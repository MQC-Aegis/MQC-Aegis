const $ = (id) => document.getElementById(id);

const feed = $("feed");
const incidentsEl = $("incidents");
const actionsEl = $("actions");
const narrativesEl = $("narratives");

function escapeHtml(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderItem(listEl, title, meta, tone = "ok") {
  const li = document.createElement("li");
  li.innerHTML = `
    <div class="row">
      <strong>${escapeHtml(title)}</strong>
      <span class="pill ${tone}">${escapeHtml(meta)}</span>
    </div>
  `;
  listEl.prepend(li);
  while (listEl.children.length > 20) listEl.removeChild(listEl.lastChild);
}

function setIdentityView(data) {
  const drift = data.drift || {};
  const identity = data.identity || data.systemIdentity || {};

  $("status").textContent = drift.status || "unknown";
  $("status").className = "metric " + (drift.status === "coherent" ? "ok" : "warn");
  $("statusSub").textContent =
    drift.status === "coherent"
      ? "Stable operational coherence"
      : "Adaptive recalibration required";

  $("drift").textContent = Number(drift.driftScore || 0).toFixed(2);
  $("baselineRisk").textContent = identity.baselineRisk ?? 0;
  $("baselineVolume").textContent = identity.baselineVolume ?? 0;
}

function setSummaryView(data) {
  $("reflection").textContent = data.summary || "No reflection available.";
  if (data.drift || data.identity) {
    setIdentityView({ drift: data.drift, identity: data.identity });
  }
}

async function boot() {
  try {
    const [summaryRes, incidentsRes, actionsRes, narrativesRes, identityRes] = await Promise.all([
      fetch("/api/summary"),
      fetch("/api/incidents"),
      fetch("/api/actions"),
      fetch("/api/narratives"),
      fetch("/api/identity")
    ]);

    const summary = await summaryRes.json();
    const incidents = await incidentsRes.json();
    const actions = await actionsRes.json();
    const narratives = await narrativesRes.json();
    const identity = await identityRes.json();

    setSummaryView(summary);
    setIdentityView(identity);

    (incidents || []).slice(0, 10).reverse().forEach((i) => {
      renderItem(
        incidentsEl,
        `${i.type} • ${i.user}`,
        `${i.severity} • ${i.action}`,
        i.severity === "critical" ? "bad" : i.severity === "high" ? "warn" : "ok"
      );
    });

    (actions || []).slice(0, 10).reverse().forEach((a) => {
      renderItem(actionsEl, `${a.type} • ${a.targetUser}`, a.reason || "issued", "warn");
    });

    (narratives || []).slice(0, 10).reverse().forEach((n) => {
      renderItem(narrativesEl, n.summary, n.pattern || "none", "ok");
    });
  } catch (err) {
    $("reflection").textContent = "Boot error: " + err.message;
  }
}

function connectWs() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${protocol}://${location.host}`);

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    const type = data.type;
    const payload = data.payload || {};

    if (type === "event") {
      renderItem(feed, `${payload.type} • ${payload.user}`, `risk ${payload.risk}`, "ok");
    }

    if (type === "incident") {
      renderItem(
        incidentsEl,
        `${payload.type} • ${payload.user}`,
        `${payload.severity} • ${payload.action}`,
        payload.severity === "critical" ? "bad" : payload.severity === "high" ? "warn" : "ok"
      );
      renderItem(feed, `INCIDENT • ${payload.user}`, payload.correlationLabel || payload.severity, "bad");
    }

    if (type === "action") {
      renderItem(actionsEl, `${payload.type} • ${payload.targetUser}`, payload.reason || "issued", "warn");
    }

    if (type === "narrative") {
      renderItem(narrativesEl, payload.summary, payload.pattern || "none", "ok");
    }

    if (type === "identity") {
      setIdentityView(payload);
      $("reflection").textContent = payload.reflection || "No reflection available.";
    }
  };

  ws.onclose = () => {
    setTimeout(connectWs, 1500);
  };
}

boot();
connectWs();
