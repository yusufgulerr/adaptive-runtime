import { ConfigurationError } from "../errors/index.js";
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
 * Structural duck-typed synchronous gauge matching OpenTelemetry Gauge.
 */
export interface GaugeLike {
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
  createGauge?(name: string, options?: MetricOptionsLike): GaugeLike;
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
  /** Maximum series cardinality across all families. Defaults to 1000. */
  readonly maxSeries?: number;
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
  /** Removes all series associated with the specified operation id; surrounding whitespace is trimmed. */
  removeOperation(operationId: string): void;
}

/**
 * Handle returned by attachOpenTelemetryMeter allowing detachment and explicit series purging.
 */
export interface OpenTelemetryMeterSubscription {
  (): void;
  /** Removes all series associated with the specified operation id from UpDownCounter tracking maps. */
  purgeOperation(operationId: string): void;
  /** Alias for purgeOperation to match RuntimeMetricsCollector.removeOperation. */
  removeOperation(operationId: string): void;
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

function validateMaxSeries(maxSeries: number | undefined): void {
  if (
    maxSeries !== undefined &&
    (typeof maxSeries !== "number" || !Number.isInteger(maxSeries) || maxSeries <= 0)
  ) {
    throw new ConfigurationError("maxSeries must be a positive integer.");
  }
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

function compareLabelKeys(a: readonly [string, string], b: readonly [string, string]): number {
  if (a[0] !== b[0]) {
    return a[0] < b[0] ? -1 : 1;
  }
  if (a[1] !== b[1]) {
    return a[1] < b[1] ? -1 : 1;
  }
  return 0;
}

function buildSeriesKey(name: string, labels: MetricLabels): string {
  // Length-prefixed segments make the key unambiguous regardless of the
  // characters present in metric names, label keys, or label values.
  let key = `${name.length}:${name}`;
  const entries = Object.entries(labels).sort(compareLabelKeys);
  for (const [labelKey, labelValue] of entries) {
    key += `;${labelKey.length}:${labelKey}=${labelValue.length}:${labelValue}`;
  }
  return key;
}

function compareSnapshots<T extends { readonly name: string; readonly labels: MetricLabels }>(
  a: T,
  b: T,
): number {
  if (a.name !== b.name) {
    return a.name < b.name ? -1 : 1;
  }
  const entriesA = Object.entries(a.labels).sort(compareLabelKeys);
  const entriesB = Object.entries(b.labels).sort(compareLabelKeys);
  const sharedLength = Math.min(entriesA.length, entriesB.length);
  for (let i = 0; i < sharedLength; i++) {
    const entryA = entriesA[i];
    const entryB = entriesB[i];
    if (entryA === undefined || entryB === undefined) {
      break;
    }
    const order = compareLabelKeys(entryA, entryB);
    if (order !== 0) {
      return order;
    }
  }
  return entriesA.length < entriesB.length ? -1 : entriesA.length > entriesB.length ? 1 : 0;
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

type MetricFamilyType = "counter" | "gauge" | "histogram";

interface MetricFamilyMeta {
  readonly type: MetricFamilyType;
  readonly help: string;
}

function getMetricFamilyHelp(name: string, prefix: string): string {
  const suffix = name.startsWith(`${prefix}_`) ? name.slice(prefix.length + 1) : name;

  switch (suffix) {
    case "strategy_selections_total":
      return "Total number of strategy selections started.";
    case "runs_total":
      return "Total number of strategy runs completed or failed.";
    case "quality_total":
      return "Total number of strategy runs categorized by quality status.";
    case "run_duration_seconds":
      return "Duration of strategy execution in seconds.";
    case "decisions_total":
      return "Total number of policy decisions made.";
    case "signal_reading":
      return "Current resource signal reading value.";
    case "signal_status_total":
      return "Total count of non-ok signal readings.";
    case "budget_engaged":
      return "Current budget engagement state (1 engaged, 0 healthy).";
    case "budget_status_total":
      return "Total count of non-ok budget evaluations.";
    case "provider_errors_total":
      return "Total number of signal provider errors.";
    case "listener_errors_total":
      return "Total number of listener errors.";
    case "runtime_closed_total":
      return "Total number of runtime close events.";
    default:
      return `Metric family for ${name}.`;
  }
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

function safeRecord(action: () => void): void {
  try {
    action();
  } catch {
    // Isolated: single instrument failure must not drop other telemetry or throw
  }
}

const REMOVAL_HOOKS = Symbol.for("adaptive-runtime.observability.removeOperationHooks");

type RuntimeWithHooks = AdaptiveRuntime & {
  [REMOVAL_HOOKS]?: Set<(operationId: string) => void>;
};

function registerOperationRemovalHook(
  runtime: AdaptiveRuntime,
  hook: (operationId: string) => void,
): () => void {
  const target = runtime as RuntimeWithHooks;
  let hooks = target[REMOVAL_HOOKS];
  if (hooks === undefined) {
    hooks = new Set();
    target[REMOVAL_HOOKS] = hooks;
    const original = runtime.removeOperation?.bind(runtime);
    if (typeof original === "function") {
      runtime.removeOperation = (operationId: string): boolean => {
        const removed = original(operationId);
        if (removed) {
          const currentHooks = target[REMOVAL_HOOKS];
          if (currentHooks !== undefined) {
            for (const h of currentHooks) {
              safeRecord(() => h(operationId));
            }
          }
        }
        return removed;
      };
    }
  }
  hooks.add(hook);
  return () => {
    hooks?.delete(hook);
  };
}

/**
 * In-memory metrics sink and Prometheus exposition generator.
 * Maintains real series state without third-party dependencies.
 */
export class MetricsCollector implements RuntimeMetricsCollector {
  readonly #prefix: string;
  readonly #defaultAttributes?: MetricAttributesLike;
  readonly #buckets: readonly number[];
  readonly #maxSeries: number;

  readonly #counters = new Map<string, InternalCounterSeries>();
  readonly #gauges = new Map<string, InternalGaugeSeries>();
  readonly #histograms = new Map<string, InternalHistogramSeries>();
  readonly #families = new Map<string, MetricFamilyMeta>();
  readonly #lruOrder = new Map<string, MetricFamilyType>();

  constructor(options?: ObservabilityOptions) {
    validateMaxSeries(options?.maxSeries);
    this.#prefix = options?.prefix ?? "adaptive_runtime";
    this.#defaultAttributes = options?.defaultAttributes;
    this.#buckets =
      options?.buckets !== undefined
        ? normalizeBuckets(options.buckets)
        : DEFAULT_HISTOGRAM_BUCKETS;
    this.#maxSeries = options?.maxSeries ?? 1000;
  }

  #touchLru(key: string, kind: MetricFamilyType): void {
    this.#lruOrder.delete(key);
    this.#lruOrder.set(key, kind);
  }

  #evictIfNeeded(): void {
    if (this.#lruOrder.size >= this.#maxSeries) {
      const oldestKey = this.#lruOrder.keys().next().value;
      if (oldestKey !== undefined) {
        const kind = this.#lruOrder.get(oldestKey);
        this.#lruOrder.delete(oldestKey);
        if (kind === "counter") {
          this.#counters.delete(oldestKey);
        } else if (kind === "gauge") {
          this.#gauges.delete(oldestKey);
        } else if (kind === "histogram") {
          this.#histograms.delete(oldestKey);
        }
      }
    }
  }

  #registerFamily(name: string, type: MetricFamilyType): void {
    const existing = this.#families.get(name);
    if (existing !== undefined) {
      if (existing.type !== type) {
        throw new TypeError(
          `Metric "${name}" is already registered as a ${existing.type} family and cannot be used as a ${type} family.`,
        );
      }
      return;
    }
    this.#families.set(name, { type, help: getMetricFamilyHelp(name, this.#prefix) });
  }

  increment(name: string, labels?: MetricAttributesLike, amount = 1): void {
    if (!Number.isFinite(amount)) {
      throw new TypeError(`Counter increment for "${name}" must be a finite number.`);
    }
    const metricLabels = createMetricLabels(this.#defaultAttributes, labels);
    this.#registerFamily(name, "counter");
    const key = buildSeriesKey(name, metricLabels);
    const existing = this.#counters.get(key);
    if (existing === undefined) {
      this.#evictIfNeeded();
      this.#counters.set(key, { name, labels: metricLabels, value: amount });
      this.#touchLru(key, "counter");
      return;
    }
    existing.value += amount;
    this.#touchLru(key, "counter");
  }

  setGauge(name: string, value: number, labels?: MetricAttributesLike): void {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Gauge value for "${name}" must be a finite number.`);
    }
    const metricLabels = createMetricLabels(this.#defaultAttributes, labels);
    this.#registerFamily(name, "gauge");
    const key = buildSeriesKey(name, metricLabels);
    const existing = this.#gauges.get(key);
    if (existing === undefined) {
      this.#evictIfNeeded();
      this.#gauges.set(key, { name, labels: metricLabels, value });
      this.#touchLru(key, "gauge");
      return;
    }
    existing.value = value;
    this.#touchLru(key, "gauge");
  }

  observe(name: string, value: number, labels?: MetricAttributesLike): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(
        `Histogram observation for "${name}" must be a finite non-negative number.`,
      );
    }
    const metricLabels = createMetricLabels(this.#defaultAttributes, labels);
    this.#registerFamily(name, "histogram");
    const key = buildSeriesKey(name, metricLabels);
    const existing = this.#histograms.get(key);
    if (existing === undefined) {
      this.#evictIfNeeded();
      this.#histograms.set(key, {
        name,
        labels: metricLabels,
        count: 1,
        sum: value,
        min: value,
        max: value,
        bucketCounts: this.#buckets.map((b) => (value <= b ? 1 : 0)),
      });
      this.#touchLru(key, "histogram");
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
    this.#touchLru(key, "histogram");
  }

  attach(runtime: AdaptiveRuntime): () => void {
    if (runtime === null || typeof runtime !== "object" || typeof runtime.on !== "function") {
      throw new TypeError("attach requires an AdaptiveRuntime instance with an 'on' method.");
    }

    const unhookRemoval = registerOperationRemovalHook(runtime, (opId) => {
      this.removeOperation(opId);
    });

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
      unhookRemoval();
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
    if (this.#families.size === 0) {
      return "";
    }

    const sortedFamilyNames = Array.from(this.#families.keys()).sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );

    const lines: string[] = [];

    for (const name of sortedFamilyNames) {
      const meta = this.#families.get(name);
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
    this.#families.clear();
    this.#lruOrder.clear();
  }

  removeOperation(operationId: string): void {
    if (typeof operationId !== "string" || operationId.trim().length === 0) {
      throw new ConfigurationError("operationId must be a non-empty string.");
    }
    const normalizedOperationId = operationId.trim();

    for (const [key, series] of this.#counters) {
      if (series.labels.operation_id === normalizedOperationId) {
        this.#counters.delete(key);
        this.#lruOrder.delete(key);
      }
    }

    for (const [key, series] of this.#gauges) {
      if (series.labels.operation_id === normalizedOperationId) {
        this.#gauges.delete(key);
        this.#lruOrder.delete(key);
      }
    }

    for (const [key, series] of this.#histograms) {
      if (series.labels.operation_id === normalizedOperationId) {
        this.#histograms.delete(key);
        this.#lruOrder.delete(key);
      }
    }
  }
}

/**
 * Creates an in-memory metrics collector and Prometheus text exporter.
 */
export function createMetricsCollector(options?: ObservabilityOptions): RuntimeMetricsCollector {
  return new MetricsCollector(options);
}

function tryCreateGauge(
  meter: OpenTelemetryMeterLike,
  name: string,
  options: MetricOptionsLike,
): GaugeLike | undefined {
  if (typeof meter.createGauge !== "function") {
    return undefined;
  }
  try {
    const gauge = meter.createGauge(name, options);
    if (gauge !== null && typeof gauge === "object" && typeof gauge.record === "function") {
      return gauge;
    }
  } catch {
    // A meter may reject gauge creation; fall back to the delta UpDownCounter.
  }
  return undefined;
}

/**
 * Stores the latest value for a series and refreshes its LRU position.
 * When the map already holds `maxSeries` entries, the least recently used
 * series is evicted before the new entry is inserted.
 */
function rememberCurrentValue(
  lastValues: Map<string, number>,
  maxSeries: number,
  seriesKey: string,
  value: number,
): void {
  lastValues.delete(seriesKey);
  if (lastValues.size >= maxSeries) {
    const oldestKey = lastValues.keys().next().value;
    if (oldestKey !== undefined) {
      lastValues.delete(oldestKey);
    }
  }
  lastValues.set(seriesKey, value);
}

/**
 * Records a current-value instrument. Gauges receive the value directly.
 * UpDownCounters are additive, so the fallback keeps the last value per label
 * set and writes only the delta needed to converge on the current value.
 * A brand-new series records its initial value (including zero) once so the
 * series is registered; subsequent no-op deltas are skipped. At most
 * `maxSeries` per-instrument series are tracked; the least recently used entry
 * is evicted, and a later reading for it converges from zero again.
 */
function recordCurrentValue(
  gauge: GaugeLike | undefined,
  upDownCounter: UpDownCounterLike | undefined,
  lastValues: Map<string, number>,
  maxSeries: number,
  seriesKey: string,
  value: number,
  attributes: MetricAttributesLike | undefined,
): void {
  if (gauge !== undefined) {
    safeRecord(() => {
      gauge.record(value, attributes);
    });
    return;
  }
  if (upDownCounter === undefined) {
    return;
  }
  const previous = lastValues.get(seriesKey);
  if (previous === value) {
    // Refresh the LRU position without emitting a redundant zero delta.
    rememberCurrentValue(lastValues, maxSeries, seriesKey, value);
    return;
  }
  safeRecord(() => {
    upDownCounter.add(previous === undefined ? value : value - previous, attributes);
    rememberCurrentValue(lastValues, maxSeries, seriesKey, value);
  });
}

/**
 * Attaches a duck-typed OpenTelemetry Meter to an AdaptiveRuntime instance.
 *
 * Signal readings (`_signal_reading`) and budget engagement (`_budget_engaged`)
 * prefer synchronous gauges when the meter exposes `createGauge`. When gauges
 * are unavailable, or gauge creation throws, the adapter falls back to
 * UpDownCounters and tracks the last value per label set, writing only
 * `next - previous` deltas so the additive instrument converges to the current
 * reading. A brand-new series records its initial value once, including zero,
 * to register it; later no-op deltas are skipped. Non-ok signal and budget
 * readings increment status counters and never record zero gauges or
 * UpDownCounter values. The UpDownCounter fallback tracks at most `maxSeries`
 * label sets per instrument (default 1000) and evicts the least recently used
 * set, matching the in-memory collector's cardinality bound.
 */
export function attachOpenTelemetryMeter(
  runtime: AdaptiveRuntime,
  meter: OpenTelemetryMeterLike,
  options?: ObservabilityOptions,
): OpenTelemetryMeterSubscription {
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

  validateMaxSeries(options?.maxSeries);
  const prefix = options?.prefix ?? "adaptive_runtime";
  const defaultAttrs = options?.defaultAttributes;
  const maxSeries = options?.maxSeries ?? 1000;

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

  const signalReadingGauge = tryCreateGauge(meter, `${prefix}_signal_reading`, {
    description: "Current resource signal reading value.",
  });
  const signalReadingUpDownCounter =
    signalReadingGauge === undefined && typeof meter.createUpDownCounter === "function"
      ? meter.createUpDownCounter(`${prefix}_signal_reading`, {
          description: "Current resource signal reading value.",
        })
      : undefined;
  const signalReadingLastValues = new Map<string, number>();

  const budgetEngagedGauge = tryCreateGauge(meter, `${prefix}_budget_engaged`, {
    description: "Current budget engagement state (1 engaged, 0 healthy).",
  });
  const budgetEngagedUpDownCounter =
    budgetEngagedGauge === undefined && typeof meter.createUpDownCounter === "function"
      ? meter.createUpDownCounter(`${prefix}_budget_engaged`, {
          description: "Current budget engagement state (1 engaged, 0 healthy).",
        })
      : undefined;
  const budgetEngagedLastValues = new Map<string, number>();

  const unsubs: Array<() => void> = [
    runtime.on("run:start", ({ operationId, strategyId }) => {
      safeRecord(() => {
        strategySelectionsCounter.add(
          1,
          mergeMetricAttributes(defaultAttrs, {
            operation_id: operationId,
            strategy_id: strategyId,
          }),
        );
      });
    }),
    runtime.on("run:success", ({ metadata }) => {
      safeRecord(() => {
        runsCounter.add(
          1,
          mergeMetricAttributes(defaultAttrs, {
            operation_id: metadata.operationId,
            result: "success",
            strategy_id: metadata.strategyId,
          }),
        );
      });
      safeRecord(() => {
        qualityCounter.add(
          1,
          mergeMetricAttributes(defaultAttrs, {
            operation_id: metadata.operationId,
            status: metadata.quality.status,
            strategy_id: metadata.strategyId,
          }),
        );
      });
      safeRecord(() => {
        runDurationHistogram.record(
          metadata.durationMs / 1000,
          mergeMetricAttributes(defaultAttrs, {
            operation_id: metadata.operationId,
            strategy_id: metadata.strategyId,
          }),
        );
      });
    }),
    runtime.on("run:error", ({ operationId, strategyId, durationMs }) => {
      const effectiveStrategyId = strategyId ?? "none";
      safeRecord(() => {
        runsCounter.add(
          1,
          mergeMetricAttributes(defaultAttrs, {
            operation_id: operationId,
            result: "error",
            strategy_id: effectiveStrategyId,
          }),
        );
      });
      if (durationMs !== undefined) {
        safeRecord(() => {
          runDurationHistogram.record(
            durationMs / 1000,
            mergeMetricAttributes(defaultAttrs, {
              operation_id: operationId,
              strategy_id: effectiveStrategyId,
            }),
          );
        });
      }
    }),
    runtime.on("decision", ({ decision }) => {
      safeRecord(() => {
        decisionsCounter.add(
          1,
          mergeMetricAttributes(defaultAttrs, {
            changed: String(decision.changed),
            kind: decision.kind,
            operation_id: decision.operationId,
          }),
        );
      });
      for (const signal of decision.signals) {
        const value = signal.value;
        if (signal.status === "ok" && typeof value === "number" && Number.isFinite(value)) {
          recordCurrentValue(
            signalReadingGauge,
            signalReadingUpDownCounter,
            signalReadingLastValues,
            maxSeries,
            buildSeriesKey("signal_reading", {
              operation_id: decision.operationId,
              signal: signal.name,
            }),
            value,
            mergeMetricAttributes(defaultAttrs, {
              operation_id: decision.operationId,
              signal: signal.name,
              status: signal.status,
            }),
          );
        } else {
          safeRecord(() => {
            signalStatusCounter.add(
              1,
              mergeMetricAttributes(defaultAttrs, {
                operation_id: decision.operationId,
                signal: signal.name,
                status: signal.status,
              }),
            );
          });
        }
      }
      for (const budget of decision.budgets) {
        if (budget.status === "ok") {
          recordCurrentValue(
            budgetEngagedGauge,
            budgetEngagedUpDownCounter,
            budgetEngagedLastValues,
            maxSeries,
            buildSeriesKey("budget_engaged", {
              budget_id: budget.id,
              operation_id: decision.operationId,
            }),
            budget.engaged ? 1 : 0,
            mergeMetricAttributes(defaultAttrs, {
              budget_id: budget.id,
              operation_id: decision.operationId,
            }),
          );
        } else {
          safeRecord(() => {
            budgetStatusCounter.add(
              1,
              mergeMetricAttributes(defaultAttrs, {
                budget_id: budget.id,
                operation_id: decision.operationId,
                status: budget.status,
              }),
            );
          });
        }
      }
    }),
    runtime.on("provider:error", ({ providerId }) => {
      safeRecord(() => {
        providerErrorsCounter.add(
          1,
          mergeMetricAttributes(defaultAttrs, {
            provider_id: providerId,
          }),
        );
      });
    }),
    runtime.on("listener:error", ({ event }) => {
      safeRecord(() => {
        listenerErrorsCounter.add(
          1,
          mergeMetricAttributes(defaultAttrs, {
            event,
          }),
        );
      });
    }),
    runtime.on("runtime:closed", () => {
      safeRecord(() => {
        runtimeClosedCounter.add(1, defaultAttrs);
      });
    }),
  ];

  function purgeOperation(operationId: string): void {
    if (typeof operationId !== "string" || operationId.trim().length === 0) {
      throw new ConfigurationError("operationId must be a non-empty string.");
    }
    const normalized = operationId.trim();
    const targetSegment = `;12:operation_id=${normalized.length}:${normalized}`;

    for (const key of signalReadingLastValues.keys()) {
      if (key.includes(targetSegment)) {
        signalReadingLastValues.delete(key);
      }
    }

    for (const key of budgetEngagedLastValues.keys()) {
      if (key.includes(targetSegment)) {
        budgetEngagedLastValues.delete(key);
      }
    }
  }

  const unhookRemoval = registerOperationRemovalHook(runtime, purgeOperation);

  const subscription: OpenTelemetryMeterSubscription = Object.assign(
    () => {
      unhookRemoval();
      for (const unsub of unsubs) {
        unsub();
      }
      signalReadingLastValues.clear();
      budgetEngagedLastValues.clear();
    },
    {
      purgeOperation,
      removeOperation: purgeOperation,
    },
  );

  return subscription;
}
