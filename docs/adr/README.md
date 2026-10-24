# Architecture decision records

- [0001 — TypeScript, ESM, zero runtime dependencies](0001-typescript-esm-zero-dependencies.md)
- [0002 — Deterministic tier policy with hysteresis](0002-deterministic-tier-policy.md)
- [0003 — One attempt, no automatic retries, cooperative cancellation](0003-single-attempt-cooperative-cancellation.md)
- [0004 — Explicit signal statuses and provider isolation](0004-explicit-signals-provider-isolation.md)
- [0005 — Ref-counted shared provider reads](0005-ref-counted-shared-reads.md)
- [0006 — Bounded operation state and subpath exports](0006-bounded-operation-state-and-subpath-exports.md)
- [0007 — Multi-runtime web and edge providers, and composite signals](0007-multi-runtime-web-edge-and-composite-providers.md)
- [0008 — Custom policy selector, observability bridge, and testing SDK](0008-custom-policy-selector-observability-and-testing-sdk.md)
- [0009 — Repository automation and supply-chain hardening](0009-repository-automation-and-supply-chain.md)
- [0010 — Two-phase GitHub and npm release](0010-two-phase-github-and-npm-release.md)
- [0011 — Observation immutability, asynchronous provider start, and metric identity](0011-observation-immutability-async-start-and-metric-identity.md)
- [0012 — Abort-aware selection queue and immediate cancellation](0012-abort-aware-selection-queue.md)
- [0013 — Strategy-level runtime statistics and latency awareness](0013-strategy-level-runtime-statistics.md)
- [0014 — Provider contract harmonization, lifecycle resilience, and reading bounds](0014-provider-contract-harmonization-and-lifecycle-resilience.md)
- [0015 — Per-operation policy overrides in multi-tenant runtimes](0015-per-operation-policy-overrides.md)
- [0016 — Shadow evaluation, state hydration, and provider expansion](0016-shadow-evaluation-state-hydration-and-provider-expansion.md)
- [0017 — Runtime introspection, bounded quality details, and composable policy selectors](0017-runtime-introspection-and-composable-selectors.md)
- [0018 — Selector composition, runtime introspection, and simulation fidelity](0018-selector-composition-and-simulation-fidelity.md)

## Decision map

The original project brief names three early decisions. They are covered without
duplicating records:

| Topic | Record |
| --- | --- |
| Runtime scope and platform | [0001](0001-typescript-esm-zero-dependencies.md) |
| Strategy selection and determinism | [0002](0002-deterministic-tier-policy.md) |
| Execution, retries, and cancellation | [0003](0003-single-attempt-cooperative-cancellation.md) |
| Signal provider model and unavailable data | [0004](0004-explicit-signals-provider-isolation.md) |
| Shared provider reads and ref-counted abort | [0005](0005-ref-counted-shared-reads.md) |
| Bounded state, modular policy core, and subpaths | [0006](0006-bounded-operation-state-and-subpath-exports.md) |
| Web/edge providers, portable core, composite signals | [0007](0007-multi-runtime-web-edge-and-composite-providers.md) |
| Custom selector, observability, testing SDK | [0008](0008-custom-policy-selector-observability-and-testing-sdk.md) |
| Repository automation and supply-chain checks | [0009](0009-repository-automation-and-supply-chain.md) |
| Two-phase GitHub and npm release | [0010](0010-two-phase-github-and-npm-release.md) |
| Published observation, async start, and metric identity | [0011](0011-observation-immutability-async-start-and-metric-identity.md) |
| Abort-aware selection queue and zero HoL delay | [0012](0012-abort-aware-selection-queue.md) |
| Strategy-level runtime statistics and latency awareness | [0013](0013-strategy-level-runtime-statistics.md) |
| Provider contract harmonization and lifecycle resilience | [0014](0014-provider-contract-harmonization-and-lifecycle-resilience.md) |
| Per-operation policy overrides and multi-tenant precedence | [0015](0015-per-operation-policy-overrides.md) |
| Shadow evaluation, state hydration, telemetry parity, provider expansion | [0016](0016-shadow-evaluation-state-hydration-and-provider-expansion.md) |
| Runtime introspection, bounded quality details, composable policy selectors | [0017](0017-runtime-introspection-and-composable-selectors.md) |
| Selector composition, runtime introspection, simulation fidelity | [0018](0018-selector-composition-and-simulation-fidelity.md) |

New decisions use the same structure: status, date, context, decision,
consequences, alternatives, and follow-up. A decision that changes public
semantics requires a major-version plan.
