# Observability guide

Adaptive Runtime does not ship a metrics client, exporter, background collector,
or network telemetry. It provides typed events, per-operation decisions, and
cumulative stats. Your application chooses the sink and the retention policy.

This guide suggests a small, low-cardinality metrics mapping. It is a starting
point, not a required schema.

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

Use stable names and bounded labels. The names below are suggestions, not
exported constants.

| Metric | Type | Labels | Source |
| --- | --- | --- | --- |
| `adaptive_runtime_runs_total` | counter | `operation_id`, `strategy_id`, `result` | `run:success`, `run:error` |
| `adaptive_runtime_run_duration_seconds` | histogram | `operation_id`, `strategy_id` | `metadata.durationMs` / `run:error.durationMs` |
| `adaptive_runtime_decisions_total` | counter | `operation_id`, `kind`, `changed` | `decision` |
| `adaptive_runtime_strategy_selections_total` | counter | `operation_id`, `strategy_id` | `run:start` |
| `adaptive_runtime_signal_reading` | gauge | `operation_id`, `signal`, `status` | `decision.signals` |
| `adaptive_runtime_budget_engaged` | gauge | `operation_id`, `budget_id` | `decision.budgets` |
| `adaptive_runtime_quality_total` | counter | `operation_id`, `strategy_id`, `status` | `metadata.quality` |
| `adaptive_runtime_provider_errors_total` | counter | `provider_id` | `provider:error` |
| `adaptive_runtime_listener_errors_total` | counter | `event` | `listener:error` |

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

- `operationId` must be a stable workload key, not raw user input. Bound the
  number of distinct ids; the runtime never evicts per-operation state.
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
