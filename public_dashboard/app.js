const $ = (id) => document.getElementById(id);

const state = {
  events: [],
  actions: [],
  comparisons: [],
  latestEventPayload: null,
  latestSummary: null
};

function escapeHtml(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function toneClass(value) {
  if (value === "critical" || value === "block" || value === "unstable") return "bad";
  if (value === "high" || value === "manual_review" || value === "shadow" || value === "review") return "warn";
  if (value === "medium" || value === "rate_limit") return "info";
  return "ok";
}

function clearEl(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function createListItem(title, meta, sub = "", tone = "info", badge = "") {
  const li = document.createElement("li");
  li.className = "item";
  li.innerHTML = `
    <div class="row">
      <div class="title">${escapeHtml(title)}</div>
      <div style="display:flex;gap:8px;align-items:center;">
        ${badge ? `<span class="badge ${badge==='diverged'?'div':'alg'}">${badge}</span>` : ``}
        <span class="pill ${tone}">${escapeHtml(meta)}</span>
      </div>
    </div>
    ${sub ? `<div class="tiny" style="margin-top:8px;">${escapeHtml(sub)}</div>` : ""}
  `;
  return li;
}

function renderTopMetrics(summary) {
  const drift = summary?.drift || {};
  const identity = summary?.identity || {};

  $("status").textContent = drift.status || "unknown";
  $("status").className = `metric ${toneClass(drift.status || "unknown")}`;
  $("statusSub").textContent =
    drift.status === "unstable" ? "Adaptive recalibration required" : "System coherent";

  $("drift").textContent = Number(drift.driftScore || 0).toFixed(2);
  $("baselineRisk").textContent = identity.baselineRisk ?? 0;
  $("eventsLoaded").textContent = state.events.length || 0;

  const avgRisk = state.events.length
    ? Math.round(state.events.reduce((sum, e) => sum + Number(e.risk || 0), 0) / state.events.length)
    : 0;
  $("avgRisk").textContent = avgRisk;

  const counts = {};
  for (const a of state.actions) counts[a.type] = (counts[a.type] || 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "log";
  $("topAction").textContent = top;
}

function renderReflection(summary) {
  $("reflection").textContent = summary?.summary || "No summary yet.";
}

function renderEventList() {
  const list = $("eventList");
  clearEl(list);

  state.events.slice(0, 14).forEach((e) => {
    const risk = Number(e.risk || 0);
    const tone = risk >= 85 ? "bad" : risk >= 60 ? "warn" : risk >= 35 ? "info" : "ok";
    const sub = `${e.ip || "unknown"} · ${e.type || "unknown"} · attempts ${e.attempts || 0} · amount ${e.amount || 0}`;
    list.appendChild(createListItem(`${e.type} • ${e.user}`, `risk ${risk}`, sub, tone));
  });
}

function renderDistribution() {
  const bars = $("distributionBars");
  clearEl(bars);

  const buckets = {
    "0–44 / low": 0,
    "45–71 / medium": 0,
    "72–89 / high": 0,
    "90–100 / critical": 0
  };

  for (const e of state.events) {
    const r = Number(e.risk || 0);
    if (r >= 90) buckets["90–100 / critical"]++;
    else if (r >= 72) buckets["72–89 / high"]++;
    else if (r >= 45) buckets["45–71 / medium"]++;
    else buckets["0–44 / low"]++;
  }

  const total = Math.max(1, state.events.length);

  Object.entries(buckets).forEach(([label, value]) => {
    const pct = (value / total) * 100;
    const row = document.createElement("div");
    row.className = "bar-row";
    row.innerHTML = `
      <div class="bar-head">
        <span>${escapeHtml(label)}</span>
        <span>${value}</span>
      </div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${pct.toFixed(1)}%"></div>
      </div>
    `;
    bars.appendChild(row);
  });
}

function reasonBullets(comp, latestEventPayload) {
  const out = [];
  if (!comp) {
    out.push("No comparison event has arrived yet.");
    return out;
  }

  out.push(`SignalDesk local action: ${comp.localAction || "log"}.`);
  out.push(`Final action: ${comp.finalAction || "log"}.`);

  if (comp.differs) out.push("MQC and SignalDesk diverged on this event.");
  else out.push("MQC and SignalDesk were aligned enough to keep the same final posture.");

  if (comp.promotedByMQC) out.push("MQC promoted the decision severity.");
  if (comp.mqcRiskDelta) out.push(`MQC added risk delta ${comp.mqcRiskDelta}.`);

  const memFactors = latestEventPayload?.memoryFactors || comp.payload?.memoryFactors || [];
  if (memFactors.length) out.push(`Memory modifiers: ${memFactors.join(", ")}.`);

  const gateReason = latestEventPayload?.gate?.reason;
  if (gateReason) out.push(`Gate result: ${gateReason}.`);

  return out;
}

function renderMemoryFactors(comp, latestEventPayload) {
  const wrap = $("memoryFactors");
  clearEl(wrap);

  const factors = latestEventPayload?.memoryFactors || comp?.payload?.memoryFactors || [];
  $("memoryNote").textContent = factors.length
    ? "Historical user context changed this decision."
    : "No historical modifiers on the latest decision.";

  if (!factors.length) {
    const span = document.createElement("span");
    span.className = "pill info";
    span.textContent = "no memory factors";
    wrap.appendChild(span);
    return;
  }

  factors.forEach((f) => {
    const span = document.createElement("span");
    span.className = `pill ${f.includes("discount") ? "ok" : "warn"}`;
    span.textContent = f;
    wrap.appendChild(span);
  });
}

function nextActionFromContext(comp, latestEventPayload) {
  if (!comp) return { title: "Observe", sub: "Need more live data" };

  const finalAction = comp.finalAction || "log";
  const user = comp.user || "unknown";
  const source = comp.finalSource || "signaldesk";
  const trust = latestEventPayload?.userMemory?.trustScore ?? comp.payload?.userMemory?.trustScore ?? null;

  if (finalAction === "block") {
    return { title: "Contain", sub: `Keep ${user} blocked and inspect source ${source}` };
  }
  if (finalAction === "manual_review") {
    return { title: "Review", sub: `Open analyst review for ${user}` };
  }
  if (finalAction === "rate_limit") {
    return { title: "Throttle", sub: `Rate-limit traffic and monitor retries` };
  }
  if (trust !== null && trust >= 70) {
    return { title: "Allow", sub: `Trusted user posture; keep monitoring quietly` };
  }
  return { title: "Observe", sub: "No escalation required yet" };
}

function markDivergenceTiles(comp) {
  const isDiv = !!comp?.differs;
  const tiles = [
    document.getElementById("currentDecision")?.closest(".decision-tile"),
    document.getElementById("signaldeskDecision")?.closest(".decision-tile"),
    document.getElementById("mqcDecision")?.closest(".decision-tile"),
    document.getElementById("nextAction")?.closest(".decision-tile"),
  ].filter(Boolean);

  tiles.forEach(t => {
    t.classList.remove("divergence", "aligned", "pulse", "quiet");
    if (!comp) return;
    if (isDiv) t.classList.add("divergence", "pulse");
    else t.classList.add("aligned");
    if (comp?.mqcRecommendedAction == null) t.classList.add("quiet");
  });
}

function buildDivergenceExplanation(comp, latestEventPayload) {
  if (!comp) {
    return {
      headline: "Waiting",
      headlineClass: "info",
      sub: "No comparison yet",
      text: "The panel has not received a comparison event yet."
    };
  }

  const payload = comp.payload || {};
  const mqc = payload.mqc || {};
  const memoryFactors = latestEventPayload?.memoryFactors || payload.memoryFactors || [];
  const trust = latestEventPayload?.userMemory?.trustScore ?? payload.userMemory?.trustScore;
  const lines = [];

  if (!comp.differs) {
    lines.push(`SignalDesk and MQC did not materially disagree on this event.`);
    lines.push(`SignalDesk local action stayed at ${comp.localAction || "log"} and final action stayed at ${comp.finalAction || "log"}.`);
    if (mqc.recommendedAction) {
      lines.push(`MQC also suggested ${mqc.recommendedAction}, so no promotion was needed.`);
    } else {
      lines.push(`MQC stayed quiet, which means no extra pattern was strong enough to override the baseline decision.`);
    }
    if (memoryFactors.length) lines.push(`Historical context still mattered: ${memoryFactors.join(", ")}.`);
    if (typeof trust === "number") lines.push(`Current trust score for this user is ${trust}.`);
    return {
      headline: "Aligned",
      headlineClass: "explain-good",
      sub: "Both engines point the same way",
      text: lines.join(" ")
    };
  }

  lines.push(`SignalDesk started from ${comp.localAction || "log"} with label ${comp.localLabel || "none"}.`);
  lines.push(`MQC added delta ${comp.mqcRiskDelta || 0} and suggested ${comp.mqcRecommendedAction || "no change"} via ${comp.mqcLabel || "shadow"}.`);

  if (comp.promotedByMQC) {
    lines.push(`MQC promoted the decision from ${comp.localAction || "log"} to ${comp.finalAction || "log"}.`);
  } else {
    lines.push(`The engines diverged in reasoning, but the final action stayed at ${comp.finalAction || "log"}.`);
  }

  if (memoryFactors.length) lines.push(`Historical pressure also shaped the result: ${memoryFactors.join(", ")}.`);

  if (typeof trust === "number") {
    if (trust <= 40) lines.push(`Low trust score (${trust}) made escalation easier to justify.`);
    else if (trust >= 70) lines.push(`High trust score (${trust}) softened part of the pressure, but not enough to remove concern.`);
    else lines.push(`Mid trust score (${trust}) left the engines to lean mostly on live behavior.`);
  }

  if ((comp.mqcLabel || "").includes("payment")) {
    lines.push(`This divergence was likely driven by payment pattern recognition rather than a single raw threshold.`);
  } else if ((comp.mqcLabel || "").includes("auth") || (comp.eventType || "").includes("login")) {
    lines.push(`This divergence was likely driven by authentication pattern logic such as cascade or repeated suspicious access.`);
  }

  return {
    headline: "Diverged",
    headlineClass: "explain-bad",
    sub: "MQC changed the shape of the decision",
    text: lines.join(" ")
  };
}

function renderDecisionPanel() {
  const comp = state.comparisons[0];
  const latest = state.latestEventPayload;
  markDivergenceTiles(comp);

  const currentAction = comp?.finalAction || "waiting";
  $("currentDecision").textContent = currentAction;
  $("currentDecision").className = `big ${toneClass(currentAction)}`;
  $("currentDecisionSub").textContent =
    comp ? `source ${comp.finalSource || "signaldesk"} · risk ${comp.mergedRiskScore ?? "n/a"}` : "No final decision yet";

  $("signaldeskDecision").textContent = comp?.localAction || "—";
  $("signaldeskDecision").className = `big ${toneClass(comp?.localAction || "ok")}`;
  $("signaldeskSub").textContent =
    comp ? `${comp.localLabel || "none"} · risk ${comp.localRiskScore ?? "n/a"}` : "No baseline decision yet";

  $("mqcDecision").textContent = comp?.mqcRecommendedAction || "quiet";
  $("mqcDecision").className = `big ${toneClass(comp?.mqcRecommendedAction || "ok")}`;
  $("mqcSub").textContent =
    comp ? `${comp.mqcLabel || "mqc-shadow"} · Δ ${comp.mqcRiskDelta ?? 0}` : "No MQC opinion yet";

  const next = nextActionFromContext(comp, latest);
  $("nextAction").textContent = next.title;
  $("nextAction").className = `big ${toneClass(next.title.toLowerCase())}`;
  $("nextActionSub").textContent = next.sub;

  const reasonList = $("reasonList");
  clearEl(reasonList);
  reasonBullets(comp, latest).forEach((r) => {
    const li = document.createElement("li");
    li.textContent = r;
    reasonList.appendChild(li);
  });

  renderMemoryFactors(comp, latest);

  const divergence = buildDivergenceExplanation(comp, latest);
  $("divergenceHeadline").textContent = divergence.headline;
  $("divergenceHeadline").className = `big ${divergence.headlineClass}`;
  $("divergenceSub").textContent = divergence.sub;
  $("divergenceExplanation").textContent = divergence.text;

  const runtime = [];
  if (latest?.engineMeta?.mode) runtime.push(`mode=${latest.engineMeta.mode}`);
  if (latest?.engineMeta?.source) runtime.push(`source=${latest.engineMeta.source}`);
  if (latest?.userMemory?.trustScore !== undefined) runtime.push(`trustScore=${latest.userMemory.trustScore}`);
  if (comp?.differs) runtime.push("decision diverged");
  if (comp?.promotedByMQC) runtime.push("mqc promoted action");
  if (latest?.gate?.reason) runtime.push(`gate=${latest.gate.reason}`);

  $("runtimeNotes").textContent = runtime.length
    ? runtime.join(" | ")
    : "Waiting for live decision context…";
}

function renderDecisionFeed() {
  const feed = $("decisionFeed");
  clearEl(feed);

  state.actions.slice(0, 14).forEach((a) => {
    const tone = toneClass(a.type || "log");
    const sub = `${a.engineSource || "signaldesk"} · ${a.reason || "no reason"} · ${a.status || "issued"}`;
    feed.appendChild(createListItem(`${a.type} • ${a.targetUser}`, a.reason || "issued", sub, tone));
  });
}

function renderMQCFeed() {
  const feed = $("mqcFeed");
  clearEl(feed);

  state.comparisons.slice(0, 14).forEach((c) => {
    const tone = c.promotedByMQC ? "bad" : c.differs ? "warn" : "info";
    const meta = c.differs ? "diverged" : "aligned";
    const sub = `local ${c.localAction} → final ${c.finalAction} · mqc ${c.mqcRecommendedAction || "quiet"} · Δ ${c.mqcRiskDelta || 0}`;
    feed.appendChild(createListItem(`${c.eventType} • ${c.user}`, meta, sub, tone, c.differs ? "diverged" : "aligned"));
  });
}

function renderAll() {
  renderTopMetrics(state.latestSummary);
  renderReflection(state.latestSummary);
  renderEventList();
  renderDistribution();
  renderDecisionPanel();
  renderDecisionFeed();
  renderMQCFeed();
}

async function boot() {
  try {
    const [summary, actions, comps] = await Promise.all([
      fetch("/api/summary").then(r => r.json()),
      fetch("/api/actions").then(r => r.json()),
      fetch("/api/mqc/compare").then(r => r.json())
    ]);

    state.latestSummary = summary;
    state.actions = actions || [];
    state.comparisons = comps || [];
    renderAll();
  } catch (err) {
    $("reflection").textContent = "Boot error: " + err.message;
  }
}

function updateFromEventResponse(payload) {
  state.latestEventPayload = payload || null;
  if (payload?.event) {
    state.events.unshift(payload.event);
    if (state.events.length > 20) state.events.pop();
  }
  if (payload?.action) {
    state.actions.unshift(payload.action);
    if (state.actions.length > 20) state.actions.pop();
  }
  if (payload?.comparison) {
    state.comparisons.unshift(payload.comparison);
    if (state.comparisons.length > 20) state.comparisons.pop();
  }
}

function connectWs() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${protocol}://${location.host}`);

  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    const type = msg.type;
    const payload = msg.payload || {};

    if (type === "event") {
      state.events.unshift(payload);
      if (state.events.length > 20) state.events.pop();
    }

    if (type === "action") {
      state.actions.unshift(payload);
      if (state.actions.length > 20) state.actions.pop();
    }

    if (type === "mqc_compare") {
      state.comparisons.unshift(payload);
      if (state.comparisons.length > 20) state.comparisons.pop();
    }

    if (type === "identity") {
      state.latestSummary = {
        ...(state.latestSummary || {}),
        drift: payload.drift,
        identity: payload.identity,
        summary: payload.reflection
      };
    }

    renderAll();
  };

  ws.onclose = () => {
    setTimeout(connectWs, 1500);
  };
}

async function pollLatestDecisionContext() {
  try {
    const summary = await fetch("/api/summary").then(r => r.json());
    state.latestSummary = summary;
    renderAll();
  } catch (_) {}
}

async function postEvent(json) {
  const res = await fetch("/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(json)
  });
  const data = await res.json();
  updateFromEventResponse(data);
  renderAll();
  return data;
}

