/**
 * middleware/trustedProxy.js
 *
 * C2 FIX: Safe IP extraction that only honours X-Forwarded-For when the
 * immediate peer (socket.handshake.address or req.socket.remoteAddress) is
 * a known, trusted reverse-proxy IP.
 *
 * WITHOUT this guard any client can send:
 *   X-Forwarded-For: 1.2.3.4
 * and bypass every IP-based rate limit or blocklist.
 *
 * ─── Configuration ────────────────────────────────────────────────────────────
 * Set the TRUSTED_PROXY_IPS environment variable to a comma-separated list of
 * your reverse-proxy addresses (IPv4 or IPv6):
 *
 *   TRUSTED_PROXY_IPS=10.0.0.1,10.0.0.2,::1
 *
 * If the variable is absent, only loopback (127.0.0.1 / ::1) is trusted, which
 * is the correct safe default for local development.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Parse env var once at startup so there is no per-request overhead.
const TRUSTED_PROXY_IPS = (() => {
    const raw = process.env.TRUSTED_PROXY_IPS || '';
    const configured = raw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

    const trusted = new Set([...LOOPBACK, ...configured]);
    return trusted;
})();

/**
 * Extract the real client IP from an Express request.
 *
 * @param {import('http').IncomingMessage} req
 * @returns {string} client IP
 */
function getClientIpFromRequest(req) {
    const peer = req.socket?.remoteAddress || '';
    const normalizedPeer = peer.replace(/^::ffff:/, '');

    if (TRUSTED_PROXY_IPS.has(peer) || TRUSTED_PROXY_IPS.has(normalizedPeer)) {
        const xff = req.headers['x-forwarded-for'];
        if (xff) {
            // XFF is a comma-separated list; the left-most entry is the client.
            const candidate = xff.split(',')[0].trim();
            if (candidate) return candidate;
        }
    }

    // Peer is not a trusted proxy — use the direct connection address.
    return normalizedPeer || peer;
}

/**
 * Extract the real client IP from a Socket.IO handshake.
 *
 * @param {import('socket.io').Socket} socket
 * @returns {string} client IP
 */
function getClientIpFromSocket(socket) {
    const peer = socket.handshake.address || '';
    const normalizedPeer = peer.replace(/^::ffff:/, '');

    if (TRUSTED_PROXY_IPS.has(peer) || TRUSTED_PROXY_IPS.has(normalizedPeer)) {
        const xff = socket.handshake.headers['x-forwarded-for'];
        if (xff) {
            const candidate = xff.split(',')[0].trim();
            if (candidate) return candidate;
        }
    }

    return normalizedPeer || peer;
}

/**
 * Optional Express middleware that attaches req.clientIp for convenience.
 * Mount it early, before any rate-limiting middleware:
 *
 *   const { trustedProxyMiddleware } = require('./middleware/trustedProxy');
 *   app.use(trustedProxyMiddleware);
 */
function trustedProxyMiddleware(req, _res, next) {
    req.clientIp = getClientIpFromRequest(req);
    next();
}

module.exports = {
    getClientIpFromRequest,
    getClientIpFromSocket,
    trustedProxyMiddleware,
    TRUSTED_PROXY_IPS, // exported for tests
};