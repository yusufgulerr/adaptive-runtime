import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  attachOpenTelemetryMeter,
  type CounterLike,
  createMetricsCollector,
  type HistogramLikeMetric,
  type MetricAttributesLike,
  type MetricOptionsLike,
  MetricsCollector,
  type OpenTelemetryMeterLike,
  type UpDownCounterLike,
} from "../../src/observability/index.js";
import { createAdaptiveRuntime } from "../../src/runtime/runtime.js";
import type { StrategyDecision } from "../../src/types/decision.js";
import type {
  AdaptiveRuntimeEvents,
  RuntimeEventListener,
  RuntimeEventName,
} from "../../src/types/events.js";
import type { AdaptiveRuntime } from "../../src/types/runtime.js";
import type { ResourceSignal, SignalProvider, SignalReadContext } from "../../src/types/signals.js";
import type { Strategy } from "../../src/types/strategy.js";

interface RecordedAdd {
  readonly value: number;
  readonly attributes?: MetricAttributesLike;
}

interface RecordedObservation {
  readonly value: number;
  readonly attributes?: MetricAttributesLike;
}

class MockCounter implements CounterLike {
  readonly adds: RecordedAdd[] = [];
  constructor(
    readonly name: string,
    readonly options?: MetricOptionsLike,
  ) {}

  add(value: number, attributes?: MetricAttributesLike): void {
    this.adds.push({ value, attributes });
  }
}

class MockHistogram implements HistogramLikeMetric {
  readonly records: RecordedObservation[] = [];
  constructor(
    readonly name: string,
    readonly options?: MetricOptionsLike,
  ) {}

  record(value: number, attributes?: MetricAttributesLike): void {
    this.records.push({ value, attributes });
  }
}

class MockUpDownCounter implements UpDownCounterLike {
  readonly adds: RecordedAdd[] = [];
  constructor(
    readonly name: string,
    readonly options?: MetricOptionsLike,
  ) {}

