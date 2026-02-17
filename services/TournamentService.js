const Tournament = require('../models/Tournament');
const User = require('../models/User');
const PaymentQueue = require('../models/PaymentQueue');
const logger = require('../logger');
const { v4: uuidv4 } = require('uuid');

class TournamentService {
    constructor(config) {
        this.config = config;
    }

    /**
     * Create a new tournament
     */
    async createTournament(tournamentData) {
        try {
            const tournament = await Tournament.create({
                name: tournamentData.name,
                description: tournamentData.description || '',
                type: tournamentData.type || 'scheduled',
                format: tournamentData.format || 'single_elimination',
                startTime: tournamentData.startTime,
                registrationDeadline: tournamentData.registrationDeadline,
                minPlayers: tournamentData.minPlayers || 4,
                maxPlayers: tournamentData.maxPlayers || 100,
                entryFee: tournamentData.entryFee || 0,
                prizePool: {
                    total: tournamentData.prizePool || 0,
                    currency: tournamentData.currency || 'USDC',
                    distribution: tournamentData.prizeDistribution || this._getDefaultPrizeDistribution()
                },
                rules: {
                    questionsPerGame: tournamentData.questionsPerGame || 10,
                    timePerQuestion: tournamentData.timePerQuestion || 15,
                    categories: tournamentData.categories || []
                },
                status: 'registration'
            });

            logger.info(`✅ Tournament created: ${tournament._id} - ${tournament.name}`);
            return tournament;

        } catch (error) {
            logger.error('Failed to create tournament:', error);
            throw error;
        }
    }

    /**
     * Register user for tournament
     */
    async registerForTournament(tournamentId, userId, walletAddress, username) {
        try {
            const tournament = await Tournament.findById(tournamentId);
            if (!tournament) {
                throw new Error('Tournament not found');
            }

            // Check if user has premium access
            const user = await User.findById(userId);
            if (!user.hasPremiumAccess()) {
                throw new Error('Premium subscription required to join tournaments');
            }

            // Check registration deadline
            if (new Date() > tournament.registrationDeadline) {
                throw new Error('Registration deadline has passed');
            }

            // Check if tournament is full
            if (tournament.participants.length >= tournament.maxPlayers) {
                throw new Error('Tournament is full');
            }

            // Check if user already registered
            if (tournament.participants.some(p => p.userId.toString() === userId.toString())) {
                throw new Error('Already registered for this tournament');
            }

            // Add participant
            await tournament.addParticipant(userId, walletAddress, username);

            logger.info(`✅ User ${userId} registered for tournament ${tournamentId}`);
            
            return tournament;

        } catch (error) {
            logger.error('Failed to register for tournament:', error);
            throw error;
        }
    }

    /**
     * Unregister user from tournament
     */
    async unregisterFromTournament(tournamentId, userId) {
        try {
            const tournament = await Tournament.findById(tournamentId);
            if (!tournament) {
                throw new Error('Tournament not found');
            }

            if (tournament.status !== 'registration') {
                throw new Error('Cannot unregister after tournament has started');
            }

            await tournament.removeParticipant(userId);

            logger.info(`✅ User ${userId} unregistered from tournament ${tournamentId}`);
            
            return tournament;

        } catch (error) {
            logger.error('Failed to unregister from tournament:', error);
            throw error;
        }
    }

    /**
     * Start tournament
     */
    async startTournament(tournamentId) {
        try {
            const tournament = await Tournament.findById(tournamentId);
            if (!tournament) {
                throw new Error('Tournament not found');
            }

            if (tournament.participants.length < tournament.minPlayers) {
                throw new Error(`Not enough participants. Minimum: ${tournament.minPlayers}, Current: ${tournament.participants.length}`);
            }

            await tournament.start();

            // Generate first round matchups
            await this._generateRoundMatchups(tournament, 1);

            logger.info(`✅ Tournament started: ${tournamentId}`);
            
            return tournament;

        } catch (error) {
            logger.error('Failed to start tournament:', error);
            throw error;
        }
    }

    /**
     * Update player score in tournament
     */
    async updatePlayerScore(tournamentId, userId, scoreIncrement, gameResult) {
        try {
            const tournament = await Tournament.findById(tournamentId);
            if (!tournament) {
                throw new Error('Tournament not found');
            }

            const participant = tournament.participants.find(
                p => p.userId.toString() === userId.toString()
            );

            if (!participant) {
                throw new Error('Participant not found in tournament');
            }

            participant.score += scoreIncrement;
            participant.gamesPlayed += 1;
            
            if (gameResult === 'win') {
                participant.wins += 1;
            } else if (gameResult === 'loss') {
                participant.losses += 1;
            }

            await tournament.save();

            logger.info(`Updated score for ${userId} in tournament ${tournamentId}: +${scoreIncrement}`);

            return tournament;

        } catch (error) {
            logger.error('Failed to update player score:', error);
            throw error;
        }
    }

