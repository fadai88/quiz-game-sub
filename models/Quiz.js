const mongoose = require("mongoose");

const QuizSchema = new mongoose.Schema({
  question: String,
  options: [String],
  correctAnswer: Number,
});

module.exports = mongoose.model("Quiz", QuizSchema);
