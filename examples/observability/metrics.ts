import {
  type Clock,
  createAdaptiveRuntime,
  type ResourceSignal,
  type SignalProvider,
  type SignalReadContext,
  type Strategy,
} from "../../src/index.js";

export const OBSERVABILITY_SUCCESS_OPERATION = "observability-success";
export const OBSERVABILITY_ERROR_OPERATION = "observability-error";
export const OBSERVABILITY_HEAP_SIGNAL = "process.memory.heapUsed";

const MEBIBYTE = 1024 * 1024;
const SCRIPTED_HEAP_BYTES = 128 * MEBIBYTE;
const DURATION_BUCKETS_SECONDS = [
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
] as const;

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

interface CounterSeries {
  readonly key: string;
  readonly name: string;
  readonly labels: MetricLabels;
  value: number;
}

interface GaugeSeries {
  readonly key: string;
  readonly name: string;
  readonly labels: MetricLabels;
  value: number;
}

interface HistogramSeries {
  readonly key: string;
  readonly name: string;
  readonly labels: MetricLabels;
  count: number;
  sum: number;
  min: number;
  max: number;
  readonly bucketCounts: number[];
}

function normalizeLabels(labels: MetricLabels): MetricLabels {
  const entries = Object.entries(labels).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return Object.freeze(Object.fromEntries(entries));
}

function seriesKey(name: string, labels: MetricLabels): string {
  const entries = Object.entries(labels).map(([key, value]) => `${key}=${value}`);
  return `${name}{${entries.join(",")}}`;
}

function compareSeries(left: { readonly key: string }, right: { readonly key: string }): number {
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

function formatLabels(labels: MetricLabels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) {
    return "{}";
  }
  return `{${entries.map(([key, value]) => `${key}="${value}"`).join(",")}}`;
}

/**
 * Example-only metrics sink. It keeps counters, gauges, and fixed-bucket
 * histograms in memory. It is not an exporter and has no retention policy.
 */
export class InMemoryMetricsSink {
  readonly #counters = new Map<string, CounterSeries>();
  readonly #gauges = new Map<string, GaugeSeries>();
  readonly #histograms = new Map<string, HistogramSeries>();

  increment(name: string, labels: MetricLabels = {}, amount = 1): void {
    if (!Number.isFinite(amount)) {
      throw new TypeError(`Counter "${name}" increment must be finite.`);
    }
    const normalized = normalizeLabels(labels);
    const key = seriesKey(name, normalized);
    const existing = this.#counters.get(key);
    if (existing === undefined) {
      this.#counters.set(key, { key, name, labels: normalized, value: amount });
      return;
    }
    existing.value += amount;
  }

