// =====================================================
// osmium scramjet browser — main logic
// =====================================================

// Shared WISP configuration (wisp-config.js must load first)
const CONFIG = window.WispConfig;
if (!CONFIG) {
    throw new Error("wisp-config.js failed to load — the proxy cannot start.");
}

const DEFAULT_WISP = CONFIG.DEFAULT_WISP;
const SEARCH_ENGINE = "https://search.brave.com/search?q=";
const SESSION_KEY = "scramjet-session";

// Migrate legacy/dead server selections to the default
try {
    const prev = localStorage.getItem(CONFIG.SERVER_KEY);
    if (prev === "wss://wisp.rhw.one/wisp/") {
        localStorage.setItem(CONFIG.SERVER_KEY, DEFAULT_WISP);
    }
} catch (_e) { /* noop */ }

// =====================================================
// BROWSER STATE
// =====================================================
if (typeof BareMux === "undefined") {
    BareMux = { BareMuxConnection: class { constructor() { } async setTransport() { } } };
}

let scramjet;
let connection = null;       // page-side bare-mux connection
let transportReady = false;  // true once the transport is configured
let tabs = [];
let activeTabId = null;
let nextTabId = 1;
let persistTimer = null;

function withTimeout(promise, ms, message) {
    return Promise.race([
        Promise.resolve(promise),
        new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
    ]);
}

// =====================================================
// INITIALIZATION
// =====================================================
document.addEventListener("DOMContentLoaded", async function () {
    // Snapshot BEFORE failover runs so we can tell the user if their
    // saved server was swapped for a healthier one.
    let wispBeforeBoot = CONFIG.DEFAULT_WISP;
    try { wispBeforeBoot = localStorage.getItem(CONFIG.SERVER_KEY) || CONFIG.DEFAULT_WISP; } catch (_e) { /* noop */ }

    const root = document.getElementById("app");
    root.innerHTML = `
        <div class="boot-splash">
            <div class="boot-logo"><i class="fa-solid fa-globe"></i></div>
            <h1>Starting proxy…</h1>
            <p id="boot-status">Loading Scramjet core</p>
            <div class="boot-hint">osmium browser</div>
        </div>`;

    const setBoot = (status) => {
        const el = document.getElementById("boot-status");
        if (el) el.textContent = status;
    };

    try {
        setBoot("Loading Scramjet core…");
        const basePath = location.pathname.replace(/[^/]*$/, "");
        if (typeof $scramjetLoadController !== "function") {
            throw new Error("Scramjet core failed to load (CDN unreachable?).");
        }
        const { ScramjetController } = $scramjetLoadController();
        scramjet = new ScramjetController({ prefix: basePath + "scramjet/", files: CONFIG.SCRAMJET_FILES });
        await scramjet.init();

        setBoot("Checking proxy servers…");
        const wispUrl = await CONFIG.pickBestWisp({ perServerTimeoutMs: 2500, maxTotalMs: 12000 });
        if (wispUrl !== CONFIG.getActiveWisp()) {
            CONFIG.saveWisp(wispUrl);
        }

        setBoot("Starting service worker…");
        if ("serviceWorker" in navigator) {
            const reg = await withTimeout(
                navigator.serviceWorker.register(basePath + "sw.js", { scope: basePath }),
                10000, "Service worker registration timed out"
            ).catch(err => { console.warn("SW register failed:", err); return null; });

            await withTimeout(navigator.serviceWorker.ready, 10000, "SW ready timeout")
                .catch(() => null);

            const configMsg = {
                type: "config",
                wispurl: wispUrl,
                customUrls: CONFIG.getStoredWisps().map(s => s.url)
            };
            const sw = (reg && reg.active) || navigator.serviceWorker.controller;
            if (sw) sw.postMessage(configMsg);
            if (navigator.serviceWorker.controller && navigator.serviceWorker.controller !== sw) {
                navigator.serviceWorker.controller.postMessage(configMsg);
            }
            if (reg) reg.update().catch(() => null);

            // First visit: wait until the SW claims the page so frames
            // are actually proxied (subsequent visits are instant).
            if (!navigator.serviceWorker.controller) {
                await new Promise(resolve => {
                    const onControl = () => {
                        navigator.serviceWorker.removeEventListener("controllerchange", onControl);
                        resolve();
                    };
                    navigator.serviceWorker.addEventListener("controllerchange", onControl);
                    setTimeout(resolve, 6000); // never block forever
                });
            }
        }

        setBoot("Connecting to " + CONFIG.serverName(wispUrl) + "…");
        // The page-side connection is REQUIRED: the service worker can't
        // spawn a SharedWorker, so it reuses the MessagePort that this
        // connection registers on the shared bareworker. The transport
        // itself lives in the shared worker (one WISP socket for everyone).
        try {
            connection = new BareMux.BareMuxConnection(basePath + "bareworker.js");
            await withTimeout(
                connection.setTransport(CONFIG.TRANSPORT_URL, [{ wisp: wispUrl }]),
                12000, "Transport setup timed out"
            );
        } catch (err) {
            console.warn("Transport setup failed (will retry via SW):", err);
        }
        transportReady = true;

        syncParentTheme();

        await initializeBrowser();
        setProxyStatus("connected", "Connected · " + CONFIG.serverName(wispUrl));
        if (wispUrl !== wispBeforeBoot) {
            toast(`<b>${CONFIG.serverName(wispUrl)}</b> — previous server was unreachable`, "info", 4500);
        }
        // If the SW hasn't claimed the page yet (slow first install), keep
        // the pill honest and flip it to Connected once it does.
        if ("serviceWorker" in navigator && !navigator.serviceWorker.controller) {
            setProxyStatus("connecting", "Waiting for proxy…");
            navigator.serviceWorker.addEventListener("controllerchange", () => {
                setProxyStatus("connected", "Connected · " + CONFIG.serverName(CONFIG.getActiveWisp()));
            });
        }
        if (!restoreSession()) {
            createTab(true);
        }
        checkHashParameters();
    } catch (err) {
        console.error("Boot failed:", err);
        showFatalError(err);
    }
});

