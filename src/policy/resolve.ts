import { ConfigurationError } from "../errors/index.js";
import type {
  BudgetRule,
  CustomPolicySelector,
  Policy,
  ResolvedBudgetRule,
  ResolvedPolicy,
} from "../types/policy.js";

const DEFAULT_EVALUATION_INTERVAL_MS = 1000;
const DEFAULT_MAX_SIGNAL_AGE_MS = 5000;
const DEFAULT_CONSECUTIVE_SAMPLES = 2;

function requireFinite(value: number, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigurationError(`${name} must be a finite number.`);
  }
  return value;
}

function requireNonNegative(value: number, name: string): number {
  requireFinite(value, name);
  if (value < 0) {
    throw new ConfigurationError(`${name} must be greater than or equal to 0.`);
  }
  return value;
}

function requirePositiveInteger(value: number, name: string): number {
  requireFinite(value, name);
  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigurationError(`${name} must be a positive integer.`);
  }
  return value;
}

function requireNonEmptyString(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigurationError(`${name} must be a non-empty string.`);
  }
  return value;
}

function requireCanonicalIdentifier(value: string, name: string): string {
  const identifier = requireNonEmptyString(value, name);
  if (identifier !== identifier.trim()) {
    throw new ConfigurationError(`${name} must not have leading or trailing whitespace.`);
  }
  return identifier;
}

