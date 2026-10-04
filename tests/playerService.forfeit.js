"use strict";

/**
 * Forfeit resolution — handlePlayerLeftWin in services/playerService.js.
 *
 * When a player abandons a match, this is the only path that pays the player
 * who stayed. settlePotGame is otherwise reached only from handleGameOver, which
 * every forfeit bypasses, so a regression here means a winner announced but
 * never paid, with both stakes stranded in the treasury. It also decides who is
 * NOT paid from the pot: games against a bot, practice games and tournament
 * matches (those advance the bracket instead).
 *
 * roomManager, constants and settlePotGame are stubbed through their module
 * objects (playerService calls them that way for this reason); the stats writes
 * go to stubbed models.
 */

const { expect } = require("chai");
const sinon = require("sinon");

const context = require("../context");
const roomManager = require("../services/roomManager");
const constants = require("../config/constants");
const gameService = require("../services/gameService");
const User = require("../models/User");
const PrizeCycle = require("../models/PrizeCycle");
const CycleStat = require("../models/CycleStat");
const { handlePlayerLeftWin } = require("../services/playerService");

const { GAME_MODES } = constants;
const STAKE = 10_000_000;
const WINNER = { username: "WinnerWa11et", score: 3 };
const LEAVER = { username: "LeaverWa11et", score: 1 };

function fakeIo() {
  const emitted = [];
  const io = {
    emitted,
    to: (room) => ({
      emit: (name, payload) => emitted.push({ room, name, payload }),
    }),
    emit: (name, payload) => emitted.push({ room: null, name, payload }),
  };
  return io;
}

function fakeRedis() {
  const m = new Map();
  return {
    m,
    // acquireIdempotencyLock: SET key 1 NX EX ttl
    set: async (k, v, nx) => {
      if (nx === "NX" && m.has(k)) return null;
      m.set(k, v);
      return "OK";
    },
    get: async (k) => (m.has(k) ? m.get(k) : null),
    del: async (k) => (m.delete(k) ? 1 : 0),
  };
}

const roomOf = (gameMode, extra = {}) => ({
  gameMode,
  betAmount: STAKE,
  players: [WINNER, LEAVER],
  tournamentId: "",
  matchId: "",
  ...extra,
});

