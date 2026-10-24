import type { Clock } from "./clock.js";
import type { StrategyDecision } from "./decision.js";
import type { RuntimeEventListener, RuntimeEventName } from "./events.js";
import type { Policy, ResolvedPolicy } from "./policy.js";
import type { Operation, RunResult, RuntimeStats } from "./run.js";
import type { SignalProvider } from "./signals.js";
import type { RuntimeStateSnapshot } from "./state.js";

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
  /**
   * Maximum length for quality check detail strings before truncation.
   * Defaults to 1000. Must be a safe positive integer.
   */
  readonly maxQualityCheckDetailLength?: number;
}

export interface EvaluateOptions {
  /**
   * When true, computes and returns a decision without persisting policy state
   * or stats, storing the decision, or emitting a `decision` event. Defaults to
   * false. Evaluation never executes a strategy in either mode.
   */
  readonly dryRun?: boolean;
}

export interface AdaptiveRuntime {
  /**
   * Selects a strategy, executes it exactly once, and returns the value with
   * decision metadata. Rejected strategies are never retried automatically.
   */
  run<TInput, TOutput>(operation: Operation<TInput, TOutput>): Promise<RunResult<TOutput>>;
  /**
   * Computes one policy decision without executing a strategy. A non-dry-run
   * evaluation persists the decision and policy state and emits `decision`, but
   * does not update run statistics. A dry run changes no observable state.
   */
  evaluate<TInput, TOutput>(
    operation: Operation<TInput, TOutput>,
    options?: EvaluateOptions,
  ): Promise<StrategyDecision>;
  /**
   * Produces a versioned JSON-compatible snapshot. With an operation id, only
   * that operation is included; an unknown id produces an empty snapshot.
   */
  exportState(operationId?: string): RuntimeStateSnapshot;
  /**
   * Validates and restores snapshot state. Existing operations not present in
   * the snapshot are left untouched. Returns the number of restored operations.
   * Throws before mutating anything when the snapshot is invalid or targets an
   * operation with an in-flight selection or run.
   */
  importState(snapshot: RuntimeStateSnapshot): number;
  /** Explicit manual override. Bypasses pressure, but not applicability checks. */
  pinStrategy(operationId: string, strategyId: string): void;
  unpinStrategy(operationId: string): void;
  /** Per-operation override of policy.adaptationEnabled. A pin takes precedence. */
  setAdaptationEnabled(operationId: string, enabled: boolean): void;
  /**
   * Overrides the selection policy for one specific operation.
   * Pass null to remove the operation's policy override.
   */
  setOperationPolicy(operationId: string, policy: Partial<Policy> | null): void;
  /**
   * Returns the resolved policy override for one specific operation, or null
   * if no override has been set. Refreshes LRU tracking when an operation record
   * exists.
   */
  getOperationPolicy(operationId: string): ResolvedPolicy | null;
  getDecision(operationId: string): StrategyDecision | null;
  getStats(operationId: string): RuntimeStats;
  /**
   * Returns a frozen array of all currently tracked operation ids in LRU order
   * (oldest to newest). Does not refresh or alter the LRU order.
   */
  getTrackedOperations(): readonly string[];
  /**
   * Returns a frozen dictionary mapping each tracked operation id to its
   * current RuntimeStats. Does not refresh or alter the LRU order.
   */
  getAllStats(): Readonly<Record<string, RuntimeStats>>;
  /**
   * Removes all retained state and stats for one operation. Returns false when
   * a selection or run is in flight for that operation; the active work is not
   * disturbed. Returns true when at least one record was removed.
   */
  removeOperation(operationId: string): boolean;
  /**
   * Resets counters for one operation, or all operations when no id is given.
   * Retained decisions, pins, and overrides are not removed.
   */
  resetStats(operationId?: string): void;
  on<K extends RuntimeEventName>(event: K, listener: RuntimeEventListener<K>): () => void;
  /**
   * Stops providers and rejects new runs. Callers should let in-flight runs
   * settle before closing; provider shutdown can affect a pending signal read.
   */
  close(): Promise<void>;
}