function requirePositiveSafeInteger(value: number, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ConfigurationError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function resolveBudget(
  rule: BudgetRule,
  index: number,
  defaultSamples: number,
): ResolvedBudgetRule {
  if (rule === null || typeof rule !== "object") {
    throw new ConfigurationError(`budgets[${index}] must be an object.`);
  }
  const id = requireCanonicalIdentifier(rule.id, `budgets[${index}].id`);
  const signal = requireCanonicalIdentifier(rule.signal, `budgets[${index}].signal`);
  const limit = requireFinite(rule.limit, `budgets[${index}].limit`);
  const recoverBelow =
    rule.recoverBelow === undefined
      ? limit
      : requireFinite(rule.recoverBelow, `budgets[${index}].recoverBelow`);
  if (recoverBelow > limit) {
    throw new ConfigurationError(
      `budgets[${index}].recoverBelow (${recoverBelow}) must be less than or equal to limit (${limit}).`,
    );
  }
  const tierReduction =
    rule.tierReduction === undefined
      ? 1
      : requirePositiveInteger(rule.tierReduction, `budgets[${index}].tierReduction`);
  const consecutiveSamples =
    rule.consecutiveSamples === undefined
      ? defaultSamples
      : requirePositiveInteger(rule.consecutiveSamples, `budgets[${index}].consecutiveSamples`);

  return { id, signal, limit, recoverBelow, tierReduction, consecutiveSamples };
}

/**
 * Applies defaults and validates policy input. Throws ConfigurationError for
 * invalid or contradictory settings.
 */
export function resolvePolicy(input: Policy | undefined): ResolvedPolicy {
  if (
    input !== undefined &&
    (input === null || typeof input !== "object" || Array.isArray(input))
  ) {
    throw new ConfigurationError("policy must be an object.");
  }
  const policy = input ?? {};
  if (policy.budgets !== undefined && !Array.isArray(policy.budgets)) {
    throw new ConfigurationError("policy.budgets must be an array.");
  }
  const evaluationIntervalMs = requireNonNegative(
    policy.evaluationIntervalMs ?? DEFAULT_EVALUATION_INTERVAL_MS,
    "policy.evaluationIntervalMs",
  );
  const maxSignalAgeMs = requireNonNegative(
    policy.maxSignalAgeMs ?? DEFAULT_MAX_SIGNAL_AGE_MS,
    "policy.maxSignalAgeMs",
  );
  if (maxSignalAgeMs === 0) {
    throw new ConfigurationError("policy.maxSignalAgeMs must be greater than 0.");
  }
  const minimumModeDurationMs = requireNonNegative(
    policy.minimumModeDurationMs ?? 0,
    "policy.minimumModeDurationMs",
  );
  const consecutiveSamples = requirePositiveInteger(
    policy.consecutiveSamples ?? DEFAULT_CONSECUTIVE_SAMPLES,
    "policy.consecutiveSamples",
  );

  const minQualityTier =
    policy.minQualityTier === undefined
      ? undefined
      : requireFinite(policy.minQualityTier, "policy.minQualityTier");
  const maxQualityTier =
    policy.maxQualityTier === undefined
      ? undefined
      : requireFinite(policy.maxQualityTier, "policy.maxQualityTier");
  if (
    minQualityTier !== undefined &&
    maxQualityTier !== undefined &&
    minQualityTier > maxQualityTier
  ) {
    throw new ConfigurationError(
      `policy.minQualityTier (${minQualityTier}) must not exceed policy.maxQualityTier (${maxQualityTier}).`,
    );
  }

  const missingSignalBehavior = policy.missingSignalBehavior ?? "hold";
  if (!["hold", "fallback", "error", "ignore"].includes(missingSignalBehavior)) {
    throw new ConfigurationError(
      `policy.missingSignalBehavior must be one of "hold", "fallback", "error", or "ignore".`,
    );
  }

  const fallbackStrategyId =
    policy.fallbackStrategyId === undefined
      ? undefined
      : requireCanonicalIdentifier(policy.fallbackStrategyId, "policy.fallbackStrategyId");
  if (missingSignalBehavior === "fallback" && fallbackStrategyId === undefined) {
    throw new ConfigurationError(
      'policy.missingSignalBehavior is "fallback" but policy.fallbackStrategyId is not set.',
    );
  }

  const qualityCheck = policy.qualityCheck ?? "report";
  if (qualityCheck !== "report" && qualityCheck !== "error") {
    throw new ConfigurationError('policy.qualityCheck must be "report" or "error".');
  }

  const adaptationEnabled = policy.adaptationEnabled ?? true;
  if (typeof adaptationEnabled !== "boolean") {
    throw new ConfigurationError("policy.adaptationEnabled must be a boolean.");
  }

  const maxTrackedOperations =
    policy.maxTrackedOperations === undefined || policy.maxTrackedOperations === null
      ? null
      : requirePositiveSafeInteger(policy.maxTrackedOperations, "policy.maxTrackedOperations");

  let customSelector: CustomPolicySelector | null = null;
  if (policy.customSelector !== undefined) {
    if (typeof policy.customSelector !== "function") {
      throw new ConfigurationError("customSelector must be a function");
    }
    customSelector = policy.customSelector;
  }

  const seenBudgetIds = new Set<string>();
  const budgets: ResolvedBudgetRule[] = [];
  for (const [index, rule] of (policy.budgets ?? []).entries()) {
    const resolved = resolveBudget(rule, index, consecutiveSamples);
    if (seenBudgetIds.has(resolved.id)) {
      throw new ConfigurationError(`Duplicate budget id "${resolved.id}".`);
    }
    seenBudgetIds.add(resolved.id);
    budgets.push(Object.freeze(resolved));
  }

  return Object.freeze({
    evaluationIntervalMs,
    maxSignalAgeMs,
    minimumModeDurationMs,
    consecutiveSamples,
    minQualityTier,
    maxQualityTier,
    fallbackStrategyId,
    missingSignalBehavior,
    adaptationEnabled,
    qualityCheck,
    budgets: Object.freeze(budgets),
    maxTrackedOperations,
    customSelector,
  });
}

/**
 * Merges a partial operation policy override onto a base resolved policy and
 * validates all constraints. Throws ConfigurationError if the override is invalid.
 */
export function resolveOperationPolicy(
  base: ResolvedPolicy,
  override: Partial<Policy>,
): ResolvedPolicy {
  if (override === null || typeof override !== "object" || Array.isArray(override)) {
    throw new ConfigurationError("policy override must be an object.");
  }
  const merged: Policy = {
    evaluationIntervalMs: override.evaluationIntervalMs ?? base.evaluationIntervalMs,
    maxSignalAgeMs: override.maxSignalAgeMs ?? base.maxSignalAgeMs,
    minimumModeDurationMs: override.minimumModeDurationMs ?? base.minimumModeDurationMs,
    consecutiveSamples: override.consecutiveSamples ?? base.consecutiveSamples,
    minQualityTier:
      override.minQualityTier !== undefined ? override.minQualityTier : base.minQualityTier,
    maxQualityTier:
      override.maxQualityTier !== undefined ? override.maxQualityTier : base.maxQualityTier,
    fallbackStrategyId:
      override.fallbackStrategyId !== undefined
        ? override.fallbackStrategyId
        : base.fallbackStrategyId,
    missingSignalBehavior: override.missingSignalBehavior ?? base.missingSignalBehavior,
    adaptationEnabled: override.adaptationEnabled ?? base.adaptationEnabled,
    qualityCheck: override.qualityCheck ?? base.qualityCheck,
    budgets: override.budgets !== undefined ? override.budgets : base.budgets,
    maxTrackedOperations:
      override.maxTrackedOperations !== undefined
        ? override.maxTrackedOperations
        : base.maxTrackedOperations,
    customSelector:
      override.customSelector !== undefined
        ? override.customSelector
        : (base.customSelector ?? undefined),
  };
  return resolvePolicy(merged);
}
