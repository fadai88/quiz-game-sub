const mongoose = require("mongoose");

// Separate question bank for free practice games. Kept apart from the main
// `Quiz` collection (used by real/staked/ranked/tournament games) so the paid
// question pool is never exposed in free play. Same shape as Quiz.
// Populated from data/practice.db via migrate-script.js.
const PracticeQuizSchema = new mongoose.Schema({
  question: String,
  options: [String],
  correctAnswer: Number,
});

module.exports = mongoose.model("PracticeQuiz", PracticeQuizSchema);
