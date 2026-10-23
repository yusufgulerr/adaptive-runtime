# Cookbook

> **Status:** Adaptive Runtime 0.5.0 is the current development line. The GitHub
> release is tag-driven; npm publication is a separate owner-approved OIDC
> workflow dispatch and is pending.
> These patterns target the API in [API.md](API.md) and run against a local
> checkout. See [Installation](../README.md#installation) for the local install
> command. If a snippet and the API reference disagree, the reference wins.

This cookbook covers common ways to use the runtime. Each pattern states when it
applies, shows a concrete API snippet, and calls out the behavior that is easy to
misread. The patterns are independent; use the parts that fit your workload.

## Patterns

1. [Exact versus approximate search under pressure](#1-exact-versus-approximate-search-under-pressure)
2. [Correctness-sensitive pins](#2-correctness-sensitive-pins)
3. [Per-operation adaptation](#3-per-operation-adaptation)
4. [Batching and sampled signals](#4-batching-and-sampled-signals)
5. [Missing signals](#5-missing-signals)
6. [Side effects and idempotency](#6-side-effects-and-idempotency)
7. [Testing providers and policy deterministically](#7-testing-providers-and-policy-deterministically)
8. [Observability from decisions, events, and stats](#8-observability-from-decisions-events-and-stats)
9. [Input-dependent eligibility](#9-input-dependent-eligibility)

## Ground rules

- **One strategy per `run()`.** The runtime invokes exactly one strategy and does
  not retry, hedge, or switch mid-run. `metadata.attempts` is always `1`.
- **Tiers are declarations.** `qualityTier` and `costTier` are supplied by your
  application. The runtime does not measure output quality or speed.
- **Ties are deterministic.** At equal quality, lower `costTier` wins; at equal
  cost, ascending `id` by code-unit order decides. See
  [the migration note](MIGRATION.md#ties-break-on-code-unit-id-order).
- **Unavailable signals stay unavailable.** `unknown`, `unsupported`, `stale`,
  `error`, and `missing` are never coerced to `0`.
- **`operationId` is the state key.** Runs with the same id share budgets, mode
  history, pins, and stats. Selection is serialized per id; execution can overlap.
- **Provider reads are shared per runtime.** Concurrent runs share one in-flight
  read, and cancellation is ref-counted. See
  [ADR 0005](adr/0005-ref-counted-shared-reads.md).
- **State is in memory.** Decisions, pins, and stats are not persisted and are
  not coordinated across processes.
- **Cancellation is cooperative.** An operation timeout or caller abort rejects
  the caller and aborts the strategy signal, but it cannot stop synchronous code
  or an uncooperative promise.
- **Close the runtime at shutdown.** Let in-flight runs settle before calling
  `close()`, because provider shutdown can affect a pending read.
- **ESM and Node.js 22+.** The package is ESM-only and exposes the root entry
  point along with specialized subpaths (`./core`, `./node`, `./web`, `./edge`,
  `./policy`, `./providers`, `./observability`, `./testing`) and `./package.json`.

## Declared quality versus verified quality

Keep these two ideas separate. The runtime can act on the first; only your
application can establish the second.

| Claim | Source | Does the runtime verify it? |
| --- | --- | --- |
| `qualityTier` | Your strategy declaration | No. It is an ordinal input to selection. |
| `costTier` | Your strategy declaration | No. It is a tie-breaker at equal quality; lower wins, and a missing value ranks last. |
| `checkQuality` result | Your optional check | Only that the check returned a valid result. It is not a proof of correctness. |
| Signal value and status | Your provider | Shape, status, unit, and `observedAt` are validated; the measurement's truth is not. |
| Selected strategy | The policy | It records the selected id and invokes it once; it does not verify that the choice is optimal. |
| `durationMs` | The configured clock | Measured; system-clock resolution is milliseconds. |
| `attempts` | The runtime | Always `1`. |

Tiers are ordinal: the numbers order strategies, and `tierReduction` subtracts a
fixed amount from the base. The size of a gap matters only through that
arithmetic, not as a measured quality difference. A higher `qualityTier` is not a
guarantee; the runtime never checks it against output.

A useful workflow for assigning tiers:

1. Choose a reference implementation and a fixed evaluation fixture.
2. Measure each strategy against that reference (for example recall, precision,
   exactness, or a domain-specific score).
3. Assign ordinal tiers from those measurements, not from names like "fast" or
   "slow".
4. Keep the measurement in your own test or evaluation harness and re-run it when
   inputs or implementations change.
5. Use `checkQuality` only for cheap invariants that can run on the hot path.

The repository's search example demonstrates the distinction: the runtime sees
declared tiers and a structural check, while recall is measured against the
exhaustive result outside the runtime. See
[`examples/resource-aware-search/search.ts`](../examples/resource-aware-search/search.ts).
The planning example does the same with priority completed versus an exact
planner; see
[`examples/resource-pressure-planning/planning.ts`](../examples/resource-pressure-planning/planning.ts).

## 1. Exact versus approximate search under pressure

**Use when** an approximate result is acceptable for some requests, the work
trade-off is real, and you can measure the quality loss externally.

```ts
import {
  createAdaptiveRuntime,
  ProcessMemoryProvider,
  type Strategy,
} from "adaptive-runtime";

interface SearchInput {
  readonly query: string;
  readonly corpus: readonly string[];
}

interface SearchResult {
  readonly matches: readonly string[];
}

const exact: Strategy<SearchInput, SearchResult> = {
  id: "exact-search",
  qualityTier: 3,
  costTier: 3,
  checkQuality: (value, { input }) => ({
    ok: value.matches.every((item) => item.includes(input.query)),
    detail:
      "Checks returned items only; recall is measured against a reference outside the runtime.",
  }),
  run: ({ input }) => ({
    matches: input.corpus.filter((item) => item.includes(input.query)),
  }),
};

const approximate: Strategy<SearchInput, SearchResult> = {
  id: "sampled-search",
  qualityTier: 1,
  costTier: 1,
  run: ({ input }) => ({
    matches: input.corpus
      .slice(0, Math.max(1, Math.floor(input.corpus.length * 0.1)))
      .filter((item) => item.includes(input.query)),
  }),
};

const runtime = createAdaptiveRuntime({
  providers: [new ProcessMemoryProvider()],
  policy: {
    evaluationIntervalMs: 1_000,
    maxSignalAgeMs: 5_000,
    consecutiveSamples: 2,
    minimumModeDurationMs: 5_000,
    budgets: [
      {
        id: "heap-pressure",
        signal: "process.memory.heapUsed",
        limit: 512 * 1024 * 1024,
        recoverBelow: 384 * 1024 * 1024,
        tierReduction: 2,
      },
    ],
  },
});

const { value, metadata } = await runtime.run({
  operationId: "catalog-search",
  input: {
    query: "wireless",
    corpus: ["wireless keyboard", "wired keyboard", "wireless mouse"],
  },
  strategies: [exact, approximate],
});

console.info(metadata.strategyId, value.matches);
await runtime.close();
```

**Why it works:** the budget reduces the target tier from `3` to `1` while
pressure is engaged. Selection then chooses the highest eligible strategy at or
below the target, which is `sampled-search`. When the budget releases, the exact
strategy is eligible again.

**Watch out:**

- `ProcessMemoryProvider` is process-local. It is not host or container memory.
- The budget is a selection threshold, not an operating-system limit.
- The structural quality check cannot prove recall. It only checks that returned
  items match the query. Measure missed matches against the exact result.
- The runtime does not choose based on measured latency. If latency must drive
  selection, expose it as an explicit signal with a provider, or keep that choice
  outside the runtime.
- If approximate output is never acceptable for a particular request, use a
  separate operation id with a pin, or an applicability rule, instead of lowering
  its declared tier.

## 2. Correctness-sensitive pins

**Use when** one operation must always use a particular implementation, such as a
billing close, an audit replay, or a compliance export. A pin is an explicit
manual override, not a quality measurement.

```ts
import { createAdaptiveRuntime, type Strategy } from "adaptive-runtime";

interface Invoice {
  readonly lines: readonly {
    readonly quantity: number;
    readonly unitPrice: number;
  }[];
}

const invoiceStrategies: readonly Strategy<Invoice, number>[] = [
  {
    id: "exact-total",
    qualityTier: 2,
    run: ({ input }) =>
      input.lines.reduce(
        (sum, line) => sum + line.quantity * line.unitPrice,
        0,
      ),
  },
  {
    id: "rounded-total",
    qualityTier: 1,
    isApplicable: ({ input }) =>
      input.lines.every((line) => Number.isInteger(line.unitPrice)),
    run: ({ input }) =>
      Math.round(
        input.lines.reduce(
          (sum, line) => sum + line.quantity * line.unitPrice,
          0,
        ),
      ),
  },
];

const runtime = createAdaptiveRuntime();

runtime.pinStrategy("invoice-close", "exact-total");

const invoice: Invoice = {
  lines: [
    { quantity: 2, unitPrice: 19.99 },
    { quantity: 1, unitPrice: 5.5 },
  ],
};

const { value, metadata } = await runtime.run({
  operationId: "invoice-close",
  input: invoice,
  strategies: invoiceStrategies,
});

console.info(metadata.decision.kind, metadata.strategyId, value);

runtime.unpinStrategy("invoice-close");
await runtime.close();
```

**Why it works:** a pin bypasses quality pressure, `minQualityTier`,
`maxQualityTier`, and `minimumModeDurationMs`. The pinned strategy must still
exist and pass its `isApplicable` check.

**Watch out:**

- An invalid pin fails the run with `PinnedStrategyError`. There is no silent
  fallback to another strategy.
- A pin applies to every future run of that `operationId`, not to one request. If
  only some inputs need the exact path, use `isApplicable` or a separate operation
  id instead.
- Pins are not persisted. Reapply them after a restart, and use
  `unpinStrategy(operationId)` to return to automatic selection.
- `setAdaptationEnabled(operationId, false)` is weaker: it ignores budgets and
  selects the highest applicable tier allowed by the floor and ceiling. A pin
  takes precedence over that setting.
- Pinning a strategy does not make its implementation correct. Keep the exact
  path under tests.

## 3. Per-operation adaptation

**Use when** different workloads need different risk profiles: an interactive
search may adapt, while a nightly reconciliation must not.

```ts
import {
  createAdaptiveRuntime,
  ProcessMemoryProvider,
  type Strategy,
} from "adaptive-runtime";

const runtime = createAdaptiveRuntime({
  providers: [new ProcessMemoryProvider()],
  policy: {
    budgets: [
      {
        id: "heap-pressure",
        signal: "process.memory.heapUsed",
        limit: 512 * 1024 * 1024,
        recoverBelow: 384 * 1024 * 1024,
        tierReduction: 1,
      },
    ],
  },
});

runtime.setAdaptationEnabled("interactive-search", true);
runtime.setAdaptationEnabled("nightly-reconcile", false);

const strategies: readonly Strategy<readonly number[], number>[] = [
  {
    id: "sum-all",
    qualityTier: 2,
    run: ({ input }) => input.reduce((sum, value) => sum + value, 0),
  },
  {
    id: "sum-first",
    qualityTier: 1,
    run: ({ input }) =>
      input.slice(0, 2).reduce((sum, value) => sum + value, 0),
  },
];

console.info(runtime.getDecision("nightly-reconcile")); // null before the first run

const result = await runtime.run({
  operationId: "nightly-reconcile",
  input: [1, 2, 3, 4],
  strategies,
});

console.info(result.metadata.decision.kind); // "static"

// At shutdown, after in-flight runs settle:
await runtime.close();
```

**Why it works:** adaptation can be switched per operation without changing the
global policy. With adaptation disabled, the runtime ignores budgets and chooses
the highest applicable strategy allowed by `minQualityTier` and
`maxQualityTier`. The decision kind is `static`.

**Watch out:**

- `operationId` is the state key. Using one id for two workloads shares budgets,
  mode history, pins, and stats, so pressure from one affects the other.
- Use stable, low-cardinality ids. The runtime bounds tracked operations using
  `maxTrackedOperations` (default: 1,000) with LRU eviction for unpinned, idle
  operations. Proactively release completed or retired operations using
  `runtime.removeOperation(operationId)`.
- `setAdaptationEnabled` expects a boolean; any other value throws
  `ConfigurationError`. Calling it after `close()` throws `RuntimeClosedError`.
- The override is in memory only. Reapply it at startup after a restart.
- `getDecision` returns `null` until the operation has been evaluated at least
  once. Decisions are retained after failures and after `close()`.

## 4. Batching and sampled signals

**Use when** many small items would otherwise trigger a provider read and a
selection per item, or when pressure changes slowly enough that re-reading on
every run is wasted work.

```ts
import {
  createAdaptiveRuntime,
  EventLoopDelayProvider,
  type Strategy,
} from "adaptive-runtime";

const runtime = createAdaptiveRuntime({
  providers: [new EventLoopDelayProvider()],
  policy: {
    evaluationIntervalMs: 500,
    maxSignalAgeMs: 5_000,
    budgets: [
      {
        id: "loop-pressure",
        signal: "eventLoop.delay.p95",
        limit: 40,
        recoverBelow: 20,
        tierReduction: 1,
      },
    ],
  },
});

const strategies: readonly Strategy<readonly number[], number>[] = [
  {
    id: "sum-all",
    qualityTier: 2,
    run: ({ input }) => input.reduce((sum, value) => sum + value, 0),
  },
  {
    id: "sum-sample",
    qualityTier: 1,
    run: ({ input }) =>
      input.slice(0, 2).reduce((sum, value) => sum + value, 0),
  },
];

const batches = [
  [1, 2, 3],
  [4, 5, 6],
  [7, 8, 9],
];

const totals: number[] = [];

for (const batch of batches) {
  const { value, metadata } = await runtime.run({
    operationId: "batch-sum",
    input: batch,
    strategies,
  });

  totals.push(value);
  console.info(metadata.strategyId, metadata.decision.signalsCached);
}

await runtime.close();
```

**Why it works:** each run processes a whole batch, so one selection covers many
items. `evaluationIntervalMs` lets later runs reuse a snapshot; the decision's
`signalsCached` flag tells you when that happened. The default `"hold"` behavior
keeps the previous budget state if the event-loop signal is temporarily
unavailable.

**Watch out:**

- `evaluationIntervalMs` controls freshness, not staleness. A cached snapshot
  still ages. Keep `maxSignalAgeMs` consistent with the cache interval you intend
  to use, or readings can become `stale`.
- If you need a decision per item, call `run` per item. Selection is serialized
  for the same `operationId`, while execution can overlap. The runtime does not
  bound concurrency; add admission control in the application if needed.
- `EventLoopDelayProvider` measures scheduling delay, not CPU utilization, and it
  does not observe worker threads or other processes.
- Batching changes the unit of timeout and cancellation. Choose `timeoutMs` for
  the batch, not for one item.

## 5. Missing signals

**Use when** a measurement source can be absent, slow, unsupported, or broken,
and you need a deliberate policy instead of a crash or a fake zero.

```ts
import {
  createAdaptiveRuntime,
  type SignalProvider,
  type Strategy,
} from "adaptive-runtime";

const unavailableMemory: SignalProvider = {
  id: "unavailable-memory",
  signals: [{ name: "process.memory.heapUsed", unit: "bytes" }],
  read: ({ now }) => [
    {
      name: "process.memory.heapUsed",
      unit: "bytes",
      status: "error",
      observedAt: now,
      error: "Simulated measurement failure.",
    },
  ],
};

const strategies: readonly Strategy<readonly number[], number>[] = [
  {
    id: "sum-all",
    qualityTier: 2,
    run: ({ input }) => input.reduce((sum, value) => sum + value, 0),
  },
  {
    id: "sum-first",
    qualityTier: 1,
    run: ({ input }) =>
      input.slice(0, 2).reduce((sum, value) => sum + value, 0),
  },
];

const runtime = createAdaptiveRuntime({
  providers: [unavailableMemory],
  policy: {
    missingSignalBehavior: "fallback",
    fallbackStrategyId: "sum-first",
    budgets: [
      {
        id: "heap-pressure",
        signal: "process.memory.heapUsed",
        limit: 512 * 1024 * 1024,
        tierReduction: 1,
      },
    ],
  },
});

const result = await runtime.run({
  operationId: "sum-with-fallback",
  input: [1, 2, 3, 4],
  strategies,
});

console.info(result.metadata.decision.kind);
console.info(result.metadata.decision.reasons.map((reason) => reason.code));

await runtime.close();
```

**Why it works:** the provider's `error` reading is a normal, validated result,
not a thrown failure. Because the budget signal is unavailable in automatic mode,
the runtime selects the configured fallback before execution and records the
`missing-signal-fallback` reason.

**Watch out:**

- `"hold"` (the default) keeps the previous budget state. It is appropriate for
  transient telemetry gaps, but stale pressure can persist while the signal is
  unavailable.
- `"fallback"` must name an applicable strategy. The fallback bypasses the quality
  floor and ceiling, like a pin, so choose one that is safe at any tier. It is
  selected before execution; it is not a retry.
- `"error"` throws `MissingSignalError`. Use it when operating without telemetry
  is unacceptable.
- `"ignore"` treats affected budgets as disengaged. It can select an expensive
  strategy while pressure is unknown.
- These behaviors apply to automatic selection. Pin and static mode do not fail
  because a budget signal is unavailable.
- Provider failures become readings and do not reject the run by default. Inspect
  `decision.signals` and `provider:error` if you need to alert on them.

## 6. Side effects and idempotency

**Use when** a strategy writes to a database, queue, filesystem, or external API.
The runtime guarantees one invocation, not one successful side effect.

```ts
import { createAdaptiveRuntime, type Strategy } from "adaptive-runtime";

interface WriteInput {
  readonly recordId: string;
  readonly payload: string;
}

const written = new Map<string, string>();

function writeOnce(recordId: string, payload: string): boolean {
  if (written.has(recordId)) {
    return false;
  }
  written.set(recordId, payload);
  return true;
}

const strategies: readonly Strategy<
  WriteInput,
  { readonly inserted: boolean }
>[] = [
  {
    id: "insert-record",
    qualityTier: 1,
    run: ({ input, signal }) => {
      if (signal.aborted) {
        throw new Error("Aborted before the write.");
      }
      return { inserted: writeOnce(input.recordId, input.payload) };
    },
  },
];

const runtime = createAdaptiveRuntime();

const result = await runtime.run({
  operationId: "record-write",
  input: { recordId: "record-42", payload: "value" },
  strategies,
  timeoutMs: 2_000,
});

console.info(result.value.inserted, result.metadata.attempts);
await runtime.close();
```

**Why it works:** the strategy checks the abort signal before touching the sink
and the sink itself de-duplicates by a stable key. The runtime does not retry, so
one `run()` corresponds to one invocation.

**Watch out:**

- A timeout or abort is cooperative. If the strategy is already awaiting a write,
  the write can still complete after the caller sees `OperationTimeoutError` or
  `OperationAbortedError`.
- The in-memory `Map` above is only an illustration. A real sink needs an atomic
  uniqueness constraint or an idempotency key enforced by the store.
- If you retry outside the runtime, reuse the same idempotency key and apply your
  own backoff and amplification limits.
- `checkQuality` runs after execution. A failed check under
  `qualityCheck: "error"` rejects the run but cannot roll back a write. Keep
  quality checks pure and side-effect free.
- `metadata.attempts` is `1`; do not infer that a failed run had no side effects.

## 7. Testing providers and policy deterministically

**Use when** you need a stable test for a budget, a fallback, or a strategy
choice. Inject a fixed provider and a fake clock; never assert on real heap, CPU,
or event-loop values.

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAdaptiveRuntime,
  type Clock,
  type SignalProvider,
} from "adaptive-runtime";

const memoryProvider: SignalProvider = {
  id: "test.memory",
  signals: [{ name: "test.memory.used", unit: "bytes" }],
  read: ({ now }) => [
    {
      name: "test.memory.used",
      unit: "bytes",
      status: "ok",
      value: 200,
      observedAt: now,
    },
  ],
};

const unavailableProvider: SignalProvider = {
  id: "test.unavailable",
  signals: [{ name: "test.memory.used", unit: "bytes" }],
  read: ({ now }) => [
    {
      name: "test.memory.used",
      unit: "bytes",
      status: "unknown",
      observedAt: now,
    },
  ],
};

const clock: Clock = {
  now: () => 1_000,
  setTimeout: () => ({ cancel: () => undefined }),
};

test("selects the economy strategy under test pressure", async () => {
  const runtime = createAdaptiveRuntime({
    providers: [memoryProvider],
    clock,
    policy: {
      evaluationIntervalMs: 0,
      consecutiveSamples: 1,
      budgets: [
        {
          id: "test-pressure",
          signal: "test.memory.used",
          limit: 100,
          tierReduction: 1,
        },
      ],
    },
  });

  try {
    const result = await runtime.run({
      operationId: "test-operation",
      input: null,
      strategies: [
        { id: "exact", qualityTier: 2, run: () => "exact" },
        { id: "economy", qualityTier: 1, run: () => "economy" },
      ],
    });

    assert.equal(result.metadata.strategyId, "economy");
    assert.equal(result.metadata.attempts, 1);
    assert.equal(result.metadata.decision.budgets[0]?.engaged, true);
  } finally {
    await runtime.close();
  }
});

test("does not invent a value for an unavailable reading", async () => {
  const readings = await unavailableProvider.read({
    now: 1_000,
    signal: new AbortController().signal,
  });

  assert.equal(readings[0]?.status, "unknown");
  assert.equal("value" in readings[0]!, false);
});
```

**Why it works:** the fixed reading makes the budget transition deterministic.
`evaluationIntervalMs: 0` forces a fresh read, and the first sample above the
limit engages the budget immediately. The assertions cover the selected
strategy, the single attempt, and the budget state.

**Watch out:**

- Keep provider tests direct as well: assert `status`, `unit`, `observedAt`, and
  the absence of `value` for unavailable readings.
- Do not assert on real process measurements. They vary by machine and test
  ordering.
- Test the failure paths too: provider throw, provider timeout, malformed output,
  caller abort, and strict quality failure. Provider authoring guidance is in
  [PROVIDERS.md](PROVIDERS.md).
- A provider read is rejected as a whole when it returns an undeclared signal, a
  duplicate, or a unit that differs from its descriptor. Tests should cover that
  shape validation.
- `isApplicable` and `checkQuality` run on the runtime path without independent
  timeouts. Keep them fast and non-blocking.
- The fake timer above never fires. That is safe because the test provider
  resolves synchronously; use a controllable timer when testing provider
  timeouts.

## 8. Observability from decisions, events, and stats

**Use when** you need to explain why a strategy ran, alert on provider failures,
or track how often the runtime degrades.

```ts
import {
  AdaptiveRuntimeError,
  createAdaptiveRuntime,
} from "adaptive-runtime";

const runtime = createAdaptiveRuntime();

runtime.on("decision", ({ decision }) => {
  console.info("adaptive.decision", {
    operationId: decision.operationId,
    strategyId: decision.strategyId,
    kind: decision.kind,
    changed: decision.changed,
    reasons: decision.reasons.map((reason) => reason.code),
    signals: decision.signals.map(({ name, status }) => ({ name, status })),
    budgets: decision.budgets.map(({ id, engaged }) => ({ id, engaged })),
    cached: decision.signalsCached,
  });
});

runtime.on("run:success", ({ metadata }) => {
  console.info("adaptive.run_success", {
    operationId: metadata.operationId,
    strategyId: metadata.strategyId,
    durationMs: metadata.durationMs,
    quality: metadata.quality.status,
  });
});

runtime.on("run:error", ({ operationId, strategyId, error, durationMs }) => {
  console.warn("adaptive.run_error", {
    operationId,
    strategyId,
    durationMs,
    code: error instanceof AdaptiveRuntimeError ? error.code : error.name,
  });
});

runtime.on("provider:error", ({ providerId, error }) => {
  console.warn("adaptive.provider_error", {
    providerId,
    code: error instanceof AdaptiveRuntimeError ? error.code : error.name,
  });
});

const stats = runtime.getStats("catalog-search");
console.info("adaptive.stats", {
  runs: stats.runs,
  successes: stats.successes,
  failures: stats.failures,
  averageDurationMs: stats.averageDurationMs,
  strategyRuns: stats.strategyRuns,
});
```

Keep this runtime alive for the process lifetime; the snippet installs listeners
and does not close it. Call `await runtime.close()` at shutdown after in-flight
runs settle.

**Why it works:** every selection emits a `decision` with stable reason codes,
signal statuses, and budget states. `run:success` and `run:error` cover outcomes,
`provider:error` covers contained provider failures, and `getStats` provides
cumulative counters for one operation.

**Watch out:**

- Listeners are synchronous and run on the hot path. Keep them cheap. A listener
  exception is caught and emitted as `listener:error`; it does not fail the run.
- Events are best-effort and in-process, not a durable audit log.
- `getStats()` resets when the runtime is recreated. `runs` includes runs that
  fail during selection; `strategyRuns` increments when a strategy is selected,
  before execution.
- Use stable reason codes and bounded labels. Do not label metrics with error
  messages, signal details, quality details, or raw user input.
- If you export signal values, emit a value only when `status === "ok"`. Never
  record an unavailable status as `0`.
- Suggested metric names and mappings are in [OBSERVABILITY.md](OBSERVABILITY.md).
  They are suggestions, not runtime exports.

## 9. Input-dependent eligibility

**Use when** eligibility depends on the input itself, such as corpus size or
document type, rather than on resource pressure. Do not encode an input-size rule
as a fake signal.

```ts
import { createAdaptiveRuntime, type Strategy } from "adaptive-runtime";

interface Query {
  readonly text: string;
  readonly corpus: readonly string[];
}

const strategies: readonly Strategy<Query, readonly string[]>[] = [
  {
    id: "exact-scan",
    qualityTier: 2,
    isApplicable: ({ input }) => input.corpus.length <= 10_000,
    run: ({ input }) =>
      input.corpus.filter((item) => item.includes(input.text)),
  },
  {
    id: "sampled-scan",
    qualityTier: 1,
    isApplicable: ({ input }) => input.corpus.length > 10_000,
    run: ({ input }) =>
      input.corpus
        .slice(0, Math.max(1, Math.floor(input.corpus.length * 0.1)))
        .filter((item) => item.includes(input.text)),
  },
];

const runtime = createAdaptiveRuntime();

const result = await runtime.run({
  operationId: "query",
  input: {
    text: "wireless",
    corpus: ["wireless keyboard", "wired mouse"],
  },
  strategies,
});

console.info(result.metadata.strategyId);
await runtime.close();
```

**Why it works:** `isApplicable` filters candidates before policy selection.
With a small corpus, only `exact-scan` is applicable; with a large corpus, only
`sampled-scan` is. No provider or budget is needed.

**Watch out:**

- `isApplicable` must be synchronous and return a boolean. A throw or a non-boolean
  result fails the run with `StrategyApplicabilityError`.
- If no strategy is applicable, the run fails with `NoEligibleStrategyError`.
- A pin bypasses pressure and tier bounds but not applicability. Pinning a
  strategy that is not applicable fails with `PinnedStrategyError`.
- Applicability is a hard filter, not a pressure policy. It has no hysteresis,
  sample count, or mode duration. Use a budget when you need gradual adaptation.
- Keep `isApplicable` pure and fast; it runs for every strategy on every run.

## Related documents

- [API reference](API.md)
- [API design notes](API_DESIGN.md)
- [Migration guide](MIGRATION.md)
- [Provider authoring](PROVIDERS.md)
- [Observability](OBSERVABILITY.md)
- [Architecture](ARCHITECTURE.md)
- [Threat model](THREAT_MODEL.md)
- [README](../README.md)
- [Quick start example](../examples/quick-start/quick-start.ts)
- [Basic example](../examples/basic/basic.ts)
- [Resource-aware search example](../examples/resource-aware-search/search.ts)
- [Resource-pressure planning example](../examples/resource-pressure-planning/planning.ts)
- [Scripted signal provider](../examples/shared/scripted-signal-provider.ts)
- [ADR 0002: deterministic tier policy](adr/0002-deterministic-tier-policy.md)
- [ADR 0003: single attempt and cooperative cancellation](adr/0003-single-attempt-cooperative-cancellation.md)
- [ADR 0004: explicit signal statuses](adr/0004-explicit-signals-provider-isolation.md)
- [ADR 0005: ref-counted shared reads](adr/0005-ref-counted-shared-reads.md)