    /**
     * Complete tournament and distribute prizes
     */
    async completeTournament(tournamentId) {
        try {
            const tournament = await Tournament.findById(tournamentId);
            if (!tournament) {
                throw new Error('Tournament not found');
            }

            // Sort participants by score
            const sortedParticipants = tournament.participants
                .filter(p => p.status === 'active')
                .sort((a, b) => b.score - a.score);

            // Determine winners based on prize distribution
            const winners = [];
            for (let i = 0; i < tournament.prizePool.distribution.length; i++) {
                const prize = tournament.prizePool.distribution[i];
                const participant = sortedParticipants[i];
                
                if (participant) {
                    const prizeAmount = (tournament.prizePool.total * prize.percentage) / 100;
                    
                    winners.push({
                        position: prize.position,
                        userId: participant.userId,
                        walletAddress: participant.walletAddress,
                        username: participant.username,
                        prizeAmount
                    });

                    // Queue payment
                    await PaymentQueue.queuePayment(
                        participant.walletAddress,
                        prizeAmount,
                        `tournament_${tournamentId}_prize_${prize.position}`,
                        0, // No bet amount for tournaments
                        {
                            tournamentId,
                            position: prize.position,
                            type: 'tournament_prize'
                        }
                    );

                    // Update user stats
                    await User.findByIdAndUpdate(participant.userId, {
                        $inc: {
                            tournamentWins: prize.position === 1 ? 1 : 0,
                            totalTournamentPrizes: prizeAmount
                        }
                    });
                }
            }

            tournament.winners = winners;
            await tournament.complete();

            logger.info(`✅ Tournament completed: ${tournamentId}, Winners: ${winners.length}`);

            return tournament;

        } catch (error) {
            logger.error('Failed to complete tournament:', error);
            throw error;
        }
    }

    /**
     * Get active tournaments
     */
    async getActiveTournaments() {
        return await Tournament.getActiveTournaments();
    }

    /**
     * Get upcoming tournaments
     */
    async getUpcomingTournaments() {
        return await Tournament.getUpcomingTournaments();
    }

    /**
     * Get a single tournament by ID
     */
    async getTournament(tournamentId) {
        const tournament = await Tournament.findById(tournamentId);
        if (!tournament) {
            throw new Error(`Tournament not found: ${tournamentId}`);
        }
        return tournament;
    }

    /**
     * Start all scheduled tournaments whose startTime has passed
     * Called by the cron job every 5 minutes
     */
    async startScheduledTournaments() {
        const now = new Date();
        // Look back 10 minutes to catch any tournaments we may have missed
        const tenMinutesAgo = new Date(now - 10 * 60 * 1000);

        const tournamentsToStart = await Tournament.find({
            status: 'registration',
            startTime: { $lte: now, $gte: tenMinutesAgo }
        });

        const started = [];

        for (const tournament of tournamentsToStart) {
            try {
                if (tournament.participants.length >= tournament.minPlayers) {
                    const updated = await this.startTournament(tournament._id);
                    started.push(updated);
                    logger.info(`✅ Auto-started tournament: ${tournament._id} - ${tournament.name}`);
                } else {
                    logger.info(
                        `⏸ Tournament ${tournament._id} not started — only ` +
                        `${tournament.participants.length}/${tournament.minPlayers} players registered`
                    );
                }
            } catch (error) {
                logger.error(`Failed to auto-start tournament ${tournament._id}:`, error);
            }
        }

        return started;
    }

    /**
     * Get user's tournament history
     */
    async getUserTournaments(userId) {
        return await Tournament.find({
            'participants.userId': userId
        }).sort({ startTime: -1 }).limit(20);
    }

    /**
     * Generate matchups for a tournament round
     */
    async _generateRoundMatchups(tournament, roundNumber) {
        try {
            const activePlayers = tournament.participants.filter(p => p.status === 'active');
            
            // Shuffle players for random matchmaking
            const shuffled = [...activePlayers].sort(() => Math.random() - 0.5);
            
            const matches = [];
            for (let i = 0; i < shuffled.length; i += 2) {
                if (i + 1 < shuffled.length) {
                    matches.push({
                        matchId: uuidv4(),
                        player1: shuffled[i].userId,
                        player2: shuffled[i + 1].userId,
                        status: 'pending'
                    });
                }
            }

            tournament.rounds.push({
                roundNumber,
                startTime: new Date(),
                matches
            });

            await tournament.save();

            logger.info(`Generated ${matches.length} matches for round ${roundNumber} of tournament ${tournament._id}`);

        } catch (error) {
            logger.error('Failed to generate round matchups:', error);
            throw error;
        }
    }

    /**
     * Default prize distribution (Top 3)
     */
    _getDefaultPrizeDistribution() {
        return [
            { position: 1, percentage: 50 },  // 1st place: 50%
            { position: 2, percentage: 30 },  // 2nd place: 30%
            { position: 3, percentage: 20 }   // 3rd place: 20%
        ];
    }
}

module.exports = TournamentService;