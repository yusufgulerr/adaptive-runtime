import { ConfigurationError } from "../errors/index.js";
import type { StrategyDecision } from "../types/decision.js";
import type {
  CustomPolicySelector,
  CustomSelectorCandidate,
  CustomSelectorContext,
} from "../types/policy.js";

export class InvalidConfigurationError extends ConfigurationError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidConfigurationError";
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
  readonly fallbackSelector?: CustomPolicySelector;
  readonly useEwma?: boolean;
}

export interface CostBudgetSelectorOptions {
  readonly maxCostTier: number;
  readonly preferLowestLatency?: boolean;
  readonly fallbackSelector?: CustomPolicySelector;
  readonly useEwma?: boolean;
}

export interface WeightedUtilitySelectorOptions {
  readonly qualityWeight?: number;
  readonly latencyWeight?: number;
  readonly errorRateWeight?: number;
  readonly costWeight?: number;
  readonly maxLatencyRefMs?: number;
  readonly maxCostTierRef?: number;
  readonly minSamplesForErrorRate?: number;
  readonly useEwma?: boolean;
}

export interface SignalTrendGuardSelectorOptions {
  readonly signalName: string;
  readonly maxSlopePerSec: number;
  readonly windowSize?: number;
  readonly minTimeSpanMs?: number;
  readonly degradedQualityCap?: number;
  readonly preferLowestLatencyOnSpike?: boolean;
  readonly fallbackSelector?: CustomPolicySelector;
}

export type SignalTrendGuardSelector = CustomPolicySelector & {
  reset: () => void;
};

