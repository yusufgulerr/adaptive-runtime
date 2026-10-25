# Roadmap

This roadmap describes intent, not commitments or dates. Priorities may change
with feedback and evidence. The 0.9.0 source line is implemented, verified, tagged,
and released on GitHub, advancing the runtime to 1.0-RC readiness. Releases `v0.1.0`
through `v0.9.0` are tagged and released on GitHub; npm publication is a separate
owner-approved workflow dispatch and remains pending.

## 0.1.0 — Foundation (delivered)

Delivered:

- TypeScript ESM package with zero runtime dependencies.
- Strategy API with declared quality/cost tiers, applicability, and optional quality checks.
- Deterministic policy engine with:
  - tier reduction from soft budgets;
  - hysteresis (`limit` / `recoverBelow`);
  - consecutive-sample engagement and release;
  - candidate stability and minimum mode duration;
  - quality floor and ceiling;
  - missing-signal behavior (`hold`, `fallback`, `error`, `ignore`);
  - manual pins and per-operation adaptation overrides.
- Signal provider contract with lifecycle, caching, timeout, and strict reading validation.
- Ref-counted shared provider reads: one caller's abort does not poison another
  caller's snapshot; the read is aborted only when every waiter leaves.
- Built-in providers: process memory, process CPU, event-loop delay, network latency probe.
- Cooperative operation timeout and abort handling.
- Typed events, per-operation decisions, and stats.
- Bounded per-operation state: `maxTrackedOperations` LRU eviction,
  `removeOperation`, and `resetStats`.
- Modular policy core (`budgets`, `candidates`, `stability`, coordinating
  `engine`) with a platform-neutral `adaptive-runtime/policy` subpath.
- `adaptive-runtime/providers` subpath and a minimal published file set.
- Cross-platform CI (Linux, Windows, macOS), Dependency Review, and OIDC trusted
  publishing.
- Examples, unit and integration tests, benchmark, documentation, and GitHub templates.
- Apache-2.0 license and community/governance files.

Not done in 0.1.0:

- Published API stability guarantees. Treat 0.x as pre-1.0.
- Fuzzing, long-run load testing, soak testing, or an independent security audit.

## 0.2.0 — Operational confidence (delivered locally)

Goals:

1. **Publish a repeatable release.** Repository metadata and the supported CI
   matrix are in place; publish with OIDC provenance and attach a changelog after
   owner approval.
2. **Provider resilience follow-up.** **Delivered locally:** cancellation-storm
   stress tests and a close-during-in-flight test are in
   `tests/unit/shared-read-stress.test.ts`; provider-authoring guidance is in
   [PROVIDERS.md](PROVIDERS.md). Ref-counted shared reads are also delivered.
3. **Observability follow-up.** **Delivered locally:** the structured decision
   snapshot and recommended counters/histograms are documented in
   [OBSERVABILITY.md](OBSERVABILITY.md), with a runnable in-memory exporter example
   in `examples/observability/`.
4. **Configuration ergonomics.** **Delivered locally:** `definePolicy` preserves
   literal types and improves editor completion without changing semantics.
5. **Documentation depth.** **Delivered locally:** [MIGRATION.md](MIGRATION.md)
   covers adoption and upgrade expectations; [COOKBOOK.md](COOKBOOK.md) covers
   approximate vs exact search, sampling, batching, missing signals, and testing.

Exit criteria:

- CI green on Node 22, 24, and 26 for a tagged release.
- Coverage thresholds enforced in CI (lines/branches/functions >= 80).
- No known correctness issue in policy transitions or provider lifecycle.
- A published package can be installed in a clean project and imported using
  only the documented entry points.

## Maintainability and technical debt

These are known, non-blocking issues. None changes the documented 0.x
semantics, and the existing tests cover the current behavior.

Resolved through 0.8.0 / 1.0-RC:

1. **Per-operation state growth.** `Policy.maxTrackedOperations` now bounds all
   operation-keyed maps with LRU eviction, and `removeOperation(operationId)`
   releases state explicitly. Pinned and active operations are never evicted.
   See [ADR 0006](adr/0006-bounded-operation-state-and-subpath-exports.md).
