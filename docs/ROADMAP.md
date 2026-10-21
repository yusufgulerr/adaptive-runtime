# Roadmap

This roadmap describes intent, not commitments or dates. Priorities may change
with feedback and evidence. The 0.1.0 release is implemented and verified; npm
publication is prepared through the tag-driven workflow.

## 0.1.0 — Foundation (current)

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

## 0.2.0 — Operational confidence

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

These are known, non-blocking issues. None changes the documented 0.1.0
semantics, and the existing tests cover the current behavior.

Resolved in 0.1.0:

1. **Per-operation state growth.** `Policy.maxTrackedOperations` now bounds all
   operation-keyed maps with LRU eviction, and `removeOperation(operationId)`
   releases state explicitly. Pinned and active operations are never evicted.
   See [ADR 0006](adr/0006-bounded-operation-state-and-subpath-exports.md).
2. **Monolithic policy engine.** `src/policy/engine.ts` now coordinates
   `budgets.ts`, `candidates.ts`, and `stability.ts` while preserving the
   `evaluatePolicy` contract.
3. **Per-file coverage.** Every `src/**` file is above 80% branch coverage; the
   lowest is 81.20% (`signals/collector.ts`).
4. **Inconsistent identifier validation.** `operationId` is trimmed; strategy,
   provider, signal, budget, and fallback identifiers reject surrounding
   whitespace. The rule is documented in [API.md](API.md).

Open:

5. **Post-publish verification is manual (medium).** The release workflow proves
   the publish command ran, not that the registry serves an installable package.
   After the first successful manual release, add a post-publish job that retries
   registry propagation, checks the version and integrity, and performs a clean
   consumer import.
6. **No benchmark regression tracking (low).** Benchmarks are intentionally not a
   CI gate because they are noisy on shared runners. Record a trend over time
   before considering a loose, non-blocking threshold.
7. **Provider start failure is permanent (low).** `SignalCollector` records a
   failed `start()` and emits error readings without retrying. Keep this behavior
   or add an explicit retry/backoff policy; either way, document it for provider
   authors.
8. **Queued abort latency is documented but real (low).** A run waiting behind
   another selection for the same operation id is not observed until the lock is
   released. Consider an abort-aware queue if this becomes a production issue.

## 0.3.0 — Extensibility without losing determinism

Candidate work, contingent on user demand:

- **Custom policy hook.** A pure function that receives the same evaluation input
  and candidate set and returns a target tier or strategy id, with validation and
  a required reason. The built-in policy remains the default.
- **Composite signals.** Derive a signal from multiple readings with explicit
  arithmetic and units, rather than encouraging hidden logic inside providers.
- **Async applicability.** Only if a clear need appears; it complicates selection
  latency and determinism.
- **Per-operation policy overrides.** Useful for multi-tenant services, but needs
  a careful precedence model against pins and global policy.
- **Latency-aware selection.** Requires an evidence-based design; simple averages
  are noisy and can cause oscillation.

Not planned for 0.3.0:

- Mid-run strategy switching.
- Speculative or hedged execution.
- Distributed state or coordination.
- An OS-level resource limiter.

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
`AbortSignal`, and standard timers.

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
