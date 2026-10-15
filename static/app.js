const SERIES_COLORS = [
  "var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)",
  "var(--series-5)", "var(--series-6)", "var(--series-7)", "var(--series-8)",
];
const SEQ_STEPS = ["--seq-100", "--seq-200", "--seq-300", "--seq-400", "--seq-500", "--seq-600", "--seq-700"];
const DEFAULT_COMMANDS = [];
const RANGE_LABELS = { "7d": "Last 1 week", "14d": "Last 2 weeks", "30d": "Last 1 month", "60d": "Last 2 months", "90d": "Last 3 months" };

let hosts = [];
let snapshotCounts = {};
let currentRange = "7d";
let currentHistory = null;
let currentOpsHostId = null;
let usersChart = null;
let loadChart = null;
let snapSessionsChart = null;

const $ = (id) => document.getElementById(id);

function resolvedColor(varExpr) {
  const name = varExpr.replace("var(", "").replace(")", "");
  return getComputedStyle(document.body).getPropertyValue(name).trim() || "#888";
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function truncate(s, n) { return s && s.length > n ? s.slice(0, n - 1) + "…" : (s || ""); }

function getCssVar(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

function destroyExistingChart(canvasEl) {
  const existing = Chart.getChart(canvasEl);
  if (existing) existing.destroy();
}

function fmtDate(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
    + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(text);
  }
  return res.status === 204 ? null : res.json();
}

// ========== Navigation ==========

function showHostsPage() {
  $("pageHosts").style.display = "";
  $("pageOps").style.display = "none";
  hideHostForm();
  currentOpsHostId = null;
}

function showOpsPage(hostId) {
  const host = hosts.find(h => h.id === hostId);
  if (!host) return;
  currentOpsHostId = hostId;

  $("pageHosts").style.display = "none";
  $("pageOps").style.display = "";

  renderHostProfile(host);
  renderOpsButtons(host);
  $("opsStatus").textContent = "";
  $("opsStatus").className = "ops-status";
  $("collectProgress").style.display = "none";

  // Reset snapshot view
  $("snapshotDetail").style.display = "none";
  $("btnDeleteSnapshot").style.display = "none";

  // Hide trends panel until a snapshot is selected
  $("dashboardPanel").style.display = "none";

  loadSnapshots(hostId);
}

function renderHostProfile(host) {
  const jumpInfo = host.jump_enabled && host.jump_hostname
    ? `via ${escapeHtml(host.jump_hostname)} → ${escapeHtml(host.jump_alias || "?")}`
    : "None (direct)";
  $("hostProfile").innerHTML = `
    <div class="profile-grid">
      <div class="profile-field"><span class="profile-label">Name</span><span class="profile-value">${escapeHtml(host.name)}</span></div>
      <div class="profile-field"><span class="profile-label">Host</span><span class="profile-value">${escapeHtml(host.username)}@${escapeHtml(host.hostname)}:${host.port}</span></div>
      <div class="profile-field"><span class="profile-label">Auth</span><span class="profile-value">${host.auth_method === "password" ? "Password" : "Identity file"}</span></div>
      <div class="profile-field"><span class="profile-label">Jump host</span><span class="profile-value">${jumpInfo}</span></div>
      <div class="profile-field"><span class="profile-label">Commands</span><span class="profile-value">${(host.commands || []).length} configured</span></div>
      <div class="profile-field"><span class="profile-label">Poll interval</span><span class="profile-value">${host.poll_interval_seconds || 300}s</span></div>
    </div>
  `;
}

function renderOpsButtons(host) {
  $("btnAutoPoll").textContent = host.auto_poll_enabled
    ? "Auto-poll: ON (click to stop)"
    : "Auto-poll: OFF (click to start)";
}

// ========== Data loading ==========

async function loadAll() {
  const [hostsRes, counts] = await Promise.all([
    api("/api/hosts"),
    api("/api/snapshot-counts"),
  ]);
  hosts = hostsRes.hosts || [];
  snapshotCounts = counts || {};
  renderHostList();
}

// ========== Host Form ==========

function showHostForm(host) {
  $("hostFormWrap").style.display = "";
  $("formTitle").textContent = host ? "Edit host" : "Add host";
  if (host) {
    fillHostForm(host);
  } else {
    resetHostForm();
  }
  $("hostFormWrap").scrollIntoView({ behavior: "smooth" });
}

function hideHostForm() {
  $("hostFormWrap").style.display = "none";
  resetHostForm();
}

function toggleAuthFields() {
  const method = $("fAuthMethod").value;
  $("identityFieldWrap").style.display = method === "identity_file" ? "" : "none";
  $("passwordFieldWrap").style.display = method === "password" ? "" : "none";
}

function toggleJumpFields() {
  $("jumpFieldsWrap").style.display = $("fJumpEnabled").checked ? "" : "none";
  toggleJumpAuthFields();
}

function toggleJumpAuthFields() {
  const method = $("fJumpAuthMethod").value;
  $("jumpIdentityWrap").style.display = method === "identity_file" ? "" : "none";
  $("jumpPasswordWrap").style.display = method === "password" ? "" : "none";
}

function resetHostForm() {
  $("hostForm").reset();
  $("hostId").value = "";
  $("fPort").value = 22;
  $("fJumpPort").value = 22;
  $("fPollInterval").value = "43200";
  $("fCommands").value = DEFAULT_COMMANDS.join("\n");
  $("fJumpAlias").value = "";
  $("fJumpEnabled").checked = false;
  $("hostFormStatus").style.display = "none";
  toggleAuthFields();
  toggleJumpFields();
}

function fillHostForm(host) {
  $("hostId").value = host.id;
  $("fName").value = host.name;
  $("fHostname").value = host.hostname;
  $("fPort").value = host.port;
  $("fUsername").value = host.username;
  $("fAuthMethod").value = host.auth_method;
  $("fIdentityFile").value = host.identity_file || "";
  $("fPassword").value = "";
  $("fJumpEnabled").checked = !!host.jump_enabled;
  $("fJumpHostname").value = host.jump_hostname || "";
  $("fJumpPort").value = host.jump_port || 22;
  $("fJumpUsername").value = host.jump_username || "";
  $("fJumpAuthMethod").value = host.jump_auth_method || "identity_file";
  $("fJumpIdentityFile").value = host.jump_identity_file || "";
  $("fJumpPassword").value = "";
  $("fJumpAlias").value = host.jump_alias || "";
  $("fCommands").value = (host.commands && host.commands.length ? host.commands : DEFAULT_COMMANDS).join("\n");
  $("fPollInterval").value = String(host.poll_interval_seconds || 43200);
  toggleAuthFields();
  toggleJumpFields();
}

function showFormStatus(msg, ok) {
  const el = $("hostFormStatus");
  el.textContent = msg;
  el.style.display = "";
  el.style.color = ok ? "var(--good)" : "var(--critical)";
  el.style.fontWeight = "600";
  if (ok) setTimeout(() => { el.style.display = "none"; }, 4000);
}

$("hostForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const submitBtn = $("hostForm").querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = "Saving…";
  $("hostFormStatus").style.display = "none";
  try {
    const existing = hosts.find(h => h.id === $("hostId").value);
    const payload = {
      id: $("hostId").value || null,
      name: $("fName").value.trim(),
      hostname: $("fHostname").value.trim(),
      port: parseInt($("fPort").value, 10) || 22,
      username: $("fUsername").value.trim(),
      auth_method: $("fAuthMethod").value,
      identity_file: $("fIdentityFile").value.trim() || null,
      password: $("fPassword").value || null,
      jump_enabled: $("fJumpEnabled").checked,
      jump_hostname: $("fJumpHostname").value.trim() || null,
      jump_port: parseInt($("fJumpPort").value, 10) || 22,
      jump_username: $("fJumpUsername").value.trim() || null,
      jump_auth_method: $("fJumpAuthMethod").value,
      jump_identity_file: $("fJumpIdentityFile").value.trim() || null,
      jump_password: $("fJumpPassword").value || null,
      jump_alias: $("fJumpAlias").value.trim() || null,
      commands: $("fCommands").value.split("\n").map(s => s.trim()).filter(Boolean),
      poll_interval_seconds: parseInt($("fPollInterval").value, 10) || 300,
      auto_poll_enabled: existing ? existing.auto_poll_enabled : false,
    };
    await api("/api/hosts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    showFormStatus("Host saved successfully.", true);
    hideHostForm();
    await loadAll();
  } catch (err) {
    showFormStatus("Failed to save host: " + err.message, false);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Save host";
  }
});

$("resetForm").addEventListener("click", resetHostForm);
$("fAuthMethod").addEventListener("change", toggleAuthFields);
$("fJumpEnabled").addEventListener("change", toggleJumpFields);
$("fJumpAuthMethod").addEventListener("change", toggleJumpAuthFields);
$("btnAddHost").addEventListener("click", () => showHostForm(null));
$("btnCancelForm").addEventListener("click", hideHostForm);

$("btnCollectAll").addEventListener("click", async () => {
  if (!hosts.length) return;
  const btn = $("btnCollectAll");
  const statusEl = $("collectAllStatus");
  btn.disabled = true;
  btn.textContent = "Collecting…";
  statusEl.textContent = "";
  statusEl.className = "ops-status";

  let done = 0;
  const total = hosts.length;
  const results = [];

  for (const host of hosts) {
    statusEl.textContent = `Collecting ${done + 1}/${total}: ${host.name}…`;
    try {
      const snapshot = await api(`/api/hosts/${host.id}/collect`, { method: "POST" });
      results.push({ name: host.name, ok: !snapshot.error, msg: snapshot.error || "OK" });
    } catch (err) {
      results.push({ name: host.name, ok: false, msg: err.message });
    }
    done++;
  }

  const succeeded = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok);
  statusEl.textContent = `Collected ${succeeded}/${total} hosts` + (failed.length ? ` — failed: ${failed.map(f => f.name).join(", ")}` : "");
  statusEl.className = "ops-status " + (failed.length ? "err" : "ok");
  btn.disabled = false;
  btn.textContent = "Collect all";
  await loadAll();
  loadOverviewDashboard();
});