2. **Monolithic policy engine.** `src/policy/engine.ts` now coordinates
   `budgets.ts`, `candidates.ts`, and `stability.ts` while preserving the
   `evaluatePolicy` contract.
3. **Per-file coverage.** Every `src/**` file remains above 80% branch coverage;
   the lowest is `providers/event-loop-utilization.ts` at 81.48%.
4. **Inconsistent identifier validation.** `operationId` is trimmed; strategy,
   provider, signal, budget, and fallback identifiers reject surrounding
   whitespace. The rule is documented in [API.md](API.md).
5. **Post-publish verification.** The npm publication phase runs a separate
   `verify-publish` job after publishing: it retries registry propagation, checks
   version, `dist.integrity`, and `repository.url`, verifies the provenance
   attestation, and installs the package in a clean consumer that imports every
   documented entry point. See [RELEASING.md](RELEASING.md).
6. **Benchmark regression tracking.** Delivered in v0.8.0 / 1.0-RC: machine-readable
   JSON outputs for both runtime overhead (`benchmarks/runtime-overhead.ts --json`) and
   concurrency throughput/heap (`benchmarks/concurrency.ts --json`), with automated
   percentage delta and configurable regression threshold comparison in
   `scripts/compare-benchmarks.mjs`.

Open:

None. All identified maintainability and telemetry debt items are resolved.

## 0.3.0 — Extensibility without losing determinism (delivered and released)

Delivered:

- **Multi-runtime providers and entry points.** `adaptive-runtime/core`,
  `/node`, `/web`, and `/edge`; browser providers for device memory, network
  information, and frame timing; an edge execution-budget provider; structural
  interfaces and no DOM type-library requirement.
- **Composite signals.** `CompositeSignalProvider` derives named, unit-bearing
  signals from child providers, propagates unavailable statuses, and rejects
  invalid rules at construction.
- **Custom policy selector.** `Policy.customSelector` refines the eligible
  candidate choice while preserving applicability, quality bounds, and stability
  gates. Choices record a `custom-selector` reason.
- **Observability bridge.** Zero-dependency in-memory metrics with Prometheus
  text exposition and a structural OpenTelemetry meter adapter. Non-`ok` signals
  increment status counters and never write a zero gauge.
- **Testing SDK.** Deterministic fake clock, scripted signal provider, and a
  provider conformance runner under `adaptive-runtime/testing`.
- **Packaging and example.** All documented entry points, a deterministic
  core/edge/observability example, a portability source scan, entry-point
  integration tests, a clean-consumer check, and ADRs 0007/0008.
- **Repository automation.** Categorized generated release notes, structured
  Discussion forms, an OpenSSF Scorecard workflow, a Conventional Commit PR title
  gate, citation metadata, editor recommendations, and a built-package export
  verifier.

Not yet delivered:

- npm publication and remote verification of the 0.3.0 tarball. Both require
  explicit owner approval and an npm dispatch against the tagged release.
- OpenSSF Best Practices passing badge. The self-assessment, evidence map, and
  application checklist are ready in
  [OPENSSF_BEST_PRACTICES.md](OPENSSF_BEST_PRACTICES.md); BadgeApp registration
  and the two owner attestations are pending.
- Post-0.3.0 work below remains candidate work, contingent on user demand.

Candidate work after 0.3.0 (0.4.0 and 0.5.0 have since delivered part of this
list):

- **Coverage-guided fuzzing.** The deterministic property-based campaign is
  delivered; a coverage-guided integration remains candidate work.
- **Async applicability.** Only if a clear need appears; it complicates selection
  latency and determinism.

Not planned for the current line:

- Mid-run strategy switching.
- Speculative or hedged execution.
- Distributed state or coordination.
- An OS-level resource limiter.

## 0.4.0 — Operational control and strategy-level evidence (delivered locally)

Delivered:

- **Abort-aware selection queue.** Queued operations reject immediately when their
  caller aborts instead of waiting for the in-flight selection, without listener
  leaks.
- **Strategy-level statistics.** `RuntimeStats.strategies` exposes per-strategy
  runs, successes, failures, and durations; custom selectors receive a historical
  latency estimate.
- **Per-operation policy overrides.** `setOperationPolicy()` follows a documented
  precedence order (`pinStrategy`, adaptation override, operation policy, global
  policy) under `maxTrackedOperations`.
- **Provider lifecycle context and recovery.** `SignalProvider.start()` receives a
  context, transient start failures recover after the evaluation interval, and
  composite providers forward the context.
- **Observability and resilience.** OpenTelemetry UpDownCounter support, bounded
  metric series with `maxSeries`, and FIFO cleanup through
  `MetricsCollector.removeOperation()`.
- **Opaque-box E2E coverage.** Public multi-entrypoint lifecycle, concurrency and
  abort storms, dual telemetry export, multi-runtime simulation, and adversarial
  soak scenarios. ADRs 0012-0015 record the contracts.

Not yet delivered:

- A separate 0.4.0 release. Its delivered work is included in 0.5.0; no 0.4.0
  tag or GitHub release exists.

## 0.5.0 — Shadow evaluation and state hydration (delivered and released)

Delivered:

- **Shadow evaluation.** `runtime.evaluate()` computes one policy decision without
  executing a strategy; `dryRun` avoids persistence and events.
- **Versioned state hydration.** `exportState()` and `importState()` move policy
  state, decisions, pins, adaptation overrides, and statistics through validated,
  deeply frozen, JSON-only snapshots.
- **Recent-latency and failure statistics.** EWMA latency, duration samples, and
  error rates are available to stats consumers and custom selectors.
- **Provider expansion.** Event-loop utilization and browser compute-pressure
  providers; retained event-loop delay readings are bounded and marked with lower
  confidence.
- **Correctness fixes.** Per-operation signal-cache intervals, exact
  OpenTelemetry gauge/delta/label semantics, trim-aware metric removal, composite
  child-error draining, and stats hydration consistency.
- **Policy timeline simulator.** `simulatePolicyTimeline()` reports per-step
  decisions and state, budget engagement/recovery, switches, and immediate
  reversals under `adaptive-runtime/testing`.
- **Release discipline.** ADR 0016 and automated version synchronization across
  `package.json`, `package-lock.json`, and the changelog in `npm run check`.

Not yet delivered:

- npm publication and post-publish registry/provenance verification. The 0.5.0
  tag, GitHub release, remote CI, CodeQL, and Scorecard checks are complete.

## 0.6.0 — Runtime inspection and selector foundations (delivered)

Delivered:

- **Batch introspection:** `getTrackedOperations()` and `getAllStats()` inspect active operations and runtime statistics in batch without altering LRU order.
- **Configurable detail length bounds:** `maxQualityCheckDetailLength` on runtime options truncates oversized strategy detail and error strings to prevent telemetry flooding.
- **Built-in selectors and formatting:** Standard selectors (`lowestLatencySelector`, `lowestErrorRateSelector`, `balancedLatencyAndErrorSelector`) and `formatDecisionSummary`.
- **OpenTelemetry series bounding:** LRU eviction bounds on UpDownCounter delta maps via `maxSeries`.
- **Enhanced provider conformance:** Validates post-close `unsupported` status and `drainProviderErrors` bridge contract.

## 0.7.0 — Selector composition, runtime introspection, and simulation fidelity (delivered)

Delivered:

- **Composable policy selectors & cold-start guards (ADR 0018):**
  - `composeSelectors(selectors)` combinator evaluates custom selectors sequentially with deterministic short-circuiting.
  - `minSamples` cold-start guard on `createErrorRateGuardSelector` protects early-lifecycle candidates from premature circuit-breaking.
  - `fallbackSelector` delegation and `useEwma` mode on `createLatencyBudgetSelector`.
