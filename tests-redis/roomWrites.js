"use strict";

/**
 * Room writes against a REAL Redis, running the real Lua.
 *
 * atomicRoomUpdate used to rely on WATCH/MULTI/EXEC over the server's single
 * shared connection. WATCH state is per connection, so every caller's EXEC
 * cleared everyone else's watches and concurrent updates wrote blindly over
 * each other: two simultaneous updates to one room lost one 200 times in 200,
 * and an update racing a delete brought the room back 148 times in 200. Rooms
 * now carry a version and are written by compare-and-set scripts; see
 * "Room writes" in services/roomManager.js. These tests reproduce the original
 * failures on ONE shared connection, exactly as the server runs.
 *
 * Connection and skip rules are the same as matchmakingClaim.js.
 */

require("dotenv").config();
const { expect } = require("chai");
const Redis = require("ioredis");
const context = require("../context");
const roomManager = require("../services/roomManager");

function connect() {
  const opts = {
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    retryStrategy: () => null,
    lazyConnect: true,
  };
  return process.env.REDIS_URL
    ? new Redis(process.env.REDIS_URL, opts)
    : new Redis({
        host: process.env.REDIS_HOST || "127.0.0.1",
        port: Number(process.env.REDIS_PORT || 6379),
        password: process.env.REDIS_PASSWORD || undefined,
        ...opts,
      });
}

describe("room writes — real Redis, one shared connection", function () {
  this.timeout(30000);

  const prefix = `roomwrites-${process.pid}-${Date.now()}`;
  let seq = 0;
  let r;
  let prevRedis;
  const made = [];

  before(async function () {
    r = connect();
    try {
      await r.connect();
      await r.ping();
    } catch (e) {
      r.disconnect();
      if (process.env.REQUIRE_REDIS === "1")
        throw new Error(
          `REQUIRE_REDIS=1 but Redis is unreachable: ${e.message}`
        );
      this.skip();
    }
    prevRedis = context.get("redisClient");
    context.set("redisClient", r);
  });

  after(async () => {
    if (!r || r.status !== "ready") return;
    for (const id of made) {
      await r.del(`room:${id}`);
      await r.srem("active:rooms", id);
    }
    r.disconnect();
    context.set("redisClient", prevRedis);
  });

  async function newRoom() {
    const id = `${prefix}-${seq++}`;
    made.push(id);
    await roomManager.createGameRoom(id, 0, "human", {});
    const room = await roomManager.getGameRoom(id);
    room.players = [
      { username: "a", score: 0 },
      { username: "b", score: 0 },
    ];
    await roomManager.updateGameRoom(id, room);
    return id;
  }

  const bump = (id, name) =>
    roomManager.atomicRoomUpdate(id, async (room) => {
      room.players.find((p) => p.username === name).score++;
      return room;
    });

  it("keeps both of two simultaneous updates to one room (was: one lost every time)", async () => {
    const TRIALS = 50;
    let lost = 0;
    for (let t = 0; t < TRIALS; t++) {
      const id = await newRoom();
      await Promise.all([bump(id, "a"), bump(id, "b")]);
      const scores = (await roomManager.getGameRoom(id)).players.map(
        (p) => p.score
      );
      if (scores[0] !== 1 || scores[1] !== 1) lost++;
    }
    expect(lost, `trials that lost an update`).to.equal(0);
  });

  it("keeps every one of many concurrent updates to one room", async () => {
    const id = await newRoom();
    await Promise.all(
      Array.from({ length: 4 }, () => bump(id, "a")).concat(
        Array.from({ length: 4 }, () => bump(id, "b"))
      )
    );
    const scores = (await roomManager.getGameRoom(id)).players.map(
      (p) => p.score
    );
    expect(scores).to.deep.equal([4, 4]);
  });

  it("leaves a deleted room deleted when an update races the delete (was: back 148 in 200)", async () => {
    const TRIALS = 50;
    let resurrected = 0;
    for (let t = 0; t < TRIALS; t++) {
      const id = await newRoom();
      await Promise.all([
        roomManager.deleteGameRoom(id),
        bump(id, "a").catch(() => {}),
      ]);
      if (await r.exists(`room:${id}`)) resurrected++;
    }
    expect(resurrected, "rooms that came back after delete").to.equal(0);
  });

  it("atomicRoomUpdate on a missing room throws 'not found' and creates nothing", async () => {
    const id = `${prefix}-missing`;
    made.push(id);
    let err;
    try {
      await bump(id, "a");
    } catch (e) {
      err = e;
    }
    expect(err && err.message).to.match(/not found/);
    expect(await r.exists(`room:${id}`)).to.equal(0);
  });

  it("updateGameRoom does not recreate a room that was deleted", async () => {
    const id = await newRoom();
    const stale = await roomManager.getGameRoom(id);
    await roomManager.deleteGameRoom(id);
    await roomManager.updateGameRoom(id, stale);
    expect(await r.exists(`room:${id}`)).to.equal(0);
  });

  it("a plain updateGameRoom forces a concurrent atomic update to re-read, not overwrite it", async () => {
    const id = await newRoom();
    let first = true;
    await roomManager.atomicRoomUpdate(id, async (room) => {
      if (first) {
        first = false;
        // Lands between the atomic read and its write.
        const other = await roomManager.getGameRoom(id);
        other.players[1].score = 7;
        await roomManager.updateGameRoom(id, other);
      }
      room.players[0].score++;
      return room;
    });
    const scores = (await roomManager.getGameRoom(id)).players.map(
      (p) => p.score
    );
    expect(scores).to.deep.equal([1, 7]);
  });

  it("round-trips a room unchanged through an atomic update", async () => {
    const id = await newRoom();
    const before = await roomManager.getGameRoom(id);
    await roomManager.atomicRoomUpdate(id, async (room) => room);
    const after = await roomManager.getGameRoom(id);
    expect(after).to.deep.equal(before);
  });
});
