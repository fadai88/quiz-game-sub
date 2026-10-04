"use strict";

/**
 * The matchmaking claim against a REAL Redis, running the real Lua script.
 *
 * tests/roomManager.claimPair.js covers the claim logic with a fake whose `eval`
 * imitates the script. This file closes the gap the fake leaves: that the Lua
 * itself is correct and that Redis really does run it atomically across many
 * concurrent connections. It needs a live server, so it lives outside tests/
 * (the main suite stays self-contained) and runs in its own CI job:
 *
 *   npm run test:integration
 *
 * Connection comes from REDIS_URL, or REDIS_HOST / REDIS_PORT / REDIS_PASSWORD
 * (read from .env locally). Without a reachable Redis the suite skips, unless
 * REQUIRE_REDIS=1 — which CI sets, so a broken service fails the job instead of
 * quietly passing it.
 *
 * Every key is namespaced per run and deleted afterwards; it never touches a
 * real matchmaking queue.
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

const entry = (i) => ({
  walletAddress: `wallet-${i}`,
  socketId: `socket-${i}`,
  joinTime: 1000 + i,
});

describe("matchmaking claim — real Redis, real Lua", function () {
  this.timeout(20000);

  const bet = `claimtest-${process.pid}-${Date.now()}`;
  const key = `matchmaking:human:${bet}`;
  let prevRedis;
  let clients = [];

  before(async function () {
    const probe = connect();
    try {
      await probe.connect();
      await probe.ping();
    } catch (e) {
      probe.disconnect();
      if (process.env.REQUIRE_REDIS === "1")
        throw new Error(
          `REQUIRE_REDIS=1 but Redis is unreachable: ${e.message}`
        );
      this.skip();
    }
    probe.disconnect();
    prevRedis = context.get("redisClient");
  });

  // Several independent connections, so concurrent claims really are separate
  // clients racing at the server — not one connection's pipeline in order.
  beforeEach(async () => {
    clients = Array.from({ length: 8 }, connect);
    await Promise.all(clients.map((c) => c.connect()));
    await clients[0].del(key);
    context.set("redisClient", clients[0]);
  });

  afterEach(async () => {
    await clients[0].del(key);
    clients.forEach((c) => c.disconnect());
    context.set("redisClient", prevRedis);
  });

  // Start a roomManager call on a given connection. roomManager reads
  // context.redisClient when each command is issued, so a multi-step call may
  // finish on another connection; that is fine — the aim is several clients
  // racing at the server, not a fixed mapping of calls to clients.
  const on = (client, fn) => {
    context.set("redisClient", client);
    return fn();
  };

  it("claims the two head entries in pop order and removes them", async () => {
    for (const i of [1, 2, 3])
      await roomManager.addToMatchmakingPool(bet, entry(i));
    const pair = await roomManager.claimTwoFromMatchmakingPool(bet);
    expect(pair.map((p) => p.socketId)).to.deep.equal(["socket-3", "socket-2"]);
    const left = await clients[0].lrange(key, 0, -1);
    expect(left.map((s) => JSON.parse(s).socketId)).to.deep.equal(["socket-1"]);
  });

  it("puts a lone entry back where it was and returns nothing", async () => {
    await roomManager.addToMatchmakingPool(bet, entry(1));
    expect(await roomManager.claimTwoFromMatchmakingPool(bet)).to.equal(null);
    expect(await clients[0].lrange(key, 0, -1)).to.deep.equal([
      JSON.stringify(entry(1)),
    ]);
  });

  it("returns nothing for an empty queue and does not create the key", async () => {
    expect(await roomManager.claimTwoFromMatchmakingPool(bet)).to.equal(null);
    expect(await clients[0].exists(key)).to.equal(0);
  });

  it("concurrent claims from many connections never hand a player out twice", async () => {
    const N = 200;
    await clients[0].lpush(
      key,
      ...Array.from({ length: N }, (_, i) => JSON.stringify(entry(i)))
    );

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        on(clients[i % clients.length], () =>
          roomManager.claimTwoFromMatchmakingPool(bet)
        )
      )
    );
    const pairs = results.filter(Boolean);
    const handedOut = pairs.flat().map((p) => p.socketId);

    expect(pairs).to.have.length(N / 2);
    expect(new Set(handedOut).size).to.equal(handedOut.length);
    expect(handedOut).to.have.length(N);
    expect(await clients[0].llen(key)).to.equal(0);
  });

  it("simultaneous joins across connections pair everyone exactly once", async () => {
    const N = 100;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => {
        const c = clients[i % clients.length];
        return on(c, () =>
          roomManager.addToMatchmakingPool(bet, entry(i))
        ).then(() => on(c, () => roomManager.claimPairFromPool(bet)));
      })
    );
    const pairs = results.filter(Boolean);
    const handedOut = pairs.flat().map((p) => p.socketId);

    expect(pairs).to.have.length(N / 2);
    expect(new Set(handedOut).size).to.equal(N);
    expect(
      await clients[0].llen(key),
      "players stranded in the queue"
    ).to.equal(0);
  });
});
