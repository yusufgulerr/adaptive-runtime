import { ConfigurationError } from "../errors/index.js";
import type { PolicyState } from "../policy/engine.js";
import type {
  BudgetView,
  DecisionKind,
  DecisionReason,
  DecisionReasonCode,
  SignalView,
  StrategyDecision,
} from "../types/decision.js";
import type { RuntimeStats, StrategyStats } from "../types/run.js";
import type { SignalStatus, SignalUnit } from "../types/signals.js";
import type { OperationRuntimeState, RuntimeStateSnapshot } from "../types/state.js";
import { validateOperationId, validateStrategyId } from "./validate.js";

const DECISION_KINDS: readonly DecisionKind[] = [
  "initial",
  "adapted",
  "retained",
  "pinned",
  "fallback",
  "static",
];

const REASON_CODES: readonly DecisionReasonCode[] = [
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

const SIGNAL_UNITS: readonly SignalUnit[] = ["bytes", "milliseconds", "ratio", "count", "custom"];
const SIGNAL_STATUSES: readonly SignalStatus[] = ["ok", "unknown", "unsupported", "stale", "error"];

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): UnknownRecord {
  if (!isRecord(value)) {
    throw new ConfigurationError(`${label} must be an object.`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new ConfigurationError(`${label} must be a boolean.`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigurationError(`${label} must be a finite number.`);
  }
  return value;
}

function requireNonNegativeNumber(value: unknown, label: string): number {
  const number = requireFiniteNumber(value, label);
  if (number < 0) {
    throw new ConfigurationError(`${label} must be greater than or equal to 0.`);
  }
  return number;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  const number = requireNonNegativeNumber(value, label);
  if (!Number.isInteger(number)) {
    throw new ConfigurationError(`${label} must be an integer.`);
  }
  return number;
}

function requireOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ConfigurationError(`${label} must be a string.`);
  }
  return value;
}

function requireCanonicalIdentifier(value: unknown, label: string): string {
  const identifier = validateOperationId(value, label);
  if (identifier !== value) {
    throw new ConfigurationError(`${label} must not have leading or trailing whitespace.`);
  }
  return identifier;
}

function requireNullableStrategyIdentifier(value: unknown, label: string): string | null {
  return value === null ? null : validateStrategyId(value, label);
}

/**
 * Clones JSON-compatible data and rejects values that would not survive a
 * JSON round trip. Object keys are defined rather than assigned so keys such as
 * "__proto__" cannot alter the prototype of the imported state.
 */
function cloneJsonValue(value: unknown, label: string, depth = 0): unknown {
  if (depth > 32) {
    throw new ConfigurationError(`${label} must not be nested more than 32 levels.`);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ConfigurationError(`${label} must not contain non-finite numbers.`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return Array.from(value, (item, index) =>
      item === undefined ? null : cloneJsonValue(item, `${label}[${index}]`, depth + 1),
    );
  }
  if (isRecord(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ConfigurationError(`${label} must contain only plain JSON objects.`);
    }
    const result: UnknownRecord = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) {
        continue;
      }
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: cloneJsonValue(item, `${label}.${key}`, depth + 1),
        writable: true,
      });
    }
    return result;
  }
  throw new ConfigurationError(`${label} must contain only JSON-compatible values.`);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  for (const item of Object.values(value)) {
    deepFreeze(item);
  }
  return Object.freeze(value);
}

