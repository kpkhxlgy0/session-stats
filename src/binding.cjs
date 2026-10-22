"use strict";

// 固定脚本仅返回会话 ID，不跨隔离环境传递 React 对象或聊天内容。
function createBindings() {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    function currentFiber(fiber) {
        let top = fiber;
        for (let depth = 0; top?.return && depth < 100; depth++) top = top.return;
        if (top?.stateNode?.current && top.stateNode.current !== top && fiber?.alternate) return fiber.alternate;
        return fiber;
    }

    function identity(value) {
        if (!value || typeof value !== "object") return null;
        const threadId = value.conversationId ?? value.threadId;
        if (typeof threadId !== "string" || !UUID.test(threadId)) return null;
        return { threadId: threadId.toLowerCase(), hostId: value.hostId ?? "local" };
    }

    function routeIdentity(location) {
        if (!location || typeof location.pathname !== "string") return null;
        const match = /^\/(?:local|hotkey-window\/thread)\/([0-9a-f-]+)\/?$/i.exec(location.pathname);
        if (!match || !UUID.test(match[1])) return null;
        const hostId = new URLSearchParams(location.search ?? "").get("hostId") ?? "local";
        return { threadId: match[1].toLowerCase(), hostId };
    }

    function resolveConversation(root, api, win) {
        if (root.dataset.composerPlacement === "home") return null;
        const fiber = currentFiber(api.react?.getFiber(root));
        let scopedBound = null;
        let direct = null;
        let route = null;
        for (let node = fiber, depth = 0; node && depth < 80; node = node.return, depth++) {
            const props = node.memoizedProps;
            if (!props || typeof props !== "object") continue;
            const scoped = props.value;
            if ([props.hostId, props.threadKey?.hostId, scoped?.hostId]
                .some((host) => typeof host === "string" && host !== "local")) return null;
            if (scoped?.kind === "new" || scoped?.kind === "cloud") return null;
            if (scoped?.kind === "local" || scoped?.kind === "codex") {
                const bound = identity(scoped);
                if (bound) scopedBound ??= bound;
            }
            direct ??= identity(props.threadKey) ?? identity(props);
            const nodeRoute = routeIdentity(props.location) ?? routeIdentity(scoped?.location);
            if (nodeRoute && nodeRoute.hostId !== "local") return null;
            route ??= nodeRoute;
        }
        const windowRoute = routeIdentity(win.location);
        if (windowRoute && windowRoute.hostId !== "local") return null;
        if (scopedBound) return scopedBound;
        if (direct) return direct.hostId === "local" ? direct : null;
        if (route) return route.hostId === "local" ? route : null;

        // 本地输入框内的 EnvironmentSetupProgressControl 通过 threadId 绑定会话。
        const candidates = new Map();
        const stack = fiber?.child ? [fiber.child] : [];
        const visited = new Set();
        while (stack.length && visited.size < 1000) {
            const node = stack.pop();
            if (!node || visited.has(node)) continue;
            visited.add(node);
            const bound = identity(node.memoizedProps?.threadKey) ?? identity(node.memoizedProps);
            if (bound) candidates.set(`${bound.hostId}:${bound.threadId}`, bound);
            if (node.child) stack.push(node.child);
            if (node.sibling) stack.push(node.sibling);
        }
        if (candidates.size > 1) return null;
        if (candidates.size === 1) {
            const bound = [...candidates.values()][0];
            return bound.hostId === "local" ? bound : null;
        }
        if (windowRoute) return windowRoute;
        return identity({ conversationId: root.dataset.conversationId });
    }

    function readBindings() {
        const api = { react: { getFiber(root) {
            const key = Object.keys(root).find((name) => name.startsWith("__reactFiber"));
            return key ? root[key] : null;
        } } };
        return [...document.querySelectorAll("[data-codex-composer-root][data-session-stats-key]")]
            .map((root) => ({ key: root.dataset.sessionStatsKey, bound: resolveConversation(root, api, window) }));
    }
    return { resolveConversation, readBindings };
}

module.exports = {
    resolveConversation: createBindings().resolveConversation,
    bindingScript: `(${createBindings.toString()})().readBindings()`,
};
