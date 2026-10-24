# Project: Adaptive Runtime — Phase 6 (v0.7.0, 1.0-RC preparation)

## Architecture

Adaptive Runtime is a deterministic, resource-aware execution runtime for
Node.js `>=22`, modern browsers, and WinterCG-compatible edge runtimes. The
0.7.0 line delivers composable policy selectors, non-disturbing runtime
introspection, exact state hydration without floating-point drift, coalesced
in-flight signal reads, configurable quality check bounds, and high-fidelity
timeline simulation, establishing the technical baseline for 1.0.0-RC.

Core principles:

1. **Zero Runtime Dependencies.** Pure TypeScript, structural `*Like`
   interfaces, and no runtime npm dependencies.
2. **Portable Core.** `src/core.ts`, `src/web.ts`, `src/edge.ts`, `src/policy`,
   `src/runtime`, `src/signals`, `src/types`, `src/errors`,
   `src/observability`, `src/testing`, `src/providers/web`,
   `src/providers/edge`, and `src/providers/composite.ts` import no Node.js
   built-ins and never read the Node.js `process` object.
3. **No Zero-Coercion.** Non-ok statuses (`unknown`, `unsupported`, `stale`,
   `error`) remain explicit and are never coerced to `0`.
4. **Deterministic Tie-Breaking.** Code-unit identifier comparison and pure
   policy evaluation; identical inputs and clock values produce identical
   decisions.
5. **Exactly One Execution.** Each `run()` selects and invokes exactly one
   strategy. There are no automatic retries, hedges, fallbacks on strategy
   failure, or mid-run switches.
6. **Bounded State.** `maxTrackedOperations` bounds runtime state,
   `maxSeries` bounds metric families and OpenTelemetry delta maps,
   `maxQualityCheckDetailLength` bounds quality error strings, and
   `removeOperation`/`resetStats` release state without disturbing active work.
7. **Evidence-First Verification.** Source and compiled package surfaces,
   conformance checks, coverage gates, and benchmarks are verified with real
   command output; release and npm claims require completed owner-approved
   commands.

## Public Surfaces

| Subpath | Contents | Portable? |
| --- | --- | --- |
| `adaptive-runtime` | Core plus Node.js providers | No (Node.js) |
| `adaptive-runtime/core` | Runtime, errors, types, policy helper, network latency, composite signals | Yes |
| `adaptive-runtime/node` | Core plus process, CPU, event-loop delay, and event-loop utilization providers | No (Node.js) |
| `adaptive-runtime/web` | Core plus device-memory, network-information, frame-timing, and compute-pressure providers | Yes |
| `adaptive-runtime/edge` | Core plus execution-budget provider | Yes |
| `adaptive-runtime/policy` | Pure policy types, resolution, evaluation, and `definePolicy` | Yes |
| `adaptive-runtime/providers` | Every built-in provider, including Node.js | No (mixed) |
| `adaptive-runtime/observability` | Metrics collector, Prometheus text, OpenTelemetry meter bridge | Yes |
| `adaptive-runtime/testing` | Fake clock, scripted provider, conformance runner, policy timeline simulator | Yes |
| `adaptive-runtime/package.json` | Package metadata | n/a |

## Feature Inventory (v0.5.0 / 0.6.0 / 0.7.0)

