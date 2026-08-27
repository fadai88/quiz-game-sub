"use strict";

/**
 * Integration tests for routes/attestation.js — the real router, mounted in a
 * real express app, driven over real HTTP. Only the two external systems are
 * faked: Redis (an in-memory map with the handful of commands the route uses)
 * and the Mongo models.
 *
 * The single most important property here is that a nonce is CONSUMED, not just
 * checked: the whole replay defence rests on `DEL` returning 1 exactly once, so
 * a captured attestation token cannot be re-submitted.
 */

const http = require("http");
const express = require("express");
const { expect } = require("chai");
const sinon = require("sinon");

const context = require("../context");
const User = require("../models/User");
const DeviceAttestation = require("../models/DeviceAttestation");

const SESSION_TOKEN = "session-token-under-test";
const WALLET = "BGF2yCpcTSd9BoQ9XBrjKYgABZAy9gTeCocuiweHmQrx";
const PACKAGE = "com.example.quiz";
const DEVICE_SECRET = "install-secret-0123456789abcdef";

// ── Fake Redis ────────────────────────────────────────────────────────────────
// Only what the route touches. `del` returns the number of keys actually
// removed, which is the behaviour the replay defence depends on.
function fakeRedis(initial = {}) {
  const store = new Map(Object.entries(initial));
  const ttls = new Map();
  return {
    store,
    ttls,
    async get(k) {
      return store.has(k) ? store.get(k) : null;
    },
    async set(k, v, mode, ttl) {
      store.set(k, v);
      if (mode === "EX") ttls.set(k, ttl);
      return "OK";
    },
    async del(k) {
      return store.delete(k) ? 1 : 0;
    },
    async ttl(k) {
      return ttls.has(k) ? ttls.get(k) : -1;
    },
    async expire(k, ttl) {
      ttls.set(k, ttl);
      return 1;
    },
  };
}

function healthyPayload(nonce) {
  return JSON.stringify({
    requestDetails: {
      requestPackageName: PACKAGE,
      nonce,
      timestampMillis: String(Date.now()),
    },
    appIntegrity: { appRecognitionVerdict: "PLAY_RECOGNIZED" },
    deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"] },
  });
}

// ── Harness ───────────────────────────────────────────────────────────────────

let sandbox;
let server;
let baseUrl;
let redis;
let savedEnv;

async function request(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body — leave null and let the assertion report the status */
  }
  return { status: res.status, body: json };
}

const authHeader = { Authorization: `Bearer ${SESSION_TOKEN}` };

