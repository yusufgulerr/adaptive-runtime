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
  start?(): void;
  read(context: SignalReadContext): Promise<readonly ResourceSignal[]> | readonly ResourceSignal[];
  close?(): void | Promise<void>;
}
```

- `id` is stable, unique within a runtime, and has no leading or trailing
  whitespace. Signal names follow the same rule.
- `signals` declares every name and unit the provider may return.
- `start()` is called lazily, once, before the first read.
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
does not open resources. A start failure is cached: subsequent reads for that
provider become `error` readings, and the failure is reported through
`provider:error`.

`read()` is isolated from the rest of the operation:

- a throw becomes error readings for that provider's declared signals;
- invalid output becomes error readings;
- a timeout aborts the provider's read signal and becomes error readings;
- a failed provider does not fail the run unless policy chooses
  `missingSignalBehavior: "error"`.

`providerTimeoutMs` defaults to 1000 ms and can be disabled with `0`. A synchronous
infinite loop in `read()` blocks the event loop before any timeout can fire.

`close()` is called for every provider through `Promise.allSettled`. A close
failure is emitted as `provider:error` and does not reject `runtime.close()`.

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

## Testing a provider

Test the provider directly and through a runtime. Keep tests deterministic: pass
`now` explicitly and inject the measurement function instead of relying on the
machine.

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
`memoryUsage`, `cpuUsage`, `histogramFactory`, and the network `probe`. See
[API.md](API.md#built-in-providers).

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
- [ ] `close()` releases timers, sockets, and listeners.
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
