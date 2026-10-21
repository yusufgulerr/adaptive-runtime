# ADR 0006: Bounded operation state and subpath exports

- **Status:** Accepted
- **Date:** 2026-10-21
- **Deciders:** Project maintainers

## Context

The runtime keeps policy state, the latest decision, the optional pin, the
adaptation override, and stats for every `operationId` it has seen. Those maps
were never evicted. A service that derives operation ids from requests, tenants,
or user input could therefore grow memory without bound, even though the runtime
itself has no background work. The threat model called this out as residual risk
T5/T6.

At the same time, `src/policy/engine.ts` had grown into one large function
covering budget transitions, candidate filtering, tier clamping, tie-breaking,
and stability gates. The behavior was correct but hard to review or extend
without re-reading the whole file.

Finally, the package exposed a single root entry point. Applications that only
needed the pure policy core or a built-in provider still loaded the entire
runtime graph, and the published package included documentation and development
files that were not needed at install time.

The constraints were:

- no runtime dependencies;
- deterministic selection for identical inputs, state, and clock values;
- exactly one strategy execution per `run()`;
- no Node APIs in the policy core;
- backward-compatible `evaluatePolicy` semantics and existing tests.

## Decision

### Bounded operation state

- Add `Policy.maxTrackedOperations?: number | null`. The default is `null`
  (unbounded). A configured value must be a positive safe integer.
- Track retained operation records in insertion order. Reading a decision or
  stats, selecting, pinning, updating adaptation state, and updating stats refresh
  recency.
- When the bound is exceeded, evict the least-recently-used operation that is
  not pinned, selecting, or executing. Eviction deletes its policy state,
  decision, adaptation override, and stats.
- Never evict pinned or active operations. The bound may be exceeded temporarily
  when every tracked operation is protected.
- Add `removeOperation(operationId): boolean`. It removes the same records
  explicitly and returns `false` while the operation is selecting or executing.
- Add `resetStats(operationId?)`. It clears counters and latency samples for one
  or all operations without discarding decisions, pins, adaptation overrides, or
  policy state.
- Track active runs with a private counter in addition to the selection lock.
  The selection lock alone is released before strategy execution, so it cannot
  protect an executing operation from eviction or removal.

### Modular policy core

Split the pure engine into:

- `budgets.ts` — reading resolution, hysteresis transitions, budget views;
- `candidates.ts` — filtering, base/target tier computation, clamping,
  required-tier choice, deterministic tie-breaking;
- `stability.ts` — minimum mode duration and pending-candidate streaks;
- `engine.ts` — precedence, decision assembly, and state update.

`evaluatePolicy` and `createInitialPolicyState` remain the entry points. The
split is internal and does not change reason codes, decision fields, or state
shape.

### Subpath exports and package contents

- Add `./policy` and `./providers` exports with their own `types`, `import`, and
  `default` conditions.
- The policy barrel exports `definePolicy`, `evaluatePolicy`,
  `createInitialPolicyState`, `resolvePolicy`, policy/decision types, and the
  budget/state types needed to call the engine. It has no Node imports.
- Reduce the published `files` list to `dist`, `README.md`, `LICENSE`, and
  `NOTICE`. Development docs, tests, examples, benchmarks, and source stay in the
  repository and on GitHub, not in the npm tarball.

### Consistent identifier validation

`operationId` remains trimmed. Strategy, provider, signal, budget, and fallback
identifiers reject leading or trailing whitespace. The rule is applied at the
same validation boundaries as the existing empty-string checks.

## Consequences

Positive:

- Memory growth is bounded and configurable, with deterministic eviction.
- Long-running services can release state explicitly without recreating the
  runtime.
- Pinned operational overrides and in-flight work cannot be discarded by
  eviction.
- The policy core is smaller per file and testable in isolation.
- Consumers can import the pure policy surface without loading Node providers.
- The published tarball is small and contains only runtime artifacts and
  licensing/readme files.
- Identifier rules are predictable across all public contracts.

Negative:

- Eviction discards an operation's history, so a later run for that id starts
  from initial policy state and zeroed stats.
- Pinned operations can keep the runtime above the configured bound until they
  are unpinned or removed.
- `removeOperation` cannot cancel an active run; it reports `false` instead.
- Two public entry points add a small maintenance surface and require
  integration tests for each.
- The default remains unbounded for backward compatibility; operators must opt
  in to a limit.

## Alternatives considered

- **TTL-based expiry:** requires a clock sweep or lazy timestamp checks and makes
  eviction depend on wall time. LRU is deterministic and needs no timer.
- **Evict the oldest record even if pinned or active:** simple, but silently
  drops operational overrides or corrupts an in-flight decision. Rejected.
- **Bound only the stats map:** leaves policy state, decisions, and pins
  unbounded; does not solve the reported risk.
- **Throw when the bound is exceeded:** turns a memory concern into a runtime
  failure for otherwise valid traffic. Rejected in favor of eviction.
- **A single root export only:** keeps the package surface minimal but forces
  policy-only consumers to load Node-specific modules.
- **Export every internal module:** exposes implementation files as a
  compatibility contract. Rejected; only the two intentional barrels are public.

## Follow-up

- Document the lifecycle API and LRU behavior in the README and API reference.
- Add integration tests that resolve each subpath and exercise
  `removeOperation`/`resetStats`.
- Keep every `src/**` file above 80% branch coverage.
- Revisit a post-publish consumer check and benchmark trend tracking in the
  roadmap.
- If per-operation policy overrides are added later, define their eviction and
  precedence rules explicitly.
