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
  composeSelectors,
  createErrorRateGuardSelector,
  createLatencyBudgetSelector,
  type ErrorRateGuardSelectorOptions,
  formatDecisionSummary,
  type LatencyBudgetSelectorOptions,
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
  ): CustomSelectorCandidate => ({
    candidate: { id, qualityTier, costTier, applicable: true },
    estimatedCost: costTier,
    estimatedLatencyMs,
    errorRate,
    samples,
    ewmaLatencyMs,
  });

  describe("createErrorRateGuardSelector", () => {
    it("validates input options", () => {
      assert.throws(
        () => createErrorRateGuardSelector(null as unknown as ErrorRateGuardSelectorOptions),
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
      const selector = createErrorRateGuardSelector({
        maxErrorRate: 0.2,
        fallbackSelector: () => null,
      });
      const cands = [cand("strat-low", 1, 1, 0.1), cand("strat-high", 2, 1, 0.1)];
      const result = selector({
        operation: "test",
        candidates: cands,
        signals: {},
        now: 1000,
      });
      assert.ok(typeof result === "object" && result !== null);
      assert.equal(result.strategyId, "strat-high");
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
  });

  describe("createLatencyBudgetSelector", () => {
    it("validates input options", () => {
      assert.throws(
        () => createLatencyBudgetSelector(null as unknown as LatencyBudgetSelectorOptions),
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
      const selector = createLatencyBudgetSelector({
        maxLatencyMs: 50,
        fallbackSelector: () => null,
      });

      const cands = [cand("fast", 1, 1, null, 20), cand("high-quality", 3, 2, null, 30)];
      const res = selector({ operation: "test", candidates: cands, signals: {}, now: 1000 });
      assert.ok(typeof res === "object" && res !== null);
      assert.equal(res.strategyId, "high-quality");
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
  });
});
