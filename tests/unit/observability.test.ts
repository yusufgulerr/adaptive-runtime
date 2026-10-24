import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigurationError } from "../../src/errors/index.js";
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
import type { BudgetView, StrategyDecision } from "../../src/types/decision.js";
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

    it("creates all expected instruments with default prefix", () => {
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

      assert.ok(
        mockMeter.upDownCounters.has("adaptive_runtime_signal_reading"),
        "Missing signal reading UpDownCounter",
      );
      assert.ok(
        mockMeter.upDownCounters.has("adaptive_runtime_budget_engaged"),
        "Missing budget engaged UpDownCounter",
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

      // UpDownCounters: only ok signals and ok budgets recorded
      const signalReadingUpDown = mockMeter.upDownCounters.get("adaptive_runtime_signal_reading");
      assert.equal(signalReadingUpDown?.adds.length, 1);
      assert.deepEqual(signalReadingUpDown?.adds[0], {
        value: 0.8,
        attributes: {
          operation_id: "op-signals",
          signal: "cpu.utilization",
          status: "ok",
        },
      });

      const budgetEngagedUpDown = mockMeter.upDownCounters.get("adaptive_runtime_budget_engaged");
      assert.equal(budgetEngagedUpDown?.adds.length, 1);
      assert.deepEqual(budgetEngagedUpDown?.adds[0], {
        value: 0,
        attributes: { budget_id: "b-ok", operation_id: "op-signals" },
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

    it("handles OpenTelemetry meter without createUpDownCounter method", () => {
      const mockRuntime = new MockEmitterRuntime() as unknown as AdaptiveRuntime;
      const meterWithoutUpDown: OpenTelemetryMeterLike = {
        createCounter(name: string, options?: MetricOptionsLike): CounterLike {
          return new MockCounter(name, options);
        },
        createHistogram(name: string, options?: MetricOptionsLike): HistogramLikeMetric {
          return new MockHistogram(name, options);
        },
      };

      const unsub = attachOpenTelemetryMeter(mockRuntime, meterWithoutUpDown);
      assert.equal(typeof unsub, "function");

      // Verify decision emission doesn't throw when upDownCounters are undefined
      (mockRuntime as unknown as MockEmitterRuntime).emit("decision", {
        decision: makeDecision({
          signals: [{ name: "cpu", status: "ok", value: 0.5, unit: "ratio" }],
          budgets: [
            {
              id: "b1",
              status: "ok",
              engaged: true,
              signal: "cpu",
              limit: 1,
              recoverBelow: 0.5,
              tierReduction: 1,
            },
          ],
        }),
      });
      unsub();
    });

    it("records ok signal readings and budget engagement to UpDownCounters with exact attributes", () => {
      const mockRuntime = new MockEmitterRuntime();
      const mockMeter = new MockOpenTelemetryMeter();

      attachOpenTelemetryMeter(mockRuntime as unknown as AdaptiveRuntime, mockMeter, {
        defaultAttributes: { env: "prod" },
      });

      mockRuntime.emit("decision", {
        decision: makeDecision({
          operationId: "op-updown",
          signals: [
            { name: "mem.used", status: "ok", value: 1024, unit: "bytes" },
            { name: "cpu.load", status: "ok", value: 0.75, unit: "ratio" },
            { name: "net.dropped", status: "unsupported", unit: "count" },
            { name: "broken.value", status: "ok", value: Number.NaN, unit: "custom" },
          ],
          budgets: [
            {
              id: "b-engaged",
              signal: "mem.used",
              status: "ok",
              engaged: true,
              limit: 2000,
              recoverBelow: 1500,
              tierReduction: 1,
            },
            {
              id: "b-healthy",
              signal: "cpu.load",
              status: "ok",
              engaged: false,
              limit: 1,
              recoverBelow: 0.5,
              tierReduction: 1,
            },
            {
              id: "b-err",
              signal: "net.dropped",
              status: "error",
              engaged: false,
              limit: 10,
              recoverBelow: 5,
              tierReduction: 1,
            },
          ],
        }),
      });

      const signalUpDown = mockMeter.upDownCounters.get("adaptive_runtime_signal_reading");
      assert.ok(signalUpDown);
      // Only ok signals with finite values are recorded (mem.used, cpu.load)
      assert.equal(signalUpDown.adds.length, 2);
      assert.deepEqual(signalUpDown.adds[0], {
        value: 1024,
        attributes: {
          env: "prod",
          operation_id: "op-updown",
          signal: "mem.used",
          status: "ok",
        },
      });
      assert.deepEqual(signalUpDown.adds[1], {
        value: 0.75,
        attributes: {
          env: "prod",
          operation_id: "op-updown",
          signal: "cpu.load",
          status: "ok",
        },
      });

      const budgetUpDown = mockMeter.upDownCounters.get("adaptive_runtime_budget_engaged");
      assert.ok(budgetUpDown);
      // Only ok budgets are recorded (b-engaged -> 1, b-healthy -> 0)
      assert.equal(budgetUpDown.adds.length, 2);
      assert.deepEqual(budgetUpDown.adds[0], {
        value: 1,
        attributes: {
          env: "prod",
          budget_id: "b-engaged",
          operation_id: "op-updown",
        },
      });
      assert.deepEqual(budgetUpDown.adds[1], {
        value: 0,
        attributes: {
          env: "prod",
          budget_id: "b-healthy",
          operation_id: "op-updown",
        },
      });

      // Budget labels use the canonical budget id, not an arbitrary name field.
      mockRuntime.emit("decision", {
        decision: makeDecision({
          budgets: [
            {
              name: "custom-budget-name",
              id: "b-id",
              status: "ok",
              engaged: true,
              signal: "mem.used",
              limit: 1,
              recoverBelow: 0.5,
              tierReduction: 1,
            } as unknown as BudgetView,
          ],
        }),
      });
      assert.equal(budgetUpDown.adds.length, 3);
      assert.deepEqual(budgetUpDown.adds[2], {
        value: 1,
        attributes: {
          env: "prod",
          budget_id: "b-id",
          operation_id: "op-test",
        },
      });
    });

    it("applies UpDownCounter deltas per series instead of accumulating readings", () => {
      const mockRuntime = new MockEmitterRuntime();
      const mockMeter = new MockOpenTelemetryMeter();

      attachOpenTelemetryMeter(mockRuntime as unknown as AdaptiveRuntime, mockMeter);

      const emitReading = (value: number, engaged: boolean): void => {
        mockRuntime.emit("decision", {
          decision: makeDecision({
            operationId: "op-delta",
            signals: [{ name: "queue.depth", status: "ok", value, unit: "count" }],
            budgets: [
              {
                id: "queue-depth",
                signal: "queue.depth",
                status: "ok",
                engaged,
                limit: 10,
                recoverBelow: 5,
                tierReduction: 1,
              },
            ],
          }),
        });
      };

      emitReading(10, false);
      emitReading(12, true);
      emitReading(12, true);

      const signalUpDown = mockMeter.upDownCounters.get("adaptive_runtime_signal_reading");
      assert.deepEqual(
        signalUpDown?.adds.map((entry) => entry.value),
        [10, 2],
      );
      const budgetUpDown = mockMeter.upDownCounters.get("adaptive_runtime_budget_engaged");
      assert.deepEqual(
        budgetUpDown?.adds.map((entry) => entry.value),
        [0, 1],
      );
    });

    it("bounds UpDownCounter last-value maps with maxSeries LRU eviction", () => {
      const mockRuntime = new MockEmitterRuntime();
      const mockMeter = new MockOpenTelemetryMeter();

      attachOpenTelemetryMeter(mockRuntime as unknown as AdaptiveRuntime, mockMeter, {
        maxSeries: 5,
      });

      const emitReading = (operationId: string, value: number, engaged: boolean): void => {
        mockRuntime.emit("decision", {
          decision: makeDecision({
            operationId,
            signals: [{ name: "queue.depth", status: "ok", value, unit: "count" }],
            budgets: [
              {
                id: "queue-depth",
                signal: "queue.depth",
                status: "ok",
                engaged,
                limit: 10,
                recoverBelow: 5,
                tierReduction: 1,
              },
            ],
          }),
        });
      };

      for (let index = 0; index < 10; index += 1) {
        emitReading(`op-${index}`, 100 + index, index % 2 === 0);
      }

      const signalUpDown = mockMeter.upDownCounters.get("adaptive_runtime_signal_reading");
      const budgetUpDown = mockMeter.upDownCounters.get("adaptive_runtime_budget_engaged");
      assert.ok(signalUpDown);
      assert.ok(budgetUpDown);
      assert.equal(signalUpDown.adds.length, 10);
      assert.equal(budgetUpDown.adds.length, 10);

      // op-5..op-9 remain inside the five-entry LRU window, so updating op-5
      // writes only the delta from its retained previous value.
      emitReading("op-5", 110, true);
      assert.equal(signalUpDown.adds.at(-1)?.value, 5);
      assert.equal(budgetUpDown.adds.at(-1)?.value, 1);

      // op-4 was evicted, so its next reading is a brand-new series and writes
      // the full value instead of a delta. The budget zero is no longer
      // suppressed as a no-op either.
      emitReading("op-4", 120, true);
      assert.equal(signalUpDown.adds.at(-1)?.value, 120);
      assert.equal(budgetUpDown.adds.at(-1)?.value, 1);
      assert.equal(signalUpDown.adds.length, 12);
      assert.equal(budgetUpDown.adds.length, 12);
    });

    it("validates OpenTelemetry maxSeries configuration", () => {
      const mockRuntime = new MockEmitterRuntime() as unknown as AdaptiveRuntime;
      const mockMeter = new MockOpenTelemetryMeter();

      for (const maxSeries of [0, -1, 3.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.throws(
          () => attachOpenTelemetryMeter(mockRuntime, mockMeter, { maxSeries }),
          ConfigurationError,
        );
      }
      assert.throws(
        () =>
          attachOpenTelemetryMeter(mockRuntime, mockMeter, {
            maxSeries: "10" as unknown as number,
          }),
        ConfigurationError,
      );
    });

    it("prefers gauges when the meter exposes createGauge", () => {
      const mockRuntime = new MockEmitterRuntime();

      class MockGauge {
        readonly records: RecordedObservation[] = [];
        record(value: number, attributes?: MetricAttributesLike): void {
          this.records.push({ value, attributes });
        }
      }

      class GaugeMeter extends MockOpenTelemetryMeter {
        readonly gauges = new Map<string, MockGauge>();

        createGauge(name: string) {
          const gauge = new MockGauge();
          this.gauges.set(name, gauge);
          return gauge;
        }
      }

      const meter = new GaugeMeter();
      attachOpenTelemetryMeter(mockRuntime as unknown as AdaptiveRuntime, meter);

      mockRuntime.emit("decision", {
        decision: makeDecision({
          operationId: "op-gauge",
          signals: [{ name: "heap.used", status: "ok", value: 100, unit: "bytes" }],
          budgets: [
            {
              id: "heap-budget",
              signal: "heap.used",
              status: "ok",
              engaged: true,
              limit: 200,
              recoverBelow: 100,
              tierReduction: 1,
            },
          ],
        }),
      });
      mockRuntime.emit("decision", {
        decision: makeDecision({
          operationId: "op-gauge",
          signals: [{ name: "heap.used", status: "ok", value: 150, unit: "bytes" }],
          budgets: [
            {
              id: "heap-budget",
              signal: "heap.used",
              status: "ok",
              engaged: false,
              limit: 200,
              recoverBelow: 100,
              tierReduction: 1,
            },
          ],
        }),
      });

      const signalGauge = meter.gauges.get("adaptive_runtime_signal_reading");
      assert.deepEqual(
        signalGauge?.records.map((entry) => entry.value),
        [100, 150],
      );
      assert.deepEqual(signalGauge?.records[0]?.attributes, {
        operation_id: "op-gauge",
        signal: "heap.used",
        status: "ok",
      });
      const budgetGauge = meter.gauges.get("adaptive_runtime_budget_engaged");
      assert.deepEqual(
        budgetGauge?.records.map((entry) => entry.value),
        [1, 0],
      );
      assert.deepEqual(budgetGauge?.records[1]?.attributes, {
        budget_id: "heap-budget",
        operation_id: "op-gauge",
      });
      // Gauges are preferred, so no UpDownCounter is created for these series.
      assert.equal(meter.upDownCounters.has("adaptive_runtime_signal_reading"), false);
      assert.equal(meter.upDownCounters.has("adaptive_runtime_budget_engaged"), false);
    });

    it("falls back to UpDownCounters when gauge creation throws", () => {
      const mockRuntime = new MockEmitterRuntime();
      const upDownCounters = new Map<string, MockUpDownCounter>();
      const meter: OpenTelemetryMeterLike = {
        createCounter: (name: string) => new MockCounter(name),
        createHistogram: (name: string) => new MockHistogram(name),
        createUpDownCounter: (name: string) => {
          const counter = new MockUpDownCounter(name);
          upDownCounters.set(name, counter);
          return counter;
        },
        createGauge: () => {
          throw new Error("gauges unavailable");
        },
      };

      attachOpenTelemetryMeter(mockRuntime as unknown as AdaptiveRuntime, meter);
      mockRuntime.emit("decision", {
        decision: makeDecision({
          operationId: "op-fallback",
          signals: [{ name: "cpu.load", status: "ok", value: 0.5, unit: "ratio" }],
        }),
      });

      assert.equal(upDownCounters.get("adaptive_runtime_signal_reading")?.adds.length, 1);
    });

    it("isolates throwing instruments so other instruments still record and listeners never throw", () => {
      const mockRuntime = new MockEmitterRuntime();

      class ThrowingCounter implements CounterLike {
        add(): void {
          throw new Error("Instrument explosion!");
        }
      }

      const safeCounters = new Map<string, MockCounter>();
      const safeHistograms = new Map<string, MockHistogram>();
      const safeUpDownCounters = new Map<string, MockUpDownCounter>();

      // Mock meter where specific instruments throw
      const throwingMeter: OpenTelemetryMeterLike = {
        createCounter(name: string, options?: MetricOptionsLike) {
          if (name === "adaptive_runtime_runs_total") {
            return new ThrowingCounter();
          }
          if (name === "adaptive_runtime_decisions_total") {
            return new ThrowingCounter();
          }
          if (name === "adaptive_runtime_provider_errors_total") {
            return new ThrowingCounter();
          }
          const counter = new MockCounter(name, options);
          safeCounters.set(name, counter);
          return counter;
        },
        createHistogram(name: string, options?: MetricOptionsLike) {
          const histogram = new MockHistogram(name, options);
          safeHistograms.set(name, histogram);
          return histogram;
        },
        createUpDownCounter(name: string, options?: MetricOptionsLike) {
          const upDown = new MockUpDownCounter(name, options);
          safeUpDownCounters.set(name, upDown);
          return upDown;
        },
      };

      attachOpenTelemetryMeter(mockRuntime as unknown as AdaptiveRuntime, throwingMeter);

      // 1. run:start - safe counter records
      assert.doesNotThrow(() => {
        mockRuntime.emit("run:start", {
          operationId: "op-1",
          strategyId: "fast",
          decision: makeDecision(),
        });
      });
      assert.equal(safeCounters.get("adaptive_runtime_strategy_selections_total")?.adds.length, 1);

      // 2. run:success - runs_total throws, but quality_total and run_duration_seconds still record!
      assert.doesNotThrow(() => {
        mockRuntime.emit("run:success", {
          metadata: {
            operationId: "op-1",
            strategyId: "fast",
            qualityTier: 1,
            startedAt: 1000,
            finishedAt: 1050,
            durationMs: 50,
            attempts: 1,
            quality: { status: "passed" },
            decision: makeDecision(),
            signals: [],
          },
        });
      });
      assert.equal(safeCounters.get("adaptive_runtime_quality_total")?.adds.length, 1);
      assert.equal(safeHistograms.get("adaptive_runtime_run_duration_seconds")?.records.length, 1);

      // 3. run:error - runs_total throws, but histogram still records!
      assert.doesNotThrow(() => {
        mockRuntime.emit("run:error", {
          operationId: "op-err",
          strategyId: "failing",
          error: new Error("fail"),
          durationMs: 100,
        });
      });
      assert.equal(safeHistograms.get("adaptive_runtime_run_duration_seconds")?.records.length, 2);

      // 4. decision - decisions_total throws, but signal and budget upDownCounters still record!
      assert.doesNotThrow(() => {
        mockRuntime.emit("decision", {
          decision: makeDecision({
            signals: [{ name: "cpu", status: "ok", value: 0.5, unit: "ratio" }],
            budgets: [
              {
                id: "b1",
                status: "ok",
                engaged: true,
                signal: "cpu",
                limit: 1,
                recoverBelow: 0.5,
                tierReduction: 1,
              },
            ],
          }),
        });
      });
      assert.equal(safeUpDownCounters.get("adaptive_runtime_signal_reading")?.adds.length, 1);
      assert.equal(safeUpDownCounters.get("adaptive_runtime_budget_engaged")?.adds.length, 1);

      // 5. provider:error - throws without crashing
      assert.doesNotThrow(() => {
        mockRuntime.emit("provider:error", {
          providerId: "p1",
          error: new Error("read err"),
        });
      });

      // 6. listener:error and runtime:closed
      assert.doesNotThrow(() => {
        mockRuntime.emit("listener:error", { event: "decision", error: new Error("err") });
      });
      assert.equal(safeCounters.get("adaptive_runtime_listener_errors_total")?.adds.length, 1);

      assert.doesNotThrow(() => {
        mockRuntime.emit("runtime:closed", {});
      });
      assert.equal(safeCounters.get("adaptive_runtime_runtime_closed_total")?.adds.length, 1);
    });

    it("automatically purges OpenTelemetry series on runtime.removeOperation and resets delta tracking", () => {
      const mockRuntime = new MockEmitterRuntime();
      let removeCalled = false;
      let removeArg = "";
      (mockRuntime as unknown as Record<string, unknown>).removeOperation = (
        opId: string,
      ): boolean => {
        removeCalled = true;
        removeArg = opId;
        return true;
      };

      const mockMeter = new MockOpenTelemetryMeter();
      const sub = attachOpenTelemetryMeter(mockRuntime as unknown as AdaptiveRuntime, mockMeter);

      const emitDecision = (opId: string, val: number, engaged: boolean) => {
        mockRuntime.emit("decision", {
          decision: makeDecision({
            operationId: opId,
            signals: [{ name: "mem.used", status: "ok", value: val, unit: "bytes" }],
            budgets: [
              {
                id: "mem.budget",
                signal: "mem.used",
                status: "ok",
                engaged,
                limit: 100,
                recoverBelow: 50,
                tierReduction: 1,
              },
            ],
          }),
        });
      };

      // 1. First decision: records initial value 50 and engaged: 1
      emitDecision("op-test", 50, true);
      const signalUpDown = mockMeter.upDownCounters.get("adaptive_runtime_signal_reading");
      const budgetUpDown = mockMeter.upDownCounters.get("adaptive_runtime_budget_engaged");
      assert.equal(signalUpDown?.adds.length, 1);
      assert.equal(signalUpDown?.adds[0]?.value, 50);
      assert.equal(budgetUpDown?.adds.length, 1);
      assert.equal(budgetUpDown?.adds[0]?.value, 1);

      // 2. Second decision with SAME value: delta is 0, so no new add is emitted
      emitDecision("op-test", 50, true);
      assert.equal(signalUpDown?.adds.length, 1);
      assert.equal(budgetUpDown?.adds.length, 1);

      // 3. Remove operation from runtime
      const removed = (mockRuntime as unknown as AdaptiveRuntime).removeOperation("op-test");
      assert.equal(removed, true);
      assert.equal(removeCalled, true);
      assert.equal(removeArg, "op-test");

      // 4. Third decision with SAME value (50, true) after operation removal:
      // Because series was purged, previous value is gone, so delta converges from zero again!
      emitDecision("op-test", 50, true);
      assert.equal(signalUpDown?.adds.length, 2);
      assert.equal(signalUpDown?.adds[1]?.value, 50);
      assert.equal(budgetUpDown?.adds.length, 2);
      assert.equal(budgetUpDown?.adds[1]?.value, 1);

      sub();
    });

    it("supports explicit series purging via subscription.purgeOperation and subscription.removeOperation", () => {
      const mockRuntime = new MockEmitterRuntime();
      const mockMeter = new MockOpenTelemetryMeter();
      const sub = attachOpenTelemetryMeter(mockRuntime as unknown as AdaptiveRuntime, mockMeter);

      assert.equal(typeof sub.purgeOperation, "function");
      assert.equal(typeof sub.removeOperation, "function");

      // Validates argument
      assert.throws(() => sub.purgeOperation(""), ConfigurationError);
      assert.throws(() => sub.purgeOperation("   "), ConfigurationError);
      assert.throws(() => sub.purgeOperation(null as unknown as string), ConfigurationError);
      assert.throws(() => sub.purgeOperation(123 as unknown as string), ConfigurationError);
      assert.throws(() => sub.removeOperation(""), ConfigurationError);

      const emitDecision = (opId: string, val: number) => {
        mockRuntime.emit("decision", {
          decision: makeDecision({
            operationId: opId,
            signals: [{ name: "cpu", status: "ok", value: val, unit: "ratio" }],
            budgets: [],
          }),
        });
      };

      emitDecision("op-explicit", 0.7);
      const signalUpDown = mockMeter.upDownCounters.get("adaptive_runtime_signal_reading");
      assert.equal(signalUpDown?.adds.length, 1);
      assert.equal(signalUpDown?.adds[0]?.value, 0.7);

      // Re-emitting same value is suppressed
      emitDecision("op-explicit", 0.7);
      assert.equal(signalUpDown?.adds.length, 1);

      // Explicit purge with whitespace trimming
      sub.purgeOperation("  op-explicit  ");

      // Re-emitting now writes full value again
      emitDecision("op-explicit", 0.7);
      assert.equal(signalUpDown?.adds.length, 2);
      assert.equal(signalUpDown?.adds[1]?.value, 0.7);

      // Non-existent operation purge is a safe no-op
      assert.doesNotThrow(() => sub.purgeOperation("op-non-existent"));
      assert.doesNotThrow(() => sub.removeOperation("op-non-existent"));

      sub();
    });

    it("cleans up removal hook and internal maps on detach", () => {
      const mockRuntime = new MockEmitterRuntime();
      let removeCount = 0;
      (mockRuntime as unknown as Record<string, unknown>).removeOperation = () => {
        removeCount += 1;
        return true;
      };

      const mockMeter = new MockOpenTelemetryMeter();
      const sub = attachOpenTelemetryMeter(mockRuntime as unknown as AdaptiveRuntime, mockMeter);

      // Detach
      sub();

      // removeOperation should succeed without errors and not fire any hook
      assert.doesNotThrow(() => {
        (mockRuntime as unknown as AdaptiveRuntime).removeOperation("op-any");
      });
      assert.equal(removeCount, 1);

      // purgeOperation on detached subscription is safe
      assert.doesNotThrow(() => sub.purgeOperation("op-any"));
    });

    it("does not purge series when runtime.removeOperation returns false", () => {
      const mockRuntime = new MockEmitterRuntime();
      (mockRuntime as unknown as Record<string, unknown>).removeOperation = () => false;

      const mockMeter = new MockOpenTelemetryMeter();
      const sub = attachOpenTelemetryMeter(mockRuntime as unknown as AdaptiveRuntime, mockMeter);

      mockRuntime.emit("decision", {
        decision: makeDecision({
          operationId: "op-locked",
          signals: [{ name: "cpu", status: "ok", value: 10, unit: "ratio" }],
          budgets: [],
        }),
      });

      const signalUpDown = mockMeter.upDownCounters.get("adaptive_runtime_signal_reading");
      assert.equal(signalUpDown?.adds.length, 1);

      // Attempt remove, returns false
      const result = (mockRuntime as unknown as AdaptiveRuntime).removeOperation("op-locked");
      assert.equal(result, false);

      // Re-emit same value: because removal returned false, series was NOT purged, so 0 delta is suppressed!
      mockRuntime.emit("decision", {
        decision: makeDecision({
          operationId: "op-locked",
          signals: [{ name: "cpu", status: "ok", value: 10, unit: "ratio" }],
          budgets: [],
        }),
      });
      assert.equal(signalUpDown?.adds.length, 1);

      sub();
    });

    it("isolates errors thrown in removal hooks", () => {
      const mockRuntime = new MockEmitterRuntime();
      (mockRuntime as unknown as Record<string, unknown>).removeOperation = () => true;

      const sub1 = attachOpenTelemetryMeter(
        mockRuntime as unknown as AdaptiveRuntime,
        new MockOpenTelemetryMeter(),
      );
      const sub2 = attachOpenTelemetryMeter(
        mockRuntime as unknown as AdaptiveRuntime,
        new MockOpenTelemetryMeter(),
      );

      const REMOVAL_HOOKS = Symbol.for("adaptive-runtime.observability.removeOperationHooks");
      const hooks = (mockRuntime as unknown as Record<symbol, unknown>)[REMOVAL_HOOKS] as Set<
        (opId: string) => void
      >;
      assert.ok(hooks && hooks.size === 2);

      const firstHook = Array.from(hooks)[0];
      if (firstHook !== undefined) {
        hooks.delete(firstHook);
      }
      hooks.add(() => {
        throw new Error("hook explosion");
      });

      assert.doesNotThrow(() => {
        const removed = (mockRuntime as unknown as AdaptiveRuntime).removeOperation("op-faulty");
        assert.equal(removed, true);
      });

      sub1();
      sub2();
    });

    it("handles runtime without removeOperation method gracefully", () => {
      const mockRuntime = new MockEmitterRuntime();
      const mockMeter = new MockOpenTelemetryMeter();
      const sub = attachOpenTelemetryMeter(mockRuntime as unknown as AdaptiveRuntime, mockMeter);
      assert.equal(typeof sub, "function");
      assert.doesNotThrow(() => sub());
    });

    it("syncs MetricsCollector auto-purge with runtime.removeOperation on attach", () => {
      const mockRuntime = new MockEmitterRuntime();
      (mockRuntime as unknown as Record<string, unknown>).removeOperation = () => true;

      const collector = createMetricsCollector();
      const unsub = collector.attach(mockRuntime as unknown as AdaptiveRuntime);

      mockRuntime.emit("decision", {
        decision: makeDecision({
          operationId: "op-collector-sync",
          signals: [{ name: "load", status: "ok", value: 0.8, unit: "ratio" }],
          budgets: [],
        }),
      });
      mockRuntime.emit("run:success", {
        metadata: {
          operationId: "op-collector-sync",
          strategyId: "strat",
          qualityTier: 1,
          startedAt: 100,
          finishedAt: 150,
          durationMs: 50,
          attempts: 1,
          quality: { status: "passed" },
          decision: makeDecision(),
          signals: [],
        },
      });

      assert.ok(
        collector.getSnapshot().gauges.some((g) => g.labels.operation_id === "op-collector-sync"),
      );
      assert.ok(
        collector.getSnapshot().counters.some((c) => c.labels.operation_id === "op-collector-sync"),
      );

      (mockRuntime as unknown as AdaptiveRuntime).removeOperation("op-collector-sync");

      assert.equal(
        collector.getSnapshot().gauges.some((g) => g.labels.operation_id === "op-collector-sync"),
        false,
      );
      assert.equal(
        collector.getSnapshot().counters.some((c) => c.labels.operation_id === "op-collector-sync"),
        false,
      );

      unsub();
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

    it("produces distinct series for ambiguous label keys and values", () => {
      const collector = new MetricsCollector();

      collector.increment("ambiguous_total", { a: "b,c=d" });
      collector.increment("ambiguous_total", { a: "b", c: "d" });

      const snapshot = collector.getSnapshot();
      assert.equal(snapshot.counters.length, 2);
      assert.deepEqual(
        snapshot.counters.map((counter) => counter.labels),
        [{ a: "b", c: "d" }, { a: "b,c=d" }],
      );
      assert.deepEqual(
        snapshot.counters.map((counter) => counter.value),
        [1, 1],
      );

      const text = collector.toPrometheusText();
      assert.ok(text.includes('ambiguous_total{a="b",c="d"} 1'));
      assert.ok(text.includes('ambiguous_total{a="b,c=d"} 1'));
    });

    it("derives histogram families from the observe instrument, not the name suffix", () => {
      const collector = new MetricsCollector({
        buckets: [0.5, Number.POSITIVE_INFINITY],
      });

      collector.observe("x_total", 0.5);

      const snapshot = collector.getSnapshot();
      assert.equal(snapshot.counters.length, 0);
      assert.equal(snapshot.histograms.length, 1);

      const text = collector.toPrometheusText();
      assert.ok(text.includes("# TYPE x_total histogram"));
      assert.ok(!text.includes("# TYPE x_total counter"));
      assert.ok(text.includes('x_total_bucket{le="0.5"} 1'));
      assert.ok(text.includes('x_total_bucket{le="+Inf"} 1'));
      assert.ok(text.includes("x_total_sum 0.5"));
      assert.ok(text.includes("x_total_count 1"));
    });

    it("rejects conflicting instrument kinds before mutating series state", () => {
      const collector = new MetricsCollector({
        buckets: [1, Number.POSITIVE_INFINITY],
      });

      collector.increment("same");
      collector.increment("same");

      assert.throws(() => collector.setGauge("same", 1), TypeError);
      assert.throws(() => collector.observe("same", 0.5), TypeError);

      const snapshot = collector.getSnapshot();
      assert.equal(snapshot.counters.length, 1);
      assert.equal(snapshot.counters[0]?.value, 2);
      assert.equal(snapshot.gauges.length, 0);
      assert.equal(snapshot.histograms.length, 0);

      const text = collector.toPrometheusText();
      assert.ok(text.includes("# TYPE same counter"));
      assert.ok(!text.includes("# TYPE same gauge"));
      assert.ok(!text.includes("# TYPE same histogram"));
      assert.ok(text.includes("same 2"));

      // Same-kind repeated calls remain allowed.
      collector.increment("same");
      assert.equal(collector.getSnapshot().counters[0]?.value, 3);

      // The reverse direction also conflicts without dropping the gauge series.
      collector.setGauge("gauge_same", 7);
      assert.throws(() => collector.increment("gauge_same"), TypeError);
      assert.throws(() => collector.observe("gauge_same", 0.5), TypeError);
      assert.equal(collector.getSnapshot().gauges[0]?.value, 7);

      // A histogram family also rejects counter and gauge instruments.
      collector.observe("hist_same", 0.5);
      assert.throws(() => collector.increment("hist_same"), TypeError);
      assert.throws(() => collector.setGauge("hist_same", 1), TypeError);
      assert.equal(collector.getSnapshot().histograms.length, 1);
    });

    it("clears family registration on reset so a name can be reused with a different kind", () => {
      const collector = new MetricsCollector({
        buckets: [1, Number.POSITIVE_INFINITY],
      });

      collector.increment("reused_total");
      assert.throws(() => collector.observe("reused_total", 0.5), TypeError);

      collector.reset();
      assert.equal(collector.toPrometheusText(), "");

      collector.observe("reused_total", 0.5);

      const snapshot = collector.getSnapshot();
      assert.equal(snapshot.counters.length, 0);
      assert.equal(snapshot.histograms.length, 1);

      const text = collector.toPrometheusText();
      assert.ok(text.includes("# TYPE reused_total histogram"));
      assert.ok(text.includes('reused_total_bucket{le="1"} 1'));
      assert.ok(text.includes("reused_total_sum 0.5"));
      assert.ok(text.includes("reused_total_count 1"));
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

  describe("MetricsCollector maxSeries & LRU eviction", () => {
    it("validates maxSeries configuration option", () => {
      assert.throws(() => new MetricsCollector({ maxSeries: 0 }), ConfigurationError);
      assert.throws(() => new MetricsCollector({ maxSeries: -5 }), ConfigurationError);
      assert.throws(() => new MetricsCollector({ maxSeries: 3.14 }), ConfigurationError);
      assert.throws(() => new MetricsCollector({ maxSeries: Number.NaN }), ConfigurationError);
      assert.throws(
        () => new MetricsCollector({ maxSeries: Number.POSITIVE_INFINITY }),
        ConfigurationError,
      );
      assert.throws(
        () => new MetricsCollector({ maxSeries: "100" as unknown as number }),
        ConfigurationError,
      );

      // Valid values do not throw
      const collector1 = new MetricsCollector({ maxSeries: 1 });
      const collector2 = new MetricsCollector({ maxSeries: 500 });
      assert.ok(collector1);
      assert.ok(collector2);
    });

    it("evicts the least recently used series when maxSeries limit is reached", () => {
      const collector = new MetricsCollector({ maxSeries: 3 });

      // Add 3 series: counter A, gauge B, histogram C
      collector.increment("counter_a", { id: "a" }, 1);
      collector.setGauge("gauge_b", 42, { id: "b" });
      collector.observe("hist_c", 0.5, { id: "c" });

      let snapshot = collector.getSnapshot();
      assert.equal(snapshot.counters.length, 1);
      assert.equal(snapshot.gauges.length, 1);
      assert.equal(snapshot.histograms.length, 1);

      // Add 4th series: counter D. Oldest series (counter A) must be evicted!
      collector.increment("counter_d", { id: "d" }, 2);

      snapshot = collector.getSnapshot();
      assert.equal(snapshot.counters.length, 1); // counter_d only
      assert.equal(snapshot.counters[0]?.name, "counter_d");
      assert.equal(snapshot.gauges.length, 1); // gauge_b
      assert.equal(snapshot.histograms.length, 1); // hist_c

      // Refresh / update gauge B (becomes MRU)
      collector.setGauge("gauge_b", 99, { id: "b" });

      // Add 5th series: counter E. Oldest series now is hist_c! hist_c must be evicted!
      collector.increment("counter_e", { id: "e" }, 3);

      snapshot = collector.getSnapshot();
      assert.equal(snapshot.histograms.length, 0); // hist_c evicted
      assert.equal(snapshot.gauges.length, 1); // gauge_b remained because refreshed
      assert.equal(snapshot.gauges[0]?.value, 99);
      assert.equal(snapshot.counters.length, 2); // counter_d and counter_e
      assert.deepEqual(
        snapshot.counters.map((c) => c.name),
        ["counter_d", "counter_e"],
      );

      // Refresh / update counter_d by incrementing
      collector.increment("counter_d", { id: "d" }, 1);

      // Add 6th series: gauge F. Oldest series now is gauge_b! gauge_b must be evicted!
      collector.setGauge("gauge_f", 10, { id: "f" });

      snapshot = collector.getSnapshot();
      assert.equal(snapshot.gauges.length, 1);
      assert.equal(snapshot.gauges[0]?.name, "gauge_f");
      assert.equal(snapshot.counters.length, 2); // counter_e and counter_d
    });

    it("refreshes LRU when observing existing histogram series", () => {
      const collector = new MetricsCollector({ maxSeries: 2 });

      collector.observe("hist_1", 0.1);
      collector.increment("counter_1");

      // Touch hist_1
      collector.observe("hist_1", 0.2);

      // Add gauge_1 -> counter_1 was older than touched hist_1, so counter_1 is evicted
      collector.setGauge("gauge_1", 100);

      const snapshot = collector.getSnapshot();
      assert.equal(snapshot.counters.length, 0);
      assert.equal(snapshot.histograms.length, 1);
      assert.equal(snapshot.histograms[0]?.name, "hist_1");
      assert.equal(snapshot.gauges.length, 1);
      assert.equal(snapshot.gauges[0]?.name, "gauge_1");
    });
  });

  describe("MetricsCollector removeOperation", () => {
    it("validates operationId input", () => {
      const collector = new MetricsCollector();

      assert.throws(() => collector.removeOperation("" as string), ConfigurationError);
      assert.throws(() => collector.removeOperation("   "), ConfigurationError);
      assert.throws(() => collector.removeOperation(null as unknown as string), ConfigurationError);
      assert.throws(() => collector.removeOperation(123 as unknown as string), ConfigurationError);
      assert.throws(() => collector.removeOperation({} as unknown as string), ConfigurationError);

      collector.increment("requests_total", { operation_id: "op-1" });
      collector.removeOperation("  op-1  ");
      assert.equal(collector.getSnapshot().counters.length, 0);
    });

    it("removes all counters, gauges, and histograms matching operation_id and frees LRU capacity", () => {
      const collector = new MetricsCollector({ maxSeries: 6 });

      // Series for op-alpha
      collector.increment("requests_total", { operation_id: "op-alpha", type: "read" }, 10);
      collector.setGauge("signal_reading", 55.5, { operation_id: "op-alpha", signal: "cpu" });
      collector.observe("latency_seconds", 0.05, { operation_id: "op-alpha" });

      // Series for op-beta
      collector.increment("requests_total", { operation_id: "op-beta", type: "write" }, 5);
      collector.setGauge("signal_reading", 88.8, { operation_id: "op-beta", signal: "cpu" });

      // Global series without operation_id
      collector.increment("runtime_closed_total");

      let snapshot = collector.getSnapshot();
      assert.equal(snapshot.counters.length, 3);
      assert.equal(snapshot.gauges.length, 2);
      assert.equal(snapshot.histograms.length, 1);

      // Remove op-alpha
      collector.removeOperation("op-alpha");

      snapshot = collector.getSnapshot();
      // All op-alpha series are gone
      assert.equal(
        snapshot.counters.some((c) => c.labels.operation_id === "op-alpha"),
        false,
      );
      assert.equal(
        snapshot.gauges.some((g) => g.labels.operation_id === "op-alpha"),
        false,
      );
      assert.equal(
        snapshot.histograms.some((h) => h.labels.operation_id === "op-alpha"),
        false,
      );

      // op-beta and global series remain
      assert.equal(snapshot.counters.length, 2); // op-beta requests_total, global runtime_closed_total
      assert.equal(snapshot.gauges.length, 1); // op-beta signal_reading
      assert.equal(snapshot.histograms.length, 0);

      // Verify Prometheus text does not contain op-alpha
      const text = collector.toPrometheusText();
      assert.ok(!text.includes("op-alpha"));
      assert.ok(text.includes('operation_id="op-beta"'));
      assert.ok(text.includes("runtime_closed_total"));

      // Verify removing non-existent operation is a clean no-op
      assert.doesNotThrow(() => collector.removeOperation("op-gamma"));
      assert.equal(collector.getSnapshot().counters.length, 2);

      // Verify LRU capacity was freed:
      // We had 6 total items. op-alpha had 3 items removed. 3 items remain.
      // maxSeries is 6. We can add 3 new series without evicting op-beta!
      collector.increment("new_1");
      collector.increment("new_2");
      collector.increment("new_3");

      snapshot = collector.getSnapshot();
      assert.ok(snapshot.counters.some((c) => c.labels.operation_id === "op-beta"));
    });
  });
});
