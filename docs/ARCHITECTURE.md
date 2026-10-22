# Architecture

Adaptive Runtime is architected with a strict separation of concerns: a pure,
platform-agnostic policy core surrounded by a low-overhead orchestration layer
that owns provider lifecycle, execution, bounded operation state, and
observability. There are no runtime dependencies and no background scheduler.

## Runtime targets and entry points

One implementation serves Node.js, browsers, and WinterCG runtimes. The
isolation boundary is enforced at the module graph level, not by build flags:

```text
src/core.ts   platform-neutral runtime + policy + network latency + composite
src/node.ts   core + process memory / CPU / event-loop providers
src/web.ts    core + device memory / network information / frame timing
src/edge.ts   core + execution budget
src/index.ts  Node.js default (re-exports src/node.ts)
```

`src/policy/**`, `src/runtime/**`, `src/signals/**`, `src/types/**`,
`src/errors/**`, `src/observability/**`, `src/testing/**`,
`src/providers/web/**`, `src/providers/edge/**`, and
`src/providers/composite.ts` contain no Node.js built-in imports and never read
the Node.js `process` object. The test suite enforces this with a source scan.
Web providers accept structural `navigator`/`performance` shapes through optional
injection points, so the package compiles under `"lib": ["ES2022"]` without DOM
types.

## Component map

```text
                       ┌──────────────────────────────────────────┐
 application ─────────▶│ AdaptiveRuntimeImpl                      │
                       │  validation, per-operation serialization │
                       │  pins / adaptation overrides / stats     │
                       └───────┬──────────────────────┬───────────┘
                               │                      │
                     ┌─────────▼────────┐    ┌────────▼─────────┐
                     │ SignalCollector  │    │ Policy engine    │
                     │ lifecycle/cache  │    │ pure evaluation  │
                     │ timeout/validate │    │ state + decision │
                     └─────────┬────────┘    └────────┬─────────┘
                               │                      │
                     ┌─────────▼────────┐    ┌────────▼─────────┐
                     │ SignalProvider[] │    │ executeStrategy  │
                     │ Node/web/edge/composite │ timeout / abort │
                     └──────────────────┘    └──────────────────┘
                               │                      │
                     ┌─────────▼──────────────────────▼─────────┐
                     │ RuntimeEmitter + StatsRegistry           │
                     └──────────────────────────────────────────┘
                               │
                     ┌─────────▼────────────────────────────────┐
                     │ observability: collector / OTel bridge  │
                     │ (subscriber, never on the critical path)│
                     └──────────────────────────────────────────┘
```

| Path | Responsibility |
| --- | --- |
| `src/core.ts` | Platform-neutral entry point: runtime, policy helper, errors, types, network latency, composite signals |
| `src/node.ts` | Node.js entry point: core plus process providers |
| `src/web.ts` | Browser entry point: core plus web providers |
| `src/edge.ts` | WinterCG entry point: core plus the execution-budget provider |
| `src/runtime/runtime.ts` | Public orchestration, operation validation, serialization, LRU state, pins, stats, events |
| `src/policy/engine.ts` | Pure policy orchestration and decision assembly |
| `src/policy/budgets.ts` | Budget hysteresis and consecutive-sample transitions |
| `src/policy/candidates.ts` | Candidate filtering, clamping, and deterministic tie-breaking |
| `src/policy/stability.ts` | Minimum mode duration and pending-candidate streaks |
| `src/policy/resolve.ts` | Policy defaults and construction-time validation |
| `src/policy/index.ts` | Platform-neutral `adaptive-runtime/policy` entry point |
| `src/signals/collector.ts` | Provider start/close, snapshot cache, timeouts, reading validation |
| `src/runtime/executor.ts` | Exactly-once strategy invocation, timeout and abort races |
| `src/runtime/emitter.ts` | Typed events with listener isolation |
| `src/runtime/stats.ts` | Per-operation counters and duration samples |
| `src/providers/` | Node.js, web, edge, and composite signal providers |
| `src/observability/index.ts` | In-memory metrics collector, Prometheus text, OpenTelemetry bridge |
| `src/testing/index.ts` | Fake clock, scripted provider, provider conformance runner |
| `src/types/` | Public contracts |

The policy modules import only types, errors, and each other. They do not import
`node:*`, providers, the runtime, or any I/O. This makes selection testable with
plain objects and a fake clock, and lets `adaptive-runtime/policy` load in
non-Node tooling that understands ESM.

## Run sequence

For one `runtime.run(operation)`:

1. `#ensureOpen()` rejects a closed runtime.
2. `validateOperation()` checks the operation shape, strategy ids/tiers, abort
   signal, and timeout.
3. A pre-aborted caller signal rejects before stats are touched.
4. `StatsRegistry.begin()` increments `runs`.
5. `#select()` enters a per-operation promise chain, so decisions for the same
   operation cannot interleave.
6. `SignalCollector.collect()` returns a fresh or cached snapshot.
7. Applicability checks run for every strategy. A throwing check becomes
   `StrategyApplicabilityError` and fails the run.
8. `evaluatePolicy()` produces the next state and an immutable decision. The
   runtime stores both and emits `decision`.
9. The selected strategy is looked up, counted, and `run:start` is emitted.
10. `executeStrategy()` invokes `run()` exactly once and races it against timeout
    and abort promises.
11. The optional quality check runs. Its result is recorded or, in strict mode,
    converted into `QualityCheckError`.
12. Metadata is assembled, stats are updated, `run:success` is emitted, and the
    result is returned.
13. On any failure after stats begin, `run:error` is emitted and stats record a
    failure. The original error is rethrown.

There is no retry path and no fallback on strategy failure. `FallbackStrategyError`
refers only to a missing-signal fallback strategy, not to execution failure.

## Policy core

`evaluatePolicy(state, input, policy)` is a pure function. Inputs are:

- the previous `PolicyState`;
- the clock value;
- the collected readings;
- candidate metadata (`id`, `qualityTier`, `costTier`, `applicable`);
- pin and adaptation overrides;
- the snapshot sequence and cache flag.

It returns a new state and a `StrategyDecision`. It never mutates its arguments.
The runtime owns state storage keyed by `operationId`.

### Candidate filtering

Candidates are filtered by:

- `applicable === true`;
- `qualityTier >= minQualityTier`, when set;
- `qualityTier <= maxQualityTier`, when set.

If the filtered pool is empty, selection fails with `NoEligibleStrategyError`
(except when a pin or missing-signal fallback resolves first).

`baseQualityTier` is the highest declared tier across **all** strategies, capped
by `maxQualityTier`; it is not recomputed from the filtered pool. `minQualityTier`
does not lower the base.

### Precedence

The order in `evaluatePolicy` is intentional:

1. **Pin** — bypasses pressure, quality floor/ceiling, and minimum mode duration;
   still checks existence and applicability.
2. **Missing-signal fallback** — only in automatic mode with behavior `"fallback"`.
3. **No candidates** — error.
4. **Adaptation disabled** — highest applicable candidate.
5. **Automatic adaptive selection**.

Validation of `"error"` / `"ignore"` / `"hold"` missing-signal behavior happens
before these branches and only in automatic mode. Pin and static modes do not
fail because a budget signal is unavailable.

### Budget state machine

Each budget keeps:

```ts
{ engaged: boolean, aboveStreak: number, belowStreak: number }
```

Only fresh snapshots advance streaks. A snapshot with a sequence number the
operation already processed reuses the previous budget state and adds
`cached-sample`; a cached snapshot with a new sequence number is processed
normally.

On the first evaluation for an operation (`state.initialized === false`), a
budget engages immediately if `value > limit`; no streak is required. This
prevents one run at the highest tier simply because the first sample arrived
during pressure.

After initialization:

- disengaged: `value > limit` increments `aboveStreak`, anything else resets it;
- engage when `aboveStreak >= consecutiveSamples`;
- engaged: `value < recoverBelow` increments `belowStreak`, anything else resets it;
- release when `belowStreak >= consecutiveSamples`.

Equality falls into the reset branch, so it neither engages nor releases. The
`recoverBelow <= limit` validation guarantees a non-negative hysteresis band.

### Target tier and choice

The target is:

```text
clamp(baseQualityTier - sum(engaged.tierReduction),
      max(minQualityTier, lowest available tier),
      highest available tier)
```

Clamping order is floor first, then the available pool. Reasons are appended for
each clamp. Selection then chooses the highest-quality candidate with
`qualityTier <= target`; ties use lower `costTier` (missing cost ranks last),
then code-unit `id` order.

### Switch stabilization

A switch to a different candidate is blocked while:

- `now - modeSince < minimumModeDurationMs`; or
- the candidate has not appeared for `consecutiveSamples` fresh evaluations.

The blocked candidate and its streak are stored in state, so alternating
candidates do not accumulate credit. When the current strategy is no longer in
the candidate pool, the runtime switches immediately and records
`current-strategy-inapplicable`.

### Custom selector hook

