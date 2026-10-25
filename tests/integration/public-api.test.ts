import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type CustomPolicySelector,
  createAdaptiveRuntime,
  createCompositeSignalProvider,
  createCostBudgetSelector,
  createSafeSelector,
  createSignalTrendGuardSelector,
  createWeightedUtilitySelector,
  diffStateSnapshots,
  filterStateSnapshot,
  inspectStateSnapshot,
  MissingSignalError,
  NoEligibleStrategyError,
  OperationAbortedError,
  OperationTimeoutError,
  QualityCheckError,
  RuntimeClosedError,
  type Strategy,
} from "../../src/index.js";
import { createMetricsCollector, MetricsCollector } from "../../src/observability/index.js";
import * as policyApi from "../../src/policy/index.js";
import * as providersApi from "../../src/providers/index.js";
import { createEdgeExecutionBudgetProvider } from "../../src/providers/index.js";
import { comparePolicyTimelines, createFakeClock } from "../../src/testing/index.js";
import { FunctionSignalProvider } from "../helpers/providers.js";

function constantProvider(id: string, signalName: string, value: number) {
  return new FunctionSignalProvider({
    id,
    signalName,
    unit: "milliseconds",
    read: (context) => [
      {
        name: signalName,
        unit: "milliseconds",
        status: "ok",
        value,
        observedAt: context.now,
      },
    ],
  });
}

const identityStrategies: readonly Strategy<number, number>[] = [
  {
    id: "thorough",
    qualityTier: 2,
    run: ({ input }) => input * 2,
  },
  {
    id: "quick",
    qualityTier: 1,
    run: ({ input }) => input * 2,
  },
];

