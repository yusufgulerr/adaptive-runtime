# Adaptive Runtime

A small, dependency-free TypeScript runtime that selects between **your own**
algorithmic strategies using explicit resource signals and policy.

Instead of hard-coding one search, planner, encoder, or scheduler, you register
strategies with declared quality and cost tiers. The runtime reads the signals
you supply, applies a deterministic policy, and runs exactly one strategy with
inspectable metadata explaining the choice.

> **Status: v0.1.0 MVP.** Published on npm as `adaptive-runtime`. It has not
> been hardened for production traffic. See
> [Status and limitations](#status-and-limitations).

## Why

Many applications contain a fast/approximate path and a slow/exact path. The
choice is often a flag, an environment variable, or an ad-hoc `if` on
`process.memoryUsage()`. Adaptive Runtime makes that choice:

- **explicit** — strategies declare quality/cost tiers; budgets name signals;
- **deterministic** — same inputs, policy state, and clock produce the same decision;
- **stable** — hysteresis, consecutive samples, and a minimum mode duration avoid flapping;
- **inspectable** — every run returns the signal snapshot, budget states, reasons, and mode history;
- **safe at the edges** — missing, stale, unsupported, timed-out, and failed readings are distinct;
- **small** — ESM-only, zero runtime dependencies, Node.js built-ins only.

It is **not** a sandbox, a scheduler, an autoscaler, or a verifier of algorithmic
correctness. Strategies are trusted code supplied by the application.

## Requirements

| Item | Supported |
| --- | --- |
| Node.js | `>=22.0.0` (`engines`) |
| Local verification | Node.js 24.15.0, npm 11.12.1 |
| CI matrix | Node.js 22, 24, and 26 |
| Module system | ESM only |
| Runtime dependencies | none |
| TypeScript | declarations and self-contained source maps; `>=5.0` for the emitted `const` type parameter |

Node.js 22 and 24 are the current LTS lines at the time of this MVP. Node.js 26
was still completing its release transition when the workflow was written; it is
included in CI so the next LTS is exercised, but the locally verified runtime is
24.15.0. See [docs/ROADMAP.md](docs/ROADMAP.md) for the support policy.

## Installation

```bash
npm install adaptive-runtime
```

The package is ESM-only and requires Node.js 22 or newer. For a local checkout,
run `npm install` and use the development commands below.

## Quick start

```ts
import { createAdaptiveRuntime, definePolicy, ProcessMemoryProvider } from "adaptive-runtime";

const runtime = createAdaptiveRuntime({
  providers: [new ProcessMemoryProvider()],
  policy: definePolicy({
    evaluationIntervalMs: 1_000,
    budgets: [
      {
        id: "heap-pressure",
        signal: "process.memory.heapUsed",
        limit: 512 * 1024 * 1024,
        recoverBelow: 384 * 1024 * 1024,
        tierReduction: 1,
      },
    ],
  }),
});

try {
  const { value, metadata } = await runtime.run({
    operationId: "sum-to-n",
    input: 10_000,
    strategies: [
      {
        id: "iterative",
        qualityTier: 2,
        run: ({ input }) => {
          let total = 0;
          for (let index = 1; index <= input; index += 1) total += index;
          return total;
        },
      },
      {
        id: "closed-form",
        qualityTier: 1,
        run: ({ input }) => (input * (input + 1)) / 2,
      },
    ],
  });

  console.log(metadata.strategyId, value);
  // Under the heap limit: "iterative" 50005000
  // Above it:          "closed-form" 50005000
} finally {
  await runtime.close();
}
```

`ProcessMemoryProvider` reports this Node.js process's heap and RSS — not total
system memory. The same program is in
[`examples/quick-start/quick-start.ts`](examples/quick-start/quick-start.ts)
(importing from `src/` so it runs inside the repository).

More complete examples:

```bash
npm install
npm run example:basic
npm run example:search
npm run example:planning
npm run example:observability
```

| Example | Demonstrates | Deterministic sequence |
| --- | --- | --- |
| `examples/basic` | One provider, two strategies, one budget, quality check | `high-quality` or `economy` |
| `examples/resource-aware-search` | Recall/work trade-off under simulated heap pressure | `exhaustive, balanced, balanced, economy, economy, exhaustive` |
| `examples/resource-pressure-planning` | Two budgets, hysteresis, stability gate, recovery | `optimal, optimal, optimal, economy, economy, economy, economy, optimal` |
| `examples/observability` | Event-to-metrics mapping with an in-memory sink | one success plus one pinned failure |

## How selection works

Every `runtime.run()` returns the result of exactly one strategy. No rejected
strategy is retried automatically.

1. **Validate** the operation, strategy ids, tiers, timeout, and abort signal.
2. **Collect signals** (or reuse a snapshot inside `evaluationIntervalMs`).
3. **Apply override precedence**:
   - a manual pin wins over pressure, quality floor/ceiling, and minimum mode
     duration, but not applicability;
   - a configured fallback is used when a required signal is unavailable and the
     behavior is `"fallback"`; it must be applicable and bypasses tier bounds;
   - otherwise, if adaptation is disabled, choose the highest applicable tier.
4. **Filter automatic candidates** with `isApplicable`, `minQualityTier`, and
   `maxQualityTier`.
5. **Update budgets** with hysteresis and consecutive fresh samples.
6. **Compute the target tier**: `baseQualityTier - sum(engaged tierReduction)`.
7. **Clamp** to `minQualityTier` and to the tiers actually available.
8. **Choose** the highest-quality applicable strategy at or below the target
   tier; ties break on lower `costTier`, then code-unit `id` order.
9. **Stabilize** switches with `minimumModeDurationMs` and `consecutiveSamples`.
10. **Execute** the strategy once, optionally run `checkQuality`, and return metadata.

`baseQualityTier` is the highest declared tier across all strategies for the
operation, capped by `maxQualityTier`.

### Budget boundaries

A budget engages when a **fresh** reading is strictly above `limit` and releases
when it is strictly below `recoverBelow`:

| Condition | Effect |
| --- | --- |
| `value > limit` | counts toward engagement |
| `value === limit` | no change |
| `recoverBelow < value < limit` | holds the current state |
| `value === recoverBelow` | no change |
| `value < recoverBelow` | counts toward release |

The first sample for an operation engages immediately when `value > limit`
(there is no prior state to stabilize). Later transitions require
`consecutiveSamples` fresh samples; the default is 2. A cached snapshot that the
operation has already processed (same sequence number) is not applied again and
does not advance policy counters. A cached snapshot that is new to the operation
is processed normally, even if another operation initiated the provider read.

## Signals

A signal is an explicit measurement with a unit, timestamp, and status. Missing
values are **never coerced to zero**.

| Status | Meaning | Counts as usable pressure? |
| --- | --- | --- |
| `ok` | Finite value, no older than `maxSignalAgeMs` | yes |
| `unknown` | Provider cannot determine a value yet | no |
| `unsupported` | Measurement is unavailable on this platform | no |
| `stale` | Reading older than `maxSignalAgeMs` | no |
| `error` | Provider read failed or timed out | no |
| `missing` | No provider returned the declared budget signal | no |

`maxSignalAgeMs` defaults to 5000 ms. Provider reads default to a 1000 ms
timeout (`providerTimeoutMs`); `0` disables the timeout.

### Missing signal behavior

`missingSignalBehavior` applies to unavailable budget signals in automatic mode
(pin and adaptation-disabled modes ignore it):

| Value | Behavior |
| --- | --- |
| `"hold"` (default) | Keep the previous budget state and add `missing-signal-hold` |
| `"fallback"` | Run `fallbackStrategyId` for this decision; error if it is absent or inapplicable |
| `"error"` | Throw `MissingSignalError` |
| `"ignore"` | Treat affected budgets as disengaged and add `missing-signal-ignored` |

### Built-in providers

| Provider | Signals | Notes |
| --- | --- | --- |
| `ProcessMemoryProvider` | `process.memory.heapUsed`, `process.memory.rss` | This process only |
| `CpuUtilizationProvider` | `process.cpu.utilization` | Ratio relative to one core; can exceed 1; first read is `unknown` |
| `EventLoopDelayProvider` | `eventLoop.delay.p95` (configurable) | Scheduling delay, not CPU percentage |
| `NetworkLatencyProvider` | `network.latency` | Requires an application-supplied probe; the library creates no traffic |

You may implement `SignalProvider` directly. Providers are started lazily before
their first read and closed by `runtime.close()`. See
[docs/PROVIDERS.md](docs/PROVIDERS.md) for the authoring guide and a worked
example.

Concurrent runs share one in-flight read per runtime. Cancellation is
**ref-counted**: one caller's abort rejects only that caller; providers are
aborted when every waiting caller has aborted. The initiating caller has no
special cancellation privilege. A read that is aborted by all callers is not
cached.

## API at a glance

```ts
const runtime = createAdaptiveRuntime({ providers, policy, clock, providerTimeoutMs });
```

| Method | Purpose |
| --- | --- |
| `run(operation)` | Select and execute one strategy; returns `{ value, metadata }` |
| `pinStrategy(operationId, strategyId)` | Manual override; bypasses pressure, quality floor/ceiling, and minimum mode duration, not applicability |
| `unpinStrategy(operationId)` | Return to automatic selection |
| `setAdaptationEnabled(operationId, enabled)` | Per-operation static/adaptive override; a pin takes precedence |
| `getDecision(operationId)` | Last decision, or `null` |
| `getStats(operationId)` | Run/success/failure counts, latency, strategy counts |
| `on(event, listener)` | Subscribe; returns an unsubscribe function |
| `close()` | Close providers and reject new runs |

Events: `decision`, `run:start`, `run:success`, `run:error`, `provider:error`,
`listener:error`, `runtime:closed`. Listener exceptions are isolated and reported
through `listener:error`; they do not fail the run.

`definePolicy(policy)` is an optional identity helper that preserves the literal
type of a policy object for editor completion; it does not validate or clone.

The full type and error reference is in [docs/API.md](docs/API.md). Design
rationale is in [docs/API_DESIGN.md](docs/API_DESIGN.md), custom provider
guidance is in [docs/PROVIDERS.md](docs/PROVIDERS.md), metrics guidance is in
[docs/OBSERVABILITY.md](docs/OBSERVABILITY.md), common patterns are in
[docs/COOKBOOK.md](docs/COOKBOOK.md), and adoption/upgrade guidance is in
[docs/MIGRATION.md](docs/MIGRATION.md).

## Error and cancellation semantics

| Situation | Result |
| --- | --- |
| Strategy throws | `StrategyExecutionError`; original error in `cause` |
| Operation timeout | `OperationTimeoutError`; strategy signal is aborted |
| Caller abort | `OperationAbortedError` (`name` is `"AbortError"`) |
| No applicable candidate | `NoEligibleStrategyError` |
| Pinned strategy absent/inapplicable | `PinnedStrategyError` |
| Missing signal with `"error"` | `MissingSignalError` |
| Quality check fails with `qualityCheck: "error"` | `QualityCheckError` |
| Runtime already closed | `RuntimeClosedError` |

Cancellation and timeouts are **cooperative**. The runtime rejects promptly and
aborts the signal passed to the strategy, but it cannot forcibly stop synchronous
code or an uncooperative promise. A timed-out strategy may continue executing and
causing side effects after the caller observes the rejection. A run timeout
covers strategy execution; `metadata.durationMs` covers the whole run, including
selection and quality checks.

## Guarantees

- Exactly one strategy is invoked per `run()`.
- There are no automatic retries, fallbacks on strategy failure, or mid-run switches.
- Selection is deterministic given the same policy, state, signals, and clock values.
- Unavailable readings stay unavailable; they are not converted to `0`.
- Provider and listener failures do not crash the runtime (provider failures
  become error readings).
- `close()` is idempotent and rejects new runs.

## Non-goals

- Sandboxing or isolation of strategy code.
- Enforcing CPU, memory, or network limits.
- Proving that `qualityTier` reflects output quality.
- Choosing a strategy based on measured output correctness or latency percentiles.
- Automatic retries, hedging, or speculative execution.
- Distributed coordination between processes.
- Supporting browsers, Deno, or Bun in the MVP.

## Benchmarks

A local micro-benchmark is in
[`benchmarks/runtime-overhead.ts`](benchmarks/runtime-overhead.ts). On the
verification machine (Node 24.15.0, Intel Core Ultra 5 225H), median per-run
cost was approximately:

| Mode | µs/run | Relative to direct |
| --- | ---: | ---: |
| Direct call | 0.254 | 1.00x |
| Runtime, static policy | 2.759 | 10.86x |
| Runtime, adaptive, fresh read | 6.708 | 26.40x |
| Runtime, adaptive, cached read | 3.071 | 12.09x |

These numbers measure runtime overhead on one machine, not total application
throughput. A separate concurrency/memory observation is in
[`benchmarks/concurrency.ts`](benchmarks/concurrency.ts); 64 concurrent callers
shared one in-flight provider read. See [docs/BENCHMARKS.md](docs/BENCHMARKS.md)
for methodology and caveats.

## Development

```bash
npm install
npm run lint        # Biome
npm run typecheck   # tsc, includes tests/examples/benchmarks
npm test            # node:test, 77 tests
npm run test:coverage
npm run build       # emit ESM + declarations to dist/
npm run benchmark
npm run benchmark:concurrency
npm run check       # lint + typecheck + test + build
```

Coverage from the verification run: **96.52% lines, 87.56% branches, 96.46%
functions** across `src/`. See [docs/VERIFICATION.md](docs/VERIFICATION.md) for
the exact commands and results.

## Project layout

```text
src/
  policy/      pure decision engine and policy resolution
  providers/   Node.js signal providers
  runtime/     orchestration, execution, events, stats
  signals/     provider lifecycle, caching, timeouts, validation
  types/       public contracts
  errors/      public error classes
examples/      runnable examples
tests/         unit and integration tests
benchmarks/    local overhead micro-benchmark
docs/          architecture, API, API design, provider/observability guides,
               cookbook, migration guide, ADRs, roadmap
```

## Status and limitations

This is an MVP suitable for evaluation, prototypes, and further development. It
has not been fuzzed, load-tested, or audited. Known limitations:

- Budgets are soft selection thresholds, not OS resource limits.
- Quality tiers are declarations; the optional check only relays pass/fail.
- Timeouts cannot preempt synchronous or uncooperative code.
- `isApplicable` and `checkQuality` run on the runtime path without independent
  timeouts; keep them fast and non-blocking.
- A run queued behind another selection for the same operation id waits for that
  selection even if the queued caller aborts; cancellation is observed when the
  lock is released.
- Decision state is per process and in memory; it is not persisted or coordinated.
- The package is published on npm, and CI/CodeQL pass on the public repository at
  <https://github.com/yusufgulerr/adaptive-runtime>.

See [docs/ROADMAP.md](docs/ROADMAP.md) and [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md),
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and [SECURITY.md](SECURITY.md). Project
roles, review rules, and access policy are in [GOVERNANCE.md](GOVERNANCE.md).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