After budgets, clamping, and the default candidate are resolved, but before the
stability gates, `evaluatePolicy` may call `policy.customSelector` with a
snapshot of eligible candidates, signals, operation id, and clock value. The
selector may return a strategy id, `{ strategyId, reason }`, or `null`/
`undefined` to keep the default. The returned id must match an applicable
candidate inside the quality bounds; otherwise the decision fails with
`ConfigurationError`. A valid choice adds a `custom-selector` reason and then
passes through the normal `minimumModeDurationMs` and `consecutiveSamples` gates.
The selector therefore refines, but cannot bypass, applicability, quality bounds,
hysteresis, or mode stability. The context is a fresh snapshot; the policy core
does not retain it.

## Signal collection

`SignalCollector` owns providers and raw readings.

- Providers are started lazily the first time they are read. A start failure is
  cached as `startError` and converted to error readings on every read.
- `close()` sets the closed flag, clears the snapshot, and calls every provider's
  `close()` via `Promise.allSettled`. Failures are reported through
  `provider:error`.
- A snapshot within `evaluationIntervalMs` is returned with `cached: true`.
- A runtime with no providers returns an empty snapshot through a fast path; no
  shared-read controller or waiter state is allocated.
- Concurrent callers share one in-flight read. The second caller always sees
  `cached: true`, even if it arrived before the read resolved.
- Cancellation is ref-counted. A waiting caller can abort its own wait; the
  shared read is aborted only when every waiter has left. The initiating caller
  has no special privilege.
- A fresh read races every provider against `providerTimeoutMs` and the shared
  read's abort signal.
- Readings are validated and normalized; omitted declared signals become
  `unknown`.
- Sequence numbers increase only for fresh snapshots. The policy uses the
  sequence, not the cache flag alone, to decide whether counters advance.

### Composite signals

`CompositeSignalProvider` is an ordinary `SignalProvider` that wraps child
providers. Its constructor validates the provider list, rule list, input
declarations, unique rule names, and collisions with passthrough inputs. On
`read()`, it awaits every child with `Promise.all`, indexes readings by name, and
evaluates each rule only when every input is `ok`. Otherwise it synthesizes the
highest-priority unavailable status (`error` > `stale` > `unsupported` >
`unknown`) and never calls `compute`. A thrown compute or non-finite result
becomes an `error` reading. Lifecycle hooks are forwarded to every child. The
composite is platform-neutral and belongs to the core entry point.

### Shared read cancellation

Each in-flight read has its own `AbortController` and a waiter count. Joining
increments the count; a caller's abort rejects that caller and decrements it. The
last waiter to leave aborts the controller, which the providers observe through
their read signals. If all callers leave, the error readings are not cached.

This removes the earlier limitation where the initiator's abort could poison a
snapshot for other callers. Provider reads are still shared: there is one read
per runtime, not one per caller.

## Execution

`executeStrategy` creates a child `AbortController` for the strategy. It races:

- the strategy promise;
- a caller-abort promise (if a signal was supplied);
- a timeout promise (if `timeoutMs` was supplied).

On timeout it aborts the child signal and rejects with `OperationTimeoutError`.
On caller abort it aborts the child signal and rejects with
`OperationAbortedError`. Any other rejection becomes `StrategyExecutionError`.

Because JavaScript cannot cancel arbitrary promises, late settlement is possible.
The runtime attaches handlers through `Promise.race`; the strategy's own work can
continue after the caller sees a rejection.

Timers are created through the injected `Clock`, and are cancelled in `finally`.
Removing the abort listener is also done in `finally`.

## Concurrency model

- **Per operation:** selection is serialized. This protects policy state from
  read-modify-write races and makes decisions deterministic under concurrent
  runs. The lock is a promise chain stored in a map and deleted when settled.
- **Across operations:** selection, providers, and execution can overlap.
- **Provider reads:** one in-flight read per runtime, shared by all operations.
- **Strategy execution:** concurrent runs may execute the same or different
  strategies simultaneously. The runtime provides no strategy-level locking.
- **Events:** emitted synchronously in registration order. Listener exceptions
  are isolated.

The runtime does not bound concurrency. Callers that need admission control must
provide it. It can bound retained per-operation state instead; see below.

## Bounded operation state

Operation-keyed maps (`#states`, `#decisions`, `#pins`,
`#adaptationOverrides`, `#stats`, `#locks`, and the active-run counter) grow with
the number of distinct operation ids. `Policy.maxTrackedOperations` bounds them.

- The default is `null` (unbounded). A configured value must be a positive safe
  integer.
