# ADR 0021: Production control plane — admission, rollout, traces, SLOs, and signal windows

- **Status:** Accepted
- **Date:** 2026-10-26
- **Deciders:** Project maintainers

## Context

The runtime already provides deterministic policy selection, bounded operation state,
cooperative cancellation, and observability bridges. Production adopters still had to
build five surrounding controls themselves:

1. **Downstream concurrency protection.** A strategy may call a database, model server,
   or third-party API. Operators need a deterministic limiter that shrinks concurrency
   under failures and latency pressure, queues a bounded number of callers, and sheds
   excess work explicitly instead of overloading the downstream dependency.
2. **Safe policy rollout.** Shipping a candidate policy to every instance at once is
   risky. Operators need a percentage rollout where a given operation id lands in the
   same cohort on every replica without shared state, coordination, or network calls.
3. **Decision forensics.** A regression report needs the exact policy inputs, traced
   decisions, and the resulting state so a maintainer can replay the decision offline
   against a changed policy and see which fields diverged.
4. **SLO visibility.** Availability, error rate, and latency objectives need bounded
   rolling windows and explicit `met` / `at-risk` / `breached` / `insufficient-data`
   statuses, attachable to existing runtime events without modifying the runtime.
5. **Signal analytics.** Applications need portable rolling statistics (quantiles,
   regression slope, freshness) for one signal stream while preserving explicit
   unavailable statuses and never treating missing data as zero.

All five capabilities must remain additive on the 0.x line, portable where the
surrounding module is portable, zero-dependency, and deterministic under an injected
clock.

## Decision

### 1. Adaptive concurrency limiter (`src/runtime/admission.ts`)

- Export `createAdaptiveLimiter`, `AdaptiveLimiter`, `AdaptiveLimiterOptions`,
  `AdaptiveLimiterPermit`, `AdaptiveLimiterSnapshot`, `AcquirePermitOptions`,
  `LimiterOutcome`, `LimiterLimitChangeEvent`, and `AdmissionRejectedError`.
- The limiter runs an AIMD controller: successes build a streak and increase the limit
  by `increaseStep` after `increaseEvery` successful outcomes; failures and
  target-latency pressure decrease it multiplicatively by `decreaseFactor`, clamped to
  `minLimit`.
- Latency feedback uses an EWMA with `latencyAlpha`; pressure exists when the EWMA
  exceeds `targetLatencyMs * latencyThresholdRatio`.
- Waiters are strictly FIFO and bounded by `maxQueueSize`. Queue-full, acquire-timeout,
  and closed rejections throw `AdmissionRejectedError` with `code:
  "ADMISSION_REJECTED"` and an explicit `reason`. Abort before or during queueing throws
  `OperationAbortedError` and cleans up its timer and listener.
- `tryAcquire` never waits. `withPermit` measures one task with the injected clock and
  releases with success/failure plus latency before rethrowing a task error.
- `close()` is idempotent, rejects queued waiters, and leaves in-flight permits
  releasable. Permits, snapshots, and limit-change events are frozen.

### 2. Deterministic percentage rollout (`src/policy/rollout.ts`)

- Export `createPolicyRollout`, `computeRolloutBucket`, `PolicyRollout`,
  `PolicyRolloutOptions`, `PolicyRolloutAssignment`, `PolicyRolloutSnapshot`, and
  `PolicyCohort`.
- The bucket is FNV-1a 32-bit over the UTF-16 code units of
  `` `${salt}\u0000${operationId}` ``, reduced modulo 10,000. The candidate cohort is
  selected when `bucket < Math.round(percentage * 100)`.
- `percentage` is validated in `0..100`; `0` is always baseline and `100` is always
  candidate. The module keeps no per-operation state, and assignments and snapshots are
  frozen. Policy references are preserved, not cloned.

### 3. Policy trace capture, replay, and diff (`src/testing/trace.ts`)

- Export `createPolicyTraceRecorder`, `capturePolicyTrace`, `replayPolicyTrace`,
  `diffPolicyTraces`, `summarizePolicyTrace`, `importPolicyTrace`, and the associated
  trace/report types under `adaptive-runtime/testing`.
