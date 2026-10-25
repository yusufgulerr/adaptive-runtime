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
 * Type alias for an operation's serialized runtime state.
 */
export type SerializedOperationState = OperationRuntimeState;

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

/**
 * Summary inspection view of a runtime state snapshot.
 */
export interface StateSnapshotInspection {
  readonly version: 1;
  readonly exportedAtMs: number;
  readonly operationCount: number;
  readonly operationIds: readonly string[];
  readonly totalStrategyRecords: number;
  readonly activeStrategiesByOperation: Readonly<Record<string, string | null>>;
}

/**
 * Strategy transition details for an operation between two state snapshots.
 */
export interface OperationStateTransition {
  readonly operationId: string;
  readonly previousStrategyId: string | null;
  readonly currentStrategyId: string | null;
  readonly switchCountDelta: number;
}

/**
 * Deterministic diff between two runtime state snapshots.
 */
export interface StateSnapshotDiff {
  readonly addedOperations: readonly string[];
  readonly removedOperations: readonly string[];
  readonly strategyTransitions: readonly OperationStateTransition[];
  readonly unchangedOperations: readonly string[];
}
