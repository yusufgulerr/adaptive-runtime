import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type MetricLabels,
  OBSERVABILITY_ERROR_OPERATION,
  OBSERVABILITY_HEAP_SIGNAL,
  OBSERVABILITY_SUCCESS_OPERATION,
  type ObservabilityExampleResult,
  runObservabilityExample,
} from "../../examples/observability/metrics.js";
import type { Clock } from "../../src/index.js";

const MEBIBYTE = 1024 * 1024;

function sameLabels(left: MetricLabels, right: MetricLabels): boolean {
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.entries(left).every(([key, value]) => right[key] === value)
  );
}

function counterValue(
  result: ObservabilityExampleResult,
  name: string,
  labels: MetricLabels,
): number {
  const match = result.counters.find(
    (counter) => counter.name === name && sameLabels(counter.labels, labels),
  );
  if (match === undefined) {
    throw new Error(`Missing counter ${name} ${JSON.stringify(labels)}.`);
  }
  return match.value;
}

describe("observability example", () => {
  it("maps deterministic counters and reports no listener failures", async () => {
    let tick = 0;
    const clock: Clock = {
      now: () => {
        tick += 1;
        return tick;
      },
      setTimeout: () => ({
        cancel: () => undefined,
      }),
    };
    const result = await runObservabilityExample({ clock });

    assert.equal(
      counterValue(result, "adaptive_runtime_runs_total", {
        operation_id: OBSERVABILITY_SUCCESS_OPERATION,
        strategy_id: "accurate",
        result: "success",
      }),
      1,
    );
    assert.equal(
      counterValue(result, "adaptive_runtime_runs_total", {
        operation_id: OBSERVABILITY_ERROR_OPERATION,
        strategy_id: "unstable",
        result: "error",
      }),
      1,
    );
    assert.equal(
      counterValue(result, "adaptive_runtime_provider_errors_total", {
        provider_id: "observability-scripted",
      }),
      1,
    );
    assert.equal(
      counterValue(result, "adaptive_runtime_decisions_total", {
        operation_id: OBSERVABILITY_SUCCESS_OPERATION,
        kind: "initial",
        changed: "false",
      }),
      1,
    );
    assert.equal(
      counterValue(result, "adaptive_runtime_decisions_total", {
        operation_id: OBSERVABILITY_ERROR_OPERATION,
        kind: "pinned",
        changed: "false",
      }),
      1,
    );
    assert.equal(
      counterValue(result, "adaptive_runtime_strategy_selections_total", {
        operation_id: OBSERVABILITY_SUCCESS_OPERATION,
        strategy_id: "accurate",
      }),
      1,
    );
    assert.equal(
      counterValue(result, "adaptive_runtime_strategy_selections_total", {
        operation_id: OBSERVABILITY_ERROR_OPERATION,
        strategy_id: "unstable",
      }),
      1,
    );
    assert.equal(
      counterValue(result, "adaptive_runtime_quality_total", {
        operation_id: OBSERVABILITY_SUCCESS_OPERATION,
        strategy_id: "accurate",
        status: "passed",
      }),
      1,
    );
    assert.equal(
      counterValue(result, "adaptive_runtime_signal_status_total", {
        operation_id: OBSERVABILITY_ERROR_OPERATION,
        signal: OBSERVABILITY_HEAP_SIGNAL,
        status: "error",
      }),
      1,
    );
    assert.equal(counterValue(result, "adaptive_runtime_runtime_closed_total", {}), 1);
    assert.equal(
      result.counters.some((counter) => counter.name === "adaptive_runtime_listener_errors_total"),
      false,
    );

    const signalGauges = result.gauges.filter(
      (gauge) => gauge.name === "adaptive_runtime_signal_reading",
    );
    assert.equal(signalGauges.length, 1);
    assert.equal(signalGauges[0]?.labels.operation_id, OBSERVABILITY_SUCCESS_OPERATION);
    assert.equal(signalGauges[0]?.labels.signal, OBSERVABILITY_HEAP_SIGNAL);
    assert.equal(signalGauges[0]?.labels.status, "ok");
    assert.equal(signalGauges[0]?.value, 128 * MEBIBYTE);

    const durationHistograms = result.histograms.filter(
      (histogram) => histogram.name === "adaptive_runtime_run_duration_seconds",
    );
    assert.equal(durationHistograms.length, 2);
    assert.equal(
      durationHistograms.reduce((total, histogram) => total + histogram.count, 0),
      2,
    );
    for (const histogram of durationHistograms) {
      assert.equal(histogram.count, 1);
      assert.ok(histogram.sum > 0);
      assert.ok(histogram.sum < 1);
      assert.ok(histogram.min > 0);
      assert.ok(histogram.max >= histogram.min);
      const bucketCounts = histogram.buckets.map((bucket) => bucket.count);
      assert.deepEqual(
        bucketCounts,
        [...bucketCounts].sort((left, right) => left - right),
      );
      assert.equal(histogram.buckets.at(-1)?.le, Number.POSITIVE_INFINITY);
      assert.equal(histogram.buckets.at(-1)?.count, histogram.count);
    }
    assert.equal(
      counterValue(result, "adaptive_runtime_budget_status_total", {
        operation_id: OBSERVABILITY_ERROR_OPERATION,
        budget_id: "heap-budget",
        status: "error",
      }),
      1,
    );
    assert.equal(
      result.gauges.some(
        (gauge) =>
          gauge.name === "adaptive_runtime_budget_engaged" &&
          gauge.labels.operation_id === OBSERVABILITY_ERROR_OPERATION,
      ),
      false,
    );
    assert.ok(result.logLines.some((line) => line.includes("provider error")));
    assert.ok(result.logLines.some((line) => line.includes("run error")));
    assert.equal(
      result.logLines.some((line) => line.includes("listener error")),
      false,
    );
  });
});