function showFatalError(err) {
    const root = document.getElementById("app");
    root.innerHTML = `
        <div class="boot-splash">
            <div class="boot-logo" style="box-shadow:0 0 40px rgba(239,68,68,0.35);"><i class="fa-solid fa-triangle-exclamation"></i></div>
            <h1>Proxy failed to start</h1>
            <p id="boot-status">${String(err && err.message || err)}</p>
            <div class="error-actions">
                <button class="error-btn" onclick="location.reload()"><i class="fa-solid fa-rotate-right"></i> Retry</button>
                <button class="error-btn" onclick="if(window.parent && window.parent!==window){window.parent.location.reload()}"><i class="fa-solid fa-house"></i> Back to Home</button>
            </div>
        </div>`;
}

// =====================================================
// THEME SYNC (mirror the parent site's full theme)
// =====================================================
// Every palette mirrors the main site's body[data-theme] CSS blocks
const THEME_PALETTES = {
    crimson: { accent: "#e63946", bright: "#ff5060", soft: "rgba(230, 57, 70, 0.16)", glow: "rgba(230, 57, 70, 0.45)", grad: "linear-gradient(135deg, #ff4050 0%, #c1121f 100%)", border: "#3d1c1c", borderLight: "#571f1f", textMuted: "#b59e9e", textDim: "#7e6363", bg: "#120808", bgAlt: "#180b0b", surface: "#200e0e", surface2: "#2a1313", surface3: "#361a1a" },
    blue: { accent: "#2563eb", bright: "#3b82f6", soft: "rgba(37,99,235,.16)", glow: "rgba(37,99,235,.45)", grad: "linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)", border: "#1e2d4a", borderLight: "#253a5e", textMuted: "#94a8c2", textDim: "#5c6e85", bg: "#060a10", bgAlt: "#0a0f18", surface: "#0e1525", surface2: "#141e33", surface3: "#1a2742" },
    green: { accent: "#16a34a", bright: "#22c55e", soft: "rgba(22,163,74,.16)", glow: "rgba(22,163,74,.45)", grad: "linear-gradient(135deg, #22c55e 0%, #15803d 100%)", border: "#1a3a22", borderLight: "#224a2e", textMuted: "#8cba94", textDim: "#557a5e", bg: "#050a06", bgAlt: "#08100a", surface: "#0c180e", surface2: "#122215", surface3: "#182e1c" },
    purple: { accent: "#7c3aed", bright: "#8b5cf6", soft: "rgba(124,58,237,.16)", glow: "rgba(124,58,237,.45)", grad: "linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%)", border: "#2a1e4a", borderLight: "#38255e", textMuted: "#b09cd6", textDim: "#7560a8", bg: "#090610", bgAlt: "#0e0a18", surface: "#130e22", surface2: "#1b1430", surface3: "#241a3e" },
    amber: { accent: "#d97706", bright: "#f59e0b", soft: "rgba(217,119,6,.16)", glow: "rgba(217,119,6,.45)", grad: "linear-gradient(135deg, #f59e0b 0%, #b45309 100%)", border: "#3d2a12", borderLight: "#5c3d1a", textMuted: "#c4a36e", textDim: "#8a6d3f", bg: "#0f0a04", bgAlt: "#150e06", surface: "#1c140a", surface2: "#281b0f", surface3: "#362515" },
    teal: { accent: "#0d9488", bright: "#14b8a6", soft: "rgba(13,148,136,.16)", glow: "rgba(13,148,136,.45)", grad: "linear-gradient(135deg, #14b8a6 0%, #0f766e 100%)", border: "#14302d", borderLight: "#1a423e", textMuted: "#8ab8b0", textDim: "#528078", bg: "#050c0b", bgAlt: "#081210", surface: "#0c1a17", surface2: "#112520", surface3: "#17322c" },
    pink: { accent: "#db2777", bright: "#ec4899", soft: "rgba(219,39,119,.16)", glow: "rgba(219,39,119,.45)", grad: "linear-gradient(135deg, #ec4899 0%, #be185d 100%)", border: "#3d1a2e", borderLight: "#5c2744", textMuted: "#d49ab5", textDim: "#9c6078", bg: "#0f050b", bgAlt: "#150810", surface: "#1c0d15", surface2: "#28131e", surface3: "#361a29" },
    indigo: { accent: "#4f46e5", bright: "#6366f1", soft: "rgba(79,70,229,.16)", glow: "rgba(79,70,229,.45)", grad: "linear-gradient(135deg, #6366f1 0%, #4338ca 100%)", border: "#1e1d4a", borderLight: "#2a2860", textMuted: "#a0a4d8", textDim: "#6468a0", bg: "#070610", bgAlt: "#0b0918", surface: "#100e22", surface2: "#171430", surface3: "#1f1b3e" },
    cyan: { accent: "#0891b2", bright: "#06b6d4", soft: "rgba(8,145,178,.16)", glow: "rgba(8,145,178,.45)", grad: "linear-gradient(135deg, #06b6d4 0%, #0e7490 100%)", border: "#122e38", borderLight: "#194251", textMuted: "#86b8c4", textDim: "#4e7a86", bg: "#040c0f", bgAlt: "#071216", surface: "#0b1a20", surface2: "#0f242c", surface3: "#15303a" },
    lime: { accent: "#65a30d", bright: "#84cc16", soft: "rgba(101,163,13,.16)", glow: "rgba(101,163,13,.45)", grad: "linear-gradient(135deg, #84cc16 0%, #4d7c0f 100%)", border: "#263310", borderLight: "#384a18", textMuted: "#a8ba86", textDim: "#6e7a4e", bg: "#080d02", bgAlt: "#0c1204", surface: "#131a08", surface2: "#1a230c", surface3: "#233010" },
    coral: { accent: "#f43f5e", bright: "#fb7185", soft: "rgba(244,63,94,.16)", glow: "rgba(244,63,94,.45)", grad: "linear-gradient(135deg, #fb7185 0%, #e11d48 100%)", border: "#3d1a24", borderLight: "#5c2635", textMuted: "#d69aa0", textDim: "#9c6068", bg: "#0f0508", bgAlt: "#15080c", surface: "#1c0d12", surface2: "#28131a", surface3: "#361a23" },
    slate: { accent: "#64748b", bright: "#94a3b8", soft: "rgba(100,116,139,.16)", glow: "rgba(100,116,139,.45)", grad: "linear-gradient(135deg, #94a3b8 0%, #475569 100%)", border: "#252a33", borderLight: "#363d48", textMuted: "#9ea8b4", textDim: "#64707e", bg: "#08090b", bgAlt: "#0c0e11", surface: "#13151a", surface2: "#1a1d23", surface3: "#22262e" },
    gold: { accent: "#ca8a04", bright: "#eab308", soft: "rgba(202,138,4,.16)", glow: "rgba(202,138,4,.45)", grad: "linear-gradient(135deg, #eab308 0%, #a16207 100%)", border: "#3d2e0e", borderLight: "#5c4416", textMuted: "#c4ae72", textDim: "#8a783e", bg: "#0f0b03", bgAlt: "#151005", surface: "#1c1708", surface2: "#28200c", surface3: "#362c12" },
    midnight: { accent: "#6366f1", bright: "#818cf8", soft: "rgba(99,102,241,.16)", glow: "rgba(99,102,241,.45)", grad: "linear-gradient(135deg, #818cf8 0%, #4f46e5 100%)", border: "#1a1b3d", borderLight: "#282860", textMuted: "#949ac8", textDim: "#5c62a0", bg: "#03040f", bgAlt: "#060718", surface: "#0b0c22", surface2: "#101230", surface3: "#16193e" },
    mono: { accent: "#78716c", bright: "#a8a29e", soft: "rgba(120,113,108,.16)", glow: "rgba(120,113,108,.45)", grad: "linear-gradient(135deg, #a8a29e 0%, #57534e 100%)", border: "#292524", borderLight: "#44403c", textMuted: "#a8a29e", textDim: "#78716c", bg: "#0c0a09", bgAlt: "#111110", surface: "#1c1917", surface2: "#231f1f", surface3: "#2b2626" }
};

