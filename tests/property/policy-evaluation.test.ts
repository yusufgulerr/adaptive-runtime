import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterAutomaticCandidates, pickHighest } from "../../src/policy/candidates.js";
import {
  createInitialPolicyState,
  evaluatePolicy,
  type PolicyEvaluationInput,
  type PolicyState,
} from "../../src/policy/engine.js";
import { resolvePolicy } from "../../src/policy/resolve.js";
import {
  createErrorRateGuardSelector,
  createLatencyBudgetSelector,
} from "../../src/policy/selectors.js";
import {
  errorRateGuardOptionsArb,
  fc,
  fuzzRuns,
  identifierArb,
  latencyBudgetOptionsArb,
} from "./support.js";

const candidateArb = fc.record({
  id: identifierArb,
  qualityTier: fc.integer({ min: -5, max: 10 }),
  costTier: fc.option(fc.integer({ min: -5, max: 10 }), { nil: undefined }),
  applicable: fc.boolean(),
});

const candidatesArb = fc.uniqueArray(candidateArb, {
  minLength: 1,
  maxLength: 8,
  selector: (candidate) => candidate.id,
});

const optionalTierArb = fc.option(fc.integer({ min: -5, max: 10 }), { nil: undefined });
const boundsArb = fc
  .record({
    minQualityTier: optionalTierArb,
    maxQualityTier: optionalTierArb,
  })
  .filter(
    ({ minQualityTier, maxQualityTier }) =>
      minQualityTier === undefined ||
      maxQualityTier === undefined ||
      minQualityTier <= maxQualityTier,
  );

const stateArb: fc.Arbitrary<PolicyState> = fc.record({
  initialized: fc.boolean(),
  currentStrategyId: fc.option(identifierArb, { nil: null }),
  currentQualityTier: fc.option(fc.integer({ min: -5, max: 10 }), { nil: null }),
  modeSince: fc.integer({ min: 0, max: 1_000_000 }),
  budgets: fc.constant({}),
  pendingStrategyId: fc.option(identifierArb, { nil: null }),
  pendingStreak: fc.integer({ min: 0, max: 5 }),
  lastSampleSequence: fc.option(fc.integer({ min: 0, max: 1_000 }), { nil: null }),
});

const scenarioArb = fc.record({
  candidates: candidatesArb,
  bounds: boundsArb,
  state: stateArb,
  now: fc.integer({ min: 0, max: 1_000_000 }),
  sampleSequence: fc.option(fc.integer({ min: 0, max: 1_000 }), { nil: null }),
  signalsCached: fc.boolean(),
  adaptationEnabled: fc.boolean(),
  minimumModeDurationMs: fc.integer({ min: 0, max: 5_000 }),
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Clone while preserving prototypes and own `undefined` properties. Fast-check
 * records use a null prototype; `structuredClone` would normalize it and make
 * the purity comparison fail for reasons unrelated to the policy engine.
 */
function clone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => clone(entry)) as T;
  }
  if (value !== null && typeof value === "object") {
    const copy = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
    for (const [key, nested] of Object.entries(value)) {
      copy[key] = clone(nested);
    }
    return copy as T;
  }
  return value;
}

