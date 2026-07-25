/**
 * utils/maintenance.js
 *
 * "Drain" / maintenance mode for planned restarts. When enabled, the server
 * stops accepting NEW games so a redeploy interrupts as few in-flight games as
 * possible. In-flight games are unaffected (they finish or get refunded on
 * restart by services/restartRecovery.js).
 *
 * The flag lives in Redis (shared across instances) and is CLEARED on startup —
 * so a fresh instance always comes up accepting games (a completed restart is,
 * by definition, no longer "draining"). Reads fail OPEN: a Redis hiccup must not
 * block games, since restart recovery is the real fund-safety net.
 */

const context = require("../context");

const KEY = "maintenance:draining";

async function setDraining(on) {
  if (!context.redisClient) return;
  if (on) await context.redisClient.set(KEY, "1");
  else await context.redisClient.del(KEY);
}

async function isDraining() {
  try {
    if (!context.redisClient) return false;
    return (await context.redisClient.get(KEY)) === "1";
  } catch {
    return false; // fail open
  }
}

module.exports = { setDraining, isDraining, KEY };
