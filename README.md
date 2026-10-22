# Adaptive Runtime

<p align="center">
  <a href="https://github.com/yusufgulerr/adaptive-runtime/actions/workflows/ci.yml">
    <img alt="CI" src="https://github.com/yusufgulerr/adaptive-runtime/actions/workflows/ci.yml/badge.svg?branch=main">
  </a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/yusufgulerr/adaptive-runtime">
    <img alt="OpenSSF Scorecard" src="https://api.scorecard.dev/projects/github.com/yusufgulerr/adaptive-runtime/badge">
  </a>
  <a href="LICENSE">
    <img alt="License: Apache-2.0" src="https://img.shields.io/github/license/yusufgulerr/adaptive-runtime">
  </a>
  <img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg">
  <a href="https://github.com/yusufgulerr/adaptive-runtime/commits/main">
    <img alt="Last commit" src="https://img.shields.io/github/last-commit/yusufgulerr/adaptive-runtime">
  </a>
</p>

A deterministic, zero-dependency, low-overhead TypeScript runtime for dynamic
algorithmic strategy orchestration under resource budgets and explicit system
signals.

Instead of hard-coding one search, planner, encoder, or scheduler, you register
strategies with declared quality and cost tiers. The runtime reads the signals
you supply, applies a deterministic policy, and runs exactly one strategy with
inspectable metadata explaining the choice.

