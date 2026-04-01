'use strict';

/**
 * utils/challengeStore.js
 *
 * Server-side login challenge management (H3 fix).
 *
 * Flow:
 *   1. issueChallenge(walletAddress)  — generates a nonce, stores it in Redis
 *                                       with a short TTL, returns { nonce, issuedAt }.
 *   2. buildMessage(nonce, issuedAt)  — deterministically reconstructs the exact
 *                                       string the client must sign.  Called on
 *                                       both sides so the message is never
 *                                       transmitted — the server always rebuilds it.
 *   3. consumeChallenge(walletAddress, nonce) — looks up the stored challenge,
 *                                       validates nonce + age, deletes it (single-use),
 *                                       and returns the canonical message to verify
 *                                       the signature against.
 *
 * Security properties:
 *   - Nonce is server-generated (crypto.randomUUID) — not guessable.
 *   - TTL = CHALLENGE_TTL_SECONDS (default 120s) — captures cannot be replayed later.
 *   - Single-use: Redis key is deleted on first valid consumption.
 *   - One active challenge per wallet: issuing a new one overwrites the old one,
 *     preventing challenge-flood attacks.
 *   - Message template is fixed on the server — the client never dictates what
 *     was signed.
 */

const crypto  = require('crypto');
const context = require('../context');
const logger  = require('../logger');

const CHALLENGE_TTL_SECONDS = 120; // 2 minutes
const CHALLENGE_KEY_PREFIX  = 'challenge:';

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate and store a new challenge for a wallet address.
 * Overwrites any existing challenge for the same wallet (one active at a time).
 *
 * @param {string} walletAddress
 * @returns {{ nonce: string, issuedAt: number }}
 */
async function issueChallenge(walletAddress) {
    const nonce     = crypto.randomUUID();
    const issuedAt  = Date.now();
    const key       = _key(walletAddress);
    const payload   = JSON.stringify({ nonce, issuedAt });

    await context.redisClient.set(key, payload, 'EX', CHALLENGE_TTL_SECONDS);

    logger.info(`[CHALLENGE] Issued for ${_short(walletAddress)}: nonce=${nonce.slice(0, 8)}…`);
    return { nonce, issuedAt };
}

/**
 * Build the canonical message the client must sign.
 * Must produce identical output on client (JS) and server (Node) — keep it simple.
 *
 * @param {string} nonce
 * @param {number} issuedAt  — ms epoch from issueChallenge
 * @returns {string}
 */
function buildMessage(nonce, issuedAt) {
    return `Sign in to Proof of Smart\nNonce: ${nonce}\nIssued: ${issuedAt}`;
}

/**
 * Validate and consume a challenge.
 * Throws a descriptive Error on any failure — callers should catch and emit
 * loginFailure to the socket.
 *
 * @param {string} walletAddress
 * @param {string} clientNonce   — nonce the client claims it received
 * @returns {string}             — canonical message to verify the signature against
 */
async function consumeChallenge(walletAddress, clientNonce) {
    const key     = _key(walletAddress);
    const raw     = await context.redisClient.get(key);

    if (!raw) {
        logger.warn(`[CHALLENGE] No active challenge for ${_short(walletAddress)}`);
        throw new Error('No active challenge — please request a new one');
    }

    let stored;
    try {
        stored = JSON.parse(raw);
    } catch {
        await context.redisClient.del(key);
        throw new Error('Malformed challenge — please request a new one');
    }

    const { nonce: storedNonce, issuedAt } = stored;

    // Constant-time comparison to prevent timing attacks on the nonce
    const nonceMatches = _safeEqual(storedNonce, clientNonce);

    // Check age even if nonce matched (belt-and-suspenders — Redis TTL is primary)
    const ageMs  = Date.now() - issuedAt;
    const expired = ageMs > CHALLENGE_TTL_SECONDS * 1000;

    // Delete before throwing so a failed attempt can't be retried with the same nonce
    await context.redisClient.del(key);

    if (!nonceMatches) {
        logger.warn(`[CHALLENGE] Nonce mismatch for ${_short(walletAddress)}`);
        throw new Error('Challenge nonce mismatch');
    }

    if (expired) {
        logger.warn(`[CHALLENGE] Expired challenge for ${_short(walletAddress)} (age ${Math.round(ageMs / 1000)}s)`);
        throw new Error('Challenge expired — please request a new one');
    }

    logger.info(`[CHALLENGE] Consumed for ${_short(walletAddress)} (age ${Math.round(ageMs / 1000)}s)`);
    return buildMessage(storedNonce, issuedAt);
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function _key(walletAddress) {
    return `${CHALLENGE_KEY_PREFIX}${walletAddress}`;
}

function _short(walletAddress) {
    return `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`;
}

/**
 * Constant-time string comparison (prevents timing-based nonce enumeration).
 */
function _safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) {
        // Still run a dummy comparison so execution time doesn't leak length
        crypto.timingSafeEqual(Buffer.alloc(1), Buffer.alloc(1));
        return false;
    }
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

module.exports = { issueChallenge, consumeChallenge, buildMessage, CHALLENGE_TTL_SECONDS };