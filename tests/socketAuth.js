"use strict";

/**
 * Socket authentication — the connection middleware and the per-event session
 * check in socket/index.js.
 *
 * Every game action, including staking and answering, runs on a socket. These
 * two functions decide who that socket belongs to:
 *   - the handshake middleware turns a session cookie (browser) or token (native
 *     app) into `socket.user`, after checking the IP block list;
 *   - validateSocketSession re-checks the session on every game event, so a
 *     logout, an expiry, or a newer login elsewhere takes effect immediately
 *     instead of at the next reconnect.
 *
 * Redis is an in-memory fake; sessions are written in the same shape
 * POST /api/auth/login writes them.
 */

// SESSION_SECRET is read when socket/index.js loads; make sure one exists, and
// sign test cookies with whatever value it captured.
process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "socket-auth-test-secret";

const { expect } = require("chai");
const cookieSignature = require("cookie-signature");
const context = require("../context");
const {
  _internal: { registerSocketAuthMiddleware, validateSocketSession },
} = require("../socket/index");

const SECRET = process.env.SESSION_SECRET;
const WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

function fakeRedis() {
  const m = new Map();
  return {
    m,
    failing: false,
    async get(k) {
      if (this.failing) throw new Error("redis down");
      return m.has(k) ? m.get(k) : null;
    },
  };
}

function login(redis, token, wallet = WALLET) {
  redis.m.set(
    `session:${token}`,
    JSON.stringify({ walletAddress: wallet, fingerprint: "fp" })
  );
  redis.m.set(`session:wallet:${wallet}`, token);
}

function fakeSocket({ token, cookie, event, ip = "203.0.113.7" } = {}) {
  const emitted = [];
  return {
    id: "sock-1",
    conn: { transport: { name: "websocket" } },
    handshake: {
      address: ip,
      auth: { ...(token && { token }), ...(event && { event }) },
      headers: { ...(cookie && { cookie }), "user-agent": "test" },
    },
    emitted,
    disconnected: false,
    emit(name, payload) {
      emitted.push({ name, payload });
    },
    disconnect() {
      this.disconnected = true;
    },
  };
}

