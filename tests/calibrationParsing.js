"use strict";

/**
 * Tests for the calibration reply parsers (scripts/calibrate-questions.js).
 *
 * Why these matter more than they look: whatever these functions return is
 * recorded as "what the model answered", and llmCorrect=false is exactly what
 * defines an AI-discriminator — a question that can be forced into a real-money
 * match. A parser that quietly returns the wrong index poisons that set, and
 * nothing downstream would notice.
 *
 * The specific hazard is reasoning output. Once a model is given room to work a
 * question out ("a regular octagon has 8 sides", "(8-2)*180 = 1080"), its reply
 * is full of integers and equals-signs that must NOT be mistaken for answers.
 */

const { expect } = require("chai");
const { parseIndex, parseBatch } = require("../scripts/calibrate-questions");

const q4 = (n) =>
  Array.from({ length: n }, () => ({ options: ["A", "B", "C", "D"] }));

describe("parseIndex — single-question replies", () => {
  it("reads the explicit ANSWER marker", () => {
    expect(parseIndex("ANSWER=2", 4)).to.equal(2);
    expect(parseIndex("answer: 3", 4)).to.equal(3);
  });

  it("ignores reasoning and takes the marker", () => {
    const reply =
      "A regular octagon has 8 sides, so the interior angles sum to " +
      "(8-2)*180 = 1080 degrees.\nANSWER=1";
    // The old parser took the first integer — 8 — and recorded it as the answer.
    expect(parseIndex(reply, 4)).to.equal(1);
  });

  it("takes the LAST marker when the model restates itself", () => {
    expect(parseIndex("ANSWER=0 ... on reflection, ANSWER=3", 4)).to.equal(3);
  });

  it("still accepts a terse bare-number reply", () => {
    expect(parseIndex("2", 4)).to.equal(2);
    expect(parseIndex("  3\n", 4)).to.equal(3);
  });

  it("refuses to guess from prose with no marker", () => {
    // -1 means "unparseable", which is excluded from the discriminator set —
    // strictly better than recording a number scraped out of a sentence.
    const reply = "The octagon has 8 sides, giving 1080 degrees in total.";
    expect(parseIndex(reply, 4)).to.equal(-1);
  });

  it("rejects an out-of-range index", () => {
    expect(parseIndex("ANSWER=9", 4)).to.equal(-1);
    expect(parseIndex("ANSWER=4", 4)).to.equal(-1); // 0-based: 4 is out of range
  });

  it("returns -1 for an empty or numberless reply", () => {
    expect(parseIndex("", 4)).to.equal(-1);
    expect(parseIndex("I am not sure.", 4)).to.equal(-1);
  });
});

describe("parseBatch — batched replies", () => {
  it("parses a clean ANSWERS block", () => {
    const text = "ANSWERS:\n1=2\n2=0\n3=3";
    expect(parseBatch(text, q4(3))).to.deep.equal([2, 0, 3]);
  });

  it("parses bare N=I lines when no block marker is present", () => {
    // Older prompts produced this shape; must stay readable.
    expect(parseBatch("1=2\n2=0", q4(2))).to.deep.equal([2, 0]);
  });

  it("ignores arithmetic in reasoning before the ANSWERS block", () => {
    // "(8-2)*180 = 1080" previously matched the N=I pattern mid-sentence and was
    // recorded as an unparseable answer for question 8.
    const text =
      "Question 8 is a regular octagon: (8-2)*180 = 1080 degrees.\n" +
      "Question 2 needs 13*13*13 = 2197, so the last digit is 7.\n" +
      "ANSWERS:\n1=0\n2=3";
    expect(parseBatch(text, q4(2))).to.deep.equal([0, 3]);
  });

  it("uses the LAST ANSWERS block if the model emits more than one", () => {
    const text = "ANSWERS:\n1=0\n2=0\n\nCorrection.\nANSWERS:\n1=1\n2=2";
    expect(parseBatch(text, q4(2))).to.deep.equal([1, 2]);
  });

  it("leaves unanswered questions PENDING rather than recording them wrong", () => {
    // undefined => retried on the next run. A -1 would be written to the
    // database and never retried, which is how a truncated batch would
    // permanently mislabel a question.
    const result = parseBatch("ANSWERS:\n1=2", q4(3));
    expect(result[0]).to.equal(2);
    expect(result[1]).to.equal(undefined);
    expect(result[2]).to.equal(undefined);
  });

  it("records an out-of-range option as unparseable, not as an answer", () => {
    expect(parseBatch("ANSWERS:\n1=9", q4(1))).to.deep.equal([-1]);
  });

  it("ignores answers for questions outside the batch", () => {
    const result = parseBatch("ANSWERS:\n1=1\n7=2", q4(2));
    expect(result).to.deep.equal([1, undefined]);
  });

  it("tolerates whitespace around the pairs", () => {
    expect(parseBatch("ANSWERS:\n  1 = 2  \n\t2=0\t", q4(2))).to.deep.equal([
      2, 0,
    ]);
  });

  it("returns all-pending for a reply truncated before the block", () => {
    // The exact failure that stranded 810 questions: the model ran out of
    // budget mid-reasoning and never reached its ANSWERS block.
    const text = "Let me work through these. Question 1 concerns an octagon,";
    expect(parseBatch(text, q4(3))).to.deep.equal([
      undefined,
      undefined,
      undefined,
    ]);
  });
});
