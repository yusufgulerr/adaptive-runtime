import { ConfigurationError } from "../errors/index.js";
import type { StrategyCandidate } from "../policy/engine.js";
import { createInitialPolicyState, evaluatePolicy, type PolicyState } from "../policy/engine.js";
import { resolvePolicy } from "../policy/resolve.js";
import { systemClock } from "../runtime/clock.js";
import type { Clock } from "../types/clock.js";
import type {
  BudgetView,
  DecisionKind,
  DecisionReason,
  SignalView,
  StrategyDecision,
} from "../types/decision.js";
import type { OperationPolicy } from "../types/policy.js";
import type { ResourceSignal, SignalStatus, SignalUnit } from "../types/signals.js";

const DEFAULT_OPERATION_ID = "traced-operation";
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_STEP_INTERVAL_MS = 1000;
const MISSING_SEQUENCE = -1;
const MISSING_STRATEGY_ID = "<missing>";

const SIGNAL_UNITS: readonly SignalUnit[] = ["bytes", "milliseconds", "ratio", "count", "custom"];

const SIGNAL_STATUSES: readonly SignalStatus[] = ["ok", "unknown", "unsupported", "stale", "error"];

const DECISION_KINDS: readonly DecisionKind[] = [
  "initial",
  "adapted",
  "retained",
  "pinned",
  "fallback",
  "static",
];

const REASON_CODES: readonly DecisionReason["code"][] = [
  "initial-selection",
  "strategy-switched",
  "strategy-retained",
  "quality-pressure",
  "budget-recovered",
  "quality-floor-clamped",
  "target-tier-clamped",
  "minimum-mode-duration",
  "candidate-stability",
  "current-strategy-inapplicable",
  "pinned-strategy",
  "adaptation-disabled",
  "missing-signal-hold",
  "missing-signal-ignored",
  "missing-signal-fallback",
  "cached-sample",
  "custom-selector",
];

const DETERMINISTIC_DECISION_FIELDS = [
  "strategyId",
  "qualityTier",
  "previousStrategyId",
  "changed",
  "kind",
  "decidedAt",
  "modeSince",
  "baseQualityTier",
  "targetQualityTier",
  "sampleSequence",
  "signalsCached",
] as const;

type DeterministicDecisionField = (typeof DETERMINISTIC_DECISION_FIELDS)[number];

/**
 * One complete policy evaluation captured for later replay: the state before
 * the evaluation, every input, the selected decision, and the resulting state.
 */
export interface PolicyTraceEntry {
  /** Monotonic entry number starting at 1. Eviction never renumbers entries. */
  readonly sequence: number;
  /** Optional caller-supplied label for reports and logs. */
  readonly label?: string;
  /** Clock value supplied to the policy evaluation. */
  readonly now: number;
  /** Policy state supplied to the evaluation. */
  readonly stateBefore: PolicyState;
  /** Decision returned by the evaluation. */
  readonly decision: StrategyDecision;
  /** Policy state returned by the evaluation. */
  readonly stateAfter: PolicyState;
  /** Signal readings supplied to the evaluation. */
  readonly signals: readonly ResourceSignal[];
  /** Strategy candidate pool supplied to the evaluation. */
  readonly strategies: readonly StrategyCandidate[];
  /** Explicit pinned strategy, or null when the operation was not pinned. */
  readonly pinnedStrategyId: string | null;
  /** Whether automatic adaptation was enabled for the evaluation. */
  readonly adaptationEnabled: boolean;
  /** Sample sequence supplied to the evaluation, or null when untracked. */
  readonly sampleSequence: number | null;
  /** Whether the evaluation reused a cached signal snapshot. */
  readonly signalsCached: boolean;
}

/** A frozen, JSON-safe recording of policy evaluations for one operation. */
export interface PolicyTrace {
  /** Trace format version. Only version 1 is supported. */
  readonly version: 1;
  /** Canonical operation id shared by every entry. */
  readonly operationId: string;
  /** Clock value captured when the trace was exported. */
  readonly createdAt: number;
  /** Captured entries in evaluation order. */
  readonly entries: readonly PolicyTraceEntry[];
}

/** Options for {@link createPolicyTraceRecorder}. */
export interface PolicyTraceRecorderOptions {
  /** Canonical operation id. Defaults to `"traced-operation"`. */
  readonly operationId?: string;
  /** Maximum retained entries, a positive safe integer. Defaults to `10_000`. */
  readonly maxEntries?: number;
  /** Time source used for trace export timestamps. Defaults to `systemClock`. */
  readonly clock?: Clock;
}

/**
 * Every field of a {@link PolicyTraceEntry} except `sequence`, which the
 * recorder assigns.
 */
export interface RecordPolicyTraceEntryInput {
  /** Optional caller-supplied label for reports and logs. */
  readonly label?: string;
  /** Clock value supplied to the policy evaluation. */
  readonly now: number;
  /** Policy state supplied to the evaluation. */
  readonly stateBefore: PolicyState;
  /** Decision returned by the evaluation. */
  readonly decision: StrategyDecision;
  /** Policy state returned by the evaluation. */
  readonly stateAfter: PolicyState;
  /** Signal readings supplied to the evaluation. */
  readonly signals: readonly ResourceSignal[];
  /** Strategy candidate pool supplied to the evaluation. */
  readonly strategies: readonly StrategyCandidate[];
  /** Explicit pinned strategy, or null when the operation was not pinned. */
  readonly pinnedStrategyId: string | null;
  /** Whether automatic adaptation was enabled for the evaluation. */
  readonly adaptationEnabled: boolean;
  /** Sample sequence supplied to the evaluation, or null when untracked. */
  readonly sampleSequence: number | null;
  /** Whether the evaluation reused a cached signal snapshot. */
  readonly signalsCached: boolean;
}

