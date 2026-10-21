import {
  FallbackStrategyError,
  MissingSignalError,
  NoEligibleStrategyError,
  PinnedStrategyError,
} from "../errors/index.js";
import type {
  BudgetView,
  DecisionKind,
  DecisionReason,
  SignalView,
  StrategyDecision,
} from "../types/decision.js";
import type { ResolvedBudgetRule, ResolvedPolicy } from "../types/policy.js";
import type { ResourceSignal, SignalStatus } from "../types/signals.js";

export interface StrategyCandidate {
  readonly id: string;
  readonly qualityTier: number;
  readonly costTier?: number;
  readonly applicable: boolean;
}

export interface BudgetState {
  readonly engaged: boolean;
  readonly aboveStreak: number;
  readonly belowStreak: number;
}

export interface PolicyState {
  readonly initialized: boolean;
  readonly currentStrategyId: string | null;
  readonly currentQualityTier: number | null;
  readonly modeSince: number;
  readonly budgets: Readonly<Record<string, BudgetState>>;
  readonly pendingStrategyId: string | null;
  readonly pendingStreak: number;
  readonly lastSampleSequence: number | null;
}

export interface PolicyEvaluationInput {
  readonly operationId: string;
  readonly now: number;
  readonly signals: readonly ResourceSignal[];
  readonly strategies: readonly StrategyCandidate[];
  readonly pinnedStrategyId: string | null;
  readonly adaptationEnabled: boolean;
  readonly sampleSequence: number | null;
  readonly signalsCached: boolean;
}

export interface PolicyEvaluation {
  readonly state: PolicyState;
  readonly decision: StrategyDecision;
}

interface ResolvedReading {
  readonly status: SignalStatus | "missing";
  readonly unit?: SignalView["unit"];
  readonly value?: number;
  readonly observedAt?: number;
  readonly ageMs?: number;
  readonly detail?: string;
}

function defaultBudgetState(): BudgetState {
  return { engaged: false, aboveStreak: 0, belowStreak: 0 };
}

export function createInitialPolicyState(): PolicyState {
  return {
    initialized: false,
    currentStrategyId: null,
    currentQualityTier: null,
    modeSince: 0,
    budgets: {},
    pendingStrategyId: null,
    pendingStreak: 0,
    lastSampleSequence: null,
  };
}

