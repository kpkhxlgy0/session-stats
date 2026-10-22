"use strict";

// 固定脚本仅返回会话与主机 ID，不跨隔离环境传递 React 对象或聊天内容。
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
        return { threadId: threadId.toLowerCase(), hostId: value.hostId };
    }

    function routeIdentity(location) {
        if (!location || typeof location.pathname !== "string") return null;
        const match = /^\/(?:local|hotkey-window\/thread)\/([0-9a-f-]+)\/?$/i.exec(location.pathname);
        if (!match || !UUID.test(match[1])) return null;
        const hostId = new URLSearchParams(location.search ?? "").get("hostId") ?? undefined;
        return { threadId: match[1].toLowerCase(), hostId };
    }

    function bind(candidate, hosts, routes) {
        const explicit = [...hosts, candidate.hostId,
            ...routes.filter((route) => route?.threadId === candidate.threadId).map((route) => route.hostId)]
            .filter((host) => host !== undefined);
        if (explicit.some((host) => typeof host !== "string" || !host.length || host.length > 512
            || /[\u0000-\u001f\u007f-\u009f]/.test(host)) || new Set(explicit).size > 1) return null;
        return { threadId: candidate.threadId, hostId: explicit[0] ?? "local" };
    }

    function scopeHosts(props) {
        return [props?.hostId, props?.threadKey?.hostId, props?.value?.hostId];
    }

    function scopeRoutes(props) {
        return [routeIdentity(props?.location), routeIdentity(props?.value?.location)].filter(Boolean);
    }

    function resolveConversation(root, api, win) {
        if (root.dataset.composerPlacement === "home") return null;
        const fiber = currentFiber(api.react?.getFiber(root));
        let scopedBound = null;
        let direct = null;
        let route = null;
        const hosts = [];
        const routes = [];
        for (let node = fiber, depth = 0; node && depth < 80; node = node.return, depth++) {
            const props = node.memoizedProps;
            if (!props || typeof props !== "object") continue;
            const scoped = props.value;
            hosts.push(...scopeHosts(props));
            if (scoped?.kind === "new" || scoped?.kind === "cloud") return null;
            if (scoped?.kind === "local" || scoped?.kind === "codex") {
                const bound = identity(scoped);
                if (bound) scopedBound ??= bound;
            }
            direct ??= identity(props.threadKey) ?? identity(props);
            const nodeRoutes = scopeRoutes(props);
            routes.push(...nodeRoutes);
            route ??= nodeRoutes[0];
        }
        const windowRoute = routeIdentity(win.location);
        if (windowRoute) routes.push(windowRoute);
        if (scopedBound) return bind(scopedBound, hosts, routes);
        if (direct) return bind(direct, hosts, routes);
        if (route) return bind(route, hosts, routes);

        // 输入框内的 EnvironmentSetupProgressControl 通过 threadId 绑定会话。
        const candidates = new Map();
        const stack = fiber?.child ? [{ node: fiber.child, hosts, routes }] : [];
        const visited = new Set();
        while (stack.length && visited.size < 1000) {
            const scope = stack.pop();
            const node = scope.node;
            if (!node || visited.has(node)) continue;
            visited.add(node);
            const props = node.memoizedProps;
            const nodeHosts = [...scope.hosts, ...scopeHosts(props)];
            const nodeRoutes = [...scope.routes, ...scopeRoutes(props)];
            const candidate = identity(props?.threadKey) ?? identity(props);
            if (candidate) {
                const bound = bind(candidate, nodeHosts, nodeRoutes);
                if (!bound) return null;
                candidates.set(JSON.stringify([bound.hostId, bound.threadId]), bound);
            }
            if (node.child) stack.push({ node: node.child, hosts: nodeHosts, routes: nodeRoutes });
            if (node.sibling) stack.push({ ...scope, node: node.sibling });
        }
        if (candidates.size > 1) return null;
        if (candidates.size === 1) return [...candidates.values()][0];
        const domBound = identity({ conversationId: root.dataset.conversationId });
        if (domBound) return bind(domBound, hosts, routes);
        return windowRoute ? bind(windowRoute, hosts, routes) : null;
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
