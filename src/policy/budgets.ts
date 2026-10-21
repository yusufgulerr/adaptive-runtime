import type { BudgetView, SignalView } from "../types/decision.js";
import type { ResolvedBudgetRule, ResolvedPolicy } from "../types/policy.js";
import type { ResourceSignal, SignalStatus } from "../types/signals.js";

/** Hysteresis counters for one budget rule. */
export interface BudgetState {
  readonly engaged: boolean;
  readonly aboveStreak: number;
  readonly belowStreak: number;
}

/** The minimum policy state shape required to evaluate budget transitions. */
export interface BudgetStateCarrier {
  readonly initialized: boolean;
  readonly budgets: Readonly<Record<string, BudgetState>>;
}

/** A signal reading resolved against freshness and status rules. */
export interface ResolvedReading {
  readonly status: SignalStatus | "missing";
  readonly unit?: SignalView["unit"];
  readonly value?: number;
  readonly observedAt?: number;
  readonly ageMs?: number;
  readonly detail?: string;
}

export interface MissingBudgetSignal {
  readonly rule: ResolvedBudgetRule;
  readonly resolution: ResolvedReading;
}

export interface BudgetEvaluation {
  readonly nextBudgets: Record<string, BudgetState>;
  readonly missing: readonly MissingBudgetSignal[];
  readonly engagedNow: ReadonlySet<string>;
  readonly recoveredNow: ReadonlySet<string>;
}

export function defaultBudgetState(): BudgetState {
  return { engaged: false, aboveStreak: 0, belowStreak: 0 };
}

export function resolveReading(
  reading: ResourceSignal | undefined,
  now: number,
  maxSignalAgeMs: number,
): ResolvedReading {
  if (reading === undefined) {
    return { status: "missing", detail: "No provider returned this signal." };
  }

  if (reading.status !== "ok") {
    return {
      status: reading.status,
      unit: reading.unit,
      observedAt: reading.observedAt,
      ageMs: Math.max(0, now - reading.observedAt),
      detail: reading.error,
    };
  }

  const ageMs = Math.max(0, now - reading.observedAt);
  if (ageMs > maxSignalAgeMs) {
    return {
      status: "stale",
      unit: reading.unit,
      value: reading.value,
      observedAt: reading.observedAt,
      ageMs,
      detail: `Reading is ${ageMs} ms old; maxSignalAgeMs is ${maxSignalAgeMs}.`,
    };
  }

  if (!Number.isFinite(reading.value)) {
    return {
      status: "error",
      unit: reading.unit,
      observedAt: reading.observedAt,
      ageMs,
      detail: "Reading value is not finite.",
    };
  }

  return {
    status: "ok",
    unit: reading.unit,
    value: reading.value,
    observedAt: reading.observedAt,
    ageMs,
  };
}

export function buildSignalViews(
  readings: ReadonlyMap<string, ResourceSignal>,
  resolutions: ReadonlyMap<string, ResolvedReading>,
  budgets: readonly ResolvedBudgetRule[],
  now: number,
  maxSignalAgeMs: number,
): readonly SignalView[] {
  const names = new Set<string>([...readings.keys(), ...budgets.map((rule) => rule.signal)]);
  const views: SignalView[] = [];
  for (const name of [...names].sort()) {
    const resolution =
      resolutions.get(name) ?? resolveReading(readings.get(name), now, maxSignalAgeMs);
    views.push({
      name,
      unit: resolution.unit,
      status: resolution.status,
      value: resolution.value,
      observedAt: resolution.observedAt,
      ageMs: resolution.ageMs,
      detail: resolution.detail,
    });
  }
  return views;
}

export function buildBudgetViews(
  nextBudgets: Readonly<Record<string, BudgetState>>,
  resolutions: ReadonlyMap<string, ResolvedReading>,
  policy: ResolvedPolicy,
): readonly BudgetView[] {
  return policy.budgets.map((rule) => {
    const resolution = resolutions.get(rule.signal) ?? { status: "missing" as const };
    const budget = nextBudgets[rule.id] ?? defaultBudgetState();
    return {
      id: rule.id,
      signal: rule.signal,
      engaged: budget.engaged,
      status: resolution.status,
      value: resolution.status === "ok" ? resolution.value : undefined,
      ageMs: resolution.ageMs,
      limit: rule.limit,
      recoverBelow: rule.recoverBelow,
      tierReduction: rule.tierReduction,
    };
  });
}

/**
 * Advances every budget rule once. Only fresh samples mutate hysteresis
 * counters; a reused snapshot keeps the previous budget state.
 */
export function evaluateBudgets(
  state: BudgetStateCarrier,
  resolutions: ReadonlyMap<string, ResolvedReading>,
  policy: ResolvedPolicy,
  fresh: boolean,
): BudgetEvaluation {
  const nextBudgets: Record<string, BudgetState> = {};
  for (const rule of policy.budgets) {
    nextBudgets[rule.id] = { ...(state.budgets[rule.id] ?? defaultBudgetState()) };
  }

  const missing: MissingBudgetSignal[] = [];
  const engagedNow = new Set<string>();
  const recoveredNow = new Set<string>();

  for (const rule of policy.budgets) {
    const resolution = resolutions.get(rule.signal) ?? { status: "missing" as const };
    if (resolution.status !== "ok") {
      missing.push({ rule, resolution });
      continue;
    }

    const budget = nextBudgets[rule.id] ?? defaultBudgetState();
    if (!fresh) {
      continue;
    }

    const value = resolution.value ?? Number.NaN;
    if (!state.initialized) {
      const engaged = value > rule.limit;
      nextBudgets[rule.id] = {
        engaged,
        aboveStreak: 0,
        belowStreak: 0,
      };
      if (engaged) {
        engagedNow.add(rule.id);
      }
      continue;
    }

    if (budget.engaged) {
      const belowStreak = value < rule.recoverBelow ? budget.belowStreak + 1 : 0;
      if (belowStreak >= rule.consecutiveSamples) {
        nextBudgets[rule.id] = { engaged: false, aboveStreak: 0, belowStreak: 0 };
        recoveredNow.add(rule.id);
      } else {
        nextBudgets[rule.id] = { ...budget, belowStreak };
      }
    } else {
      const aboveStreak = value > rule.limit ? budget.aboveStreak + 1 : 0;
      if (aboveStreak >= rule.consecutiveSamples) {
        nextBudgets[rule.id] = { engaged: true, aboveStreak: 0, belowStreak: 0 };
        engagedNow.add(rule.id);
      } else {
        nextBudgets[rule.id] = { ...budget, aboveStreak };
      }
    }
  }

  return { nextBudgets, missing, engagedNow, recoveredNow };
}
