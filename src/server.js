import http from "http";
import express from "express";

import { initDb, persistComparison, persistIncident, persistLearningLog, persistNarrative } from "./lib/db.js";
import { broadcast, setWss } from "./lib/runtime.js";
import {
  actionStore,
  alertCooldown,
  compareStore,
  globalEvents,
  incidentStore,
  learningState,
  narrativeStore,
  systemIdentity,
  trendStore,
  userMemory
} from "./lib/state.js";
import { nowIso, parseJsonSafe } from "./lib/utils.js";
import { WebSocketServer } from "ws";
import { buildNarrative, buildReasonCodes, shouldCreateIncident } from "./lib/domain.js";
import { resolveDecisionEngine } from "./lib/engine.js";
import {
  generateSystemReflection,
  getComparisonStats,
  getCurrentStats,
  adaptSystemIdentity,
  evaluateIdentityDrift,
  runAutoLearn
} from "./lib/learning.js";
import {
  loadUserMemory,
  updateUserMemoryFromDecision,
  updateUserMemoryFromEvent
} from "./lib/memory.js";
import { actionFromRisk, detectTrendAnomaly, severityFromRisk } from "./lib/risk.js";

const app = express();
app.use(express.json());
app.use(express.static("public_dashboard"));

const PORT = process.env.PORT || 3000;
const MQC_ENABLED = process.env.MQC_ENABLED === "true";
const MQC_MODE = process.env.MQC_MODE || "shadow";

const db = await initDb();
await loadUserMemory(db, userMemory);

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "SignalDesk",
    ws: Boolean(setWss),
    mqc: {
      enabled: MQC_ENABLED,
      mode: MQC_ENABLED ? MQC_MODE : "disabled"
    },
    autoLearn: {
      enabled: learningState.enabled,
      minComparisons: learningState.minComparisons,
      lastRunAt: learningState.lastRunAt || null
    },
    memoryUsers: userMemory.size,
    time: nowIso()
  });
});

