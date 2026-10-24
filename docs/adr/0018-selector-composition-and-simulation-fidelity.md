# ADR 0018: Selector composition, runtime introspection, and simulation fidelity

- **Status:** Accepted
- **Date:** 2026-10-24
- **Deciders:** Project maintainers

## Context

As `adaptive-runtime` prepares for 1.0-RC, production deployments in high-throughput, multi-tenant environments revealed four key architectural challenges:

1. **Policy Selection Pipeline and Cold-Start Resilience:**
   - In production, newly registered or rarely triggered strategies lack historical statistics. When evaluated under an error-rate circuit guard (`createErrorRateGuardSelector`), a single early error could produce an observed error rate of `1.0` (100%), causing immediate disqualification before statistically significant samples accumulate.
   - Latency budget selectors (`createLatencyBudgetSelector`) lacked the ability to delegate within-budget candidate selection to secondary selectors (such as error rate guards or cost-tier optimizers) and only evaluated arithmetic latency averages rather than exponentially weighted moving averages (EWMA).
   - Operators combining multiple specialized selection rules (e.g., error rate circuit breaking -> latency budget bounds -> quality tier selection) lacked a standardized, deterministic pipeline combinator, requiring bespoke boilerplate.

2. **Runtime Introspection, Detail Bounds, and Stats Hydration Fidelity:**
   - Multi-tenant orchestrators need to introspect an operation's effective policy (`getEffectivePolicy`) and registered provider signals (`getProviderDescriptors`) without altering LRU eviction queues or creating phantom operation entries.
   - Quality check functions could return unbounded error or diagnostic detail strings, introducing memory bloat and log pollution risks unless bounded by a configurable limit (`maxQualityCheckDetailLength`).
   - Exporting and importing state (`exportState`/`importState`) recomputed total run duration from `averageDurationMs * durationSamples`, introducing IEEE 754 floating-point drift across repeated hydration cycles.

3. **Signal Collector Shared-Read Semantics:**
   - Under concurrent load, callers joining an in-flight live signal read were marked with `cached: true` upon read resolution. This caused the policy engine to misclassify live readings as historical interval cache hits (`cached-sample`), withholding state counter advancement.
   - High-concurrency cancellation storms (e.g. 100 simultaneous client aborts) required verified ref-count cancellation resilience without unhandled promise rejections.

4. **Observability Lifecycle Synchronization and Simulation Fidelity:**
   - The deterministic policy timeline simulator (`simulatePolicyTimeline`) in `adaptive-runtime/testing` did not support candidate latency or error-rate parameters on `SimulatedStrategy`, making it impossible to simulate custom selectors relying on `estimatedLatencyMs`, `ewmaLatencyMs`, or `errorRate`.
   - In high-churn multi-tenant environments, removing operations via `runtime.removeOperation(operationId)` did not purge series tracked in OpenTelemetry UpDownCounter delta maps, causing state retention and baseline drift if an operation was later re-registered.

## Decision

### 1. Composable Policy Selectors and Cold-Start Guards

- **`composeSelectors(selectors)` combinator:**
  - Exported from `adaptive-runtime`, `adaptive-runtime/policy`, and `adaptive-runtime/core`.
  - Strictly validates that `selectors` is a non-empty array of functions.
  - Takes a defensive snapshot `[...selectors]` to ensure runtime immutability.
  - Evaluates sequentially: returns the first non-null/non-undefined decision produced by a selector. If all selectors return `null`/`undefined`, it returns `null` to allow default engine tie-breaking.
- **`minSamples` cold-start guard in `createErrorRateGuardSelector`:**
  - Added `minSamples?: number` option (default: `1`, validated safe positive integer).
  - Disqualification is suppressed for candidates whose sample count is strictly less than `minSamples`, even if `errorRate > maxErrorRate`.
  - Structured audit reasons explicitly distinguish cold-start rescues:
    `error-rate-guard: selected cold-start strategy "<id>" with errorRate <rate> (samples < minSamples <min>)`.
