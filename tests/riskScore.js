"use strict";

/**
 * Unit tests for the pure risk-scoring core (services/riskScore.scorePlayer).
 *
 * The design intent is "distributions, not single rules": no single metric flags
 * an account, and an honest expert (high accuracy but human-like varied timing)
 * must NOT be flagged, while a combined-bad profile (uniform + fast answers whose
 * correctness tracks LLM-easiness, plus IP clustering) must be.
 */

const { expect } = require("chai");
const {
  scorePlayer,
  coefficientOfVariation,
  clamp01,
  MIN_ANSWERS,
} = require("../services/riskScore");

function rec(isCorrect, responseTimeMs, llmCorrect) {
  return { isCorrect, timedOut: false, responseTimeMs, llmCorrect };
}

// Honest expert: 90% accuracy, but widely varying response times (fast on some,
// slow on others) and correctness that does NOT perfectly track LLM-easiness.
function honestExpert() {
  const r = [];
  for (let i = 0; i < 20; i++) r.push(rec(true, 1000 + i * 400, true));
  for (let i = 0; i < 20; i++) r.push(rec(i < 16, 1200 + i * 380, false));
  return r;
}

// Weak-model assistant + multi-accounting: near-uniform fast answers, aces the
// LLM-easy set and fails the LLM-hard set, and shares its IP with many wallets.
function botLike() {
  const r = [];
  for (let i = 0; i < 33; i++) r.push(rec(true, 1500 + (i % 2), true));
  for (let i = 0; i < 7; i++) r.push(rec(false, 1500 + (i % 2), false));
  return r;
}

describe("riskScore — helpers", () => {
  it("clamp01 bounds to [0,1]", () => {
    expect(clamp01(-3)).to.equal(0);
    expect(clamp01(0.4)).to.equal(0.4);
    expect(clamp01(9)).to.equal(1);
  });

  it("coefficientOfVariation is ~0 for uniform, larger for spread", () => {
    expect(coefficientOfVariation([1500, 1500, 1500])).to.be.closeTo(0, 1e-9);
    expect(coefficientOfVariation([1000, 5000, 9000])).to.be.greaterThan(0.4);
  });
});

describe("riskScore — scorePlayer", () => {
  it("returns insufficient_data below MIN_ANSWERS and does not flag", () => {
    const few = Array.from({ length: MIN_ANSWERS - 1 }, () =>
      rec(true, 1500, true)
    );
    const out = scorePlayer(few, { maxWalletsPerIp: 9 });
    expect(out.confidence).to.equal("insufficient_data");
    expect(out.score).to.equal(0);
    expect(out.flagged).to.equal(false);
  });

  it("does NOT flag an honest high-accuracy expert", () => {
    const out = scorePlayer(honestExpert(), { maxWalletsPerIp: 1 });
    expect(out.confidence).to.equal("ok");
    expect(out.flagged).to.equal(false);
    expect(out.score).to.be.lessThan(70);
  });

  it("flags a combined-bad (uniform, fast, LLM-aligned, clustered) profile", () => {
    const out = scorePlayer(botLike(), { maxWalletsPerIp: 5 });
    expect(out.flagged).to.equal(true);
    expect(out.score).to.be.greaterThanOrEqual(70);
  });

  it("ranks the bot-like profile well above the honest one", () => {
    const bot = scorePlayer(botLike(), { maxWalletsPerIp: 5 });
    const honest = scorePlayer(honestExpert(), { maxWalletsPerIp: 1 });
    expect(bot.score).to.be.greaterThan(honest.score);
  });

  it("high accuracy ALONE (varied timing, no clustering) is not enough to flag", () => {
    // Same accuracy as the bot but human-like varied timing and single account.
    const r = [];
    for (let i = 0; i < 33; i++) r.push(rec(true, 800 + i * 250, true));
    for (let i = 0; i < 7; i++) r.push(rec(false, 900 + i * 300, false));
    const out = scorePlayer(r, { maxWalletsPerIp: 1 });
    expect(out.flagged).to.equal(false);
  });
});
