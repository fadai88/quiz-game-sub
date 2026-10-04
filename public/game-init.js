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

// The USDC mint and treasury come ONLY from the server (/api/config), which
// reads them from the deployment's env. There is deliberately no built-in
// fallback: the old one paired the MAINNET mint with the DEVNET treasury, so a
// failed config fetch on mainnet would have built a real-USDC stake transfer to
// the wrong wallet. Until the server supplies them, staking is unavailable
// (USDCManager.createTransferTransaction refuses to build a transfer).
const config = {
  USDC_MINT: null,
  TREASURY_WALLET: null,
};
