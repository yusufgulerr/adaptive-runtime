import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigurationError } from "../../src/errors/index.js";
import { resolvePolicy } from "../../src/policy/resolve.js";
import type { Policy } from "../../src/types/policy.js";

function invalid(input: unknown): ConfigurationError {
  try {
    resolvePolicy(input as Policy);
  } catch (error) {
    assert.ok(
      error instanceof ConfigurationError,
      `expected ConfigurationError, got ${String(error)}`,
    );
    return error;
  }
  assert.fail("expected resolvePolicy to throw");
}

describe("resolvePolicy", () => {
  it("applies documented defaults", () => {
    const resolved = resolvePolicy(undefined);
    assert.equal(resolved.evaluationIntervalMs, 1000);
    assert.equal(resolved.maxSignalAgeMs, 5000);
    assert.equal(resolved.minimumModeDurationMs, 0);
    assert.equal(resolved.consecutiveSamples, 2);
    assert.equal(resolved.minQualityTier, undefined);
    assert.equal(resolved.maxQualityTier, undefined);
    assert.equal(resolved.fallbackStrategyId, undefined);
    assert.equal(resolved.missingSignalBehavior, "hold");
    assert.equal(resolved.adaptationEnabled, true);
    assert.equal(resolved.qualityCheck, "report");
    assert.deepEqual(resolved.budgets, []);
  });

  it("fills budget defaults from the policy sample count", () => {
    const resolved = resolvePolicy({
      consecutiveSamples: 3,
      budgets: [{ id: "b", signal: "s", limit: 10 }],
    });
    assert.deepEqual(resolved.budgets[0], {
      id: "b",
      signal: "s",
      limit: 10,
      recoverBelow: 10,
      tierReduction: 1,
      consecutiveSamples: 3,
    });
  });

  it("rejects invalid policy shapes and values", () => {
    assert.match(invalid(null).message, /policy must be an object/);
    assert.match(invalid([]).message, /policy must be an object/);
    assert.match(invalid({ budgets: {} }).message, /budgets must be an array/);
    assert.match(invalid({ adaptationEnabled: "yes" }).message, /must be a boolean/);
    assert.match(invalid({ maxSignalAgeMs: 0 }).message, /greater than 0/);
    assert.match(invalid({ consecutiveSamples: 0 }).message, /positive integer/);
    assert.match(invalid({ evaluationIntervalMs: -1 }).message, /greater than or equal to 0/);
    assert.match(invalid({ qualityCheck: "warn" }).message, /report.*error/);
    assert.match(invalid({ missingSignalBehavior: "wait" }).message, /must be one of/);
    assert.match(invalid({ minQualityTier: 3, maxQualityTier: 2 }).message, /must not exceed/);
  });

  it("rejects invalid budget rules", () => {
    assert.match(
      invalid({ budgets: [{ id: "b", signal: "s", limit: 10, recoverBelow: 11 }] }).message,
      /less than or equal/,
    );
    assert.match(
      invalid({ budgets: [{ id: "b", signal: "s", limit: 10, tierReduction: 0 }] }).message,
      /positive integer/,
    );
    assert.match(
      invalid({
        budgets: [
          { id: "b", signal: "s", limit: 10 },
          { id: "b", signal: "t", limit: 20 },
        ],
      }).message,
      /Duplicate budget id/,
    );
    assert.match(
      invalid({ budgets: [{ id: "", signal: "s", limit: 10 }] }).message,
      /non-empty string/,
    );
  });

  it("requires a fallback strategy id when fallback behavior is selected", () => {
    assert.match(
      invalid({ missingSignalBehavior: "fallback" }).message,
      /fallbackStrategyId is not set/,
    );
    assert.equal(
      resolvePolicy({
        missingSignalBehavior: "fallback",
        fallbackStrategyId: "economy",
      }).fallbackStrategyId,
      "economy",
    );
  });
});
