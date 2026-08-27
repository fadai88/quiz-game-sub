/**
 * public/net.js — network layer shared by the web page and the native app.
 *
 * On the web nothing changes: the page is served by the same origin it talks to,
 * so relative `/api/...` calls and a bare `io()` already do the right thing, and
 * the session rides in an HttpOnly cookie.
 *
 * Inside the Capacitor app the picture is different:
 *   - the page is loaded from the APK (origin `https://localhost`), so a relative
 *     `/api/...` would resolve to the phone itself and 404;
 *   - there is no cookie jar, so the session token must travel in an
 *     `Authorization: Bearer` header instead.
 *
 * Rather than rewrite the ~20 existing `fetch("/api/...")` call sites across
 * game.js, login.js, leaderboard.js and friends, this file wraps `window.fetch`
 * once and rewrites root-relative API paths to the configured server. That keeps
 * the diff in the game code near zero and gives one place to reason about where
 * the session token is allowed to go.
 *
 * MUST be loaded before any script that calls fetch() or io() at import time
 * (login.js and game.js both do).
 */
(function () {
  "use strict";

  // Capacitor injects this global; on the web it is simply absent.
  const isNative = !!(
    window.Capacitor &&
    typeof window.Capacitor.isNativePlatform === "function" &&
    window.Capacitor.isNativePlatform()
  );

  // Where the server lives. Empty string on the web means "same origin", which
  // is what every existing relative path already assumes. The native build gets
  // a real URL injected by mobile/scripts/sync-web.js at build time.
  const apiBase = (isNative ? window.__API_BASE__ || "" : "").replace(
    /\/+$/,
    ""
  );

  if (isNative && !apiBase) {
    // Loud on purpose: a native build with no server URL cannot do anything at
    // all, and failing silently here would surface as a confusing 404 storm.
    console.error(
      "[net] Native build has no API base URL. Rebuild with API_BASE set."
    );
  }

  // The origin the bearer token may be sent to. Anything else — an RPC endpoint,
  // an image host, a wallet's API — must never see the session token.
  const apiOrigin = apiBase ? new URL(apiBase).origin : window.location.origin;

  // ── Session token (native only) ───────────────────────────────────────────
  // The web keeps using its HttpOnly cookie, which JS cannot read and therefore
  // cannot leak. In the app the WebView only ever runs our own bundled assets
  // (no remote scripts, no user content), so localStorage is an acceptable home
  // for the token; there is no third-party script in the page to steal it.
  const TOKEN_KEY = "sessionToken";

  function getSessionToken() {
    if (!isNative) return null;
    try {
      return window.localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  }

  function setSessionToken(token) {
    if (!isNative) return;
    try {
      if (token) window.localStorage.setItem(TOKEN_KEY, token);
      else window.localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage unavailable — the session simply won't persist a restart */
    }
  }

  // ── URL helpers ───────────────────────────────────────────────────────────

  // Root-relative paths ("/api/config") are the ones the app must redirect at
  // the server. Everything else — absolute URLs, "./thing.js", data: URIs — is
  // left exactly as the caller wrote it.
  function isRootRelative(url) {
    return (
      typeof url === "string" && url.startsWith("/") && !url.startsWith("//")
    );
  }

  function apiUrl(path) {
    return isRootRelative(path) ? apiBase + path : path;
  }

  // True when the request is going to our own server and may carry the session.
  function isApiDestination(url) {
    try {
      return new URL(url, window.location.href).origin === apiOrigin;
    } catch {
      return false;
    }
  }

  // ── fetch wrapper ─────────────────────────────────────────────────────────

  const originalFetch = window.fetch.bind(window);

  window.fetch = function patchedFetch(input, init) {
    // Only string URLs are rewritten. A Request object already carries a fully
    // resolved URL, and rebuilding one loses body/stream state.
    const rewritten =
      typeof input === "string" && isRootRelative(input)
        ? apiBase + input
        : input;

    if (!isNative) return originalFetch(rewritten, init);

    const target = typeof rewritten === "string" ? rewritten : rewritten.url;
    if (!isApiDestination(target)) {
      // Third-party host (Solana RPC, etc.) — pass through untouched so the
      // session token cannot escape to it.
      return originalFetch(rewritten, init);
    }

    const opts = Object.assign({}, init);
    const headers = new Headers(opts.headers || {});
    // Tells routes/auth.js to hand back the session token in the login response
    // body, since we have nowhere to put a cookie.
    headers.set("X-Client-Type", "native");
    const token = getSessionToken();
    if (token && !headers.has("Authorization")) {
      headers.set("Authorization", "Bearer " + token);
    }
    opts.headers = headers;
    return originalFetch(rewritten, opts);
  };

  // ── socket.io helper ──────────────────────────────────────────────────────

  // Mirrors the fetch story: same-origin on the web, explicit URL plus a bearer
  // token in the handshake on native (socket/index.js accepts either).
  function connectSocket(options) {
    const opts = Object.assign({ withCredentials: true }, options || {});
    if (isNative) {
      opts.auth = Object.assign({}, opts.auth, { token: getSessionToken() });
      return window.io(apiBase, opts);
    }
    return window.io(opts);
  }

  window.AppNet = {
    isNative,
    apiBase,
    apiUrl,
    connectSocket,
    getSessionToken,
    setSessionToken,
  };
})();