function validatePolicyState(value: unknown, label: string): PolicyState {
  const state = requireRecord(value, label);
  const initialized = requireBoolean(state.initialized, `${label}.initialized`);
  const currentStrategyId = requireNullableStrategyIdentifier(
    state.currentStrategyId,
    `${label}.currentStrategyId`,
  );
  const currentQualityTier =
    state.currentQualityTier === null
      ? null
      : requireFiniteNumber(state.currentQualityTier, `${label}.currentQualityTier`);
  if ((currentStrategyId === null) !== (currentQualityTier === null)) {
    throw new ConfigurationError(
      `${label}.currentStrategyId and ${label}.currentQualityTier must both be null or both be set.`,
    );
  }
  if (initialized && currentStrategyId === null) {
    throw new ConfigurationError(`${label} is initialized but has no current strategy.`);
  }
  if (!initialized && currentStrategyId !== null) {
    throw new ConfigurationError(`${label} is not initialized but has a current strategy.`);
  }
  const modeSince = requireNonNegativeNumber(state.modeSince, `${label}.modeSince`);

  const rawBudgets = requireRecord(state.budgets, `${label}.budgets`);
  const budgets: Record<string, { engaged: boolean; aboveStreak: number; belowStreak: number }> =
    {};
  for (const [budgetId, rawBudget] of Object.entries(rawBudgets)) {
    const canonicalBudgetId = requireCanonicalIdentifier(budgetId, `${label}.budgets key`);
    const budget = requireRecord(rawBudget, `${label}.budgets.${canonicalBudgetId}`);
    const validated = {
      engaged: requireBoolean(budget.engaged, `${label}.budgets.${canonicalBudgetId}.engaged`),
      aboveStreak: requireNonNegativeInteger(
        budget.aboveStreak,
        `${label}.budgets.${canonicalBudgetId}.aboveStreak`,
      ),
      belowStreak: requireNonNegativeInteger(
        budget.belowStreak,
        `${label}.budgets.${canonicalBudgetId}.belowStreak`,
      ),
    };
    Object.defineProperty(budgets, canonicalBudgetId, {
      configurable: true,
      enumerable: true,
      value: validated,
      writable: true,
    });
  }

  const pendingStrategyId = requireNullableStrategyIdentifier(
    state.pendingStrategyId,
    `${label}.pendingStrategyId`,
  );
  const pendingStreak = requireNonNegativeInteger(state.pendingStreak, `${label}.pendingStreak`);
  if (pendingStrategyId === null && pendingStreak !== 0) {
    throw new ConfigurationError(`${label}.pendingStreak must be 0 when no strategy is pending.`);
  }
  const lastSampleSequence =
    state.lastSampleSequence === null
      ? null
      : requireNonNegativeInteger(state.lastSampleSequence, `${label}.lastSampleSequence`);

  return {
    initialized,
    currentStrategyId,
    currentQualityTier,
    modeSince,
    budgets,
    pendingStrategyId,
    pendingStreak,
    lastSampleSequence,
  };
}

function validateSignalView(value: unknown, label: string): SignalView {
  const view = requireRecord(value, label);
  const name = requireCanonicalIdentifier(view.name, `${label}.name`);
  const unit =
    view.unit === undefined
      ? undefined
      : SIGNAL_UNITS.includes(view.unit as SignalUnit)
        ? (view.unit as SignalUnit)
        : (() => {
            throw new ConfigurationError(`${label}.unit is not a supported signal unit.`);
          })();
  const status = view.status;
  if (status !== "missing" && !SIGNAL_STATUSES.includes(status as SignalStatus)) {
    throw new ConfigurationError(`${label}.status is not a valid signal status.`);
  }
  const signalStatus = status as SignalStatus | "missing";
  const readingValue =
    view.value === undefined ? undefined : requireFiniteNumber(view.value, `${label}.value`);
  if (signalStatus === "ok" && readingValue === undefined) {
    throw new ConfigurationError(`${label}.value is required when status is "ok".`);
  }
  const observedAt =
    view.observedAt === undefined
      ? undefined
      : requireNonNegativeNumber(view.observedAt, `${label}.observedAt`);
  const ageMs =
    view.ageMs === undefined ? undefined : requireNonNegativeNumber(view.ageMs, `${label}.ageMs`);
  const detail = requireOptionalString(view.detail, `${label}.detail`);
  return {
    name,
    ...(unit === undefined ? {} : { unit }),
    status: signalStatus,
    ...(readingValue === undefined ? {} : { value: readingValue }),
    ...(observedAt === undefined ? {} : { observedAt }),
    ...(ageMs === undefined ? {} : { ageMs }),
    ...(detail === undefined ? {} : { detail }),
  };
}