// ── Tests ─────────────────────────────────────────────────────────────────────
// Everything lives inside this describe on purpose: mocha's root-level hooks
// apply to EVERY file in the suite, so a root `beforeEach` stubbing
// context.redisClient would hand a fake Redis to unrelated tests.
describe("routes/attestation", () => {
  before((done) => {
    savedEnv = {
      ATTESTATION_PROVIDER: process.env.ATTESTATION_PROVIDER,
      ANDROID_PACKAGE_NAME: process.env.ANDROID_PACKAGE_NAME,
    };
    process.env.ATTESTATION_PROVIDER = "mock";
    process.env.ANDROID_PACKAGE_NAME = PACKAGE;

    const app = express();
    app.use(express.json());
    // Mounted exactly as server.js mounts it.
    app.use("/api/attest", require("../routes/attestation"));

    server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  after((done) => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    server.close(done);
  });

  beforeEach(() => {
    sandbox = sinon.createSandbox();

    redis = fakeRedis({
      [`session:${SESSION_TOKEN}`]: JSON.stringify({
        walletAddress: WALLET,
        fingerprint: "fp",
        clientType: "native",
      }),
      [`session:wallet:${WALLET}`]: SESSION_TOKEN,
    });
    sandbox.stub(context, "redisClient").get(() => redis);

    sandbox
      .stub(User, "findOne")
      .resolves({ _id: "user-1", walletAddress: WALLET });
    sandbox.stub(DeviceAttestation, "findOneAndUpdate").resolves({});
  });

  afterEach(() => sandbox.restore());

  describe("auth", () => {
    it("rejects an unauthenticated nonce request", async () => {
      const res = await request("/api/attest/nonce", { method: "POST" });
      expect(res.status).to.equal(401);
    });

    it("accepts a bearer token — the native app has no cookie jar", async () => {
      const res = await request("/api/attest/nonce", {
        method: "POST",
        headers: authHeader,
      });
      expect(res.status).to.equal(200);
      expect(res.body.nonce).to.be.a("string");
    });

    it("rejects a bearer token with no matching session", async () => {
      const res = await request("/api/attest/nonce", {
        method: "POST",
        headers: { Authorization: "Bearer not-a-real-session" },
      });
      expect(res.status).to.equal(401);
    });
  });

  describe("verify", () => {
    async function getNonce() {
      const res = await request("/api/attest/nonce", {
        method: "POST",
        headers: authHeader,
      });
      return res.body.nonce;
    }

    it("verifies a healthy token and marks the session attested", async () => {
      const nonce = await getNonce();

      const res = await request("/api/attest/verify", {
        method: "POST",
        headers: authHeader,
        body: {
          token: healthyPayload(nonce),
          nonce,
          deviceSecret: DEVICE_SECRET,
          platform: "android",
        },
      });

      expect(res.status).to.equal(200);
      expect(res.body.attested).to.equal(true);

      const session = JSON.parse(await redis.get(`session:${SESSION_TOKEN}`));
      expect(session.attested).to.equal(true);
      expect(session.attestedAt).to.be.a("number");
      expect(session.deviceId).to.match(/^[a-f0-9]{64}$/);
      // Pre-existing session fields must survive the read-modify-write.
      expect(session.walletAddress).to.equal(WALLET);
      expect(session.fingerprint).to.equal("fp");
    });

    it("records the device with the wallet bound to it", async () => {
      const nonce = await getNonce();
      await request("/api/attest/verify", {
        method: "POST",
        headers: authHeader,
        body: {
          token: healthyPayload(nonce),
          nonce,
          deviceSecret: DEVICE_SECRET,
          platform: "android",
        },
      });

      expect(DeviceAttestation.findOneAndUpdate.calledOnce).to.equal(true);
      const [filter, update] =
        DeviceAttestation.findOneAndUpdate.firstCall.args;
      expect(filter.deviceId).to.match(/^[a-f0-9]{64}$/);
      expect(update.$addToSet.wallets).to.equal(WALLET);
      expect(update.$inc).to.deep.equal({ verifyCount: 1 });
    });

    it("refuses to reuse a nonce (replay defence)", async () => {
      const nonce = await getNonce();
      const body = {
        token: healthyPayload(nonce),
        nonce,
        deviceSecret: DEVICE_SECRET,
        platform: "android",
      };

      const first = await request("/api/attest/verify", {
        method: "POST",
        headers: authHeader,
        body,
      });
      expect(first.status).to.equal(200);

      // Same token, same nonce, replayed — must not re-attest.
      const second = await request("/api/attest/verify", {
        method: "POST",
        headers: authHeader,
        body,
      });
      expect(second.status).to.equal(401);
      expect(second.body.code).to.equal("NONCE_INVALID");
    });

    it("rejects a nonce that was never issued", async () => {
      const res = await request("/api/attest/verify", {
        method: "POST",
        headers: authHeader,
        body: {
          token: healthyPayload("fabricated-nonce"),
          nonce: "fabricated-nonce",
          deviceSecret: DEVICE_SECRET,
          platform: "android",
        },
      });
      expect(res.status).to.equal(401);
      expect(res.body.code).to.equal("NONCE_INVALID");
    });

    it("rejects a failing verdict and leaves the session unattested", async () => {
      const nonce = await getNonce();
      const rooted = JSON.parse(healthyPayload(nonce));
      rooted.deviceIntegrity.deviceRecognitionVerdict = [
        "MEETS_BASIC_INTEGRITY",
      ];

      const res = await request("/api/attest/verify", {
        method: "POST",
        headers: authHeader,
        body: {
          token: JSON.stringify(rooted),
          nonce,
          deviceSecret: DEVICE_SECRET,
          platform: "android",
        },
      });

      expect(res.status).to.equal(403);
      expect(res.body.code).to.equal("DEVICE_INTEGRITY_FAILED");

      const session = JSON.parse(await redis.get(`session:${SESSION_TOKEN}`));
      expect(session.attested).to.equal(undefined);
    });

    it("counts a failed attempt against the device but binds no wallet", async () => {
      const nonce = await getNonce();
      const rooted = JSON.parse(healthyPayload(nonce));
      rooted.deviceIntegrity.deviceRecognitionVerdict = [];

      await request("/api/attest/verify", {
        method: "POST",
        headers: authHeader,
        body: {
          token: JSON.stringify(rooted),
          nonce,
          deviceSecret: DEVICE_SECRET,
          platform: "android",
        },
      });

      const [, update] = DeviceAttestation.findOneAndUpdate.firstCall.args;
      expect(update.$inc).to.deep.equal({ failCount: 1 });
      // A spoofed failing request must not be able to attach a wallet to someone
      // else's device record.
      expect(update.$addToSet).to.equal(undefined);
    });

    it("rejects a malformed body before touching the nonce", async () => {
      const nonce = await getNonce();
      const res = await request("/api/attest/verify", {
        method: "POST",
        headers: authHeader,
        body: { nonce, platform: "android" }, // no token, no deviceSecret
      });

      expect(res.status).to.equal(400);
      // The nonce must still be usable — a client bug shouldn't burn it.
      expect(await redis.get(`attest:nonce:${WALLET}:${nonce}`)).to.equal("1");
    });

    it("writes the session back with its TTL, never as a session that cannot expire", async () => {
      const nonce = await getNonce();

      await request("/api/attest/verify", {
        method: "POST",
        headers: authHeader,
        body: {
          token: healthyPayload(nonce),
          nonce,
          deviceSecret: DEVICE_SECRET,
          platform: "android",
        },
      });

      // The route read-modify-writes the session record; a plain SET would drop
      // the expiry and leave an immortal session. It carries the TTL over — here
      // the 24h one `authenticate` refreshes on every request.
      const ttl = await redis.ttl(`session:${SESSION_TOKEN}`);
      expect(ttl).to.be.greaterThan(0);
      expect(ttl).to.equal(86400);
    });
  });
});
