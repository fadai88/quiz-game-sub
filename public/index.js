function toggleTheme() {
  document.body.classList.toggle("dark-theme");
}

let wallet = null;

// Check if wallet is already connected on page load
window.addEventListener("load", () => {
  const savedWallet = localStorage.getItem("walletAddress");
  const connectBtn = document.getElementById("connectWalletBtn");
  if (savedWallet && connectBtn) {
    wallet = savedWallet;
    connectBtn.textContent = `Connected: ${wallet.slice(0, 4)}...${wallet.slice(
      -4
    )}`;
  }
});

async function connectWallet() {
  try {
    if (!window.solana || !window.solana.isPhantom) {
      alert("Please install Phantom wallet!");
      return;
    }

    const resp = await window.solana.connect();
    wallet = resp.publicKey.toString();
    // Save wallet address to localStorage
    localStorage.setItem("walletAddress", wallet);
    const connectBtn = document.getElementById("connectWalletBtn");
    if (connectBtn) {
      connectBtn.textContent = `Connected: ${wallet.slice(
        0,
        4
      )}...${wallet.slice(-4)}`;
    }
  } catch (err) {
    console.error("Error connecting wallet:", err);
    alert("Failed to connect wallet");
  }
}

const connectWalletBtn = document.getElementById("connectWalletBtn");
if (connectWalletBtn) {
  connectWalletBtn.addEventListener("click", connectWallet);
}
