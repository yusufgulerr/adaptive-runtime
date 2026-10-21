import type { AdaptiveRuntime } from "../types/runtime.js";

/**
 * Structural type for an OpenTelemetry attribute value.
 */
export type MetricAttributeValue = string | number | boolean | undefined;

/**
 * Structural type for metric attributes dictionary.
 */
export type MetricAttributesLike = Readonly<Record<string, MetricAttributeValue>>;

/**
 * Structural duck-typed counter matching OpenTelemetry Counter.
 */
export interface CounterLike {
  add(value: number, attributes?: MetricAttributesLike): void;
}

/**
 * Structural duck-typed histogram matching OpenTelemetry Histogram.
 */
export interface HistogramLikeMetric {
  record(value: number, attributes?: MetricAttributesLike): void;
}

/**
 * Structural duck-typed UpDownCounter matching OpenTelemetry UpDownCounter.
 */
export interface UpDownCounterLike {
  add(value: number, attributes?: MetricAttributesLike): void;
}

/**
 * Structural options for metric instrument creation.
 */
export interface MetricOptionsLike {
  readonly description?: string;
  readonly unit?: string;
}

/**
 * Structural duck-typed Meter interface compatible with OpenTelemetry Meter.
 * Zero dependency on \@opentelemetry/api at compile-time or runtime.
 */
export interface OpenTelemetryMeterLike {
  createCounter(name: string, options?: MetricOptionsLike): CounterLike;
  createHistogram(name: string, options?: MetricOptionsLike): HistogramLikeMetric;
  createUpDownCounter?(name: string, options?: MetricOptionsLike): UpDownCounterLike;
}

/**
 * Options configuring the observability bridge and metrics collector.
 */
export interface ObservabilityOptions {
  /** Metric prefix. Defaults to "adaptive_runtime". */
  readonly prefix?: string;
  /** Static attributes attached to every metric event. */
  readonly defaultAttributes?: MetricAttributesLike;
  /** Custom latency histogram buckets in seconds. */
  readonly buckets?: readonly number[];
}

/**
 * Normalized string label dictionary for metrics snapshots and Prometheus output.
 */
export type MetricLabels = Readonly<Record<string, string>>;

export interface CounterSnapshot {
  readonly name: string;
  readonly labels: MetricLabels;
  readonly value: number;
}

export interface GaugeSnapshot {
  readonly name: string;
  readonly labels: MetricLabels;
  readonly value: number;
}

export interface HistogramBucketSnapshot {
  readonly le: number;
  readonly count: number;
}

export interface HistogramSnapshot {
  readonly name: string;
  readonly labels: MetricLabels;
  readonly count: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
  readonly buckets: readonly HistogramBucketSnapshot[];
}

export interface MetricsSnapshot {
  readonly counters: readonly CounterSnapshot[];
  readonly gauges: readonly GaugeSnapshot[];
  readonly histograms: readonly HistogramSnapshot[];
}

export interface RuntimeMetricsCollector {
  attach(runtime: AdaptiveRuntime): () => void;
  getSnapshot(): MetricsSnapshot;
  toPrometheusText(): string;
  reset(): void;
}

/**
 * Standard Prometheus latency histogram buckets in seconds.
 */
const DEFAULT_HISTOGRAM_BUCKETS: readonly number[] = [
  0.005,
  0.01,
  0.025,
  0.05,
  0.1,
  0.25,
  0.5,
  1,
  2.5,
  5,
  10,
  Number.POSITIVE_INFINITY,
];

function mergeMetricAttributes(
  defaults: MetricAttributesLike | undefined,
  overrides?: MetricAttributesLike,
): MetricAttributesLike | undefined {
  if (defaults === undefined) {
    return overrides;
  }
  if (overrides === undefined) {
    return defaults;
  }
  return { ...defaults, ...overrides };
}

