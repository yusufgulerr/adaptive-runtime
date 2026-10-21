# Threat model

This document describes what Adaptive Runtime does and does not protect against.
It is a library-level threat model, not a deployment security review.

## Scope and assumptions

Adaptive Runtime runs inside a Node.js process controlled by the application.
Strategies and providers are **application-supplied code**. The runtime assumes:

- the application and its dependencies are trusted;
- strategy code is trusted to the same degree as the rest of the process;
- providers may be buggy, slow, or untrusted data sources, but run in-process;
- the process is not a multi-tenant sandbox;
- the caller applies its own authentication, authorization, input validation, and
  resource admission control.

Out of scope: browser, Deno, Bun, worker isolation, container hardening, network
protocol security, secret storage, and OS-level resource limits.

## Assets

| Asset | Why it matters |
| --- | --- |
| Correct strategy selection | A wrong choice can silently reduce output quality or increase cost |
| Application availability | A blocked event loop or unbounded work can stall the process |
| Application data | Strategies and quality checks receive inputs and can read process state |
| Telemetry integrity | False signals can force degraded or expensive modes |
| Build and release integrity | A compromised package executes in consumer processes |
| Diagnostic data | Decisions and errors may contain signal values, ids, or input-derived text |

## Trust boundaries

```text
 application code (trusted)
        │
        ▼
 ┌───────────────┐   in-process calls   ┌────────────────────┐
 │ Adaptive      │─────────────────────▶│ Strategy code      │  trusted
 │ Runtime       │                      └────────────────────┘
 │               │   in-process reads   ┌────────────────────┐
 │               │─────────────────────▶│ Signal providers   │  semi-trusted
 └───────┬───────┘                      └─────────┬──────────┘
         │ events / metadata                      │ optional I/O
         ▼                                        ▼
 logs, metrics, APM (trusted sink)          OS / network / APIs
```

The most important boundary is **not** enforced: strategies execute in the same
JavaScript realm, with the same permissions, and can do anything the application
can do.

## Threats and mitigations

### T1. Strategy code is malicious or defective

**Threat:** A strategy reads secrets, exfiltrates data, mutates shared state,
blocks the event loop, allocates without bound, or ignores cancellation.

**Mitigations:**

- Strategies are documented as trusted application code.
- Exactly one strategy runs per operation; the runtime does not fetch or load
  strategy code dynamically.
- Timeouts abort a signal and reject the runtime promise.

**Residual risk: high.** A timeout cannot stop synchronous code or an
uncooperative promise. Use worker threads, child processes, or containers for
untrusted algorithms. The runtime is not a sandbox.

### T2. Provider blocks or exhausts resources

**Threat:** A provider performs synchronous CPU work, allocates a huge array,
returns a thenable that never settles, or ignores the abort signal.

**Mitigations:**

- Provider reads race against `providerTimeoutMs` (default 1000 ms).
- The read signal is aborted on timeout, or when every caller waiting on the
  shared read has aborted.
- Reading arrays are shape-validated; undeclared and duplicate signals are rejected.
- Provider failures become error readings instead of crashing the run.

**Residual risk: medium-high.** `read()` may return a synchronous value; a
synchronous infinite loop blocks the event loop before the timeout can fire. A
provider can return a very large array of valid readings, which is validated but
not size-capped. Use trusted providers and keep reads O(number of declared signals).

### T3. Signal spoofing, drift, or staleness

**Threat:** A provider reports a low value under real pressure, a high value when
healthy, or an old timestamp. Selection degrades or flaps.

**Mitigations:**

- Signals are explicitly named and unit-checked against declarations.
- `observedAt` is validated; readings older than `maxSignalAgeMs` become `stale`.
- Unavailable values are never coerced to zero.
- Hysteresis and consecutive samples reduce reaction to a single bad sample.
- Decisions expose every signal value, status, and age for auditing.

**Residual risk: medium.** The runtime does not authenticate providers or detect
a consistently lying provider. Signal quality is a deployment concern. Cross-check
critical signals externally.

### T4. Policy misconfiguration

**Threat:** `recoverBelow` is set above `limit`; a tiny tier reduction causes
constant degradation; the floor is above the ceiling; fallback points at an
inapplicable strategy; every operation shares one id.

**Mitigations:**

- Construction rejects invalid ranges, duplicate ids, invalid sample counts, and
  missing fallback configuration.
- Pins and fallbacks are checked for existence and applicability at run time.
- Decisions include reasons such as `quality-floor-clamped`, `target-tier-clamped`,
  `missing-signal-fallback`, and `candidate-stability`.
- Examples and tests cover engage/release boundaries.

**Residual risk: medium.** Semantically wrong but valid policy cannot be detected.
Monitor decision kinds and strategy distribution.

### T5. State collision across operations

**Threat:** Two logical workloads reuse one `operationId`. They share budgets,
mode duration, pending candidate, pins, and stats, so pressure from one affects
the other.