function applyTheme(key) {
    const pal = THEME_PALETTES[key] || THEME_PALETTES.mono;
    try {
        const s = document.documentElement.style;
        s.setProperty("--accent", pal.accent);
        s.setProperty("--accent-bright", pal.bright);
        s.setProperty("--accent-soft", pal.soft);
        s.setProperty("--accent-glow", pal.glow);
        s.setProperty("--grad", pal.grad);
        s.setProperty("--border", pal.border);
        s.setProperty("--border-light", pal.borderLight);
        s.setProperty("--text-muted", pal.textMuted);
        s.setProperty("--text-dim", pal.textDim);
        s.setProperty("--bg", pal.bg);
        s.setProperty("--bg-alt", pal.bgAlt);
        s.setProperty("--surface", pal.surface);
        s.setProperty("--surface-2", pal.surface2);
        s.setProperty("--surface-3", pal.surface3);
        document.body.dataset.theme = key;
        broadcastThemeToFrames(key);
    } catch (_e) { /* noop */ }
}

// Keep any same-origin child pages (e.g. the New Tab page) in sync
function broadcastThemeToFrames(key) {
    tabs.forEach(t => {
        try {
            t.frame.frame.contentWindow.postMessage({ type: "theme-accent", theme: key }, "*");
        } catch (_e) { /* noop */ }
    });
}

