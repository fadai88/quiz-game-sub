const splToken = window.SplToken;
window.Buffer = buffer.Buffer;

const TOKEN_PROGRAM_ID = new solanaWeb3.PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
const ASSOCIATED_TOKEN_PROGRAM_ID = new solanaWeb3.PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);
const USDC_DECIMALS = 6;
const USDC_MULTIPLIER = 1_000_000; // 10^6 for 6 decimals

// Valid bet amounts in USDC (for display)
const VALID_BET_AMOUNTS_USDC = [3, 10, 15, 20, 30];
// Valid bet amounts in atomic units (what we send to backend)
const VALID_BET_AMOUNTS_ATOMIC = VALID_BET_AMOUNTS_USDC.map(
  (x) => x * USDC_MULTIPLIER
);
// Result: [3000000, 10000000, 15000000, 20000000, 30000000]

/**
 * Convert USDC display amount to atomic units
 */
function toAtomicUnits(usdcAmount) {
  return usdcAmount * USDC_MULTIPLIER;
}

/**
 * Convert atomic units to USDC display amount
 */
function fromAtomicUnits(atomicAmount) {
  return atomicAmount / USDC_MULTIPLIER;
}

const config = {
  USDC_MINT: new solanaWeb3.PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
  ),
  TREASURY_WALLET: new solanaWeb3.PublicKey(
    "NoyR3nErDpw4fWDyHQ3CCURAe4TjTf9TkHZ7vhuDTp4"
  ),
};
