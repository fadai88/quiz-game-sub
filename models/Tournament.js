const mongoose = require('mongoose');

const TournamentSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    description: {
        type: String,
        default: ''
    },
    status: {
        type: String,
        enum: ['scheduled', 'registration', 'in_progress', 'completed', 'cancelled'],
        default: 'scheduled',
        index: true
    },
    type: {
        type: String,
        enum: ['scheduled', 'on_demand'],
        default: 'scheduled'
    },
    format: {
        type: String,
        enum: ['single_elimination', 'round_robin', 'bracket'],
        default: 'single_elimination'
    },
    startTime: {
        type: Date,
        required: true,
        index: true
    },
    endTime: {
        type: Date
    },
    registrationDeadline: {
        type: Date,
        required: true
    },
    minPlayers: {
        type: Number,
        default: 4,
        min: 2
    },
    maxPlayers: {
        type: Number,
        default: 100,
        min: 2
    },
    entryFee: {
        type: Number,
        default: 0,
        min: 0
    },
    prizePool: {
        total: {
            type: Number,
            default: 0
        },
        currency: {
            type: String,
            enum: ['USDC', 'SOL'],
            default: 'USDC'
        },
        distribution: [{
            position: Number,
            amount: Number,
            percentage: Number
        }]
    },
    participants: [{
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        walletAddress: String,
        username: String,
        joinedAt: Date,
        status: {
            type: String,
            enum: ['registered', 'active', 'eliminated', 'winner'],
            default: 'registered'
        },
        score: {
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
        }
    }],
    rounds: [{
        roundNumber: Number,
        startTime: Date,
        endTime: Date,
        matches: [{
            matchId: String,
            player1: mongoose.Schema.Types.ObjectId,
            player2: mongoose.Schema.Types.ObjectId,
            winner: mongoose.Schema.Types.ObjectId,
            score1: Number,
            score2: Number,
            status: {
                type: String,
                enum: ['pending', 'in_progress', 'completed']
            }
        }]
    }],
    winners: [{
        position: Number,
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        walletAddress: String,
        username: String,
        prizeAmount: Number,
        paidAt: Date,
        transactionSignature: String
    }],
    rules: {
        questionsPerGame: {
            type: Number,
            default: 10
        },
        timePerQuestion: {
            type: Number,
            default: 15
        },
        categories: [String]
    },
    metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    }
}, {
    timestamps: true
});

// Index for finding active tournaments
TournamentSchema.index({ status: 1, startTime: 1 });
TournamentSchema.index({ status: 1, type: 1 });

// Static method to get active tournaments
TournamentSchema.statics.getActiveTournaments = async function() {
    return this.find({
        status: { $in: ['registration', 'in_progress'] },
        startTime: { $gte: new Date() }
    }).sort({ startTime: 1 });
};

// Static method to get upcoming tournaments
TournamentSchema.statics.getUpcomingTournaments = async function() {
    return this.find({
        status: 'scheduled',
        startTime: { $gte: new Date() }
    }).sort({ startTime: 1 }).limit(10);
};

// Method to check if registration is open
TournamentSchema.methods.isRegistrationOpen = function() {
    const now = new Date();
    return this.status === 'registration' && 
           now >= this.registrationDeadline && 
           this.participants.length < this.maxPlayers;
};

// Method to add participant
TournamentSchema.methods.addParticipant = async function(userId, walletAddress, username) {
    if (this.participants.length >= this.maxPlayers) {
        throw new Error('Tournament is full');
    }
    
    if (this.participants.some(p => p.userId.toString() === userId.toString())) {
        throw new Error('User already registered');
    }
    
    this.participants.push({
        userId,
        walletAddress,
        username,
        joinedAt: new Date(),
        status: 'registered'
    });
    
    return await this.save();
};

// Method to remove participant
TournamentSchema.methods.removeParticipant = async function(userId) {
    this.participants = this.participants.filter(
        p => p.userId.toString() !== userId.toString()
    );
    return await this.save();
};

// Method to start tournament
TournamentSchema.methods.start = async function() {
    if (this.participants.length < this.minPlayers) {
        throw new Error('Not enough participants to start tournament');
    }
    
    this.status = 'in_progress';
    this.startTime = new Date();
    
    // Mark all participants as active
    this.participants.forEach(p => {
        p.status = 'active';
    });
    
    return await this.save();
};

// Method to complete tournament
TournamentSchema.methods.complete = async function() {
    this.status = 'completed';
    this.endTime = new Date();
    return await this.save();
};

const Tournament = mongoose.model('Tournament', TournamentSchema);

module.exports = Tournament;