export interface SafeSelectorOptions {
  readonly fallbackSelector?: CustomPolicySelector;
  readonly onSelectorError?: (error: unknown, context: CustomSelectorContext) => void;
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

function getCandidateLatency(c: CustomSelectorCandidate, useEwma: boolean): number | null {
  if (useEwma) {
    const ewma = c.ewmaLatencyMs;
    return typeof ewma === "number" && Number.isFinite(ewma) ? ewma : null;
  }
  const est = c.estimatedLatencyMs;
  return typeof est === "number" && Number.isFinite(est) ? est : null;
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
  if (typeof minSamples !== "number" || !Number.isSafeInteger(minSamples) || minSamples < 1) {
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
      const isColdStart = typeof chosen.errorRate === "number" && chosen.errorRate > maxErrorRate;

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
  const { maxLatencyMs, preferLowestCost, fallbackSelector, useEwma = false } = options;
  if (typeof maxLatencyMs !== "number" || !Number.isFinite(maxLatencyMs) || maxLatencyMs <= 0) {
    throw new ConfigurationError("maxLatencyMs must be a positive finite number.");
  }
  if (fallbackSelector !== undefined && typeof fallbackSelector !== "function") {
    throw new ConfigurationError("fallbackSelector must be a function.");
  }
  if (typeof useEwma !== "boolean") {
    throw new ConfigurationError("useEwma must be a boolean.");
  }

  const comparator = preferLowestCost ? compareCandidatesCostFirst : compareCandidatesQualityFirst;

  return (context) => {
    if (context.candidates.length === 0) {
      return null;
    }

    const withinBudget = context.candidates.filter((c) => {
      const lat = getCandidateLatency(c, useEwma);
      return lat === null || lat <= maxLatencyMs;
    });

    if (withinBudget.length > 0) {
      if (fallbackSelector !== undefined) {
        const delegated = fallbackSelector({ ...context, candidates: withinBudget });
        if (delegated !== null && delegated !== undefined) {
          return delegated;
        }
      }
      const sorted = [...withinBudget].sort(comparator);
      const chosen = sorted[0] as CustomSelectorCandidate;
      const chosenLatency = getCandidateLatency(chosen, useEwma);
      return {
        strategyId: chosen.candidate.id,
        reason: `latency-budget: selected strategy "${chosen.candidate.id}" within budget ${maxLatencyMs}ms (latency=${chosenLatency ?? "unmeasured"}ms)`,
      };
    }

    const sortedByLatency = [...context.candidates].sort((a, b) => {
      const latA = getCandidateLatency(a, useEwma) ?? Number.POSITIVE_INFINITY;
      const latB = getCandidateLatency(b, useEwma) ?? Number.POSITIVE_INFINITY;
      if (latA !== latB) {
        return latA - latB;
      }
      return comparator(a, b);
    });
    const chosen = sortedByLatency[0] as CustomSelectorCandidate;
    const chosenLatency = getCandidateLatency(chosen, useEwma);
    return {
      strategyId: chosen.candidate.id,
      reason: `latency-budget: all candidates exceeded budget ${maxLatencyMs}ms; selected candidate "${chosen.candidate.id}" with lowest latency ${chosenLatency}ms`,
    };
  };
}

function getCandidateCostTier(c: CustomSelectorCandidate): number {
  const cost = c.candidate?.costTier ?? (c as { costTier?: number | null }).costTier;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : 0;
}

function getCandidateQualityTier(c: CustomSelectorCandidate): number {
  const quality = c.candidate?.qualityTier ?? (c as { qualityTier?: number | null }).qualityTier;
  return typeof quality === "number" && Number.isFinite(quality) ? quality : 0;
}

function getCandidateId(c: CustomSelectorCandidate): string {
  return c.candidate?.id ?? (c as { id?: string }).id ?? "";
}

function getCandidateCostSelectorLatency(
  c: CustomSelectorCandidate,
  useEwma: boolean,
): number | null {
  const ewma =
    typeof c.ewmaLatencyMs === "number" && Number.isFinite(c.ewmaLatencyMs)
      ? c.ewmaLatencyMs
      : null;
  const lastRaw = (c as { lastLatencyMs?: number | null }).lastLatencyMs ?? c.estimatedLatencyMs;
  const last = typeof lastRaw === "number" && Number.isFinite(lastRaw) ? lastRaw : null;

  return useEwma ? (ewma ?? last) : (last ?? ewma);
}

/**
 * Creates a pure custom selector that constrains selection to strategies within
 * a maximum cost tier budget (`costTier <= maxCostTier`).
 *
 * If eligible candidates remain:
 * - When `fallbackSelector` is provided, it delegates to it over the within-budget candidates.
 * - Otherwise, sorts candidates:
 *   - When `preferLowestLatency: true`, orders by ascending latency (known latency before unknown),
 *     then descending quality tier, then ascending cost tier, then code-unit id.
 *   - Otherwise, orders by descending quality tier, then ascending cost tier, then code-unit id.
 *
 * If all candidates exceed `maxCostTier`, selects the candidate with the lowest cost tier,
 * tie-breaking by descending quality tier, then code-unit id.
 */
export function createCostBudgetSelector(options: CostBudgetSelectorOptions): CustomPolicySelector {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new InvalidConfigurationError("options must be an object.");
  }
  const { maxCostTier, preferLowestLatency, fallbackSelector, useEwma } = options;
  if (typeof maxCostTier !== "number" || !Number.isFinite(maxCostTier)) {
    throw new InvalidConfigurationError("maxCostTier must be a finite number.");
  }
  if (preferLowestLatency !== undefined && typeof preferLowestLatency !== "boolean") {
    throw new InvalidConfigurationError("preferLowestLatency must be a boolean.");
  }
  if (useEwma !== undefined && typeof useEwma !== "boolean") {
    throw new InvalidConfigurationError("useEwma must be a boolean.");
  }
  if (fallbackSelector !== undefined && typeof fallbackSelector !== "function") {
    throw new InvalidConfigurationError("fallbackSelector must be a function.");
  }

  return (context) => {
    if (context.candidates.length === 0) {
      return null;
    }

    const withinBudget = context.candidates.filter((c) => getCandidateCostTier(c) <= maxCostTier);

    if (withinBudget.length > 0) {
      if (fallbackSelector !== undefined) {
        const delegated = fallbackSelector({
          ...context,
          candidates: Object.freeze(withinBudget),
        });
        if (delegated !== null && delegated !== undefined) {
          const delegatedId = typeof delegated === "string" ? delegated : delegated.strategyId;
          if (
            typeof delegatedId === "string" &&
            withinBudget.some((c) => getCandidateId(c) === delegatedId)
          ) {
            return delegated;
          }
        }
      }

      const useEwmaVal = useEwma !== false;
      const sorted = [...withinBudget].sort((a, b) => {
        if (preferLowestLatency === true) {
          const latA = getCandidateCostSelectorLatency(a, useEwmaVal);
          const latB = getCandidateCostSelectorLatency(b, useEwmaVal);

          if (latA !== null && latB !== null) {
            if (latA !== latB) {
              return latA - latB;
            }
          } else if (latA !== null && latB === null) {
            return -1;
          } else if (latA === null && latB !== null) {
            return 1;
          }
        }

        const qA = getCandidateQualityTier(a);
        const qB = getCandidateQualityTier(b);
        if (qB !== qA) {
          return qB - qA;
        }

        const cA = getCandidateCostTier(a);
        const cB = getCandidateCostTier(b);
        if (cA !== cB) {
          return cA - cB;
        }

        const idA = getCandidateId(a);
        const idB = getCandidateId(b);
        return idA < idB ? -1 : idA > idB ? 1 : 0;
      });

      const chosen = sorted[0] as CustomSelectorCandidate;
      const chosenId = getCandidateId(chosen);
      const chosenCost = getCandidateCostTier(chosen);

      return {
        strategyId: chosenId,
        reason: `cost-budget: selected strategy "${chosenId}" within budget maxCostTier ${maxCostTier} (costTier=${chosenCost})`,
      };
    }

    const sortedByCost = [...context.candidates].sort((a, b) => {
      const cA = getCandidateCostTier(a);
      const cB = getCandidateCostTier(b);
      if (cA !== cB) {
        return cA - cB;
      }

      const qA = getCandidateQualityTier(a);
      const qB = getCandidateQualityTier(b);
      if (qB !== qA) {
        return qB - qA;
      }

      const idA = getCandidateId(a);
      const idB = getCandidateId(b);
      return idA < idB ? -1 : idA > idB ? 1 : 0;
    });

    const chosen = sortedByCost[0] as CustomSelectorCandidate;
    const chosenId = getCandidateId(chosen);
    const chosenCost = getCandidateCostTier(chosen);

    return {
      strategyId: chosenId,
      reason: `cost-budget: all candidates exceeded budget maxCostTier ${maxCostTier}; selected candidate "${chosenId}" with lowest costTier ${chosenCost}`,
    };
  };
}

/**
 * Wraps a custom policy selector with a resilient error-handling boundary.
 *
 * Catches any synchronous or runtime errors thrown by `selector`.
 * If an error occurs:
 * - Calls `options.onSelectorError` safely (never re-throwing error from handler).
 * - Falls back to `options.fallbackSelector` inside its own try/catch.
 * - If no fallback is provided or fallback also throws, returns `null` so the engine
 *   reverts to deterministic tie-breaking.
 */
export function createSafeSelector(
  selector: CustomPolicySelector,
  options?: SafeSelectorOptions,
): CustomPolicySelector {
  if (typeof selector !== "function") {
    throw new InvalidConfigurationError("selector must be a function.");
  }
  if (options !== undefined) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new InvalidConfigurationError("options must be an object.");
    }
    if (options.fallbackSelector !== undefined && typeof options.fallbackSelector !== "function") {
      throw new InvalidConfigurationError("fallbackSelector must be a function.");
    }
    if (options.onSelectorError !== undefined && typeof options.onSelectorError !== "function") {
      throw new InvalidConfigurationError("onSelectorError must be a function.");
    }
  }

  const fallback = options?.fallbackSelector;
  const onError = options?.onSelectorError;

  return (context) => {
    try {
      return selector(context);
    } catch (error) {
      if (onError !== undefined) {
        try {
          onError(error, context);
        } catch {
          // Never let onSelectorError throw!
        }
      }
      if (fallback !== undefined) {
        try {
          return fallback(context);
        } catch {
          return null;
        }
      }
      return null;
    }
  };
}

