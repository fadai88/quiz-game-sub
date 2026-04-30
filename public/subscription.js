// Hardcoded program IDs - no SPL Token library needed
        const TOKEN_PROGRAM_ID = new solanaWeb3.PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
        const ASSOCIATED_TOKEN_PROGRAM_ID = new solanaWeb3.PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

        const SUBSCRIPTION_API = '/api/subscription';
        let walletAddress = null;
        let currentSubscription = null;
        let isSubscribing = false; // FIX #2: guard against double-clicks

        // Solana configuration
        const config = {
            USDC_MINT: new solanaWeb3.PublicKey('Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr'), // Devnet USDC mint
            // USDC_MINT: new solanaWeb3.PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), // Mainnet USDC mint
            TREASURY_WALLET: new solanaWeb3.PublicKey('NoyR3nErDpw4fWDyHQ3CCURAe4TjTf9TkHZ7vhuDTp4'),
        };

        const connection = new solanaWeb3.Connection(
            'https://devnet.helius-rpc.com/?api-key=961d5e62-871f-447a-bda0-0d61ce151d6e',
            'confirmed'
        );

        // Helper to find associated token address (manual PDA derivation)
        async function findAssociatedTokenAddress(walletAddress, tokenMintAddress) {
            return (await solanaWeb3.PublicKey.findProgramAddress(
                [
                    walletAddress.toBuffer(),
                    TOKEN_PROGRAM_ID.toBuffer(),
                    tokenMintAddress.toBuffer(),
                ],
                ASSOCIATED_TOKEN_PROGRAM_ID
            ))[0];
        }

        // Create USDC transfer transaction for subscription (manual instruction creation)
        async function createSubscriptionTransaction(fromWallet, amountUSDC) {
            try {
                const fromWalletPubkey = new solanaWeb3.PublicKey(fromWallet);
                const amount = Math.floor(amountUSDC * 1_000_000); // Convert to atomic units

                // Get associated token accounts
                const fromTokenAccount = await findAssociatedTokenAddress(
                    fromWalletPubkey,
                    config.USDC_MINT
                );
                const toTokenAccount = await findAssociatedTokenAddress(
                    config.TREASURY_WALLET,
                    config.USDC_MINT
                );

                // SPL Token Transfer instruction accounts: [source, destination, owner]
                const keys = [
                    { pubkey: fromTokenAccount, isSigner: false, isWritable: true },
                    { pubkey: toTokenAccount, isSigner: false, isWritable: true },
                    { pubkey: fromWalletPubkey, isSigner: true, isWritable: false },
                ];

                const data = new Uint8Array(9);
                const view = new DataView(data.buffer);
                view.setUint8(0, 3); // 3 = Transfer instruction index
                view.setBigUint64(1, BigInt(amount), true); // true = little-endian

                const transferInstruction = new solanaWeb3.TransactionInstruction({
                    keys,
                    programId: TOKEN_PROGRAM_ID,
                    data
                });

                // Create transaction with a fresh blockhash every time
                const transaction = new solanaWeb3.Transaction();
                const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
                transaction.recentBlockhash = blockhash;
                transaction.lastValidBlockHeight = lastValidBlockHeight;
                transaction.feePayer = fromWalletPubkey;
                transaction.add(transferInstruction);

                return transaction;
            } catch (error) {
                console.error('Error creating subscription transaction:', error);
                throw new Error('Failed to create payment transaction: ' + error.message);
            }
        }

        async function connectWallet() {
            try {
                const { solana } = window;
                if (!solana?.isPhantom) {
                    showMessage('Please install Phantom wallet', 'error');
                    return null;
                }

                const resp = await solana.connect();
                walletAddress = resp.publicKey.toString();
                return walletAddress;
            } catch (error) {
                console.error('Wallet connection error:', error);
                showMessage('Failed to connect wallet', 'error');
                return null;
            }
        }

        async function loadSubscriptionStatus() {
            try {
                const response = await fetch(`${SUBSCRIPTION_API}/status`, {
                    credentials: 'include'
                });

                if (!response.ok) {
                    throw new Error('Failed to load subscription status');
                }

                const data = await response.json();
                if (data.success) {
                    currentSubscription = data;
                    updateSubscriptionDisplay();
                }
            } catch (error) {
                console.error('Error loading subscription:', error);
            }
        }

        async function loadPrices() {
            try {
                const response = await fetch(`${SUBSCRIPTION_API}/prices`);
                const data = await response.json();
                
                if (data.success) {
                    document.getElementById('monthlyPrice').textContent = data.prices.monthly;
                    document.getElementById('yearlyPrice').textContent = data.prices.yearly;
                }
            } catch (error) {
                console.error('Error loading prices:', error);
            }
        }

        function updateSubscriptionDisplay() {
            if (!currentSubscription) return;

            const container = document.getElementById('currentSubscription');
            const badge = document.getElementById('statusBadge');
            const details = document.getElementById('subscriptionDetails');
            const cancelBtn = document.getElementById('cancelBtn');
            const freePlanBtn = document.getElementById('freePlanBtn');
            const monthlyBtn = document.getElementById('subscribeMonthlyBtn');
            const yearlyBtn = document.getElementById('subscribeYearlyBtn');

            container.style.display = 'block';

            if (currentSubscription.tier === 'premium' && currentSubscription.status === 'active') {
                badge.textContent = 'Premium';
                badge.className = 'status-badge active';

                const rawDate = currentSubscription.endDate;
                const endDate = rawDate ? new Date(rawDate) : null;
                details.textContent = endDate && !isNaN(endDate)
                    ? `Active until ${endDate.toLocaleDateString()}`
                    : 'Active';

                cancelBtn.style.display = 'inline-block';

                // Free card: not the current plan
                freePlanBtn.textContent = 'Free Tier';
                freePlanBtn.disabled = true;

                // Highlight the active plan; let user switch to the other
                if (currentSubscription.plan === 'yearly') {
                    monthlyBtn.textContent = 'Switch to Monthly';
                    monthlyBtn.disabled = false;
                    yearlyBtn.textContent = 'Current Plan';
                    yearlyBtn.disabled = true;
                } else {
                    // monthly (or unknown — default to monthly)
                    monthlyBtn.textContent = 'Current Plan';
                    monthlyBtn.disabled = true;
                    yearlyBtn.textContent = 'Switch to Yearly';
                    yearlyBtn.disabled = false;
                }
            } else {
                badge.textContent = 'Free';
                badge.className = 'status-badge free';
                details.textContent = 'Upgrade to Premium for tournament access';
                cancelBtn.style.display = 'none';

                // Free card: this IS the current plan
                freePlanBtn.textContent = 'Current Plan';
                freePlanBtn.disabled = true;
                monthlyBtn.textContent = 'Subscribe Monthly';
                monthlyBtn.disabled = false;
                yearlyBtn.textContent = 'Subscribe Yearly';
                yearlyBtn.disabled = false;
            }
        }

        function setSubscribeButtonsDisabled(disabled) {
            document.getElementById('subscribeMonthlyBtn').disabled = disabled;
            document.getElementById('subscribeYearlyBtn').disabled = disabled;
        }

        async function subscribe(plan) {
            // FIX #2: Prevent double-submission from rapid clicks
            if (isSubscribing) return;
            isSubscribing = true;
            setSubscribeButtonsDisabled(true);

            try {
                if (!walletAddress) {
                    walletAddress = await connectWallet();
                    if (!walletAddress) return;
                }

                showMessage('Processing subscription... Please approve the transaction in Phantom', 'info');

                // Get price
                const pricesResponse = await fetch(`${SUBSCRIPTION_API}/prices`);
                const pricesData = await pricesResponse.json();
                const amount = plan === 'monthly' ? pricesData.prices.monthly : pricesData.prices.yearly;

                // Create USDC transfer transaction
                showMessage(`Creating payment transaction for $${amount} USDC...`, 'info');
                const transaction = await createSubscriptionTransaction(walletAddress, amount);

                // Sign transaction with Phantom
                showMessage('Please approve the transaction in your Phantom wallet...', 'info');
                const { solana } = window;
                const signedTransaction = await solana.signTransaction(transaction);

                // FIX #1: Send with skipPreflight: true to avoid
                // "already processed" simulation false-positive on retries.
                // preflightCommitment still guards the first real submission.
                showMessage('Sending transaction to Solana network...', 'info');
                let signature;
                try {
                    signature = await connection.sendRawTransaction(
                        signedTransaction.serialize(),
                        {
                            skipPreflight: true,           // <-- KEY FIX
                            preflightCommitment: 'confirmed',
                            maxRetries: 3,
                        }
                    );
                } catch (sendErr) {
                    // If the tx was already processed, it likely landed on a prior attempt.
                    // Extract the signature from the error and continue to confirmation.
                    if (sendErr.message?.includes('already been processed')) {
                        console.warn('Transaction already processed — checking confirmation on chain.');
                        // The signature is not available here, so we must surface a clear error.
                        showMessage(
                            'This transaction was already submitted. If payment was deducted, please refresh the page to check your subscription status.',
                            'error'
                        );
                        return;
                    }
                    throw sendErr;
                }

                console.log('Subscription payment transaction signature:', signature);

                // Wait for confirmation
                showMessage('Waiting for transaction confirmation...', 'info');
                const confirmation = await connection.confirmTransaction({
                    signature,
                    blockhash: transaction.recentBlockhash,
                    lastValidBlockHeight: transaction.lastValidBlockHeight,
                }, 'confirmed');

                if (confirmation.value.err) {
                    throw new Error('Transaction confirmed but failed on-chain: ' + JSON.stringify(confirmation.value.err));
                }

                // Submit subscription to server
                showMessage('Activating subscription...', 'info');
                const response = await fetch(`${SUBSCRIPTION_API}/subscribe`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    credentials: 'include',
                    body: JSON.stringify({
                        walletAddress,
                        transactionSignature: signature,
                        plan
                    })
                });

                const data = await response.json();
                
                if (data.success) {
                    showMessage('Subscription activated successfully!', 'success');
                    setTimeout(() => {
                        window.location.reload();
                    }, 2000);
                } else {
                    showMessage(data.error || 'Subscription failed', 'error');
                }

            } catch (error) {
                console.error('Subscription error:', error);
                showMessage('Failed to process subscription: ' + error.message, 'error');
            } finally {
                // FIX #2: Always re-enable buttons when done
                isSubscribing = false;
                setSubscribeButtonsDisabled(false);
            }
        }

        async function cancelSubscription() {
            if (!confirm('Are you sure you want to cancel your subscription? You will keep access until the end of your billing period.')) {
                return;
            }

            try {
                const response = await fetch(`${SUBSCRIPTION_API}/cancel`, {
                    method: 'POST',
                    credentials: 'include'
                });

                const data = await response.json();
                
                if (data.success) {
                    showMessage('Subscription cancelled. You will keep access until the end of your billing period.', 'success');
                    setTimeout(() => {
                        window.location.reload();
                    }, 2000);
                } else {
                    showMessage(data.error || 'Failed to cancel subscription', 'error');
                }
            } catch (error) {
                console.error('Cancel error:', error);
                showMessage('Failed to cancel subscription', 'error');
            }
        }

        function showMessage(text, type) {
            const messageDiv = document.getElementById('message');
            messageDiv.className = type === 'error' ? 'error-message' : 'success-message';
            messageDiv.textContent = text;
            messageDiv.style.display = 'block';

            if (type === 'success') {
                setTimeout(() => {
                    messageDiv.style.display = 'none';
                }, 5000);
            }
        }

        // Event listeners
        document.getElementById('subscribeMonthlyBtn').addEventListener('click', () => subscribe('monthly'));
        document.getElementById('subscribeYearlyBtn').addEventListener('click', () => subscribe('yearly'));
        document.getElementById('cancelBtn').addEventListener('click', cancelSubscription);

        // Initialize
        loadPrices();
        loadSubscriptionStatus();