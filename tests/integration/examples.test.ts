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

  it("edge example degrades through three tiers and recovers deterministically", async () => {
    const { runEdgeGatewayExample } = await import(
      "../../examples/multi-runtime-edge/edge-gateway.js"
    );
    const lines: string[] = [];

    const result = await runEdgeGatewayExample({ logger: (line) => lines.push(line) });

    assert.deepEqual(result.strategySequence, [
      "deep-rerank",
      "deep-rerank",
      "fast-vector",
      "cached-lexical",
      "deep-rerank",
    ]);
    assert.deepEqual(result.decisionKinds, [
      "initial",
      "retained",
      "adapted",
      "adapted",
      "adapted",
    ]);
    assert.deepEqual(result.values, [
      "request-1:deep-rerank",
      "request-2:deep-rerank",
      "request-3:fast-vector",
      "request-4:cached-lexical",
      "request-5:deep-rerank",
    ]);

    const expectedPressure = [0.06, 0.4, 0.63, 0.86, 0.3];
    for (const [index, expected] of expectedPressure.entries()) {
      const actual = result.pressureScores[index];
      assert.equal(typeof actual, "number");
      assert.ok(Math.abs((actual ?? 0) - expected) < 1e-9);
    }

    const prometheus = result.prometheusText;
    for (const line of [
      "# HELP edge_gateway_runs_total Total number of strategy runs completed or failed.",
      "# TYPE edge_gateway_runs_total counter",
      'edge_gateway_runs_total{operation_id="edge-gateway",result="success",strategy_id="deep-rerank"} 3',
      'edge_gateway_runs_total{operation_id="edge-gateway",result="success",strategy_id="fast-vector"} 1',
      'edge_gateway_runs_total{operation_id="edge-gateway",result="success",strategy_id="cached-lexical"} 1',
      'edge_gateway_signal_reading{operation_id="edge-gateway",signal="edge.pressure.score",status="ok"} 0.3',
      "edge_gateway_runtime_closed_total 1",
    ]) {
      assert.ok(prometheus.includes(line), `Prometheus output must contain: ${line}`);
    }
    assert.ok(!prometheus.includes("edge_gateway_signal_status_total"));
    assert.ok(lines.some((line) => line.includes("request 4: strategy=cached-lexical")));
    assert.ok(lines.some((line) => line.includes("strategy sequence: deep-rerank")));
  });
});