- The recorder deep-copies and freezes entries, bounds retention with `maxEntries`, and
  keeps entry sequence numbers monotonic after eviction. Exported traces are JSON-safe.
- `capturePolicyTrace` evaluates supplied timeline steps sequentially through
  `evaluatePolicy` and records the complete input, decision, and resulting state.
- `replayPolicyTrace` re-evaluates each entry independently, reports changed decision
  fields and state divergence, and sets `deterministic` only when every entry matches.
- `diffPolicyTraces` compares traces by index; missing entries are divergences.
  `summarizePolicyTrace` reports switches, reversals, cached samples, and engaged budget
  ids. `importPolicyTrace` structurally validates untrusted JSON and returns a deeply
  frozen copy.

### 4. SLO and error-budget monitor (`src/observability/slo.ts`)

- Export `createSloMonitor`, `attachSloMonitor`, `SloMonitor`, `SloObjective`,
  `SloObservation`, snapshots, and status types.
- Objectives support `availability` (successes / samples, met when `>= target`),
  `error-rate` (failures / samples, met when `<= target`), and `latency` (mean duration,
  met when `<= target`). `warningMargin` defines the at-risk band, `minSamples` controls
  `insufficient-data`, and `operationId` filters observations.
- One ring buffer is sized to the largest objective window. Snapshots are frozen and
  follow configuration order; `reset()` clears observations but keeps configuration.
- `attachSloMonitor` subscribes to `run:success` and `run:error`, records both, and
  returns an idempotent unsubscribe function. It does not alter runtime behavior.

### 5. Bounded signal window analytics (`src/signals/window.ts`)

- Export `createSignalWindow`, `SignalWindow`, `SignalWindowOptions`,
  `SignalWindowSummary`, and `SignalTrend`.
- The window retains the newest `capacity` readings, including unavailable readings.
  Value statistics (min, max, mean, population standard deviation, interpolated
  quantiles) include only `ok` values; unavailable counts stay explicit and are never
  coerced to zero.
- The slope is ordinary least squares over `ok` values against `observedAt`; fewer than
  two distinct timestamps yields `slopePerMs: null` and `insufficient-data`. `trend`
  compares the absolute slope with `trendThresholdPerMs`.
- `summary(now?)` reports `ageMs` and `stale`; omitting `now` reports `ageMs: 0` and
  `stale: false`. Summaries are frozen.

## Consequences

### Positive

- Operators can protect downstream dependencies and shed load with a deterministic,
  inspectable limiter instead of an ad-hoc semaphore.
- Percentage rollout is reproducible across replicas and processes without shared
  storage.
- Policy regressions can be captured, replayed, diffed, and summarized from JSON traces.
- SLO status is available from existing runtime events without modifying the runtime or
  adding dependencies.
- Signal analytics preserve the project's no-zero-coercion and determinism invariants.

### Neutral / operational

- The limiter, SLO monitor, and signal window retain bounded state; callers choose the
  bounds. Trace recording is opt-in and bounded by `maxEntries`.
- `AdmissionRejectedError` adds a thirteenth machine-readable error code. It extends
  `AdaptiveRuntimeError` but is defined in the admission module rather than the frozen
  shared error barrel.
- Rollout stability depends on keeping the salt and operation id stable. Changing either
  deliberately reshuffles cohorts.
- Trace replay re-evaluates the recorded entry state; it does not re-read providers or
  execute strategies.

### Alternatives considered

- **Token-bucket or fixed semaphore for admission.** Rejected because it does not react
  to failure or latency pressure and gives operators no adaptive control loop.
- **Random or clock-based rollout.** Rejected because replicas would disagree and the
  same operation could flap between cohorts across processes.
- **Record raw runtime events only.** Rejected because events do not contain the full
  policy input and resulting state required for deterministic replay.
- **Unbounded SLO and signal history.** Rejected because it violates the project's
  bounded-state invariant and creates a memory-growth hazard.
- **Percentile estimation with a probabilistic sketch.** Rejected for 0.10.0 because a
  bounded sorted copy is deterministic, dependency-free, and adequate for the documented
  window sizes.
