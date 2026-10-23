import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAdaptiveRuntime } from "../../src/core.js";
import {
  attachOpenTelemetryMeter,
  type CounterLike,
  createMetricsCollector,
  type HistogramLikeMetric,
  type MetricAttributesLike,
  type MetricOptionsLike,
  type OpenTelemetryMeterLike,
  type UpDownCounterLike,
} from "../../src/observability/index.js";
import { definePolicy } from "../../src/policy/index.js";
import type {
  ResourceSignal,
  SignalDescriptor,
  SignalProvider,
  SignalReadContext,
  SignalStatus,
} from "../../src/types/signals.js";
import type { Strategy } from "../../src/types/strategy.js";

interface RecordedMetricCall {
  readonly value: number;
  readonly attributes?: MetricAttributesLike;
}

class MockCounter implements CounterLike {
  readonly calls: RecordedMetricCall[] = [];
  shouldThrow = false;

  constructor(
    readonly name: string,
    readonly options?: MetricOptionsLike,
  ) {}

  add(value: number, attributes?: MetricAttributesLike): void {
    if (this.shouldThrow) {
      throw new Error(`HOSTILE_COUNTER_ERROR: ${this.name}`);
    }
    this.calls.push({ value, attributes });
  }
}

class MockHistogram implements HistogramLikeMetric {
  readonly calls: RecordedMetricCall[] = [];
  shouldThrow = false;

  constructor(
    readonly name: string,
    readonly options?: MetricOptionsLike,
  ) {}

  record(value: number, attributes?: MetricAttributesLike): void {
    if (this.shouldThrow) {
      throw new Error(`HOSTILE_HISTOGRAM_ERROR: ${this.name}`);
    }
    this.calls.push({ value, attributes });
  }
}

class MockUpDownCounter implements UpDownCounterLike {
  readonly calls: RecordedMetricCall[] = [];
  shouldThrow = false;

  constructor(
    readonly name: string,
    readonly options?: MetricOptionsLike,
  ) {}

  add(value: number, attributes?: MetricAttributesLike): void {
    if (this.shouldThrow) {
      throw new Error(`HOSTILE_UPDOWN_ERROR: ${this.name}`);
    }
    this.calls.push({ value, attributes });
  }
}

class MockOpenTelemetryMeter implements OpenTelemetryMeterLike {
  readonly counters = new Map<string, MockCounter>();
  readonly histograms = new Map<string, MockHistogram>();
  readonly upDownCounters = new Map<string, MockUpDownCounter>();

  createCounter(name: string, options?: MetricOptionsLike): CounterLike {
    const counter = new MockCounter(name, options);
    this.counters.set(name, counter);
    return counter;
  }

  createHistogram(name: string, options?: MetricOptionsLike): HistogramLikeMetric {
    const histogram = new MockHistogram(name, options);
    this.histograms.set(name, histogram);
    return histogram;
  }

  createUpDownCounter(name: string, options?: MetricOptionsLike): UpDownCounterLike {
    const upDownCounter = new MockUpDownCounter(name, options);
    this.upDownCounters.set(name, upDownCounter);
    return upDownCounter;
  }
}

class MultiStatusSignalProvider implements SignalProvider {
  readonly id = "multi-status-provider";
  readonly signals: readonly SignalDescriptor[] = [
    { name: "sample.ok", unit: "count" },
    { name: "sample.unknown", unit: "count" },
    { name: "sample.unsupported", unit: "count" },
    { name: "sample.stale", unit: "count" },
    { name: "sample.error", unit: "count" },
  ];

  read(context: SignalReadContext): readonly ResourceSignal[] {
    const statuses: Array<{ name: string; status: SignalStatus; value?: number; error?: string }> =
      [
        { name: "sample.ok", status: "ok", value: 42 },
        { name: "sample.unknown", status: "unknown", error: "Not yet available" },
        {
          name: "sample.unsupported",
          status: "unsupported",
          error: "Not supported in environment",
        },
        { name: "sample.stale", status: "stale", error: "Stale data" },
        { name: "sample.error", status: "error", error: "Hardware sensor fault" },
      ];

    return statuses.map((s) => {
      if (s.status === "ok") {
        return {
          name: s.name,
          unit: "count",
          status: "ok",
          value: s.value as number,
          observedAt: context.now,
          confidence: 1,
        };
      }
      return {
        name: s.name,
        unit: "count",
        status: s.status,
        observedAt: context.now,
        error: s.error,
      };
    });
  }
}

