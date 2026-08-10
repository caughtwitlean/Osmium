// =====================================================
// wisp-config.js — shared WISP proxy configuration
// -----------------------------------------------------
// Single source of truth for the proxy server list, the
// Scramjet core files, the epoxy transport URL, plus
// helpers for validation, health probing and failover.
//
// Load this in the browser UI (scramjet/index.html) and
// the embed page (scramjet/embed.html) BEFORE the main
// scripts, and importScripts() it from the service worker.
// Works on window, self (worker scope) and module.exports.
// =====================================================
(function (root) {
    "use strict";

    // ---- Scramjet core + transport (keep all files in sync) ----
    const SCRAMJET_FILES = {
        wasm: "https://cdn.jsdelivr.net/gh/Destroyed12121/Staticsj@main/JS/scramjet.wasm.wasm",
        all: "https://cdn.jsdelivr.net/gh/Destroyed12121/Staticsj@main/JS/scramjet.all.js",
        sync: "https://cdn.jsdelivr.net/gh/Destroyed12121/Staticsj@main/JS/scramjet.sync.js"
    };

    // epoxy transport (WISP). If this stops resolving, bump the version.
    const TRANSPORT_URL = "https://cdn.jsdelivr.net/npm/@mercuryworkshop/epoxy-transport@2.1.28/dist/index.mjs";

    // bare-mux. PINNED to v2.1.7: newer builds removed the `fetch` method
    // from BareMuxConnection (moved to BareClient), which scramjet's core
    // depends on. v2.1.7 also matches the bundled bareworker.js.
    const BARE_MUX_URL = "https://cdn.jsdelivr.net/npm/@mercuryworkshop/bare-mux@2.1.7/dist/index.js";

    // ---- WISP servers ----
    // The first entry is the default. Order matters: it is also the
    // order used for automatic failover when a server is unreachable.
    // Each entry is probed at runtime, so dead entries are harmless.
    const WISP_SERVERS = [
        { name: "Anura", url: "wss://anura.pro/" },
        { name: "Mercury Workshop", url: "wss://wisp.mercurywork.shop/" }
    ];

    const DEFAULT_WISP = WISP_SERVERS[0].url;

    // ---- storage keys ----
    const SERVER_KEY = "proxServer";
    const CUSTOM_KEY = "customWisps";

    // ---- safe localStorage (also usable in worker contexts) ----
    function lsGet(key) {
        try { return root.localStorage ? root.localStorage.getItem(key) : null; } catch (_e) { return null; }
    }
    function lsSet(key, value) {
        try { if (root.localStorage) root.localStorage.setItem(key, value); } catch (_e) { /* noop */ }
    }

    // ---- URL validation ----
    // Accepts ws:// and wss:// URLs. Unlike the old config, no
    // "/wisp" suffix is required — many public servers (e.g.
    // wss://anura.pro/) don't use one.
    function isValidWispUrl(url) {
        try {
            if (typeof url !== "string" || !url) return false;
            const u = new URL(url);
            if (u.protocol !== "wss:" && u.protocol !== "ws:") return false;
            return !!u.hostname;
        } catch (_e) {
            return false;
        }
    }

    // ---- server lookup ----
    function getStoredWisps() {
        try {
            const raw = lsGet(CUSTOM_KEY);
            const list = raw ? JSON.parse(raw) : [];
            return Array.isArray(list) ? list.filter(s => s && s.url && isValidWispUrl(s.url)) : [];
        } catch (_e) {
            return [];
        }
    }

    function getAllServers() {
        return [...WISP_SERVERS, ...getStoredWisps()];
    }

    function getActiveWisp() {
        const saved = lsGet(SERVER_KEY);
        return (saved && isValidWispUrl(saved)) ? saved : DEFAULT_WISP;
    }

    function serverName(url) {
        const found = getAllServers().find(s => s.url === url);
        return found ? found.name : "Custom Server";
    }

    // ---- persistence + SW notification ----
    // Custom server URLs ride along with the config so the service worker
    // can include them when it auto-fails-over (it has no localStorage).
    function notifyServiceWorker(wispUrl) {
        try {
            if (root.navigator && root.navigator.serviceWorker && root.navigator.serviceWorker.controller) {
                root.navigator.serviceWorker.controller.postMessage({
                    type: "config",
                    wispurl: wispUrl,
                    customUrls: getStoredWisps().map(s => s.url)
                });
            }
        } catch (_e) { /* noop */ }
    }

    // Persist the active server, tell the service worker about it and
    // dispatch an event so any open UI can react. Returns true on success.
    function saveWisp(url) {
        if (!isValidWispUrl(url)) return false;
        const oldUrl = lsGet(SERVER_KEY);
        lsSet(SERVER_KEY, url);
        notifyServiceWorker(url);
        try {
            const evt = new root.CustomEvent("wispUrlUpdated", {
                detail: { oldUrl: oldUrl || DEFAULT_WISP, newUrl: url }
            });
            (root.document || root).dispatchEvent(evt);
        } catch (_e) { /* noop */ }
        return true;
    }

    // ---- health probing ----
    // Opens a WebSocket to the server and resolves with the measured
    // latency in ms, or null if it fails within `timeoutMs`.
    // Results are cached briefly so repeated UI refreshes don't hammer
    // rate-limited public WISP servers.
    const probeCache = new Map();
    const PROBE_CACHE_TTL = 15000;

    function probeServer(url, timeoutMs) {
        const cached = probeCache.get(url);
        if (cached && (Date.now() - cached.time) < PROBE_CACHE_TTL) {
            return Promise.resolve(cached.latency);
        }
        return new Promise((resolve) => {
            let settled = false;
            let socket;
            const start = Date.now();
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                try { socket && socket.close(); } catch (_e) { /* noop */ }
                probeCache.set(url, { time: Date.now(), latency: null });
                resolve(null);
            }, timeoutMs || 3000);

            try {
                socket = new WebSocket(url);
            } catch (_e) {
                clearTimeout(timer);
                probeCache.set(url, { time: Date.now(), latency: null });
                return resolve(null);
            }

            socket.onopen = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                const latency = Date.now() - start;
                try { socket.close(); } catch (_e) { /* noop */ }
                probeCache.set(url, { time: Date.now(), latency });
                resolve(latency);
            };
            socket.onerror = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { socket.close(); } catch (_e) { /* noop */ }
                probeCache.set(url, { time: Date.now(), latency: null });
                resolve(null);
            };
            socket.onclose = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                probeCache.set(url, { time: Date.now(), latency: null });
                resolve(null);
            };
        });
    }

    // ---- failover ----
    // Tries the saved server first (if any), then every known server in
    // list order, resolving with the first one that answers. Falls back to
    // the saved/default server if everything is unreachable. The chosen
    // URL is persisted so every page agrees on the active server.
    function pickBestWisp(opts) {
        opts = opts || {};
        const perServerTimeout = opts.perServerTimeoutMs || 2500;
        const maxTotal = opts.maxTotalMs || 12000;

        return new Promise((resolve) => {
            const saved = getActiveWisp();
            const candidates = [];
            if (saved) candidates.push(saved);
            WISP_SERVERS.forEach(s => { if (s.url !== saved) candidates.push(s.url); });
            getStoredWisps().forEach(s => { if (s.url !== saved) candidates.push(s.url); });

            const fallback = saved || DEFAULT_WISP;
            let idx = 0;
            let settled = false;
            const start = Date.now();

            function tryNext() {
                if (settled) return;
                // out of candidates or out of budget → fallback
                if (idx >= candidates.length || (Date.now() - start) > maxTotal) {
                    settled = true;
                    if (saved !== fallback) lsSet(SERVER_KEY, fallback);
                    return resolve(fallback);
                }
                const url = candidates[idx++];
                probeServer(url, perServerTimeout).then((latency) => {
                    if (settled) return;
                    if (latency !== null) {
                        settled = true;
                        lsSet(SERVER_KEY, url);
                        return resolve(url);
                    }
                    tryNext();
                });
            }
            tryNext();
        });
    }

    const api = {
        SCRAMJET_FILES: SCRAMJET_FILES,
        TRANSPORT_URL: TRANSPORT_URL,
        BARE_MUX_URL: BARE_MUX_URL,
        WISP_SERVERS: WISP_SERVERS,
        DEFAULT_WISP: DEFAULT_WISP,
        SERVER_KEY: SERVER_KEY,
        CUSTOM_KEY: CUSTOM_KEY,
        isValidWispUrl: isValidWispUrl,
        getStoredWisps: getStoredWisps,
        getAllServers: getAllServers,
        getActiveWisp: getActiveWisp,
        serverName: serverName,
        notifyServiceWorker: notifyServiceWorker,
        saveWisp: saveWisp,
        probeServer: probeServer,
        pickBestWisp: pickBestWisp
    };

    root.WispConfig = api;
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
})(typeof self !== "undefined" ? self : this);
