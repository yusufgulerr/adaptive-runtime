import { ConfigurationError } from "../errors/index.js";
import type { StrategyDecision } from "../types/decision.js";
import type { CustomPolicySelector, CustomSelectorCandidate } from "../types/policy.js";

declare module "../types/policy.js" {
  interface CustomSelectorCandidate {
    /** Number of execution samples observed for this candidate, or null/undefined if untracked. */
    readonly samples?: number | null;
  }
}

export interface ErrorRateGuardSelectorOptions {
  readonly maxErrorRate: number;
  readonly fallbackSelector?: CustomPolicySelector;
  readonly minSamples?: number;
}

export interface LatencyBudgetSelectorOptions {
  readonly maxLatencyMs: number;
  readonly preferLowestCost?: boolean;
}

function compareCandidatesQualityFirst(
  a: CustomSelectorCandidate,
  b: CustomSelectorCandidate,
): number {
  if (b.candidate.qualityTier !== a.candidate.qualityTier) {
    return b.candidate.qualityTier - a.candidate.qualityTier;
  }
  const costA = a.candidate.costTier ?? 0;
  const costB = b.candidate.costTier ?? 0;
  if (costA !== costB) {
    return costA - costB;
  }
  return a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0;
}

function compareCandidatesCostFirst(
  a: CustomSelectorCandidate,
  b: CustomSelectorCandidate,
): number {
  const costA = a.candidate.costTier ?? 0;
  const costB = b.candidate.costTier ?? 0;
  if (costA !== costB) {
    return costA - costB;
  }
  if (b.candidate.qualityTier !== a.candidate.qualityTier) {
    return b.candidate.qualityTier - a.candidate.qualityTier;
  }
  return a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0;
}

function getCandidateSamples(c: CustomSelectorCandidate): number | null {
  const raw =
    (c as { samples?: number | null; sampleCount?: number | null; runs?: number | null }).samples ??
    (c as { sampleCount?: number | null }).sampleCount ??
    (c as { runs?: number | null }).runs;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : null;
}

/**
 * Creates a pure custom selector that filters out strategy candidates whose
 * observed error rate exceeds `maxErrorRate`.
 *
 * If eligible candidates remain, it selects the highest quality (then lowest cost)
 * candidate, or delegates to `fallbackSelector` when provided.
 *
 * If all candidates exceed `maxErrorRate`, it selects the candidate with the
 * lowest observed error rate to mitigate complete failure.
 */
export function createErrorRateGuardSelector(
  options: ErrorRateGuardSelectorOptions,
): CustomPolicySelector {
  if (options === null || typeof options !== "object") {
    throw new ConfigurationError("options must be an object.");
  }
  const { maxErrorRate, fallbackSelector, minSamples = 1 } = options;
  if (
    typeof maxErrorRate !== "number" ||
    !Number.isFinite(maxErrorRate) ||
    maxErrorRate < 0 ||
    maxErrorRate > 1
  ) {
    throw new ConfigurationError("maxErrorRate must be a finite number between 0 and 1.");
  }
  if (fallbackSelector !== undefined && typeof fallbackSelector !== "function") {
    throw new ConfigurationError("fallbackSelector must be a function.");
  }
  if (
    typeof minSamples !== "number" ||
    !Number.isSafeInteger(minSamples) ||
    minSamples < 1
  ) {
    throw new ConfigurationError("minSamples must be a positive integer.");
  }

  return (context) => {
    if (context.candidates.length === 0) {
      return null;
    }

    const eligible = context.candidates.filter((c) => {
      const samples = getCandidateSamples(c);
      if (samples !== null && samples < minSamples) {
        return true;
      }
      const rate = c.errorRate;
      return rate === null || rate === undefined || rate <= maxErrorRate;
    });

    if (eligible.length > 0) {
      if (fallbackSelector !== undefined) {
        const delegated = fallbackSelector({ ...context, candidates: eligible });
        if (delegated !== null && delegated !== undefined) {
          return delegated;
        }
      }
      const sorted = [...eligible].sort(compareCandidatesQualityFirst);
      const chosen = sorted[0] as CustomSelectorCandidate;
      const chosenSamples = getCandidateSamples(chosen);
      const isColdStart =
        chosen.errorRate !== null &&
        chosen.errorRate !== undefined &&
        chosen.errorRate > maxErrorRate &&
        chosenSamples !== null &&
        chosenSamples < minSamples;

      const reason = isColdStart
        ? `error-rate-guard: selected cold-start strategy "${chosen.candidate.id}" with errorRate ${chosen.errorRate} (samples < minSamples ${minSamples})`
        : `error-rate-guard: selected strategy "${chosen.candidate.id}" with errorRate ${chosen.errorRate ?? 0} <= ${maxErrorRate}`;

      return {
        strategyId: chosen.candidate.id,
        reason,
      };
    }

    const sortedByError = [...context.candidates].sort((a, b) => {
      const errA = a.errorRate ?? 0;
      const errB = b.errorRate ?? 0;
      if (errA !== errB) {
        return errA - errB;
      }
      return compareCandidatesQualityFirst(a, b);
    });
    const fallback = sortedByError[0] as CustomSelectorCandidate;
    return {
      strategyId: fallback.candidate.id,
      reason: `error-rate-guard: all candidates exceeded maxErrorRate ${maxErrorRate}; selected candidate "${fallback.candidate.id}" with lowest errorRate ${fallback.errorRate ?? 0}`,
    };
  };
}

