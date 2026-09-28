"use strict";

/**
 * Redis round-trip regression test for `disconnectGracePeriod`.
 *
 * NOTE (continue-model change): mid-game disconnects no longer pause the game,
 * so the production disconnect handler no longer sets this flag to `true` — the
 * match just keeps running and the leaver rejoins the live question. The flag
 * is now legacy/defensive: `completeQuestion` / `restartCurrentQuestion` still
 * read it, so it must continue to survive serialization intact. Historically it
 * was NOT persisted by `_serializeRoom` / hydrated by `getGameRoom`, so the flag
 * vanished on the next Redis read; these tests guard that round-trip so the
 * defensive reads can never silently see `undefined`.
 *
 * These tests drive the real roomManager against an in-memory fake Redis
 * client, asserting the flag survives a write → read round-trip.
 */

const { expect } = require("chai");
const context = require("../context");
const roomManager = require("../services/roomManager");

// ── In-memory fake Redis client ────────────────────────────────────────────────
// Implements only the surface roomManager touches: hash storage via multi()
// (hset/expire/exec), hgetall, and eval for the two room-write scripts (write
// only if the room exists, bump its version). Field values are strings, like
// real Redis. `seed` creates a room hash, as createGameRoom would.
function makeFakeRedis() {
  const store = new Map(); // key -> { field: stringValue }

  function hsetInto(key, obj) {
    const hash = store.get(key) || {};
    for (const [k, v] of Object.entries(obj)) hash[k] = String(v);
    store.set(key, hash);
  }

  return {
    multi() {
      const ops = [];
      const chain = {
        hset(key, obj) {
          ops.push(() => hsetInto(key, obj));
          return chain;
        },
        expire() {
          return chain;
        },
        async exec() {
          ops.forEach((op) => op());
          return [];
        },
      };
      return chain;
    },
    async hgetall(key) {
      return store.get(key) || {};
    },
    async eval(script, numKeys, key, ...argv) {
      if (!store.has(key)) return -1;
      const cas = script.includes("ARGV[1] then return 0");
      const hash = store.get(key);
      if (cas && (hash.version || "0") !== String(argv[0])) return 0;
      const pairs = argv.slice(cas ? 2 : 1);
      const fields = {};
      for (let i = 0; i < pairs.length; i += 2) fields[pairs[i]] = pairs[i + 1];
      hsetInto(key, fields);
      hash.version = String(Number(hash.version || 0) + 1);
      return 1;
    },
    seed(roomId) {
      store.set(`room:${roomId}`, {});
    },
  };
}

function makeRoom(overrides = {}) {
  return {
    players: [
      { username: "leaver", isBot: false, score: 3 },
      { username: "stayer", isBot: false, score: 1 },
    ],
    betAmount: 10,
    questions: [],
    questionIdMap: new Map(),
    currentQuestionIndex: 4,
    answersReceived: 0,
    gameStarted: true,
    roomMode: "human",
    hasBot: false,
    playerLeft: false,
    questionStartTime: null,
    roundStartTime: null,
    isDeleted: false,
    gameMode: "tournament",
    tournamentId: "",
    matchId: "",
    isPractice: false,
    ...overrides,
  };
}

describe("roomManager — disconnectGracePeriod Redis round-trip", () => {
  let prevRedis;
  let redis;

  beforeEach(() => {
    prevRedis = context.get("redisClient");
    redis = makeFakeRedis();
    for (const id of ["room-1", "room-2", "room-3"]) redis.seed(id);
    context.set("redisClient", redis);
  });

  afterEach(() => {
    context.set("redisClient", prevRedis);
  });

  it("persists and hydrates disconnectGracePeriod=true (the bug fix)", async () => {
    await roomManager.updateGameRoom(
      "room-1",
      makeRoom({ disconnectGracePeriod: true })
    );

    const loaded = await roomManager.getGameRoom("room-1");

    // Guards the round-trip so the defensive readers (completeQuestion /
    // restartCurrentQuestion) never see `undefined` instead of a boolean.
    expect(loaded.disconnectGracePeriod).to.equal(true);
  });

  it("round-trips disconnectGracePeriod=false", async () => {
    await roomManager.updateGameRoom(
      "room-2",
      makeRoom({ disconnectGracePeriod: false })
    );

    const loaded = await roomManager.getGameRoom("room-2");
    expect(loaded.disconnectGracePeriod).to.equal(false);
  });

  it("defaults to false when the field was never written (legacy rooms)", async () => {
    const room = makeRoom();
    delete room.disconnectGracePeriod;

    await roomManager.updateGameRoom("room-3", room);
    const loaded = await roomManager.getGameRoom("room-3");
    expect(loaded.disconnectGracePeriod).to.equal(false);
  });
});