async function runScenario(name) {
  const log = $("scenarioLog");
  log.textContent = `Running scenario: ${name} ...`;

  try {
    if (name === "trusted") {
      await postEvent({ type: "login", user: "trusted-ui-user", attempts: 1, ip: "10.20.30.40", risk: 18, velocitySpike: false, geoMismatch: false });
      await postEvent({ type: "payment", user: "trusted-ui-user", amount: 1200, ip: "10.20.30.40", risk: 22, velocitySpike: false, geoMismatch: false });
      await postEvent({ type: "login", user: "trusted-ui-user", attempts: 1, ip: "10.20.30.40", risk: 20, velocitySpike: false, geoMismatch: false });
      log.textContent = "Trusted user injected. This should build calm memory and usually lower pressure.";
    }

    if (name === "borderline") {
      await postEvent({ type: "payment", user: "borderline-ui-user", amount: 9000, ip: "unknown", risk: 58, velocitySpike: false, geoMismatch: false });
      log.textContent = "Borderline review injected. Good for manual_review territory.";
    }

    if (name === "cluster") {
      await postEvent({ type: "payment", user: "cluster-ui-user", amount: 8000, ip: "unknown", risk: 55, velocitySpike: false, geoMismatch: false });
      await postEvent({ type: "payment", user: "cluster-ui-user", amount: 9500, ip: "unknown", risk: 59, velocitySpike: false, geoMismatch: false });
      await postEvent({ type: "payment", user: "cluster-ui-user", amount: 11000, ip: "unknown", risk: 63, velocitySpike: false, geoMismatch: false });
      log.textContent = "MQC payment cluster injected. This is your best shot at divergence from pattern recognition.";
    }

    if (name === "auth") {
      await postEvent({ type: "login", user: "auth-ui-user", attempts: 6, ip: "unknown", risk: 76, velocitySpike: true, geoMismatch: true });
      log.textContent = "Auth cascade injected. Usually hard escalation.";
    }

    if (name === "repeat") {
      await postEvent({ type: "login", user: "repeat-ui-user", attempts: 5, ip: "unknown", risk: 66, velocitySpike: true, geoMismatch: false });
      await postEvent({ type: "payment", user: "repeat-ui-user", amount: 14000, ip: "unknown", risk: 68, velocitySpike: false, geoMismatch: false });
      await postEvent({ type: "login", user: "repeat-ui-user", attempts: 4, ip: "unknown", risk: 64, velocitySpike: false, geoMismatch: true });
      log.textContent = "Repeat offender injected. Memory should start pushing harder.";
    }

    if (name === "newip") {
      await postEvent({ type: "login", user: "trusted-ui-user", attempts: 1, ip: "172.16.10.55", risk: 28, velocitySpike: false, geoMismatch: false });
      log.textContent = "Known user on new IP injected. This should test memory tension instead of raw threat.";
    }
  } catch (err) {
    log.textContent = `Scenario failed: ${err.message}`;
  }
}

function bindScenarioButtons() {
  document.querySelectorAll("[data-scenario]").forEach((btn) => {
    btn.addEventListener("click", () => runScenario(btn.dataset.scenario));
  });
}

boot();
connectWs();
bindScenarioButtons();
setInterval(pollLatestDecisionContext, 4000);
