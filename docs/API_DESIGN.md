# API design notes

This document explains why the public API looks the way it does. The exact
signatures and field-level rules are in [API.md](API.md). This is a design note,
not a second reference.

Status: pre-1.0 (`0.x`). The public surface may still change, but changes follow
the compatibility process described below.

## Goals

1. A useful operation should fit on one screen: create a runtime, declare
   strategies, and call `run()`.
2. Resource measurement must be visible, never implied. Signals carry an explicit
   status, unit, timestamp, and source.
3. Policy decisions must be deterministic for the same inputs, state, and clock.
4. Every run must say which strategy ran and why.
5. The core runtime must remain lean and zero-dependency: ESM-native, low memory
   footprint, and zero hidden background or network activity.
6. Failure at the edges must not take down application work by default.

## Non-goals

- A sandbox, worker scheduler, OS resource limiter, or autoscaler.
- Automatic retries, hedging, or mid-run strategy switching.
- Proving that a strategy is correct or that its declared quality tier is honest.
- Persisting decision state or coordinating multiple processes.
- A general plugin framework or dependency-injection container.

## Public surface

The package exposes 10 package exports (9 runtime subpaths plus `package.json`).
Consumers should not import from `dist/` subpaths directly.

| Entry point | Target | Contents | Responsibility |
| --- | --- | --- | --- |
| `adaptive-runtime` | Node.js | Runtime, operation, strategy, policy, decision, signal, error, and built-in provider types | Recommended application surface: lifecycle, selection, execution, events, stats |
| `adaptive-runtime/core` | Universal | Portable core runtime (`createAdaptiveRuntime`, `CompositeSignalProvider`, `NetworkLatencyProvider`, `definePolicy`, `createErrorRateGuardSelector`, `createLatencyBudgetSelector`, `formatDecisionSummary`, types, errors) | Pure, portable core with zero Node.js built-ins or `process` dependencies |
| `adaptive-runtime/node` | Node.js | Core runtime plus Node.js process-level resource providers (`ProcessMemoryProvider`, `CpuUtilizationProvider`, `EventLoopDelayProvider`, `EventLoopUtilizationProvider`) | Targeted surface for Node.js services requiring OS and process telemetry |
| `adaptive-runtime/web` | Browser | Web-specific signal providers (`DeviceMemoryProvider`, `NetworkInformationProvider`, `FrameTimingProvider`, `ComputePressureProvider`) | Structurally typed browser telemetry with no direct DOM/window global assumptions |
| `adaptive-runtime/edge` | WinterCG | Edge execution budget providers (`ExecutionBudgetProvider`, `EDGE_EXECUTION_REMAINING_MS`, `EDGE_EXECUTION_USED_RATIO`, `EDGE_CONCURRENCY_SATURATION`) | Edge and worker runtimes (Cloudflare Workers, Deno, Bun, Vercel Edge) |
| `adaptive-runtime/policy` | Universal | Pure policy engine (`definePolicy`, `resolvePolicy`, `evaluatePolicy`, `createInitialPolicyState`, `createErrorRateGuardSelector`, `createLatencyBudgetSelector`, `formatDecisionSummary`, decision/budget types) | Platform-neutral policy evaluation and declarative rule definition with zero dependencies |
| `adaptive-runtime/providers` | Mixed | Comprehensive providers barrel (composite, web, edge, and Node.js process providers) | Single-import convenience barrel for all signal provider implementations |
| `adaptive-runtime/observability` | Universal | Zero-dependency observability bridge (`createMetricsCollector`, `MetricsCollector`, `attachOpenTelemetryMeter`) | In-memory metrics collection, Prometheus text generation, and OpenTelemetry Meter bridge |
| `adaptive-runtime/testing` | Universal | Provider conformance and test SDK (`createFakeClock`, `ScriptedSignalProvider`, `runProviderConformanceCheck`, `simulatePolicyTimeline`) | Deterministic simulation, fake timers, and provider contract verification |
| `adaptive-runtime/package.json` | Manifest | Package metadata and exports manifest | Package resolution and build tooling introspection |

Root entry-point areas:

| Area | Main types | Responsibility |
| --- | --- | --- |
| Runtime | `createAdaptiveRuntime`, `AdaptiveRuntime` | Lifecycle, selection, execution, events, stats |
| Operation | `Operation`, `RunResult`, `RunMetadata` | One logical unit of work and its result |
| Strategies | `Strategy`, `StrategyRunContext`, `QualityCheckResult` | Application-supplied alternative implementations |
| Policy | `Policy`, `definePolicy`, `BudgetRule`, `MissingSignalBehavior` | Declarative selection constraints and a type-preserving identity helper |
| Decisions | `StrategyDecision`, `SignalView`, `BudgetView` | Inspectable explanation of a selection |
| Signals | `SignalProvider`, `ResourceSignal`, descriptors | Measurement boundary |
| Errors | Typed `AdaptiveRuntimeError` subclasses | Stable failure categories |

`definePolicy` is deliberately only an identity helper: it preserves the literal
type of a policy object for editor completion and type inference, but performs no
validation or defaulting. Validation remains in `createAdaptiveRuntime()`.

## Request flow

```text
run(operation)
  validate operation and strategy declarations
  serialize selection for the operationId
  collect a fresh or cached signal snapshot
  apply pin / fallback / static / automatic policy
  choose one eligible strategy deterministically
  release the selection lock
  invoke exactly one strategy with a cooperative signal
  optionally run the strategy's quality check
  update stats and emit events
  return { value, metadata }
```

Selection and strategy execution are deliberately separate. Selection is
serialized per `operationId` because policy state is shared for that key.
Execution may overlap across runs, including runs for the same key, after
selection has completed.

