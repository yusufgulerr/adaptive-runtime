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
import { resolvePolicy } from "../../src/policy/resolve.js";
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
});
