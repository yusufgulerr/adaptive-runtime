import type { SignalReading } from "./signals.js";

export type MissingSignalBehavior = "hold" | "fallback" | "error" | "ignore";

export interface PolicyCandidate {
  readonly id: string;
  readonly qualityTier: number;
  readonly costTier?: number;
  readonly applicable?: boolean;
}

export interface CustomSelectorCandidate {
  readonly candidate: PolicyCandidate;
  readonly estimatedCost: number | null;
  /**
   * Recent latency estimate. When execution history exists this is the
   * exponentially weighted moving average; otherwise it is null.
   */
  readonly estimatedLatencyMs: number | null;
  /** Configurable recent latency estimate, or null when no samples exist. */
  readonly ewmaLatencyMs?: number | null;
  /** Observed failure ratio in the range 0..1; 0 when no runs exist. */
  readonly errorRate?: number | null;
  /** Number of execution samples observed for this candidate, or null/undefined if untracked. */
  readonly samples?: number | null;
}

export interface CustomPolicySelectorContext {
  readonly operation: string;
  readonly operationId?: string;
  readonly candidates: readonly CustomSelectorCandidate[];
  readonly signals: Readonly<Record<string, SignalReading>>;
  readonly now: number;
}

export type CustomSelectorContext = CustomPolicySelectorContext;

export interface CustomPolicySelection {
  readonly strategyId: string;
  readonly reason?: string;
}

export type CustomPolicySelector = (
  context: CustomPolicySelectorContext,
) => CustomPolicySelection | string | null | undefined;

/**
 * A soft budget rule. When the signal exceeds `limit`, the policy reduces the
 * target quality tier. It recovers once the signal falls below `recoverBelow`.
 *
 * This is a selection policy, not an operating-system resource limit.
 */
export interface BudgetRule {
  readonly id: string;
  readonly signal: string;
  readonly limit: number;
  /**
   * Value that must be observed before the rule releases. Must be less than or
   * equal to `limit`. Defaults to `limit`, so equality is neither entering nor
   * recovering.
   */
  readonly recoverBelow?: number;
  /** Quality tiers removed while engaged. Positive integer. Defaults to 1. */
  readonly tierReduction?: number;
  /** Overrides the policy-level sample count for this rule. */
  readonly consecutiveSamples?: number;
}

export interface Policy {
  /**
   * Minimum time between fresh provider reads. Runs inside the interval reuse
   * the cached snapshot. Defaults to 1000 ms. Set to 0 to read on every run.
   */
  readonly evaluationIntervalMs?: number;
  /** Readings older than this are treated as stale. Defaults to 5000 ms. */
  readonly maxSignalAgeMs?: number;
  /** Minimum time a strategy remains selected before an adaptive switch. */
  readonly minimumModeDurationMs?: number;
  /** Consecutive fresh samples required for pressure and candidate stability. */
  readonly consecutiveSamples?: number;
  /** Automatic selection never chooses a tier below this floor. */
  readonly minQualityTier?: number;
  /** Caps automatic selection, even if strategies declare higher tiers. */
  readonly maxQualityTier?: number;
  /** Safe strategy used when a referenced signal is missing. */
  readonly fallbackStrategyId?: string;
  /** Defaults to "hold". */
  readonly missingSignalBehavior?: MissingSignalBehavior;
  /** When false, select the highest applicable quality tier without pressure. */
  readonly adaptationEnabled?: boolean;
  /** "report" records a failed quality check; "error" fails the run. */
  readonly qualityCheck?: "report" | "error";
  readonly budgets?: readonly BudgetRule[];
  /**
   * Maximum number of operation ids whose policy state, decisions, pins,
   * overrides, and stats are retained. Least-recently-used unlocked and
   * unpinned operations are evicted first. Defaults to `null` (unbounded).
   * Must be a positive safe integer when set.
   */
  readonly maxTrackedOperations?: number | null;
  readonly customSelector?: CustomPolicySelector;
}

export interface ResolvedBudgetRule {
  readonly id: string;
  readonly signal: string;
  readonly limit: number;
  readonly recoverBelow: number;
  readonly tierReduction: number;
  readonly consecutiveSamples: number;
}

export interface ResolvedPolicy {
  readonly evaluationIntervalMs: number;
  readonly maxSignalAgeMs: number;
  readonly minimumModeDurationMs: number;
  readonly consecutiveSamples: number;
  readonly minQualityTier: number | undefined;
  readonly maxQualityTier: number | undefined;
  readonly fallbackStrategyId: string | undefined;
  readonly missingSignalBehavior: MissingSignalBehavior;
  readonly adaptationEnabled: boolean;
  readonly qualityCheck: "report" | "error";
  readonly budgets: readonly ResolvedBudgetRule[];
  readonly maxTrackedOperations: number | null;
  readonly customSelector: CustomPolicySelector | null;
}

export type OperationPolicy = Partial<Policy>;
