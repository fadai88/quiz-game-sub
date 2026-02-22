/**
 * middleware/authenticate.js
 * Session-based HTTP authentication and admin guard.
 */

const logger  = require('../logger');
const context = require('../context');
const User    = require('../models/User');

async function authenticate(req, res, next) {
    try {
        const { sessionToken } = req.signedCookies;
        if (!sessionToken) return res.status(401).json({ success: false, error: 'Not authenticated' });

        const sessionDataStr = await context.redisClient.get(`session:${sessionToken}`);
        if (!sessionDataStr) {
            res.clearCookie('sessionToken');
            return res.status(401).json({ success: false, error: 'Session expired' });
        }

        const sessionData = JSON.parse(sessionDataStr);
        const user        = await User.findOne({ walletAddress: sessionData.walletAddress });
        if (!user) return res.status(401).json({ success: false, error: 'User not found' });

        req.user = { id: user._id, walletAddress: sessionData.walletAddress };
        next();
    } catch (error) {
        logger.error('[AUTH] Middleware error:', { error: error.message });
        res.status(500).json({ success: false, error: 'Authentication error' });
    }
}

function requireAdmin(req, res, next) {
    const ADMIN_WALLETS = (process.env.ADMIN_WALLETS || '').split(',').map(w => w.trim()).filter(Boolean);
    if (!req.user || !ADMIN_WALLETS.includes(req.user.walletAddress)) {
        return res.status(403).json({ success: false, error: 'Admin access required' });
    }
    next();
}

module.exports = { authenticate, requireAdmin };