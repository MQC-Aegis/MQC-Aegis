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
const demoStatus = document.getElementById("demoStatus");
const severityFilter = document.getElementById("severityFilter");
const actionFilter = document.getElementById("actionFilter");
const typeFilter = document.getElementById("typeFilter");
const resetFiltersBtn = document.getElementById("resetFiltersBtn");
const clearDemoBtn = document.getElementById("clearDemoBtn");
const execPhase = document.getElementById("execPhase");
const execVisibleIncidents = document.getElementById("execVisibleIncidents");
const execVisibleActions = document.getElementById("execVisibleActions");
const execPosture = document.getElementById("execPosture");
const execPostureCopy = document.getElementById("execPostureCopy");
const execPressure = document.getElementById("execPressure");
const execPressureCopy = document.getElementById("execPressureCopy");
const execRecommendation = document.getElementById("execRecommendation");
const execRecommendationCopy = document.getElementById("execRecommendationCopy");
const execWhy = document.getElementById("execWhy");

let lastIncidentId = null;
let lastActionId = null;
let socketRef = null;

let currentIncidents = [];
let currentActions = [];
let currentSummary = null;

function getActiveFilters() {
  return {
    severity: severityFilter?.value || "all",
    action: actionFilter?.value || "all",
    type: typeFilter?.value || "all"
  };
}

function matchesFilters(item, filters) {
  if (filters.severity !== "all" && String(item.severity || "").toLowerCase() !== filters.severity) {
    return false;
  }
  if (filters.action !== "all" && String(item.action || "").toLowerCase() !== filters.action) {
    return false;
  }
  if (filters.type !== "all" && String(item.type || "").toLowerCase() !== filters.type) {
    return false;
  }
  return true;
}

function getFilteredData() {
  const filters = getActiveFilters();
  return {
    incidents: currentIncidents.filter((item) => matchesFilters(item, filters)),
    actions: currentActions.filter((item) => matchesFilters(item, filters))
  };
}


function setExecValueClass(el, baseId, level) {
  if (!el) return;
  el.classList.remove("exec-posture-critical", "exec-posture-high", "exec-posture-medium", "exec-posture-low");
  el.classList.remove("exec-pressure-high", "exec-pressure-medium", "exec-pressure-low");

  if (baseId === "posture") {
    if (level === "critical") el.classList.add("exec-posture-critical");
    else if (level === "high") el.classList.add("exec-posture-high");
    else if (level === "medium") el.classList.add("exec-posture-medium");
    else el.classList.add("exec-posture-low");
  }

  if (baseId === "pressure") {
    if (level === "high") el.classList.add("exec-pressure-high");
    else if (level === "medium") el.classList.add("exec-pressure-medium");
    else el.classList.add("exec-pressure-low");
  }
}

