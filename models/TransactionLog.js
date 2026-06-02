/**
 * models/TransactionLog.js
 * Persistent audit log for verified on-chain transactions (replay-attack prevention).
 */

const mongoose = require("mongoose");

const TransactionLog = mongoose.model(
  "TransactionLog",
  new mongoose.Schema({
    signature: { type: String, required: true, unique: true, index: true },
    walletAddress: String,
    betAmount: Number,
    verifiedAt: { type: Date, default: Date.now },
    status: {
      type: String,
      enum: ["pending", "verified", "replayed", "failed"],
    },
  })
);

module.exports = TransactionLog;
