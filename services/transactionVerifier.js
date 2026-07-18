/**
 * services/transactionVerifier.js
 * On-chain USDC transaction verification with replay-attack, nonce, and amount checks.
 */

const bs58 = require("bs58").default;
const logger = require("../logger");
const context = require("../context");
const TransactionLog = require("../models/TransactionLog");
const { safeRedisOp } = require("./redisService");
const { formatUSDC } = require("../utils/usdcUtils");

// ─── Blockchain status check ──────────────────────────────────────────────────

async function verifyTransactionWithStatus(
  signature,
  maxRetries = 12,
  retryDelay = 1000
) {
  const cfg = context.config;
  // "confirmed" means a supermajority of the cluster has voted on the block;
  // it is safe enough to accept a stake and lands within a few seconds. Waiting
  // for "finalized" (32 slots, ~15-30s) would make every player wait that long
  // and, with a short retry budget, fail outright before finalization is even
  // possible.
  const ACCEPTABLE_STATUSES = new Set(["confirmed", "finalized"]);
  for (let i = 0; i < maxRetries; i++) {
    logger.info(
      `🔍 Verification attempt ${i + 1}/${maxRetries} for ${signature}`
    );
    const statuses = await cfg.connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    const status = statuses.value[0];
    // A transaction that landed but failed on-chain still has a status; surface
    // it immediately instead of burning the whole retry budget waiting.
    if (status?.err) {
      logger.error(
        `❌ Transaction failed on-chain: ${JSON.stringify(status.err)}`
      );
      return await cfg.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });
    }
    if (status && ACCEPTABLE_STATUSES.has(status.confirmationStatus)) {
      logger.info(`✅ Transaction ${status.confirmationStatus} on blockchain`);
      return await cfg.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });
    }
    if (i < maxRetries - 1) {
      logger.info(
        `⏳ Transaction not confirmed yet, retrying in ${retryDelay}ms...`
      );
      await new Promise((r) => setTimeout(r, retryDelay));
    }
  }
  logger.info(`❌ Transaction verification failed after ${maxRetries} retries`);
  return null;
}

// ─── Full verification pipeline ──────────────────────────────────────────────

