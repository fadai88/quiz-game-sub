const Tournament = require('../models/Tournament');
const User = require('../models/User');
const Subscription = require('../models/Subscription');
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

            // Check if user has a currently-valid premium subscription (real-time endDate check)
            const user = await User.findById(userId);
            const hasActiveSub = await Subscription.hasActiveSubscription(userId);
            if (!hasActiveSub) {
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
     * Atomically validates a claimed match, updates both participants, completes the
     * match, and advances the bracket — all in a single Tournament.save().
     *
     * Returns { action, claimed } where claimed===false means the match was rejected
     * (wrong status or roomId) so the caller must not update external stats.
     */
    async processClaimedMatchResult(tournamentId, matchId, roomId, winnerUserId, loserUserId, winnerScore, loserScore) {
        try {
            const tournament = await Tournament.findById(tournamentId);
            if (!tournament) throw new Error('Tournament not found');
            if (tournament.status !== 'in_progress') return { action: 'match_recorded', claimed: false };

            const currentRound = tournament.rounds[tournament.rounds.length - 1];
            if (!currentRound) return { action: 'match_recorded', claimed: false };

            const match = currentRound.matches.find(m => m.matchId === matchId);
            if (!match) {
                logger.warn(`processClaimedMatchResult: match ${matchId} not found`);
                return { action: 'match_recorded', claimed: false };
            }
            if (match.status !== 'in_progress' || match.roomId !== roomId) {
                logger.warn(`processClaimedMatchResult: match ${matchId} status=${match.status} roomId=${match.roomId} expected ${roomId} — rejected`);
                return { action: 'match_recorded', claimed: false };
            }

            // Verify winner and loser are exactly the two bracket participants
            const p1 = match.player1?.toString();
            const p2 = match.player2?.toString();
            const wId = winnerUserId.toString();
            const lId = loserUserId.toString();
            if (wId === lId || !((wId === p1 && lId === p2) || (wId === p2 && lId === p1))) {
                logger.warn(`processClaimedMatchResult: participant mismatch for match ${matchId} — expected [${p1},${p2}] got [${wId},${lId}]`);
                return { action: 'match_recorded', claimed: false };
            }

            // Update winner participant
            const winnerParticipant = tournament.participants.find(p => p.userId.toString() === winnerUserId.toString());
            if (winnerParticipant) {
                winnerParticipant.score      += winnerScore || 0;
                winnerParticipant.gamesPlayed += 1;
                winnerParticipant.wins        += 1;
            }

            // Update loser participant
            const loserParticipant = tournament.participants.find(p => p.userId.toString() === loserUserId.toString());
            if (loserParticipant) {
                loserParticipant.score      += loserScore || 0;
                loserParticipant.gamesPlayed += 1;
                loserParticipant.losses      += 1;
                if (tournament.format === 'single_elimination') {
                    loserParticipant.status = 'eliminated';
                    logger.info(`Player ${loserUserId} eliminated from tournament ${tournamentId}`);
                }
            }

            // Complete the match
            match.winner = winnerUserId;
            match.status = 'completed';
            await tournament.save();

            // Check for round / tournament completion
            const activePlayers = tournament.participants.filter(p => p.status === 'active');
            logger.info(`Tournament ${tournamentId}: ${activePlayers.length} active players remaining`);

            if (activePlayers.length <= 1) {
                logger.info(`Tournament ${tournamentId}: final match done, completing tournament`);
                await this.completeTournament(tournamentId);
                return { action: 'tournament_complete', claimed: true };
            }

            const pendingMatchesInRound = currentRound.matches.filter(m => m.status !== 'completed').length;
            if (pendingMatchesInRound === 0) {
                const nextRoundNumber = (currentRound.roundNumber ?? 0) + 1;
                logger.info(`Tournament ${tournamentId}: round ${currentRound.roundNumber} complete, generating round ${nextRoundNumber}`);
                const freshTournament = await Tournament.findById(tournamentId);
                await this._generateRoundMatchups(freshTournament, nextRoundNumber);
                return { action: 'round_advanced', claimed: true };
            }

            return { action: 'match_recorded', claimed: true };

        } catch (error) {
            logger.error('Failed to process claimed match result:', error);
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

            // Sort participants by wins then score (include eliminated players for prize distribution)
            const sortedParticipants = tournament.participants
                .filter(p => p.status === 'active' || p.status === 'eliminated')
                .sort((a, b) => {
                    if (b.wins !== a.wins) return b.wins - a.wins;
                    return b.score - a.score;
                });

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