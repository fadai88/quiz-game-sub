        const TOURNAMENTS_API = '/api/tournaments';
        const SUBSCRIPTION_API = '/api/subscription';
        
        let userSubscription = null;
        let hasPremium = false;

        async function checkSubscription() {
            try {
                const response = await fetch(`${SUBSCRIPTION_API}/status`, {
                    credentials: 'include'
                });

                if (!response.ok) return;

                const data = await response.json();
                if (data.success) {
                    userSubscription = data;
                    hasPremium = data.tier === 'premium' && data.status === 'active';
                }
            } catch (error) {
                console.error('Error checking subscription:', error);
            }
        }

        async function loadTournaments() {
            if (!hasPremium) {
                document.getElementById('premiumBanner').style.display = 'block';
                document.getElementById('activeTournamentsSection').style.display = 'none';
                document.getElementById('upcomingTournamentsSection').style.display = 'none';
                document.getElementById('myTournamentsSection').style.display = 'none';
                return;
            }

            try {
                // Load active tournaments
                const activeResponse = await fetch(`${TOURNAMENTS_API}/active`, {
                    credentials: 'include'
                });
                const activeData = await activeResponse.json();
                if (activeData.success) {
                    renderTournaments(activeData.tournaments, 'activeTournaments');
                }

                // Load upcoming tournaments
                const upcomingResponse = await fetch(`${TOURNAMENTS_API}/upcoming`, {
                    credentials: 'include'
                });
                const upcomingData = await upcomingResponse.json();
                if (upcomingData.success) {
                    renderTournaments(upcomingData.tournaments, 'upcomingTournaments');
                }

                // Load user's tournament history
                const myResponse = await fetch(`${TOURNAMENTS_API}/my-history`, {
                    credentials: 'include'
                });
                const myData = await myResponse.json();
                if (myData.success) {
                    renderTournaments(myData.tournaments, 'myTournaments', true);
                }

            } catch (error) {
                console.error('Error loading tournaments:', error);
            }
        }

        function renderTournaments(tournaments, containerId, isHistory = false) {
            const container = document.getElementById(containerId);
            
            if (!tournaments || tournaments.length === 0) {
                container.innerHTML = '<div class="no-tournaments">No tournaments available</div>';
                return;
            }

            container.innerHTML = tournaments.map(tournament => {
                const isRegistered = tournament.participants?.some(p => p.userId === userSubscription?.userId);
                const isFull = tournament.participants?.length >= tournament.maxPlayers;
                const startTime = new Date(tournament.startTime);
                const regDeadline = new Date(tournament.registrationDeadline);
                const now = new Date();

                return `
                    <div class="tournament-card">
                        <div class="tournament-header">
                            <div>
                                <div class="tournament-title">${tournament.name}</div>
                                <p style="color: #94a3b8; font-size: 14px;">${tournament.description || ''}</p>
                            </div>
                            <div class="tournament-badge badge-${tournament.status}">
                                ${tournament.status.toUpperCase().replace('_', ' ')}
                            </div>
                        </div>

                        ${tournament.prizePool?.total > 0 ? `
                            <div class="prize-pool">
                                <div style="font-size: 14px; opacity: 0.9;">Prize Pool</div>
                                <div class="prize-amount">${tournament.prizePool.total} ${tournament.prizePool.currency}</div>
                            </div>
                        ` : ''}

                        <div class="participants-count">
                            ${tournament.participants?.length || 0} / ${tournament.maxPlayers} Players
                        </div>

                        <div class="tournament-info">
                            <div class="info-row">
                                <span class="info-label">Start Time</span>
                                <span class="info-value">${startTime.toLocaleString()}</span>
                            </div>
                            <div class="info-row">
                                <span class="info-label">Format</span>
                                <span class="info-value">${tournament.format?.replace('_', ' ')}</span>
                            </div>
                            <div class="info-row">
                                <span class="info-label">Questions</span>
                                <span class="info-value">${tournament.rules?.questionsPerGame || 10} per game</span>
                            </div>
                        </div>

                        ${!isHistory && now < startTime ? `
                            <div class="countdown" id="countdown-${tournament._id}">
                                Starting in: <span class="countdown-value"></span>
                            </div>
                        ` : ''}

                        <div class="tournament-actions">
                            ${getTournamentAction(tournament, isRegistered, isFull, now, regDeadline, isHistory)}
                        </div>
                    </div>
                `;
            }).join('');

            // Start countdowns
            tournaments.forEach(tournament => {
                if (!isHistory && new Date() < new Date(tournament.startTime)) {
                    startCountdown(tournament._id, new Date(tournament.startTime));
                }
            });
        }

        function getTournamentAction(tournament, isRegistered, isFull, now, regDeadline, isHistory) {
            if (isHistory) {
                const userParticipant = tournament.participants?.find(p => p.userId === userSubscription?.userId);
                const winner = tournament.winners?.find(w => w.userId === userSubscription?.userId);
                
                if (winner) {
                    return `<button class="action-btn" disabled>🏆 Position ${winner.position} - Won ${winner.prizeAmount} USDC</button>`;
                }
                return `<button class="action-btn" disabled>Score: ${userParticipant?.score || 0}</button>`;
            }

            if (tournament.status === 'registration') {
                if (now > regDeadline) {
                    return `<button class="action-btn" disabled>Registration Closed</button>`;
                }
                if (isRegistered) {
                    return `<button class="action-btn unregister-btn" onclick="unregisterFromTournament('${tournament._id}')">Unregister</button>`;
                }
                if (isFull) {
                    return `<button class="action-btn" disabled>Tournament Full</button>`;
                }
                return `<button class="action-btn register-btn" onclick="registerForTournament('${tournament._id}')">Register Now</button>`;
            }

            if (tournament.status === 'in_progress' && isRegistered) {
                return `<button class="action-btn join-btn" onclick="joinTournament('${tournament._id}')">Join Now</button>`;
            }

            if (tournament.status === 'completed') {
                return `<button class="action-btn" disabled>Completed</button>`;
            }

            return `<button class="action-btn" disabled>${tournament.status}</button>`;
        }

        function startCountdown(tournamentId, startTime) {
            const countdownElement = document.getElementById(`countdown-${tournamentId}`);
            if (!countdownElement) return;

            const valueElement = countdownElement.querySelector('.countdown-value');

            const updateCountdown = () => {
                const now = new Date();
                const diff = startTime - now;

                if (diff <= 0) {
                    valueElement.textContent = 'Starting now!';
                    return;
                }

                const days = Math.floor(diff / (1000 * 60 * 60 * 24));
                const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
                const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
                const seconds = Math.floor((diff % (1000 * 60)) / 1000);

                valueElement.textContent = `${days}d ${hours}h ${minutes}m ${seconds}s`;
            };

            updateCountdown();
            setInterval(updateCountdown, 1000);
        }

        async function registerForTournament(tournamentId) {
            try {
                const response = await fetch(`${TOURNAMENTS_API}/${tournamentId}/register`, {
                    method: 'POST',
                    credentials: 'include'
                });

                const data = await response.json();
                
                if (data.success) {
                    alert('Successfully registered for tournament!');
                    loadTournaments();
                } else {
                    alert(data.error || 'Failed to register');
                }
            } catch (error) {
                console.error('Registration error:', error);
                alert('Failed to register for tournament');
            }
        }

        async function unregisterFromTournament(tournamentId) {
            if (!confirm('Are you sure you want to unregister from this tournament?')) {
                return;
            }

            try {
                const response = await fetch(`${TOURNAMENTS_API}/${tournamentId}/unregister`, {
                    method: 'POST',
                    credentials: 'include'
                });

                const data = await response.json();
                
                if (data.success) {
                    alert('Successfully unregistered from tournament');
                    loadTournaments();
                } else {
                    alert(data.error || 'Failed to unregister');
                }
            } catch (error) {
                console.error('Unregistration error:', error);
                alert('Failed to unregister from tournament');
            }
        }

        function joinTournament(tournamentId) {
            // Redirect to game page with tournament ID
            window.location.href = `/game.html?tournament=${tournamentId}`;
        }

        // Initialize
        (async function() {
            await checkSubscription();
            await loadTournaments();
        })();