| # | Feature | Description | Contract |
| --- | --- | --- | --- |
| 1 | Deterministic tier policy | Quality/cost tier selection with quality bounds and stable hysteresis | ADR 0002 |
| 2 | Budget hysteresis | Per-budget engage/recover thresholds and consecutive-sample gates | ADR 0002 |
| 3 | Custom policy selector | Application hook that refines eligible candidates before stability gates | ADR 0008 |
| 4 | Per-operation policy overrides | `setOperationPolicy` with pin > adaptation > operation > global precedence | ADR 0015 |
| 5 | Abort-aware selection queue | Queued callers reject immediately with `OperationAbortedError` on abort | ADR 0012 |
| 6 | Strategy-level statistics | Per-strategy runs, successes, failures, durations, EWMA latency, and error rate | ADR 0013 |
| 7 | Shadow evaluation | `evaluate()` computes a decision without executing; `dryRun` skips persistence and events | ADR 0016 |
| 8 | Versioned state hydration | `exportState()`/`importState()` move validated, deeply frozen, JSON-only snapshots | ADR 0016 |
| 9 | Node.js providers | Process memory, CPU utilization, event-loop delay, event-loop utilization, network latency | ADR 0004, 0016 |
| 10 | Browser providers | Device memory, network information, frame timing, W3C compute pressure | ADR 0007, 0016 |
| 11 | Edge provider | Execution deadline remaining/used ratios and concurrency saturation | ADR 0007 |
| 12 | Composite signals | Priority status propagation (`error` > `stale` > `unsupported` > `unknown`) and compute rules | ADR 0007 |
| 13 | OpenTelemetry bridge | Duck-typed counters, histograms, preferred gauges, delta UpDownCounters, bounded `maxSeries` LRU maps | ADR 0011 |
| 14 | Prometheus metrics collector | In-memory series, `maxSeries` LRU eviction, label normalization, and text exposition | ADR 0011 |
| 15 | Provider lifecycle resilience | Start context forwarding, transient start recovery, post-close `unsupported`, and error draining | ADR 0014 |
| 16 | Fake clock | Virtual `now`, `advance`, `set`, deterministic timer ordering, and pending-timer accounting | ADR 0008 |
| 17 | Scripted signal provider | Repeat-last or exhaust-to-`unknown` scripted readings for reproducible tests | ADR 0008 |
| 18 | Provider conformance check | Validates descriptors, readings, lifecycle, post-close unsupported state, and `drainProviderErrors` | ADR 0008 |
| 19 | Policy timeline simulator | Replays decisions, budget transitions, switches, and reversals without providers or timers | ADR 0016 |
| 20 | Source and dist benchmarks | JSON schema v1 identifies `source` or `--dist` entry points for consumer-facing measurements | ADR 0009 |
| 21 | Release and supply-chain automation | Version sync, package export verification, provenance release workflow, CodeQL, Scorecard | ADR 0009, 0010 |
| 22 | Composable policy selectors | `composeSelectors`, `minSamples` cold-start guard, `fallbackSelector`, and `useEwma` mode | ADR 0017, 0018 |
| 23 | Non-disturbing introspection & bounds | `getEffectivePolicy`, `getProviderDescriptors`, and `maxQualityCheckDetailLength` | ADR 0017, 0018 |
| 24 | Exact stats hydration | Bit-exact `totalDurationMs` persistence across export/import cycles | ADR 0018 |
| 25 | Coalesced shared reads | Distinct `coalesced` vs `cached` snapshot semantics for in-flight joiners | ADR 0005, 0018 |
| 26 | High-fidelity simulation | `estimatedLatencyMs`, `ewmaLatencyMs`, and `errorRate` on `SimulatedStrategy` | ADR 0018 |

## Milestones

| # | Name | Scope | Status |
| --- | --- | --- | --- |
| M1 | Multi-runtime web and edge providers | `src/providers/web`, `src/providers/edge`, unit tests | DONE |
| M2 | Composite signal provider | `src/providers/composite.ts`, unit tests | DONE |
| M3 | Custom policy selector | Policy types, resolution, engine, unit tests | DONE |
| M4 | Zero-dependency observability | Metrics collector, Prometheus text, OpenTelemetry bridge | DONE |
| M5 | Conformance testing SDK | Fake clock, scripted provider, conformance runner | DONE |
| M6 | Packaging, entry points, examples, ADRs | All subpaths, isolation test, edge example, clean consumer | DONE |
| M7 | Opaque-box E2E suite | Tiers 1-5 lifecycle, concurrency, telemetry, multi-runtime, adversarial soak | DONE |
| M8 | 0.4.0 operational control | Abort-aware queue, strategy stats, per-operation policy, provider recovery | DONE (included in 0.5.0) |
| M9 | 0.5.0 shadow evaluation and state hydration | `evaluate`, `exportState`/`importState`, latency/error stats, provider expansion, timeline simulator | DONE (released) |
| M10 | 0.6.0 hardening | Bounded OTel delta maps, provider branch coverage, post-close conformance, dist benchmark verification, documentation synchronization | DONE |
| M11 | 0.7.0 Wave 1 & 2 integration | Composable selectors, introspection, exact stats, coalesced reads, simulator fidelity, ADR 0018, v0.7.0 release prep | DONE |

## Interface Contracts

### Runtime

- `createAdaptiveRuntime(options): AdaptiveRuntime`
- `run(operation): Promise<RunResult>`
- `evaluate(operation): Promise<StrategyDecision>` with optional `dryRun`
- `pinStrategy`/`unpinStrategy`, `setAdaptationEnabled`, `setOperationPolicy`
- `getEffectivePolicy(operationId): ResolvedPolicy`
- `getProviderDescriptors(): readonly SignalDescriptor[]`
- `getTrackedOperations(): readonly string[]`
- `getAllStats(): Readonly<Record<string, RuntimeStats>>`
- `getDecision`, `getStats`, `exportState`, `importState`
- `removeOperation` returns `false` while an operation is selecting or executing
- `resetStats` clears counters without discarding decisions, pins, or policy state
- `on(event, listener)` and `close()`

