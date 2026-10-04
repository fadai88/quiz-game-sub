"use strict";

/**
 * Regression tests for the atomic matchmaking claim.
 *
 * Simultaneous joins used to build a room per handler for the same pair: each
 * handler read the pool (LRANGE), picked the first two entries and removed them
 * (LREM), and every handler that read before those removals landed picked the
 * same two players. Eight simultaneous joins produced eight rooms for one pair.
 * The fix claims a pair with a single Lua script (`claimTwoFromMatchmakingPool`),
 * wrapped by `claimPairFromPool`, which drops dead entries and requeues a live
 * player whose partner was dead. See docs/LOAD_TESTING.md.
 *
 * The fake Redis below is the point of this file. Every ordinary command yields
 * to the event loop before it runs, so concurrent callers interleave between
 * commands the way they do against a real server. `eval` does not yield: Redis
 * runs a script as one step, and so does the fake. A read-then-remove claim
 * therefore races here exactly as it did in production — the "fake is racy
 * enough" test proves that — while the atomic claim cannot.
 *
 * The fake implements the claim script's semantics rather than running its Lua.
 * The real script against a real Redis is covered by tests-integration/, which runs in
 * its own CI job with a Redis service.
 */

const { expect } = require("chai");
const context = require("../context");
const roomManager = require("../services/roomManager");

const tick = () => new Promise((r) => setImmediate(r));

function makeRacyListRedis() {
  const lists = new Map(); // key -> array, index 0 = head
  const list = (key) => {
    if (!lists.has(key)) lists.set(key, []);
    return lists.get(key);
  };
  const stats = { evals: 0 };

  return {
    lists,
    stats,
    async lpush(key, ...values) {
      await tick();
      list(key).unshift(...values.reverse());
      return list(key).length;
    },
    async lrange(key, start, stop) {
      await tick();
      const l = list(key);
      return l.slice(start, stop === -1 ? undefined : stop + 1);
    },
    async lrem(key, count, value) {
      await tick();
      const l = list(key);
      let removed = 0;
      for (let i = 0; i < l.length && (count === 0 || removed < count); ) {
        if (l[i] === value) {
          l.splice(i, 1);
          removed++;
        } else i++;
      }
      return removed;
    },
    // Atomic, like a Redis script: no yield between reading and writing.
    async eval(script, numKeys, key) {
      stats.evals++;
      expect(script).to.match(/LPOP/, "expected the pair-claim script");
      expect(numKeys).to.equal(1);
      const l = list(key);
      if (l.length < 2) return null;
      return [l.shift(), l.shift()];
    },
  };
}

const KEY = "matchmaking:human:0";
const entry = (i, extra = {}) => ({
  walletAddress: `wallet-${i}`,
  socketId: `socket-${i}`,
  joinTime: 1000 + i,
  ...extra,
});

// The pre-fix claim, reproduced to prove the fake exposes its race.
async function naiveClaim(betAmount) {
  const pool = await roomManager.getMatchmakingPool(betAmount);
  if (pool.length < 2) return null;
  const [a, b] = pool;
  await context.redisClient.lrem(KEY, 1, JSON.stringify(a));
  await context.redisClient.lrem(KEY, 1, JSON.stringify(b));
  return [a, b];
}

function assertDisjointPairs(pairs, expectedPlayers) {
  const seen = new Map();
  for (const [a, b] of pairs) {
    for (const p of [a, b])
      seen.set(p.socketId, (seen.get(p.socketId) || 0) + 1);
    expect(a.socketId).to.not.equal(b.socketId, "paired with themselves");
  }
  const repeats = [...seen].filter(([, n]) => n > 1);
  expect(repeats, "players handed to more than one pair").to.deep.equal([]);
  expect(seen.size).to.equal(expectedPlayers);
}

