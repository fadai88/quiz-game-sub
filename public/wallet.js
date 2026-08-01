/**
 * public/wallet.js — shared multi-wallet provider abstraction.
 *
 * The app was originally hardcoded to Phantom (`window.solana.isPhantom`). This
 * module detects every major Solana wallet that injects a Phantom-compatible
 * provider (connect / signMessage / signTransaction / publicKey) and lets the
 * user pick which to use. No build step, no external deps — loaded via a plain
 * <script src="/wallet.js"> before each page's own script.
 *
 * Public API (attached to window.WalletManager):
 *   detect()                     -> [{ id, name, icon, provider }]  (installed only)
 *   connect({ onlyIfTrusted })   -> { provider, publicKey, wallet } (picker if >1)
 *   getProvider()                -> the active provider, or null
 *   getSelected()                -> { id, name, icon, provider } or null
 *   signMessage(provider, bytes) -> Uint8Array signature (normalized across wallets)
 *   onDisconnect(cb)             -> register a disconnect/account-change callback
 *   showNoWalletHelp()           -> user-facing "install a wallet" prompt
 */
(function () {
  "use strict";

  function tileIcon(bg, letter) {
    const svg =
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'>" +
      "<rect width='40' height='40' rx='10' fill='" +
      bg +
      "'/><text x='20' y='27' font-family='Arial,Helvetica,sans-serif' " +
      "font-size='22' font-weight='bold' text-anchor='middle' fill='#fff'>" +
      letter +
      "</text></svg>";
    return "data:image/svg+xml," + encodeURIComponent(svg);
  }

  // Detection getters return the injected provider object or null. Each wallet
  // is identified by its own flag so we never mistake one for another (several
  // wallets historically also populate window.solana).
  const WALLETS = [
    {
      id: "phantom",
      name: "Phantom",
      url: "https://phantom.app/",
      icon: tileIcon("#AB9FF2", "P"),
      get: () =>
        (window.phantom &&
          window.phantom.solana &&
          window.phantom.solana.isPhantom &&
          window.phantom.solana) ||
        (window.solana && window.solana.isPhantom && window.solana) ||
        null,
    },
    {
      id: "solflare",
      name: "Solflare",
      url: "https://solflare.com/",
      icon: tileIcon("#FC7227", "S"),
      get: () =>
        (window.solflare && window.solflare.isSolflare && window.solflare) ||
        null,
    },
    {
      id: "backpack",
      name: "Backpack",
      url: "https://backpack.app/",
      icon: tileIcon("#E33E3F", "B"),
      get: () =>
        (window.backpack && window.backpack.isBackpack && window.backpack) ||
        null,
    },
    {
      id: "coinbase",
      name: "Coinbase Wallet",
      url: "https://www.coinbase.com/wallet",
      icon: tileIcon("#2C5FF6", "C"),
      get: () => window.coinbaseSolana || null,
    },
    {
      id: "glow",
      name: "Glow",
      url: "https://glow.app/",
      icon: tileIcon("#9945FF", "G"),
      get: () =>
        window.glowSolana || (window.glow && window.glow.solana) || null,
    },
  ];

  const STORAGE_KEY = "selectedWalletId";
  let selectedId = null;
  try {
    selectedId = localStorage.getItem(STORAGE_KEY) || null;
  } catch (_) {
    /* localStorage may be unavailable */
  }

  const disconnectCbs = [];
  // Track which provider objects we've already wired events on. Kept OUTSIDE the
  // provider (a WeakSet) because some wallets (e.g. Backpack) freeze their
  // provider object — assigning a marker property to it throws "object is not
  // extensible".
  const boundProviders = new WeakSet();

  function meta(id) {
    return WALLETS.find((w) => w.id === id) || null;
  }

  function detect() {
    return WALLETS.map((w) => ({
      id: w.id,
      name: w.name,
      icon: w.icon,
      url: w.url,
      provider: w.get(),
    })).filter((w) => w.provider);
  }

  function providerFor(id) {
    const m = meta(id);
    return m ? m.get() : null;
  }

  function getProvider() {
    return selectedId ? providerFor(selectedId) : null;
  }

  function getSelected() {
    const provider = getProvider();
    if (!provider) return null;
    const m = meta(selectedId);
    return { id: m.id, name: m.name, icon: m.icon, url: m.url, provider };
  }

  function select(id) {
    selectedId = id;
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch (_) {
      /* ignore */
    }
    attachProviderEvents(providerFor(id));
  }

  // Forget the remembered wallet so the next connect() shows the picker again.
  // Also best-effort disconnects the current provider so the old wallet isn't
  // left silently connected.
  function clearSelection() {
    const current = getProvider();
    if (
      current &&
      current.isConnected &&
      typeof current.disconnect === "function"
    ) {
      try {
        current.disconnect();
      } catch (_) {
        /* ignore */
      }
    }
    selectedId = null;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {
      /* ignore */
    }
  }

  // Attach disconnect/account-change listeners once per provider, fanning out to
  // every registered callback. Guarded so repeated connects don't stack handlers.
  function attachProviderEvents(provider) {
    if (
      !provider ||
      boundProviders.has(provider) ||
      typeof provider.on !== "function"
    )
      return;
    boundProviders.add(provider);
    const fire = () => {
      disconnectCbs.forEach((cb) => {
        try {
          cb();
        } catch (_) {
          /* ignore */
        }
      });
    };
    try {
      provider.on("disconnect", fire);
      provider.on("accountChanged", (pk) => {
        // accountChanged with a null/absent key means the wallet locked/left.
        if (!pk) fire();
      });
    } catch (_) {
      /* provider without events */
    }
  }

  function onDisconnect(cb) {
    if (typeof cb === "function") disconnectCbs.push(cb);
    // Bind to whatever provider is already active (e.g. persisted on reload).
    attachProviderEvents(getProvider());
  }

  // Normalize signMessage across wallets: some return { signature }, some return
  // the raw Uint8Array. Always hand back the signature bytes.
  async function signMessage(provider, encodedMessage) {
    const out = await provider.signMessage(encodedMessage, "utf8");
    if (out && out.signature) return out.signature;
    return out;
  }

  /**
   * Resolve a provider and connect it.
   *  - 0 installed  -> throws Error(code NO_WALLET)
   *  - previously chosen & still installed -> reuse it
   *  - exactly 1 installed -> auto-select
   *  - several installed -> show the picker (unless onlyIfTrusted, then reuse/skip)
   */
  async function connect(opts) {
    opts = opts || {};
    const available = detect();
    if (available.length === 0) {
      const err = new Error(
        "No supported Solana wallet found. Install Phantom, Solflare, Backpack, Coinbase Wallet, or Glow."
      );
      err.code = "NO_WALLET";
      throw err;
    }

    let choice =
      (selectedId && available.find((w) => w.id === selectedId)) || null;
    if (!choice) {
      if (opts.onlyIfTrusted) {
        // Silent reconnect: don't pop a picker. Only proceed if unambiguous.
        if (available.length !== 1) {
          const err = new Error("No trusted wallet to reconnect");
          err.code = "NO_TRUSTED";
          throw err;
        }
        choice = available[0];
      } else {
        choice =
          available.length === 1 ? available[0] : await showPicker(available);
      }
    }

    select(choice.id);
    const provider = choice.provider;
    const resp = await provider.connect(
      opts.onlyIfTrusted ? { onlyIfTrusted: true } : undefined
    );
    const publicKey = (resp && resp.publicKey) || provider.publicKey;
    if (!publicKey) throw new Error("Wallet did not return a public key");
    return { provider, publicKey, wallet: choice };
  }

  // ── Picker modal ───────────────────────────────────────────────────────────
  function showPicker(available) {
    return new Promise((resolve, reject) => {
      const overlay = document.createElement("div");
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.style.cssText =
        "position:fixed;inset:0;z-index:100000;display:flex;align-items:center;" +
        "justify-content:center;background:rgba(0,0,0,0.6);";

      const card = document.createElement("div");
      card.style.cssText =
        "background:#1b1b2b;color:#fff;width:min(360px,92vw);border-radius:16px;" +
        "padding:20px;box-shadow:0 20px 60px rgba(0,0,0,0.5);" +
        "font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;";

      const title = document.createElement("h3");
      title.textContent = "Choose a wallet";
      title.style.cssText = "margin:0 0 4px;font-size:18px;";
      const sub = document.createElement("p");
      sub.textContent = "Select which wallet to connect with.";
      sub.style.cssText = "margin:0 0 16px;font-size:13px;opacity:0.7;";
      card.appendChild(title);
      card.appendChild(sub);

      function cleanup() {
        document.removeEventListener("keydown", onKey);
        overlay.remove();
      }
      function onKey(e) {
        if (e.key === "Escape") {
          cleanup();
          reject(makeCancel());
        }
      }
      function makeCancel() {
        const err = new Error("Wallet selection cancelled");
        err.code = "CANCELLED";
        return err;
      }

      available.forEach((w) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.style.cssText =
          "display:flex;align-items:center;gap:12px;width:100%;margin:6px 0;" +
          "padding:12px 14px;border:1px solid #333;border-radius:12px;" +
          "background:#25253a;color:#fff;cursor:pointer;font-size:15px;text-align:left;";
        btn.onmouseenter = () => (btn.style.background = "#30304a");
        btn.onmouseleave = () => (btn.style.background = "#25253a");
        const img = document.createElement("img");
        img.src = w.icon;
        img.alt = "";
        img.width = 28;
        img.height = 28;
        img.style.cssText = "width:28px;height:28px;border-radius:8px;";
        const label = document.createElement("span");
        label.textContent = w.name;
        label.style.flex = "1";
        btn.appendChild(img);
        btn.appendChild(label);
        btn.onclick = () => {
          cleanup();
          resolve(w);
        };
        card.appendChild(btn);
      });

      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancel";
      cancel.style.cssText =
        "margin-top:10px;width:100%;padding:10px;border:none;border-radius:10px;" +
        "background:transparent;color:#aaa;cursor:pointer;font-size:14px;";
      cancel.onclick = () => {
        cleanup();
        reject(makeCancel());
      };
      card.appendChild(cancel);

      overlay.appendChild(card);
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) {
          cleanup();
          reject(makeCancel());
        }
      });
      document.addEventListener("keydown", onKey);
      document.body.appendChild(overlay);
    });
  }

  function showNoWalletHelp() {
    const names = WALLETS.map((w) => w.name).join(", ");
    // eslint-disable-next-line no-alert
    alert(
      "No supported Solana wallet detected.\n\nInstall one of: " +
        names +
        ",\nthen refresh this page."
    );
  }

  // Bind events to a persisted provider as soon as the module loads, so a
  // disconnect right after a reload is still observed.
  attachProviderEvents(getProvider());

  window.WalletManager = {
    detect,
    connect,
    getProvider,
    getSelected,
    select,
    clearSelection,
    signMessage,
    onDisconnect,
    showPicker,
    showNoWalletHelp,
  };
})();