const standardStrategy: Strategy<string, string> = {
  id: "standard",
  qualityTier: 1,
  run: async (context) => `standard:${context.input}`,
  checkQuality: async (value) => ({ ok: true, score: 0.95, detail: `Quality ok for ${value}` }),
};

describe("Tier 3 E2E: Dual Telemetry Export (Prometheus + OpenTelemetry)", () => {
  it("binds both Prometheus MetricsCollector and OpenTelemetry meter to the same runtime and verifies full metric emission", async () => {
    const prefix = "dual_tier3";
    const collector = createMetricsCollector({ prefix, maxSeries: 1000 });
    const otelMeter = new MockOpenTelemetryMeter();

    const provider = new MultiStatusSignalProvider();
    const runtime = createAdaptiveRuntime({
      providers: [provider],
      policy: definePolicy({
        evaluationIntervalMs: 0,
        defaultStrategyId: "standard",
        budgets: [
          {
            id: "ok-budget",
            signal: "sample.ok",
            limit: 50,
            recoverBelow: 40,
            consecutiveSamples: 1,
          },
        ],
      }),
    });

    const detachCollector = collector.attach(runtime);
    const detachOtel = attachOpenTelemetryMeter(runtime, otelMeter, { prefix });

    try {
      const result = await runtime.run({
        operationId: "dual-telemetry-op",
        input: "test-data",
        strategies: [standardStrategy],
      });

      assert.equal(result.value, "standard:test-data");

      // --- Verify Prometheus Output ---
      const prometheusText = collector.toPrometheusText();
      assert.ok(prometheusText.includes(`# HELP ${prefix}_runs_total`));
      assert.ok(prometheusText.includes(`# TYPE ${prefix}_runs_total counter`));
      assert.ok(
        prometheusText.includes(
          `${prefix}_runs_total{operation_id="dual-telemetry-op",result="success",strategy_id="standard"} 1`,
        ),
      );

      assert.ok(prometheusText.includes(`# HELP ${prefix}_strategy_selections_total`));
      assert.ok(
        prometheusText.includes(
          `${prefix}_strategy_selections_total{operation_id="dual-telemetry-op",strategy_id="standard"} 1`,
        ),
      );

      assert.ok(prometheusText.includes(`# HELP ${prefix}_run_duration_seconds`));
      assert.ok(prometheusText.includes(`${prefix}_run_duration_seconds_bucket`));
      assert.ok(prometheusText.includes(`${prefix}_run_duration_seconds_count`));
      assert.ok(prometheusText.includes(`${prefix}_run_duration_seconds_sum`));

      assert.ok(prometheusText.includes(`# HELP ${prefix}_quality_total`));
      assert.ok(
        prometheusText.includes(
          `${prefix}_quality_total{operation_id="dual-telemetry-op",status="passed",strategy_id="standard"} 1`,
        ),
      );

      // --- Verify OpenTelemetry Meter Calls ---
      // UpDownCounters:
      const signalReadingCounter = otelMeter.upDownCounters.get(`${prefix}_signal_reading`);
      assert.ok(signalReadingCounter !== undefined, "signal_reading UpDownCounter must be created");
      const budgetEngagedCounter = otelMeter.upDownCounters.get(`${prefix}_budget_engaged`);
      assert.ok(budgetEngagedCounter !== undefined, "budget_engaged UpDownCounter must be created");

      // Verify budget engaged was emitted (value 0 since limit 50 > 42)
      assert.ok(budgetEngagedCounter.calls.some((c) => c.value === 0));

      // Counters:
      const otelRuns = otelMeter.counters.get(`${prefix}_runs_total`);
      assert.ok(otelRuns !== undefined);
      assert.equal(otelRuns.calls.length, 1);
      assert.equal(otelRuns.calls[0]?.value, 1);
      assert.equal(otelRuns.calls[0]?.attributes?.result, "success");

      const otelSelections = otelMeter.counters.get(`${prefix}_strategy_selections_total`);
      assert.ok(otelSelections !== undefined);
      assert.equal(otelSelections.calls.length, 1);
      assert.equal(otelSelections.calls[0]?.value, 1);

      // Histogram:
      const otelDuration = otelMeter.histograms.get(`${prefix}_run_duration_seconds`);
      assert.ok(otelDuration !== undefined);
      assert.equal(otelDuration.calls.length, 1);
      assert.ok(
        (otelDuration.calls[0]?.value as number) >= 0,
        "Run duration must be non-negative in seconds",
      );
    } finally {
      detachCollector();
      detachOtel();
      await runtime.close();
    }
  });

  it("enforces strict zero-coercion invariant: non-ok signal readings never emit 0 gauge values", async () => {
    const prefix = "zero_coercion_tier3";
    const collector = createMetricsCollector({ prefix });
    const otelMeter = new MockOpenTelemetryMeter();

    const provider = new MultiStatusSignalProvider();
    const runtime = createAdaptiveRuntime({
      providers: [provider],
      policy: definePolicy({
        evaluationIntervalMs: 0,
        defaultStrategyId: "standard",
      }),
    });

    collector.attach(runtime);
    attachOpenTelemetryMeter(runtime, otelMeter, { prefix });

    try {
      await runtime.run({
        operationId: "zero-coercion-op",
        input: "payload",
        strategies: [standardStrategy],
      });

      // 1. Check Prometheus output
      const prometheusText = collector.toPrometheusText();

      // "sample.ok" should emit gauge value 42
      assert.ok(
        prometheusText.includes(
          `${prefix}_signal_reading{operation_id="zero-coercion-op",signal="sample.ok",status="ok"} 42`,
        ),
      );

      // Invariant: Non-ok signals (unknown, unsupported, stale, error) must NEVER emit gauge entries!
      assert.equal(
        prometheusText.includes(
          `${prefix}_signal_reading{operation_id="zero-coercion-op",signal="sample.unknown"`,
        ),
        false,
        "sample.unknown must not emit a gauge reading",
      );
      assert.equal(
        prometheusText.includes(
          `${prefix}_signal_reading{operation_id="zero-coercion-op",signal="sample.unsupported"`,
        ),
        false,
        "sample.unsupported must not emit a gauge reading",
      );
      assert.equal(
        prometheusText.includes(
          `${prefix}_signal_reading{operation_id="zero-coercion-op",signal="sample.stale"`,
        ),
        false,
        "sample.stale must not emit a gauge reading",
      );
      assert.equal(
        prometheusText.includes(
          `${prefix}_signal_reading{operation_id="zero-coercion-op",signal="sample.error"`,
        ),
        false,
        "sample.error must not emit a gauge reading",
      );

      // Verify gauges in collector snapshot only contain ok status and never 0
      const snapshot = collector.getSnapshot();
      for (const gauge of snapshot.gauges) {
        if (gauge.name === `${prefix}_signal_reading`) {
          assert.equal(gauge.labels.status, "ok");
          assert.notEqual(gauge.value, 0, "Signal gauge must never be coerced to 0");
        }
      }

      // Non-ok signals must increment the signal_status_total counter instead:
      assert.ok(
        prometheusText.includes(
          `${prefix}_signal_status_total{operation_id="zero-coercion-op",signal="sample.unknown",status="unknown"} 1`,
        ),
      );
      assert.ok(
        prometheusText.includes(
          `${prefix}_signal_status_total{operation_id="zero-coercion-op",signal="sample.unsupported",status="unsupported"} 1`,
        ),
      );
      assert.ok(
        prometheusText.includes(
          `${prefix}_signal_status_total{operation_id="zero-coercion-op",signal="sample.stale",status="stale"} 1`,
        ),
      );
      assert.ok(
        prometheusText.includes(
          `${prefix}_signal_status_total{operation_id="zero-coercion-op",signal="sample.error",status="error"} 1`,
        ),
      );

      // 2. Check OpenTelemetry Meter UpDownCounter
      const signalReadingCounter = otelMeter.upDownCounters.get(`${prefix}_signal_reading`);
      assert.ok(signalReadingCounter !== undefined);

      // Invariant: signal_reading UpDownCounter must ONLY contain the call for "sample.ok" with value 42
      assert.equal(signalReadingCounter.calls.length, 1);
      assert.equal(signalReadingCounter.calls[0]?.value, 42);
      assert.equal(signalReadingCounter.calls[0]?.attributes?.signal, "sample.ok");

      // Verify no call had value 0
      assert.ok(signalReadingCounter.calls.every((c) => c.value !== 0));

      // Status counter should record the 4 non-ok signals
      const statusCounter = otelMeter.counters.get(`${prefix}_signal_status_total`);
      assert.ok(statusCounter !== undefined);
      assert.equal(statusCounter.calls.length, 4);

      const recordedStatuses = statusCounter.calls.map((c) => c.attributes?.status);
      assert.ok(recordedStatuses.includes("unknown"));
      assert.ok(recordedStatuses.includes("unsupported"));
      assert.ok(recordedStatuses.includes("stale"));
      assert.ok(recordedStatuses.includes("error"));
    } finally {
      await runtime.close();
    }
  });

  it("isolates errors per instrument when hostile OTel meter instruments throw", async () => {
    const prefix = "hostile_otel_tier3";
    const otelMeter = new MockOpenTelemetryMeter();

    const provider = new MultiStatusSignalProvider();
    const runtime = createAdaptiveRuntime({
      providers: [provider],
      policy: definePolicy({
        evaluationIntervalMs: 0,
        defaultStrategyId: "standard",
      }),
    });

    attachOpenTelemetryMeter(runtime, otelMeter, { prefix });

    // Make the runs_total counter and run_duration_seconds histogram hostile (throw errors)
    const runsCounter = otelMeter.counters.get(`${prefix}_runs_total`) as MockCounter;
    runsCounter.shouldThrow = true;

    const durationHistogram = otelMeter.histograms.get(
      `${prefix}_run_duration_seconds`,
    ) as MockHistogram;
    durationHistogram.shouldThrow = true;

    try {
      // Invariant: The execution of the runtime operation must NOT crash or fail!
      const result = await runtime.run({
        operationId: "hostile-instrument-op",
        input: "survives",
        strategies: [standardStrategy],
      });

      assert.equal(result.value, "standard:survives");

      // Invariant: Non-throwing instruments should still successfully record metrics
      const selectionsCounter = otelMeter.counters.get(
        `${prefix}_strategy_selections_total`,
      ) as MockCounter;
      assert.equal(selectionsCounter.calls.length, 1);

      const decisionsCounter = otelMeter.counters.get(`${prefix}_decisions_total`) as MockCounter;
      assert.equal(decisionsCounter.calls.length, 1);

      const qualityCounter = otelMeter.counters.get(`${prefix}_quality_total`) as MockCounter;
      assert.equal(qualityCounter.calls.length, 1);
    } finally {
      await runtime.close();
    }
  });

  it("bounds cardinality at maxSeries and purges operation series via collector.removeOperation", async () => {
    const prefix = "cardinality_tier3";
    const maxSeries = 100;
    const collector = createMetricsCollector({ prefix, maxSeries });

    const provider = new MultiStatusSignalProvider();
    const runtime = createAdaptiveRuntime({
      providers: [provider],
      policy: definePolicy({
        evaluationIntervalMs: 0,
        defaultStrategyId: "standard",
      }),
    });

    collector.attach(runtime);

    try {
      // Run across 150 distinct operations (exceeding maxSeries = 100)
      for (let i = 0; i < 150; i++) {
        await runtime.run({
          operationId: `cardinality-op-${i}`,
          input: `item-${i}`,
          strategies: [standardStrategy],
        });
      }

      // Check snapshot series bounds
      const snapshot = collector.getSnapshot();
      const totalSeries =
        snapshot.counters.length + snapshot.gauges.length + snapshot.histograms.length;

      // Invariant: Cardinality must be strictly bounded at maxSeries
      assert.ok(
        totalSeries <= maxSeries,
        `Series count ${totalSeries} must be bounded at maxSeries ${maxSeries}`,
      );

      // Verify that newest operations are present in collector
      const newestOp = "cardinality-op-149";
      assert.ok(
        snapshot.counters.some((c) => c.labels.operation_id === newestOp),
        "Newest operation should be present in metrics",
      );

      // Now target newestOp and test removeOperation
      collector.removeOperation(newestOp);

      const snapshotAfterRemove = collector.getSnapshot();
      assert.equal(
        snapshotAfterRemove.counters.some((c) => c.labels.operation_id === newestOp),
        false,
        "Removed operation must not have any counter series remaining",
      );
      assert.equal(
        snapshotAfterRemove.gauges.some((g) => g.labels.operation_id === newestOp),
        false,
        "Removed operation must not have any gauge series remaining",
      );
      assert.equal(
        snapshotAfterRemove.histograms.some((h) => h.labels.operation_id === newestOp),
        false,
        "Removed operation must not have any histogram series remaining",
      );

      // Also verify Prometheus text exporter does not include the purged operation
      const prometheusText = collector.toPrometheusText();
      assert.equal(prometheusText.includes(`operation_id="${newestOp}"`), false);
    } finally {
      await runtime.close();
    }
  });
});
