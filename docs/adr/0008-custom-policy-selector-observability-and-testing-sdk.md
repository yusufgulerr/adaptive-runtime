# ADR 0008: Custom policy selector, observability bridge, and testing SDK

- **Status:** Accepted
- **Date:** 2026-10-22
- **Deciders:** Project maintainers

## Context

The deterministic tier policy covers pressure, hysteresis, quality bounds, and
stability. Some applications need a small, explicit refinement that is not
expressible as a numeric budget — for example, preferring a strategy because of
a feature flag, a tenant policy, or a cheap heuristic over eligible candidates.
Reworking the policy engine for every such case would multiply configuration and
risk changing existing decisions.

Operators also need a low-cardinality metrics surface without adding a runtime
dependency, and provider authors need deterministic test utilities and a
contract check. The project is explicitly zero-dependency and platform-neutral,
so importing `@opentelemetry/api` or a Prometheus client at runtime was not
acceptable.

The constraints were:

- preserve determinism, applicability, quality bounds, and stability gates;
- no runtime dependencies;
- no Node.js built-ins in the policy, observability, or testing modules;
- never coerce unavailable signal statuses to `0`;
- keep the default policy behavior unchanged when the new features are unused;
- keep the core hot path free of metrics or test code.

## Decision

### Custom policy selector

Add `Policy.customSelector?: CustomPolicySelector`. The selector receives an
operation snapshot: operation/operationId, clock value, eligible automatic
candidates, and the raw signal record. It may return a strategy id,
`{ strategyId, reason? }`, or `null`/`undefined`.

The engine calls the selector after budgets, clamping, and the default candidate
are resolved, and before `minimumModeDurationMs` and `consecutiveSamples` gates.
The returned id must match an applicable candidate inside the quality bounds;
otherwise the run fails with `ConfigurationError`. A valid choice adds a
`custom-selector` reason and then passes through the normal stability gates. A
`null`/`undefined` result keeps the default. Configuration resolution rejects a
non-function selector.

The selector cannot bypass a pin, missing-signal behavior, applicability,
quality bounds, or hysteresis. It is a refinement hook, not a replacement for
the policy.

### Observability bridge

Add `src/observability/index.ts`, exported as `adaptive-runtime/observability`.
It provides:

- `createMetricsCollector(options?)` with `attach(runtime)`, `getSnapshot()`,
  `toPrometheusText()`, and `reset()`;
- `attachOpenTelemetryMeter(runtime, meter, options?)`, accepting a structural
  `OpenTelemetryMeterLike` and returning a detach function;
- structural counter/histogram/up-down-counter interfaces and metric snapshot
  types.

The in-memory collector subscribes to runtime events, records counters, gauges,
and a seconds-based duration histogram, and renders deterministic Prometheus
text with escaped label values. It is pull-based: no timers, sockets, exporter,
or background flush. For any non-`ok` signal it increments a status counter and
does not write a gauge. The OpenTelemetry adapter forwards the same events and
contains instrument failures; metrics never change a decision or a run result.

### Testing SDK

Add `src/testing/index.ts`, exported as `adaptive-runtime/testing`. It provides:

- `createFakeClock(initialMs?)` with `now`, `setTimeout`, `advance`, `set`, and
  `pendingTimers`;
- `ScriptedSignalProvider` replaying finite values or explicit unavailable
  statuses, with `reset()` and `close()`;
- `runProviderConformanceCheck(provider, options?)` returning a report with
  `ok`, `providerId`, `checksPassed`, and `failures`.

The conformance runner invokes lifecycle hooks once, validates ids, descriptors,
reading names/units, timestamps, statuses, finite `ok` values, confidence bounds,
and error strings, and reports failures instead of throwing. The SDK is
platform-neutral and depends only on public types and `ConfigurationError`.

## Consequences

Positive:

- Applications can encode small eligibility refinements without forking the
  policy engine.
- Stability and quality guarantees still apply to selector choices.
- Metrics work in Node.js, browsers, and edge runtimes with no dependency.
- Prometheus output is available without an exporter process, while the
  OpenTelemetry bridge fits existing meter pipelines.
- Provider authors get deterministic test primitives and a reusable contract
  check.
- The default policy and runtime hot path are unchanged when the features are
  unused.

Negative:

- The selector context is another public type surface and must remain stable.
- A selector can still choose a poor strategy within the eligible set; the
  runtime only enforces applicability and bounds, not quality.
- The in-memory registry grows with distinct label combinations; applications
  must keep operation ids and signal names bounded and call `reset()` or detach
  when appropriate.
- Prometheus text generation is not a scraping server; applications must expose
  the string themselves.
- The conformance runner is a one-shot check, not a fuzzer or a timeout harness.
- The fake clock fires timers only through `advance()`; tests must not expect
  real-time scheduling.

## Alternatives considered

- **Add more numeric budgets only:** cannot express non-numeric eligibility
  refinements and would grow policy configuration without covering the use case.
- **Allow arbitrary strategy replacement after stability:** would let a selector
  bypass hysteresis and could cause flapping. Rejected; the selector runs before
  the gates.
- **Import `@opentelemetry/api`:** violates the zero-runtime-dependency rule and
  pulls a large transitive surface into edge bundles. A structural interface is
  sufficient.
- **Ship a Prometheus HTTP server:** adds a listener, lifecycle, and security
  surface that belongs to the application. A text method is smaller and
  composable.
- **Make the conformance runner throw on the first failure:** makes aggregated
  CI reports harder and prevents checking the remaining contract. A report is
  more useful.
- **Expose the fake clock from the main entry point:** pollutes the production
  surface. A dedicated `/testing` subpath keeps it opt-in.

## Follow-up

- Document the selector signature, eligible-candidate rule, and stability
  interaction in the API reference.
- Document metric names, label cardinality, and the no-zero gauge rule in the
  observability guide.
- Add integration tests that resolve the `/observability` and `/testing`
  subpaths.
- Keep every added `src/**` file above 80% branch coverage.
- Revisit selector latency estimates if the runtime ever produces them; today
  `estimatedLatencyMs` is `null`.
