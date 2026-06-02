// ── Auth check ────────────────────────────────────────────────────────────
async function checkAdminAccess() {
  try {
    const res = await fetch("/api/admin/tournaments", {
      credentials: "include",
    });
    if (res.status === 401) {
      window.location.href = "/login.html?redirect=/admin-tournaments.html";
      return false;
    }
    if (res.status === 403) {
      document.getElementById("accessDenied").style.display = "flex";
      return false;
    }
    document.getElementById("adminContent").style.display = "block";
    return true;
  } catch (e) {
    document.getElementById("accessDenied").style.display = "flex";
    return false;
  }
}

// ── Load & render tournament list ─────────────────────────────────────────
async function loadTournaments() {
  const container = document.getElementById("tournamentList");
  container.innerHTML =
    '<div class="empty-state"><div class="loading-spinner"></div></div>';

  try {
    const res = await fetch("/api/admin/tournaments", {
      credentials: "include",
    });
    const data = await res.json();

    if (!data.success || !data.tournaments.length) {
      container.innerHTML =
        '<div class="empty-state"><p>No tournaments yet. Create one!</p></div>';
      return;
    }

    container.innerHTML = `
                <table class="tournament-table">
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th>Status</th>
                            <th>Start Time</th>
                            <th>Reg. Deadline</th>
                            <th>Players</th>
                            <th>Prize Pool</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${data.tournaments
                          .map(
                            (t) => `
                            <tr>
                                <td>
                                    <strong>${escHtml(t.name)}</strong>
                                </td>
                                <td><span class="status-pill status-${
                                  t.status
                                }">${t.status.replace("_", " ")}</span></td>
                                <td>${fmtDate(t.startTime)}</td>
                                <td>${fmtDate(t.registrationDeadline)}</td>
                                <td>
                                    ${t.participants?.length ?? 0} / ${
                              t.maxPlayers
                            }
                                    ${
                                      t.participants?.length < t.minPlayers
                                        ? `<br><small style="color:#f59e0b">needs ${
                                            t.minPlayers -
                                            (t.participants?.length ?? 0)
                                          } more</small>`
                                        : ""
                                    }
                                </td>
                                <td>${
                                  t.prizePool?.total > 0
                                    ? `${t.prizePool.total} ${t.prizePool.currency}`
                                    : "—"
                                }</td>
                                <td>
                                    <button class="btn-cancel"
                                        onclick="cancelTournament('${
                                          t._id
                                        }', this)"
                                        ${
                                          ["completed", "cancelled"].includes(
                                            t.status
                                          )
                                            ? "disabled"
                                            : ""
                                        }>
                                        Cancel
                                    </button>
                                </td>
                            </tr>
                        `
                          )
                          .join("")}
                    </tbody>
                </table>
            `;
  } catch (e) {
    container.innerHTML =
      '<div class="empty-state"><p style="color:#ef4444">Failed to load tournaments</p></div>';
  }
}

// ── Create tournament ─────────────────────────────────────────────────────
document.getElementById("createForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("submitBtn");
  btn.disabled = true;
  btn.textContent = "Creating...";
  hideAlert();

  const startTime = document.getElementById("startTime").value;
  const registrationDeadline = document.getElementById(
    "registrationDeadline"
  ).value;

  // Client-side deadline check
  if (new Date(registrationDeadline) >= new Date(startTime)) {
    showAlert("Registration deadline must be before the start time.", "error");
    btn.disabled = false;
    btn.textContent = "Create Tournament";
    return;
  }

  const payload = {
    name: document.getElementById("name").value.trim(),
    description: document.getElementById("description").value.trim(),
    type: document.getElementById("type").value,
    format: document.getElementById("format").value,
    startTime: new Date(startTime).toISOString(),
    registrationDeadline: new Date(registrationDeadline).toISOString(),
    minPlayers: parseInt(document.getElementById("minPlayers").value),
    maxPlayers: parseInt(document.getElementById("maxPlayers").value),
    prizePool: parseFloat(document.getElementById("prizePool").value) || 0,
    entryFee: parseFloat(document.getElementById("entryFee").value) || 0,
    questionsPerGame: parseInt(
      document.getElementById("questionsPerGame").value
    ),
    timePerQuestion: parseInt(document.getElementById("timePerQuestion").value),
  };

  try {
    const res = await fetch("/api/admin/tournaments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (data.success) {
      showAlert(
        `✅ Tournament "${data.tournament.name}" created successfully!`,
        "success"
      );
      document.getElementById("createForm").reset();
      loadTournaments();
    } else {
      showAlert(data.error || "Failed to create tournament", "error");
    }
  } catch (err) {
    showAlert("Network error. Please try again.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Create Tournament";
  }
});

// ── Cancel tournament ─────────────────────────────────────────────────────
async function cancelTournament(id, btn) {
  if (!confirm("Cancel this tournament? This cannot be undone.")) return;
  btn.disabled = true;
  btn.textContent = "...";

  try {
    const res = await fetch(`/api/admin/tournaments/${id}/cancel`, {
      method: "POST",
      credentials: "include",
    });
    const data = await res.json();
    if (data.success) {
      loadTournaments();
    } else {
      alert(data.error || "Failed to cancel");
      btn.disabled = false;
      btn.textContent = "Cancel";
    }
  } catch (e) {
    alert("Network error");
    btn.disabled = false;
    btn.textContent = "Cancel";
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function escHtml(str) {
  return String(str).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        c
      ])
  );
}

function showAlert(msg, type) {
  const el = document.getElementById("createAlert");
  el.textContent = msg;
  el.className = `alert alert-${type}`;
  el.style.display = "block";
  if (type === "success") setTimeout(hideAlert, 5000);
}

function hideAlert() {
  const el = document.getElementById("createAlert");
  el.style.display = "none";
}

// ── Prefill datetime inputs with sensible defaults ────────────────────────
function prefillDates() {
  const now = new Date();
  const regTime = new Date(now.getTime() + 30 * 60 * 1000); // 30 min from now
  const start = new Date(now.getTime() + 60 * 60 * 1000); // 1 hr from now

  const toLocal = (d) => {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
      d.getDate()
    )}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  document.getElementById("registrationDeadline").value = toLocal(regTime);
  document.getElementById("startTime").value = toLocal(start);
}

// ── Boot ──────────────────────────────────────────────────────────────────
(async () => {
  const ok = await checkAdminAccess();
  if (ok) {
    prefillDates();
    loadTournaments();
  }
})();
