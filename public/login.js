function getErrorMessage(error) {
  if (error && typeof error === "object") {
    if (error.error) return error.error;
    if (error.message) return error.message;
    return "An error occurred. Please try again.";
  }
  if (typeof error === "string") return error;
  return "An error occurred. Please try again.";
}

function logError(context, error) {
  const isProduction = window.location.hostname !== "localhost";
  if (isProduction) {
    if (error && error.errorId) {
      console.log(`[${context}] Error ID: ${error.errorId}`);
    } else {
      console.log(`[${context}] An error occurred`);
    }
  } else {
    console.log(`[${context}]`, {
      message: getErrorMessage(error),
      code: error?.code,
      errorId: error?.errorId,
    });
  }
}

const socket = AppNet.connectSocket({
  auth: {
    event: "walletLogin",
  },
});

// Fetch server configuration on page load
async function fetchServerConfig() {
  try {
    const response = await fetch("/api/config");
    if (response.ok) {
      const config = await response.json();
      window.recaptchaEnabled = config.recaptchaEnabled || false;
      console.log("Server config loaded - reCAPTCHA:", window.recaptchaEnabled);
    } else {
      console.warn("Failed to fetch server config, using defaults");
    }
  } catch (error) {
    console.warn("Error fetching server config:", error.message);
  }
}

// Load config when page loads
fetchServerConfig();

socket.on("error", (error) => {
  logError("socket-error", error); // ✅ Safe logging

  if (error.code === "SESSION_EXPIRED" || error.code === "AUTH_ERROR") {
    showError("Session expired. Please login again.");
  }
});

socket.on("disconnect", (reason) => {
  console.log("Disconnected:", reason);
  if (reason === "io server disconnect") {
    // Server kicked—likely auth fail
    showError("Session expired. Please reconnect.");
  }
});

socket.on("reconnect_attempt", (attemptNumber) => {
  console.log(`Reconnect attempt ${attemptNumber}...`);
});

let connectedWallet = null;

// Store signature/message for HTTP authentication (secure cookies)
let lastSignature = null;
let lastMessage = null;

// Record page load time for bot detection
window.pageLoadTime = Date.now();

// Track user behavior metrics
const behaviorMetrics = {
  mouseMovements: 0,
  keyPresses: 0,
  clicks: 0,
  timeOnPage: 0,
};

// Reusable reCAPTCHA token generation function
async function getRecaptchaToken(action) {
  if (!window.recaptchaEnabled) {
    return null;
  }

  console.log("reCAPTCHA enabled - generating token for action:", action);
  try {
    const token = await new Promise((resolve, reject) => {
      grecaptcha.ready(async () => {
        try {
          const token = await grecaptcha.execute(window.recaptchaSiteKey, {
            action: action,
          });
          if (!token) {
            reject(new Error("Failed to generate reCAPTCHA token"));
          } else {
            resolve(token);
          }
        } catch (error) {
          reject(error);
        }
      });
    });
    console.log("reCAPTCHA token generated successfully");
    return token;
  } catch (error) {
    console.error("reCAPTCHA token generation error:", error);
    throw new Error("reCAPTCHA verification failed: " + error.message);
  }
}

// Track mouse movements
document.addEventListener("mousemove", () => {
  behaviorMetrics.mouseMovements++;
});

// Track key presses
document.addEventListener("keydown", () => {
  behaviorMetrics.keyPresses++;
});

// Track clicks
document.addEventListener("click", () => {
  behaviorMetrics.clicks++;
});

// Update time on page
setInterval(() => {
  behaviorMetrics.timeOnPage = Math.floor(
    (Date.now() - window.pageLoadTime) / 1000
  );
}, 1000);