- **`fallbackSelector` and `useEwma` in `createLatencyBudgetSelector`:**
  - Added `fallbackSelector?: CustomPolicySelector` to delegate selection among candidates satisfying latency budgets.
  - Added `useEwma?: boolean` (default: `false`): when `true`, filters and ranks candidates using `ewmaLatencyMs` rather than arithmetic `estimatedLatencyMs`.

### 2. Runtime Introspection, Detail Bounds, and Exact Stats Hydration

- **Non-disturbing introspection APIs:**
  - `runtime.getEffectivePolicy(operationId: string): ResolvedPolicy`: Resolves and returns the effective policy (operation override or root default) without invoking internal operation tracking or mutating LRU state.
  - `runtime.getProviderDescriptors(): readonly SignalDescriptor[]`: Returns deeply frozen provider descriptors declared across registered providers.
- **Configurable quality check detail bounding:**
  - Added `maxQualityCheckDetailLength?: number` (default: `1,000`, validated safe positive integer) to `CreateRuntimeOptions`.
  - Enforced in `AdaptiveRuntimeImpl.#checkQuality` across thrown errors, failing details, and passing details via defensive truncation with ellipsis.
- **Exact `totalDurationMs` persistence:**
  - Added `totalDurationMs?: number` to `StrategyStats` and `RuntimeStats`.
  - Preserves exact millisecond duration sums in `StatsRegistry` and serialized state snapshots, falling back to `averageDurationMs * durationSamples` when importing legacy snapshots.
  - Eliminates IEEE 754 floating-point drift across arbitrary export/import cycles.

### 3. Signal Collector Shared-Read Semantics

- **Distinct `coalesced` snapshot flag:**
  - Added `readonly coalesced: boolean` to `SignalSnapshot`.
  - Callers initiating a live read receive `cached: false, coalesced: false`.
  - Callers joining an in-flight live read receive `cached: false, coalesced: true`.
  - Callers reusing a historical interval snapshot receive `cached: true, coalesced: false`.
- **Diagnostic descriptors:**
  - Pre-freezes and exposes `collector.getDescriptors(): readonly SignalDescriptor[]` on `SignalCollector`.

### 4. Observability Lifecycle Sync and Simulation Fidelity

- **Simulation parameters on `SimulatedStrategy`:**
  - Added optional `estimatedLatencyMs?: number | null`, `ewmaLatencyMs?: number | null`, and `errorRate?: number | null` to `SimulatedStrategy`.
  - Strictly validated in `normalizeSimulatedStrategies` (finite non-negative numbers for latencies, `[0, 1]` for error rates).
  - Propagated to `StrategyCandidate` objects in `simulatePolicyTimeline`.
- **OpenTelemetry operation lifecycle hooks:**
  - Utilizes `Symbol.for("adaptive-runtime.observability.removeOperationHooks")` to listen for operation removals without polluting the public interface.
  - `attachOpenTelemetryMeter` registers `purgeOperation(operationId)` to delete tracking keys matching removed operations from UpDownCounter delta maps.
  - `MetricsCollector.attach` automatically purges in-memory operation series when operations are removed.

## Consequences

- **Mathematical exactness:** State serialization and restoration maintains bit-exact total duration sums without IEEE 754 drift.
- **High-fidelity simulation:** Policy timeline simulations can accurately reproduce complex custom selector behaviors relying on candidate latency and error-rate measurements.
- **Accurate signal telemetry:** Concurrent requests joining in-flight reads are correctly classified as live coalesced evaluations rather than historical cache hits.
- **Memory and cardinality protection:** Configurable quality check truncation and automatic OpenTelemetry series purging eliminate memory growth risks in multi-tenant environments.
- **Zero runtime dependencies & portable core:** All additions remain strictly zero-dependency, ESM-only, and portable across Node.js, browsers, and WinterCG edge environments.