function resolveReading(
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

function buildSignalViews(
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

function compareCandidates(left: StrategyCandidate, right: StrategyCandidate): number {
  if (left.qualityTier !== right.qualityTier) {
    return right.qualityTier - left.qualityTier;
  }
  const leftCost = left.costTier ?? Number.POSITIVE_INFINITY;
  const rightCost = right.costTier ?? Number.POSITIVE_INFINITY;
  if (leftCost !== rightCost) {
    return leftCost - rightCost;
  }
  // Code-unit comparison, not localeCompare: selection must be locale-independent.
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function chooseAtOrBelow(
  candidates: readonly StrategyCandidate[],
  targetTier: number,
): StrategyCandidate | undefined {
  return candidates
    .filter((candidate) => candidate.qualityTier <= targetTier)
    .sort(compareCandidates)[0];
}

function findApplicable(
  strategies: readonly StrategyCandidate[],
  strategyId: string,
): StrategyCandidate | undefined {
  return strategies.find((strategy) => strategy.id === strategyId && strategy.applicable);
}

function hasCandidate(strategies: readonly StrategyCandidate[], strategyId: string): boolean {
  return strategies.some((strategy) => strategy.id === strategyId);
}

function decisionFor(
  input: PolicyEvaluationInput,
  state: PolicyState,
  candidate: StrategyCandidate,
  baseQualityTier: number,
  targetQualityTier: number,
  kind: DecisionKind,
  changed: boolean,
  modeSince: number,
  reasons: readonly DecisionReason[],
  signals: readonly SignalView[],
  budgets: readonly BudgetView[],
  nextBudgets: Readonly<Record<string, BudgetState>>,
  pendingStrategyId: string | null,
  pendingStreak: number,
): PolicyEvaluation {
  const nextState: PolicyState = {
    initialized: true,
    currentStrategyId: candidate.id,
    currentQualityTier: candidate.qualityTier,
    modeSince,
    budgets: nextBudgets,
    pendingStrategyId,
    pendingStreak,
    lastSampleSequence: input.sampleSequence,
  };
  const decision: StrategyDecision = {
    operationId: input.operationId,
    strategyId: candidate.id,
    qualityTier: candidate.qualityTier,
    previousStrategyId: state.currentStrategyId,
    changed,
    kind,
    decidedAt: input.now,
    modeSince,
    baseQualityTier,
    targetQualityTier,
    signals,
    budgets,
    reasons,
    sampleSequence: input.sampleSequence,
    signalsCached: input.signalsCached,
  };
  return { state: nextState, decision };
}

/**
 * Pure policy evaluation. It has no Node.js or provider dependencies: callers
 * supply measurements, candidate metadata, the clock value, and current state.
 */
export function evaluatePolicy(
  state: PolicyState,
  input: PolicyEvaluationInput,
  policy: ResolvedPolicy,
): PolicyEvaluation {
  if (input.strategies.length === 0) {
    throw new NoEligibleStrategyError(input.operationId, policy.minQualityTier);
  }

  const readings = new Map<string, ResourceSignal>();
  for (const reading of input.signals) {
    readings.set(reading.name, reading);
  }

  const resolutions = new Map<string, ResolvedReading>();
  for (const rule of policy.budgets) {
    resolutions.set(
      rule.signal,
      resolveReading(readings.get(rule.signal), input.now, policy.maxSignalAgeMs),
    );
  }

  const fresh =
    !state.initialized ||
    input.sampleSequence === null ||
    state.lastSampleSequence !== input.sampleSequence;

  const nextBudgets: Record<string, BudgetState> = {};
  for (const rule of policy.budgets) {
    nextBudgets[rule.id] = { ...(state.budgets[rule.id] ?? defaultBudgetState()) };
  }

  const reasons: DecisionReason[] = [];
  const missing: Array<{ rule: ResolvedBudgetRule; resolution: ResolvedReading }> = [];
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

  for (const rule of policy.budgets) {
    const resolution = resolutions.get(rule.signal);
    if (resolution === undefined || resolution.status !== "ok") {
      continue;
    }
    if (engagedNow.has(rule.id)) {
      reasons.push({
        code: "quality-pressure",
        message: `Budget "${rule.id}" engaged: ${rule.signal} is above ${rule.limit}.`,
        details: {
          budgetId: rule.id,
          signal: rule.signal,
          value: resolution.value,
          limit: rule.limit,
        },
      });
    }
    if (recoveredNow.has(rule.id)) {
      reasons.push({
        code: "budget-recovered",
        message: `Budget "${rule.id}" recovered: ${rule.signal} is below ${rule.recoverBelow}.`,
        details: {
          budgetId: rule.id,
          signal: rule.signal,
          value: resolution.value,
          recoverBelow: rule.recoverBelow,
        },
      });
    }
  }

  if (missing.length > 0) {
    const missingNames = [...new Set(missing.map(({ rule }) => rule.signal))].sort();
    const automaticMode = input.pinnedStrategyId === null && input.adaptationEnabled;
    if (automaticMode && policy.missingSignalBehavior === "error") {
      throw new MissingSignalError(input.operationId, missingNames);
    }
    if (automaticMode && policy.missingSignalBehavior === "ignore") {
      for (const { rule } of missing) {
        nextBudgets[rule.id] = { engaged: false, aboveStreak: 0, belowStreak: 0 };
      }
      reasons.push({
        code: "missing-signal-ignored",
        message: `Ignoring unavailable signal(s) for this evaluation: ${missingNames.join(", ")}.`,
        details: { signals: missingNames },
      });
    } else if (automaticMode) {
      reasons.push({
        code: "missing-signal-hold",
        message: `Holding policy state because signal(s) are unavailable: ${missingNames.join(", ")}.`,
        details: { signals: missingNames },
      });
    }
  }

  const signalViews = buildSignalViews(
    readings,
    resolutions,
    policy.budgets,
    input.now,
    policy.maxSignalAgeMs,
  );

  const budgetViews: BudgetView[] = policy.budgets.map((rule) => {
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

  const declaredMaxQualityTier = Math.max(...input.strategies.map((s) => s.qualityTier));
  const baseQualityTier =
    policy.maxQualityTier === undefined
      ? declaredMaxQualityTier
      : Math.min(declaredMaxQualityTier, policy.maxQualityTier);

  const automaticCandidates = input.strategies.filter(
    (strategy) =>
      strategy.applicable &&
      (policy.minQualityTier === undefined || strategy.qualityTier >= policy.minQualityTier) &&
      (policy.maxQualityTier === undefined || strategy.qualityTier <= policy.maxQualityTier),
  );

  const missingFallbackNames =
    policy.missingSignalBehavior === "fallback" &&
    missing.length > 0 &&
    input.pinnedStrategyId === null &&
    input.adaptationEnabled
      ? missing
      : [];

  // A manual pin is an explicit override of pressure, quality floor, and min mode duration.
  if (input.pinnedStrategyId !== null) {
    const pinned = input.strategies.find((s) => s.id === input.pinnedStrategyId);
    if (pinned === undefined) {
      throw new PinnedStrategyError(input.operationId, input.pinnedStrategyId, "not-found");
    }
    if (!pinned.applicable) {
      throw new PinnedStrategyError(input.operationId, input.pinnedStrategyId, "not-applicable");
    }
    const changed = state.currentStrategyId !== null && state.currentStrategyId !== pinned.id;
    const modeSince = state.currentStrategyId === pinned.id ? state.modeSince : input.now;
    return decisionFor(
      input,
      state,
      pinned,
      baseQualityTier,
      pinned.qualityTier,
      "pinned",
      changed,
      modeSince,
      [
        {
          code: "pinned-strategy",
          message: `Operation is pinned to strategy "${pinned.id}".`,
          details: { strategyId: pinned.id },
        },
        ...(changed
          ? [
              {
                code: "strategy-switched" as const,
                message: `Switched from "${state.currentStrategyId ?? "none"}" to "${pinned.id}".`,
              },
            ]
          : []),
      ],
      signalViews,
      budgetViews,
      nextBudgets,
      null,
      0,
    );
  }

  if (missingFallbackNames.length > 0) {
    const fallbackId = policy.fallbackStrategyId;
    const fallback =
      fallbackId === undefined ? undefined : findApplicable(input.strategies, fallbackId);
    if (fallbackId === undefined || fallback === undefined) {
      const reason = hasCandidate(input.strategies, fallbackId ?? "")
        ? "not-applicable"
        : "not-found";
      throw new FallbackStrategyError(input.operationId, fallbackId ?? "<unset>", reason);
    }
    const changed = state.currentStrategyId !== null && state.currentStrategyId !== fallback.id;
    const modeSince = state.currentStrategyId === fallback.id ? state.modeSince : input.now;
    return decisionFor(
      input,
      state,
      fallback,
      baseQualityTier,
      fallback.qualityTier,
      "fallback",
      changed,
      modeSince,
      [
        {
          code: "missing-signal-fallback",
          message: `Using fallback strategy "${fallback.id}" because signal(s) are unavailable: ${missingFallbackNames
            .map(({ rule }) => rule.signal)
            .join(", ")}.`,
          details: { fallbackStrategyId: fallback.id },
        },
        ...(changed
          ? [
              {
                code: "strategy-switched" as const,
                message: `Switched from "${state.currentStrategyId ?? "none"}" to "${fallback.id}".`,
              },
            ]
          : []),
      ],
      signalViews,
      budgetViews,
      nextBudgets,
      null,
      0,
    );
  }

  if (automaticCandidates.length === 0) {
    throw new NoEligibleStrategyError(input.operationId, policy.minQualityTier);
  }

  if (!input.adaptationEnabled) {
    const candidate = [...automaticCandidates].sort(compareCandidates)[0];
    if (candidate === undefined) {
      throw new NoEligibleStrategyError(input.operationId, policy.minQualityTier);
    }
    const changed = state.currentStrategyId !== null && state.currentStrategyId !== candidate.id;
    const modeSince = state.currentStrategyId === candidate.id ? state.modeSince : input.now;
    reasons.push({
      code: "adaptation-disabled",
      message: "Adaptation is disabled; selecting the highest applicable quality tier.",
    });
    if (changed) {
      reasons.push({
        code: "strategy-switched",
        message: `Switched from "${state.currentStrategyId ?? "none"}" to "${candidate.id}".`,
      });
    }
    return decisionFor(
      input,
      state,
      candidate,
      baseQualityTier,
      candidate.qualityTier,
      "static",
      changed,
      modeSince,
      reasons,
      signalViews,
      budgetViews,
      nextBudgets,
      null,
      0,
    );
  }

  const engagedRules = policy.budgets.filter((rule) => nextBudgets[rule.id]?.engaged === true);
  const tierReduction = engagedRules.reduce((sum, rule) => sum + rule.tierReduction, 0);
  let targetQualityTier = baseQualityTier - tierReduction;

  if (engagedRules.length > 0) {
    reasons.push({
      code: "quality-pressure",
      message: `Quality pressure active from ${engagedRules.length} budget(s); reducing target tier by ${tierReduction}.`,
      details: {
        activeBudgetIds: engagedRules.map((rule) => rule.id),
        tierReduction,
      },
    });
  }

  if (policy.minQualityTier !== undefined && targetQualityTier < policy.minQualityTier) {
    targetQualityTier = policy.minQualityTier;
    reasons.push({
      code: "quality-floor-clamped",
      message: `Target tier raised to the configured quality floor (${policy.minQualityTier}).`,
      details: { minQualityTier: policy.minQualityTier },
    });
  }

  const poolTiers = automaticCandidates.map((strategy) => strategy.qualityTier);
  const minPoolTier = Math.min(...poolTiers);
  const maxPoolTier = Math.max(...poolTiers);
  if (targetQualityTier < minPoolTier) {
    targetQualityTier = minPoolTier;
    reasons.push({
      code: "target-tier-clamped",
      message: `Target tier raised to the lowest available tier (${minPoolTier}); no strategy is available below it.`,
      details: { minPoolTier },
    });
  } else if (targetQualityTier > maxPoolTier) {
    targetQualityTier = maxPoolTier;
    reasons.push({
      code: "target-tier-clamped",
      message: `Target tier lowered to the highest available tier (${maxPoolTier}).`,
      details: { maxPoolTier },
    });
  }

  const candidate = chooseAtOrBelow(automaticCandidates, targetQualityTier);
  if (candidate === undefined) {
    throw new NoEligibleStrategyError(input.operationId, policy.minQualityTier);
  }

  if (input.signalsCached && !fresh) {
    reasons.push({
      code: "cached-sample",
      message:
        "Signal snapshot was reused within evaluationIntervalMs; state counters did not advance.",
    });
  }

  if (!state.initialized || state.currentStrategyId === null) {
    reasons.unshift({
      code: "initial-selection",
      message: `Initial strategy selection: "${candidate.id}" at quality tier ${candidate.qualityTier}.`,
    });
    return decisionFor(
      input,
      state,
      candidate,
      baseQualityTier,
      targetQualityTier,
      "initial",
      false,
      input.now,
      reasons,
      signalViews,
      budgetViews,
      nextBudgets,
      null,
      0,
    );
  }

  if (state.currentStrategyId === candidate.id) {
    reasons.unshift({
      code: "strategy-retained",
      message: `Strategy "${candidate.id}" remains selected.`,
    });
    return decisionFor(
      input,
      state,
      candidate,
      baseQualityTier,
      targetQualityTier,
      "retained",
      false,
      state.modeSince,
      reasons,
      signalViews,
      budgetViews,
      nextBudgets,
      null,
      0,
    );
  }

  const currentInPool = automaticCandidates.some((s) => s.id === state.currentStrategyId);
  if (!currentInPool) {
    reasons.push({
      code: "current-strategy-inapplicable",
      message: `Previously selected strategy "${state.currentStrategyId}" is no longer eligible; switching immediately.`,
      details: { previousStrategyId: state.currentStrategyId, strategyId: candidate.id },
    });
    return decisionFor(
      input,
      state,
      candidate,
      baseQualityTier,
      targetQualityTier,
      "adapted",
      true,
      input.now,
      reasons,
      signalViews,
      budgetViews,
      nextBudgets,
      null,
      0,
    );
  }

  if (!fresh) {
    reasons.unshift({
      code: "strategy-retained",
      message: `Strategy "${state.currentStrategyId}" retained because no fresh sample is available.`,
    });
    return decisionFor(
      input,
      state,
      {
        ...candidate,
        id: state.currentStrategyId,
        qualityTier: state.currentQualityTier ?? candidate.qualityTier,
      },
      baseQualityTier,
      targetQualityTier,
      "retained",
      false,
      state.modeSince,
      reasons,
      signalViews,
      budgetViews,
      nextBudgets,
      state.pendingStrategyId,
      state.pendingStreak,
    );
  }

  const pendingStreak = state.pendingStrategyId === candidate.id ? state.pendingStreak + 1 : 1;
  const elapsed = input.now - state.modeSince;

  if (elapsed < policy.minimumModeDurationMs) {
    reasons.push({
      code: "minimum-mode-duration",
      message: `Keeping "${state.currentStrategyId}" until minimumModeDurationMs (${policy.minimumModeDurationMs}) elapses.`,
      details: { elapsedMs: elapsed, minimumModeDurationMs: policy.minimumModeDurationMs },
    });
    return decisionFor(
      input,
      state,
      {
        ...candidate,
        id: state.currentStrategyId,
        qualityTier: state.currentQualityTier ?? candidate.qualityTier,
      },
      baseQualityTier,
      targetQualityTier,
      "retained",
      false,
      state.modeSince,
      reasons,
      signalViews,
      budgetViews,
      nextBudgets,
      candidate.id,
      pendingStreak,
    );
  }

  if (pendingStreak < policy.consecutiveSamples) {
    reasons.push({
      code: "candidate-stability",
      message: `Candidate "${candidate.id}" needs ${policy.consecutiveSamples} consecutive fresh samples; observed ${pendingStreak}.`,
      details: { candidateStrategyId: candidate.id, pendingStreak },
    });
    return decisionFor(
      input,
      state,
      {
        ...candidate,
        id: state.currentStrategyId,
        qualityTier: state.currentQualityTier ?? candidate.qualityTier,
      },
      baseQualityTier,
      targetQualityTier,
      "retained",
      false,
      state.modeSince,
      reasons,
      signalViews,
      budgetViews,
      nextBudgets,
      candidate.id,
      pendingStreak,
    );
  }

  reasons.push({
    code: "strategy-switched",
    message: `Switched from "${state.currentStrategyId}" to "${candidate.id}".`,
    details: { previousStrategyId: state.currentStrategyId, strategyId: candidate.id },
  });
  return decisionFor(
    input,
    state,
    candidate,
    baseQualityTier,
    targetQualityTier,
    "adapted",
    true,
    input.now,
    reasons,
    signalViews,
    budgetViews,
    nextBudgets,
    null,
    0,
  );
}
