# Provider authoring guide

A signal provider is the boundary between the runtime and a measurement source.
It declares which signals it can produce and returns explicit readings. The policy
engine never reaches into the provider; it only sees validated readings.

The contract is defined in [API.md](API.md#signals). This guide covers the
practical rules that are not obvious from the type signatures.

## Contract at a glance

```ts
interface SignalProvider {
  readonly id: string;
  readonly signals: readonly SignalDescriptor[];
  start?(context: SignalStartContext): void | Promise<void>;
  read(context: SignalReadContext): Promise<readonly ResourceSignal[]> | readonly ResourceSignal[];
  drainProviderErrors?(): readonly Error[];
  close?(): void | Promise<void>;
}
```

- `id` is stable, unique within a runtime, and has no leading or trailing
  whitespace. Signal names follow the same rule.
- `signals` declares every name and unit the provider may return.
- `start()` is called lazily, once, before the first read. It may be synchronous
  or asynchronous.
- `read()` may be synchronous or asynchronous and must return an array of readings.
- `close()` is called once by `runtime.close()`.

Providers are listed in `createAdaptiveRuntime({ providers })`. A provider id or
signal name collision is a `ConfigurationError` at construction.

## Reading rules

Every reading needs a declared `name`, the matching `unit`, an `observedAt`
timestamp, and an explicit status.

| Status | Use when | Required fields |
| --- | --- | --- |
| `ok` | A finite measurement is available | `value`; optional `confidence` in `0..1` |
| `unknown` | The source exists but has no value yet | optional `error` |
| `unsupported` | The platform or source cannot provide this metric | optional `error` |
| `stale` | The provider already knows the value is too old | optional `error` |
| `error` | The read failed | optional short, non-secret `error` |

Rules that matter:

- **Never use `0` for missing data.** `0` means a real measurement of zero.
- Use `context.now` for `observedAt`; do not call `Date.now()` inside the provider.
- If a successful read omits a declared signal, the runtime synthesizes
  `unknown` for it. Returning `[]` is valid and means "nothing measured this time".
- Do not return undeclared signals, duplicate names, or a unit different from the
  descriptor. That rejects the whole provider read.
- `error` and `details` are exported to events and decisions. Never put secrets,
  tokens, raw user input, or full URLs in them.
- `confidence` is informational in the current policy and does not alter selection.

## Lifecycle and failure handling

The runtime starts providers lazily, so a provider that is configured but unused
does not open resources. An asynchronous `start()` is awaited before the first
read, under the same `providerTimeoutMs` and caller abort signal as a read. A
start failure or timeout is cached: subsequent reads for that provider become
`error` readings, and the failure is reported through `provider:error` once. An
abandoned wait does not cache the caller's abort, and a late start rejection is
observed rather than leaking as an unhandled rejection.

`read()` is isolated from the rest of the operation:

- a throw becomes error readings for that provider's declared signals;
- invalid output becomes error readings;
- a timeout aborts the provider's read signal and becomes error readings;
- a failed provider does not fail the run unless policy chooses
  `missingSignalBehavior: "error"`.

`providerTimeoutMs` defaults to 1000 ms and can be disabled with `0`. A synchronous
infinite loop in `start()` or `read()` blocks the event loop before any timeout
can fire.

`close()` is called for every provider through `Promise.allSettled`. A close
failure is emitted as `provider:error` and does not reject `runtime.close()`.

A provider that catches internal failures and converts them into readings may
implement `drainProviderErrors()`. The collector calls it after each fresh read and
forwards every returned error as `provider:error`. `CompositeSignalProvider` uses
this to make child and nested-child failures visible without failing the combined
read. Cache hits do not drain, so a failure is reported once.

## Shared reads and cancellation

Concurrent runs may share one in-flight read per runtime. The read is owned by the
collector, not by whichever caller started it:

- a caller's abort rejects only that caller;
- providers see an abort when the last waiting caller leaves or the provider
  timeout expires;
- a read aborted by every caller is not cached;
- an initiator has no special cancellation privilege.

Your `read()` should still honor `context.signal` for any I/O. Stop work when it is
aborted, and do not resolve with a partially measured array after abort. The
collector discards a provider result after a timeout or full cancellation, but
cooperative providers avoid wasting work.

See [ADR 0005](adr/0005-ref-counted-shared-reads.md).

## Worked example: application queue depth

This provider measures an in-memory queue. It needs no network, OS-specific API,
or background timer.

```ts
import type {
  ResourceSignal,
  SignalDescriptor,
  SignalProvider,
  SignalReadContext,
} from "adaptive-runtime";

interface QueueLike {
  readonly length: number;
}

export class QueueDepthProvider implements SignalProvider {
  readonly id = "app.queue";

  readonly signals = [
    {
      name: "app.queue.depth",
      unit: "count",
      description: "Items waiting in the application queue.",
    },
  ] as const satisfies readonly SignalDescriptor[];

  constructor(private readonly queue: QueueLike) {}

  read({ now }: SignalReadContext): readonly ResourceSignal[] {
    const value = this.queue.length;
    if (!Number.isFinite(value) || value < 0) {
      return [
        {
          name: "app.queue.depth",
          unit: "count",
          status: "error",
          observedAt: now,
          error: "Queue depth was not a finite non-negative number.",
        },
      ];
    }

    return [
      {
        name: "app.queue.depth",
        unit: "count",
        status: "ok",
        value,
        observedAt: now,
      },
    ];
  }
}
```

Use it with a budget:

```ts
import { createAdaptiveRuntime } from "adaptive-runtime";

const runtime = createAdaptiveRuntime({
  providers: [new QueueDepthProvider(queue)],
  policy: {
    budgets: [
      {
        id: "queue-pressure",
        signal: "app.queue.depth",
        limit: 100,
        recoverBelow: 20,
        tierReduction: 1,
      },
    ],
  },
});
```

The budget is a **selection threshold**, not an admission-control mechanism. A
queue at 101 items reduces the target quality tier; it does not make the queue
shorter.

## Platform providers

The same provider contract works on every runtime. Import from the narrowest
subpath so a bundler does not pull Node.js built-ins into a browser or worker.

### Web: structural globals

Web providers never assume the DOM type library is present. They define
structural interfaces and read `globalThis` with optional chaining.

```ts
import { DeviceMemoryProvider, FrameTimingProvider } from "adaptive-runtime/web";

const deviceMemory = new DeviceMemoryProvider();
const frameTiming = new FrameTimingProvider({ targetFrameBudgetMs: 16.67 });

function renderFrame(durationMs: number): void {
  frameTiming.recordFrameDuration(durationMs);
}
```

`DeviceMemoryProvider` reads `navigator.deviceMemory` and
`performance.memory`. `NetworkInformationProvider` reads
`navigator.connection`. `FrameTimingProvider` is fed by your render loop.
`ComputePressureProvider` observes a W3C `PressureObserver` when present and maps
`nominal`/`fair`/`serious`/`critical` to `0.25`/`0.5`/`0.75`/`1.0`; environments
without an observer can call `recordPressureState()` manually. Absent APIs produce
`unsupported` or `unknown`; invalid values produce `error`. Never replace them with
zero. All web providers accept injection options for tests.

### Node.js: event-loop pressure

`EventLoopDelayProvider` measures scheduling delay with
`monitorEventLoopDelay`. It exposes a percentile (default p95) in milliseconds and
retains its last valid reading for `resolutionMs * minSamples` after a reset, so a
read that arrives before new samples does not flap to `unknown`.
`EventLoopUtilizationProvider` reports cumulative utilization on the first read and
delta utilization afterwards. Both return explicit `unknown`/`error` statuses when
there is no activity or the source is invalid.

### Edge: wall-clock and concurrency budgets

Serverless runtimes expose deadlines differently, so `ExecutionBudgetProvider`
takes an application-supplied snapshot:

```ts
import { ExecutionBudgetProvider, EDGE_EXECUTION_USED_RATIO } from "adaptive-runtime/edge";

const budget = new ExecutionBudgetProvider({
  getBudgetSnapshot: () => ({
    totalBudgetMs: 30_000,
    elapsedMs: Date.now() - requestStartedAt,
    activeRequests: inFlight.size,
    maxConcurrency: 20,
  }),
});
```

Use `edge.execution.usedRatio` for deadline pressure and
`edge.concurrency.saturation` for queue pressure. `remainingMs` is convenient
for logs and composite rules. Missing snapshot fields are `unknown`, not zero.

### Composite: derive a policy signal

`CompositeSignalProvider` wraps one or more providers and computes derived
signals. All inputs must be `ok` before `compute` runs; otherwise the unavailable
status propagates in priority order `error` > `stale` > `unsupported` >
`unknown`.

```ts
import { CompositeSignalProvider } from "adaptive-runtime/core";
import {
  EDGE_CONCURRENCY_SATURATION,
  EDGE_EXECUTION_USED_RATIO,
  ExecutionBudgetProvider,
} from "adaptive-runtime/edge";

const composite = new CompositeSignalProvider({
  providers: [new ExecutionBudgetProvider({ getBudgetSnapshot })],
  rules: [
    {
      name: "edge.pressure.score",
      unit: "ratio",
      inputs: [EDGE_EXECUTION_USED_RATIO, EDGE_CONCURRENCY_SATURATION],
      compute: (values) => {
        const used = values[EDGE_EXECUTION_USED_RATIO];
        const saturation = values[EDGE_CONCURRENCY_SATURATION];
        if (used === undefined || saturation === undefined) {
          return Number.NaN;
        }
        return 0.6 * used + 0.4 * saturation;
      },
    },
  ],
});
```

The constructor rejects empty providers/rules, unknown inputs, duplicate rule
names, and name collisions with passthrough inputs. A rule that throws or returns
a non-finite number becomes an `error` reading. The local lookup above turns an
impossible missing input into an explicit error instead of a zero reading.

## Testing a provider

Test the provider directly and through a runtime. Keep tests deterministic: pass
`now` explicitly and inject the measurement function instead of relying on the
machine. The `adaptive-runtime/testing` subpath provides `ScriptedSignalProvider`
for runtime scenarios and `runProviderConformanceCheck` for contract checks.

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { QueueDepthProvider } from "./queue-depth-provider.js";

test("reports queue depth", () => {
  const provider = new QueueDepthProvider({ length: 7 });
  const readings = provider.read({
    now: 1_000,
    signal: new AbortController().signal,
  });

  assert.equal(readings[0]?.status, "ok");
  assert.equal(readings[0]?.name, "app.queue.depth");
  assert.equal(readings[0]?.unit, "count");
  assert.equal(readings[0]?.observedAt, 1_000);
});

test("does not use zero for missing data", () => {
  const provider = new QueueDepthProvider({ length: Number.NaN });
  const readings = provider.read({
    now: 1_000,
    signal: new AbortController().signal,
  });

  assert.equal(readings[0]?.status, "error");
  assert.equal("value" in readings[0]!, false);
});
```

For built-in providers, use their injection points rather than real hardware:
`memoryUsage`, `cpuUsage`, `histogramFactory`, and the network `probe`. Web and
edge providers accept `getEnvironment`, `getConnection`, and
`getBudgetSnapshot`; the frame provider accepts recorded durations. See
[API.md](API.md#built-in-providers).

Run the conformance check once per provider in your test suite:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { runProviderConformanceCheck } from "adaptive-runtime/testing";
import { QueueDepthProvider } from "./queue-depth-provider.js";

test("queue depth provider conforms to the signal contract", async () => {
  const report = await runProviderConformanceCheck(new QueueDepthProvider({ length: 7 }));
  assert.equal(report.ok, true, report.failures.join("; "));
});
```

The check invokes `start()` and `close()` once, calls `read()` once before
closing, and verifies the provider id, descriptor names/units, reading
names/units, `observedAt`, status codes, finite `ok` values, confidence bounds,
and error strings. It reports failures instead of throwing, so one bad provider
does not abort the suite. It does not enforce a timeout.

By default it also calls `read()` once after `close()` and requires every
reading to report `status: "unsupported"`. Pass `{ checkPostClose: false }` only
when a provider intentionally permits post-close reads. If the provider defines
`drainProviderErrors()`, the check calls it once after the initial read and
requires an array; a throwing call or a non-array result is reported as a
failure. All built-in Node.js, web, edge, composite, and scripted providers pass
this contract. The check never invents a zero reading for an unavailable
signal.

For runtime integration, use a fake `Clock` and a provider that returns a fixed
reading. Assert the selected strategy, the decision reasons, and the signal
status. Do not assert on real heap, CPU, or event-loop values.

## Checklist

- [ ] `id` is stable and specific (for example `app.queue`, not `queue`).
- [ ] Every signal is declared with the correct unit.
- [ ] `read()` uses `context.now` and honors `context.signal`.
- [ ] Missing data is `unknown`, `unsupported`, `stale`, or `error`, never `0`.
- [ ] No network, disk, or subprocess work unless the application opted in.
- [ ] Work is bounded and does not block the event loop.
- [ ] `close()` releases timers, sockets, and listeners, and later `read()`
      calls report `status: "unsupported"`.
- [ ] Errors and details contain no secrets or unbounded user data.
- [ ] Tests cover success, unavailable, timeout, abort, and malformed output.
- [ ] The signal is documented in the application's policy configuration.

## Anti-patterns

| Anti-pattern | Problem |
| --- | --- |
| `value: memory ?? 0` | Turns unknown pressure into a healthy signal |
| `observedAt: Date.now()` | Ignores the runtime clock and makes tests nondeterministic |
| Throwing for an unsupported platform | Hides the distinction between a bug and a missing capability |
| Starting a timer in `read()` | Leaks resources; use `start()` and `close()` |
| Doing an unconfigured network probe | Creates hidden traffic and unpredictable latency |
| Returning unrelated signals | Rejected by validation, or creates policy coupling |
| Putting a token in `details` | Exported through decisions and events |
| Making `read()` wait for a lock or queue | Adds hidden backpressure to every run |

## Related documents

- [API reference](API.md)
- [API design notes](API_DESIGN.md)
- [Architecture](ARCHITECTURE.md)
- [Threat model](THREAT_MODEL.md)
- [ADR 0004: explicit signal statuses](adr/0004-explicit-signals-provider-isolation.md)
- [ADR 0005: ref-counted shared reads](adr/0005-ref-counted-shared-reads.md)
