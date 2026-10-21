import type { Clock } from "./clock.js";
import type { StrategyDecision } from "./decision.js";
import type { RuntimeEventListener, RuntimeEventName } from "./events.js";
import type { Policy } from "./policy.js";
import type { Operation, RunResult, RuntimeStats } from "./run.js";
import type { SignalProvider } from "./signals.js";

export interface CreateRuntimeOptions {
  /** Defaults documented in Policy; every field has a safe default. */
  readonly policy?: Policy;
  /** Signal providers added at construction. Names must be unique. */
  readonly providers?: readonly SignalProvider[];
  /** Injectable clock for policy timing and timeouts. */
  readonly clock?: Clock;
  /**
   * Maximum time to wait for one provider read. Defaults to 1000 ms.
   * Set to 0 to disable the timeout.
   */
  readonly providerTimeoutMs?: number;
}

export interface AdaptiveRuntime {
  /**
   * Selects a strategy, executes it exactly once, and returns the value with
   * decision metadata. Rejected strategies are never retried automatically.
   */
  run<TInput, TOutput>(operation: Operation<TInput, TOutput>): Promise<RunResult<TOutput>>;
  /** Explicit manual override. Bypasses pressure, but not applicability checks. */
  pinStrategy(operationId: string, strategyId: string): void;
  unpinStrategy(operationId: string): void;
  /** Per-operation override of policy.adaptationEnabled. A pin takes precedence. */
  setAdaptationEnabled(operationId: string, enabled: boolean): void;
  getDecision(operationId: string): StrategyDecision | null;
  getStats(operationId: string): RuntimeStats;
  on<K extends RuntimeEventName>(event: K, listener: RuntimeEventListener<K>): () => void;
  /**
   * Stops providers and rejects new runs. Callers should let in-flight runs
   * settle before closing; provider shutdown can affect a pending signal read.
   */
  close(): Promise<void>;
}
