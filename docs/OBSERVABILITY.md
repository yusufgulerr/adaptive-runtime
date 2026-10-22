# Observability guide

Adaptive Runtime ships a zero-dependency, platform-neutral observability bridge
in `adaptive-runtime/observability`. It includes an in-memory metrics collector
with Prometheus text exposition and a structural OpenTelemetry meter adapter. It
does not start a background exporter, network client, or telemetry agent, and it
never sends data anywhere by itself. Your application chooses the sink and the
retention policy.

The runtime also exposes typed events, per-operation decisions, and cumulative
stats for custom pipelines. This guide describes both surfaces.

## Built-in collector

```ts
import { createAdaptiveRuntime } from "adaptive-runtime/core";
import { createMetricsCollector } from "adaptive-runtime/observability";

const runtime = createAdaptiveRuntime({ providers, policy });
const collector = createMetricsCollector({
  prefix: "adaptive_runtime",              // default
  defaultAttributes: { service: "search" },
  buckets: [0.001, 0.01, 0.1, 1],          // seconds
  maxSeries: 1000,                         // default series cardinality limit
});
const detach = collector.attach(runtime);

await runtime.run(operation);

const snapshot = collector.getSnapshot();
const prometheus = collector.toPrometheusText();
console.log(prometheus);
detach();
```

`MetricsCollector` is the exported class behind `createMetricsCollector`; use
whichever form reads more clearly in your application. `attach()` returns a
detach function and subscribes to `decision`, `run:start`,
`run:success`, `run:error`, `provider:error`, `listener:error`, and
`runtime:closed`. `reset()` clears the in-memory registry and LRU tracking.
Snapshot counters cover runs, decisions, strategy selections, signal statuses,
budget statuses, quality checks, provider errors, listener errors, and runtime
closes. Gauges cover `ok` signal readings and budget engagement. Histograms
cover run duration in seconds.

The collector derives a family's type from the recording method, not from the
metric name: `increment` creates a counter, `setGauge` a gauge, and `observe` a
histogram. Reusing a name with a different instrument kind throws `TypeError`
before state changes. Series keys encode label keys and values unambiguously, so
commas, equals signs, or quotes in label text cannot merge distinct series.
`reset()` clears the series, LRU tracking, and family registrations.

### Series Cardinality & Eviction (`maxSeries`)

The collector bounds series cardinality across all metric families (counters,
gauges, histograms) using an LRU tracking structure. When the total number of
series reaches `maxSeries` (default: `1000`) and a new series is created, the
least-recently used series is evicted before inserting the new one. Updating
or observing an existing series refreshes its LRU position. Configuring
`maxSeries` with a non-positive integer throws `ConfigurationError`.

To proactively free series for completed or retired operations, call
`collector.removeOperation(operationId)`. This purges all counter, gauge, and
histogram series with `operation_id === operationId` and removes them from LRU
tracking. Throws `ConfigurationError` if `operationId` is empty or has leading
or trailing whitespace.

| Metric | Type | Labels |
| --- | --- | --- |
| `<prefix>_runs_total` | counter | `operation_id`, `strategy_id`, `result` |
| `<prefix>_run_duration_seconds` | histogram | `operation_id`, `strategy_id` |
| `<prefix>_decisions_total` | counter | `operation_id`, `kind`, `changed` |
| `<prefix>_strategy_selections_total` | counter | `operation_id`, `strategy_id` |
| `<prefix>_signal_reading` | gauge | `operation_id`, `signal`, `status` |
| `<prefix>_signal_status_total` | counter | `operation_id`, `signal`, `status` |
| `<prefix>_budget_engaged` | gauge | `operation_id`, `budget_id` |
| `<prefix>_budget_status_total` | counter | `operation_id`, `budget_id`, `status` |
| `<prefix>_quality_total` | counter | `operation_id`, `strategy_id`, `status` |
| `<prefix>_provider_errors_total` | counter | `provider_id` |
| `<prefix>_listener_errors_total` | counter | `event` |
| `<prefix>_runtime_closed_total` | counter | — |

Critical rule: when a signal status is not `ok`, the collector increments
`<prefix>_signal_status_total{status="unknown|stale|unsupported|error|missing"}`
and **does not write the gauge**. It never exports unavailable data as `0`.
Prometheus label values escape backslashes, double quotes, and newlines.