app.get("/api/incidents", async (req, res) => {
  try {
    const rows = await db.all(`SELECT * FROM incidents ORDER BY id DESC LIMIT 100`);
    rows.forEach((r) => {
      r.reasonCodes = parseJsonSafe(r.reasonCodes, []);
    });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/actions", async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT id, user, action, severity, correlationLabel, createdAt
      FROM incidents
      ORDER BY id DESC
      LIMIT 100
    `);

    const actions = rows.map((r) => ({
      id: r.id,
      type: r.action,
      targetUser: r.user,
      reason: r.correlationLabel && r.correlationLabel !== "none" ? r.correlationLabel : r.severity,
      status: "issued",
      engineSource: "signaldesk",
      createdAt: r.createdAt
    }));

    res.json(actions);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/narratives", async (req, res) => {
  try {
    const rows = await db.all(`SELECT * FROM narratives ORDER BY id DESC LIMIT 100`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/identity", (req, res) => {
  const stats = getCurrentStats(globalEvents);
  const drift = evaluateIdentityDrift(systemIdentity, stats);

  res.json({
    systemIdentity,
    drift,
    stats,
    mqc: {
      enabled: MQC_ENABLED,
      mode: MQC_ENABLED ? MQC_MODE : "disabled"
    },
    autoLearn: {
      enabled: learningState.enabled,
      minComparisons: learningState.minComparisons,
      lastRunAt: learningState.lastRunAt || null
    },
    userMemory: {
      users: userMemory.size
    }
  });
});

app.get("/api/mqc", (req, res) => {
  res.json({
    ok: true,
    enabled: MQC_ENABLED,
    mode: MQC_ENABLED ? MQC_MODE : "disabled",
    contract: {
      source: "mqc-aegis",
      modes: ["shadow", "primary"],
      fields: [
        "enabled",
        "mode",
        "source",
        "riskDelta",
        "recommendedAction",
        "label",
        "confidence"
      ]
    }
  });
});

app.get("/api/mqc/compare", async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT *
      FROM engine_comparisons
      ORDER BY id DESC
      LIMIT 100
    `);

    rows.forEach((r) => {
      r.payload = parseJsonSafe(r.payload, {});
      r.differs = Boolean(r.differs);
      r.promotedByMQC = Boolean(r.promotedByMQC);
      r.mqcEnabled = Boolean(r.mqcEnabled);
    });

    res.json(rows);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/mqc/stats", async (req, res) => {
  try {
    const stats = await getComparisonStats(db, 500);
    const rows = await db.all(`
      SELECT *
      FROM learning_log
      ORDER BY id DESC
      LIMIT 1
    `);

    res.json({
      ok: true,
      total: stats.total,
      differs: stats.differs,
      promotedByMQC: stats.promotedByMQC,
      diffRate: Number(stats.diffRate.toFixed(4)),
      promotionRate: Number(stats.promotionRate.toFixed(4)),
      avgMergedRisk: Number(stats.avgMergedRisk.toFixed(2)),
      latestLearning: rows[0] || null
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/learning/logs", async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT *
      FROM learning_log
      ORDER BY id DESC
      LIMIT 50
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/learning/run", async (req, res) => {
  try {
    const result = await runAutoLearn({
      db,
      persistLearningLog,
      learningState,
      systemIdentity,
      globalEvents
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/learning/config", (req, res) => {
  const body = req.body || {};

  if (typeof body.enabled === "boolean") {
    learningState.enabled = body.enabled;
  }

  if (Number.isFinite(body.minComparisons)) {
    learningState.minComparisons = Math.max(3, Math.min(200, Math.round(body.minComparisons)));
  }

  res.json({
    ok: true,
    autoLearn: {
      enabled: learningState.enabled,
      minComparisons: learningState.minComparisons,
      lastRunAt: learningState.lastRunAt || null
    }
  });
});

app.get("/api/users/memory", async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT *
      FROM user_memory
      ORDER BY trustScore ASC, totalIncidents DESC, updatedAt DESC
      LIMIT 100
    `);

    rows.forEach((r) => {
      r.knownIps = parseJsonSafe(r.knownIps, []);
    });

    res.json(rows);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/users/memory/:user", async (req, res) => {
  try {
    const row = await db.get(`
      SELECT *
      FROM user_memory
      WHERE user = ?
    `, [req.params.user]);

    if (!row) {
      res.status(404).json({ ok: false, error: "user not found" });
      return;
    }

    row.knownIps = parseJsonSafe(row.knownIps, []);
    res.json(row);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/summary", async (req, res) => {
  try {
    const recentIncidents = await db.all(`
      SELECT *
      FROM incidents
      ORDER BY id DESC
      LIMIT 20
    `);

    recentIncidents.forEach((r) => {
      r.reasonCodes = parseJsonSafe(r.reasonCodes, []);
    });

    const totals = await db.get(`
      SELECT
        COUNT(*) AS incidents,
        COALESCE(SUM(CASE WHEN action IS NOT NULL AND action != '' THEN 1 ELSE 0 END), 0) AS actions
      FROM incidents
    `);

    const narrativeTotals = await db.get(`
      SELECT COUNT(*) AS narratives
      FROM narratives
    `);

    const currentRisk = recentIncidents.length
      ? recentIncidents.reduce((sum, r) => sum + Number(r.riskScore || 0), 0) / recentIncidents.length
      : 0;

    const stats = {
      avgRisk: Number(currentRisk.toFixed(2)),
      volume: recentIncidents.length
    };

    const drift = evaluateIdentityDrift(systemIdentity, stats);

    const summary = generateSystemReflection(systemIdentity, drift, recentIncidents, {
      mode: MQC_ENABLED ? MQC_MODE : "signaldesk-only",
      source: "signaldesk"
    });

    res.json({
      ok: true,
      summary,
      drift,
      identity: systemIdentity,
      incidents: totals?.incidents || 0,
      actions: totals?.actions || 0,
      narratives: narrativeTotals?.narratives || 0,
      mqc: {
        enabled: MQC_ENABLED,
        mode: MQC_ENABLED ? MQC_MODE : "disabled"
      },
      autoLearn: {
        enabled: learningState.enabled,
        minComparisons: learningState.minComparisons,
        lastRunAt: learningState.lastRunAt || null
      },
      userMemory: {
        users: userMemory.size
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/insights", (req, res) => {
  const stats = getCurrentStats(globalEvents);
  const drift = evaluateIdentityDrift(systemIdentity, stats);
  const summary = generateSystemReflection(systemIdentity, drift, incidentStore.slice(-20), {
    mode: MQC_ENABLED ? MQC_MODE : "signaldesk-only",
    source: "signaldesk"
  });

  res.json({
    ok: true,
    summary,
    drift,
    identity: systemIdentity,
    mqc: {
      enabled: MQC_ENABLED,
      mode: MQC_ENABLED ? MQC_MODE : "disabled"
    }
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

    const mem = await updateUserMemoryFromEvent(db, userMemory, event);

    const recentIncidentsForContext = incidentStore.filter(
      (i) => Date.now() - new Date(i.createdAt).getTime() < 15 * 60 * 1000
    );

    const trendLabel = detectTrendAnomaly(event, trendStore);

    const resolved = resolveDecisionEngine({
      MQC_ENABLED,
      MQC_MODE,
      event,
      context: { recentIncidents: recentIncidentsForContext.length },
      mem
    });

    const riskScore = resolved.riskScore;
    const memoryAdjustedRiskScore = resolved.memoryAdjustedRiskScore;
    const memoryFactors = resolved.memoryFactors;
    const convergence = resolved.convergence;
    const engineMeta = resolved.engineMeta;
    const comparison = resolved.comparison;
    const severity = severityFromRisk(riskScore);
    const finalAction = convergence.action || actionFromRisk(riskScore);

    compareStore.unshift(comparison);
    if (compareStore.length > 500) compareStore.pop();
    await persistComparison(db, comparison);
    broadcast("mqc_compare", comparison);

    const gate = shouldCreateIncident(alertCooldown, event, riskScore, convergence);

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
        reasonCodes: buildReasonCodes(event, riskScore, convergence, memoryFactors),
        correlationLabel: convergence.label,
        trendLabel,
        createdAt: nowIso()
      };

      incidentStore.push(incident);
      if (incidentStore.length > 500) incidentStore.shift();

      await persistIncident(db, incident);

      actionRecord = {
        id: actionStore.length + 1,
        type: finalAction,
        targetUser: event.user,
        reason: convergence.label !== "none" ? convergence.label : severity,
        status: "issued",
        engineSource: convergence.source,
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

      await persistNarrative(db, narrative);

      adaptSystemIdentity(systemIdentity, globalEvents, incidentStore.slice(-20));

      broadcast("incident", incident);
      broadcast("action", actionRecord);
      broadcast("narrative", narrative);
    }

    const updatedMem = await updateUserMemoryFromDecision(db, mem, event, incident, actionRecord);
    broadcast("user_memory", updatedMem);

    if (compareStore.length >= learningState.minComparisons && Date.now() - learningState.lastRunAt > 5000) {
      try {
        await runAutoLearn({
          db,
          persistLearningLog,
          learningState,
          systemIdentity,
          globalEvents
        });
      } catch (err) {
        console.error("Auto-learn failed:", err.message);
      }
    }

    const stats = getCurrentStats(globalEvents);
    const drift = evaluateIdentityDrift(systemIdentity, stats);
    const reflection = generateSystemReflection(systemIdentity, drift, incidentStore.slice(-20), engineMeta);

    broadcast("event", event);
    broadcast("identity", {
      identity: systemIdentity,
      drift,
      reflection,
      mqc: {
        enabled: MQC_ENABLED,
        mode: MQC_ENABLED ? MQC_MODE : "disabled",
        source: engineMeta.source
      },
      autoLearn: {
        enabled: learningState.enabled,
        minComparisons: learningState.minComparisons,
        lastRunAt: learningState.lastRunAt || null
      }
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
      gate,
      engineMeta,
      memoryAdjustedRiskScore,
      memoryFactors,
      userMemory: updatedMem,
      comparison,
      mqc: {
        enabled: MQC_ENABLED,
        mode: MQC_ENABLED ? MQC_MODE : "disabled"
      },
      autoLearn: {
        enabled: learningState.enabled,
        minComparisons: learningState.minComparisons,
        lastRunAt: learningState.lastRunAt || null
      }
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
setWss(wss);

wss.on("connection", (ws) => {
  ws.send(
    JSON.stringify({
      type: "hello",
      payload: {
        message: "SignalDesk websocket connected",
        time: nowIso(),
        mqc: {
          enabled: MQC_ENABLED,
          mode: MQC_ENABLED ? MQC_MODE : "disabled"
        },
        autoLearn: {
          enabled: learningState.enabled,
          minComparisons: learningState.minComparisons,
          lastRunAt: learningState.lastRunAt || null
        },
        userMemory: {
          users: userMemory.size
        }
      }
    })
  );
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`SignalDesk listening on http://0.0.0.0:${PORT}`);
  console.log(`MQC ready: enabled=${MQC_ENABLED} mode=${MQC_ENABLED ? MQC_MODE : "disabled"}`);
  console.log(`Auto-learn: enabled=${learningState.enabled} minComparisons=${learningState.minComparisons}`);
  console.log(`User memory loaded: ${userMemory.size}`);
});
