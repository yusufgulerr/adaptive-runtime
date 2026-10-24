# API reference

Package entry points (ESM only): `adaptive-runtime` (root, Node.js),
`adaptive-runtime/core`, `adaptive-runtime/node`, `adaptive-runtime/web`,
`adaptive-runtime/edge`, `adaptive-runtime/policy`,
`adaptive-runtime/providers`, `adaptive-runtime/observability`, and
`adaptive-runtime/testing`. In this repository, examples and tests import from
the matching `src/*.ts` files.

```ts
import {
  createAdaptiveRuntime,
  definePolicy,
  ProcessMemoryProvider,
  CpuUtilizationProvider,
  EventLoopDelayProvider,
  NetworkLatencyProvider,
} from "adaptive-runtime";
```

All core and Node.js types are exported from the root entry point. Web and edge
provider option types are exported from their matching `/web` and `/edge`
subpaths. The `/core` subpath is platform-neutral and excludes every Node.js
provider. The `/node`, `/web`, and `/edge` subpaths each re-export the core plus
their platform's providers. `/providers` is a mixed barrel that includes Node.js,
web, and edge providers, so it is not platform-neutral. `/observability` and
`/testing` are platform-neutral.

## `createAdaptiveRuntime(options?)`

Creates a runtime. Construction validates the policy, providers, clock, and
provider timeout, and throws `ConfigurationError` on invalid input.

```ts
interface CreateRuntimeOptions {
  readonly policy?: Policy;
  readonly providers?: readonly SignalProvider[];
  readonly clock?: Clock;
  readonly providerTimeoutMs?: number;
  readonly maxQualityCheckDetailLength?: number;
}
```