function validateBudgetView(value: unknown, label: string): BudgetView {
  const view = requireRecord(value, label);
  const id = requireCanonicalIdentifier(view.id, `${label}.id`);
  const signal = requireCanonicalIdentifier(view.signal, `${label}.signal`);
  const status = view.status;
  if (status !== "missing" && !SIGNAL_STATUSES.includes(status as SignalStatus)) {
    throw new ConfigurationError(`${label}.status is not a valid signal status.`);
  }
  const budgetStatus = status as SignalStatus | "missing";
  const readingValue =
    view.value === undefined ? undefined : requireFiniteNumber(view.value, `${label}.value`);
  if (budgetStatus === "ok" && readingValue === undefined) {
    throw new ConfigurationError(`${label}.value is required when status is "ok".`);
  }
  const ageMs =
    view.ageMs === undefined ? undefined : requireNonNegativeNumber(view.ageMs, `${label}.ageMs`);
  return {
    id,
    signal,
    engaged: requireBoolean(view.engaged, `${label}.engaged`),
    status: budgetStatus,
    ...(readingValue === undefined ? {} : { value: readingValue }),
    ...(ageMs === undefined ? {} : { ageMs }),
    limit: requireFiniteNumber(view.limit, `${label}.limit`),
    recoverBelow: requireFiniteNumber(view.recoverBelow, `${label}.recoverBelow`),
    tierReduction: requireFiniteNumber(view.tierReduction, `${label}.tierReduction`),
  };
}

function validateReason(value: unknown, label: string): DecisionReason {
  const reason = requireRecord(value, label);
  if (!REASON_CODES.includes(reason.code as DecisionReasonCode)) {
    throw new ConfigurationError(`${label}.code is not a recognized decision reason code.`);
  }
  if (typeof reason.message !== "string") {
    throw new ConfigurationError(`${label}.message must be a string.`);
  }
  const detail = requireOptionalString(reason.detail, `${label}.detail`);
  let details: Readonly<Record<string, unknown>> | undefined;
  if (reason.details !== undefined) {
    const cloned = cloneJsonValue(reason.details, `${label}.details`);
    if (!isRecord(cloned)) {
      throw new ConfigurationError(`${label}.details must be a plain JSON object.`);
    }
    details = cloned as Readonly<Record<string, unknown>>;
  }
  return {
    code: reason.code as DecisionReasonCode,
    message: reason.message,
    ...(detail === undefined ? {} : { detail }),
    ...(details === undefined ? {} : { details }),
  };
}

