import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAdaptiveRuntime } from "../../src/core.js";
import { OperationAbortedError } from "../../src/errors/index.js";
import { definePolicy } from "../../src/policy/index.js";
import type {
  ResourceSignal,
  SignalDescriptor,
  SignalProvider,
  SignalReadContext,
} from "../../src/types/signals.js";
import type { Strategy } from "../../src/types/strategy.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FastSignalProvider implements SignalProvider {
  readonly id = "fast-signal-provider";
  readonly signals: readonly SignalDescriptor[] = [
    { name: "concurrency.signal", unit: "count", description: "Signal for concurrency tests" },
  ];

  read(context: SignalReadContext): readonly ResourceSignal[] {
    return [
      {
        name: "concurrency.signal",
        unit: "count",
        status: "ok",
        value: 1,
        observedAt: context.now,
        confidence: 1,
      },
    ];
  }
}

class DelayedSignalProvider implements SignalProvider {
  readonly id = "delayed-signal-provider";
  readonly signals: readonly SignalDescriptor[] = [
    { name: "delayed.signal", unit: "count", description: "Delayed signal" },
  ];
  delayMs: number;

  constructor(delayMs = 60) {
    this.delayMs = delayMs;
  }

  async read(context: SignalReadContext): Promise<readonly ResourceSignal[]> {
    await sleep(this.delayMs);
    return [
      {
        name: "delayed.signal",
        unit: "count",
        status: "ok",
        value: 1,
        observedAt: context.now,
        confidence: 1,
      },
    ];
  }
}

const echoStrategy: Strategy<number, number> = {
  id: "echo",
  qualityTier: 1,
  run: async (context) => context.input,
};

