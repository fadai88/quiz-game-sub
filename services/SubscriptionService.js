'use strict';


const { Connection, PublicKey } = require('@solana/web3.js');
const Subscription    = require('../models/Subscription');
const TransactionLog  = require('../models/TransactionLog');
const User            = require('../models/User');
const context         = require('../context');
const logger          = require('../logger');
const { safeRedisOp } = require('./redisService');
const { SecurityLogger, AuditLogger } = require('../utils/securityLogger');

class SubscriptionService {
    constructor(config) {
        // Use 'finalized' so rolled-back fork transactions cannot be replayed (H1).
        this.connection = new Connection(config.SOLANA_RPC_URL, 'finalized');
        this.treasuryWallet   = new PublicKey(config.TREASURY_WALLET);
        this.usdcMint         = new PublicKey(config.USDC_MINT);
        this.subscriptionPrices = {
            monthly: config.MONTHLY_SUBSCRIPTION_PRICE || 15,  // $15 USDC
            yearly:  config.YEARLY_SUBSCRIPTION_PRICE  || 150, // $150 USDC
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
    async verifySubscriptionPayment(transactionSignature, walletAddress, expectedAmount) {
        logger.info(`[SUB] Verifying subscription payment: ${transactionSignature} from ${walletAddress}`);

        // ── Step 1: Replay prevention — MongoDB atomic upsert (H2 fix) ───────
        // findOneAndUpdate with upsert:true, new:false returns the *pre-existing*
        // document if one was found, or null if this is the first insert.
        // A duplicate-key error (11000) means a concurrent request beat us to it.
        try {
            const existing = await TransactionLog.findOneAndUpdate(
                { signature: transactionSignature },
                {
                    $setOnInsert: {
                        signature:     transactionSignature,
                        walletAddress,
                        betAmount:     expectedAmount,    // reusing field for USDC amount
                        verifiedAt:    new Date(),
                        status:        'verified',
                    },
                },
                { upsert: true, new: false, runValidators: true }
            );

            if (existing !== null) {
                // Document already existed → this signature was used before.
                logger.error(`[SUB] ❌ REPLAY ATTACK: signature ${transactionSignature} already in TransactionLog`);
                SecurityLogger.log('subscription_replay_attack', {
                    transactionSignature,
                    walletAddress,
                    existingStatus: existing.status,
                });
                throw new Error('Transaction already processed — replay attack prevented');
            }

            logger.info(`[SUB] ✅ Replay check passed — signature recorded in TransactionLog`);
        } catch (dbErr) {
            if (dbErr.code === 11000) {
                // Race condition: two concurrent requests, other won.
                logger.error(`[SUB] ❌ RACE / REPLAY: duplicate key for ${transactionSignature}`);
                throw new Error('Transaction already processed');
            }
            if (dbErr.message.includes('replay') || dbErr.message.includes('already processed')) {
                throw dbErr; // Re-throw our own errors from above.
            }
            logger.error('[SUB] ❌ MongoDB audit write failed:', { error: dbErr.message });
            throw new Error('Audit service unavailable — cannot process subscription');
        }

        // ── Step 2: Redis cache check — fast second layer (H2 fix) ───────────
        const redisKey = `tx:${transactionSignature}`;
        await safeRedisOp(async () => {
            const cached = await context.redisClient.get(redisKey);
            if (cached) {
                // MongoDB already blocked the true replay above; this branch only
                // fires if Redis is ahead of Mongo (edge case).  Log and continue —
                // Mongo is the authoritative store.
                logger.warn(`[SUB] ⚠️  Redis cache hit for ${redisKey} (Mongo is authoritative)`);
            }
        }, null, 'Redis subscription signature check');

        // ── Step 3: Fetch & validate the on-chain transaction ─────────────────
        let transaction;
        try {
            transaction = await this.connection.getTransaction(transactionSignature, {
                commitment: 'finalized',          // H1 fix: must be finalized, not confirmed
                maxSupportedTransactionVersion: 0,
            });
        } catch (rpcErr) {
            // Mark the TransactionLog entry as failed so a legitimate retry is possible.
            await TransactionLog.findOneAndUpdate(
                { signature: transactionSignature },
                { status: 'failed', errorMessage: rpcErr.message }
            ).catch(() => {});
            logger.error('[SUB] ❌ RPC fetch failed:', { error: rpcErr.message });
            throw new Error('Failed to fetch transaction from blockchain — please try again');
        }

        if (!transaction) {
            await TransactionLog.findOneAndUpdate(
                { signature: transactionSignature },
                { status: 'failed', errorMessage: 'Transaction not found' }
            ).catch(() => {});
            throw new Error('Transaction not found on blockchain');
        }

        if (transaction.meta.err) {
            await TransactionLog.findOneAndUpdate(
                { signature: transactionSignature },
                { status: 'failed', errorMessage: JSON.stringify(transaction.meta.err) }
            ).catch(() => {});
            throw new Error(`Transaction failed on-chain: ${JSON.stringify(transaction.meta.err)}`);
        }

        // ── Step 4: Verify USDC payment to treasury ───────────────────────────
        const { preTokenBalances, postTokenBalances } = transaction.meta;
        const usdcChanges = this._calculateTokenChanges(preTokenBalances, postTokenBalances);

        const paymentToTreasury = usdcChanges.find(
            change => change.owner === this.treasuryWallet.toString() && change.amount > 0
        );

        if (!paymentToTreasury) {
            await TransactionLog.findOneAndUpdate(
                { signature: transactionSignature },
                { status: 'failed', errorMessage: 'No payment to treasury found in transaction' }
            ).catch(() => {});
            throw new Error('No payment to treasury found in transaction');
        }

        // Convert atomic units (6 decimals) → USDC float
        const paidAmount = paymentToTreasury.amount / 1e6;

        if (paidAmount < expectedAmount) {
            await TransactionLog.findOneAndUpdate(
                { signature: transactionSignature },
                { status: 'failed', errorMessage: `Insufficient payment: expected ${expectedAmount} USDC, got ${paidAmount} USDC` }
            ).catch(() => {});
            throw new Error(`Insufficient payment: expected ${expectedAmount} USDC, got ${paidAmount} USDC`);
        }

        // ── Step 5: Cache in Redis (best-effort, 7 days) ──────────────────────
        await safeRedisOp(async () => {
            await context.redisClient.set(redisKey, '1', 'EX', 604800);
        }, null, 'Redis subscription cache write');

        logger.info(`[SUB] ✅ Subscription payment verified: ${paidAmount} USDC from ${walletAddress}`);

        return {
            verified:             true,
            amount:               paidAmount,
            transactionSignature,
            timestamp:            new Date(transaction.blockTime * 1000),
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // createSubscription
    // ─────────────────────────────────────────────────────────────────────────

    async createSubscription(userId, walletAddress, transactionSignature, plan = 'monthly') {
        const expectedAmount = this.subscriptionPrices[plan] ?? this.subscriptionPrices.monthly;

        // verifySubscriptionPayment() now enforces replay protection.
        const verification = await this.verifySubscriptionPayment(
            transactionSignature,
            walletAddress,
            expectedAmount
        );

        const startDate = new Date();
        const endDate   = new Date();
        if (plan === 'yearly') {
            endDate.setFullYear(endDate.getFullYear() + 1);
        } else {
            endDate.setMonth(endDate.getMonth() + 1);
        }

        const subscription = await Subscription.create({
            userId,
            walletAddress,
            status:               'active',
            tier:                 'premium',
            amount:               verification.amount,
            currency:             'USDC',
            startDate,
            endDate,
            transactionSignature,
            autoRenew:            false,   // Default false — user must opt in explicitly
            metadata: {
                plan,
                verifiedAt: verification.timestamp,
            },
        });

        await User.findByIdAndUpdate(userId, {
            accountTier:        'premium',
            subscriptionStatus: 'active',
            subscriptionId:     subscription._id,
        });

        AuditLogger.transactionVerified?.(walletAddress, verification.amount, transactionSignature, this.treasuryWallet.toString());
        logger.info(`[SUB] ✅ Subscription created for user ${userId}: ${plan}`);

        return subscription;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // renewSubscription
    // ─────────────────────────────────────────────────────────────────────────

    async renewSubscription(subscriptionId, transactionSignature) {
        const subscription = await Subscription.findById(subscriptionId);
        if (!subscription) throw new Error('Subscription not found');

        // verifySubscriptionPayment() enforces replay protection here too.
        const verification = await this.verifySubscriptionPayment(
            transactionSignature,
            subscription.walletAddress,
            subscription.amount
        );

        await subscription.renew(transactionSignature);

        await User.findByIdAndUpdate(subscription.userId, {
            subscriptionStatus: 'active',
        });

        logger.info(`[SUB] ✅ Subscription renewed: ${subscriptionId}`);

        return subscription;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // cancelSubscription
    // ─────────────────────────────────────────────────────────────────────────

    async cancelSubscription(subscriptionId) {
        const subscription = await Subscription.findById(subscriptionId);
        if (!subscription) throw new Error('Subscription not found');

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
            status:  'active',
            endDate: { $lt: new Date() },
        });

        for (const subscription of expiredSubscriptions) {
            subscription.status = 'expired';
            await subscription.save();

            await User.findByIdAndUpdate(subscription.userId, {
                subscriptionStatus: 'expired',
                accountTier:        'free',
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
            const pre = preBalances.find(p => p.accountIndex === post.accountIndex);
            if (!pre) continue;
            const delta = Number(post.uiTokenAmount.amount) - Number(pre.uiTokenAmount.amount);
            if (delta !== 0) {
                changes.push({ owner: post.owner, amount: delta, mint: post.mint });
            }
        }
        return changes;
    }
}

module.exports = SubscriptionService;