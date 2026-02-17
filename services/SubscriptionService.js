const { Connection, PublicKey } = require('@solana/web3.js');
const Subscription = require('../models/Subscription');
const User = require('../models/User');
const logger = require('../logger');

class SubscriptionService {
    constructor(config) {
        this.connection = new Connection(config.SOLANA_RPC_URL, 'confirmed');
        this.treasuryWallet = new PublicKey(config.TREASURY_WALLET);
        this.usdcMint = new PublicKey(config.USDC_MINT);
        this.subscriptionPrices = {
            monthly: config.MONTHLY_SUBSCRIPTION_PRICE || 15, // $15/month in USDC
            yearly: config.YEARLY_SUBSCRIPTION_PRICE || 150   // $150/year in USDC
        };
    }

    /**
     * Verify subscription payment transaction
     */
    async verifySubscriptionPayment(transactionSignature, walletAddress, expectedAmount) {
        try {
            logger.info(`Verifying subscription payment: ${transactionSignature}`);

            const transaction = await this.connection.getTransaction(transactionSignature, {
                commitment: 'confirmed',
                maxSupportedTransactionVersion: 0
            });

            if (!transaction) {
                throw new Error('Transaction not found');
            }

            // Verify transaction success
            if (transaction.meta.err) {
                throw new Error(`Transaction failed: ${JSON.stringify(transaction.meta.err)}`);
            }

            // Verify the transaction involves the correct wallets and amount
            const { preTokenBalances, postTokenBalances } = transaction.meta;
            
            // Find USDC token changes
            const usdcChanges = this._calculateTokenChanges(preTokenBalances, postTokenBalances);
            
            // Verify payment to treasury
            const paymentToTreasury = usdcChanges.find(change => 
                change.owner === this.treasuryWallet.toString() && 
                change.amount > 0
            );

            if (!paymentToTreasury) {
                throw new Error('No payment to treasury found in transaction');
            }

            // Convert atomic units to USDC (6 decimals)
            const paidAmount = paymentToTreasury.amount / 1e6;

            if (paidAmount < expectedAmount) {
                throw new Error(`Insufficient payment: expected ${expectedAmount} USDC, got ${paidAmount} USDC`);
            }

            logger.info(`✅ Subscription payment verified: ${paidAmount} USDC from ${walletAddress}`);
            
            return {
                verified: true,
                amount: paidAmount,
                transactionSignature,
                timestamp: new Date(transaction.blockTime * 1000)
            };

        } catch (error) {
            logger.error('Subscription payment verification failed:', error);
            throw error;
        }
    }

    /**
     * Create new subscription
     */
    async createSubscription(userId, walletAddress, transactionSignature, plan = 'monthly') {
        try {
            const expectedAmount = this.subscriptionPrices[plan] || this.subscriptionPrices.monthly;
            
            // Verify payment first
            const verification = await this.verifySubscriptionPayment(
                transactionSignature,
                walletAddress,
                expectedAmount
            );

            // Calculate subscription period
            const startDate = new Date();
            const endDate = new Date();
            if (plan === 'yearly') {
                endDate.setFullYear(endDate.getFullYear() + 1);
            } else {
                endDate.setMonth(endDate.getMonth() + 1);
            }

            // Create subscription record
            const subscription = await Subscription.create({
                userId,
                walletAddress,
                status: 'active',
                tier: 'premium',
                amount: verification.amount,
                currency: 'USDC',
                startDate,
                endDate,
                transactionSignature,
                autoRenew: true,
                metadata: {
                    plan,
                    verifiedAt: verification.timestamp
                }
            });

            // Update user account
            await User.findByIdAndUpdate(userId, {
                accountTier: 'premium',
                subscriptionStatus: 'active',
                subscriptionId: subscription._id
            });

            logger.info(`✅ Subscription created for user ${userId}: ${plan}`);

            return subscription;

        } catch (error) {
            logger.error('Failed to create subscription:', error);
            throw error;
        }
    }

    /**
     * Renew existing subscription
     */
    async renewSubscription(subscriptionId, transactionSignature) {
        try {
            const subscription = await Subscription.findById(subscriptionId);
            if (!subscription) {
                throw new Error('Subscription not found');
            }

            // Verify payment
            const verification = await this.verifySubscriptionPayment(
                transactionSignature,
                subscription.walletAddress,
                subscription.amount
            );

            // Renew subscription
            await subscription.renew(transactionSignature);

            // Update user status
            await User.findByIdAndUpdate(subscription.userId, {
                subscriptionStatus: 'active'
            });

            logger.info(`✅ Subscription renewed: ${subscriptionId}`);

            return subscription;

        } catch (error) {
            logger.error('Failed to renew subscription:', error);
            throw error;
        }
    }

    /**
     * Cancel subscription
     */
    async cancelSubscription(subscriptionId) {
        try {
            const subscription = await Subscription.findById(subscriptionId);
            if (!subscription) {
                throw new Error('Subscription not found');
            }

            await subscription.cancel();

            // Note: User keeps premium access until end date
            logger.info(`✅ Subscription cancelled: ${subscriptionId}`);

            return subscription;

        } catch (error) {
            logger.error('Failed to cancel subscription:', error);
            throw error;
        }
    }

    /**
     * Check and expire old subscriptions
     */
    async expireOldSubscriptions() {
        try {
            const expiredSubscriptions = await Subscription.find({
                status: 'active',
                endDate: { $lt: new Date() }
            });

            for (const subscription of expiredSubscriptions) {
                subscription.status = 'expired';
                await subscription.save();

                // Update user status
                await User.findByIdAndUpdate(subscription.userId, {
                    subscriptionStatus: 'expired',
                    accountTier: 'free'
                });

                logger.info(`Expired subscription: ${subscription._id}`);
            }

            return expiredSubscriptions.length;

        } catch (error) {
            logger.error('Failed to expire subscriptions:', error);
            throw error;
        }
    }

    /**
     * Helper: Calculate token balance changes
     */
    _calculateTokenChanges(preBalances, postBalances) {
        const changes = [];
        
        for (const post of postBalances) {
            const pre = preBalances.find(p => p.accountIndex === post.accountIndex);
            if (pre && post.mint === this.usdcMint.toString()) {
                const change = {
                    owner: post.owner,
                    amount: post.uiTokenAmount.amount - pre.uiTokenAmount.amount,
                    mint: post.mint
                };
                if (change.amount !== 0) {
                    changes.push(change);
                }
            }
        }
        
        return changes;
    }

    /**
     * Get subscription prices
     */
    getPrices() {
        return this.subscriptionPrices;
    }
}

module.exports = SubscriptionService;
