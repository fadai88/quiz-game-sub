"use strict";

/**
 * Restart recovery's refund decisions, against a REAL Mongo and Redis.
 *
 * This is the money half of the §G kill test, minus the transfer itself. When a
 * server dies mid-game, services/restartRecovery.js decides on the next boot who
 * gets their stake back. Those decisions are what can lose or leak money:
 *   - every human player in a crashed staked game is refunded exactly once,
 *   - nothing is refunded again after a second crash, or when two instances
 *     recover at the same moment,
 *   - a game whose winner payout was already queued is not also refunded.
 * Sending the USDC (PaymentProcessor) is the part that needs funded devnet
 * wallets; it is deliberately not started here, so nothing leaves the treasury.
 *
 * Why real services: the no-double-refund guarantee under a race rests on
 * Mongo's unique index on PaymentQueue.gameId. A fake would only test the fake.
 *
 * Isolation — this never touches dev data:
 *   - Mongo: a throwaway database `recovery_test_<pid>`, dropped afterwards.
 *   - Redis: logical database 15. The suite refuses to run if db 15 already
 *     holds keys, and flushes only db 15.
 *
 * Connection: MONGODB_URI (host part; the database name is overridden) and
 * REDIS_URL or REDIS_HOST / REDIS_PORT / REDIS_PASSWORD. Without them the suite
 * skips, unless REQUIRE_MONGO=1 / REQUIRE_REDIS=1 (set in CI).
 */

require("dotenv").config();
// Pass 3 (stakers waiting in the queue) only runs in pot mode, and the mode is
// read when config/constants.js loads — so set it before requiring anything.
process.env.MONETIZATION = "pot";

const { expect } = require("chai");
const Redis = require("ioredis");
const mongoose = require("mongoose");
const context = require("../context");
const roomManager = require("../services/roomManager");
const GameSession = require("../models/GameSession");
const PaymentQueue = require("../models/PaymentQueue");
const {
  recoverInFlightOnStartup,
  _internal,
} = require("../services/restartRecovery");
const { VALID_BET_AMOUNTS_ATOMIC } = require("../utils/usdcUtils");

const REDIS_DB = 15;
const TEST_DB = `recovery_test_${process.pid}`;
const STAKE = VALID_BET_AMOUNTS_ATOMIC[1]; // 10 USDC, a real stake tier

