import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigurationError } from "../../src/errors/index.js";
import {
  createInitialPolicyState,
  evaluatePolicy,
  type PolicyEvaluationInput,
  type StrategyCandidate,
} from "../../src/policy/engine.js";
import { resolvePolicy } from "../../src/policy/resolve.js";
import {
  type CostBudgetSelectorOptions,
  composeSelectors,
  createCostBudgetSelector,
  createErrorRateGuardSelector,
  createLatencyBudgetSelector,
  createSafeSelector,
  createSignalTrendGuardSelector,
  createWeightedUtilitySelector,
  type ErrorRateGuardSelectorOptions,
  formatDecisionSummary,
  InvalidConfigurationError,
  type LatencyBudgetSelectorOptions,
  type SafeSelectorOptions,
  type SignalTrendGuardSelector,
  type SignalTrendGuardSelectorOptions,
  type WeightedUtilitySelectorOptions,
} from "../../src/policy/selectors.js";
import { createAdaptiveRuntime } from "../../src/runtime/runtime.js";
import type { StrategyDecision } from "../../src/types/decision.js";
import type {
  CustomPolicySelector,
  CustomSelectorCandidate,
  Policy,
} from "../../src/types/policy.js";
import type { Strategy } from "../../src/types/strategy.js";
import { FakeClock } from "../helpers/fake-clock.js";

function invalidPolicy(input: unknown): ConfigurationError {
  try {
    resolvePolicy(input as Policy);
  } catch (error) {
    assert.ok(
      error instanceof ConfigurationError,
      `expected ConfigurationError, got ${String(error)}`,
    );
    return error;
  }
  assert.fail("expected resolvePolicy to throw");
}

const mockCandidates: readonly StrategyCandidate[] = [
  { id: "fast", qualityTier: 1, costTier: 1, applicable: true },
  { id: "balanced", qualityTier: 2, costTier: 2, applicable: true },
  { id: "thorough", qualityTier: 3, costTier: 3, applicable: true },
  { id: "experimental", qualityTier: 2, costTier: 4, applicable: false },
  { id: "low-tier", qualityTier: 0, costTier: 1, applicable: true },
  { id: "high-tier", qualityTier: 5, costTier: 5, applicable: true },
];

function createInput(overrides?: Partial<PolicyEvaluationInput>): PolicyEvaluationInput {
  return {
    operationId: "test-op",
    now: 1000,
    signals: [
      {
        name: "cpu.utilization",
        unit: "ratio",
        status: "ok",
        value: 0.25,
        observedAt: 1000,
      },
    ],
    strategies: mockCandidates,
    pinnedStrategyId: null,
    adaptationEnabled: true,
    sampleSequence: 1,
    signalsCached: false,
    ...overrides,
  };
}

describe("CustomPolicySelector Hook", () => {
  describe("resolvePolicy validation", () => {
    it("defaults customSelector to null when not provided", () => {
      const resolved = resolvePolicy({});
      assert.equal(resolved.customSelector, null);
    });

    it("accepts a valid customSelector function", () => {
      const fn = () => null;
      const resolved = resolvePolicy({ customSelector: fn });
      assert.equal(resolved.customSelector, fn);
    });

    it("rejects non-function customSelector values", () => {
      assert.match(
        invalidPolicy({ customSelector: "not-a-func" }).message,
        /customSelector must be a function/,
      );
      assert.match(
        invalidPolicy({ customSelector: 123 }).message,
        /customSelector must be a function/,
      );
      assert.match(
        invalidPolicy({ customSelector: true }).message,
        /customSelector must be a function/,
      );
      assert.match(
        invalidPolicy({ customSelector: {} }).message,
        /customSelector must be a function/,
      );
      assert.match(
        invalidPolicy({ customSelector: [] }).message,
        /customSelector must be a function/,
      );
    });
  });

  describe("engine evaluation with customSelector", () => {
    it("chooses applicable candidate when customSelector returns valid strategyId and custom reason", () => {
      let inspectedOperation = "";
      let inspectedCandidateCount = 0;
      let inspectedSignalName = "";
      let inspectedNow = 0;

      const policy = resolvePolicy({
        customSelector: (ctx) => {
          inspectedOperation = ctx.operation;
          inspectedCandidateCount = ctx.candidates.length;
          inspectedSignalName = ctx.signals["cpu.utilization"]?.name ?? "";
          inspectedNow = ctx.now;
          return {
            strategyId: "fast",
            reason: "Choose fast strategy for low-latency testing.",
          };
        },
      });

      const input = createInput({ now: 2500 });
      const state = createInitialPolicyState();
      const evaluation = evaluatePolicy(state, input, policy);

      assert.equal(evaluation.decision.strategyId, "fast");
      assert.equal(evaluation.decision.kind, "initial");
      assert.equal(inspectedOperation, "test-op");
      assert.equal(inspectedCandidateCount, 5); // 5 applicable candidates
      assert.equal(inspectedSignalName, "cpu.utilization");
      assert.equal(inspectedNow, 2500);

      const customReason = evaluation.decision.reasons.find((r) => r.code === "custom-selector");
      assert.ok(customReason !== undefined);
      assert.equal(customReason?.message, "Choose fast strategy for low-latency testing.");
      assert.equal(customReason?.detail, "Choose fast strategy for low-latency testing.");
      assert.equal(customReason?.details?.strategyId, "fast");
    });

    it("uses default detail message when reason is omitted in custom selection", () => {
      const policy = resolvePolicy({
        customSelector: () => ({
          strategyId: "balanced",
        }),
      });

      const input = createInput();
      const state = createInitialPolicyState();
      const evaluation = evaluatePolicy(state, input, policy);

      assert.equal(evaluation.decision.strategyId, "balanced");
      const customReason = evaluation.decision.reasons.find((r) => r.code === "custom-selector");
      assert.ok(customReason !== undefined);
      assert.equal(customReason?.message, 'Custom policy selector chose strategy "balanced".');
      assert.equal(customReason?.detail, 'Custom policy selector chose strategy "balanced".');
    });

    it("supports string return value from customSelector", () => {
      const policy = resolvePolicy({
        customSelector: () => "thorough" as unknown as { strategyId: string },
      });

      const input = createInput();
      const state = createInitialPolicyState();
      const evaluation = evaluatePolicy(state, input, policy);

      assert.equal(evaluation.decision.strategyId, "thorough");
      const customReason = evaluation.decision.reasons.find((r) => r.code === "custom-selector");
      assert.ok(customReason !== undefined);
      assert.equal(customReason?.message, 'Custom policy selector chose strategy "thorough".');
    });

    it("falls back to default scoring when customSelector returns null", () => {
      const policy = resolvePolicy({
        customSelector: () => null,
      });

      const input = createInput();
      const state = createInitialPolicyState();
      const evaluation = evaluatePolicy(state, input, policy);

      // Default highest tier candidate is high-tier (tier 5)
      assert.equal(evaluation.decision.strategyId, "high-tier");
      const customReason = evaluation.decision.reasons.find((r) => r.code === "custom-selector");
      assert.equal(customReason, undefined);
    });

    it("falls back to default scoring when customSelector returns undefined", () => {
      const policy = resolvePolicy({
        customSelector: () => undefined,
      });

      const input = createInput();
      const state = createInitialPolicyState();
      const evaluation = evaluatePolicy(state, input, policy);

      assert.equal(evaluation.decision.strategyId, "high-tier");
      const customReason = evaluation.decision.reasons.find((r) => r.code === "custom-selector");
      assert.equal(customReason, undefined);
    });

    it("verifies candidates structure in context (candidate object and properties)", () => {
      let candidateRef: unknown = null;
      let costRef: unknown = null;
      let latencyRef: unknown = null;
      let inspectedFirstCandidate: unknown = null;

      const policy = resolvePolicy({
        customSelector: (ctx) => {
          const first = ctx.candidates[0];
          if (!first) {
            return null;
          }
          inspectedFirstCandidate = first;
          candidateRef = first.candidate;
          costRef = first.estimatedCost;
          latencyRef = first.estimatedLatencyMs;
          return { strategyId: first.candidate.id };
        },
      });

      const input = createInput();
      const state = createInitialPolicyState();
      evaluatePolicy(state, input, policy);

      assert.ok(candidateRef !== null && typeof candidateRef === "object");
      assert.equal((candidateRef as { id: string }).id, "fast");
      assert.equal(costRef, 1);
      assert.equal(latencyRef, null);
      assert.equal("id" in (inspectedFirstCandidate as object), false);
      assert.equal("qualityTier" in (inspectedFirstCandidate as object), false);
      assert.equal("costTier" in (inspectedFirstCandidate as object), false);
      assert.equal("applicable" in (inspectedFirstCandidate as object), false);
    });

    it("uses input.operation when provided in PolicyEvaluationInput", () => {
      let receivedOp = "";
      const policy = resolvePolicy({
        customSelector: (ctx) => {
          receivedOp = ctx.operation;
          return null;
        },
      });

      const input = createInput({ operation: "custom-operation-name" });
      const state = createInitialPolicyState();
      evaluatePolicy(state, input, policy);

      assert.equal(receivedOp, "custom-operation-name");
    });
  });

  describe("validation errors", () => {
    it("throws ConfigurationError when strategyId is non-existent", () => {
      const policy = resolvePolicy({
        customSelector: () => ({ strategyId: "non-existent-strategy" }),
      });

      const input = createInput();
      const state = createInitialPolicyState();

      assert.throws(
        () => evaluatePolicy(state, input, policy),
        (err: unknown) => {
          assert.ok(err instanceof ConfigurationError);
          assert.match(err.message, /not an applicable surviving candidate/);
          return true;
        },
      );
    });

    it("throws ConfigurationError when strategyId matches an inapplicable candidate", () => {
      const policy = resolvePolicy({
        // "experimental" has applicable: false
        customSelector: () => ({ strategyId: "experimental" }),
      });

      const input = createInput();
      const state = createInitialPolicyState();

      assert.throws(
        () => evaluatePolicy(state, input, policy),
        (err: unknown) => {
          assert.ok(err instanceof ConfigurationError);
          assert.match(err.message, /not an applicable surviving candidate/);
          return true;
        },
      );
    });

    it("throws ConfigurationError when strategyId is outside minQualityTier bound", () => {
      const policy = resolvePolicy({
        minQualityTier: 2,
        // "low-tier" has qualityTier: 0, which is below minQualityTier
        customSelector: () => ({ strategyId: "low-tier" }),
      });

      const input = createInput();
      const state = createInitialPolicyState();

      assert.throws(
        () => evaluatePolicy(state, input, policy),
        (err: unknown) => {
          assert.ok(err instanceof ConfigurationError);
          assert.match(err.message, /not an applicable surviving candidate/);
          return true;
        },
      );
    });

    it("throws ConfigurationError when strategyId is outside maxQualityTier bound", () => {
      const policy = resolvePolicy({
        maxQualityTier: 3,
        // "high-tier" has qualityTier: 5, which is above maxQualityTier
        customSelector: () => ({ strategyId: "high-tier" }),
      });

      const input = createInput();
      const state = createInitialPolicyState();

      assert.throws(
        () => evaluatePolicy(state, input, policy),
        (err: unknown) => {
          assert.ok(err instanceof ConfigurationError);
          assert.match(err.message, /not an applicable surviving candidate/);
          return true;
        },
      );
    });

    it("throws ConfigurationError when strategyId is empty or invalid string", () => {
      const policy = resolvePolicy({
        customSelector: () => ({ strategyId: "   " }),
      });

      const input = createInput();
      const state = createInitialPolicyState();

      assert.throws(
        () => evaluatePolicy(state, input, policy),
        (err: unknown) => {
          assert.ok(err instanceof ConfigurationError);
          assert.match(err.message, /customSelector must return a valid strategyId/);
          return true;
        },
      );
    });

    it("throws ConfigurationError when returned object has non-string strategyId", () => {
      const policy = resolvePolicy({
        customSelector: () => ({ strategyId: 123 as unknown as string }),
      });

      const input = createInput();
      const state = createInitialPolicyState();

      assert.throws(
        () => evaluatePolicy(state, input, policy),
        (err: unknown) => {
          assert.ok(err instanceof ConfigurationError);
          assert.match(err.message, /customSelector must return a valid strategyId/);
          return true;
        },
      );
    });
  });

  describe("stability and hysteresis preservation", () => {
    it("preserves minimumModeDurationMs when customSelector selects a different candidate", () => {
      let desiredStrategy = "fast";
      const policy = resolvePolicy({
        minimumModeDurationMs: 5000,
        consecutiveSamples: 1,
        customSelector: () => ({ strategyId: desiredStrategy }),
      });

      // Run 1: initial selection of "fast" at t = 1000
      const input1 = createInput({ now: 1000, sampleSequence: 1 });
      const state0 = createInitialPolicyState();
      const eval1 = evaluatePolicy(state0, input1, policy);
      assert.equal(eval1.decision.strategyId, "fast");
      assert.equal(eval1.decision.kind, "initial");

      // Run 2: customSelector changes desiredStrategy to "thorough" at t = 3000 (only 2000ms elapsed < 5000ms)
      desiredStrategy = "thorough";
      const input2 = createInput({ now: 3000, sampleSequence: 2 });
      const eval2 = evaluatePolicy(eval1.state, input2, policy);

      // Must HOLD "fast" due to minimum-mode-duration
      assert.equal(eval2.decision.strategyId, "fast");
      assert.equal(eval2.decision.kind, "retained");
      const minDurationReason = eval2.decision.reasons.find(
        (r) => r.code === "minimum-mode-duration",
      );
      assert.ok(minDurationReason !== undefined);
      assert.equal(eval2.state.pendingStrategyId, "thorough");

      // Run 3: at t = 6500 (5500ms elapsed since modeSince: 1000 >= 5000ms)
      const input3 = createInput({ now: 6500, sampleSequence: 3 });
      const eval3 = evaluatePolicy(eval2.state, input3, policy);

      // Now it switches to "thorough"
      assert.equal(eval3.decision.strategyId, "thorough");
      assert.equal(eval3.decision.kind, "adapted");
      const switchReason = eval3.decision.reasons.find((r) => r.code === "strategy-switched");
      assert.ok(switchReason !== undefined);
    });

    it("preserves candidate stability (consecutive samples) with customSelector", () => {
      let desiredStrategy = "fast";
      const policy = resolvePolicy({
        minimumModeDurationMs: 0,
        consecutiveSamples: 3,
        customSelector: () => ({ strategyId: desiredStrategy }),
      });

      // Initial selection: "fast" at t = 1000
      const input1 = createInput({ now: 1000, sampleSequence: 1 });
      const eval1 = evaluatePolicy(createInitialPolicyState(), input1, policy);
      assert.equal(eval1.decision.strategyId, "fast");

      // Change desiredStrategy to "balanced", streak 1 (needs 3)
      desiredStrategy = "balanced";
      const input2 = createInput({ now: 2000, sampleSequence: 2 });
      const eval2 = evaluatePolicy(eval1.state, input2, policy);
      assert.equal(eval2.decision.strategyId, "fast");
      assert.equal(eval2.decision.kind, "retained");
      const stabilityReason1 = eval2.decision.reasons.find((r) => r.code === "candidate-stability");
      assert.ok(stabilityReason1 !== undefined);
      assert.equal(eval2.state.pendingStreak, 1);

      // Streak 2 (needs 3)
      const input3 = createInput({ now: 3000, sampleSequence: 3 });
      const eval3 = evaluatePolicy(eval2.state, input3, policy);
      assert.equal(eval3.decision.strategyId, "fast");
      assert.equal(eval3.decision.kind, "retained");
      assert.equal(eval3.state.pendingStreak, 2);

      // Streak 3: threshold met -> switches!
      const input4 = createInput({ now: 4000, sampleSequence: 4 });
      const eval4 = evaluatePolicy(eval3.state, input4, policy);
      assert.equal(eval4.decision.strategyId, "balanced");
      assert.equal(eval4.decision.kind, "adapted");
    });
  });

  describe("end-to-end integration with createAdaptiveRuntime", () => {
    const strategies: readonly Strategy<number, number>[] = [
      {
        id: "fast",
        qualityTier: 1,
        run: ({ input }) => input * 2,
      },
      {
        id: "accurate",
        qualityTier: 3,
        run: ({ input }) => input * 3,
      },
    ];

    it("executes strategy chosen by customSelector cleanly in runtime.run()", async () => {
      const runtime = createAdaptiveRuntime({
        policy: {
          evaluationIntervalMs: 0,
          customSelector: () => ({
            strategyId: "fast",
            reason: "Preferred fast strategy in runtime test.",
          }),
        },
      });

      const result = await runtime.run({
        operationId: "math-op",
        input: 10,
        strategies,
      });

      assert.equal(result.value, 20); // 10 * 2
      assert.equal(result.metadata.strategyId, "fast");
      const decision = runtime.getDecision("math-op");
      assert.equal(decision?.strategyId, "fast");
      const reason = decision?.reasons.find((r) => r.code === "custom-selector");
      assert.ok(reason !== undefined);
      assert.equal(reason?.message, "Preferred fast strategy in runtime test.");

      await runtime.close();
    });

    it("runtime falls back to standard selection when customSelector returns null", async () => {
      const runtime = createAdaptiveRuntime({
        policy: {
          evaluationIntervalMs: 0,
          customSelector: () => null,
        },
      });

      const result = await runtime.run({
        operationId: "math-op-fallback",
        input: 10,
        strategies,
      });

      // Default highest tier is "accurate" (qualityTier 3)
      assert.equal(result.value, 30); // 10 * 3
      assert.equal(result.metadata.strategyId, "accurate");

      await runtime.close();
    });

    it("runtime surfaces ConfigurationError if customSelector returns an ineligible strategy", async () => {
      const runtime = createAdaptiveRuntime({
        policy: {
          evaluationIntervalMs: 0,
          customSelector: () => ({ strategyId: "unknown-strategy" }),
        },
      });

      await assert.rejects(
        runtime.run({
          operationId: "math-op-invalid",
          input: 10,
          strategies,
        }),
        (err: unknown) => {
          assert.ok(err instanceof ConfigurationError);
          assert.match(err.message, /not an applicable surviving candidate/);
          return true;
        },
      );

      await runtime.close();
    });

    it("enriches CustomSelectorCandidate.estimatedLatencyMs with historical strategy average duration and enables latency-based decisions", async () => {
      const recordedLatencies: (number | null)[] = [];
      const latencyStrategies: readonly Strategy<number, number>[] = [
        {
          id: "fast",
          qualityTier: 1,
          run: () => 100,
        },
        {
          id: "accurate",
          qualityTier: 2,
          run: () => 200,
        },
      ];

      // Custom selector prefers "fast" initially. If "fast" average duration exceeds 20ms, it chooses "accurate".
      const runtime = createAdaptiveRuntime({
        policy: {
          evaluationIntervalMs: 0,
          customSelector: (ctx) => {
            const fastCandidate = ctx.candidates.find((c) => c.candidate.id === "fast");
            recordedLatencies.push(fastCandidate?.estimatedLatencyMs ?? null);
            if (
              fastCandidate?.estimatedLatencyMs !== null &&
              fastCandidate?.estimatedLatencyMs !== undefined &&
              fastCandidate.estimatedLatencyMs > 20
            ) {
              return {
                strategyId: "accurate",
                reason: "Fast strategy exceeded 20ms average latency threshold.",
              };
            }
            return {
              strategyId: "fast",
              reason: "Fast strategy within acceptable latency or untracked.",
            };
          },
        },
      });

      // Run 1: No previous history, estimatedLatencyMs must be null (not 0!)
      const res1 = await runtime.run({
        operationId: "latency-op",
        input: 1,
        strategies: latencyStrategies,
      });
      assert.equal(res1.metadata.strategyId, "fast");
      assert.equal(recordedLatencies[0], null);

      // Now fast strategy has 1 sample in stats. Let's inspect runtime stats
      const statsAfterRun1 = runtime.getStats("latency-op");
      assert.equal(statsAfterRun1.strategies.fast?.runs, 1);
      assert.equal(statsAfterRun1.strategies.fast?.successes, 1);
      assert.ok(statsAfterRun1.strategies.fast?.averageDurationMs !== null);

      // Run 2: fast strategy has recorded latency
      await runtime.run({
        operationId: "latency-op",
        input: 2,
        strategies: latencyStrategies,
      });
      assert.equal(recordedLatencies.length, 2);
      assert.ok(recordedLatencies[1] !== null);
      assert.equal(typeof recordedLatencies[1], "number");

      await runtime.close();
    });

    it("verifies estimatedLatencyMs reflects multi-run duration averages cleanly with FakeClock", async () => {
      const clock = new FakeClock();
      let lastObservedLatencyFast: number | null | undefined;
      let lastObservedLatencyAccurate: number | null | undefined;

      const dynamicStrategies: readonly Strategy<number, number>[] = [
        {
          id: "strat-a",
          qualityTier: 1,
          run: () => {
            clock.advance(30);
            return 1;
          },
        },
        {
          id: "strat-b",
          qualityTier: 2,
          run: () => {
            clock.advance(10);
            return 2;
          },
        },
      ];

      const runtime = createAdaptiveRuntime({
        clock,
        policy: {
          evaluationIntervalMs: 0,
          customSelector: (ctx) => {
            const candA = ctx.candidates.find((c) => c.candidate.id === "strat-a");
            const candB = ctx.candidates.find((c) => c.candidate.id === "strat-b");
            lastObservedLatencyFast = candA?.estimatedLatencyMs;
            lastObservedLatencyAccurate = candB?.estimatedLatencyMs;
            // Select candidate with lowest estimated latency when available
            if (
              candA?.estimatedLatencyMs !== null &&
              candB?.estimatedLatencyMs !== null &&
              candA?.estimatedLatencyMs !== undefined &&
              candB?.estimatedLatencyMs !== undefined
            ) {
              return candA.estimatedLatencyMs <= candB.estimatedLatencyMs ? "strat-a" : "strat-b";
            }
            return "strat-a";
          },
        },
      });

      // Run 1: both null initially
      await runtime.run({ operationId: "dyn-op", input: 1, strategies: dynamicStrategies });
      assert.equal(lastObservedLatencyFast, null);
      assert.equal(lastObservedLatencyAccurate, null);

      // Run 2: strat-a ran for 30ms -> strat-a avg is 30ms, strat-b is null
      await runtime.run({ operationId: "dyn-op", input: 2, strategies: dynamicStrategies });
      assert.equal(lastObservedLatencyFast, 30);
      assert.equal(lastObservedLatencyAccurate, null);

      // Now pin strat-b to generate history for strat-b
      runtime.pinStrategy("dyn-op", "strat-b");
      await runtime.run({ operationId: "dyn-op", input: 3, strategies: dynamicStrategies }); // strat-b runs for 10ms
      runtime.unpinStrategy("dyn-op");

      // Run 4: customSelector observes strat-a: 30ms, strat-b: 10ms -> should choose strat-b!
      const res4 = await runtime.run({
        operationId: "dyn-op",
        input: 4,
        strategies: dynamicStrategies,
      });
      assert.equal(lastObservedLatencyFast, 30);
      assert.equal(lastObservedLatencyAccurate, 10);
      assert.equal(res4.metadata.strategyId, "strat-b");

      await runtime.close();
    });
  });
});

