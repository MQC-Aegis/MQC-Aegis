import http from "http";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const NODE_ENV = process.env.NODE_ENV || "development";
const DB_FILE = path.resolve(process.env.DB_FILE || "./signaldesk.db");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "..", "public_dashboard");

app.use(express.static(publicDir));

let db;
let isShuttingDown = false;

const incidentStore = [];
const actionStore = [];
const eventStore = [];

function resetArray(target, items) {
  target.length = 0;
  target.push(...items);
}

function normalizeEvent(input = {}) {
  return {
    type: String(input.type || "unknown").toLowerCase(),
    user: String(input.user || "anonymous"),
    amount: Number(input.amount || 0),
    risk: Number(input.risk || 0),
    attempts: Number(input.attempts || 0),
    ip: String(input.ip || "unknown"),
    geoMismatch: Boolean(input.geoMismatch || false),
    velocitySpike: Boolean(input.velocitySpike || false),
    timestamp: new Date().toISOString()
  };
}

function getRecentEvents({ user, seconds = 120 }) {
  const cutoff = Date.now() - seconds * 1000;
  return eventStore.filter((item) => {
    return item.user === user && new Date(item.timestamp).getTime() >= cutoff;
  });
}

function detectTrendAnomaly(event) {
  const recentUserEvents = getRecentEvents({ user: event.user, seconds: 120 });
  const sameTypeCount = recentUserEvents.filter((e) => e.type === event.type).length;

  if (recentUserEvents.length >= 5 || sameTypeCount >= 4) {
    return { label: "spike", scoreBoost: 20, reasonCodes: ["TREND_SPIKE"] };
  }

  if (recentUserEvents.length >= 3 || sameTypeCount >= 2) {
    return { label: "elevated", scoreBoost: 10, reasonCodes: ["TREND_ELEVATED"] };
  }

  return { label: "normal", scoreBoost: 0, reasonCodes: [] };
}

function detectCorrelation(event) {
  let signals = 0;
  const reasonCodes = [];

  if (event.velocitySpike) { signals += 1; reasonCodes.push("VELOCITY_SPIKE"); }
  if (event.geoMismatch) { signals += 1; reasonCodes.push("GEO_MISMATCH"); }
  if (event.attempts >= 3) { signals += 1; reasonCodes.push("REPEAT_ATTEMPTS"); }
  if (event.amount > 10000) { signals += 1; reasonCodes.push("HIGH_AMOUNT"); }
  if (event.ip === "unknown") { signals += 1; reasonCodes.push("UNSEEN_IP"); }
  if (event.risk >= 60) { signals += 1; reasonCodes.push("BASE_RISK_HIGH"); }

  if (signals >= 4) {
    return { label: "critical_chain", scoreBoost: 25, reasonCodes };
  }

  if (signals >= 2) {
    return { label: "multi_signal", scoreBoost: 12, reasonCodes };
  }

  return { label: "none", scoreBoost: 0, reasonCodes };
}

function calculateRiskScore(event, trend, correlation) {
  let score = 0;
  const reasonCodes = [];

  score += event.risk;
  if (event.risk > 0) reasonCodes.push("BASE_RISK");

  if (event.attempts >= 3) { score += 20; reasonCodes.push("ATTEMPTS_OVER_3"); }
  if (event.amount > 10000) { score += 25; reasonCodes.push("AMOUNT_OVER_10000"); }
  if (event.geoMismatch) { score += 20; reasonCodes.push("GEO_MISMATCH"); }
  if (event.velocitySpike) { score += 15; reasonCodes.push("VELOCITY_SPIKE"); }
  if (event.ip === "unknown") { score += 10; reasonCodes.push("UNKNOWN_IP"); }

  score += trend.scoreBoost;
  score += correlation.scoreBoost;

  reasonCodes.push(...trend.reasonCodes);
  reasonCodes.push(...correlation.reasonCodes);

  if (score > 100) score = 100;

  return {
    score,
    reasonCodes: [...new Set(reasonCodes)]
  };
}

