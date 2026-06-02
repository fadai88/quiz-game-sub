let allCycles = [],
  activeCycleId = null;

function fmtAddr(a) {
  return a && a.length > 12
    ? `${a.slice(0, 6)}…${a.slice(-4)}`
    : a || "Unknown";
}
function fmtDate(d) {
  return d
    ? new Date(d).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      })
    : "—";
}

async function loadCycles() {
  try {
    const r = await fetch("/api/leaderboard/cycles");
    allCycles = await r.json();
  } catch {
    allCycles = [];
  }

  if (!allCycles.length) {
    try {
      const r = await fetch("/api/leaderboard");
      const d = await r.json();
      if (d.cycle) allCycles = [d.cycle];
    } catch {}
  }

  renderPills();
  if (allCycles.length) {
    activeCycleId = allCycles[0]._id || allCycles[0].id;
    await loadStandings(activeCycleId);
  }
}

function renderPills() {
  const bar = document.getElementById("cyclePills");
  while (bar.firstChild) bar.removeChild(bar.firstChild);
  if (!allCycles.length) {
    const span = document.createElement("span");
    span.style.cssText = "color:#475569;font-size:.88rem";
    span.textContent = "No cycles yet";
    bar.appendChild(span);
    return;
  }
  allCycles.forEach((c) => {
    const id = c._id || c.id;
    const pill = document.createElement("div");
    pill.className = "cycle-pill";
    pill.dataset.id = id;
    pill.addEventListener("click", () => selectCycle(id, pill));
    pill.textContent = c.label || "";
    const badge = document.createElement("span");
    badge.className = "cycle-badge";
    badge.textContent = c.status === "active" ? "🟢" : "🔒";
    pill.appendChild(badge);
    bar.appendChild(pill);
  });
}

function selectCycle(id, el) {
  document
    .querySelectorAll(".cycle-pill")
    .forEach((p) => p.classList.remove("active"));
  if (el) el.classList.add("active");
  activeCycleId = id;
  loadStandings(id);
}

function refreshCurrent() {
  activeCycleId ? loadStandings(activeCycleId) : loadCycles();
}

async function loadStandings(cycleId) {
  document.getElementById(
    "tableWrap"
  ).innerHTML = `<div class="empty"><span class="spinner"></span> Loading…</div>`;
  document.getElementById("awardsSection").style.display = "none";
  document.getElementById("cycleInfoBar").style.display = "none";
  try {
    const url = cycleId
      ? `/api/leaderboard/cycle/${cycleId}`
      : "/api/leaderboard";
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    renderCycleInfo(data.cycle);
    renderTable(data.rows || []);
    if (data.cycle?.status === "closed" && data.cycle?.awards?.length)
      renderAwards(data.cycle.awards);
    document.querySelectorAll(".cycle-pill").forEach((p) => {
      p.classList.toggle(
        "active",
        p.dataset.id === String(data.cycle?._id || data.cycle?.id)
      );
    });
  } catch (err) {
    const wrap = document.getElementById("tableWrap");
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
    const empty = document.createElement("div");
    empty.className = "empty";
    const icon = document.createElement("div");
    icon.className = "icon";
    icon.textContent = "⚠️";
    const p = document.createElement("p");
    p.textContent = err.message;
    empty.appendChild(icon);
    empty.appendChild(p);
    wrap.appendChild(empty);
  }
}

function renderCycleInfo(c) {
  if (!c) return;
  document.getElementById("cycleInfoBar").style.display = "flex";
  document.getElementById("cycleLabel").textContent = c.label || "—";
  document.getElementById("cycleStarted").textContent = fmtDate(
    c.startedAt || c.started_at
  );
  document.getElementById("statusDot").className =
    "status-dot " + (c.status === "active" ? "active" : "closed");
}

function renderTable(rows) {
  const wrap = document.getElementById("tableWrap");
  while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    const icon = document.createElement("div");
    icon.className = "icon";
    icon.textContent = "🎯";
    const p1 = document.createElement("p");
    p1.textContent = "No games played in this cycle yet.";
    const p2 = document.createElement("p");
    p2.style.cssText = "margin-top:8px;font-size:.85rem";
    const a = document.createElement("a");
    a.href = "game.html";
    a.style.color = "#f59e0b";
    a.textContent = "Be the first to play →";
    p2.appendChild(a);
    empty.appendChild(icon);
    empty.appendChild(p1);
    empty.appendChild(p2);
    wrap.appendChild(empty);
    return;
  }
  const MEDALS = ["🥇", "🥈", "🥉"];
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  ["#", "Wallet", "Wins", "Losses", "Games", "Win %"].forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    const tdRank = document.createElement("td");
    tdRank.className = "rank-cell" + (r.rank <= 3 ? " rank-" + r.rank : "");
    tdRank.textContent = r.rank <= 3 ? MEDALS[r.rank - 1] : String(r.rank);
    tr.appendChild(tdRank);
    const tdAddr = document.createElement("td");
    tdAddr.className = "addr";
    tdAddr.textContent = fmtAddr(r.username);
    tr.appendChild(tdAddr);
    const tdWins = document.createElement("td");
    tdWins.className = "wins";
    tdWins.textContent = r.wins;
    tr.appendChild(tdWins);
    const tdLosses = document.createElement("td");
    tdLosses.className = "losses";
    tdLosses.textContent = r.losses;
    tr.appendChild(tdLosses);
    const tdGames = document.createElement("td");
    tdGames.textContent = r.gamesPlayed;
    tr.appendChild(tdGames);
    const tdPct = document.createElement("td");
    tdPct.className = "pct";
    tdPct.textContent = r.winPct + "%";
    tr.appendChild(tdPct);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
}

function renderAwards(awards) {
  const body = document.getElementById("awardsBody");
  while (body.firstChild) body.removeChild(body.firstChild);
  [...awards]
    .sort((a, b) => a.rank - b.rank)
    .forEach((a) => {
      const row = document.createElement("div");
      row.className = "award-row";
      const rankSpan = document.createElement("span");
      rankSpan.className = "award-rank";
      rankSpan.textContent = "#" + a.rank;
      row.appendChild(rankSpan);
      const addrSpan = document.createElement("span");
      addrSpan.className = "award-addr";
      addrSpan.textContent = fmtAddr(a.walletAddress);
      row.appendChild(addrSpan);
      const prizeSpan = document.createElement("span");
      prizeSpan.className = "award-prize";
      prizeSpan.textContent = a.prizeNote || "";
      row.appendChild(prizeSpan);
      body.appendChild(row);
    });
  document.getElementById("awardsSection").style.display = "block";
}

loadCycles();
setInterval(() => {
  const active = allCycles.find((c) => c.status === "active");
  if (active && (active._id || active.id) === activeCycleId)
    loadStandings(activeCycleId);
}, 30_000);
