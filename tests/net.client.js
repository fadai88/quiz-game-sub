"use strict";

/**
 * Tests for public/net.js — the browser/native network shim.
 *
 * This is client code, so it normally only runs on a device. The one property
 * that must not be got wrong is where the session token is allowed to travel:
 * the shim attaches an `Authorization: Bearer` header automatically, and the
 * game also talks to third parties (Solana RPC endpoints) from the same page.
 * Sending the token to one of those would hand a stranger the session.
 *
 * The real file is executed in a vm with a hand-built `window`, so what is
 * tested is the shipped source rather than a copy of its logic.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { expect } = require("chai");

const NET_JS = fs.readFileSync(
  path.join(__dirname, "..", "public", "net.js"),
  "utf8"
);

const API_BASE = "https://play.example.com";

/**
 * Execute net.js against a fake browser.
 * @param {object} opts native: pretend to be the Capacitor app; token: stored session
 * @returns {{sandbox: object, calls: Array}} calls records every fetch the shim made
 */
function loadNet({ native = false, token = null, apiBase = API_BASE } = {}) {
  const calls = [];
  const store = new Map();
  if (token) store.set("sessionToken", token);

  const sandbox = {
    console: { error() {}, warn() {}, log() {} },
    Headers: global.Headers,
    URL: global.URL,
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve({ ok: true });
    },
  };

  sandbox.window = {
    __API_BASE__: apiBase,
    location: {
      origin: "https://localhost",
      href: "https://localhost/game.html",
    },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    },
    fetch: sandbox.fetch,
    io: (...args) => ({ ioArgs: args }),
    Capacitor: native ? { isNativePlatform: () => true } : undefined,
  };
  // net.js reads bare `window`, `Headers` and `URL` off the global scope.
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(NET_JS, sandbox);
  return { sandbox, calls, store };
}

describe("net.js — web build", () => {
  it("reports itself as not native", () => {
    const { sandbox } = loadNet({ native: false });
    expect(sandbox.window.AppNet.isNative).to.equal(false);
  });

  it("leaves relative URLs alone — same-origin already works", async () => {
    const { sandbox, calls } = loadNet({ native: false });
    await sandbox.window.fetch("/api/config");
    expect(calls[0].url).to.equal("/api/config");
  });

  it("never attaches an Authorization header", async () => {
    const { sandbox, calls } = loadNet({ native: false, token: "web-token" });
    await sandbox.window.fetch("/api/config");
    // The web session is an HttpOnly cookie; JS holding a token would be a
    // regression, not a feature.
    expect(calls[0].init).to.equal(undefined);
  });

  it("connects the socket to its own origin", () => {
    const { sandbox } = loadNet({ native: false });
    const socket = sandbox.window.AppNet.connectSocket();
    expect(socket.ioArgs[0]).to.deep.equal({ withCredentials: true });
  });

  it("does not persist a session token", () => {
    const { sandbox, store } = loadNet({ native: false });
    sandbox.window.AppNet.setSessionToken("should-not-be-stored");
    expect(store.has("sessionToken")).to.equal(false);
  });
});

describe("net.js — native build", () => {
  it("rewrites root-relative API paths to the configured server", async () => {
    const { sandbox, calls } = loadNet({ native: true });
    await sandbox.window.fetch("/api/config");
    expect(calls[0].url).to.equal(`${API_BASE}/api/config`);
  });

  it("attaches the bearer token and native client type", async () => {
    const { sandbox, calls } = loadNet({ native: true, token: "abc123" });
    await sandbox.window.fetch("/api/attest/nonce", { method: "POST" });

    const headers = calls[0].init.headers;
    expect(headers.get("Authorization")).to.equal("Bearer abc123");
    expect(headers.get("X-Client-Type")).to.equal("native");
    expect(calls[0].init.method).to.equal("POST");
  });

  it("preserves caller-supplied headers", async () => {
    const { sandbox, calls } = loadNet({ native: true, token: "abc123" });
    await sandbox.window.fetch("/api/attest/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(calls[0].init.headers.get("Content-Type")).to.equal(
      "application/json"
    );
    expect(calls[0].init.headers.get("Authorization")).to.equal(
      "Bearer abc123"
    );
  });

  it("NEVER sends the session token to a third-party host", async () => {
    const { sandbox, calls } = loadNet({ native: true, token: "secret-token" });

    // The game talks to a Solana RPC from the same page. That request must not
    // carry the session that controls the player's account and funds.
    await sandbox.window.fetch("https://api.devnet.solana.com", {
      method: "POST",
    });

    const init = calls[0].init;
    const auth =
      init.headers && init.headers.get && init.headers.get("Authorization");
    expect(auth == null).to.equal(true);
  });

  it("does not rewrite absolute URLs", async () => {
    const { sandbox, calls } = loadNet({ native: true });
    await sandbox.window.fetch("https://api.devnet.solana.com/x");
    expect(calls[0].url).to.equal("https://api.devnet.solana.com/x");
  });

  it("does not rewrite protocol-relative URLs into the API base", async () => {
    const { sandbox, calls } = loadNet({ native: true });
    await sandbox.window.fetch("//evil.example.com/x");
    expect(calls[0].url).to.equal("//evil.example.com/x");
  });

  it("sends no Authorization header when there is no session yet", async () => {
    const { sandbox, calls } = loadNet({ native: true, token: null });
    await sandbox.window.fetch("/api/config");
    expect(calls[0].init.headers.has("Authorization")).to.equal(false);
    // X-Client-Type still goes, so login knows to return the token in the body.
    expect(calls[0].init.headers.get("X-Client-Type")).to.equal("native");
  });

  it("connects the socket to the API base with the token in the handshake", () => {
    const { sandbox } = loadNet({ native: true, token: "abc123" });
    const socket = sandbox.window.AppNet.connectSocket();
    expect(socket.ioArgs[0]).to.equal(API_BASE);
    expect(socket.ioArgs[1].auth.token).to.equal("abc123");
  });

  it("round-trips and clears the session token", () => {
    const { sandbox } = loadNet({ native: true });
    sandbox.window.AppNet.setSessionToken("t1");
    expect(sandbox.window.AppNet.getSessionToken()).to.equal("t1");
    sandbox.window.AppNet.setSessionToken(null);
    expect(sandbox.window.AppNet.getSessionToken()).to.equal(null);
  });
});