async function connectWallet() {
  try {
    // Check for honeypot field
    if (document.getElementById("username").value !== "") {
      console.log("Bot detected via honeypot field");
      showError("Connection failed. Please try again later.");
      return;
    }

    // Check for behavioral indicators of bot
    if (
      behaviorMetrics.mouseMovements < 5 &&
      behaviorMetrics.timeOnPage < 2 &&
      behaviorMetrics.clicks < 2
    ) {
      console.log("Suspicious behavior detected: possible bot");
      showError("Please wait a moment and try again.");
      return;
    }

    console.log("Connecting wallet...");
    if (WalletManager.detect().length === 0) {
      WalletManager.showNoWalletHelp();
      return;
    }

    // Generate reCAPTCHA token only if enabled
    let recaptchaToken = null;
    if (window.recaptchaEnabled) {
      try {
        recaptchaToken = await getRecaptchaToken("wallet_connect");
        console.log("reCAPTCHA token generated successfully");
      } catch (error) {
        console.error("reCAPTCHA generation failed:", error);
        showError(
          "Verification required. Please complete the reCAPTCHA challenge and try again."
        );
        return;
      }
    } else {
      console.log("reCAPTCHA disabled, skipping token generation");
    }

    const connectButton = document.getElementById("connectWalletBtn");
    connectButton.disabled = true;
    connectButton.innerHTML =
      '<img src="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 128 128%27 fill=%27%23AB9FF2%27%3E%3Cpath d=%27M96 24c17.7 0 32 14.3 32 32v48c0 17.7-14.3 32-32 32H32C14.3 136 0 121.7 0 104V56c0-17.7 14.3-32 32-32h64zm-32 40c0 8.8-7.2 16-16 16s-16-7.2-16-16 7.2-16 16-16 16 7.2 16 16zm32 0c0 8.8-7.2 16-16 16s-16-7.2-16-16 7.2-16 16-16 16 7.2 16 16z%27/%3E%3C/svg%3E" alt="Phantom" class="wallet-icon">Connecting...';

    try {
      // ── Step 1: Connect wallet (multi-wallet picker) ──────────
      const { provider, publicKey: pubKey } = await WalletManager.connect();
      const publicKey = pubKey.toString();
      console.log(
        "Connected to wallet:",
        publicKey,
        "via",
        WalletManager.getSelected() && WalletManager.getSelected().name
      );
      refreshWalletChooser();

      // ── Step 2: Request a server-issued challenge ─────────────
      console.log("Requesting login challenge from server…");
      const { nonce, issuedAt } = await new Promise((resolve, reject) => {
        const onChallenge = (data) => {
          socket.off("challengeError", onError);
          resolve(data);
        };
        const onError = (msg) => {
          socket.off("challenge", onChallenge);
          reject(new Error(msg || "Failed to get challenge"));
        };
        socket.once("challenge", onChallenge);
        socket.once("challengeError", onError);
        socket.emit("requestChallenge", { walletAddress: publicKey });
        setTimeout(() => {
          socket.off("challenge", onChallenge);
          socket.off("challengeError", onError);
          reject(new Error("Challenge request timed out. Please try again."));
        }, 10_000);
      });

      // ── Step 3: Sign the server-dictated message ──────────────
      // Template must stay in sync with utils/challengeStore.js
      const message = `Sign in to Proof of Smart\nNonce: ${nonce}\nIssued: ${issuedAt}`;
      const encodedMessage = new TextEncoder().encode(message);
      console.log("Requesting wallet signature for server challenge…");
      const sigBytes = await WalletManager.signMessage(
        provider,
        encodedMessage
      );
      const signature = btoa(String.fromCharCode(...sigBytes));

      // Store for follow-up HTTP /api/auth/login call
      lastSignature = signature;
      lastMessage = message;

      // ── Step 4: Send nonce + signature (not message) ──────────
      socket.emit("walletLogin", {
        walletAddress: publicKey,
        signature,
        nonce,
        recaptchaToken,
        clientData: {
          timestamp: new Date().toISOString(),
          timeOnPage: behaviorMetrics.timeOnPage,
          mouseMovements: behaviorMetrics.mouseMovements,
          screenResolution: `${screen.width}x${screen.height}`,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          userAgent: navigator.userAgent,
        },
      });
      console.log("Sent login request to server");
    } catch (error) {
      logError("wallet-connection", error); // ✅ Safe logging
      connectButton.disabled = false;
      connectButton.innerHTML =
        '<img src="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 128 128%27 fill=%27%23AB9FF2%27%3E%3Cpath d=%27M96 24c17.7 0 32 14.3 32 32v48c0 17.7-14.3 32-32 32H32C14.3 136 0 121.7 0 104V56c0-17.7 14.3-32 32-32h64zm-32 40c0 8.8-7.2 16-16 16s-16-7.2-16-16 7.2-16 16-16 16 7.2 16 16zm32 0c0 8.8-7.2 16-16 16s-16-7.2-16-16 7.2-16 16-16 16 7.2 16 16z%27/%3E%3C/svg%3E" alt="Phantom" class="wallet-icon">Connect Wallet';
      showError(
        getErrorMessage(error) || "Failed to connect wallet. Please try again."
      ); // ✅ Safe message
    }
  } catch (err) {
    logError("connect-wallet", err); // ✅ Safe logging
    const connectButton = document.getElementById("connectWalletBtn");
    connectButton.disabled = false;
    connectButton.innerHTML =
      '<img src="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 128 128%27 fill=%27%23AB9FF2%27%3E%3Cpath d=%27M96 24c17.7 0 32 14.3 32 32v48c0 17.7-14.3 32-32 32H32C14.3 136 0 121.7 0 104V56c0-17.7 14.3-32 32-32h64zm-32 40c0 8.8-7.2 16-16 16s-16-7.2-16-16 7.2-16 16-16 16 7.2 16 16zm32 0c0 8.8-7.2 16-16 16s-16-7.2-16-16 7.2-16 16-16 16 7.2 16 16z%27/%3E%3C/svg%3E" alt="Phantom" class="wallet-icon">Connect Wallet';

    const errorMsg = getErrorMessage(err);
    if (errorMsg.toLowerCase().includes("recaptcha")) {
      showError(errorMsg + " Please refresh and try again.");
    } else {
      showError(errorMsg);
    }
  }
}

