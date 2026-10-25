# ADR 0020: Utility selectors, cooperative drain, and provider circuit breakers

- **Status:** Accepted
- **Date:** 2026-10-25
- **Deciders:** Project maintainers

## Context

As `adaptive-runtime` prepares for 1.0-RC, production deployments in complex distributed architectures and latency-sensitive microservices highlighted several operational challenges:

1. **Multi-Objective Tradeoffs and Rate-of-Change Guards:**
   - Production operations often balance multiple competing constraints simultaneously (e.g. quality tier, financial cost, observed error rate, EWMA latency). Operators need a principled, multi-objective utility selector that computes weighted scores across normalized objective dimensions.
   - When external signals degrade rapidly (such as sudden network latency spikes or steep memory consumption growth), static threshold budgets may trigger too late. A slope/trend guard selector was required to detect rate-of-change degradation and proactively step down to resilient fallback strategies before hard SLO budgets are breached.

2. **Zero-Drop Graceful Shutdown and Drain (`waitForIdle`):**
   - In containerized environments (Kubernetes, AWS ECS, Cloudflare Workers), instances receive termination signals (SIGTERM) and need to drain all currently executing operations before tearing down providers and closing resources.
   - Calling `close()` while operations are mid-flight aborts active requests. Callers needed an explicit, cooperative drain mechanism (`waitForIdle`) with timeout semantics and error handling that awaits the resolution of all active runs.

3. **Circuit Breaker Cooldown and Provider Fault Isolation:**
   - When a signal provider experiences repeated failures, timeouts, or exceptions, querying it on every evaluation interval causes cascading latency and spammy log noise.
   - The signal collector required a per-provider circuit breaker with configurable consecutive failure thresholds, open cooldown durations, and half-open probing to isolate failing providers without interrupting healthy ones.
   - Operators also required runtime-level health diagnostics (`getRuntimeHealth`) to inspect provider circuit statuses and operational readiness.

4. **Telemetry Export and Cardinality Safety:**
   - In modern observability pipelines (Datadog, OpenTelemetry, Prometheus), structured JSON metrics export is essential for machine parsing and dashboard ingestion.
   - High-cardinality label explosion poses significant memory and billing hazards. The runtime needed strict cardinality safety controls, callbacks on cardinality breaches, and a simulation harness to validate metric label volume prior to deployment.

5. **State Hydration Parity and Offline Timeline Verification:**
   - Stateful migrations, rolling deployments, and blue/green traffic shifts require merging state snapshots from previous instances without overwriting newly initialized operations (`importState({ mode: 'merge' })`).
   - Testing teams required offline timeline comparison tooling (`comparePolicyTimelines`) to detect divergences between baseline and candidate policy runs across simulated scenarios.

---

## Decision

### 1. Multi-Objective Weighted Utility Selector (`createWeightedUtilitySelector`)

- Exported from `adaptive-runtime`, `adaptive-runtime/policy`, and `adaptive-runtime/core`.
- Accepts `WeightedUtilitySelectorOptions`:
  - `objectives`: Array of weighted scoring dimensions (`{ name, weight, value }`), where `value` maps a candidate and selector context to a numeric utility score.
  - Optional `fallbackSelector`: Fallback selector when no candidates qualify or all scores are non-positive.
- Computes aggregate weighted score: $\sum (\text{weight}_i \times \text{value}_i)$.
- Selects the candidate with the maximum positive weighted score, breaking ties deterministically by highest `qualityTier`, lowest `costTier`, and ascending candidate `id`.

### 2. Signal-Slope Trend Guard Selector (`createSignalTrendGuardSelector`)

- Exported from `adaptive-runtime`, `adaptive-runtime/policy`, and `adaptive-runtime/core`.
- Accepts `SignalTrendGuardSelectorOptions`:
  - `signalName`: Monitored signal name.
  - `slopeThreshold`: Maximum positive rate-of-change (units per second) tolerated before triggering degradation.
  - `degradeStrategyId`: Strategy ID to select when the slope threshold is exceeded.
  - `minSamples` & `windowMs`: Configurable observation window and sample count requirements.
  - Optional `fallbackSelector`: Secondary selector when slope is within safe bounds.
- Computes linear regression / slope over recent signal readings. When the rate of degradation exceeds `slopeThreshold`, returns `degradeStrategyId`, preventing catastrophic budget exhaustion.

### 3. Cooperative Graceful Drain (`waitForIdle`)

- Added to the `AdaptiveRuntime` contract.
- Accepts `WaitForIdleOptions` with optional `timeoutMs` and `abortSignal`.
- Tracks in-flight executions across all operations via ref-counted completion listeners.
- Resolves when `hasInFlight()` returns `false` across all registered operations.
- Rejects with `OperationTimeoutError` if operations do not complete within the specified timeout.

### 4. Per-Provider Circuit Breakers and Health Diagnostics (`getRuntimeHealth`)

- Configurable via `ProviderCircuitBreakerOptions` on `createAdaptiveRuntime`.
- Tracks consecutive failures, enters `open` state during cooldown windows, and transitions to `half-open` for single-attempt probes.
- `runtime.getRuntimeHealth()` returns a `RuntimeHealthSummary`:
  - `healthy`: Boolean reflecting whether all providers are operational and circuit breakers closed.
  - `providers`: Detailed array of `ProviderHealthStatus` records with state (`closed`, `open`, `half-open`), failure counts, consecutive error counters, and cooldown timestamps.

### 5. Structured Metrics Export & Cardinality Controls

- Added `toStructuredMetrics()` and `toMetricsJson()` to `MetricsCollector`.
- Structured schema versioning for automated ingestion.
- Added `onCardinalityLimitExceeded` callback and `simulateMetricsCardinality` harness in `adaptive-runtime/observability` and `adaptive-runtime/testing`.

### 6. Additive State Hydration & Offline Timeline Divergence Analysis

- Enhanced `runtime.importState(snapshot, { mode: "merge" | "replace" })`:
  - `"replace"` (default): Replaces entire operational state with snapshot data.
  - `"merge"`: Additively updates matching operations and preserves non-conflicting active runtime state.
- Added `comparePolicyTimelines(baseTimeline, candidateTimeline, options)` in `adaptive-runtime/testing` producing structured diffs of strategy decisions, tier divergences, and divergence intervals.

---

## Consequences

### Positive

- High-fidelity multi-objective optimization without external dependencies.
- Proactive degradation ahead of signal spikes, reducing cascading failure risks.
- Clean container teardown and zero-drop request draining with `waitForIdle`.
- Robust provider fault isolation with circuit breaker cooldowns.
- Automated validation of cardinality and policy divergences before production deployment.

### Neutral / Operational

- Slope calculation adds minimal floating-point arithmetic across bounded sample windows (sub-microsecond overhead).
- Circuit breaker state adds small per-provider tracking metadata.
- Merged state hydration validates schema and timestamps strictly to prevent clock skew regressions.
