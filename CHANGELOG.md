# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project intends
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) after 1.0.

## [Unreleased]

### Added

- Deterministic property/fuzz suite using `fast-check` as a development-only
  dependency. It covers budget hysteresis, candidate ordering, pure policy
  evaluation, and the exactly-one-execution runtime invariant; the runtime still
  has zero runtime dependencies.
- OpenSSF Best Practices passing-level self-assessment, evidence map, and
  application checklist in `docs/OPENSSF_BEST_PRACTICES.md`.

### Fixed

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