socket.on("loginSuccess", async (data) => {
  console.log("✅ Signature verified, proceeding with HTTP authentication...");

  try {
    // Get reCAPTCHA token
    const recaptchaToken = window.recaptchaEnabled
      ? await getRecaptchaToken("login")
      : null;

    // Collect client fingerprint data
    const clientData = {
      userAgent: navigator.userAgent,
      screen: {
        width: screen.width,
        height: screen.height,
        colorDepth: screen.colorDepth,
      },
      language: navigator.language,
      languages: navigator.languages || [navigator.language],
      platform: navigator.platform,
      hardwareConcurrency: navigator.hardwareConcurrency || 1,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      timezoneOffset: new Date().getTimezoneOffset(),
    };

    // Call HTTP authentication endpoint
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include", // CRITICAL: Enable cookies
      body: JSON.stringify({
        walletAddress: data.walletAddress,
        verifyToken: data.verifyToken, // From Socket.IO (proves signature verified)
        recaptchaToken,
        clientData,
      }),
    });

    const result = await response.json();

    if (result.success) {
      console.log("✅ HTTP authentication successful - secure cookie set");
      connectedWallet = data.walletAddress;

      // Web: NO localStorage — the session is in an httpOnly cookie.
      // Native: there is no cookie jar, so the server returns the token in the
      // body (only for X-Client-Type: native) and we hold it for the bearer
      // header. No-op on the web, where result.sessionToken is never sent.
      if (result.sessionToken) AppNet.setSessionToken(result.sessionToken);

      // The socket authenticated before login, so it is still an anonymous
      // connection. On native the token only enters the handshake at connect
      // time, so it must reconnect to pick up the new session.
      if (AppNet.isNative) socket.disconnect().connect();

      // Update UI
      document.getElementById("walletSection").style.display = "none";
      document.getElementById("userInfo").style.display = "block";
      document.getElementById(
        "walletDisplay"
      ).textContent = `${connectedWallet.slice(0, 4)}...${connectedWallet.slice(
        -4
      )}`;

      showSuccess("Successfully connected! Redirecting to game...");

      // Redirect after 1 second
      setTimeout(() => {
        window.location.href = "game.html";
      }, 1000);
    } else {
      logError("http-auth-failed", { error: result.error }); // ✅ Safe logging
      showError(
        getErrorMessage(result.error) ||
          "Authentication failed. Please try again."
      );
      document.getElementById("connectWalletBtn").disabled = false;
      document.getElementById("connectWalletBtn").innerHTML =
        '<img src="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 128 128%27 fill=%27%23AB9FF2%27%3E%3Cpath d=%27M96 24c17.7 0 32 14.3 32 32v48c0 17.7-14.3 32-32 32H32C14.3 136 0 121.7 0 104V56c0-17.7 14.3-32 32-32h64zm-32 40c0 8.8-7.2 16-16 16s-16-7.2-16-16 7.2-16 16-16 16 7.2 16 16zm32 0c0 8.8-7.2 16-16 16s-16-7.2-16-16 7.2-16 16-16 16 7.2 16 16z%27/%3E%3C/svg%3E" alt="Phantom" class="wallet-icon">Connect Wallet';
    }
  } catch (error) {
    logError("http-auth-error", error); // ✅ Safe logging
    showError("Authentication failed. Please try again.");
    document.getElementById("connectWalletBtn").disabled = false;
    document.getElementById("connectWalletBtn").innerHTML =
      '<img src="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 128 128%27 fill=%27%23AB9FF2%27%3E%3Cpath d=%27M96 24c17.7 0 32 14.3 32 32v48c0 17.7-14.3 32-32 32H32C14.3 136 0 121.7 0 104V56c0-17.7 14.3-32 32-32h64zm-32 40c0 8.8-7.2 16-16 16s-16-7.2-16-16 7.2-16 16-16 16 7.2 16 16zm32 0c0 8.8-7.2 16-16 16s-16-7.2-16-16 7.2-16 16-16 16 7.2 16 16z%27/%3E%3C/svg%3E" alt="Phantom" class="wallet-icon">Connect Wallet';
  }
});