| Option | Default | Notes |
| --- | --- | --- |
| `policy` | all defaults | See [`Policy`](#policy) |
| `providers` | `[]` | Provider ids and signal names must be unique and have no surrounding whitespace |
| `clock` | system clock | `now()` and `setTimeout()` |
| `providerTimeoutMs` | `1000` | Applies to one provider read; `0` disables |
| `maxQualityCheckDetailLength` | `1000` | Maximum length for quality check error/detail strings before truncation |

A runtime with no providers is valid. Budgets that reference unavailable signals
then follow `missingSignalBehavior`.

## `definePolicy(policy)`

An optional identity helper that returns its argument unchanged while preserving
the literal type of the policy object:

```ts
const policy = definePolicy({
  evaluationIntervalMs: 1_000,
  missingSignalBehavior: "fallback",
  fallbackStrategyId: "safe",
});
```

It performs no validation, defaulting, or cloning. Invalid policy values are
still rejected by `createAdaptiveRuntime()`. The helper exists for editor
completion and literal-type inference; a plain object works everywhere it does.
The emitted declaration uses a TypeScript 5.0 `const` type parameter, so the
package requires TypeScript `>=5.0` for declarations (the project is developed
with TypeScript 5.9).

## `createErrorRateGuardSelector(options)`

Creates a pure, zero-dependency `CustomPolicySelector` that filters strategy candidates
based on their observed failure ratio (`errorRate`):

```ts
const selector = createErrorRateGuardSelector({
  maxErrorRate: 0.1, // Discard candidates exceeding 10% failure rate
  minSamples: 5,     // Cold-start guard: require at least 5 samples before disqualifying
  fallbackSelector: (context) => undefined, // Optional delegation among eligible candidates
});
```

- When eligible candidates remain at or below `maxErrorRate`, it selects the highest quality tier,
  breaking ties by lowest cost tier and code-unit strategy id.
- `minSamples` (default `1`, safe positive integer) protects cold-start strategies: candidates with fewer
  than `minSamples` observed samples are exempt from disqualification, preventing premature circuit-breaking
  on early single-failure spikes.
- If all candidates exceed `maxErrorRate` (and have reached `minSamples`), it selects the candidate with the lowest
  observed error rate to mitigate total outage.
- Candidates with unobserved error rates (`errorRate === null`) are treated as eligible.

## `createLatencyBudgetSelector(options)`

Creates a pure, zero-dependency `CustomPolicySelector` that selects strategies within a target
latency budget:

```ts
const selector = createLatencyBudgetSelector({
  maxLatencyMs: 150,
  preferLowestCost: true,                    // When true, optimizes cost over quality among budget-compliant candidates
  fallbackSelector: (context) => undefined,  // Optional delegation among within-budget candidates
  useEwma: true,                             // When true, filters and orders using ewmaLatencyMs instead of estimatedLatencyMs
});
```

- Selects candidates whose latency is within `maxLatencyMs` (or unmeasured `null`).
- When `useEwma: true`, candidates are evaluated using exponential moving average (`ewmaLatencyMs`); otherwise arithmetic mean (`estimatedLatencyMs`) is used.
- When `fallbackSelector` is defined and compliant candidates exist, selection delegates to `fallbackSelector`; if it returns `null`/`undefined`, deterministic tier tie-breaking is applied.
- By default selects highest quality tier; with `preferLowestCost: true` it selects lowest cost tier.
- If all candidates exceed `maxLatencyMs`, it selects the candidate with the lowest observed latency.

## `composeSelectors(selectors)`

Combines multiple `CustomPolicySelector` functions into a deterministic sequential pipeline:

```ts
const selector = composeSelectors([
  createErrorRateGuardSelector({ maxErrorRate: 0.1, minSamples: 3 }),
  createLatencyBudgetSelector({ maxLatencyMs: 150, useEwma: true }),
]);
```

- Accepts a non-empty array of selector functions and takes a defensive immutable snapshot.
- Evaluates selectors in order: returns the first non-null, non-undefined `CustomPolicySelection` (`string` or `{ strategyId, reason? }`).
- If no selector produces a decision (or candidates are empty), returns `null` so normal runtime tie-breaking takes effect.

## `formatDecisionSummary(decision)`

Formats a `StrategyDecision` into a deterministic, single-line structured string suitable for
audit logging and structured diagnostics:

```ts
const summary = formatDecisionSummary(decision);
// [search-op] strategy="fast" tier=1/3 kind=adapted changed=true budgets=heap(engaged) reasons=quality-pressure,strategy-switched
```

## `AdaptiveRuntime`

```ts
interface AdaptiveRuntime {
  run<TInput, TOutput>(operation: Operation<TInput, TOutput>): Promise<RunResult<TOutput>>;
  evaluate<TInput, TOutput>(
    operation: Operation<TInput, TOutput>,
    options?: EvaluateOptions,
  ): Promise<StrategyDecision>;
  exportState(operationId?: string): RuntimeStateSnapshot;
  importState(snapshot: RuntimeStateSnapshot): number;
  pinStrategy(operationId: string, strategyId: string): void;
  unpinStrategy(operationId: string): void;
  setAdaptationEnabled(operationId: string, enabled: boolean): void;
  setOperationPolicy(operationId: string, policy: Partial<Policy> | null): void;
  getOperationPolicy(operationId: string): ResolvedPolicy | null;
  getEffectivePolicy(operationId: string): ResolvedPolicy;
  getDecision(operationId: string): StrategyDecision | null;
  getStats(operationId: string): RuntimeStats;
  getTrackedOperations(): readonly string[];
  getAllStats(): Readonly<Record<string, RuntimeStats>>;
  getProviderDescriptors(): readonly SignalDescriptor[];
  removeOperation(operationId: string): boolean;
  resetStats(operationId?: string): void;
  on<K extends RuntimeEventName>(event: K, listener: RuntimeEventListener<K>): () => void;
  close(): Promise<void>;
}
```

### `run(operation)`

Selects one strategy, invokes it exactly once, optionally runs its quality check,
and resolves with the value and metadata. Rejected strategies are not retried.

Calls for the same `operationId` are serialized through selection. Strategy
execution itself can overlap across runs. Different operation ids select
independently.

Possible rejections include `ConfigurationError`, `NoEligibleStrategyError`,
`MissingSignalError`, `FallbackStrategyError`, `PinnedStrategyError`,
`StrategyApplicabilityError`, `StrategyExecutionError`, `OperationAbortedError`,
`OperationTimeoutError`, `QualityCheckError`, and `RuntimeClosedError`.

`startedAt`/`finishedAt` use the configured clock; `durationMs` covers the whole
run. With the system clock the resolution is milliseconds.

### `evaluate(operation, options?)`

Computes one policy decision without executing a strategy. It uses the same
signal snapshot, applicability checks, policy overrides, pin, and serialization
queue as `run()`. The returned decision is frozen.

```ts
interface EvaluateOptions {
  /** Defaults to false. */
  readonly dryRun?: boolean;
}
```

- `dryRun: true` persists no policy state, stores no decision, updates no stats,
  and emits no `decision` event.
- `dryRun: false` persists policy state and the decision, and emits `decision`.
  It does not execute a strategy or update run statistics.
- A dry run can still trigger a fresh provider read or reuse a cached snapshot.

### `exportState(operationId?)` / `importState(snapshot)`

`exportState()` returns a frozen, versioned, JSON-compatible snapshot:

```ts
interface RuntimeStateSnapshot {
  readonly version: 1;
  readonly exportedAt: number;
  readonly operations: readonly {
    readonly operationId: string;
    readonly state: {
      readonly policyState: PolicyState;
      readonly decision: StrategyDecision | null;
      readonly pinnedStrategyId: string | null;
      readonly adaptationEnabled: boolean | null;
      readonly stats: RuntimeStats;
    };
  }[];
}
```

Passing an operation id exports only that operation; an unknown id produces an
empty `operations` array. Snapshots exclude function-bearing configuration such
as per-operation policy overrides and custom selectors.

`importState(snapshot)` validates and deep-clones the entire snapshot before
mutating runtime state, so an invalid snapshot changes nothing. It rejects an
import for an operation with an in-flight selection or run, restores the listed
operations, leaves operations absent from the snapshot untouched, and returns the
number of restored operations. Imported operations participate in
`maxTrackedOperations` eviction; pins remain protected.

### `pinStrategy(operationId, strategyId)` / `unpinStrategy(operationId)`

A pin is an explicit manual override for future runs. It bypasses quality
pressure, `minQualityTier`, `maxQualityTier`, and `minimumModeDurationMs`, but the
pinned strategy must exist and be applicable. An invalid pin fails the run with
`PinnedStrategyError`. Leading or trailing whitespace in `strategyId` is rejected
with `ConfigurationError` instead of being trimmed. Pins are per operation and
are included in `exportState()`; they are not written to any external store
unless the caller persists the snapshot.

### `setAdaptationEnabled(operationId, enabled)`

Overrides `policy.adaptationEnabled` for one operation. When disabled, the
runtime chooses the highest applicable tier allowed by `minQualityTier` and
`maxQualityTier`, without applying budgets. A pin takes precedence. Passing a
non-boolean throws `ConfigurationError`. The override written by the call is
protected from LRU eviction during that call, so the tracking bound may be
exceeded temporarily when all other tracked operations are pinned or active.

### `setOperationPolicy(operationId, policy)`

Configures a per-operation policy override for multi-tenant and mixed-SLA
workloads. Merges declared operation rules (`budgets`, `minQualityTier`,
`maxQualityTier`, `missingSignalBehavior`, `evaluationIntervalMs`, `customSelector`,
etc.) over the global runtime policy. Pass `null` to clear the override.

The selection engine evaluates rules under a strict 4-tier precedence hierarchy:

1. **Manual Pin (`pinStrategy`):** Forces a strategy verbatim.
2. **Adaptation Toggle (`setAdaptationEnabled`):** When disabled, retains the initial
   strategy without evaluating budgets.
3. **Operation Policy (`setOperationPolicy`):** Merges declared rules over the global
   policy.
4. **Global Policy:** Base fallback for all operations.

Operation policy overrides are tracked under `maxTrackedOperations` LRU bounds and
are immediately purged when `removeOperation(operationId)` is called.

### `getOperationPolicy(operationId)`

Returns the frozen `ResolvedPolicy` override configured for the operation, or `null`
if no override has been set. When an operation record exists, calling `getOperationPolicy`
refreshes the operation's position in the LRU tracking order.

### `getEffectivePolicy(operationId)`

Returns the active `ResolvedPolicy` for the given operation (resolving any operation-level
override against global policy defaults). Unlike `getOperationPolicy`, `getEffectivePolicy`
is a non-disturbing introspection API: it **does not** register or track the operation,
nor does it alter existing LRU eviction order. Remains readable after `close()`.

### `getDecision(operationId)`

Returns the most recent decision for the operation, or `null` if it has never
been evaluated. Decisions are retained after failures and after `close()`.
Decision objects are frozen before storage; the same immutable object is used by
events and run metadata.

### `getStats(operationId)`

```ts
interface StrategyStats {
  readonly runs: number;
  readonly successes: number;
  readonly failures: number;
  readonly lastDurationMs: number | null;
  readonly averageDurationMs: number | null;
  readonly ewmaDurationMs: number | null;
  readonly durationSamples: number;
  readonly totalDurationMs?: number;
  readonly errorRate: number;
}

interface RuntimeStats {
  readonly operationId: string;
  readonly runs: number;
  readonly successes: number;
  readonly failures: number;
  readonly lastDurationMs: number | null;
  readonly averageDurationMs: number | null;
  readonly ewmaDurationMs: number | null;
  readonly durationSamples: number;
  readonly totalDurationMs?: number;
  readonly errorRate: number;
  readonly strategyRuns: Readonly<Record<string, number>>;
  readonly strategies: Readonly<Record<string, StrategyStats>>;
}
```

`runs` counts started runs, including runs that fail during selection.
`strategyRuns` increments when a strategy is selected, before execution.
`strategies` exposes fine-grained per-strategy counts (`runs`, `successes`,
`failures`) and durations (`lastDurationMs`, `averageDurationMs`,
`ewmaDurationMs`, `totalDurationMs`). Latency samples include successful runs and failures that
occurred after selection. `totalDurationMs` tracks exact cumulative execution milliseconds,
eliminating IEEE 754 floating-point drift across repeated `exportState()`/`importState()` cycles.
`ewmaDurationMs` uses alpha `0.2`; `errorRate` is
`failures / runs` and is `0` before the first run. `durationSamples` is the number
of duration observations and is persisted in state snapshots. Reading stats
refreshes the operation's LRU position.

### `getTrackedOperations()`

Returns a frozen array of all currently tracked `operationId`s in LRU order (from
oldest to newest). Unlike `getDecision` and `getStats`, inspecting tracked operations
is read-only and **does not** alter or refresh LRU order. Remains readable after `close()`.

### `getAllStats()`

Returns a frozen dictionary mapping each tracked `operationId` to its current
`RuntimeStats`. Does not alter or refresh LRU tracking order. Remains readable after `close()`.

### `getProviderDescriptors()`

Returns a frozen array of all `SignalDescriptor` records declared by registered signal
providers in registration order. Read-only introspection API: **does not** alter or refresh
LRU tracking order. Remains readable after `close()`.

### `removeOperation(operationId)`

Removes the operation's policy state, decision, pin, adaptation override, and
stats. Returns `true` when at least one record existed and `false` when the
operation had no retained state. Returns `false` without removing anything while
the operation is selecting or executing. Throws `RuntimeClosedError` after
`close()` and `ConfigurationError` for an invalid id.

### `resetStats(operationId?)`

Clears the counters and latency samples for one operation, or for all operations
when called without an id. Decisions, pins, adaptation overrides, and policy
state are retained. Resetting one operation leaves any other state it owns
intact, so its LRU entry remains; resetting all operations removes entries that
no longer own any state. Throws `RuntimeClosedError` after `close()`.

### `on(event, listener)`

Subscribes to an event and returns an unsubscribe function. Listener exceptions
are caught; the runtime emits `listener:error` and continues. Decisions and
successful run metadata are frozen before emission. A listener cannot change a
decision, metadata, or which strategy executes.

### `close()`

Closes providers and the signal collector, emits `runtime:closed`, and rejects
future runs and mutations with `RuntimeClosedError`. It is idempotent. Call it
after in-flight runs settle; `close()` does not abort an in-flight read, so a
pending read may remain pending or fail depending on provider shutdown. Abort
callers or await runs before closing. A provider's `close()` failure is emitted
as `provider:error` and does not reject `close()`.

## `Operation<TInput, TOutput>`

```ts
interface Operation<TInput, TOutput> {
  readonly operationId: string;
  readonly input: TInput;
  readonly strategies: readonly Strategy<TInput, TOutput>[];
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly context?: unknown;
}
```

| Field | Rules |
| --- | --- |
| `operationId` | Non-empty string; trimmed; policy state is per id |
| `strategies` | Non-empty array with unique ids |
| `signal` | Standard `AbortSignal`; may already be aborted |
| `timeoutMs` | Positive finite number; covers strategy execution only |
| `context` | Opaque value passed to strategy hooks |

Validation errors are thrown before signal collection or strategy execution.

## `Strategy<TInput, TOutput>`

```ts
interface Strategy<TInput, TOutput> {
  readonly id: string;
  readonly description?: string;
  readonly qualityTier: number;
  readonly costTier?: number;
  readonly labels?: readonly string[];
  isApplicable?(context: StrategyApplicabilityContext<TInput>): boolean;
  run(context: StrategyRunContext<TInput>): TOutput | Promise<TOutput>;
  checkQuality?(
    value: TOutput,
    context: StrategyRunContext<TInput>,
  ): QualityCheckResult | Promise<QualityCheckResult>;
}
```

| Field | Semantics |
| --- | --- |
| `id` | Non-empty, unique per operation; no leading or trailing whitespace. |
| `qualityTier` | Finite number; higher is declared better. The runtime does not verify this. |
| `costTier` | Optional finite number; lower wins ties at the same quality tier. |
| `isApplicable` | Synchronous filter. Must return a boolean; a throw becomes `StrategyApplicabilityError`. |
| `run` | Invoked once. May be sync or async. |
| `checkQuality` | Optional output check. Never triggers a retry or a different strategy. |

`StrategyApplicabilityContext` contains `input`, `operationId`, and `context`.
`StrategyRunContext` contains those plus `signal`, `strategyId`, and `decision`.
The `signal` is aborted on operation timeout or caller cancellation. The runtime
does not guarantee that a strategy's async work stops when the signal aborts.

A thrown or rejected `run()` becomes `StrategyExecutionError` with the original
error in `cause`.

## `QualityCheckResult`

```ts
interface QualityCheckResult {
  readonly ok: boolean;
  readonly detail?: string;
  readonly score?: number;
}
```

The result is reported as `metadata.quality`:

| Status | Cause |
| --- | --- |
| `not-configured` | Strategy has no `checkQuality` |
| `passed` | `ok: true` |
| `failed` | `ok: false` under `qualityCheck: "report"` |
| `error` | Check threw or returned an invalid shape |

With `policy.qualityCheck: "error"`, a `failed` result, a throw, or an invalid
result rejects the run with `QualityCheckError`. The strategy is still executed
only once. Quality checks have no independent timeout; keep them synchronous and
fast, or enforce your own deadline.

The fallback strategy selected by `missingSignalBehavior: "fallback"` must be
applicable, but it bypasses the quality floor/ceiling, like a pin. Choose a
fallback that is safe at any tier.

## `Policy`

```ts
interface Policy {
  readonly evaluationIntervalMs?: number;
  readonly maxSignalAgeMs?: number;
  readonly minimumModeDurationMs?: number;
  readonly consecutiveSamples?: number;
  readonly minQualityTier?: number;
  readonly maxQualityTier?: number;
  readonly fallbackStrategyId?: string;
  readonly missingSignalBehavior?: "hold" | "fallback" | "error" | "ignore";
  readonly adaptationEnabled?: boolean;
  readonly qualityCheck?: "report" | "error";
  readonly budgets?: readonly BudgetRule[];
  readonly maxTrackedOperations?: number | null;
  readonly customSelector?: CustomPolicySelector;
}
```

| Field | Default | Constraints |
| --- | --- | --- |
| `evaluationIntervalMs` | `1000` | Finite, `>= 0`; `0` reads on every run |
| `maxSignalAgeMs` | `5000` | Finite, `> 0` |
| `minimumModeDurationMs` | `0` | Finite, `>= 0` |
| `consecutiveSamples` | `2` | Positive integer |
| `minQualityTier` | unset | Finite; cannot exceed `maxQualityTier` |
| `maxQualityTier` | unset | Finite |
| `fallbackStrategyId` | unset | Non-empty, no surrounding whitespace; required when behavior is `"fallback"` |
| `missingSignalBehavior` | `"hold"` | One of the four literals |
| `adaptationEnabled` | `true` | Boolean |
| `qualityCheck` | `"report"` | `"report"` or `"error"` |
| `budgets` | `[]` | Unique budget ids |
| `maxTrackedOperations` | `null` | `null` or a positive safe integer |
| `customSelector` | unset | Function; validated during policy resolution |

### `CustomPolicySelector`

```ts
interface CustomSelectorCandidate {
  readonly candidate: PolicyCandidate;
  readonly estimatedCost: number | null;
  readonly estimatedLatencyMs: number | null;
  readonly id?: string;
  readonly qualityTier?: number;
  readonly costTier?: number;
  readonly applicable?: boolean;
}

interface CustomPolicySelectorContext {
  readonly operation: string;
  readonly operationId?: string;
  readonly candidates: readonly CustomSelectorCandidate[];
  readonly signals: Readonly<Record<string, SignalReading>>;
  readonly now: number;
}

interface CustomPolicySelection {
  readonly strategyId: string;
  readonly reason?: string;
}

type CustomPolicySelector = (
  context: CustomPolicySelectorContext,
) => CustomPolicySelection | string | null | undefined;
```

The selector runs after budgets and the default target tier have been evaluated,
but before `minimumModeDurationMs` and `consecutiveSamples` gates. Returning
`null`/`undefined` keeps the default selection. Returning a strategy id (or
`{ strategyId, reason }`) must reference an eligible candidate — applicable and
inside the quality bounds — otherwise the run fails with `ConfigurationError`.
A valid choice records a `custom-selector` reason and then goes through the same
stability gates, so a selector cannot bypass hysteresis or mode-duration
protection. `candidates` contains only eligible automatic candidates.
`estimatedCost` mirrors `costTier` when present; `estimatedLatencyMs` is
populated with the strategy's historical `averageDurationMs` from `StatsRegistry`
when execution samples exist, or `null` otherwise. The context is a snapshot;
do not mutate it. Selector exceptions fail the run.

### `BudgetRule`

```ts
interface BudgetRule {
  readonly id: string;
  readonly signal: string;
  readonly limit: number;
  readonly recoverBelow?: number;
  readonly tierReduction?: number;
  readonly consecutiveSamples?: number;
}
```

| Field | Default | Constraints |
| --- | --- | --- |
| `id` | required | Non-empty, unique, no surrounding whitespace |
| `signal` | required | Non-empty, no surrounding whitespace; need not be currently provided |
| `limit` | required | Finite |
| `recoverBelow` | `limit` | Finite, `<= limit` |
| `tierReduction` | `1` | Positive integer |
| `consecutiveSamples` | policy value | Positive integer |

A budget is a **selection threshold**, not an operating-system limit. Multiple
engaged budgets sum their `tierReduction` values. Budget, signal, strategy,
provider, and fallback identifiers must not have leading or trailing whitespace;
`operationId` is trimmed. Use stable identifiers without surrounding whitespace.

`maxTrackedOperations` bounds retained per-operation state with LRU eviction.
Pinned operations and operations that are selecting or executing are never
evicted, so the bound can be exceeded temporarily. Eviction discards the
operation's decision, stats, policy state, and adaptation override. Releasing a
pin immediately re-applies the bound.

Boundary and initial-sample behavior is described in the
[README](../README.md#budget-boundaries).

## Signals

```ts
type SignalUnit = "bytes" | "milliseconds" | "ratio" | "count" | "custom";
type SignalStatus = "ok" | "unknown" | "unsupported" | "stale" | "error";

interface SignalDescriptor {
  readonly name: string;
  readonly unit: SignalUnit;
  readonly description?: string;
}

interface SignalStartContext {
  readonly now: number;
  readonly signal: AbortSignal;
}

interface SignalProvider {
  readonly id: string;
  readonly signals: readonly SignalDescriptor[];
  start?(context: SignalStartContext): void | Promise<void>;
  read(context: SignalReadContext): Promise<readonly ResourceSignal[]> | readonly ResourceSignal[];
  drainProviderErrors?(): readonly Error[];
  close?(): void | Promise<void>;
}
```

`drainProviderErrors()` is an optional bridge for providers that isolate child
failures internally, such as `CompositeSignalProvider`. The collector calls it
after each fresh read and forwards every returned error as `provider:error`; a
cache hit does not drain, so one failure is reported once.

`start()` is called lazily once before the first read with a `SignalStartContext`
containing `now` and an abort `signal`. A returned promise is awaited under
`providerTimeoutMs` and the caller's abort signal; a rejection or timeout becomes
cached error readings and a `provider:error` event. A late rejection after an
abandoned wait is observed and never becomes an unhandled rejection. The abort
itself is not cached as a provider failure. Start failures are transiently
cached only for the current `evaluationIntervalMs`; subsequent evaluation
intervals allow the provider to retry initialization.

`SignalReadContext` contains `now` and an abort `signal`. Providers should stamp
`observedAt` with `context.now` and honor the abort signal when doing I/O.
Error messages supplied in provider reading payloads (`reading.error`) are
truncated to at most 1,000 characters to prevent unbounded memory growth.

Concurrent runs share one in-flight read per runtime. That read has its own abort
controller and a waiter count. Aborting a waiting caller rejects only that caller;
the provider reads are aborted only when the last waiter leaves. The initiating
caller has no special cancellation privilege. A read aborted by every caller is
not cached. Callers joining an in-flight live read receive a snapshot marked with
`cached: false, coalesced: true`, ensuring live evaluation without false
`cached-sample` penalty flags. Reused historical snapshots within
`evaluationIntervalMs` are marked with `cached: true, coalesced: false`. Fresh
initiators receive `cached: false, coalesced: false`. See
[ADR 0005](adr/0005-ref-counted-shared-reads.md),
[ADR 0018](adr/0018-selector-composition-and-simulation-fidelity.md), and
[PROVIDERS.md](PROVIDERS.md) for authoring guidance.

Readings are validated strictly. A provider read is rejected as a whole — and
converted to error readings for that provider's declared signals — when it
returns:

- a non-array value;
- an undeclared signal, a duplicate signal, or a unit that differs from its descriptor;
- an invalid status, a non-finite `observedAt`, or a negative `observedAt`;
- an `ok` reading with a non-finite `value` or confidence outside `0..1`;
- a non-string `error` on an unavailable reading.

Declared signals omitted from a successful array are synthesized as `unknown`
readings, never as zero. Provider errors and timeouts do not reject the run;
they become readings and follow `missingSignalBehavior`. A provider timeout
aborts that provider's read signal; full cancellation of the shared read also
aborts it.

### Built-in providers

#### `ProcessMemoryProvider`

```ts
new ProcessMemoryProvider({
  id?: string,
  heapSignalName?: string,
  rssSignalName?: string,
  memoryUsage?: () => { heapUsed: number; rss: number },
});
```

Signals: `process.memory.heapUsed` and `process.memory.rss`, both `bytes`.
These are process-local values, not machine-wide pressure. `memoryUsage` is a
test injection point.

#### `CpuUtilizationProvider`

```ts
new CpuUtilizationProvider({
  id?: string,
  signalName?: string,
  cpuUsage?: () => { user: number; system: number },
});
```

Signal: `process.cpu.utilization` (`ratio`). Computes process CPU time divided by
elapsed wall time relative to one core, so it can exceed 1. The first read
establishes a baseline and returns `unknown`.

#### `EventLoopDelayProvider`

```ts
new EventLoopDelayProvider({
  id?: string,
  signalName?: string,
  percentile?: number,       // 0..100, default 95
  resolutionMs?: number,     // > 0, default 20
  minSamples?: number,       // positive integer, default 1
  histogramFactory?: (resolutionMs: number) => HistogramLike,
});
```

Default signal: `eventLoop.delay.p95` (`milliseconds`). Uses
`perf_hooks.monitorEventLoopDelay`. Before samples exist, returns `unknown`. After
a valid reading, the histogram resets; if a later read has fewer than
`minSamples` new samples, the provider retains the last valid value for
`resolutionMs * minSamples` instead of flapping back to `unknown`. Retained
readings are marked with `details.retained: true` and `confidence: 0.5`. This is
event-loop scheduling delay, not CPU utilization, and does not observe worker
threads or other processes.

#### `EventLoopUtilizationProvider`

```ts
new EventLoopUtilizationProvider({
  id?: string,
  signalName?: string,
  eventLoopUtilization?: () => { idle: number; active: number; utilization: number },
});
```

Signal: `eventLoop.utilization` (`ratio`). Uses
`perf_hooks.performance.eventLoopUtilization`. The first read reports cumulative
utilization since the process started; later reads subtract the previous snapshot
and report the delta. A zero-activity or invalid snapshot is `unknown`/`error`,
never a fabricated `0`.

#### `NetworkLatencyProvider`

```ts
new NetworkLatencyProvider({
  id?: string,
  signalName?: string,
  probe: ({ signal }) => number | Promise<number>,
});
```

Signal: `network.latency` (`milliseconds`). The application defines what the
probe measures. The library creates no network traffic; invalid probe results
throw inside the provider and become error readings. The probe receives an abort
signal that is aborted on provider timeout or when every caller waiting on the
shared read has aborted.

#### Web providers (`adaptive-runtime/web`)

These providers use structural interfaces and optional chaining instead of the
DOM library, so they compile under `"lib": ["ES2022"]` and run in browsers,
Deno, Bun, and workers that expose the same globals.

##### `DeviceMemoryProvider`

```ts
new DeviceMemoryProvider({
  id?: string,
  getEnvironment?: () => {
    deviceMemory?: number;
    memory?: { usedJSHeapSize: number; totalJSHeapSize?: number; jsHeapSizeLimit: number };
  } | undefined,
});
```

Signals: `web.device.memoryGib` (`custom`) and `web.jsHeap.usedRatio` (`ratio`).
`deviceMemory` is reported as `ok` only when it is finite and `> 0`; absence is
`unsupported`, an invalid number is `error`. Heap ratio requires
`usedJSHeapSize >= 0` and `jsHeapSizeLimit > 0`; otherwise the reading is
`unsupported` (not `0`).

##### `NetworkInformationProvider`

```ts
new NetworkInformationProvider({
  id?: string,
  getConnection?: () => {
    rtt?: number;
    downlink?: number;
    saveData?: boolean;
    effectiveType?: string;
  } | undefined,
});
```

Signals: `web.network.rttMs` (`milliseconds`), `web.network.downlinkMbps`
(`custom`), `web.network.saveData` (`count`; `1` enabled, `0` disabled). When
`navigator.connection` is absent, all three are `unsupported`. A present but
invalid field is `unknown`.

##### `FrameTimingProvider`

```ts
new FrameTimingProvider({
  id?: string,
  targetFrameBudgetMs?: number, // default 16.67, must be > 0
  windowSize?: number,          // default 60, minimum 5
  minSamples?: number,          // default 3, >= 1 and <= windowSize
});
```

Signals: `web.frame.durationP95Ms` (`milliseconds`) and
`web.frame.droppedRatio` (`ratio`, `0..1`). Call `recordFrameDuration(ms)` from
your `requestAnimationFrame` loop; negative or non-finite durations throw
`ConfigurationError`. With fewer than `minSamples`, both readings are `unknown`.
`clearSamples()` and `close()` reset the window.

##### `ComputePressureProvider`

```ts
new ComputePressureProvider({
  id?: string,
  signalName?: string,
  source?: string,             // default "cpu"
  sampleIntervalMs?: number,
  pressureObserverFactory?: PressureObserverFactory,
});
```

Signal: `web.computePressure` (`ratio`). When a structural W3C
`PressureObserver` is available (or injected), the provider observes `source`
and maps `nominal`/`fair`/`serious`/`critical` to
`0.25`/`0.5`/`0.75`/`1.0`. Without an observer, call
`recordPressureState(state)` from your own pressure integration. Before any
state is known, the reading is `unknown`, never `0`.

#### `ExecutionBudgetProvider` (`adaptive-runtime/edge`)

```ts
new ExecutionBudgetProvider({
  id?: string,
  getBudgetSnapshot: (context) => {
    totalBudgetMs?: number;
    elapsedMs?: number;
    activeRequests?: number;
    maxConcurrency?: number;
  } | Promise<...>,
});
```

Signals: `edge.execution.remainingMs` (`milliseconds`),
`edge.execution.usedRatio` (`ratio`), and `edge.concurrency.saturation` (`ratio`).
`remainingMs = max(0, totalBudgetMs - elapsedMs)` and
`usedRatio = elapsedMs / totalBudgetMs` are `ok` only when
`totalBudgetMs > 0` and `elapsedMs >= 0`. Saturation is `ok` only when
`activeRequests >= 0` and `maxConcurrency > 0`. Missing fields produce
`unknown`; invalid fields produce `error`. The snapshot function may be async
and receives the provider's abort signal.

#### `CompositeSignalProvider` (`adaptive-runtime/core`)

```ts
new CompositeSignalProvider({
  id?: string,
  providers: readonly SignalProvider[],
  passthroughInputs?: boolean, // default true
  rules: readonly {
    name: string;
    unit: SignalUnit;
    description?: string;
    inputs: readonly string[];
    compute: (values: Readonly<Record<string, number>>) => number;
  }[],
});
```

The constructor validates that providers and rules are non-empty, that every
input name is declared by a child provider, that rule names are unique, and that
derived names do not collide with passthrough inputs. `read()` runs child reads
with `Promise.all`. Each rule propagates the highest-priority unavailable status
(`error` > `stale` > `unsupported` > `unknown`) and calls `compute` only when all
inputs are `ok`. A throw or non-finite compute result becomes an `error` reading.
`start()` and `close()` are forwarded to every child provider. Composite output
can feed budgets exactly like a built-in signal.

## Decisions

```ts
interface StrategyDecision {
  readonly operationId: string;
  readonly strategyId: string;
  readonly qualityTier: number;
  readonly previousStrategyId: string | null;
  readonly changed: boolean;
  readonly kind: "initial" | "adapted" | "retained" | "pinned" | "fallback" | "static";
  readonly decidedAt: number;
  readonly modeSince: number;
  readonly baseQualityTier: number;
  readonly targetQualityTier: number;
  readonly signals: readonly SignalView[];
  readonly budgets: readonly BudgetView[];
  readonly reasons: readonly DecisionReason[];
  readonly sampleSequence: number | null;
  readonly signalsCached: boolean;
}
```

| Kind | Meaning |
| --- | --- |
| `initial` | First automatic selection for the operation |
| `adapted` | Automatic switch under pressure or eligibility change |
| `retained` | Same strategy remains selected |
| `pinned` | Manual pin applied |
| `fallback` | Fallback used because a budget signal is unavailable |
| `static` | Adaptation disabled |

`changed` is true only when an existing selection moves to a different strategy.
`modeSince` is the clock value when the current strategy was selected.

`SignalView.status` adds `"missing"` to the provider statuses. `ageMs` is
computed against the decision time. `BudgetView` reports the post-update state,
including `engaged`, `status`, `value`, `ageMs`, `limit`, `recoverBelow`, and
`tierReduction`.

`reasons` is intended for logs, tests, and debugging. Codes are stable within the
0.x line:

`initial-selection`, `strategy-switched`, `strategy-retained`, `quality-pressure`,
`budget-recovered`, `quality-floor-clamped`, `target-tier-clamped`,
`minimum-mode-duration`, `candidate-stability`, `current-strategy-inapplicable`,
`pinned-strategy`, `adaptation-disabled`, `missing-signal-hold`,
`missing-signal-ignored`, `missing-signal-fallback`, `cached-sample`,
`custom-selector`.

## Run result and metadata

```ts
interface RunResult<TOutput> {
  readonly value: TOutput;
  readonly metadata: RunMetadata;
}

interface RunMetadata {
  readonly operationId: string;
  readonly strategyId: string;
  readonly qualityTier: number;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly durationMs: number;
  readonly attempts: 1;
  readonly decision: StrategyDecision;
  readonly signals: readonly SignalView[];
  readonly quality: QualityMetadata;
}
```

`attempts` is always `1`; its literal type documents the no-retry guarantee.
`signals` is the decision's signal snapshot. The decision, nested signal, budget,
and reason views, and the success metadata are frozen before `run:success` is
emitted and before the result is returned. Opaque `reason.details` values are not
recursively frozen.

## Events

```ts
interface AdaptiveRuntimeEvents {
  decision: { decision: StrategyDecision };
  "run:start": {
    operationId: string;
    strategyId: string;
    decision: StrategyDecision;
  };
  "run:success": { metadata: RunMetadata };
  "run:error": {
    operationId: string;
    strategyId?: string;
    error: Error;
    decision?: StrategyDecision;
    durationMs?: number;
  };
  "provider:error": { providerId: string; error: Error };
  "listener:error": {
    event: keyof AdaptiveRuntimeEvents;
    error: Error;
  };
  "runtime:closed": Record<string, never>;
}
```

`run:error` covers selection, applicability, execution, timeout, abort, and
quality-check failures. `provider:error` also covers provider `close()` failures.
The runtime does not await listeners; async work started by a listener is the
listener's responsibility.

## Errors

All errors extend `AdaptiveRuntimeError`, which has a stable `code` string and
supports the standard `cause` option.

| Class | `code` | Extra fields |
| --- | --- | --- |
| `ConfigurationError` | `CONFIGURATION_ERROR` | — |
| `RuntimeClosedError` | `RUNTIME_CLOSED` | — |
| `NoEligibleStrategyError` | `NO_ELIGIBLE_STRATEGY` | `operationId`, `minQualityTier` |
| `PinnedStrategyError` | `PINNED_STRATEGY_UNAVAILABLE` | `operationId`, `strategyId`, `reason` |
| `FallbackStrategyError` | `FALLBACK_STRATEGY_UNAVAILABLE` | `operationId`, `strategyId`, `reason` |
| `MissingSignalError` | `MISSING_SIGNAL` | `operationId`, `signals` |
| `StrategyApplicabilityError` | `STRATEGY_APPLICABILITY_FAILED` | `operationId`, `strategyId` |
| `StrategyExecutionError` | `STRATEGY_EXECUTION_FAILED` | `operationId`, `strategyId`, `decision`, `durationMs` |
| `OperationAbortedError` | `OPERATION_ABORTED` | `operationId`; `name` is `"AbortError"` |
| `OperationTimeoutError` | `OPERATION_TIMEOUT` | `operationId`, `timeoutMs`; `name` is `"TimeoutError"` |
| `QualityCheckError` | `QUALITY_CHECK_FAILED` | `operationId`, `strategyId`, `decision`, `durationMs` |
| `ProviderTimeoutError` | `PROVIDER_TIMEOUT` | `providerId`, `timeoutMs` |

`ProviderTimeoutError` is used internally and is not normally thrown from
`run()`; provider timeouts become error readings.

## Clock

```ts
interface Clock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ClockTimer;
}

interface ClockTimer {
  cancel(): void;
}
```

The clock is injectable for deterministic tests. Operation and provider timeouts
use `setTimeout`; signal age and mode duration use `now()`. Values must be
monotonic in practice for meaningful behavior; the runtime clamps negative
durations to zero but does not repair a backwards clock.

## Observability (`adaptive-runtime/observability`)

The observability bridge is zero-dependency and platform-neutral. It accepts
structural OpenTelemetry-compatible meters and also provides an in-memory
collector with Prometheus text exposition.

```ts
interface ObservabilityOptions {
  readonly prefix?: string;                    // default "adaptive_runtime"
  readonly defaultAttributes?: MetricAttributesLike;
  readonly buckets?: readonly number[];        // seconds; +Inf is appended
  readonly maxSeries?: number;                 // max metric series before FIFO eviction (default 1000)
}

interface RuntimeMetricsCollector {
  attach(runtime: AdaptiveRuntime): () => void;
  getSnapshot(): MetricsSnapshot;
  toPrometheusText(): string;
  removeOperation(operationId: string): void;
  reset(): void;
}

function createMetricsCollector(options?: ObservabilityOptions): RuntimeMetricsCollector;

function attachOpenTelemetryMeter(
  runtime: AdaptiveRuntime,
  meter: OpenTelemetryMeterLike,
  options?: ObservabilityOptions,
): () => void;
```

`MetricsCollector` is the exported class behind `createMetricsCollector`; both
forms are supported. `attach()` subscribes to `decision`, `run:start`, `run:success`, `run:error`,
`provider:error`, `listener:error`, and `runtime:closed`, and returns a
detach function. Snapshot counters include runs, decisions, strategy selections,
signal statuses, provider errors, quality checks, budget statuses, listener
errors, and runtime closes. Gauges include the latest `ok` signal readings and
budget engagement. Durations are recorded in seconds.

Non-`ok` signals increment `*_signal_status_total{status="..."}` only. They are
**never** written to the `*_signal_reading` gauge as `0`, so unavailable data is
not confused with a real zero measurement. Prometheus label values escape
backslashes, quotes, and newlines.

`attachOpenTelemetryMeter` prefers a structural `createGauge` instrument for
current signal readings and budget engagement. If the meter has no gauge, it
falls back to UpDownCounters and applies `next - previous` deltas per label set,
so the instrument converges to the current value instead of accumulating. Signal
attributes are `{ operation_id, signal, status }`; budget attributes are
`{ budget_id, operation_id }`. The fallback cannot retract a stale value when a
signal later becomes unavailable.

When an operation is removed via `runtime.removeOperation(operationId)`,
`attachOpenTelemetryMeter` automatically purges tracking keys for that operation
from internal UpDownCounter delta maps via lifecycle hooks, preventing memory
leaks in multi-tenant systems. The returned subscription also exposes
`subscription.purgeOperation(operationId)` for manual series cleanup.
Similarly, `MetricsCollector.attach(runtime)` automatically purges operation series
upon operation removal.

Metric family type is determined by the recording method: `increment` registers
a counter, `setGauge` a gauge, and `observe` a histogram, regardless of the name
suffix. Reusing a name with a different instrument kind throws `TypeError` before
series state changes. Series keys encode label text unambiguously, so commas,
equals signs, or quotes in label keys and values cannot merge distinct series.
`reset()` clears family registrations along with the series. See
[OBSERVABILITY.md](OBSERVABILITY.md) for the metric name table and examples.

## Testing SDK (`adaptive-runtime/testing`)

```ts
const clock = createFakeClock(1_000);
clock.advance(250);          // fires due timers and moves time
clock.set(5_000);            // sets time without firing timers
clock.pendingTimers();       // uncancelled, unfired timers

const provider = new ScriptedSignalProvider({
  id?: string,
  repeatLast?: boolean,      // default true
  script: [{
    name: string,
    unit: SignalUnit,
    description?: string,
    values: readonly (number | { status: Exclude<SignalStatus, "ok">; error?: string })[],
  }],
});

const report = await runProviderConformanceCheck(provider, {
  now?: number,              // default 1_000_000
  signal?: AbortSignal,      // default fresh, un-aborted signal
});
// { ok, providerId, checksPassed, failures }

const timeline = simulatePolicyTimeline({
  operationId?: string,      // default "simulated-operation"
  policy?: Policy,
  strategies: [{ id: "fast", qualityTier: 1 }, { id: "thorough", qualityTier: 2 }],
  initialState?: PolicyState,
  steps: [{
    now?: number,            // default index * 1000
    signals: ResourceSignal[],
    strategies?: SimulatedStrategy[],
    pinnedStrategyId?: string | null,
    adaptationEnabled?: boolean,
    sampleSequence?: number | null, // default null
    signalsCached?: boolean,        // default false
  }],
});
// { steps, decisions, finalState, strategySwitches, strategyReversals,
//   engagedBudgetIds, recoveredBudgetIds }
```

```ts
interface SimulatedStrategy {
  readonly id: string;
  readonly qualityTier: number;
  readonly costTier?: number;
  readonly applicable?: boolean;
  readonly estimatedLatencyMs?: number | null;
  readonly ewmaLatencyMs?: number | null;
  readonly errorRate?: number | null;
}
```

`createFakeClock` starts at `0` by default and rejects negative or non-finite
times. Timers execute in time order, then insertion order; timers scheduled by a
callback can fire within the same `advance()`. `set()` does not fire timers, so
overdue timers fire on the next `advance(0)`.

`ScriptedSignalProvider` validates its script at construction. A finite number
becomes an `ok` reading with `confidence: 1`; a status object becomes an explicit
unavailable reading. After the script is exhausted, the last value repeats by
default or the provider emits `unknown` when `repeatLast: false`. `reset()`
restarts the sequence; `close()` makes all readings `unsupported`.

`runProviderConformanceCheck` invokes `start()` and `close()` once, calls
`read()` once, and validates the provider id, descriptors, signal names and
units, `observedAt === context.now`, status codes, finite `ok` values, confidence
bounds, and error strings. It reports failures instead of throwing. It does not
enforce a timeout; wrap a provider that may hang in your own deadline.

`simulatePolicyTimeline` is a pure, provider-free policy simulator. It resolves
the policy once, threads policy state through each step, and reports the decision
and state for every step. It also reports per-step and cumulative budget
engagements/recoveries, the number of strategy switches, and the number of
reversals (a switch that exactly undoes the immediately preceding switch). The
default `sampleSequence: null` treats every step as a fresh sample. Strategies can
declare `estimatedLatencyMs`, `ewmaLatencyMs`, and `errorRate` for high-fidelity
simulation of custom selectors. No strategy is executed and no timer is scheduled.

## Exports

The package exports:

- root (`adaptive-runtime`): the Node.js entry point — core plus
  `ProcessMemoryProvider`, `CpuUtilizationProvider`, `EventLoopDelayProvider`,
  `EventLoopUtilizationProvider`, `NetworkLatencyProvider`,
  `CompositeSignalProvider`, `composeSelectors`, `createErrorRateGuardSelector`,
  `createLatencyBudgetSelector`, all public types, and all error classes;
- `adaptive-runtime/core`: platform-neutral runtime, policy helper,
  `composeSelectors`, `createErrorRateGuardSelector`, `createLatencyBudgetSelector`,
  errors, types (including state snapshot types), `NetworkLatencyProvider`, and
  `CompositeSignalProvider`;
- `adaptive-runtime/node`: core plus the process-level providers, including
  `EventLoopDelayProvider` and `EventLoopUtilizationProvider`;
- `adaptive-runtime/web`: core plus `DeviceMemoryProvider`,
  `NetworkInformationProvider`, `FrameTimingProvider`, and
  `ComputePressureProvider`;
- `adaptive-runtime/edge`: core plus `ExecutionBudgetProvider`;
- `adaptive-runtime/policy`: policy types and defaults, `definePolicy`,
  `resolvePolicy`, `createInitialPolicyState`, `evaluatePolicy`,
  `composeSelectors`, `createErrorRateGuardSelector`, `createLatencyBudgetSelector`,
  and the decision/state types needed to call it;
- `adaptive-runtime/providers`: every built-in provider (Node.js, web, edge, and
  composite) plus signal-name constants; this mixed barrel is not
  platform-neutral;
- `adaptive-runtime/observability`: `MetricsCollector`,
  `createMetricsCollector`, `attachOpenTelemetryMeter`, and the metrics types;
- `adaptive-runtime/testing`: `createFakeClock`, `ScriptedSignalProvider`,
  `runProviderConformanceCheck`, and `simulatePolicyTimeline`;
- `adaptive-runtime/package.json`: package metadata.

The root entry point intentionally excludes `/observability` and `/testing`.
Import those subpaths explicitly so production bundles do not include test
utilities. `npm run verify:exports` resolves every declared subpath from the
built package and checks its named runtime exports.

Internal modules (`src/runtime`, `src/signals`, `src/policy/*` implementation
files, `src/providers/*` implementation files) are not importable as package
subpaths. `/core`, `/web`, `/edge`, `/policy`, `/observability`, and `/testing`
do not import Node.js built-ins or read the Node.js `process` object.