**Mitigation:** `operationId` is documented as the state key. The runtime cannot
infer intent.

**Residual risk: medium.** Use stable, workload-specific ids. Do not put
high-cardinality user input in ids without a plan for memory growth; state is
never evicted.

### T6. Unbounded concurrency and memory growth

**Threat:** Many concurrent runs, many distinct operation ids, or leaking event
listeners grow memory and degrade latency.

**Mitigations:**

- Per-operation selection locks are deleted when settled.
- Snapshots hold one reading per declared signal.
- `close()` releases providers and the cached snapshot.

**Residual risk: medium.** There is no max-concurrency setting and no eviction of
per-operation state or stats. Admission control belongs to the caller. Long-lived
processes with unbounded operation ids should periodically recreate the runtime.

### T7. Shared in-flight read abort

**Threat:** Run A initiates a provider read; Run B shares it. Run A aborts. If
cancellation were tied to the initiator, the provider read would stop and Run B
would receive error readings even though its own signal is healthy. Conversely,
if one caller leaves without ref-counting, the shared read could be cancelled
while other callers still need it.

**Mitigations:**

- Each in-flight read owns a private `AbortController` and a waiter count; the
  initiator has no special cancellation privilege.
- A caller's abort rejects only that caller and decrements the waiter count. The
  provider read is aborted only when the last waiter leaves.
- A read aborted by every caller is not cached, so a later run cannot observe
  cancellation error readings.
- The behavior is documented in
  [ARCHITECTURE.md](ARCHITECTURE.md#shared-read-cancellation).
- Missing-signal behavior can hold, fall back, ignore, or error.

**Residual risk: low.** A provider that ignores its abort signal may keep working
until it settles (or until `providerTimeoutMs`), but it can no longer turn a
healthy caller's snapshot into an error. Aggressive cancellation storms can still
cause repeated provider work; use provider-level caching where appropriate.

### T8. Information disclosure through telemetry

**Threat:** Decision reasons, signal details, quality details, or error messages
are shipped to logs and contain secrets or personal data.

**Mitigations:**

- Documentation tells provider and quality-check authors not to put secrets in
  `details`, `error`, or `detail`.
- The runtime copies only declared metadata; it does not serialize inputs.

**Residual risk: medium.** Strategy errors and application-supplied details can
contain anything. Redact before exporting events to third parties.

### T9. Listener interference

**Threat:** An event listener throws, recurses, or performs expensive synchronous
work on every decision.

**Mitigations:**

- Listener exceptions are isolated and reported via `listener:error`.
- A throwing `listener:error` listener is ignored.
- Events are synchronous, so a slow listener slows the run.

**Residual risk: low.** Treat observability callbacks as hot-path code.

### T10. Release and dependency compromise

**Threat:** A malicious release, compromised npm token, or dependency update
injects code into consumer processes.

**Mitigations:**

- Zero runtime dependencies reduces install-time surface.
- Dev dependencies are pinned by `package-lock.json`.
- CI runs lint, typecheck, tests, coverage, and build.
- CodeQL and Dependabot workflows are provided.
- The release workflow is manual/tag-driven and intended to use npm provenance.

**Residual risk: medium.** CI and CodeQL have executed successfully on the public
repository. The release workflow is configured to publish with npm provenance,
but npm publication is still pending and the runtime has not been independently
audited. Verify the package provenance and integrity before production use.

### T11. Time-of-check/time-of-use changes

**Threat:** Pressure changes after selection. A high-quality strategy starts under
low pressure and then the process becomes constrained.

**Mitigation:** This is explicit: decisions happen at operation start only. There
is no mid-run switching. Strategies receive the decision and can implement their
own internal safeguards.

**Residual risk: by design.** Choose operation granularity and timeouts so that a
run remains acceptable if conditions change.

## Security properties the runtime does provide

- No dynamic code loading or `eval`.
- No network access from built-in providers except the application-supplied
  network latency probe.
- No zero-coercion of unavailable signals.
- No automatic retries or hidden second execution.
- Provider and listener failures do not crash the operation.
- Strict runtime validation of provider readings and policy configuration.

## Deployment checklist

- [ ] Treat strategies as trusted code; isolate untrusted algorithms in a worker
      or separate process.
- [ ] Use stable, low-cardinality `operationId` values and bound the number of ids.
- [ ] Apply application-level concurrency limits.
- [ ] Keep provider reads cheap and honor `context.signal`.
- [ ] Redact `details`, `error`, and quality `detail` before external export.
- [ ] Monitor `run:error`, `provider:error`, decision kinds, and strategy distribution.
- [ ] Set timeouts on both operations and providers.
- [ ] Test behavior under missing and stale signals.
- [ ] Pin and verify the package version in production.

## Reporting

See [SECURITY.md](../SECURITY.md). Do not include exploit details in a public
issue before a private channel is established.
