import type { ResolvedPolicy } from "../types/policy.js";

export interface StrategyCandidate {
  readonly id: string;
  readonly qualityTier: number;
  readonly costTier?: number;
  readonly applicable: boolean;
  /** Arithmetic mean of historical durations, or null when untracked. */
  readonly estimatedLatencyMs?: number | null;
  /** Exponentially weighted recent latency, or null when untracked. */
  readonly ewmaLatencyMs?: number | null;
  /** Observed failure ratio in the range 0..1; 0 when no runs exist. */
  readonly errorRate?: number | null;
  /** Number of execution samples observed for this candidate, or null when untracked. */
  readonly samples?: number | null;
}

export interface TargetTierClamp {
  readonly targetQualityTier: number;
  readonly floorApplied: number | null;
  readonly poolMinApplied: number | null;
  readonly poolMaxApplied: number | null;
}

/** Deterministic ordering: higher quality, lower cost, then code-unit id. */
export function compareCandidates(left: StrategyCandidate, right: StrategyCandidate): number {
  if (left.qualityTier !== right.qualityTier) {
    return right.qualityTier - left.qualityTier;
  }
  const leftCost = left.costTier ?? Number.POSITIVE_INFINITY;
  const rightCost = right.costTier ?? Number.POSITIVE_INFINITY;
  if (leftCost !== rightCost) {
    return leftCost - rightCost;
  }
  // Code-unit comparison, not localeCompare: selection must be locale-independent.
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function chooseAtOrBelow(
  candidates: readonly StrategyCandidate[],
  targetTier: number,
): StrategyCandidate | undefined {
  return candidates
    .filter((candidate) => candidate.qualityTier <= targetTier)
    .sort(compareCandidates)[0];
}

export function pickHighest(
  candidates: readonly StrategyCandidate[],
): StrategyCandidate | undefined {
  return [...candidates].sort(compareCandidates)[0];
}

export function findApplicable(
  strategies: readonly StrategyCandidate[],
  strategyId: string,
): StrategyCandidate | undefined {
  return strategies.find((strategy) => strategy.id === strategyId && strategy.applicable);
}

export function hasCandidate(
  strategies: readonly StrategyCandidate[],
  strategyId: string,
): boolean {
  return strategies.some((strategy) => strategy.id === strategyId);
}

export function filterAutomaticCandidates(
  strategies: readonly StrategyCandidate[],
  policy: ResolvedPolicy,
): readonly StrategyCandidate[] {
  return strategies.filter(
    (strategy) =>
      strategy.applicable &&
      (policy.minQualityTier === undefined || strategy.qualityTier >= policy.minQualityTier) &&
      (policy.maxQualityTier === undefined || strategy.qualityTier <= policy.maxQualityTier),
  );
}

export function computeBaseQualityTier(
  strategies: readonly StrategyCandidate[],
  maxQualityTier: number | undefined,
): number {
  const declaredMaxQualityTier = Math.max(...strategies.map((strategy) => strategy.qualityTier));
  return maxQualityTier === undefined
    ? declaredMaxQualityTier
    : Math.min(declaredMaxQualityTier, maxQualityTier);
}

export function clampTargetQualityTier(
  targetQualityTier: number,
  minQualityTier: number | undefined,
  poolTiers: readonly number[],
): TargetTierClamp {
  let target = targetQualityTier;
  let floorApplied: number | null = null;
  let poolMinApplied: number | null = null;
  let poolMaxApplied: number | null = null;

  if (minQualityTier !== undefined && target < minQualityTier) {
    target = minQualityTier;
    floorApplied = minQualityTier;
  }

  const minPoolTier = Math.min(...poolTiers);
  const maxPoolTier = Math.max(...poolTiers);
  if (target < minPoolTier) {
    target = minPoolTier;
    poolMinApplied = minPoolTier;
  } else if (target > maxPoolTier) {
    target = maxPoolTier;
    poolMaxApplied = maxPoolTier;
  }

  return {
    targetQualityTier: target,
    floorApplied,
    poolMinApplied,
    poolMaxApplied,
  };
}
