import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAdaptiveRuntime } from "../../src/core.js";
import { ConfigurationError } from "../../src/errors/index.js";
import { definePolicy } from "../../src/policy/index.js";
import { validateRuntimeStateSnapshot } from "../../src/runtime/state.js";
import { createFakeClock } from "../../src/testing/index.js";
import type {
  ResourceSignal,
  SignalDescriptor,
  SignalProvider,
  SignalReadContext,
  SignalStartContext,
} from "../../src/types/signals.js";
import type { Strategy } from "../../src/types/strategy.js";

function createMulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fallbackStrategy: Strategy<number, number> = {
  id: "safe-fallback",
  qualityTier: 1,
  run: async (context) => context.input * -1,
};

const optimalStrategy: Strategy<number, number> = {
  id: "optimal",
  qualityTier: 3,
  run: async (context) => context.input * 10,
};

describe("Tier 5 E2E: Hostile Throwing/Hanging Providers & Adversarial Soak", () => {
  it("withstands hostile provider gauntlet: throwing, rejecting, hanging, corrupt, and oversized errors without crashing", async () => {
    // 1. Hostile Provider 1: synchronous throw in read()
    const syncThrowProvider: SignalProvider = {
      id: "hostile-sync-read",
      signals: [{ name: "hostile.sync", unit: "count" }],
      read: () => {
        throw new Error("FATAL_SYNC_READ_THROW");
      },
    };

    // 2. Hostile Provider 2: asynchronous rejection in read()
    const asyncRejectProvider: SignalProvider = {
      id: "hostile-async-read",
      signals: [{ name: "hostile.async", unit: "count" }],
      read: async () => {
        throw new Error("FATAL_ASYNC_READ_REJECT");
      },
    };

    // 3. Hostile Provider 3: synchronous throw in start()
    const syncStartThrowProvider: SignalProvider = {
      id: "hostile-sync-start",
      signals: [{ name: "hostile.sync.start", unit: "count" }],
      start: () => {
        throw new Error("FATAL_SYNC_START_THROW");
      },
      read: () => [],
    };

    // 4. Hostile Provider 4: hanging promise in start()
    const hangingStartProvider: SignalProvider = {
      id: "hostile-hanging-start",
      signals: [{ name: "hostile.hanging.start", unit: "count" }],
      start: () => new Promise<void>(() => {}), // Never resolves
      read: () => [],
    };

    // 5. Hostile Provider 5: corrupted data shape
    const corruptedProvider: SignalProvider = {
      id: "hostile-corrupted",
      signals: [{ name: "hostile.corrupted", unit: "count" }],
      read: () =>
        [
          {
            name: "hostile.corrupted",
            unit: "count",
            status: "ok",
            value: Number.NaN, // Corrupted value
            observedAt: Date.now(),
            confidence: 1,
          },
        ] as readonly ResourceSignal[],
    };

    // 6. Hostile Provider 6: massive oversized error payload
    const oversizedErrorProvider: SignalProvider = {
      id: "hostile-oversized",
      signals: [{ name: "hostile.oversized", unit: "bytes" }],
      read: (context) => [
        {
          name: "hostile.oversized",
          unit: "bytes",
          status: "unsupported",
          observedAt: context.now,
          error: "E".repeat(100_000), // 100 KB error string
        },
      ],
    };

    // 7. Hostile Provider 7: throws inside close()
    const hostileCloseProvider: SignalProvider = {
      id: "hostile-close",
      signals: [{ name: "hostile.close", unit: "count" }],
      read: (context) => [
        {
          name: "hostile.close",
          unit: "count",
          status: "ok",
          value: 1,
          observedAt: context.now,
          confidence: 1,
        },
      ],
      close: () => {
        throw new Error("FATAL_CLOSE_EXPLOSION");
      },
    };

    const providerErrors: string[] = [];

    const runtime = createAdaptiveRuntime({
      providers: [
        syncThrowProvider,
        asyncRejectProvider,
        syncStartThrowProvider,
        hangingStartProvider,
        corruptedProvider,
        oversizedErrorProvider,
        hostileCloseProvider,
      ],
      providerTimeoutMs: 50, // Short timeout for hanging start
      policy: definePolicy({
        evaluationIntervalMs: 0,
        fallbackStrategyId: "safe-fallback",
        missingSignalBehavior: "fallback",
        budgets: [
          {
            id: "sync-budget",
            signal: "hostile.sync",
            limit: 10,
          },
        ],
      }),
    });

    runtime.on("provider:error", ({ providerId, error }) => {
      providerErrors.push(`${providerId}:${error.message}`);
    });

    try {
      // Invariant: Runtime NEVER crashes and falls back according to missingSignalBehavior
      const result = await runtime.run({
        operationId: "gauntlet-op",
        input: 42,
        strategies: [optimalStrategy, fallbackStrategy],
      });

      assert.equal(result.value, -42, "Must safely execute fallback strategy");
      assert.equal(result.metadata.strategyId, "safe-fallback");
      assert.equal(result.metadata.decision.kind, "fallback");

      // Verify that provider errors were recorded via provider:error
      assert.ok(providerErrors.some((e) => e.includes("hostile-sync-read")));
      assert.ok(providerErrors.some((e) => e.includes("hostile-async-read")));
      assert.ok(providerErrors.some((e) => e.includes("hostile-sync-start")));

      // Verify that oversized error payload was truncated to 1001 chars ending with ellipsis
      const oversizedSignal = result.metadata.signals.find((s) => s.name === "hostile.oversized");
      assert.ok(oversizedSignal !== undefined);
      assert.equal(oversizedSignal.status, "unsupported");
      assert.ok(
        (oversizedSignal.detail?.length ?? 0) <= 1001,
        "Error detail must be bounded to 1001 chars",
      );
      assert.ok(oversizedSignal.detail?.endsWith("…"));
    } finally {
      // Invariant: close() must not crash even when hostileCloseProvider throws in close()
      await runtime.close();
    }
  });

  it("verifies transient start recovery: recovers and evaluates ok signal on subsequent evaluation interval", async () => {
    let startCalls = 0;
    let readCalls = 0;
    const clock = createFakeClock(5_000_000);

    const transientProvider: SignalProvider = {
      id: "transient-boot-provider",
      signals: [{ name: "transient.signal", unit: "count" }],
      start: (_context: SignalStartContext) => {
        startCalls += 1;
        if (startCalls === 1) {
          throw new Error("TRANSIENT_BOOT_FAILURE");
        }
      },
      read: (context) => {
        readCalls += 1;
        return [
          {
            name: "transient.signal",
            unit: "count",
            status: "ok",
            value: 100,
            observedAt: context.now,
            confidence: 1,
          },
        ];
      },
    };

    const runtime = createAdaptiveRuntime({
      providers: [transientProvider],
      clock,
      policy: definePolicy({
        evaluationIntervalMs: 1000,
        fallbackStrategyId: "safe-fallback",
        missingSignalBehavior: "fallback",
        minimumModeDurationMs: 0,
        consecutiveSamples: 1,
        budgets: [
          {
            id: "transient-budget",
            signal: "transient.signal",
            limit: 500, // 100 is healthy (< 500)
            consecutiveSamples: 1,
          },
        ],
      }),
    });

    try {
      const opId = "transient-recovery-op";

      // 1. Initial run: start() fails with TRANSIENT_BOOT_FAILURE
      const res1 = await runtime.run({
        operationId: opId,
        input: 5,
        strategies: [optimalStrategy, fallbackStrategy],
      });

      assert.equal(startCalls, 1);
      assert.equal(readCalls, 0);
      assert.equal(res1.value, -5, "Initial run must fallback due to transient start failure");
      assert.equal(res1.metadata.strategyId, "safe-fallback");

      // 2. Advance clock past evaluation interval (1500ms > 1000ms)
      clock.advance(1500);

      // 3. Second run: start() is retried, succeeds, and read() returns ok signal
      const res2 = await runtime.run({
        operationId: opId,
        input: 5,
        strategies: [optimalStrategy, fallbackStrategy],
      });

      assert.equal(startCalls, 2, "start() should be retried on next fresh cycle");
      assert.equal(readCalls, 1, "read() should be called once started successfully");
      assert.equal(
        res2.value,
        50,
        "Recovered run must select optimal strategy using the healthy ok signal",
      );
      assert.equal(res2.metadata.strategyId, "optimal");
    } finally {
      await runtime.close();
    }
  });

  it("proves bounded memory tracking across 2,000 rapid operations under maxTrackedOperations", async () => {
    const maxTracked = 50;
    const runtime = createAdaptiveRuntime({
      policy: definePolicy({
        maxTrackedOperations: maxTracked,
      }),
    });

    const fastStrategy: Strategy<number, number> = {
      id: "fast",
      qualityTier: 1,
      run: async (context) => context.input + 1,
    };

    try {
      const TOTAL_OPS = 2000;

      for (let i = 0; i < TOTAL_OPS; i++) {
        await runtime.run({
          operationId: `soak-op-${i}`,
          input: i,
          strategies: [fastStrategy],
        });
      }

      // Invariant: Operations beyond maxTrackedOperations must be evicted
      // Early operations (op-0 to op-100) must have been evicted from stats registry
      const earlyStats = runtime.getStats("soak-op-0");
      assert.equal(
        earlyStats.runs,
        0,
        "Early operation soak-op-0 must be evicted from stats tracking",
      );

      const midStats = runtime.getStats("soak-op-1000");
      assert.equal(
        midStats.runs,
        0,
        "Middle operation soak-op-1000 must be evicted from stats tracking",
      );

      // Most recent operation must still be tracked
      const latestStats = runtime.getStats(`soak-op-${TOTAL_OPS - 1}`);
      assert.equal(latestStats.runs, 1, "Most recent operation must still be tracked");
      assert.equal(latestStats.successes, 1);
    } finally {
      await runtime.close();
    }
  });

  it("guarantees 100% bit-for-bit determinism across two independent runtimes over 500 pseudo-random signal sequences", async () => {
    const seed = 0xdeadbeef;
    const rng = createMulberry32(seed);

    let currentSignalValue = 0.5;

    class DeterministicSignalProvider implements SignalProvider {
      readonly id = "deterministic-provider";
      readonly signals: readonly SignalDescriptor[] = [{ name: "entropy.pressure", unit: "ratio" }];

      read(context: SignalReadContext): readonly ResourceSignal[] {
        return [
          {
            name: "entropy.pressure",
            unit: "ratio",
            status: "ok",
            value: currentSignalValue,
            observedAt: context.now,
            confidence: 1,
          },
        ];
      }
    }

    const tier3: Strategy<number, number> = {
      id: "strat-tier3",
      qualityTier: 3,
      costTier: 3,
      run: async (ctx) => ctx.input * 3,
    };

    const tier2A: Strategy<number, number> = {
      id: "strat-tier2-a",
      qualityTier: 2,
      costTier: 2,
      run: async (ctx) => ctx.input * 2,
    };

    const tier2B: Strategy<number, number> = {
      id: "strat-tier2-b",
      qualityTier: 2,
      costTier: 2,
      run: async (ctx) => ctx.input * 2 + 1,
    };

    const tier1: Strategy<number, number> = {
      id: "strat-tier1",
      qualityTier: 1,
      costTier: 1,
      run: async (ctx) => ctx.input,
    };

    const policy = definePolicy({
      evaluationIntervalMs: 0,
      fallbackStrategyId: "strat-tier1",
      minQualityTier: 1,
      maxQualityTier: 3,
      consecutiveSamples: 2,
      budgets: [
        {
          id: "entropy-budget",
          signal: "entropy.pressure",
          limit: 0.7,
          recoverBelow: 0.4,
          tierReduction: 1,
          consecutiveSamples: 2,
        },
      ],
    });

    const runtimeA = createAdaptiveRuntime({
      providers: [new DeterministicSignalProvider()],
      policy,
    });

    const runtimeB = createAdaptiveRuntime({
      providers: [new DeterministicSignalProvider()],
      policy,
    });

    try {
      const ROUNDS = 500;
      const strategies = [tier3, tier2A, tier2B, tier1];

      for (let round = 0; round < ROUNDS; round++) {
        // Generate pseudo-random pressure value and input
        currentSignalValue = rng(); // 0.0 to 1.0
        const input = Math.floor(rng() * 1000);

        const opId = `determinism-op-${round % 5}`; // 5 cycling operations

        const resA = await runtimeA.run({
          operationId: opId,
          input,
          strategies,
        });

        const resB = await runtimeB.run({
          operationId: opId,
          input,
          strategies,
        });

        // 1. Outputs must be identical
        assert.equal(resA.value, resB.value, `Round ${round}: Values must be identical`);

        // 2. Selected strategy must be identical
        assert.equal(
          resA.metadata.strategyId,
          resB.metadata.strategyId,
          `Round ${round}: Strategy selection must be identical`,
        );

        // 3. Decision kind must be identical
        assert.equal(
          resA.metadata.decision.kind,
          resB.metadata.decision.kind,
          `Round ${round}: Decision kind must be identical`,
        );

        // 4. Reasons must be identical
        assert.equal(
          resA.metadata.decision.reasons.length,
          resB.metadata.decision.reasons.length,
          `Round ${round}: Reason count must match`,
        );
        for (let r = 0; r < resA.metadata.decision.reasons.length; r++) {
          assert.equal(
            resA.metadata.decision.reasons[r]?.code,
            resB.metadata.decision.reasons[r]?.code,
            `Round ${round}: Reason code ${r} must match`,
          );
        }

        // 5. Budget engagement must be identical
        assert.equal(resA.metadata.decision.budgets.length, resB.metadata.decision.budgets.length);
        for (let b = 0; b < resA.metadata.decision.budgets.length; b++) {
          assert.equal(
            resA.metadata.decision.budgets[b]?.engaged,
            resB.metadata.decision.budgets[b]?.engaged,
            `Round ${round}: Budget ${b} engagement state must match`,
          );
        }
      }
    } finally {
      await runtimeA.close();
      await runtimeB.close();
    }
  });

  it("shared-read collector storm with intermittent provider timeouts & synchronous throws guarantees zero unhandled rejections, exact cleanup, and post-storm recovery", async () => {
    let chaotic = true;
    const providerErrors: Array<{ providerId: string; message: string }> = [];

    const syncThrowProvider: SignalProvider = {
      id: "storm-sync-throw",
      signals: [{ name: "chaos.sync", unit: "count" }],
      read: (context) => {
        if (chaotic && Math.random() < 0.7) {
          throw new Error("STORM_SYNC_EXPLOSION");
        }
        return [
          {
            name: "chaos.sync",
            unit: "count",
            status: "ok",
            value: 10,
            observedAt: context.now,
          },
        ];
      },
    };

    const asyncRejectProvider: SignalProvider = {
      id: "storm-async-reject",
      signals: [{ name: "chaos.async", unit: "count" }],
      read: async (context) => {
        if (chaotic && Math.random() < 0.7) {
          throw new Error("STORM_ASYNC_EXPLOSION");
        }
        return [
          {
            name: "chaos.async",
            unit: "count",
            status: "ok",
            value: 20,
            observedAt: context.now,
          },
        ];
      },
    };

    const timeoutProvider: SignalProvider = {
      id: "storm-timeout",
      signals: [{ name: "chaos.timeout", unit: "count" }],
      read: (context) => {
        if (chaotic) {
          return new Promise<readonly ResourceSignal[]>((resolve) => {
            setTimeout(() => {
              resolve([
                {
                  name: "chaos.timeout",
                  unit: "count",
                  status: "ok",
                  value: 30,
                  observedAt: context.now,
                },
              ]);
            }, 100);
          });
        }
        return [
          {
            name: "chaos.timeout",
            unit: "count",
            status: "ok",
            value: 30,
            observedAt: context.now,
          },
        ];
      },
    };

    const healthyProvider: SignalProvider = {
      id: "storm-healthy",
      signals: [{ name: "chaos.healthy", unit: "count" }],
      read: (context) => [
        {
          name: "chaos.healthy",
          unit: "count",
          status: "ok",
          value: 100,
          observedAt: context.now,
        },
      ],
    };

    const runtime = createAdaptiveRuntime({
      providers: [syncThrowProvider, asyncRejectProvider, timeoutProvider, healthyProvider],
      providerTimeoutMs: 30,
      policy: definePolicy({
        evaluationIntervalMs: 0,
        fallbackStrategyId: "safe-fallback",
        missingSignalBehavior: "fallback",
        budgets: [
          { id: "b-sync", signal: "chaos.sync", limit: 50 },
          { id: "b-async", signal: "chaos.async", limit: 50 },
          { id: "b-timeout", signal: "chaos.timeout", limit: 50 },
        ],
      }),
    });

    runtime.on("provider:error", ({ providerId, error }) => {
      providerErrors.push({ providerId, message: error.message });
    });

    const unhandledRejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const TOTAL_CALLERS = 60;
      const tasks: Promise<unknown>[] = [];

      for (let i = 0; i < TOTAL_CALLERS; i++) {
        const opId = `storm-op-${i % 6}`;
        const controller = new AbortController();

        // Abort a subset of callers early to stress shared-read waiter ref-counting
        if (i % 4 === 1) {
          setTimeout(() => controller.abort(new Error(`aborted-${i}`)), 5 + (i % 15));
        }

        if (i % 2 === 0) {
          tasks.push(
            runtime.run({
              operationId: opId,
              input: i,
              strategies: [optimalStrategy, fallbackStrategy],
              signal: controller.signal,
            }),
          );
        } else {
          tasks.push(
            runtime.evaluate(
              {
                operationId: opId,
                input: i,
                strategies: [optimalStrategy, fallbackStrategy],
                signal: controller.signal,
              },
              { dryRun: i % 3 === 0 },
            ),
          );
        }
      }

      const results = await Promise.allSettled(tasks);

      // Verify zero unhandled rejections during the entire storm
      assert.equal(
        unhandledRejections.length,
        0,
        `Expected 0 unhandled rejections, got: ${JSON.stringify(unhandledRejections)}`,
      );

      // Verify every caller either succeeded or rejected with expected abort
      for (const res of results) {
        if (res.status === "rejected") {
          assert.match(
            String(res.reason),
            /aborted/i,
            "Rejections must only be due to caller aborts",
          );
        } else {
          assert.ok(res.value !== undefined);
        }
      }

      // Exact cleanup: ensure provider errors were logged and no background crash
      assert.ok(providerErrors.length > 0, "Hostile provider errors must be captured by listener");

      // Healed post-storm: Turn off chaos and verify pristine provider reads and optimal execution
      chaotic = false;
      // Allow any lagging setTimeout from hanging reads to settle
      await new Promise((resolve) => setTimeout(resolve, 120));

      const postStormRun = await runtime.run({
        operationId: "post-storm-recovered-op",
        input: 7,
        strategies: [optimalStrategy, fallbackStrategy],
      });

      assert.equal(
        postStormRun.value,
        70,
        "Post-storm run must execute optimal strategy using healed signals",
      );
      assert.equal(postStormRun.metadata.strategyId, "optimal");

      const postStormExplain = await runtime.evaluate(
        {
          operationId: "post-storm-recovered-op",
          input: 7,
          strategies: [optimalStrategy, fallbackStrategy],
        },
        { dryRun: true },
      );
      assert.equal(postStormExplain.strategyId, "optimal");
      assert.equal(unhandledRejections.length, 0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await runtime.close();
    }
  });

  it("rapid state hydration & reset churn under load verifies no state corruption or uncaught exceptions", async () => {
    const runtime = createAdaptiveRuntime({
      policy: definePolicy({
        evaluationIntervalMs: 0,
        maxTrackedOperations: 30,
      }),
    });

    const asyncStrategy: Strategy<number, number> = {
      id: "async-strat",
      qualityTier: 2,
      run: async (ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 8 + (ctx.input % 8)));
        return ctx.input * 3;
      },
    };

    const fastStrategy: Strategy<number, number> = {
      id: "fast-strat",
      qualityTier: 1,
      run: (ctx) => ctx.input + 1,
    };

    try {
      // Warm up a few operations
      for (let i = 0; i < 5; i++) {
        await runtime.run({
          operationId: `churn-op-${i}`,
          input: i,
          strategies: [fastStrategy],
        });
      }

      const activeOps: Promise<unknown>[] = [];
      const TOTAL_CONCURRENT = 25;

      // Launch concurrent operations in flight on "load-op-*"
      for (let i = 0; i < TOTAL_CONCURRENT; i++) {
        const opId = `load-op-${i % 5}`;
        activeOps.push(
          runtime.run({
            operationId: opId,
            input: i,
            strategies: [asyncStrategy, fastStrategy],
          }),
        );
      }

      // Concurrently churn state export, import, reset, and removal while load operations are in flight
      let churnIterations = 0;
      const CHURN_COUNT = 20;

      for (let k = 0; k < CHURN_COUNT; k++) {
        churnIterations++;
        const churnOpId = `churn-op-${k % 5}`;
        const loadOpId = `load-op-${k % 5}`;

        // 1. Run quick churn operation
        await runtime.run({
          operationId: churnOpId,
          input: k,
          strategies: [fastStrategy],
        });

        // 2. exportState() while concurrent load-ops are in flight
        const snapshot = runtime.exportState();
        assert.ok(snapshot.version === 1);
        validateRuntimeStateSnapshot(snapshot);

        // 3. importState()
        // If snapshot includes in-flight loadOpId, importState must throw ConfigurationError
        // without corrupting state. If targeting an isolated idle churnOpId, it succeeds.
        try {
          runtime.importState(snapshot);
        } catch (error) {
          assert.ok(
            error instanceof ConfigurationError,
            `Unexpected error during importState: ${String(error)}`,
          );
        }

        const isolatedSnapshot = runtime.exportState(churnOpId);
        if (isolatedSnapshot.operations.length > 0) {
          const restored = runtime.importState(isolatedSnapshot);
          assert.equal(restored, 1);
        }

        // 4. resetStats() for completed churn operation
        runtime.resetStats(churnOpId);
        const resetStats = runtime.getStats(churnOpId);
        assert.equal(resetStats.runs, 0);

        // 5. removeOperation() on in-flight loadOpId (safely returns false) and on idle churnOpId
        const loadRemoved = runtime.removeOperation(loadOpId);
        assert.equal(typeof loadRemoved, "boolean");

        const churnRemoved = runtime.removeOperation(churnOpId);
        assert.equal(typeof churnRemoved, "boolean");

        await new Promise((resolve) => setTimeout(resolve, 2));
      }

      assert.equal(churnIterations, CHURN_COUNT);

      // Await all concurrent in-flight load operations to finish cleanly without crashing
      const runResults = await Promise.all(activeOps);
      assert.equal(runResults.length, TOTAL_CONCURRENT);

      // Verify no state corruption after concurrent churn
      const finalSnapshot = runtime.exportState();
      assert.ok(finalSnapshot.version === 1);
      const validated = validateRuntimeStateSnapshot(finalSnapshot);
      assert.ok(validated !== null);

      // Hydrate into a clean second runtime
      const runtime2 = createAdaptiveRuntime({
        policy: definePolicy({
          evaluationIntervalMs: 0,
          maxTrackedOperations: 30,
        }),
      });

      try {
        const restored = runtime2.importState(finalSnapshot);
        assert.equal(restored, finalSnapshot.operations.length);

        // Both runtimes execute deterministically post-churn
        const res1 = await runtime.run({
          operationId: "post-churn-verify",
          input: 100,
          strategies: [asyncStrategy, fastStrategy],
        });
        const res2 = await runtime2.run({
          operationId: "post-churn-verify",
          input: 100,
          strategies: [asyncStrategy, fastStrategy],
        });

        assert.equal(res1.value, res2.value);
        assert.equal(res1.metadata.strategyId, res2.metadata.strategyId);
      } finally {
        await runtime2.close();
      }
    } finally {
      await runtime.close();
    }
  });
});