function validateDecision(value: unknown, operationId: string, label: string): StrategyDecision {
  const decision = requireRecord(value, label);
  const decisionOperationId = requireCanonicalIdentifier(
    decision.operationId,
    `${label}.operationId`,
  );
  if (decisionOperationId !== operationId) {
    throw new ConfigurationError(`${label}.operationId must match its operation snapshot.`);
  }
  if (!DECISION_KINDS.includes(decision.kind as DecisionKind)) {
    throw new ConfigurationError(`${label}.kind is not a valid decision kind.`);
  }
  if (!Array.isArray(decision.signals)) {
    throw new ConfigurationError(`${label}.signals must be an array.`);
  }
  if (!Array.isArray(decision.budgets)) {
    throw new ConfigurationError(`${label}.budgets must be an array.`);
  }
  if (!Array.isArray(decision.reasons)) {
    throw new ConfigurationError(`${label}.reasons must be an array.`);
  }
  const sampleSequence =
    decision.sampleSequence === null
      ? null
      : requireNonNegativeInteger(decision.sampleSequence, `${label}.sampleSequence`);
  return {
    operationId: decisionOperationId,
    strategyId: validateStrategyId(decision.strategyId, `${label}.strategyId`),
    qualityTier: requireFiniteNumber(decision.qualityTier, `${label}.qualityTier`),
    previousStrategyId: requireNullableStrategyIdentifier(
      decision.previousStrategyId,
      `${label}.previousStrategyId`,
    ),
    changed: requireBoolean(decision.changed, `${label}.changed`),
    kind: decision.kind as DecisionKind,
    decidedAt: requireNonNegativeNumber(decision.decidedAt, `${label}.decidedAt`),
    modeSince: requireNonNegativeNumber(decision.modeSince, `${label}.modeSince`),
    baseQualityTier: requireFiniteNumber(decision.baseQualityTier, `${label}.baseQualityTier`),
    targetQualityTier: requireFiniteNumber(
      decision.targetQualityTier,
      `${label}.targetQualityTier`,
    ),
    signals: decision.signals.map((signal, index) =>
      validateSignalView(signal, `${label}.signals[${index}]`),
    ),
    budgets: decision.budgets.map((budget, index) =>
      validateBudgetView(budget, `${label}.budgets[${index}]`),
    ),
    reasons: decision.reasons.map((reason, index) =>
      validateReason(reason, `${label}.reasons[${index}]`),
    ),
    sampleSequence,
    signalsCached: requireBoolean(decision.signalsCached, `${label}.signalsCached`),
  };
}

function validateStrategyStats(
  value: unknown,
  label: string,
  operationRuns: number,
): StrategyStats {
  const stats = requireRecord(value, label);
  const runs = requireNonNegativeInteger(stats.runs, `${label}.runs`);
  const successes = requireNonNegativeInteger(stats.successes, `${label}.successes`);
  const failures = requireNonNegativeInteger(stats.failures, `${label}.failures`);
  if (runs > operationRuns) {
    throw new ConfigurationError(`${label}.runs must not exceed the operation run count.`);
  }
  if (successes + failures > runs) {
    throw new ConfigurationError(`${label}.successes + failures must not exceed runs.`);
  }
  const durationSamples = requireNonNegativeInteger(
    stats.durationSamples,
    `${label}.durationSamples`,
  );
  if (durationSamples > runs) {
    throw new ConfigurationError(`${label}.durationSamples must not exceed runs.`);
  }
  const lastDurationMs =
    stats.lastDurationMs === null
      ? null
      : requireNonNegativeNumber(stats.lastDurationMs, `${label}.lastDurationMs`);
  const averageDurationMs =
    stats.averageDurationMs === null
      ? null
      : requireNonNegativeNumber(stats.averageDurationMs, `${label}.averageDurationMs`);
  const ewmaDurationMs =
    stats.ewmaDurationMs === null
      ? null
      : requireNonNegativeNumber(stats.ewmaDurationMs, `${label}.ewmaDurationMs`);
  if (durationSamples === 0) {
    if (lastDurationMs !== null || averageDurationMs !== null || ewmaDurationMs !== null) {
      throw new ConfigurationError(`${label} must not report durations when durationSamples is 0.`);
    }
  } else if (lastDurationMs === null || averageDurationMs === null || ewmaDurationMs === null) {
    throw new ConfigurationError(
      `${label} must report durations when durationSamples is positive.`,
    );
  }
  const errorRate = requireNonNegativeNumber(stats.errorRate, `${label}.errorRate`);
  if (errorRate > 1) {
    throw new ConfigurationError(`${label}.errorRate must be between 0 and 1.`);
  }
  const totalDurationMs =
    stats.totalDurationMs === undefined
      ? undefined
      : requireNonNegativeNumber(stats.totalDurationMs, `${label}.totalDurationMs`);
  if (durationSamples === 0 && totalDurationMs !== undefined && totalDurationMs !== 0) {
    throw new ConfigurationError(`${label}.totalDurationMs must be 0 when durationSamples is 0.`);
  }
  return {
    runs,
    successes,
    failures,
    lastDurationMs,
    averageDurationMs,
    ...(totalDurationMs === undefined ? {} : { totalDurationMs }),
    ewmaDurationMs,
    durationSamples,
    errorRate,
  };
}

