import type { SignalView, StrategyDecision } from "./decision.js";
import type { Strategy } from "./strategy.js";

export interface Operation<TInput, TOutput> {
  /** Stable identifier; policy state is kept per operation. */
  readonly operationId: string;
  readonly input: TInput;
  readonly strategies: readonly Strategy<TInput, TOutput>[];
  /** Standard cancellation signal. Cancellation is cooperative. */
  readonly signal?: AbortSignal;
  /** Per-run timeout in milliseconds. Must be positive when provided. */
  readonly timeoutMs?: number;
  /** Opaque application context passed to strategies. */
  readonly context?: unknown;
}

export interface QualityMetadata {
  readonly status: "not-configured" | "passed" | "failed" | "error";
  readonly detail?: string;
  readonly score?: number;
}

export interface RunMetadata {
  readonly operationId: string;
  readonly strategyId: string;
  readonly qualityTier: number;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly durationMs: number;
  readonly attempts: 1;
  readonly decision: StrategyDecision;
  readonly signals: readonly SignalView[];
  readonly quality: QualityMetadata;
}

export interface RunResult<TOutput> {
  readonly value: TOutput;
  readonly metadata: RunMetadata;
}

export interface StrategyStats {
  readonly runs: number;
  readonly successes: number;
  readonly failures: number;
  readonly lastDurationMs: number | null;
  /** Unbounded arithmetic mean of all sampled durations. */
  readonly averageDurationMs: number | null;
  /**
   * Total observed duration across all duration samples in milliseconds.
   * Preserved exactly across export/import cycles to eliminate floating-point drift.
   */
  readonly totalDurationMs?: number;
  /**
   * Exponentially weighted moving average of sampled durations (alpha 0.2).
   * Reacts to recent latency changes without losing the arithmetic average.
   */
  readonly ewmaDurationMs: number | null;
  /** Number of duration observations used by the averages. */
  readonly durationSamples: number;
  /** failures / runs, or 0 when the strategy has not run yet. */
  readonly errorRate: number;
}

export interface RuntimeStats {
  readonly operationId: string;
  readonly runs: number;
  readonly successes: number;
  readonly failures: number;
  readonly lastDurationMs: number | null;
  /** Unbounded arithmetic mean of all sampled durations. */
  readonly averageDurationMs: number | null;
  /**
   * Total observed duration across all duration samples in milliseconds.
   * Preserved exactly across export/import cycles to eliminate floating-point drift.
   */
  readonly totalDurationMs?: number;
  /** Exponentially weighted moving average of sampled durations (alpha 0.2). */
  readonly ewmaDurationMs: number | null;
  /** Number of duration observations used by the averages. */
  readonly durationSamples: number;
  /** failures / runs, or 0 when the operation has not run yet. */
  readonly errorRate: number;
  readonly strategyRuns: Readonly<Record<string, number>>;
  readonly strategies: Readonly<Record<string, StrategyStats>>;
}
