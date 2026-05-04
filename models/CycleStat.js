const mongoose = require('mongoose');

const CycleStatSchema = new mongoose.Schema({
    walletAddress: { type: String, required: true },
    cycleId:       { type: mongoose.Schema.Types.ObjectId, ref: 'PrizeCycle', required: true },
    wins:          { type: Number, default: 0 },
    losses:        { type: Number, default: 0 },
    gamesPlayed:   { type: Number, default: 0 },
});

// Upsert key — one document per player per cycle
CycleStatSchema.index({ walletAddress: 1, cycleId: 1 }, { unique: true });
// Leaderboard sort: wins DESC, losses ASC, walletAddress ASC
CycleStatSchema.index({ cycleId: 1, wins: -1, losses: 1, walletAddress: 1 });

module.exports = mongoose.model('CycleStat', CycleStatSchema);
