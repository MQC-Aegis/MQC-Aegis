import http from "http";
import express from "express";
import { WebSocketServer } from "ws";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

const app = express();
app.use(express.json());
app.use(express.static("public_dashboard"));

const PORT = Number(process.env.PHASE2_PORT || 3002);

let db;
let wss;

const globalEvents = [];
const incidentStore = [];
const actionStore = [];
const narrativeStore = [];
const trendStore = new Map();
const alertCooldown = new Map();

const systemIdentity = {
  baselineRisk: 35,
  baselineVolume: 100,
  tolerance: 0.2,
  lastUpdated: Date.now()
};

function nowIso() {
  return new Date().toISOString();
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function safeJson(v, fallback = []) {
  try {
    return JSON.stringify(v);
  } catch {
    return JSON.stringify(fallback);
  }
}

function broadcast(type, payload) {
  if (!wss) return;
  const msg = JSON.stringify({ type, payload });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

async function initDb() {
  db = await open({
    filename: "./signaldesk-phase2.db",
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT,
      user TEXT,
      riskScore INTEGER,
      severity TEXT,
      action TEXT,
      status TEXT,
      ip TEXT,
      amount REAL,
      reasonCodes TEXT,
      correlationLabel TEXT,
      trendLabel TEXT,
      createdAt TEXT
    );

    CREATE TABLE IF NOT EXISTS narratives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user TEXT,
      summary TEXT,
      pattern TEXT,
      learning TEXT,
      timestamp TEXT
    );
  `);
}

function evaluateRiskScore(event) {
  let riskScore = Number(event.risk || 0);

  if (event.type === "login" && Number(event.attempts || 0) >= 5) riskScore += 25;
  if (event.velocitySpike) riskScore += 20;
  if (event.geoMismatch) riskScore += 20;
  if ((event.ip || "").toLowerCase() === "unknown") riskScore += 10;
  if (event.type === "payment" && Number(event.amount || 0) >= 10000) riskScore += 20;

  return clamp(riskScore, 0, 100);
}

function severityFromRisk(riskScore) {
  if (riskScore >= 85) return "critical";
  if (riskScore >= 60) return "high";
  if (riskScore >= 35) return "medium";
  return "low";
}

function actionFromRisk(riskScore) {
  if (riskScore >= 85) return "block";
  if (riskScore >= 60) return "manual_review";
  if (riskScore >= 35) return "rate_limit";
  return "log";
}

function detectTrendAnomaly(event) {
  const key = event.type || "unknown";
  const bucket = trendStore.get(key) || { count: 0, recentRisk: [] };

  bucket.count += 1;
  bucket.recentRisk.push(Number(event.risk || 0));
  if (bucket.recentRisk.length > 20) bucket.recentRisk.shift();

  trendStore.set(key, bucket);

  const avgRisk =
    bucket.recentRisk.length > 0
      ? bucket.recentRisk.reduce((sum, n) => sum + n, 0) / bucket.recentRisk.length
      : 0;

  if (bucket.count >= 5 && avgRisk >= 50) return "surge";
  if (bucket.count >= 3 && avgRisk >= 30) return "spike";
  return "stable";
}

function detectSignalConvergence(event, context) {
  let score = 0;

  if (Number(event.risk || 0) > 70) score += 1;
  if (event.velocitySpike) score += 1;
  if (event.geoMismatch) score += 1;
  if (context.recentIncidents > 3) score += 1;

  if (score >= 3) {
    return {
      label: "convergent-threat",
      action: "block",
      confidence: "high"
    };
  }

  if (score === 2) {
    return {
      label: "multi-signal-risk",
      action: "manual_review",
      confidence: "medium"
    };
  }

  return {
    label: "none",
    action: null,
    confidence: "low"
  };
}

function getCurrentStats() {
  const recent = globalEvents.slice(-100);
  const avgRisk =
    recent.length > 0
      ? recent.reduce((sum, e) => sum + Number(e.risk || 0), 0) / recent.length
      : 0;

  return {
    avgRisk,
    volume: recent.length
  };
}

function evaluateIdentityDrift(currentStats) {
  const safeRiskBase = systemIdentity.baselineRisk || 1;
  const safeVolumeBase = systemIdentity.baselineVolume || 1;

  const riskDrift = currentStats.avgRisk - systemIdentity.baselineRisk;
  const volumeDrift = currentStats.volume - systemIdentity.baselineVolume;

  const driftScore =
    Math.abs(riskDrift) / safeRiskBase +
    Math.abs(volumeDrift) / safeVolumeBase;

  return {
    driftScore,
    status: driftScore > systemIdentity.tolerance ? "unstable" : "coherent",
    baselineRisk: systemIdentity.baselineRisk,
    baselineVolume: systemIdentity.baselineVolume,
    currentRisk: currentStats.avgRisk,
    currentVolume: currentStats.volume
  };
}

function adaptSystemIdentity(recentIncidents) {
  if (!recentIncidents.length) return systemIdentity;

  const avgRisk =
    recentIncidents.reduce((sum, i) => sum + Number(i.riskScore || 0), 0) /
    recentIncidents.length;

  systemIdentity.baselineRisk =
    Math.round(systemIdentity.baselineRisk * 0.8 + avgRisk * 0.2);

  systemIdentity.baselineVolume = Math.max(
    10,
    Math.round(systemIdentity.baselineVolume * 0.9 + globalEvents.slice(-100).length * 0.1)
  );

  systemIdentity.lastUpdated = Date.now();
  return systemIdentity;
}

function buildNarrative(event, decision) {
  return {
    user: event.user || "unknown",
    summary: `User ${event.user || "unknown"} triggered ${decision.action || "log"}`,
    pattern: decision.label || "none",
    learning:
      decision.confidence === "high"
        ? "Strong pattern detected"
        : decision.confidence === "medium"
        ? "Multiple signals aligned"
        : "Weak signal observed",
    timestamp: nowIso()
  };
}

function generateSystemReflection(identity, drift, incidents) {
  return [
    `System status: ${drift.status}.`,
    `Drift score: ${drift.driftScore.toFixed(2)}.`,
    `Baseline risk: ${identity.baselineRisk}.`,
    `Baseline volume: ${identity.baselineVolume}.`,
    `Current avg risk: ${drift.currentRisk.toFixed(2)}.`,
    `Current volume: ${drift.currentVolume}.`,
    `Recent behavior indicates ${
      drift.status === "unstable"
        ? "adaptive recalibration required"
        : "stable operational coherence"
    }.`,
    `Total incidents: ${incidents.length}.`,
    `Recommendation: ${
      drift.status === "unstable"
        ? "tighten thresholds and monitor convergence"
        : "maintain current strategy"
    }.`
  ].join(" ");
}

function dedupeCooldownKey(event, action) {
  return `${event.type || "unknown"}:${event.user || "unknown"}:${action || "log"}`;
}

function shouldCreateIncident(event, riskScore, convergence) {
  const cooldownKey = dedupeCooldownKey(event, convergence.action || actionFromRisk(riskScore));
  const lastTs = alertCooldown.get(cooldownKey) || 0;
  const now = Date.now();

  if (now - lastTs < 30000) {
    return { allow: false, reason: "cooldown_active" };
  }

  alertCooldown.set(cooldownKey, now);

  if (riskScore >= 35) return { allow: true, reason: "risk_threshold" };
  if (convergence.label !== "none") return { allow: true, reason: "signal_convergence" };
  return { allow: false, reason: "below_threshold" };
}

async function persistIncident(incident) {
  await db.run(
    `
    INSERT INTO incidents
    (type, user, riskScore, severity, action, status, ip, amount, reasonCodes, correlationLabel, trendLabel, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      incident.type,
      incident.user,
      incident.riskScore,
      incident.severity,
      incident.action,
      incident.status,
      incident.ip,
      incident.amount,
      safeJson(incident.reasonCodes),
      incident.correlationLabel,
      incident.trendLabel,
      incident.createdAt
    ]
  );
}

async function persistNarrative(narrative) {
  await db.run(
    `
    INSERT INTO narratives
    (user, summary, pattern, learning, timestamp)
    VALUES (?, ?, ?, ?, ?)
    `,
    [
      narrative.user,
      narrative.summary,
      narrative.pattern,
      narrative.learning,
      narrative.timestamp
    ]
  );
}

function buildReasonCodes(event, riskScore, convergence) {
  const codes = [];
  if (riskScore >= 85) codes.push("RISK_OVER_85");
  if (riskScore >= 60 && riskScore < 85) codes.push("RISK_OVER_60");
  if ((event.ip || "").toLowerCase() === "unknown") codes.push("UNSEEN_IP");
  if (event.velocitySpike) codes.push("VELOCITY_SPIKE");
  if (event.geoMismatch) codes.push("GEO_MISMATCH");
  if (Number(event.amount || 0) >= 10000) codes.push("LARGE_TRANSACTION");
  if (convergence.label === "convergent-threat") codes.push("SIGNAL_CONVERGENCE_HIGH");
  if (convergence.label === "multi-signal-risk") codes.push("SIGNAL_CONVERGENCE_MEDIUM");
  return codes.length ? codes : ["LOW_SIGNAL"];
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "MQC-Aegis Phase 2",
    ws: Boolean(wss),
    time: nowIso(),
    port: PORT
  });
});

