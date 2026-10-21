# ADR 0002: Deterministic tier policy with hysteresis

- **Status:** Accepted
- **Date:** 2026-10-21
- **Deciders:** Project maintainers

## Context

The runtime must choose among developer-provided strategies using resource
signals. The choice must be explainable and testable, and must not oscillate when
a signal hovers near a threshold. Candidate designs:

1. A numeric score per strategy, combining quality, cost, and pressure.
2. A learned or adaptive model based on observed latency/quality.
3. An ordinal tier policy with per-signal budget rules and hysteresis.
4. A fully user-supplied selector function.

## Decision

Use an **ordinal quality-tier policy**:

- Strategies declare a finite `qualityTier`; higher means expected-better quality.
- Budget rules reduce the target tier when a signal exceeds `limit`.
- A budget releases only below `recoverBelow` (`recoverBelow <= limit`).
- Transitions require `consecutiveSamples` fresh snapshots.
- Switches also respect `minimumModeDurationMs` and candidate stability.
- Candidates are filtered by applicability and optional quality floor/ceiling.
- Among eligible candidates at or below the target, choose highest quality, then
  lower cost, then lexicographic id.
- The policy core is a pure function with no I/O.

## Consequences

Positive:

- Decisions are reproducible and easy to unit test with a fake clock.
- Hysteresis prevents rapid flapping around a single threshold.
- Ordinal tiers avoid false precision from arbitrary weights.
- The algorithm is independent of providers and Node APIs.
- Every decision can explain pressure, clamping, and stability reasons.

Negative:

- Tiers are declarations, not measurements; a mislabeled strategy leads to wrong
  choices.
- Only pressure-driven tier reduction is modeled. Latency, error rate, and
  business cost are not directly optimized.
- A fixed policy cannot encode every application-specific rule.
- Multiple budgets sum reductions, which can overshoot the intended tier.

## Alternatives considered

- **Weighted score:** requires calibrated weights, hides trade-offs, and is harder
  to explain. Rejected for the MVP.
- **Learned model:** needs outcome data, risks non-determinism, and is far outside
  the MVP scope.
- **Custom selector:** maximum flexibility but no stable semantics or shared
  observability. Deferred to a future opt-in hook with strict validation.

## Follow-up

- Collect real-world feedback on tier granularity and multi-budget behavior.
- Consider a documented custom-policy hook in 0.3.0, preserving the built-in
  policy as the default.
- Keep decision reason codes stable within 0.x and document any change.
