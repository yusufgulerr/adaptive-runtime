# ADR 0017: Runtime introspection, bounded quality details, and composable policy selectors

- **Status:** Accepted
- **Date:** 2026-10-24
- **Deciders:** Project maintainers

## Context

In long-running multi-tenant systems and operational control planes, operators and
telemetry bridges need to inspect the set of active operations and their runtime
statistics in batch without disturbing LRU cache order or triggering side effects.

Additionally:
- Operators configuring per-operation policy overrides via `setOperationPolicy(operationId, policy)`
  had no read API to inspect the resolved policy or verify active constraints.
- While provider errors were safely bounded to 1,000 characters by `SignalCollector`,
  user strategies returning large `result.detail` strings in `checkQuality()` could inject
  arbitrarily large strings into `metadata.quality.detail` and `QualityCheckError.message`,
  creating telemetry and memory exhaustion risks.
- Resolved policy objects returned or shared across callers were vulnerable to external mutation.
- Common adaptive selection patterns, such as error-rate circuit guards and latency budget bounds,
  required repetitive custom selector implementations. Developers also lacked a structured,
  deterministic, single-line format for logging strategy decisions.

## Decision

### 1. Batch Introspection APIs

Add `getTrackedOperations()` and `getAllStats()` to `AdaptiveRuntime`:

- `getTrackedOperations(): readonly string[]`: Returns a frozen array of all currently
  tracked `operationId`s in LRU order (oldest to newest). Crucially, unlike single-operation
  accessors (`getDecision`/`getStats`), it does **not** alter or refresh LRU order. It
  remains readable after `close()`.
- `getAllStats(): Readonly<Record<string, RuntimeStats>>`: Returns a frozen dictionary
  mapping each tracked `operationId` to its current `RuntimeStats`. Does not alter LRU order
  and remains readable after `close()`.

### 2. Operation Policy Inspection and Immutability

Add `getOperationPolicy(operationId: string): ResolvedPolicy | null` to `AdaptiveRuntime`:

- Returns the frozen `ResolvedPolicy` override configured for the operation, or `null` if none
  exists.
- When an operation record exists, access refreshes LRU tracking identically to `getDecision`.
- Returns `null` after `setOperationPolicy(id, null)` or `removeOperation(id)`.
- `resolvePolicy` and `resolveOperationPolicy` now return `Object.freeze`-d policy objects
  and frozen `budgets` arrays, guaranteeing immutability across consumers.

### 3. Quality Check Detail Bounding

In `AdaptiveRuntimeImpl.#checkQuality`, normalize and bound `result.detail` strings using
`errorMessage(result.detail)`. If a strategy returns an oversized detail string (e.g., 50,000
characters), it is truncated to at most 1,000 characters followed by `…` (length <= 1,001),
preventing memory bloating and telemetry log flooding in both `report` and `error` modes.

### 4. Built-in Composable Policy Selectors

Provide zero-dependency, pure selector factories in `adaptive-runtime/policy` and `adaptive-runtime/core`:

- `createErrorRateGuardSelector(options: { maxErrorRate, fallbackSelector? })`:
  Filters candidates whose `errorRate` exceeds `maxErrorRate`. Picks the highest quality/lowest
  cost candidate or delegates to `fallbackSelector`. If all candidates exceed the threshold, it
  selects the candidate with the lowest observed error rate to mitigate total outage.
- `createLatencyBudgetSelector(options: { maxLatencyMs, preferLowestCost? })`:
  Selects candidates whose `estimatedLatencyMs` is within `maxLatencyMs` (or unmeasured `null`).
  Supports `preferLowestCost: true` to optimize for resource efficiency when latency goals are met.
  If all candidates exceed the budget, it selects the lowest latency candidate.

### 5. Deterministic Decision Summary Formatter

Provide `formatDecisionSummary(decision: StrategyDecision): string`:

Produces a deterministic, single-line structured audit string in the canonical format:
`[operationId] strategy="..." tier=X/Y kind=... changed=... budgets=... reasons=...`
Handling empty budgets and reasons with `none`.

## Consequences

- Multi-tenant control planes and observability scrapers can inspect all tracked operations and stats in a single call without LRU side effects.
- Immutability guarantees are strengthened across policy objects and batch queries.
- Memory and telemetry safety is strictly bounded against hostile or oversized strategy quality checks.
- Common latency and reliability patterns are provided out of the box with zero runtime dependencies.
