/**
 * services/refunds.js
 *
 * Single on-chain refund path for pot-mode stakes. Queues a USDC transfer from
 * the treasury back to the player's wallet (via PaymentQueue → PaymentProcessor).
 *
 * Replaces refundToVirtualBalance for staked games: virtual balance can't be
 * spent or withdrawn, so it never actually returned funds.
 *
 * Idempotent via a deterministic `refundKey` (PaymentQueue enforces a unique
 * gameId). Callers use consistent keys so the same stake can't be double-refunded
 * across different paths:
 *   refund:<roomId>:<wallet>       — in-flight game (abort / safety-net / restart)
 *   refund:pool:<wallet>:<joinTime> — staker still waiting in matchmaking
 *   refund:stake:<nonce>            — stake that failed after being verified
 *   refund:drain:<nonce>           — stake that raced in during maintenance drain
 *   refund:withheld:<recordId>     — operator-resolved withheld payout
 *
 * A zero/empty amount is a no-op (practice games, subscription ranked), so this
 * is safe to call unconditionally wherever the old virtual-balance refund was.
 */

const logger = require("../logger");
const PaymentQueue = require("../models/PaymentQueue");
const { formatUSDC } = require("../utils/usdcUtils");

async function queueOnChainRefund(wallet, amountAtomic, refundKey, reason) {
  if (!wallet || !amountAtomic || Number(amountAtomic) <= 0) return false;
  try {
    await PaymentQueue.queuePayment(
      wallet,
      Number(amountAtomic),
      refundKey,
      Number(amountAtomic),
      { type: "refund", reason }
    );
    logger.info(
      `[REFUND] queued ${formatUSDC(
        amountAtomic
      )} → ${wallet} (${refundKey}) — ${reason}`
    );
    return true;
  } catch (err) {
    // Duplicate gameId (already queued/refunded) → idempotent success.
    if (err.code === 11000 || /already/i.test(err.message || "")) {
      logger.info(`[REFUND] ${refundKey} already refunded — skipping`);
      return true;
    }
    logger.error(`[REFUND] failed for ${refundKey}`, { error: err.message });
    return false;
  }
}

module.exports = { queueOnChainRefund };
