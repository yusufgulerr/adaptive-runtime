# ADR 0015: Per-operation policy overrides in multi-tenant runtimes

- **Status:** Accepted
- **Date:** 2026-10-23
- **Deciders:** Project maintainers

## Context

Adaptive Runtime enforces a global policy across all operations evaluated by a runtime instance. In multi-tenant systems, edge gateways, or workloads with diverse service-level objectives (SLOs), different operations require customized constraints:

- An interactive user-facing search operation may require a strict quality floor (`minQualityTier: 2`), whereas a background indexing operation on the same cluster requires aggressive cost reduction (`minQualityTier: 1`, tighter heap budgets).
- Previously, supporting distinct operational requirements necessitated instantiating multiple independent `AdaptiveRuntime` instances. This duplicated signal providers, metric collectors, and background event listeners, wasting system resources.

## Decision

- Introduce `AdaptiveRuntime.setOperationPolicy(operationId: string, policy: Partial<Policy> | null): void`.
- Allow callers to declare per-operation overrides for policy fields (`budgets`, `minQualityTier`, `maxQualityTier`, `missingSignalBehavior`, `evaluationIntervalMs`, `customSelector`, etc.). Setting `null` clears the override.
- Define a strict 4-tier selection precedence hierarchy:
  1. **Manual Pin (`pinStrategy`):** Highest priority; explicitly forces a strategy verbatim.
  2. **Adaptation Toggle (`setAdaptationEnabled`):** When disabled, retains the initial strategy without evaluating budgets.
  3. **Operation Policy Override (`setOperationPolicy`):** Merges declared operational rules over the global policy.
  4. **Global Policy:** Base fallback for all operations.
- Pure policy resolution: Introduce `resolveOperationPolicy(globalPolicy: ResolvedPolicy, operationPolicy: Partial<Policy> | null | undefined): ResolvedPolicy` in `src/policy/resolve.ts`. The resolution remains 100% pure, side-effect-free, and deterministic.
- Memory bounding: Integrate operation policy overrides into `maxTrackedOperations` LRU eviction. When an untracked, non-pinned, non-active operation is evicted from memory, its operational policy override is purged alongside its states and stats. Calling `removeOperation(operationId)` purges the override immediately.

## Consequences

### Positive

- **Multi-tenant efficiency:** A single runtime instance can orchestrate hundreds of diverse operations with distinct budgets and quality floors without duplicate infrastructure.
- **Strict determinism:** Policy merging is synchronous, pure, and obeys an unambiguous precedence model.
- **Bounded memory:** Governed by `maxTrackedOperations` LRU eviction and explicit `removeOperation()` cleanup.

### Negative / Neutral

- Requires resolving effective policy parameters per selection when an operation override is active. Resolution operates over small configuration objects and adds less than 0.5µs to the selection pipeline.
