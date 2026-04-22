import http from "http";
import express from "express";
import { WebSocketServer } from "ws";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

const app = express();
app.use(express.json());
app.use(express.static("public_dashboard"));

const PORT = process.env.PORT || 3000;
const MQC_ENABLED = process.env.MQC_ENABLED === "true";
const MQC_MODE = process.env.MQC_MODE || "shadow";

let db;
let wss;

const globalEvents = [];
const incidentStore = [];
const actionStore = [];
const narrativeStore = [];
const trendStore = new Map();
const alertCooldown = new Map();
const compareStore = [];
const userMemory = new Map();

const systemIdentity = {
  baselineRisk: 35,
  baselineVolume: 100,
  tolerance: 0.2,
  lastUpdated: Date.now(),
  learningCycles: 0,
  lastLearningAt: null
};

const learningState = {
  enabled: true,
  minComparisons: 8,
  lastRunAt: 0
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

function parseJsonSafe(v, fallback = null) {
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
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
    filename: "./signaldesk.db",
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

    CREATE TABLE IF NOT EXISTS engine_comparisons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      eventId INTEGER,
      eventType TEXT,
      user TEXT,
      localRiskScore INTEGER,
      mergedRiskScore INTEGER,
      localAction TEXT,
      finalAction TEXT,
      localLabel TEXT,
      finalLabel TEXT,
      localConfidence TEXT,
      finalConfidence TEXT,
      localSource TEXT,
      finalSource TEXT,
      mqcEnabled INTEGER,
      mqcMode TEXT,
      mqcRiskDelta INTEGER,
      mqcRecommendedAction TEXT,
      mqcLabel TEXT,
      mqcConfidence TEXT,
      differs INTEGER,
      promotedByMQC INTEGER,
      payload TEXT,
      createdAt TEXT
    );

    CREATE TABLE IF NOT EXISTS learning_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      previousBaselineRisk INTEGER,
      newBaselineRisk INTEGER,
      previousBaselineVolume INTEGER,
      newBaselineVolume INTEGER,
      previousTolerance REAL,
      newTolerance REAL,
      diffRate REAL,
      promotionRate REAL,
      samples INTEGER,
      note TEXT,
      createdAt TEXT
    );

    CREATE TABLE IF NOT EXISTS user_memory (
      user TEXT PRIMARY KEY,
      totalEvents INTEGER DEFAULT 0,
      totalIncidents INTEGER DEFAULT 0,
      totalActions INTEGER DEFAULT 0,
      avgRisk REAL DEFAULT 0,
      lastRisk REAL DEFAULT 0,
      trustScore INTEGER DEFAULT 50,
      riskMomentum REAL DEFAULT 0,
      lastAction TEXT,
      lastSeverity TEXT,
      knownIpCount INTEGER DEFAULT 0,
      knownIps TEXT DEFAULT '[]',
      lastSeenAt TEXT,
      updatedAt TEXT
    );
  `);
}

async function loadUserMemory() {
  const rows = await db.all(`SELECT * FROM user_memory`);
  for (const row of rows) {
    userMemory.set(row.user, {
      user: row.user,
      totalEvents: Number(row.totalEvents || 0),
      totalIncidents: Number(row.totalIncidents || 0),
      totalActions: Number(row.totalActions || 0),
      avgRisk: Number(row.avgRisk || 0),
      lastRisk: Number(row.lastRisk || 0),
      trustScore: Number(row.trustScore || 50),
      riskMomentum: Number(row.riskMomentum || 0),
      lastAction: row.lastAction || null,
      lastSeverity: row.lastSeverity || null,
      knownIpCount: Number(row.knownIpCount || 0),
      knownIps: parseJsonSafe(row.knownIps, []),
      lastSeenAt: row.lastSeenAt || null,
      updatedAt: row.updatedAt || null
    });
  }
}

function getUserMemory(user) {
  if (!userMemory.has(user)) {
    userMemory.set(user, {
      user,
      totalEvents: 0,
      totalIncidents: 0,
      totalActions: 0,
      avgRisk: 0,
      lastRisk: 0,
      trustScore: 50,
      riskMomentum: 0,
      lastAction: null,
      lastSeverity: null,
      knownIpCount: 0,
      knownIps: [],
      lastSeenAt: null,
      updatedAt: null
    });
  }
  return userMemory.get(user);
}

async function persistUserMemory(mem) {
  await db.run(
    `
    INSERT INTO user_memory (
      user, totalEvents, totalIncidents, totalActions, avgRisk, lastRisk,
      trustScore, riskMomentum, lastAction, lastSeverity, knownIpCount,
      knownIps, lastSeenAt, updatedAt
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user) DO UPDATE SET
      totalEvents=excluded.totalEvents,
      totalIncidents=excluded.totalIncidents,
      totalActions=excluded.totalActions,
      avgRisk=excluded.avgRisk,
      lastRisk=excluded.lastRisk,
      trustScore=excluded.trustScore,
      riskMomentum=excluded.riskMomentum,
      lastAction=excluded.lastAction,
      lastSeverity=excluded.lastSeverity,
      knownIpCount=excluded.knownIpCount,
      knownIps=excluded.knownIps,
      lastSeenAt=excluded.lastSeenAt,
      updatedAt=excluded.updatedAt
    `,
    [
      mem.user,
      mem.totalEvents,
      mem.totalIncidents,
      mem.totalActions,
      mem.avgRisk,
      mem.lastRisk,
      mem.trustScore,
      mem.riskMomentum,
      mem.lastAction,
      mem.lastSeverity,
      mem.knownIpCount,
      safeJson(mem.knownIps, []),
      mem.lastSeenAt,
      mem.updatedAt
    ]
  );
}

function evaluateRiskScore(event) {
  const baseRisk = Number(event.risk || 0);
  let riskScore = baseRisk;

  if (event.type === "login") {
    const attempts = Number(event.attempts || 0);
    if (attempts >= 8) riskScore += 16;
    else if (attempts >= 6) riskScore += 12;
    else if (attempts >= 4) riskScore += 8;
  }

  if (event.velocitySpike) riskScore += 9;
  if (event.geoMismatch) riskScore += 11;
  if ((event.ip || "").toLowerCase() === "unknown") riskScore += 5;

  if (event.type === "payment") {
    const amount = Number(event.amount || 0);
    if (amount >= 50000) riskScore += 18;
    else if (amount >= 25000) riskScore += 12;
    else if (amount >= 10000) riskScore += 8;
  }

  if (riskScore > 85) {
    riskScore = 85 + (riskScore - 85) * 0.35;
  } else if (riskScore > 70) {
    riskScore = 70 + (riskScore - 70) * 0.6;
  }

  return Math.round(clamp(riskScore, 0, 100));
}

function applyUserMemoryToRisk(event, baseRiskScore, mem) {
  let adjusted = baseRiskScore;
  const factors = [];

  if (mem.totalEvents >= 5 && mem.trustScore >= 70 && !event.geoMismatch && !event.velocitySpike) {
    adjusted -= 6;
    factors.push("trusted_user_discount");
  }

  if (mem.totalIncidents >= 3) {
    adjusted += 7;
    factors.push("repeat_incident_history");
  } else if (mem.totalIncidents >= 1) {
    adjusted += 3;
    factors.push("prior_incident_history");
  }

  if (mem.riskMomentum >= 15) {
    adjusted += 6;
    factors.push("risk_momentum_high");
  } else if (mem.riskMomentum <= -10) {
    adjusted -= 4;
    factors.push("risk_momentum_low");
  }

  const ip = (event.ip || "").trim();
  if (ip && ip !== "unknown") {
    if (mem.knownIps.includes(ip)) {
      adjusted -= 5;
      factors.push("known_ip_discount");
    } else if (mem.totalEvents >= 3) {
      adjusted += 4;
      factors.push("new_ip_penalty");
    }
  }

  if (mem.lastAction === "block") {
    adjusted += 6;
    factors.push("prior_block_history");
  } else if (mem.lastAction === "manual_review") {
    adjusted += 3;
    factors.push("prior_review_history");
  }

  return {
    adjustedRiskScore: Math.round(clamp(adjusted, 0, 100)),
    factors
  };
}

function severityFromRisk(riskScore) {
  if (riskScore >= 90) return "critical";
  if (riskScore >= 72) return "high";
  if (riskScore >= 45) return "medium";
  return "low";
}

function actionFromRisk(riskScore) {
  if (riskScore >= 90) return "block";
  if (riskScore >= 72) return "manual_review";
  if (riskScore >= 45) return "rate_limit";
  return "log";
}

function actionPriority(action) {
  if (action === "block") return 4;
  if (action === "manual_review") return 3;
  if (action === "rate_limit") return 2;
  return 1;
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
      confidence: "high",
      source: "signaldesk"
    };
  }

  if (score === 2) {
    return {
      label: "multi-signal-risk",
      action: "manual_review",
      confidence: "medium",
      source: "signaldesk"
    };
  }

  return {
    label: "none",
    action: null,
    confidence: "low",
    source: "signaldesk"
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

function generateSystemReflection(identity, drift, incidents, engineMeta = {}) {
  return [
    `System status: ${drift.status}.`,
    `Drift score: ${drift.driftScore.toFixed(2)}.`,
    `Baseline risk: ${identity.baselineRisk}.`,
    `Baseline volume: ${identity.baselineVolume}.`,
    `Tolerance: ${Number(identity.tolerance).toFixed(2)}.`,
    `Learning cycles: ${identity.learningCycles || 0}.`,
    `Current avg risk: ${drift.currentRisk.toFixed(2)}.`,
    `Current volume: ${drift.currentVolume}.`,
    `Engine mode: ${engineMeta.mode || "signaldesk-only"}.`,
    `Engine source: ${engineMeta.source || "signaldesk"}.`,
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
    }`
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

  if (riskScore >= 45) return { allow: true, reason: "risk_threshold" };
  if (convergence.label !== "none") return { allow: true, reason: "signal_convergence" };
  return { allow: false, reason: "below_threshold" };
}

