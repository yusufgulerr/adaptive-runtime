import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as coreApi from "../../src/core.js";
import * as edgeApi from "../../src/edge.js";
import { RuntimeClosedError, StrategyExecutionError } from "../../src/errors/index.js";
import * as rootApi from "../../src/index.js";
import * as nodeApi from "../../src/node.js";
import { definePolicy } from "../../src/policy/index.js";
import { createFakeClock } from "../../src/testing/index.js";
import type { AdaptiveRuntime } from "../../src/types/runtime.js";
import type {
  ResourceSignal,
  SignalDescriptor,
  SignalProvider,
  SignalReadContext,
} from "../../src/types/signals.js";
import type { Strategy } from "../../src/types/strategy.js";
import * as webApi from "../../src/web.js";

interface TestSignalState {
  cpuLoad: number;
}

class MutableSignalProvider implements SignalProvider {
  readonly id: string;
  readonly signals: readonly SignalDescriptor[];
  state: TestSignalState;

  constructor(id = "lifecycle-provider", initialState: TestSignalState = { cpuLoad: 0.2 }) {
    this.id = id;
    this.signals = [{ name: "cpu.load", unit: "ratio", description: "CPU load ratio" }];
    this.state = initialState;
  }

  read(context: SignalReadContext): readonly ResourceSignal[] {
    return [
      {
        name: "cpu.load",
        unit: "ratio",
        status: "ok",
        value: this.state.cpuLoad,
        observedAt: context.now,
        confidence: 1,
      },
    ];
  }
}

function makeStrategies(): readonly [
  Strategy<string, string>,
  Strategy<string, string>,
  Strategy<string, string>,
] {
  const deep: Strategy<string, string> = {
    id: "deep",
    qualityTier: 3,
    costTier: 3,
    run: async (context) => `deep:${context.input}`,
  };

  const balanced: Strategy<string, string> = {
    id: "balanced",
    qualityTier: 2,
    costTier: 2,
    run: async (context) => `balanced:${context.input}`,
  };

  const fast: Strategy<string, string> = {
    id: "fast",
    qualityTier: 1,
    costTier: 1,
    run: async (context) => `fast:${context.input}`,
  };

  return [deep, balanced, fast];
}