## OpenTelemetry bridge

`attachOpenTelemetryMeter` accepts any object that structurally matches the
OpenTelemetry `Meter` interface. No `@opentelemetry/api` dependency is required
at build time or runtime.

```ts
import { attachOpenTelemetryMeter } from "adaptive-runtime/observability";

const detachMeter = attachOpenTelemetryMeter(runtime, meter, {
  prefix: "adaptive_runtime",
  defaultAttributes: { service: "search" },
});
```

The adapter creates counters, a duration histogram, and (when `meter.createUpDownCounter`
is available) UpDownCounters for signal readings (`<prefix>_signal_reading`) and budget
engagement (`<prefix>_budget_engaged`).

On `decision` events:
- For signal readings with `reading.status === "ok"`, records `reading.value` to
  `<prefix>_signal_reading` with attributes `{ signal: reading.name, unit: reading.unit }`.
  Non-ok readings are strictly recorded to `<prefix>_signal_status_total` and are never
  coerced to `0` or emitted to the UpDownCounter.
- For budget evaluations with `budget.status === "ok"`, records `budget.engaged ? 1 : 0` to
  `<prefix>_budget_engaged` with attributes `{ budget: budget.name }`. Non-ok budgets
  record to `<prefix>_budget_status_total`.

### Per-Instrument Error Isolation

Every individual metric instrument call inside the OpenTelemetry event listeners is
isolated with safe error handling (`safeRecord`). If an individual instrument throws
an error (e.g., meter transport error, invalid metric attribute formatting), the error
is caught safely without bubbling, preventing listener failures and ensuring that
remaining telemetry instruments continue recording without dropping data or failing
runs. Call the returned detach function before discarding the runtime.

## Surfaces

| Surface | What it provides | Lifetime |
| --- | --- | --- |
| `run:start` | Operation, selected strategy, decision | Per run |
| `run:success` | Full `RunMetadata`, including duration and quality | Per run |
| `run:error` | Error, operation, optional strategy/decision/duration | Per failed run |
| `decision` | `StrategyDecision` for every selection | Per selection |
| `provider:error` | Provider id and contained failure | Per provider failure |
| `listener:error` | Failing event name and listener error | Per listener failure |
| `getDecision(id)` | Most recent decision | Until process exit |
| `getStats(id)` | Cumulative counters and latency | Until process exit |

Events are synchronous, best-effort, and in-process. A listener exception is
caught and emitted as `listener:error`; it does not fail the operation. Keep
listeners cheap because they run on the hot path.

`getStats()` is not a durable store. It resets when the runtime is recreated and
is not shared across processes.

## Recommended metrics

Use stable names and bounded labels. These are the names emitted by the built-in
collector with the default `adaptive_runtime` prefix; a custom pipeline should
copy the same mapping.

| Metric | Type | Labels | Source |
| --- | --- | --- | --- |
| `adaptive_runtime_runs_total` | counter | `operation_id`, `strategy_id`, `result` | `run:success`, `run:error` |
| `adaptive_runtime_run_duration_seconds` | histogram | `operation_id`, `strategy_id` | `metadata.durationMs` / `run:error.durationMs` |
| `adaptive_runtime_decisions_total` | counter | `operation_id`, `kind`, `changed` | `decision` |
| `adaptive_runtime_strategy_selections_total` | counter | `operation_id`, `strategy_id` | `run:start` |
| `adaptive_runtime_signal_reading` | gauge | `operation_id`, `signal`, `status` | `decision.signals` |
| `adaptive_runtime_signal_status_total` | counter | `operation_id`, `signal`, `status` | `decision.signals` |
| `adaptive_runtime_budget_engaged` | gauge | `operation_id`, `budget_id` | `decision.budgets` |
| `adaptive_runtime_budget_status_total` | counter | `operation_id`, `budget_id`, `status` | `decision.budgets` |
| `adaptive_runtime_quality_total` | counter | `operation_id`, `strategy_id`, `status` | `metadata.quality` |
| `adaptive_runtime_provider_errors_total` | counter | `provider_id` | `provider:error` |
| `adaptive_runtime_listener_errors_total` | counter | `event` | `listener:error` |
| `adaptive_runtime_runtime_closed_total` | counter | — | `runtime:closed` |

