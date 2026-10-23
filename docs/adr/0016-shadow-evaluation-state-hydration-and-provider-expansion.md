# ADR 0016: Shadow evaluation, state hydration, and provider expansion

- **Status:** Accepted
- **Date:** 2026-10-23
- **Deciders:** Project maintainers

## Context

Version 0.5.0 closes gaps that appear when the runtime is used as a long-lived
control plane rather than a per-request helper:

- Operators need to inspect what the policy would choose without executing a
  strategy, and without a dry-run changing later selections.
- Process restarts, deployments, and multi-instance rollouts need a portable way
  to preserve hysteresis, pins, decisions, and latency history.
- Per-operation policies already accept `evaluationIntervalMs`, but the collector
  only used the global interval.
- Latency averages hide recent regressions, and failure ratios were not exposed to
  custom selectors.
- OpenTelemetry UpDownCounters were updated additively, so they drifted away from
  the current reading, and signal labels were missing `operation_id`.
- Composite providers converted child failures into readings without a path to
  the runtime's `provider:error` event.
- Node.js and browser users lacked first-class event-loop utilization and compute
  pressure providers.
- Policy changes are difficult to review without a deterministic timeline view.

## Decision

### Shadow evaluation

Add `runtime.evaluate(operation, { dryRun? })`. Evaluation performs the same
signal collection, applicability checks, and pure policy evaluation as `run()`,
but never executes a strategy. With `dryRun: true`, it persists no policy state,
stores no decision, and emits no `decision` event. With `dryRun: false` (the
default), it persists state and the decision and emits `decision`, but does not
update run statistics. Evaluation is serialized with `run()` for the same
operation id, so it cannot interleave with an active selection.

### State hydration

Add `exportState(operationId?)` and `importState(snapshot)`.

- Snapshots are versioned JSON: `{ version: 1, exportedAt, operations[] }`.
- Each operation stores policy state, the last decision, the explicit pin, the
  adaptation override, and runtime statistics.
- Function-bearing configuration, including per-operation policy overrides and
  custom selectors, is deliberately excluded.
- `importState` validates and deep-clones the entire snapshot before mutating
  anything, rejects operations with an in-flight selection or run, and restores
  the imported operations under the existing LRU bound. Operations absent from
  the snapshot are left untouched.
- `durationSamples` is part of the persisted statistics so arithmetic averages
  and sample counts round-trip exactly.

### Recent-latency statistics

Add `ewmaDurationMs` (alpha `0.2`), `durationSamples`, and `errorRate` to
`RuntimeStats` and `StrategyStats`. `errorRate` is `failures / runs`, or `0` when
there are no runs. Candidate metadata passes the EWMA as `estimatedLatencyMs`
with the arithmetic mean as a fallback, and exposes `ewmaLatencyMs` and
`errorRate` to custom selectors.

### Per-operation evaluation interval

Resolve the effective operation policy before collecting signals and pass its
`evaluationIntervalMs` into `SignalCollector.collect()`. The collector's cache
window is therefore evaluated against the operation that is asking, while the
snapshot itself remains shared across operations.

### Telemetry parity

- Signal readings and budget engagement prefer an OpenTelemetry `Gauge` when the
  meter provides `createGauge`.
- Without gauges, bounded UpDownCounters receive deltas so the instrument
  converges to the current value instead of accumulating every decision.
- Signal attributes are `{ operation_id, signal, status }`; budget attributes are
  `{ budget_id, operation_id }`.
- `MetricsCollector.removeOperation()` trims surrounding whitespace, matching the
  runtime's operation-id normalization.

### Provider error bridge

`SignalProvider` gains optional `drainProviderErrors()`. Composite providers queue
child read failures (including failures from nested composites) and the collector
drains the queue after each fresh read, forwarding entries to `provider:error`.
Cached snapshots do not drain, so one failure is reported once.

### Provider and testing expansion

- `EventLoopDelayProvider` gains `minSamples` and retains the last valid reading
  for `resolutionMs * minSamples`, preventing an immediate post-reset read from
  flapping to `unknown`.
- `EventLoopUtilizationProvider` reports cumulative utilization on the first read
  and deltas on later reads.
- `ComputePressureProvider` maps W3C `nominal`/`fair`/`serious`/`critical` states to
  `0.25`/`0.5`/`0.75`/`1.0` and supports manual state recording.
- `adaptive-runtime/testing` gains `simulatePolicyTimeline`, a pure simulator that
  reports per-step decisions, state, budget transitions, switches, and reversals.

## Consequences

### Positive

- Dry runs are safe for dashboards, canaries, and policy review.
- Hysteresis and latency history survive restarts without serializing functions.
- Telemetry instruments represent current state rather than cumulative noise.
- Composite failures remain visible without failing the combined read.
- Policy changes can be regression-tested as deterministic timelines.

### Negative / Neutral

- State snapshots are intentionally not a full runtime backup; configuration is
  reconstructed by the application.
- The UpDownCounter fallback cannot retract the last value when a signal becomes
  unavailable; meters that support gauges should use them.
- `evaluate` shares the selection queue and provider cache with `run()`, so a dry
  run can still trigger a fresh provider read or reuse a cached one.

## Alternatives considered

- **Unversioned state blobs:** rejected because forward-compatible validation and
  clear failure modes are more important than a slightly smaller payload.
- **Serializing policy overrides:** rejected because overrides may contain
  functions and executable selectors.
- **Always persisting dry runs:** rejected because an inspection must not perturb
  the next decision.
- **Clearing UpDownCounters on unavailable signals:** rejected because writing
  zero would coerce an unavailable signal into a healthy-looking measurement.
- **Executing strategies inside the timeline simulator:** rejected because the
  simulator must stay pure, fast, and provider-independent.
