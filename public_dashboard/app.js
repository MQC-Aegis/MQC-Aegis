const incidentList = document.getElementById("incidentList");
const actionList = document.getElementById("actionList");
const incidentCount = document.getElementById("incidentCount");
const actionCount = document.getElementById("actionCount");
const engineState = document.getElementById("engineState");
const engineMeta = document.getElementById("engineMeta");
const phaseLabel = document.getElementById("phaseLabel");
const refreshBtn = document.getElementById("refreshBtn");
const decisionState = document.getElementById("decisionState");
const decisionMeta = document.getElementById("decisionMeta");
const socketStatus = document.getElementById("socketStatus");
const liveDot = document.getElementById("liveDot");

const totalIncidents = document.getElementById("totalIncidents");
const totalActions = document.getElementById("totalActions");
const totalEvents = document.getElementById("totalEvents");
const severitySummary = document.getElementById("severitySummary");
const actionSummary = document.getElementById("actionSummary");
const trendSummary = document.getElementById("trendSummary");
const correlationSummary = document.getElementById("correlationSummary");
const latestIncidentSummary = document.getElementById("latestIncidentSummary");
const latestActionSummary = document.getElementById("latestActionSummary");

function severityClass(severity) {
  if (!severity) return "low";
  const s = severity.toLowerCase();
  if (s === "critical") return "critical";
  if (s === "high") return "high";
  if (s === "medium") return "medium";
  return "low";
}

function trendClass(label) {
  if (!label) return "trend-normal";
  if (label === "spike") return "trend-spike";
  if (label === "elevated") return "trend-elevated";
  return "trend-normal";
}

function correlationClass(label) {
  if (!label) return "corr-none";
  if (label === "critical_chain") return "corr-critical_chain";
  if (label === "multi_signal") return "corr-multi_signal";
  return "corr-none";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso || "—";
  }
}

function renderReasonCodes(reasonCodes = []) {
  if (!reasonCodes.length) return `<div class="muted">No reason codes.</div>`;

  return `
    <div class="reason-list">
      ${reasonCodes.map((code) => `<span class="reason-chip">${escapeHtml(code)}</span>`).join("")}
    </div>
  `;
}

function renderSummaryBlock(container, entries) {
  if (!entries.length) {
    container.innerHTML = `<div class="muted">No data.</div>`;
    return;
  }

  container.innerHTML = entries.map(([label, value]) => `
    <div class="summary-line">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `).join("");
}

function renderLatestBox(container, item, type) {
  if (!item) {
    container.innerHTML = `<div class="muted">No recent ${escapeHtml(type)}.</div>`;
    return;
  }

  const lines = type === "incident"
    ? [
        ["type", item.type],
        ["user", item.user],
        ["action", item.action],
        ["risk", item.riskScore],
        ["time", formatDate(item.createdAt)]
      ]
    : [
        ["type", item.type],
        ["user", item.user],
        ["action", item.action],
        ["severity", item.severity],
        ["time", formatDate(item.createdAt)]
      ];

  renderSummaryBlock(container, lines);
}

function renderIncidents(items) {
  incidentCount.textContent = String(items.length);

  if (!items.length) {
    incidentList.innerHTML = `
      <div class="empty">
        No incidents yet. Post to <code>/event</code> and they will appear here live.
      </div>
    `;
    return;
  }

  incidentList.innerHTML = items.map((item) => `
    <div class="incident">
      <div class="incident-top">
        <div class="incident-title">
          ${escapeHtml(item.type)} · ${escapeHtml(item.user)}
        </div>
        <div class="badges">
          <span class="badge ${severityClass(item.severity)}">${escapeHtml(item.severity)}</span>
          <span class="badge ${severityClass(item.severity)}">${escapeHtml(item.action)}</span>
          <span class="badge ${severityClass(item.severity)}">risk ${escapeHtml(item.riskScore)}</span>
        </div>
      </div>

      <div class="badges" style="margin-bottom:10px;">
        <span class="badge ${trendClass(item.trendLabel)}">trend ${escapeHtml(item.trendLabel || "normal")}</span>
        <span class="badge ${correlationClass(item.correlationLabel)}">correlation ${escapeHtml(item.correlationLabel || "none")}</span>
      </div>

      <div class="muted">${escapeHtml(item.reason || "No reason provided.")}</div>

      <div class="row">
        <div class="meta">
          <span class="meta-label">Status</span>
          <div class="meta-value">${escapeHtml(item.status)}</div>
        </div>

        <div class="meta">
          <span class="meta-label">IP</span>
          <div class="meta-value">${escapeHtml(item.ip)}</div>
        </div>

        <div class="meta">
          <span class="meta-label">Created</span>
          <div class="meta-value">${escapeHtml(formatDate(item.createdAt))}</div>
        </div>

        <div class="meta">
          <span class="meta-label">Amount</span>
          <div class="meta-value">${escapeHtml(item.amount)}</div>
        </div>

        <div class="meta">
          <span class="meta-label">Attempts</span>
          <div class="meta-value">${escapeHtml(item.attempts)}</div>
        </div>

        <div class="meta">
          <span class="meta-label">Flags</span>
          <div class="meta-value">
            geoMismatch=${escapeHtml(item.geoMismatch)} · velocitySpike=${escapeHtml(item.velocitySpike)}
          </div>
        </div>
      </div>

      ${renderReasonCodes(item.reasonCodes || [])}
    </div>
  `).join("");
}

