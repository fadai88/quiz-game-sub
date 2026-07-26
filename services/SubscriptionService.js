"use strict";

const { Connection, PublicKey } = require("@solana/web3.js");
const Subscription = require("../models/Subscription");
const TransactionLog = require("../models/TransactionLog");
const User = require("../models/User");
const context = require("../context");
const logger = require("../logger");
const { safeRedisOp } = require("./redisService");
const { SecurityLogger, AuditLogger } = require("../utils/securityLogger");

class SubscriptionService {
  constructor(config) {
    // Use 'finalized' so rolled-back fork transactions cannot be replayed (H1).
    this.connection = new Connection(config.SOLANA_RPC_URL, "finalized");
    this.treasuryWallet = new PublicKey(config.TREASURY_WALLET);
    this.usdcMint = new PublicKey(config.USDC_MINT);
    this.subscriptionPrices = {
      monthly: config.MONTHLY_SUBSCRIPTION_PRICE || 15, // $15 USDC
      yearly: config.YEARLY_SUBSCRIPTION_PRICE || 150, // $150 USDC
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // verifySubscriptionPayment
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Verify that a Solana transaction signature represents a valid subscription
   * payment from `walletAddress` of at least `expectedAmount` USDC to the
   * treasury, and that this exact signature has never been used before.
   *
   * @param {string} transactionSignature  - Base-58 Solana tx signature
   * @param {string} walletAddress         - Payer's public key (base-58)
   * @param {number} expectedAmount        - Required payment in USDC (e.g. 15)
   * @returns {{ verified, amount, transactionSignature, timestamp }}
   * @throws   Error on replay, wrong amount, wrong recipient, or chain failure
   */
  async verifySubscriptionPayment(
    transactionSignature,
    walletAddress,
    expectedAmount
  ) {
    logger.info(
      `[SUB] Verifying subscription payment: ${transactionSignature} from ${walletAddress}`
    );

    // ── Step 1: Replay prevention — MongoDB atomic upsert ────────────────
    // We use 'pending' status here and only promote to 'verified' after the
    // full on-chain check succeeds (Step 3+).  This prevents a failed
    // blockchain lookup from permanently "burning" a valid signature.
    //
    // Allowed transitions:
    //   null       → insert as 'pending'   (first attempt)
    //   'pending'  → allow retry            (previous attempt failed on-chain)
    //   'failed'   → allow retry            (previous attempt failed on-chain)
    //   'verified' → reject                 (genuine replay attack)
    const redisKey = `tx:${transactionSignature}`;
    try {
      const existing = await TransactionLog.findOne({
        signature: transactionSignature,
      });

      const STALE_PENDING_MS = 120_000; // > any single verification attempt
      if (existing !== null) {
        if (existing.status === "verified") {
          // This signature was already successfully processed.
          logger.error(
            `[SUB] ❌ REPLAY ATTACK: signature ${transactionSignature} already verified in TransactionLog`
          );
          SecurityLogger.log("subscription_replay_attack", {
            transactionSignature,
            walletAddress,
            existingStatus: existing.status,
          });
          throw new Error(
            "Transaction already processed — replay attack prevented"
          );
        }
        if (existing.status === "pending") {
          // A *fresh* pending row means another request for this signature is
          // in-flight — reject the concurrent duplicate (single-flight). Only a
          // stale one (owning attempt must have died) may be retried.
          const ageMs = Date.now() - new Date(existing.verifiedAt).getTime();
          if (ageMs < STALE_PENDING_MS) {
            logger.warn(
              `[SUB] ⏳ CONCURRENT: ${transactionSignature} already being processed`
            );
            throw new Error("Transaction already being processed");
          }
          logger.warn(
            `[SUB] ♻️  Reclaiming stale pending signature ${transactionSignature}`
          );
        } else {
          // 'failed' — a prior attempt failed; allow retry.
          logger.info(
            `[SUB] ℹ️  Retrying previously ${existing.status} signature ${transactionSignature}`
          );
        }
        // Re-arm the sentinel so this attempt owns the in-flight window.
        await TransactionLog.updateOne(
          { signature: transactionSignature },
          { $set: { status: "pending", verifiedAt: new Date() } }
        );
      } else {
        // First time we've seen this signature — insert a 'pending' sentinel
        // so concurrent requests are blocked by the unique index (code 11000).
        await TransactionLog.create({
          signature: transactionSignature,
          walletAddress,
          betAmount: expectedAmount,
          verifiedAt: new Date(),
          status: "pending",
        });
        logger.info(
          `[SUB] ✅ Replay check passed — signature recorded as pending`
        );
      }
    } catch (dbErr) {
      if (dbErr.code === 11000) {
        // Race condition: concurrent request inserted the sentinel first.
        // Treat like a verified replay to be safe.
        logger.error(
          `[SUB] ❌ RACE / REPLAY: duplicate key for ${transactionSignature}`
        );
        throw new Error("Transaction already processed");
      }
      if (
        dbErr.message.includes("replay") ||
        dbErr.message.includes("already processed") ||
        dbErr.message.includes("being processed")
      ) {
        throw dbErr;
      }
      logger.error("[SUB] ❌ MongoDB audit write failed:", {
        error: dbErr.message,
      });
      throw new Error(
        "Audit service unavailable — cannot process subscription"
      );
    }

    // ── Step 2: Redis cache check — fast second layer ─────────────────────
    await safeRedisOp(
      async () => {
        const cached = await context.redisClient.get(redisKey);
        if (cached) {
          logger.warn(
            `[SUB] ⚠️  Redis cache hit for ${redisKey} (Mongo is authoritative)`
          );
        }
      },
      null,
      "Redis subscription signature check"
    );

    // ── Step 3: Fetch & validate the on-chain transaction ─────────────────
    // Solana `finalized` commitment can take ~15–32 slots after broadcast.
    // Poll with backoff instead of failing immediately when null is returned.
    const TX_POLL_ATTEMPTS = 10;
    const TX_POLL_INTERVAL = 3000; // ms between attempts
    let transaction = null;
    for (let attempt = 1; attempt <= TX_POLL_ATTEMPTS; attempt++) {
      try {
        transaction = await this.connection.getTransaction(
          transactionSignature,
          {
            commitment: "finalized",
            maxSupportedTransactionVersion: 0,
          }
        );
      } catch (rpcErr) {
        await TransactionLog.findOneAndUpdate(
          { signature: transactionSignature },
          { status: "failed", errorMessage: rpcErr.message }
        ).catch(() => {});
        logger.error("[SUB] ❌ RPC fetch failed:", { error: rpcErr.message });
        throw new Error(
          "Failed to fetch transaction from blockchain — please try again"
        );
      }

      if (transaction !== null) break;

      if (attempt < TX_POLL_ATTEMPTS) {
        logger.info(
          `[SUB] ⏳ Transaction not yet finalized, waiting (attempt ${attempt}/${TX_POLL_ATTEMPTS})…`
        );
        await new Promise((resolve) => setTimeout(resolve, TX_POLL_INTERVAL));
      }
    }

    if (!transaction) {
      await TransactionLog.findOneAndUpdate(
        { signature: transactionSignature },
        {
          status: "failed",
          errorMessage: "Transaction not found after polling",
        }
      ).catch(() => {});
      throw new Error(
        "Transaction not found on blockchain — it may not be finalized yet, please retry in a moment"
      );
    }

    if (transaction.meta.err) {
      await TransactionLog.findOneAndUpdate(
        { signature: transactionSignature },
        { status: "failed", errorMessage: JSON.stringify(transaction.meta.err) }
      ).catch(() => {});
      throw new Error(
        `Transaction failed on-chain: ${JSON.stringify(transaction.meta.err)}`
      );
    }

    // ── Step 4: Verify transaction was signed by the authenticated wallet ──
    const accountKeys = transaction.transaction.message.accountKeys;
    const senderIndex = accountKeys.findIndex(
      (k) => k.toBase58() === walletAddress
    );
    if (senderIndex === -1) {
      await TransactionLog.findOneAndUpdate(
        { signature: transactionSignature },
        {
          status: "failed",
          errorMessage: "Transaction sender verification failed",
        }
      ).catch(() => {});
      throw new Error("Transaction sender verification failed");
    }
    const message = transaction.transaction.message;
    if (senderIndex >= message.header.numRequiredSignatures) {
      await TransactionLog.findOneAndUpdate(
        { signature: transactionSignature },
        {
          status: "failed",
          errorMessage: "Transaction not signed by expected sender",
        }
      ).catch(() => {});
      throw new Error("Transaction not signed by expected sender");
    }

    // ── Step 5: Verify USDC payment to treasury ───────────────────────────
    const { preTokenBalances, postTokenBalances } = transaction.meta;
    const usdcChanges = this._calculateTokenChanges(
      preTokenBalances,
      postTokenBalances
    );

    const paymentToTreasury = usdcChanges.find(
      (change) =>
        change.owner === this.treasuryWallet.toString() && change.amount > 0
    );

    if (!paymentToTreasury) {
      await TransactionLog.findOneAndUpdate(
        { signature: transactionSignature },
        {
          status: "failed",
          errorMessage: "No payment to treasury found in transaction",
        }
      ).catch(() => {});
      throw new Error("No payment to treasury found in transaction");
    }

    // Convert atomic units (6 decimals) → USDC float
    const paidAmount = paymentToTreasury.amount / 1e6;

    if (paidAmount < expectedAmount) {
      await TransactionLog.findOneAndUpdate(
        { signature: transactionSignature },
        {
          status: "failed",
          errorMessage: `Insufficient payment: expected ${expectedAmount} USDC, got ${paidAmount} USDC`,
        }
      ).catch(() => {});
      throw new Error(
        `Insufficient payment: expected ${expectedAmount} USDC, got ${paidAmount} USDC`
      );
    }

    // ── Step 6: Transaction age check ─────────────────────────────────────
    if (!transaction.blockTime) {
      await TransactionLog.findOneAndUpdate(
        { signature: transactionSignature },
        { status: "failed", errorMessage: "Transaction missing timestamp" }
      ).catch(() => {});
      throw new Error("Transaction missing timestamp");
    }
    const SUB_TX_MAX_AGE = 300000; // 5 minutes
    const txAge = Date.now() - transaction.blockTime * 1000;
    if (txAge > SUB_TX_MAX_AGE) {
      await TransactionLog.findOneAndUpdate(
        { signature: transactionSignature },
        { status: "failed", errorMessage: "Transaction expired" }
      ).catch(() => {});
      throw new Error(
        "Transaction expired — please resubmit with a recent transaction"
      );
    }
    logger.info(`[SUB] ✅ Transaction age: ${Math.round(txAge / 1000)}s`);

    // ── Step 7: Promote TransactionLog status to 'verified' ──────────
    // Only now — after all checks pass — do we mark the signature as fully
    // verified. Replay protection for future requests relies on this status.
    await TransactionLog.findOneAndUpdate(
      { signature: transactionSignature },
      { status: "verified", verifiedAt: new Date() }
    ).catch((err) =>
      logger.error("[SUB] ❌ Failed to promote TransactionLog to verified:", {
        error: err.message,
      })
    );

    // ── Step 8: Cache in Redis (best-effort, 7 days) ──────────────────────
    await safeRedisOp(
      async () => {
        await context.redisClient.set(redisKey, "1", "EX", 604800);
      },
      null,
      "Redis subscription cache write"
    );

    logger.info(
      `[SUB] ✅ Subscription payment verified: ${paidAmount} USDC from ${walletAddress}`
    );

    return {
      verified: true,
      amount: paidAmount,
      transactionSignature,
      timestamp: new Date(transaction.blockTime * 1000),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // createSubscription
  // ─────────────────────────────────────────────────────────────────────────

  async createSubscription(
    userId,
    walletAddress,
    transactionSignature,
    plan = "monthly"
  ) {
    const expectedAmount =
      this.subscriptionPrices[plan] ?? this.subscriptionPrices.monthly;

    // verifySubscriptionPayment() now enforces replay protection.
    const verification = await this.verifySubscriptionPayment(
      transactionSignature,
      walletAddress,
      expectedAmount
    );

    const startDate = new Date();
    const endDate = new Date();
    if (plan === "yearly") {
      endDate.setTime(endDate.getTime() + 365 * 24 * 60 * 60 * 1000);
    } else {
      endDate.setTime(endDate.getTime() + 30 * 24 * 60 * 60 * 1000);
    }

    const subscription = await Subscription.create({
      userId,
      walletAddress,
      status: "active",
      tier: "premium",
      amount: verification.amount,
      currency: "USDC",
      startDate,
      endDate,
      transactionSignature,
      autoRenew: false, // Default false — user must opt in explicitly
      metadata: {
        plan,
        verifiedAt: verification.timestamp,
      },
    });

    await User.findByIdAndUpdate(userId, {
      accountTier: "premium",
      subscriptionStatus: "active",
      subscriptionId: subscription._id,
    });

    AuditLogger.transactionVerified?.(
      walletAddress,
      verification.amount,
      transactionSignature,
      this.treasuryWallet.toString()
    );
    logger.info(`[SUB] ✅ Subscription created for user ${userId}: ${plan}`);

    return subscription;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // renewSubscription
  // ─────────────────────────────────────────────────────────────────────────

  async renewSubscription(subscriptionId, transactionSignature) {
    const subscription = await Subscription.findById(subscriptionId);
    if (!subscription) throw new Error("Subscription not found");

    // verifySubscriptionPayment() enforces replay protection here too.
    const verification = await this.verifySubscriptionPayment(
      transactionSignature,
      subscription.walletAddress,
      subscription.amount
    );

    await subscription.renew(transactionSignature);

    await User.findByIdAndUpdate(subscription.userId, {
      subscriptionStatus: "active",
    });

    logger.info(`[SUB] ✅ Subscription renewed: ${subscriptionId}`);

    return subscription;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // cancelSubscription
  // ─────────────────────────────────────────────────────────────────────────

  async cancelSubscription(subscriptionId) {
    const subscription = await Subscription.findById(subscriptionId);
    if (!subscription) throw new Error("Subscription not found");
    if (subscription.status !== "active")
      throw new Error(
        `Subscription cannot be cancelled (status: ${subscription.status})`
      );

    await subscription.cancel();

    // User keeps premium access until endDate — do not downgrade tier here.
    logger.info(`[SUB] ✅ Subscription cancelled: ${subscriptionId}`);

    return subscription;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // expireOldSubscriptions
  // ─────────────────────────────────────────────────────────────────────────

  async expireOldSubscriptions() {
    const expiredSubscriptions = await Subscription.find({
      status: "active",
      endDate: { $lt: new Date() },
    });

    for (const subscription of expiredSubscriptions) {
      subscription.status = "expired";
      await subscription.save();

      await User.findByIdAndUpdate(subscription.userId, {
        subscriptionStatus: "expired",
        accountTier: "free",
      });

      logger.info(`[SUB] Expired subscription: ${subscription._id}`);
    }

    return expiredSubscriptions.length;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // getPrices
  // ─────────────────────────────────────────────────────────────────────────

  getPrices() {
    return this.subscriptionPrices;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // _calculateTokenChanges  (private helper)
  // ─────────────────────────────────────────────────────────────────────────

  _calculateTokenChanges(preBalances, postBalances) {
    const changes = [];
    for (const post of postBalances) {
      if (post.mint !== this.usdcMint.toString()) continue;
      const pre = preBalances.find((p) => p.accountIndex === post.accountIndex);
      if (!pre) continue;
      const delta =
        Number(post.uiTokenAmount.amount) - Number(pre.uiTokenAmount.amount);
      if (delta !== 0) {
        changes.push({ owner: post.owner, amount: delta, mint: post.mint });
      }
    }
    return changes;
  }
}

module.exports = SubscriptionService;
