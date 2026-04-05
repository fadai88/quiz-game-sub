/**
 * middleware/securityHeaders.js
 * OWASP-recommended security headers (CSP, HSTS, X-Frame-Options, etc.).
 */

const crypto = require('crypto');
const { ENVIRONMENT } = require('../config/constants');

function securityHeaders(req, res, next) {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.locals.cspNonce = nonce;

    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const cspDirectives = [
        "default-src 'self'",
        `script-src 'self' 'nonce-${nonce}' https://www.google.com https://www.gstatic.com https://bundle.run https://unpkg.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://static.cloudflareinsights.com`,
        `style-src 'self' 'nonce-${nonce}'`,
        "img-src 'self' data: https:",
        "font-src 'self' data:",
        "connect-src 'self' wss: ws: https://courtnay-0wegdq-fast-mainnet.helius-rpc.com https://devnet.helius-rpc.com https://mainnet.helius-rpc.com https://api.anthropic.com https://unpkg.com https://cdn.jsdelivr.net https://bundle.run https://cdnjs.cloudflare.com https://www.google.com https://www.gstatic.com",
        "frame-src 'self' https://www.google.com https://recaptcha.google.com https://www.recaptcha.net",
        "child-src 'self' https://www.google.com https://recaptcha.google.com",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
    ].join('; ');
    res.setHeader('Content-Security-Policy', cspDirectives);

    const permissionsPolicy = [
        'geolocation=()', 'microphone=()', 'camera=()', 'payment=()',
        'usb=()', 'magnetometer=()', 'accelerometer=()', 'gyroscope=()',
    ].join(', ');
    res.setHeader('Permissions-Policy', permissionsPolicy);

    if (ENVIRONMENT === 'production' && req.secure) {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    }

    next();
}

module.exports = securityHeaders;