describe("Tier 1 E2E: Full Public Lifecycle Across Entry Points", () => {
  it("verifies multi-entry point parity across root, /core, /node, /web, and /edge", async () => {
    const entryPoints = [
      { name: "root", factory: rootApi.createAdaptiveRuntime },
      { name: "core", factory: coreApi.createAdaptiveRuntime },
      { name: "node", factory: nodeApi.createAdaptiveRuntime },
      { name: "web", factory: webApi.createAdaptiveRuntime },
      { name: "edge", factory: edgeApi.createAdaptiveRuntime },
    ];

    for (const { name, factory } of entryPoints) {
      const clock = createFakeClock(1_000_000);
      const provider = new MutableSignalProvider(`provider-${name}`);
      const runtime = factory({
        providers: [provider],
        clock,
        policy: definePolicy({
          fallbackStrategyId: "fast",
        }),
      });

      try {
        const [deep, balanced, fast] = makeStrategies();
        const result = await runtime.run({
          operationId: `op-entrypoint-${name}`,
          input: "hello",
          strategies: [deep, balanced, fast],
        });

        assert.equal(
          result.value,
          "deep:hello",
          `Entry point ${name} must select highest qualityTier 3`,
        );
        assert.equal(result.metadata.strategyId, "deep");
        assert.equal(result.metadata.operationId, `op-entrypoint-${name}`);
        assert.equal(typeof result.metadata.durationMs, "number");

        const stats = runtime.getStats(`op-entrypoint-${name}`);
        assert.equal(stats.runs, 1);
        assert.equal(stats.successes, 1);
        assert.equal(stats.failures, 0);
        assert.equal(stats.strategies.deep?.runs, 1);
      } finally {
        await runtime.close();
      }
    }
  });

  it("exercises dynamic control pipeline: baseline, pressure degradation, operation policy override, pinning, unpinning, and adaptation toggle", async () => {
    const clock = createFakeClock(2_000_000);
    const provider = new MutableSignalProvider("pipeline-provider", { cpuLoad: 0.2 });

    const policy = definePolicy({
      evaluationIntervalMs: 0,
      defaultStrategyId: "balanced",
      fallbackStrategyId: "fast",
      minQualityTier: 1,
      maxQualityTier: 3,
      consecutiveSamples: 1,
      budgets: [
        {
          id: "cpu-budget",
          signal: "cpu.load",
          limit: 0.7,
          recoverBelow: 0.63,
          tierReduction: 2, // When engaged, reduces quality tier from 3 down to 1
          consecutiveSamples: 1,
        },
      ],
    });

    const runtime: AdaptiveRuntime = rootApi.createAdaptiveRuntime({
      providers: [provider],
      clock,
      policy,
    });

    try {
      const [deep, balanced, fast] = makeStrategies();
      const opId = "pipeline-e2e-op";

      // 1. Baseline run (cpuLoad = 0.20 -> deep tier 3)
      const res1 = await runtime.run({
        operationId: opId,
        input: "step1",
        strategies: [deep, balanced, fast],
      });
      assert.equal(res1.value, "deep:step1");
      assert.equal(res1.metadata.strategyId, "deep");

      // 2. Pressure degradation (cpuLoad = 0.85 -> deep violates budget -> fast tier 1 fallback)
      provider.state.cpuLoad = 0.85;
      clock.advance(100);

      const res2 = await runtime.run({
        operationId: opId,
        input: "step2",
        strategies: [deep, balanced, fast],
      });
      assert.equal(res2.value, "fast:step2");
      assert.equal(res2.metadata.strategyId, "fast");

      // 3. Hysteresis check: cpuLoad drops to 0.68 (between 0.63 and 0.70) -> stays degraded
      provider.state.cpuLoad = 0.68;
      clock.advance(100);

      const res3 = await runtime.run({
        operationId: opId,
        input: "step3",
        strategies: [deep, balanced, fast],
      });
      assert.equal(
        res3.value,
        "fast:step3",
        "Should stay on fast due to hysteresis zone (0.63 - 0.70)",
      );

      // cpuLoad drops to 0.50 (< 0.63) -> recovers to deep
      provider.state.cpuLoad = 0.5;
      clock.advance(100);

      const res4 = await runtime.run({
        operationId: opId,
        input: "step4",
        strategies: [deep, balanced, fast],
      });
      assert.equal(res4.value, "deep:step4", "Should recover to deep once below recovery bound");

      // 4. Dynamic operation policy override: cap maxQualityTier at 2
      runtime.setOperationPolicy(opId, {
        maxQualityTier: 2,
        fallbackStrategyId: "fast",
      });
      clock.advance(100);

      const res5 = await runtime.run({
        operationId: opId,
        input: "step5",
        strategies: [deep, balanced, fast],
      });
      assert.equal(
        res5.value,
        "balanced:step5",
        "Operation policy override should cap selection at tier 2 (balanced)",
      );

      // Reset operation policy override -> back to deep
      runtime.setOperationPolicy(opId, null);
      clock.advance(100);

      const res6 = await runtime.run({
        operationId: opId,
        input: "step6",
        strategies: [deep, balanced, fast],
      });
      assert.equal(res6.value, "deep:step6", "Removing override should restore global policy");

      // 5. Pinning strategy: pin to "fast"
      runtime.pinStrategy(opId, "fast");
      clock.advance(100);

      const res7 = await runtime.run({
        operationId: opId,
        input: "step7",
        strategies: [deep, balanced, fast],
      });
      assert.equal(res7.value, "fast:step7");
      assert.equal(res7.metadata.decision.kind, "pinned");

      // Unpin strategy -> returns to evaluation
      runtime.unpinStrategy(opId);
      clock.advance(100);

      const res8 = await runtime.run({
        operationId: opId,
        input: "step8",
        strategies: [deep, balanced, fast],
      });
      assert.equal(res8.value, "deep:step8");

      // 6. Adaptation toggle: disable adaptation -> frozen on current selection
      runtime.setAdaptationEnabled(opId, false);
      provider.state.cpuLoad = 0.95; // Extreme pressure
      clock.advance(100);

      const res9 = await runtime.run({
        operationId: opId,
        input: "step9",
        strategies: [deep, balanced, fast],
      });
      assert.equal(
        res9.value,
        "deep:step9",
        "With adaptation disabled, strategy should stay frozen on deep",
      );

      // Re-enable adaptation -> degrades to fast
      runtime.setAdaptationEnabled(opId, true);
      clock.advance(100);

      const res10 = await runtime.run({
        operationId: opId,
        input: "step10",
        strategies: [deep, balanced, fast],
      });
      assert.equal(
        res10.value,
        "fast:step10",
        "Re-enabling adaptation should immediately degrade to fast",
      );
    } finally {
      await runtime.close();
    }
  });

  it("verifies event stream fidelity, observation immutability, and listener error containment", async () => {
    const clock = createFakeClock(3_000_000);
    const provider = new MutableSignalProvider("event-provider", { cpuLoad: 0.3 });
    const runtime = rootApi.createAdaptiveRuntime({
      providers: [provider],
      clock,
      policy: definePolicy({
        defaultStrategyId: "fast",
        fallbackStrategyId: "fast",
      }),
    });

    const recordedEvents: string[] = [];
    const listenerErrors: string[] = [];
    let capturedDecision: unknown;
    let capturedMetadata: unknown;

    runtime.on("decision", ({ decision }) => {
      recordedEvents.push("decision");
      capturedDecision = decision;

      // Invariant: Decision and internal arrays must be frozen
      assert.ok(Object.isFrozen(decision), "decision must be frozen");
      assert.ok(Object.isFrozen(decision.signals), "decision.signals must be frozen");
      assert.ok(Object.isFrozen(decision.budgets), "decision.budgets must be frozen");
      assert.ok(Object.isFrozen(decision.reasons), "decision.reasons must be frozen");
    });

    runtime.on("run:start", ({ operationId, strategyId, decision }) => {
      recordedEvents.push("run:start");
      assert.equal(operationId, "event-op");
      assert.equal(strategyId, "deep");
      assert.ok(Object.isFrozen(decision), "decision in run:start must be frozen");
    });

    runtime.on("run:success", ({ metadata }) => {
      recordedEvents.push("run:success");
      capturedMetadata = metadata;

      // Invariant: RunMetadata and nested structures must be frozen
      assert.ok(Object.isFrozen(metadata), "metadata must be frozen");
      assert.ok(Object.isFrozen(metadata.quality), "metadata.quality must be frozen");
      assert.ok(Object.isFrozen(metadata.signals), "metadata.signals must be frozen");
      assert.ok(Object.isFrozen(metadata.decision), "metadata.decision must be frozen");
    });

    runtime.on("run:error", ({ operationId, error }) => {
      recordedEvents.push(`run:error:${operationId}:${error.name}`);
    });

    runtime.on("provider:error", ({ providerId, error }) => {
      recordedEvents.push(`provider:error:${providerId}:${error.message}`);
    });

    runtime.on("runtime:closed", () => {
      recordedEvents.push("runtime:closed");
    });

    // Throwing listener: should NOT crash the runtime or abort the operation
    runtime.on("decision", () => {
      throw new Error("HOSTILE_LISTENER_CRASH");
    });

    runtime.on("listener:error", ({ event, error }) => {
      recordedEvents.push(`listener:error:${event}`);
      listenerErrors.push(error.message);
    });

    try {
      const [deep, balanced, fast] = makeStrategies();

      // Successful run
      const res = await runtime.run({
        operationId: "event-op",
        input: "payload",
        strategies: [deep, balanced, fast],
      });

      assert.equal(res.value, "deep:payload");
      assert.ok(capturedDecision !== undefined);
      assert.ok(capturedMetadata !== undefined);

      // Verify throwing listener was contained and listener:error was emitted
      assert.ok(recordedEvents.includes("listener:error:decision"));
      assert.ok(listenerErrors.includes("HOSTILE_LISTENER_CRASH"));

      // Verify run:error is emitted when strategy throws
      const failingStrategy: Strategy<string, string> = {
        id: "failing-strat",
        qualityTier: 1,
        run: async () => {
          throw new Error("STRATEGY_INTENTIONAL_FAILURE");
        },
      };

      await assert.rejects(
        () =>
          runtime.run({
            operationId: "error-op",
            input: "fail",
            strategies: [failingStrategy],
          }),
        StrategyExecutionError,
      );

      assert.ok(recordedEvents.includes("run:error:error-op:StrategyExecutionError"));
    } finally {
      await runtime.close();
      assert.ok(recordedEvents.includes("runtime:closed"));
    }
  });

  it("verifies statistics tracking, resetStats, removeOperation, and post-close enforcement", async () => {
    const clock = createFakeClock(4_000_000);
    const provider = new MutableSignalProvider("stats-provider", { cpuLoad: 0.1 });
    const runtime = rootApi.createAdaptiveRuntime({
      providers: [provider],
      clock,
      policy: definePolicy({
        defaultStrategyId: "fast",
        fallbackStrategyId: "fast",
      }),
    });

    const [deep, balanced, fast] = makeStrategies();
    const failing: Strategy<string, string> = {
      id: "failing",
      qualityTier: 1,
      run: async () => {
        throw new Error("BOOM");
      },
    };

    try {
      const opId = "stats-op";

      // 2 successful runs of deep
      await runtime.run({ operationId: opId, input: "a", strategies: [deep, balanced, fast] });
      await runtime.run({ operationId: opId, input: "b", strategies: [deep, balanced, fast] });

      // 1 failure of failing strategy
      await assert.rejects(
        () => runtime.run({ operationId: opId, input: "c", strategies: [failing] }),
        StrategyExecutionError,
      );

      const stats1 = runtime.getStats(opId);
      assert.equal(stats1.runs, 3);
      assert.equal(stats1.successes, 2);
      assert.equal(stats1.failures, 1);
      assert.ok(stats1.lastDurationMs !== null && stats1.lastDurationMs >= 0);
      assert.ok(stats1.averageDurationMs !== null && stats1.averageDurationMs >= 0);

      // Strategy stats check
      assert.equal(stats1.strategies.deep?.runs, 2);
      assert.equal(stats1.strategies.deep?.successes, 2);
      assert.equal(stats1.strategies.deep?.failures, 0);

      assert.equal(stats1.strategies.failing?.runs, 1);
      assert.equal(stats1.strategies.failing?.successes, 0);
      assert.equal(stats1.strategies.failing?.failures, 1);

      // Pin strategy to fast to verify resetStats does NOT unpin
      runtime.pinStrategy(opId, "fast");
      runtime.resetStats(opId);

      const statsAfterReset = runtime.getStats(opId);
      assert.equal(statsAfterReset.runs, 0);
      assert.equal(statsAfterReset.successes, 0);
      assert.equal(statsAfterReset.failures, 0);

      // Run again -> should still be pinned to fast
      const resAfterReset = await runtime.run({
        operationId: opId,
        input: "d",
        strategies: [deep, balanced, fast],
      });
      assert.equal(resAfterReset.value, "fast:d");
      assert.equal(resAfterReset.metadata.decision.kind, "pinned");

      // removeOperation cleans up all state
      const removed = runtime.removeOperation(opId);
      assert.equal(removed, true);

      // Calling getStats on removed op returns clean initial stats
      const statsAfterRemove = runtime.getStats(opId);
      assert.equal(statsAfterRemove.runs, 0);

      // Close runtime
      await runtime.close();

      // Post-close calls must reject/throw with RuntimeClosedError
      await assert.rejects(
        () => runtime.run({ operationId: opId, input: "post-close", strategies: [fast] }),
        RuntimeClosedError,
      );

      assert.throws(() => runtime.setOperationPolicy(opId, {}), RuntimeClosedError);
      assert.throws(() => runtime.pinStrategy(opId, "fast"), RuntimeClosedError);
      assert.throws(() => runtime.unpinStrategy(opId), RuntimeClosedError);
      assert.throws(() => runtime.setAdaptationEnabled(opId, false), RuntimeClosedError);
      assert.throws(() => runtime.resetStats(opId), RuntimeClosedError);
      assert.throws(() => runtime.removeOperation(opId), RuntimeClosedError);
    } finally {
      await runtime.close();
    }
  });
});