  add(value: number, attributes?: MetricAttributesLike): void {
    this.adds.push({ value, attributes });
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

class MockEmitterRuntime implements Partial<AdaptiveRuntime> {
  readonly listeners = new Map<RuntimeEventName, Set<RuntimeEventListener<RuntimeEventName>>>();

  on<K extends RuntimeEventName>(event: K, listener: RuntimeEventListener<K>): () => void {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const genericListener = listener as RuntimeEventListener<RuntimeEventName>;
    set.add(genericListener);
    return () => {
      set?.delete(genericListener);
    };
  }

  emit<K extends RuntimeEventName>(event: K, payload: AdaptiveRuntimeEvents[K]): void {
    const set = this.listeners.get(event);
    if (set !== undefined) {
      for (const listener of set) {
        listener(payload);
      }
    }
  }

  listenerCount(event: RuntimeEventName): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

function makeDecision(overrides?: Partial<StrategyDecision>): StrategyDecision {
  return {
    operationId: "op-test",
    strategyId: "fast",
    qualityTier: 1,
    previousStrategyId: null,
    changed: false,
    kind: "initial",
    decidedAt: 1000,
    modeSince: 1000,
    baseQualityTier: 1,
    targetQualityTier: 1,
    signals: [],
    budgets: [],
    reasons: [],
    sampleSequence: 1,
    signalsCached: false,
    ...overrides,
  };
}

describe("Observability Bridge Unit Tests", () => {
  describe("attachOpenTelemetryMeter", () => {
    it("validates input arguments", () => {
      const mockRuntime = new MockEmitterRuntime() as unknown as AdaptiveRuntime;
      const mockMeter = new MockOpenTelemetryMeter();

      assert.throws(
        () => attachOpenTelemetryMeter(mockRuntime, null as unknown as OpenTelemetryMeterLike),
        TypeError,
      );
      assert.throws(
        () => attachOpenTelemetryMeter(mockRuntime, {} as unknown as OpenTelemetryMeterLike),
        TypeError,
      );
      assert.throws(
        () => attachOpenTelemetryMeter(null as unknown as AdaptiveRuntime, mockMeter),
        TypeError,
      );
      assert.throws(
        () => attachOpenTelemetryMeter({} as unknown as AdaptiveRuntime, mockMeter),
        TypeError,
      );
    });

    it("creates all 10 expected instruments with default prefix", () => {
      const mockRuntime = new MockEmitterRuntime() as unknown as AdaptiveRuntime;
      const mockMeter = new MockOpenTelemetryMeter();

      attachOpenTelemetryMeter(mockRuntime, mockMeter);

      const expectedCounters = [
        "adaptive_runtime_strategy_selections_total",
        "adaptive_runtime_runs_total",
        "adaptive_runtime_quality_total",
        "adaptive_runtime_decisions_total",
        "adaptive_runtime_signal_status_total",
        "adaptive_runtime_budget_status_total",
        "adaptive_runtime_provider_errors_total",
        "adaptive_runtime_listener_errors_total",
        "adaptive_runtime_runtime_closed_total",
      ];

      for (const name of expectedCounters) {
        assert.ok(mockMeter.counters.has(name), `Missing counter ${name}`);
      }

      assert.ok(
        mockMeter.histograms.has("adaptive_runtime_run_duration_seconds"),
        "Missing duration histogram",
      );
      assert.equal(
        mockMeter.histograms.get("adaptive_runtime_run_duration_seconds")?.options?.unit,
        "s",
      );
    });

    it("supports custom prefix and custom default attributes", () => {
      const mockRuntime = new MockEmitterRuntime() as unknown as AdaptiveRuntime;
      const mockMeter = new MockOpenTelemetryMeter();

      attachOpenTelemetryMeter(mockRuntime, mockMeter, {
        prefix: "custom_app",
        defaultAttributes: { env: "prod", cluster: 42, active: true, tag: undefined },
      });

      assert.ok(mockMeter.counters.has("custom_app_runs_total"));
      assert.ok(mockMeter.histograms.has("custom_app_run_duration_seconds"));
    });

    it("records run:start event", () => {
      const mockRuntime = new MockEmitterRuntime();
      const mockMeter = new MockOpenTelemetryMeter();

      attachOpenTelemetryMeter(mockRuntime as unknown as AdaptiveRuntime, mockMeter, {
        defaultAttributes: { service: "worker" },
      });

      mockRuntime.emit("run:start", {
        operationId: "op-1",
        strategyId: "strat-a",
        decision: makeDecision(),
      });

      const counter = mockMeter.counters.get("adaptive_runtime_strategy_selections_total");
      assert.equal(counter?.adds.length, 1);
      assert.equal(counter?.adds[0]?.value, 1);
      assert.deepEqual(counter?.adds[0]?.attributes, {
        service: "worker",
        operation_id: "op-1",
        strategy_id: "strat-a",
      });
    });

    it("records run:success event with duration and quality", () => {
      const mockRuntime = new MockEmitterRuntime();
      const mockMeter = new MockOpenTelemetryMeter();

      attachOpenTelemetryMeter(mockRuntime as unknown as AdaptiveRuntime, mockMeter);

      mockRuntime.emit("run:success", {
        metadata: {
          operationId: "op-success",
          strategyId: "accurate",
          qualityTier: 1,
          startedAt: 1000,
          finishedAt: 1050,
          durationMs: 50,
          attempts: 1,
          quality: { status: "passed", detail: "ok" },
          decision: makeDecision(),
          signals: [],
        },
      });

      const runs = mockMeter.counters.get("adaptive_runtime_runs_total");
      assert.equal(runs?.adds.length, 1);
      assert.deepEqual(runs?.adds[0]?.attributes, {
        operation_id: "op-success",
        result: "success",
        strategy_id: "accurate",
      });

      const quality = mockMeter.counters.get("adaptive_runtime_quality_total");
      assert.equal(quality?.adds.length, 1);
      assert.deepEqual(quality?.adds[0]?.attributes, {
        operation_id: "op-success",
        status: "passed",
        strategy_id: "accurate",
      });

      const duration = mockMeter.histograms.get("adaptive_runtime_run_duration_seconds");
      assert.equal(duration?.records.length, 1);
      assert.equal(duration?.records[0]?.value, 0.05); // 50ms / 1000
      assert.deepEqual(duration?.records[0]?.attributes, {
        operation_id: "op-success",
        strategy_id: "accurate",
      });
    });

    it("records run:error event with duration and with strategyId omitted", () => {
      const mockRuntime = new MockEmitterRuntime();
      const mockMeter = new MockOpenTelemetryMeter();

      attachOpenTelemetryMeter(mockRuntime as unknown as AdaptiveRuntime, mockMeter);

      // Error with strategyId and durationMs
      mockRuntime.emit("run:error", {
        operationId: "op-err",
        strategyId: "failing-strat",
        error: new Error("boom"),
        durationMs: 120,
      });

      const runs = mockMeter.counters.get("adaptive_runtime_runs_total");
      assert.equal(runs?.adds.length, 1);
      assert.deepEqual(runs?.adds[0]?.attributes, {
        operation_id: "op-err",
        result: "error",
        strategy_id: "failing-strat",
      });

      const duration = mockMeter.histograms.get("adaptive_runtime_run_duration_seconds");
      assert.equal(duration?.records.length, 1);
      assert.equal(duration?.records[0]?.value, 0.12);

      // Error without strategyId and without durationMs
      mockRuntime.emit("run:error", {
        operationId: "op-err-2",
        error: new Error("no strategy"),
      });

      assert.equal(runs?.adds.length, 2);
      assert.deepEqual(runs?.adds[1]?.attributes, {
        operation_id: "op-err-2",
        result: "error",
        strategy_id: "none",
      });
      // Duration was not recorded because durationMs was undefined
      assert.equal(duration?.records.length, 1);
    });

    it("enforces strict non-zero-coercion on decision signals and budgets", () => {
      const mockRuntime = new MockEmitterRuntime();
      const mockMeter = new MockOpenTelemetryMeter();

      attachOpenTelemetryMeter(mockRuntime as unknown as AdaptiveRuntime, mockMeter);

      mockRuntime.emit("decision", {
        decision: makeDecision({
          operationId: "op-signals",
          changed: true,
          kind: "adapted",
          signals: [
            { name: "cpu.utilization", unit: "ratio", status: "ok", value: 0.8 },
            { name: "web.device.memoryGib", unit: "custom", status: "unsupported" },
            { name: "web.network.rttMs", unit: "milliseconds", status: "error" },
            { name: "custom.signal", unit: "count", status: "missing" },
            { name: "edge.stale", unit: "milliseconds", status: "stale" },
          ],
          budgets: [
            {
              id: "b-ok",
              signal: "cpu.utilization",
              engaged: false,
              status: "ok",
              limit: 1,
              recoverBelow: 0.5,
              tierReduction: 1,
            },
            {
              id: "b-unsupported",
              signal: "web.device.memoryGib",
              engaged: false,
              status: "unsupported",
              limit: 4,
              recoverBelow: 2,
              tierReduction: 1,
            },
          ],
        }),
      });

      const decisions = mockMeter.counters.get("adaptive_runtime_decisions_total");
      assert.equal(decisions?.adds.length, 1);
      assert.deepEqual(decisions?.adds[0]?.attributes, {
        changed: "true",
        kind: "adapted",
        operation_id: "op-signals",
      });

      const signalStatus = mockMeter.counters.get("adaptive_runtime_signal_status_total");
      // Only non-ok signals recorded (4 out of 5)
      assert.equal(signalStatus?.adds.length, 4);
      assert.deepEqual(signalStatus?.adds[0]?.attributes, {
        operation_id: "op-signals",
        signal: "web.device.memoryGib",
        status: "unsupported",
      });
      assert.deepEqual(signalStatus?.adds[1]?.attributes, {
        operation_id: "op-signals",
        signal: "web.network.rttMs",
        status: "error",
      });
      assert.deepEqual(signalStatus?.adds[2]?.attributes, {
        operation_id: "op-signals",
        signal: "custom.signal",
        status: "missing",
      });
      assert.deepEqual(signalStatus?.adds[3]?.attributes, {
        operation_id: "op-signals",
        signal: "edge.stale",
        status: "stale",
      });

      const budgetStatus = mockMeter.counters.get("adaptive_runtime_budget_status_total");
      // Only non-ok budget recorded (1 out of 2)
      assert.equal(budgetStatus?.adds.length, 1);
      assert.deepEqual(budgetStatus?.adds[0]?.attributes, {
        budget_id: "b-unsupported",
        operation_id: "op-signals",
        status: "unsupported",
      });
    });

    it("records provider:error, listener:error, and runtime:closed", () => {
      const mockRuntime = new MockEmitterRuntime();
      const mockMeter = new MockOpenTelemetryMeter();

      attachOpenTelemetryMeter(mockRuntime as unknown as AdaptiveRuntime, mockMeter, {
        defaultAttributes: { region: "eu-central" },
      });

      mockRuntime.emit("provider:error", {
        providerId: "cpu-provider",
        error: new Error("read failed"),
      });

      const providerErrors = mockMeter.counters.get("adaptive_runtime_provider_errors_total");
      assert.equal(providerErrors?.adds.length, 1);
      assert.deepEqual(providerErrors?.adds[0]?.attributes, {
        region: "eu-central",
        provider_id: "cpu-provider",
      });

      mockRuntime.emit("listener:error", {
        event: "decision",
        error: new Error("listener crashed"),
      });

      const listenerErrors = mockMeter.counters.get("adaptive_runtime_listener_errors_total");
      assert.equal(listenerErrors?.adds.length, 1);
      assert.deepEqual(listenerErrors?.adds[0]?.attributes, {
        region: "eu-central",
        event: "decision",
      });

      mockRuntime.emit("runtime:closed", {});

      const runtimeClosed = mockMeter.counters.get("adaptive_runtime_runtime_closed_total");
      assert.equal(runtimeClosed?.adds.length, 1);
      assert.deepEqual(runtimeClosed?.adds[0]?.attributes, {
        region: "eu-central",
      });
    });

    it("detaches all listeners upon calling unsubscribe", () => {
      const mockRuntime = new MockEmitterRuntime();
      const mockMeter = new MockOpenTelemetryMeter();

      const unsubscribe = attachOpenTelemetryMeter(
        mockRuntime as unknown as AdaptiveRuntime,
        mockMeter,
      );

      assert.equal(mockRuntime.listenerCount("run:start"), 1);
      assert.equal(mockRuntime.listenerCount("run:success"), 1);
      assert.equal(mockRuntime.listenerCount("run:error"), 1);
      assert.equal(mockRuntime.listenerCount("decision"), 1);
      assert.equal(mockRuntime.listenerCount("provider:error"), 1);
      assert.equal(mockRuntime.listenerCount("listener:error"), 1);
      assert.equal(mockRuntime.listenerCount("runtime:closed"), 1);

      unsubscribe();

      assert.equal(mockRuntime.listenerCount("run:start"), 0);
      assert.equal(mockRuntime.listenerCount("run:success"), 0);
      assert.equal(mockRuntime.listenerCount("run:error"), 0);
      assert.equal(mockRuntime.listenerCount("decision"), 0);
      assert.equal(mockRuntime.listenerCount("provider:error"), 0);
      assert.equal(mockRuntime.listenerCount("listener:error"), 0);
      assert.equal(mockRuntime.listenerCount("runtime:closed"), 0);

      // Subsequent emissions do nothing
      mockRuntime.emit("run:start", {
        operationId: "op-after-unsub",
        strategyId: "strat",
        decision: makeDecision(),
      });
      assert.equal(
        mockMeter.counters.get("adaptive_runtime_strategy_selections_total")?.adds.length,
        0,
      );
    });
  });

  describe("createMetricsCollector & MetricsCollector", () => {
    it("validates runtime on attach", () => {
      const collector = createMetricsCollector();
      assert.throws(() => collector.attach(null as unknown as AdaptiveRuntime), TypeError);
      assert.throws(() => collector.attach({} as unknown as AdaptiveRuntime), TypeError);
    });

    it("validates increment, setGauge, and observe inputs", () => {
      const collector = new MetricsCollector();

      assert.throws(() => collector.increment("counter", {}, Number.NaN), TypeError);
      assert.throws(() => collector.increment("counter", {}, Number.POSITIVE_INFINITY), TypeError);

      assert.throws(() => collector.setGauge("gauge", Number.NaN), TypeError);
      assert.throws(() => collector.setGauge("gauge", Number.NEGATIVE_INFINITY), TypeError);

      assert.throws(() => collector.observe("hist", Number.NaN), RangeError);
      assert.throws(() => collector.observe("hist", -0.01), RangeError);
      assert.throws(() => collector.observe("hist", Number.POSITIVE_INFINITY), RangeError);
    });

    it("normalizes custom buckets ensuring terminal Infinity", () => {
      const collector = new MetricsCollector({
        buckets: [1, 0.1, 0.5],
      });

      collector.observe("hist", 0.4);
      const snapshot = collector.getSnapshot();
      assert.equal(snapshot.histograms.length, 1);
      const bucketBounds = snapshot.histograms[0]?.buckets.map((b) => b.le);
      assert.deepEqual(bucketBounds, [0.1, 0.5, 1, Number.POSITIVE_INFINITY]);
    });

    it("tracks multiple observations, accumulates sum, min, max, and cumulative bucket counts", () => {
      const collector = new MetricsCollector({
        buckets: [0.1, 0.5, 1, Number.POSITIVE_INFINITY],
      });

      collector.observe("latency", 0.05, { route: "api" });
      collector.observe("latency", 0.3, { route: "api" });
      collector.observe("latency", 0.8, { route: "api" });

      const snapshot = collector.getSnapshot();
      assert.equal(snapshot.histograms.length, 1);
      const hist = snapshot.histograms[0];
      assert.ok(hist);
      assert.equal(hist.count, 3);
      assert.ok(Math.abs(hist.sum - 1.15) < 1e-6);
      assert.equal(hist.min, 0.05);
      assert.equal(hist.max, 0.8);

      // Cumulative counts
      // le: 0.1 -> 1 (0.05)
      // le: 0.5 -> 2 (0.05, 0.3)
      // le: 1.0 -> 3 (0.05, 0.3, 0.8)
      // le: +Inf -> 3
      assert.deepEqual(
        hist.buckets.map((b) => b.count),
        [1, 2, 3, 3],
      );
    });

    it("handles existing counter and gauge updates", () => {
      const collector = new MetricsCollector();

      collector.increment("counter_a", { env: "prod" }, 2);
      collector.increment("counter_a", { env: "prod" }, 3);

      collector.setGauge("gauge_a", 42, { instance: "1" });
      collector.setGauge("gauge_a", 99, { instance: "1" });

      const snapshot = collector.getSnapshot();
      assert.equal(snapshot.counters[0]?.value, 5);
      assert.equal(snapshot.gauges[0]?.value, 99);
    });

    it("provides deterministic alphabetical sorting across names and labels", () => {
      const collector = new MetricsCollector();

      collector.increment("z_counter", { b: "2", a: "1" });
      collector.increment("a_counter", { z: "9", y: "8" });
      collector.increment("a_counter", { z: "1", y: "8" });

      collector.setGauge("z_gauge", 10, { k: "v" });
      collector.setGauge("a_gauge", 20, { k: "v" });

      collector.observe("z_hist", 1, { m: "1" });
      collector.observe("a_hist", 2, { m: "1" });

      const snapshot = collector.getSnapshot();
      assert.deepEqual(
        snapshot.counters.map((c) => c.name),
        ["a_counter", "a_counter", "z_counter"],
      );
      assert.deepEqual(
        snapshot.counters.map((c) => c.labels),
        [
          { y: "8", z: "1" },
          { y: "8", z: "9" },
          { a: "1", b: "2" },
        ],
      );
      assert.deepEqual(
        snapshot.gauges.map((g) => g.name),
        ["a_gauge", "z_gauge"],
      );
      assert.deepEqual(
        snapshot.histograms.map((h) => h.name),
        ["a_hist", "z_hist"],
      );
    });

    it("resets all metric series cleanly", () => {
      const collector = new MetricsCollector();
      collector.increment("counter");
      collector.setGauge("gauge", 10);
      collector.observe("hist", 0.5);

      assert.equal(collector.getSnapshot().counters.length, 1);
      assert.equal(collector.getSnapshot().gauges.length, 1);
      assert.equal(collector.getSnapshot().histograms.length, 1);

      collector.reset();

      assert.equal(collector.getSnapshot().counters.length, 0);
      assert.equal(collector.getSnapshot().gauges.length, 0);
      assert.equal(collector.getSnapshot().histograms.length, 0);
      assert.equal(collector.toPrometheusText(), "");
    });

    it("produces valid Prometheus text format v0.0.4 with HELP, TYPE, escaping, and trailing newline", () => {
      const collector = new MetricsCollector({
        prefix: "test_runtime",
        buckets: [0.1, 1, Number.POSITIVE_INFINITY],
      });

      // Special characters for escaping test
      collector.increment("test_runtime_runs_total", {
        path: "C:\\Windows\\System32",
        quote: 'say "hello"',
        newline: "line1\nline2",
      });

      collector.setGauge("test_runtime_signal_reading", 123.45, {
        signal: "cpu",
      });

      collector.observe("test_runtime_run_duration_seconds", 0.05, {
        op: "search",
      });

      collector.increment("test_runtime_strategy_selections_total", { op: "search" });
      collector.increment("test_runtime_quality_total", { status: "passed" });
      collector.increment("test_runtime_decisions_total", { kind: "initial" });
      collector.increment("test_runtime_signal_status_total", { status: "unsupported" });
      collector.setGauge("test_runtime_budget_engaged", 1, { budget_id: "b1" });
      collector.increment("test_runtime_budget_status_total", { status: "error" });
      collector.increment("test_runtime_provider_errors_total", { provider_id: "p1" });
      collector.increment("test_runtime_listener_errors_total", { event: "decision" });
      collector.increment("test_runtime_runtime_closed_total");

      // Custom metric to test fallback help/type
      collector.increment("custom_events_total", { id: "1" }, 2);
      collector.setGauge("custom_temperature", 23.5);

      const text = collector.toPrometheusText();

      // Invariants
      assert.ok(text.endsWith("\n"), "Prometheus output must end with newline");

      // Validates escaping
      assert.ok(text.includes('path="C:\\\\Windows\\\\System32"'));
      assert.ok(text.includes('quote="say \\"hello\\""'));
      assert.ok(text.includes('newline="line1\\nline2"'));

      // Validates headers
      assert.ok(
        text.includes(
          "# HELP test_runtime_runs_total Total number of strategy runs completed or failed.",
        ),
      );
      assert.ok(text.includes("# TYPE test_runtime_runs_total counter"));
      assert.ok(
        text.includes(
          "# HELP test_runtime_strategy_selections_total Total number of strategy selections started.",
        ),
      );
      assert.ok(
        text.includes(
          "# HELP test_runtime_quality_total Total number of strategy runs categorized by quality status.",
        ),
      );
      assert.ok(
        text.includes("# HELP test_runtime_decisions_total Total number of policy decisions made."),
      );
      assert.ok(
        text.includes(
          "# HELP test_runtime_signal_status_total Total count of non-ok signal readings.",
        ),
      );
      assert.ok(
        text.includes(
          "# HELP test_runtime_budget_engaged Current budget engagement state (1 engaged, 0 healthy).",
        ),
      );
      assert.ok(
        text.includes(
          "# HELP test_runtime_budget_status_total Total count of non-ok budget evaluations.",
        ),
      );
      assert.ok(
        text.includes(
          "# HELP test_runtime_provider_errors_total Total number of signal provider errors.",
        ),
      );
      assert.ok(
        text.includes("# HELP test_runtime_listener_errors_total Total number of listener errors."),
      );
      assert.ok(
        text.includes(
          "# HELP test_runtime_runtime_closed_total Total number of runtime close events.",
        ),
      );
      assert.ok(
        text.includes("# HELP test_runtime_signal_reading Current resource signal reading value."),
      );
      assert.ok(text.includes("# TYPE test_runtime_signal_reading gauge"));
      assert.ok(
        text.includes(
          "# HELP test_runtime_run_duration_seconds Duration of strategy execution in seconds.",
        ),
      );
      assert.ok(text.includes("# TYPE test_runtime_run_duration_seconds histogram"));

      // Validates fallback headers
      assert.ok(text.includes("# HELP custom_events_total Metric family for custom_events_total."));
      assert.ok(text.includes("# TYPE custom_events_total counter"));
      assert.ok(text.includes("# HELP custom_temperature Metric family for custom_temperature."));
      assert.ok(text.includes("# TYPE custom_temperature gauge"));

      // Validates histogram structure
      assert.ok(text.includes('test_runtime_run_duration_seconds_bucket{le="0.1",op="search"} 1'));
      assert.ok(text.includes('test_runtime_run_duration_seconds_bucket{le="1",op="search"} 1'));
      assert.ok(text.includes('test_runtime_run_duration_seconds_bucket{le="+Inf",op="search"} 1'));
      assert.ok(text.includes('test_runtime_run_duration_seconds_sum{op="search"} 0.05'));
      assert.ok(text.includes('test_runtime_run_duration_seconds_count{op="search"} 1'));

      // Gauge without labels
      assert.ok(text.includes("custom_temperature 23.5"));
    });

    it("verifies strict non-zero-coercion when attached to runtime events", () => {
      const mockRuntime = new MockEmitterRuntime();
      const collector = createMetricsCollector();
      collector.attach(mockRuntime as unknown as AdaptiveRuntime);

      mockRuntime.emit("decision", {
        decision: makeDecision({
          operationId: "op-check",
          signals: [
            { name: "heap.used", status: "ok", value: 500 },
            { name: "web.network", status: "unsupported" },
            { name: "invalid.signal", status: "ok", value: Number.NaN },
          ],
          budgets: [
            {
              id: "b-engaged",
              signal: "heap.used",
              engaged: true,
              status: "ok",
              limit: 400,
              recoverBelow: 300,
              tierReduction: 1,
            },
            {
              id: "b-stale",
              signal: "web.network",
              engaged: false,
              status: "stale",
              limit: 100,
              recoverBelow: 50,
              tierReduction: 1,
            },
          ],
        }),
      });

      const snapshot = collector.getSnapshot();

      // Gauges: only heap.used and b-engaged
      const gauges = snapshot.gauges;
      assert.equal(gauges.length, 2);
      assert.ok(
        gauges.some(
          (g) =>
            g.name === "adaptive_runtime_signal_reading" &&
            g.labels.signal === "heap.used" &&
            g.value === 500,
        ),
      );
      assert.ok(
        gauges.some(
          (g) =>
            g.name === "adaptive_runtime_budget_engaged" &&
            g.labels.budget_id === "b-engaged" &&
            g.value === 1,
        ),
      );

      // Verify NO 0 gauge for unsupported signal or stale budget
      assert.equal(
        gauges.some((g) => g.labels.signal === "web.network"),
        false,
      );
      assert.equal(
        gauges.some((g) => g.labels.budget_id === "b-stale"),
        false,
      );

      // Counters: non-ok signals & invalid.signal (NaN)
      const counters = snapshot.counters;
      assert.ok(
        counters.some(
          (c) =>
            c.name === "adaptive_runtime_signal_status_total" &&
            c.labels.signal === "web.network" &&
            c.labels.status === "unsupported",
        ),
      );
      assert.ok(
        counters.some(
          (c) =>
            c.name === "adaptive_runtime_signal_status_total" &&
            c.labels.signal === "invalid.signal" &&
            c.labels.status === "ok",
        ),
      );
      assert.ok(
        counters.some(
          (c) =>
            c.name === "adaptive_runtime_budget_status_total" &&
            c.labels.budget_id === "b-stale" &&
            c.labels.status === "stale",
        ),
      );

      // Verify Prometheus text matches
      const prometheusText = collector.toPrometheusText();
      assert.ok(
        prometheusText.includes(
          'adaptive_runtime_signal_status_total{operation_id="op-check",signal="web.network",status="unsupported"} 1',
        ),
      );
      assert.ok(
        prometheusText.includes(
          'adaptive_runtime_budget_status_total{budget_id="b-stale",operation_id="op-check",status="stale"} 1',
        ),
      );
      assert.ok(
        !prometheusText.includes(
          'adaptive_runtime_signal_reading{operation_id="op-check",signal="web.network"',
        ),
      );
    });

    it("handles label attributes with undefined, numbers, booleans, and label-less series", () => {
      const collector = new MetricsCollector({
        defaultAttributes: { env: "test", unset: undefined },
      });

      collector.increment("counter_plain");
      collector.increment("counter_plain");
      collector.increment("counter_typed", { count: 12, enabled: true, ignored: undefined });

      const snapshot = collector.getSnapshot();
      assert.equal(snapshot.counters.length, 2);

      const plain = snapshot.counters.find((c) => c.name === "counter_plain");
      assert.deepEqual(plain?.labels, { env: "test" });
      assert.equal(plain?.value, 2);

      const typed = snapshot.counters.find((c) => c.name === "counter_typed");
      assert.deepEqual(typed?.labels, { count: "12", enabled: "true", env: "test" });
    });
  });

  describe("End-to-End Runtime Integration", () => {
    class FailingProvider implements SignalProvider {
      readonly id = "failing-provider";
      readonly signals = [
        { name: "test.fail", unit: "count" as const, description: "always throws" },
      ];
      read(_context: SignalReadContext): readonly ResourceSignal[] {
        throw new Error("provider simulated failure");
      }
    }

    class UnsupportedProvider implements SignalProvider {
      readonly id = "unsupported-provider";
      readonly signals = [
        { name: "test.unsupported", unit: "count" as const, description: "unsupported signal" },
      ];
      read(context: SignalReadContext) {
        return [
          {
            name: "test.unsupported",
            unit: "count" as const,
            status: "unsupported" as const,
            observedAt: context.now,
          },
        ];
      }
    }

    const strategies: readonly Strategy<number, number>[] = [
      {
        id: "fast",
        qualityTier: 1,
        costTier: 1,
        run: ({ input }) => input * 2,
      },
      {
        id: "thrower",
        qualityTier: 2,
        costTier: 2,
        run: () => {
          throw new Error("strategy execution error");
        },
      },
    ];

    it("attaches collector and OpenTelemetry meter to real AdaptiveRuntime and performs runs", async () => {
      const failingProvider = new FailingProvider();
      const unsupportedProvider = new UnsupportedProvider();

      const runtime = createAdaptiveRuntime({
        providers: [failingProvider, unsupportedProvider],
        policy: {
          evaluationIntervalMs: 0,
          consecutiveSamples: 1,
          budgets: [
            {
              id: "unsupported-budget",
              signal: "test.unsupported",
              limit: 10,
              recoverBelow: 5,
            },
          ],
        },
      });

      const collector = createMetricsCollector({
        prefix: "live_runtime",
        defaultAttributes: { tier: "production" },
      });
      const detachCollector = collector.attach(runtime);

      const otelMeter = new MockOpenTelemetryMeter();
      const detachOtel = attachOpenTelemetryMeter(runtime, otelMeter, {
        prefix: "live_runtime",
        defaultAttributes: { tier: "production" },
      });

      try {
        // Run healthy operation
        runtime.pinStrategy("calc-op", "fast");
        const result = await runtime.run({
          operationId: "calc-op",
          input: 10,
          strategies,
        });
        assert.equal(result.value, 20);

        // Run failing operation
        runtime.pinStrategy("err-op", "thrower");
        let threw = false;
        try {
          await runtime.run({
            operationId: "err-op",
            input: 5,
            strategies,
          });
        } catch {
          threw = true;
        }
        assert.ok(threw, "err-op must throw");
      } finally {
        await runtime.close();
      }

      // Check Collector snapshot
      const snapshot = collector.getSnapshot();

      // Runs counter
      const runSuccess = snapshot.counters.find(
        (c) =>
          c.name === "live_runtime_runs_total" &&
          c.labels.operation_id === "calc-op" &&
          c.labels.result === "success",
      );
      assert.ok(runSuccess, "Expected successful run counter");
      assert.equal(runSuccess.value, 1);
      assert.equal(runSuccess.labels.tier, "production");

      const runError = snapshot.counters.find(
        (c) =>
          c.name === "live_runtime_runs_total" &&
          c.labels.operation_id === "err-op" &&
          c.labels.result === "error",
      );
      assert.ok(runError, "Expected error run counter");
      assert.equal(runError.value, 1);

      // Non-zero coercion verification:
      // test.unsupported signal has status unsupported -> counter incremented, NO gauge emitted
      const signalStatus = snapshot.counters.find(
        (c) =>
          c.name === "live_runtime_signal_status_total" && c.labels.signal === "test.unsupported",
      );
      assert.ok(signalStatus, "Expected signal status counter for unsupported signal");
      assert.equal(signalStatus.labels.status, "unsupported");

      const noGaugesForUnsupported = snapshot.gauges.filter(
        (g) => g.labels.signal === "test.unsupported",
      );
      assert.equal(noGaugesForUnsupported.length, 0, "No gauge must exist for unsupported signal");

      // Provider error counter
      const providerError = snapshot.counters.find(
        (c) =>
          c.name === "live_runtime_provider_errors_total" &&
          c.labels.provider_id === "failing-provider",
      );
      assert.ok(providerError, "Expected provider error counter");

      // Runtime closed counter
      const runtimeClosed = snapshot.counters.find(
        (c) => c.name === "live_runtime_runtime_closed_total",
      );
      assert.ok(runtimeClosed, "Expected runtime closed counter");

      // Check OpenTelemetry Meter recordings
      const otelRuns = otelMeter.counters.get("live_runtime_runs_total");
      assert.equal(otelRuns?.adds.length, 2);

      const otelSignalStatus = otelMeter.counters.get("live_runtime_signal_status_total");
      assert.ok((otelSignalStatus?.adds.length ?? 0) >= 1);

      // Verify Prometheus text exporter
      const prometheusText = collector.toPrometheusText();
      assert.ok(prometheusText.includes("# HELP live_runtime_runs_total"));
      assert.ok(
        prometheusText.includes(
          'live_runtime_runs_total{operation_id="calc-op",result="success",strategy_id="fast",tier="production"} 1',
        ),
      );
      assert.ok(
        prometheusText.includes(
          'live_runtime_runs_total{operation_id="err-op",result="error",strategy_id="thrower",tier="production"} 1',
        ),
      );
      assert.ok(
        prometheusText.includes(
          'live_runtime_signal_status_total{operation_id="calc-op",signal="test.unsupported",status="unsupported",tier="production"} 1',
        ),
      );
      assert.ok(prometheusText.endsWith("\n"));

      detachCollector();
      detachOtel();
    });
  });
});