function syncParentTheme() {
    try {
        if (window.parent === window) return;
        const theme = window.parent.document.body && window.parent.document.body.dataset.theme;
        applyTheme(theme || "mono");
    } catch (_e) { /* cross-origin or no parent — use mono default matching the site */ }
}

window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "theme-accent") {
        if (e.data.theme) {
            applyTheme(e.data.theme);
        } else if (Array.isArray(e.data.accent)) {
            // legacy payload — only the accent pair
            const pal = THEME_PALETTES.mono;
            try {
                const s = document.documentElement.style;
                s.setProperty("--accent", e.data.accent[0]);
                s.setProperty("--accent-bright", e.data.accent[1] || e.data.accent[0]);
                s.setProperty("--accent-soft", pal.soft);
                s.setProperty("--accent-glow", pal.glow);
                s.setProperty("--grad", pal.grad);
            } catch (_e) { /* noop */ }
        }
    }
    if (e.data && e.data.type === "navigate") handleSubmit(e.data.url);
    if (e.data && e.data.type === "proxy-failover" && e.data.url) {
        // The service worker auto-switched to a healthier server.
        try { localStorage.setItem(CONFIG.SERVER_KEY, e.data.url); } catch (_e) { /* noop */ }
        setProxyStatus("connected", "Connected · " + CONFIG.serverName(e.data.url));
        toast(`<b>${CONFIG.serverName(e.data.url)}</b> — auto-switched (previous server went offline)`, "warning", 6000);
    }
});

// =====================================================
// BROWSER UI
// =====================================================
async function initializeBrowser() {
    const root = document.getElementById("app");
    root.innerHTML = `
        <div class="browser-container">
            <div class="toolbar">
                <div class="tabs" id="tabs-container"></div>
                <div class="nav">
                    <div class="nav-group">
                        <button class="nav-btn" id="back-btn" title="Back (Alt+←)"><i class="fa-solid fa-chevron-left"></i></button>
                        <button class="nav-btn" id="fwd-btn" title="Forward (Alt+→)"><i class="fa-solid fa-chevron-right"></i></button>
                        <button class="nav-btn" id="reload-btn" title="Reload (Ctrl+R)"><i class="fa-solid fa-arrow-rotate-right"></i></button>
                    </div>
                    <div class="nav-divider"></div>
                    <div class="address-wrapper">
                        <i class="fa-solid fa-globe" id="addr-icon"></i>
                        <input class="bar" id="address-bar" autocomplete="off" placeholder="Search or enter URL" spellcheck="false">
                        <button id="home-btn-nav" title="Back to home"><i class="fa-solid fa-house"></i></button>
                    </div>
                    <div class="nav-divider"></div>
                    <div class="nav-group">
                        <button class="nav-btn" id="fullscreen-btn" title="Fullscreen (F11)"><i class="fa-solid fa-expand"></i></button>
                        <button class="nav-btn" id="devtools-btn" title="DevTools (Ctrl+Shift+I)"><i class="fa-solid fa-code"></i></button>
                    </div>
                    <button id="proxy-status" title="Proxy Settings — click to change server">
                        <span class="status-dot" id="proxy-status-dot"></span>
                        <span class="status-label" id="proxy-status-label">Connecting…</span>
                    </button>

                </div>
                <div class="loading-bar-wrap"><div class="loading-bar" id="loading-bar"></div></div>
            </div>
            <div class="iframe-container" id="iframe-container">
                <div id="loading" class="message-container" style="display: none;">
                    <div class="message-content">
                        <div class="spinner"></div>
                        <h1 id="loading-title">Connecting</h1>
                        <p id="loading-url">Initializing proxy...</p>
                        <button id="skip-btn">Skip</button>
                    </div>
                </div>
                <div id="error" class="message-container" style="display: none;">
                    <div class="message-content">
                        <h1><i class="fa-solid fa-triangle-exclamation"></i> Connection Error</h1>
                        <p id="error-message">An error occurred.</p>
                        <div class="error-actions">
                            <button id="error-retry" class="error-btn"><i class="fa-solid fa-rotate-right"></i> Try Again</button>
                            <button id="error-settings" class="error-btn"><i class="fa-solid fa-server"></i> Switch Server</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>`;

    document.getElementById("back-btn").onclick = () => getActiveTab()?.frame.back();
    document.getElementById("fwd-btn").onclick = () => getActiveTab()?.frame.forward();
    document.getElementById("reload-btn").onclick = () => reloadActive();
    document.getElementById("home-btn-nav").onclick = () => window.location.href = "../index.html";
    document.getElementById("fullscreen-btn").onclick = toggleFullscreen;
    document.getElementById("devtools-btn").onclick = toggleDevTools;
    document.getElementById("proxy-status").onclick = openSettings;
    document.getElementById("error-retry").onclick = () => { hideError(); reloadActive(); };
    document.getElementById("error-settings").onclick = () => { hideError(); openSettings(); };

    const skipBtn = document.getElementById("skip-btn");
    if (skipBtn) {
        skipBtn.onclick = () => {
            const tab = getActiveTab();
            if (tab) {
                tab.loading = false;
                tab.showSkip = false;
                showIframeLoading(false);
            }
        };
    }

    const addrBar = document.getElementById("address-bar");
    addrBar.onkeyup = (e) => { if (e.key === "Enter") handleSubmit(); };
    addrBar.onfocus = () => addrBar.select();

    registerShortcuts();
}