function renderActions(items) {
  actionCount.textContent = String(items.length);

  if (!items.length) {
    actionList.innerHTML = `
      <div class="empty">
        No actions yet. Decisions will appear here live.
      </div>
    `;
    return;
  }

  actionList.innerHTML = items.map((item) => `
    <div class="action-item">
      <div class="action-top">
        <div class="action-title">
          ${escapeHtml(item.action)} · ${escapeHtml(item.user)}
        </div>
        <div class="badges">
          <span class="badge ${severityClass(item.severity)}">${escapeHtml(item.severity)}</span>
          <span class="badge ${severityClass(item.severity)}">${escapeHtml(item.type)}</span>
          <span class="badge ${severityClass(item.severity)}">risk ${escapeHtml(item.riskScore)}</span>
        </div>
      </div>

      <div class="badges" style="margin-bottom:10px;">
        <span class="badge ${trendClass(item.trendLabel)}">trend ${escapeHtml(item.trendLabel || "normal")}</span>
        <span class="badge ${correlationClass(item.correlationLabel)}">correlation ${escapeHtml(item.correlationLabel || "none")}</span>
      </div>

      <div class="muted">${escapeHtml(item.reason || "No reason provided.")}</div>

      <div class="row">
        <div class="meta">
          <span class="meta-label">Status</span>
          <div class="meta-value">${escapeHtml(item.status)}</div>
        </div>

        <div class="meta">
          <span class="meta-label">Incident ID</span>
          <div class="meta-value">${escapeHtml(item.incidentId)}</div>
        </div>

        <div class="meta">
          <span class="meta-label">Created</span>
          <div class="meta-value">${escapeHtml(formatDate(item.createdAt))}</div>
        </div>
      </div>
    </div>
  `).join("");
}

function updateDecisionPosture(incidents, actions) {
  if (!incidents.length && !actions.length) {
    decisionState.textContent = "Monitoring";
    decisionMeta.textContent = "No recent actions. Engine is waiting for new events.";
    return;
  }

  const latestAction = actions[0];
  if (!latestAction) {
    decisionState.textContent = "Tracking";
    decisionMeta.textContent = "Incidents exist, but no action feed is available yet.";
    return;
  }

  decisionState.textContent = latestAction.action;
  decisionMeta.textContent =
    `Latest action: ${latestAction.action} on ${latestAction.type} for ${latestAction.user} ` +
    `with risk ${latestAction.riskScore}, trend ${latestAction.trendLabel || "normal"}, ` +
    `correlation ${latestAction.correlationLabel || "none"}.`;
}

function renderSummary(summary) {
  totalIncidents.textContent = String(summary?.totals?.incidents ?? 0);
  totalActions.textContent = String(summary?.totals?.actions ?? 0);
  totalEvents.textContent = String(summary?.totals?.events ?? 0);

  renderSummaryBlock(severitySummary, Object.entries(summary?.severity || {}));
  renderSummaryBlock(actionSummary, Object.entries(summary?.actions || {}));
  renderSummaryBlock(trendSummary, Object.entries(summary?.trends || {}));
  renderSummaryBlock(correlationSummary, Object.entries(summary?.correlations || {}));
  renderLatestBox(latestIncidentSummary, summary?.latest?.incident || null, "incident");
  renderLatestBox(latestActionSummary, summary?.latest?.action || null, "action");
}

function renderAll(incidents, actions, summary = null) {
  renderIncidents(incidents || []);
  renderActions(actions || []);
  updateDecisionPosture(incidents || [], actions || []);
  if (summary) renderSummary(summary);
  engineState.textContent = "Running";
  engineMeta.textContent = `Phase D4.1 · ${incidents.length} incidents · ${actions.length} actions`;
}

async function loadInitialData() {
  const [healthRes, incidentsRes, actionsRes, summaryRes] = await Promise.all([
    fetch("/health"),
    fetch("/api/incidents"),
    fetch("/api/actions"),
    fetch("/api/summary")
  ]);

  const health = await healthRes.json();
  const incidentData = await incidentsRes.json();
  const actionData = await actionsRes.json();
  const summaryData = await summaryRes.json();

  phaseLabel.textContent = health.phase || "D4";
  engineState.textContent = health.ok ? "Running" : "Stopped";
  engineMeta.textContent = `Phase ${health.phase || "?"} · ${health.incidents ?? 0} incidents · ${health.actions ?? 0} actions`;
  renderAll(incidentData.incidents || [], actionData.actions || [], summaryData);
}

function connectSocket() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${window.location.host}`);

  ws.addEventListener("open", () => {
    socketStatus.textContent = "socket live";
    liveDot.classList.add("on");
  });

  ws.addEventListener("close", () => {
    socketStatus.textContent = "socket offline";
    liveDot.classList.remove("on");
    setTimeout(connectSocket, 1500);
  });

  ws.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);

      if (payload.type === "bootstrap") {
        renderAll(payload.incidents || [], payload.actions || []);
        return;
      }

      if (payload.type === "event_processed") {
        renderAll(payload.incidents || [], payload.actions || [], payload.summary || null);
      }
    } catch (err) {
      console.error("WebSocket parse error:", err);
    }
  });

  ws.addEventListener("error", () => {
    socketStatus.textContent = "socket error";
    liveDot.classList.remove("on");
  });
}

refreshBtn.addEventListener("click", () => {
  loadInitialData().catch((err) => {
    engineState.textContent = "Error";
    engineMeta.textContent = err.message || "Manual refresh failed.";
  });
});

loadInitialData().catch((err) => {
  engineState.textContent = "Error";
  engineMeta.textContent = err.message || "Could not load initial dashboard data.";
});

connectSocket();