describe("Tier 2 E2E: 100 Concurrent Operations & Abort Storms", () => {
  it("serializes 100 concurrent operations sharing the same operationId with single execution per run", async () => {
    const runtime = createAdaptiveRuntime({
      providers: [new FastSignalProvider()],
      policy: definePolicy({
        evaluationIntervalMs: 0,
      }),
    });

    try {
      const operationId = "shared-queue-op";
      let executionCount = 0;

      const countingStrategy: Strategy<number, number> = {
        id: "counting",
        qualityTier: 1,
        run: async (context) => {
          executionCount += 1;
          await sleep(1); // minimal async tick
          return context.input * 10;
        },
      };

      const tasks = Array.from({ length: 100 }, (_, i) =>
        runtime.run({
          operationId,
          input: i,
          strategies: [countingStrategy],
        }),
      );

      const results = await Promise.all(tasks);

      assert.equal(results.length, 100);
      assert.equal(executionCount, 100, "Exactly 1 execution per run");

      for (let i = 0; i < 100; i++) {
        assert.equal(results[i]?.value, i * 10);
      }

      const stats = runtime.getStats(operationId);
      assert.equal(stats.runs, 100);
      assert.equal(stats.successes, 100);
      assert.equal(stats.failures, 0);
    } finally {
      await runtime.close();
    }
  });

  it("evaluates 100 concurrent operations with distinct operationIds in parallel with zero contention", async () => {
    const runtime = createAdaptiveRuntime({
      providers: [new FastSignalProvider()],
      policy: definePolicy({
        evaluationIntervalMs: 0,
      }),
    });

    try {
      const tasks = Array.from({ length: 100 }, (_, i) =>
        runtime.run({
          operationId: `distinct-op-${i}`,
          input: i + 1,
          strategies: [echoStrategy],
        }),
      );

      const results = await Promise.all(tasks);

      assert.equal(results.length, 100);
      for (let i = 0; i < 100; i++) {
        assert.equal(results[i]?.value, i + 1);
        const stats = runtime.getStats(`distinct-op-${i}`);
        assert.equal(stats.runs, 1);
        assert.equal(stats.successes, 1);
      }
    } finally {
      await runtime.close();
    }
  });

  it("rejects 50 pre-aborted operations immediately with zero wait time", async () => {
    const runtime = createAdaptiveRuntime({
      providers: [new FastSignalProvider()],
      policy: definePolicy({}),
    });

    try {
      let executed = 0;
      const strategy: Strategy<number, number> = {
        id: "never-run",
        qualityTier: 1,
        run: async (context) => {
          executed += 1;
          return context.input;
        },
      };

      const startTime = Date.now();
      const tasks = Array.from({ length: 50 }, (_, i) => {
        const controller = new AbortController();
        controller.abort(new Error(`Pre-aborted ${i}`));
        return runtime.run({
          operationId: `pre-aborted-op-${i}`,
          input: i,
          signal: controller.signal,
          strategies: [strategy],
        });
      });

      const settled = await Promise.allSettled(tasks);
      const elapsed = Date.now() - startTime;

      assert.equal(settled.length, 50);
      assert.equal(executed, 0, "No strategy should be executed for pre-aborted operations");

      for (const result of settled) {
        assert.equal(result.status, "rejected");
        assert.ok(
          result.reason instanceof OperationAbortedError,
          "Reason must be OperationAbortedError",
        );
      }

      assert.ok(
        elapsed < 200,
        `Pre-aborted operations must reject immediately (took ${elapsed}ms)`,
      );
    } finally {
      await runtime.close();
    }
  });

  it("eliminates Head-of-Line blocking: queued operations reject immediately upon abort without waiting for in-flight operation", async () => {
    const delayedProvider = new DelayedSignalProvider(80);
    const runtime = createAdaptiveRuntime({
      providers: [delayedProvider],
      policy: definePolicy({
        evaluationIntervalMs: 0,
      }),
    });

    try {
      const operationId = "hol-elimination-op";

      // 1. Launch Operation 1: will enter selection and take >= 80ms in provider read
      const op1Promise = runtime.run({
        operationId,
        input: 999,
        strategies: [echoStrategy],
      });

      // Give Op1 a tick to enter selection and acquire lock
      await sleep(5);

      // 2. Queue 50 operations behind Op1, each with an active controller
      const controllers = Array.from({ length: 50 }, () => new AbortController());
      const queuedStartTimes: number[] = [];

      const queuedTasks = controllers.map((controller, i) => {
        queuedStartTimes[i] = Date.now();
        return runtime.run({
          operationId,
          input: i,
          signal: controller.signal,
          strategies: [echoStrategy],
        });
      });

      // 3. Abort all 50 queued operations after 5ms
      await sleep(5);
      const abortTriggerTime = Date.now();
      for (const controller of controllers) {
        controller.abort(new Error("Queued cancellation"));
      }

      // 4. Await all 50 queued operations
      const settledQueued = await Promise.allSettled(queuedTasks);
      const queuedResolutionTime = Date.now();

      // Invariant: All 50 must have rejected with OperationAbortedError
      assert.equal(settledQueued.length, 50);
      for (const result of settledQueued) {
        assert.equal(result.status, "rejected");
        assert.ok(
          result.reason instanceof OperationAbortedError,
          "Queued tasks must reject with OperationAbortedError",
        );
      }

      // Zero-HoL assertion: the 50 queued tasks must have resolved well before Op1 finishes (at ~80ms)
      const holDelay = queuedResolutionTime - abortTriggerTime;
      assert.ok(
        holDelay < 50,
        `Queued tasks must reject without waiting for Op1 (abort delay was ${holDelay}ms)`,
      );

      // 5. Op1 must still complete successfully!
      const op1Result = await op1Promise;
      assert.equal(op1Result.value, 999);
    } finally {
      await runtime.close();
    }
  });

  it("cooperatively cancels 50 concurrent operations mid-flight", async () => {
    const runtime = createAdaptiveRuntime({
      providers: [new FastSignalProvider()],
      policy: definePolicy({}),
    });

    try {
      const operationId = "mid-flight-op";
      let cancelledCount = 0;

      const cooperativeStrategy: Strategy<number, number> = {
        id: "cooperative",
        qualityTier: 1,
        run: async (context) => {
          return new Promise<number>((resolve, reject) => {
            const timer = setTimeout(() => {
              resolve(context.input);
            }, 100);

            context.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              cancelledCount += 1;
              reject(new OperationAbortedError(context.operationId, context.signal.reason));
            });
          });
        },
      };

      const controllers = Array.from({ length: 50 }, () => new AbortController());
      const tasks = controllers.map((controller, i) =>
        runtime.run({
          operationId: `${operationId}-${i}`,
          input: i,
          signal: controller.signal,
          strategies: [cooperativeStrategy],
        }),
      );

      // Abort all mid-flight after 10ms
      await sleep(10);
      for (const controller of controllers) {
        controller.abort(new Error("Mid-flight abort"));
      }

      const settled = await Promise.allSettled(tasks);

      assert.equal(settled.length, 50);
      for (const result of settled) {
        assert.equal(result.status, "rejected");
        assert.ok(
          result.reason instanceof OperationAbortedError,
          "Mid-flight aborted tasks must reject with OperationAbortedError",
        );
      }
      assert.equal(cancelledCount, 50, "All 50 strategies must observe cancellation");

      // Verify runtime queue is healthy and can run subsequent tasks cleanly
      const recovery = await runtime.run({
        operationId: `${operationId}-recovery`,
        input: 42,
        strategies: [echoStrategy],
      });
      assert.equal(recovery.value, 42);
    } finally {
      await runtime.close();
    }
  });

  it("resolves mixed chaos storm of 100 simultaneous operations cleanly with zero unhandled rejections", async () => {
    const delayedProvider = new DelayedSignalProvider(30);
    const runtime = createAdaptiveRuntime({
      providers: [delayedProvider],
      policy: definePolicy({
        evaluationIntervalMs: 0,
      }),
    });

    try {
      const operationId = "chaos-storm-op";

      // 4 groups of 25 operations:
      // Group 0: Normal runs (should succeed)
      // Group 1: Pre-aborted runs (should immediately reject)
      // Group 2: Aborted while queued (should reject before execution)
      // Group 3: Aborted mid-flight (should reject during execution)

      const group2Controllers = Array.from({ length: 25 }, () => new AbortController());
      const group3Controllers = Array.from({ length: 25 }, () => new AbortController());

      const midFlightStrategy: Strategy<number, number> = {
        id: "mid-flight-strat",
        qualityTier: 1,
        run: async (context) => {
          return new Promise<number>((resolve, reject) => {
            const timer = setTimeout(() => resolve(context.input), 50);
            context.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new OperationAbortedError(context.operationId, context.signal.reason));
            });
          });
        },
      };

      const tasks: Promise<{ group: number; value: number }>[] = [];

      for (let i = 0; i < 100; i++) {
        const group = i % 4;
        if (group === 0) {
          // Normal
          tasks.push(
            runtime
              .run({
                operationId,
                input: i,
                strategies: [echoStrategy],
              })
              .then((res) => ({ group, value: res.value })),
          );
        } else if (group === 1) {
          // Pre-aborted
          const preController = new AbortController();
          preController.abort(new Error("Pre-aborted"));
          tasks.push(
            runtime
              .run({
                operationId,
                input: i,
                signal: preController.signal,
                strategies: [echoStrategy],
              })
              .then((res) => ({ group, value: res.value })),
          );
        } else if (group === 2) {
          // Aborted while queued
          const ctrl = group2Controllers[Math.floor(i / 4)] as AbortController;
          tasks.push(
            runtime
              .run({
                operationId,
                input: i,
                signal: ctrl.signal,
                strategies: [echoStrategy],
              })
              .then((res) => ({ group, value: res.value })),
          );
        } else {
          // Aborted mid-flight
          const ctrl = group3Controllers[Math.floor(i / 4)] as AbortController;
          tasks.push(
            runtime
              .run({
                operationId,
                input: i,
                signal: ctrl.signal,
                strategies: [midFlightStrategy],
              })
              .then((res) => ({ group, value: res.value })),
          );
        }
      }

      // Trigger aborts for group 2 after 5ms
      setTimeout(() => {
        for (const ctrl of group2Controllers) {
          ctrl.abort(new Error("Queue abort"));
        }
      }, 5);

      // Trigger aborts for group 3 after 25ms (during mid-flight execution)
      setTimeout(() => {
        for (const ctrl of group3Controllers) {
          ctrl.abort(new Error("Mid-flight abort"));
        }
      }, 25);

      const settled = await Promise.allSettled(tasks);

      assert.equal(settled.length, 100);

      let successCount = 0;
      let abortedCount = 0;

      for (const result of settled) {
        if (result.status === "fulfilled") {
          successCount += 1;
          assert.equal(result.value.group, 0, "Only group 0 operations should succeed");
        } else {
          abortedCount += 1;
          assert.ok(
            result.reason instanceof OperationAbortedError,
            `Rejected reason must be OperationAbortedError, got: ${result.reason}`,
          );
        }
      }

      assert.equal(successCount, 25, "Exactly 25 operations should succeed");
      assert.equal(abortedCount, 75, "Exactly 75 operations should abort");

      // Verify that after all 100 operations settle, the runtime is completely intact
      const subsequent = await runtime.run({
        operationId,
        input: 12345,
        strategies: [echoStrategy],
      });
      assert.equal(subsequent.value, 12345);
    } finally {
      await runtime.close();
    }
  });
});