The policy engine is pure and provider-independent. It receives a normalized
snapshot and policy state; it does not call Node APIs, read the clock, or load
strategy code.

## Why tiers instead of scores

A strategy declares `qualityTier` and optional `costTier`. This is intentionally
coarse:

- tiers are easy to reason about and test;
- policy output is discrete and reviewable;
- a budget can reduce the target by a fixed number of tiers;
- ties have a deterministic order instead of depending on a hidden score.

The runtime cannot verify a tier. It is a declaration by the application. If an
application needs outcome assurance, it must provide `checkQuality` or validate
the result outside the runtime. A failed quality check is reported or rejects the
run; it never causes a second strategy to execute.

Tie-breaking order is deliberate: highest declared quality at or below the target,
then lower cost tier, then code-unit `id` ordering. Code-unit comparison avoids
locale-dependent behavior across machines.

## Why one attempt

Exactly one strategy runs per `run()`. Automatic retries and fallback-on-error
would create duplicate side effects and make cost unpredictable. The only fallback
is selected **before** execution when a required signal is unavailable.

Caller-managed retries remain possible outside the runtime. Applications that do
this own idempotency, backoff, and amplification control.

## Cancellation model

- Every run accepts a standard `AbortSignal`.
- `timeoutMs` bounds strategy execution and aborts the strategy signal.
- Provider reads have their own `providerTimeoutMs`.
- Cancellation is cooperative. A synchronous loop or an uncooperative promise
  cannot be preempted.
- A cancelled run rejects with `OperationAbortedError`; a timed-out run rejects
  with `OperationTimeoutError`.
- Queued selections are abort-aware and reject immediately with OperationAbortedError when the caller's signal aborts.

Provider reads are shared across concurrent runs. The shared read has its own
controller and a waiter count, so one caller's abort does not cancel the read for
healthy waiters. The last waiter to leave aborts the provider signals, and a read
aborted by every caller is not cached. See
[ADR 0005](adr/0005-ref-counted-shared-reads.md) and
[ADR 0012](adr/0012-abort-aware-selection-queue.md).

## Observability contract

`run()` returns metadata synchronously with the result. The same information is
available through events and accessors:

| Surface | Semantics |
| --- | --- |
| `metadata.decision` | Decision used for this run, including signals and reasons |
| `getDecision(id)` | Most recent decision, retained after failures and close |
| `getStats(id)` | Cumulative run, success, failure, latency, and strategy counts |
| `getTrackedOperations()` | Frozen list of all tracked operation ids in LRU order (oldest to newest) |
| `getAllStats()` | Frozen dictionary mapping every tracked operation to its RuntimeStats |
| `getOperationPolicy(id)` | Resolved per-operation policy override or null if unconfigured |
| `on(event, listener)` | Synchronous notifications; listener failures are isolated |
| `signalsCached` / `snapshot.cached` | Whether the snapshot came from cache |
| `sampleSequence` | Fresh-snapshot sequence used by policy stabilization |

Events are not a durability mechanism. They are best-effort in-process callbacks.
Applications that export metrics should map stable reason codes and event names,
not free-form messages.

## Error taxonomy

Errors are grouped by phase:

| Phase | Errors |
| --- | --- |
| Construction/configuration | `ConfigurationError`, `RuntimeClosedError` |
| Selection | `NoEligibleStrategyError`, `MissingSignalError`, `FallbackStrategyError`, `PinnedStrategyError` |
| Applicability/quality | `StrategyApplicabilityError`, `QualityCheckError` |
| Execution | `StrategyExecutionError`, `OperationAbortedError`, `OperationTimeoutError` |
| Providers | `ProviderTimeoutError` (surfaced as readings/events, not as run failures by default) |

All public errors extend `AdaptiveRuntimeError` and preserve a `cause` when one
exists. Provider and listener failures are contained: they become error readings
or `provider:error` / `listener:error` events instead of crashing the operation.

## Compatibility and change process

- The package is ESM-only and exposes the root entry point, 8 runtime subpaths,
  and `./package.json`.
- `0.x` is pre-1.0. Breaking changes are allowed but must be documented in
  [CHANGELOG.md](../CHANGELOG.md) and, for semantic changes, an ADR.
- Prefer additive optional fields over changing existing meanings.
- Do not change reason codes, error classes, or decision semantics silently.
- A new public option needs a test, a doc update, and a clear default.
- A hot-path change needs a before/after benchmark using the documented method.
- Node.js support follows the policy in [ROADMAP.md](ROADMAP.md); dropping a
  supported line is a breaking change outside end-of-life.

## Alternatives considered

| Alternative | Why it is excluded |
| --- | --- |
| Numeric `unknown = 0` | Converts missing data into a false "healthy" signal |
| Automatic retry / hedging | Duplicate side effects and unpredictable cost |
| Per-caller provider reads | Multiplies provider work under concurrency |
| Global signal singleton | Hidden state and no isolation between runtimes |
| Async applicability | Complicates deterministic selection and latency |
| Custom policy callback | Larger contract; needs a stable validation and reason model first |
| Dynamic strategy loading | Violates the compact, auditable, trusted-code model |
| Mid-run switching | Cannot safely stop the first strategy in one JavaScript realm |

## Related records

- [API reference](API.md)
- [Provider authoring](PROVIDERS.md)
- [Architecture](ARCHITECTURE.md)
- [ADR 0002: deterministic tier policy](adr/0002-deterministic-tier-policy.md)
- [ADR 0003: single attempt and cooperative cancellation](adr/0003-single-attempt-cooperative-cancellation.md)
- [ADR 0004: explicit signal statuses](adr/0004-explicit-signals-provider-isolation.md)
- [ADR 0005: ref-counted shared reads](adr/0005-ref-counted-shared-reads.md)
- [Threat model](THREAT_MODEL.md)