/**
 * Creates a pure custom selector that selects candidates within a target latency
 * budget (`estimatedLatencyMs <= maxLatencyMs`). Candidates with unmeasured
 * latency (`estimatedLatencyMs === null`) are considered eligible.
 *
 * If all candidates exceed the latency budget, it selects the candidate with
 * the lowest estimated latency.
 */
export function createLatencyBudgetSelector(
  options: LatencyBudgetSelectorOptions,
): CustomPolicySelector {
  if (options === null || typeof options !== "object") {
    throw new ConfigurationError("options must be an object.");
  }
  const { maxLatencyMs, preferLowestCost } = options;
  if (typeof maxLatencyMs !== "number" || !Number.isFinite(maxLatencyMs) || maxLatencyMs <= 0) {
    throw new ConfigurationError("maxLatencyMs must be a positive finite number.");
  }

  const comparator = preferLowestCost ? compareCandidatesCostFirst : compareCandidatesQualityFirst;

  return (context) => {
    if (context.candidates.length === 0) {
      return null;
    }

    const withinBudget = context.candidates.filter(
      (c) => c.estimatedLatencyMs === null || c.estimatedLatencyMs <= maxLatencyMs,
    );

    if (withinBudget.length > 0) {
      const sorted = [...withinBudget].sort(comparator);
      const chosen = sorted[0] as CustomSelectorCandidate;
      return {
        strategyId: chosen.candidate.id,
        reason: `latency-budget: selected strategy "${chosen.candidate.id}" within budget ${maxLatencyMs}ms (latency=${chosen.estimatedLatencyMs ?? "unmeasured"}ms)`,
      };
    }

    const sortedByLatency = [...context.candidates].sort((a, b) => {
      const latA = a.estimatedLatencyMs ?? Number.POSITIVE_INFINITY;
      const latB = b.estimatedLatencyMs ?? Number.POSITIVE_INFINITY;
      if (latA !== latB) {
        return latA - latB;
      }
      return comparator(a, b);
    });
    const chosen = sortedByLatency[0] as CustomSelectorCandidate;
    return {
      strategyId: chosen.candidate.id,
      reason: `latency-budget: all candidates exceeded budget ${maxLatencyMs}ms; selected candidate "${chosen.candidate.id}" with lowest latency ${chosen.estimatedLatencyMs}ms`,
    };
  };
}

/**
 * Formats a single-line audit summary of a StrategyDecision.
 *
 * Example output:
 * `[operationId] strategy="fast" tier=1/3 kind=adapted changed=true budgets=heap(engaged) reasons=quality-pressure,strategy-switched`
 */
export function formatDecisionSummary(decision: StrategyDecision): string {
  const budgetsPart =
    decision.budgets.length === 0
      ? "none"
      : decision.budgets.map((b) => `${b.id}(${b.engaged ? "engaged" : b.status})`).join(",");

  const reasonsPart =
    decision.reasons.length === 0 ? "none" : decision.reasons.map((r) => r.code).join(",");

  return `[${decision.operationId}] strategy="${decision.strategyId}" tier=${decision.qualityTier}/${decision.baseQualityTier} kind=${decision.kind} changed=${decision.changed} budgets=${budgetsPart} reasons=${reasonsPart}`;
}
