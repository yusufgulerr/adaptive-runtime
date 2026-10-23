# Roadmap

This roadmap describes intent, not commitments or dates. Priorities may change
with feedback and evidence. The 0.5.0 source line is implemented, verified
locally and remotely, and released on GitHub. The latest GitHub release is
v0.5.0; 0.4.0 was superseded and has no separate release. npm publication is a
separate owner-approved workflow dispatch and remains pending.

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

Resolved through 0.5.0:

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

Open:

6. **No benchmark regression tracking (low).** Benchmarks are intentionally not a
   CI gate because they are noisy on shared runners. Record a trend over time
   before considering a loose, non-blocking threshold. Provider start recovery
   (0.4.0) and the abort-aware selection queue (0.4.0, ADR 0012) closed the earlier
   lifecycle and queued-abort items.

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

## 1.0.0 — Stability

A 1.0 release requires:

- At least one published 0.x line with no breaking changes for a full minor cycle.
- Frozen public type and error-code compatibility policy.
- A documented deprecation policy.
- Security review of the provider and event surfaces.
- Load and soak testing of the runtime's own overhead, including concurrent runs.
- Clear guidance for strategy-side idempotency and side effects under timeout.
- Decision that the fixed tier model is sufficient, or a stable custom-policy API.

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