// ========== Host list (Page 1) ==========

function renderHostList() {
  const list = $("hostList");
  list.innerHTML = "";
  if (!hosts.length) {
    list.innerHTML = '<p class="empty-state">No hosts added yet. Click "+ Add host" above to get started.</p>';
    return;
  }
  hosts.forEach(host => {
    const card = document.createElement("div");
    card.className = "host-card";
    const count = snapshotCounts[host.id] || 0;
    const jumpText = host.jump_enabled && host.jump_hostname
      ? ` via ${escapeHtml(host.jump_hostname)} → ${escapeHtml(host.jump_alias || "?")}`
      : "";
    card.innerHTML = `
      <div class="host-card-top">
        <span class="host-card-name">${escapeHtml(host.name)}</span>
        <span class="host-card-snapshots">${count ? `${count} snapshot${count === 1 ? "" : "s"}` : "no data yet"}</span>
      </div>
      <div class="host-card-meta">${escapeHtml(host.username)}@${escapeHtml(host.hostname)}:${host.port}${jumpText} · ${host.auth_method === "password" ? "password" : "identity file"} auth
        ${host.auto_poll_enabled ? ' · <span class="autopoll-badge">auto-poll ON</span>' : ""}</div>
      <div class="host-card-actions">
        <button data-action="open" class="btn-primary btn-sm">Open</button>
        <button data-action="copy" class="btn-ghost btn-sm">Copy</button>
        <button data-action="edit" class="btn-ghost btn-sm">Edit</button>
        <button data-action="delete" class="btn-ghost btn-sm btn-danger">Delete</button>
      </div>
    `;
    card.querySelector('[data-action="open"]').onclick = () => showOpsPage(host.id);
    card.querySelector('[data-action="copy"]').onclick = () => copyHost(host);
    card.querySelector('[data-action="edit"]').onclick = () => showHostForm(host);
    card.querySelector('[data-action="delete"]').onclick = () => deleteHost(host);
    list.appendChild(card);
  });
}

