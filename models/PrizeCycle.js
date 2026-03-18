// models/PrizeCycle.js
// Tracks weekly prize cycles. One cycle is "active" at a time.
// At the end of each week an admin (or cron) closes it and opens a new one.

const mongoose = require('mongoose');

const PrizeCycleSchema = new mongoose.Schema({
    label: {
        type: String,
        required: true,
        // e.g. "Week 1 – Mar 10–16 2026"
    },
    status: {
        type: String,
        enum: ['active', 'closed'],
        default: 'active',
        index: true,
    },
    startedAt: {
        type: Date,
        default: Date.now,
    },
    closedAt: {
        type: Date,
    },
    // Prize awards recorded when the cycle is closed
    awards: [{
        walletAddress: String,
        rank:          Number,
        prizeNote:     String,   // e.g. "5.40 USDC" – actual payout happens off-platform
        awardedAt:     { type: Date, default: Date.now },
    }],
}, { timestamps: true });

// ── Static helpers ────────────────────────────────────────────────────────────

/** Returns the current active cycle, creating one if none exists. */
PrizeCycleSchema.statics.getOrCreateActive = async function () {
    let cycle = await this.findOne({ status: 'active' }).sort({ startedAt: -1 });
    if (!cycle) {
        const now   = new Date();
        const label = `Week starting ${now.toDateString()}`;
        cycle = await this.create({ label });
    }
    return cycle;
};

/** Closes the active cycle and opens a new one. Returns both. */
PrizeCycleSchema.statics.rotateWeekly = async function (newLabel, awards = []) {
    const active = await this.findOne({ status: 'active' }).sort({ startedAt: -1 });
    if (active) {
        active.status   = 'closed';
        active.closedAt = new Date();
        if (awards.length) active.awards = awards;
        await active.save();
    }

    const now  = new Date();
    const label = newLabel || `Week starting ${now.toDateString()}`;
    const fresh = await this.create({ label });
    return { closed: active, opened: fresh };
};

const PrizeCycle = mongoose.model('PrizeCycle', PrizeCycleSchema);
module.exports = PrizeCycle;