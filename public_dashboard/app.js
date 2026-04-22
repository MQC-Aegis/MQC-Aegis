(() => {
  const REFRESH_MS = 3000;
  const API_BASE = "";

  const ACTION_PRIORITY = {
    block: 4,
    manual_review: 3,
    rate_limit: 2,
    observe: 1,
    log: 0
  };

  const el = {
    statusValue: document.getElementById("statusValue"),
    statusSub: document.getElementById("statusSub"),
    driftValue: document.getElementById("driftValue"),
    driftSub: document.getElementById("driftSub"),
    baselineRiskValue: document.getElementById("baselineRiskValue"),
    baselineRiskSub: document.getElementById("baselineRiskSub"),
    eventsLoadedValue: document.getElementById("eventsLoadedValue"),
    eventsLoadedSub: document.getElementById("eventsLoadedSub"),
    avgRiskValue: document.getElementById("avgRiskValue"),
    avgRiskSub: document.getElementById("avgRiskSub"),
    topActionValue: document.getElementById("topActionValue"),
    topActionSub: document.getElementById("topActionSub"),

    currentDecisionValue: document.getElementById("currentDecisionValue"),
    currentDecisionSub: document.getElementById("currentDecisionSub"),
    signalDeskValue: document.getElementById("signalDeskValue"),
    signalDeskSub: document.getElementById("signalDeskSub"),
    mqcSuggestionValue: document.getElementById("mqcSuggestionValue"),
    mqcSuggestionSub: document.getElementById("mqcSuggestionSub"),
    nextBestActionValue: document.getElementById("nextBestActionValue"),
    nextBestActionSub: document.getElementById("nextBestActionSub"),

    decisionReasoning: document.getElementById("decisionReasoning"),
    memoryFactors: document.getElementById("memoryFactors"),
    runtimeNotes: document.getElementById("runtimeNotes"),
    divergenceExplanation: document.getElementById("divergenceExplanation"),
    systemReflection: document.getElementById("systemReflection"),

    incidentList: document.getElementById("incidentList"),
    decisionFeed: document.getElementById("decisionFeed"),
    mqcInsightFeed: document.getElementById("mqcInsightFeed"),

    bucketLowBar: document.getElementById("bucketLowBar"),
    bucketLowCount: document.getElementById("bucketLowCount"),
    bucketMediumBar: document.getElementById("bucketMediumBar"),
    bucketMediumCount: document.getElementById("bucketMediumCount"),
    bucketHighBar: document.getElementById("bucketHighBar"),
    bucketHighCount: document.getElementById("bucketHighCount"),
    bucketCriticalBar: document.getElementById("bucketCriticalBar"),
    bucketCriticalCount: document.getElementById("bucketCriticalCount"),

    connectionStatus: document.getElementById("connectionStatus"),
    authStatus: document.getElementById("authStatus")
  };

  function setText(node, value) {
    if (node) node.textContent = value;
  }

  function setHTML(node, value) {
    if (node) node.innerHTML = value;
  }

  function esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function niceAction(action) {
    return String(action || "observe").replaceAll("_", " ");
  }

  function upperAction(action) {
    return niceAction(action).toUpperCase();
  }

  function formatTime(value) {
    if (!value) return "n/a";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "n/a";
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function formatScore(value) {
    const n = Number(value);
    return Number.isFinite(n) ? String(Math.round(n)) : "n/a";
  }

  function severityClass(severity, score) {
    const s = String(severity || "").toLowerCase();
    if (s === "critical") return "critical";
    if (s === "high") return "high";
    if (s === "medium") return "medium";
    if (s === "low") return "low";

    const n = Number(score);
    if (!Number.isFinite(n)) return "low";
    if (n >= 90) return "critical";
    if (n >= 72) return "high";
    if (n >= 45) return "medium";
    return "low";
  }

  async function getJSON(path) {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
    if (!res.ok) {
      throw new Error(`${path} -> HTTP ${res.status}`);
    }
    return res.json();
  }

  function normalizeIncidents(raw) {
    const list = Array.isArray(raw) ? raw : [];
    return list
      .map((item) => {
        const riskScore = Number.isFinite(Number(item?.riskScore))
          ? Number(item.riskScore)
          : (Number.isFinite(Number(item?.risk)) ? Number(item.risk) : null);

        const createdAtTs = new Date(item?.createdAt || 0).getTime() || 0;

        return {
          ...item,
          riskScore,
          createdAtTs
        };
      })
      .sort((a, b) => b.createdAtTs - a.createdAtTs);
  }

  function computeAvgRisk(incidents) {
    const scored = incidents.filter((i) => Number.isFinite(i.riskScore));
    if (!scored.length) return 0;
    const sum = scored.reduce((acc, item) => acc + item.riskScore, 0);
    return Math.round(sum / scored.length);
  }

  function computeTopAction(incidents) {
    const actions = incidents.slice(0, 20).map((i) => i?.action).filter(Boolean);
    if (!actions.length) return "observe";
    return actions.sort((a, b) => (ACTION_PRIORITY[b] || 0) - (ACTION_PRIORITY[a] || 0))[0] || "observe";
  }

  function computeBuckets(incidents) {
    const buckets = { low: 0, medium: 0, high: 0, critical: 0 };

    for (const item of incidents) {
      const score = Number(item?.riskScore);
      if (!Number.isFinite(score)) continue;

      if (score <= 44) buckets.low++;
      else if (score <= 71) buckets.medium++;
      else if (score <= 89) buckets.high++;
      else buckets.critical++;
    }

    return buckets;
  }

  function renderReasonCodes(item) {
    const codes = Array.isArray(item?.reasonCodes) ? item.reasonCodes : [];
    if (!codes.length) {
      return `<ul class="clean"><li>No explicit reason codes.</li></ul>`;
    }
    return `<ul class="clean">${codes.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`;
  }

  function renderMemoryFactors(item) {
    const codes = Array.isArray(item?.reasonCodes) ? item.reasonCodes : [];
    const memoryCodes = codes.filter((c) => String(c).startsWith("MEMORY_"));

    if (!memoryCodes.length) {
      return `
        <div>No memory factors triggered</div>
        <div style="margin-top:8px;opacity:.8;">Latest user: ${esc(item?.user || "unknown")}</div>
      `;
    }

    return `
      <div>${memoryCodes.slice(0, 4).map(esc).join(", ")}</div>
      <div style="margin-top:8px;opacity:.8;">Latest user: ${esc(item?.user || "unknown")}</div>
    `;
  }

  function renderRuntimeNotes(item) {
    if (!item) return `Awaiting live incident.`;

    return `
      <div>Latest event type: <b>${esc(item?.type || "unknown")}</b></div>
      <div>Severity: <b>${esc(item?.severity || "unknown")}</b></div>
      <div>Status: <b>${esc(item?.status || "issued")}</b></div>
      <div>Time: <b>${esc(formatTime(item?.createdAt))}</b></div>
    `;
  }

  function renderDivergence(summary) {
    const enabled = Boolean(summary?.mqc?.enabled);

    if (!enabled) {
      return `
        <div class="strong" style="color:#93c5fd;">Aligned</div>
        <div style="margin-top:6px;">No shadow comparison yet.</div>
        <div style="margin-top:8px;">SignalDesk is driving the decision stream from the incident engine in this build.</div>
      `;
    }

    return `
      <div class="strong" style="color:#93c5fd;">Comparison active</div>
      <div style="margin-top:6px;">MQC comparison stream available.</div>
    `;
  }

  function renderReflection(summary, latestIncident, avgRisk, incidents) {
    const driftStatus = summary?.drift?.status || "unknown";
    const driftScore = Number.isFinite(Number(summary?.drift?.driftScore))
      ? Number(summary.drift.driftScore).toFixed(2)
      : "n/a";
    const engineMode = summary?.mqc?.enabled ? (summary?.mqc?.mode || "comparison") : "signaldesk";
    const currentVolume = incidents.length;
    const latestDecisionTime = formatTime(latestIncident?.createdAt);

    return `System status: ${driftStatus}. Drift score: ${driftScore}. Engine mode: ${engineMode}. Current avg risk: ${avgRisk}. Current volume: ${currentVolume}. Latest decision time: ${latestDecisionTime}.`;
  }

  function renderIncidentCards(incidents) {
    if (!incidents.length) {
      return `<div class="empty-state">No live incidents yet.</div>`;
    }

    return incidents.slice(0, 12).map((item) => `
      <div class="card ${severityClass(item?.severity, item?.riskScore)}">
        <div class="row">
          <div>
            <div class="strong">${esc(item?.type || "event")} • ${esc(item?.user || "unknown")}</div>
            <div>severity: <b>${esc(item?.severity || "unknown")}</b> • action: <b>${esc(item?.action || "observe")}</b></div>
          </div>
          <div class="muted">${esc(formatTime(item?.createdAt))}</div>
        </div>
        <div style="margin-top:6px;word-break:break-word;">
          ${Array.isArray(item?.reasonCodes) && item.reasonCodes.length
            ? esc(item.reasonCodes.join(", "))
            : "No explicit reason codes."}
        </div>
      </div>
    `).join("");
  }

  function renderDecisionFeed(incidents) {
    if (!incidents.length) {
      return `<div class="empty-state">Awaiting decision stream.</div>`;
    }

    return incidents.slice(0, 6).map((item) => `
      <div class="card low">
        <div class="row">
          <div class="strong">${esc(upperAction(item?.action))}</div>
          <div class="muted">${esc(item?.user || "unknown")} • ${esc(niceAction(item?.action))} • ${esc(formatTime(item?.createdAt))}</div>
        </div>
        <div style="margin-top:4px;">user: ${esc(item?.user || "unknown")}</div>
        <div>score: ${esc(formatScore(item?.riskScore))} • status: ${esc(item?.status || "issued")}</div>
        <div style="margin-top:4px;">${esc(item?.summary || "Narrative pending")}</div>
      </div>
    `).join("");
  }

  function renderMQCFeed(incidents, summary) {
    const latest = incidents[0];

    if (!summary?.mqc?.enabled) {
      return `
        <div class="card low">
          <div class="row">
            <div class="strong">${esc(latest?.action || "observe")} • ${esc(latest?.user || "unknown")}</div>
            <div class="muted">${esc(formatTime(latest?.createdAt))}</div>
          </div>
          <div style="margin-top:4px;">Action: <b>observe</b></div>
          <div>Reasons: MQC disabled in this build</div>
        </div>
      `;
    }

    return `
      <div class="card low">
        <div>MQC comparison stream active.</div>
      </div>
    `;
  }

  function updateRiskBars(buckets) {
    const total = Object.values(buckets).reduce((a, b) => a + b, 0) || 1;

    setText(el.bucketLowCount, String(buckets.low));
    setText(el.bucketMediumCount, String(buckets.medium));
    setText(el.bucketHighCount, String(buckets.high));
    setText(el.bucketCriticalCount, String(buckets.critical));

    if (el.bucketLowBar) el.bucketLowBar.style.width = `${(buckets.low / total) * 100}%`;
    if (el.bucketMediumBar) el.bucketMediumBar.style.width = `${(buckets.medium / total) * 100}%`;
    if (el.bucketHighBar) el.bucketHighBar.style.width = `${(buckets.high / total) * 100}%`;
    if (el.bucketCriticalBar) el.bucketCriticalBar.style.width = `${(buckets.critical / total) * 100}%`;
  }

  async function refresh() {
    try {
      setText(el.connectionStatus, "connecting...");
      setText(el.authStatus, "live");

      const [rawIncidents, rawActions, summary] = await Promise.all([
        getJSON("/api/incidents"),
        getJSON("/api/actions").catch(() => []),
        getJSON("/api/summary")
      ]);

      const incidents = normalizeIncidents(rawIncidents);
      const latestIncident = incidents[0] || null;
      const avgRisk = computeAvgRisk(incidents);
      const topAction = computeTopAction(incidents);
      const buckets = computeBuckets(incidents);

      setText(el.statusValue, String(summary?.drift?.status || "unknown"));
      setText(el.statusSub, "Adaptive recalibration required");

      setText(
        el.driftValue,
        Number.isFinite(Number(summary?.drift?.driftScore))
          ? Number(summary.drift.driftScore).toFixed(2)
          : "0.00"
      );
      setText(el.driftSub, "Identity drift");

      setText(el.baselineRiskValue, String(summary?.identity?.baselineRisk ?? summary?.drift?.baselineRisk ?? 0));
      setText(el.baselineRiskSub, "System baseline");

      setText(el.eventsLoadedValue, String(incidents.length));
      setText(el.eventsLoadedSub, "Recent live events");

      setText(el.avgRiskValue, String(avgRisk));
      setText(el.avgRiskSub, "Recent average");

      setText(el.topActionValue, niceAction(topAction));
      setText(el.topActionSub, "Strongest recent action");

      setText(el.currentDecisionValue, upperAction(latestIncident?.action || "observe"));
      setText(
        el.currentDecisionSub,
        latestIncident?.riskScore != null
          ? `Score — ${formatScore(latestIncident.riskScore)}`
          : "Score — n/a"
      );

      setText(el.signalDeskValue, "Active");
      setText(el.signalDeskSub, "SignalDesk weighted rule engine");

      setText(el.mqcSuggestionValue, summary?.mqc?.enabled ? "Active" : "Inactive");
      setText(
        el.mqcSuggestionSub,
        summary?.mqc?.enabled ? "Comparison stream available" : "MQC disabled in this build"
      );

      setText(el.nextBestActionValue, niceAction(latestIncident?.action || topAction || "observe"));
      setText(el.nextBestActionSub, latestIncident ? "Derived from latest incident" : "Await next signal");

      setHTML(el.decisionReasoning, renderReasonCodes(latestIncident));
      setHTML(el.memoryFactors, renderMemoryFactors(latestIncident));
      setHTML(el.runtimeNotes, renderRuntimeNotes(latestIncident));
      setHTML(el.divergenceExplanation, renderDivergence(summary));
      setText(el.systemReflection, renderReflection(summary, latestIncident, avgRisk, incidents));

      setHTML(el.incidentList, renderIncidentCards(incidents));
      setHTML(el.decisionFeed, renderDecisionFeed(incidents));
      setHTML(el.mqcInsightFeed, renderMQCFeed(incidents, summary));

      updateRiskBars(buckets);

      setText(el.connectionStatus, "connected");
    } catch (err) {
      console.error("[SignalDesk UI] refresh failed:", err);
      setText(el.connectionStatus, "offline");
      setText(el.authStatus, "error");
      setText(el.systemReflection, `Dashboard refresh failed: ${err.message}`);
    }
  }

  function boot() {
    refresh();
    setInterval(refresh, REFRESH_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
