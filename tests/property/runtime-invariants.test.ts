import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatDecisionSummary } from "../../src/policy/selectors.js";
import { createAdaptiveRuntime } from "../../src/runtime/runtime.js";
import type { Strategy } from "../../src/types/strategy.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { FunctionSignalProvider } from "../helpers/providers.js";
import { asyncFuzzRuns, fc, identifierArb } from "./support.js";

const strategySpecArb = fc.record({
  id: identifierArb,
  qualityTier: fc.integer({ min: -3, max: 5 }),
  costTier: fc.option(fc.integer({ min: -3, max: 5 }), { nil: undefined }),
});

const scenarioArb = fc.record({
  specs: fc.uniqueArray(strategySpecArb, {
    minLength: 1,
    maxLength: 6,
    selector: (spec) => spec.id,
  }),
  input: fc.integer({ min: -1_000, max: 1_000 }),
});

describe("property: runtime execution", () => {
  it("executes exactly one selected strategy once per run", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ specs, input }) => {
        const calls: string[] = [];
        const strategies: Strategy<number, string>[] = specs.map((spec) => ({
          id: spec.id,
          qualityTier: spec.qualityTier,
          ...(spec.costTier === undefined ? {} : { costTier: spec.costTier }),
          run: ({ input: value }) => {
            calls.push(spec.id);
            return `${spec.id}:${value}`;
          },
        }));
        const runtime = createAdaptiveRuntime({
          clock: new FakeClock(),
          policy: {
            evaluationIntervalMs: 0,
            consecutiveSamples: 1,
            budgets: [],
          },
        });

        try {
          const result = await runtime.run({
            operationId: "fuzz-runtime",
            input,
            strategies,
          });

          assert.equal(result.metadata.attempts, 1);
          assert.equal(result.metadata.decision.strategyId, result.metadata.strategyId);
          assert.equal(result.value, `${result.metadata.strategyId}:${input}`);
          assert.deepEqual(calls, [result.metadata.strategyId]);
          assert.equal(result.metadata.quality.status, "not-configured");
          assert.deepEqual(result.metadata.signals, []);

          const stats = runtime.getStats("fuzz-runtime");
          assert.equal(stats.runs, 1);
          assert.equal(stats.successes, 1);
          assert.equal(stats.failures, 0);
          assert.equal(stats.strategyRuns[result.metadata.strategyId], 1);
        } finally {
          await runtime.close();
        }
      }),
      { numRuns: asyncFuzzRuns },
    );
  });

  it("preserves bit-for-bit identical evaluation and state across exportState and importState round-trip", async () => {
    const operationsArb = fc.array(
      fc.record({
        operationId: fc.constantFrom("op-alpha", "op-beta", "op-gamma"),
        input: fc.integer({ min: 1, max: 100 }),
        pin: fc.option(fc.constantFrom("strat-high", "strat-low"), { nil: undefined }),
      }),
      { minLength: 1, maxLength: 8 },
    );

    const signalValueArb = fc.integer({ min: 10, max: 200 });

    await fc.assert(
      fc.asyncProperty(operationsArb, signalValueArb, async (ops, signalVal) => {
        let currentSignal = signalVal;
        const createProvider = () =>
          new FunctionSignalProvider({
            id: "fuzz-provider",
            signalName: "heap.pressure",
            read: (ctx) => [
              {
                name: "heap.pressure",
                unit: "bytes",
                status: "ok",
                value: currentSignal,
                observedAt: ctx.now,
              },
            ],
          });

        const policy = {
          evaluationIntervalMs: 0,
          consecutiveSamples: 1,
          budgets: [
            {
              id: "heap-budget",
              signal: "heap.pressure",
              limit: 100,
              recoverBelow: 50,
              tierReduction: 1,
            },
          ],
        };

        const clockA = new FakeClock(1000);
        const clockB = new FakeClock(1000);

        const runtimeA = createAdaptiveRuntime({
          clock: clockA,
          providers: [createProvider()],
          policy,
        });

        const runtimeB = createAdaptiveRuntime({
          clock: clockB,
          providers: [createProvider()],
          policy,
        });

        const strategies: Strategy<number, string>[] = [
          { id: "strat-high", qualityTier: 2, run: ({ input }) => `high:${input}` },
          { id: "strat-low", qualityTier: 1, run: ({ input }) => `low:${input}` },
        ];

        try {
          for (const op of ops) {
            clockA.advance(10);
            if (op.pin !== undefined) {
              runtimeA.pinStrategy(op.operationId, op.pin);
            }
            await runtimeA.run({
              operationId: op.operationId,
              input: op.input,
              strategies,
            });
          }

          // Synchronize runtimeB collector sequence to match runtimeA before hydrating state
          for (let i = 0; i < ops.length; i += 1) {
            await runtimeB.evaluate(
              { operationId: "collector-sync", input: 0, strategies },
              { dryRun: true },
            );
          }

          const snapshot = runtimeA.exportState();
          const restored = runtimeB.importState(snapshot);
          assert.equal(restored, snapshot.operations.length);

          clockB.advance(clockA.now() - clockB.now());
          currentSignal = signalVal > 100 ? 40 : 150;

          for (const opId of runtimeA.getTrackedOperations()) {
            const testOp = { operationId: opId, input: 999, strategies };
            const decA = await runtimeA.evaluate(testOp, { dryRun: true });
            const decB = await runtimeB.evaluate(testOp, { dryRun: true });

            assert.equal(decB.strategyId, decA.strategyId);
            assert.equal(decB.qualityTier, decA.qualityTier);
            assert.equal(decB.kind, decA.kind);
            assert.equal(decB.changed, decA.changed);
            assert.equal(decB.baseQualityTier, decA.baseQualityTier);
            assert.equal(decB.targetQualityTier, decA.targetQualityTier);
            assert.deepEqual(decB.reasons, decA.reasons);
            assert.deepEqual(decB.budgets, decA.budgets);

            assert.deepEqual(runtimeB.getStats(opId), runtimeA.getStats(opId));
          }
        } finally {
          await runtimeA.close();
          await runtimeB.close();
        }
      }),
      { numRuns: asyncFuzzRuns },
    );
  });

  it("preserves identical explain and shadow evaluation decisions across exportState and importState round-trip under randomized operation sequences and signal fluctuations", async () => {
    const actionArb = fc.oneof(
      fc.record({
        type: fc.constant("run" as const),
        operationId: fc.constantFrom("op-alpha", "op-beta", "op-gamma", "op-delta"),
        input: fc.integer({ min: 1, max: 500 }),
      }),
      fc.record({
        type: fc.constant("evaluateShadow" as const),
        operationId: fc.constantFrom("op-alpha", "op-beta", "op-gamma", "op-delta"),
        input: fc.integer({ min: 1, max: 500 }),
        dryRun: fc.boolean(),
      }),
      fc.record({
        type: fc.constant("pin" as const),
        operationId: fc.constantFrom("op-alpha", "op-beta", "op-gamma", "op-delta"),
        strategyId: fc.constantFrom("strat-high", "strat-mid", "strat-low"),
      }),
      fc.record({
        type: fc.constant("unpin" as const),
        operationId: fc.constantFrom("op-alpha", "op-beta", "op-gamma", "op-delta"),
      }),
      fc.record({
        type: fc.constant("adaptation" as const),
        operationId: fc.constantFrom("op-alpha", "op-beta", "op-gamma", "op-delta"),
        enabled: fc.boolean(),
      }),
      fc.record({
        type: fc.constant("signal" as const),
        value: fc.integer({ min: 10, max: 250 }),
      }),
      fc.record({
        type: fc.constant("advanceTime" as const),
        deltaMs: fc.integer({ min: 10, max: 200 }),
      }),
    );

    const testScenarioArb = fc.record({
      actions: fc.array(actionArb, { minLength: 3, maxLength: 12 }),
      testSignals: fc.array(fc.integer({ min: 10, max: 250 }), { minLength: 1, maxLength: 3 }),
    });

    await fc.assert(
      fc.asyncProperty(testScenarioArb, async ({ actions, testSignals }) => {
        let currentSignal = 50;
        const createProvider = () =>
          new FunctionSignalProvider({
            id: "fuzz-provider",
            signalName: "heap.pressure",
            read: (ctx) => [
              {
                name: "heap.pressure",
                unit: "bytes",
                status: "ok",
                value: currentSignal,
                observedAt: ctx.now,
              },
            ],
          });

        const policy = {
          evaluationIntervalMs: 0,
          consecutiveSamples: 1,
          budgets: [
            {
              id: "heap-budget",
              signal: "heap.pressure",
              limit: 100,
              recoverBelow: 50,
              tierReduction: 1,
            },
          ],
        };

        const clockA = new FakeClock(1000);
        const runtimeA = createAdaptiveRuntime({
          clock: clockA,
          providers: [createProvider()],
          policy,
        });

        const strategies: Strategy<number, string>[] = [
          { id: "strat-high", qualityTier: 3, costTier: 3, run: ({ input }) => `high:${input}` },
          { id: "strat-mid", qualityTier: 2, costTier: 2, run: ({ input }) => `mid:${input}` },
          { id: "strat-low", qualityTier: 1, costTier: 1, run: ({ input }) => `low:${input}` },
        ];

        let collectionCount = 0;
        try {
          for (const action of actions) {
            switch (action.type) {
              case "run":
                collectionCount += 1;
                await runtimeA.run({
                  operationId: action.operationId,
                  input: action.input,
                  strategies,
                });
                break;
              case "evaluateShadow":
                collectionCount += 1;
                await runtimeA.evaluate(
                  {
                    operationId: action.operationId,
                    input: action.input,
                    strategies,
                  },
                  { dryRun: action.dryRun },
                );
                break;
              case "pin":
                runtimeA.pinStrategy(action.operationId, action.strategyId);
                break;
              case "unpin":
                runtimeA.unpinStrategy(action.operationId);
                break;
              case "adaptation":
                runtimeA.setAdaptationEnabled(action.operationId, action.enabled);
                break;
              case "signal":
                currentSignal = action.value;
                break;
              case "advanceTime":
                clockA.advance(action.deltaMs);
                break;
            }
          }

          const snapshot = runtimeA.exportState();

          const clockB = new FakeClock(clockA.now());
          const runtimeB = createAdaptiveRuntime({
            clock: clockB,
            providers: [createProvider()],
            policy,
          });

          try {
            // Synchronize runtimeB collector sequence to match runtimeA before hydrating state
            for (let i = 0; i < collectionCount; i += 1) {
              await runtimeB.evaluate(
                { operationId: "collector-sync", input: 0, strategies },
                { dryRun: true },
              );
            }

            const restored = runtimeB.importState(snapshot);
            assert.equal(restored, snapshot.operations.length);

            for (const testSig of testSignals) {
              currentSignal = testSig;
              for (const opId of runtimeA.getTrackedOperations()) {
                const testOp = { operationId: opId, input: 999, strategies };
                const decA = await runtimeA.evaluate(testOp, { dryRun: true });
                const decB = await runtimeB.evaluate(testOp, { dryRun: true });

                assert.equal(decB.strategyId, decA.strategyId);
                assert.equal(decB.qualityTier, decA.qualityTier);
                assert.equal(decB.kind, decA.kind);
                assert.equal(decB.changed, decA.changed);
                assert.equal(decB.baseQualityTier, decA.baseQualityTier);
                assert.equal(decB.targetQualityTier, decA.targetQualityTier);
                assert.deepEqual(decB.reasons, decA.reasons);
                assert.deepEqual(decB.budgets, decA.budgets);
                assert.equal(formatDecisionSummary(decB), formatDecisionSummary(decA));

                assert.deepEqual(runtimeB.getStats(opId), runtimeA.getStats(opId));
                const decPersistA = runtimeA.getDecision(opId);
                const decPersistB = runtimeB.getDecision(opId);
                if (decPersistA === null) {
                  assert.equal(decPersistB, null);
                } else {
                  assert.ok(decPersistB !== null);
                  assert.equal(decPersistB.strategyId, decPersistA.strategyId);
                  assert.equal(decPersistB.qualityTier, decPersistA.qualityTier);
                  assert.equal(decPersistB.kind, decPersistA.kind);
                  assert.deepEqual(decPersistB.reasons, decPersistA.reasons);
                  assert.deepEqual(
                    JSON.parse(JSON.stringify(decPersistB)),
                    JSON.parse(JSON.stringify(decPersistA)),
                  );
                }
              }
            }
          } finally {
            await runtimeB.close();
          }
        } finally {
          await runtimeA.close();
        }
      }),
      { numRuns: asyncFuzzRuns },
    );
  });

  it("guarantees pinned and active operations are never evicted and tracked count never exceeds maxTrackedOperations plus pinnedCount under churn", async () => {
    const evictionArb = fc.record({
      maxTracked: fc.integer({ min: 3, max: 6 }),
      pinnedIds: fc.uniqueArray(fc.constantFrom("pin-1", "pin-2", "pin-3", "pin-4"), {
        minLength: 1,
        maxLength: 3,
      }),
      churnIds: fc.array(
        fc.integer({ min: 1, max: 25 }).map((n) => `churn-op-${n}`),
        {
          minLength: 12,
          maxLength: 25,
        },
      ),
    });

    await fc.assert(
      fc.asyncProperty(evictionArb, async ({ maxTracked, pinnedIds, churnIds }) => {
        const runtime = createAdaptiveRuntime({
          policy: {
            maxTrackedOperations: maxTracked,
          },
        });

        const fastStrategy: Strategy<number, number> = {
          id: "strat-fast",
          qualityTier: 1,
          run: ({ input }) => input * 2,
        };

        let resolveActiveRun!: () => void;
        const activeRunGate = new Promise<void>((resolve) => {
          resolveActiveRun = resolve;
        });

        const slowStrategy: Strategy<number, number> = {
          id: "strat-slow",
          qualityTier: 1,
          run: async ({ input }) => {
            await activeRunGate;
            return input * 2;
          },
        };

        const inFlightOpId = "active-in-flight-op";

        try {
          // Pin designated operations
          for (const pId of pinnedIds) {
            runtime.pinStrategy(pId, "strat-fast");
          }

          // Launch an active operation that stays in-flight during the churn
          const inFlightPromise = runtime.run({
            operationId: inFlightOpId,
            input: 42,
            strategies: [slowStrategy],
          });

          // Run randomized churn operations while inFlightOpId is active
          for (const churnId of churnIds) {
            await runtime.run({
              operationId: churnId,
              input: 10,
              strategies: [fastStrategy],
            });

            const trackedMid = runtime.getTrackedOperations();
            // Invariant: Currently executing operation is NEVER evicted
            assert.ok(
              trackedMid.includes(inFlightOpId),
              `Active in-flight operation "${inFlightOpId}" must never be evicted during churn`,
            );

            // Invariant: Pinned operations are NEVER evicted
            for (const pId of pinnedIds) {
              assert.ok(
                trackedMid.includes(pId),
                `Pinned operation "${pId}" must never be evicted during churn`,
              );
            }
          }

          // Complete the in-flight operation
          resolveActiveRun();
          const inFlightResult = await inFlightPromise;
          assert.equal(inFlightResult.value, 84);

          // Now after completion of all runs, check tracked count invariant
          const finalTracked = runtime.getTrackedOperations();

          // All pinned operations must remain tracked
          for (const pId of pinnedIds) {
            assert.ok(
              finalTracked.includes(pId),
              `Pinned operation "${pId}" must remain tracked after churn completion`,
            );
          }

          // Tracked count after completion never exceeds maxTrackedOperations + pinnedCount
          assert.ok(
            finalTracked.length <= maxTracked + pinnedIds.length,
            `Tracked count (${finalTracked.length}) must not exceed maxTracked (${maxTracked}) + pinnedCount (${pinnedIds.length})`,
          );
        } finally {
          resolveActiveRun();
          await runtime.close();
        }
      }),
      { numRuns: asyncFuzzRuns },
    );
  });
});
