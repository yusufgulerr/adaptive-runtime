# API reference

Package entry point: `adaptive-runtime` (ESM only). In this repository, examples
and tests import from `src/index.ts`.

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

All types are exported from the same entry point unless noted otherwise.

## `createAdaptiveRuntime(options?)`

Creates a runtime. Construction validates the policy, providers, clock, and
provider timeout, and throws `ConfigurationError` on invalid input.

```ts
interface CreateRuntimeOptions {
  readonly policy?: Policy;
  readonly providers?: readonly SignalProvider[];
  readonly clock?: Clock;
  readonly providerTimeoutMs?: number;
}
```

| Option | Default | Notes |
| --- | --- | --- |
| `policy` | all defaults | See [`Policy`](#policy) |
| `providers` | `[]` | Provider ids and signal names must be unique |
| `clock` | system clock | `now()` and `setTimeout()` |
| `providerTimeoutMs` | `1000` | Applies to one provider read; `0` disables |

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

## `AdaptiveRuntime`

```ts
interface AdaptiveRuntime {
  run<TInput, TOutput>(operation: Operation<TInput, TOutput>): Promise<RunResult<TOutput>>;
  pinStrategy(operationId: string, strategyId: string): void;
  unpinStrategy(operationId: string): void;
  setAdaptationEnabled(operationId: string, enabled: boolean): void;
  getDecision(operationId: string): StrategyDecision | null;
  getStats(operationId: string): RuntimeStats;
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

### `pinStrategy(operationId, strategyId)` / `unpinStrategy(operationId)`

A pin is an explicit manual override for future runs. It bypasses quality
pressure, `minQualityTier`, `maxQualityTier`, and `minimumModeDurationMs`, but the
pinned strategy must exist and be applicable. An invalid pin fails the run with
`PinnedStrategyError`. Pins are per operation and are not persisted.

### `setAdaptationEnabled(operationId, enabled)`

Overrides `policy.adaptationEnabled` for one operation. When disabled, the
runtime chooses the highest applicable tier allowed by `minQualityTier` and
`maxQualityTier`, without applying budgets. A pin takes precedence. Passing a
non-boolean throws `ConfigurationError`.

### `getDecision(operationId)`

Returns the most recent decision for the operation, or `null` if it has never
been evaluated. Decisions are retained after failures and after `close()`.

### `getStats(operationId)`

```ts
interface RuntimeStats {
  readonly operationId: string;
  readonly runs: number;
  readonly successes: number;
  readonly failures: number;
  readonly lastDurationMs: number | null;
  readonly averageDurationMs: number | null;
  readonly strategyRuns: Readonly<Record<string, number>>;
}
```

`runs` counts started runs, including runs that fail during selection.
`strategyRuns` increments when a strategy is selected, before execution. Latency
samples include successful runs and failures that occurred after selection.

### `on(event, listener)`

Subscribes to an event and returns an unsubscribe function. Listener exceptions
are caught; the runtime emits `listener:error` and continues. A listener cannot
change a decision.

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
| `fallbackStrategyId` | unset | Non-empty; required when behavior is `"fallback"` |
| `missingSignalBehavior` | `"hold"` | One of the four literals |
| `adaptationEnabled` | `true` | Boolean |
| `qualityCheck` | `"report"` | `"report"` or `"error"` |
| `budgets` | `[]` | Unique budget ids |

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
| `id` | required | Non-empty, unique |
| `signal` | required | Non-empty; need not be currently provided |
| `limit` | required | Finite |
| `recoverBelow` | `limit` | Finite, `<= limit` |
| `tierReduction` | `1` | Positive integer |
| `consecutiveSamples` | policy value | Positive integer |

A budget is a **selection threshold**, not an operating-system limit. Multiple
engaged budgets sum their `tierReduction` values.

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

interface SignalProvider {
  readonly id: string;
  readonly signals: readonly SignalDescriptor[];
  start?(): void;
  read(context: SignalReadContext): Promise<readonly ResourceSignal[]> | readonly ResourceSignal[];
  close?(): void | Promise<void>;
}
```

`SignalReadContext` contains `now` and an abort `signal`. Providers should stamp
`observedAt` with `context.now` and honor the abort signal when doing I/O.

Concurrent runs share one in-flight read per runtime. That read has its own abort
controller and a waiter count. Aborting a waiting caller rejects only that caller;
the provider reads are aborted only when the last waiter leaves. The initiating
caller has no special cancellation privilege. A read aborted by every caller is
not cached. See [ADR 0005](adr/0005-ref-counted-shared-reads.md) and
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
  histogramFactory?: (resolutionMs: number) => HistogramLike,
});
```

Default signal: `eventLoop.delay.p95` (`milliseconds`). Uses
`perf_hooks.monitorEventLoopDelay`. Before samples exist, returns `unknown`. This
is event-loop scheduling delay, not CPU utilization, and does not observe worker
threads or other processes.

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
`missing-signal-ignored`, `missing-signal-fallback`, `cached-sample`.

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
`signals` is the decision's signal snapshot.

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

## Exports

The package exports:

- `createAdaptiveRuntime`, `definePolicy`, and all public types listed above;
- the four providers and their signal-name constants;
- all error classes.

Internal modules (`src/policy`, `src/runtime`, `src/signals`) are not importable as
package subpaths; only the root entry point (`dist/index.js`) is exported.