function updateExecutiveSummary(incidents, actions, summary = null) {
  const visibleIncidents = incidents || [];
  const visibleActions = actions || [];
  const latestAction = visibleActions[0] || null;
  const criticalCount = visibleActions.filter((item) => String(item.severity || "").toLowerCase() === "critical").length;
  const highCount = visibleActions.filter((item) => String(item.severity || "").toLowerCase() === "high").length;

  if (execVisibleIncidents) execVisibleIncidents.textContent = String(visibleIncidents.length);
  if (execVisibleActions) execVisibleActions.textContent = String(visibleActions.length);
  if (execPhase && phaseLabel) execPhase.textContent = phaseLabel.textContent || "D5";

  if (!latestAction) {
    if (execPosture) execPosture.textContent = "Monitoring";
    if (execPostureCopy) execPostureCopy.textContent = "No urgent signals detected yet.";
    if (execPressure) execPressure.textContent = "Low";
    if (execPressureCopy) execPressureCopy.textContent = "No elevated concentration of critical actions is visible.";
    if (execRecommendation) execRecommendation.textContent = "Continue monitoring";
    if (execRecommendationCopy) execRecommendationCopy.textContent = "Maintain baseline observation while the engine gathers more evidence.";
    if (execWhy) execWhy.textContent = "The engine is waiting for live signals. Once events arrive, this section will translate technical activity into business-facing posture and recommended response.";
    setExecValueClass(execPosture, "posture", "low");
    setExecValueClass(execPressure, "pressure", "low");
    return;
  }

  const action = String(latestAction.action || "").toLowerCase();
  const severity = String(latestAction.severity || "").toLowerCase();
  const latestType = latestAction.type || "unknown";
  const latestUser = latestAction.user || "unknown user";
  const latestRisk = latestAction.riskScore ?? "—";
  const corr = latestAction.correlationLabel || "none";
  const trend = latestAction.trendLabel || "normal";

  let postureText = "Monitoring";
  let postureCopy = "The engine is observing activity without escalation.";
  let recommendationText = "Continue monitoring";
  let recommendationCopy = "Maintain baseline observation while the engine gathers more evidence.";

  if (action === "block") {
    postureText = "Block";
    postureCopy = "The engine is actively stopping high-risk activity.";
    recommendationText = "Escalate and review";
    recommendationCopy = "A blocking action is already active. Human review should validate scope, origin and containment.";
  } else if (action === "manual_review") {
    postureText = "Manual review";
    postureCopy = "The engine has escalated activity for analyst attention.";
    recommendationText = "Review immediately";
    recommendationCopy = "A human analyst should inspect intent, exposure and user impact before resolution.";
  } else if (action === "rate_limit") {
    postureText = "Rate limit";
    postureCopy = "The engine is slowing risky activity while preserving service continuity.";
    recommendationText = "Watch closely";
    recommendationCopy = "Throttle pressure is active. Confirm whether risk is rising or stabilising.";
  } else if (action === "allow") {
    postureText = "Allow";
    postureCopy = "The engine sees current behaviour as acceptable.";
    recommendationText = "Maintain baseline";
    recommendationCopy = "No immediate intervention is required beyond standard monitoring.";
  }

  let pressureText = "Low";
  let pressureCopy = "No elevated concentration of critical actions is visible.";
  let pressureLevel = "low";

  if (criticalCount >= 3 || severity === "critical") {
    pressureText = "High";
    pressureCopy = "Critical actions dominate the visible decision stream and require active attention.";
    pressureLevel = "high";
  } else if (highCount >= 2 || severity === "high" || visibleActions.length >= 3) {
    pressureText = "Medium";
    pressureCopy = "The engine is seeing repeated elevated-risk behaviour across the visible action set.";
    pressureLevel = "medium";
  }

  if (execPosture) execPosture.textContent = postureText;
  if (execPostureCopy) execPostureCopy.textContent = postureCopy;
  if (execPressure) execPressure.textContent = pressureText;
  if (execPressureCopy) execPressureCopy.textContent = pressureCopy;
  if (execRecommendation) execRecommendation.textContent = recommendationText;
  if (execRecommendationCopy) execRecommendationCopy.textContent = recommendationCopy;

  if (execWhy) {
    execWhy.textContent =
      `Latest decision: ${action} on ${latestType} for ${latestUser} at risk ${latestRisk}. ` +
      `Trend is ${trend} and correlation is ${corr}. This means the engine is translating raw technical signals into an operational recommendation that leadership can act on immediately.`;
  }

  setExecValueClass(execPosture, "posture", severity || "low");
  setExecValueClass(execPressure, "pressure", pressureLevel);

  if (summary?.totals && execVisibleIncidents && execVisibleActions) {
    execVisibleIncidents.textContent = String(visibleIncidents.length);
    execVisibleActions.textContent = String(visibleActions.length);
  }
}


function rerenderFromState() {
  const filtered = getFilteredData();
  renderIncidents(filtered.incidents);
  renderActions(filtered.actions);
  updateDecisionPosture(filtered.incidents, filtered.actions);

  if (currentSummary) {
    renderSummary(currentSummary);
  }

  updateExecutiveSummary(filtered.incidents, filtered.actions, currentSummary);

  engineState.textContent = "Running";
  engineMeta.textContent = `Live engine · ${filtered.incidents.length} visible incidents · ${filtered.actions.length} visible actions`;
}