function hideError() {
    const err = document.getElementById("error");
    if (err) err.style.display = "none";
}

function showFrameError(message) {
    const err = document.getElementById("error");
    if (!err) return;
    const msgEl = document.getElementById("error-message");
    if (msgEl) msgEl.textContent = message;
    err.style.display = "flex";
}

// =====================================================
// KEYBOARD SHORTCUTS
// =====================================================
function registerShortcuts() {
    window.addEventListener("keydown", (e) => {
        const mod = e.ctrlKey || e.metaKey;
        const key = e.key.toLowerCase();
        const target = e.target;
        const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

        if (mod && key === "t") { e.preventDefault(); createTab(true); }
        else if (mod && key === "w") { e.preventDefault(); closeTab(activeTabId); }
        else if (mod && key === "l") { e.preventDefault(); focusAddressBar(); }
        else if (mod && key === "r") { e.preventDefault(); reloadActive(); }
        else if (mod && key === "i") { e.preventDefault(); toggleDevTools(); }
        else if (mod && key === "tab") { e.preventDefault(); cycleTab(e.shiftKey ? -1 : 1); }
        else if (e.key === "F11") { e.preventDefault(); toggleFullscreen(); }
        else if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); getActiveTab()?.frame.back(); }
        else if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); getActiveTab()?.frame.forward(); }
        else if (key === "escape" && !typing) {
            const modal = document.getElementById("wisp-settings-modal");
            if (modal && !modal.classList.contains("hidden")) modal.classList.add("hidden");
        }
    });
}

function focusAddressBar() {
    const bar = document.getElementById("address-bar");
    if (bar) { bar.focus(); bar.select(); }
}

function cycleTab(dir) {
    if (!tabs.length) return;
    const idx = tabs.findIndex(t => t.id === activeTabId);
    const next = (idx + dir + tabs.length) % tabs.length;
    switchTab(tabs[next].id);
}

// =====================================================
// TAB MANAGEMENT
// =====================================================
function createTab(makeActive = true) {
    const frame = scramjet.createFrame();
    const tab = {
        id: nextTabId++,
        title: "New Tab",
        url: "NT.html",
        frame: frame,
        loading: false,
        favicon: null,
        showSkip: false,
        skipTimeout: null
    };

    frame.frame.src = "NT.html";

    frame.addEventListener("urlchange", (e) => {
        tab.url = e.url;
        tab.loading = true;
        tab.showSkip = false;
        hideError();

        if (tab.id === activeTabId) {
            showIframeLoading(true, tab.url);
        }

        try {
            const urlObj = new URL(e.url);
            tab.title = urlObj.hostname;
            tab.favicon = `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=32`;
        } catch {
            tab.title = "Browsing";
            tab.favicon = null;
        }
        updateTabsUI();
        updateAddressBar();
        updateLoadingBar(tab, 10);
        persistSession();

        if (tab.skipTimeout) clearTimeout(tab.skipTimeout);
        tab.skipTimeout = setTimeout(() => {
            if (tab.loading) {
                tab.showSkip = true;
                if (tab.id === activeTabId) showIframeLoading(true, tab.url);
            }
        }, 8000);
    });

    frame.frame.addEventListener("load", () => {
        tab.loading = false;
        if (tab.skipTimeout) { clearTimeout(tab.skipTimeout); tab.skipTimeout = null; }

        if (tab.id === activeTabId) showIframeLoading(false);

        // The service worker renders an HTML error page when the proxy fails
        try {
            const win = frame.frame.contentWindow;
            if (win && win.document && win.document.title === "Proxy Error") {
                showFrameError((win.document.body && win.document.body.innerText) || "Connection failed");
                updateTabsUI();
                updateAddressBar();
                persistSession();
                return;
            }
        } catch { /* cross-origin — ignore */ }

        try {
            const title = frame.frame.contentWindow.document.title;
            if (title) tab.title = title;
        } catch { /* cross-origin — ignore */ }

        try {
            const href = frame.frame.contentWindow.location.href;
            if (href.includes("NT.html")) {
                tab.title = "New Tab";
                tab.url = "";
                tab.favicon = null;
            }
        } catch { /* ignore */ }

        updateTabsUI();
        updateAddressBar();
        updateLoadingBar(tab, 100);
        persistSession();
    });

    tabs.push(tab);
    document.getElementById("iframe-container").appendChild(frame.frame);
    if (makeActive) switchTab(tab.id);
    return tab;
}