async function copyHost(host) {
  const newName = prompt(`Enter a name for the copy of "${host.name}":`, host.name + " (copy)");
  if (!newName) return;
  const copy = {
    name: newName.trim(),
    hostname: host.hostname,
    port: host.port,
    username: host.username,
    auth_method: host.auth_method,
    identity_file: host.identity_file || null,
    jump_enabled: host.jump_enabled || false,
    jump_hostname: host.jump_hostname || null,
    jump_port: host.jump_port || 22,
    jump_username: host.jump_username || null,
    jump_auth_method: host.jump_auth_method || "identity_file",
    jump_identity_file: host.jump_identity_file || null,
    jump_alias: host.jump_alias || null,
    commands: host.commands || [],
    poll_interval_seconds: host.poll_interval_seconds || 43200,
    auto_poll_enabled: false,
  };
  try {
    await api("/api/hosts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(copy),
    });
    await loadAll();
    loadOverviewDashboard();
  } catch (err) {
    alert("Failed to copy host: " + err.message);
  }
}

async function deleteHost(host) {
  if (!confirm(`Delete host "${host.name}" and all its collected data?`)) return;
  await api(`/api/hosts/${host.id}`, { method: "DELETE" });
  await loadAll();
  loadOverviewDashboard();
}

// ========== Operations page (Page 2) ==========

$("btnBack").addEventListener("click", () => {
  showHostsPage();
  loadAll().then(() => loadOverviewDashboard());
});

$("btnTest").addEventListener("click", async () => {
  const host = hosts.find(h => h.id === currentOpsHostId);
  if (!host) return;
  const statusEl = $("opsStatus");
  $("btnTest").disabled = true;
  statusEl.textContent = "Testing…";
  statusEl.className = "ops-status";
  try {
    const result = await api(`/api/hosts/${host.id}/test`, { method: "POST" });
    statusEl.textContent = result.message;
    statusEl.className = "ops-status " + (result.ok ? "ok" : "err");
  } catch (err) {
    statusEl.textContent = "Request failed: " + err.message;
    statusEl.className = "ops-status err";
  } finally {
    $("btnTest").disabled = false;
  }
});