  setGauge(name: string, value: number, labels: MetricLabels = {}): void {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Gauge "${name}" value must be finite.`);
    }
    const normalized = normalizeLabels(labels);
    const key = seriesKey(name, normalized);
    const existing = this.#gauges.get(key);
    if (existing === undefined) {
      this.#gauges.set(key, { key, name, labels: normalized, value });
      return;
    }
    existing.value = value;
  }

  observe(name: string, value: number, labels: MetricLabels = {}): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`Histogram "${name}" observation must be finite and non-negative.`);
    }
    const normalized = normalizeLabels(labels);
    const key = seriesKey(name, normalized);
    const existing = this.#histograms.get(key);
    if (existing === undefined) {
      this.#histograms.set(key, {
        key,
        name,
        labels: normalized,
        count: 1,
        sum: value,
        min: value,
        max: value,
        bucketCounts: DURATION_BUCKETS_SECONDS.map((bucket) => (value <= bucket ? 1 : 0)),
      });
      return;
    }
    existing.count += 1;
    existing.sum += value;
    existing.min = Math.min(existing.min, value);
    existing.max = Math.max(existing.max, value);
    for (const [index, bucket] of DURATION_BUCKETS_SECONDS.entries()) {
      if (value <= bucket) {
        existing.bucketCounts[index] = (existing.bucketCounts[index] ?? 0) + 1;
      }
    }
  }

  snapshot(): MetricsSnapshot {
    return {
      counters: [...this.#counters.values()].sort(compareSeries).map((series) => ({
        name: series.name,
        labels: series.labels,
        value: series.value,
      })),
      gauges: [...this.#gauges.values()].sort(compareSeries).map((series) => ({
        name: series.name,
        labels: series.labels,
        value: series.value,
      })),
      histograms: [...this.#histograms.values()].sort(compareSeries).map((series) => ({
        name: series.name,
        labels: series.labels,
        count: series.count,
        sum: series.sum,
        min: series.min,
        max: series.max,
        buckets: DURATION_BUCKETS_SECONDS.map((le, index) => ({
          le,
          count: series.bucketCounts[index] ?? 0,
        })),
      })),
    };
  }
}

class ScriptedObservabilityProvider implements SignalProvider {
  readonly id = "observability-scripted";
  readonly signals = [
    {
      name: OBSERVABILITY_HEAP_SIGNAL,
      unit: "bytes" as const,
      description: "Scripted heap reading used by the observability example.",
    },
  ];
  #reads = 0;

  read(context: SignalReadContext): readonly ResourceSignal[] {
    this.#reads += 1;
    if (this.#reads > 1) {
      throw new Error("simulated provider failure");
    }
    return [
      {
        name: OBSERVABILITY_HEAP_SIGNAL,
        unit: "bytes",
        status: "ok",
        value: SCRIPTED_HEAP_BYTES,
        observedAt: context.now,
        confidence: 1,
      },
    ];
  }
}

const SUCCESS_STRATEGIES: readonly Strategy<number, number>[] = [
  {
    id: "accurate",
    qualityTier: 2,
    costTier: 2,
    description: "Doubles the input and validates the arithmetic identity.",
    checkQuality: (value, context) => ({
      ok: value === context.input * 2,
      detail: "Checks the deterministic arithmetic identity.",
    }),
    run: ({ input }) => input * 2,
  },
  {
    id: "economy",
    qualityTier: 1,
    costTier: 1,
    description: "Adds the input to itself.",
    run: ({ input }) => input + input,
  },
];

const ERROR_STRATEGIES: readonly Strategy<number, number>[] = [
  {
    id: "unstable",
    qualityTier: 2,
    costTier: 2,
    description: "Always throws so the example can show the run:error path.",
    run: () => {
      throw new Error("simulated strategy failure");
    },
  },
];

export interface ObservabilityExampleOptions {
  readonly provider?: SignalProvider;
  readonly clock?: Clock;
  readonly logger?: (line: string) => void;
}

export interface ObservabilityExampleResult extends MetricsSnapshot {
  readonly logLines: readonly string[];
}

/**
 * Runs one healthy operation and one intentionally failing operation, mapping
 * runtime events into an in-memory metrics sink. It never coerces unavailable
 * signal readings to zero: an unavailable signal only increments a status
 * counter, while the value gauge is written only for status "ok".
 */
export async function runObservabilityExample(
  options: ObservabilityExampleOptions = {},
): Promise<ObservabilityExampleResult> {
  const logger = options.logger ?? (() => undefined);
  const provider = options.provider ?? new ScriptedObservabilityProvider();
  const sink = new InMemoryMetricsSink();
  const logLines: string[] = [];
  const log = (line: string): void => {
    logLines.push(line);
    logger(line);
  };

  const runtime = createAdaptiveRuntime({
    providers: [provider],
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    policy: {
      evaluationIntervalMs: 0,
      consecutiveSamples: 1,
      budgets: [
        {
          id: "heap-budget",
          signal: OBSERVABILITY_HEAP_SIGNAL,
          limit: 512 * MEBIBYTE,
          recoverBelow: 384 * MEBIBYTE,
        },
      ],
    },
  });

  runtime.on("decision", ({ decision }) => {
    sink.increment("adaptive_runtime_decisions_total", {
      operation_id: decision.operationId,
      kind: decision.kind,
      changed: String(decision.changed),
    });
    for (const signal of decision.signals) {
      if (signal.status === "ok" && signal.value !== undefined) {
        sink.setGauge("adaptive_runtime_signal_reading", signal.value, {
          operation_id: decision.operationId,
          signal: signal.name,
          status: signal.status,
        });
      } else {
        sink.increment("adaptive_runtime_signal_status_total", {
          operation_id: decision.operationId,
          signal: signal.name,
          status: signal.status,
        });
      }
    }
    for (const budget of decision.budgets) {
      if (budget.status === "ok") {
        sink.setGauge("adaptive_runtime_budget_engaged", budget.engaged ? 1 : 0, {
          operation_id: decision.operationId,
          budget_id: budget.id,
        });
      } else {
        sink.increment("adaptive_runtime_budget_status_total", {
          operation_id: decision.operationId,
          budget_id: budget.id,
          status: budget.status,
        });
      }
    }
    log(`decision ${decision.operationId}: ${decision.strategyId} (${decision.kind})`);
  });

  runtime.on("run:start", ({ operationId, strategyId }) => {
    sink.increment("adaptive_runtime_strategy_selections_total", {
      operation_id: operationId,
      strategy_id: strategyId,
    });
  });

  runtime.on("run:success", ({ metadata }) => {
    sink.increment("adaptive_runtime_runs_total", {
      operation_id: metadata.operationId,
      strategy_id: metadata.strategyId,
      result: "success",
    });
    sink.increment("adaptive_runtime_quality_total", {
      operation_id: metadata.operationId,
      strategy_id: metadata.strategyId,
      status: metadata.quality.status,
    });
    sink.observe("adaptive_runtime_run_duration_seconds", metadata.durationMs / 1000, {
      operation_id: metadata.operationId,
      strategy_id: metadata.strategyId,
    });
    log(
      `run success ${metadata.operationId}: strategy=${metadata.strategyId} quality=${metadata.quality.status}`,
    );
  });

  runtime.on("run:error", ({ operationId, strategyId, error, durationMs }) => {
    sink.increment("adaptive_runtime_runs_total", {
      operation_id: operationId,
      strategy_id: strategyId ?? "none",
      result: "error",
    });
    if (durationMs !== undefined) {
      sink.observe("adaptive_runtime_run_duration_seconds", durationMs / 1000, {
        operation_id: operationId,
        strategy_id: strategyId ?? "none",
      });
    }
    log(`run error ${operationId}: strategy=${strategyId ?? "none"} error=${error.message}`);
  });

  runtime.on("provider:error", ({ providerId, error }) => {
    sink.increment("adaptive_runtime_provider_errors_total", { provider_id: providerId });
    log(`provider error ${providerId}: ${error.message}`);
  });

  runtime.on("listener:error", ({ event, error }) => {
    sink.increment("adaptive_runtime_listener_errors_total", { event });
    log(`listener error on ${event}: ${error.message}`);
  });

  runtime.on("runtime:closed", () => {
    sink.increment("adaptive_runtime_runtime_closed_total");
    log("runtime closed");
  });

  try {
    await runtime.run({
      operationId: OBSERVABILITY_SUCCESS_OPERATION,
      input: 21,
      strategies: SUCCESS_STRATEGIES,
    });

    runtime.pinStrategy(OBSERVABILITY_ERROR_OPERATION, "unstable");
    let errorPathObserved = false;
    try {
      await runtime.run({
        operationId: OBSERVABILITY_ERROR_OPERATION,
        input: 1,
        strategies: ERROR_STRATEGIES,
      });
    } catch {
      errorPathObserved = true;
    }
    if (!errorPathObserved) {
      throw new Error("Expected the pinned observability strategy to fail.");
    }
  } finally {
    await runtime.close();
  }

  const snapshot = sink.snapshot();
  log("counters:");
  for (const counter of snapshot.counters) {
    log(`  ${counter.name}${formatLabels(counter.labels)} = ${counter.value}`);
  }
  log("gauges:");
  for (const gauge of snapshot.gauges) {
    log(`  ${gauge.name}${formatLabels(gauge.labels)} = ${gauge.value}`);
  }
  log("histograms:");
  for (const histogram of snapshot.histograms) {
    log(
      `  ${histogram.name}${formatLabels(histogram.labels)} count=${histogram.count} min=${histogram.min.toFixed(6)}s max=${histogram.max.toFixed(6)}s`,
    );
  }

  return { ...snapshot, logLines };
}
