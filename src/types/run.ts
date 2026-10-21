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

export interface RuntimeStats {
  readonly operationId: string;
  readonly runs: number;
  readonly successes: number;
  readonly failures: number;
  readonly lastDurationMs: number | null;
  readonly averageDurationMs: number | null;
  readonly strategyRuns: Readonly<Record<string, number>>;
}
