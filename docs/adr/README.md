# Architecture decision records

- [0001 — TypeScript, ESM, zero runtime dependencies](0001-typescript-esm-zero-dependencies.md)
- [0002 — Deterministic tier policy with hysteresis](0002-deterministic-tier-policy.md)
- [0003 — One attempt, no automatic retries, cooperative cancellation](0003-single-attempt-cooperative-cancellation.md)
- [0004 — Explicit signal statuses and provider isolation](0004-explicit-signals-provider-isolation.md)
- [0005 — Ref-counted shared provider reads](0005-ref-counted-shared-reads.md)
- [0006 — Bounded operation state and subpath exports](0006-bounded-operation-state-and-subpath-exports.md)
- [0007 — Multi-runtime web and edge providers, and composite signals](0007-multi-runtime-web-edge-and-composite-providers.md)
- [0008 — Custom policy selector, observability bridge, and testing SDK](0008-custom-policy-selector-observability-and-testing-sdk.md)

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

New decisions use the same structure: status, date, context, decision,
consequences, alternatives, and follow-up. A decision that changes public
semantics requires a major-version plan.