describe("roomManager — atomic matchmaking claim", () => {
  let prevRedis;
  let redis;

  beforeEach(() => {
    prevRedis = context.get("redisClient");
    redis = makeRacyListRedis();
    context.set("redisClient", redis);
  });

  afterEach(() => {
    context.set("redisClient", prevRedis);
  });

  async function queue(...entries) {
    for (const e of entries) await roomManager.addToMatchmakingPool(0, e);
  }

  describe("claimTwoFromMatchmakingPool", () => {
    it("claims the two players at the head, in pop order, and removes them", async () => {
      await queue(entry(1), entry(2), entry(3)); // LPUSH: head is 3, then 2
      const pair = await roomManager.claimTwoFromMatchmakingPool(0);
      expect(pair.map((p) => p.socketId)).to.deep.equal([
        "socket-3",
        "socket-2",
      ]);
      expect(redis.lists.get(KEY)).to.have.length(1);
      expect(JSON.parse(redis.lists.get(KEY)[0]).socketId).to.equal("socket-1");
    });

    it("takes nobody, and leaves the queue untouched, when only one is waiting", async () => {
      await queue(entry(1));
      expect(await roomManager.claimTwoFromMatchmakingPool(0)).to.equal(null);
      expect(redis.lists.get(KEY)).to.deep.equal([JSON.stringify(entry(1))]);
    });

    it("returns null for an empty queue", async () => {
      expect(await roomManager.claimTwoFromMatchmakingPool(0)).to.equal(null);
    });

    it("returns null instead of throwing when Redis fails", async () => {
      redis.eval = async () => {
        throw new Error("connection lost");
      };
      expect(await roomManager.claimTwoFromMatchmakingPool(0)).to.equal(null);
    });
  });

  describe("under concurrency", () => {
    it("the fake is racy enough: the pre-fix read-then-remove claim hands players out twice", async () => {
      // Guards the guard. If the fake ever stops interleaving commands, the
      // tests below would pass against the old bug too, and mean nothing.
      await queue(...Array.from({ length: 8 }, (_, i) => entry(i)));
      const results = await Promise.all(
        Array.from({ length: 8 }, () => naiveClaim(0))
      );
      const pairs = results.filter(Boolean);
      const handedOut = pairs.flat().map((p) => p.socketId);
      expect(new Set(handedOut).size).to.be.lessThan(handedOut.length);
    });

    it("concurrent claims over a full queue never hand a player to two pairs", async () => {
      const N = 20;
      await queue(...Array.from({ length: N }, (_, i) => entry(i)));
      const results = await Promise.all(
        Array.from({ length: N }, () => roomManager.claimPairFromPool(0))
      );
      const pairs = results.filter(Boolean);
      expect(pairs).to.have.length(N / 2);
      assertDisjointPairs(pairs, N);
      expect(redis.lists.get(KEY)).to.deep.equal([]);
    });

    it("simultaneous joins (queue yourself, then claim) produce one pair per two players and strand nobody", async () => {
      // The production shape: each join handler LPUSHes its own player and
      // then tries to claim. This is what built eight rooms for one pair.
      const N = 40;
      const results = await Promise.all(
        Array.from({ length: N }, async (_, i) => {
          await roomManager.addToMatchmakingPool(0, entry(i));
          return roomManager.claimPairFromPool(0);
        })
      );
      const pairs = results.filter(Boolean);
      expect(pairs).to.have.length(N / 2);
      assertDisjointPairs(pairs, N);
      expect(
        redis.lists.get(KEY),
        "players left stranded in the queue"
      ).to.deep.equal([]);
    });
  });

  describe("claimPairFromPool — dead entries", () => {
    const live = (ids) => (e) => ids.includes(e.socketId);

    it("drops a dead entry, requeues its live partner, and pairs them with the next live player", async () => {
      // Pop order is socket-2 (dead), socket-1 (live); socket-3 joins after.
      await queue(entry(1), entry(2));
      await queue(entry(3));
      const pair = await roomManager.claimPairFromPool(
        0,
        live(["socket-1", "socket-3"])
      );
      expect(pair.map((p) => p.socketId).sort()).to.deep.equal([
        "socket-1",
        "socket-3",
      ]);
      const remaining = redis.lists.get(KEY).map((s) => JSON.parse(s).socketId);
      expect(remaining).to.not.include("socket-2");
      expect(remaining).to.deep.equal([]);
    });

    it("keeps a live player queued (never drops them) when their only partner is dead", async () => {
      // In ranked a queued player has already staked; dropping them would be
      // a collected stake with no game and no refund.
      await queue(entry(1), entry(2));
      const pair = await roomManager.claimPairFromPool(0, live(["socket-1"]));
      expect(pair).to.equal(null);
      const remaining = redis.lists.get(KEY).map((s) => JSON.parse(s).socketId);
      expect(remaining).to.deep.equal(["socket-1"]);
    });

    it("discards two dead entries and claims nothing", async () => {
      await queue(entry(1), entry(2));
      expect(await roomManager.claimPairFromPool(0, live([]))).to.equal(null);
      expect(redis.lists.get(KEY)).to.deep.equal([]);
    });

    it("gives up after a bounded number of attempts instead of spinning", async () => {
      // A pathological queue of dead entries must not loop forever.
      await queue(...Array.from({ length: 60 }, (_, i) => entry(i)));
      expect(await roomManager.claimPairFromPool(0, live([]))).to.equal(null);
      expect(redis.stats.evals).to.be.at.most(12);
    });
  });
});