function showIframeLoading(show, url = "") {
    const loader = document.getElementById("loading");
    const title = document.getElementById("loading-title");
    const urlText = document.getElementById("loading-url");
    const skipBtn = document.getElementById("skip-btn");

    if (loader) {
        loader.style.display = show ? "flex" : "none";
        const tab = getActiveTab();
        if (tab) tab.frame.frame.classList.toggle("loading", show);
        if (show) {
            title.textContent = transportReady ? "Loading" : "Connecting";
            urlText.textContent = url || "Loading content...";
            skipBtn.style.display = tab && tab.showSkip ? "inline-block" : "none";
        }
    }
}

function switchTab(tabId) {
    activeTabId = tabId;
    const tab = getActiveTab();
    tabs.forEach(t => t.frame.frame.classList.toggle("hidden", t.id !== tabId));

    if (tab) {
        showIframeLoading(tab.loading, tab.url);
        if (tab.loading) {
            const skipBtn = document.getElementById("skip-btn");
            if (skipBtn) skipBtn.style.display = tab.showSkip ? "inline-block" : "none";
        }
    }

    updateTabsUI();
    updateAddressBar();
    persistSession();
}

function closeTab(tabId) {
    const idx = tabs.findIndex(t => t.id === tabId);
    if (idx === -1) return;

    if (tabs[idx].skipTimeout) clearTimeout(tabs[idx].skipTimeout);
    tabs[idx].frame.frame.remove();
    tabs.splice(idx, 1);

    if (activeTabId === tabId) {
        if (tabs.length > 0) switchTab(tabs[Math.max(0, idx - 1)].id);
        else createTab(true);
    } else {
        updateTabsUI();
    }
    persistSession();
}

function updateTabsUI() {
    const container = document.getElementById("tabs-container");
    container.innerHTML = "";

    tabs.forEach(tab => {
        const el = document.createElement("div");
        el.className = `tab ${tab.id === activeTabId ? "active" : ""}`;

        let iconHtml;
        if (tab.loading) {
            iconHtml = `<div class="tab-spinner"></div>`;
        } else if (tab.favicon) {
            iconHtml = `<img src="${tab.favicon}" class="tab-favicon" onerror="this.style.display='none'" alt="">`;
        } else {
            iconHtml = ``;
        }

        el.innerHTML = `
            ${iconHtml}
            <span class="tab-title">${escapeHtml(tab.title)}</span>
            <span class="tab-close">&times;</span>
        `;

        el.onclick = () => switchTab(tab.id);
        el.addEventListener("auxclick", (e) => { if (e.button === 1) { e.preventDefault(); closeTab(tab.id); } });
        el.querySelector(".tab-close").onclick = (e) => { e.stopPropagation(); closeTab(tab.id); };
        container.appendChild(el);
    });

    const newBtn = document.createElement("button");
    newBtn.className = "new-tab";
    newBtn.innerHTML = "<i class='fa-solid fa-plus'></i>";
    newBtn.onclick = () => createTab(true);
    container.appendChild(newBtn);
}

function updateAddressBar() {
    const bar = document.getElementById("address-bar");
    const tab = getActiveTab();
    if (bar && tab) {
        bar.value = (tab.url && !tab.url.includes("NT.html")) ? tab.url : "";
    }
}

function getActiveTab() { return tabs.find(t => t.id === activeTabId); }

function handleSubmit(url) {
    const tab = getActiveTab();
    if (!tab) return;
    let input = url || document.getElementById("address-bar").value.trim();
    if (!input) return;

    // Block dangerous schemes
    if (/^\s*javascript:/i.test(input)) return;

    // No scheme → guess
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input)) {
        if (/^localhost(:\d+)?([/?#]|$)/.test(input)) {
            input = "http://" + input; // local servers are http
        } else if (input.includes(".") && !input.includes(" ")) {
            input = "https://" + input;
        } else {
            input = SEARCH_ENGINE + encodeURIComponent(input);
        }
    }
    tab.frame.go(input);
}

function reloadActive() {
    const tab = getActiveTab();
    if (tab) tab.frame.reload();
}

function updateLoadingBar(tab, percent) {
    if (tab.id !== activeTabId) return;
    const bar = document.getElementById("loading-bar");
    if (!bar) return;
    bar.style.width = percent + "%";
    bar.style.opacity = percent === 100 ? "0" : "1";
    if (percent === 100) setTimeout(() => { bar.style.width = "0%"; }, 200);
}

// =====================================================
// SESSION RESTORE
// =====================================================
function persistSession() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
        try {
            const urls = tabs.map(t => (t.url && !t.url.includes("NT.html") ? t.url : ""));
            const idx = Math.max(0, tabs.findIndex(t => t.id === activeTabId));
            sessionStorage.setItem(SESSION_KEY, JSON.stringify({ tabs: urls, active: idx }));
        } catch (_e) { /* noop */ }
    }, 400);
}