For `adaptive_runtime_signal_reading`, emit `value` only when
`status === "ok"`. For unavailable statuses, either omit the sample or record a
separate status counter; never record unavailable as `0`, because that would
recreate the zero-coercion bug the runtime avoids.

Suggested status counters:

```text
adaptive_runtime_signal_status_total{operation_id,signal,status}
```

## Example mapping

The following is integration pseudocode. Replace `metrics` with your client.

```ts
runtime.on("decision", ({ decision }) => {
  metrics.increment("adaptive_runtime_decisions_total", {
    operation_id: decision.operationId,
    kind: decision.kind,
    changed: String(decision.changed),
  });

  for (const signal of decision.signals) {
    if (signal.status === "ok") {
      metrics.gauge("adaptive_runtime_signal_reading", signal.value, {
        operation_id: decision.operationId,
        signal: signal.name,
        status: signal.status,
      });
    } else {
      metrics.increment("adaptive_runtime_signal_status_total", {
        operation_id: decision.operationId,
        signal: signal.name,
        status: signal.status,
      });
    }
  }

  for (const budget of decision.budgets) {
    metrics.gauge("adaptive_runtime_budget_engaged", budget.engaged ? 1 : 0, {
      operation_id: decision.operationId,
      budget_id: budget.id,
    });
  }
});

runtime.on("run:success", ({ metadata }) => {
  metrics.increment("adaptive_runtime_runs_total", {
    operation_id: metadata.operationId,
    strategy_id: metadata.strategyId,
    result: "success",
  });
  metrics.observe("adaptive_runtime_run_duration_seconds", metadata.durationMs / 1000, {
    operation_id: metadata.operationId,
    strategy_id: metadata.strategyId,
  });
});

runtime.on("run:error", ({ operationId, strategyId, durationMs }) => {
  metrics.increment("adaptive_runtime_runs_total", {
    operation_id: operationId,
    strategy_id: strategyId ?? "none",
    result: "error",
  });
  if (durationMs !== undefined) {
    metrics.observe("adaptive_runtime_run_duration_seconds", durationMs / 1000, {
      operation_id: operationId,
      strategy_id: strategyId ?? "none",
    });
  }
});
```

## Label cardinality

- `operationId` must be a stable workload key, not raw user input. Although the
  runtime evicts unpinned operations beyond `maxTrackedOperations` and the
  metrics collector bounds series cardinality via `maxSeries` (default: 1000,
  with LRU eviction and `removeOperation(operationId)`), bounding distinct ids
  protects downstream metric stores from unbounded label cardinality.
- `strategyId` and `budget.id` come from application declarations and are usually
  bounded.
- `signal.name` is provider-declared and bounded by the runtime configuration.
- Do **not** label metrics with error messages, signal `details`, quality
  `detail`, or arbitrary input.
- Prefer reason **codes** (`decision.reasons[].code`) over free-form reasons.

## What to alert on

Useful starting points, once the metrics exist:

- Provider error rate or a sustained `unsupported`/`error` signal status.
- Missing-signal rate and `missingSignalBehavior: "fallback"` frequency.
- Decision flapping: a high rate of `changed: "true"` over a sliding window.
- Quality-check failure rate.
- Run duration or failure rate by strategy.
- Listener error rate, which indicates broken telemetry rather than broken work.

Thresholds depend on the workload. Do not alert on a single decision; the policy
is designed to tolerate isolated noisy samples.

## Privacy and retention

- Events may contain operation ids, signal names, values, decision reasons, and
  error messages.
- The runtime does not serialize operation inputs, but application-supplied
  `details`, `error`, and quality `detail` can contain anything.
- Redact before export. Avoid logging secrets, tokens, full URLs, or raw user data.
- Decide retention and sampling in the observability pipeline, not inside the
  runtime.

## Related documents

- [API reference](API.md)
- [API design notes](API_DESIGN.md)
- [Architecture](ARCHITECTURE.md)
- [Runnable observability example](../examples/observability/index.ts)
- [Threat model](THREAT_MODEL.md)
