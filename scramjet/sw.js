// =====================================================
// osmium scramjet — service worker
// Intercepts proxied requests under /scramjet/ and
// routes them through the WISP transport.
//
// Design notes:
//  • The transport lives in the shared bareworker, configured by the
//    page (and re-configured here when we need to fail over).
//  • `scramjet.client` is scramjet's OWN embedded client — it must NOT
//    be overwritten (external bare-mux connections have no `fetch`).
//  • Resilience: transport re-creation on dead sockets, automatic
//    failover to the next server (pages are notified so localStorage
//    and the status pill stay in sync), friendly HTML error pages.
// =====================================================
"use strict";

const swPath = self.location.pathname;
const basePath = swPath.substring(0, swPath.lastIndexOf("/") + 1);
self.basePath = self.basePath || basePath;

// Shared configuration (server list, transport URL, core files)
importScripts("./wisp-config.js");
const CFG = self.WispConfig || {};
const DEFAULT_WISP = CFG.DEFAULT_WISP || "wss://anura.pro/";
const TRANSPORT_URL = CFG.TRANSPORT_URL || "https://cdn.jsdelivr.net/npm/@mercuryworkshop/epoxy-transport@2.1.28/dist/index.mjs";

// ---- load the Scramjet core (it embeds its own bare-mux) ----
self.$scramjet = { files: CFG.SCRAMJET_FILES || {} };
self.__scramjetReady = false;

try {
    importScripts("https://cdn.jsdelivr.net/gh/Destroyed12121/Staticsj@main/JS/scramjet.all.js");
    // Global bare-mux is only used here to (re)configure the shared worker
    // transport. scramjet's own embedded client performs the actual fetches.
    // Pinned — matches the bundled bareworker.js.
    importScripts(CFG.BARE_MUX_URL || "https://cdn.jsdelivr.net/npm/@mercuryworkshop/bare-mux@2.1.7/dist/index.js");
    self.__scramjetReady = true;
} catch (err) {
    console.error("SW: scramjet core failed to load:", err);
}

let scramjet = null;
if (self.__scramjetReady && typeof $scramjetLoadWorker === "function") {
    try {
        const { ScramjetServiceWorker } = $scramjetLoadWorker();
        scramjet = new ScramjetServiceWorker({ prefix: basePath + "scramjet/" });
    } catch (err) {
        console.error("SW: could not construct ScramjetServiceWorker:", err);
    }
}

self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// ---- fetch interception ----
// Anything that isn't a scramjet URL is passed straight through.
self.addEventListener("fetch", (event) => {
    if (!scramjet || !self.__scramjetReady) return; // no core → plain browsing
    event.respondWith((async () => {
        try {
            await ensureConfigLoaded();
            if (scramjet.route(event)) {
                return await scramjet.fetch(event);
            }
            return fetch(event.request);
        } catch (err) {
            console.warn("SW: fetch fallback for", event.request.url, err);
            return fetch(event.request);
        }
    })());
});

let configLoadedPromise = null;
function ensureConfigLoaded() {
    if (!configLoadedPromise) configLoadedPromise = scramjet.loadConfig().catch(() => null);
    return configLoadedPromise;
}

// ---- WISP configuration from the page ----
let wispConfig = {};
let resolveConfigReady;
const configReadyPromise = new Promise(resolve => resolveConfigReady = resolve);

self.addEventListener("message", ({ data }) => {
    if (data && data.type === "config" && data.wispurl) {
        const changed = wispConfig.wispurl && data.wispurl !== wispConfig.wispurl;
        wispConfig.wispurl = data.wispurl;
        if (Array.isArray(data.customUrls)) wispConfig.customUrls = data.customUrls;
        if (changed) {
            // Server changed mid-session → the shared worker transport
            // will be re-created against the new server on next request.
            transportUrl = null;
            console.log("SW: proxy server changed → transport will re-init on next request");
        }
        if (resolveConfigReady) {
            resolveConfigReady();
            resolveConfigReady = null;
        }
    }
});

// Fallback: if the page never sends config (e.g. SW updated while idle),
// use the default server so requests don't fail forever.
setTimeout(() => {
    if (!wispConfig.wispurl && resolveConfigReady) {
        console.warn("SW: config timeout, using default server");
        wispConfig.wispurl = DEFAULT_WISP;
        resolveConfigReady();
        resolveConfigReady = null;
    }
}, 1500);

// ---- transport management (shared bareworker) ----
let transportUrl = null; // server the shared worker transport is configured for