describe("Built-in Policy Selectors and formatDecisionSummary", () => {
  const cand = (
    id: string,
    qualityTier: number,
    costTier: number,
    errorRate: number | null = null,
    estimatedLatencyMs: number | null = null,
    samples?: number | null,
    ewmaLatencyMs?: number | null,
    lastLatencyMs?: number | null,
    ewmaErrorRate?: number | null,
  ): CustomSelectorCandidate => ({
    candidate: { id, qualityTier, costTier, applicable: true },
    estimatedCost: costTier,
    estimatedLatencyMs,
    errorRate,
    samples,
    ewmaLatencyMs,
    ...(lastLatencyMs !== undefined ? { lastLatencyMs } : {}),
    ...(ewmaErrorRate !== undefined ? { ewmaErrorRate } : {}),
  });

  describe("createErrorRateGuardSelector", () => {
    it("validates input options", () => {
      assert.throws(
        () => createErrorRateGuardSelector(null as unknown as ErrorRateGuardSelectorOptions),
        ConfigurationError,
      );
      assert.throws(
        () => createErrorRateGuardSelector("invalid" as unknown as ErrorRateGuardSelectorOptions),
        ConfigurationError,
      );
      assert.throws(
        () => createErrorRateGuardSelector({ maxErrorRate: "0.1" as unknown as number }),
        ConfigurationError,
      );
      assert.throws(() => createErrorRateGuardSelector({ maxErrorRate: -0.1 }), ConfigurationError);
      assert.throws(() => createErrorRateGuardSelector({ maxErrorRate: 1.1 }), ConfigurationError);
      assert.throws(
        () => createErrorRateGuardSelector({ maxErrorRate: Number.NaN }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          createErrorRateGuardSelector({
            maxErrorRate: 0.5,
            fallbackSelector: "invalid" as unknown as CustomPolicySelector,
          }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          createErrorRateGuardSelector({
            maxErrorRate: 0.5,
            minSamples: 0,
          }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          createErrorRateGuardSelector({
            maxErrorRate: 0.5,
            minSamples: -2,
          }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          createErrorRateGuardSelector({
            maxErrorRate: 0.5,
            minSamples: 1.5,
          }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          createErrorRateGuardSelector({
            maxErrorRate: 0.5,
            minSamples: "5" as unknown as number,
          }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          createErrorRateGuardSelector({
            maxErrorRate: 0.5,
            minSamples: Number.NaN,
          }),
        ConfigurationError,
      );
    });

    it("returns null when candidates are empty", () => {
      const selector = createErrorRateGuardSelector({ maxErrorRate: 0.1 });
      const result = selector({
        operation: "test",
        candidates: [],
        signals: {},
        now: 1000,
      });
      assert.equal(result, null);
    });

    it("filters out candidates exceeding maxErrorRate and selects best remaining", () => {
      const selector = createErrorRateGuardSelector({ maxErrorRate: 0.1 });
      const cands = [
        cand("high-broken", 3, 3, 0.5),
        cand("mid-ok", 2, 2, 0.05),
        cand("low-ok", 1, 1, 0.0),
      ];
      const result = selector({
        operation: "test",
        candidates: cands,
        signals: {},
        now: 1000,
      });
      assert.ok(typeof result === "object" && result !== null);
      assert.equal(result.strategyId, "mid-ok");
      assert.ok(result.reason?.includes("error-rate-guard"));
    });

    it("supports boundary 0% and 100% maxErrorRate and null errorRate", () => {
      const strict = createErrorRateGuardSelector({ maxErrorRate: 0 });
      const cands = [
        cand("unmeasured", 3, 2, null),
        cand("zero-error", 2, 1, 0.0),
        cand("tiny-error", 1, 1, 0.01),
      ];
      const resStrict = strict({
        operation: "test",
        candidates: cands,
        signals: {},
        now: 1000,
      });
      assert.equal(typeof resStrict === "object" ? resStrict?.strategyId : resStrict, "unmeasured");

      const relaxed = createErrorRateGuardSelector({ maxErrorRate: 1.0 });
      const resRelaxed = relaxed({
        operation: "test",
        candidates: [cand("fail-heavy", 3, 1, 1.0), cand("safe", 2, 1, 0.0)],
        signals: {},
        now: 1000,
      });
      assert.equal(
        typeof resRelaxed === "object" ? resRelaxed?.strategyId : resRelaxed,
        "fail-heavy",
      );
    });

    it("chains to fallbackSelector when provided and eligible candidates exist", () => {
      let delegatedCandidatesCount = 0;
      const selector = createErrorRateGuardSelector({
        maxErrorRate: 0.2,
        fallbackSelector: (ctx) => {
          delegatedCandidatesCount = ctx.candidates.length;
          return { strategyId: "delegated-strat", reason: "custom fallback" };
        },
      });

      const cands = [cand("a", 2, 2, 0.1), cand("b", 1, 1, 0.05), cand("c", 3, 3, 0.8)];
      const result = selector({
        operation: "test",
        candidates: cands,
        signals: {},
        now: 1000,
      });
      assert.equal(delegatedCandidatesCount, 2);
      assert.ok(typeof result === "object" && result !== null);
      assert.equal(result.strategyId, "delegated-strat");
      assert.equal(result.reason, "custom fallback");
    });

    it("falls back to default sorting if fallbackSelector returns null or undefined", () => {
      const selectorNull = createErrorRateGuardSelector({
        maxErrorRate: 0.2,
        fallbackSelector: () => null,
      });
      const selectorUndef = createErrorRateGuardSelector({
        maxErrorRate: 0.2,
        fallbackSelector: () => undefined,
      });
      const cands = [cand("strat-low", 1, 1, 0.1), cand("strat-high", 2, 1, 0.1)];
      const resNull = selectorNull({
        operation: "test",
        candidates: cands,
        signals: {},
        now: 1000,
      });
      const resUndef = selectorUndef({
        operation: "test",
        candidates: cands,
        signals: {},
        now: 1000,
      });
      assert.ok(typeof resNull === "object" && resNull !== null);
      assert.equal(resNull.strategyId, "strat-high");
      assert.ok(typeof resUndef === "object" && resUndef !== null);
      assert.equal(resUndef.strategyId, "strat-high");
    });

    it("selects lowest errorRate candidate when all candidates exceed maxErrorRate", () => {
      const selector = createErrorRateGuardSelector({ maxErrorRate: 0.1 });
      const cands = [cand("terrible", 3, 1, 0.9), cand("bad", 2, 1, 0.4), cand("worse", 1, 1, 0.6)];
      const result = selector({
        operation: "test",
        candidates: cands,
        signals: {},
        now: 1000,
      });
      assert.ok(typeof result === "object" && result !== null);
      assert.equal(result.strategyId, "bad");
      assert.ok(result.reason?.includes("all candidates exceeded"));
    });

    it("breaks ties by code-unit id comparison when quality, cost and error rate match", () => {
      const selector = createErrorRateGuardSelector({ maxErrorRate: 0.5 });
      const cands = [cand("beta", 2, 1, 0.1), cand("alpha", 2, 1, 0.1)];
      const result = selector({
        operation: "test",
        candidates: cands,
        signals: {},
        now: 1000,
      });
      assert.ok(typeof result === "object" && result !== null);
      assert.equal(result.strategyId, "alpha");
    });

    it("prevents premature disqualification of cold-start candidates where candidate samples < minSamples", () => {
      const selector = createErrorRateGuardSelector({ maxErrorRate: 0.1, minSamples: 5 });
      const cands = [
        cand("cold-start-high", 3, 2, 0.5, null, 2), // 2 samples < 5 -> protected!
        cand("mature-low", 1, 1, 0.05, null, 10), // mature within budget
      ];
      const result = selector({
        operation: "test",
        candidates: cands,
        signals: {},
        now: 1000,
      });
      assert.ok(typeof result === "object" && result !== null);
      assert.equal(result.strategyId, "cold-start-high");
      assert.equal(
        result.reason,
        'error-rate-guard: selected cold-start strategy "cold-start-high" with errorRate 0.5 (samples < minSamples 5)',
      );
    });

    it("disqualifies candidate when samples >= minSamples and errorRate > maxErrorRate", () => {
      const selector = createErrorRateGuardSelector({ maxErrorRate: 0.1, minSamples: 5 });
      const cands = [
        cand("mature-failing", 3, 2, 0.5, null, 6), // 6 samples >= 5 -> disqualified!
        cand("mature-ok", 2, 2, 0.05, null, 10), // mature within budget
      ];
      const result = selector({
        operation: "test",
        candidates: cands,
        signals: {},
        now: 1000,
      });
      assert.ok(typeof result === "object" && result !== null);
      assert.equal(result.strategyId, "mature-ok");
      assert.equal(
        result.reason,
        'error-rate-guard: selected strategy "mature-ok" with errorRate 0.05 <= 0.1',
      );
    });

    it("resolves sample count from sampleCount or runs property when samples is absent", () => {
      const selector = createErrorRateGuardSelector({ maxErrorRate: 0.1, minSamples: 10 });
      const candSampleCount = {
        candidate: { id: "via-sampleCount", qualityTier: 3, costTier: 1, applicable: true },
        estimatedCost: 1,
        estimatedLatencyMs: null,
        errorRate: 0.8,
        sampleCount: 3,
      } as unknown as CustomSelectorCandidate;
      const candRuns = {
        candidate: { id: "via-runs", qualityTier: 2, costTier: 1, applicable: true },
        estimatedCost: 1,
        estimatedLatencyMs: null,
        errorRate: 0.8,
        runs: 2,
      } as unknown as CustomSelectorCandidate;

      const result = selector({
        operation: "test",
        candidates: [candSampleCount, candRuns],
        signals: {},
        now: 1000,
      });
      assert.ok(typeof result === "object" && result !== null);
      assert.equal(result.strategyId, "via-sampleCount");
      assert.match(result.reason ?? "", /samples < minSamples 10/);
    });

    it("breaks ties by quality and cost when all candidates exceed maxErrorRate with identical error rates", () => {
      const selector = createErrorRateGuardSelector({ maxErrorRate: 0.1 });
      const cands = [cand("tie-low", 1, 1, 0.5), cand("tie-high", 3, 2, 0.5)];
      const result = selector({ operation: "test", candidates: cands, signals: {}, now: 1000 });
      assert.ok(typeof result === "object" && result !== null);
      assert.equal(result.strategyId, "tie-high");
    });

    it("treats negative samples or non-finite runs as null (unmeasured)", () => {
      const selector = createErrorRateGuardSelector({ maxErrorRate: 0.1, minSamples: 3 });
      const cands = [cand("cand-neg", 2, 1, 0.05, null, -5)];
      const result = selector({ operation: "test", candidates: cands, signals: {}, now: 1000 });
      assert.ok(typeof result === "object" && result !== null);
      assert.equal(result.strategyId, "cand-neg");
    });

    it("treats non-finite runs or sampleCount as null (unmeasured)", () => {
      const selector = createErrorRateGuardSelector({ maxErrorRate: 0.1, minSamples: 3 });
      const cands = [
        {
          candidate: { id: "inf-runs", qualityTier: 2, costTier: 1, applicable: true },
          estimatedCost: 1,
          estimatedLatencyMs: null,
          errorRate: 0.05,
          runs: Number.POSITIVE_INFINITY,
        } as unknown as CustomSelectorCandidate,
      ];
      const result = selector({ operation: "test", candidates: cands, signals: {}, now: 1000 });
      assert.ok(typeof result === "object" && result !== null);
      assert.equal(result.strategyId, "inf-runs");
    });

    it("treats undefined errorRate as eligible in error-rate-guard", () => {
      const selector = createErrorRateGuardSelector({ maxErrorRate: 0.1 });
      const cands = [cand("cand-undef-rate", 2, 1, undefined as unknown as null)];
      const result = selector({ operation: "test", candidates: cands, signals: {}, now: 1000 });
      assert.ok(typeof result === "object" && result !== null);
      assert.equal(result.strategyId, "cand-undef-rate");
    });
  });

  describe("createLatencyBudgetSelector", () => {
    it("validates input options", () => {
      assert.throws(
        () => createLatencyBudgetSelector(null as unknown as LatencyBudgetSelectorOptions),
        ConfigurationError,
      );
      assert.throws(
        () => createLatencyBudgetSelector("invalid" as unknown as LatencyBudgetSelectorOptions),
        ConfigurationError,
      );
      assert.throws(
        () => createLatencyBudgetSelector({ maxLatencyMs: "50" as unknown as number }),
        ConfigurationError,
      );
      assert.throws(() => createLatencyBudgetSelector({ maxLatencyMs: 0 }), ConfigurationError);
      assert.throws(() => createLatencyBudgetSelector({ maxLatencyMs: -5 }), ConfigurationError);
      assert.throws(
        () => createLatencyBudgetSelector({ maxLatencyMs: Number.NaN }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          createLatencyBudgetSelector({
            maxLatencyMs: 50,
            fallbackSelector: "invalid" as unknown as CustomPolicySelector,
          }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          createLatencyBudgetSelector({
            maxLatencyMs: 50,
            useEwma: "true" as unknown as boolean,
          }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          createLatencyBudgetSelector({
            maxLatencyMs: 50,
            useEwma: 123 as unknown as boolean,
          }),
        ConfigurationError,
      );
    });

    it("returns null when candidates are empty", () => {
      const selector = createLatencyBudgetSelector({ maxLatencyMs: 50 });
      const result = selector({
        operation: "test",
        candidates: [],
        signals: {},
        now: 1000,
      });
      assert.equal(result, null);
    });

    it("treats null estimatedLatencyMs as eligible and selects highest quality by default", () => {
      const selector = createLatencyBudgetSelector({ maxLatencyMs: 50 });
      const cands = [
        cand("unmeasured", 3, 3, null, null),
        cand("fast", 2, 1, null, 20),
        cand("too-slow", 3, 2, null, 80),
      ];
      const result = selector({
        operation: "test",
        candidates: cands,
        signals: {},
        now: 1000,
      });
      assert.ok(typeof result === "object" && result !== null);
      assert.equal(result.strategyId, "unmeasured");
      assert.ok(result.reason?.includes("within budget"));
    });

    it("supports preferLowestCost option", () => {
      const qualityFirst = createLatencyBudgetSelector({ maxLatencyMs: 50 });
      const costFirst = createLatencyBudgetSelector({ maxLatencyMs: 50, preferLowestCost: true });

      const cands = [cand("high-cost", 3, 3, null, 25), cand("cheap-low-quality", 1, 1, null, 20)];
      const resQ = qualityFirst({ operation: "test", candidates: cands, signals: {}, now: 1000 });
      const resC = costFirst({ operation: "test", candidates: cands, signals: {}, now: 1000 });

      assert.equal(typeof resQ === "object" ? resQ?.strategyId : resQ, "high-cost");
      assert.equal(typeof resC === "object" ? resC?.strategyId : resC, "cheap-low-quality");
    });

    it("selects lowest latency candidate when all exceed maxLatencyMs and breaks ties", () => {
      const selector = createLatencyBudgetSelector({ maxLatencyMs: 50 });
      const cands = [
        cand("slow", 3, 1, null, 120),
        cand("moderate-b", 2, 2, null, 65),
        cand("moderate-a", 2, 1, null, 65), // lower cost wins tie
        cand("very-slow", 1, 1, null, 200),
      ];
      const result = selector({
        operation: "test",
        candidates: cands,
        signals: {},
        now: 1000,
      });
      assert.ok(typeof result === "object" && result !== null);
      assert.equal(result.strategyId, "moderate-a");
      assert.ok(result.reason?.includes("all candidates exceeded budget"));
    });

    it("breaks ties in preferLowestCost when cost is identical but quality differs", () => {
      const costFirst = createLatencyBudgetSelector({ maxLatencyMs: 50, preferLowestCost: true });
      const cands = [cand("cheap-low", 1, 1, null, 20), cand("cheap-high", 3, 1, null, 20)];
      const res = costFirst({ operation: "test", candidates: cands, signals: {}, now: 1000 });
      assert.equal(typeof res === "object" ? res?.strategyId : res, "cheap-high");
    });

    it("breaks ties by code-unit id when quality and cost are identical", () => {
      const selector = createLatencyBudgetSelector({ maxLatencyMs: 50 });
      const cands = [cand("strat-z", 2, 1, null, 20), cand("strat-a", 2, 1, null, 20)];
      const res = selector({ operation: "test", candidates: cands, signals: {}, now: 1000 });
      assert.equal(typeof res === "object" ? res?.strategyId : res, "strat-a");
    });

    it("chains to fallbackSelector when provided and candidates within budget exist", () => {
      let delegatedCount = 0;
      const selector = createLatencyBudgetSelector({
        maxLatencyMs: 50,
        fallbackSelector: (ctx) => {
          delegatedCount = ctx.candidates.length;
          return { strategyId: "delegated-choice", reason: "custom budget fallback" };
        },
      });

      const cands = [
        cand("fast", 1, 1, null, 20),
        cand("mid", 2, 2, null, 40),
        cand("slow", 3, 3, null, 100),
      ];
      const res = selector({ operation: "test", candidates: cands, signals: {}, now: 1000 });
      assert.equal(delegatedCount, 2);
      assert.ok(typeof res === "object" && res !== null);
      assert.equal(res.strategyId, "delegated-choice");
      assert.equal(res.reason, "custom budget fallback");
    });

    it("falls back to default latency sorting if fallbackSelector returns null or undefined", () => {
      const selectorNull = createLatencyBudgetSelector({
        maxLatencyMs: 50,
        fallbackSelector: () => null,
      });
      const selectorUndef = createLatencyBudgetSelector({
        maxLatencyMs: 50,
        fallbackSelector: () => undefined,
      });

      const cands = [cand("fast", 1, 1, null, 20), cand("high-quality", 3, 2, null, 30)];
      const resNull = selectorNull({
        operation: "test",
        candidates: cands,
        signals: {},
        now: 1000,
      });
      const resUndef = selectorUndef({
        operation: "test",
        candidates: cands,
        signals: {},
        now: 1000,
      });
      assert.ok(typeof resNull === "object" && resNull !== null);
      assert.equal(resNull.strategyId, "high-quality");
      assert.ok(typeof resUndef === "object" && resUndef !== null);
      assert.equal(resUndef.strategyId, "high-quality");
    });

    it("does not invoke fallbackSelector when all candidates exceed budget", () => {
      let fallbackInvoked = false;
      const selector = createLatencyBudgetSelector({
        maxLatencyMs: 50,
        fallbackSelector: () => {
          fallbackInvoked = true;
          return { strategyId: "should-not-be-called" };
        },
      });

      const cands = [cand("over1", 2, 1, null, 80), cand("over2", 1, 1, null, 60)];
      const res = selector({ operation: "test", candidates: cands, signals: {}, now: 1000 });
      assert.equal(fallbackInvoked, false);
      assert.ok(typeof res === "object" && res !== null);
      assert.equal(res.strategyId, "over2"); // lowest latency over budget
    });

    it("evaluates candidates using ewmaLatencyMs when useEwma is true", () => {
      const selector = createLatencyBudgetSelector({ maxLatencyMs: 50, useEwma: true });
      const cands = [
        // strat-a: estimated is 100 (over budget), but EWMA is 30 (within budget)
        cand("strat-a", 2, 2, null, 100, null, 30),
        // strat-b: estimated is 20 (within budget), but EWMA is 80 (over budget)
        cand("strat-b", 3, 3, null, 20, null, 80),
      ];
      const res = selector({ operation: "test", candidates: cands, signals: {}, now: 1000 });
      assert.ok(typeof res === "object" && res !== null);
      assert.equal(res.strategyId, "strat-a");
      assert.equal(
        res.reason,
        'latency-budget: selected strategy "strat-a" within budget 50ms (latency=30ms)',
      );
    });

    it("treats null ewmaLatencyMs as unmeasured when useEwma is true", () => {
      const selector = createLatencyBudgetSelector({ maxLatencyMs: 50, useEwma: true });
      const cands = [
        cand("unmeasured-ewma", 3, 1, null, 20, null, null),
        cand("measured-ewma", 2, 1, null, 20, null, 40),
      ];
      const res = selector({ operation: "test", candidates: cands, signals: {}, now: 1000 });
      assert.ok(typeof res === "object" && res !== null);
      assert.equal(res.strategyId, "unmeasured-ewma");
      assert.equal(
        res.reason,
        'latency-budget: selected strategy "unmeasured-ewma" within budget 50ms (latency=unmeasuredms)',
      );
    });

    it("selects lowest ewmaLatencyMs candidate when all exceed budget under useEwma: true", () => {
      const selector = createLatencyBudgetSelector({ maxLatencyMs: 50, useEwma: true });
      const cands = [
        cand("slow-ewma", 3, 1, null, 10, null, 120),
        cand("moderate-ewma", 2, 1, null, 10, null, 70),
      ];
      const res = selector({ operation: "test", candidates: cands, signals: {}, now: 1000 });
      assert.ok(typeof res === "object" && res !== null);
      assert.equal(res.strategyId, "moderate-ewma");
      assert.equal(
        res.reason,
        'latency-budget: all candidates exceeded budget 50ms; selected candidate "moderate-ewma" with lowest latency 70ms',
      );
    });

    it("handles identical id, quality, and cost tiers returning 0 in comparator", () => {
      const selector = createLatencyBudgetSelector({ maxLatencyMs: 50, preferLowestCost: true });
      const cands = [cand("same-id", 2, 1, null, 20), cand("same-id", 2, 1, null, 20)];
      const result = selector({ operation: "test", candidates: cands, signals: {}, now: 1000 });
      assert.ok(typeof result === "object" && result !== null);
      assert.equal(result.strategyId, "same-id");
    });

    it("breaks ties by cost when preferLowestCost is true and all exceed budget", () => {
      const selector = createLatencyBudgetSelector({ maxLatencyMs: 50, preferLowestCost: true });
      const cands = [cand("over-expensive", 3, 3, null, 100), cand("over-cheap", 2, 1, null, 100)];
      const result = selector({ operation: "test", candidates: cands, signals: {}, now: 1000 });
      assert.ok(typeof result === "object" && result !== null);
      assert.equal(result.strategyId, "over-cheap");
    });

    it("treats non-finite estimatedLatencyMs or ewmaLatencyMs as null (unmeasured)", () => {
      const selector = createLatencyBudgetSelector({ maxLatencyMs: 50 });
      const cands = [
        cand("nan-latency", 2, 1, null, Number.NaN),
        cand("valid-latency", 1, 1, null, 40),
      ];
      const result = selector({ operation: "test", candidates: cands, signals: {}, now: 1000 });
      assert.ok(typeof result === "object" && result !== null);
      assert.equal(result.strategyId, "nan-latency"); // unmeasured gets selected due to higher quality
    });

    it("treats non-finite ewmaLatencyMs as unmeasured when useEwma is true", () => {
      const selector = createLatencyBudgetSelector({ maxLatencyMs: 50, useEwma: true });
      const cands = [
        cand("inf-ewma", 2, 1, null, 10, null, Number.POSITIVE_INFINITY),
        cand("normal", 1, 1, null, 10, null, 30),
      ];
      const result = selector({ operation: "test", candidates: cands, signals: {}, now: 1000 });
      assert.ok(typeof result === "object" && result !== null);
      assert.equal(result.strategyId, "inf-ewma"); // inf is treated as null (unmeasured), higher quality wins
    });
  });

  describe("composeSelectors", () => {
    it("validates input selectors array", () => {
      assert.throws(
        () => composeSelectors(null as unknown as CustomPolicySelector[]),
        (err: unknown) =>
          err instanceof ConfigurationError && err.message.includes("selectors must be an array"),
      );
      assert.throws(
        () => composeSelectors(undefined as unknown as CustomPolicySelector[]),
        (err: unknown) =>
          err instanceof ConfigurationError && err.message.includes("selectors must be an array"),
      );
      assert.throws(
        () => composeSelectors("not-an-array" as unknown as CustomPolicySelector[]),
        (err: unknown) =>
          err instanceof ConfigurationError && err.message.includes("selectors must be an array"),
      );
      assert.throws(
        () => composeSelectors([]),
        (err: unknown) =>
          err instanceof ConfigurationError && err.message.includes("selectors must not be empty"),
      );
      assert.throws(
        () => composeSelectors([() => null, "invalid" as unknown as CustomPolicySelector]),
        (err: unknown) =>
          err instanceof ConfigurationError &&
          err.message.includes("Selector at index 1 must be a function"),
      );
    });

    it("returns null when candidates are empty", () => {
      let firstCalled = false;
      const selector = composeSelectors([
        () => {
          firstCalled = true;
          return { strategyId: "fast" };
        },
      ]);
      const res = selector({ operation: "test", candidates: [], signals: {}, now: 1000 });
      assert.equal(res, null);
      assert.equal(firstCalled, false);
    });

    it("evaluates pipeline in sequential order and short-circuits on first decision", () => {
      const callLog: string[] = [];
      const selA: CustomPolicySelector = () => {
        callLog.push("A");
        return null;
      };
      const selB: CustomPolicySelector = () => {
        callLog.push("B");
        return { strategyId: "strat-b", reason: "chosen by B" };
      };
      const selC: CustomPolicySelector = () => {
        callLog.push("C");
        return { strategyId: "strat-c" };
      };

      const composed = composeSelectors([selA, selB, selC]);
      const cands = [cand("strat-b", 2, 1), cand("strat-c", 3, 1)];
      const res = composed({ operation: "test", candidates: cands, signals: {}, now: 1000 });

      assert.deepEqual(callLog, ["A", "B"]);
      assert.ok(typeof res === "object" && res !== null);
      assert.equal(res.strategyId, "strat-b");
      assert.equal(res.reason, "chosen by B");
    });

    it("returns null if all selectors return null or undefined", () => {
      const composed = composeSelectors([() => null, () => undefined]);
      const cands = [cand("strat-1", 1, 1)];
      const res = composed({ operation: "test", candidates: cands, signals: {}, now: 1000 });
      assert.equal(res, null);
    });

    it("supports string return value from selector in pipeline", () => {
      const composed = composeSelectors([() => "strat-direct"]);
      const cands = [cand("strat-direct", 1, 1)];
      const res = composed({ operation: "test", candidates: cands, signals: {}, now: 1000 });
      assert.equal(res, "strat-direct");
    });

    it("creates defensive copy of selectors array preventing external mutation", () => {
      const mutableArray: CustomPolicySelector[] = [() => ({ strategyId: "initial-choice" })];
      const composed = composeSelectors(mutableArray);
      mutableArray.push(() => ({ strategyId: "mutated-choice" }));
      mutableArray[0] = () => ({ strategyId: "replaced-choice" });

      const cands = [cand("initial-choice", 1, 1)];
      const res = composed({ operation: "test", candidates: cands, signals: {}, now: 1000 });
      assert.ok(typeof res === "object" && res !== null);
      assert.equal(res.strategyId, "initial-choice");
    });

    it("seamlessly chains error-rate-guard with latency-budget in an end-to-end policy", () => {
      const composed = composeSelectors([
        createErrorRateGuardSelector({ maxErrorRate: 0.1 }),
        createLatencyBudgetSelector({ maxLatencyMs: 50 }),
      ]);

      const policy = resolvePolicy({ customSelector: composed });
      const state = createInitialPolicyState();
      const input = createInput({
        strategies: [{ id: "fast", qualityTier: 2, costTier: 1, applicable: true }],
      });
      const evalResult = evaluatePolicy(state, input, policy);
      assert.equal(evalResult.decision.strategyId, "fast");
    });

    it("is re-exported from policy barrel src/policy/index.js", async () => {
      const policyModule = await import("../../src/policy/index.js");
      assert.equal(typeof policyModule.composeSelectors, "function");
      assert.equal(policyModule.composeSelectors, composeSelectors);
    });
  });

  describe("formatDecisionSummary", () => {
    it("formats complete decision with budgets and reasons into structured single line", () => {
      const decision: StrategyDecision = {
        operationId: "search-op",
        strategyId: "fast",
        qualityTier: 1,
        previousStrategyId: "thorough",
        changed: true,
        kind: "adapted",
        decidedAt: 1000,
        modeSince: 500,
        baseQualityTier: 3,
        targetQualityTier: 1,
        signals: [{ name: "cpu.utilization", status: "ok", value: 0.9 }],
        budgets: [
          {
            id: "heap",
            signal: "node.heap.used",
            engaged: true,
            status: "ok",
            limit: 100,
            recoverBelow: 80,
            tierReduction: 1,
          },
        ],
        reasons: [
          { code: "quality-pressure", message: "pressure" },
          { code: "strategy-switched", message: "switched" },
        ],
        sampleSequence: 1,
        signalsCached: false,
      };

      const summary = formatDecisionSummary(decision);
      assert.equal(
        summary,
        '[search-op] strategy="fast" tier=1/3 kind=adapted changed=true budgets=heap(engaged) reasons=quality-pressure,strategy-switched',
      );
    });

    it("handles empty budgets and empty reasons with 'none'", () => {
      const decision: StrategyDecision = {
        operationId: "static-op",
        strategyId: "baseline",
        qualityTier: 2,
        previousStrategyId: null,
        changed: false,
        kind: "initial",
        decidedAt: 1000,
        modeSince: 1000,
        baseQualityTier: 2,
        targetQualityTier: 2,
        signals: [],
        budgets: [],
        reasons: [],
        sampleSequence: null,
        signalsCached: false,
      };

      const summary = formatDecisionSummary(decision);
      assert.equal(
        summary,
        '[static-op] strategy="baseline" tier=2/2 kind=initial changed=false budgets=none reasons=none',
      );
    });

    it("formats unengaged budget using its status string", () => {
      const decision: StrategyDecision = {
        operationId: "unengaged-op",
        strategyId: "fast",
        qualityTier: 1,
        previousStrategyId: null,
        changed: false,
        kind: "initial",
        decidedAt: 1000,
        modeSince: 1000,
        baseQualityTier: 1,
        targetQualityTier: 1,
        signals: [],
        budgets: [
          {
            id: "cpu",
            signal: "cpu.utilization",
            engaged: false,
            status: "ok",
            limit: 0.8,
            recoverBelow: 0.6,
            tierReduction: 1,
          },
        ],
        reasons: [{ code: "initial-selection", message: "ok" }],
        sampleSequence: 1,
        signalsCached: false,
      };

      const summary = formatDecisionSummary(decision);
      assert.equal(
        summary,
        '[unengaged-op] strategy="fast" tier=1/1 kind=initial changed=false budgets=cpu(ok) reasons=initial-selection',
      );
    });
  });

  describe("createCostBudgetSelector", () => {
    it("validates input options strictly", () => {
      assert.throws(
        () => createCostBudgetSelector(null as unknown as CostBudgetSelectorOptions),
        InvalidConfigurationError,
      );
      assert.throws(
        () => createCostBudgetSelector(undefined as unknown as CostBudgetSelectorOptions),
        ConfigurationError,
      );
      assert.throws(
        () => createCostBudgetSelector("not-an-object" as unknown as CostBudgetSelectorOptions),
        InvalidConfigurationError,
      );
      assert.throws(
        () => createCostBudgetSelector(123 as unknown as CostBudgetSelectorOptions),
        InvalidConfigurationError,
      );
      assert.throws(
        () => createCostBudgetSelector([] as unknown as CostBudgetSelectorOptions),
        InvalidConfigurationError,
      );
      assert.throws(
        () => createCostBudgetSelector({ maxCostTier: "2" as unknown as number }),
        InvalidConfigurationError,
      );
      assert.throws(
        () => createCostBudgetSelector({ maxCostTier: Number.NaN }),
        InvalidConfigurationError,
      );
      assert.throws(
        () => createCostBudgetSelector({ maxCostTier: Number.POSITIVE_INFINITY }),
        InvalidConfigurationError,
      );
      assert.throws(
        () => createCostBudgetSelector({ maxCostTier: Number.NEGATIVE_INFINITY }),
        InvalidConfigurationError,
      );
      assert.throws(
        () =>
          createCostBudgetSelector({
            maxCostTier: 2,
            preferLowestLatency: "yes" as unknown as boolean,
          }),
        InvalidConfigurationError,
      );
      assert.throws(
        () =>
          createCostBudgetSelector({
            maxCostTier: 2,
            useEwma: 1 as unknown as boolean,
          }),
        InvalidConfigurationError,
      );
      assert.throws(
        () =>
          createCostBudgetSelector({
            maxCostTier: 2,
            fallbackSelector: "invalid" as unknown as CustomPolicySelector,
          }),
        InvalidConfigurationError,
      );
    });

    it("returns null when candidates are empty", () => {
      const selector = createCostBudgetSelector({ maxCostTier: 2 });
      const res = selector({ operation: "test", candidates: [], signals: {}, now: 1000 });
      assert.equal(res, null);
    });

    it("filters candidates within budget and selects highest quality tier by default", () => {
      const selector = createCostBudgetSelector({ maxCostTier: 2 });
      const cands = [
        cand("too-expensive", 5, 3), // costTier 3 > 2
        cand("high-quality", 4, 2), // costTier 2 <= 2
        cand("medium-quality", 3, 1), // costTier 1 <= 2
        cand("low-quality", 1, 0), // costTier 0 <= 2
      ];

      const res = selector({ operation: "test", candidates: cands, signals: {}, now: 1000 });
      assert.ok(typeof res === "object" && res !== null);
      assert.equal(res.strategyId, "high-quality");
      assert.equal(
        res.reason,
        'cost-budget: selected strategy "high-quality" within budget maxCostTier 2 (costTier=2)',
      );
    });

    it("breaks ties by lowest costTier ascending when qualityTier is identical", () => {
      const selector = createCostBudgetSelector({ maxCostTier: 3 });
      const cands = [
        cand("tier2-cost2", 3, 2),
        cand("tier2-cost1", 3, 1), // lower cost wins tie
      ];

      const res = selector({ operation: "test", candidates: cands, signals: {}, now: 1000 });
      assert.ok(typeof res === "object" && res !== null);
      assert.equal(res.strategyId, "tier2-cost1");
    });

    it("breaks ties by code-unit id ascending when qualityTier and costTier are identical", () => {
      const selector = createCostBudgetSelector({ maxCostTier: 2 });
      const cands = [
        cand("strategy-beta", 3, 1),
        cand("strategy-alpha", 3, 1), // "strategy-alpha" < "strategy-beta"
      ];

      const res = selector({ operation: "test", candidates: cands, signals: {}, now: 1000 });
      assert.ok(typeof res === "object" && res !== null);
      assert.equal(res.strategyId, "strategy-alpha");
    });

    it("treats undefined costTier as 0 when filtering and comparing", () => {
      const selector = createCostBudgetSelector({ maxCostTier: 0 });
      const candNoCost: CustomSelectorCandidate = {
        candidate: { id: "free-strat", qualityTier: 2, applicable: true },
        estimatedCost: null,
        estimatedLatencyMs: null,
        errorRate: null,
      };
      const candCost1: CustomSelectorCandidate = {
        candidate: { id: "paid-strat", qualityTier: 3, costTier: 1, applicable: true },
        estimatedCost: 1,
        estimatedLatencyMs: null,
        errorRate: null,
      };

      const res = selector({
        operation: "test",
        candidates: [candCost1, candNoCost],
        signals: {},
        now: 1000,
      });
      assert.ok(typeof res === "object" && res !== null);
      assert.equal(res.strategyId, "free-strat");
      assert.equal(
        res.reason,
        'cost-budget: selected strategy "free-strat" within budget maxCostTier 0 (costTier=0)',
      );
    });

    it("selects lowest cost candidate when all candidates exceed maxCostTier", () => {
      const selector = createCostBudgetSelector({ maxCostTier: 1 });
      const cands = [
        cand("expensive-high", 5, 4),
        cand("moderate-low", 2, 2),
        cand("moderate-high", 3, 2), // costTier 2 wins over 4, quality 3 wins over 2
      ];

      const res = selector({ operation: "test", candidates: cands, signals: {}, now: 1000 });
      assert.ok(typeof res === "object" && res !== null);
      assert.equal(res.strategyId, "moderate-high");
      assert.equal(
        res.reason,
        'cost-budget: all candidates exceeded budget maxCostTier 1; selected candidate "moderate-high" with lowest costTier 2',
      );
    });

    it("breaks ties by code-unit id when all candidates exceed budget and have same cost and quality", () => {
      const selector = createCostBudgetSelector({ maxCostTier: 0 });
      const cands = [cand("strat-z", 2, 2), cand("strat-a", 2, 2)];
      const res = selector({ operation: "test", candidates: cands, signals: {}, now: 1000 });
      assert.ok(typeof res === "object" && res !== null);
      assert.equal(res.strategyId, "strat-a");
    });

    it("chains to fallbackSelector with frozen withinBudget candidates when provided", () => {
      let passedCandidatesCount = 0;
      let candidatesAreFrozen = false;

      const selector = createCostBudgetSelector({
        maxCostTier: 2,
        fallbackSelector: (ctx) => {
          passedCandidatesCount = ctx.candidates.length;
          candidatesAreFrozen = Object.isFrozen(ctx.candidates);
          return { strategyId: "selected-by-fallback", reason: "custom fallback reason" };
        },
      });

      const cands = [
        cand("strat-1", 1, 1),
        cand("selected-by-fallback", 2, 2),
        cand("strat-over", 5, 3), // excluded from withinBudget
      ];

      const res = selector({ operation: "test", candidates: cands, signals: {}, now: 1000 });
      assert.equal(passedCandidatesCount, 2);
      assert.equal(candidatesAreFrozen, true);
      assert.ok(typeof res === "object" && res !== null);
      assert.equal(res.strategyId, "selected-by-fallback");
      assert.equal(res.reason, "custom fallback reason");
    });

    it("supports string return value from fallbackSelector", () => {
      const selector = createCostBudgetSelector({
        maxCostTier: 2,
        fallbackSelector: () => "strat-string",
      });

      const cands = [cand("strat-string", 1, 1), cand("strat-other", 2, 2)];
      const res = selector({ operation: "test", candidates: cands, signals: {}, now: 1000 });
      assert.equal(res, "strat-string");
    });

    it("falls back to default sorting when fallbackSelector returns null or undefined", () => {
      const selectorNull = createCostBudgetSelector({
        maxCostTier: 2,
        fallbackSelector: () => null,
      });
      const selectorUndef = createCostBudgetSelector({
        maxCostTier: 2,
        fallbackSelector: () => undefined,
      });

      const cands = [cand("low-qual", 1, 1), cand("high-qual", 3, 2)];
      const resNull = selectorNull({
        operation: "test",
        candidates: cands,
        signals: {},
        now: 1000,
      });
      const resUndef = selectorUndef({
        operation: "test",
        candidates: cands,
        signals: {},
        now: 1000,
      });

      assert.ok(typeof resNull === "object" && resNull !== null);
      assert.equal(resNull.strategyId, "high-qual");
      assert.ok(typeof resUndef === "object" && resUndef !== null);
      assert.equal(resUndef.strategyId, "high-qual");
    });

    it("falls back to default sorting when fallbackSelector returns an ID not in withinBudget", () => {
      const selector = createCostBudgetSelector({
        maxCostTier: 2,
        fallbackSelector: () => ({ strategyId: "unknown-or-over-budget" }),
      });

      const cands = [
        cand("low-qual", 1, 1),
        cand("high-qual", 3, 2),
        cand("unknown-or-over-budget", 5, 4), // cost 4 > 2
      ];

      const res = selector({ operation: "test", candidates: cands, signals: {}, now: 1000 });
      assert.ok(typeof res === "object" && res !== null);
      assert.equal(res.strategyId, "high-qual");
    });

    it("does not invoke fallbackSelector when all candidates exceed maxCostTier", () => {
      let fallbackCalled = false;
      const selector = createCostBudgetSelector({
        maxCostTier: 1,
        fallbackSelector: () => {
          fallbackCalled = true;
          return { strategyId: "should-not-run" };
        },
      });

      const cands = [cand("over-1", 3, 2), cand("over-2", 4, 3)];
      const res = selector({ operation: "test", candidates: cands, signals: {}, now: 1000 });
      assert.equal(fallbackCalled, false);
      assert.ok(typeof res === "object" && res !== null);
      assert.equal(res.strategyId, "over-1");
    });

    it("sorts by latency ascending when preferLowestLatency is true (known latency before unknown)", () => {
      const selector = createCostBudgetSelector({
        maxCostTier: 2,
        preferLowestLatency: true,
      });

      const cands = [
        cand("unmeasured", 5, 1, null, null, null, null), // unknown latency
        cand("slow", 4, 1, null, 150, null, 150),
        cand("fast", 2, 2, null, 25, null, 25), // lowest latency
      ];

      const res = selector({ operation: "test", candidates: cands, signals: {}, now: 1000 });
      assert.ok(typeof res === "object" && res !== null);
      assert.equal(res.strategyId, "fast");
    });

    it("places known finite latency before unknown latency under preferLowestLatency: true", () => {
      const selector = createCostBudgetSelector({
        maxCostTier: 2,
        preferLowestLatency: true,
      });

      const cands = [
        cand("unmeasured-high-tier", 5, 1, null, null, null, null),
        cand("measured-modest-tier", 2, 1, null, 90, null, 90),
      ];

      const res = selector({ operation: "test", candidates: cands, signals: {}, now: 1000 });
      assert.ok(typeof res === "object" && res !== null);
      assert.equal(res.strategyId, "measured-modest-tier");
    });

    it("uses ewmaLatencyMs ?? lastLatencyMs when useEwma is true or default (useEwma !== false)", () => {
      // With useEwma: true (default)
      const selectorDefault = createCostBudgetSelector({
        maxCostTier: 3,
        preferLowestLatency: true,
      });

      const cands = [
        // strat-a has last 10, but EWMA 100
        cand("strat-a", 3, 1, null, 10, null, 100, 10),
        // strat-b has last 50, but EWMA 20
        cand("strat-b", 3, 1, null, 50, null, 20, 50),
      ];

      const res = selectorDefault({ operation: "test", candidates: cands, signals: {}, now: 1000 });
      assert.ok(typeof res === "object" && res !== null);
      // strat-b wins because EWMA 20 < 100
      assert.equal(res.strategyId, "strat-b");
    });

    it("uses lastLatencyMs ?? ewmaLatencyMs when useEwma === false", () => {
      const selectorNoEwma = createCostBudgetSelector({
        maxCostTier: 3,
        preferLowestLatency: true,
        useEwma: false,
      });

      const cands = [
        // strat-a has last 10, but EWMA 100
        cand("strat-a", 3, 1, null, 10, null, 100, 10),
        // strat-b has last 50, but EWMA 20
        cand("strat-b", 3, 1, null, 50, null, 20, 50),
      ];

      const res = selectorNoEwma({ operation: "test", candidates: cands, signals: {}, now: 1000 });
      assert.ok(typeof res === "object" && res !== null);
      // strat-a wins because lastLatencyMs 10 < 50
      assert.equal(res.strategyId, "strat-a");
    });

    it("breaks ties in preferLowestLatency by qualityTier descending then costTier ascending then id", () => {
      const selector = createCostBudgetSelector({
        maxCostTier: 3,
        preferLowestLatency: true,
      });

      const cands = [
        cand("same-lat-low-qual", 1, 1, null, 50, null, 50),
        cand("same-lat-high-qual", 3, 2, null, 50, null, 50), // higher quality wins
      ];

      const res = selector({ operation: "test", candidates: cands, signals: {}, now: 1000 });
      assert.ok(typeof res === "object" && res !== null);
      assert.equal(res.strategyId, "same-lat-high-qual");

      // Now tie in both latency and quality: lower cost wins
      const candsCostTie = [
        cand("same-q-high-cost", 3, 3, null, 50, null, 50),
        cand("same-q-low-cost", 3, 1, null, 50, null, 50),
      ];
      const resCostTie = selector({
        operation: "test",
        candidates: candsCostTie,
        signals: {},
        now: 1000,
      });
      assert.ok(typeof resCostTie === "object" && resCostTie !== null);
      assert.equal(resCostTie.strategyId, "same-q-low-cost");

      // Now tie in latency, quality, and cost: code-unit id wins
      const candsIdTie = [
        cand("strat-z", 3, 1, null, 50, null, 50),
        cand("strat-m", 3, 1, null, 50, null, 50),
      ];
      const resIdTie = selector({
        operation: "test",
        candidates: candsIdTie,
        signals: {},
        now: 1000,
      });
      assert.ok(typeof resIdTie === "object" && resIdTie !== null);
      assert.equal(resIdTie.strategyId, "strat-m");
    });

    it("is re-exported from policy barrel and core", async () => {
      const policyModule = await import("../../src/policy/index.js");
      const coreModule = await import("../../src/core.js");
      assert.equal(typeof policyModule.createCostBudgetSelector, "function");
      assert.equal(typeof coreModule.createCostBudgetSelector, "function");
      assert.equal(policyModule.createCostBudgetSelector, createCostBudgetSelector);
      assert.equal(coreModule.createCostBudgetSelector, createCostBudgetSelector);
    });
  });

  describe("createSafeSelector", () => {
    it("validates input arguments strictly", () => {
      assert.throws(
        () => createSafeSelector(null as unknown as CustomPolicySelector),
        InvalidConfigurationError,
      );
      assert.throws(
        () => createSafeSelector(undefined as unknown as CustomPolicySelector),
        InvalidConfigurationError,
      );
      assert.throws(
        () => createSafeSelector("not-a-fn" as unknown as CustomPolicySelector),
        InvalidConfigurationError,
      );
      assert.throws(
        () => createSafeSelector(123 as unknown as CustomPolicySelector),
        InvalidConfigurationError,
      );
      assert.throws(
        () => createSafeSelector({} as unknown as CustomPolicySelector),
        InvalidConfigurationError,
      );
      assert.throws(
        () => createSafeSelector(() => null, null as unknown as SafeSelectorOptions),
        InvalidConfigurationError,
      );
      assert.throws(
        () => createSafeSelector(() => null, "options" as unknown as SafeSelectorOptions),
        InvalidConfigurationError,
      );
      assert.throws(
        () => createSafeSelector(() => null, [] as unknown as SafeSelectorOptions),
        InvalidConfigurationError,
      );
      assert.throws(
        () =>
          createSafeSelector(() => null, {
            fallbackSelector: "invalid" as unknown as CustomPolicySelector,
          }),
        InvalidConfigurationError,
      );
      assert.throws(
        () =>
          createSafeSelector(() => null, {
            onSelectorError: "invalid" as unknown as (err: unknown) => void,
          }),
        InvalidConfigurationError,
      );
    });

    it("returns selector's selection when selector succeeds without errors", () => {
      let onErrorCalled = false;
      const safe = createSafeSelector(() => ({ strategyId: "selected-fast", reason: "all good" }), {
        onSelectorError: () => {
          onErrorCalled = true;
        },
      });

      const res = safe({
        operation: "test",
        candidates: [cand("selected-fast", 1, 1)],
        signals: {},
        now: 1000,
      });
      assert.ok(typeof res === "object" && res !== null);
      assert.equal(res.strategyId, "selected-fast");
      assert.equal(res.reason, "all good");
      assert.equal(onErrorCalled, false);
    });

    it("returns null when selector succeeds and returns null", () => {
      const safe = createSafeSelector(() => null);
      const res = safe({
        operation: "test",
        candidates: [cand("strat", 1, 1)],
        signals: {},
        now: 1000,
      });
      assert.equal(res, null);
    });

    it("calls onSelectorError safely and returns null on selector error when no fallback", () => {
      let capturedError: unknown = null;
      let capturedContextOp = "";

      const safe = createSafeSelector(
        () => {
          throw new Error("Selector explosion!");
        },
        {
          onSelectorError: (err, ctx) => {
            capturedError = err;
            capturedContextOp = ctx.operation;
          },
        },
      );

      const res = safe({
        operation: "safe-op",
        candidates: [cand("strat", 1, 1)],
        signals: {},
        now: 1000,
      });
      assert.equal(res, null);
      assert.ok(capturedError instanceof Error);
      assert.equal((capturedError as Error).message, "Selector explosion!");
      assert.equal(capturedContextOp, "safe-op");
    });

    it("calls fallbackSelector when selector throws and returns fallback result", () => {
      const safe = createSafeSelector(
        () => {
          throw new TypeError("Failed in primary selector");
        },
        {
          fallbackSelector: (ctx) => ({
            strategyId: ctx.candidates[0]?.candidate.id ?? "fallback-default",
            reason: "recovered by fallback selector",
          }),
        },
      );

      const res = safe({
        operation: "fallback-op",
        candidates: [cand("fallback-choice", 2, 1)],
        signals: {},
        now: 1000,
      });
      assert.ok(typeof res === "object" && res !== null);
      assert.equal(res.strategyId, "fallback-choice");
      assert.equal(res.reason, "recovered by fallback selector");
    });

    it("swallows error when onSelectorError throws and proceeds to fallbackSelector", () => {
      const safe = createSafeSelector(
        () => {
          throw new Error("Primary failed");
        },
        {
          onSelectorError: () => {
            throw new Error("Logging failed!");
          },
          fallbackSelector: () => ({ strategyId: "salvaged-strat" }),
        },
      );

      const res = safe({
        operation: "test",
        candidates: [cand("salvaged-strat", 1, 1)],
        signals: {},
        now: 1000,
      });
      assert.ok(typeof res === "object" && res !== null);
      assert.equal(res.strategyId, "salvaged-strat");
    });

    it("returns null safely when both selector and fallbackSelector throw", () => {
      let onErrorCount = 0;
      const safe = createSafeSelector(
        () => {
          throw new Error("Primary selector failed");
        },
        {
          onSelectorError: () => {
            onErrorCount++;
          },
          fallbackSelector: () => {
            throw new Error("Fallback selector also failed");
          },
        },
      );

      const res = safe({
        operation: "double-fail",
        candidates: [cand("strat", 1, 1)],
        signals: {},
        now: 1000,
      });
      assert.equal(res, null);
      assert.equal(onErrorCount, 1);
    });

    it("returns null safely when selector throws, onSelectorError throws, and fallbackSelector throws", () => {
      const safe = createSafeSelector(
        () => {
          throw new Error("Fail 1");
        },
        {
          onSelectorError: () => {
            throw new Error("Fail 2");
          },
          fallbackSelector: () => {
            throw new Error("Fail 3");
          },
        },
      );

      assert.doesNotThrow(() => {
        const res = safe({
          operation: "triple-fail",
          candidates: [cand("strat", 1, 1)],
          signals: {},
          now: 1000,
        });
        assert.equal(res, null);
      });
    });

    it("integrates seamlessly into policy evaluation and prevents runtime crashes", () => {
      const safeSelector = createSafeSelector(() => {
        throw new Error("Buggy user selector!");
      });

      const policy = resolvePolicy({
        customSelector: safeSelector,
      });

      const input = createInput();
      const state = createInitialPolicyState();
      // Should not throw, and falls back to deterministic default (highest tier "high-tier")
      const evaluation = evaluatePolicy(state, input, policy);
      assert.equal(evaluation.decision.strategyId, "high-tier");
    });

    it("is re-exported from policy barrel and core", async () => {
      const policyModule = await import("../../src/policy/index.js");
      const coreModule = await import("../../src/core.js");
      assert.equal(typeof policyModule.createSafeSelector, "function");
      assert.equal(typeof coreModule.createSafeSelector, "function");
      assert.equal(policyModule.createSafeSelector, createSafeSelector);
      assert.equal(coreModule.createSafeSelector, createSafeSelector);
    });
  });

  describe("createWeightedUtilitySelector", () => {
    it("validates options strictly", () => {
      assert.throws(
        () => createWeightedUtilitySelector(null as unknown as WeightedUtilitySelectorOptions),
        InvalidConfigurationError,
      );
      assert.throws(
        () => createWeightedUtilitySelector("invalid" as unknown as WeightedUtilitySelectorOptions),
        InvalidConfigurationError,
      );
      assert.throws(
        () => createWeightedUtilitySelector(123 as unknown as WeightedUtilitySelectorOptions),
        InvalidConfigurationError,
      );
      assert.throws(
        () => createWeightedUtilitySelector([] as unknown as WeightedUtilitySelectorOptions),
        InvalidConfigurationError,
      );

      // Invalid weights
      assert.throws(
        () => createWeightedUtilitySelector({ qualityWeight: -0.1 }),
        InvalidConfigurationError,
      );
      assert.throws(
        () => createWeightedUtilitySelector({ qualityWeight: Number.NaN }),
        InvalidConfigurationError,
      );
      assert.throws(
        () => createWeightedUtilitySelector({ qualityWeight: Number.POSITIVE_INFINITY }),
        InvalidConfigurationError,
      );
      assert.throws(
        () => createWeightedUtilitySelector({ qualityWeight: "0.5" as unknown as number }),
        InvalidConfigurationError,
      );

      assert.throws(
        () => createWeightedUtilitySelector({ latencyWeight: -1 }),
        InvalidConfigurationError,
      );
      assert.throws(
        () => createWeightedUtilitySelector({ latencyWeight: Number.NaN }),
        InvalidConfigurationError,
      );

      assert.throws(
        () => createWeightedUtilitySelector({ errorRateWeight: -0.2 }),
        InvalidConfigurationError,
      );
      assert.throws(
        () => createWeightedUtilitySelector({ errorRateWeight: Number.NaN }),
        InvalidConfigurationError,
      );

      assert.throws(
        () => createWeightedUtilitySelector({ costWeight: -0.5 }),
        InvalidConfigurationError,
      );
      assert.throws(
        () => createWeightedUtilitySelector({ costWeight: Number.NaN }),
        InvalidConfigurationError,
      );

      // All four weights zero
      assert.throws(
        () =>
          createWeightedUtilitySelector({
            qualityWeight: 0,
            latencyWeight: 0,
            errorRateWeight: 0,
            costWeight: 0,
          }),
        InvalidConfigurationError,
      );

      // maxLatencyRefMs
      assert.throws(
        () => createWeightedUtilitySelector({ maxLatencyRefMs: 0 }),
        InvalidConfigurationError,
      );
      assert.throws(
        () => createWeightedUtilitySelector({ maxLatencyRefMs: -10 }),
        InvalidConfigurationError,
      );
      assert.throws(
        () => createWeightedUtilitySelector({ maxLatencyRefMs: Number.NaN }),
        InvalidConfigurationError,
      );
      assert.throws(
        () => createWeightedUtilitySelector({ maxLatencyRefMs: "100" as unknown as number }),
        InvalidConfigurationError,
      );

      // maxCostTierRef
      assert.throws(
        () => createWeightedUtilitySelector({ maxCostTierRef: 0 }),
        InvalidConfigurationError,
      );
      assert.throws(
        () => createWeightedUtilitySelector({ maxCostTierRef: -1 }),
        InvalidConfigurationError,
      );
      assert.throws(
        () => createWeightedUtilitySelector({ maxCostTierRef: Number.NaN }),
        InvalidConfigurationError,
      );

      // minSamplesForErrorRate
      assert.throws(
        () => createWeightedUtilitySelector({ minSamplesForErrorRate: -1 }),
        InvalidConfigurationError,
      );
      assert.throws(
        () => createWeightedUtilitySelector({ minSamplesForErrorRate: 1.5 }),
        InvalidConfigurationError,
      );
      assert.throws(
        () => createWeightedUtilitySelector({ minSamplesForErrorRate: Number.NaN }),
        InvalidConfigurationError,
      );
      assert.throws(
        () =>
          createWeightedUtilitySelector({
            minSamplesForErrorRate: "5" as unknown as number,
          }),
        InvalidConfigurationError,
      );

      // useEwma
      assert.throws(
        () => createWeightedUtilitySelector({ useEwma: "true" as unknown as boolean }),
        InvalidConfigurationError,
      );
      assert.throws(
        () => createWeightedUtilitySelector({ useEwma: 1 as unknown as boolean }),
        InvalidConfigurationError,
      );

      // Valid configurations
      assert.doesNotThrow(() => createWeightedUtilitySelector());
      assert.doesNotThrow(() => createWeightedUtilitySelector({}));
      assert.doesNotThrow(() =>
        createWeightedUtilitySelector({
          qualityWeight: 1,
          latencyWeight: 0,
          errorRateWeight: 0,
          costWeight: 0,
        }),
      );
      assert.doesNotThrow(() =>
        createWeightedUtilitySelector({
          minSamplesForErrorRate: 0,
          useEwma: false,
          maxLatencyRefMs: 500,
          maxCostTierRef: 10,
        }),
      );
    });

    it("returns null when candidates list is empty", () => {
      const selector = createWeightedUtilitySelector();
      const result = selector({
        operation: "test",
        candidates: [],
        signals: {},
        now: 1000,
      });
      assert.equal(result, null);
    });

    it("returns single candidate immediately without scoring", () => {
      const selector = createWeightedUtilitySelector();
      const single = cand("sole-strategy", 1, 1);
      const result = selector({
        operation: "test",
        candidates: [single],
        signals: {},
        now: 1000,
      });
      assert.ok(typeof result === "object" && result !== null);
      assert.equal(result.strategyId, "sole-strategy");
      assert.ok(result.reason?.includes("sole-strategy"));
    });

    it("computes normQuality as 1 when all candidates have identical qualityTier", () => {
      const selector = createWeightedUtilitySelector({
        qualityWeight: 0.5,
        latencyWeight: 0.5,
        errorRateWeight: 0,
        costWeight: 0,
      });
      // Both qualityTier 2: normQuality is 1 for both. strat-low-lat has lower latency penalty
      const cands = [
        cand("strat-high-lat", 2, 1, 0, 100, 10, 100),
        cand("strat-low-lat", 2, 1, 0, 20, 10, 20),
      ];
      const result = selector({
        operation: "test",
        candidates: cands,
        signals: {},
        now: 1000,
      });
      assert.ok(typeof result === "object" && result !== null);
      assert.equal(result.strategyId, "strat-low-lat");
    });

    it("normalizes quality across spread of quality tiers", () => {
      const selector = createWeightedUtilitySelector({
        qualityWeight: 1.0,
        latencyWeight: 0,
        errorRateWeight: 0,
        costWeight: 0,
      });
      const cands = [cand("low-q", 1, 1), cand("mid-q", 3, 1), cand("high-q", 5, 1)];
      const result = selector({
        operation: "test",
        candidates: cands,
        signals: {},
        now: 1000,
      });
      assert.ok(typeof result === "object" && result !== null);
      assert.equal(result.strategyId, "high-q");
    });

    it("assigns neutral 0.5 latency penalty to unknown/unmeasured latency", () => {
      const selector = createWeightedUtilitySelector({
        qualityWeight: 0,
        latencyWeight: 1.0,
        errorRateWeight: 0,
        costWeight: 0,
        maxLatencyRefMs: 100,
      });
      // strat-known has latency 20ms -> penalty = 20 / 100 = 0.2 (better than 0.5)
      // strat-unknown has null latency -> penalty = 0.5
      // strat-slow has latency 90ms -> penalty = 0.9 (worse than 0.5)
      const cands = [
        cand("strat-slow", 1, 1, 0, 90),
        cand("strat-unknown", 1, 1, 0, null),
        cand("strat-fast", 1, 1, 0, 20),
      ];
      const result1 = selector({
        operation: "test",
        candidates: [cands[0] as CustomSelectorCandidate, cands[1] as CustomSelectorCandidate],
        signals: {},
        now: 1000,
      });
      // strat-unknown (penalty 0.5) beats strat-slow (penalty 0.9)
      assert.ok(typeof result1 === "object" && result1 !== null);
      assert.equal(result1.strategyId, "strat-unknown");

      const result2 = selector({
        operation: "test",
        candidates: [cands[1] as CustomSelectorCandidate, cands[2] as CustomSelectorCandidate],
        signals: {},
        now: 1000,
      });
      // strat-fast (penalty 0.2) beats strat-unknown (penalty 0.5)
      assert.ok(typeof result2 === "object" && result2 !== null);
      assert.equal(result2.strategyId, "strat-fast");
    });

    it("respects useEwma flag for latency (prefers ewma vs last latency)", () => {
      // strat-a: ewma 10ms, last 100ms
      // strat-b: ewma 100ms, last 10ms
      const candA = cand("strat-a", 1, 1, 0, null, 10, 10, 100);
      const candB = cand("strat-b", 1, 1, 0, null, 10, 100, 10);

      const selectorEwma = createWeightedUtilitySelector({
        qualityWeight: 0,
        latencyWeight: 1.0,
        errorRateWeight: 0,
        costWeight: 0,
        useEwma: true,
      });
      const resEwma = selectorEwma({
        operation: "test",
        candidates: [candA, candB],
        signals: {},
        now: 1000,
      });
      assert.ok(typeof resEwma === "object" && resEwma !== null);
      assert.equal(resEwma.strategyId, "strat-a"); // 10ms < 100ms

      const selectorLast = createWeightedUtilitySelector({
        qualityWeight: 0,
        latencyWeight: 1.0,
        errorRateWeight: 0,
        costWeight: 0,
        useEwma: false,
      });
      const resLast = selectorLast({
        operation: "test",
        candidates: [candA, candB],
        signals: {},
        now: 1000,
      });
      assert.ok(typeof resLast === "object" && resLast !== null);
      assert.equal(resLast.strategyId, "strat-b"); // last 10ms < 100ms
    });

    it("evaluates error rate penalty only when samples >= minSamplesForErrorRate", () => {
      const selector = createWeightedUtilitySelector({
        qualityWeight: 0,
        latencyWeight: 0,
        errorRateWeight: 1.0,
        costWeight: 0,
        minSamplesForErrorRate: 5,
      });

      // strat-unproven has 100% error rate but only 2 samples (< 5) -> penalty 0
      // strat-proven has 10% error rate with 10 samples (>= 5) -> penalty 0.1
      const stratUnproven = cand("unproven", 1, 1, 1.0, null, 2);
      const stratProven = cand("proven", 1, 1, 0.1, null, 10);

      const res = selector({
        operation: "test",
        candidates: [stratProven, stratUnproven],
        signals: {},
        now: 1000,
      });
      assert.ok(typeof res === "object" && res !== null);
      // unproven has penalty 0 (-0 > -0.1), so unproven wins!
      assert.equal(res.strategyId, "unproven");
    });

    it("respects useEwma flag for error rate (prefers ewma vs raw error rate)", () => {
      // strat-1: ewmaErrorRate 0.05, errorRate 0.50
      // strat-2: ewmaErrorRate 0.50, errorRate 0.05
      const cand1 = cand("strat-1", 1, 1, 0.5, null, 10, null, null, 0.05);
      const cand2 = cand("strat-2", 1, 1, 0.05, null, 10, null, null, 0.5);

      const selectorEwma = createWeightedUtilitySelector({
        qualityWeight: 0,
        latencyWeight: 0,
        errorRateWeight: 1.0,
        costWeight: 0,
        useEwma: true,
      });
      const resEwma = selectorEwma({
        operation: "test",
        candidates: [cand1, cand2],
        signals: {},
        now: 1000,
      });
      assert.ok(typeof resEwma === "object" && resEwma !== null);
      assert.equal(resEwma.strategyId, "strat-1");

      const selectorRaw = createWeightedUtilitySelector({
        qualityWeight: 0,
        latencyWeight: 0,
        errorRateWeight: 1.0,
        costWeight: 0,
        useEwma: false,
      });
      const resRaw = selectorRaw({
        operation: "test",
        candidates: [cand1, cand2],
        signals: {},
        now: 1000,
      });
      assert.ok(typeof resRaw === "object" && resRaw !== null);
      assert.equal(resRaw.strategyId, "strat-2");
    });

    it("normalizes cost penalty against maxCostTierRef or candidate costs", () => {
      const selector = createWeightedUtilitySelector({
        qualityWeight: 0,
        latencyWeight: 0,
        errorRateWeight: 0,
        costWeight: 1.0,
        maxCostTierRef: 10,
      });
      const cands = [cand("cheap", 1, 1), cand("expensive", 1, 5)];
      const res = selector({
        operation: "test",
        candidates: cands,
        signals: {},
        now: 1000,
      });
      assert.ok(typeof res === "object" && res !== null);
      assert.equal(res.strategyId, "cheap");
    });

    it("breaks ties deterministically within 1e-12 epsilon by qualityTier desc, costTier asc, code-unit id asc", () => {
      // Pure latency selector where both candidates have identical latency (50ms) -> identical utility score
      const pureLatencySelector = createWeightedUtilitySelector({
        qualityWeight: 0,
        latencyWeight: 1.0,
        errorRateWeight: 0,
        costWeight: 0,
      });

      // Both have latency 50ms -> identical utility score
      const tieQuality = pureLatencySelector({
        operation: "test",
        candidates: [cand("low-quality", 1, 2, 0, 50), cand("high-quality", 3, 2, 0, 50)],
        signals: {},
        now: 1000,
      });
      assert.ok(typeof tieQuality === "object" && tieQuality !== null);
      assert.equal(tieQuality.strategyId, "high-quality");

      // Same qualityTier and utility score -> tie broken by costTier ascending
      const tieCost = pureLatencySelector({
        operation: "test",
        candidates: [cand("high-cost", 2, 5, 0, 50), cand("low-cost", 2, 1, 0, 50)],
        signals: {},
        now: 1000,
      });
      assert.ok(typeof tieCost === "object" && tieCost !== null);
      assert.equal(tieCost.strategyId, "low-cost");

      // Same qualityTier, same costTier, same utility score -> tie broken by code-unit id ascending
      const tieId = pureLatencySelector({
        operation: "test",
        candidates: [cand("strat-zebra", 2, 1, 0, 50), cand("strat-alpha", 2, 1, 0, 50)],
        signals: {},
        now: 1000,
      });
      assert.ok(typeof tieId === "object" && tieId !== null);
      assert.equal(tieId.strategyId, "strat-alpha");
    });

    it("composes cleanly with composeSelectors and engine evaluation", () => {
      const weightedSelector = createWeightedUtilitySelector({
        qualityWeight: 0.6,
        latencyWeight: 0.4,
        errorRateWeight: 0,
        costWeight: 0,
      });
      const composed = composeSelectors([() => null, weightedSelector]);

      const policy = resolvePolicy({
        customSelector: composed,
      });
      const input = createInput();
      const state = createInitialPolicyState();
      const evaluation = evaluatePolicy(state, input, policy);

      assert.ok(typeof evaluation.decision.strategyId === "string");
      assert.ok(evaluation.decision.reasons.some((r) => r.code === "custom-selector"));
    });

    it("is re-exported from policy barrel", async () => {
      const policyModule = await import("../../src/policy/index.js");
      assert.equal(typeof policyModule.createWeightedUtilitySelector, "function");
      assert.equal(policyModule.createWeightedUtilitySelector, createWeightedUtilitySelector);
    });
  });

  describe("createSignalTrendGuardSelector", () => {
    it("validates options strictly", () => {
      assert.throws(
        () => createSignalTrendGuardSelector(null as unknown as SignalTrendGuardSelectorOptions),
        InvalidConfigurationError,
      );
      assert.throws(
        () =>
          createSignalTrendGuardSelector("invalid" as unknown as SignalTrendGuardSelectorOptions),
        InvalidConfigurationError,
      );
      assert.throws(
        () => createSignalTrendGuardSelector([] as unknown as SignalTrendGuardSelectorOptions),
        InvalidConfigurationError,
      );

      // signalName
      assert.throws(
        () => createSignalTrendGuardSelector({ signalName: "", maxSlopePerSec: 10 }),
        InvalidConfigurationError,
      );
      assert.throws(
        () => createSignalTrendGuardSelector({ signalName: "   ", maxSlopePerSec: 10 }),
        InvalidConfigurationError,
      );
      assert.throws(
        () =>
          createSignalTrendGuardSelector({
            signalName: 123 as unknown as string,
            maxSlopePerSec: 10,
          }),
        InvalidConfigurationError,
      );

      // maxSlopePerSec
      assert.throws(
        () => createSignalTrendGuardSelector({ signalName: "cpu", maxSlopePerSec: 0 }),
        InvalidConfigurationError,
      );
      assert.throws(
        () => createSignalTrendGuardSelector({ signalName: "cpu", maxSlopePerSec: Number.NaN }),
        InvalidConfigurationError,
      );
      assert.throws(
        () =>
          createSignalTrendGuardSelector({
            signalName: "cpu",
            maxSlopePerSec: Number.POSITIVE_INFINITY,
          }),
        InvalidConfigurationError,
      );

      // windowSize
      assert.throws(
        () =>
          createSignalTrendGuardSelector({
            signalName: "cpu",
            maxSlopePerSec: 10,
            windowSize: 1,
          }),
        InvalidConfigurationError,
      );
      assert.throws(
        () =>
          createSignalTrendGuardSelector({
            signalName: "cpu",
            maxSlopePerSec: 10,
            windowSize: 101,
          }),
        InvalidConfigurationError,
      );
      assert.throws(
        () =>
          createSignalTrendGuardSelector({
            signalName: "cpu",
            maxSlopePerSec: 10,
            windowSize: 3.5,
          }),
        InvalidConfigurationError,
      );

      // minTimeSpanMs
      assert.throws(
        () =>
          createSignalTrendGuardSelector({
            signalName: "cpu",
            maxSlopePerSec: 10,
            minTimeSpanMs: 0,
          }),
        InvalidConfigurationError,
      );
      assert.throws(
        () =>
          createSignalTrendGuardSelector({
            signalName: "cpu",
            maxSlopePerSec: 10,
            minTimeSpanMs: -50,
          }),
        InvalidConfigurationError,
      );
      assert.throws(
        () =>
          createSignalTrendGuardSelector({
            signalName: "cpu",
            maxSlopePerSec: 10,
            minTimeSpanMs: Number.NaN,
          }),
        InvalidConfigurationError,
      );

      // degradedQualityCap
      assert.throws(
        () =>
          createSignalTrendGuardSelector({
            signalName: "cpu",
            maxSlopePerSec: 10,
            degradedQualityCap: Number.NaN,
          }),
        InvalidConfigurationError,
      );

      // preferLowestLatencyOnSpike
      assert.throws(
        () =>
          createSignalTrendGuardSelector({
            signalName: "cpu",
            maxSlopePerSec: 10,
            preferLowestLatencyOnSpike: "true" as unknown as boolean,
          }),
        InvalidConfigurationError,
      );

      // fallbackSelector
      assert.throws(
        () =>
          createSignalTrendGuardSelector({
            signalName: "cpu",
            maxSlopePerSec: 10,
            fallbackSelector: "invalid" as unknown as CustomPolicySelector,
          }),
        InvalidConfigurationError,
      );

      // Valid configurations (both positive and negative slopes)
      assert.doesNotThrow(() =>
        createSignalTrendGuardSelector({ signalName: "cpu", maxSlopePerSec: 25.5 }),
      );
      assert.doesNotThrow(() =>
        createSignalTrendGuardSelector({ signalName: "battery", maxSlopePerSec: -15 }),
      );
    });

    it("returns null or fallback when window has < 2 samples or timeSpan < minTimeSpanMs", () => {
      const guard = createSignalTrendGuardSelector({
        signalName: "cpu.utilization",
        maxSlopePerSec: 10,
        minTimeSpanMs: 100,
        fallbackSelector: () => ({ strategyId: "fallback-strat" }),
      });

      const cands = [cand("strat-1", 1, 1)];

      // Sample 1: only 1 reading in window
      const res1 = guard({
        operation: "test",
        candidates: cands,
        signals: {
          "cpu.utilization": {
            name: "cpu.utilization",
            unit: "ratio",
            status: "ok",
            value: 0.1,
            observedAt: 1000,
          },
        },
        now: 1000,
      });
      assert.ok(typeof res1 === "object" && res1 !== null);
      assert.equal(res1.strategyId, "fallback-strat");

      // Sample 2: elapsed only 50ms (< minTimeSpanMs 100ms)
      const res2 = guard({
        operation: "test",
        candidates: cands,
        signals: {
          "cpu.utilization": {
            name: "cpu.utilization",
            unit: "ratio",
            status: "ok",
            value: 0.9, // huge jump, but timeSpan is too short!
            observedAt: 1050,
          },
        },
        now: 1050,
      });
      assert.ok(typeof res2 === "object" && res2 !== null);
      assert.equal(res2.strategyId, "fallback-strat");
    });

    it("detects rising spike and activates degraded low-latency candidate selection", () => {
      const guard = createSignalTrendGuardSelector({
        signalName: "load",
        maxSlopePerSec: 50, // threshold 50/s
        minTimeSpanMs: 100,
        degradedQualityCap: 2,
        preferLowestLatencyOnSpike: true,
      });

      const cands = [
        cand("high-heavy", 3, 3, 0, 100), // quality 3 > cap 2
        cand("mid-slow", 2, 2, 0, 80), // quality 2, lat 80
        cand("mid-fast", 2, 2, 0, 15), // quality 2, lat 15 (should win!)
      ];

      // t = 1000, load = 10
      guard({
        operation: "test",
        candidates: cands,
        signals: {
          load: { name: "load", unit: "count", status: "ok", value: 10, observedAt: 1000 },
        },
        now: 1000,
      });

      // t = 1200, load = 30 -> slope = (30 - 10) / 0.2s = 100/s > 50/s (Spike active!)
      const res = guard({
        operation: "test",
        candidates: cands,
        signals: {
          load: { name: "load", unit: "count", status: "ok", value: 30, observedAt: 1200 },
        },
        now: 1200,
      });

      assert.ok(typeof res === "object" && res !== null);
      assert.equal(res.strategyId, "mid-fast");
      assert.ok(res.reason?.includes("signal-trend-guard: spike detected"));
    });

    it("detects falling drop when maxSlopePerSec is negative", () => {
      const guard = createSignalTrendGuardSelector({
        signalName: "available-memory-mb",
        maxSlopePerSec: -50, // drop steeper than -50/s triggers spike
        minTimeSpanMs: 200,
      });

      const cands = [cand("strat-fast", 1, 1, 0, 10), cand("strat-slow", 2, 2, 0, 100)];

      // t = 1000, mem = 500
      guard({
        operation: "test",
        candidates: cands,
        signals: {
          "available-memory-mb": {
            name: "available-memory-mb",
            unit: "bytes",
            status: "ok",
            value: 500,
            observedAt: 1000,
          },
        },
        now: 1000,
      });

      // t = 1500, mem = 480 -> slope = (480 - 500) / 0.5s = -40/s (> -50/s, not steep enough)
      const resNormal = guard({
        operation: "test",
        candidates: cands,
        signals: {
          "available-memory-mb": {
            name: "available-memory-mb",
            unit: "bytes",
            status: "ok",
            value: 480,
            observedAt: 1500,
          },
        },
        now: 1500,
      });
      assert.equal(resNormal, null);

      // t = 2000, mem = 400 -> slope from oldest (1000, 500) = (400 - 500) / 1.0s = -100/s (< -50/s, steep drop!)
      const resDrop = guard({
        operation: "test",
        candidates: cands,
        signals: {
          "available-memory-mb": {
            name: "available-memory-mb",
            unit: "bytes",
            status: "ok",
            value: 400,
            observedAt: 2000,
          },
        },
        now: 2000,
      });
      assert.ok(typeof resDrop === "object" && resDrop !== null);
      assert.equal(resDrop.strategyId, "strat-fast");
    });

    it("trims sliding window to windowSize", () => {
      const guard = createSignalTrendGuardSelector({
        signalName: "temp",
        maxSlopePerSec: 10,
        windowSize: 3,
        minTimeSpanMs: 100,
      });

      const cands = [cand("strat", 1, 1)];

      // Push 4 entries: 1000 (v=10), 1100 (v=20), 1200 (v=30), 1300 (v=32)
      // Window after 4th entry has: [1100, 1200, 1300]
      // Slope between oldest (1100, v=20) and newest (1300, v=32) is (32 - 20) / 0.2s = 60/s > 10/s!
      guard({
        operation: "test",
        candidates: cands,
        signals: {
          temp: { name: "temp", unit: "count", status: "ok", value: 10, observedAt: 1000 },
        },
        now: 1000,
      });
      guard({
        operation: "test",
        candidates: cands,
        signals: {
          temp: { name: "temp", unit: "count", status: "ok", value: 20, observedAt: 1100 },
        },
        now: 1100,
      });
      guard({
        operation: "test",
        candidates: cands,
        signals: {
          temp: { name: "temp", unit: "count", status: "ok", value: 30, observedAt: 1200 },
        },
        now: 1200,
      });
      const res = guard({
        operation: "test",
        candidates: cands,
        signals: {
          temp: { name: "temp", unit: "count", status: "ok", value: 32, observedAt: 1300 },
        },
        now: 1300,
      });
      assert.ok(typeof res === "object" && res !== null);
      assert.equal(res.strategyId, "strat");
    });

    it("clears window on clock reset (timestamp going backwards)", () => {
      const guard = createSignalTrendGuardSelector({
        signalName: "cpu",
        maxSlopePerSec: 10,
        minTimeSpanMs: 100,
      });

      const cands = [cand("strat", 1, 1)];

      // Sample at 5000
      guard({
        operation: "test",
        candidates: cands,
        signals: {
          cpu: { name: "cpu", unit: "ratio", status: "ok", value: 0.1, observedAt: 5000 },
        },
        now: 5000,
      });

      // Sample at 1000 (clock reset!)
      const resReset = guard({
        operation: "test",
        candidates: cands,
        signals: {
          cpu: { name: "cpu", unit: "ratio", status: "ok", value: 0.9, observedAt: 1000 },
        },
        now: 1000,
      });
      // Window should have been cleared, leaving only 1 entry -> spike not active
      assert.equal(resReset, null);
    });

    it("updates value in-place when reading has same timestamp", () => {
      const guard = createSignalTrendGuardSelector({
        signalName: "cpu",
        maxSlopePerSec: 10,
        minTimeSpanMs: 100,
      });

      const cands = [cand("strat", 1, 1)];

      guard({
        operation: "test",
        candidates: cands,
        signals: {
          cpu: { name: "cpu", unit: "ratio", status: "ok", value: 0.1, observedAt: 1000 },
        },
        now: 1000,
      });

      // Same timestamp updated to 0.5
      guard({
        operation: "test",
        candidates: cands,
        signals: {
          cpu: { name: "cpu", unit: "ratio", status: "ok", value: 0.5, observedAt: 1000 },
        },
        now: 1000,
      });

      // At 1200, value is 0.7. Slope is (0.7 - 0.5) / 0.2s = 1.0/s <= 10/s -> inactive
      const res = guard({
        operation: "test",
        candidates: cands,
        signals: {
          cpu: { name: "cpu", unit: "ratio", status: "ok", value: 0.7, observedAt: 1200 },
        },
        now: 1200,
      });
      assert.equal(res, null);
    });

    it("resets sliding window when .reset() is invoked", () => {
      const guard = createSignalTrendGuardSelector({
        signalName: "metric",
        maxSlopePerSec: 10,
        minTimeSpanMs: 100,
      });

      const cands = [cand("strat", 1, 1)];

      guard({
        operation: "test",
        candidates: cands,
        signals: {
          metric: { name: "metric", unit: "count", status: "ok", value: 10, observedAt: 1000 },
        },
        now: 1000,
      });
      const resSpike = guard({
        operation: "test",
        candidates: cands,
        signals: {
          metric: { name: "metric", unit: "count", status: "ok", value: 50, observedAt: 1200 },
        },
        now: 1200,
      });
      assert.ok(typeof resSpike === "object" && resSpike !== null);

      // Invoke .reset()
      guard.reset();

      // Next reading is now treated as 1st reading
      const resAfterReset = guard({
        operation: "test",
        candidates: cands,
        signals: {
          metric: { name: "metric", unit: "count", status: "ok", value: 60, observedAt: 1300 },
        },
        now: 1300,
      });
      assert.equal(resAfterReset, null);
    });

    it("falls back to all candidates if none qualify for degradedQualityCap", () => {
      const guard = createSignalTrendGuardSelector({
        signalName: "cpu",
        maxSlopePerSec: 5,
        minTimeSpanMs: 100,
        degradedQualityCap: 1, // Cap is 1, but candidates have quality 3 and 4
      });

      const cands = [cand("strat-3", 3, 1, 0, 50), cand("strat-4", 4, 1, 0, 10)];

      guard({
        operation: "test",
        candidates: cands,
        signals: {
          cpu: { name: "cpu", unit: "ratio", status: "ok", value: 0.1, observedAt: 1000 },
        },
        now: 1000,
      });

      const res = guard({
        operation: "test",
        candidates: cands,
        signals: {
          cpu: { name: "cpu", unit: "ratio", status: "ok", value: 0.9, observedAt: 1100 },
        },
        now: 1100,
      });

      assert.ok(typeof res === "object" && res !== null);
      // Falls back to all candidates and selects lowest latency ("strat-4", lat 10)
      assert.equal(res.strategyId, "strat-4");
    });

    it("prefers lowest qualityTier (load-shedding) when preferLowestLatencyOnSpike is false", () => {
      const guard = createSignalTrendGuardSelector({
        signalName: "cpu",
        maxSlopePerSec: 2,
        minTimeSpanMs: 100,
        preferLowestLatencyOnSpike: false,
      });

      const cands = [
        cand("tier-3-fast", 3, 1, 0, 5), // high quality, ultra low latency
        cand("tier-1-slow", 1, 1, 0, 100), // lowest quality (sheds most load!)
      ];

      guard({
        operation: "test",
        candidates: cands,
        signals: {
          cpu: { name: "cpu", unit: "ratio", status: "ok", value: 0.1, observedAt: 1000 },
        },
        now: 1000,
      });

      const res = guard({
        operation: "test",
        candidates: cands,
        signals: {
          cpu: { name: "cpu", unit: "ratio", status: "ok", value: 0.9, observedAt: 1200 },
        },
        now: 1200,
      });

      assert.ok(typeof res === "object" && res !== null);
      assert.equal(res.strategyId, "tier-1-slow");
    });

    it("ignores unavailable or invalid signal readings gracefully", () => {
      const guard = createSignalTrendGuardSelector({
        signalName: "cpu",
        maxSlopePerSec: 10,
      });

      const cands = [cand("strat", 1, 1)];

      // Signal missing from context.signals
      assert.equal(guard({ operation: "test", candidates: cands, signals: {}, now: 1000 }), null);

      // Signal status is not "ok"
      assert.equal(
        guard({
          operation: "test",
          candidates: cands,
          signals: {
            cpu: { name: "cpu", unit: "ratio", status: "error", error: "fail", observedAt: 1000 },
          },
          now: 1000,
        }),
        null,
      );

      // Signal value is NaN
      assert.equal(
        guard({
          operation: "test",
          candidates: cands,
          signals: {
            cpu: { name: "cpu", unit: "ratio", status: "ok", value: Number.NaN, observedAt: 1000 },
          },
          now: 1000,
        }),
        null,
      );
    });

    it("composes with createWeightedUtilitySelector in composeSelectors", () => {
      const guard = createSignalTrendGuardSelector({
        signalName: "cpu",
        maxSlopePerSec: 5,
        minTimeSpanMs: 100,
      });
      const utilitySelector = createWeightedUtilitySelector();
      const composed = composeSelectors([guard, utilitySelector]);

      const cands = [cand("quality-heavy", 3, 2, 0, 50), cand("fast-light", 1, 1, 0, 10)];

      // t = 1000: guard is inactive -> utilitySelector runs and picks highest utility
      const res1 = composed({
        operation: "test",
        candidates: cands,
        signals: {
          cpu: { name: "cpu", unit: "ratio", status: "ok", value: 0.1, observedAt: 1000 },
        },
        now: 1000,
      });
      assert.ok(typeof res1 === "object" && res1 !== null);

      // t = 1100: spike active on guard -> guard intercepts and picks fast-light!
      const res2 = composed({
        operation: "test",
        candidates: cands,
        signals: {
          cpu: { name: "cpu", unit: "ratio", status: "ok", value: 0.9, observedAt: 1100 },
        },
        now: 1100,
      });
      assert.ok(typeof res2 === "object" && res2 !== null);
      assert.equal(res2.strategyId, "fast-light");
      assert.ok(res2.reason?.includes("signal-trend-guard: spike detected"));
    });

    it("is re-exported from policy barrel", async () => {
      const policyModule = await import("../../src/policy/index.js");
      assert.equal(typeof policyModule.createSignalTrendGuardSelector, "function");
      assert.equal(policyModule.createSignalTrendGuardSelector, createSignalTrendGuardSelector);
      const testGuard: SignalTrendGuardSelector = createSignalTrendGuardSelector({
        signalName: "test-signal",
        maxSlopePerSec: 10,
      });
      assert.equal(typeof testGuard.reset, "function");
    });
  });
});
