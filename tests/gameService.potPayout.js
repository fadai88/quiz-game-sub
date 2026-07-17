"use strict";

/**
 * Pot-mode settlement tests.
 *
 * The subscription refactor dropped the per-game payout: the ranked branch of
 * handleGameOver emitted "Game complete" and never queued anything, so pot mode
 * could collect a stake and never pay it out. `settlePotGame` restores the
 * pre-refactor behaviour (server.js @ 9e0f96d) and these tests pin the parts
 * that move real money:
 *
 *   1. winner beating a human is paid 1.8× their stake (10% rake on the 2× pot)
 *   2. winner beating a bot is paid 1.5× (treasury-funded — no second stake)
 *   3. a bot "winner" is never paid
 *   4. a zero-stake room never reaches the payment queue
 *   5. a suspicious winner has the payout withheld and the account flagged
 *   6. a missing botDetector withholds rather than paying unchecked
 *   7. a failing queuePayment surfaces as withheld, not as a completed game
 *
 * No network calls: PaymentProcessor and BotDetector are stubbed, and the
 * context getters are replaced for the duration of each test.
 */

const { expect } = require("chai");
const sinon = require("sinon");

const context = require("../context");
const User = require("../models/User");
const { settlePotGame } = require("../services/gameService");

// ── Fixtures ──────────────────────────────────────────────────────────────────

const WINNER = "winnerWallet1111111111111111111111111111111";
const LOSER = "loserWallet22222222222222222222222222222222";
const BOT_NAME = "TriviaBot";
const ROOM_ID = "room-abc";
const STAKE = 10_000_000; // 10 USDC in atomic units — a valid bet amount

function humanRoom(overrides = {}) {
  return {
    betAmount: STAKE,
    roomMode: "ranked",
    players: [
      { username: WINNER, isBot: false },
      { username: LOSER, isBot: false },
    ],
    ...overrides,
  };
}

function botRoom(overrides = {}) {
  return {
    betAmount: STAKE,
    roomMode: "bot",
    players: [
      { username: WINNER, isBot: false },
      { username: BOT_NAME, isBot: true },
    ],
    ...overrides,
  };
}

// ── Harness ───────────────────────────────────────────────────────────────────

let sandbox;
let queuePayment;
let getSuspicionScore;
let getBotAnalysis;

function useContext({ withBotDetector = true, withProcessor = true } = {}) {
  const botDetector = { getSuspicionScore, getBotAnalysis };
  const paymentProcessor = { queuePayment };

  sandbox
    .stub(context, "botDetector")
    .get(() => (withBotDetector ? botDetector : null));
  sandbox
    .stub(context, "paymentProcessor")
    .get(() => (withProcessor ? paymentProcessor : null));
}

beforeEach(() => {
  sandbox = sinon.createSandbox();

  queuePayment = sandbox.stub().resolves({ _id: "payment-1" });
  getSuspicionScore = sandbox.stub().returns(0); // clean by default
  getBotAnalysis = sandbox.stub().returns({ found: true, flags: [] });

  // Never touch the database in these tests.
  sandbox.stub(User, "findOneAndUpdate").resolves({});
});

afterEach(() => sandbox.restore());

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("gameService — pot settlement", () => {
  it("pays a human winner 1.8× their stake against a human opponent", async () => {
    useContext();

    const outcome = await settlePotGame(ROOM_ID, humanRoom(), WINNER, false);

    expect(queuePayment.calledOnce).to.equal(true);
    const [recipient, amount, gameId, betAmount] = queuePayment.firstCall.args;
    expect(recipient).to.equal(WINNER);
    expect(amount).to.equal(18_000_000); // 1.8 × 10 USDC
    expect(gameId).to.equal(ROOM_ID);
    expect(betAmount).to.equal(STAKE);
    expect(outcome).to.deep.include({
      paymentId: "payment-1",
      withheld: false,
      withheldReason: null,
    });
  });

  it("pays a human winner 1.5× their stake against a bot opponent", async () => {
    useContext();

    await settlePotGame(ROOM_ID, botRoom(), WINNER, true);

    expect(queuePayment.calledOnce).to.equal(true);
    expect(queuePayment.firstCall.args[1]).to.equal(15_000_000); // 1.5 × 10 USDC
  });

  it("passes a plain number to the payment queue, never a bigint", async () => {
    // calculateWinnings returns a bigint; queuePayment and the Mongo document
    // expect a Number. A bigint here would throw on serialisation.
    useContext();

    await settlePotGame(ROOM_ID, humanRoom(), WINNER, false);

    expect(typeof queuePayment.firstCall.args[1]).to.equal("number");
  });

  it("never pays a bot that wins", async () => {
    useContext();

    const outcome = await settlePotGame(ROOM_ID, botRoom(), BOT_NAME, true);

    expect(queuePayment.called).to.equal(false);
    expect(outcome.paymentId).to.equal(null);
    expect(outcome.withheld).to.equal(false); // nothing owed, not withheld
  });

  it("never queues a payment for a zero-stake room", async () => {
    useContext();

    const outcome = await settlePotGame(
      ROOM_ID,
      humanRoom({ betAmount: 0 }),
      WINNER,
      false
    );

    expect(queuePayment.called).to.equal(false);
    expect(outcome.paymentId).to.equal(null);
  });

  it("withholds the payout and flags the account when the winner looks automated", async () => {
    getSuspicionScore.returns(85); // over the 70 threshold
    getBotAnalysis.returns({
      found: true,
      flags: ["robotic_timing", "fast_answer"],
    });
    useContext();

    const outcome = await settlePotGame(ROOM_ID, humanRoom(), WINNER, false);

    expect(queuePayment.called).to.equal(false);
    expect(outcome).to.deep.include({
      paymentId: null,
      withheld: true,
      withheldReason: "fraud",
    });

    expect(User.findOneAndUpdate.calledOnce).to.equal(true);
    const [filter, update] = User.findOneAndUpdate.firstCall.args;
    expect(filter).to.deep.equal({ walletAddress: WINNER });
    expect(update.$set.isFlagged).to.equal(true);
    expect(update.$set.flagReason).to.contain("robotic_timing");
  });

  it("pays out at exactly one point below the fraud threshold", async () => {
    // Guards against the boundary flipping to > vs >=.
    getSuspicionScore.returns(69);
    useContext();

    const outcome = await settlePotGame(ROOM_ID, humanRoom(), WINNER, false);

    expect(queuePayment.calledOnce).to.equal(true);
    expect(outcome.withheld).to.equal(false);
  });

  it("withholds rather than paying unchecked when botDetector is unavailable", async () => {
    useContext({ withBotDetector: false });

    const outcome = await settlePotGame(ROOM_ID, humanRoom(), WINNER, false);

    expect(queuePayment.called).to.equal(false);
    expect(outcome).to.deep.include({
      withheld: true,
      withheldReason: "unavailable",
    });
  });

  it("withholds when the payment processor is unavailable", async () => {
    useContext({ withProcessor: false });

    const outcome = await settlePotGame(ROOM_ID, humanRoom(), WINNER, false);

    expect(outcome).to.deep.include({
      withheld: true,
      withheldReason: "unavailable",
    });
  });

  it("reports a failed queue as withheld instead of a completed game", async () => {
    // The stake is already collected; a silent failure here would look like a
    // normal win with no money.
    queuePayment.rejects(new Error("Treasury low on SOL"));
    useContext();

    const outcome = await settlePotGame(ROOM_ID, humanRoom(), WINNER, false);

    expect(outcome).to.deep.include({
      paymentId: null,
      withheld: true,
      withheldReason: "error",
    });
  });
});
