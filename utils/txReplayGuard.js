/**
 * utils/txReplayGuard.js
 *
 * Atomic single-flight replay guard for on-chain payment signatures, shared by
 * transactionVerifier.js and SubscriptionService.js.
 *
 * A signature is only a genuine replay once fully 'verified'. A 'pending' row
 * means an attempt is in-flight; a 'failed' row (or a 'pending' one older than
 * STALE_PENDING_MS, i.e. the owner died) may be retried. Claiming is done in a
 * single conditional findOneAndUpdate so two concurrent requests can't both take
 * over the same stale row (the previous read-then-update version could).
 */

const TransactionLog = require("../models/TransactionLog");

const STALE_PENDING_MS = 120_000; // > any single verification attempt

/**
 * Atomically claim `signature` for verification.
 *
 * @returns {Promise<void>} resolves if THIS caller now owns the in-flight window.
 * @throws  Error with .replay=true if already verified (genuine replay);
 *          Error with .concurrent=true if another attempt is in-flight;
 *          any other DB error is rethrown.
 */
async function claimSignatureForVerification(signature, meta = {}) {
  const now = new Date();
  const staleBefore = new Date(Date.now() - STALE_PENDING_MS);

  // 1. Atomically take over a 'failed' row or a *stale* 'pending' row. Only one
  //    concurrent caller can win — the update flips verifiedAt to now, so a
  //    second caller's predicate no longer matches.
  const reclaimed = await TransactionLog.findOneAndUpdate(
    {
      signature,
      $or: [
        { status: "failed" },
        { status: "pending", verifiedAt: { $lte: staleBefore } },
      ],
    },
    { $set: { status: "pending", verifiedAt: now, ...meta } },
    { new: true }
  );
  if (reclaimed) return;

  // 2. Nothing reclaimable — try to insert a fresh sentinel (first sighting).
  try {
    await TransactionLog.create({
      signature,
      status: "pending",
      verifiedAt: now,
      ...meta,
    });
    return;
  } catch (err) {
    if (err.code !== 11000) throw err; // real DB error

    // 3. Row exists and wasn't claimable → it's 'verified' (replay) or a *fresh*
    //    'pending' (another request is in-flight right now).
    const existing = await TransactionLog.findOne({ signature })
      .select("status")
      .lean();
    if (existing && existing.status === "verified") {
      const e = new Error(
        "Transaction already processed - replay attack prevented"
      );
      e.replay = true;
      throw e;
    }
    const e = new Error("Transaction already being processed");
    e.concurrent = true;
    throw e;
  }
}

module.exports = { claimSignatureForVerification, STALE_PENDING_MS };