> **Status: v0.3.0 source line.** The public repository is live and its baseline
> passes CI/CodeQL on Node.js 22, 24, and 26, plus OpenSSF Scorecard on `main`.
> The 0.3.0 tree provides a verified multi-runtime core for Node.js, browsers, and
> WinterCG edge runtimes with **zero runtime dependencies** and a fully typed ESM
> surface. It includes web and edge signal providers, composite signals, custom
> policy selectors, an in-memory OpenTelemetry-compatible metrics bridge with
> Prometheus exposition, and a testing SDK. The 0.3.0 tree is verified locally and
> on remote CI/CodeQL. The public API follows semantic versioning; the 0.x series
> may still make documented breaking changes. GitHub releases are tag-driven; npm
> publication is a separate owner-approved OIDC/provenance dispatch and is pending.
> See [Architectural boundaries](#architectural-boundaries-and-operational-notes).

## Why

Many applications contain a fast/approximate path and a slow/exact path. The
choice is often a flag, an environment variable, or an ad-hoc `if` on
`process.memoryUsage()`. Adaptive Runtime makes that choice:

- **explicit** — strategies declare quality/cost tiers; budgets name signals;
- **deterministic** — same inputs, policy state, and clock produce the same decision;
- **stable** — hysteresis, consecutive samples, and a minimum mode duration avoid flapping;
- **inspectable** — every run returns the signal snapshot, budget states, reasons, and mode history;
- **safe at the edges** — missing, stale, unsupported, timed-out, and failed readings are distinct;
- **portable by construction** — one platform-neutral core with Node.js, browser, and WinterCG entry points;
- **low-overhead & zero-dependency** — sub-10µs dispatch overhead, ESM-native, built strictly on standard platform primitives with zero external supply-chain risk.

It is **not** a sandbox, a scheduler, an autoscaler, or a verifier of algorithmic
correctness. Strategies are trusted code supplied by the application.

## Requirements

| Item | Supported |
| --- | --- |
| Node.js | `>=22.0.0` (`engines`) |
| Browsers | Modern evergreen browsers with ESM (web providers use structural globals) |
| Edge / WinterCG | Cloudflare Workers, Vercel Edge, Deno, Bun, and compatible runtimes |
| Local verification | Node.js 24.15.0, npm 11.12.1 |
| CI matrix | Node.js 22, 24, and 26 |
| Module system | ESM only |
| Runtime dependencies | none |
| TypeScript | declarations and self-contained source maps; `>=5.0` for the emitted `const` type parameter |

Node.js 22 and 24 are the active LTS lines, and Node.js 26 is included in the
verification matrix as the next LTS transition. The locally verified runtime is
24.15.0; CI exercises all three lines. See [docs/ROADMAP.md](docs/ROADMAP.md) for
the support policy.

## Installation

### From the repository (current)

```bash
git clone https://github.com/yusufgulerr/adaptive-runtime.git
cd adaptive-runtime
npm ci
npm run build
```

The package is ESM-only and requires Node.js 22 or newer. For development, run
`npm ci` and use the commands in [Development](#development).

### From npm (after the verified release)

```bash
npm install adaptive-runtime
```

Registry publication uses a separate, owner-approved OIDC/provenance workflow
dispatch against the release tag. Until that workflow has completed and the
registry artifact is verified, use the repository installation above. See
[docs/RELEASING.md](docs/RELEASING.md) and
[docs/VERIFICATION.md](docs/VERIFICATION.md) for the release evidence.

## Configuration

Adaptive Runtime does not read environment variables and has no `.env` contract.
Configure strategies, providers, budgets, and policy explicitly in code with
`createAdaptiveRuntime` and `definePolicy`. Keep application secrets in your own
environment; `.env` files are ignored by this repository.

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
npm run example:edge
```

| Example | Demonstrates | Deterministic sequence |
| --- | --- | --- |
| `examples/basic` | One provider, two strategies, one budget, quality check | `high-quality` or `economy` |
| `examples/resource-aware-search` | Recall/work trade-off under simulated heap pressure | `exhaustive, balanced, balanced, economy, economy, exhaustive` |
| `examples/resource-pressure-planning` | Two budgets, hysteresis, stability gate, recovery | `optimal, optimal, optimal, economy, economy, economy, economy, optimal` |
| `examples/observability` | Event-to-metrics mapping with an in-memory sink | one success plus one pinned failure |
| `examples/multi-runtime-edge` | Core + edge + observability only: execution budget, composite pressure signal, three-tier ladder, Prometheus text | `deep-rerank, deep-rerank, fast-vector, cached-lexical, deep-rerank` |

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
9. **Apply the custom selector** (if configured) to the eligible candidate set,
   validate its choice, and record a `custom-selector` reason.
10. **Stabilize** switches with `minimumModeDurationMs` and `consecutiveSamples`.
11. **Execute** the strategy once, optionally run `checkQuality`, and return metadata.

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

Node.js providers are available from the root entry point and from
`adaptive-runtime/node`. Web and edge providers live in their own subpaths so a
bundler never pulls Node.js built-ins into a browser or worker build.

| Provider | Entry point | Signals | Notes |
| --- | --- | --- | --- |
| `ProcessMemoryProvider` | root, `/node` | `process.memory.heapUsed`, `process.memory.rss` | This process only |
| `CpuUtilizationProvider` | root, `/node` | `process.cpu.utilization` | Ratio relative to one core; can exceed 1; first read is `unknown` |
| `EventLoopDelayProvider` | root, `/node` | `eventLoop.delay.p95` (configurable) | Scheduling delay, not CPU percentage |
| `NetworkLatencyProvider` | root, `/core`, `/node` | `network.latency` | Requires an application-supplied probe; the library creates no traffic |
| `DeviceMemoryProvider` | `/web` | `web.device.memoryGib`, `web.jsHeap.usedRatio` | Reads structural `navigator`/`performance` globals; unavailable fields stay explicit |
| `NetworkInformationProvider` | `/web` | `web.network.rttMs`, `web.network.downlinkMbps`, `web.network.saveData` | W3C Network Information API; `saveData` is `1`/`0` |
| `FrameTimingProvider` | `/web` | `web.frame.durationP95Ms`, `web.frame.droppedRatio` | Sliding frame window; call `recordFrameDuration()` from your render loop |
| `ExecutionBudgetProvider` | `/edge` | `edge.execution.remainingMs`, `edge.execution.usedRatio`, `edge.concurrency.saturation` | App-supplied wall-clock and concurrency snapshot; ideal for serverless deadlines |
| `CompositeSignalProvider` | root, `/core`, `/edge` | Derived names and units from rules | Combines child provider readings; propagates `error` > `stale` > `unsupported` > `unknown` and never coerces unavailable inputs |

You may implement `SignalProvider` directly. Providers are started lazily before
their first read and closed by `runtime.close()`. See
[docs/PROVIDERS.md](docs/PROVIDERS.md) for the authoring guide, web/edge
examples, composite rules, and the conformance test helper.

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
| `removeOperation(operationId)` | Remove retained state, pins, overrides, and stats; returns `false` while a selection/run is active |
| `resetStats(operationId?)` | Reset counters for one operation, or all operations when no id is given |
| `on(event, listener)` | Subscribe; returns an unsubscribe function |
| `close()` | Close providers and reject new runs |

Set `policy.maxTrackedOperations` to bound per-operation state. The runtime keeps
insertion order as an LRU list, refreshes it on access, and evicts the
least-recently-used operation that is not pinned, selecting, or executing.
Manual pins and in-flight work are never evicted, so a workload that pins every
operation can temporarily exceed the bound.

State can also be released explicitly with `removeOperation(operationId)`, which
returns `false` while that operation is selecting or executing. `resetStats()`
clears counters without discarding decisions, pins, or policy state.

### Subpath exports

The package exposes platform-targeted entry points for narrow dependency graphs:

```ts
import { createAdaptiveRuntime, CompositeSignalProvider } from "adaptive-runtime/core";
import { ProcessMemoryProvider, EventLoopDelayProvider } from "adaptive-runtime/node";
import { DeviceMemoryProvider, FrameTimingProvider } from "adaptive-runtime/web";
import { ExecutionBudgetProvider } from "adaptive-runtime/edge";
import { createMetricsCollector } from "adaptive-runtime/observability";
import { createFakeClock, ScriptedSignalProvider } from "adaptive-runtime/testing";
```

| Subpath | Contents | Portable? |
| --- | --- | --- |
| `adaptive-runtime` | Core plus Node.js providers | No (Node.js) |
| `adaptive-runtime/core` | Runtime, errors, types, policy helper, network latency, composite signals | Yes |
| `adaptive-runtime/node` | Core plus process, CPU, and event-loop providers | No (Node.js) |
| `adaptive-runtime/web` | Core plus browser providers | Yes |
| `adaptive-runtime/edge` | Core plus execution-budget provider | Yes |
| `adaptive-runtime/policy` | Pure policy types, resolution, and evaluation | Yes |
| `adaptive-runtime/providers` | Every built-in provider, including Node.js | No (mixed) |
| `adaptive-runtime/observability` | In-memory metrics collector, Prometheus text, OpenTelemetry meter bridge | Yes |
| `adaptive-runtime/testing` | Fake clock, scripted provider, conformance runner | Yes |
| `adaptive-runtime/package.json` | Package metadata | n/a |

The `/core`, `/web`, `/edge`, `/policy`, `/observability`, and `/testing`
subpaths import no Node.js built-ins and never read the Node.js `process`
object. Prefer `/providers` only when a Node.js build genuinely needs every
provider; platform bundles should use `/core`, `/web`, or `/edge`.

The root entry point remains the recommended surface for Node.js applications.

Events: `decision`, `run:start`, `run:success`, `run:error`, `provider:error`,
`listener:error`, `runtime:closed`. Listener exceptions are isolated and reported
through `listener:error`; they do not fail the run.

`definePolicy(policy)` is an optional identity helper that preserves the literal
type of a policy object for editor completion; it does not validate or clone.

A custom selector can refine the automatic choice without bypassing
applicability, quality bounds, or the stability gates:

```ts
const runtime = createAdaptiveRuntime({
  policy: definePolicy({
    budgets: [/* ... */],
    customSelector: ({ candidates }) =>
      candidates.find((candidate) => candidate.id === "fast-vector")?.id,
  }),
});
```

The full type and error reference is in [docs/API.md](docs/API.md). Design
rationale is in [docs/API_DESIGN.md](docs/API_DESIGN.md), custom provider
guidance is in [docs/PROVIDERS.md](docs/PROVIDERS.md), metrics guidance is in
[docs/OBSERVABILITY.md](docs/OBSERVABILITY.md), common patterns are in
[docs/COOKBOOK.md](docs/COOKBOOK.md), fuzzing is covered in
[docs/FUZZING.md](docs/FUZZING.md), and adoption/upgrade guidance is in
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
- Providing a DOM, fetch, or telemetry implementation; web and edge providers adapt
  to the structural globals your runtime already exposes.

## Benchmarks

A local micro-benchmark is in
[`benchmarks/runtime-overhead.ts`](benchmarks/runtime-overhead.ts). On the
verification machine (Node 24.15.0, Intel Core Ultra 5 225H), median per-run
cost was approximately:

| Mode | µs/run | Relative to direct |
| --- | ---: | ---: |
| Direct call | 0.310 | 1.00x |
| Runtime, static policy | 4.026 | 12.99x |
| Runtime, adaptive, fresh read | 9.340 | 30.15x |
| Runtime, adaptive, cached read | 4.632 | 14.95x |

These numbers measure runtime overhead on one machine, not total application
throughput. A separate concurrency/memory observation is in
[`benchmarks/concurrency.ts`](benchmarks/concurrency.ts); 64 concurrent callers
shared one in-flight provider read. See [docs/BENCHMARKS.md](docs/BENCHMARKS.md)
for methodology and caveats.

## Development

```bash
npm install
npm run format      # Biome formatter
npm run lint        # Biome
npm run typecheck   # tsc, includes tests/examples/benchmarks
npm test            # node:test, 313 tests
npm run test:fuzz   # deterministic property/fuzz campaign
npm run test:coverage
npm run build       # emit ESM + declarations to dist/
npm run verify:exports  # import every built subpath and check named exports
npm run verify:zero-deps  # fail if package.json or the lockfile adds a runtime dependency
npm run check:links       # fail on broken relative Markdown links
npm run example:edge
npm run benchmark
npm run benchmark:concurrency
npm pack --dry-run  # inspect the package file set
npm run check       # lint + typecheck + test + build + verification gates
```

CI runs the suite on Node.js 22, 24, and 26 on Linux plus Windows and macOS. A
separate [Security and documentation workflow](.github/workflows/security.yml)
also verifies that `package.json` and `package-lock.json` contain no runtime
dependencies, audits production dependencies at high severity, and checks every
relative Markdown link on pull requests and `main`.

Coverage from the verification run: **99.08% lines, 96.93% branches, 98.68%
functions** across `src/`, with every source file above 80% branch coverage.
The property/fuzz suite uses `fast-check` as a dev-only dependency and covers
budget hysteresis, candidate ordering, pure policy evaluation, and the
exactly-one-execution runtime invariant. See
[docs/FUZZING.md](docs/FUZZING.md) for the local campaign controls, scheduled
workflow, and scope limits, and [docs/VERIFICATION.md](docs/VERIFICATION.md) for
the exact commands and results.

## Project layout

```text
src/
  core.ts      platform-neutral entry point
  node.ts      Node.js entry point
  web.ts       browser entry point
  edge.ts      WinterCG/serverless entry point
  policy/      pure decision engine and policy resolution
  providers/   Node.js, web, edge, and composite signal providers
  runtime/     orchestration, execution, events, stats
  signals/     provider lifecycle, caching, timeouts, validation
  observability/ in-memory metrics and OpenTelemetry/Prometheus bridge
  testing/     fake clock, scripted provider, conformance runner
  types/       public contracts
  errors/      public error classes
examples/      runnable examples
tests/         unit and integration tests
benchmarks/    local overhead micro-benchmark
docs/          architecture, API, API design, provider/observability guides,
               cookbook, fuzzing guide, migration guide, release runbook,
               GitHub settings, ADRs, roadmap
```

## Architectural Boundaries and Operational Notes

The runtime is designed for production services that need deterministic
degradation behavior, with explicit boundaries the application remains
responsible for:

- Budgets are soft selection thresholds, not OS resource limits.
- Quality tiers are declarations; the optional check only relays pass/fail.
- Timeouts cannot preempt synchronous or uncooperative code.
- `isApplicable` and `checkQuality` run on the runtime path without independent
  timeouts; keep them fast and non-blocking.
- A run queued behind another selection for the same operation id waits for that
  selection even if the queued caller aborts; cancellation is observed when the
  lock is released.
- Decision state is per process and in memory; it is not persisted or
  coordinated. Bound it with `maxTrackedOperations` or release it with
  `removeOperation`.
- The public source repository is at
  <https://github.com/yusufgulerr/adaptive-runtime>; the 0.3.0 tree passes CI,
  CodeQL, and Scorecard there. See
  [docs/VERIFICATION.md](docs/VERIFICATION.md) for the verification record.

See [docs/ROADMAP.md](docs/ROADMAP.md) and [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Security

Do not report vulnerabilities in a public issue. Use the repository's private
**Security → Report a vulnerability** flow and read [SECURITY.md](SECURITY.md).
The runtime is not a sandbox; treat strategies and providers as trusted code.

## OpenSSF Best Practices

The passing-level self-assessment, evidence map, and BadgeApp application
checklist are in
[docs/OPENSSF_BEST_PRACTICES.md](docs/OPENSSF_BEST_PRACTICES.md). The project has
not registered for or earned the badge, so no badge is claimed.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md),
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and [SECURITY.md](SECURITY.md). Project
roles, review rules, and access policy are in [GOVERNANCE.md](GOVERNANCE.md).
Repository settings and the exact review gate are documented in
[docs/GITHUB_SETTINGS.md](docs/GITHUB_SETTINGS.md). Pull request titles are
validated against the Conventional Commits format in CI.

## Citation

If you use Adaptive Runtime in academic or technical work, cite it using the
metadata in [CITATION.cff](CITATION.cff). GitHub exposes the same metadata through
the repository's **Cite this repository** action.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
