"use strict";

/**
 * Redis round-trip regression test for `disconnectGracePeriod`.
 *
 * Bug: when a player disconnects, the disconnect handler sets
 * `room.disconnectGracePeriod = true` (so completeQuestion knows the game is
 * paused and must NOT score the still-connected leader as winner). But
 * `_serializeRoom` / `getGameRoom` never persisted or hydrated that field, so
 * the flag vanished on the very next Redis read. The completion path on the
 * last question then ran normally and declared the disconnected player —
 * who was ahead — the winner.
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

    // Before the fix this came back undefined → completeQuestion ran the
    // normal scoring path and crowned the disconnected leader.
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
