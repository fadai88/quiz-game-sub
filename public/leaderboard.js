let allCycles = [], activeCycleId = null;

function fmtAddr(a) { return a && a.length > 12 ? `${a.slice(0,6)}…${a.slice(-4)}` : (a || 'Unknown'); }
function fmtDate(d) { return d ? new Date(d).toLocaleDateString(undefined, {month:'short',day:'numeric',year:'numeric'}) : '—'; }

async function loadCycles() {
    try {
        const r = await fetch('/api/leaderboard/cycles');
        allCycles = await r.json();
    } catch { allCycles = []; }

    if (!allCycles.length) {
        try { const r = await fetch('/api/leaderboard'); const d = await r.json(); if (d.cycle) allCycles = [d.cycle]; } catch {}
    }

    renderPills();
    if (allCycles.length) { activeCycleId = allCycles[0]._id || allCycles[0].id; await loadStandings(activeCycleId); }
}

function renderPills() {
    const bar = document.getElementById('cyclePills');
    if (!allCycles.length) { bar.innerHTML = '<span style="color:#475569;font-size:.88rem">No cycles yet</span>'; return; }
    bar.innerHTML = allCycles.map(c => {
        const id = c._id || c.id;
        return `<div class="cycle-pill" data-id="${id}" onclick="selectCycle('${id}',this)">${c.label}<span class="cycle-badge">${c.status==='active'?'🟢':'🔒'}</span></div>`;
    }).join('');
}

function selectCycle(id, el) {
    document.querySelectorAll('.cycle-pill').forEach(p => p.classList.remove('active'));
    if (el) el.classList.add('active');
    activeCycleId = id; loadStandings(id);
}

function refreshCurrent() { activeCycleId ? loadStandings(activeCycleId) : loadCycles(); }

async function loadStandings(cycleId) {
    document.getElementById('tableWrap').innerHTML = `<div class="empty"><span class="spinner"></span> Loading…</div>`;
    document.getElementById('awardsSection').style.display = 'none';
    document.getElementById('cycleInfoBar').style.display  = 'none';
    try {
        const url = cycleId ? `/api/leaderboard/cycle/${cycleId}` : '/api/leaderboard';
        const res = await fetch(url);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        renderCycleInfo(data.cycle);
        renderTable(data.rows || []);
        if (data.cycle?.status === 'closed' && data.cycle?.awards?.length) renderAwards(data.cycle.awards);
        document.querySelectorAll('.cycle-pill').forEach(p => {
            p.classList.toggle('active', p.dataset.id === String(data.cycle?._id || data.cycle?.id));
        });
    } catch(err) {
        document.getElementById('tableWrap').innerHTML = `<div class="empty"><div class="icon">⚠️</div><p>${err.message}</p></div>`;
    }
}

function renderCycleInfo(c) {
    if (!c) return;
    document.getElementById('cycleInfoBar').style.display = 'flex';
    document.getElementById('cycleLabel').textContent   = c.label || '—';
    document.getElementById('cycleStarted').textContent = fmtDate(c.startedAt || c.started_at);
    document.getElementById('statusDot').className = 'status-dot ' + (c.status === 'active' ? 'active' : 'closed');
}

function renderTable(rows) {
    const wrap = document.getElementById('tableWrap');
    if (!rows.length) {
        wrap.innerHTML = `<div class="empty"><div class="icon">🎯</div><p>No games played in this cycle yet.</p><p style="margin-top:8px;font-size:.85rem"><a href="game.html" style="color:#f59e0b">Be the first to play →</a></p></div>`;
        return;
    }
    const MEDALS = ['🥇','🥈','🥉'];
    wrap.innerHTML = `<table><thead><tr><th>#</th><th>Wallet</th><th>Wins</th><th>Losses</th><th>Games</th><th>Win %</th></tr></thead><tbody>` +
        rows.map(r => `<tr>
            <td class="rank-cell ${r.rank<=3?'rank-'+r.rank:''}">${r.rank<=3?MEDALS[r.rank-1]:r.rank}</td>
            <td class="addr">${fmtAddr(r.username)}</td>
            <td class="wins">${r.wins}</td>
            <td class="losses">${r.losses}</td>
            <td>${r.gamesPlayed}</td>
            <td class="pct">${r.winPct}%</td>
        </tr>`).join('') + `</tbody></table>`;
}

function renderAwards(awards) {
    document.getElementById('awardsBody').innerHTML = [...awards].sort((a,b)=>a.rank-b.rank).map(a =>
        `<div class="award-row"><span class="award-rank">#${a.rank}</span><span class="award-addr">${fmtAddr(a.walletAddress)}</span><span class="award-prize">${a.prizeNote||''}</span></div>`
    ).join('');
    document.getElementById('awardsSection').style.display = 'block';
}

loadCycles();
setInterval(() => {
    const active = allCycles.find(c => c.status === 'active');
    if (active && (active._id||active.id) === activeCycleId) loadStandings(activeCycleId);
}, 30_000);