function decideAction(riskScore, context) {
  if (riskScore >= 90 || context.correlationLabel === "critical_chain") {
    return {
      action: "block",
      severity: "critical",
      status: "pending_review",
      reason: "Critical multi-signal risk detected"
    };
  }

  if (
    riskScore >= 70 ||
    context.trendLabel === "spike" ||
    context.correlationLabel === "multi_signal"
  ) {
    return {
      action: "manual_review",
      severity: "high",
      status: "open",
      reason: "Escalated risk pattern requires analyst review"
    };
  }

  if (riskScore >= 40 || context.trendLabel === "elevated") {
    return {
      action: "rate_limit",
      severity: "medium",
      status: "monitor",
      reason: "Risk is elevated and should be monitored"
    };
  }

  return {
    action: "allow",
    severity: "low",
    status: "ok",
    reason: "Risk is within acceptable range"
  };
}

function createIncident(event, riskScore, decision, trend, correlation, reasonCodes) {
  return {
    type: event.type,
    user: event.user,
    amount: event.amount,
    ip: event.ip,
    risk: event.risk,
    riskScore,
    severity: decision.severity,
    action: decision.action,
    status: decision.status,
    reason: decision.reason,
    reasonCodes,
    trendLabel: trend.label,
    correlationLabel: correlation.label,
    geoMismatch: event.geoMismatch,
    velocitySpike: event.velocitySpike,
    attempts: event.attempts,
    createdAt: event.timestamp
  };
}

function createActionLog(event, riskScore, decision, incidentId, trendLabel, correlationLabel) {
  return {
    incidentId,
    user: event.user,
    type: event.type,
    action: decision.action,
    severity: decision.severity,
    status: decision.status,
    reason: decision.reason,
    riskScore,
    trendLabel,
    correlationLabel,
    createdAt: event.timestamp
  };
}

function parseBooleanParam(value) {
  if (value === undefined) return undefined;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function applyIncidentFilters(items, query) {
  const severity = query.severity ? String(query.severity).toLowerCase() : null;
  const type = query.type ? String(query.type).toLowerCase() : null;
  const action = query.action ? String(query.action).toLowerCase() : null;
  const status = query.status ? String(query.status).toLowerCase() : null;
  const user = query.user ? String(query.user).toLowerCase() : null;
  const trendLabel = query.trendLabel ? String(query.trendLabel).toLowerCase() : null;
  const correlationLabel = query.correlationLabel ? String(query.correlationLabel).toLowerCase() : null;
  const geoMismatch = parseBooleanParam(query.geoMismatch);
  const velocitySpike = parseBooleanParam(query.velocitySpike);
  const minRiskScore = query.minRiskScore !== undefined ? Number(query.minRiskScore) : null;
  const maxRiskScore = query.maxRiskScore !== undefined ? Number(query.maxRiskScore) : null;
  const limit = parsePositiveInt(query.limit, 50);

  return items
    .filter((item) => !severity || item.severity?.toLowerCase() === severity)
    .filter((item) => !type || item.type?.toLowerCase() === type)
    .filter((item) => !action || item.action?.toLowerCase() === action)
    .filter((item) => !status || item.status?.toLowerCase() === status)
    .filter((item) => !user || item.user?.toLowerCase().includes(user))
    .filter((item) => !trendLabel || item.trendLabel?.toLowerCase() === trendLabel)
    .filter((item) => !correlationLabel || item.correlationLabel?.toLowerCase() === correlationLabel)
    .filter((item) => geoMismatch === undefined || item.geoMismatch === geoMismatch)
    .filter((item) => velocitySpike === undefined || item.velocitySpike === velocitySpike)
    .filter((item) => minRiskScore === null || item.riskScore >= minRiskScore)
    .filter((item) => maxRiskScore === null || item.riskScore <= maxRiskScore)
    .slice(0, limit);
}

function applyActionFilters(items, query) {
  const severity = query.severity ? String(query.severity).toLowerCase() : null;
  const type = query.type ? String(query.type).toLowerCase() : null;
  const action = query.action ? String(query.action).toLowerCase() : null;
  const status = query.status ? String(query.status).toLowerCase() : null;
  const user = query.user ? String(query.user).toLowerCase() : null;
  const trendLabel = query.trendLabel ? String(query.trendLabel).toLowerCase() : null;
  const correlationLabel = query.correlationLabel ? String(query.correlationLabel).toLowerCase() : null;
  const minRiskScore = query.minRiskScore !== undefined ? Number(query.minRiskScore) : null;
  const maxRiskScore = query.maxRiskScore !== undefined ? Number(query.maxRiskScore) : null;
  const limit = parsePositiveInt(query.limit, 50);

  return items
    .filter((item) => !severity || item.severity?.toLowerCase() === severity)
    .filter((item) => !type || item.type?.toLowerCase() === type)
    .filter((item) => !action || item.action?.toLowerCase() === action)
    .filter((item) => !status || item.status?.toLowerCase() === status)
    .filter((item) => !user || item.user?.toLowerCase().includes(user))
    .filter((item) => !trendLabel || item.trendLabel?.toLowerCase() === trendLabel)
    .filter((item) => !correlationLabel || item.correlationLabel?.toLowerCase() === correlationLabel)
    .filter((item) => minRiskScore === null || item.riskScore >= minRiskScore)
    .filter((item) => maxRiskScore === null || item.riskScore <= maxRiskScore)
    .slice(0, limit);
}

function countBy(items, key, allowedValues = []) {
  const initial = Object.fromEntries(allowedValues.map((value) => [value, 0]));
  for (const item of items) {
    const value = item?.[key] ?? "unknown";
    initial[value] = (initial[value] || 0) + 1;
  }
  return initial;
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(payload) {
  const message = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(message);
    }
  }
}