function validateStats(value: unknown, operationId: string, label: string): RuntimeStats {
  const stats = requireRecord(value, label);
  const statsOperationId = requireCanonicalIdentifier(stats.operationId, `${label}.operationId`);
  if (statsOperationId !== operationId) {
    throw new ConfigurationError(`${label}.operationId must match its operation snapshot.`);
  }
  const runs = requireNonNegativeInteger(stats.runs, `${label}.runs`);
  const successes = requireNonNegativeInteger(stats.successes, `${label}.successes`);
  const failures = requireNonNegativeInteger(stats.failures, `${label}.failures`);
  if (successes + failures > runs) {
    throw new ConfigurationError(`${label}.successes + failures must not exceed runs.`);
  }
  const durationSamples = requireNonNegativeInteger(
    stats.durationSamples,
    `${label}.durationSamples`,
  );
  if (durationSamples > runs) {
    throw new ConfigurationError(`${label}.durationSamples must not exceed runs.`);
  }
  const lastDurationMs =
    stats.lastDurationMs === null
      ? null
      : requireNonNegativeNumber(stats.lastDurationMs, `${label}.lastDurationMs`);
  const averageDurationMs =
    stats.averageDurationMs === null
      ? null
      : requireNonNegativeNumber(stats.averageDurationMs, `${label}.averageDurationMs`);
  const ewmaDurationMs =
    stats.ewmaDurationMs === null
      ? null
      : requireNonNegativeNumber(stats.ewmaDurationMs, `${label}.ewmaDurationMs`);
  if (durationSamples === 0) {
    if (lastDurationMs !== null || averageDurationMs !== null || ewmaDurationMs !== null) {
      throw new ConfigurationError(`${label} must not report durations when durationSamples is 0.`);
    }
  } else if (lastDurationMs === null || averageDurationMs === null || ewmaDurationMs === null) {
    throw new ConfigurationError(
      `${label} must report durations when durationSamples is positive.`,
    );
  }
  const errorRate = requireNonNegativeNumber(stats.errorRate, `${label}.errorRate`);
  if (errorRate > 1) {
    throw new ConfigurationError(`${label}.errorRate must be between 0 and 1.`);
  }
  const totalDurationMs =
    stats.totalDurationMs === undefined
      ? undefined
      : requireNonNegativeNumber(stats.totalDurationMs, `${label}.totalDurationMs`);
  if (durationSamples === 0 && totalDurationMs !== undefined && totalDurationMs !== 0) {
    throw new ConfigurationError(`${label}.totalDurationMs must be 0 when durationSamples is 0.`);
  }
  const rawStrategyRuns = requireRecord(stats.strategyRuns, `${label}.strategyRuns`);
  const strategyRuns: Record<string, number> = {};
  let totalStrategyRuns = 0;
  for (const [strategyId, count] of Object.entries(rawStrategyRuns)) {
    const canonicalStrategyId = requireCanonicalIdentifier(strategyId, `${label}.strategyRuns key`);
    const strategyRunCount = requireNonNegativeInteger(
      count,
      `${label}.strategyRuns.${canonicalStrategyId}`,
    );
    if (strategyRunCount > runs) {
      throw new ConfigurationError(
        `${label}.strategyRuns.${canonicalStrategyId} must not exceed the operation run count.`,
      );
    }
    totalStrategyRuns += strategyRunCount;
    Object.defineProperty(strategyRuns, canonicalStrategyId, {
      configurable: true,
      enumerable: true,
      value: strategyRunCount,
      writable: true,
    });
  }
  if (totalStrategyRuns > runs) {
    throw new ConfigurationError(
      `${label}.strategyRuns must not total more than the operation run count.`,
    );
  }
  const rawStrategies = requireRecord(stats.strategies, `${label}.strategies`);
  const strategies: Record<string, StrategyStats> = {};
  for (const [strategyId, strategyStats] of Object.entries(rawStrategies)) {
    const canonicalStrategyId = requireCanonicalIdentifier(strategyId, `${label}.strategies key`);
    Object.defineProperty(strategies, canonicalStrategyId, {
      configurable: true,
      enumerable: true,
      value: validateStrategyStats(
        strategyStats,
        `${label}.strategies.${canonicalStrategyId}`,
        runs,
      ),
      writable: true,
    });
  }
  for (const [strategyId, strategyRunCount] of Object.entries(strategyRuns)) {
    if (!Object.hasOwn(strategies, strategyId)) {
      throw new ConfigurationError(
        `${label}.strategies must contain strategy "${strategyId}" from strategyRuns.`,
      );
    }
    if (strategies[strategyId]?.runs !== strategyRunCount) {
      throw new ConfigurationError(
        `${label}.strategies.${strategyId}.runs must match strategyRuns.`,
      );
    }
  }
  for (const strategyId of Object.keys(strategies)) {
    if (!Object.hasOwn(strategyRuns, strategyId)) {
      throw new ConfigurationError(
        `${label}.strategyRuns must contain strategy "${strategyId}" from strategies.`,
      );
    }
  }
  return {
    operationId: statsOperationId,
    runs,
    successes,
    failures,
    lastDurationMs,
    averageDurationMs,
    ...(totalDurationMs === undefined ? {} : { totalDurationMs }),
    ewmaDurationMs,
    durationSamples,
    errorRate,
    strategyRuns,
    strategies,
  };
}

