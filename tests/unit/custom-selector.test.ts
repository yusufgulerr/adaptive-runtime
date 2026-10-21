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
import { createAdaptiveRuntime } from "../../src/runtime/runtime.js";
import type { Policy } from "../../src/types/policy.js";
import type { Strategy } from "../../src/types/strategy.js";

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

      const policy = resolvePolicy({
        customSelector: (ctx) => {
          const first = ctx.candidates[0];
          if (!first) {
            return null;
          }
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
  });
});