describe("socket auth", () => {
  let redis;
  let prevRedis;
  let middleware;

  before(() => {
    const io = { use: (fn) => (middleware = fn) };
    registerSocketAuthMiddleware(io);
  });

  beforeEach(() => {
    prevRedis = context.get("redisClient");
    redis = fakeRedis();
    context.set("redisClient", redis);
  });

  afterEach(() => context.set("redisClient", prevRedis));

  // Runs the handshake middleware; resolves with the error passed to next(), or
  // null if the connection was accepted.
  const handshake = (socket) =>
    new Promise((resolve) => middleware(socket, (err) => resolve(err || null)));

  describe("handshake", () => {
    it("accepts a valid signed session cookie and identifies the wallet", async () => {
      login(redis, "tok-browser");
      const signed = "s:" + cookieSignature.sign("tok-browser", SECRET);
      const socket = fakeSocket({
        cookie: `sessionToken=${encodeURIComponent(signed)}`,
      });

      expect(await handshake(socket)).to.equal(null);
      expect(socket.user).to.include({
        walletAddress: WALLET,
        sessionToken: "tok-browser",
      });
    });

    it("accepts the native app's token in handshake.auth", async () => {
      login(redis, "tok-native");
      const socket = fakeSocket({ token: "tok-native" });

      expect(await handshake(socket)).to.equal(null);
      expect(socket.user.walletAddress).to.equal(WALLET);
    });

    it("rejects a cookie whose signature was tampered with", async () => {
      login(redis, "tok-browser");
      const signed = "s:" + cookieSignature.sign("tok-browser", SECRET);
      const forged = signed.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
      const socket = fakeSocket({
        cookie: `sessionToken=${encodeURIComponent(forged)}`,
      });

      expect((await handshake(socket)).message).to.equal("Invalid session");
      expect(socket.user).to.equal(undefined);
    });

    it("rejects a cookie signed with a different secret", async () => {
      login(redis, "tok-browser");
      const signed =
        "s:" + cookieSignature.sign("tok-browser", "not-the-secret");
      const socket = fakeSocket({
        cookie: `sessionToken=${encodeURIComponent(signed)}`,
      });

      expect((await handshake(socket)).message).to.equal("Invalid session");
    });

    it("rejects a token with no session behind it (expired or invented)", async () => {
      const socket = fakeSocket({ token: "tok-made-up" });
      expect((await handshake(socket)).message).to.equal("Session expired");
      expect(socket.user).to.equal(undefined);
    });

    it("rejects a handshake with no credentials at all", async () => {
      expect((await handshake(fakeSocket())).message).to.equal(
        "Authentication required"
      );
    });

    it("rejects cookies that carry no session token", async () => {
      const socket = fakeSocket({ cookie: "theme=dark" });
      expect((await handshake(socket)).message).to.equal("No session cookie");
    });

    it("refuses a block-listed IP even with a valid session", async () => {
      login(redis, "tok-native");
      redis.m.set("blocklist:203.0.113.7", "1");
      const socket = fakeSocket({ token: "tok-native" });

      expect((await handshake(socket)).message).to.equal("Connection refused");
      expect(socket.user).to.equal(undefined);
    });

    it("lets no one in when Redis is down (the block list fails open, the session check does not)", async () => {
      login(redis, "tok-native");
      redis.failing = true;
      const socket = fakeSocket({ token: "tok-native" });

      expect((await handshake(socket)).message).to.equal(
        "Authentication failed"
      );
      expect(socket.user).to.equal(undefined);
    });

    it("lets a login socket connect unauthenticated, but it cannot act as anyone", async () => {
      // The walletLogin handshake skips the session lookup by design (it is how
      // a session gets created). It must leave the socket with no identity.
      const socket = fakeSocket({ event: "walletLogin" });

      expect(await handshake(socket)).to.equal(null);
      expect(socket.user).to.equal(undefined);
      expect(
        await validateSocketSession(socket, "joinHumanMatchmaking")
      ).to.equal(false);
      expect(socket.emitted[0].payload.code).to.equal("AUTH_REQUIRED");
    });
  });

  describe("per-event session check", () => {
    async function connected(token = "tok-1") {
      login(redis, token);
      const socket = fakeSocket({ token });
      expect(await handshake(socket)).to.equal(null);
      return socket;
    }

    it("passes a live session and exposes the current session record", async () => {
      const socket = await connected();
      expect(await validateSocketSession(socket, "submitAnswer")).to.equal(
        true
      );
      expect(socket.sessionData.walletAddress).to.equal(WALLET);
      expect(socket.disconnected).to.equal(false);
    });

    it("sees an update to the session record made after the handshake", async () => {
      // e.g. a fresh device attestation, which the staked-play gate reads here.
      const socket = await connected();
      redis.m.set(
        "session:tok-1",
        JSON.stringify({ walletAddress: WALLET, attestation: { ok: true } })
      );
      await validateSocketSession(socket, "joinHumanMatchmaking");
      expect(socket.sessionData.attestation).to.deep.equal({ ok: true });
    });

    it("cuts off a socket whose session ended after it connected (logout/expiry)", async () => {
      const socket = await connected();
      redis.m.delete("session:tok-1");

      expect(await validateSocketSession(socket, "submitAnswer")).to.equal(
        false
      );
      expect(socket.emitted[0].payload.code).to.equal("SESSION_EXPIRED");
      expect(socket.disconnected).to.equal(true);
    });

    it("cuts off a socket whose wallet logged in again elsewhere", async () => {
      const socket = await connected("tok-old");
      login(redis, "tok-new"); // newer login for the same wallet

      expect(await validateSocketSession(socket, "submitAnswer")).to.equal(
        false
      );
      expect(socket.emitted[0].payload.code).to.equal("SESSION_SUPERSEDED");
      expect(socket.disconnected).to.equal(true);
    });

    it("fails closed when Redis errors mid-session", async () => {
      const socket = await connected();
      redis.failing = true;

      expect(await validateSocketSession(socket, "submitAnswer")).to.equal(
        false
      );
      expect(socket.emitted[0].payload.code).to.equal("AUTH_ERROR");
    });
  });
});