- **Runtime introspection & exact state hydration:**
  - `getEffectivePolicy(operationId)` and `getProviderDescriptors()` allow non-disturbing introspection without altering LRU order.
  - Exact `totalDurationMs` persistence across `exportState()` and `importState()` cycles eliminates IEEE 754 floating-point drift.
  - Configurable `maxQualityCheckDetailLength` on `CreateRuntimeOptions` bounds error messages defensively.
- **Signal collector shared-read semantics & provider diagnostics:**
  - `SignalSnapshot.coalesced` distinguishes in-flight shared read joiners from historical cache hits, preventing false cached-sample penalties.
  - `collector.getDescriptors()` exposes deeply frozen provider descriptors.
  - Verified resilience against cancellation storms (100 simultaneous aborts) and deterministic provider timeout recovery.
- **Observability lifecycle sync & simulation fidelity:**
  - `estimatedLatencyMs`, `ewmaLatencyMs`, and `errorRate` simulation parameters on `SimulatedStrategy` in `adaptive-runtime/testing`.
  - Automatic series purging in OpenTelemetry UpDownCounter delta tracking upon operation removal.
  - Full suite expanded to 507 tests across 77 suites with >= 96% branch coverage across all files.

## 0.8.0 — Cost-aware selectors, state inspection, and resilience (delivered)

Delivered:

- **Cost-aware policy selector & safe boundary:**
  - `createCostBudgetSelector`: cost-aware strategy evaluation against budget limits.
  - `createSafeSelector`: resilient error-isolation boundary with graceful fallback delegation.
  - Candidate `samples` property wired directly to policy selectors.
- **Runtime in-flight introspection & idle pruning:**
  - `hasInFlight(operationId)` and `getActiveOperations()` non-disturbing introspection.
  - `pruneIdleOperations(maxAgeMs)` safe pruning of unpinned idle operations.
- **Deterministic state snapshot inspection & diffing:**
  - `inspectStateSnapshot`, `diffStateSnapshots`, `filterStateSnapshot`, and `validateStateSnapshot`.
- **Web & edge provider enhancements:**
  - Frame timing dropped ratio and p95 duration calculation.
  - Compute pressure staleness guards.
  - Edge execution budget reserve headroom (`reserveWallClockMs`, `reserveCpuMs`), snapshot inspection, and window reset.
- **Composite signal aggregation:**
  - Added `median` and `spread` combiner modes, `minAvailableSources` quorum guard, and `onSourceUnavailable` callback.
- **Property testing & adversarial soak suite:**
  - State serialization round-trip property tests and 631 tests / 100 suites across all platforms.

## 0.9.0 — Utility Selectors, Cooperative Drain, and Provider Circuit Breakers (delivered)

Delivered:

- **Multi-objective weighted utility & signal-trend guard selectors:**
  - `createWeightedUtilitySelector`: Composable scoring balancing normalized quality, latency, error rate, and cost weights.
  - `createSignalTrendGuardSelector`: Linear regression slope monitoring for early proactive degradation before budget breaches.
- **Structured JSON metrics & cardinality simulator:**
  - `MetricsCollector.toJSON()` producing `MetricsJsonReport` with utilization and dropped series counters.
  - `onSeriesDropped` alert callback and cardinality limit enforcement.
  - `comparePolicyTimelines`: Offline timeline comparator for A/B policy validation and regression analysis.
- **Node.js provider EWMA smoothing & jitter stats:**
  - `CpuUtilizationProvider` EWMA smoothing with configurable `alpha` and `getCpuStats()`.
  - `ProcessMemoryProvider` heap headroom calculation (`PROCESS_MEMORY_HEAP_HEADROOM`) and `getMemoryStats()`.
  - `NetworkLatencyProvider` jitter calculation (`NETWORK_LATENCY_JITTER`) and `getLatencyStats()`.
- **Per-provider circuit breaker cooldowns & health diagnostics:**
  - Circuit breaker in `SignalCollector` with consecutive failure thresholds, open cooldown windows, and half-open probing.
  - `runtime.getRuntimeHealth()` and `collector.getHealth()` returning `RuntimeHealthSummary` and per-provider statuses.
