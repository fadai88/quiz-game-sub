"use strict";

/**
 * Response-time accounting tests for timed-out answers.
 *
 * Bug: when a player ran out of time on a question, the timeout handler set
 * their per-question `lastResponseTime` but never added it to the running
 * `totalResponseTime`. Because head-to-head ties are broken by the LOWER total
 * response time, timing out was actually cheaper than answering slowly — a
 * player could win a tie-break by not answering hard questions.
 *
 * These tests exercise `markUnansweredPlayersTimedOut`, the exact helper both
 * timeout handlers (startNextQuestion / restartCurrentQuestion) call.
 */

const { expect } = require("chai");
const { markUnansweredPlayersTimedOut } = require("../services/gameService");

// ── Fixtures ──────────────────────────────────────────────────────────────────

const QUESTION_START = 1_000;
const NOW = 11_000; // 10s after the question started → full-duration timeout
const ELAPSED = NOW - QUESTION_START; // 10_000

function makePlayer(overrides = {}) {
  return {
    username: "wallet-" + (overrides.username || "A"),
    isBot: false,
    answered: false,
    lastAnswer: null,
    lastResponseTime: null,
    score: 0,
    totalResponseTime: 0,
    ...overrides,
  };
}

function makeRoom(players) {
  return {
    questionStartTime: QUESTION_START,
    answersReceived: 0,
    players,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("gameService — timed-out response-time accounting", () => {
  it("adds the full elapsed time to a timed-out player's total (the bug fix)", () => {
    const player = makePlayer();
    const room = makeRoom([player]);

    markUnansweredPlayersTimedOut(room, NOW);

    // Before the fix this stayed 0 — the core regression guard.
    expect(player.totalResponseTime).to.equal(ELAPSED);
    expect(player.lastResponseTime).to.equal(ELAPSED);
    expect(player.answered).to.equal(true);
    expect(player.lastAnswer).to.equal(-1);
  });

  it("accumulates onto an existing total instead of overwriting it", () => {
    // Player already spent 6s answering an earlier question.
    const player = makePlayer({ totalResponseTime: 6_000 });
    const room = makeRoom([player]);

    markUnansweredPlayersTimedOut(room, NOW);

    expect(player.totalResponseTime).to.equal(6_000 + ELAPSED);
  });

  it("leaves players who already answered untouched", () => {
    const answered = makePlayer({
      username: "A",
      answered: true,
      lastAnswer: 2,
      lastResponseTime: 3_200,
      totalResponseTime: 3_200,
    });
    const room = makeRoom([answered]);

    const timedOut = markUnansweredPlayersTimedOut(room, NOW);

    expect(timedOut).to.have.lengthOf(0);
    expect(answered.totalResponseTime).to.equal(3_200);
    expect(answered.lastAnswer).to.equal(2);
    expect(room.answersReceived).to.equal(0);
  });

  it("never penalises bots (their timing is handled separately)", () => {
    const bot = makePlayer({ username: "bot", isBot: true });
    const room = makeRoom([bot]);

    const timedOut = markUnansweredPlayersTimedOut(room, NOW);

    expect(timedOut).to.have.lengthOf(0);
    expect(bot.totalResponseTime).to.equal(0);
    expect(bot.answered).to.equal(false);
  });

  it("times out only the unanswered player in a mixed room and reports it", () => {
    const fast = makePlayer({
      username: "fast",
      answered: true,
      lastAnswer: 1,
      lastResponseTime: 4_000,
      totalResponseTime: 4_000,
    });
    const slow = makePlayer({ username: "slow" });
    const room = makeRoom([fast, slow]);

    const timedOut = markUnansweredPlayersTimedOut(room, NOW);

    // The answerer keeps their honest total; the timer-out is charged the max.
    expect(fast.totalResponseTime).to.equal(4_000);
    expect(slow.totalResponseTime).to.equal(ELAPSED);

    // The bug previously let the slow player END UP with a LOWER total than the
    // player who actually answered — which would wrongly win the tie-break.
    expect(slow.totalResponseTime).to.be.greaterThan(fast.totalResponseTime);

    expect(room.answersReceived).to.equal(1);
    expect(timedOut).to.deep.equal([
      { username: slow.username, responseTime: ELAPSED },
    ]);
  });
});
