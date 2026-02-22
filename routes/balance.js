/**
 * routes/balance.js
 * Balance check, virtual balance, payment status, leaderboard, and honeypot routes.
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const router  = express.Router();
const { PublicKey } = require('@solana/web3.js');
const logger  = require('../logger');
const context = require('../context');
const User    = require('../models/User');
const PaymentQueue = require('../models/PaymentQueue');
const { walletParamSchema, paymentIdParamSchema } = require('../config/schemas');
const { authenticate }       = require('../middleware/authenticate');
const { SecurityLogger }     = require('../utils/securityLogger');
const { trackValidationFailure } = require('../config/alerts');

// ─── GET /api/balance/:walletAddress (authenticated) ─────────────────────────

router.get('/balance/:walletAddress', authenticate, async (req, res) => {
    try {
        const { walletAddress } = req.params;
        if (!walletAddress || walletAddress.length < 32 || walletAddress.length > 44) {
            SecurityLogger.log('balance_check_invalid_address', { ip: req.ip, address: walletAddress });
            return res.status(400).json({ error: 'Invalid wallet address' });
        }

        // Ensure the authenticated user can only check their own balance
        if (req.user.walletAddress !== walletAddress) {
            SecurityLogger.log('balance_check_unauthorized', { ip: req.ip, requestedWallet: walletAddress, sessionWallet: req.user.walletAddress });
            return res.status(403).json({ error: 'Unauthorized' });
        }

        const cfg = context.config;
        const publicKey = new PublicKey(walletAddress);
        const tokenAccounts = await cfg.connection.getTokenAccountsByOwner(publicKey, { mint: cfg.USDC_MINT });
        let balance = 0;
        if (tokenAccounts.value.length > 0) {
            const info = await cfg.connection.getTokenAccountBalance(tokenAccounts.value[0].pubkey);
            balance = parseFloat(info.value.amount) / 1_000_000;
        }

        logger.info('[BALANCE] Balance checked:', { wallet: walletAddress, balance });
        res.json({ balance: balance.toFixed(6), walletAddress });
    } catch (error) {
        logger.error('[BALANCE] Error fetching balance:', { error: error.message, wallet: req.params.walletAddress });
        res.status(500).json({ error: 'Failed to fetch balance' });
    }
});

// ─── GET /api/public-balance/:walletAddress (rate-limited, unauthenticated) ──

router.get('/public-balance/:walletAddress', async (req, res) => {
    try {
        const { walletAddress } = req.params;
        if (!walletAddress || walletAddress.length < 32 || walletAddress.length > 44) {
            return res.status(400).json({ error: 'Invalid wallet address' });
        }

        const ip = req.ip || req.connection.remoteAddress;
        const rateLimitKey = `balance-check:${ip}`;
        const requestCount = await context.redisClient.incr(rateLimitKey);
        if (requestCount === 1) await context.redisClient.expire(rateLimitKey, 60);
        if (requestCount > 10) {
            SecurityLogger.log('balance_check_rate_limit', { ip, wallet: walletAddress });
            return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
        }

        const cfg = context.config;
        const publicKey = new PublicKey(walletAddress);
        const tokenAccounts = await cfg.connection.getTokenAccountsByOwner(publicKey, { mint: cfg.USDC_MINT });
        let balance = 0;
        if (tokenAccounts.value.length > 0) {
            const info = await cfg.connection.getTokenAccountBalance(tokenAccounts.value[0].pubkey);
            balance = parseFloat(info.value.amount) / 1_000_000;
        }
        res.json({ balance: balance.toFixed(6), walletAddress });
    } catch (error) {
        logger.error('[PUBLIC-BALANCE] Error:', { error: error.message, wallet: req.params.walletAddress });
        res.status(500).json({ error: 'Failed to fetch balance' });
    }
});

// ─── GET /api/virtual-balance/:wallet ────────────────────────────────────────

router.get('/virtual-balance/:wallet', async (req, res) => {
    try {
        const { error, value } = walletParamSchema.validate(req.params, { abortEarly: false, stripUnknown: true });
        if (error) {
            trackValidationFailure(req.ip, 'virtual_balance', error.details.map(d => d.message).join('; '));
            return res.status(400).json({ success: false, error: 'Invalid wallet address' });
        }
        const user = await User.findOne({ walletAddress: value.wallet });
        res.json({ balance: user?.virtualBalance || 0 });
    } catch (error) {
        logger.error('Error fetching virtual balance:', error);
        res.status(500).json({ error: 'Server error', balance: 0 });
    }
});

// ─── GET /api/payment/:paymentId ─────────────────────────────────────────────

router.get('/payment/:paymentId', async (req, res) => {
    try {
        const { error, value } = paymentIdParamSchema.validate(req.params, { abortEarly: false, stripUnknown: true });
        if (error) {
            trackValidationFailure(req.ip, 'payment', error.details.map(d => d.message).join('; '));
            return res.status(400).json({ success: false, error: 'Invalid payment ID' });
        }
        const payment = await PaymentQueue.findById(value.paymentId);
        if (!payment) return res.status(404).json({ error: 'Payment not found' });
        res.json({ paymentId: payment._id, status: payment.status, amount: payment.amount, transactionSignature: payment.transactionSignature, errorMessage: payment.errorMessage });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── GET /api/leaderboard ─────────────────────────────────────────────────────

router.get('/leaderboard', async (req, res) => {
    try {
        const leaderboard = await User.find({})
            .select('walletAddress gamesPlayed totalWinnings wins correctAnswers')
            .sort({ totalWinnings: -1 }).limit(20).lean();
        res.json(leaderboard.map(u => ({
            username:       u.walletAddress,
            correctAnswers: u.correctAnswers || 0,
            gamesPlayed:    u.gamesPlayed    || 0,
            totalPoints:    u.correctAnswers || 0,
            wins:           u.wins           || 0,
            totalWinnings:  u.totalWinnings  || 0,
        })));
    } catch (error) {
        logger.error('Error fetching leaderboard:', { error });
        res.status(500).json({ error: 'Failed to fetch leaderboard' });
    }
});

// ─── GET /api/tokens.json (honeypot) ─────────────────────────────────────────

router.get('/tokens.json', async (req, res) => {
    const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    logger.warn(`Potential bot detected accessing honeypot: ${clientIP}`);
    await context.redisClient.set(`blocklist:${clientIP}`, 1, 'EX', 86400);
    res.json({ status: 'success', data: { tokens: [] } });
});

// ─── GET /api/config ──────────────────────────────────────────────────────────

router.get('/config', (req, res) => {
    try {
        res.json({ recaptchaEnabled: process.env.ENABLE_RECAPTCHA === 'true', recaptchaSiteKey: process.env.RECAPTCHA_SITE_KEY || '' });
    } catch (error) {
        logger.error('[CONFIG] Error serving config:', { error });
        res.status(500).json({ error: 'Failed to load configuration' });
    }
});

module.exports = router;