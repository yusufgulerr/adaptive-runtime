# ADR 0014: Provider contract harmonization, lifecycle resilience, and reading bounds

- **Status:** Accepted
- **Date:** 2026-10-23
- **Deciders:** Project maintainers

## Context

An architectural audit of signal providers and `SignalCollector` revealed contract asymmetries and failure handling risks:

1. **Provider Constructor Asymmetry:** Phase 3 providers (`DeviceMemoryProvider`, `NetworkInformationProvider`, `FrameTimingProvider`, `ExecutionBudgetProvider`, `CompositeSignalProvider`) validated options rigorously via `validateId`, threw `ConfigurationError` on invalid options or whitespace-padded identifiers, and implemented `close()` to transition subsequent reads to `status: "unsupported"`. Conversely, Phase 1 providers (`ProcessMemoryProvider`, `CpuUtilizationProvider`, `EventLoopDelayProvider`, `NetworkLatencyProvider`) lacked whitespace validation, threw ad-hoc `TypeError`/`RangeError` exceptions, and omitted `close()`.
2. **Permanent Start Failures:** In `SignalCollector`, when a provider's `start()` rejected or timed out, the resulting error was cached permanently as `entry.startError` with `entry.started = true`. Subsequent reads returned synthetic `error` signals indefinitely without ever retrying, permanently disabling the provider even if the failure was transient.
3. **Start Context Absence:** `SignalProvider.start?()` took no arguments, yet providers like `CompositeSignalProvider` attempted to forward context to child providers. Start operations lacked an abort signal and timestamp.
4. **Reading Error Payload Bounding:** In `SignalCollector.#normalizeReadings`, while internal thrown exceptions were formatted via `errorMessage(error)` (capped at 1,000 characters), reading payloads directly returned by providers with non-ok statuses (`reading.error`) had no length limits, creating a memory and telemetry DoS vector (Threat Model T2).

## Decision

### Provider Contract Harmonization

- Harmonize all built-in providers (`ProcessMemoryProvider`, `CpuUtilizationProvider`, `EventLoopDelayProvider`, `NetworkLatencyProvider`) with the standard `validateId` helper.
- Standardize all invalid constructor option errors to `ConfigurationError`.
- Implement `close(): void` across all providers, ensuring post-close reads return explicit `status: "unsupported"` signals.

### Lifecycle Resilience & Context

- Introduce `SignalStartContext`:
  ```ts
  export interface SignalStartContext {
    readonly now: number;
    readonly signal: AbortSignal;
  }
  ```
- Widen `SignalProvider.start?(context: SignalStartContext): void | Promise<void>`.
- In `SignalCollector`, pass `{ now, signal }` to `provider.start(context)`. `CompositeSignalProvider` safely forwards this context to child providers.
- Transient start recovery: In `SignalCollector`, track the collection timestamp when a start failure occurred. If a start attempt fails, cache `startError` only for the duration of the current `evaluationIntervalMs`. On subsequent collection intervals, clear `startError` and `startPromise`, permitting the provider to attempt re-initialization.

### Reading Error Bounds

- In `SignalCollector.#normalizeReadings`, enforce `MAX_ERROR_MESSAGE_LENGTH = 1000` on provider-supplied `reading.error` strings:
  `reading.error.length > MAX_ERROR_MESSAGE_LENGTH ? `${reading.error.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…` : reading.error`

## Consequences

### Positive

- **Contract symmetry:** All 8 built-in providers follow the identical lifecycle, error taxonomy, and post-close semantics.
- **Self-healing runtimes:** Transient network or resource hiccups during initial startup no longer permanently incapacitate a signal provider.
- **DoS protection:** Bounded error string lengths protect memory, decision snapshots, and Prometheus/OpenTelemetry downstream collectors.

### Negative / Neutral

- Tests expecting `TypeError` or `RangeError` from Phase 1 provider constructors now catch `ConfigurationError`. This is an intended contract harmonization.
