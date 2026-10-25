# ADR 0019: Concurrency benchmarks, resilient selector pipeline, and runtime state lifecycle

- **Status:** Accepted
- **Date:** 2026-10-25
- **Deciders:** Project maintainers

## Context

As `adaptive-runtime` reaches the 1.0.0-RC candidate milestone, production workloads in high-concurrency, multi-tenant cloud and edge environments surfaced six key operational and architectural requirements:

1. **Cost Tier Constraints in Composable Policy Pipelines (`createCostBudgetSelector`):**
   - In production workflows incorporating LLMs, multi-model AI routing, and distributed microservices, strategies exhibit disparate financial and compute cost tiers.
   - Operators using `composeSelectors` lacked a standardized, declarative selector to enforce hard upper bounds on `costTier` while delegating optimal within-budget candidate selection to secondary selectors (such as error rate guards or latency budget optimizers).

2. **Custom Selector Exception Boundaries and Crash Resilience (`createSafeSelector`):**
   - Custom policy selectors written by application developers or third-party plugins can throw unhandled exceptions or return invalid/undefined strategy IDs.
   - Unhandled exceptions inside custom selectors abort the entire selection phase with uncaught errors rather than falling back to safe deterministic defaults. A higher-order wrapper was needed to guarantee pipeline isolation and fault tolerance.

3. **Candidate Sample Size Visibility (`StrategyCandidate.samples`):**
   - While `StrategyCandidate` exposed historical metrics such as `estimatedLatencyMs`, `ewmaLatencyMs`, and `errorRate`, it lacked direct visibility into the statistical sample size (`samples` / `durationSamples`).
   - Custom selectors could not differentiate between a candidate with 2 recorded runs versus 20,000 runs, making confidence-weighted decisions or cold-start thresholds difficult without inspecting out-of-band stats.

4. **In-Flight Operation Introspection and Idle State Management (`hasInFlight`, `getActiveOperations`, `pruneIdleOperations`):**
   - In dynamic, multi-tenant systems where operations are provisioned on demand, operators need to verify whether an operation has active requests before evicting or reconfiguring it.
   - Calling `removeOperation()` while requests are executing could cause state corruption or loss of in-flight stats tracking.
   - Systems with high cardinality and transient operation IDs needed an automated, safe mechanism to garbage-collect idle operations that have completed their runs without risking the eviction of active operations.

5. **Reusable Telemetry Lifecycle Control (`MetricsCollector.resetMetrics`):**
   - In persistent testing harnesses, integration suites, and multi-stage lifecycle benchmarks, developers need to reset accumulated metrics counters between test runs or reporting windows without unhooking event listeners or recreating collector instances.

6. **Machine-Readable Concurrency Telemetry and Automated Regression Detection:**
   - Existing performance benchmarks provided machine-readable JSON output for serial micro-benchmarks (`runtime-overhead.ts`), but concurrency and heap observations (`concurrency.ts`) only supported human-readable tabular output.
   - Continuous integration and release automation require structured JSON schemas (`schemaVersion: 1`, `benchmark: "concurrency"`) and automated threshold regression checks across concurrency levels (`scripts/compare-benchmarks.mjs`).

---

## Decision

### 1. Cost Budget Selector (`createCostBudgetSelector`)

- Exported from `adaptive-runtime`, `adaptive-runtime/policy`, and `adaptive-runtime/core`.
- Accepts `CostBudgetSelectorOptions`:
  - `maxCostTier: number`: Non-negative finite integer defining the strict upper bound on acceptable strategy `costTier`.
  - `fallbackSelector?: CustomPolicySelector`: Optional secondary selector to evaluate qualifying candidates.
- Evaluates candidates: filters candidates with `candidate.costTier <= maxCostTier`.
- When multiple candidates qualify:
  - If `fallbackSelector` is provided, delegates selection among eligible candidates.
  - If no `fallbackSelector` is provided, selects the candidate with the highest `qualityTier`, breaking ties by lowest `costTier` and ascending code-unit `id`.
- If no candidates satisfy `costTier <= maxCostTier`, returns `undefined` to permit subsequent selectors in `composeSelectors` to evaluate or fallback to root policies.

### 2. Resilient Selector Isolation (`createSafeSelector`)