async function clearDemoData() {
  const confirmed = window.confirm("Clear all demo incidents, actions and events?");
  if (!confirmed) return;

  engineState.textContent = "Resetting";
  engineMeta.textContent = "Clearing demo data and rebuilding clean state...";

  try {
    const res = await fetch("/api/admin/clear-demo", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      }
    });

    const data = await res.json();

    if (!res.ok || !data?.ok) {
      throw new Error(data?.error || "Clear demo failed.");
    }

    currentIncidents = [];
    currentActions = [];
    currentSummary = {
      totals: { incidents: 0, actions: 0, events: 0 },
      severity: { critical: 0, high: 0, medium: 0, low: 0 },
      actions: { block: 0, manual_review: 0, rate_limit: 0, allow: 0 },
      trends: { spike: 0, elevated: 0, normal: 0 },
      correlations: { critical_chain: 0, multi_signal: 0, none: 0 },
      latest: { incident: null, action: null }
    };

    lastIncidentId = null;
    lastActionId = null;

    rerenderFromState();
    setDemoStatus("Demo data cleared. Dashboard is clean again.", "ok");
    phaseLabel.textContent = "D5";
  } catch (err) {
    engineState.textContent = "Error";
    engineMeta.textContent = err.message || "Could not clear demo data.";
    setDemoStatus(err.message || "Could not clear demo data.", "err");
  }
}

function wireClearDemo() {
  if (!clearDemoBtn) return;
  clearDemoBtn.addEventListener("click", () => {
    clearDemoData();
  });
}

function wireFilters() {
  [severityFilter, actionFilter, typeFilter].forEach((el) => {
    if (!el) return;
    el.addEventListener("change", () => {
      rerenderFromState();
    });
  });

  if (resetFiltersBtn) {
    resetFiltersBtn.addEventListener("click", () => {
      if (severityFilter) severityFilter.value = "all";
      if (actionFilter) actionFilter.value = "all";
      if (typeFilter) typeFilter.value = "all";
      rerenderFromState();
    });
  }
}



const DEMO_SCENARIOS = {
  login_spike: {
    type: "login",
    user: "demo-login-user",
    attempts: 6,
    ip: "unknown",
    risk: 74,
    velocitySpike: true
  },
  payment_fraud: {
    type: "payment",
    user: "vip-user",
    amount: 24500,
    risk: 82,
    ip: "unknown",
    geoMismatch: true,
    velocitySpike: true
  },
  account_takeover: {
    type: "login",
    user: "exec-user",
    attempts: 4,
    risk: 67,
    ip: "unknown",
    geoMismatch: true,
    velocitySpike: true
  },
  safe_event: {
    type: "login",
    user: "known-user",
    attempts: 1,
    risk: 12,
    ip: "trusted-ip",
    geoMismatch: false,
    velocitySpike: false
  }
};

function setDemoStatus(message, kind = "") {
  if (!demoStatus) return;
  demoStatus.className = `demo-status${kind ? ` ${kind}` : ""}`;
  demoStatus.textContent = message;
}

async function triggerDemoScenario(name) {
  const payload = DEMO_SCENARIOS[name];
  if (!payload) {
    setDemoStatus("Unknown demo scenario.", "err");
    return;
  }

  const labelMap = {
    login_spike: "login spike",
    payment_fraud: "payment fraud",
    account_takeover: "account takeover",
    safe_event: "safe event"
  };

  setDemoStatus(`Running ${labelMap[name] || name} scenario...`);

  try {
    const res = await fetch("/event", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (!res.ok || !data?.ok) {
      throw new Error(data?.error || "Scenario request failed.");
    }

    const action = data?.decision?.action || "processed";
    const risk = data?.riskScore ?? "—";
    setDemoStatus(`Scenario ${labelMap[name] || name} sent successfully. Engine action: ${action}. Risk: ${risk}.`, "ok");
  } catch (err) {
    setDemoStatus(err.message || "Scenario failed.", "err");
  }
}

function wireDemoButtons() {
  document.querySelectorAll("[data-demo]").forEach((button) => {
    button.addEventListener("click", () => {
      const name = button.getAttribute("data-demo");
      triggerDemoScenario(name);
    });
  });
}


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

function pulseLiveDot() {
  liveDot.style.transform = "scale(1.35)";
  setTimeout(() => {
    liveDot.style.transform = "";
  }, 220);
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
        ["severity", item.severity],
        ["risk", item.riskScore],
        ["time", formatDate(item.createdAt)]
      ]
    : [
        ["type", item.type],
        ["user", item.user],
        ["action", item.action],
        ["severity", item.severity],
        ["risk", item.riskScore],
        ["time", formatDate(item.createdAt)]
      ];

  renderSummaryBlock(container, lines);
}

