# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project intends
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) after 1.0.

## [Unreleased]

## [0.8.0] — 2026-10-25

### Added

- **Cost-aware policy selector & safe selector boundary (PR #36):**
  - `createCostBudgetSelector(options)`: Cost-aware strategy selector that evaluates candidate resource costs against configured budget limits, selecting the highest-quality candidate within budget limits or minimizing cost overshoot.
  - `createSafeSelector(options)`: Resilient selector wrapper providing fallback strategy selection, error isolation, and graceful degradation when custom selectors encounter exceptions or unexpected null outputs.
  - First-class candidate sample wiring for enriched custom selector decisions.
- **Observability timeline simulation samples & provider conformance (PR #37):**
  - `simulatePolicyTimeline` enriched with candidate samples and expanded timeline telemetry.
  - Conformance test hardening across provider lifecycle hooks (`start`, `read`, `close`).
  - Added `.reset()` metric method to `MetricsCollector` for isolated lifecycle testing and Prometheus metric resets.
- **Runtime in-flight operation queries & idle pruning (PR #38):**
  - `runtime.getInFlightOperations()`: Non-disturbing introspection API returning all active, concurrent in-flight operation IDs and counts.
  - `runtime.pruneIdleOperations(maxIdleAgeMs)`: Explicit pruning of idle operation states exceeding the maximum idle age.
  - Wired live samples directly into candidate views during concurrent policy evaluation.
- **Concurrency benchmarks, JSON telemetry & 1.0-RC stability specification (PR #39):**
  - High-concurrency benchmark harness with `--json` telemetry reporting (`npm run benchmark:concurrency -- --json`).
  - `scripts/compare-benchmarks.mjs`: Automated regression comparison utility for throughput and latency percentiles across benchmark runs.
  - Added `docs/DEPRECATION_AND_STABILITY.md`: Formal stability, semantic versioning, and deprecation lifecycle specification for the 1.0-RC roadmap.
- **Deterministic state snapshot inspection, diffing & filtering (PR #40):**
  - `inspectStateSnapshot(snapshot)`: Summary inspection extracting version, exported timestamp, operation counts, operation IDs, and active strategy mappings.
  - `diffStateSnapshots(before, after)`: Deterministic diffing utility reporting added, removed, unchanged operations, and strategy transitions with switch count deltas.
  - `filterStateSnapshot(snapshot, predicateOrIds)`: Pure functional filtering of state snapshots by operation IDs or predicate.
  - `validateStateSnapshot` / `validateRuntimeStateSnapshot`: Strict validation ensuring snapshot structural integrity and schema conformity.
- **Web provider resilience, frame timing & compute pressure guards (PR #41):**
  - `FrameTimingProvider`: Added frame dropped ratio calculation (`WEB_FRAME_DROPPED_RATIO`) and p95 frame duration stats (`WEB_FRAME_DURATION_P95_MS`).
  - `ComputePressureProvider`: Added pressure observation staleness guard to invalidate obsolete records past configured staleness thresholds.
  - `NetworkInformationProvider`: Factored Save-Data headers and flags into network RTT calculations (`WEB_NETWORK_SAVE_DATA`).
- **Property testing expansion & adversarial concurrency soak suite (PR #42):**
  - Property test suites in `tests/property/` verifying invariant preservation across state serialization round-trips and custom policy selection.
  - Tier-5 adversarial soak suite (`tests/e2e/tier5-adversarial-soak.test.ts`) exercising high-throughput concurrent load, random cancellations, and unexpected errors.
- **Edge execution budget headroom & window reset (PR #43):**
  - `EdgeExecutionBudgetProvider` / `ExecutionBudgetProvider`: Configurable wall-clock and CPU reserve headroom (`reserveWallClockMs`, `reserveCpuMs`).
  - Added `getBudgetSnapshot()` inspection method and window reset capabilities for serverless worker reuse.
  - WinterCG execution budget signals: `EDGE_EXECUTION_REMAINING_MS`, `EDGE_EXECUTION_USED_RATIO`, and `EDGE_CONCURRENCY_SATURATION`.
- **Composite signal median/spread operators & quorum guards (PR #44):**
  - Added `median` and `spread` combiner modes to `CompositeSignalProvider` for robust multi-signal aggregation.
  - Added `minAvailableSources` quorum guard ensuring composite calculations only run when minimum quorum thresholds are satisfied.
  - Added `onSourceUnavailable` diagnostic notification callback and exported `createCompositeSignalProvider` factory.

### Changed

- Re-exported `inspectStateSnapshot`, `diffStateSnapshots`, `filterStateSnapshot`, `validateStateSnapshot`, and related types in `src/core.ts`, `src/node.ts`, and `src/index.ts`.
- Re-exported `createCompositeSignalProvider`, `CompositeCombinerMode`, `createEdgeExecutionBudgetProvider`, `EdgeExecutionBudgetProvider`, and `EdgeBudgetSnapshot` in `src/providers/index.ts` and root barrels.
- Updated `scripts/verify-package-exports.mjs` and `tests/integration/public-api.test.ts` to assert all v0.8.0 public runtime symbols.


## [0.7.0] — 2026-10-24

### Added

- **Composable policy selectors & cold-start guards (ADR 0018):**
  - `composeSelectors(selectors)` combinator: Deterministic pipeline evaluation that runs custom selectors sequentially and yields the first non-null/non-undefined decision.
  - `minSamples` option (default `1`, validated safe positive integer) on `createErrorRateGuardSelector`: Prevents premature disqualification of cold-start candidates before statistically meaningful error sample counts accumulate.
  - `fallbackSelector` and `useEwma` options on `createLatencyBudgetSelector`: Enables delegating within-budget candidate selection to secondary selectors (such as error rate guards or quality pickers) and selecting between EWMA (`ewmaLatencyMs`) and arithmetic mean (`estimatedLatencyMs`) latency measurements.
- **Runtime introspection & configurable detail bounds:**
  - `maxQualityCheckDetailLength` option (default `1,000`, validated safe positive integer) on `CreateRuntimeOptions`: Bounds error and diagnostic detail strings produced by quality check functions.
  - Exact `totalDurationMs` persistence across `exportState()` and `importState()` cycles in `StatsRegistry`: Eliminates IEEE 754 floating-point drift across repeated state hydration cycles.
  - `runtime.getEffectivePolicy(operationId)`: Resolves an operation's active policy definition without altering LRU tracking order or marking operations as active.
  - `runtime.getProviderDescriptors()`: Returns deeply frozen signal descriptors declared by registered providers.
- **Signal collector shared-read semantics & provider diagnostics:**
  - `SignalSnapshot.coalesced`: Distinguishes concurrent callers joining an in-flight live collection (`cached: false, coalesced: true`) from historical cache hits (`cached: true, coalesced: false`), preventing false cached-sample penalties in policy evaluation.
  - `collector.getDescriptors()`: Exposes immutable, frozen signal descriptors on `SignalCollector`.
  - Resilience against cancellation storms (100+ concurrent aborts) and deterministic provider timeout recovery.
- **Observability lifecycle synchronization & simulation fidelity:**
  - `estimatedLatencyMs`, `ewmaLatencyMs`, and `errorRate` parameters on `SimulatedStrategy` in `adaptive-runtime/testing`: Allows realistic simulation of latency-aware and error-rate-aware policy selector logic during timeline simulations.
  - OpenTelemetry series purging: Automatically purges internal delta state for removed operations via `runtime.removeOperation(operationId)` lifecycle hooks, preventing memory leaks in high-churn multi-tenant environments.
- **Architecture Decision Record:**
  - Added ADR 0018: Selector Composition and Simulation Fidelity (`docs/adr/0018-selector-composition-and-simulation-fidelity.md`).

### Changed

- Barrel exports in `adaptive-runtime` and `adaptive-runtime/policy` now expose `composeSelectors`.
- Enforced `CITATION.cff` version synchronization alongside `package.json`, `package-lock.json`, and `CHANGELOG.md` in `scripts/verify-version-sync.mjs`.

## [0.6.0] — 2026-10-24

### Added

- **Runtime inspection APIs (`getOperationPolicy`, `getTrackedOperations`, `getAllStats`):**
  - `runtime.getOperationPolicy(operationId)` retrieves the registered policy definition for an operation.
  - `runtime.getTrackedOperations()` enumerates all currently tracked operation IDs.
  - `runtime.getAllStats()` returns an immutable snapshot mapping of operational statistics across all tracked operations.
- **Configurable quality check detail length bounding (`maxQualityCheckDetailLength`):**
  - Allows configuring maximum detail string length (default: 1,000 characters) on runtime options, truncating excessive error or diagnostic detail strings defensively.
- **Built-in policy selectors and formatting utilities:**
  - Standard selectors `lowestLatencySelector`, `lowestErrorRateSelector`, and `balancedLatencyAndErrorSelector` exported from `adaptive-runtime/policy`.
  - `formatDecisionSummary(decision)` utility for human-readable diagnostic logging of policy decisions.
- **OpenTelemetry UpDownCounter LRU series bounding (`maxSeries`):**
  - Protects `attachOpenTelemetryMeter` against high-cardinality series memory growth by enforcing an LRU eviction bound (configurable via `maxSeries`, default: 1,000) on UpDownCounter delta tracking maps.
- **Enhanced Provider Conformance Test Suite:**
  - `runProviderConformanceCheck` in `adaptive-runtime/testing` now validates that providers explicitly report `unsupported` status after `close()`, and verifies `drainProviderErrors()` bridge contract compliance.

### Changed

- **EventLoopUtilizationProvider branch coverage and validation:**
  - Streamlined option parsing and input validation branches in `EventLoopUtilizationProvider` with comprehensive test coverage.
- **Package subpath export verification:**
  - Enhanced `scripts/verify-package-exports.mjs` with comprehensive export assertions across all 10 documented entry points and runtime symbols.

### Fixed

- Fixed tier-5 adversarial soak test policy definitions to align with strict `PolicyDefinition` schema.

## [0.5.0] — 2026-10-23

### Added

- **Shadow evaluation (`evaluate`, ADR 0016):** Computes one policy decision
  without executing a strategy. `dryRun: true` persists no state and emits no
  event; a normal evaluation persists state and the decision but does not update
  run statistics.
- **State hydration (`exportState` / `importState`, ADR 0016):** Versioned,
  JSON-compatible snapshots of policy state, decisions, pins, adaptation
  overrides, and statistics. Imports are validated atomically, bounded by
  `maxTrackedOperations`, and rejected while an operation has in-flight work.
- **Recent-latency and failure statistics:** `ewmaDurationMs` (alpha `0.2`),
  `durationSamples`, and `errorRate` on `RuntimeStats` and `StrategyStats`.
  Custom selectors receive `estimatedLatencyMs` (EWMA first), `ewmaLatencyMs`,
  and `errorRate`.
- **`EventLoopUtilizationProvider`:** Node.js event-loop utilization with a
  cumulative first reading and delta-based later readings.
- **`ComputePressureProvider`:** W3C Compute Pressure integration with explicit
  `nominal`/`fair`/`serious`/`critical` mapping and manual state recording.
- **`simulatePolicyTimeline`:** Deterministic policy timeline simulator in
  `adaptive-runtime/testing`, reporting per-step decisions/state, budget
  engagements and recoveries, strategy switches, and switch reversals.
- **ADR 0016:** Shadow evaluation, state hydration, telemetry parity, and
  provider expansion.

### Changed

- Per-operation `evaluationIntervalMs` now controls the signal collector's cache
  window instead of always using the global policy value.
- `attachOpenTelemetryMeter` prefers `createGauge` when available and otherwise
  applies bounded deltas to UpDownCounters. Signal labels now include
  `operation_id`, `signal`, and `status`; budget labels use `budget_id` and
  `operation_id`.
- `MetricsCollector.removeOperation()` trims surrounding whitespace, matching
  runtime operation-id normalization.
- `EventLoopDelayProvider` adds `minSamples` and retains its last valid reading
  for `resolutionMs * minSamples` to avoid post-reset `unknown` flapping.

### Fixed

- Composite providers now surface child-provider failures through the optional
  `drainProviderErrors()` bridge, including nested composites.
- State snapshots preserve arithmetic averages exactly by persisting
  `durationSamples`.
- Version synchronization is enforced by `scripts/verify-version-sync.mjs` in
  `npm run check`.

## [0.4.0] — 2026-10-23

### Added

- **Abort-Aware Selection Queue (ADR 0012):** Immediate cancellation of queued
  operations in `AdaptiveRuntimeImpl.#serialize` upon `operation.signal` abort,
  eliminating Head-of-Line blocking without listener leaks.
- **Strategy-Level Statistics (`StrategyStats`, ADR 0013):** `RuntimeStats.strategies`
  exposing per-strategy counts (`runs`, `successes`, `failures`) and durations
  (`lastDurationMs`, `averageDurationMs`).
- **Latency-Aware Custom Selector (`estimatedLatencyMs`):** Populated
  `CustomSelectorCandidate.estimatedLatencyMs` with empirical historical
  `averageDurationMs` from `StatsRegistry`.
- **Per-Operation Policy Overrides (`setOperationPolicy`, ADR 0015):** Multi-tenant
  operational policy overrides adhering to a strict 4-tier precedence model
  (`pinStrategy > setAdaptationEnabled > operationPolicy > globalPolicy`) under
  `maxTrackedOperations` LRU bounds.
- **Provider Lifecycle Resilience & Context (ADR 0014):** Added `SignalStartContext`
  passed to `SignalProvider.start?(context)`, forwarded through
  `CompositeSignalProvider`, with automatic transient start recovery across
  evaluation intervals.
- **Full OpenTelemetry UpDownCounter Bridge:** `attachOpenTelemetryMeter` emits
  `*_signal_reading` and `*_budget_engaged` via `createUpDownCounter` when present,
  with per-instrument error isolation.
- **MetricsCollector Series Bounding:** Added `maxSeries` option (default 1000)
  with FIFO eviction and `removeOperation(operationId)` cleanup.
- **Milestone M7 Opaque-Box E2E Suite (Tiers 1-5):** Complete opaque-box E2E test
  suite in `tests/e2e/` covering public multi-entrypoint lifecycle, 100-operation
  concurrency & abort storms, dual telemetry export, multi-runtime environment
  simulation, and adversarial soak testing.
- Architectural Decision Records: ADR 0012, 0013, 0014, and 0015.

### Fixed

- Standardized Phase 1 provider constructors (`ProcessMemoryProvider`,
  `CpuUtilizationProvider`, `EventLoopDelayProvider`, `NetworkLatencyProvider`) to
  validate `id` with `validateId`, throw `ConfigurationError` on invalid options, and
  implement `close(): void` with post-close `status: "unsupported"`.
- Bounded provider reading error strings (`reading.error`) to at most 1,000 characters
  in `SignalCollector.#normalizeReadings` to mitigate memory and telemetry DoS.
- Synchronized documentation across `API_DESIGN.md`, `COOKBOOK.md`, `MIGRATION.md`,
  and `OBSERVABILITY.md` to accurately document all 10 public exports and
  `maxTrackedOperations` LRU eviction semantics.
- Expanded clean consumer smoke test in `scripts/verify-published-package.mjs` to
  verify all 9 runtime subpaths.

### Added

- Deterministic property/fuzz suite using `fast-check` as a development-only
  dependency. It covers budget hysteresis, candidate ordering, pure policy
  evaluation, and the exactly-one-execution runtime invariant; the runtime still
  has zero runtime dependencies.
- Scheduled property fuzz campaign in `.github/workflows/fuzz.yml`, with weekly,
  pull-request, and manual-dispatch modes. The scope and reproduction workflow
  are documented in `docs/FUZZING.md`.
- OpenSSF Best Practices passing-level self-assessment, evidence map, and
  application checklist in `docs/OPENSSF_BEST_PRACTICES.md`.
- Asynchronous `SignalProvider.start()` support. The collector awaits a returned
  promise before the first read, applies the provider timeout and caller abort
  signal, and caches failures instead of leaking rejected promises.
- Post-publication verification is now an offline-testable CLI in
  `scripts/verify-published-package.mjs`. The release workflow uses it to check
  registry propagation, exact version, `sha512` integrity, repository metadata,
  provenance, and a clean consumer install; metadata and attestation fixtures
  allow network-free verification tests.
- Machine-readable benchmark output with `schemaVersion: 1`, the
  `benchmark:compare` CLI, and an observation-only weekly benchmark workflow that
  uploads JSON artifacts without enforcing a performance threshold.
- Automated zero-runtime-dependency and relative Markdown-link checks, plus a
  read-only Security and documentation workflow that also runs a high-severity
  production dependency audit.

### Fixed

- Policy decisions and successful run metadata are frozen before events are
  emitted and before decisions are stored, so listener mutation cannot change the
  selected strategy or returned metadata.
- `setAdaptationEnabled()` no longer loses its just-written override during
  tracking-limit enforcement when the bound is full of protected operations.
  Padded `pinStrategy()` strategy ids are rejected instead of silently trimmed.
- Metric series keys are unambiguous for arbitrary label text, and metric family
  type now comes from the recording instrument rather than the metric name
  suffix. Reusing a name with a different instrument kind throws `TypeError`
  instead of silently dropping series.
- The tag-push GitHub release job sets `GH_REPO` for `gh release` commands when it
  runs without a checkout.

## [0.3.0] — 2026-10-22

### Added

- Multi-runtime entry points: `adaptive-runtime/core`, `/node`, `/web`, and
  `/edge`, plus `/observability` and `/testing`. The root entry point remains the
  Node.js default. Every subpath declares `types`, `import`, and `default`
  conditions.
- `DeviceMemoryProvider`, `NetworkInformationProvider`, and `FrameTimingProvider`
  for browsers and Web-compatible runtimes. They use structural interfaces,
  require no DOM type library, and keep unavailable data explicit.
- `ExecutionBudgetProvider` for WinterCG, serverless, and edge runtimes, with
  remaining wall-clock time, used-budget ratio, and concurrency saturation.
- `CompositeSignalProvider` with validated rules, passthrough inputs, child
  lifecycle forwarding, and status propagation (`error` > `stale` >
  `unsupported` > `unknown`).
- `Policy.customSelector` and the `custom-selector` decision reason. The selector
  refines eligible automatic candidates and remains subject to applicability,
  quality bounds, hysteresis, and stability gates.
- `adaptive-runtime/observability`: `createMetricsCollector` with in-memory
  counters/gauges/histograms and Prometheus text exposition, plus
  `attachOpenTelemetryMeter` for structural OpenTelemetry meters. Non-`ok` signal
  statuses increment status counters and never write a zero gauge.
- `adaptive-runtime/testing`: `createFakeClock`, `ScriptedSignalProvider`, and
  `runProviderConformanceCheck`.
- `examples/multi-runtime-edge`: deterministic core + edge + observability
  example with an execution budget, composite pressure score, three-tier strategy
  ladder, and Prometheus output.
- ADRs 0007 (multi-runtime and composite providers) and 0008 (custom selector,
  observability, and testing SDK), plus 0009 (repository automation and
  supply-chain hardening).
- Source-scan portability test, entry-point integration tests, and package
  subpath assertions.
- `Policy.maxTrackedOperations`: bounds all operation-keyed state with
  deterministic LRU eviction. Pinned, selecting, and executing operations are
  never evicted.
- `runtime.removeOperation(operationId)`: releases an operation's policy state,
  decision, pin, adaptation override, and stats; returns `false` while the
  operation is selecting or executing.
- `runtime.resetStats(operationId?)`: clears counters and latency samples for one
  operation or all operations without discarding decisions, pins, or policy state.
- `adaptive-runtime/policy` subpath: platform-neutral policy types,
  `definePolicy`, `resolvePolicy`, `createInitialPolicyState`, and
  `evaluatePolicy`.
- `adaptive-runtime/providers` subpath: every built-in provider (Node.js, web,
  edge, and composite) and their signal-name constants. This barrel is mixed and
  not platform-neutral.
- Dependency Review workflow pinned to
  `actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294`
  (v5.0.0).
- Cross-platform CI job on Windows and macOS.
- Repository automation: `.github/release.yml` categorizes generated release
  notes, Discussion forms cover Q&A and design ideas, an OpenSSF Scorecard
  workflow uploads SARIF and publishes badge results, and a dependency-free PR
  title check enforces Conventional Commits. `CITATION.cff` adds citation
  metadata, and `.vscode/` recommends the Biome extension with format-on-save.
- `npm run verify:exports` imports every built subpath through the package export
  map and checks the named runtime exports; CI runs it on Linux, Windows, and
  macOS after `npm run build`.
- Integration coverage now uses the root `CustomPolicySelector` type, the
  observability collector, and the testing SDK together, and validates the PR
  title checker.
- ADR 0006 documenting bounded operation state and subpath exports.
- `verify-publish` release job: registry propagation retry, version, integrity,
  repository metadata, provenance attestation, and clean-consumer import checks.

### Changed

- Repository settings documentation now matches the checked-in workflows and
  issue forms: `status:needs-triage` is the triage label, Dependency Review uses
  `actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294`
  (v5.0.0), CodeQL action pins are labeled as v4.39.0, and `release.yml` uses the
  same `actions/setup-node` pin as the other workflows.
- Package version is `0.3.0`. The root entry point now re-exports the Node.js
  entry point; platform-specific modules should import `/core`, `/web`, or
  `/edge` explicitly.
- The package description, keywords, README, API reference, architecture,
  provider guide, observability guide, roadmap, verification record, and agent
  rules now describe the multi-runtime surface.
- Expanded branch coverage for the new entry points, providers, testing SDK, and
  portability checks to 256 tests and 99.10% line / 96.91% branch / 98.64%
  function coverage.
- Split the policy core into `budgets.ts`, `candidates.ts`, `stability.ts`, and a
  coordinating `engine.ts`. `evaluatePolicy` semantics and the public contract are
  unchanged; `src/policy/` remains free of Node.js imports.
- Identifier validation is consistent: `operationId` is trimmed, while strategy,
  provider, signal, budget, and fallback identifiers reject leading or trailing
  whitespace.
- Governance documents define a four-level contributor ladder (Community
  Contributor, Triage Collaborator, Committer/Reviewer, Core Maintainer/Owner)
  with recorded promotion and access-review rules.
- The release workflow uses npm trusted publishing (OIDC) with provenance and an
  optional `NPM_TOKEN` fallback; the npm cache is disabled for release jobs. The
  tag/version check reads `package.json` without CommonJS `require`.
- Release publication is two-phase: a `v*` tag push verifies the tagged tree and
  creates the GitHub release, while npm publication is a separate
  `workflow_dispatch` with `publish_npm=true`, gated by the `release` environment.
- Published package contents are limited to `dist`, `README.md`, `LICENSE`, and
  `NOTICE`.

### Fixed

- Per-operation maps no longer grow without bound when `maxTrackedOperations` is
  configured.

### Notes

- Version 0.3.0 uses a two-phase release: the tag and GitHub release are created
  from the release commit, and npm publication remains a separate owner-approved
  `workflow_dispatch`.
- The portable `/core`, `/web`, `/edge`, `/policy`, `/observability`, and
  `/testing` modules contain no Node.js built-in imports and do not read the
  Node.js `process` object.
- The runtime remains a trusted-code library, not a sandbox.

## [0.1.0] — 2026-10-21

### Added

- TypeScript ESM runtime with `createAdaptiveRuntime`, zero runtime dependencies,
  and Node.js 22+ support.
- Strategy contract with quality/cost tiers, applicability checks, optional
  quality checks, and exactly-once execution.
- Deterministic tier policy with soft budgets, hysteresis, consecutive samples,
  candidate stability, minimum mode duration, quality floor/ceiling, pins, and
  per-operation adaptation overrides.
- Missing-signal behaviors: `hold`, `fallback`, `error`, and `ignore`.
- Signal provider contract with lifecycle management, snapshot caching, provider
  timeouts, strict reading validation, and error isolation.
- Ref-counted shared provider reads: a caller's abort rejects only that caller,
  and provider reads stop when the last waiter leaves or the provider timeout
  expires.
- `definePolicy` identity helper: preserves the literal type of a policy object
  without validating, cloning, or changing it.
- Cancellation/ref-count stress tests for many concurrent waiters, all-caller
  abort with no caching, and `close()` during an in-flight read.
- Built-in providers: `ProcessMemoryProvider`, `CpuUtilizationProvider`,
  `EventLoopDelayProvider`, and `NetworkLatencyProvider`.
- Cooperative operation timeout and abort handling with typed errors.
- Typed events, per-operation decisions with reasons, and runtime stats.
- Unit and integration tests, runnable examples, and a local overhead benchmark.
- A runnable observability example with an in-memory metrics sink and an
  integration test covering success, provider-error, and strategy-error paths.
- Documentation: README, API reference, API design notes, provider authoring
  guide, observability guide, architecture, threat model, roadmap, benchmarks,
  verification, migration/upgrade guide, cookbook, and six ADRs.
- Apache-2.0 license, contribution guide, code of conduct, security policy,
  support guide, issue forms, pull request template, Dependabot, CI, CodeQL, and
  release workflow definitions.

### Changed

- Shared signal reads now use a per-read abort controller and waiter count. The
  initiating caller no longer controls cancellation for other waiting runs, and
  an all-aborted read is not cached.

### Notes

- Version 0.1.0 is the first public source release.
- The public repository, CI, CodeQL, and tag-driven release workflow are
  established; CI passes on Node.js 22, 24, and 26.
- The release workflow is configured to publish with npm provenance; npm
  registry publication is still pending.
- The runtime is not a sandbox and does not enforce OS resource limits.
- Public API and decision reason codes may change during 0.x.
