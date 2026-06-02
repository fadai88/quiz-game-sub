// models/PrizeCycle.js
// Tracks weekly prize cycles. One cycle is "active" at a time.
// Cycles are aligned to Monday 00:00 UTC boundaries, not rolling 7-day windows.

const mongoose = require("mongoose");

// Formats a Date as "Mon 02 Jun 2026" using UTC fields so the label is the
// same regardless of the server's local timezone.
function formatUTCDate(d) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${days[d.getUTCDay()]} ${String(d.getUTCDate()).padStart(2, "0")} ${
    months[d.getUTCMonth()]
  } ${d.getUTCFullYear()}`;
}

// Returns Monday 00:00:00.000 UTC for the week that contains the current moment.
function getCurrentWeekMonday() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon, …, 6=Sat
  const daysBack = day === 0 ? 6 : day - 1;
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - daysBack,
      0,
      0,
      0,
      0
    )
  );
}

const PrizeCycleSchema = new mongoose.Schema(
  {
    label: {
      type: String,
      required: true,
      // e.g. "Week of Mon Jun 02 2026"
    },
    status: {
      type: String,
      enum: ["active", "closed"],
      default: "active",
    },
    startedAt: {
      type: Date,
      default: Date.now,
    },
    closedAt: {
      type: Date,
    },
    // Prize awards recorded when the cycle is closed
    awards: [
      {
        walletAddress: String,
        rank: Number,
        prizeNote: String, // e.g. "5.40 USDC" — actual payout happens off-platform
        awardedAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

// Ensures at most one document can have status:'active' at a time.
// Closed cycles are excluded by the partial filter so there can be many of them.
// When two concurrent callers both try to create an active cycle, the second
// gets a duplicate-key error (code 11000) and re-fetches the winner.
PrizeCycleSchema.index(
  { status: 1 },
  { unique: true, partialFilterExpression: { status: "active" } }
);

// ── Static helpers ────────────────────────────────────────────────────────────

/**
 * Returns the active cycle for the current calendar week (Mon–Sun UTC).
 *
 * If the stored active cycle started before this week's Monday it is stale.
 * The stale cycle is closed atomically and a new one is opened with
 * startedAt = Monday 00:00 UTC — not the server's startup time.
 *
 * This method is safe to call from both the leaderboard route and the stats
 * writer, so a missed cron cannot cause stats to land in an old cycle.
 */
PrizeCycleSchema.statics.getOrCreateActive = async function () {
  const weekStart = getCurrentWeekMonday();

  // Happy path: a valid cycle for the current week already exists.
  const current = await this.findOne({
    status: "active",
    startedAt: { $gte: weekStart },
  });
  if (current) return current;

  // Stale or missing: only close a cycle that actually predates this week.
  // Filtering by startedAt < weekStart prevents closing a current-week cycle
  // that a concurrent caller just created between our read above and this write.
  await this.findOneAndUpdate(
    { status: "active", startedAt: { $lt: weekStart } },
    { $set: { status: "closed", closedAt: new Date() } },
    { sort: { startedAt: -1 } }
  );

  // Create the new cycle anchored to the real week boundary.
  const label = `Week of ${formatUTCDate(weekStart)}`;
  try {
    return await this.create({ label, startedAt: weekStart });
  } catch (err) {
    if (err.code === 11000) {
      // A concurrent caller won the race — return the current-week cycle they created.
      return await this.findOne({
        status: "active",
        startedAt: { $gte: weekStart },
      });
    }
    throw err;
  }
};

/**
 * Closes the active cycle (optionally recording prize awards) and opens the
 * next one anchored to Monday 00:00 UTC.
 *
 * findOneAndUpdate makes the close step atomic so overlapping cron/admin/startup
 * calls cannot close the same cycle twice.
 */
PrizeCycleSchema.statics.rotateWeekly = async function (newLabel, awards = []) {
  const weekStart = getCurrentWeekMonday();

  const setDoc = { status: "closed", closedAt: new Date() };
  if (awards.length) setDoc.awards = awards;

  // Atomic close — returns the document as it was before the update.
  const closed = await this.findOneAndUpdate(
    { status: "active" },
    { $set: setDoc },
    { sort: { startedAt: -1 }, new: false }
  );

  const label = newLabel || `Week of ${formatUTCDate(weekStart)}`;
  let opened;
  try {
    opened = await this.create({ label, startedAt: weekStart });
  } catch (err) {
    if (err.code === 11000) {
      opened = await this.findOne({ status: "active" });
    } else {
      throw err;
    }
  }
  return { closed, opened };
};

const PrizeCycle = mongoose.model("PrizeCycle", PrizeCycleSchema);
module.exports = PrizeCycle;
