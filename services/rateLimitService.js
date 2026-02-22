/**
 * services/rateLimitService.js
 * Per-event and per-IP rate limiting helpers used by socket handlers.
 */

const logger = require('../logger');
const context = require('../context');
const { eventLimiters, safeRedisOp } = require('./redisService');

/**
 * Consume one token from the event-specific limiter for both wallet and IP.
 * Throws a descriptive error on exceed; callers should catch and emit to socket.
 */
async function rateLimitEvent(walletAddress, eventName, ip = null, socket = null) {
    const limiter = eventLimiters.get(eventName);
    if (!limiter) {
        logger.warn(`⚠️  No rate limiter configured for event: ${eventName}`);
        return; // fail-open if unconfigured
    }

    const redisClient = context.redisClient;

    try {
        await limiter.consume(walletAddress, 1);

        if (ip) {
            try {
                await limiter.consume(`ip:${ip}`, 1);
            } catch {
                logger.error(`🚨 [RATE LIMIT] IP ${ip} exceeded limit for ${eventName}`);
                await redisClient.set(`blocklist:${ip}`, '1', 'EX', 600);
                if (socket) socket.disconnect(true);
                throw new Error(`Rate limit exceeded for ${eventName}. Please wait before trying again.`);
            }
        }

        logger.info(`✅ [RATE LIMIT] ${eventName} passed for ${walletAddress}`);
    } catch (error) {
        if (error.msBeforeNext !== undefined) {
            const waitSeconds = Math.ceil(error.msBeforeNext / 1000);
            logger.error(`🚨 [RATE LIMIT] ${walletAddress} exceeded limit for ${eventName}, retry in ${waitSeconds}s`);

            const offenderKey = `offender:${walletAddress}:${eventName}`;
            const offenseCount = await redisClient.incr(offenderKey);
            await redisClient.expire(offenderKey, 3600);

            if (offenseCount > 5) {
                logger.error(`🚨 [SECURITY] ${walletAddress} is a repeat offender (${offenseCount} violations)`);
                await redisClient.set(`blocklist:wallet:${walletAddress}`, '1', 'EX', 3600);
                if (socket) {
                    socket.emit('error', { message: 'Account temporarily restricted due to suspicious activity', code: 'RATE_LIMIT_ABUSE' });
                    socket.disconnect(true);
                }
            }

            throw new Error(`Rate limit exceeded for ${eventName}. Please wait ${waitSeconds} seconds.`);
        }
        throw error;
    }
}

/**
 * Increment and check the failed-reCAPTCHA counter for an IP.
 * Throws when the threshold (5/hour) is breached.
 */
async function rateLimitFailedRecaptcha(ip) {
    await safeRedisOp(async () => {
        const key = `recaptcha_fail:${ip}`;
        const attempts = await context.redisClient.get(key) || 0;
        if (parseInt(attempts) >= 5) {
            throw new Error('Too many failed verification attempts. Try again in 1 hour.');
        }
        await context.redisClient.incr(key);
        await context.redisClient.expire(key, 3600);
    }, null, `reCAPTCHA rate limit for ${ip}`);
}

/**
 * Check whether a wallet or IP is in the Redis blocklist.
 * Returns true if blocked.
 */
async function isBlocked(identifier) {
    try {
        const byIp     = await context.redisClient.get(`blocklist:${identifier}`);
        const byWallet = await context.redisClient.get(`blocklist:wallet:${identifier}`);
        return !!(byIp || byWallet);
    } catch {
        return false;
    }
}

module.exports = { rateLimitEvent, rateLimitFailedRecaptcha, isBlocked };