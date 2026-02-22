/**
 * utils/idempotency.js
 * Redis-backed idempotency locks — prevent duplicate submissions / race conditions.
 */

const logger = require('../logger');
const context = require('../context');

// ─── Metrics ─────────────────────────────────────────────────────────────────

const raceConditionMetrics = {
    totalAttempts:     0,
    totalRetries:      0,
    maxRetriesExceeded: 0,
    idempotencyKeyHits: 0,
    lastResetTime:     Date.now(),
    byHandler:         {},
};

const orphanedPlayerMetrics = {
    totalOrphaned: 0,
    totalRestored: 0,
    lastResetTime: Date.now(),
};

// Log race-condition metrics every 5 minutes
setInterval(() => {
    if (raceConditionMetrics.totalAttempts === 0) return;

    const retryRate = raceConditionMetrics.totalRetries / raceConditionMetrics.totalAttempts;
    logger.info('Race condition metrics:', {
        ...raceConditionMetrics,
        retryRate: `${(retryRate * 100).toFixed(2)}%`,
    });

    if (retryRate > 0.1) {
        logger.warn(`⚠️ High race condition retry rate: ${(retryRate * 100).toFixed(2)}%`);
    }
    if (raceConditionMetrics.maxRetriesExceeded > 0) {
        logger.error(`❌ Max retries exceeded ${raceConditionMetrics.maxRetriesExceeded} times!`);
    }
}, 5 * 60 * 1000);

// ─── Lock helpers ─────────────────────────────────────────────────────────────

/**
 * Atomic SET NX — returns true if this caller is first (lock acquired).
 */
async function acquireIdempotencyLock(key, ttlSeconds = 30) {
    try {
        const result = await context.redisClient.set(key, '1', 'NX', 'EX', ttlSeconds);
        return result === 'OK';
    } catch (error) {
        logger.error('Error acquiring idempotency lock:', { key, error });
        throw error;
    }
}

/**
 * Release a lock early (optional — locks expire automatically via TTL).
 */
async function releaseIdempotencyLock(key) {
    try {
        await context.redisClient.del(key);
    } catch (error) {
        logger.error('Error releasing idempotency lock:', { key, error });
    }
}

module.exports = {
    acquireIdempotencyLock,
    releaseIdempotencyLock,
    raceConditionMetrics,
    orphanedPlayerMetrics,
};