/**
 * A bounded, append-only policy trace collector. Recorded inputs and outputs are
 * deep-copied and frozen, so later caller mutation cannot alter a trace.
 */
export interface PolicyTraceRecorder {
  /** Records one evaluation and returns its frozen, sequenced entry. */
  record(input: RecordPolicyTraceEntryInput): PolicyTraceEntry;
  /** Returns a frozen snapshot of the retained entries in sequence order. */
  getEntries(): readonly PolicyTraceEntry[];
  /** Exports a frozen, JSON-safe trace stamped with the current clock value. */
  exportTrace(): PolicyTrace;
  /** Removes every retained entry and restarts sequencing at 1. */
  clear(): void;
  /** Number of currently retained entries. */
  size(): number;
}

/** One entry whose replayed decision or next state differs from the trace. */
export interface PolicyTraceReplayDivergence {
  /** Sequence number of the divergent entry. */
  readonly sequence: number;
  /** Entry label when one was recorded. */
  readonly label?: string;
  /** Strategy id recorded in the trace. */
  readonly expectedStrategyId: string;
  /** Strategy id selected by the replayed policy. */
  readonly actualStrategyId: string;
  /** Changed deterministic decision fields, in contract order. */
  readonly fields: readonly string[];
  /** Whether the replayed next policy state structurally equals `stateAfter`. */
  readonly stateMatched: boolean;
}

/** Result of replaying a trace against a policy. */
export interface PolicyTraceReplayReport {
  /** Operation id of the replayed trace. */
  readonly operationId: string;
  /** Number of entries in the trace. */
  readonly totalEntries: number;
  /** Entries whose decision fields and next state both matched. */
  readonly matchedEntries: number;
  /** Entries with at least one decision-field or state divergence. */
  readonly mismatchedEntries: number;
  /** True when every entry matched and no state diverged. */
  readonly deterministic: boolean;
  /** Frozen divergence details, in trace order. */
  readonly divergences: readonly PolicyTraceReplayDivergence[];
}

/** One index at which two traces disagree, or where one trace has no entry. */
export interface PolicyTraceDivergence {
  /** Zero-based entry index. */
  readonly index: number;
  /** Baseline entry sequence, or `-1` when the index is missing from the baseline. */
  readonly baselineSequence: number;
  /** Candidate entry sequence, or `-1` when the index is missing from the candidate. */
  readonly candidateSequence: number;
  /** Baseline label, or the candidate label when only the candidate has one. */
  readonly label?: string;
  /** Baseline strategy id, or `"<missing>"` when the index is missing. */
  readonly baselineStrategyId: string;
  /** Candidate strategy id, or `"<missing>"` when the index is missing. */
  readonly candidateStrategyId: string;
}

/** Result of comparing two traces by entry index. */
export interface PolicyTraceDiff {
  /** Operation id of the baseline trace. */
  readonly baselineOperationId: string;
  /** Operation id of the candidate trace. */
  readonly candidateOperationId: string;
  /** Number of compared indices: the longer trace length. */
  readonly totalEntries: number;
  /** Indices compared, including indices missing from one side. */
  readonly comparedEntries: number;
  /** Number of divergent indices. */
  readonly divergenceCount: number;
  /** `(comparedEntries - divergenceCount) / comparedEntries`, or 1 when empty. */
  readonly agreementRatio: number;
  /** Candidate strategy switches minus baseline strategy switches. */
  readonly strategySwitchDelta: number;
  /** Frozen divergences, in index order. */
  readonly divergences: readonly PolicyTraceDivergence[];
}

/** Aggregate statistics for one trace. */
export interface PolicyTraceSummary {
  /** Operation id of the summarized trace. */
  readonly operationId: string;
  /** Number of entries. */
  readonly entryCount: number;
  /** Clock value of the first entry, or 0 for an empty trace. */
  readonly firstAt: number;
  /** Clock value of the last entry, or 0 for an empty trace. */
  readonly lastAt: number;
  /** Decision counts keyed by strategy id, with sorted keys. */
  readonly strategyCounts: Readonly<Record<string, number>>;
  /** Decision counts keyed by decision kind, with sorted keys. */
  readonly kindCounts: Readonly<Record<string, number>>;
  /** Number of entries whose decision reports `changed: true`. */
  readonly strategySwitches: number;
  /** Number of A-to-B switches immediately followed by a B-to-A switch. */
  readonly strategyReversals: number;
  /** Number of entries that reused a cached signal snapshot. */
  readonly cachedSamples: number;
  /** Sorted, unique budget ids observed transitioning to engaged. */
  readonly engagedBudgetIds: readonly string[];
}

/** A strategy accepted by {@link capturePolicyTrace}; mirrors the simulator input. */
interface TraceSimulatedStrategy {
  readonly id: string;
  readonly qualityTier: number;
  readonly costTier?: number;
  readonly applicable?: boolean;
  readonly estimatedLatencyMs?: number | null;
  readonly ewmaLatencyMs?: number | null;
  readonly errorRate?: number | null;
  readonly samples?: number | null;
}

/** One scripted step accepted by {@link capturePolicyTrace}; mirrors the simulator input. */
interface TraceTimelineStep {
  readonly label?: string;
  readonly now?: number;
  readonly signals: readonly ResourceSignal[];
  readonly strategies?: readonly TraceSimulatedStrategy[];
  readonly pinnedStrategyId?: string | null;
  readonly adaptationEnabled?: boolean;
  readonly sampleSequence?: number | null;
  readonly signalsCached?: boolean;
}

interface NormalizedCaptureStep {
  readonly label?: string;
  readonly now: number;
  readonly signals: readonly ResourceSignal[];
  readonly strategies: readonly StrategyCandidate[];
  readonly pinnedStrategyId: string | null;
  readonly adaptationEnabled: boolean;
  readonly sampleSequence: number | null;
  readonly signalsCached: boolean;
}

