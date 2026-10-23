import type { PolicyState } from "../policy/engine.js";
import type { StrategyDecision } from "./decision.js";
import type { RuntimeStats } from "./run.js";

/**
 * Serializable runtime state for one operation.
 *
 * Configuration such as per-operation policy overrides is deliberately not
 * included: policy overrides may contain functions and are not state.
 */
export interface OperationRuntimeState {
  /** Policy mode, budget hysteresis counters, and stability counters. */
  readonly policyState: PolicyState;
  /** Last persisted decision, or null when no decision has been stored. */
  readonly decision: StrategyDecision | null;
  /** Explicit pin, or null when the operation is not pinned. */
  readonly pinnedStrategyId: string | null;
  /** Per-operation adaptation override, or null when no override is set. */
  readonly adaptationEnabled: boolean | null;
  /** Counters and latency estimates used for policy candidate metadata. */
  readonly stats: RuntimeStats;
}

export interface OperationStateSnapshot {
  readonly operationId: string;
  readonly state: OperationRuntimeState;
}

/**
 * Versioned state snapshot produced by `exportState()` and accepted by
 * `importState()`. Only JSON-compatible values are present.
 */
export interface RuntimeStateSnapshot {
  readonly version: 1;
  /** Clock value at which the snapshot was produced. */
  readonly exportedAt: number;
  readonly operations: readonly OperationStateSnapshot[];
}