- Exported from `adaptive-runtime`, `adaptive-runtime/policy`, and `adaptive-runtime/core`.
- High-order combinator accepting:
  - `selector: CustomPolicySelector`: The primary (potentially untrusted) selector.
  - `fallbackSelector?: CustomPolicySelector`: Optional fallback selector invoked if the primary selector fails or returns an invalid candidate.
- Wraps execution in defensive `try/catch` boundaries:
  - Validates that the selected strategy ID belongs to an applicable candidate.
  - If the primary selector throws, logs diagnostic context and delegates to `fallbackSelector` or returns `undefined` (falling back to deterministic engine selection).
  - Guarantees that runtime selection never crashes due to a buggy custom selector.

### 3. First-Class `samples` on `StrategyCandidate`

- Added `readonly samples?: number` to `StrategyCandidate`.
- Populated directly from `strategyStats.durationSamples` during candidate construction.
- Reflects the exact number of measured execution samples for the candidate within the current operation.
- Enables custom selectors to implement confidence intervals, minimum sample thresholds, or Bayesian selection rules directly on candidate records.

### 4. In-Flight Introspection and Idle Operation Pruning

- Added three non-disturbing lifecycle methods to `AdaptiveRuntime`:
  - `hasInFlight(operationId: string): boolean`: Returns `true` if one or more executions for `operationId` are currently executing or awaiting selection; `false` otherwise. Does not modify LRU order.
  - `getActiveOperations(): readonly string[]`: Returns a defensive snapshot of all operation IDs currently in flight.
  - `pruneIdleOperations(maxAgeMs?: number): number`: Safely removes operation state for operations that:
    1. Are not pinned;
    2. Have no in-flight executions (`hasInFlight === false`);
    3. Have been idle for at least `maxAgeMs` milliseconds (or default expiration threshold).
    Returns the count of pruned operations, effectively preventing unbounded memory growth in dynamic tenant environments.

### 5. Metrics Collector Reset (`MetricsCollector.resetMetrics`)

- Added `resetMetrics(): void` to `MetricsCollector` in `adaptive-runtime/observability`.
- Atomically clears internal counters, histograms, and gauge series without detaching event listeners from the runtime.
- Enables deterministic reset between test cases and multi-tenant reporting intervals.

### 6. Concurrency Telemetry Schema and Automated Trend Comparison

- Extended `benchmarks/concurrency.ts`:
  - Added `--json` flag to emit a deterministic JSON document matching `schemaVersion: 1`, `benchmark: "concurrency"`.
  - Added optional `--iterations=N` flag for rapid execution in CI and integration testing.
  - Reports package identity, environment details (`nodeVersion`, `platform`, `arch`, `timestamp`), run configuration (`concurrencyLevels`, `operationsCount`, `iterationsPerLevel`), and per-level metrics:
    `concurrency`, `totalOperations`, `opsPerSec`, `scalingFactor`, `p50Us`, `p95Us`, `p99Us`, `heapDeltaBytes`.
- Extended `scripts/compare-benchmarks.mjs`:
  - Automatically identifies whether benchmark files are `runtime-overhead` or `concurrency`.
  - For concurrency benchmarks, matches concurrency levels and evaluates `opsPerSec` throughput regressions against `--max-regression-percent`.
  - Outputs human-readable tables or structured JSON comparison reports with exit code `1` when regression thresholds are breached.

---

## Consequences

- **Cost Protection:** Multi-model and multi-tier workflows can enforce strict financial boundaries without sacrificing deterministic selection.
- **Fault-Tolerant Selection:** Faulty or throwing custom selectors are isolated at runtime, preventing application outages.
- **Statistical Fidelity:** Custom selectors can reason about sample counts (`candidate.samples`) alongside EWMA latencies and error rates.
- **Safe Resource Cleanup:** Operators can safely inspect in-flight work and prune idle operations in long-running services without race conditions.
- **Performance Drift Guard:** Automated CI pipelines can compare concurrency JSON telemetry and alert on throughput or scaling regressions.
- **Zero Runtime Dependencies & Full Portability:** All additions remain strictly zero-dependency, ESM-only, and compatible across Node.js, browsers, and WinterCG edge runtimes.
