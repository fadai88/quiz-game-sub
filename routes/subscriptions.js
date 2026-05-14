/**
 * routes/subscriptions.js
 */

const express = require('express');
const router  = express.Router();
const logger  = require('../logger');
const context = require('../context');
const User    = require('../models/User');
const Subscription = require('../models/Subscription');
const { authenticate } = require('../middleware/authenticate');
const { subscribeSchema } = require('../config/schemas');

router.get('/prices', (req, res) => {
    try {
        const ss = context.subscriptionService;
        res.json({
            success: true,
            prices: ss ? ss.getPrices() : {
                monthly: parseFloat(process.env.MONTHLY_SUBSCRIPTION_PRICE) || 15,
                yearly:  parseFloat(process.env.YEARLY_SUBSCRIPTION_PRICE)  || 150,
            },
        });
    } catch (error) {
        logger.error('[SUBSCRIPTION] Error fetching prices:', { error: error.message });
        res.status(500).json({ success: false, error: 'Failed to fetch prices' });
    }
});

router.get('/status', authenticate, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        let endDate = null;
        let plan = null;
        let status = user.subscriptionStatus || 'none';
        let tier   = user.accountTier || 'free';

        if (user.subscriptionId) {
            const sub = await Subscription.findById(user.subscriptionId);
            endDate = sub?.endDate || null;
            plan    = sub?.metadata?.plan || null;

            // Real-time expiry check — cron may have missed this if server was down
            if (sub && sub.status === 'active' && endDate && endDate < new Date()) {
                sub.status = 'expired';
                await sub.save();
                await User.findByIdAndUpdate(user._id, { subscriptionStatus: 'expired', accountTier: 'free' });
                status = 'expired';
                tier   = 'free';
                logger.info(`[SUBSCRIPTION] Inline-expired subscription ${sub._id} for user ${user._id}`);
            }
        }

        res.json({ success: true, status, tier, endDate, plan, subscription: user.subscriptionId || null });
    } catch (error) {
        logger.error('[SUBSCRIPTION] Error checking status:', { error: error.message });
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/cancel', authenticate, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user.subscriptionId) return res.status(400).json({ success: false, error: 'No active subscription' });
        if (context.subscriptionService) await context.subscriptionService.cancelSubscription(user.subscriptionId);
        res.json({ success: true, message: 'Subscription cancelled' });
    } catch (error) {
        logger.error('[SUBSCRIPTION] Error cancelling:', { error: error.message });
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/subscribe', authenticate, async (req, res) => {
    try {
        const { error } = subscribeSchema.validate(req.body);
        if (error) return res.status(400).json({ success: false, error: error.details[0].message });

        const { walletAddress, transactionSignature, plan } = req.body;
        if (req.user.walletAddress !== walletAddress) return res.status(403).json({ success: false, error: 'Wallet address mismatch' });

        const user = await User.findOne({ walletAddress });
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });
        if (!context.subscriptionService) return res.status(503).json({ success: false, error: 'Subscription service unavailable' });

        const subscription = await context.subscriptionService.createSubscription(user._id, walletAddress, transactionSignature, plan);
        logger.info('[SUBSCRIPTION] Created via REST:', { walletAddress, plan, transactionSignature });
        res.json({ success: true, subscription: { status: subscription.status, tier: subscription.tier, endDate: subscription.endDate } });
    } catch (error) {
        logger.error('[SUBSCRIPTION] Error creating subscription:', { error: error.message });
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;