describe("property: policy evaluation", () => {
  it("is pure, deterministic, and selects an applicable candidate within bounds", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const policy = resolvePolicy({
          minQualityTier: scenario.bounds.minQualityTier,
          maxQualityTier: scenario.bounds.maxQualityTier,
          minimumModeDurationMs: scenario.minimumModeDurationMs,
          consecutiveSamples: 1,
          missingSignalBehavior: "hold",
          budgets: [],
        });
        const automatic = filterAutomaticCandidates(scenario.candidates, policy);
        fc.pre(automatic.length > 0);

        const state = {
          ...scenario.state,
          budgets: {},
        };
        const input: PolicyEvaluationInput = {
          operationId: "fuzz-op",
          now: scenario.now,
          signals: [],
          strategies: scenario.candidates,
          pinnedStrategyId: null,
          adaptationEnabled: scenario.adaptationEnabled,
          sampleSequence: scenario.sampleSequence,
          signalsCached: scenario.signalsCached,
        };

        const frozenState = deepFreeze(clone(state));
        const frozenInput = deepFreeze(clone(input));
        const frozenPolicy = deepFreeze(clone(policy));

        const first = evaluatePolicy(frozenState, frozenInput, frozenPolicy);
        const second = evaluatePolicy(frozenState, frozenInput, frozenPolicy);

        assert.deepEqual(second, first);
        assert.deepEqual(frozenState, state);
        assert.deepEqual(frozenInput, input);
        assert.deepEqual(frozenPolicy, policy);
        assert.equal(first.decision.operationId, "fuzz-op");
        assert.equal(first.decision.decidedAt, scenario.now);
        assert.equal(first.state.currentStrategyId, first.decision.strategyId);
        assert.equal(first.state.currentQualityTier, first.decision.qualityTier);
        assert.deepEqual(first.decision.signals, []);
        assert.deepEqual(first.decision.budgets, []);
        assert.deepEqual(first.state.budgets, {});

        const selected = scenario.candidates.find(
          (candidate) => candidate.id === first.decision.strategyId,
        );
        assert.ok(selected, `selected candidate ${first.decision.strategyId} must exist`);
        assert.equal(selected.applicable, true);
        if (scenario.bounds.minQualityTier !== undefined) {
          assert.ok(selected.qualityTier >= scenario.bounds.minQualityTier);
        }
        if (scenario.bounds.maxQualityTier !== undefined) {
          assert.ok(selected.qualityTier <= scenario.bounds.maxQualityTier);
        }
        if (!scenario.adaptationEnabled) {
          assert.equal(first.decision.strategyId, pickHighest(automatic)?.id);
        }
      }),
      { numRuns: fuzzRuns },
    );
  });

  it("keeps the initial state untouched and returns the same result for repeated evaluation", () => {
    fc.assert(
      fc.property(candidatesArb, (candidates) => {
        fc.pre(candidates.some((candidate) => candidate.applicable));
        const policy = resolvePolicy({ budgets: [], consecutiveSamples: 1 });
        const state = createInitialPolicyState();
        const input: PolicyEvaluationInput = {
          operationId: "fuzz-initial",
          now: 1_000,
          signals: [],
          strategies: candidates,
          pinnedStrategyId: null,
          adaptationEnabled: true,
          sampleSequence: 1,
          signalsCached: false,
        };

        const first = evaluatePolicy(state, input, policy);
        const second = evaluatePolicy(state, input, policy);

        assert.deepEqual(second, first);
        assert.deepEqual(state, createInitialPolicyState());
        assert.equal(first.decision.kind, "initial");
        assert.equal(first.decision.changed, false);
        assert.equal(
          first.decision.strategyId,
          pickHighest(candidates.filter((c) => c.applicable))?.id,
        );
      }),
      { numRuns: fuzzRuns },
    );
  });

  it("always selects an eligible automatic candidate with createErrorRateGuardSelector", () => {
    const richCandidatesArb = fc.uniqueArray(
      fc.record({
        id: identifierArb,
        qualityTier: fc.integer({ min: 1, max: 5 }),
        costTier: fc.option(fc.integer({ min: 1, max: 5 }), { nil: undefined }),
        applicable: fc.boolean(),
        errorRate: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
        estimatedLatencyMs: fc.option(fc.double({ min: 1, max: 1_000, noNaN: true }), {
          nil: null,
        }),
      }),
      { minLength: 1, maxLength: 6, selector: (c) => c.id },
    );

    fc.assert(
      fc.property(richCandidatesArb, errorRateGuardOptionsArb, (candidates, options) => {
        const policy = resolvePolicy({
          customSelector: createErrorRateGuardSelector(options),
        });
        const automatic = filterAutomaticCandidates(candidates, policy);
        fc.pre(automatic.length > 0);

        const state = createInitialPolicyState();
        const input: PolicyEvaluationInput = {
          operationId: "fuzz-error-guard",
          now: 1000,
          signals: [],
          strategies: candidates,
          pinnedStrategyId: null,
          adaptationEnabled: true,
          sampleSequence: 1,
          signalsCached: false,
        };

        const result = evaluatePolicy(state, input, policy);
        const chosen = automatic.find((c) => c.id === result.decision.strategyId);
        assert.ok(
          chosen,
          `chosen candidate ${result.decision.strategyId} must belong to automatic pool`,
        );
        assert.equal(result.decision.strategyId, chosen.id);
      }),
      { numRuns: fuzzRuns },
    );
  });

  it("always selects an eligible automatic candidate with createLatencyBudgetSelector", () => {
    const richCandidatesArb = fc.uniqueArray(
      fc.record({
        id: identifierArb,
        qualityTier: fc.integer({ min: 1, max: 5 }),
        costTier: fc.option(fc.integer({ min: 1, max: 5 }), { nil: undefined }),
        applicable: fc.boolean(),
        errorRate: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
        estimatedLatencyMs: fc.option(fc.double({ min: 1, max: 1_000, noNaN: true }), {
          nil: null,
        }),
      }),
      { minLength: 1, maxLength: 6, selector: (c) => c.id },
    );

    fc.assert(
      fc.property(richCandidatesArb, latencyBudgetOptionsArb, (candidates, options) => {
        const policy = resolvePolicy({
          customSelector: createLatencyBudgetSelector(options),
        });
        const automatic = filterAutomaticCandidates(candidates, policy);
        fc.pre(automatic.length > 0);

        const state = createInitialPolicyState();
        const input: PolicyEvaluationInput = {
          operationId: "fuzz-latency-budget",
          now: 1000,
          signals: [],
          strategies: candidates,
          pinnedStrategyId: null,
          adaptationEnabled: true,
          sampleSequence: 1,
          signalsCached: false,
        };

        const result = evaluatePolicy(state, input, policy);
        const chosen = automatic.find((c) => c.id === result.decision.strategyId);
        assert.ok(
          chosen,
          `chosen candidate ${result.decision.strategyId} must belong to automatic pool`,
        );
        assert.equal(result.decision.strategyId, chosen.id);
      }),
      { numRuns: fuzzRuns },
    );
  });
});