- Retained operation records form an LRU list. Reading a decision or stats,
  selecting, pinning, and updating stats all refresh recency.
- When an insert would exceed the bound, the least-recently-used operation that
  is not pinned, selecting, or executing is evicted. That operation loses its
  decision, stats, policy state, and adaptation override. Pins prevent eviction,
  so an evicted operation never loses a pin.
- If every retained operation is protected, the runtime temporarily exceeds the
  bound. It never evicts active or pinned work to satisfy the limit.
- `removeOperation(id)` performs the same cleanup explicitly and returns `false`
  while that operation is selecting or executing.
- `resetStats(id?)` clears counters without discarding decisions, pins, or policy
  state. Resetting one operation retains its LRU entry; resetting all removes
  entries that no longer own any state.

Eviction is deterministic: the LRU order is the insertion/refresh order, and no
clock or sampling influences it.

## Lifecycle

```text
created ──run/collect──▶ providers started lazily
   │
   ├── pin / unpin / setAdaptationEnabled
   ├── getDecision / getStats / on
   │
   └── close() ──▶ providers closed ──▶ runtime:closed
                         │
                         └── future run/pin/unpin/set → RuntimeClosedError
```

`getDecision`, `getStats`, `on`, and `unpinStrategy` are not blocked after close
except that `pinStrategy` and `setAdaptationEnabled` call `#ensureOpen()`;
`unpinStrategy` also checks. Decisions and stats remain readable.

`close()` is idempotent and returns the same promise. It does not wait for
in-flight strategies. Callers should settle those first.

## Error model

Errors are split into three layers:

- **Configuration:** invalid policy, operation, providers, or clock; thrown
  before work.
- **Selection:** no eligible strategy, missing required signal, unavailable
  pin/fallback, or applicability throw.
- **Execution:** strategy throw, timeout, abort, or strict quality failure.

Provider read failures are not thrown from `run()`. They are data: error
readings that drive missing-signal behavior. This keeps a broken metrics source
from crashing application work.

Events are observability, not control flow. A listener cannot veto a decision or
change a result.

## Observability and testing layers

These layers are optional and sit outside the decision path.

The in-memory collector subscribes to runtime events and maintains counters,
gauges, and a duration histogram. It is pull-based: no timers, sockets, or
background flush. `toPrometheusText()` renders the registry deterministically.
The OpenTelemetry adapter accepts a structural meter and forwards the same
events; instrument failures are contained. Neither layer changes a decision or a
run result, and neither turns an unavailable signal into a zero gauge.

The testing SDK provides a deterministic clock, a scripted provider, and a
provider conformance runner. It is platform-neutral, depends only on public
types and `ConfigurationError`, and is excluded from the runtime's hot path. The
conformance runner validates descriptors, lifecycle, reading shape, units,
timestamps, status codes, values, confidence, and error strings, returning a
report rather than throwing.

## Design trade-offs

| Choice | Benefit | Cost |
| --- | --- | --- |
| In-memory per-process state | Simple, fast, no dependencies | No persistence or cross-process coordination |
| Per-operation serialization | Deterministic state transitions | Same-operation runs cannot select in parallel |
| Ordinal tiers, not measured quality | Provider-agnostic and predictable | Developer declarations can be wrong |
| Hysteresis + stability gates | Avoids flapping | Slower reaction to sudden changes |
| Cooperative cancellation | Works with plain JS promises | Cannot stop uncooperative work |
| Error readings instead of throwing | Resilient to telemetry failures | Failures can be silent unless observed |
| No retries | Predictable attempt counts and side effects | Applications must implement their own retry policy |
| Zero dependencies | Minimal supply chain and install footprint | Some utilities are implemented locally |
| Bounded LRU state | Predictable memory under high-cardinality ids | Least-recently-used state can be discarded |

## Extension points

- Implement `SignalProvider` for custom metrics. Use `context.now` for
  `observedAt` and honor `context.signal`. Validate with
  `runProviderConformanceCheck`.
- Combine providers or derive policy signals with `CompositeSignalProvider`
  instead of duplicating measurement logic.
- Implement `Strategy` for algorithms. Use `isApplicable` for input-dependent
  eligibility and `checkQuality` for cheap invariants.
- Inject a `Clock` for deterministic tests. Use `createFakeClock` from
  `adaptive-runtime/testing`.
- Use `policy.customSelector` to refine the automatic choice without bypassing
  eligibility or stability gates.
- Subscribe to events for logs or metrics, or attach the built-in collector /
  OpenTelemetry bridge.
- Use pins and `setAdaptationEnabled` for operational controls.