function withTimeout(promise, ms, label) {
    return Promise.race([
        Promise.resolve(promise),
        new Promise((_, reject) => setTimeout(() => reject(new Error(label + " timed out")), ms))
    ]);
}

// Configures the shared worker's transport (idempotent per server).
// The external connection is thrown away — only the transport state in
// the shared worker matters; scramjet's own client fetches through it.
async function ensureTransport(url) {
    if (transportUrl === url) return;
    const connection = new BareMux.BareMuxConnection(basePath + "bareworker.js");
    await withTimeout(connection.setTransport(TRANSPORT_URL, [{ wisp: url }]), 10000, "transport setup");
    transportUrl = url;
}

function isTransportDead(err) {
    const msg = String(err && err.message || err).toLowerCase();
    return /wsimplsocketclosed|websocket closed|connection closed|connect|eof|handshake|reset|network|timeout|socket/i.test(msg);
}

// =========================================================
// Error page renderer — self-contained themed HTML for every
// HTTP status that the proxy might return.
// =========================================================
function getErrorTitle(status) {
    const titles = {
        400: "Bad Request", 403: "Forbidden", 404: "Page Not Found",
        408: "Request Timeout", 413: "Payload Too Large",
        429: "Too Many Requests", 500: "Internal Server Error",
        502: "Bad Gateway", 503: "Service Unavailable",
        504: "Gateway Timeout", 529: "Rate Limited"
    };
    return titles[status] || `Error ${status}`;
}

function getErrorDesc(status, rawMessage) {
    const m = String(rawMessage || "");
    // Default descriptions per status code
    if (status === 404) return "The page you're trying to reach doesn't exist or can't be found through the proxy.";
    if (status === 502) return "The proxy server couldn't connect to the target site. The server may be down, unreachable, or the WISP transport failed.";
    if (status === 529) return "The WISP proxy server is rate-limiting requests. Wait a moment and try again.";
    if (status === 504) return "The connection to the target site timed out. The server might be too slow or overloaded.";
    if (status === 408) return "The request took too long and timed out.";
    if (status === 429) return "Too many requests were sent. Wait a moment before trying again.";
    if (status === 500) return "Something went wrong inside the proxy server.";
    if (status === 503) return "The proxy service is temporarily unavailable. The WISP server might be restarting.";
    if (status === 413) return "The request is too large for the proxy to handle.";
    // Fallback: show the raw error message (already HTML-escaped at call site)
    return m || "An unexpected error occurred while loading the page.";
}

function statusFromError(err) {
    const msg = String(err && err.message || err || "").toLowerCase();
    if (/rate.?limit|529|too many/i.test(msg)) return 529;
    if (/timeout|timed.?out/i.test(msg)) return 504;
    if (/not.?found|404|no.?dns|nxdomain|enotfound/i.test(msg)) return 404;
    if (/forbidden|403|blocked/i.test(msg)) return 403;
    if (/too.?large|413/i.test(msg)) return 413;
    return 502; // most proxy errors = bad gateway
}