function normalizeBuckets(buckets: readonly number[]): readonly number[] {
  const sorted = [...buckets].sort((a, b) => a - b);
  if (sorted[sorted.length - 1] !== Number.POSITIVE_INFINITY) {
    sorted.push(Number.POSITIVE_INFINITY);
  }
  return sorted;
}

function createMetricLabels(
  defaults?: MetricAttributesLike,
  overrides?: MetricAttributesLike,
): MetricLabels {
  const map: Record<string, string> = {};
  if (defaults !== undefined) {
    for (const [key, value] of Object.entries(defaults)) {
      if (value !== undefined) {
        map[key] = String(value);
      }
    }
  }
  if (overrides !== undefined) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) {
        map[key] = String(value);
      }
    }
  }
  const sortedKeys = Object.keys(map).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const sorted: Record<string, string> = {};
  for (const key of sortedKeys) {
    const val = map[key];
    if (val !== undefined) {
      sorted[key] = val;
    }
  }
  return Object.freeze(sorted);
}

function buildSeriesKey(name: string, labels: MetricLabels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) {
    return name;
  }
  const formatted = entries.map(([k, v]) => `${k}=${v}`).join(",");
  return `${name}{${formatted}}`;
}

function compareSnapshots<T extends { readonly name: string; readonly labels: MetricLabels }>(
  a: T,
  b: T,
): number {
  if (a.name !== b.name) {
    return a.name < b.name ? -1 : 1;
  }
  const keyA = buildSeriesKey(a.name, a.labels);
  const keyB = buildSeriesKey(b.name, b.labels);
  return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
}

function escapeHelp(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function formatPrometheusLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (keys.length === 0) {
    return "";
  }
  const pairs = keys.map((key) => `${key}="${escapeLabelValue(labels[key] ?? "")}"`);
  return `{${pairs.join(",")}}`;
}

interface MetricFamilyMeta {
  readonly type: "counter" | "gauge" | "histogram";
  readonly help: string;
}

function getMetricFamilyMeta(name: string, prefix: string): MetricFamilyMeta {
  const suffix = name.startsWith(`${prefix}_`) ? name.slice(prefix.length + 1) : name;
  let type: "counter" | "gauge" | "histogram";
  let help: string;

  switch (suffix) {
    case "strategy_selections_total":
      type = "counter";
      help = "Total number of strategy selections started.";
      break;
    case "runs_total":
      type = "counter";
      help = "Total number of strategy runs completed or failed.";
      break;
    case "quality_total":
      type = "counter";
      help = "Total number of strategy runs categorized by quality status.";
      break;
    case "run_duration_seconds":
      type = "histogram";
      help = "Duration of strategy execution in seconds.";
      break;
    case "decisions_total":
      type = "counter";
      help = "Total number of policy decisions made.";
      break;
    case "signal_reading":
      type = "gauge";
      help = "Current resource signal reading value.";
      break;
    case "signal_status_total":
      type = "counter";
      help = "Total count of non-ok signal readings.";
      break;
    case "budget_engaged":
      type = "gauge";
      help = "Current budget engagement state (1 engaged, 0 healthy).";
      break;
    case "budget_status_total":
      type = "counter";
      help = "Total count of non-ok budget evaluations.";
      break;
    case "provider_errors_total":
      type = "counter";
      help = "Total number of signal provider errors.";
      break;
    case "listener_errors_total":
      type = "counter";
      help = "Total number of listener errors.";
      break;
    case "runtime_closed_total":
      type = "counter";
      help = "Total number of runtime close events.";
      break;
    default:
      type = name.endsWith("_total") ? "counter" : "gauge";
      help = `Metric family for ${name}.`;
      break;
  }

  return { type, help };
}

interface InternalCounterSeries {
  readonly name: string;
  readonly labels: MetricLabels;
  value: number;
}

interface InternalGaugeSeries {
  readonly name: string;
  readonly labels: MetricLabels;
  value: number;
}

interface InternalHistogramSeries {
  readonly name: string;
  readonly labels: MetricLabels;
  count: number;
  sum: number;
  min: number;
  max: number;
  readonly bucketCounts: number[];
}

