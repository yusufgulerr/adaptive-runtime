import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ConfigurationError,
  OperationAbortedError,
  QualityCheckError,
} from "../../src/errors/index.js";
import { createAdaptiveRuntime } from "../../src/runtime/runtime.js";
import type { CustomSelectorCandidate } from "../../src/types/policy.js";
import type { RuntimeStateSnapshot } from "../../src/types/state.js";
import type { Strategy } from "../../src/types/strategy.js";
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
});
