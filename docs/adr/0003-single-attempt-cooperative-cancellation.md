# ADR 0003: One attempt, no automatic retries, cooperative cancellation

- **Status:** Accepted
- **Date:** 2026-10-21
- **Deciders:** Project maintainers

## Context

Strategies can fail, exceed a latency budget, or run while the caller cancels.
Common runtime designs include automatic retries, fallback execution, hedging, or
mid-run strategy switches. Each adds hidden side effects: duplicate writes,
multiplied load, ambiguous results, and unpredictable cost.

The MVP targets operations where a single attempt has meaningful side effects and
where the caller should remain in control.

## Decision

- Invoke exactly **one** strategy per `run()`.
- Never retry a failed strategy automatically.
- Never switch strategies after execution begins.
- A missing-signal `fallbackStrategy` selects a different strategy **before**
  execution; it is not a retry.
- Expose `metadata.attempts` as the literal `1`.
- Timeouts and caller aborts:
  - abort the signal passed to the strategy;
  - reject the runtime promise promptly with a typed error;
  - do not forcibly terminate the strategy.
- Document that uncooperative work may continue after rejection.

## Consequences

Positive:

- Predictable attempt counts and cost.
- No duplicate side effects caused by the runtime.
- Callers can implement retries with their own idempotency policy.
- `run:error` and stats correspond to one real invocation.
- Simple state machine: selection happens once, before execution.

Negative:

- Transient strategy failures are surfaced to the caller; the runtime does not
  mask them.
- A timeout can leave work running in the background.
- No hedging means tail latency is not improved.
- Applications that want fallback-on-error must implement it outside the runtime.

## Alternatives considered

- **Retry with backoff:** requires idempotency contracts and can amplify load
  during pressure, exactly when the system is constrained.
- **Fallback on execution failure:** hides defects and produces results from a
  strategy the policy did not select.
- **Hedged execution:** doubles cost and complicates side-effect guarantees.
- **Mid-run switching:** cannot safely cancel the first strategy in JavaScript.

## Follow-up

- Provide documentation patterns for caller-managed retries and idempotency.
- Keep timeout semantics explicit in the API docs and error messages.
- If worker-based isolation is added later, revisit forced termination; do not
  change the single-attempt guarantee without a major version.
