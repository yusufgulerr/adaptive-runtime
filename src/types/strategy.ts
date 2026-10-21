import type { StrategyDecision } from "./decision.js";

export interface StrategyApplicabilityContext<TInput> {
  readonly input: TInput;
  readonly operationId: string;
  readonly context: unknown;
}

export interface StrategyRunContext<TInput> {
  readonly input: TInput;
  readonly signal: AbortSignal;
  readonly operationId: string;
  readonly strategyId: string;
  readonly decision: StrategyDecision;
  readonly context: unknown;
}

export interface QualityCheckResult {
  readonly ok: boolean;
  /** Human-readable detail. Do not include secrets or raw user input. */
  readonly detail?: string;
  readonly score?: number;
}

/**
 * A strategy performs the same logical operation with a different cost/quality
 * profile. Quality tiers are developer declarations, not verified facts.
 */
export interface Strategy<TInput, TOutput> {
  readonly id: string;
  readonly description?: string;
  /**
   * Ordinal quality declaration. Higher is expected to be better quality.
   * The runtime never infers quality from code or output.
   */
  readonly qualityTier: number;
  /** Optional ordinal cost declaration. Lower is cheaper; used as a tie-breaker. */
  readonly costTier?: number;
  readonly labels?: readonly string[];
  /** Optional synchronous applicability check. A throw fails the run. */
  isApplicable?(context: StrategyApplicabilityContext<TInput>): boolean;
  run(context: StrategyRunContext<TInput>): TOutput | Promise<TOutput>;
  /**
   * Optional output check. The runtime relays the result; it does not prove
   * semantic correctness. A failed check never triggers an automatic re-run.
   */
  checkQuality?(
    value: TOutput,
    context: StrategyRunContext<TInput>,
  ): QualityCheckResult | Promise<QualityCheckResult>;
}
