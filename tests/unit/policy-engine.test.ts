import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FallbackStrategyError,
  MissingSignalError,
  NoEligibleStrategyError,
  PinnedStrategyError,
} from "../../src/errors/index.js";
import {
  createInitialPolicyState,
  evaluatePolicy,
  type PolicyEvaluationInput,
  type PolicyState,
  type StrategyCandidate,
} from "../../src/policy/engine.js";
import { resolvePolicy } from "../../src/policy/resolve.js";
import type { CustomSelectorCandidate, Policy } from "../../src/types/policy.js";
import { okSignal, unavailableSignal } from "../helpers/providers.js";

const NOW = 1_000_000;
const SIGNAL = "test.value";

function candidates(
  specs: ReadonlyArray<{
    id: string;
    qualityTier: number;
    costTier?: number;
    applicable?: boolean;
    samples?: number | null;
  }>,
): StrategyCandidate[] {
  return specs.map((spec) => ({
    id: spec.id,
    qualityTier: spec.qualityTier,
    costTier: spec.costTier,
    applicable: spec.applicable ?? true,
    samples: spec.samples,
  }));
}

const defaultStrategies = candidates([
  { id: "high", qualityTier: 3 },
  { id: "balanced", qualityTier: 2 },
  { id: "economy", qualityTier: 1 },
]);

function makePolicy(overrides: Policy = {}) {
  return resolvePolicy({
    budgets: [
      {
        id: "pressure",
        signal: SIGNAL,
        limit: 100,
        recoverBelow: 50,
        tierReduction: 1,
        consecutiveSamples: 1,
      },
    ],
    consecutiveSamples: 1,
    ...overrides,
  });
}

function makeInput(overrides: Partial<PolicyEvaluationInput> = {}): PolicyEvaluationInput {
  return {
    operationId: "test-op",
    now: NOW,
    signals: [okSignal(SIGNAL, 10, NOW)],
    strategies: defaultStrategies,
    pinnedStrategyId: null,
    adaptationEnabled: true,
    sampleSequence: 1,
    signalsCached: false,
    ...overrides,
  };
}

function evaluate(
  state: PolicyState,
  input: PolicyEvaluationInput,
  policy: ReturnType<typeof makePolicy>,
) {
  return evaluatePolicy(state, input, policy);
}

