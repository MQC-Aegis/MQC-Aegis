import { nowIso, clamp } from "./utils.js";
import { actionFromRisk, actionPriority, detectSignalConvergence, evaluateRiskScore } from "./risk.js";
import { applyUserMemoryToRisk } from "./memory.js";

export function runMQCShadow({ MQC_ENABLED, MQC_MODE, event, localDecision, mem }) {
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

    const paymentAmount = Number(event.amount || 0);
  const eventRisk = Number(event.risk || 0);
  const unknownIp = (event.ip || "").toLowerCase() === "unknown";
  const repeatOffender = Number(mem.totalIncidents || 0) >= 3;
  const paymentClusterCandidate =
    event.type === "payment" &&
    (
      paymentAmount >= 25000 ||
      (paymentAmount >= 8000 && repeatOffender) ||
      (paymentAmount >= 10000 && unknownIp)
    );

  if (paymentClusterCandidate) {
    riskDelta += 8;
    recommendedAction = "manual_review";
    label = "mqc-payment-cluster";
    confidence = "high";

    if (
      paymentAmount >= 25000 ||
      (paymentAmount >= 10000 && repeatOffender) ||
      (paymentAmount >= 10000 && unknownIp && eventRisk >= 60) ||
      (paymentAmount >= 8000 && repeatOffender && eventRisk >= 63)
    ) {
      recommendedAction = "block";
      riskDelta += 6;
      label = "mqc-payment-cluster-hard";
      confidence = "high";
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

export function resolveDecisionEngine({ MQC_ENABLED, MQC_MODE, event, context, mem }) {
  const localConvergence = detectSignalConvergence(event, context);
  const baseRiskScore = evaluateRiskScore(event);
  const memoryAdjusted = applyUserMemoryToRisk(event, baseRiskScore, mem);
  const localRiskScore = memoryAdjusted.adjustedRiskScore;
  const localAction = localConvergence.action || actionFromRisk(localRiskScore);

  const mqc = runMQCShadow({ MQC_ENABLED, MQC_MODE, event, localDecision: localConvergence, mem });
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
