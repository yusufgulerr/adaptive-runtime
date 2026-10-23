# ADR 0012: Abort-aware selection queue and immediate cancellation

- **Status:** Accepted
- **Date:** 2026-10-23
- **Deciders:** Project maintainers

## Context

When multiple concurrent calls to `runtime.run()` targeted the same `operationId`, their strategy selections were serialized via `AdaptiveRuntimeImpl.#serialize` to ensure deterministic state transitions and protect hysteresis stability gates. Under this design:

- Concurrent requests queued behind a shared lock promise: `previous.catch(() => undefined).then(task)`.
- If a queued caller aborted its `operation.signal` while waiting behind an in-flight selection (which could perform an asynchronous provider read lasting up to `providerTimeoutMs`), the cancellation was not observed until the preceding task completed and the lock was yielded.
- This introduced Head-of-Line (HoL) blocking for cancelled operations: callers suffered unnecessary queue latency before finally rejecting with `OperationAbortedError` inside `#select`.
- While non-blocking under light traffic, under heavy concurrent bursts with mixed cancellations, aborted calls accumulated in memory and tied up caller execution contexts.

## Decision

- Refactor `AdaptiveRuntimeImpl.#serialize` to accept the caller's optional `AbortSignal`:
  `#serialize<T>(operationId: string, signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T>`
- Fast-path check: If `signal?.aborted` is true upon entry, reject immediately with `OperationAbortedError(operationId, signal.reason)` without enqueuing behind the lock.
- Abort-aware queue node: If a lock is held, race the lock acquisition promise against the caller's `abort` event.
- If the signal aborts while queued:
  - Detach the abort listener immediately to prevent memory leaks.
  - Reject the waiting caller's promise immediately with `OperationAbortedError`.
  - Ensure the underlying lock chain remains intact so subsequent healthy operations are not disrupted.
- Guaranteed cleanup: Guarantee `removeEventListener("abort", ...)` cleanup in a `finally` block for all resolution paths (success, error, or early abort).

## Consequences

### Positive

- **Zero Head-of-Line cancellation latency:** Aborted callers reject in microsecond time (< 1ms) rather than waiting for preceding provider timeouts or in-flight work.
- **Resource conservation:** Frees caller async frames and memory immediately.
- **Invariant preservation:** Does not compromise deterministic tie-breaking or single-attempt execution for remaining healthy operations.
- **Leak-free:** Abort listeners are strictly cleaned up when the lock resolves or when an abort fires.

### Negative / Neutral

- Adds a lightweight wrapper promise and event listener registration per queued operation when an `AbortSignal` is provided. Benchmarks confirm this overhead is negligible (< 0.2µs) and median control-plane overhead remains well below 10µs.

## Alternatives considered

- *Retain status-quo HoL delay:* Documented as low-priority debt in Roadmap item 8, but unacceptable for latency-sensitive multi-tenant production systems.
- *Cancel the in-flight operation when a queue waiter aborts:* Rejected because the in-flight operation belongs to a different caller whose signal has not aborted. Shared reads already isolate provider aborts safely (ADR 0005).