function fail(path: string, requirement: string): never {
  throw new ConfigurationError(`${path} ${requirement}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    fail(path, "must be an object.");
  }
  return value;
}

function requireArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    fail(path, "must be an array.");
  }
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    fail(path, "must be a string.");
  }
  return value;
}

function requireCanonicalString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(path, "must be a non-empty string.");
  }
  if (value !== value.trim()) {
    fail(path, "must not have leading or trailing whitespace.");
  }
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    fail(path, "must be a boolean.");
  }
  return value;
}

function requireFinite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(path, "must be a finite number.");
  }
  return value;
}

function requireNonNegativeFinite(value: unknown, path: string): number {
  const number = requireFinite(value, path);
  if (number < 0) {
    fail(path, "must be greater than or equal to 0.");
  }
  return number;
}

function requireSafeInteger(value: unknown, path: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    fail(
      path,
      minimum === 1 ? "must be a positive safe integer." : "must be a non-negative safe integer.",
    );
  }
  return value;
}

function isSignalUnit(value: unknown): value is SignalUnit {
  return typeof value === "string" && (SIGNAL_UNITS as readonly string[]).includes(value);
}

function requireSignalUnit(value: unknown, path: string): SignalUnit {
  if (!isSignalUnit(value)) {
    fail(path, `must be one of ${SIGNAL_UNITS.join(", ")}.`);
  }
  return value;
}

function isSignalStatus(value: unknown): value is SignalStatus {
  return typeof value === "string" && (SIGNAL_STATUSES as readonly string[]).includes(value);
}

function isDecisionKind(value: unknown): value is DecisionKind {
  return typeof value === "string" && (DECISION_KINDS as readonly string[]).includes(value);
}

function isReasonCode(value: unknown): value is DecisionReason["code"] {
  return typeof value === "string" && (REASON_CODES as readonly string[]).includes(value);
}

function cloneNullableCanonicalString(value: unknown, path: string): string | null {
  return value === null ? null : requireCanonicalString(value, path);
}

function cloneNullableFinite(value: unknown, path: string): number | null {
  return value === null ? null : requireFinite(value, path);
}

function cloneNullableNonNegativeFinite(value: unknown, path: string): number | null {
  return value === null ? null : requireNonNegativeFinite(value, path);
}

function cloneNullableNonNegativeInteger(value: unknown, path: string): number | null {
  return value === null ? null : requireSafeInteger(value, path, 0);
}

function cloneErrorRate(value: unknown, path: string): number | null {
  if (value === null) {
    return null;
  }
  const rate = requireFinite(value, path);
  if (rate < 0 || rate > 1) {
    fail(path, "must be between 0 and 1.");
  }
  return rate;
}

function cloneJsonValue(value: unknown, path: string, stack: Set<object>): unknown {
  if (value === null) {
    return null;
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        fail(path, "must be a finite JSON number.");
      }
      return value;
    case "object":
      break;
    default:
      fail(path, "must be JSON-safe (no functions, symbols, or bigints).");
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => cloneJsonValue(item, `${path}[${index}]`, stack));
  }

  const record = value as Record<string, unknown>;
  if (!isPlainRecord(record)) {
    fail(path, "must contain only plain JSON objects and arrays.");
  }
  if (stack.has(record)) {
    fail(path, "must not contain circular references.");
  }

  stack.add(record);
  try {
    const cloned: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      const item = record[key];
      if (item === undefined) {
        continue;
      }
      defineRecordKey(cloned, key, cloneJsonValue(item, `${path}.${key}`, stack));
    }
    return cloned;
  } finally {
    stack.delete(record);
  }
}

function defineRecordKey<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function cloneJsonRecord(value: unknown, path: string): Readonly<Record<string, unknown>> {
  const cloned = cloneJsonValue(value, path, new Set<object>());
  if (!isPlainRecord(cloned)) {
    fail(path, "must be an object.");
  }
  return cloned;
}

function cloneBudgetState(value: unknown, path: string): PolicyState["budgets"][string] {
  const record = requireRecord(value, path);
  return {
    engaged: requireBoolean(record.engaged, `${path}.engaged`),
    aboveStreak: requireSafeInteger(record.aboveStreak, `${path}.aboveStreak`, 0),
    belowStreak: requireSafeInteger(record.belowStreak, `${path}.belowStreak`, 0),
  };
}

function clonePolicyState(value: unknown, path: string): PolicyState {
  const record = requireRecord(value, path);
  const budgetRecord = requireRecord(record.budgets, `${path}.budgets`);
  const budgets: Record<string, PolicyState["budgets"][string]> = {};
  for (const budgetId of Object.keys(budgetRecord).sort()) {
    defineRecordKey(
      budgets,
      budgetId,
      cloneBudgetState(budgetRecord[budgetId], `${path}.budgets.${budgetId}`),
    );
  }

  return {
    initialized: requireBoolean(record.initialized, `${path}.initialized`),
    currentStrategyId: cloneNullableCanonicalString(
      record.currentStrategyId,
      `${path}.currentStrategyId`,
    ),
    currentQualityTier: cloneNullableFinite(
      record.currentQualityTier,
      `${path}.currentQualityTier`,
    ),
    modeSince: requireFinite(record.modeSince, `${path}.modeSince`),
    budgets,
    pendingStrategyId: cloneNullableCanonicalString(
      record.pendingStrategyId,
      `${path}.pendingStrategyId`,
    ),
    pendingStreak: requireSafeInteger(record.pendingStreak, `${path}.pendingStreak`, 0),
    lastSampleSequence: cloneNullableNonNegativeInteger(
      record.lastSampleSequence,
      `${path}.lastSampleSequence`,
    ),
  };
}

function cloneResourceSignal(value: unknown, path: string): ResourceSignal {
  const record = requireRecord(value, path);
  const name = requireCanonicalString(record.name, `${path}.name`);
  const unit = requireSignalUnit(record.unit, `${path}.unit`);
  const observedAt = requireFinite(record.observedAt, `${path}.observedAt`);
  const status = record.status;
  if (!isSignalStatus(status)) {
    fail(`${path}.status`, `must be one of ${SIGNAL_STATUSES.join(", ")}.`);
  }
  const details =
    record.details === undefined ? undefined : cloneJsonRecord(record.details, `${path}.details`);

  if (status === "ok") {
    const signalValue = requireFinite(record.value, `${path}.value`);
    const confidence =
      record.confidence === undefined
        ? undefined
        : requireFinite(record.confidence, `${path}.confidence`);
    if (confidence !== undefined && (confidence < 0 || confidence > 1)) {
      fail(`${path}.confidence`, "must be between 0 and 1.");
    }
    return {
      name,
      unit,
      status,
      value: signalValue,
      observedAt,
      ...(confidence === undefined ? {} : { confidence }),
      ...(details === undefined ? {} : { details }),
    };
  }

  const error =
    record.error === undefined ? undefined : requireString(record.error, `${path}.error`);
  return {
    name,
    unit,
    status,
    observedAt,
    ...(error === undefined ? {} : { error }),
    ...(details === undefined ? {} : { details }),
  };
}

function cloneSignalView(value: unknown, path: string): SignalView {
  const record = requireRecord(value, path);
  const status = record.status;
  if (status !== "missing" && !isSignalStatus(status)) {
    fail(`${path}.status`, `must be one of ${SIGNAL_STATUSES.join(", ")}, or "missing".`);
  }
  const unit =
    record.unit === undefined ? undefined : requireSignalUnit(record.unit, `${path}.unit`);
  const signalValue =
    record.value === undefined ? undefined : requireFinite(record.value, `${path}.value`);
  const observedAt =
    record.observedAt === undefined
      ? undefined
      : requireFinite(record.observedAt, `${path}.observedAt`);
  const ageMs =
    record.ageMs === undefined ? undefined : requireFinite(record.ageMs, `${path}.ageMs`);
  const detail =
    record.detail === undefined ? undefined : requireString(record.detail, `${path}.detail`);

  return {
    name: requireCanonicalString(record.name, `${path}.name`),
    ...(unit === undefined ? {} : { unit }),
    status,
    ...(signalValue === undefined ? {} : { value: signalValue }),
    ...(observedAt === undefined ? {} : { observedAt }),
    ...(ageMs === undefined ? {} : { ageMs }),
    ...(detail === undefined ? {} : { detail }),
  };
}

function cloneBudgetView(value: unknown, path: string): BudgetView {
  const record = requireRecord(value, path);
  const status = record.status;
  if (status !== "missing" && !isSignalStatus(status)) {
    fail(`${path}.status`, `must be one of ${SIGNAL_STATUSES.join(", ")}, or "missing".`);
  }
  const signalValue =
    record.value === undefined ? undefined : requireFinite(record.value, `${path}.value`);
  const ageMs =
    record.ageMs === undefined ? undefined : requireFinite(record.ageMs, `${path}.ageMs`);

  return {
    id: requireCanonicalString(record.id, `${path}.id`),
    signal: requireCanonicalString(record.signal, `${path}.signal`),
    engaged: requireBoolean(record.engaged, `${path}.engaged`),
    status,
    ...(signalValue === undefined ? {} : { value: signalValue }),
    ...(ageMs === undefined ? {} : { ageMs }),
    limit: requireFinite(record.limit, `${path}.limit`),
    recoverBelow: requireFinite(record.recoverBelow, `${path}.recoverBelow`),
    tierReduction: requireFinite(record.tierReduction, `${path}.tierReduction`),
  };
}

function cloneDecisionReason(value: unknown, path: string): DecisionReason {
  const record = requireRecord(value, path);
  const code = record.code;
  if (!isReasonCode(code)) {
    fail(`${path}.code`, "must be a known decision reason code.");
  }
  const detail =
    record.detail === undefined ? undefined : requireString(record.detail, `${path}.detail`);
  const details =
    record.details === undefined ? undefined : cloneJsonRecord(record.details, `${path}.details`);

  return {
    code,
    message: requireString(record.message, `${path}.message`),
    ...(detail === undefined ? {} : { detail }),
    ...(details === undefined ? {} : { details }),
  };
}

function cloneStrategy(value: unknown, path: string): StrategyCandidate {
  const record = requireRecord(value, path);
  const costTier =
    record.costTier === undefined ? undefined : requireFinite(record.costTier, `${path}.costTier`);
  const estimatedLatencyMs =
    record.estimatedLatencyMs === undefined
      ? undefined
      : cloneNullableNonNegativeFinite(record.estimatedLatencyMs, `${path}.estimatedLatencyMs`);
  const ewmaLatencyMs =
    record.ewmaLatencyMs === undefined
      ? undefined
      : cloneNullableNonNegativeFinite(record.ewmaLatencyMs, `${path}.ewmaLatencyMs`);
  const errorRate =
    record.errorRate === undefined
      ? undefined
      : cloneErrorRate(record.errorRate, `${path}.errorRate`);
  const samples =
    record.samples === undefined
      ? undefined
      : cloneNullableNonNegativeInteger(record.samples, `${path}.samples`);

  return {
    id: requireCanonicalString(record.id, `${path}.id`),
    qualityTier: requireFinite(record.qualityTier, `${path}.qualityTier`),
    ...(costTier === undefined ? {} : { costTier }),
    applicable: requireBoolean(record.applicable, `${path}.applicable`),
    ...(estimatedLatencyMs === undefined ? {} : { estimatedLatencyMs }),
    ...(ewmaLatencyMs === undefined ? {} : { ewmaLatencyMs }),
    ...(errorRate === undefined ? {} : { errorRate }),
    ...(samples === undefined ? {} : { samples }),
  };
}

function cloneStrategyDecision(value: unknown, path: string): StrategyDecision {
  const record = requireRecord(value, path);
  const kind = record.kind;
  if (!isDecisionKind(kind)) {
    fail(`${path}.kind`, `must be one of ${DECISION_KINDS.join(", ")}.`);
  }
  return {
    operationId: requireCanonicalString(record.operationId, `${path}.operationId`),
    strategyId: requireCanonicalString(record.strategyId, `${path}.strategyId`),
    qualityTier: requireFinite(record.qualityTier, `${path}.qualityTier`),
    previousStrategyId: cloneNullableCanonicalString(
      record.previousStrategyId,
      `${path}.previousStrategyId`,
    ),
    changed: requireBoolean(record.changed, `${path}.changed`),
    kind,
    decidedAt: requireFinite(record.decidedAt, `${path}.decidedAt`),
    modeSince: requireFinite(record.modeSince, `${path}.modeSince`),
    baseQualityTier: requireFinite(record.baseQualityTier, `${path}.baseQualityTier`),
    targetQualityTier: requireFinite(record.targetQualityTier, `${path}.targetQualityTier`),
    signals: requireArray(record.signals, `${path}.signals`).map((signal, index) =>
      cloneSignalView(signal, `${path}.signals[${index}]`),
    ),
    budgets: requireArray(record.budgets, `${path}.budgets`).map((budget, index) =>
      cloneBudgetView(budget, `${path}.budgets[${index}]`),
    ),
    reasons: requireArray(record.reasons, `${path}.reasons`).map((reason, index) =>
      cloneDecisionReason(reason, `${path}.reasons[${index}]`),
    ),
    sampleSequence: cloneNullableNonNegativeInteger(
      record.sampleSequence,
      `${path}.sampleSequence`,
    ),
    signalsCached: requireBoolean(record.signalsCached, `${path}.signalsCached`),
  };
}

function buildTraceEntry(
  source: Record<string, unknown>,
  path: string,
  sequence: number,
): PolicyTraceEntry {
  const label =
    source.label === undefined ? undefined : requireString(source.label, `${path}.label`);
  const strategies = requireArray(source.strategies, `${path}.strategies`).map((strategy, index) =>
    cloneStrategy(strategy, `${path}.strategies[${index}]`),
  );
  if (strategies.length === 0) {
    fail(`${path}.strategies`, "must not be empty.");
  }

  const entry: PolicyTraceEntry = {
    sequence,
    ...(label === undefined ? {} : { label }),
    now: requireNonNegativeFinite(source.now, `${path}.now`),
    stateBefore: clonePolicyState(source.stateBefore, `${path}.stateBefore`),
    decision: cloneStrategyDecision(source.decision, `${path}.decision`),
    stateAfter: clonePolicyState(source.stateAfter, `${path}.stateAfter`),
    signals: requireArray(source.signals, `${path}.signals`).map((signal, index) =>
      cloneResourceSignal(signal, `${path}.signals[${index}]`),
    ),
    strategies,
    pinnedStrategyId: cloneNullableCanonicalString(
      source.pinnedStrategyId,
      `${path}.pinnedStrategyId`,
    ),
    adaptationEnabled: requireBoolean(source.adaptationEnabled, `${path}.adaptationEnabled`),
    sampleSequence: cloneNullableNonNegativeInteger(
      source.sampleSequence,
      `${path}.sampleSequence`,
    ),
    signalsCached: requireBoolean(source.signalsCached, `${path}.signalsCached`),
  };
  return deepFreeze(entry);
}

function cloneRecordedEntry(
  input: RecordPolicyTraceEntryInput,
  sequence: number,
): PolicyTraceEntry {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("policy trace entry", "must be an object.");
  }
  return buildTraceEntry(
    input as unknown as Record<string, unknown>,
    "policy trace entry",
    sequence,
  );
}

function normalizeCaptureStrategies(value: unknown, path: string): readonly StrategyCandidate[] {
  const candidates = requireArray(value, path);
  if (candidates.length === 0) {
    fail(path, "must be a non-empty array.");
  }
  const seenIds = new Set<string>();
  return candidates.map((candidate, index) => {
    const candidatePath = `${path}[${index}]`;
    const record = requireRecord(candidate, candidatePath);
    const id = requireCanonicalString(record.id, `${candidatePath}.id`);
    if (seenIds.has(id)) {
      fail(path, `must not contain duplicate strategy id "${id}".`);
    }
    seenIds.add(id);
    const qualityTier = requireFinite(record.qualityTier, `${candidatePath}.qualityTier`);
    const applicable = record.applicable;
    if (applicable !== undefined && typeof applicable !== "boolean") {
      fail(`${candidatePath}.applicable`, "must be a boolean when present.");
    }
    const normalized: Record<string, unknown> = {
      id,
      qualityTier,
      applicable: applicable ?? true,
      samples: record.samples ?? null,
    };
    if (record.costTier !== undefined) {
      normalized.costTier = record.costTier;
    }
    if (record.estimatedLatencyMs !== undefined) {
      normalized.estimatedLatencyMs = record.estimatedLatencyMs;
    }
    if (record.ewmaLatencyMs !== undefined) {
      normalized.ewmaLatencyMs = record.ewmaLatencyMs;
    }
    if (record.errorRate !== undefined) {
      normalized.errorRate = record.errorRate;
    }
    return cloneStrategy(normalized, candidatePath);
  });
}

function normalizeCaptureStep(
  value: unknown,
  index: number,
  fallbackStrategies: readonly StrategyCandidate[],
  defaultAdaptationEnabled: boolean,
): NormalizedCaptureStep {
  const path = `steps[${index}]`;
  const record = requireRecord(value, path);
  const label =
    record.label === undefined ? undefined : requireString(record.label, `${path}.label`);
  const now =
    record.now === undefined
      ? index * DEFAULT_STEP_INTERVAL_MS
      : requireNonNegativeFinite(record.now, `${path}.now`);
  const pinnedStrategyId = cloneNullableCanonicalString(
    record.pinnedStrategyId ?? null,
    `${path}.pinnedStrategyId`,
  );
  const adaptationEnabled =
    record.adaptationEnabled === undefined
      ? defaultAdaptationEnabled
      : requireBoolean(record.adaptationEnabled, `${path}.adaptationEnabled`);
  const sampleSequence =
    record.sampleSequence === undefined
      ? null
      : cloneNullableNonNegativeInteger(record.sampleSequence, `${path}.sampleSequence`);
  const signalsCached =
    record.signalsCached === undefined
      ? false
      : requireBoolean(record.signalsCached, `${path}.signalsCached`);

  return {
    ...(label === undefined ? {} : { label }),
    now,
    signals: requireArray(record.signals, `${path}.signals`).map((signal, signalIndex) =>
      cloneResourceSignal(signal, `${path}.signals[${signalIndex}]`),
    ),
    strategies:
      record.strategies === undefined
        ? fallbackStrategies
        : normalizeCaptureStrategies(record.strategies, `${path}.strategies`),
    pinnedStrategyId,
    adaptationEnabled,
    sampleSequence,
    signalsCached,
  };
}

function deepFreeze<T>(value: T, seen: Set<object> = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  const record = value as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const child = record[key];
    if (child !== null && typeof child === "object") {
      deepFreeze(child, seen);
    }
  }
  return Object.freeze(value);
}

function structuralEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const leftArray = Array.isArray(left);
  const rightArray = Array.isArray(right);
  if (leftArray !== rightArray) {
    return false;
  }
  if (leftArray && rightArray) {
    if (left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index += 1) {
      if (!structuralEqual(left[index], right[index])) {
        return false;
      }
    }
    return true;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  if (leftKeys.length !== Object.keys(rightRecord).length) {
    return false;
  }
  for (const key of leftKeys) {
    if (!Object.hasOwn(rightRecord, key)) {
      return false;
    }
    if (!structuralEqual(leftRecord[key], rightRecord[key])) {
      return false;
    }
  }
  return true;
}

function countSwitches(trace: PolicyTrace): number {
  let switches = 0;
  for (const entry of trace.entries) {
    if (entry.decision.changed) {
      switches += 1;
    }
  }
  return switches;
}

function assertTraceShape(value: unknown, path: string): asserts value is PolicyTrace {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be a policy trace object.");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    fail(`${path}.version`, "must be 1.");
  }
  if (typeof record.operationId !== "string") {
    fail(`${path}.operationId`, "must be a string.");
  }
  if (!Array.isArray(record.entries)) {
    fail(`${path}.entries`, "must be an array.");
  }
}

function sortedCounts(counts: ReadonlyMap<string, number>): Readonly<Record<string, number>> {
  const record: Record<string, number> = {};
  for (const key of [...counts.keys()].sort()) {
    defineRecordKey(record, key, counts.get(key) ?? 0);
  }
  return record;
}

class PolicyTraceRecorderImpl implements PolicyTraceRecorder {
  readonly #operationId: string;
  readonly #maxEntries: number;
  readonly #clock: Clock;
  readonly #entries: PolicyTraceEntry[] = [];
  #nextSequence = 1;

  constructor(operationId: string, maxEntries: number, clock: Clock) {
    this.#operationId = operationId;
    this.#maxEntries = maxEntries;
    this.#clock = clock;
  }

  record(input: RecordPolicyTraceEntryInput): PolicyTraceEntry {
    const entry = cloneRecordedEntry(input, this.#nextSequence);
    this.#nextSequence += 1;
    this.#entries.push(entry);
    const overflow = this.#entries.length - this.#maxEntries;
    if (overflow > 0) {
      this.#entries.splice(0, overflow);
    }
    return entry;
  }

  getEntries(): readonly PolicyTraceEntry[] {
    return Object.freeze([...this.#entries]);
  }

  exportTrace(): PolicyTrace {
    const createdAt = this.#clock.now();
    if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) {
      fail("clock.now()", "must return a finite number.");
    }
    const trace: PolicyTrace = {
      version: 1,
      operationId: this.#operationId,
      createdAt,
      entries: this.getEntries(),
    };
    return deepFreeze(trace);
  }

  clear(): void {
    this.#entries.length = 0;
    this.#nextSequence = 1;
  }

  size(): number {
    return this.#entries.length;
  }
}

/**
 * Creates a bounded policy trace recorder. Recorded entries are deep-copied,
 * frozen, and JSON-safe; eviction drops the oldest entries while sequence
 * numbers continue to increase. `clear()` resets both entries and sequencing.
 */
export function createPolicyTraceRecorder(
  options: PolicyTraceRecorderOptions = {},
): PolicyTraceRecorder {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new ConfigurationError("createPolicyTraceRecorder options must be an object.");
  }
  const operationId =
    options.operationId === undefined
      ? DEFAULT_OPERATION_ID
      : requireCanonicalString(options.operationId, "operationId");
  const maxEntries =
    options.maxEntries === undefined
      ? DEFAULT_MAX_ENTRIES
      : requireSafeInteger(options.maxEntries, "maxEntries", 1);
  const clock = options.clock ?? systemClock;
  if (clock === null || typeof clock !== "object" || typeof clock.now !== "function") {
    throw new ConfigurationError("clock must provide a now() function.");
  }
  return new PolicyTraceRecorderImpl(operationId, maxEntries, clock);
}

/**
 * Replays every entry independently with `evaluatePolicy` using the recorded
 * `stateBefore` and inputs. Reports deterministic fields that changed, whether
 * the replayed next state structurally equals `stateAfter`, and an overall
 * determinism verdict. Pass the original policy to reproduce the trace; the
 * default policy is an empty operation policy.
 */
export function replayPolicyTrace(
  trace: PolicyTrace,
  options?: { readonly policy?: OperationPolicy },
): PolicyTraceReplayReport {
  assertTraceShape(trace, "trace");
  if (
    options !== undefined &&
    (options === null || typeof options !== "object" || Array.isArray(options))
  ) {
    throw new ConfigurationError("replayPolicyTrace options must be an object.");
  }
  const resolvedPolicy = resolvePolicy(options?.policy);

  const divergences: PolicyTraceReplayDivergence[] = [];
  let matchedEntries = 0;

  for (const entry of trace.entries) {
    const evaluation = evaluatePolicy(
      entry.stateBefore,
      {
        operationId: trace.operationId,
        now: entry.now,
        signals: entry.signals,
        strategies: entry.strategies,
        pinnedStrategyId: entry.pinnedStrategyId,
        adaptationEnabled: entry.adaptationEnabled,
        sampleSequence: entry.sampleSequence,
        signalsCached: entry.signalsCached,
      },
      resolvedPolicy,
    );

    const fields: DeterministicDecisionField[] = [];
    for (const field of DETERMINISTIC_DECISION_FIELDS) {
      if (entry.decision[field] !== evaluation.decision[field]) {
        fields.push(field);
      }
    }
    const stateMatched = structuralEqual(evaluation.state, entry.stateAfter);
    if (fields.length === 0 && stateMatched) {
      matchedEntries += 1;
      continue;
    }

    divergences.push(
      deepFreeze({
        sequence: entry.sequence,
        ...(entry.label === undefined ? {} : { label: entry.label }),
        expectedStrategyId: entry.decision.strategyId,
        actualStrategyId: evaluation.decision.strategyId,
        fields: Object.freeze(fields),
        stateMatched,
      }),
    );
  }

  const totalEntries = trace.entries.length;
  return deepFreeze({
    operationId: trace.operationId,
    totalEntries,
    matchedEntries,
    mismatchedEntries: totalEntries - matchedEntries,
    deterministic: matchedEntries === totalEntries,
    divergences: Object.freeze(divergences),
  });
}

/**
 * Compares two traces by entry index. A missing entry on either side counts as
 * a divergence at that index; missing sequences are reported as `-1` and
 * missing strategy ids as `"<missing>"`. Agreement is computed over the longer
 * trace length and is 1 when both traces are empty.
 */
export function diffPolicyTraces(baseline: PolicyTrace, candidate: PolicyTrace): PolicyTraceDiff {
  assertTraceShape(baseline, "baseline");
  assertTraceShape(candidate, "candidate");

  const comparedEntries = Math.max(baseline.entries.length, candidate.entries.length);
  const divergences: PolicyTraceDivergence[] = [];

  for (let index = 0; index < comparedEntries; index += 1) {
    const baselineEntry = baseline.entries[index];
    const candidateEntry = candidate.entries[index];
    if (
      baselineEntry !== undefined &&
      candidateEntry !== undefined &&
      baselineEntry.decision.strategyId === candidateEntry.decision.strategyId
    ) {
      continue;
    }
    const label = baselineEntry?.label ?? candidateEntry?.label;
    divergences.push(
      deepFreeze({
        index,
        baselineSequence: baselineEntry?.sequence ?? MISSING_SEQUENCE,
        candidateSequence: candidateEntry?.sequence ?? MISSING_SEQUENCE,
        ...(label === undefined ? {} : { label }),
        baselineStrategyId: baselineEntry?.decision.strategyId ?? MISSING_STRATEGY_ID,
        candidateStrategyId: candidateEntry?.decision.strategyId ?? MISSING_STRATEGY_ID,
      }),
    );
  }

  return deepFreeze({
    baselineOperationId: baseline.operationId,
    candidateOperationId: candidate.operationId,
    totalEntries: comparedEntries,
    comparedEntries,
    divergenceCount: divergences.length,
    agreementRatio:
      comparedEntries === 0 ? 1 : (comparedEntries - divergences.length) / comparedEntries,
    strategySwitchDelta: countSwitches(candidate) - countSwitches(baseline),
    divergences: Object.freeze(divergences),
  });
}

/**
 * Summarizes strategy and decision-kind counts, switches, reversals, cached
 * samples, and budget ids that transitioned to engaged. Count records use
 * code-unit sorted keys; an empty trace reports `firstAt` and `lastAt` as 0.
 */
export function summarizePolicyTrace(trace: PolicyTrace): PolicyTraceSummary {
  assertTraceShape(trace, "trace");

  const strategyCounts = new Map<string, number>();
  const kindCounts = new Map<string, number>();
  const engagedBudgetIds = new Set<string>();
  const initialEngaged = new Map<string, boolean>();
  for (const [budgetId, budget] of Object.entries(trace.entries[0]?.stateBefore.budgets ?? {})) {
    initialEngaged.set(budgetId, budget.engaged);
  }
  let previousEngaged = initialEngaged;
  let strategySwitches = 0;
  let strategyReversals = 0;
  let cachedSamples = 0;
  let lastSwitchFrom: string | null = null;
  let lastSwitchTo: string | null = null;

  for (const entry of trace.entries) {
    const strategyId = entry.decision.strategyId;
    strategyCounts.set(strategyId, (strategyCounts.get(strategyId) ?? 0) + 1);
    const kind = entry.decision.kind;
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);

    if (entry.signalsCached) {
      cachedSamples += 1;
    }

    if (entry.decision.changed) {
      strategySwitches += 1;
      const from = entry.decision.previousStrategyId;
      const to = entry.decision.strategyId;
      if (lastSwitchFrom !== null && from === lastSwitchTo && to === lastSwitchFrom) {
        strategyReversals += 1;
      }
      lastSwitchFrom = from;
      lastSwitchTo = to;
    }

    const currentEngaged = new Map<string, boolean>();
    for (const budget of entry.decision.budgets) {
      currentEngaged.set(budget.id, budget.engaged);
      if (budget.engaged && previousEngaged.get(budget.id) !== true) {
        engagedBudgetIds.add(budget.id);
      }
    }
    previousEngaged = currentEngaged;
  }

  const firstEntry = trace.entries[0];
  const lastEntry = trace.entries[trace.entries.length - 1];

  return deepFreeze({
    operationId: trace.operationId,
    entryCount: trace.entries.length,
    firstAt: firstEntry?.now ?? 0,
    lastAt: lastEntry?.now ?? 0,
    strategyCounts: sortedCounts(strategyCounts),
    kindCounts: sortedCounts(kindCounts),
    strategySwitches,
    strategyReversals,
    cachedSamples,
    engagedBudgetIds: Object.freeze([...engagedBudgetIds].sort()),
  });
}

/**
 * Validates and imports an untrusted trace value. Enforces version 1, a
 * canonical operation id, a finite `createdAt`, positive and strictly
 * increasing entry sequences, non-negative entry clocks, and complete state,
 * decision, signal, and strategy shapes. Returns a deeply frozen copy and
 * throws `ConfigurationError` for malformed input.
 */
export function importPolicyTrace(value: unknown): PolicyTrace {
  const record = requireRecord(value, "trace");
  if (record.version !== 1) {
    fail("trace.version", "must be 1.");
  }
  const operationId = requireCanonicalString(record.operationId, "trace.operationId");
  const createdAt = requireFinite(record.createdAt, "trace.createdAt");
  const rawEntries = requireArray(record.entries, "trace.entries");
  let previousSequence = 0;
  const entries = rawEntries.map((entryValue, index) => {
    const path = `trace.entries[${index}]`;
    const entryRecord = requireRecord(entryValue, path);
    const sequence = requireSafeInteger(entryRecord.sequence, `${path}.sequence`, 1);
    if (sequence <= previousSequence) {
      fail(`${path}.sequence`, "must be strictly greater than the previous sequence.");
    }
    previousSequence = sequence;
    return buildTraceEntry(entryRecord, path, sequence);
  });

  return deepFreeze({
    version: 1,
    operationId,
    createdAt,
    entries: Object.freeze(entries),
  });
}

/**
 * Evaluates a scripted timeline and captures every full input and output into a
 * frozen trace. Simulated strategies are normalized like the policy timeline
 * simulator: `applicable` defaults to true and `samples` defaults to null.
 * Step clocks default to `index * 1000`; the operation id defaults to
 * `"traced-operation"`; the initial state defaults to
 * `createInitialPolicyState()`. Pass the same policy to `replayPolicyTrace` to
 * verify the round trip.
 */
export function capturePolicyTrace(options: {
  readonly operationId?: string;
  readonly policy?: OperationPolicy;
  readonly strategies: readonly TraceSimulatedStrategy[];
  readonly initialState?: PolicyState;
  readonly steps: readonly TraceTimelineStep[];
  readonly clock?: Clock;
}): PolicyTrace {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new ConfigurationError("capturePolicyTrace options must be an object.");
  }
  const operationId =
    options.operationId === undefined
      ? DEFAULT_OPERATION_ID
      : requireCanonicalString(options.operationId, "operationId");
  const resolvedPolicy = resolvePolicy(options.policy);
  const strategies = normalizeCaptureStrategies(options.strategies, "strategies");
  const rawSteps = requireArray(options.steps, "steps");
  if (rawSteps.length === 0) {
    fail("steps", "must be a non-empty array.");
  }
  const steps = rawSteps.map((step, index) =>
    normalizeCaptureStep(step, index, strategies, resolvedPolicy.adaptationEnabled),
  );
  const initialState =
    options.initialState === undefined
      ? createInitialPolicyState()
      : clonePolicyState(options.initialState, "initialState");
  const recorder = createPolicyTraceRecorder({
    operationId,
    maxEntries: steps.length,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });

  let state = initialState;
  for (const step of steps) {
    const stateBefore = state;
    const evaluation = evaluatePolicy(
      stateBefore,
      {
        operationId,
        now: step.now,
        signals: step.signals,
        strategies: step.strategies,
        pinnedStrategyId: step.pinnedStrategyId,
        adaptationEnabled: step.adaptationEnabled,
        sampleSequence: step.sampleSequence,
        signalsCached: step.signalsCached,
      },
      resolvedPolicy,
    );
    state = evaluation.state;
    recorder.record({
      ...(step.label === undefined ? {} : { label: step.label }),
      now: step.now,
      stateBefore,
      decision: evaluation.decision,
      stateAfter: evaluation.state,
      signals: step.signals,
      strategies: step.strategies,
      pinnedStrategyId: step.pinnedStrategyId,
      adaptationEnabled: step.adaptationEnabled,
      sampleSequence: step.sampleSequence,
      signalsCached: step.signalsCached,
    });
  }

  return recorder.exportTrace();
}
