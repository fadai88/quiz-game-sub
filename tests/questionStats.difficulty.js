"use strict";

/**
 * Unit tests for the empirical difficulty derivation in services/questionStats.
 *
 * deriveDifficulty(correctRate, attempts) maps a question's measured human
 * correct-rate to a bucket, but only once it has enough attempts to be trusted
 * (below MIN_ATTEMPTS it stays "unrated" so a single lucky/unlucky answer never
 * mislabels a question).
 */

const { expect } = require("chai");
const {
  deriveDifficulty,
  MIN_ATTEMPTS,
  EASY_MIN,
  HARD_MAX,
} = require("../services/questionStats");

describe("questionStats — deriveDifficulty", () => {
  it("is 'unrated' below the minimum attempts, regardless of rate", () => {
    expect(deriveDifficulty(1.0, MIN_ATTEMPTS - 1)).to.equal("unrated");
    expect(deriveDifficulty(0.0, 0)).to.equal("unrated");
    expect(deriveDifficulty(0.9, 1)).to.equal("unrated");
  });

  it("labels high correct-rate questions 'easy'", () => {
    expect(deriveDifficulty(EASY_MIN, MIN_ATTEMPTS)).to.equal("easy");
    expect(deriveDifficulty(0.95, 50)).to.equal("easy");
    expect(deriveDifficulty(1.0, 20)).to.equal("easy");
  });

  it("labels low correct-rate questions 'hard'", () => {
    expect(deriveDifficulty(HARD_MAX - 0.01, MIN_ATTEMPTS)).to.equal("hard");
    expect(deriveDifficulty(0.1, 30)).to.equal("hard");
    expect(deriveDifficulty(0.0, 10)).to.equal("hard");
  });

  it("labels the middle band 'medium'", () => {
    expect(deriveDifficulty(HARD_MAX, MIN_ATTEMPTS)).to.equal("medium"); // inclusive lower edge
    expect(deriveDifficulty(0.6, 40)).to.equal("medium");
    expect(deriveDifficulty(EASY_MIN - 0.01, 40)).to.equal("medium");
  });

  it("treats the bucket edges consistently (easy is inclusive, hard is exclusive)", () => {
    // exactly EASY_MIN → easy; exactly HARD_MAX → medium (not hard)
    expect(deriveDifficulty(EASY_MIN, 10)).to.equal("easy");
    expect(deriveDifficulty(HARD_MAX, 10)).to.equal("medium");
  });
});
