import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
});