async function initDb() {
  db = await open({
    filename: DB_FILE,
    driver: sqlite3.Database
  });

  await db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT,
      user TEXT,
      amount REAL,
      risk INTEGER,
      attempts INTEGER,
      ip TEXT,
      geoMismatch INTEGER,
      velocitySpike INTEGER,
      timestamp TEXT
    );

    CREATE TABLE IF NOT EXISTS incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT,
      user TEXT,
      amount REAL,
      ip TEXT,
      risk INTEGER,
      riskScore INTEGER,
      severity TEXT,
      action TEXT,
      status TEXT,
      reason TEXT,
      reasonCodes TEXT,
      trendLabel TEXT,
      correlationLabel TEXT,
      geoMismatch INTEGER,
      velocitySpike INTEGER,
      attempts INTEGER,
      createdAt TEXT
    );

    CREATE TABLE IF NOT EXISTS actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incidentId INTEGER,
      user TEXT,
      type TEXT,
      action TEXT,
      severity TEXT,
      status TEXT,
      reason TEXT,
      riskScore INTEGER,
      trendLabel TEXT,
      correlationLabel TEXT,
      createdAt TEXT
    );
  `);
}

function parseIncidentRow(row) {
  return {
    ...row,
    geoMismatch: Boolean(row.geoMismatch),
    velocitySpike: Boolean(row.velocitySpike),
    reasonCodes: row.reasonCodes ? JSON.parse(row.reasonCodes) : []
  };
}

function parseEventRow(row) {
  return {
    ...row,
    geoMismatch: Boolean(row.geoMismatch),
    velocitySpike: Boolean(row.velocitySpike)
  };
}

async function hydrateStores() {
  const dbEvents = await db.all(`SELECT * FROM events ORDER BY id DESC LIMIT 500`);
  const dbIncidents = await db.all(`SELECT * FROM incidents ORDER BY id DESC LIMIT 100`);
  const dbActions = await db.all(`SELECT * FROM actions ORDER BY id DESC LIMIT 100`);

  resetArray(eventStore, dbEvents.map(parseEventRow));
  resetArray(incidentStore, dbIncidents.map(parseIncidentRow));
  resetArray(actionStore, dbActions);
}

function buildSummary() {
  return {
    totals: {
      incidents: incidentStore.length,
      actions: actionStore.length,
      events: eventStore.length
    },
    severity: countBy(incidentStore, "severity", ["critical", "high", "medium", "low"]),
    actions: countBy(actionStore, "action", ["block", "manual_review", "rate_limit", "allow"]),
    trends: countBy(incidentStore, "trendLabel", ["spike", "elevated", "normal"]),
    correlations: countBy(incidentStore, "correlationLabel", ["critical_chain", "multi_signal", "none"]),
    latest: {
      incident: incidentStore[0] || null,
      action: actionStore[0] || null
    }
  };
}

wss.on("connection", (socket) => {
  socket.send(JSON.stringify({
    type: "bootstrap",
    incidents: incidentStore,
    actions: actionStore,
    summary: buildSummary()
  }));
});


app.post("/api/admin/clear-demo", async (_req, res) => {
  try {
    if (db) {
      await db.close();
      db = null;
    }

    await fs.promises.unlink(DB_FILE).catch((err) => {
      if (err && err.code !== "ENOENT") throw err;
    });

    incidentStore.length = 0;
    actionStore.length = 0;
    eventStore.length = 0;

    await initDb();

    if (typeof broadcast === "function") {
      broadcast({
        type: "event_processed",
        incidents: incidentStore,
        actions: actionStore,
        summary: {
          totals: { incidents: 0, actions: 0, events: 0 },
          severity: { critical: 0, high: 0, medium: 0, low: 0 },
          actions: { block: 0, manual_review: 0, rate_limit: 0, allow: 0 },
          trends: { spike: 0, elevated: 0, normal: 0 },
          correlations: { critical_chain: 0, multi_signal: 0, none: 0 },
          latest: { incident: null, action: null }
        }
      });
    }

    return res.json({
      ok: true,
      cleared: true,
      db: "signaldesk.db",
      incidents: 0,
      actions: 0,
      events: 0
    });
  } catch (err) {
    console.error("[SignalDesk] clear-demo failed:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "Clear demo failed."
    });
  }
});


app.get("/health", (_req, res) => {
  const healthOk = !isShuttingDown && !!db;
  res.status(healthOk ? 200 : 503).json({
    ok: healthOk,
    service: "SignalDesk",
    phase: "D5",
    env: NODE_ENV,
    incidents: incidentStore.length,
    actions: actionStore.length,
    events: eventStore.length,
    ws: true,
    db: path.basename(DB_FILE),
    shuttingDown: isShuttingDown
  });
});

app.get("/api/incidents", (req, res) => {
  const incidents = applyIncidentFilters(incidentStore, req.query);
  res.json({ ok: true, count: incidents.length, filters: req.query, incidents });
});

app.get("/api/actions", (req, res) => {
  const actions = applyActionFilters(actionStore, req.query);
  res.json({ ok: true, count: actions.length, filters: req.query, actions });
});

app.get("/api/summary", (_req, res) => {
  res.json({ ok: true, ...buildSummary() });
});

app.post("/event", async (req, res) => {
  try {
    if (isShuttingDown) {
      return res.status(503).json({ ok: false, error: "Service is shutting down" });
    }

    const normalized = normalizeEvent(req.body);
    const trend = detectTrendAnomaly(normalized);
    const correlation = detectCorrelation(normalized);
    const riskResult = calculateRiskScore(normalized, trend, correlation);

    const decision = decideAction(riskResult.score, {
      trendLabel: trend.label,
      correlationLabel: correlation.label
    });

    const eventInsert = await db.run(
      `INSERT INTO events (type, user, amount, risk, attempts, ip, geoMismatch, velocitySpike, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        normalized.type,
        normalized.user,
        normalized.amount,
        normalized.risk,
        normalized.attempts,
        normalized.ip,
        normalized.geoMismatch ? 1 : 0,
        normalized.velocitySpike ? 1 : 0,
        normalized.timestamp
      ]
    );

    const incidentDraft = createIncident(
      normalized,
      riskResult.score,
      decision,
      trend,
      correlation,
      riskResult.reasonCodes
    );

    const incidentInsert = await db.run(
      `INSERT INTO incidents (
        type, user, amount, ip, risk, riskScore, severity, action, status, reason,
        reasonCodes, trendLabel, correlationLabel, geoMismatch, velocitySpike, attempts, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        incidentDraft.type,
        incidentDraft.user,
        incidentDraft.amount,
        incidentDraft.ip,
        incidentDraft.risk,
        incidentDraft.riskScore,
        incidentDraft.severity,
        incidentDraft.action,
        incidentDraft.status,
        incidentDraft.reason,
        JSON.stringify(incidentDraft.reasonCodes),
        incidentDraft.trendLabel,
        incidentDraft.correlationLabel,
        incidentDraft.geoMismatch ? 1 : 0,
        incidentDraft.velocitySpike ? 1 : 0,
        incidentDraft.attempts,
        incidentDraft.createdAt
      ]
    );

    const incident = { id: incidentInsert.lastID, ...incidentDraft };

    const actionDraft = createActionLog(
      normalized,
      riskResult.score,
      decision,
      incident.id,
      incident.trendLabel,
      incident.correlationLabel
    );

    const actionInsert = await db.run(
      `INSERT INTO actions (
        incidentId, user, type, action, severity, status, reason,
        riskScore, trendLabel, correlationLabel, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        actionDraft.incidentId,
        actionDraft.user,
        actionDraft.type,
        actionDraft.action,
        actionDraft.severity,
        actionDraft.status,
        actionDraft.reason,
        actionDraft.riskScore,
        actionDraft.trendLabel,
        actionDraft.correlationLabel,
        actionDraft.createdAt
      ]
    );

    const actionLog = { id: actionInsert.lastID, ...actionDraft };

    eventStore.unshift({ id: eventInsert.lastID, ...normalized });
    incidentStore.unshift(incident);
    actionStore.unshift(actionLog);

    if (eventStore.length > 500) eventStore.pop();
    if (incidentStore.length > 100) incidentStore.pop();
    if (actionStore.length > 100) actionStore.pop();

    const summary = buildSummary();

    broadcast({
      type: "event_processed",
      incident,
      actionLog,
      incidents: incidentStore,
      actions: actionStore,
      summary
    });

    return res.json({
      ok: true,
      event: normalized,
      trend,
      correlation,
      riskScore: riskResult.score,
      reasonCodes: riskResult.reasonCodes,
      decision,
      incidentCreated: true,
      incident,
      actionLogged: true,
      actionLog,
      summary
    });
  } catch (err) {
    console.error("POST /event failed:", err);
    return res.status(400).json({
      ok: false,
      error: err.message || "Invalid event payload"
    });
  }
});

app.get("/{*any}", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[SignalDesk] ${signal} received, shutting down gracefully...`);

  wss.clients.forEach((client) => {
    try { client.close(); } catch {}
  });

  server.close(async () => {
    try {
      if (db) await db.close();
      console.log("[SignalDesk] Shutdown complete.");
      process.exit(0);
    } catch (err) {
      console.error("[SignalDesk] Shutdown error:", err);
      process.exit(1);
    }
  });

  setTimeout(() => {
    console.error("[SignalDesk] Forced shutdown after timeout.");
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("unhandledRejection", (err) => {
  console.error("[SignalDesk] Unhandled rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("[SignalDesk] Uncaught exception:", err);
});

async function start() {
  await initDb();
  await hydrateStores();

  server.listen(PORT, HOST, () => {
    console.log(`SignalDesk Phase D5 listening on http://${HOST}:${PORT}`);
    console.log(`Using database: ${DB_FILE}`);
    console.log(`Environment: ${NODE_ENV}`);
  });
}

start().catch((err) => {
  console.error("Failed to start SignalDesk:", err);
  process.exit(1);
});