- **Cooperative graceful drain & state merge hydration:**
  - `runtime.waitForIdle()` for zero-drop graceful container shutdown (SIGTERM).
  - `runtime.importState(snapshot, { mode: "merge" })` for non-destructive additive state hydration.

## 1.0.0-RC & 1.0.0 — Stability and Release Candidate

The 0.8.0 and 0.9.0 milestones achieve complete 1.0.0-RC technical and architectural readiness:

- [x] **Complete architectural coverage across 20 ADRs:** ADRs 0001 through 0020 document every architectural decision, lifecycle guarantee, and stability contract.
- [x] **Zero runtime dependencies, portable core, and platform-targeted subpaths:** Validated by automated repository scans and package export verification (`npm run verify:zero-deps`, `npm run verify:exports`).
- [x] **Rigorous property-based fuzzing and multi-platform CI verification:** Enforced across Node 22, 24, and 26 on Linux, macOS, and Windows.
- [x] **Published 0.x line stability:** 0.5.0, 0.6.0, and 0.7.0 delivered stable minor cycles without breaking changes.
- [x] **Frozen public type and error-code compatibility policy:** Frozen 12-error-code catalog formalized in [DEPRECATION_AND_STABILITY.md](DEPRECATION_AND_STABILITY.md).
- [x] **Documented deprecation policy:** Standardized 2-minor-cycle deprecation policy formalized in [DEPRECATION_AND_STABILITY.md](DEPRECATION_AND_STABILITY.md).
- [x] **Security review of provider and event surfaces:** Strict reading validation, bounded quality detail lengths, and frozen data snapshots.
- [x] **Load, concurrency, and soak telemetry:** Automated machine-readable JSON telemetry for runtime overhead and concurrency benchmarks with regression comparison tooling (`scripts/compare-benchmarks.mjs`).
- [x] **Clear guidance for strategy-side idempotency and side effects under timeout:** Comprehensive timeout cancellation and idempotency contract in [COOKBOOK.md](COOKBOOK.md).
- [x] **Resilient selector pipeline and state management:** Delivered `createCostBudgetSelector`, `createSafeSelector`, candidate `samples` property, and in-flight operation lifecycle management (`hasInFlight`, `getActiveOperations`, `pruneIdleOperations`).
- [x] **Observability lifecycle control:** Delivered `MetricsCollector.resetMetrics` for clean multi-stage evaluation.

1.0 does **not** imply that strategies are correct, sandboxed, or safe. Those
remain application responsibilities.

## Support policy

| Line | Status | Runtime support |
| --- | --- | --- |
| Node.js 22 | LTS | Supported |
| Node.js 24 | LTS (maintenance from 2026-10-20) | Supported |
| Node.js 26 | Transitioning to LTS on 2026-10-28 | In CI; supported for the transitional line |
| Node.js < 22 | End-of-life | Not supported |

`engines.node` is `>=22.0.0`. The package uses only stable Node APIs:
`process.memoryUsage`, `process.cpuUsage`, `perf_hooks.monitorEventLoopDelay`,
`perf_hooks.performance.eventLoopUtilization`, `AbortSignal`, and standard
timers. Portable entry points use only
`AbortController`, `Promise`, standard timers, and structural globals; they do
not depend on a specific browser, worker, or edge vendor version. Verify
`AbortSignal` and ESM support in your target runtime before adopting the edge or
web entry point.

The support window will follow the Node.js release schedule: current and active
LTS lines plus the next LTS during its transition. Dropping a Node line is a
breaking change for a major version, except when the line reaches end-of-life.

## How priorities are chosen

1. Correctness and predictable behavior.
2. Safety at boundaries (timeouts, aborts, provider failures).
3. Observability and debuggability.
4. Minimal API surface and zero runtime dependencies.
5. Performance only when measured and attributable.

Proposals should include a concrete use case, the failure mode being addressed,
and how determinism is preserved. See [CONTRIBUTING.md](../CONTRIBUTING.md).