$("btnCollect").addEventListener("click", () => {
  const host = hosts.find(h => h.id === currentOpsHostId);
  if (!host) return;
  const statusEl = $("opsStatus");
  const progressEl = $("collectProgress");
  const barFill = $("progressBarFill");
  const stepsEl = $("progressSteps");

  $("btnCollect").disabled = true;
  statusEl.textContent = "";
  statusEl.className = "ops-status";
  progressEl.style.display = "";
  barFill.style.width = "0%";
  stepsEl.innerHTML = "";

  const stepMessages = [];
  function addStep(msg, state) { stepMessages.push({ msg, state }); renderSteps(); }
  function updateLastStep(msg, state) {
    if (stepMessages.length) { stepMessages[stepMessages.length - 1].msg = msg; stepMessages[stepMessages.length - 1].state = state; }
    renderSteps();
  }
  function renderSteps() {
    stepsEl.innerHTML = stepMessages.map(s => {
      const icon = s.state === "done" ? "&#10003;" : s.state === "error" ? "&#10007;" : "&#8943;";
      return `<div class="progress-step ${s.state}"><span class="step-icon">${icon}</span>${escapeHtml(s.msg)}</div>`;
    }).join("");
  }

  const es = new EventSource(`/api/hosts/${host.id}/collect-stream`);

  es.addEventListener("progress", (e) => {
    const data = JSON.parse(e.data);
    const pct = Math.round((data.step / data.total) * 100);
    barFill.style.width = pct + "%";
    if (stepMessages.length && stepMessages[stepMessages.length - 1].state === "active") {
      updateLastStep(stepMessages[stepMessages.length - 1].msg, "done");
    }
    addStep(data.message, "active");
  });

  es.addEventListener("done", (e) => {
    es.close();
    const snapshot = JSON.parse(e.data);
    barFill.style.width = "100%";
    if (stepMessages.length && stepMessages[stepMessages.length - 1].state === "active") {
      updateLastStep(stepMessages[stepMessages.length - 1].msg, "done");
    }
    if (snapshot.error) {
      addStep("Error: " + snapshot.error, "error");
      statusEl.textContent = "Collection failed: " + snapshot.error;
      statusEl.className = "ops-status err";
    } else {
      addStep("Done — snapshot saved", "done");
      statusEl.textContent = "Collection complete at " + fmtDate(snapshot.collected_at);
      statusEl.className = "ops-status ok";
    }
    snapshotCounts[host.id] = (snapshotCounts[host.id] || 0) + 1;
    // Reload snapshots and auto-select the new one
    loadSnapshots(host.id, snapshot.error ? null : snapshot.collected_at);
    $("btnCollect").disabled = false;
    setTimeout(() => { progressEl.style.display = "none"; }, 6000);
  });

  es.onerror = () => {
    es.close();
    if (stepMessages.length && stepMessages[stepMessages.length - 1].state === "active") {
      updateLastStep(stepMessages[stepMessages.length - 1].msg, "error");
    }
    statusEl.textContent = "Collection stream failed — connection lost";
    statusEl.className = "ops-status err";
    $("btnCollect").disabled = false;
  };
});

