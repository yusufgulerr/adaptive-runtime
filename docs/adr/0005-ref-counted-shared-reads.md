# ADR 0005: Ref-counted shared provider reads

- **Status:** Accepted
- **Date:** 2026-10-21
- **Deciders:** Project maintainers

## Context

`SignalCollector` shares one in-flight provider read across concurrent runs. This
avoids duplicate provider work when many operations start together.

The first implementation created the read with the initiating caller's abort
signal. If the initiator aborted, every provider read was aborted and all waiting
callers received error readings. The initiator therefore had cancellation power
over unrelated runs. A waiting caller could abort its own wait without cancelling
the shared read, but could not protect the read from the initiator.

Sharing remains desirable: per-caller reads multiply provider cost exactly when
concurrency and resource pressure are high. The cancellation ownership model had
to change instead.

## Decision

- Each in-flight read owns a private `AbortController` and a waiter count.
- Every caller, including the initiator, joins the read through the same path and
  increments the waiter count.
- A caller's abort rejects only that caller and decrements the waiter count.
- The shared controller is aborted only when the last waiter leaves before the
  read settles.
- The initiator has no special cancellation privilege.
- A read aborted by all callers is not stored in the snapshot cache. A later run
  cannot observe its error readings.
- If an aborted read has not settled yet, a new collect starts a fresh read
  instead of joining the doomed one.
- The shared read is still one read per runtime, not one read per caller.

## Consequences

Positive:

- A cancelled operation cannot degrade a healthy concurrent operation.
- Cancellation remains prompt for the caller that requested it.
- Provider work is still deduplicated while at least one caller needs it.
- The behavior is testable at both the collector and runtime layers.

Negative:

- The collector carries a small amount of reference-counting state.
- A read aborted by every caller may still consume an internal sequence number
  before it settles; no caller receives that snapshot and it is not cached.
- A provider that ignores its abort signal may continue working after the last
  waiter leaves. `providerTimeoutMs` still bounds how long the collector waits.
- A cancellation storm followed by a new run can start a fresh provider read
  before the abandoned one has fully settled.

## Alternatives considered

- **Initiator-owned cancellation:** simple, but lets one run cancel unrelated
  runs. Rejected as the original limitation.
- **Per-caller provider reads:** removes interference but multiplies provider cost
  and can amplify load under pressure.
- **No sharing and no caching:** predictable cancellation, but the least efficient
  option for concurrent operations and contrary to the existing signal model.
- **Ignore all caller aborts until the provider settles:** keeps healthy callers
  safe but makes cancellation slow and wastes provider work for abandoned runs.

## Follow-up

- Add stress tests for cancellation storms and for `close()` during an in-flight
  read.
- Document provider authoring guidance in [PROVIDERS.md](../PROVIDERS.md).
- Revisit a conformance test helper if third-party providers appear.
