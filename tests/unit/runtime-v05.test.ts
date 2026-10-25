import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ConfigurationError,
  OperationAbortedError,
  QualityCheckError,
} from "../../src/errors/index.js";
import { createAdaptiveRuntime } from "../../src/runtime/runtime.js";
import { SignalCollector } from "../../src/signals/collector.js";
import type { CustomSelectorCandidate } from "../../src/types/policy.js";
import type { RuntimeStateSnapshot } from "../../src/types/state.js";
import type { Strategy } from "../../src/types/strategy.js";
import { errorMessage } from "../../src/utils/errors.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { FunctionSignalProvider, okSignal } from "../helpers/providers.js";

const SIGNAL = "test.value";

function strategy(
  id: string,
  qualityTier: number,
  run: Strategy<number, string>["run"],
): Strategy<number, string> {
  return { id, qualityTier, run };
}

function strategies(calls: string[] = []): readonly Strategy<number, string>[] {
  return [
    strategy("high", 2, ({ input }) => {
      calls.push("high");
      return `high:${input}`;
    }),
    strategy("economy", 1, ({ input }) => {
      calls.push("economy");
      return `economy:${input}`;
    }),
  ];
}

function fixedProvider(value: number): FunctionSignalProvider {
  return new FunctionSignalProvider({
    id: "fixed",
    signalName: SIGNAL,
    read: (context) => [okSignal(SIGNAL, value, context.now)],
  });
}