describe("public API integration", () => {
  it("uses only the published entry point for a full adapt/close lifecycle", async () => {
    const runtime = createAdaptiveRuntime({
      providers: [constantProvider("latency", "net.latency", 10)],
      policy: {
        evaluationIntervalMs: 0,
        consecutiveSamples: 1,
        budgets: [
          {
            id: "slow-network",
            signal: "net.latency",
            limit: 100,
            recoverBelow: 80,
            tierReduction: 1,
          },
        ],
      },
    });

    const result = await runtime.run({
      operationId: "double",
      input: 21,
      strategies: identityStrategies,
    });

    assert.equal(result.value, 42);
    assert.equal(result.metadata.strategyId, "thorough");
    assert.equal(result.metadata.attempts, 1);
    assert.equal(runtime.getDecision("double")?.strategyId, "thorough");
    assert.equal(runtime.getStats("double").successes, 1);

    await runtime.close();
    await assert.rejects(
      runtime.run({ operationId: "double", input: 1, strategies: identityStrategies }),
      RuntimeClosedError,
    );
  });

  it("surfaces missing-signal, quality, timeout, and abort errors end to end", async () => {
    const missingRuntime = createAdaptiveRuntime({
      policy: {
        evaluationIntervalMs: 0,
        missingSignalBehavior: "error",
        budgets: [{ id: "missing", signal: "absent.signal", limit: 1 }],
      },
    });
    await assert.rejects(
      missingRuntime.run({ operationId: "missing", input: 1, strategies: identityStrategies }),
      MissingSignalError,
    );
    await missingRuntime.close();

    const qualityRuntime = createAdaptiveRuntime({ policy: { qualityCheck: "error" } });
    const failing: readonly Strategy<number, number>[] = [
      {
        id: "failing",
        qualityTier: 1,
        run: ({ input }) => input,
        checkQuality: () => ({ ok: false, detail: "scripted failure" }),
      },
    ];
    await assert.rejects(
      qualityRuntime.run({ operationId: "quality", input: 1, strategies: failing }),
      QualityCheckError,
    );
    await qualityRuntime.close();

    const hangingRuntime = createAdaptiveRuntime();
    const hanging: readonly Strategy<number, number>[] = [
      {
        id: "hanging",
        qualityTier: 1,
        run: ({ signal }) =>
          new Promise<number>((resolve) => {
            signal.addEventListener("abort", () => resolve(0), { once: true });
          }),
      },
    ];
    await assert.rejects(
      hangingRuntime.run({
        operationId: "timeout",
        input: 1,
        strategies: hanging,
        timeoutMs: 10,
      }),
      OperationTimeoutError,
    );
    await hangingRuntime.close();

    const abortRuntime = createAdaptiveRuntime();
    const controller = new AbortController();
    controller.abort(new Error("caller stopped"));
    await assert.rejects(
      abortRuntime.run({
        operationId: "abort",
        input: 1,
        strategies: identityStrategies,
        signal: controller.signal,
      }),
      (error: unknown) => error instanceof OperationAbortedError && error.name === "AbortError",
    );
    await abortRuntime.close();
  });

  it("rejects operations with no eligible strategy and emits no success", async () => {
    const runtime = createAdaptiveRuntime();
    const successes: number[] = [];
    runtime.on("run:success", () => successes.push(1));
    const inapplicable: readonly Strategy<number, number>[] = [
      {
        id: "never",
        qualityTier: 1,
        isApplicable: () => false,
        run: ({ input }) => input,
      },
    ];

    await assert.rejects(
      runtime.run({ operationId: "empty", input: 1, strategies: inapplicable }),
      NoEligibleStrategyError,
    );
    assert.deepEqual(successes, []);
    assert.equal(runtime.getStats("empty").failures, 1);
    await runtime.close();
  });

  it("exposes platform-neutral policy and provider subpath entry points", () => {
    assert.equal(typeof policyApi.definePolicy, "function");
    assert.equal(typeof policyApi.evaluatePolicy, "function");
    assert.equal(typeof policyApi.createInitialPolicyState, "function");
    assert.equal(typeof policyApi.resolvePolicy, "function");

    const resolved = policyApi.resolvePolicy({ maxTrackedOperations: 2 });
    assert.equal(resolved.maxTrackedOperations, 2);
    const evaluation = policyApi.evaluatePolicy(
      policyApi.createInitialPolicyState(),
      {
        operationId: "subpath",
        now: 1,
        signals: [],
        strategies: [{ id: "only", qualityTier: 1, applicable: true }],
        pinnedStrategyId: null,
        adaptationEnabled: true,
        sampleSequence: 1,
        signalsCached: false,
      },
      resolved,
    );
    assert.equal(evaluation.decision.strategyId, "only");
    assert.equal(evaluation.decision.kind, "initial");

    assert.equal(typeof providersApi.ProcessMemoryProvider, "function");
    assert.equal(providersApi.PROCESS_MEMORY_HEAP_USED, "process.memory.heapUsed");
  });

  it("uses the root selector type, observability collector, and testing SDK together", async () => {
    const selector: CustomPolicySelector = ({ candidates }) => candidates[0]?.candidate.id;
    const runtime = createAdaptiveRuntime({
      policy: { evaluationIntervalMs: 0, customSelector: selector },
    });
    const collector = createMetricsCollector({ prefix: "public_api_test" });
    assert.ok(collector instanceof MetricsCollector);
    const detach = collector.attach(runtime);
    const clock = createFakeClock(1_000);
    assert.equal(clock.now(), 1_000);

    const result = await runtime.run({
      operationId: "selector",
      input: 21,
      strategies: identityStrategies,
    });
    assert.equal(result.value, 42);

    detach();
    await runtime.close();

    const prometheus = collector.toPrometheusText();
    assert.match(prometheus, /public_api_test_runs_total/);
    assert.match(prometheus, /public_api_test_decisions_total/);
  });

  it("exposes v0.8.0 runtime symbols and state/composite/edge utilities", async () => {
    assert.equal(typeof createCostBudgetSelector, "function");
    assert.equal(typeof createSafeSelector, "function");
    assert.equal(typeof inspectStateSnapshot, "function");
    assert.equal(typeof diffStateSnapshots, "function");
    assert.equal(typeof filterStateSnapshot, "function");
    assert.equal(typeof createCompositeSignalProvider, "function");
    assert.equal(typeof createEdgeExecutionBudgetProvider, "function");

    const edgeProvider = createEdgeExecutionBudgetProvider({ wallClockBudgetMs: 5_000 });
    const compositeProvider = createCompositeSignalProvider({
      providers: [edgeProvider],
      rules: [
        {
          name: "composite.budget",
          unit: "milliseconds",
          sources: ["edge.execution.remainingMs"],
          mode: "mean",
        },
      ],
    });

    const costSelector = createCostBudgetSelector({ maxCostTier: 2 });
    const selector = createSafeSelector(costSelector, {
      fallbackSelector: () => "thorough",
    });

    const runtime = createAdaptiveRuntime({
      providers: [compositeProvider],
      policy: {
        evaluationIntervalMs: 0,
        customSelector: selector,
      },
    });

    const runResult = await runtime.run({
      operationId: "v080-op",
      input: 5,
      strategies: identityStrategies,
    });
    assert.equal(runResult.value, 10);

    const snapshotBefore = runtime.exportState();
    const inspection = inspectStateSnapshot(snapshotBefore);
    assert.equal(inspection.operationCount, 1);
    assert.deepEqual(inspection.operationIds, ["v080-op"]);

    const filtered = filterStateSnapshot(snapshotBefore, ["v080-op"]);
    assert.equal(filtered.operations.length, 1);

    const snapshotAfter = {
      version: 1 as const,
      exportedAt: snapshotBefore.exportedAt + 100,
      operations: [],
    };
    const diff = diffStateSnapshots(snapshotBefore, snapshotAfter);
    assert.deepEqual(diff.removedOperations, ["v080-op"]);

    await runtime.close();
  });

  it("exposes v0.9.0 runtime symbols, weighted utility, signal trend guard, and timeline comparison", async () => {
    assert.equal(typeof createWeightedUtilitySelector, "function");
    assert.equal(typeof createSignalTrendGuardSelector, "function");
    assert.equal(typeof comparePolicyTimelines, "function");

    const weightedSelector = createWeightedUtilitySelector({
      qualityWeight: 1.0,
      latencyWeight: 0.5,
      costWeight: 0.2,
      useEwma: true,
    });

    const trendSelector = createSignalTrendGuardSelector({
      signalName: "net.latency",
      maxSlopePerSec: 5,
      degradedQualityCap: 1,
    });
    assert.equal(typeof trendSelector, "function");
    assert.equal(typeof trendSelector.reset, "function");

    const runtime = createAdaptiveRuntime({
      providers: [constantProvider("latency", "net.latency", 10)],
      policy: {
        evaluationIntervalMs: 0,
        customSelector: weightedSelector,
      },
    });

    const health = runtime.getRuntimeHealth();
    assert.equal(health.closed, false);
    assert.equal(health.trackedOperationCount, 0);
    assert.equal(health.activeOperationCount, 0);

    const runResult = await runtime.run({
      operationId: "v090-op",
      input: 21,
      strategies: identityStrategies,
    });
    assert.equal(runResult.value, 42);
    assert.equal(runResult.metadata.strategyId, "thorough");

    const idle = await runtime.waitForIdle();
    assert.equal(idle, true);
    await runtime.close();

    const comparison = comparePolicyTimelines({
      baselinePolicy: { evaluationIntervalMs: 0 },
      candidatePolicy: { evaluationIntervalMs: 0 },
      strategies: [
        { id: "quick", qualityTier: 1 },
        { id: "thorough", qualityTier: 2 },
      ],
      steps: [
        {
          now: 0,
          signals: [
            {
              name: "net.latency",
              unit: "milliseconds",
              status: "ok",
              value: 10,
              observedAt: 0,
            },
          ],
        },
      ],
    });
    assert.equal(comparison.totalSteps, 1);
    assert.equal(comparison.divergenceCount, 0);
    assert.equal(comparison.agreementRatio, 1);
  });
});
