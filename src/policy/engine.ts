import {
  ConfigurationError,
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
import type {
  CustomPolicySelectorContext,
  CustomSelectorCandidate,
  ResolvedPolicy,
} from "../types/policy.js";
import type { ResourceSignal } from "../types/signals.js";
import {
  type BudgetState,
  buildBudgetViews,
  buildSignalViews,
  evaluateBudgets,
  type ResolvedReading,
  resolveReading,
} from "./budgets.js";
import {
  chooseAtOrBelow,
  clampTargetQualityTier,
  computeBaseQualityTier,
  filterAutomaticCandidates,
  findApplicable,
  hasCandidate,
  pickHighest,
  type StrategyCandidate,
} from "./candidates.js";
import { evaluateStabilityGate } from "./stability.js";

export type { BudgetState } from "./budgets.js";
export type { StrategyCandidate } from "./candidates.js";

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
  readonly operation?: string;
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

  const { nextBudgets, missing, engagedNow, recoveredNow } = evaluateBudgets(
    state,
    resolutions,
    policy,
    fresh,
  );

  const reasons: DecisionReason[] = [];

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

  const budgetViews = buildBudgetViews(nextBudgets, resolutions, policy);

  const baseQualityTier = computeBaseQualityTier(input.strategies, policy.maxQualityTier);

  const automaticCandidates = filterAutomaticCandidates(input.strategies, policy);

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
    const candidate = pickHighest(automaticCandidates);
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

  const poolTiers = automaticCandidates.map((strategy) => strategy.qualityTier);
  const clamp = clampTargetQualityTier(targetQualityTier, policy.minQualityTier, poolTiers);
  targetQualityTier = clamp.targetQualityTier;

  if (clamp.floorApplied !== null) {
    reasons.push({
      code: "quality-floor-clamped",
      message: `Target tier raised to the configured quality floor (${clamp.floorApplied}).`,
      details: { minQualityTier: clamp.floorApplied },
    });
  }

  if (clamp.poolMinApplied !== null) {
    reasons.push({
      code: "target-tier-clamped",
      message: `Target tier raised to the lowest available tier (${clamp.poolMinApplied}); no strategy is available below it.`,
      details: { minPoolTier: clamp.poolMinApplied },
    });
  } else if (clamp.poolMaxApplied !== null) {
    reasons.push({
      code: "target-tier-clamped",
      message: `Target tier lowered to the highest available tier (${clamp.poolMaxApplied}).`,
      details: { maxPoolTier: clamp.poolMaxApplied },
    });
  }

  let candidate = chooseAtOrBelow(automaticCandidates, targetQualityTier);
  if (candidate === undefined) {
    throw new NoEligibleStrategyError(input.operationId, policy.minQualityTier);
  }

  if (policy.customSelector !== null) {
    const selectorCandidates: CustomSelectorCandidate[] = automaticCandidates.map((c) => ({
      candidate: {
        id: c.id,
        qualityTier: c.qualityTier,
        costTier: c.costTier,
        applicable: c.applicable,
      },
      estimatedCost: c.costTier ?? null,
      estimatedLatencyMs: c.estimatedLatencyMs ?? null,
      ewmaLatencyMs: c.ewmaLatencyMs ?? null,
      errorRate: c.errorRate ?? null,
      samples: c.samples ?? null,
    }));

    const signalsRecord: Record<string, ResourceSignal> = {};
    for (const sig of input.signals) {
      signalsRecord[sig.name] = sig;
    }

    const selectorContext: CustomPolicySelectorContext = {
      operation: input.operation ?? input.operationId,
      operationId: input.operationId,
      candidates: selectorCandidates,
      signals: signalsRecord,
      now: input.now,
    };

    const selection = policy.customSelector(selectorContext);

    if (selection !== null && selection !== undefined) {
      const chosenStrategyId =
        typeof selection === "string"
          ? selection
          : selection && typeof selection === "object"
            ? selection.strategyId
            : undefined;

      if (typeof chosenStrategyId !== "string" || chosenStrategyId.trim().length === 0) {
        throw new ConfigurationError(
          `customSelector must return a valid strategyId, got "${String(chosenStrategyId)}".`,
        );
      }

      const matchedCandidate = automaticCandidates.find((c) => c.id === chosenStrategyId);
      if (!matchedCandidate) {
        throw new ConfigurationError(
          `customSelector chose strategy "${chosenStrategyId}" which is not an applicable surviving candidate within quality tier bounds.`,
        );
      }

      candidate = matchedCandidate;

      const reasonDetail =
        typeof selection === "object" &&
        typeof selection.reason === "string" &&
        selection.reason.length > 0
          ? selection.reason
          : `Custom policy selector chose strategy "${chosenStrategyId}".`;

      reasons.push({
        code: "custom-selector",
        message: reasonDetail,
        detail: reasonDetail,
        details: { strategyId: chosenStrategyId },
      });
    }
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

  const stability = evaluateStabilityGate(
    state,
    candidate.id,
    input.now,
    policy.minimumModeDurationMs,
    policy.consecutiveSamples,
  );

  if (stability.blocked === "minimum-mode-duration") {
    reasons.push({
      code: "minimum-mode-duration",
      message: `Keeping "${state.currentStrategyId}" until minimumModeDurationMs (${policy.minimumModeDurationMs}) elapses.`,
      details: {
        elapsedMs: stability.elapsedMs,
        minimumModeDurationMs: policy.minimumModeDurationMs,
      },
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
      stability.pendingStrategyId,
      stability.pendingStreak,
    );
  }

  if (stability.blocked === "candidate-stability") {
    reasons.push({
      code: "candidate-stability",
      message: `Candidate "${candidate.id}" needs ${policy.consecutiveSamples} consecutive fresh samples; observed ${stability.pendingStreak}.`,
      details: { candidateStrategyId: candidate.id, pendingStreak: stability.pendingStreak },
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
      stability.pendingStrategyId,
      stability.pendingStreak,
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
