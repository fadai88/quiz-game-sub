const mongoose = require("mongoose");

/**
 * QuestionCalibration — one document per (question, model) pair recording how a
 * given LLM performed on a question.
 *
 * Purpose (anti-cheat): find "AI-discriminator" questions where LLM behaviour
 * diverges from human behaviour.
 *   - llmCorrect=true across strong models ⇒ LLM-easy: a same-device assistant
 *     aces it instantly, so a human nailing a whole set of these fast is a flag.
 *   - llmCorrect=false ⇒ LLM-hard: honest humans and cheaters diverge here.
 * Seeding a couple of these per match lets response/accuracy telemetry separate
 * genuine knowledge from an assistant. See [[anti-cheat-telemetry]].
 *
 * Populated offline by scripts/calibrate-questions.js; never written at runtime.
 */
const QuestionCalibrationSchema = new mongoose.Schema(
  {
    questionId: { type: mongoose.Schema.Types.ObjectId, required: true },
    collectionName: { type: String, default: "Quiz" }, // which bank: Quiz | PracticeQuiz
    model: { type: String, required: true }, // e.g. "claude-haiku-4-5-20251001"
    correctAnswer: { type: Number, required: true }, // index into the question's options
    llmAnswer: { type: Number, default: -1 }, // index the model chose (-1 = unparseable)
    llmCorrect: { type: Boolean, default: false },
    raw: { type: String }, // short snippet of the raw model reply, for spot-checking
  },
  { timestamps: true }
);

// One result per question per model; re-runs upsert in place.
QuestionCalibrationSchema.index({ questionId: 1, model: 1 }, { unique: true });
// For "how hard is this question for LLMs across models" aggregation.
QuestionCalibrationSchema.index({ model: 1, llmCorrect: 1 });

module.exports = mongoose.model(
  "QuestionCalibration",
  QuestionCalibrationSchema
);
