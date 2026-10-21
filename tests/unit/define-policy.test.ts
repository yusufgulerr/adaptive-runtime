import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { definePolicy } from "../../src/index.js";
import type { Policy } from "../../src/types/policy.js";

type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

describe("definePolicy", () => {
  it("returns the same object reference", () => {
    const policy: Policy = {
      evaluationIntervalMs: 250,
      missingSignalBehavior: "fallback",
      fallbackStrategyId: "safe",
      budgets: [{ id: "cpu", signal: "cpu.utilization", limit: 0.8 }],
    };
    assert.equal(definePolicy(policy), policy);
  });

  it("preserves literal types", () => {
    const policy = definePolicy({
      missingSignalBehavior: "hold",
      qualityCheck: "error",
    });
    const literalPreserved: IsEqual<
      typeof policy,
      { readonly missingSignalBehavior: "hold"; readonly qualityCheck: "error" }
    > = true;
    assert.equal(literalPreserved, true);
  });

  it("has compile-time coverage for invalid policy literals", () => {
    // This function is never called. `npm run typecheck` enforces the expected
    // errors, so removing the Policy constraint cannot pass silently.
    const invalidPolicyChecks = (): void => {
      // @ts-expect-error -- missingSignalBehavior is restricted to Policy literals
      definePolicy({ missingSignalBehavior: "invalid" });
      // @ts-expect-error -- unknown properties are not part of Policy
      definePolicy({ unknownOption: true });
    };
    void invalidPolicyChecks;
  });
});