socket.on("loginFailure", (error) => {
  logError("login-failure", error); // ✅ Safe logging
  document.getElementById("connectWalletBtn").disabled = false;
  document.getElementById("connectWalletBtn").innerHTML =
    '<img src="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 128 128%27 fill=%27%23AB9FF2%27%3E%3Cpath d=%27M96 24c17.7 0 32 14.3 32 32v48c0 17.7-14.3 32-32 32H32C14.3 136 0 121.7 0 104V56c0-17.7 14.3-32 32-32h64zm-32 40c0 8.8-7.2 16-16 16s-16-7.2-16-16 7.2-16 16-16 16 7.2 16 16zm32 0c0 8.8-7.2 16-16 16s-16-7.2-16-16 7.2-16 16-16 16 7.2 16 16z%27/%3E%3C/svg%3E" alt="Phantom" class="wallet-icon">Connect Wallet';
  showError(getErrorMessage(error)); // ✅ User-friendly message
});

document
  .getElementById("connectWalletBtn")
  .addEventListener("click", connectWallet);

// ── "Use a different wallet" ────────────────────────────────────────────────
// WalletManager remembers the last wallet and reuses it silently. This link
// lets the user forget that choice and re-open the picker — only useful when
// they have more than one wallet installed and one is already remembered.
function refreshWalletChooser() {
  const link = document.getElementById("switchWalletBtn");
  if (!link || !window.WalletManager) return;
  const selected = WalletManager.getSelected();
  const installedCount = WalletManager.detect().length;
  if (selected && installedCount > 1) {
    link.textContent = `Using ${selected.name} — use a different wallet`;
    link.style.display = "block";
  } else {
    link.style.display = "none";
  }
}

const switchWalletBtn = document.getElementById("switchWalletBtn");
if (switchWalletBtn) {
  switchWalletBtn.addEventListener("click", async () => {
    WalletManager.clearSelection();
    refreshWalletChooser();
    // Re-run the normal connect flow; with no remembered wallet the picker opens.
    await connectWallet();
  });
}

// Wallets may inject slightly after page load; refresh once now and shortly after.
refreshWalletChooser();
setTimeout(refreshWalletChooser, 800);

document.getElementById("playGameBtn").addEventListener("click", () => {
  window.location.href = `game.html`;
});

document.getElementById("disconnectBtn").addEventListener("click", async () => {
  try {
    // Call logout endpoint to clear cookie
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
    });
  } catch (error) {
    logError("logout", error);
  }

  const activeProvider = WalletManager.getProvider();
  if (
    activeProvider &&
    activeProvider.isConnected &&
    activeProvider.disconnect
  ) {
    activeProvider.disconnect();
  }

  // Web: nothing to clear — the session was in an httpOnly cookie.
  // Native: drop the bearer token too, or the next launch resumes the session
  // the user just asked to end.
  AppNet.setSessionToken(null);
  window.location.href = "login.html";
});

function showError(message) {
  const loginMessage = document.getElementById("loginMessage");
  loginMessage.textContent = message;
  loginMessage.className = "error-message";
}

function showSuccess(message) {
  const loginMessage = document.getElementById("loginMessage");
  loginMessage.textContent = message;
  loginMessage.className = "success-message";
}

// Check for existing session on page load (via secure cookie)
window.addEventListener("load", async () => {
  try {
    const response = await fetch("/api/auth/session", {
      credentials: "include",
    });

    const data = await response.json();

    if (data.authenticated) {
      // Already logged in, show user info
      connectedWallet = data.walletAddress;
      document.getElementById("walletSection").style.display = "none";
      document.getElementById("userInfo").style.display = "block";
      document.getElementById(
        "walletDisplay"
      ).textContent = `${connectedWallet.slice(0, 4)}...${connectedWallet.slice(
        -4
      )}`;
    }
  } catch (error) {
    // Not logged in, show login form (default state)
    console.log("No existing session");
  }
});
