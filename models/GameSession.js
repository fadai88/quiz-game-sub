/**
 * models/GameSession.js
 * Persistent record of game sessions — used for crash-recovery and safety-net refunds.
 */

const mongoose = require("mongoose");

const GameSessionSchema = new mongoose.Schema({
  roomId: { type: String, required: true, unique: true, index: true },
  betAmount: { type: Number, required: true },
  gameMode: {
    type: String,
    enum: ["practice", "tournament"],
    default: "practice",
  },
  players: [
    {
      walletAddress: String,
      socketId: String,
    },
  ],
  status: {
    type: String,
    enum: ["active", "completed", "refunded", "error"],
    default: "active",
  },
  startTime: { type: Date, default: Date.now },
  endTime: Date,
  refundReason: String,
});

module.exports = mongoose.model("GameSession", GameSessionSchema);