function validateOperationState(
  value: unknown,
  index: number,
  seenOperationIds: Set<string>,
): { operationId: string; state: OperationRuntimeState } {
  const entry = requireRecord(value, `operations[${index}]`);
  const operationId = requireCanonicalIdentifier(
    entry.operationId,
    `operations[${index}].operationId`,
  );
  if (seenOperationIds.has(operationId)) {
    throw new ConfigurationError(`Duplicate operationId "${operationId}" in state snapshot.`);
  }
  seenOperationIds.add(operationId);
  const state = requireRecord(entry.state, `operations[${index}].state`);
  const adaptationEnabled =
    state.adaptationEnabled === null
      ? null
      : requireBoolean(state.adaptationEnabled, `operations[${index}].state.adaptationEnabled`);
  return {
    operationId,
    state: {
      policyState: validatePolicyState(state.policyState, `operations[${index}].state.policyState`),
      decision:
        state.decision === null
          ? null
          : validateDecision(state.decision, operationId, `operations[${index}].state.decision`),
      pinnedStrategyId: requireNullableStrategyIdentifier(
        state.pinnedStrategyId,
        `operations[${index}].state.pinnedStrategyId`,
      ),
      adaptationEnabled,
      stats: validateStats(state.stats, operationId, `operations[${index}].state.stats`),
    },
  };
}

/**
 * Validates and deeply clones a runtime state snapshot. The returned value is
 * frozen and safe to retain independently of the caller's object.
 */
export function validateRuntimeStateSnapshot(input: unknown): RuntimeStateSnapshot {
  if (!isRecord(input)) {
    throw new ConfigurationError("state snapshot must be an object.");
  }
  if (input.version !== 1) {
    throw new ConfigurationError(
      `state snapshot version must be 1 (received ${String(input.version)}).`,
    );
  }
  const exportedAt = requireNonNegativeNumber(input.exportedAt, "state snapshot exportedAt");
  if (!Array.isArray(input.operations)) {
    throw new ConfigurationError("state snapshot operations must be an array.");
  }
  const seenOperationIds = new Set<string>();
  const operations = input.operations.map((entry, index) =>
    validateOperationState(entry, index, seenOperationIds),
  );
  return deepFreeze({
    version: 1 as const,
    exportedAt,
    operations,
  });
}
