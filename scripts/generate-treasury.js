const { Keypair } = require("@solana/web3.js");
const fs = require("fs");
const path = require("path");

const keypair = Keypair.generate();
const outPath = path.resolve(__dirname, "treasury-keypair.json");

// Write the keypair to a file — never print the secret key to stdout/logs.
fs.writeFileSync(outPath, JSON.stringify(Array.from(keypair.secretKey)), {
  mode: 0o600,
});

console.log("Public Key:", keypair.publicKey.toString());
console.log("Keypair saved to:", outPath);
console.log("Keep that file secret and out of version control.");
