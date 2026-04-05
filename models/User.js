// Update models/User.js to also fix the email field issue:

const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    username: {
        type: String,
        // Default to a substring of wallet address
        default: function() {
            return this.walletAddress ? this.walletAddress.substring(0, 8) : `user_${Date.now().toString(36)}`;
        }
    },
    walletAddress: {
        type: String,
        required: true,
        unique: true // This should be the unique identifier
    },
    registrationIP: String,
    lastLoginIP: String,
    registrationDate: Date,
    lastLoginDate: Date,
    userAgent: String,
    virtualBalance: {
        type: Number,
        default: 0
    },
    correctAnswers: {
        type: Number,
        default: 0
    },
    gamesPlayed: {
        type: Number,
        default: 0
    },
    wins: {
        type: Number,
        default: 0
    },
    losses: {
        type: Number,
        default: 0
    },
    totalWinnings: {
        type: Number,
        default: 0
    },
    accountTier: {
        type: String,
        enum: ['free', 'premium'],
        default: 'free',
        index: true
    },
    subscriptionStatus: {
        type: String,
        enum: ['none', 'active', 'expired', 'cancelled'],
        default: 'none',
        index: true
    },
    subscriptionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Subscription',
        sparse: true
    },
    practiceGamesPlayed: {
        type: Number,
        default: 0
    },
    tournamentsPlayed: {
        type: Number,
        default: 0
    },
    tournamentWins: {
        type: Number,
        default: 0
    },
    totalTournamentPrizes: {
        type: Number,
        default: 0
    },
    lastActiveCycleId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'PrizeCycle',
        default: null,
        index: true,
    },
    recentQuestions: {
        type: [String],
        default: [],
    },
}, {
    timestamps: true
});

// Check if user has active premium subscription
UserSchema.methods.hasPremiumAccess = function() {
    return this.accountTier === 'premium' && this.subscriptionStatus === 'active';
};

// Check if user can access tournaments
UserSchema.methods.canAccessTournaments = function() {
    return this.hasPremiumAccess();
};

// Check if user is on free tier
UserSchema.methods.isFreeUser = function() {
    return this.accountTier === 'free';
};

const User = mongoose.model('User', UserSchema);
module.exports = User;