### Policy

- `definePolicy(policy)` is an identity helper with no validation or cloning.
- `resolvePolicy`, `evaluatePolicy`, and `createInitialPolicyState` are pure.
- `PolicyState` tracks budget hysteresis, mode duration, samples, and selection
  history for deterministic replay.
- `Policy.customSelector` refines eligible candidates but cannot bypass
  applicability, quality bounds, or stability gates.

### Providers and signals

- `SignalProvider` exposes `id`, descriptors, optional `start(context)`,
  `read(context)`, optional `close()`, and optional `drainProviderErrors()`.
- Readings use `context.now`, preserve explicit unavailable statuses, and never
  invent a zero value.
- `CompositeSignalProvider` propagates the highest-priority unavailable status
  and surfaces child failures through `drainProviderErrors`.
- Every built-in provider reports `status: "unsupported"` after `close()`.

### Observability

- `createMetricsCollector(options)` / `new MetricsCollector(options)`
- `maxSeries` is a positive integer (default `1000`); invalid values throw
  `ConfigurationError`.
- `attachOpenTelemetryMeter(runtime, meter, options)` prefers
  `createGauge`, falls back to delta `UpDownCounter`, and bounds each delta map
  with the same `maxSeries` LRU rule.
- Non-ok signal and budget statuses increment status counters and never write
  zero gauges.

### Testing

- `createFakeClock(initialMs?)`
- `ScriptedSignalProvider({ script, repeatLast? })`
- `runProviderConformanceCheck(provider, { now?, signal?, checkPostClose? })`
- `simulatePolicyTimeline({ operationId?, policy?, strategies, initialState?, steps })`

## Code Layout

```text
src/
  core.ts, node.ts, web.ts, edge.ts, index.ts
  errors/
  policy/          budgets, candidates, define-policy, engine, resolve, stability
  providers/       composite, cpu-utilization, event-loop-delay,
                   event-loop-utilization, network-latency, process-memory
    web/           compute-pressure, device-memory, frame-timing, network-info
    edge/          execution-budget
  runtime/         clock, emitter, executor, runtime, state, stats, validate
  signals/         collector
  types/           clock, decision, events, policy, run, runtime, signals,
                   state, strategy
  observability/   metrics collector and OpenTelemetry bridge
  testing/         fake clock, scripted provider, conformance, timeline
  utils/           error helpers
tests/
  unit/            runtime, policy, providers, observability, testing SDK
  integration/     entry points, public API, benchmarks, links, examples
  property/        budget model, evaluation, selection, runtime invariants
  e2e/             tiers 1-5 opaque-box lifecycle, concurrency, telemetry
  helpers/         fake clock and provider helpers
benchmarks/        runtime overhead (source or --dist) and concurrency
scripts/           version sync, export verification, publishing, links
examples/          basic, quick-start, search, planning, observability, edge
docs/              API, architecture, providers, observability, benchmarks,
                   verification, roadmap, ADRs
```

## Verification Status

- Full local gate: format/lint, typecheck, tests, coverage, build,
  `verify:exports`, `verify:zero-deps`, `check:links`, examples, and both
  benchmarks.
- Node.js test suite (unit, integration, property, and E2E) passes with zero
  failures and zero skipped tests (507 tests across 77 suites).
- Global coverage on 2026-10-24 (Node 24.15.0): 99.00% lines, 96.28% branches,
  99.05% functions; every `src/**` file remains above 91% branch coverage (well above 80% gate).
- `npm run build` and `npm run verify:exports` verify all ten export entries,
  27 built files, and 36 runtime symbols.
- The benchmark JSON schema is validated against the TypeScript source and,
  after a build, the compiled `dist/index.js` (`config.entrypoint` distinguishes
  them).
- The `v0.5.0` tag and GitHub release are published; npm publication is a
  separate owner-approved dispatch and has not been performed. The 0.7.0
  release line integrates Wave 1 and Wave 2 in preparation for 1.0-RC.
- Remote CI/CodeQL/Scorecard status and release evidence are recorded in
  [docs/VERIFICATION.md](docs/VERIFICATION.md). Release steps are in
  [docs/RELEASING.md](docs/RELEASING.md).
