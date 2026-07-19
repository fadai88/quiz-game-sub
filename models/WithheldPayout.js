/**
 * models/WithheldPayout.js
 *
 * Escrow / audit record for a pot-mode payout that settlePotGame withheld
 * (fraud hold, missing dependency, staked-bot backstop, or a failed queue).
 *
 * Before this existed, a withheld pot was kept in the treasury with only a log
 * line and an alert — a false-positive fraud flag silently confiscated a
 * legitimate winner's stake with no record to resolve against. Each withhold now
 * writes one row here (idempotent per room) so operators have a queryable
 * worklist and can resolve it (refund the stake, release the payout, or deny)
 * rather than the funds vanishing into the treasury.
 *
 * Amounts are in USDC atomic units (1 USDC = 1e6), matching the rest of the
 * money path. No funds move as a side effect of writing this record.
 */

const mongoose = require("mongoose");

const withheldPayoutSchema = new mongoose.Schema(
  {
    // roomId doubles as the game id and is unique per settled game, so it is the
    // natural idempotency key: at most one withheld record per room.
    roomId: { type: String, required: true, unique: true, index: true },
    walletAddress: { type: String, required: true, index: true },
    stakeAmount: { type: Number, required: true }, // the winner's own stake (atomic)
    intendedPayout: { type: Number, default: null }, // winnings that were withheld (atomic)
    reason: {
      type: String,
      required: true,
      enum: ["fraud", "unavailable", "error", "staked_bot_game"],
    },
    flags: { type: [String], default: [] },
    suspicionScore: { type: Number, default: null },
    status: {
      type: String,
      enum: ["pending_review", "resolved_refunded", "resolved_paid", "resolved_denied"],
      default: "pending_review",
      index: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("WithheldPayout", withheldPayoutSchema);
