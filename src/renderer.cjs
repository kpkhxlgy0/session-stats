"use strict";

const { resolveConversation } = require("./binding.cjs");
const ROOT = "[data-codex-composer-root]";
const MARKER = "[data-session-stats]";

function compact(value) {
    if (!Number.isFinite(value) || value < 0) return "—";
    if (value >= 1000000) return `${(value / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
    if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}K`;
    return String(Math.round(value));
}

function isVisible(root, win) {
    if (!root.isConnected || root.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    if (!root.getClientRects().length) return false;
    for (let node = root; node; node = node.parentElement) {
        const style = win.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
}

function makeBar(doc) {
    const anchor = doc.createElement("div");
    anchor.dataset.sessionStatsAnchor = "";
    const bar = doc.createElement("div");
    bar.dataset.sessionStats = "";
    bar.className = "text-secondary text-xs";
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "会话统计");
    const activity = doc.createElement("span");
    const usage = doc.createElement("span");
    activity.className = usage.className = "session-stats-group";
    const fields = {};
    for (const [name, parent] of [["turns", activity], ["steps", activity], ["tps", activity],
        ["tokens", usage], ["cache", usage]]) {
        if (parent.childNodes.length) parent.append(doc.createTextNode(" · "));
        const field = doc.createElement("span");
        field.dataset.stat = name;
        parent.append(field);
        fields[name] = field;
    }
    bar.append(activity, usage);
    anchor.append(bar);
    fields.turns.title = "当前会话的轮次，按 turn_id 去重";
    fields.steps.title = "当前会话的模型调用次数，按 response_id 去重；不等于工具调用次数";
    fields.tps.title = "本轮平均 TPS：输出 Token（含推理）÷ 模型活跃时间；重叠区间只算一次，排除工具等待。"
        + "按响应完成更新；~ 表示暂时保留上次有效速度。";
    return { anchor, bar, fields };
}

function render(entry, stats) {
    const usable = stats?.status === "ok";
    const s = usable ? stats : {};
    const set = (key, value) => {
        if (entry.fields[key].textContent !== value) entry.fields[key].textContent = value;
    };
    set("turns", `${s.turns ?? "—"} turns`);
    set("steps", `${s.steps ?? "—"} steps`);
    set("tps", `${Number.isFinite(s.tps) && s.tps > 0 ? `${s.tpsHeld ? "~" : ""}${Math.round(s.tps)}` : "—"} tok/s`);
    set("tokens", `${compact(s.totalTokens)} tok`);
    set("cache", `Cache hit ${Number.isFinite(s.cacheHit) ? `${Math.round(s.cacheHit * 100)}%` : "—"}`);
    const pending = stats?.status === "not-found" ? "等待当前会话的本地用量日志" : "当前会话暂无可用统计";
    entry.bar.title = usable ? "" : pending;
    entry.fields.tokens.title = usable ? `累计 ${s.totalTokens ?? "—"} tokens；输入 ${s.inputTokens ?? "—"}，`
        + `输出 ${s.outputTokens ?? "—"}。缓存输入已包含在输入中。` : pending;
    entry.fields.cache.title = usable ? `缓存输入 ${s.cachedInputTokens ?? "—"} ÷ 总输入 ${s.inputTokens ?? "—"}` : pending;
}

function startRenderer(api, options = {}) {
    const win = options.window ?? window;
    const doc = win.document;
    const entries = new Map();
    let stopped = false;
    let scheduled = null;
    let bindingRequest = false;
    let dirty = false;
    let nextKey = 0;
    const keyPrefix = Math.random().toString(36).slice(2);
    const style = doc.createElement("style");
    style.dataset.sessionStatsStyle = "";
    style.textContent = `
        [data-session-stats-anchor] {
            position: relative; height: 0; min-height: 0; margin: 0; padding: 0; border: 0;
        }
        [data-session-stats] {
            position: absolute; top: 2px; left: var(--spacing, .25rem); right: var(--spacing, .25rem);
            display: flex; flex-wrap: nowrap; align-items: center;
            gap: calc(var(--spacing, .25rem) * 5); padding: 0;
            overflow-x: auto; scrollbar-width: none;
            color: var(--color-text-secondary, var(--color-token-text-secondary, inherit));
            font-size: var(--text-xs, 11px); line-height: 14px;
            font-variant-numeric: tabular-nums; user-select: text;
        }
        [data-session-stats] .session-stats-group { white-space: nowrap; flex-shrink: 0; }
        [data-session-stats] .session-stats-group:first-child { margin-left: auto; }
        [data-session-stats] .session-stats-group:last-child { margin-right: auto; }
    `;
    doc.head.append(style);

    async function refresh(root, entry) {
        if (stopped || entry.inflight || !root.isConnected) return;
        const request = {};
        const threadId = entry.threadId;
        entry.inflight = request;
        try {
            const stats = await api.ipc.invoke("stats", threadId);
            if (stopped || entries.get(root) !== entry || entry.inflight !== request) return;
            if (stats?.threadId !== threadId) return;
            render(entry, stats);
            if (stats.status === "ok" && !entry.logged) {
                entry.logged = true;
                api.log.info(`footer ready: ${threadId}; turns=${stats.turns}, steps=${stats.steps}, tps=${stats.tps}`);
            }
        } catch {
            if (!stopped && entries.get(root) === entry && entry.inflight === request) render(entry, null);
        } finally {
            if (entry.inflight === request) entry.inflight = null;
        }
    }

    async function reconcile() {
        scheduled = null;
        if (stopped) return;
        if (bindingRequest) { dirty = true; return; }
        dirty = false;
        const roots = new Set(doc.querySelectorAll(ROOT));
        const visibleRoots = [...roots].filter((root) => isVisible(root, win));
        const bindings = new Map();
        const needsBridge = visibleRoots.some((root) => root.dataset.composerPlacement !== "home"
            && !api.react?.getFiber(root));
        if (needsBridge) {
            for (const root of visibleRoots) root.dataset.sessionStatsKey ??= `${keyPrefix}-${++nextKey}`;
            bindingRequest = true;
            try {
                const result = await api.ipc.invoke("bindings");
                if (Array.isArray(result)) for (const item of result) bindings.set(item.key, item.bound);
            } catch { /* 主页面切换或销毁时等待下次绑定。 */ }
            finally { bindingRequest = false; }
            if (stopped) return;
            if (dirty) { schedule(); return; }
        }
        for (const [root, entry] of entries) {
            if (!roots.has(root) || !isVisible(root, win)) {
                entry.anchor.remove(); entries.delete(root);
            }
        }
        for (const root of roots) {
            if (!isVisible(root, win)) continue;
            const bound = bindings.has(root.dataset.sessionStatsKey) ? bindings.get(root.dataset.sessionStatsKey)
                : resolveConversation(root, api, win);
            let entry = entries.get(root);
            if (!bound) {
                if (entry) { entry.anchor.remove(); entries.delete(root); }
                continue;
            }
            if (!entry || entry.threadId !== bound.threadId) {
                entry?.anchor.remove();
                entry = { ...makeBar(doc), threadId: bound.threadId, inflight: null, logged: false };
                entries.set(root, entry);
                render(entry, null);
                root.append(entry.anchor);
                void refresh(root, entry);
            } else if (!entry.anchor.isConnected) {
                root.append(entry.anchor);
            }
        }
    }

    function schedule() {
        if (bindingRequest) dirty = true;
        if (!stopped && scheduled === null) scheduled = win.setTimeout(reconcile, options.debounceMs ?? 100);
    }
    const observer = new win.MutationObserver((mutations) => {
        if (mutations.some((mutation) => !mutation.target.parentElement?.closest(MARKER)
            && !mutation.target.closest?.(MARKER))) schedule();
    });
    observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true,
        attributeFilter: ["data-conversation-id", "data-composer-placement", "hidden", "inert", "aria-hidden", "style"] });
    win.addEventListener("popstate", schedule);
    win.addEventListener("hashchange", schedule);
    win.addEventListener("resize", schedule);
    doc.addEventListener("visibilitychange", schedule);
    const timer = win.setInterval(() => {
        if (doc.visibilityState === "hidden") return;
        schedule();
        for (const [root, entry] of entries) void refresh(root, entry);
    }, options.pollMs ?? 1000);
    reconcile();
    api.log.info("renderer started");

    return {
        stop() {
            if (stopped) return;
            stopped = true;
            observer.disconnect();
            win.clearInterval(timer);
            if (scheduled !== null) win.clearTimeout(scheduled);
            win.removeEventListener("popstate", schedule);
            win.removeEventListener("hashchange", schedule);
            win.removeEventListener("resize", schedule);
            doc.removeEventListener("visibilitychange", schedule);
            for (const entry of entries.values()) entry.anchor.remove();
            for (const root of doc.querySelectorAll(ROOT)) delete root.dataset.sessionStatsKey;
            entries.clear(); style.remove();
        },
    };
}

module.exports = { resolveConversation, startRenderer };