function buildReasonCodes(event, riskScore, convergence, memoryFactors = []) {
  const codes = [];
  if (riskScore >= 90) codes.push("RISK_OVER_90");
  else if (riskScore >= 72) codes.push("RISK_OVER_72");
  else if (riskScore >= 45) codes.push("RISK_OVER_45");

  if ((event.ip || "").toLowerCase() === "unknown") codes.push("UNSEEN_IP");
  if (event.velocitySpike) codes.push("VELOCITY_SPIKE");
  if (event.geoMismatch) codes.push("GEO_MISMATCH");

  const amount = Number(event.amount || 0);
  if (amount >= 25000) codes.push("VERY_LARGE_TRANSACTION");
  else if (amount >= 10000) codes.push("LARGE_TRANSACTION");

  if (convergence.label === "convergent-threat") codes.push("SIGNAL_CONVERGENCE_HIGH");
  if (convergence.label === "multi-signal-risk") codes.push("SIGNAL_CONVERGENCE_MEDIUM");
  if (convergence.source === "mqc-aegis") codes.push("MQC_OVERRIDE");

  for (const factor of memoryFactors) {
    codes.push(`MEMORY_${factor.toUpperCase()}`);
  }

  return codes.length ? codes : ["LOW_SIGNAL"];
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

async function persistComparison(comp) {
  await db.run(
    `
    INSERT INTO engine_comparisons
    (
      eventId, eventType, user, localRiskScore, mergedRiskScore,
      localAction, finalAction, localLabel, finalLabel,
      localConfidence, finalConfidence, localSource, finalSource,
      mqcEnabled, mqcMode, mqcRiskDelta, mqcRecommendedAction,
      mqcLabel, mqcConfidence, differs, promotedByMQC, payload, createdAt
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      comp.eventId,
      comp.eventType,
      comp.user,
      comp.localRiskScore,
      comp.mergedRiskScore,
      comp.localAction,
      comp.finalAction,
      comp.localLabel,
      comp.finalLabel,
      comp.localConfidence,
      comp.finalConfidence,
      comp.localSource,
      comp.finalSource,
      comp.mqcEnabled ? 1 : 0,
      comp.mqcMode,
      comp.mqcRiskDelta,
      comp.mqcRecommendedAction,
      comp.mqcLabel,
      comp.mqcConfidence,
      comp.differs ? 1 : 0,
      comp.promotedByMQC ? 1 : 0,
      safeJson(comp.payload, {}),
      comp.createdAt
    ]
  );
}

async function persistLearningLog(log) {
  await db.run(
    `
    INSERT INTO learning_log
    (
      previousBaselineRisk, newBaselineRisk,
      previousBaselineVolume, newBaselineVolume,
      previousTolerance, newTolerance,
      diffRate, promotionRate, samples, note, createdAt
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      log.previousBaselineRisk,
      log.newBaselineRisk,
      log.previousBaselineVolume,
      log.newBaselineVolume,
      log.previousTolerance,
      log.newTolerance,
      log.diffRate,
      log.promotionRate,
      log.samples,
      log.note,
      log.createdAt
    ]
  );
}

function runMQCShadow(event, localDecision, mem) {
  if (!MQC_ENABLED) {
    return {
      enabled: false,
      mode: "disabled",
      source: "signaldesk",
      riskDelta: 0,
      recommendedAction: null,
      label: "mqc-off",
      confidence: "low"
    };
  }

  let riskDelta = 0;
  let recommendedAction = null;
  let label = "mqc-shadow";
  let confidence = "low";

  if (event.type === "payment" && Number(event.amount || 0) >= 25000) {
    riskDelta += 8;
    recommendedAction = "manual_review";
    label = "mqc-payment-cluster";
    confidence = "high";

    if (Number(event.risk || 0) >= 82 || (event.ip || "").toLowerCase() === "unknown") {
      recommendedAction = "block";
      riskDelta += 4;
    }
  }

  if (event.type === "login" && event.geoMismatch && event.velocitySpike) {
    riskDelta += 6;
    recommendedAction = localDecision.action === "block" ? "block" : "manual_review";
    label = "mqc-auth-cascade";
    confidence = "high";
  }

  if (Number(event.risk || 0) >= 80 && localDecision.label === "none") {
    riskDelta += 4;
    recommendedAction = "manual_review";
    label = "mqc-latent-risk";
    confidence = "medium";
  }

  if (mem.totalIncidents >= 3) {
    riskDelta += 3;
    if (!recommendedAction) recommendedAction = "manual_review";
    label = label === "mqc-shadow" ? "mqc-repeat-offender" : label;
    confidence = confidence === "low" ? "medium" : confidence;
  }

  if (mem.trustScore >= 80 && mem.totalEvents >= 6 && !event.geoMismatch && !event.velocitySpike) {
    riskDelta -= 4;
    if (recommendedAction === "block") recommendedAction = "manual_review";
    else if (recommendedAction === "manual_review" && Number(event.risk || 0) < 75) recommendedAction = "rate_limit";
    if (label === "mqc-shadow") label = "mqc-trusted-user";
    confidence = "medium";
  }

  return {
    enabled: true,
    mode: MQC_MODE,
    source: "mqc-aegis",
    riskDelta,
    recommendedAction,
    label,
    confidence
  };
}

function resolveDecisionEngine(event, context, mem) {
  const localConvergence = detectSignalConvergence(event, context);
  const baseRiskScore = evaluateRiskScore(event);
  const memoryAdjusted = applyUserMemoryToRisk(event, baseRiskScore, mem);
  const localRiskScore = memoryAdjusted.adjustedRiskScore;
  const localAction = localConvergence.action || actionFromRisk(localRiskScore);

  const mqc = runMQCShadow(event, localConvergence, mem);
  const mergedRiskScore = clamp(localRiskScore + Number(mqc.riskDelta || 0), 0, 100);

  let finalAction = localConvergence.action || actionFromRisk(mergedRiskScore);
  let finalLabel = localConvergence.label;
  let finalConfidence = localConvergence.confidence;
  let finalSource = localConvergence.source || "signaldesk";

  if (mqc.enabled && mqc.recommendedAction) {
    if (MQC_MODE === "primary") {
      finalAction = mqc.recommendedAction;
      finalLabel = mqc.label;
      finalConfidence = mqc.confidence;
      finalSource = "mqc-aegis";
    } else if (MQC_MODE === "shadow") {
      if (actionPriority(mqc.recommendedAction) > actionPriority(finalAction || "log")) {
        finalAction = mqc.recommendedAction;
        finalLabel = mqc.label;
        finalConfidence = mqc.confidence;
        finalSource = "mqc-aegis";
      }
    }
  }

  if (!finalAction) finalAction = actionFromRisk(mergedRiskScore);
  if (!finalLabel) finalLabel = "none";
  if (!finalConfidence) finalConfidence = "low";

  const comparison = {
    eventId: event.id,
    eventType: event.type,
    user: event.user,
    localRiskScore,
    mergedRiskScore,
    localAction,
    finalAction,
    localLabel: localConvergence.label,
    finalLabel,
    localConfidence: localConvergence.confidence,
    finalConfidence,
    localSource: "signaldesk",
    finalSource,
    mqcEnabled: mqc.enabled,
    mqcMode: mqc.enabled ? MQC_MODE : "disabled",
    mqcRiskDelta: Number(mqc.riskDelta || 0),
    mqcRecommendedAction: mqc.recommendedAction || null,
    mqcLabel: mqc.label || null,
    mqcConfidence: mqc.confidence || null,
    differs:
      localRiskScore !== mergedRiskScore ||
      localAction !== finalAction ||
      localConvergence.label !== finalLabel ||
      finalSource !== "signaldesk",
    promotedByMQC:
      finalSource === "mqc-aegis" ||
      actionPriority(finalAction) > actionPriority(localAction),
    payload: {
      event,
      localConvergence,
      mqc,
      memoryFactors: memoryAdjusted.factors,
      userMemory: {
        trustScore: mem.trustScore,
        totalEvents: mem.totalEvents,
        totalIncidents: mem.totalIncidents,
        riskMomentum: mem.riskMomentum
      }
    },
    createdAt: nowIso()
  };

  return {
    riskScore: mergedRiskScore,
    memoryAdjustedRiskScore: localRiskScore,
    memoryFactors: memoryAdjusted.factors,
    convergence: {
      label: finalLabel,
      action: finalAction,
      confidence: finalConfidence,
      source: finalSource
    },
    engineMeta: {
      mode: mqc.enabled ? MQC_MODE : "signaldesk-only",
      source: finalSource,
      localLabel: localConvergence.label,
      mqcLabel: mqc.label,
      mqcRiskDelta: mqc.riskDelta,
      mqcEnabled: mqc.enabled,
      trustScore: mem.trustScore
    },
    comparison
  };
}

async function getComparisonStats(limit = 200) {
  const rows = await db.all(`
    SELECT *
    FROM engine_comparisons
    ORDER BY id DESC
    LIMIT ?
  `, [limit]);

  const total = rows.length;
  const differs = rows.filter((r) => r.differs === 1).length;
  const promotedByMQC = rows.filter((r) => r.promotedByMQC === 1).length;
  const avgMergedRisk =
    total > 0
      ? rows.reduce((sum, r) => sum + Number(r.mergedRiskScore || 0), 0) / total
      : 0;

  return {
    total,
    differs,
    promotedByMQC,
    avgMergedRisk,
    diffRate: total ? differs / total : 0,
    promotionRate: total ? promotedByMQC / total : 0
  };
}

async function runAutoLearn() {
  if (!learningState.enabled) {
    return { ok: false, reason: "learning_disabled" };
  }

  const stats = await getComparisonStats(200);
  if (stats.total < learningState.minComparisons) {
    return { ok: false, reason: "not_enough_samples", stats };
  }

  const previousBaselineRisk = systemIdentity.baselineRisk;
  const previousBaselineVolume = systemIdentity.baselineVolume;
  const previousTolerance = systemIdentity.tolerance;

  let note = "minor recalibration";
  let targetRisk = previousBaselineRisk;
  let targetVolume = previousBaselineVolume;
  let targetTolerance = previousTolerance;

  if (stats.diffRate >= 0.35) {
    targetTolerance = clamp(previousTolerance + 0.03, 0.1, 0.6);
    note = "high divergence: widened tolerance slightly";
  } else if (stats.diffRate <= 0.12) {
    targetTolerance = clamp(previousTolerance - 0.02, 0.1, 0.6);
    note = "low divergence: tightened tolerance slightly";
  }

  if (stats.promotionRate >= 0.25) {
    targetRisk = clamp(Math.round(previousBaselineRisk + 2), 15, 95);
    note += "; MQC promotions strong: raised baseline risk";
  } else if (stats.promotionRate <= 0.05) {
    targetRisk = clamp(Math.round(previousBaselineRisk - 1), 15, 95);
    note += "; MQC quiet: lowered baseline risk slightly";
  }

  const observedVolume = globalEvents.slice(-100).length || previousBaselineVolume;
  targetVolume = clamp(
    Math.round(previousBaselineVolume * 0.85 + observedVolume * 0.15),
    10,
    500
  );

  systemIdentity.baselineRisk = targetRisk;
  systemIdentity.baselineVolume = targetVolume;
  systemIdentity.tolerance = Number(targetTolerance.toFixed(2));
  systemIdentity.lastUpdated = Date.now();
  systemIdentity.learningCycles = Number(systemIdentity.learningCycles || 0) + 1;
  systemIdentity.lastLearningAt = nowIso();

  const log = {
    previousBaselineRisk,
    newBaselineRisk: systemIdentity.baselineRisk,
    previousBaselineVolume,
    newBaselineVolume: systemIdentity.baselineVolume,
    previousTolerance,
    newTolerance: systemIdentity.tolerance,
    diffRate: Number(stats.diffRate.toFixed(4)),
    promotionRate: Number(stats.promotionRate.toFixed(4)),
    samples: stats.total,
    note,
    createdAt: nowIso()
  };

  await persistLearningLog(log);
  broadcast("auto_learn", {
    ok: true,
    identity: systemIdentity,
    stats: {
      diffRate: log.diffRate,
      promotionRate: log.promotionRate,
      samples: log.samples
    },
    note: log.note
  });

  learningState.lastRunAt = Date.now();

  return { ok: true, log };
}

async function updateUserMemoryFromEvent(event) {
  const mem = getUserMemory(event.user);
  const previousAvg = mem.avgRisk;
  const nextEvents = mem.totalEvents + 1;
  const nextAvg = nextEvents > 0
    ? ((mem.avgRisk * mem.totalEvents) + Number(event.risk || 0)) / nextEvents
    : Number(event.risk || 0);

  mem.totalEvents = nextEvents;
  mem.avgRisk = Number(nextAvg.toFixed(2));
  mem.lastRisk = Number(event.risk || 0);
  mem.riskMomentum = Number((mem.lastRisk - previousAvg).toFixed(2));

  const ip = (event.ip || "").trim();
  if (ip && ip !== "unknown" && !mem.knownIps.includes(ip)) {
    mem.knownIps.push(ip);
  }
  mem.knownIps = mem.knownIps.slice(-10);
  mem.knownIpCount = mem.knownIps.length;
  mem.lastSeenAt = nowIso();
  mem.updatedAt = nowIso();

  await persistUserMemory(mem);
  return mem;
}

async function updateUserMemoryFromDecision(mem, event, incident, actionRecord) {
  if (incident) mem.totalIncidents += 1;
  if (actionRecord) mem.totalActions += 1;

  if (actionRecord?.type === "block") mem.trustScore -= 12;
  else if (actionRecord?.type === "manual_review") mem.trustScore -= 6;
  else if (actionRecord?.type === "rate_limit") mem.trustScore -= 3;
  else mem.trustScore += 1;

  if (!incident && !event.geoMismatch && !event.velocitySpike && Number(event.risk || 0) < 45) {
    mem.trustScore += 2;
  }

  mem.trustScore = clamp(Math.round(mem.trustScore), 0, 100);
  mem.lastAction = actionRecord?.type || mem.lastAction;
  mem.lastSeverity = incident?.severity || mem.lastSeverity;
  mem.updatedAt = nowIso();

  await persistUserMemory(mem);
  return mem;
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "SignalDesk",
    ws: Boolean(wss),
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

app.get("/api/actions", (req, res) => {
  res.json(actionStore.slice(-100).reverse());
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
  const stats = getCurrentStats();
  const drift = evaluateIdentityDrift(stats);

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
    const stats = await getComparisonStats(500);
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
    const result = await runAutoLearn();
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
    learningState.minComparisons = clamp(Math.round(body.minComparisons), 3, 200);
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

app.get("/api/summary", (req, res) => {
  const stats = getCurrentStats();
  const drift = evaluateIdentityDrift(stats);
  const summary = generateSystemReflection(systemIdentity, drift, incidentStore.slice(-20), {
    mode: MQC_ENABLED ? MQC_MODE : "signaldesk-only",
    source: "signaldesk"
  });

  res.json({
    ok: true,
    summary,
    drift,
    identity: systemIdentity,
    incidents: incidentStore.length,
    actions: actionStore.length,
    narratives: narrativeStore.length,
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

app.post("/api/insights", (req, res) => {
  const stats = getCurrentStats();
  const drift = evaluateIdentityDrift(stats);
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

    const mem = await updateUserMemoryFromEvent(event);

    const recentIncidentsForContext = incidentStore.filter(
      (i) => Date.now() - new Date(i.createdAt).getTime() < 15 * 60 * 1000
    );

    const trendLabel = detectTrendAnomaly(event);

    const resolved = resolveDecisionEngine(event, {
      recentIncidents: recentIncidentsForContext.length
    }, mem);

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
    await persistComparison(comparison);
    broadcast("mqc_compare", comparison);

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
        reasonCodes: buildReasonCodes(event, riskScore, convergence, memoryFactors),
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

      await persistNarrative(narrative);

      adaptSystemIdentity(incidentStore.slice(-20));

      broadcast("incident", incident);
      broadcast("action", actionRecord);
      broadcast("narrative", narrative);
    }

    const updatedMem = await updateUserMemoryFromDecision(mem, event, incident, actionRecord);
    broadcast("user_memory", updatedMem);

    if (compareStore.length >= learningState.minComparisons && Date.now() - learningState.lastRunAt > 5000) {
      try {
        await runAutoLearn();
      } catch (err) {
        console.error("Auto-learn failed:", err.message);
      }
    }

    const stats = getCurrentStats();
    const drift = evaluateIdentityDrift(stats);
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

await initDb();
await loadUserMemory();

const server = http.createServer(app);
wss = new WebSocketServer({ server });

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