function redisClient() {
  const opts = {
    db: REDIS_DB,
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

// A syntactically valid Solana address (PaymentQueue validates base58, 32–44
// chars) that is unique per n. Never signs anything; nothing is ever sent.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const wallet = (n) =>
  (
    "RecoveryTest" + [...String(n)].map((d) => B58[Number(d) + 9]).join("")
  ).padEnd(44, "1");

// What a crashed instance leaves behind: a room hash in Redis (tracked in
// active:rooms) and, usually, an `active` GameSession in Mongo.
async function crashedRoom(roomId, bet, players, { session = true } = {}) {
  const room = await roomManager.createGameRoom(roomId, bet, "human", {
    gameMode: bet > 0 ? "ranked" : "practice",
    isPractice: bet === 0,
  });
  room.players = players.map((p) => ({
    id: `socket-${p.username}`,
    username: p.username,
    isBot: !!p.isBot,
    score: 0,
  }));
  room.gameStarted = true;
  await roomManager.updateGameRoom(roomId, room);
  if (session) {
    await GameSession.create({
      roomId,
      betAmount: bet,
      gameMode: bet > 0 ? "ranked" : "practice",
      players: players
        .filter((p) => !p.isBot)
        .map((p) => ({ walletAddress: p.username })),
    });
  }
}

const refundsFor = (filter = {}) =>
  PaymentQueue.find({ "metadata.type": "refund", ...filter }).lean();

describe("restart recovery — refund decisions (real Mongo + Redis)", function () {
  this.timeout(30000);

  let r;
  let prevRedis;
  let ready = false;

  before(async function () {
    r = redisClient();
    try {
      await r.connect();
      await r.ping();
    } catch (e) {
      r.disconnect();
      if (process.env.REQUIRE_REDIS === "1")
        throw new Error(
          `REQUIRE_REDIS=1 but Redis is unreachable: ${e.message}`
        );
      return this.skip();
    }
    if ((await r.dbsize()) > 0) {
      r.disconnect();
      throw new Error(
        `Redis db ${REDIS_DB} is not empty — refusing to run, it would be flushed`
      );
    }
    try {
      await mongoose.connect(process.env.MONGODB_URI, {
        dbName: TEST_DB,
        serverSelectionTimeoutMS: 4000,
      });
    } catch (e) {
      r.disconnect();
      if (process.env.REQUIRE_MONGO === "1")
        throw new Error(
          `REQUIRE_MONGO=1 but Mongo is unreachable: ${e.message}`
        );
      return this.skip();
    }
    // The race test depends on the unique gameId index existing up front.
    await PaymentQueue.init();
    await GameSession.init();
    prevRedis = context.get("redisClient");
    context.set("redisClient", r);
    ready = true;
  });

  beforeEach(async () => {
    await r.flushdb();
    await PaymentQueue.deleteMany({});
    await GameSession.deleteMany({});
  });

  after(async () => {
    if (!ready) return;
    context.set("redisClient", prevRedis);
    await r.flushdb();
    r.disconnect();
    if (mongoose.connection.db.databaseName === TEST_DB)
      await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
  });

  it("refunds each human player of a crashed staked game exactly once, for the stake", async () => {
    await crashedRoom("room-a", STAKE, [
      { username: wallet(1) },
      { username: wallet(2) },
    ]);

    await recoverInFlightOnStartup();

    const refunds = await refundsFor();
    expect(refunds.map((p) => p.gameId).sort()).to.deep.equal([
      `refund:room-a:${wallet(1)}`,
      `refund:room-a:${wallet(2)}`,
    ]);
    for (const p of refunds) {
      expect(p.amount).to.equal(STAKE);
      expect(p.status).to.equal("pending");
      expect(p.recipientWallet).to.be.oneOf([wallet(1), wallet(2)]);
    }
    const session = await GameSession.findOne({ roomId: "room-a" }).lean();
    expect(session.status).to.equal("refunded");
    expect(await r.exists("room:room-a")).to.equal(0);
    expect(await r.sismember("active:rooms", "room-a")).to.equal(0);
  });

  it("never refunds a bot opponent", async () => {
    await crashedRoom("room-bot", STAKE, [
      { username: wallet(3) },
      { username: "bot-opponent", isBot: true },
    ]);

    await recoverInFlightOnStartup();

    const refunds = await refundsFor();
    expect(refunds.map((p) => p.recipientWallet)).to.deep.equal([wallet(3)]);
  });

  it("queues nothing new on a second recovery after another crash", async () => {
    await crashedRoom("room-b", STAKE, [
      { username: wallet(4) },
      { username: wallet(5) },
    ]);
    await recoverInFlightOnStartup();

    // The second crash happens after recovery ran. Rebuild the room as if the
    // first boot's cleanup never landed, so the second pass sees it again.
    await crashedRoom(
      "room-b",
      STAKE,
      [{ username: wallet(4) }, { username: wallet(5) }],
      { session: false }
    );
    await recoverInFlightOnStartup();

    expect(await refundsFor()).to.have.length(2);
  });

  it("does not refund again once a refund was sent, or while a failed one awaits retry", async () => {
    await crashedRoom("room-c", STAKE, [
      { username: wallet(6) },
      { username: wallet(7) },
    ]);
    await recoverInFlightOnStartup();
    await PaymentQueue.updateOne(
      { gameId: `refund:room-c:${wallet(6)}` },
      { status: "completed" }
    );
    await PaymentQueue.updateOne(
      { gameId: `refund:room-c:${wallet(7)}` },
      { status: "failed" }
    );

    await crashedRoom(
      "room-c",
      STAKE,
      [{ username: wallet(6) }, { username: wallet(7) }],
      { session: false }
    );
    await recoverInFlightOnStartup();

    const refunds = await refundsFor();
    expect(refunds).to.have.length(2);
    expect(refunds.map((p) => p.status).sort()).to.deep.equal([
      "completed",
      "failed",
    ]);
  });

  it("two instances recovering at the same moment still refund each player once", async () => {
    await crashedRoom("room-race", STAKE, [
      { username: wallet(8) },
      { username: wallet(9) },
    ]);

    await Promise.all([recoverInFlightOnStartup(), recoverInFlightOnStartup()]);

    const refunds = await refundsFor();
    expect(refunds.map((p) => p.gameId).sort()).to.deep.equal([
      `refund:room-race:${wallet(8)}`,
      `refund:room-race:${wallet(9)}`,
    ]);
  });

  it("does not refund a game whose winner payout was already queued, and records it as completed", async () => {
    await crashedRoom("room-paid", STAKE, [
      { username: wallet(10) },
      { username: wallet(11) },
    ]);
    // settlePotGame queues the winner's payout under gameId === roomId.
    await PaymentQueue.create({
      recipientWallet: wallet(10),
      amount: STAKE * 2,
      gameId: "room-paid",
      betAmount: STAKE,
    });

    await recoverInFlightOnStartup();

    expect(await refundsFor()).to.have.length(0);
    expect(await PaymentQueue.countDocuments({})).to.equal(1);
    const session = await GameSession.findOne({ roomId: "room-paid" }).lean();
    expect(session.status).to.equal("completed");
    expect(session.refundReason).to.equal(undefined);
    expect(await r.exists("room:room-paid")).to.equal(0);
  });

  it("refunds from the session when Redis lost the room (downtime past the room TTL)", async () => {
    await GameSession.create({
      roomId: "room-gone",
      betAmount: STAKE,
      gameMode: "ranked",
      players: [{ walletAddress: wallet(12) }, { walletAddress: wallet(13) }],
    });

    await recoverInFlightOnStartup();

    const refunds = await refundsFor();
    expect(refunds.map((p) => p.gameId).sort()).to.deep.equal([
      `refund:room-gone:${wallet(12)}`,
      `refund:room-gone:${wallet(13)}`,
    ]);
    const session = await GameSession.findOne({ roomId: "room-gone" }).lean();
    expect(session.status).to.equal("refunded");
  });

  it("refunds a staker left waiting in the queue once, and clears the entry", async () => {
    const entry = {
      walletAddress: wallet(14),
      socketId: "dead-socket",
      joinTime: 1790000000000,
    };
    await roomManager.addToMatchmakingPool(STAKE, entry);

    await recoverInFlightOnStartup();
    // A second boot finds nothing left to refund.
    await roomManager.addToMatchmakingPool(STAKE, entry);
    await recoverInFlightOnStartup();

    const refunds = await refundsFor();
    expect(refunds.map((p) => p.gameId)).to.deep.equal([
      `refund:pool:${wallet(14)}:${entry.joinTime}`,
    ]);
    expect(refunds[0].amount).to.equal(STAKE);
    expect(await roomManager.getMatchmakingPool(STAKE)).to.deep.equal([]);
  });

  it("queues no payment for a crashed practice game", async () => {
    await crashedRoom("room-free", 0, [
      { username: wallet(15) },
      { username: wallet(16) },
    ]);

    await recoverInFlightOnStartup();

    expect(await PaymentQueue.countDocuments({})).to.equal(0);
    const session = await GameSession.findOne({ roomId: "room-free" }).lean();
    expect(session.status).to.equal("refunded");
  });

  it("recovers every crashed game in one pass, refunding each player once", async () => {
    const N = 25;
    for (let i = 0; i < N; i++)
      await crashedRoom(`room-many-${i}`, STAKE, [
        { username: wallet(100 + i * 2) },
        { username: wallet(101 + i * 2) },
      ]);

    const { games, refunds } = await _internal.recoverGames();

    expect(games).to.equal(N);
    expect(refunds).to.equal(N * 2);
    const rows = await refundsFor();
    expect(rows).to.have.length(N * 2);
    expect(new Set(rows.map((p) => p.gameId)).size).to.equal(N * 2);
    expect(await GameSession.countDocuments({ status: "refunded" })).to.equal(
      N
    );
  });
});