describe("AdaptiveRuntime v0.5 surfaces", () => {
  it("supports dry-run evaluation without persisting decisions, stats, or events", async () => {
    const clock = new FakeClock();
    const calls: string[] = [];
    const runtime = createAdaptiveRuntime({
      clock,
      providers: [fixedProvider(10)],
      policy: { evaluationIntervalMs: 0 },
    });
    let decisions = 0;
    runtime.on("decision", () => {
      decisions += 1;
    });

    const decision = await runtime.evaluate(
      { operationId: "shadow", input: 7, strategies: strategies(calls) },
      { dryRun: true },
    );

    assert.equal(decision.strategyId, "high");
    assert.equal(decision.operationId, "shadow");
    assert.deepEqual(calls, []);
    assert.equal(runtime.getDecision("shadow"), null);
    assert.equal(runtime.getStats("shadow").runs, 0);
    assert.equal(decisions, 0);

    await runtime.close();
  });

  it("persists non-dry-run evaluation decisions without executing or updating run stats", async () => {
    const clock = new FakeClock();
    const calls: string[] = [];
    const runtime = createAdaptiveRuntime({
      clock,
      providers: [fixedProvider(10)],
      policy: { evaluationIntervalMs: 0 },
    });
    let decisions = 0;
    runtime.on("decision", () => {
      decisions += 1;
    });

    const decision = await runtime.evaluate({
      operationId: "shadow",
      input: 7,
      strategies: strategies(calls),
    });

    assert.equal(decision.strategyId, "high");
    assert.equal(runtime.getDecision("shadow"), decision);
    assert.equal(runtime.getStats("shadow").runs, 0);
    assert.equal(decisions, 1);
    assert.deepEqual(calls, []);

    const result = await runtime.run({
      operationId: "shadow",
      input: 8,
      strategies: strategies(calls),
    });
    assert.equal(result.value, "high:8");
    assert.deepEqual(calls, ["high"]);
    assert.equal(runtime.getStats("shadow").runs, 1);

    await runtime.close();
  });

  it("validates evaluate options and preserves abort semantics", async () => {
    const runtime = createAdaptiveRuntime({ policy: { evaluationIntervalMs: 0 } });
    const operation = {
      operationId: "shadow",
      input: 1,
      strategies: strategies(),
    };

    await assert.rejects(
      () =>
        runtime.evaluate(operation, {
          dryRun: "yes" as unknown as boolean,
        }),
      ConfigurationError,
    );
    await assert.rejects(
      () => runtime.evaluate(operation, null as unknown as Record<string, never>),
      ConfigurationError,
    );

    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await assert.rejects(
      () =>
        runtime.evaluate({
          ...operation,
          signal: controller.signal,
        }),
      OperationAbortedError,
    );

    await runtime.close();
  });

  it("uses the per-operation evaluationIntervalMs for signal cache freshness", async () => {
    const clock = new FakeClock();
    let reads = 0;
    const provider = new FunctionSignalProvider({
      id: "counter",
      signalName: SIGNAL,
      read: (context) => {
        reads += 1;
        return [okSignal(SIGNAL, 10, context.now)];
      },
    });
    const runtime = createAdaptiveRuntime({
      clock,
      providers: [provider],
      policy: { evaluationIntervalMs: 10_000 },
    });
    const operation = (operationId: string) => ({
      operationId,
      input: 1,
      strategies: strategies(),
    });

    runtime.setOperationPolicy("fresh", { evaluationIntervalMs: 0 });
    await runtime.run(operation("fresh"));
    await runtime.run(operation("fresh"));
    assert.equal(reads, 2);

    await runtime.run(operation("cached"));
    await runtime.run(operation("cached"));
    assert.equal(reads, 2);

    await runtime.close();
  });

  it("exports state, restores pins/adaptation/stats, and leaves other operations untouched", async () => {
    const clock = new FakeClock();
    const source = createAdaptiveRuntime({
      clock,
      policy: { evaluationIntervalMs: 0 },
    });

    await source.run({
      operationId: "hydrated",
      input: 1,
      strategies: strategies(),
    });
    source.setAdaptationEnabled("hydrated", false);
    source.pinStrategy("hydrated", "economy");

    const snapshot = source.exportState();
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.operations.length, 1);
    const operationState = snapshot.operations[0]?.state;
    assert.ok(operationState);
    assert.equal(operationState.pinnedStrategyId, "economy");
    assert.equal(operationState.adaptationEnabled, false);
    assert.equal(operationState.stats.durationSamples, 1);
    assert.equal(operationState.stats.strategyRuns.high, 1);
    assert.equal(source.exportState("missing").operations.length, 0);
    assert.ok(Object.isFrozen(snapshot));
    assert.ok(Object.isFrozen(operationState.stats));

    const target = createAdaptiveRuntime({
      clock,
      policy: { evaluationIntervalMs: 0 },
    });
    await target.run({
      operationId: "untouched",
      input: 1,
      strategies: strategies(),
    });
    const untouchedBefore = target.getStats("untouched");

    assert.equal(target.importState(snapshot), 1);
    assert.deepEqual(target.getStats("hydrated"), operationState.stats);
    assert.equal(target.getDecision("hydrated")?.strategyId, "high");
    assert.deepEqual(target.getStats("untouched"), untouchedBefore);

    const calls: string[] = [];
    const result = await target.run({
      operationId: "hydrated",
      input: 2,
      strategies: strategies(calls),
    });
    assert.equal(result.metadata.strategyId, "economy");
    assert.equal(result.metadata.decision.kind, "pinned");
    assert.deepEqual(calls, ["economy"]);

    await source.close();
    await target.close();
  });

  it("rejects invalid snapshots atomically and imports only when no work is in flight", async () => {
    const clock = new FakeClock();
    const runtime = createAdaptiveRuntime({
      clock,
      policy: { evaluationIntervalMs: 0 },
    });
    await runtime.run({
      operationId: "op",
      input: 1,
      strategies: strategies(),
    });
    const snapshot = runtime.exportState();
    const before = runtime.getDecision("op");

    const invalid = JSON.parse(JSON.stringify(snapshot)) as {
      operations: Array<{ state: { stats: { operationId: string } } }>;
    };
    const invalidOperation = invalid.operations[0];
    assert.ok(invalidOperation);
    invalidOperation.state.stats.operationId = "different";
    assert.throws(
      () => runtime.importState(invalid as unknown as RuntimeStateSnapshot),
      ConfigurationError,
    );
    assert.equal(runtime.getDecision("op"), before);

    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocked = runtime.run({
      operationId: "blocked",
      input: 1,
      strategies: [
        strategy("high", 1, async () => {
          await pending;
          return "done";
        }),
      ],
    });
    await Promise.resolve();
    const blockedSnapshot = runtime.exportState("blocked");
    assert.equal(blockedSnapshot.operations.length, 1);
    assert.throws(() => runtime.importState(blockedSnapshot), ConfigurationError);
    release?.();
    await blocked;

    await runtime.close();
  });

  it("reports EWMA latency, duration samples, and failure rates to custom selectors", async () => {
    const clock = new FakeClock();
    let observed: CustomSelectorCandidate | undefined;
    let shouldFail = false;

    const runtime = createAdaptiveRuntime({
      clock,
      policy: {
        evaluationIntervalMs: 0,
        customSelector: (context) => {
          observed = context.candidates[0];
          return "worker";
        },
      },
    });
    const worker: Strategy<number, number> = {
      id: "worker",
      qualityTier: 1,
      run: () => {
        if (shouldFail) {
          clock.advance(20);
          throw new Error("worker failed");
        }
        clock.advance(10);
        return 1;
      },
    };
    const operation = {
      operationId: "stats",
      input: 1,
      strategies: [worker],
    };

    await runtime.run(operation);
    shouldFail = true;
    await assert.rejects(() => runtime.run(operation));

    const stats = runtime.getStats("stats");
    assert.equal(stats.runs, 2);
    assert.equal(stats.successes, 1);
    assert.equal(stats.failures, 1);
    assert.equal(stats.durationSamples, 2);
    assert.equal(stats.lastDurationMs, 20);
    assert.equal(stats.averageDurationMs, 15);
    assert.equal(stats.ewmaDurationMs, 12);
    assert.equal(stats.errorRate, 0.5);
    const workerStats = stats.strategies.worker;
    assert.ok(workerStats);
    assert.equal(workerStats.averageDurationMs, 15);
    assert.equal(workerStats.ewmaDurationMs, 12);
    assert.equal(workerStats.durationSamples, 2);
    assert.equal(workerStats.errorRate, 0.5);

    shouldFail = false;
    await runtime.evaluate(operation, { dryRun: true });
    assert.ok(observed);
    assert.equal(observed.estimatedLatencyMs, 12);
    assert.equal(observed.ewmaLatencyMs, 12);
    assert.equal(observed.errorRate, 0.5);

    await runtime.close();
  });

  it("tracks operations in LRU order, provides frozen views, and retains inspection after close", async () => {
    const clock = new FakeClock();
    const runtime = createAdaptiveRuntime({
      clock,
      policy: {
        evaluationIntervalMs: 0,
        maxTrackedOperations: 3,
      },
    });

    assert.deepEqual(runtime.getTrackedOperations(), []);
    assert.ok(Object.isFrozen(runtime.getTrackedOperations()));
    assert.deepEqual(runtime.getAllStats(), {});
    assert.ok(Object.isFrozen(runtime.getAllStats()));

    const s = (name: string): Strategy<number, string> => ({
      id: "main",
      qualityTier: 1,
      run: () => name,
    });

    await runtime.run({ operationId: "op1", input: 1, strategies: [s("op1")] });
    await runtime.run({ operationId: "op2", input: 2, strategies: [s("op2")] });
    await runtime.run({ operationId: "op3", input: 3, strategies: [s("op3")] });

    assert.deepEqual(runtime.getTrackedOperations(), ["op1", "op2", "op3"]);
    const statsAll = runtime.getAllStats();
    assert.ok(Object.isFrozen(statsAll));
    assert.equal(statsAll.op1?.runs, 1);
    assert.equal(statsAll.op2?.runs, 1);
    assert.equal(statsAll.op3?.runs, 1);

    // Inspection calls MUST NOT refresh LRU order
    assert.deepEqual(runtime.getTrackedOperations(), ["op1", "op2", "op3"]);
    runtime.getAllStats();
    assert.deepEqual(runtime.getTrackedOperations(), ["op1", "op2", "op3"]);

    // Accessing single operation via getDecision/getStats DOES refresh LRU order
    runtime.getStats("op1");
    assert.deepEqual(runtime.getTrackedOperations(), ["op2", "op3", "op1"]);

    // Exceed maxTrackedOperations (limit = 3): running op4 evicts op2 (oldest)
    await runtime.run({ operationId: "op4", input: 4, strategies: [s("op4")] });
    assert.deepEqual(runtime.getTrackedOperations(), ["op3", "op1", "op4"]);
    const statsAfterEviction = runtime.getAllStats();
    assert.equal(statsAfterEviction.op2, undefined);
    assert.equal(statsAfterEviction.op4?.runs, 1);

    // removeOperation removes from tracked operations and stats
    const removed = runtime.removeOperation("op1");
    assert.equal(removed, true);
    assert.deepEqual(runtime.getTrackedOperations(), ["op3", "op4"]);
    assert.equal(runtime.getAllStats().op1, undefined);

    // After close(), getTrackedOperations() and getAllStats() remain readable
    await runtime.close();
    assert.deepEqual(runtime.getTrackedOperations(), ["op3", "op4"]);
    const statsClosed = runtime.getAllStats();
    assert.equal(statsClosed.op3?.runs, 1);
    assert.equal(statsClosed.op4?.runs, 1);
  });

  it("bounds quality check detail length to 1001 characters in both report and error modes", async () => {
    const hugeDetail = "X".repeat(50000);

    // 1. Report mode
    const runtimeReport = createAdaptiveRuntime({
      policy: { qualityCheck: "report" },
    });
    const stratReport: Strategy<number, string> = {
      id: "strat",
      qualityTier: 1,
      run: () => "result",
      checkQuality: () => ({ ok: false, detail: hugeDetail }),
    };

    const runResult = await runtimeReport.run({
      operationId: "op-report",
      input: 1,
      strategies: [stratReport],
    });
    assert.ok(runResult.metadata.quality);
    assert.equal(runResult.metadata.quality.status, "failed");
    assert.equal(runResult.metadata.quality.detail?.length, 1001);
    assert.ok(runResult.metadata.quality.detail?.endsWith("…"));

    await runtimeReport.close();

    // 2. Error mode
    const runtimeError = createAdaptiveRuntime({
      policy: { qualityCheck: "error" },
    });
    const stratError: Strategy<number, string> = {
      id: "strat",
      qualityTier: 1,
      run: () => "result",
      checkQuality: () => ({ ok: false, detail: hugeDetail }),
    };

    await assert.rejects(
      async () =>
        runtimeError.run({
          operationId: "op-error",
          input: 1,
          strategies: [stratError],
        }),
      (err: unknown) => {
        assert.ok(err instanceof QualityCheckError);
        assert.ok(err.message.endsWith("…"));
        assert.ok(err.message.length <= 1200);
        return true;
      },
    );

    await runtimeError.close();
  });

  it("exposes operation policy overrides, returns frozen policies, and updates LRU order", async () => {
    const clock = new FakeClock();
    const runtime = createAdaptiveRuntime({
      clock,
      policy: {
        evaluationIntervalMs: 0,
        maxTrackedOperations: 3,
      },
    });

    // 1. Returns null when no override exists
    assert.equal(runtime.getOperationPolicy("tenant-a"), null);

    // 2. Returns frozen ResolvedPolicy when set
    runtime.setOperationPolicy("tenant-a", {
      minQualityTier: 2,
      budgets: [
        {
          id: "heap-budget",
          signal: "node.heap.used",
          limit: 100,
        },
      ],
    });

    const policy = runtime.getOperationPolicy("tenant-a");
    assert.ok(policy !== null);
    assert.equal(policy.minQualityTier, 2);
    assert.ok(Object.isFrozen(policy));
    assert.ok(Object.isFrozen(policy.budgets));
    assert.equal(policy.budgets.length, 1);
    assert.ok(Object.isFrozen(policy.budgets[0]));

    // 3. getOperationPolicy refreshes LRU tracking
    runtime.setOperationPolicy("tenant-b", { minQualityTier: 1 });
    runtime.setOperationPolicy("tenant-c", { minQualityTier: 1 });
    assert.deepEqual(runtime.getTrackedOperations(), ["tenant-a", "tenant-b", "tenant-c"]);

    // Accessing tenant-a moves it to the newest position
    runtime.getOperationPolicy("tenant-a");
    assert.deepEqual(runtime.getTrackedOperations(), ["tenant-b", "tenant-c", "tenant-a"]);

    // 4. Returns null after setOperationPolicy(id, null)
    runtime.setOperationPolicy("tenant-a", null);
    assert.equal(runtime.getOperationPolicy("tenant-a"), null);

    // 5. Returns null after removeOperation
    runtime.setOperationPolicy("tenant-b", { maxQualityTier: 3 });
    assert.ok(runtime.getOperationPolicy("tenant-b") !== null);
    runtime.removeOperation("tenant-b");
    assert.equal(runtime.getOperationPolicy("tenant-b"), null);

    await runtime.close();
  });

  describe("maxQualityCheckDetailLength and errorMessage bounding", () => {
    it("validates maxQualityCheckDetailLength in CreateRuntimeOptions", () => {
      // Valid positive safe integers accepted
      const r1 = createAdaptiveRuntime({ maxQualityCheckDetailLength: 50 });
      assert.ok(r1);
      const r2 = createAdaptiveRuntime({ maxQualityCheckDetailLength: 1 });
      assert.ok(r2);
      const r3 = createAdaptiveRuntime({});
      assert.ok(r3);

      // Rejects 0, negative numbers, floats, NaN, Infinity, strings, etc.
      for (const invalid of [
        0,
        -1,
        -500,
        1.5,
        NaN,
        Infinity,
        -Infinity,
        "1000",
        null,
        false,
        Number.MAX_SAFE_INTEGER + 1,
      ]) {
        assert.throws(
          () =>
            createAdaptiveRuntime({ maxQualityCheckDetailLength: invalid as unknown as number }),
          (err: unknown) =>
            err instanceof ConfigurationError &&
            err.message === "maxQualityCheckDetailLength must be a safe positive integer.",
        );
      }
    });

    it("bounds errorMessage with custom maxLength and falls back for invalid maxLength", () => {
      const longStr = "x".repeat(200);
      assert.equal(errorMessage(longStr, 50), `${"x".repeat(50)}…`);
      assert.equal(errorMessage(new Error(longStr), 20), `${"x".repeat(20)}…`);

      // Shorter than bound remains intact
      assert.equal(errorMessage("hello", 50), "hello");

      // Non-positive or non-safe integer maxLength falls back to 1000
      const str1200 = "y".repeat(1200);
      assert.equal(errorMessage(str1200, 0), `${"y".repeat(1000)}…`);
      assert.equal(errorMessage(str1200, -10), `${"y".repeat(1000)}…`);
      assert.equal(errorMessage(str1200, NaN), `${"y".repeat(1000)}…`);
      assert.equal(errorMessage(str1200, 1.5), `${"y".repeat(1000)}…`);
    });

    it("bounds quality check details in report mode with custom length", async () => {
      const runtime = createAdaptiveRuntime({
        maxQualityCheckDetailLength: 50,
        policy: { qualityCheck: "report" },
      });

      // Passed check with long detail
      const resPassed = await runtime.run({
        operationId: "detail-pass",
        input: 1,
        strategies: [
          {
            id: "s1",
            qualityTier: 1,
            run: () => "ok",
            checkQuality: () => ({ ok: true, detail: "a".repeat(100) }),
          },
        ],
      });
      assert.equal(resPassed.metadata.quality.status, "passed");
      assert.equal(resPassed.metadata.quality.detail, `${"a".repeat(50)}…`);

      // Failed check with long detail
      const resFailed = await runtime.run({
        operationId: "detail-fail",
        input: 1,
        strategies: [
          {
            id: "s2",
            qualityTier: 1,
            run: () => "ok",
            checkQuality: () => ({ ok: false, detail: "b".repeat(100) }),
          },
        ],
      });
      assert.equal(resFailed.metadata.quality.status, "failed");
      assert.equal(resFailed.metadata.quality.detail, `${"b".repeat(50)}…`);

      // Thrown error with long detail
      const resError = await runtime.run({
        operationId: "detail-throw",
        input: 1,
        strategies: [
          {
            id: "s3",
            qualityTier: 1,
            run: () => "ok",
            checkQuality: () => {
              throw new Error("c".repeat(100));
            },
          },
        ],
      });
      assert.equal(resError.metadata.quality.status, "error");
      assert.equal(resError.metadata.quality.detail, `Quality check threw: ${"c".repeat(50)}…`);

      await runtime.close();
    });

    it("bounds quality check details in error mode with custom length", async () => {
      const runtime = createAdaptiveRuntime({
        maxQualityCheckDetailLength: 60,
        policy: { qualityCheck: "error" },
      });

      // Failed check in error mode
      await assert.rejects(
        () =>
          runtime.run({
            operationId: "error-mode-fail",
            input: 1,
            strategies: [
              {
                id: "s1",
                qualityTier: 1,
                run: () => "ok",
                checkQuality: () => ({ ok: false, detail: "d".repeat(120) }),
              },
            ],
          }),
        (err: unknown) => {
          assert.ok(err instanceof QualityCheckError);
          assert.ok(err.message.includes(`${"d".repeat(60)}…`));
          return true;
        },
      );

      // Thrown error in error mode
      await assert.rejects(
        () =>
          runtime.run({
            operationId: "error-mode-throw",
            input: 1,
            strategies: [
              {
                id: "s2",
                qualityTier: 1,
                run: () => "ok",
                checkQuality: () => {
                  throw new Error("e".repeat(120));
                },
              },
            ],
          }),
        (err: unknown) => {
          assert.ok(err instanceof QualityCheckError);
          assert.ok(err.message.includes(`Quality check threw: ${"e".repeat(60)}…`));
          return true;
        },
      );

      await runtime.close();
    });

    it("uses default 1000 char bounding when maxQualityCheckDetailLength is omitted", async () => {
      const runtime = createAdaptiveRuntime({
        policy: { qualityCheck: "report" },
      });

      const longDetail = "z".repeat(1500);
      const res = await runtime.run({
        operationId: "default-bound",
        input: 1,
        strategies: [
          {
            id: "s1",
            qualityTier: 1,
            run: () => "ok",
            checkQuality: () => ({ ok: true, detail: longDetail }),
          },
        ],
      });
      assert.equal(res.metadata.quality.detail, `${"z".repeat(1000)}…`);

      await runtime.close();
    });
  });

  describe("getEffectivePolicy and getProviderDescriptors introspection", () => {
    it("getEffectivePolicy returns root policy when no override is set and returns override when set", async () => {
      const runtime = createAdaptiveRuntime({
        policy: { minQualityTier: 1 },
      });

      // Root policy returned for untracked/unconfigured operation
      const rootEffective = runtime.getEffectivePolicy("op-1");
      assert.equal(rootEffective.minQualityTier, 1);
      assert.ok(Object.isFrozen(rootEffective));

      // Set override
      runtime.setOperationPolicy("op-1", { minQualityTier: 3 });
      const overridden = runtime.getEffectivePolicy("op-1");
      assert.equal(overridden.minQualityTier, 3);
      assert.ok(Object.isFrozen(overridden));

      // Reverts after setOperationPolicy(id, null)
      runtime.setOperationPolicy("op-1", null);
      assert.equal(runtime.getEffectivePolicy("op-1").minQualityTier, 1);

      // Reverts after removeOperation(id)
      runtime.setOperationPolicy("op-2", { minQualityTier: 2 });
      assert.equal(runtime.getEffectivePolicy("op-2").minQualityTier, 2);
      runtime.removeOperation("op-2");
      assert.equal(runtime.getEffectivePolicy("op-2").minQualityTier, 1);

      // Trims whitespace from valid operationId
      assert.equal(runtime.getEffectivePolicy(" op-1 ").minQualityTier, 1);

      // Rejects invalid operationId
      for (const invalid of ["", "   ", null, undefined, 123, false]) {
        assert.throws(
          () => runtime.getEffectivePolicy(invalid as unknown as string),
          ConfigurationError,
        );
      }

      await runtime.close();
      // Remains readable after close()
      assert.equal(runtime.getEffectivePolicy("op-1").minQualityTier, 1);
    });

    it("getEffectivePolicy does not disturb LRU cache order or track untracked operations", async () => {
      const runtime = createAdaptiveRuntime({
        policy: { minQualityTier: 1 },
      });

      runtime.setOperationPolicy("tenant-a", { minQualityTier: 1 });
      runtime.setOperationPolicy("tenant-b", { minQualityTier: 2 });
      runtime.setOperationPolicy("tenant-c", { minQualityTier: 3 });
      assert.deepEqual(runtime.getTrackedOperations(), ["tenant-a", "tenant-b", "tenant-c"]);

      // Querying tenant-a with getEffectivePolicy does NOT move it to the end
      const policyA = runtime.getEffectivePolicy("tenant-a");
      assert.equal(policyA.minQualityTier, 1);
      assert.deepEqual(runtime.getTrackedOperations(), ["tenant-a", "tenant-b", "tenant-c"]);

      // Querying an untracked operation does NOT add it to tracked operations
      runtime.getEffectivePolicy("untracked-op");
      assert.deepEqual(runtime.getTrackedOperations(), ["tenant-a", "tenant-b", "tenant-c"]);

      // In contrast, getOperationPolicy does refresh LRU order
      runtime.getOperationPolicy("tenant-a");
      assert.deepEqual(runtime.getTrackedOperations(), ["tenant-b", "tenant-c", "tenant-a"]);

      await runtime.close();
    });

    it("getProviderDescriptors returns declared descriptors and does not affect LRU tracking", async () => {
      // Empty providers
      const runtimeEmpty = createAdaptiveRuntime({});
      const emptyDescriptors = runtimeEmpty.getProviderDescriptors();
      assert.deepEqual(emptyDescriptors, []);
      assert.ok(Object.isFrozen(emptyDescriptors));
      await runtimeEmpty.close();
      assert.deepEqual(runtimeEmpty.getProviderDescriptors(), []);

      // Configured providers
      const p1 = new FunctionSignalProvider({
        id: "p1",
        signalName: "signal.a",
        unit: "count",
        read: () => [],
      });
      const p2 = new FunctionSignalProvider({
        id: "p2",
        signalName: "signal.b",
        unit: "milliseconds",
        read: () => [],
      });
      const runtime = createAdaptiveRuntime({
        providers: [p1, p2],
      });

      const descriptors = runtime.getProviderDescriptors();
      assert.equal(descriptors.length, 2);
      assert.equal(descriptors[0]?.name, "signal.a");
      assert.equal(descriptors[0]?.unit, "count");
      assert.equal(descriptors[1]?.name, "signal.b");
      assert.equal(descriptors[1]?.unit, "milliseconds");
      assert.ok(Object.isFrozen(descriptors));

      // Does not alter LRU tracking
      assert.deepEqual(runtime.getTrackedOperations(), []);

      // Remains readable after close()
      await runtime.close();
      assert.equal(runtime.getProviderDescriptors().length, 2);
    });

    it("getProviderDescriptors delegates to collector.getDescriptors when present", async () => {
      const mockDescriptors = Object.freeze([
        { name: "collector.signal", unit: "custom" as const },
      ]);
      const collectorProto = SignalCollector.prototype as unknown as {
        getDescriptors?: () => readonly unknown[];
      };
      const original = collectorProto.getDescriptors;
      try {
        collectorProto.getDescriptors = () => mockDescriptors;
        const runtime = createAdaptiveRuntime({});
        assert.equal(runtime.getProviderDescriptors(), mockDescriptors);
        await runtime.close();
      } finally {
        if (original === undefined) {
          delete collectorProto.getDescriptors;
        } else {
          collectorProto.getDescriptors = original;
        }
      }
    });
  });

  describe("in-flight operation queries, idle pruning, and candidate samples", () => {
    function deferred<T = void>() {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    it("tracks in-flight state during selection and strategy execution phases, on completion, and on abort", async () => {
      const selectGate = deferred<void>();
      const execGate = deferred<void>();

      const slowProvider = new FunctionSignalProvider({
        id: "slow-provider",
        signalName: "slow.metric",
        unit: "count",
        read: async (context) => {
          await selectGate.promise;
          return [
            {
              name: "slow.metric",
              unit: "count",
              status: "ok",
              value: 10,
              observedAt: context.now,
            },
          ];
        },
      });

      const runtime = createAdaptiveRuntime({
        providers: [slowProvider],
        policy: { evaluationIntervalMs: 0 },
      });

      // Initially no operations in flight
      assert.equal(runtime.hasInFlight("op-flight"), false);
      assert.equal(runtime.hasInFlight(), false);
      assert.deepEqual(runtime.getActiveOperations(), []);

      const runPromise = runtime.run({
        operationId: "op-flight",
        input: 1,
        strategies: [
          {
            id: "flight-strat",
            qualityTier: 1,
            run: async () => {
              await execGate.promise;
              return "result";
            },
          },
        ],
      });

      // 1. Selection phase: slowProvider is awaiting selectGate
      // Let microtasks run so runtime enters #select
      await Promise.resolve();
      assert.equal(runtime.hasInFlight("op-flight"), true);
      assert.equal(runtime.hasInFlight(), true);
      assert.deepEqual(runtime.getActiveOperations(), ["op-flight"]);

      // Unblock selection phase; now enters strategy execution phase
      selectGate.resolve();
      // Allow execution to reach strategy.run()
      await Promise.resolve();
      await Promise.resolve();

      // 2. Execution phase: strategy is awaiting execGate
      assert.equal(runtime.hasInFlight("op-flight"), true);
      assert.equal(runtime.hasInFlight(), true);
      assert.deepEqual(runtime.getActiveOperations(), ["op-flight"]);

      // 3. Completion: unblock execution
      execGate.resolve();
      const result = await runPromise;
      assert.equal(result.value, "result");

      assert.equal(runtime.hasInFlight("op-flight"), false);
      assert.equal(runtime.hasInFlight(), false);
      assert.deepEqual(runtime.getActiveOperations(), []);

      // 4. Abort: verify active run cleanup
      const abortController = new AbortController();
      const abortExecGate = deferred<void>();
      const abortPromise = runtime.run({
        operationId: "op-aborted",
        input: 2,
        signal: abortController.signal,
        strategies: [
          {
            id: "abort-strat",
            qualityTier: 1,
            run: async ({ signal }) => {
              abortExecGate.resolve();
              return new Promise<string>((_, reject) => {
                signal.addEventListener(
                  "abort",
                  () => reject(new OperationAbortedError("op-aborted", signal.reason)),
                  { once: true },
                );
              });
            },
          },
        ],
      });

      await abortExecGate.promise;
      assert.equal(runtime.hasInFlight("op-aborted"), true);
      assert.equal(runtime.hasInFlight(), true);
      assert.deepEqual(runtime.getActiveOperations(), ["op-aborted"]);

      abortController.abort(new Error("caller-abort"));
      await assert.rejects(abortPromise, OperationAbortedError);

      assert.equal(runtime.hasInFlight("op-aborted"), false);
      assert.equal(runtime.hasInFlight(), false);
      assert.deepEqual(runtime.getActiveOperations(), []);

      // 5. Invalid operationId inputs
      for (const invalid of ["", "   ", null, 123, {}, false]) {
        assert.throws(() => runtime.hasInFlight(invalid as unknown as string), ConfigurationError);
      }

      await runtime.close();
      // Works even after close()
      assert.equal(runtime.hasInFlight("op-flight"), false);
      assert.equal(runtime.hasInFlight(), false);
      assert.deepEqual(runtime.getActiveOperations(), []);
    });

    it("getActiveOperations returns a frozen, deterministically code-unit sorted array under concurrent runs", async () => {
      const runtime = createAdaptiveRuntime();
      const gate = deferred<void>();

      const hangingStrategy = (id: string): Strategy<number, string> => ({
        id: `strat-${id}`,
        qualityTier: 1,
        run: async () => {
          await gate.promise;
          return id;
        },
      });

      // Launch multiple operations in arbitrary non-sorted order
      const ids = ["tenant-z", "tenant-10", "tenant-a", "tenant-2", "tenant-b"];
      const runs = ids.map((id) =>
        runtime.run({
          operationId: id,
          input: 1,
          strategies: [hangingStrategy(id)],
        }),
      );

      // Concurrent runs for the same operation id should be deduplicated
      const duplicateRun = runtime.run({
        operationId: "tenant-a",
        input: 2,
        strategies: [hangingStrategy("tenant-a-dup")],
      });

      // Let runs enter execution
      await Promise.resolve();

      const active = runtime.getActiveOperations();
      assert.ok(Object.isFrozen(active));
      // Code-unit ascending sort: "10" < "2" < "a" < "b" < "z"
      assert.deepEqual(active, ["tenant-10", "tenant-2", "tenant-a", "tenant-b", "tenant-z"]);

      // Inspection must be non-disturbing (does not alter tracked operations LRU order)
      const trackedBefore = runtime.getTrackedOperations();
      runtime.getActiveOperations();
      runtime.hasInFlight();
      runtime.hasInFlight("tenant-a");
      assert.deepEqual(runtime.getTrackedOperations(), trackedBefore);

      gate.resolve();
      await Promise.all([...runs, duplicateRun]);

      assert.deepEqual(runtime.getActiveOperations(), []);
      assert.ok(Object.isFrozen(runtime.getActiveOperations()));

      await runtime.close();
      assert.deepEqual(runtime.getActiveOperations(), []);
    });

    it("pruneIdleOperations preserves active and pinned operations while pruning idle ones", async () => {
      const runtime = createAdaptiveRuntime();
      const activeGate = deferred<void>();

      const simpleStrat = (name: string): Strategy<number, string> => ({
        id: `s-${name}`,
        qualityTier: 1,
        run: () => name,
      });

      // 1. Run idle operations to completion
      await runtime.run({ operationId: "op-idle-2", input: 1, strategies: [simpleStrat("2")] });
      await runtime.run({ operationId: "op-idle-1", input: 1, strategies: [simpleStrat("1")] });
      await runtime.run({ operationId: "op-pinned", input: 1, strategies: [simpleStrat("p")] });
      runtime.pinStrategy("op-pinned", "s-p");

      // 2. Start an in-flight operation
      const activeRun = runtime.run({
        operationId: "op-active",
        input: 1,
        strategies: [
          {
            id: "s-active",
            qualityTier: 1,
            run: async () => {
              await activeGate.promise;
              return "active";
            },
          },
        ],
      });

      await Promise.resolve();
      assert.equal(runtime.hasInFlight("op-active"), true);

      // 3. Prune idle operations: op-active and op-pinned must NOT be pruned
      const pruned = runtime.pruneIdleOperations();
      assert.ok(Object.isFrozen(pruned));
      // Code-unit ascending order: "op-idle-1" < "op-idle-2"
      assert.deepEqual(pruned, ["op-idle-1", "op-idle-2"]);

      const tracked = runtime.getTrackedOperations();
      assert.ok(tracked.includes("op-pinned"));
      assert.ok(tracked.includes("op-active"));
      assert.ok(!tracked.includes("op-idle-1"));
      assert.ok(!tracked.includes("op-idle-2"));

      // 4. Complete active operation and prune it
      activeGate.resolve();
      await activeRun;
      assert.equal(runtime.hasInFlight("op-active"), false);

      const pruned2 = runtime.pruneIdleOperations();
      assert.ok(Object.isFrozen(pruned2));
      assert.deepEqual(pruned2, ["op-active"]);
      assert.deepEqual(runtime.getTrackedOperations(), ["op-pinned"]);

      // 5. Subsequent call returns empty frozen array
      const prunedEmpty = runtime.pruneIdleOperations();
      assert.deepEqual(prunedEmpty, []);
      assert.ok(Object.isFrozen(prunedEmpty));

      // 6. Prune after close()
      await runtime.run({
        operationId: "op-pre-close",
        input: 1,
        strategies: [simpleStrat("pre")],
      });
      assert.ok(runtime.getTrackedOperations().includes("op-pre-close"));

      await runtime.close();
      // Must not throw RuntimeClosedError
      const prunedClosed = runtime.pruneIdleOperations();
      assert.deepEqual(prunedClosed, ["op-pre-close"]);
      assert.deepEqual(runtime.getTrackedOperations(), ["op-pinned"]);
    });

    it("populates live samples on candidate objects passed during policy evaluation", async () => {
      const runtime = createAdaptiveRuntime({
        policy: {
          evaluationIntervalMs: 0,
        },
      });

      const stratA: Strategy<number, string> = {
        id: "strat-a",
        qualityTier: 2,
        run: () => "A",
      };
      const stratB: Strategy<number, string> = {
        id: "strat-b",
        qualityTier: 1,
        run: () => "B",
      };

      runtime.pinStrategy("op-samples-test", "strat-a");

      let capturedCandidateA: { id: string; samples?: number } | undefined;
      let capturedCandidateB: { id: string; samples?: number } | undefined;

      const origFind = Array.prototype.find;
      const captureSamples = async (fn: () => Promise<unknown>) => {
        try {
          Array.prototype.find = function (
            this: unknown,
            predicate: (value: unknown, index: number, obj: unknown[]) => boolean,
            thisArg?: unknown,
          ) {
            if (
              Array.isArray(this) &&
              this.length > 0 &&
              this[0] !== null &&
              typeof this[0] === "object" &&
              "qualityTier" in this[0] &&
              "samples" in this[0]
            ) {
              const list = this as Array<{ id: string; samples?: number }>;
              for (const item of list) {
                if (item.id === "strat-a") {
                  capturedCandidateA = item;
                } else if (item.id === "strat-b") {
                  capturedCandidateB = item;
                }
              }
            }
            return origFind.apply(this, [predicate, thisArg] as never);
          };
          await fn();
        } finally {
          Array.prototype.find = origFind;
        }
      };

      // Run 1: 0 previous runs for both strategies
      await captureSamples(async () => {
        await runtime.run({
          operationId: "op-samples-test",
          input: 1,
          strategies: [stratA, stratB],
        });
      });
      assert.ok(capturedCandidateA);
      assert.ok(capturedCandidateB);
      assert.equal(capturedCandidateA.samples, 0);
      assert.equal(capturedCandidateB.samples, 0);

      // Run 2: strat-a was selected in Run 1 and has 1 run
      await captureSamples(async () => {
        await runtime.run({
          operationId: "op-samples-test",
          input: 1,
          strategies: [stratA, stratB],
        });
      });
      assert.ok(capturedCandidateA);
      assert.ok(capturedCandidateB);
      assert.equal(capturedCandidateA.samples, 1);
      assert.equal(capturedCandidateB.samples, 0);

      // Run 3: strat-a has 2 runs
      await captureSamples(async () => {
        await runtime.run({
          operationId: "op-samples-test",
          input: 1,
          strategies: [stratA, stratB],
        });
      });
      assert.ok(capturedCandidateA);
      assert.ok(capturedCandidateB);
      assert.equal(capturedCandidateA.samples, 2);
      assert.equal(capturedCandidateB.samples, 0);

      await runtime.close();
    });
  });
});
