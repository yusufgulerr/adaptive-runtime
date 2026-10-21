import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScriptedSignalProvider } from "../../examples/shared/scripted-signal-provider.js";

const MEBIBYTE = 1024 * 1024;

describe("examples", () => {
  it("basic example uses the high tier when pressure is low", async () => {
    const { runBasicExample } = await import("../../examples/basic/basic.js");
    const provider = new ScriptedSignalProvider({
      id: "basic-low-pressure",
      script: [
        {
          name: "process.memory.heapUsed",
          unit: "bytes",
          values: [64 * MEBIBYTE],
        },
      ],
    });

    const result = await runBasicExample({ provider });

    assert.equal(result.value, 50_005_000);
    assert.equal(result.strategyId, "high-quality");
    assert.equal(result.qualityTier, 2);
    assert.equal(result.decisionKind, "initial");
    assert.equal(result.qualityStatus, "passed");
    assert.equal(result.signals.length, 1);
    assert.equal(result.signals[0]?.name, "process.memory.heapUsed");
  });

  it("basic example degrades when the heap budget is exceeded", async () => {
    const { runBasicExample } = await import("../../examples/basic/basic.js");
    const provider = new ScriptedSignalProvider({
      id: "basic-high-pressure",
      script: [
        {
          name: "process.memory.heapUsed",
          unit: "bytes",
          values: [700 * MEBIBYTE],
        },
      ],
    });

    const result = await runBasicExample({ provider });

    assert.equal(result.value, 50_005_000);
    assert.equal(result.strategyId, "economy");
    assert.equal(result.qualityTier, 1);
    assert.equal(result.qualityStatus, "passed");
  });

  it("search example follows the deterministic pressure sequence", async () => {
    const { runSearchExample } = await import("../../examples/resource-aware-search/search.js");
    const lines: string[] = [];

    const result = await runSearchExample({
      corpusSize: 2_000,
      logger: (line) => lines.push(line),
    });

    assert.deepEqual(result.strategySequence, [
      "exhaustive",
      "balanced",
      "balanced",
      "economy",
      "economy",
      "exhaustive",
    ]);
    assert.equal(result.summary[0]?.recall, 1);
    assert.ok(Math.abs((result.summary[1]?.recall ?? 0) - 0.6) < 0.01);
    assert.equal(result.summary[3]?.matches, 25);
    assert.ok((result.summary[3]?.recall ?? 1) < (result.summary[1]?.recall ?? 0));
    assert.equal(result.summary.length, 6);
    assert.ok(lines.some((line) => line.includes("reference matches")));
  });

  it("planning example adapts, holds, and recovers with stable transitions", async () => {
    const { runPlanningExample } = await import(
      "../../examples/resource-pressure-planning/planning.js"
    );
    const lines: string[] = [];

    const result = await runPlanningExample({ logger: (line) => lines.push(line) });

    assert.deepEqual(result.strategySequence, [
      "optimal",
      "optimal",
      "optimal",
      "economy",
      "economy",
      "economy",
      "economy",
      "optimal",
    ]);
    assert.equal(result.optimalPriority, 85);
    assert.equal(result.summary[0]?.qualityRatio, 1);
    assert.equal(result.summary[3]?.qualityRatio, 80 / 85);
    assert.deepEqual(
      result.summary.map((row) => row.decisionKind),
      ["initial", "retained", "retained", "adapted", "retained", "retained", "retained", "adapted"],
    );
    assert.equal(result.summary[3]?.reasons.includes("quality-pressure"), true);
    assert.ok(lines.some((line) => line.includes("optimal priority: 85")));
  });
});