function renderErrorPage(status, url, message) {
    const safeUrl = String(url || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const safeMsg = String(message || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const title = getErrorTitle(status);
    const desc = getErrorDesc(status, safeMsg);
    const codeStr = String(status);
    const is5xx = status >= 500 && status < 600;
    const accent = is5xx ? "#ef4444" : "#f59e0b";

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — osmium</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{
    background:radial-gradient(ellipse 60% 45% at 15% -5%,${accent}18 0%,transparent 60%),radial-gradient(ellipse 55% 40% at 95% 10%,${accent}12 0%,transparent 60%),radial-gradient(ellipse 70% 55% at 50% 110%,${accent}0a 0%,transparent 60%),#0c0a09;
    color:#e4e4e7;
    font-family:system-ui,-apple-system,sans-serif;
    min-height:100vh;
    display:flex;
    align-items:center;
    justify-content:center;
    padding:24px;
  }
  .card{text-align:center;max-width:440px;animation:rise .35s ease both}
  .code{
    font-size:clamp(4rem,10vw,6.5rem);
    font-weight:900;
    letter-spacing:-4px;
    line-height:1;
    background:linear-gradient(135deg,${accent} 0%,${accent}88 100%);
    -webkit-background-clip:text;
    background-clip:text;
    -webkit-text-fill-color:transparent;
    filter:drop-shadow(0 4px 20px ${accent}60);
    margin-bottom:10px;
  }
  h1{font-size:1.25rem;font-weight:700;margin:0 0 8px}
  .desc{color:#a8a29e;font-size:13px;line-height:1.6;margin-bottom:6px;word-break:break-word}
  .url{color:#78716c;font-size:11px;font-family:monospace;word-break:break-all;margin-bottom:22px}
  .btns{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
  .btn{
    display:inline-flex;align-items:center;gap:8px;
    padding:9px 18px;border-radius:9999px;border:1px solid #44403c;
    background:#1c1917;color:#e4e4e7;cursor:pointer;font-size:13px;
    font-family:inherit;transition:all .15s;text-decoration:none;
  }
  .btn:hover{background:#231f1f;border-color:${accent};color:${accent};transform:translateY(-1px)}
  .btn.primary{background:${accent};border-color:${accent};color:#fff;font-weight:600}
  .btn.primary:hover{filter:brightness(1.15)}
  @keyframes rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
</style>
</head>
<body>
<div class="card">
  <div class="code">${codeStr}</div>
  <h1>${title}</h1>
  <p class="desc">${desc}</p>
  ${url ? `<p class="url">${safeUrl}</p>` : ""}
  <div class="btns">
    <button class="btn" onclick="history.back()">&#8592; Go Back</button>
    <button class="btn primary" onclick="location.reload()">&#8635; Retry</button>
  </div>
</div>
</body>
</html>`;

    return new Response(html, {
        status: status,
        headers: { "content-type": "text/html; charset=utf-8" }
    });
}

function buildFetchOptions(e) {
    return {
        method: e.method,
        body: e.body,
        headers: e.requestHeaders,
        credentials: "include",
        mode: e.mode === "cors" ? e.mode : "same-origin",
        cache: e.cache,
        redirect: "manual",
        duplex: "half"
    };
}

// Notify every open window so it can persist the new server + update UI
function notifyFailover(fromUrl, toUrl) {
    self.clients.matchAll({ type: "window" }).then((clients) => {
        clients.forEach((c) => c.postMessage({ type: "proxy-failover", url: toUrl, from: fromUrl }));
    }).catch(() => { });
}

// ---- handle proxied requests ----
if (scramjet) {
    scramjet.addEventListener("request", async (e) => {
        e.response = (async () => {
            try {
                await configReadyPromise;
                if (!wispConfig.wispurl) {
                    return renderErrorPage(502, e.url, "Proxy server not configured");
                }
                if (!scramjet.client || typeof scramjet.client.fetch !== "function") {
                    return renderErrorPage(500, e.url, "Proxy client not initialized");
                }

                const options = buildFetchOptions(e);
                const MAX_ATTEMPTS = 2;
                let lastErr = null;
                let transportDead = false;

                // ensureTransport is inside the loop so a setup failure (e.g.
                // the active server being dead) feeds into the retry/failover
                // logic instead of returning a bare 502.
                for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
                    try {
                        await ensureTransport(wispConfig.wispurl);
                        return await scramjet.client.fetch(e.url, options);
                    } catch (err) {
                        lastErr = err;
                        transportDead = isTransportDead(err);
                        if (!transportDead || attempt >= MAX_ATTEMPTS - 1 || e.method !== "GET") break;
                        // Socket died → rebuild the shared transport
                        transportUrl = null;
                        console.warn(`SW: transport reset ${attempt + 1}/${MAX_ATTEMPTS - 1} for ${e.url}: ${err.message}`);
                        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
                    }
                }

                // Server itself is unreachable → fail over to the next one
                if (transportDead && lastErr && e.method === "GET") {
                    const candidates = [
                        ...(CFG.WISP_SERVERS || []).map(s => s.url),
                        ...(wispConfig.customUrls || [])
                    ].filter(u => u && u !== wispConfig.wispurl);
                    const nextUrl = candidates[0];
                    if (nextUrl) {
                        const oldUrl = wispConfig.wispurl;
                        wispConfig.wispurl = nextUrl;
                        transportUrl = null;
                        console.warn(`SW: failing over to ${nextUrl}`);
                        notifyFailover(oldUrl, nextUrl);
                        try {
                            await ensureTransport(nextUrl);
                            return await scramjet.client.fetch(e.url, options);
                        } catch (err2) {
                            lastErr = err2;
                        }
                    }
                }

                console.error("SW: final fetch error:", lastErr);
                const status = lastErr ? statusFromError(lastErr) : 502;
                return renderErrorPage(status, e.url, lastErr && lastErr.message || "unknown error");
            } catch (err) {
                console.error("SW: request handler error:", err);
                const hstatus = err ? statusFromError(err) : 500;
                return renderErrorPage(hstatus, e.url, err && err.message || "unknown error");
            }
        })();
    });
}