/**
 * In-memory metrics sink and Prometheus exposition generator.
 * Maintains real series state without third-party dependencies.
 */
export class MetricsCollector implements RuntimeMetricsCollector {
  readonly #prefix: string;
  readonly #defaultAttributes?: MetricAttributesLike;
  readonly #buckets: readonly number[];

  readonly #counters = new Map<string, InternalCounterSeries>();
  readonly #gauges = new Map<string, InternalGaugeSeries>();
  readonly #histograms = new Map<string, InternalHistogramSeries>();

  constructor(options?: ObservabilityOptions) {
    this.#prefix = options?.prefix ?? "adaptive_runtime";
    this.#defaultAttributes = options?.defaultAttributes;
    this.#buckets =
      options?.buckets !== undefined
        ? normalizeBuckets(options.buckets)
        : DEFAULT_HISTOGRAM_BUCKETS;
  }

  increment(name: string, labels?: MetricAttributesLike, amount = 1): void {
    if (!Number.isFinite(amount)) {
      throw new TypeError(`Counter increment for "${name}" must be a finite number.`);
    }
    const metricLabels = createMetricLabels(this.#defaultAttributes, labels);
    const key = buildSeriesKey(name, metricLabels);
    const existing = this.#counters.get(key);
    if (existing === undefined) {
      this.#counters.set(key, { name, labels: metricLabels, value: amount });
      return;
    }
    existing.value += amount;
  }

  setGauge(name: string, value: number, labels?: MetricAttributesLike): void {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Gauge value for "${name}" must be a finite number.`);
    }
    const metricLabels = createMetricLabels(this.#defaultAttributes, labels);
    const key = buildSeriesKey(name, metricLabels);
    const existing = this.#gauges.get(key);
    if (existing === undefined) {
      this.#gauges.set(key, { name, labels: metricLabels, value });
      return;
    }
    existing.value = value;
  }

  observe(name: string, value: number, labels?: MetricAttributesLike): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(
        `Histogram observation for "${name}" must be a finite non-negative number.`,
      );
    }
    const metricLabels = createMetricLabels(this.#defaultAttributes, labels);
    const key = buildSeriesKey(name, metricLabels);
    const existing = this.#histograms.get(key);
    if (existing === undefined) {
      this.#histograms.set(key, {
        name,
        labels: metricLabels,
        count: 1,
        sum: value,
        min: value,
        max: value,
        bucketCounts: this.#buckets.map((b) => (value <= b ? 1 : 0)),
      });
      return;
    }
    existing.count += 1;
    existing.sum += value;
    existing.min = Math.min(existing.min, value);
    existing.max = Math.max(existing.max, value);
    for (let i = 0; i < this.#buckets.length; i++) {
      const bucket = this.#buckets[i];
      if (bucket !== undefined && value <= bucket) {
        existing.bucketCounts[i] = (existing.bucketCounts[i] ?? 0) + 1;
      }
    }
  }

  attach(runtime: AdaptiveRuntime): () => void {
    if (runtime === null || typeof runtime !== "object" || typeof runtime.on !== "function") {
      throw new TypeError("attach requires an AdaptiveRuntime instance with an 'on' method.");
    }

    const unsubs: Array<() => void> = [
      runtime.on("run:start", ({ operationId, strategyId }) => {
        this.increment(`${this.#prefix}_strategy_selections_total`, {
          operation_id: operationId,
          strategy_id: strategyId,
        });
      }),
      runtime.on("run:success", ({ metadata }) => {
        this.increment(`${this.#prefix}_runs_total`, {
          operation_id: metadata.operationId,
          result: "success",
          strategy_id: metadata.strategyId,
        });
        this.increment(`${this.#prefix}_quality_total`, {
          operation_id: metadata.operationId,
          status: metadata.quality.status,
          strategy_id: metadata.strategyId,
        });
        this.observe(`${this.#prefix}_run_duration_seconds`, metadata.durationMs / 1000, {
          operation_id: metadata.operationId,
          strategy_id: metadata.strategyId,
        });
      }),
      runtime.on("run:error", ({ operationId, strategyId, durationMs }) => {
        const effectiveStrategyId = strategyId ?? "none";
        this.increment(`${this.#prefix}_runs_total`, {
          operation_id: operationId,
          result: "error",
          strategy_id: effectiveStrategyId,
        });
        if (durationMs !== undefined) {
          this.observe(`${this.#prefix}_run_duration_seconds`, durationMs / 1000, {
            operation_id: operationId,
            strategy_id: effectiveStrategyId,
          });
        }
      }),
      runtime.on("decision", ({ decision }) => {
        this.increment(`${this.#prefix}_decisions_total`, {
          changed: String(decision.changed),
          kind: decision.kind,
          operation_id: decision.operationId,
        });
        for (const signal of decision.signals) {
          if (
            signal.status === "ok" &&
            typeof signal.value === "number" &&
            Number.isFinite(signal.value)
          ) {
            this.setGauge(`${this.#prefix}_signal_reading`, signal.value, {
              operation_id: decision.operationId,
              signal: signal.name,
              status: signal.status,
            });
          } else {
            this.increment(`${this.#prefix}_signal_status_total`, {
              operation_id: decision.operationId,
              signal: signal.name,
              status: signal.status,
            });
          }
        }
        for (const budget of decision.budgets) {
          if (budget.status === "ok") {
            this.setGauge(`${this.#prefix}_budget_engaged`, budget.engaged ? 1 : 0, {
              budget_id: budget.id,
              operation_id: decision.operationId,
            });
          } else {
            this.increment(`${this.#prefix}_budget_status_total`, {
              budget_id: budget.id,
              operation_id: decision.operationId,
              status: budget.status,
            });
          }
        }
      }),
      runtime.on("provider:error", ({ providerId }) => {
        this.increment(`${this.#prefix}_provider_errors_total`, {
          provider_id: providerId,
        });
      }),
      runtime.on("listener:error", ({ event }) => {
        this.increment(`${this.#prefix}_listener_errors_total`, {
          event,
        });
      }),
      runtime.on("runtime:closed", () => {
        this.increment(`${this.#prefix}_runtime_closed_total`);
      }),
    ];

    return () => {
      for (const unsub of unsubs) {
        unsub();
      }
    };
  }

  getSnapshot(): MetricsSnapshot {
    return {
      counters: Array.from(this.#counters.values())
        .map((s) => ({ name: s.name, labels: s.labels, value: s.value }))
        .sort(compareSnapshots),
      gauges: Array.from(this.#gauges.values())
        .map((s) => ({ name: s.name, labels: s.labels, value: s.value }))
        .sort(compareSnapshots),
      histograms: Array.from(this.#histograms.values())
        .map((s) => ({
          name: s.name,
          labels: s.labels,
          count: s.count,
          sum: s.sum,
          min: s.min,
          max: s.max,
          buckets: this.#buckets.map((le, idx) => ({
            le,
            count: s.bucketCounts[idx] ?? 0,
          })),
        }))
        .sort(compareSnapshots),
    };
  }

  toPrometheusText(): string {
    if (this.#counters.size === 0 && this.#gauges.size === 0 && this.#histograms.size === 0) {
      return "";
    }

    const familyMap = new Map<string, MetricFamilyMeta>();

    for (const counter of this.#counters.values()) {
      if (!familyMap.has(counter.name)) {
        familyMap.set(counter.name, getMetricFamilyMeta(counter.name, this.#prefix));
      }
    }
    for (const gauge of this.#gauges.values()) {
      if (!familyMap.has(gauge.name)) {
        familyMap.set(gauge.name, getMetricFamilyMeta(gauge.name, this.#prefix));
      }
    }
    for (const histogram of this.#histograms.values()) {
      if (!familyMap.has(histogram.name)) {
        familyMap.set(histogram.name, getMetricFamilyMeta(histogram.name, this.#prefix));
      }
    }

    const sortedFamilyNames = Array.from(familyMap.keys()).sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );

    const lines: string[] = [];

    for (const name of sortedFamilyNames) {
      const meta = familyMap.get(name);
      if (meta === undefined) {
        continue;
      }
      lines.push(`# HELP ${name} ${escapeHelp(meta.help)}`);
      lines.push(`# TYPE ${name} ${meta.type}`);

      if (meta.type === "counter") {
        const seriesList = Array.from(this.#counters.values())
          .filter((s) => s.name === name)
          .sort(compareSnapshots);
        for (const s of seriesList) {
          lines.push(`${name}${formatPrometheusLabels(s.labels)} ${s.value}`);
        }
      } else if (meta.type === "gauge") {
        const seriesList = Array.from(this.#gauges.values())
          .filter((s) => s.name === name)
          .sort(compareSnapshots);
        for (const s of seriesList) {
          lines.push(`${name}${formatPrometheusLabels(s.labels)} ${s.value}`);
        }
      } else if (meta.type === "histogram") {
        const seriesList = Array.from(this.#histograms.values())
          .filter((s) => s.name === name)
          .sort(compareSnapshots);
        for (const s of seriesList) {
          for (let i = 0; i < this.#buckets.length; i++) {
            const le = this.#buckets[i];
            if (le === undefined) {
              continue;
            }
            const leStr = !Number.isFinite(le) ? "+Inf" : String(le);
            const bucketLabels = { ...s.labels, le: leStr };
            lines.push(
              `${name}_bucket${formatPrometheusLabels(bucketLabels)} ${s.bucketCounts[i] ?? 0}`,
            );
          }
          lines.push(`${name}_sum${formatPrometheusLabels(s.labels)} ${s.sum}`);
          lines.push(`${name}_count${formatPrometheusLabels(s.labels)} ${s.count}`);
        }
      }
    }

    return `${lines.join("\n")}\n`;
  }

  reset(): void {
    this.#counters.clear();
    this.#gauges.clear();
    this.#histograms.clear();
  }
}

/**
 * Creates an in-memory metrics collector and Prometheus text exporter.
 */
export function createMetricsCollector(options?: ObservabilityOptions): RuntimeMetricsCollector {
  return new MetricsCollector(options);
}

/**
 * Attaches a duck-typed OpenTelemetry Meter to an AdaptiveRuntime instance.
 * Conforms strictly to zero-coercion: non-ok signal and budget readings
 * increment status counters and never record zero gauges.
 */
export function attachOpenTelemetryMeter(
  runtime: AdaptiveRuntime,
  meter: OpenTelemetryMeterLike,
  options?: ObservabilityOptions,
): () => void {
  if (
    meter === null ||
    typeof meter !== "object" ||
    typeof meter.createCounter !== "function" ||
    typeof meter.createHistogram !== "function"
  ) {
    throw new TypeError(
      "attachOpenTelemetryMeter requires an OpenTelemetryMeterLike with createCounter and createHistogram.",
    );
  }
  if (runtime === null || typeof runtime !== "object" || typeof runtime.on !== "function") {
    throw new TypeError(
      "attachOpenTelemetryMeter requires an AdaptiveRuntime instance with an 'on' method.",
    );
  }

  const prefix = options?.prefix ?? "adaptive_runtime";
  const defaultAttrs = options?.defaultAttributes;

  const strategySelectionsCounter = meter.createCounter(`${prefix}_strategy_selections_total`, {
    description: "Total number of strategy selections started.",
  });
  const runsCounter = meter.createCounter(`${prefix}_runs_total`, {
    description: "Total number of strategy executions completed or failed.",
  });
  const qualityCounter = meter.createCounter(`${prefix}_quality_total`, {
    description: "Total number of runs categorized by quality status.",
  });
  const runDurationHistogram = meter.createHistogram(`${prefix}_run_duration_seconds`, {
    description: "Duration of strategy execution in seconds.",
    unit: "s",
  });
  const decisionsCounter = meter.createCounter(`${prefix}_decisions_total`, {
    description: "Total number of policy decisions made.",
  });
  const signalStatusCounter = meter.createCounter(`${prefix}_signal_status_total`, {
    description: "Total count of non-ok signal readings observed.",
  });
  const budgetStatusCounter = meter.createCounter(`${prefix}_budget_status_total`, {
    description: "Total count of non-ok budget evaluations observed.",
  });
  const providerErrorsCounter = meter.createCounter(`${prefix}_provider_errors_total`, {
    description: "Total number of provider read errors.",
  });
  const listenerErrorsCounter = meter.createCounter(`${prefix}_listener_errors_total`, {
    description: "Total number of listener errors.",
  });
  const runtimeClosedCounter = meter.createCounter(`${prefix}_runtime_closed_total`, {
    description: "Total number of times runtime was closed.",
  });

  const unsubs: Array<() => void> = [
    runtime.on("run:start", ({ operationId, strategyId }) => {
      strategySelectionsCounter.add(
        1,
        mergeMetricAttributes(defaultAttrs, {
          operation_id: operationId,
          strategy_id: strategyId,
        }),
      );
    }),
    runtime.on("run:success", ({ metadata }) => {
      runsCounter.add(
        1,
        mergeMetricAttributes(defaultAttrs, {
          operation_id: metadata.operationId,
          result: "success",
          strategy_id: metadata.strategyId,
        }),
      );
      qualityCounter.add(
        1,
        mergeMetricAttributes(defaultAttrs, {
          operation_id: metadata.operationId,
          status: metadata.quality.status,
          strategy_id: metadata.strategyId,
        }),
      );
      runDurationHistogram.record(
        metadata.durationMs / 1000,
        mergeMetricAttributes(defaultAttrs, {
          operation_id: metadata.operationId,
          strategy_id: metadata.strategyId,
        }),
      );
    }),
    runtime.on("run:error", ({ operationId, strategyId, durationMs }) => {
      const effectiveStrategyId = strategyId ?? "none";
      runsCounter.add(
        1,
        mergeMetricAttributes(defaultAttrs, {
          operation_id: operationId,
          result: "error",
          strategy_id: effectiveStrategyId,
        }),
      );
      if (durationMs !== undefined) {
        runDurationHistogram.record(
          durationMs / 1000,
          mergeMetricAttributes(defaultAttrs, {
            operation_id: operationId,
            strategy_id: effectiveStrategyId,
          }),
        );
      }
    }),
    runtime.on("decision", ({ decision }) => {
      decisionsCounter.add(
        1,
        mergeMetricAttributes(defaultAttrs, {
          changed: String(decision.changed),
          kind: decision.kind,
          operation_id: decision.operationId,
        }),
      );
      for (const signal of decision.signals) {
        if (signal.status !== "ok") {
          signalStatusCounter.add(
            1,
            mergeMetricAttributes(defaultAttrs, {
              operation_id: decision.operationId,
              signal: signal.name,
              status: signal.status,
            }),
          );
        }
      }
      for (const budget of decision.budgets) {
        if (budget.status !== "ok") {
          budgetStatusCounter.add(
            1,
            mergeMetricAttributes(defaultAttrs, {
              budget_id: budget.id,
              operation_id: decision.operationId,
              status: budget.status,
            }),
          );
        }
      }
    }),
    runtime.on("provider:error", ({ providerId }) => {
      providerErrorsCounter.add(
        1,
        mergeMetricAttributes(defaultAttrs, {
          provider_id: providerId,
        }),
      );
    }),
    runtime.on("listener:error", ({ event }) => {
      listenerErrorsCounter.add(
        1,
        mergeMetricAttributes(defaultAttrs, {
          event,
        }),
      );
    }),
    runtime.on("runtime:closed", () => {
      runtimeClosedCounter.add(1, defaultAttrs);
    }),
  ];

  return () => {
    for (const unsub of unsubs) {
      unsub();
    }
  };
}
