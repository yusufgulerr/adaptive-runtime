import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chooseAtOrBelow,
  clampTargetQualityTier,
  compareCandidates,
  computeBaseQualityTier,
  filterAutomaticCandidates,
  pickHighest,
  type StrategyCandidate,
} from "../../src/policy/candidates.js";
import { createInitialPolicyState, evaluatePolicy } from "../../src/policy/engine.js";
import { resolvePolicy } from "../../src/policy/resolve.js";
import {
  composeSelectors,
  createErrorRateGuardSelector,
  createLatencyBudgetSelector,
} from "../../src/policy/selectors.js";
import type {
  CustomPolicySelection,
  CustomPolicySelector,
  CustomSelectorCandidate,
} from "../../src/types/policy.js";
import { fc, fuzzRuns, identifierArb } from "./support.js";

const candidateArb: fc.Arbitrary<StrategyCandidate> = fc.record({
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

const targetTierArb = fc.integer({ min: -6, max: 11 });
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

function compareByFields(left: StrategyCandidate, right: StrategyCandidate): number {
  if (left.qualityTier !== right.qualityTier) {
    return right.qualityTier - left.qualityTier;
  }
  const leftCost = left.costTier ?? Number.POSITIVE_INFINITY;
  const rightCost = right.costTier ?? Number.POSITIVE_INFINITY;
  if (leftCost !== rightCost) {
    return leftCost - rightCost;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function pickReference(candidates: readonly StrategyCandidate[]): StrategyCandidate | undefined {
  return candidates.reduce<StrategyCandidate | undefined>((best, candidate) => {
    if (best === undefined || compareByFields(candidate, best) < 0) {
      return candidate;
    }
    return best;
  }, undefined);
}

describe("property: candidate ordering", () => {
  it("orders by quality, cost, then code-unit id", () => {
    fc.assert(
      fc.property(candidateArb, candidateArb, (left, right) => {
        assert.equal(compareCandidates(left, right), compareByFields(left, right));
        assert.equal(compareCandidates(left, right), -compareCandidates(right, left));
        assert.equal(compareCandidates(left, left), 0);
      }),
      { numRuns: fuzzRuns },
    );
  });

  it("selects the highest candidate or the best candidate at or below the target", () => {
    fc.assert(
      fc.property(candidatesArb, targetTierArb, (candidates, targetTier) => {
        const eligible = candidates.filter((candidate) => candidate.qualityTier <= targetTier);
        assert.deepEqual(chooseAtOrBelow(candidates, targetTier), pickReference(eligible));
        assert.deepEqual(pickHighest(candidates), pickReference(candidates));
      }),
      { numRuns: fuzzRuns },
    );
  });

  it("filters automatic candidates by applicability and configured tier bounds", () => {
    fc.assert(
      fc.property(candidatesArb, boundsArb, (candidates, bounds) => {
        const policy = resolvePolicy(bounds);
        const expected = candidates.filter(
          (candidate) =>
            candidate.applicable &&
            (bounds.minQualityTier === undefined ||
              candidate.qualityTier >= bounds.minQualityTier) &&
            (bounds.maxQualityTier === undefined || candidate.qualityTier <= bounds.maxQualityTier),
        );

        assert.deepEqual(filterAutomaticCandidates(candidates, policy), expected);
      }),
      { numRuns: fuzzRuns },
    );
  });

  it("computes the base tier and clamps targets into the available pool", () => {
    fc.assert(
      fc.property(
        candidatesArb,
        targetTierArb,
        optionalTierArb,
        optionalTierArb,
        (candidates, targetTier, minQualityTier, maxQualityTier) => {
          const tiers = candidates.map((candidate) => candidate.qualityTier);
          const declaredMax = Math.max(...tiers);
          const base =
            maxQualityTier === undefined ? declaredMax : Math.min(declaredMax, maxQualityTier);
          assert.equal(computeBaseQualityTier(candidates, maxQualityTier), base);

          const clamp = clampTargetQualityTier(targetTier, minQualityTier, tiers);
          assert.ok(clamp.targetQualityTier >= Math.min(...tiers));
          assert.ok(clamp.targetQualityTier <= Math.max(...tiers));
        },
      ),
      { numRuns: fuzzRuns },
    );
  });

  it("verifies selector composition associativity and deterministic fallback by code-unit order", () => {
    const selectorCandidateArb: fc.Arbitrary<CustomSelectorCandidate> = fc.record({
      candidate: fc.record({
        id: identifierArb,
        qualityTier: fc.integer({ min: 1, max: 4 }),
        costTier: fc.option(fc.integer({ min: 1, max: 4 }), { nil: undefined }),
        applicable: fc.constant(true),
      }),
      estimatedCost: fc.option(fc.double({ min: 1, max: 10, noNaN: true }), { nil: null }),
      estimatedLatencyMs: fc.option(fc.double({ min: 1, max: 500, noNaN: true }), { nil: null }),
      ewmaLatencyMs: fc.option(fc.double({ min: 1, max: 500, noNaN: true }), { nil: null }),
      errorRate: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
      samples: fc.option(fc.integer({ min: 1, max: 20 }), { nil: null }),
    });

    const contextCandidatesArb = fc.uniqueArray(selectorCandidateArb, {
      minLength: 1,
      maxLength: 6,
      selector: (c) => c.candidate.id,
    });

    const selectorGeneratorArb = fc.oneof(
      fc.constant({ type: "null" as const }),
      fc.record({
        type: fc.constant("errorRate" as const),
        maxErrorRate: fc.double({ min: 0.1, max: 0.9, noNaN: true }),
      }),
      fc.record({
        type: fc.constant("latency" as const),
        maxLatencyMs: fc.double({ min: 10, max: 300, noNaN: true }),
        preferLowestCost: fc.boolean(),
        useEwma: fc.boolean(),
      }),
      fc.record({
        type: fc.constant("pickQuality" as const),
      }),
    );

    fc.assert(
      fc.property(
        contextCandidatesArb,
        selectorGeneratorArb,
        selectorGeneratorArb,
        selectorGeneratorArb,
        (candidates, gen1, gen2, gen3) => {
          const instantiateSelector = (gen: typeof gen1): CustomPolicySelector => {
            switch (gen.type) {
              case "null":
                return () => null;
              case "errorRate":
                return createErrorRateGuardSelector({ maxErrorRate: gen.maxErrorRate });
              case "latency":
                return createLatencyBudgetSelector({
                  maxLatencyMs: gen.maxLatencyMs,
                  preferLowestCost: gen.preferLowestCost,
                  useEwma: gen.useEwma,
                });
              case "pickQuality":
                return (ctx) => {
                  const sorted = [...ctx.candidates].sort(
                    (a, b) => b.candidate.qualityTier - a.candidate.qualityTier,
                  );
                  const first = sorted[0];
                  return first ? { strategyId: first.candidate.id, reason: "quality" } : null;
                };
            }
          };

          const s1 = instantiateSelector(gen1);
          const s2 = instantiateSelector(gen2);
          const s3 = instantiateSelector(gen3);

          const flat = composeSelectors([s1, s2, s3]);
          const nestedLeft = composeSelectors([composeSelectors([s1, s2]), s3]);
          const nestedRight = composeSelectors([s1, composeSelectors([s2, s3])]);

          const context = {
            operation: "test-op",
            operationId: "test-op",
            candidates,
            signals: {},
            now: 1000,
          };

          // 1. Selector Composition Associativity:
          const flatResult = flat(context);
          const leftResult = nestedLeft(context);
          const rightResult = nestedRight(context);

          assert.deepEqual(leftResult, flatResult);
          assert.deepEqual(rightResult, flatResult);

          // 2. Evaluated in policy selection: always returns a valid candidate ID or falls back deterministically by code-unit order
          const stratCandidates: StrategyCandidate[] = candidates.map((c) => ({
            id: c.candidate.id,
            qualityTier: c.candidate.qualityTier,
            costTier: c.candidate.costTier,
            applicable: true,
            estimatedLatencyMs: c.estimatedLatencyMs,
            ewmaLatencyMs: c.ewmaLatencyMs,
            errorRate: c.errorRate ?? 0,
          }));

          const policyFlat = resolvePolicy({ customSelector: flat });
          const policyNull = resolvePolicy({});

          const stateFlat = createInitialPolicyState();
          const stateNull = createInitialPolicyState();

          const inputFlat = {
            operationId: "test-op",
            now: 1000,
            signals: [],
            strategies: stratCandidates,
            pinnedStrategyId: null,
            adaptationEnabled: true,
            sampleSequence: 1,
            signalsCached: false,
          };

          const evalFlat = evaluatePolicy(stateFlat, inputFlat, policyFlat);
          const evalNull = evaluatePolicy(stateNull, inputFlat, policyNull);

          // Always produces a valid candidate ID from the available candidates
          assert.ok(
            candidates.some((c) => c.candidate.id === evalFlat.decision.strategyId),
            `Selected strategy "${evalFlat.decision.strategyId}" must be a valid candidate ID`,
          );

          if (flatResult !== null && flatResult !== undefined) {
            const expectedId = typeof flatResult === "string" ? flatResult : flatResult.strategyId;
            assert.equal(evalFlat.decision.strategyId, expectedId);
          } else {
            // When custom selectors return null, must fall back identically to default selection
            assert.equal(evalFlat.decision.strategyId, evalNull.decision.strategyId);

            // Fallback selection orders ties deterministically by code-unit id
            const automatic = filterAutomaticCandidates(stratCandidates, policyNull);
            const highestTier = Math.max(...automatic.map((c) => c.qualityTier));
            const topTierCandidates = automatic.filter((c) => c.qualityTier === highestTier);
            if (topTierCandidates.length > 1) {
              const bestCost = Math.min(
                ...topTierCandidates.map((c) => c.costTier ?? Number.POSITIVE_INFINITY),
              );
              const tiedCandidates = topTierCandidates.filter(
                (c) => (c.costTier ?? Number.POSITIVE_INFINITY) === bestCost,
              );
              if (tiedCandidates.length > 1) {
                // Must pick smallest code-unit string
                const sortedCodeUnit = [...tiedCandidates].sort((a, b) =>
                  a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
                );
                assert.equal(evalFlat.decision.strategyId, sortedCodeUnit[0]?.id);
              }
            }
          }
        },
      ),
      { numRuns: fuzzRuns },
    );
  });

  it("proves EWMA vs instantaneous latency selector monotonicity: increasing latency never improves rank", () => {
    const candidateWithLatencyArb = fc.record({
      id: identifierArb,
      qualityTier: fc.integer({ min: 1, max: 4 }),
      costTier: fc.option(fc.integer({ min: 1, max: 4 }), { nil: undefined }),
      latency: fc.double({ min: 1, max: 500, noNaN: true }),
    });

    const scenarioArb = fc.record({
      candidates: fc.uniqueArray(candidateWithLatencyArb, {
        minLength: 2,
        maxLength: 6,
        selector: (c) => c.id,
      }),
      targetIndex: fc.integer({ min: 0, max: 5 }),
      deltaLatency: fc.double({ min: 0.1, max: 200, noNaN: true }),
      maxLatencyMs: fc.double({ min: 10, max: 400, noNaN: true }),
      preferLowestCost: fc.boolean(),
      useEwma: fc.boolean(),
    });

    fc.assert(
      fc.property(
        scenarioArb,
        ({ candidates, targetIndex, deltaLatency, maxLatencyMs, preferLowestCost, useEwma }) => {
          const index = targetIndex % candidates.length;
          const target = candidates[index] as (typeof candidates)[0];

          const latency1 = target.latency;
          const latency2 = target.latency + deltaLatency;

          const toCustomCandidates = (targetLat: number): CustomSelectorCandidate[] =>
            candidates.map((c, i) => {
              const lat = i === index ? targetLat : c.latency;
              return {
                candidate: {
                  id: c.id,
                  qualityTier: c.qualityTier,
                  costTier: c.costTier,
                  applicable: true,
                },
                estimatedCost: c.costTier ?? null,
                estimatedLatencyMs: useEwma ? null : lat,
                ewmaLatencyMs: useEwma ? lat : null,
                errorRate: 0,
              };
            });

          const c1 = toCustomCandidates(latency1);
          const c2 = toCustomCandidates(latency2);

          const selector = createLatencyBudgetSelector({
            maxLatencyMs,
            preferLowestCost,
            useEwma,
          });

          const toStrategyId = (
            res: string | CustomPolicySelection | null | undefined,
          ): string | null => {
            if (res === null || res === undefined) {
              return null;
            }
            return typeof res === "string" ? res : res.strategyId;
          };

          // Determine rank of target candidate by counting how many other candidates beat it pairwise
          const computeRank = (set: CustomSelectorCandidate[]): number => {
            const targetCandidate = set[index] as CustomSelectorCandidate;
            let rank = 0;
            for (let i = 0; i < set.length; i++) {
              if (i === index) {
                continue;
              }
              const other = set[i] as CustomSelectorCandidate;
              const result = selector({
                operation: "test-rank",
                operationId: "test-rank",
                candidates: [targetCandidate, other],
                signals: {},
                now: 1000,
              });
              if (toStrategyId(result) === other.candidate.id) {
                rank += 1;
              }
            }
            return rank;
          };

          const rank1 = computeRank(c1);
          const rank2 = computeRank(c2);

          // Monotonicity: Increasing candidate latency never improves its rank (rank2 must be >= rank1)
          assert.ok(
            rank2 >= rank1,
            `Increasing latency for "${target.id}" from ${latency1} to ${latency2} improved rank from ${rank1} to ${rank2}`,
          );

          // Also check full set selection:
          const choice1 = selector({
            operation: "test-full",
            operationId: "test-full",
            candidates: c1,
            signals: {},
            now: 1000,
          });
          const choice2 = selector({
            operation: "test-full",
            operationId: "test-full",
            candidates: c2,
            signals: {},
            now: 1000,
          });

          const choiceId1 = toStrategyId(choice1);
          const choiceId2 = toStrategyId(choice2);

          // If selected with higher latency, it must also have been selected with lower latency
          if (choiceId2 === target.id) {
            assert.equal(
              choiceId1,
              target.id,
              `Candidate "${target.id}" selected at higher latency ${latency2} must be selected at lower latency ${latency1}`,
            );
          }

          // If not selected with lower latency, it cannot be selected with higher latency
          if (choiceId1 !== target.id) {
            assert.notEqual(
              choiceId2,
              target.id,
              `Candidate "${target.id}" not selected at lower latency ${latency1} must not be selected at higher latency ${latency2}`,
            );
          }
        },
      ),
      { numRuns: fuzzRuns },
    );
  });
});