describe("policy engine", () => {
  it("selects the highest quality tier initially and is deterministic", () => {
    const policy = makePolicy();
    const state = createInitialPolicyState();
    const input = makeInput();
    const first = evaluate(state, input, policy);
    const second = evaluate(state, input, policy);

    assert.equal(first.decision.strategyId, "high");
    assert.equal(first.decision.kind, "initial");
    assert.equal(first.decision.targetQualityTier, 3);
    assert.equal(first.decision.changed, false);
    assert.deepEqual(second.decision, first.decision);
    assert.deepEqual(second.state, first.state);
  });

  it("engages initial pressure immediately instead of starting at the highest tier", () => {
    const policy = makePolicy();
    const result = evaluate(
      createInitialPolicyState(),
      makeInput({ signals: [okSignal(SIGNAL, 150, NOW)] }),
      policy,
    );

    assert.equal(result.decision.strategyId, "balanced");
    assert.equal(result.decision.targetQualityTier, 2);
    assert.equal(result.decision.budgets[0]?.engaged, true);
    assert.ok(result.decision.reasons.some((reason) => reason.code === "quality-pressure"));
  });

  it("requires consecutive fresh samples before switching and ignores cached duplicates", () => {
    const policy = makePolicy({ consecutiveSamples: 2 });
    let state = createInitialPolicyState();
    const initial = evaluate(state, makeInput(), policy);
    state = initial.state;
    assert.equal(initial.decision.strategyId, "high");

    const cached = evaluate(
      state,
      makeInput({
        now: NOW + 1000,
        sampleSequence: 1,
        signalsCached: true,
        signals: [okSignal(SIGNAL, 150, NOW + 1000)],
      }),
      policy,
    );
    assert.equal(cached.decision.strategyId, "high");
    assert.ok(cached.decision.reasons.some((reason) => reason.code === "cached-sample"));

    const firstFresh = evaluate(
      cached.state,
      makeInput({
        now: NOW + 2000,
        sampleSequence: 2,
        signals: [okSignal(SIGNAL, 150, NOW + 2000)],
      }),
      policy,
    );
    assert.equal(firstFresh.decision.strategyId, "high");
    assert.equal(firstFresh.decision.kind, "retained");
    assert.ok(firstFresh.decision.reasons.some((reason) => reason.code === "candidate-stability"));

    const secondFresh = evaluate(
      firstFresh.state,
      makeInput({
        now: NOW + 3000,
        sampleSequence: 3,
        signals: [okSignal(SIGNAL, 150, NOW + 3000)],
      }),
      policy,
    );
    assert.equal(secondFresh.decision.strategyId, "balanced");
    assert.equal(secondFresh.decision.kind, "adapted");
    assert.equal(secondFresh.decision.changed, true);
  });

  it("processes a shared cached snapshot that is new to the operation", () => {
    const policy = makePolicy();
    const initial = evaluate(createInitialPolicyState(), makeInput(), policy);
    assert.equal(initial.decision.strategyId, "high");

    const shared = evaluate(
      initial.state,
      makeInput({
        now: NOW + 1000,
        sampleSequence: 2,
        signalsCached: true,
        signals: [okSignal(SIGNAL, 150, NOW + 1000)],
      }),
      policy,
    );

    assert.equal(shared.decision.signalsCached, true);
    assert.equal(shared.decision.budgets[0]?.engaged, true);
    assert.equal(shared.decision.strategyId, "balanced");
    assert.equal(shared.state.lastSampleSequence, 2);
    assert.ok(!shared.decision.reasons.some((reason) => reason.code === "cached-sample"));
  });

  it("implements hysteresis: between recoverBelow and limit keeps pressure engaged", () => {
    const policy = makePolicy();
    let state = createInitialPolicyState();
    state = evaluate(state, makeInput(), policy).state;
    const engaged = evaluate(
      state,
      makeInput({
        now: NOW + 1000,
        sampleSequence: 2,
        signals: [okSignal(SIGNAL, 150, NOW + 1000)],
      }),
      policy,
    );
    assert.equal(engaged.decision.strategyId, "balanced");

    const between = evaluate(
      engaged.state,
      makeInput({
        now: NOW + 2000,
        sampleSequence: 3,
        signals: [okSignal(SIGNAL, 75, NOW + 2000)],
      }),
      policy,
    );
    assert.equal(between.decision.strategyId, "balanced");
    assert.equal(between.decision.budgets[0]?.engaged, true);

    const recovered = evaluate(
      between.state,
      makeInput({
        now: NOW + 3000,
        sampleSequence: 4,
        signals: [okSignal(SIGNAL, 40, NOW + 3000)],
      }),
      policy,
    );
    assert.equal(recovered.decision.strategyId, "high");
    assert.equal(recovered.decision.kind, "adapted");
    assert.equal(recovered.decision.budgets[0]?.engaged, false);
    assert.ok(recovered.decision.reasons.some((reason) => reason.code === "budget-recovered"));
  });

  it("respects minimumModeDurationMs even when a candidate is ready", () => {
    const policy = makePolicy({ minimumModeDurationMs: 5000 });
    let state = createInitialPolicyState();
    state = evaluate(state, makeInput(), policy).state;

    const early = evaluate(
      state,
      makeInput({
        now: NOW + 1000,
        sampleSequence: 2,
        signals: [okSignal(SIGNAL, 150, NOW + 1000)],
      }),
      policy,
    );
    assert.equal(early.decision.strategyId, "high");
    assert.ok(early.decision.reasons.some((reason) => reason.code === "minimum-mode-duration"));

    const atBoundary = evaluate(
      early.state,
      makeInput({
        now: NOW + 5000,
        sampleSequence: 3,
        signals: [okSignal(SIGNAL, 150, NOW + 5000)],
      }),
      policy,
    );
    assert.equal(atBoundary.decision.strategyId, "balanced");
  });

  it("applies a quality floor and records the clamp", () => {
    const policy = makePolicy({
      minQualityTier: 2,
      budgets: [
        {
          id: "pressure",
          signal: SIGNAL,
          limit: 100,
          recoverBelow: 50,
          tierReduction: 5,
          consecutiveSamples: 1,
        },
      ],
    });
    const result = evaluate(
      createInitialPolicyState(),
      makeInput({ signals: [okSignal(SIGNAL, 150, NOW)] }),
      policy,
    );
    assert.equal(result.decision.strategyId, "balanced");
    assert.equal(result.decision.targetQualityTier, 2);
    assert.ok(result.decision.reasons.some((reason) => reason.code === "quality-floor-clamped"));
  });

  it("clamps a target tier to the lowest available strategy", () => {
    const policy = makePolicy({
      budgets: [
        {
          id: "pressure",
          signal: SIGNAL,
          limit: 100,
          recoverBelow: 50,
          tierReduction: 5,
          consecutiveSamples: 1,
        },
      ],
    });
    const result = evaluate(
      createInitialPolicyState(),
      makeInput({
        strategies: candidates([
          { id: "balanced", qualityTier: 2 },
          { id: "high", qualityTier: 3 },
        ]),
        signals: [okSignal(SIGNAL, 150, NOW)],
      }),
      policy,
    );
    assert.equal(result.decision.strategyId, "balanced");
    assert.equal(result.decision.targetQualityTier, 2);
    assert.ok(result.decision.reasons.some((reason) => reason.code === "target-tier-clamped"));
  });

  it("uses cost tier and then lexical id to break quality ties", () => {
    const policy = makePolicy({ budgets: [], consecutiveSamples: 1 });
    const cheap = evaluate(
      createInitialPolicyState(),
      makeInput({
        strategies: candidates([
          { id: "same-b", qualityTier: 2, costTier: 2 },
          { id: "same-a", qualityTier: 2, costTier: 1 },
        ]),
      }),
      policy,
    );
    assert.equal(cheap.decision.strategyId, "same-a");

    const lexical = evaluate(
      createInitialPolicyState(),
      makeInput({
        strategies: candidates([
          { id: "z-last", qualityTier: 2 },
          { id: "a-first", qualityTier: 2 },
        ]),
      }),
      policy,
    );
    assert.equal(lexical.decision.strategyId, "a-first");
  });

  it("holds state when a budget signal is missing (never treats it as zero)", () => {
    const policy = makePolicy();
    const result = evaluate(createInitialPolicyState(), makeInput({ signals: [] }), policy);
    assert.equal(result.decision.strategyId, "high");
    assert.equal(result.decision.budgets[0]?.engaged, false);
    assert.equal(result.decision.budgets[0]?.status, "missing");
    assert.ok(result.decision.reasons.some((reason) => reason.code === "missing-signal-hold"));
  });

  it("treats stale readings as missing and reports the stale status", () => {
    const policy = makePolicy({
      maxSignalAgeMs: 5000,
      missingSignalBehavior: "fallback",
      fallbackStrategyId: "fallback",
    });
    const strategies = candidates([
      { id: "high", qualityTier: 3 },
      { id: "fallback", qualityTier: 1 },
    ]);
    const result = evaluate(
      createInitialPolicyState(),
      makeInput({
        strategies,
        signals: [okSignal(SIGNAL, 10, NOW - 6000)],
      }),
      policy,
    );
    assert.equal(result.decision.strategyId, "fallback");
    assert.equal(result.decision.kind, "fallback");
    assert.equal(result.decision.budgets[0]?.status, "stale");
  });

  it("uses the configured fallback when a signal is unavailable", () => {
    const policy = makePolicy({
      missingSignalBehavior: "fallback",
      fallbackStrategyId: "safe",
    });
    const strategies = candidates([
      { id: "high", qualityTier: 3 },
      { id: "safe", qualityTier: 0 },
    ]);
    const result = evaluate(
      createInitialPolicyState(),
      makeInput({
        strategies,
        signals: [unavailableSignal(SIGNAL, NOW, "unsupported")],
      }),
      policy,
    );
    assert.equal(result.decision.strategyId, "safe");
    assert.ok(result.decision.reasons.some((reason) => reason.code === "missing-signal-fallback"));
  });

  it("can fail instead of guessing when signals are missing", () => {
    const policy = makePolicy({ missingSignalBehavior: "error" });
    assert.throws(
      () =>
        evaluate(
          createInitialPolicyState(),
          makeInput({ signals: [unavailableSignal(SIGNAL, NOW, "unknown")] }),
          policy,
        ),
      (error: unknown) =>
        error instanceof MissingSignalError &&
        error.signals.includes(SIGNAL) &&
        error.code === "MISSING_SIGNAL",
    );
  });

  it("reports an unavailable fallback strategy clearly", () => {
    const policy = makePolicy({
      missingSignalBehavior: "fallback",
      fallbackStrategyId: "safe",
    });
    assert.throws(
      () =>
        evaluate(
          createInitialPolicyState(),
          makeInput({
            strategies: candidates([{ id: "high", qualityTier: 3 }]),
            signals: [],
          }),
          policy,
        ),
      FallbackStrategyError,
    );
  });

  it("supports manual pinning and rejects an inapplicable pinned strategy", () => {
    const policy = makePolicy();
    const pinned = evaluate(
      createInitialPolicyState(),
      makeInput({
        pinnedStrategyId: "economy",
        signals: [okSignal(SIGNAL, 150, NOW)],
      }),
      policy,
    );
    assert.equal(pinned.decision.strategyId, "economy");
    assert.equal(pinned.decision.kind, "pinned");
    assert.ok(pinned.decision.reasons.some((reason) => reason.code === "pinned-strategy"));

    assert.throws(
      () =>
        evaluate(
          createInitialPolicyState(),
          makeInput({
            pinnedStrategyId: "missing",
          }),
          policy,
        ),
      PinnedStrategyError,
    );

    assert.throws(
      () =>
        evaluate(
          createInitialPolicyState(),
          makeInput({
            strategies: candidates([
              { id: "high", qualityTier: 3 },
              { id: "off", qualityTier: 2, applicable: false },
            ]),
            pinnedStrategyId: "off",
          }),
          policy,
        ),
      PinnedStrategyError,
    );
  });

  it("selects statically when adaptation is disabled", () => {
    const policy = makePolicy();
    const result = evaluate(
      createInitialPolicyState(),
      makeInput({
        adaptationEnabled: false,
        signals: [okSignal(SIGNAL, 150, NOW)],
      }),
      policy,
    );
    assert.equal(result.decision.strategyId, "high");
    assert.equal(result.decision.kind, "static");
    assert.ok(result.decision.reasons.some((reason) => reason.code === "adaptation-disabled"));
  });

  it("does not fail on missing signals when pinned or adaptation is disabled", () => {
    const policy = makePolicy({ missingSignalBehavior: "error" });
    const pinned = evaluate(
      createInitialPolicyState(),
      makeInput({ pinnedStrategyId: "high", signals: [] }),
      policy,
    );
    assert.equal(pinned.decision.strategyId, "high");

    const staticResult = evaluate(
      createInitialPolicyState(),
      makeInput({ adaptationEnabled: false, signals: [] }),
      policy,
    );
    assert.equal(staticResult.decision.strategyId, "high");
  });

  it("throws when no applicable strategy exists", () => {
    const policy = makePolicy();
    assert.throws(
      () =>
        evaluate(
          createInitialPolicyState(),
          makeInput({
            strategies: candidates([
              { id: "high", qualityTier: 3, applicable: false },
              { id: "low", qualityTier: 1, applicable: false },
            ]),
          }),
          policy,
        ),
      NoEligibleStrategyError,
    );
  });

  it("switches immediately when the current strategy becomes inapplicable", () => {
    const policy = makePolicy();
    let state = createInitialPolicyState();
    state = evaluate(state, makeInput(), policy).state;
    const result = evaluate(
      state,
      makeInput({
        now: NOW + 1,
        sampleSequence: 2,
        strategies: candidates([
          { id: "high", qualityTier: 3, applicable: false },
          { id: "balanced", qualityTier: 2 },
        ]),
      }),
      policy,
    );
    assert.equal(result.decision.strategyId, "balanced");
    assert.ok(
      result.decision.reasons.some((reason) => reason.code === "current-strategy-inapplicable"),
    );
  });

  it("captures signal status and age in the decision", () => {
    const policy = makePolicy({ maxSignalAgeMs: 10000 });
    const result = evaluate(
      createInitialPolicyState(),
      makeInput({
        signals: [
          okSignal(SIGNAL, 10, NOW - 250, "bytes"),
          unavailableSignal("other.signal", NOW, "error", "count"),
        ],
      }),
      policy,
    );
    const current = result.decision.signals.find((signal) => signal.name === SIGNAL);
    const other = result.decision.signals.find((signal) => signal.name === "other.signal");
    assert.equal(current?.status, "ok");
    assert.equal(current?.ageMs, 250);
    assert.equal(other?.status, "error");
  });

  it("propagates samples from StrategyCandidate into selectorCandidates for customSelector", () => {
    let capturedCandidates: readonly CustomSelectorCandidate[] = [];
    const policy = makePolicy({
      customSelector: (ctx) => {
        capturedCandidates = ctx.candidates;
        return null;
      },
    });

    evaluate(
      createInitialPolicyState(),
      makeInput({
        strategies: candidates([
          { id: "high", qualityTier: 3, samples: 42 },
          { id: "balanced", qualityTier: 2, samples: null },
          { id: "economy", qualityTier: 1 },
        ]),
      }),
      policy,
    );

    assert.equal(capturedCandidates.length, 3);
    const high = capturedCandidates.find((c) => c.candidate.id === "high");
    const balanced = capturedCandidates.find((c) => c.candidate.id === "balanced");
    const economy = capturedCandidates.find((c) => c.candidate.id === "economy");

    assert.equal(high?.samples, 42);
    assert.equal(balanced?.samples, null);
    assert.equal(economy?.samples, null);
  });
});