async function verifyAndValidateTransaction(
  signature,
  expectedAmount,
  senderAddress,
  recipientAddress,
  nonce,
  maxRetries = 12,
  retryDelay = 1000
) {
  const cfg = context.config;
  const redisClient = context.redisClient;

  logger.info(`🔐 SECURE VERIFICATION: ${signature}`);
  logger.info(
    `   Expected: ${formatUSDC(
      expectedAmount
    )} from ${senderAddress} to ${recipientAddress}`
  );
  logger.info(`   Nonce: ${nonce}`);

  const key = `tx:${signature}`;
  const nonceKey = `nonce:${nonce}`;

  // Step 1 — Replay prevention (MongoDB atomic upsert)
  try {
    const result = await TransactionLog.findOneAndUpdate(
      { signature },
      {
        $setOnInsert: {
          signature,
          walletAddress: senderAddress,
          betAmount: expectedAmount,
          verifiedAt: new Date(),
          status: "verified",
        },
      },
      { upsert: true, new: false, runValidators: true }
    );
    if (result !== null) {
      logger.error(`❌ REPLAY ATTACK DETECTED: ${signature} already processed`);
      throw new Error(
        "Transaction already processed - replay attack prevented"
      );
    }
    logger.info("✅ MongoDB: New transaction recorded");
  } catch (dbErr) {
    if (dbErr.code === 11000) {
      logger.error(`❌ RACE CONDITION: ${signature} duplicate key error`);
      throw new Error("Transaction already processed");
    }
    logger.error("❌ MongoDB audit failed:", { error: dbErr.message });
    throw new Error("Audit service unavailable");
  }

  // Step 2A — Redis signature check (best-effort)
  await safeRedisOp(
    async () => {
      const exists = await redisClient.get(key);
      if (exists)
        logger.info(
          `⚠️  Redis: Replay detected for ${key} (MongoDB already prevented)`
        );
    },
    null,
    "Redis signature check"
  );

  // Step 2B — Nonce check (strict)
  try {
    const storedNonce = await redisClient.get(nonceKey);
    if (storedNonce) {
      logger.error(`❌ NONCE REUSE DETECTED: ${nonce}`);
      await TransactionLog.findOneAndUpdate(
        { signature },
        { status: "failed", errorMessage: "Nonce already used" }
      );
      throw new Error("Nonce already used - duplicate request prevented");
    }
    await redisClient.set(nonceKey, "used", "EX", 86400);
    logger.info(`✅ Nonce registered: ${nonce}`);
  } catch (error) {
    if (error.message.includes("Nonce already used")) throw error;
    logger.error("❌ CRITICAL: Redis nonce service unavailable");
    await TransactionLog.findOneAndUpdate(
      { signature },
      {
        status: "failed",
        errorMessage: "Nonce verification service unavailable",
      }
    );
    throw new Error("Unable to verify transaction - please try again");
  }

  // Step 3 — Fetch & confirm blockchain transaction
  let transaction;
  try {
    transaction = await verifyTransactionWithStatus(
      signature,
      maxRetries,
      retryDelay
    );
  } catch (error) {
    if (error.message.includes("Invalid param: Invalid")) {
      logger.error(`❌ Invalid signature format: ${signature}`);
      await TransactionLog.findOneAndUpdate(
        { signature },
        { status: "failed", errorMessage: "Invalid signature" }
      );
      throw new Error("Invalid transaction signature");
    }
    logger.error(`❌ Blockchain verification failed: ${error.message}`);
    await TransactionLog.findOneAndUpdate(
      { signature },
      { status: "failed", errorMessage: error.message }
    );
    throw new Error("Failed to verify transaction on blockchain");
  }

  if (!transaction) {
    await TransactionLog.findOneAndUpdate(
      { signature },
      { status: "failed", errorMessage: "Transaction not found" }
    );
    throw new Error("Transaction could not be verified");
  }
  if (transaction.meta.err) {
    logger.error(
      `❌ Transaction failed on-chain: ${JSON.stringify(transaction.meta.err)}`
    );
    await TransactionLog.findOneAndUpdate(
      { signature },
      { status: "failed", errorMessage: JSON.stringify(transaction.meta.err) }
    );
    throw new Error("Transaction failed on the blockchain");
  }
  logger.info("✅ Transaction fetched from blockchain");

  // Step 4 — Verify sender signed the transaction
  const accountKeys = transaction.transaction.message.accountKeys;
  const senderIndex = accountKeys.findIndex(
    (k) => k.toBase58() === senderAddress
  );
  if (senderIndex === -1) {
    await TransactionLog.findOneAndUpdate(
      { signature },
      {
        status: "failed",
        errorMessage: "Sender wallet not found in transaction",
      }
    );
    throw new Error("Transaction sender verification failed");
  }
  const message = transaction.transaction.message;
  if (senderIndex >= message.header.numRequiredSignatures) {
    await TransactionLog.findOneAndUpdate(
      { signature },
      { status: "failed", errorMessage: "Sender did not sign transaction" }
    );
    throw new Error("Transaction not signed by expected sender");
  }
  logger.info(`✅ Sender verified: ${senderAddress}`);

  // Steps 5-6 — Verify USDC token balances
  const { postTokenBalances, preTokenBalances } = transaction.meta;
  if (!postTokenBalances || !preTokenBalances) {
    await TransactionLog.findOneAndUpdate(
      { signature },
      { status: "failed", errorMessage: "Missing token balances" }
    );
    throw new Error("Transaction missing required balance information");
  }

  const usdcMint = cfg.USDC_MINT.toBase58();
  const treasuryPost = postTokenBalances.find(
    (b) => b.owner === recipientAddress && b.mint === usdcMint
  );
  const treasuryPre = preTokenBalances.find(
    (b) => b.owner === recipientAddress && b.mint === usdcMint
  );

  if (!treasuryPost || !treasuryPre) {
    await TransactionLog.findOneAndUpdate(
      { signature },
      { status: "failed", errorMessage: "Wrong token - expected USDC" }
    );
    throw new Error("Transaction does not transfer USDC to treasury");
  }

  const actualTransferAmount =
    BigInt(treasuryPost.uiTokenAmount.amount || "0") -
    BigInt(treasuryPre.uiTokenAmount.amount || "0");
  if (!Number.isInteger(expectedAmount))
    throw new Error("Bet amount must be in atomic units (integer)");

  if (actualTransferAmount !== BigInt(expectedAmount)) {
    await TransactionLog.findOneAndUpdate(
      { signature },
      {
        status: "failed",
        errorMessage: `Amount mismatch: expected ${formatUSDC(
          expectedAmount
        )}, got ${formatUSDC(actualTransferAmount)}`,
      }
    );
    throw new Error(
      `Amount mismatch: expected ${formatUSDC(
        expectedAmount
      )}, received ${formatUSDC(actualTransferAmount)}`
    );
  }
  logger.info(`✅ Amount verified: ${formatUSDC(expectedAmount)}`);

  // Step 9 — Verify memo nonce
  try {
    const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
    const memoIx = transaction.transaction.message.instructions.find(
      (ix) => accountKeys[ix.programIdIndex].toString() === MEMO_PROGRAM_ID
    );
    if (!memoIx) {
      await TransactionLog.findOneAndUpdate(
        { signature },
        { status: "failed", errorMessage: "Missing memo instruction" }
      );
      throw new Error(
        "Transaction missing memo instruction for replay protection"
      );
    }
    let memoText;
    try {
      memoText = Buffer.from(bs58.decode(memoIx.data)).toString("utf8");
    } catch {
      try {
        memoText = Buffer.from(memoIx.data, "base64").toString("utf8");
      } catch {
        memoText = memoIx.data;
      }
    }
    if (!memoText.includes(nonce)) {
      await TransactionLog.findOneAndUpdate(
        { signature },
        { status: "failed", errorMessage: "Nonce mismatch in transaction memo" }
      );
      throw new Error("Nonce mismatch - transaction does not match request");
    }
    logger.info(`✅ Memo nonce verified: ${nonce}`);
  } catch (error) {
    if (
      error.message.includes("Nonce") ||
      error.message.includes("memo") ||
      error.message.includes("MISSING")
    )
      throw error;
    await TransactionLog.findOneAndUpdate(
      { signature },
      { status: "failed", errorMessage: "Invalid memo format" }
    );
    throw new Error("Invalid memo instruction format");
  }

  // Step 10 — Transaction age check
  if (!transaction.blockTime) {
    await TransactionLog.findOneAndUpdate(
      { signature },
      { status: "failed", errorMessage: "Transaction missing timestamp" }
    );
    throw new Error("Transaction missing timestamp");
  }
  const TX_MAX_AGE = 300000;
  const txAge = Date.now() - transaction.blockTime * 1000;
  if (txAge > TX_MAX_AGE) {
    await TransactionLog.findOneAndUpdate(
      { signature },
      { status: "failed", errorMessage: "Transaction expired" }
    );
    throw new Error("Transaction expired - please create a new transaction");
  }
  logger.info(`✅ Transaction age: ${Math.round(txAge / 1000)}s`);

  // Step 11 — Cache in Redis (best-effort)
  try {
    await redisClient.set(key, "1", "EX", 604800);
    logger.info("✅ Transaction cached in Redis");
  } catch (err) {
    logger.error("⚠️  Redis cache failed (non-blocking):", {
      error: err.message,
    });
  }

  logger.info(`🎉 TRANSACTION VERIFIED SUCCESSFULLY: ${signature}`);
  return transaction;
}

module.exports = { verifyAndValidateTransaction, verifyTransactionWithStatus };