function getCandidateUtilityLatency(c: CustomSelectorCandidate, useEwma: boolean): number | null {
  const ewma =
    typeof c.ewmaLatencyMs === "number" && Number.isFinite(c.ewmaLatencyMs)
      ? c.ewmaLatencyMs
      : null;
  const lastRaw = (c as { lastLatencyMs?: number | null }).lastLatencyMs;
  const last = typeof lastRaw === "number" && Number.isFinite(lastRaw) ? lastRaw : null;
  const est =
    typeof c.estimatedLatencyMs === "number" && Number.isFinite(c.estimatedLatencyMs)
      ? c.estimatedLatencyMs
      : null;

  const primary = useEwma ? (ewma ?? last) : (last ?? ewma);
  return primary ?? est ?? null;
}

function getCandidateUtilityErrorRate(
  c: CustomSelectorCandidate,
  minSamples: number,
  useEwma: boolean,
): number | null {
  const samples = getCandidateSamples(c) ?? 0;
  if (samples < minSamples) {
    return null;
  }
  const ewmaRaw = (c as { ewmaErrorRate?: number | null }).ewmaErrorRate;
  const ewma = typeof ewmaRaw === "number" && Number.isFinite(ewmaRaw) ? ewmaRaw : null;
  const errRaw = c.errorRate;
  const err = typeof errRaw === "number" && Number.isFinite(errRaw) ? errRaw : null;

  const rate = useEwma ? (ewma ?? err) : (err ?? ewma);
  return rate ?? null;
}

