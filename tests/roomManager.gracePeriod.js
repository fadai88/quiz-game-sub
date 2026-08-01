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
// (hset/expire/exec), and hgetall. Field values are strings, like real Redis.
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

  beforeEach(() => {
    prevRedis = context.get("redisClient");
    context.set("redisClient", makeFakeRedis());
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