function buildHighlightStyle(isNew, severity) {
  if (!isNew) return "";
  const glow =
    severity === "critical"
      ? "box-shadow: 0 0 0 1px rgba(255,92,108,.25), 0 0 24px rgba(255,92,108,.14);"
      : severity === "high"
      ? "box-shadow: 0 0 0 1px rgba(255,179,71,.25), 0 0 22px rgba(255,179,71,.12);"
      : "box-shadow: 0 0 0 1px rgba(87,199,240,.18), 0 0 20px rgba(87,199,240,.10);";
  return `${glow} animation: fadeFlash 1.4s ease;`;
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

  incidentList.innerHTML = items.map((item, index) => {
    const isNewest = index === 0 && item.id !== lastIncidentId;
    return `
      <div class="incident" style="${buildHighlightStyle(isNewest, item.severity)}">
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
    `;
  }).join("");

  if (items[0]?.id) lastIncidentId = items[0].id;
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

  actionList.innerHTML = items.map((item, index) => {
    const isNewest = index === 0 && item.id !== lastActionId;
    return `
      <div class="action-item" style="${buildHighlightStyle(isNewest, item.severity)}">
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
    `;
  }).join("");

  if (items[0]?.id) lastActionId = items[0].id;
}

function updateDecisionPosture(incidents, actions) {
  if (!incidents.length && !actions.length) {
    decisionState.textContent = "Monitoring";
    decisionMeta.textContent = "No recent actions. Engine is armed and waiting for new signals.";
    return;
  }

  const latestAction = actions[0];
  const latestIncident = incidents[0];

  if (!latestAction && latestIncident) {
    decisionState.textContent = "Tracking";
    decisionMeta.textContent =
      `Incident detected for ${latestIncident.user} on ${latestIncident.type} with risk ${latestIncident.riskScore}. Awaiting next decision output.`;
    return;
  }

  if (!latestAction) {
    decisionState.textContent = "Tracking";
    decisionMeta.textContent = "Action stream is empty, but live monitoring is active.";
    return;
  }

  const postureMap = {
    block: "Block",
    manual_review: "Manual review",
    rate_limit: "Rate limit",
    allow: "Allow"
  };

  decisionState.textContent = postureMap[latestAction.action] || latestAction.action;

  const severityTone =
    latestAction.severity === "critical"
      ? "Critical posture active."
      : latestAction.severity === "high"
      ? "High-risk posture active."
      : latestAction.severity === "medium"
      ? "Elevated monitoring posture active."
      : "Low-risk posture active.";

  decisionMeta.textContent =
    `${severityTone} Latest action targets ${latestAction.type} for ${latestAction.user} ` +
    `at risk ${latestAction.riskScore}, trend ${latestAction.trendLabel || "normal"}, ` +
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
  currentIncidents = incidents || [];
  currentActions = actions || [];
  if (summary) currentSummary = summary;
  rerenderFromState();
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

  phaseLabel.textContent = health.phase || "D5";
  engineState.textContent = health.ok ? "Running" : "Stopped";
  engineMeta.textContent = `Phase ${health.phase || "?"} · ${health.incidents ?? 0} incidents · ${health.actions ?? 0} actions`;

  renderAll(incidentData.incidents || [], actionData.actions || [], summaryData);
}

function connectSocket() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${window.location.host}`);
  socketRef = ws;

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
        renderAll(payload.incidents || [], payload.actions || [], payload.summary || null);
        return;
      }

      if (payload.type === "event_processed") {
        pulseLiveDot();
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
  engineState.textContent = "Refreshing";
  engineMeta.textContent = "Pulling latest incident, action and summary state...";

  loadInitialData().catch((err) => {
    engineState.textContent = "Error";
    engineMeta.textContent = err.message || "Manual refresh failed.";
  });
});

loadInitialData().catch((err) => {
  engineState.textContent = "Error";
  engineMeta.textContent = err.message || "Could not load initial dashboard data.";
});

const style = document.createElement("style");
style.textContent = `
  @keyframes fadeFlash {
    0% { transform: translateY(-2px); filter: brightness(1.08); }
    100% { transform: translateY(0); filter: brightness(1); }
  }

  #liveDot {
    transition: transform .18s ease, box-shadow .18s ease;
  }
`;
document.head.appendChild(style);

wireDemoButtons();
wireFilters();
wireClearDemo();
connectSocket();