function restoreSession() {
    let data = null;
    try { data = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); } catch (_e) { /* noop */ }

    const urls = (data && Array.isArray(data.tabs) ? data.tabs : [])
        .map(u => (typeof u === "string" ? u.trim() : ""))
        .filter(u => u && !u.includes("NT.html"));

    if (!urls.length) return false;

    // restoreSession runs before any default tab exists, so just build the
    // restored tabs (first one active).
    urls.forEach((u, i) => {
        const tab = createTab(i === 0);
        tab.frame.go(u);
    });

    toast(`Restored ${urls.length} tab${urls.length > 1 ? "s" : ""}`, "info", 2500);
    return true;
}

// =====================================================
// SETTINGS & WISP
// =====================================================
function openSettings() {
    const modal = document.getElementById("wisp-settings-modal");
    if (!modal) return;
    modal.classList.remove("hidden");

    document.getElementById("close-wisp-modal").onclick = () => modal.classList.add("hidden");
    document.getElementById("save-custom-wisp").onclick = saveCustomWisp;

    const refresh = document.getElementById("refresh-servers");
    if (refresh) {
        refresh.onclick = () => {
            refresh.classList.add("spinning");
            renderServerList(() => setTimeout(() => refresh.classList.remove("spinning"), 400));
        };
    }

    modal.onclick = (e) => { if (e.target === modal) modal.classList.add("hidden"); };
    renderServerList();
}

function getStoredWisps() { return CONFIG.getStoredWisps(); }

function renderServerList(done) {
    const list = document.getElementById("server-list");
    if (!list) return;
    list.innerHTML = "";

    const currentUrl = CONFIG.getActiveWisp();
    const allWisps = CONFIG.getAllServers();
    const checks = [];

    allWisps.forEach((server, index) => {
        const isActive = server.url === currentUrl;
        const isCustom = index >= CONFIG.WISP_SERVERS.length;

        const item = document.createElement("div");
        item.className = `wisp-option ${isActive ? "active" : ""} checking`;

        const deleteBtn = isCustom
            ? `<button class="delete-wisp-btn" title="Remove server"><i class="fa-solid fa-trash"></i></button>`
            : "";

        item.innerHTML = `
            <div class="wisp-option-header">
                <div class="wisp-option-name">
                    ${escapeHtml(server.name)}
                    ${isActive ? '<i class="fa-solid fa-check" style="margin-left:8px; font-size:0.7em; color:var(--accent);"></i>' : ""}
                </div>
                <div class="server-status">
                    <span class="ping-text">Checking…</span>
                    <div class="status-indicator"></div>
                    ${deleteBtn}
                </div>
            </div>
            <div class="wisp-option-url">${escapeHtml(server.url)}</div>
        `;

        item.onclick = () => setWisp(server.url);
        const del = item.querySelector(".delete-wisp-btn");
        if (del) del.onclick = (e) => { e.stopPropagation(); deleteCustomWisp(server.url); };

        list.appendChild(item);
        checks.push(checkServerHealth(server.url, item));
    });

    Promise.allSettled(checks).then(() => {
        if (typeof done === "function") done();
    });
}

function saveCustomWisp() {
    const input = document.getElementById("custom-wisp-input");
    const url = input.value.trim();

    if (!url) return;
    if (!CONFIG.isValidWispUrl(url)) {
        toast("<b>Invalid server URL</b><br>Must start with wss:// or ws://", "error", 4000);
        return;
    }

    const all = CONFIG.getAllServers();
    if (all.some(w => w.url === url)) {
        toast("This server is already in the list", "warning", 3500);
        return;
    }

    const custom = getStoredWisps();
    custom.push({ name: `Custom ${custom.length + 1}`, url });
    try { localStorage.setItem(CONFIG.CUSTOM_KEY, JSON.stringify(custom)); } catch (_e) { /* noop */ }

    toast("Custom server added", "success", 3000);
    input.value = "";
    renderServerList();
}

function deleteCustomWisp(urlToDelete) {
    const custom = getStoredWisps().filter(w => w.url !== urlToDelete);
    try { localStorage.setItem(CONFIG.CUSTOM_KEY, JSON.stringify(custom)); } catch (_e) { /* noop */ }

    if (CONFIG.getActiveWisp() === urlToDelete) {
        setWisp(CONFIG.DEFAULT_WISP);
    } else {
        renderServerList();
    }
}

