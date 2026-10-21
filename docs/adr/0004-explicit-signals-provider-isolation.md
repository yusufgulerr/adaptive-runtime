# ADR 0004: Explicit signal statuses and provider isolation

- **Status:** Accepted
- **Date:** 2026-10-21
- **Deciders:** Project maintainers

## Context

Resource measurements fail in many ways: a platform API is missing, a probe times
out, a value is not ready, or a reading is too old. A common shortcut is to treat
unavailable data as zero. That silently converts "unknown memory pressure" into
"no memory pressure" and can select the most expensive strategy at the worst time.

Providers may also be third-party or application code and can throw, return
malformed data, or hang.

## Decision

- Model readings as a discriminated union of available (`status: "ok"`) and
  unavailable (`unknown`, `unsupported`, `stale`, `error`) values.
- Never coerce an unavailable reading to `0`.
- Validate provider output strictly:
  - array of declared signals only;
  - unique names, unit match, valid timestamp and status;
  - finite values for `ok`, confidence in `0..1`.
- Synthesize `unknown` for declared signals omitted from a successful read.
- Convert provider throws, invalid output, and timeouts into error readings for
  that provider.
- Emit `provider:error` for observability.
- Apply `missingSignalBehavior` at the policy layer (`hold`, `fallback`, `error`,
  `ignore`) instead of failing the runtime by default.
- Let providers own their lifecycle; the runtime starts them lazily and closes
  them on shutdown.

## Consequences

Positive:

- Missing data is visible in decisions and can be monitored.
- A broken metrics provider does not crash application work by default.
- Policy behavior is explicit and configurable per runtime.
- Provider implementations are interchangeable and independently testable.

Negative:

- More verbose readings and policy configuration.
- Applications must choose a missing-signal behavior; the default (`hold`) can
  keep a stale mode longer than desired.
- Per-provider error readings lose partial success within that provider.
- Strict validation rejects some otherwise usable payloads.

## Alternatives considered

- **Nullable numbers:** loses the distinction between unsupported, not-ready, and
  failed, and invites `?? 0` bugs.
- **Throw on provider failure:** turns telemetry failure into application failure.
- **Coerce to zero:** unsafe under pressure; rejected explicitly.
- **Loose validation:** silently accepts unit and timestamp mistakes.

## Follow-up

- ~~Ref-count shared in-flight reads so one caller's abort cannot poison another.~~
  Implemented by [ADR 0005](0005-ref-counted-shared-reads.md).
- Consider optional size limits for provider arrays.
- Provider authoring guidance is documented in
  [PROVIDERS.md](../PROVIDERS.md); add a conformance test helper if demand appears.