function getSignalTrendCandidateLatency(c: CustomSelectorCandidate): number {
  const ewma =
    typeof c.ewmaLatencyMs === "number" && Number.isFinite(c.ewmaLatencyMs)
      ? c.ewmaLatencyMs
      : null;
  const lastRaw = (c as { lastLatencyMs?: number | null }).lastLatencyMs;
  const last = typeof lastRaw === "number" && Number.isFinite(lastRaw) ? lastRaw : null;
  const est =
    typeof c.estimatedLatencyMs === "number" && Number.isFinite(c.estimatedLatencyMs)
      ? c.estimatedLatencyMs
      : null;

  return ewma ?? last ?? est ?? Number.POSITIVE_INFINITY;
}

function getSignalTimestamp(signal: unknown): number | null {
  if (signal === null || typeof signal !== "object") {
    return null;
  }
  const raw =
    (signal as { timestamp?: unknown; observedAt?: unknown }).timestamp ??
    (signal as { observedAt?: unknown }).observedAt;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

interface SignalWindowEntry {
  readonly timestamp: number;
  value: number;
}

/**
 * Creates a pure custom selector that scores strategy candidates using a
 * multi-objective weighted utility function balancing quality, latency, error
 * rate, and cost.
 */
export function createWeightedUtilitySelector(
  options?: WeightedUtilitySelectorOptions,
): CustomPolicySelector {
  if (options !== undefined) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new InvalidConfigurationError("options must be an object.");
    }
    if (
      options.qualityWeight !== undefined &&
      (typeof options.qualityWeight !== "number" ||
        !Number.isFinite(options.qualityWeight) ||
        options.qualityWeight < 0)
    ) {
      throw new InvalidConfigurationError("qualityWeight must be a non-negative finite number.");
    }
    if (
      options.latencyWeight !== undefined &&
      (typeof options.latencyWeight !== "number" ||
        !Number.isFinite(options.latencyWeight) ||
        options.latencyWeight < 0)
    ) {
      throw new InvalidConfigurationError("latencyWeight must be a non-negative finite number.");
    }
    if (
      options.errorRateWeight !== undefined &&
      (typeof options.errorRateWeight !== "number" ||
        !Number.isFinite(options.errorRateWeight) ||
        options.errorRateWeight < 0)
    ) {
      throw new InvalidConfigurationError("errorRateWeight must be a non-negative finite number.");
    }
    if (
      options.costWeight !== undefined &&
      (typeof options.costWeight !== "number" ||
        !Number.isFinite(options.costWeight) ||
        options.costWeight < 0)
    ) {
      throw new InvalidConfigurationError("costWeight must be a non-negative finite number.");
    }
    if (
      options.maxLatencyRefMs !== undefined &&
      (typeof options.maxLatencyRefMs !== "number" ||
        !Number.isFinite(options.maxLatencyRefMs) ||
        options.maxLatencyRefMs <= 0)
    ) {
      throw new InvalidConfigurationError("maxLatencyRefMs must be a positive finite number.");
    }
    if (
      options.maxCostTierRef !== undefined &&
      (typeof options.maxCostTierRef !== "number" ||
        !Number.isFinite(options.maxCostTierRef) ||
        options.maxCostTierRef <= 0)
    ) {
      throw new InvalidConfigurationError("maxCostTierRef must be a positive finite number.");
    }
    if (
      options.minSamplesForErrorRate !== undefined &&
      (typeof options.minSamplesForErrorRate !== "number" ||
        !Number.isSafeInteger(options.minSamplesForErrorRate) ||
        options.minSamplesForErrorRate < 0)
    ) {
      throw new InvalidConfigurationError(
        "minSamplesForErrorRate must be a non-negative safe integer.",
      );
    }
    if (options.useEwma !== undefined && typeof options.useEwma !== "boolean") {
      throw new InvalidConfigurationError("useEwma must be a boolean.");
    }
  }

  const qualityWeight = options?.qualityWeight ?? 0.4;
  const latencyWeight = options?.latencyWeight ?? 0.3;
  const errorRateWeight = options?.errorRateWeight ?? 0.2;
  const costWeight = options?.costWeight ?? 0.1;

  if (qualityWeight === 0 && latencyWeight === 0 && errorRateWeight === 0 && costWeight === 0) {
    throw new InvalidConfigurationError("At least one weight must be greater than zero.");
  }

  const maxLatencyRefMs = options?.maxLatencyRefMs;
  const maxCostTierRef = options?.maxCostTierRef;
  const minSamplesForErrorRate = options?.minSamplesForErrorRate ?? 1;
  const useEwma = options?.useEwma !== false;

  return (context) => {
    if (context.candidates.length === 0) {
      return null;
    }
    if (context.candidates.length === 1) {
      const single = context.candidates[0] as CustomSelectorCandidate;
      const singleId = getCandidateId(single);
      return {
        strategyId: singleId,
        reason: `weighted-utility: single candidate "${singleId}" selected`,
      };
    }

    const qualities = context.candidates.map((c) => getCandidateQualityTier(c));
    const minQ = Math.min(...qualities);
    const maxQ = Math.max(...qualities);

    const latencies = context.candidates.map((c) => getCandidateUtilityLatency(c, useEwma));
    const finiteLatencies = latencies.filter(
      (lat): lat is number => lat !== null && Number.isFinite(lat),
    );
    const refLatency =
      maxLatencyRefMs ?? (finiteLatencies.length > 0 ? Math.max(1, ...finiteLatencies) : 1);

    const costs = context.candidates.map((c) => getCandidateCostTier(c));
    const refCost = maxCostTierRef ?? Math.max(1, ...costs);

    const scored = context.candidates.map((c, index) => {
      const id = getCandidateId(c);
      const q = qualities[index] as number;
      const cost = costs[index] as number;
      const latency = latencies[index] as number | null;
      const errorRate = getCandidateUtilityErrorRate(c, minSamplesForErrorRate, useEwma);

      const normQuality = maxQ === minQ ? 1 : (q - minQ) / (maxQ - minQ);
      const normLatencyPenalty =
        latency === null || !Number.isFinite(latency)
          ? 0.5
          : Math.min(1, Math.max(0, latency / refLatency));
      const normErrorPenalty =
        errorRate === null || !Number.isFinite(errorRate) ? 0 : Math.min(1, Math.max(0, errorRate));
      const normCostPenalty = refCost > 0 ? Math.min(1, Math.max(0, cost / refCost)) : 0;

      const utilityScore =
        qualityWeight * normQuality -
        latencyWeight * normLatencyPenalty -
        errorRateWeight * normErrorPenalty -
        costWeight * normCostPenalty;

      return {
        id,
        qualityTier: q,
        costTier: cost,
        utilityScore,
      };
    });

    scored.sort((a, b) => {
      const diff = b.utilityScore - a.utilityScore;
      if (Math.abs(diff) > 1e-12) {
        return diff;
      }
      if (b.qualityTier !== a.qualityTier) {
        return b.qualityTier - a.qualityTier;
      }
      if (a.costTier !== b.costTier) {
        return a.costTier - b.costTier;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    const chosen = scored[0] as { id: string; utilityScore: number };
    return {
      strategyId: chosen.id,
      reason: `weighted-utility: selected strategy "${chosen.id}" with utility score ${chosen.utilityScore.toFixed(4)}`,
    };
  };
}

/**
 * Creates a stateful custom selector closure that detects rising or falling
 * signal slope spikes across a sliding window and triggers proactive load
 * shedding or low-latency degraded candidate selection.
 */
export function createSignalTrendGuardSelector(
  options: SignalTrendGuardSelectorOptions,
): SignalTrendGuardSelector {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new InvalidConfigurationError("options must be an object.");
  }
  const {
    signalName,
    maxSlopePerSec,
    windowSize = 5,
    minTimeSpanMs = 100,
    degradedQualityCap,
    preferLowestLatencyOnSpike = true,
    fallbackSelector,
  } = options;

  if (typeof signalName !== "string" || signalName.trim().length === 0) {
    throw new InvalidConfigurationError("signalName must be a non-empty string.");
  }
  if (
    typeof maxSlopePerSec !== "number" ||
    !Number.isFinite(maxSlopePerSec) ||
    maxSlopePerSec === 0
  ) {
    throw new InvalidConfigurationError("maxSlopePerSec must be a non-zero finite number.");
  }
  if (
    options.windowSize !== undefined &&
    (typeof windowSize !== "number" ||
      !Number.isSafeInteger(windowSize) ||
      windowSize < 2 ||
      windowSize > 100)
  ) {
    throw new InvalidConfigurationError("windowSize must be a safe integer between 2 and 100.");
  }
  if (
    options.minTimeSpanMs !== undefined &&
    (typeof minTimeSpanMs !== "number" || !Number.isFinite(minTimeSpanMs) || minTimeSpanMs <= 0)
  ) {
    throw new InvalidConfigurationError("minTimeSpanMs must be a positive finite number.");
  }
  if (
    degradedQualityCap !== undefined &&
    (typeof degradedQualityCap !== "number" || !Number.isFinite(degradedQualityCap))
  ) {
    throw new InvalidConfigurationError("degradedQualityCap must be a finite number.");
  }
  if (
    options.preferLowestLatencyOnSpike !== undefined &&
    typeof preferLowestLatencyOnSpike !== "boolean"
  ) {
    throw new InvalidConfigurationError("preferLowestLatencyOnSpike must be a boolean.");
  }
  if (fallbackSelector !== undefined && typeof fallbackSelector !== "function") {
    throw new InvalidConfigurationError("fallbackSelector must be a function.");
  }

  let window: SignalWindowEntry[] = [];

  const selector = (context: CustomSelectorContext) => {
    const signal = context.signals[signalName];
    const signalTimestamp = getSignalTimestamp(signal);

    if (
      signal !== undefined &&
      signal !== null &&
      signal.status === "ok" &&
      typeof signal.value === "number" &&
      Number.isFinite(signal.value) &&
      signalTimestamp !== null
    ) {
      const lastEntry = window[window.length - 1];
      if (lastEntry !== undefined && lastEntry.timestamp > signalTimestamp) {
        window = [];
      }

      const currentLast = window[window.length - 1];
      if (currentLast === undefined || currentLast.timestamp < signalTimestamp) {
        window.push({ timestamp: signalTimestamp, value: signal.value });
        while (window.length > windowSize) {
          window.shift();
        }
      } else if (currentLast.timestamp === signalTimestamp) {
        currentLast.value = signal.value;
      }
    }

    if (context.candidates.length === 0) {
      return null;
    }

    let spikeActive = false;
    let slopePerSec = 0;

    if (window.length >= 2) {
      const oldest = window[0] as SignalWindowEntry;
      const newest = window[window.length - 1] as SignalWindowEntry;
      const timeSpanMs = newest.timestamp - oldest.timestamp;

      if (timeSpanMs >= minTimeSpanMs) {
        slopePerSec = (newest.value - oldest.value) / (timeSpanMs / 1000);
        spikeActive =
          (maxSlopePerSec > 0 && slopePerSec > maxSlopePerSec) ||
          (maxSlopePerSec < 0 && slopePerSec < maxSlopePerSec);
      }
    }

    if (spikeActive) {
      let pool = [...context.candidates];
      if (degradedQualityCap !== undefined) {
        const filtered = pool.filter((c) => getCandidateQualityTier(c) <= degradedQualityCap);
        if (filtered.length > 0) {
          pool = filtered;
        }
      }

      if (preferLowestLatencyOnSpike !== false) {
        pool.sort((a, b) => {
          const latA = getSignalTrendCandidateLatency(a);
          const latB = getSignalTrendCandidateLatency(b);
          if (latA !== latB) {
            return latA - latB;
          }
          const costA = getCandidateCostTier(a);
          const costB = getCandidateCostTier(b);
          if (costA !== costB) {
            return costA - costB;
          }
          const qA = getCandidateQualityTier(a);
          const qB = getCandidateQualityTier(b);
          if (qA !== qB) {
            return qA - qB;
          }
          const idA = getCandidateId(a);
          const idB = getCandidateId(b);
          return idA < idB ? -1 : idA > idB ? 1 : 0;
        });
      } else {
        pool.sort((a, b) => {
          const qA = getCandidateQualityTier(a);
          const qB = getCandidateQualityTier(b);
          if (qA !== qB) {
            return qA - qB;
          }
          const costA = getCandidateCostTier(a);
          const costB = getCandidateCostTier(b);
          if (costA !== costB) {
            return costA - costB;
          }
          const idA = getCandidateId(a);
          const idB = getCandidateId(b);
          return idA < idB ? -1 : idA > idB ? 1 : 0;
        });
      }

      const chosen = pool[0] as CustomSelectorCandidate;
      const chosenId = getCandidateId(chosen);
      return {
        strategyId: chosenId,
        reason: `signal-trend-guard: spike detected on "${signalName}" (slope=${slopePerSec.toFixed(2)}/s, threshold=${maxSlopePerSec}/s); selected "${chosenId}"`,
      };
    }

    if (fallbackSelector !== undefined) {
      return fallbackSelector(context);
    }
    return null;
  };

  return Object.assign(selector, {
    reset(): void {
      window = [];
    },
  });
}

/**
 * Composes multiple CustomPolicySelector functions into a single sequential
 * pipeline. Selectors are evaluated in the order provided.
 *
 * The first selector that returns a non-null, non-undefined selection determines
 * the outcome. If all selectors return null or undefined, the composed selector
 * returns null (allowing downstream policy defaults to take effect).
 *
 * If `context.candidates` is empty, evaluation short-circuits to null.
 */
export function composeSelectors(selectors: readonly CustomPolicySelector[]): CustomPolicySelector {
  if (!Array.isArray(selectors)) {
    throw new ConfigurationError("selectors must be an array.");
  }
  if (selectors.length === 0) {
    throw new ConfigurationError("selectors must not be empty.");
  }
  for (let i = 0; i < selectors.length; i++) {
    if (typeof selectors[i] !== "function") {
      throw new ConfigurationError(`Selector at index ${i} must be a function.`);
    }
  }

  const pipeline = [...selectors];

  return (context) => {
    if (context.candidates.length === 0) {
      return null;
    }
    for (const selector of pipeline) {
      const selection = selector(context);
      if (selection !== null && selection !== undefined) {
        return selection;
      }
    }
    return null;
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
