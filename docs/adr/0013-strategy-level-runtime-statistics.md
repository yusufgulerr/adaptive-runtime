# ADR 0013: Strategy-level runtime statistics and latency awareness

- **Status:** Accepted
- **Date:** 2026-10-23
- **Deciders:** Project maintainers

## Context

Prior to v0.4.0, `StatsRegistry` tracked cumulative execution metrics only at the aggregate operation level (`runs`, `successes`, `failures`, `lastDurationMs`, `averageDurationMs`) and recorded a single integer count of selections per strategy (`strategyRuns: Record<string, number>`). This presented several limitations:

- Applications and telemetry systems could not inspect the execution success rate, failure count, or duration distribution of individual strategies within an operation.
- In `CustomPolicySelectorContext`, candidates were exposed as `CustomSelectorCandidate`, but `estimatedLatencyMs` was permanently hardcoded to `null` because no latency tracking existed per strategy.
- `CustomSelectorCandidate` suffered from redundant nested and top-level fields (`candidate: { id, qualityTier, costTier, applicable }` alongside top-level `id?`, `qualityTier?`, `costTier?`, `applicable?`).

## Decision

- Define a typed `StrategyStats` interface:
  ```ts
  export interface StrategyStats {
    readonly runs: number;
    readonly successes: number;
    readonly failures: number;
    readonly lastDurationMs: number | null;
    readonly averageDurationMs: number | null;
  }
  ```
- Enrich `RuntimeStats` with a `strategies: Readonly<Record<string, StrategyStats>>` dictionary while preserving the legacy `strategyRuns: Record<string, number>` map for full backward compatibility.
- Update `StatsRegistry` to receive `strategyId: string | undefined` on both `success(operationId, strategyId, durationMs)` and `failure(operationId, strategyId, durationMs)`.
- When an operation succeeds or fails with a known strategy, update both the operation-level aggregates and the corresponding strategy-level stats.
- Simplify `CustomSelectorCandidate`:
  - Retain structural backward compatibility by preserving `candidate: PolicyCandidate` alongside top-level convenience properties (`id`, `qualityTier`, `costTier`, `applicable`).
  - Wire `estimatedLatencyMs` to the strategy's calculated `averageDurationMs` from `StatsRegistry` (or `null` if no recorded samples exist).
- Zero-cost determinism: Automatic policy selection continues to use pure, provider-independent quality tier and soft budget hysteresis. Strategy stats are exposed exclusively for observability and `customSelector` guidance without polluting deterministic automatic selection.

## Consequences

### Positive

- **Fine-grained observability:** Telemetry pipelines can monitor per-strategy degradation, error spikes, and latency drift.
- **Informed custom selectors:** `customSelector` functions can leverage genuine empirical latency estimates (`estimatedLatencyMs`) when choosing between equivalent-tier candidates.
- **Backward compatible:** Existing callers consuming `RuntimeStats.strategyRuns` continue to function without modification.

### Negative / Neutral

- Adds a secondary map update per `run()` completion inside `StatsRegistry`. Measured overhead is sub-microsecond and maintains zero runtime allocations on the critical selection path.
