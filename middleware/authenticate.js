/**
 * middleware/authenticate.js
 * Session-based HTTP authentication and admin guard.
 */

const logger = require("../logger");
const context = require("../context");
const User = require("../models/User");

/**
 * The session token, from either transport:
 *   - browsers send it as a signed HttpOnly cookie
 *   - the native app sends it as `Authorization: Bearer <token>` (no cookie jar)
 * Both resolve to the same raw token and the same `session:<token>` record, so
 * there is still exactly one session model.
 */
function extractSessionToken(req) {
  const header = req.headers?.authorization;
  if (header && header.startsWith("Bearer ")) {
    const bearer = header.slice(7).trim();
    if (bearer) return bearer;
  }
  return req.signedCookies?.sessionToken || null;
}

async function authenticate(req, res, next) {
  try {
    const sessionToken = extractSessionToken(req);
    if (!sessionToken)
      return res
        .status(401)
        .json({ success: false, error: "Not authenticated" });

    const sessionDataStr = await context.redisClient.get(
      `session:${sessionToken}`
    );
    if (!sessionDataStr) {
      res.clearCookie("sessionToken");
      return res.status(401).json({ success: false, error: "Session expired" });
    }

    const sessionData = JSON.parse(sessionDataStr);
    const user = await User.findOne({
      walletAddress: sessionData.walletAddress,
    });
    if (!user)
      return res.status(401).json({ success: false, error: "User not found" });

    // Extend TTL on each use without rotating the token — rotation on every
    // request causes a race condition where the socket auth middleware (which
    // validated the old token at handshake time) sees it deleted mid-flight.
    // Token rotation happens only at login (routes/auth.js).
    await context.redisClient.expire(`session:${sessionToken}`, 86400);
    await context.redisClient.expire(
      `session:wallet:${sessionData.walletAddress}`,
      86400
    );

    req.user = { id: user._id, walletAddress: sessionData.walletAddress };
    // Routes that need to amend the session record itself (e.g. marking it
    // attested) need the token and the current record, not just the identity.
    req.sessionToken = sessionToken;
    req.sessionData = sessionData;
    next();
  } catch (error) {
    logger.error("[AUTH] Middleware error:", { error: error.message });
    res.status(500).json({ success: false, error: "Authentication error" });
  }
}

function requireAdmin(req, res, next) {
  const ADMIN_WALLETS = (process.env.ADMIN_WALLETS || "")
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean);
  if (!req.user || !ADMIN_WALLETS.includes(req.user.walletAddress)) {
    return res
      .status(403)
      .json({ success: false, error: "Admin access required" });
  }
  next();
}

module.exports = { authenticate, requireAdmin, extractSessionToken };
