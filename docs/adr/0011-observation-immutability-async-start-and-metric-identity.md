# ADR 0011: Observation immutability, asynchronous provider start, and metric identity

- **Status:** Accepted
- **Date:** 2026-10-22
- **Deciders:** Project maintainers

## Context

Three documented contracts were not fully enforced:

- Event listeners received the same decision object that the runtime later used
  to look up and execute a strategy. A listener could mutate `strategyId` and
  change which strategy ran. Successful run metadata was also mutable after it
  had been emitted and returned.
- `SignalProvider.start()` was typed as synchronous and invoked without observing
  a returned promise. An async start could reject as an unhandled rejection while
  the first read proceeded before initialization completed.
- Metric series keys joined label pairs with commas, so label values containing
  commas or equals signs could collide. Family type was inferred from the metric
  name suffix, so an observation recorded through `observe()` could be exported
  as a counter and silently lose its sample. Reusing one name across instrument
  kinds was accepted but could drop an entire series set from Prometheus output.

The audit also found two bounded-state edge cases: tracking-limit enforcement
could evict the adaptation override that `setAdaptationEnabled()` had just
written, and `pinStrategy()` silently trimmed padded strategy ids.

## Decision

### Immutable published observations

- Freeze a decision and its nested signal, budget, and reason views before it is
  stored and before the `decision` event is emitted.
- Freeze the success metadata and quality object before `run:success` is emitted
  and before the result is returned.
- Do not recursively traverse opaque `reason.details` values. They are part of
  the decision and are shallow-frozen, but application objects reachable from
  them are not frozen as a side effect.
- Listener exceptions remain isolated. A mutation attempt cannot change the
  executed strategy, `getDecision()` output, or returned metadata.
- Protect the override written by `setAdaptationEnabled()` from the enforcement
  call that immediately follows it. Later unrelated tracking may still evict it
  through normal LRU rules.
- Reject leading or trailing whitespace in `pinStrategy()` strategy ids instead
  of trimming them. Strategy matching is verbatim.

### Asynchronous provider start

- Widen `SignalProvider.start` to `void | Promise<void>`. This is backward
  compatible for existing providers.
- Invoke `start()` lazily at most once per provider and await a returned promise
  before the first read.
- Apply `providerTimeoutMs` and the caller's abort signal to the start wait.
  Cache a rejection or timeout as `startError`, report it through
  `provider:error` once, and return error readings on that and later reads.
- Do not cache a caller abort as a provider failure. Observe a late rejection so
  it never becomes an unhandled rejection.
- `start()` receives no abort signal. The timeout and abort bound only the
  collector's wait; provider work remains cooperative.

### Metric identity and family type

- Encode series keys with length-prefixed name and label segments. Distinct
  labels must always produce distinct keys, regardless of punctuation.
- Register family type from the recording instrument: `increment` is a counter,
  `setGauge` is a gauge, and `observe` is a histogram. The name suffix is not
  authoritative.
- Reject a conflicting instrument kind with `TypeError` before changing series
  state. `reset()` clears family registrations so a name can be reused.
- Keep snapshot shapes, Prometheus labels, and public method signatures
  unchanged.

## Consequences

Positive:

- The documented rule that events are observability rather than control flow is
  now enforced for decisions and metadata.
- Provider initialization is deterministic, bounded, and free of leaked
  rejections.
- Metric series cannot collide through label text, and observations cannot be
  exported under the wrong family type.
- The tracking bound no longer discards the state write that triggered
  enforcement.

Negative:

- Freezing publishes a small traversal cost on every selection and successful
  run. The benchmark suite must track this overhead.
- A provider that ignores the collector's timeout may continue starting after
  the first read has already failed.
- A name used with two instrument kinds now fails loudly instead of producing
  incomplete output. Applications must use one instrument kind per metric name.
- `reason.details` is only shallow-frozen; nested application data remains the
  caller's responsibility.

## Alternatives considered

- **Copy decisions for events while keeping a mutable internal object:** avoids
  freezing user data, but still permits `getDecision()` and metadata mutation and
  adds allocation on the hot path.
- **Deep-freeze every reachable object:** stronger isolation for event payloads,
  but freezes unrelated application objects passed through selector details.
  Rejected as an unacceptable side effect.
- **Fire-and-forget async start with a catch handler:** prevents an unhandled
  rejection but still lets reads race initialization. Rejected because it does
  not satisfy the lifecycle contract.
- **Infer metric type from the name suffix:** preserves the previous behavior but
  cannot represent custom histograms ending in `_total` or `_count`. Rejected as
  the source of the data-loss bug.
- **Allow mixed instrument kinds and rename families automatically:** changes
  public metric names and creates ambiguous output. Rejected in favor of an
  explicit configuration error.

## Follow-up

- Track the freeze traversal and async start path in the benchmark suite.
- Keep the provider lifecycle and metric family rules covered by regression
  tests.
- Revisit a bounded metric-series limit separately; this ADR does not introduce
  a cardinality bound.
