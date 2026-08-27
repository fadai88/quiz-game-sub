"use strict";

/**
 * Tests for the content-derived question id (scripts/import-questions.js).
 *
 * Background: question `_id`s used to be generated fresh on every import, so
 * re-importing after an edit silently orphaned every collection that references
 * questions — QuestionCalibration (expensive LLM calls), QuestionStats and
 * AnswerTelemetry. On 2026-08-25 an answer-key fix detached all 30,075
 * calibration rows, and nothing errored, because services/discriminators.js
 * fails soft by design.
 *
 * The property that prevents a repeat is narrow and worth pinning exactly:
 * correcting an ANSWER KEY must preserve a question's identity, while changing
 * its TEXT or OPTIONS must not.
 */

const { expect } = require("chai");
const mongoose = require("mongoose");
const { stableQuestionId } = require("../scripts/import-questions");

const question = {
  question: "Which planet is closest to the Sun?",
  options: ["A) Venus", "B) Mercury", "C) Earth", "D) Mars"],
  correctAnswer: 1,
};

describe("stableQuestionId", () => {
  it("produces a valid ObjectId", () => {
    const id = stableQuestionId(question);
    expect(mongoose.Types.ObjectId.isValid(id)).to.equal(true);
  });

  it("is deterministic — the same question always gets the same id", () => {
    expect(String(stableQuestionId(question))).to.equal(
      String(stableQuestionId({ ...question }))
    );
  });

  it("PRESERVES the id when only the answer key is corrected", () => {
    // The whole point. Fixing a wrong key must not throw away the question's
    // calibration, difficulty stats and telemetry history.
    const corrected = { ...question, correctAnswer: 0 };
    expect(String(stableQuestionId(corrected))).to.equal(
      String(stableQuestionId(question))
    );
  });

  it("mints a new id when the wording changes", () => {
    const reworded = { ...question, question: "Which planet orbits closest?" };
    expect(String(stableQuestionId(reworded))).to.not.equal(
      String(stableQuestionId(question))
    );
  });

  it("mints a new id when an option changes", () => {
    const reoptioned = {
      ...question,
      options: ["A) Venus", "B) Mercury", "C) Earth", "D) Jupiter"],
    };
    expect(String(stableQuestionId(reoptioned))).to.not.equal(
      String(stableQuestionId(question))
    );
  });

  it("mints a new id when options are merely reordered", () => {
    // Order is meaningful: correctAnswer is an index into it.
    const reordered = {
      ...question,
      options: ["B) Mercury", "A) Venus", "C) Earth", "D) Mars"],
    };
    expect(String(stableQuestionId(reordered))).to.not.equal(
      String(stableQuestionId(question))
    );
  });

  it("distinguishes questions that share text but differ in options", () => {
    // The bank genuinely contains these (44 such groups) and they must never be
    // treated as one question — see the questions-text-not-duplicate note.
    const a = {
      question: "What is the capital?",
      options: ["A) Paris", "B) Lyon"],
      correctAnswer: 0,
    };
    const b = {
      question: "What is the capital?",
      options: ["A) Rome", "B) Milan"],
      correctAnswer: 0,
    };
    expect(String(stableQuestionId(a))).to.not.equal(
      String(stableQuestionId(b))
    );
  });

  it("cannot be confused by text that runs into an option boundary", () => {
    // Hashing a plain concatenation would make these two collide.
    const a = {
      question: "AB",
      options: ["C", "D"],
      correctAnswer: 0,
    };
    const b = {
      question: "A",
      options: ["BC", "D"],
      correctAnswer: 0,
    };
    expect(String(stableQuestionId(a))).to.not.equal(
      String(stableQuestionId(b))
    );
  });
});