app.get("/api/incidents", async (_req, res) => {
  try {
    const rows = await db.all(`SELECT * FROM incidents ORDER BY id DESC LIMIT 100`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/actions", (_req, res) => {
  res.json(actionStore.slice(-100).reverse());
});

app.get("/api/narratives", async (_req, res) => {
  try {
    const rows = await db.all(`SELECT * FROM narratives ORDER BY id DESC LIMIT 100`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/identity", (_req, res) => {
  const stats = getCurrentStats();
  const drift = evaluateIdentityDrift(stats);

  res.json({
    systemIdentity,
    drift,
    stats
  });
});

app.get("/api/summary", (_req, res) => {
  const stats = getCurrentStats();
  const drift = evaluateIdentityDrift(stats);
  const summary = generateSystemReflection(systemIdentity, drift, incidentStore.slice(-20));

  res.json({
    ok: true,
    summary,
    drift,
    identity: systemIdentity,
    incidents: incidentStore.length,
    actions: actionStore.length,
    narratives: narrativeStore.length
  });
});

app.post("/api/insights", (_req, res) => {
  const stats = getCurrentStats();
  const drift = evaluateIdentityDrift(stats);
  const summary = generateSystemReflection(systemIdentity, drift, incidentStore.slice(-20));

  res.json({
    ok: true,
    summary,
    drift,
    identity: systemIdentity
  });
});

app.post("/event", async (req, res) => {
  try {
    const body = req.body || {};
    const event = {
      id: globalEvents.length + 1,
      type: body.type || "unknown",
      user: body.user || "unknown",
      attempts: Number(body.attempts || 0),
      amount: Number(body.amount || 0),
      ip: body.ip || "unknown",
      risk: Number(body.risk || 0),
      geoMismatch: Boolean(body.geoMismatch),
      velocitySpike: Boolean(body.velocitySpike),
      createdAt: nowIso()
    };

    globalEvents.push(event);
    if (globalEvents.length > 1000) globalEvents.shift();

    const recentIncidentsForContext = incidentStore.filter(
      (i) => Date.now() - new Date(i.createdAt).getTime() < 15 * 60 * 1000
    );

    const trendLabel = detectTrendAnomaly(event);
    const riskScore = evaluateRiskScore(event);
    const severity = severityFromRisk(riskScore);
    const convergence = detectSignalConvergence(event, {
      recentIncidents: recentIncidentsForContext.length
    });

    const baseAction = actionFromRisk(riskScore);
    const finalAction = convergence.action || baseAction;

    const gate = shouldCreateIncident(event, riskScore, convergence);

    let incident = null;
    let narrative = null;
    let actionRecord = null;

    if (gate.allow) {
      incident = {
        id: incidentStore.length + 1,
        type: event.type,
        user: event.user,
        riskScore,
        severity,
        action: finalAction,
        status: finalAction === "block" ? "blocked" : "pending_review",
        ip: event.ip,
        amount: event.amount,
        reasonCodes: buildReasonCodes(event, riskScore, convergence),
        correlationLabel: convergence.label,
        trendLabel,
        createdAt: nowIso()
      };

      incidentStore.push(incident);
      if (incidentStore.length > 500) incidentStore.shift();

      await persistIncident(incident);

      actionRecord = {
        id: actionStore.length + 1,
        type: finalAction,
        targetUser: event.user,
        reason: convergence.label !== "none" ? convergence.label : severity,
        status: "issued",
        createdAt: nowIso()
      };

      actionStore.push(actionRecord);
      if (actionStore.length > 500) actionStore.shift();

      narrative = buildNarrative(event, {
        action: finalAction,
        label: convergence.label,
        confidence: convergence.confidence
      });

      narrativeStore.push(narrative);
      if (narrativeStore.length > 500) narrativeStore.shift();

      await persistNarrative(narrative);

      adaptSystemIdentity(incidentStore.slice(-20));

      broadcast("incident", incident);
      broadcast("action", actionRecord);
      broadcast("narrative", narrative);
    }

    const stats = getCurrentStats();
    const drift = evaluateIdentityDrift(stats);
    const reflection = generateSystemReflection(systemIdentity, drift, incidentStore.slice(-20));

    broadcast("event", event);
    broadcast("identity", {
      identity: systemIdentity,
      drift,
      reflection
    });

    res.json({
      ok: true,
      event,
      incidentCreated: Boolean(incident),
      incident,
      action: actionRecord,
      narrative,
      identity: systemIdentity,
      drift,
      reflection,
      gate
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

await initDb();

const server = http.createServer(app);
wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.send(
    JSON.stringify({
      type: "hello",
      payload: {
        message: "MQC-Aegis Phase 2 websocket connected",
        time: nowIso()
      }
    })
  );
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`MQC-Aegis Phase 2 listening on http://0.0.0.0:${PORT}`);
});
