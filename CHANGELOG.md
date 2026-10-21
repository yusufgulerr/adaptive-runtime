# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project intends
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) after 1.0.

## [Unreleased]

No changes yet.

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
  verification, migration/upgrade guide, cookbook, and five ADRs.
- Apache-2.0 license, contribution guide, code of conduct, security policy,
  support guide, issue forms, pull request template, Dependabot, CI, CodeQL, and
  release workflow definitions.

### Changed

- Shared signal reads now use a per-read abort controller and waiter count. The
  initiating caller no longer controls cancellation for other waiting runs, and
  an all-aborted read is not cached.

### Notes

- Version 0.1.0 is the first public release.
- The public repository, CI, CodeQL, and tag-driven release workflow are
  established; CI passes on Node.js 22, 24, and 26.
- The package is published with npm provenance.
- The runtime is not a sandbox and does not enforce OS resource limits.
- Public API and decision reason codes may change during 0.x.