$("btnAutoPoll").addEventListener("click", async () => {
  const host = hosts.find(h => h.id === currentOpsHostId);
  if (!host) return;
  const statusEl = $("opsStatus");
  const next = !host.auto_poll_enabled;
  $("btnAutoPoll").disabled = true;
  try {
    await api(`/api/hosts/${host.id}/autopoll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    host.auto_poll_enabled = next;
    statusEl.textContent = next
      ? `Auto-poll started — collecting every ${host.poll_interval_seconds || 300}s while the server runs`
      : "Auto-poll stopped";
    statusEl.className = "ops-status ok";
    renderOpsButtons(host);
  } catch (err) {
    statusEl.textContent = "Request failed: " + err.message;
    statusEl.className = "ops-status err";
  } finally {
    $("btnAutoPoll").disabled = false;
  }
});

// ========== Snapshot browser ==========

async function loadSnapshots(hostId, autoSelectTimestamp) {
  const sel = $("snapshotSelect");
  sel.innerHTML = '<option value="">Loading snapshots…</option>';
  sel.disabled = true;
  $("btnDeleteSnapshot").style.display = "none";
  $("snapshotEmpty").textContent = "Loading snapshots…";
  $("snapshotEmpty").style.display = "";
  try {
    const res = await api(`/api/hosts/${hostId}/snapshots`);
    const snaps = res.snapshots || [];
    sel.innerHTML = '<option value="">Select a snapshot…</option>';
    sel.disabled = false;
    if (!snaps.length) {
      $("snapshotEmpty").textContent = "No snapshots collected yet. Click \"Collect now\" above to gather data.";
      $("snapshotEmpty").style.display = "";
      $("snapshotDetail").style.display = "none";
      return;
    }
    snaps.slice().reverse().forEach(s => {
      const opt = document.createElement("option");
      opt.value = s.collected_at;
      opt.textContent = `${fmtDate(s.collected_at)} — ${s.user_count} user${s.user_count !== 1 ? "s" : ""}, ${s.session_count} session${s.session_count !== 1 ? "s" : ""}, load ${s.load_1m}`;
      sel.appendChild(opt);
    });
    $("snapshotEmpty").style.display = "none";

    if (autoSelectTimestamp) {
      sel.value = autoSelectTimestamp;
      sel.dispatchEvent(new Event("change"));
    }
  } catch (err) {
    $("snapshotEmpty").textContent = "Failed to load snapshots: " + err.message;
    $("snapshotEmpty").style.display = "";
  }
}

$("snapshotSelect").addEventListener("change", async (e) => {
  const collected_at = e.target.value;
  $("btnDeleteSnapshot").style.display = collected_at ? "" : "none";
  if (!collected_at || !currentOpsHostId) {
    $("snapshotDetail").style.display = "none";
    $("snapshotEmpty").textContent = "Select a snapshot above to view details.";
    $("snapshotEmpty").style.display = "";
    $("dashboardPanel").style.display = "none";
    return;
  }
  $("snapshotEmpty").innerHTML = '<span class="loading-spinner"></span> Loading snapshot…';
  $("snapshotEmpty").style.display = "";
  $("snapshotDetail").style.display = "none";
  try {
    const detail = await api(`/api/hosts/${currentOpsHostId}/snapshot/${encodeURIComponent(collected_at)}`);
    renderSnapshotDetail(detail);
    // Show trends panel and load in background (non-blocking)
    $("dashboardPanel").style.display = "";
    loadAndRenderDashboard(currentOpsHostId);
  } catch (err) {
    $("snapshotEmpty").textContent = "Failed to load snapshot: " + err.message;
  }
});

$("btnDeleteSnapshot").addEventListener("click", async () => {
  const sel = $("snapshotSelect");
  const collected_at = sel.value;
  if (!collected_at || !currentOpsHostId) return;
  if (!confirm(`Delete snapshot from ${fmtDate(collected_at)}?`)) return;

  // Remove from combo box immediately for instant feedback
  const deletedIdx = sel.selectedIndex;
  sel.remove(deletedIdx);
  $("btnDeleteSnapshot").style.display = "none";
  $("snapshotDetail").style.display = "none";
  $("opsStatus").textContent = "Snapshot deleted";
  $("opsStatus").className = "ops-status ok";

  // Auto-select next available snapshot
  if (sel.options.length > 1) {
    sel.selectedIndex = Math.min(deletedIdx, sel.options.length - 1);
    if (sel.selectedIndex === 0 && sel.options.length > 1) sel.selectedIndex = 1;
    sel.dispatchEvent(new Event("change"));
  } else {
    $("dashboardPanel").style.display = "none";
    $("snapshotEmpty").textContent = "No snapshots remaining.";
    $("snapshotEmpty").style.display = "";
  }

  // Fire the API delete in background — server writes to disk async too
  try {
    await api(`/api/hosts/${currentOpsHostId}/snapshot/${encodeURIComponent(collected_at)}`, { method: "DELETE" });
  } catch (err) {
    $("opsStatus").textContent = "Delete may have failed: " + err.message;
    $("opsStatus").className = "ops-status err";
    loadSnapshots(currentOpsHostId);
  }
});

function renderSnapshotDetail(detail) {
  $("snapshotEmpty").style.display = "none";
  $("snapshotDetail").style.display = "";

  const u = detail.uptime;
  const sessions = detail.who_sessions;
  const lastRecs = detail.last_records || [];
  const distinctWho = [...new Set(sessions.map(s => s.user))];
  const distinctLast = [...new Set(lastRecs.map(r => r.user))];
  const stillIn = lastRecs.filter(r => r.still_logged_in);
  const totalHours = Math.round(lastRecs.reduce((s, r) => s + r.duration_min, 0) / 60 * 10) / 10;

  // Stat cards
  $("snapStatCards").innerHTML = [
    { label: "Users (login history)", value: distinctLast.length, sub: distinctLast.slice(0, 5).join(", ") || "—" },
    { label: "Login sessions", value: lastRecs.length, sub: `${stillIn.length} still logged in` },
    { label: "Total time spent", value: totalHours + "h", sub: "Across all users and sessions" },
    { label: "Load average", value: `${u.load_1m} / ${u.load_5m} / ${u.load_15m}`, sub: "1 min / 5 min / 15 min" },
  ].map(c => `
    <div class="stat-card">
      <div class="stat-label">${escapeHtml(c.label)}</div>
      <div class="stat-value">${escapeHtml(String(c.value))}</div>
      <div class="stat-sub">${escapeHtml(c.sub)}</div>
    </div>`).join("");

  // Hours-per-user bar chart from `last`
  const userHours = {};
  lastRecs.forEach(r => { userHours[r.user] = (userHours[r.user] || 0) + r.duration_min; });
  const userLabels = Object.keys(userHours).sort((a, b) => userHours[b] - userHours[a]);
  const userValues = userLabels.map(u => Math.round(userHours[u] / 60 * 10) / 10);
  const barColors = userLabels.map((_, i) => resolvedColor(SERIES_COLORS[i % SERIES_COLORS.length]));

  destroyExistingChart($("snapSessionsChart"));
  if (userLabels.length > 0) {
    $("snapSessionsChart").parentElement.parentElement.style.display = "";
    $("snapSessionsChart").parentElement.style.height = Math.max(120, userLabels.length * 36) + "px";
    snapSessionsChart = new Chart($("snapSessionsChart").getContext("2d"), {
      type: "bar",
      data: {
        labels: userLabels,
        datasets: [{
          label: "Hours",
          data: userValues,
          backgroundColor: barColors,
          borderRadius: 4,
          barThickness: 22,
        }],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { beginAtZero: true, grid: { color: getCssVar("--gridline") }, ticks: { color: getCssVar("--text-muted") }, title: { display: true, text: "Hours", color: getCssVar("--text-muted") } },
          y: { grid: { display: false }, ticks: { color: getCssVar("--text-secondary"), font: { size: 12 } } },
        },
        plugins: { legend: { display: false } },
      },
    });
  } else {
    $("snapSessionsChart").parentElement.parentElement.style.display = "none";
  }

  // Login history table from `last`
  const tbody = document.querySelector("#snapUserTable tbody");
  if (lastRecs.length > 0) {
    tbody.innerHTML = lastRecs.slice(0, 100).map(r => {
      const dur = r.duration_min >= 60
        ? Math.floor(r.duration_min / 60) + "h " + (r.duration_min % 60) + "m"
        : r.duration_min + "m";
      const status = r.still_logged_in ? '<span style="color:var(--good);font-weight:600">active</span>' : dur;
      return `<tr>
        <td><strong>${escapeHtml(r.user)}</strong></td>
        <td class="mono">${escapeHtml(r.login_dt ? r.login_dt.slice(5, 16).replace("T", " ") : "")}</td>
        <td class="mono">${r.still_logged_in ? "—" : escapeHtml(r.logout_dt ? r.logout_dt.slice(5, 16).replace("T", " ") : "")}</td>
        <td class="mono">${status}</td>
        <td class="mono">${escapeHtml(truncate(r.source, 30))}</td>
      </tr>`;
    }).join("");
  } else if (sessions.length > 0) {
    tbody.innerHTML = sessions.map(s => `
      <tr>
        <td><strong>${escapeHtml(s.user)}</strong></td>
        <td class="mono">${escapeHtml(s.login_time)}</td>
        <td class="mono">—</td>
        <td class="mono">—</td>
        <td class="mono">${escapeHtml(truncate(s.source, 30))}</td>
      </tr>`).join("");
  } else {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No login history available</td></tr>';
  }

  // Raw output
  const extraKeys = Object.keys(detail.extra_command_outputs || {});
  $("snapRawOutput").innerHTML = `
    <h4>who</h4><pre>${escapeHtml(detail.who_raw || "(empty)")}</pre>
    <h4>uptime</h4><pre>${escapeHtml(detail.uptime_raw || "(empty)")}</pre>
    ${detail.last_raw ? `<h4>last (login history)</h4><pre>${escapeHtml(detail.last_raw.slice(0, 5000))}${detail.last_raw.length > 5000 ? "\n… (truncated)" : ""}</pre>` : ""}
    ${extraKeys.map(k => `<h4>${escapeHtml(k)}</h4><pre>${escapeHtml(detail.extra_command_outputs[k])}</pre>`).join("")}
  `;
}

// ========== Historical trends ==========

document.querySelectorAll(".range-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    currentRange = btn.dataset.range;
    document.querySelectorAll(".range-btn").forEach(b => b.classList.toggle("active", b === btn));
    if (currentOpsHostId && $("dashboardPanel").style.display !== "none") {
      loadAndRenderDashboard(currentOpsHostId);
    }
  });
});
document.querySelector(`.range-btn[data-range="${currentRange}"]`).classList.add("active");

async function loadAndRenderDashboard(hostId) {
  if (!hostId) return;
  $("dashboardEmpty").textContent = "Loading trends…";
  $("dashboardEmpty").style.display = "";
  $("dashboardContent").style.display = "none";
  try {
    const history = await api(`/api/hosts/${hostId}/history?range=${currentRange}`);
    currentHistory = history;
    if (!history.snapshot_count) {
      $("dashboardEmpty").textContent = `No data collected yet for ${RANGE_LABELS[currentRange]}.`;
      return;
    }
    $("dashboardEmpty").style.display = "none";
    $("dashboardContent").style.display = "";
    renderTrends(history);
  } catch (err) {
    $("dashboardEmpty").textContent = "Failed to load history: " + err.message;
  }
}

function renderTrends(history) {
  renderTrendStatCards(history);
  renderUsersChart(history.daily);
  renderLoadChart(history.daily);
  renderHeatmap(history.heatmap);
  renderUserSummaryTable(history.user_summary);
}

function renderTrendStatCards(history) {
  const cards = [
    { label: "Snapshots in range", value: history.snapshot_count, sub: `${history.range_start.slice(0, 10)} → ${history.range_end.slice(0, 10)}` },
    { label: "Distinct users", value: history.distinct_users.length, sub: history.distinct_users.slice(0, 6).join(", ") || "—" },
    { label: "Busiest day", value: history.busiest_day || "—", sub: history.busiest_day ? `${history.busiest_day_users} user${history.busiest_day_users !== 1 ? "s" : ""} logged in` : "" },
  ];
  $("trendStatCards").innerHTML = cards.map(c => `
    <div class="stat-card">
      <div class="stat-label">${escapeHtml(c.label)}</div>
      <div class="stat-value">${escapeHtml(String(c.value))}</div>
      <div class="stat-sub">${escapeHtml(c.sub)}</div>
    </div>`).join("");
}

function renderUsersChart(daily) {
  destroyExistingChart($("usersChart"));
  const ctx = $("usersChart").getContext("2d");
  usersChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: daily.map(d => d.date),
      datasets: [{
        label: "Logged-in users",
        data: daily.map(d => d.logged_in_users),
        borderColor: resolvedColor("var(--series-1)"),
        backgroundColor: resolvedColor("var(--series-1)") + "22",
        fill: true, tension: 0.3, borderWidth: 2, pointRadius: 4,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { grid: { color: getCssVar("--gridline") }, ticks: { color: getCssVar("--text-muted") } },
        y: { beginAtZero: true, grid: { color: getCssVar("--gridline") }, ticks: { color: getCssVar("--text-muted"), precision: 0 } },
      },
      plugins: { legend: { display: false } },
    },
  });
  $("usersChart").parentElement.style.height = "240px";
}

function renderLoadChart(daily) {
  destroyExistingChart($("loadChart"));
  const ctx = $("loadChart").getContext("2d");
  loadChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: daily.map(d => d.date),
      datasets: [
        { label: "1 min avg", data: daily.map(d => d.avg_load_1m), borderColor: resolvedColor("var(--series-2)"), backgroundColor: resolvedColor("var(--series-2)"), tension: 0.3, borderWidth: 2, pointRadius: 3 },
        { label: "5 min avg", data: daily.map(d => d.avg_load_5m), borderColor: resolvedColor("var(--series-3)"), backgroundColor: resolvedColor("var(--series-3)"), tension: 0.3, borderWidth: 2, pointRadius: 3 },
        { label: "15 min avg", data: daily.map(d => d.avg_load_15m), borderColor: resolvedColor("var(--series-4)"), backgroundColor: resolvedColor("var(--series-4)"), tension: 0.3, borderWidth: 2, pointRadius: 3 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { grid: { color: getCssVar("--gridline") }, ticks: { color: getCssVar("--text-muted") } },
        y: { beginAtZero: true, grid: { color: getCssVar("--gridline") }, ticks: { color: getCssVar("--text-muted") } },
      },
      plugins: { legend: { position: "top", labels: { color: getCssVar("--text-secondary") } } },
    },
  });
  $("loadChart").parentElement.style.height = "240px";
}

function renderHeatmap(heatmap) {
  const wrap = $("heatmapWrap");
  const dates = heatmap.dates;
  const maxCount = heatmap.max_count || 1;
  const cellByKey = new Map(heatmap.cells.map(c => [`${c.date}:${c.hour}`, c.count]));
  let html = '<table class="heatmap-table"><thead><tr><th></th>';
  for (let h = 0; h < 24; h++) html += `<th>${h}</th>`;
  html += "</tr></thead><tbody>";
  dates.forEach(date => {
    html += `<tr><td class="heatmap-row-label">${escapeHtml(date)}</td>`;
    for (let h = 0; h < 24; h++) {
      const count = cellByKey.get(`${date}:${h}`) || 0;
      const color = heatColor(count, maxCount);
      html += `<td><div class="heatmap-cell" style="background:${color}" title="${escapeHtml(date)} ${h}:00 — ${count} user${count !== 1 ? "s" : ""}"></div></td>`;
    }
    html += "</tr>";
  });
  html += "</tbody></table>";
  wrap.innerHTML = dates.length ? html : '<p class="empty-state">No activity data in this range.</p>';
  const legend = $("heatmapLegend");
  const steps = [0, 0.25, 0.5, 0.75, 1];
  legend.innerHTML = "Low " + steps.map(f =>
    `<span class="heatmap-scale-swatch" style="background:${heatColor(Math.round(f * maxCount), maxCount)}"></span>`
  ).join("") + " High";
}

function heatColor(count, maxCount) {
  if (count === 0) return getCssVar("--gridline");
  const ratio = Math.min(1, count / maxCount);
  const idx = Math.min(SEQ_STEPS.length - 1, Math.floor(ratio * (SEQ_STEPS.length - 1)));
  return getCssVar(SEQ_STEPS[idx]);
}

function renderUserSummaryTable(summary) {
  $("userSummaryNote").textContent = `${summary.length} user${summary.length !== 1 ? "s" : ""} in ${RANGE_LABELS[currentRange]}`;
  const tbody = document.querySelector("#userSummaryTable tbody");
  tbody.innerHTML = summary.map(u => `
    <tr>
      <td><strong>${escapeHtml(u.user)}</strong>${u.still_logged_in ? ' <span style="color:var(--good);font-size:10px;font-weight:600">ACTIVE</span>' : ""}</td>
      <td class="mono">${escapeHtml(u.first_seen)}</td>
      <td class="mono">${escapeHtml(u.last_seen)}</td>
      <td class="mono">${u.days_active}</td>
      <td class="mono">${u.total_sessions}</td>
      <td class="mono">${u.total_hours}</td>
      <td class="mono">${escapeHtml(truncate(u.sources.join(", "), 50))}</td>
    </tr>`).join("") || '<tr><td colspan="7" class="empty-state">No users found</td></tr>';
}

// ========== Theme toggle ==========

$("themeToggle").addEventListener("click", () => {
  const html = document.documentElement;
  const next = html.getAttribute("data-theme") === "dark" ? "light" : "dark";
  html.setAttribute("data-theme", next);
  $("themeToggle").textContent = next === "dark" ? "Light mode" : "Dark mode";
  if (currentHistory && $("dashboardPanel").style.display !== "none") renderTrends(currentHistory);
});

// ========== Overview Dashboard (Page 1) ==========

let overviewRange = "30d";
let overviewCharts = [];

document.querySelectorAll(".overview-range-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    overviewRange = btn.dataset.range;
    document.querySelectorAll(".overview-range-btn").forEach(b => b.classList.toggle("active", b === btn));
    loadOverviewDashboard();
  });
});
document.querySelector(`.overview-range-btn[data-range="${overviewRange}"]`).classList.add("active");

async function loadOverviewDashboard() {
  const section = $("overviewSection");
  if (!hosts.length) { section.style.display = "none"; return; }
  section.style.display = "";
  $("overviewLoading").style.display = "";
  $("overviewGrid").innerHTML = "";
  overviewCharts.forEach(c => c.destroy());
  overviewCharts = [];

  try {
    const data = await api(`/api/dashboard?range=${overviewRange}`);
    $("overviewLoading").style.display = "none";
    renderOverviewGrid(data.hosts);
  } catch (err) {
    $("overviewLoading").textContent = "Failed to load dashboard: " + err.message;
  }
}

function renderOverviewGrid(hostData) {
  const grid = $("overviewGrid");
  grid.innerHTML = "";

  hostData.forEach((h, idx) => {
    const card = document.createElement("div");
    card.className = "overview-card panel";
    const canvasId = `overviewChart_${idx}`;
    const periodLine = `<div class="overview-collected">Data: ${h.range_start.slice(0, 10)} to ${h.range_end.slice(0, 10)}${h.last_collected ? " · Collected: " + fmtDate(h.last_collected) : ""}</div>`;

    card.style.cursor = "pointer";
    card.addEventListener("click", () => showOpsPage(h.host_id));

    if (!h.user_summary.length) {
      card.innerHTML = `
        <div class="overview-card-header">
          <h3>${escapeHtml(h.name)}</h3>
          <span class="muted-note">${escapeHtml(h.hostname)}</span>
        </div>
        ${periodLine}
        <div class="overview-card-stat">
          <span class="stat-value">0h</span>
          <span class="stat-sub">No activity in ${RANGE_LABELS[overviewRange]}</span>
        </div>
        <div class="overview-empty">No login data — click to open</div>
      `;
      grid.appendChild(card);
      return;
    }

    const users = h.user_summary;
    const userLabels = users.map(u => u.user);
    const userHours = users.map(u => u.total_hours);
    const colors = users.map((_, i) => resolvedColor(SERIES_COLORS[i % SERIES_COLORS.length]));

    card.innerHTML = `
      <div class="overview-card-header">
        <h3>${escapeHtml(h.name)}</h3>
        <span class="muted-note">${escapeHtml(h.hostname)}</span>
      </div>
      ${periodLine}
      <div class="overview-card-stat">
        <span class="stat-value">${h.total_hours}h</span>
        <span class="stat-sub">${h.distinct_users.length} user${h.distinct_users.length !== 1 ? "s" : ""} · ${h.snapshot_count} snapshot${h.snapshot_count !== 1 ? "s" : ""}</span>
      </div>
      <div class="overview-chart-wrap"><canvas id="${canvasId}"></canvas></div>
      <div class="overview-legend" id="legend_${idx}"></div>
    `;
    grid.appendChild(card);

    const ctx = document.getElementById(canvasId).getContext("2d");
    const chart = new Chart(ctx, {
      type: "doughnut",
      data: {
        labels: userLabels,
        datasets: [{
          data: userHours,
          backgroundColor: colors,
          borderWidth: 2,
          borderColor: getCssVar("--surface-1"),
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        cutout: "60%",
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label(ctx) { return `${ctx.label}: ${ctx.parsed}h`; },
            },
          },
        },
      },
    });
    overviewCharts.push(chart);

    const legendEl = document.getElementById(`legend_${idx}`);
    legendEl.innerHTML = users.map((u, i) =>
      `<span class="overview-legend-item"><span class="legend-swatch" style="background:${colors[i]}"></span>${escapeHtml(u.user)} (${u.total_hours}h)</span>`
    ).join("");
  });
}

// ========== Init ==========

showHostsPage();
loadAll().then(() => {
  loadOverviewDashboard();
}).catch(err => {
  console.error(err);
  $("hostList").innerHTML = '<p class="empty-state">Failed to load data: ' + escapeHtml(err.message) + "</p>";
});
