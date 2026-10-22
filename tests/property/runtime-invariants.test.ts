import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAdaptiveRuntime } from "../../src/runtime/runtime.js";
import type { Strategy } from "../../src/types/strategy.js";
import { FakeClock } from "../helpers/fake-clock.js";
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
});
