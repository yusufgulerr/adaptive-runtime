# Migrating from a manual fast/slow flag

> **Status:** Adaptive Runtime 0.3.0 is the current development line. The GitHub
> release is tag-driven; npm publication is a separate owner-approved OIDC
> workflow dispatch and is pending.
> This guide describes adopting the runtime from a local checkout. It does not
> describe upgrading a published package, because no published package exists
> yet. See [Status and limitations](../README.md#status-and-limitations).

A common starting point is a boolean flag that chooses between an exact path and
a cheaper approximate path:

```ts
const useFastPath =
  process.env.SEARCH_FAST === "1" ||
  process.memoryUsage().heapUsed > 512 * 1024 * 1024;
return useFastPath ? sampledMatches(input) : exactMatches(input);
```

That works until the flag has to answer several different questions: which
signal, which threshold, how long pressure must last, what to do when the signal
is unavailable, and why a particular request took the slow path. Adaptive Runtime
makes those choices explicit and returns the decision with the result.

## Prerequisites

- Node.js `>=22.0.0`.
- ESM. The package exposes the root entry point along with specialized subpaths
  (`./core`, `./node`, `./web`, `./edge`, `./policy`, `./providers`,
  `./observability`, `./testing`) and `./package.json`; a CommonJS codebase needs
  an ESM boundary or a dynamic import.
- A local checkout installed as described in
  [Installation](../README.md#installation). The package is not on npm.

## Shared setup

The before and after snippets use the same small search functions:

```ts
interface SearchInput {
  readonly query: string;
  readonly corpus: readonly string[];
}

function exactMatches(input: SearchInput): readonly string[] {
  return input.corpus.filter((item) => item.includes(input.query));
}

function sampledMatches(input: SearchInput): readonly string[] {
  const sampleSize = Math.max(1, Math.floor(input.corpus.length * 0.1));
  return input.corpus
    .slice(0, sampleSize)
    .filter((item) => item.includes(input.query));
}
```

The sample is deliberately simple. It does less work than the exact scan and can
miss matches; that is the quality trade-off the policy will make explicit.

## Before: one flag, one threshold

```ts
const EXACT_THRESHOLD_BYTES = 512 * 1024 * 1024;

function searchCatalog(input: SearchInput): readonly string[] {
  const useFastPath =
    process.env.SEARCH_FAST === "1" ||
    process.memoryUsage().heapUsed > EXACT_THRESHOLD_BYTES;

  return useFastPath ? sampledMatches(input) : exactMatches(input);
}
```

The flag is doing more work than it appears to:

| Hidden responsibility | Current behavior |
| --- | --- |
| Measurement | One `process.memoryUsage()` call per request |
| Threshold | A constant embedded in application code |
| Scope | A process-wide environment variable plus a global memory check |
| Stability | No hysteresis or sample count; a value near the threshold can flip |
| Missing data | Not modeled; this particular call always returns a number |
| Explanation | None; callers cannot see why the path changed |
| Testing | Tests must manipulate the environment or process memory |

## After: two strategies and one budget

```ts
import {
  createAdaptiveRuntime,
  ProcessMemoryProvider,
  type Strategy,
} from "adaptive-runtime";

interface SearchResult {
  readonly matches: readonly string[];
  readonly strategyId: string;
}

const strategies: readonly Strategy<SearchInput, SearchResult>[] = [
  {
    id: "exact-search",
    qualityTier: 3,
    costTier: 3,
    description: "Scans the full corpus.",
    run: ({ input, strategyId }) => ({
      matches: exactMatches(input),
      strategyId,
    }),
  },
  {
    id: "sampled-search",
    qualityTier: 1,
    costTier: 1,
    description: "Scans a prefix sample; may miss matches.",
    run: ({ input, strategyId }) => ({
      matches: sampledMatches(input),
      strategyId,
    }),
  },
];

const runtime = createAdaptiveRuntime({
  providers: [new ProcessMemoryProvider()],
  policy: {
    evaluationIntervalMs: 1_000,
    maxSignalAgeMs: 5_000,
    consecutiveSamples: 2,
    minimumModeDurationMs: 5_000,
    budgets: [
      {
        id: "heap-pressure",
        signal: "process.memory.heapUsed",
        limit: 512 * 1024 * 1024,
        recoverBelow: 384 * 1024 * 1024,
        tierReduction: 2,
      },
    ],
    missingSignalBehavior: "hold",
  },
});

const catalog = [
  "wireless keyboard",
  "wired keyboard",
  "wireless mouse",
];

const { value, metadata } = await runtime.run({
  operationId: "catalog-search",
  input: { query: "wireless", corpus: catalog },
  strategies,
  timeoutMs: 2_000,
});

console.info(
  metadata.strategyId,
  value.matches.length,
  metadata.decision.kind,
  metadata.decision.reasons.map((reason) => reason.code),
);

await runtime.close();
```

With no pin and no `maxQualityTier`, the highest declared tier is the starting
point. While the heap budget is engaged, the target tier drops by two, so
`sampled-search` is selected. When the budget releases, the target returns to the exact strategy.
The decision carries the signal values, budget states, and reason codes that
explain the choice.

`ProcessMemoryProvider` reports this process's heap and RSS, not machine-wide
memory. If the old flag measured host memory or a container limit, supply a
provider for that source instead; the built-in providers are listed in
[API.md](API.md#built-in-providers).

## What the runtime now owns

| Manual flag | Runtime equivalent |
| --- | --- |
| Ad-hoc `process.memoryUsage()` call | Provider read, cached for `evaluationIntervalMs` |
| Immediate switch at a threshold | Budget engages after `consecutiveSamples` fresh samples; the first sample can engage immediately |
| Env var override | `pinStrategy` for a named path, or `setAdaptationEnabled` to disable adaptation for one operation; reapply after restart |
| No explanation | `metadata.decision` with `signals`, `budgets`, and `reasons` |
| Unhandled missing measurement | Explicit signal status plus `missingSignalBehavior` |
| Assumed "fast" path | Declared `costTier`; the runtime does not measure speed |

A budget is a **selection threshold**, not an operating-system limit. It changes
which strategy is eligible; it does not make memory, CPU, or latency smaller.

## When a flag is still the right tool

Do not force every boolean into a quality tier:

- If the flag is a hard correctness gate, keep the exact path or pin it. A tier
  is a declaration, not a proof.
- If the choice depends on input shape, tenant policy, or a business rule, use
  `isApplicable` or a separate operation id. Budgets model resource pressure.
- If you need retries, hedging, or mid-run switching, the runtime intentionally
  does not provide them.
- If the measurement source cannot be made explicit or trustworthy, a provider
  would only move the guesswork.

## Rollout controls

If the old flag is still needed during rollout, keep it as an explicit pin
instead of an `if` around the call:

```ts
if (process.env.SEARCH_FORCE_EXACT === "1") {
  runtime.pinStrategy("catalog-search", "exact-search");
}
```

A pin bypasses quality pressure, `minQualityTier`, `maxQualityTier`, and
`minimumModeDurationMs`, but the pinned strategy must exist and be applicable. An
invalid pin fails the run with `PinnedStrategyError`; there is no silent fallback.
Pins are per operation and are not persisted, so a restarted process must reapply
them from configuration.

For a softer switch, `runtime.setAdaptationEnabled("catalog-search", false)`
ignores budgets and selects the highest applicable tier allowed by the quality
floor and ceiling. A pin takes precedence over that setting. See
[API.md](API.md#setadaptationenabledoperationid-enabled) for the exact
precedence.

## 0.x compatibility policy

There is no published 0.x release today, so there is no released upgrade matrix
or deprecation window to cite. The project's stated policy for the 0.x line is:

- **0.x is pre-1.0.** Breaking changes are allowed, but they must be
  documented in [CHANGELOG.md](../CHANGELOG.md) and, for semantic changes, in an
  ADR.
- **Prefer additive optional fields** over changing the meaning of existing
  fields.
- **Do not change reason codes, error classes, or decision semantics silently.**
  Reason codes are intended to be stable within 0.x.
- **A new public option needs a test, a documentation update, and a clear
  default.**
- **Semantic Versioning is intended after 1.0.** The 0.x line does not promise
  SemVer compatibility.
- **Node.js support follows** the policy in [ROADMAP.md](ROADMAP.md). Dropping a
  supported line is a breaking change outside end-of-life.

When you update the local tree, read the changelog, follow any linked ADR, and
re-run the tests that assert your strategy choices. Because no release exists,
treat the checked-out source as the source of truth rather than assuming a
version-to-version contract.

## Behavior changes to account for

### Provider reads are shared and ref-counted

Concurrent runs share one in-flight provider read per runtime. Each read has its
own abort controller and a waiter count:

- a caller's abort rejects only that caller;
- providers see an abort when the last waiting caller leaves or the provider
  timeout expires;
- the initiating caller has no special cancellation privilege;
- a read aborted by every caller is not cached, and a later run starts a fresh
  read;
- an aborted read that has not settled is not joined by a new caller.

This replaces the earlier local behavior where the initiating caller's abort
could cancel the shared read for everyone; the changelog records it under
Unreleased in [CHANGELOG.md](../CHANGELOG.md). The migration consequence is that
aborting your run does not necessarily stop measurement work while another
waiter still needs it. Custom providers should honor `context.signal`, and
`providerTimeoutMs` bounds how long the collector waits. See
[ADR 0005](adr/0005-ref-counted-shared-reads.md),
[PROVIDERS.md](PROVIDERS.md#shared-reads-and-cancellation), and
[ARCHITECTURE.md](ARCHITECTURE.md#shared-read-cancellation).

### Ties break on code-unit id order

Candidate choice is deterministic, in this order:

1. highest declared `qualityTier` at or below the target;
2. lower `costTier` when quality tiers are equal; a missing `costTier` ranks
   last;
3. ascending `id` by UTF-16 code-unit comparison.

The last step is the JavaScript `<` and `>` comparison, not `localeCompare`.
Declaration order is not a tie-breaker. Consequences:

- `"Build"` sorts before `"build"` because uppercase code units come first.
- `"job-10"` sorts before `"job-2"` because the comparison is lexicographic, not
  numeric.
- Renaming a strategy can change a tie outcome even if its behavior is unchanged.

Use stable, descriptive ids. If numeric suffixes matter, zero-pad them
(`"job-02"`, `"job-10"`) or use distinct prefixes. See
[ADR 0002](adr/0002-deterministic-tier-policy.md).

### One attempt, no retries

`run()` invokes exactly one strategy. A thrown or rejected strategy becomes
`StrategyExecutionError`; the runtime does not retry it, run a second strategy, or
switch mid-run. `metadata.attempts` is always `1`. Keep any existing retry,
backoff, or fallback-on-error logic outside the runtime, and make side effects
idempotent. See
[ADR 0003](adr/0003-single-attempt-cooperative-cancellation.md).

### Tiers are declarations

`qualityTier` and `costTier` are application declarations. The runtime does not
measure output quality, speed, or cost, and it cannot verify that a tier is
honest. `checkQuality` can report a cheap invariant or reject the run in strict
mode, but it never triggers a retry or a different strategy. Measure quality
externally before assigning tiers, and keep that measurement in your own test or
evaluation harness.

## Migration checklist

- [ ] List every manual flag, environment variable, threshold, and override.
- [ ] Classify each one as a performance heuristic, a correctness requirement,
      or an emergency operational control.
- [ ] Map each logical workload to a stable, low-cardinality `operationId`; do
      not use raw user input as the id.
- [ ] Implement each path as a `Strategy` with a truthful `qualityTier`.
- [ ] Add `costTier` only when you have a reason to prefer one strategy over
      another at the same declared quality.
- [ ] Measure output quality against a reference before assigning tiers, and
      record the method and fixture.
- [ ] Pick a signal that measures the actual constraint; confirm its unit and
      whether it is process-local or host-wide.
- [ ] Return explicit `unknown`, `unsupported`, `stale`, or `error` readings for
      unavailable data; never substitute `0`.
- [ ] Set `providerTimeoutMs` and make custom provider reads honor
      `context.signal`.
- [ ] Choose `evaluationIntervalMs` and `maxSignalAgeMs` together; a cached
      snapshot still ages.
- [ ] Choose `consecutiveSamples`, `minimumModeDurationMs`, `limit`, and
      `recoverBelow` to avoid flapping.
- [ ] Choose `missingSignalBehavior`. If you use `"fallback"`, make the fallback
      applicable and safe at any tier.
- [ ] Decide whether quality checks are `"report"` or `"error"`. Do not rely on
      a failed check to run another strategy.
- [ ] Keep retries and fallback-on-error outside the runtime, with idempotent
      side effects.
- [ ] Roll out with a pin or `setAdaptationEnabled` first, then compare decisions
      and outputs before removing the old flag.
- [ ] Add deterministic tests with fixed providers and a fake clock; assert the
      selected strategy, decision kind, budget state, and quality status.
- [ ] Subscribe to `decision`, `run:error`, and `provider:error`; keep label
      cardinality bounded.
- [ ] Close the runtime during shutdown after in-flight runs settle, and reapply
      pins or adaptation overrides after a restart.

## Anti-patterns

| Anti-pattern | Why it fails |
| --- | --- |
| Copying "fast" and "slow" names into tiers without measuring | The runtime cannot verify tiers, so a mislabeled strategy silently produces worse output |
| Returning `0` when a measurement is unavailable | Turns missing pressure into a healthy reading and defeats the policy |
| Creating a runtime per request | Loses budget and mode state, repeats provider startup, and resets stats |
| Using one `operationId` for unrelated workloads | Budgets, mode history, pins, and stats leak across those workloads |
| Expecting `run()` to retry or fall back on strategy failure | It does not; the failure is surfaced as `StrategyExecutionError` |
| Treating a timeout as guaranteed cancellation | Cancellation is cooperative; work and side effects can continue |
| Relying on declaration order for equal tiers and costs | Code-unit `id` order decides, not array order |
| Calling `close()` while runs are in flight | Provider shutdown can affect a pending read |

## What this migration does not do

- It does not make strategies correct, fast, or safe.
- It does not enforce CPU, memory, or network limits.
- It does not persist decisions, pins, or stats across processes.
- It does not add retries, hedging, or mid-run switching.
- It does not verify that a declared quality tier matches real output.

Those remain application responsibilities. For concrete implementation patterns,
see [COOKBOOK.md](COOKBOOK.md). For the full contracts, see
[API.md](API.md) and [API_DESIGN.md](API_DESIGN.md).

## Related documents

- [API reference](API.md)
- [API design notes](API_DESIGN.md)
- [Cookbook](COOKBOOK.md)
- [Provider authoring](PROVIDERS.md)
- [Architecture](ARCHITECTURE.md)
- [Observability](OBSERVABILITY.md)
- [Threat model](THREAT_MODEL.md)
- [README](../README.md)
- [ADR 0002: deterministic tier policy](adr/0002-deterministic-tier-policy.md)
- [ADR 0003: single attempt and cooperative cancellation](adr/0003-single-attempt-cooperative-cancellation.md)
- [ADR 0005: ref-counted shared reads](adr/0005-ref-counted-shared-reads.md)
