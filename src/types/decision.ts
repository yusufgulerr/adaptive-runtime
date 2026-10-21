import type { SignalStatus, SignalUnit } from "./signals.js";

export type DecisionKind = "initial" | "adapted" | "retained" | "pinned" | "fallback" | "static";

export type DecisionReasonCode =
  | "initial-selection"
  | "strategy-switched"
  | "strategy-retained"
  | "quality-pressure"
  | "budget-recovered"
  | "quality-floor-clamped"
  | "target-tier-clamped"
  | "minimum-mode-duration"
  | "candidate-stability"
  | "current-strategy-inapplicable"
  | "pinned-strategy"
  | "adaptation-disabled"
  | "missing-signal-hold"
  | "missing-signal-ignored"
  | "missing-signal-fallback"
  | "cached-sample"
  | "custom-selector";

export interface DecisionReason {
  readonly code: DecisionReasonCode;
  readonly message: string;
  readonly detail?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface SignalView {
  readonly name: string;
  readonly unit?: SignalUnit;
  /** "missing" means no provider returned this signal in the snapshot. */
  readonly status: SignalStatus | "missing";
  readonly value?: number;
  readonly observedAt?: number;
  readonly ageMs?: number;
  readonly detail?: string;
}

export interface BudgetView {
  readonly id: string;
  readonly signal: string;
  readonly engaged: boolean;
  readonly status: SignalStatus | "missing";
  readonly value?: number;
  readonly ageMs?: number;
  readonly limit: number;
  readonly recoverBelow: number;
  readonly tierReduction: number;
}

/**
 * A complete, inspectable explanation of the strategy selection. Decisions are
 * deterministic for the same inputs, policy state, and clock value.
 */
export interface StrategyDecision {
  readonly operationId: string;
  readonly strategyId: string;
  readonly qualityTier: number;
  readonly previousStrategyId: string | null;
  readonly changed: boolean;
  readonly kind: DecisionKind;
  readonly decidedAt: number;
  readonly modeSince: number;
  readonly baseQualityTier: number;
  readonly targetQualityTier: number;
  readonly signals: readonly SignalView[];
  readonly budgets: readonly BudgetView[];
  readonly reasons: readonly DecisionReason[];
  readonly sampleSequence: number | null;
  readonly signalsCached: boolean;
}