describe("playerService — forfeit resolution (handlePlayerLeftWin)", () => {
  let io;
  let room;
  let settle;
  let deleted;
  let userWrites;
  let prev;

  beforeEach(() => {
    prev = {
      io: context.get("io"),
      redis: context.get("redisClient"),
      ts: context.get("tournamentService"),
    };
    io = fakeIo();
    context.set("io", io);
    context.set("redisClient", fakeRedis());
    room = roomOf(GAME_MODES.RANKED);
    deleted = [];
    userWrites = [];

    sinon.stub(constants, "isPotMode").returns(true);
    sinon.stub(roomManager, "getGameRoom").callsFake(async () => room);
    sinon
      .stub(roomManager, "deleteGameRoom")
      .callsFake(async (id) => deleted.push(id));
    sinon.stub(roomManager, "logGameRoomsState").resolves();
    settle = sinon
      .stub(gameService, "settlePotGame")
      .resolves({ paymentId: "pay-123", withheld: false });
    sinon.stub(PrizeCycle, "getOrCreateActive").resolves({ _id: "cycle-1" });
    sinon.stub(User, "findOneAndUpdate").callsFake(async (filter, update) => {
      userWrites.push({ wallet: filter.walletAddress, inc: update.$inc });
    });
    sinon.stub(CycleStat, "findOneAndUpdate").resolves();
    sinon.stub(User, "findOne").callsFake(async ({ walletAddress }) => ({
      _id: `id-${walletAddress}`,
    }));
  });

  afterEach(() => {
    sinon.restore();
    context.set("io", prev.io);
    context.set("redisClient", prev.redis);
    context.set("tournamentService", prev.ts);
  });

  const forfeit = (bet = STAKE, bot = false) =>
    handlePlayerLeftWin("room-1", WINNER, LEAVER, bet, bot, [WINNER, LEAVER]);
  const sent = (name) => io.emitted.filter((e) => e.name === name);

  it("pays the player who stayed in a staked match, once, and tells both players", async () => {
    await forfeit();

    expect(settle.calledOnce).to.equal(true);
    const [roomId, settledRoom, winner, botOpponent] = settle.firstCall.args;
    expect([roomId, winner, botOpponent]).to.deep.equal([
      "room-1",
      WINNER.username,
      false,
    ]);
    expect(settledRoom).to.equal(room);

    const [over] = sent("gameOverForfeit");
    expect(over.room).to.equal("room-1");
    expect(over.payload).to.include({
      winner: WINNER.username,
      disconnectedPlayer: LEAVER.username,
      paymentId: "pay-123",
      payoutWithheld: false,
    });
    expect(deleted).to.deep.equal(["room-1"]);
  });

  it("records a win for the winner and a loss for the player who left", async () => {
    await forfeit();
    const byWallet = Object.fromEntries(
      userWrites.map((w) => [w.wallet, w.inc])
    );
    expect(byWallet[WINNER.username]).to.include({ wins: 1, losses: 0 });
    expect(byWallet[LEAVER.username]).to.include({ wins: 0, losses: 1 });
  });

  it("settles before announcing, so the result carries the payout status", async () => {
    let emittedBeforeSettle = null;
    settle.callsFake(async () => {
      emittedBeforeSettle = sent("gameOverForfeit").length;
      return { paymentId: "pay-9", withheld: false };
    });
    await forfeit();
    expect(emittedBeforeSettle).to.equal(0);
  });

  it("still announces and cleans up when settlement fails, marking the payout withheld", async () => {
    settle.rejects(new Error("treasury unavailable"));
    await forfeit();

    const [over] = sent("gameOverForfeit");
    expect(over.payload).to.include({ paymentId: null, payoutWithheld: true });
    expect(sent("gameError")).to.have.length(0);
    expect(deleted).to.deep.equal(["room-1"]);
  });

  it("passes on a hold decided by settlement (e.g. fraud review)", async () => {
    settle.resolves({ paymentId: null, withheld: true });
    await forfeit();
    expect(sent("gameOverForfeit")[0].payload.payoutWithheld).to.equal(true);
  });

  it("never pays from the pot in a game against a bot", async () => {
    await forfeit(STAKE, true);
    expect(settle.called).to.equal(false);
    expect(sent("gameOverForfeit")).to.have.length(1);
  });

  it("never pays from the pot in a practice game", async () => {
    room = roomOf(GAME_MODES.PRACTICE, { betAmount: 0 });
    await forfeit(0);
    expect(settle.called).to.equal(false);
    expect(
      userWrites,
      "practice games do not touch the leaderboard"
    ).to.have.length(0);
  });

  it("does not settle outside pot mode", async () => {
    constants.isPotMode.returns(false);
    await forfeit();
    expect(settle.called).to.equal(false);
  });

  it("does not settle if the room is already gone, but still announces and cleans up", async () => {
    room = null;
    await forfeit();
    expect(settle.called).to.equal(false);
    expect(sent("gameOverForfeit")).to.have.length(1);
    expect(deleted).to.deep.equal(["room-1"]);
  });

  describe("tournament matches", () => {
    let processResult;

    beforeEach(() => {
      room = roomOf(GAME_MODES.TOURNAMENT, {
        tournamentId: "t-1",
        matchId: "m-1",
      });
      processResult = sinon
        .stub()
        .resolves({ action: "round_advanced", claimed: true });
      context.set("tournamentService", {
        processClaimedMatchResult: processResult,
      });
    });

    it("advance the bracket instead of paying from the pot", async () => {
      await forfeit();

      expect(settle.called).to.equal(false);
      expect(processResult.calledOnce).to.equal(true);
      const args = processResult.firstCall.args;
      expect(args.slice(0, 3)).to.deep.equal(["t-1", "m-1", "room-1"]);
      expect(args[3]).to.equal(`id-${WINNER.username}`);
      expect(args[4]).to.equal(`id-${LEAVER.username}`);
      expect(sent("tournamentRoundAdvanced")).to.have.length(1);
    });

    it("are processed once even if the forfeit is handled twice", async () => {
      await forfeit();
      await forfeit();
      expect(processResult.calledOnce).to.equal(true);
    });

    it("record stats only for a match the tournament actually claimed", async () => {
      processResult.resolves({ action: null, claimed: false });
      await forfeit();
      expect(userWrites).to.have.length(0);
    });
  });

  it("reports an error to the room and still cleans up if resolution itself fails", async () => {
    roomManager.getGameRoom.rejects(new Error("redis down"));
    await forfeit();
    expect(sent("gameError")).to.have.length(1);
    expect(deleted).to.deep.equal(["room-1"]);
  });
});