async function checkServerHealth(url, element) {
    const dot = element.querySelector(".status-indicator");
    const text = element.querySelector(".ping-text");
    const latency = await CONFIG.probeServer(url, 3000);
    element.classList.remove("checking");

    if (latency === null) {
        dot.classList.add("status-error");
        text.textContent = "Offline";
    } else {
        dot.classList.add("status-success");
        text.textContent = `${latency}ms`;
    }
}

async function setWisp(url) {
    if (!CONFIG.isValidWispUrl(url)) {
        toast("Invalid server URL", "error", 3000);
        return;
    }

    const oldUrl = CONFIG.getActiveWisp();
    if (oldUrl === url) {
        const modal = document.getElementById("wisp-settings-modal");
        if (modal) modal.classList.add("hidden");
        return;
    }

    CONFIG.saveWisp(url); // persists + tells the SW (it re-creates the transport)
    setProxyStatus("connecting", "Switching…");
    toast(`Switching to <b>${CONFIG.serverName(url)}</b>…`, "info", 4000);

    try {
        if (connection && typeof connection.setTransport === "function") {
            await withTimeout(
                connection.setTransport(CONFIG.TRANSPORT_URL, [{ wisp: url }]),
                10000, "Transport setup timed out"
            );
        }
        setProxyStatus("connected", "Connected · " + CONFIG.serverName(url));
        toast(`Connected to <b>${CONFIG.serverName(url)}</b>`, "success", 3000);
    } catch (err) {
        console.warn("setWisp transport failed:", err);
        setProxyStatus("offline", "Offline");
        toast("Could not connect to that server", "error", 5000);
    }

    // Reload the active tab so it runs on the new server
    const tab = getActiveTab();
    if (tab && tab.url && !tab.url.includes("NT.html")) tab.frame.reload();

    const modal = document.getElementById("wisp-settings-modal");
    if (modal) modal.classList.add("hidden");
    renderServerList();
}

// =====================================================
// PROXY STATUS PILL
// =====================================================
function setProxyStatus(state, label) {
    const pill = document.getElementById("proxy-status");
    const dot = document.getElementById("proxy-status-dot");
    const lbl = document.getElementById("proxy-status-label");
    if (!pill) return;
    pill.dataset.state = state; // connecting | connected | offline
    if (dot) dot.className = "status-dot";
    if (lbl) lbl.textContent = label;
    pill.title = `Proxy: ${label} — click to change server`;
}

// =====================================================
// TOASTS
// =====================================================
function toast(message, type = "info", ms = 3200) {
    let container = document.getElementById("toast-container");
    if (!container) {
        container = document.createElement("div");
        container.id = "toast-container";
        document.body.appendChild(container);
    }
    const el = document.createElement("div");
    el.className = `toast toast-${type}`;
    el.innerHTML = message;
    container.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    setTimeout(() => {
        el.classList.remove("show");
        setTimeout(() => el.remove(), 300);
    }, ms);
}

// =====================================================
// UTILITIES
// =====================================================
function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
}

// =====================================================
// FULLSCREEN (whole proxy browser, not the active tab)
// =====================================================
function toggleFullscreen() {
    const doc = document;
    if (doc.fullscreenElement) {
        doc.exitFullscreen().catch(() => { /* noop */ });
        return;
    }
    const el = doc.documentElement;
    if (el.requestFullscreen) {
        el.requestFullscreen().catch(() => {
            toast("Fullscreen blocked — allow fullscreen for this page", "warning", 4000);
        });
    }
}

function updateFullscreenIcon() {
    const btn = document.getElementById("fullscreen-btn");
    if (!btn) return;
    const active = !!document.fullscreenElement;
    btn.classList.toggle("active", active);
    btn.innerHTML = active
        ? "<i class='fa-solid fa-compress'></i>"
        : "<i class='fa-solid fa-expand'></i>";
    btn.title = active ? "Exit fullscreen (F11)" : "Fullscreen (F11)";
}

document.addEventListener("fullscreenchange", updateFullscreenIcon);

try {
    if (window.parent && window.parent !== window && window.parent.document) {
        // Re-check once the parent allows fullscreen
        window.addEventListener("focus", updateFullscreenIcon);
    }
} catch (_e) { /* noop */ }

function toggleDevTools() {
    const win = getActiveTab()?.frame.frame.contentWindow;
    if (!win) return;
    if (win.eruda) { win.eruda.show(); return; }
    const script = win.document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/eruda";
    script.onload = () => { win.eruda.init(); win.eruda.show(); };
    win.document.body.appendChild(script);
}

async function checkHashParameters() {
    if (window.location.hash) {
        const hash = decodeURIComponent(window.location.hash.substring(1));
        if (hash) handleSubmit(hash);
        history.replaceState(null, null, location.pathname);
    }
}
