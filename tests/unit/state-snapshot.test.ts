import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigurationError } from "../../src/errors/index.js";
import { validateRuntimeStateSnapshot } from "../../src/runtime/state.js";
import type { StrategyDecision } from "../../src/types/decision.js";
import type { RuntimeStateSnapshot } from "../../src/types/state.js";

function validSnapshot(): RuntimeStateSnapshot {
  return {
    version: 1,
    exportedAt: 10,
    operations: [
      {
        operationId: "op",
        state: {
          policyState: {
            initialized: false,
            currentStrategyId: null,
            currentQualityTier: null,
            modeSince: 0,
            budgets: {},
            pendingStrategyId: null,
            pendingStreak: 0,
            lastSampleSequence: null,
          },
          decision: null,
          pinnedStrategyId: null,
          adaptationEnabled: null,
          stats: {
            operationId: "op",
            runs: 0,
            successes: 0,
            failures: 0,
            lastDurationMs: null,
            averageDurationMs: null,
            ewmaDurationMs: null,
            durationSamples: 0,
            errorRate: 0,
            strategyRuns: {},
            strategies: {},
          },
        },
      },
    ],
  };
}

function mutableSnapshot(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(validSnapshot())) as Record<string, unknown>;
}

function mutate(root: Record<string, unknown>, path: readonly (string | number)[], value: unknown) {
  let current: Record<string, unknown> | unknown[] = root;
  for (const key of path.slice(0, -1)) {
    const next = (current as Record<string | number, unknown>)[key];
    if (next === null || typeof next !== "object") {
      throw new Error(`Path segment ${String(key)} is not an object.`);
    }
    current = next as Record<string, unknown> | unknown[];
  }
  (current as Record<string | number, unknown>)[path[path.length - 1] as string | number] = value;
}

function validate(value: Record<string, unknown>): RuntimeStateSnapshot {
  return validateRuntimeStateSnapshot(value);
}

function validDecision(overrides: Partial<StrategyDecision> = {}): StrategyDecision {
  return {
    operationId: "op",
    strategyId: "high",
    qualityTier: 2,
    previousStrategyId: null,
    changed: false,
    kind: "initial",
    decidedAt: 0,
    modeSince: 0,
    baseQualityTier: 2,
    targetQualityTier: 2,
    signals: [],
    budgets: [],
    reasons: [],
    sampleSequence: null,
    signalsCached: false,
    ...overrides,
  };
}

function rawDecision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...validDecision(), ...overrides };
}

describe("validateRuntimeStateSnapshot", () => {
  it("returns a deeply frozen, independent copy and normalizes JSON arrays", () => {
    const input = mutableSnapshot();
    const decision = validDecision({
      reasons: [
        {
          code: "strategy-switched",
          message: "switch",
          details: { nested: [1, undefined as unknown as number] },
        },
      ],
    });
    mutate(input, ["operations", 0, "state", "decision"], decision);
    mutate(input, ["operations", 0, "state", "policyState", "initialized"], true);
    mutate(input, ["operations", 0, "state", "policyState", "currentStrategyId"], "high");
    mutate(input, ["operations", 0, "state", "policyState", "currentQualityTier"], 2);
    mutate(input, ["operations", 0, "state", "stats"], {
      operationId: "op",
      runs: 1,
      successes: 1,
      failures: 0,
      lastDurationMs: 5,
      averageDurationMs: 5,
      ewmaDurationMs: 5,
      durationSamples: 1,
      errorRate: 0,
      strategyRuns: { high: 1 },
      strategies: {
        high: {
          runs: 1,
          successes: 1,
          failures: 0,
          lastDurationMs: 5,
          averageDurationMs: 5,
          ewmaDurationMs: 5,
          durationSamples: 1,
          errorRate: 0,
        },
      },
    });

    const output = validate(input);
    assert.equal(output.version, 1);
    assert.equal(output.operations[0]?.state.stats.runs, 1);
    assert.deepEqual(output.operations[0]?.state.decision?.reasons[0]?.details, {
      nested: [1, null],
    });
    assert.ok(Object.isFrozen(output));
    assert.ok(Object.isFrozen(output.operations));
    assert.ok(Object.isFrozen(output.operations[0]?.state.stats.strategies));
    assert.ok(Object.isFrozen(output.operations[0]?.state.decision?.reasons[0]?.details));

    mutate(input, ["operations", 0, "state", "pinnedStrategyId"], "mutated");
    assert.equal(output.operations[0]?.state.pinnedStrategyId, null);
  });

  it("rejects malformed top-level snapshots and duplicate operation ids", () => {
    for (const value of [null, [], "snapshot", 1]) {
      assert.throws(() => validateRuntimeStateSnapshot(value), ConfigurationError);
    }

    const wrongVersion = mutableSnapshot();
    mutate(wrongVersion, ["version"], 2);
    assert.throws(() => validate(wrongVersion), ConfigurationError);

    const badTime = mutableSnapshot();
    mutate(badTime, ["exportedAt"], -1);
    assert.throws(() => validate(badTime), ConfigurationError);

    const badOperations = mutableSnapshot();
    mutate(badOperations, ["operations"], {});
    assert.throws(() => validate(badOperations), ConfigurationError);

    const duplicate = mutableSnapshot();
    const operations = duplicate.operations as unknown[];
    operations.push(JSON.parse(JSON.stringify(operations[0])) as unknown);
    assert.throws(() => validate(duplicate), ConfigurationError);

    const padded = mutableSnapshot();
    mutate(padded, ["operations", 0, "operationId"], " op ");
    assert.throws(() => validate(padded), ConfigurationError);
  });

  it("rejects inconsistent policy state and padded strategy identifiers", () => {
    const initializedWithoutStrategy = mutableSnapshot();
    mutate(
      initializedWithoutStrategy,
      ["operations", 0, "state", "policyState", "initialized"],
      true,
    );
    assert.throws(() => validate(initializedWithoutStrategy), ConfigurationError);

    const uninitializedWithStrategy = mutableSnapshot();
    mutate(
      uninitializedWithStrategy,
      ["operations", 0, "state", "policyState", "currentStrategyId"],
      "high",
    );
    mutate(
      uninitializedWithStrategy,
      ["operations", 0, "state", "policyState", "currentQualityTier"],
      2,
    );
    assert.throws(() => validate(uninitializedWithStrategy), ConfigurationError);

    const tierMismatch = mutableSnapshot();
    mutate(tierMismatch, ["operations", 0, "state", "policyState", "currentStrategyId"], "high");
    assert.throws(() => validate(tierMismatch), ConfigurationError);

    const pendingWithoutId = mutableSnapshot();
    mutate(pendingWithoutId, ["operations", 0, "state", "policyState", "pendingStreak"], 1);
    assert.throws(() => validate(pendingWithoutId), ConfigurationError);

    for (const field of ["currentStrategyId", "pendingStrategyId", "pinnedStrategyId"]) {
      const padded = mutableSnapshot();
      if (field === "pinnedStrategyId") {
        mutate(padded, ["operations", 0, "state", field], " high ");
      } else {
        mutate(padded, ["operations", 0, "state", "policyState", field], " high ");
      }
      assert.throws(() => validate(padded), ConfigurationError, field);
    }

    const paddedBudgetKey = mutableSnapshot();
    mutate(paddedBudgetKey, ["operations", 0, "state", "policyState", "budgets"], {
      " load ": { engaged: false, aboveStreak: 0, belowStreak: 0 },
    });
    assert.throws(() => validate(paddedBudgetKey), ConfigurationError);

    const decisionWithPaddedPrevious = mutableSnapshot();
    mutate(
      decisionWithPaddedPrevious,
      ["operations", 0, "state", "decision"],
      rawDecision({ previousStrategyId: " high " }),
    );
    assert.throws(() => validate(decisionWithPaddedPrevious), ConfigurationError);
  });

  it("validates decision shape, signal views, and JSON-only reason details", () => {
    const misplacedOperation = mutableSnapshot();
    mutate(
      misplacedOperation,
      ["operations", 0, "state", "decision"],
      rawDecision({ operationId: "other" }),
    );
    assert.throws(() => validate(misplacedOperation), ConfigurationError);

    const invalidKind = mutableSnapshot();
    mutate(invalidKind, ["operations", 0, "state", "decision"], rawDecision({ kind: "bogus" }));
    assert.throws(() => validate(invalidKind), ConfigurationError);

    const missingValue = mutableSnapshot();
    mutate(
      missingValue,
      ["operations", 0, "state", "decision"],
      rawDecision({ signals: [{ name: "test.value", status: "ok" }] }),
    );
    assert.throws(() => validate(missingValue), ConfigurationError);

    const invalidDetails = mutableSnapshot();
    mutate(
      invalidDetails,
      ["operations", 0, "state", "decision"],
      rawDecision({
        reasons: [{ code: "strategy-switched", message: "x", details: [1, 2] }],
      }),
    );
    assert.throws(() => validate(invalidDetails), ConfigurationError);

    const dateDetails = mutableSnapshot();
    mutate(
      dateDetails,
      ["operations", 0, "state", "decision"],
      rawDecision({
        reasons: [{ code: "strategy-switched", message: "x", details: { date: new Date(0) } }],
      }),
    );
    assert.throws(() => validate(dateDetails), ConfigurationError);

    const functionDetails = mutableSnapshot();
    mutate(
      functionDetails,
      ["operations", 0, "state", "decision"],
      rawDecision({
        reasons: [{ code: "strategy-switched", message: "x", details: { fn: () => 1 } }],
      }),
    );
    assert.throws(() => validate(functionDetails), ConfigurationError);

    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let index = 0; index < 35; index += 1) {
      const next: Record<string, unknown> = {};
      deep.child = next;
      deep = next;
    }
    const tooDeep = mutableSnapshot();
    mutate(
      tooDeep,
      ["operations", 0, "state", "decision"],
      rawDecision({
        reasons: [{ code: "strategy-switched", message: "x", details: root }],
      }),
    );
    assert.throws(() => validate(tooDeep), ConfigurationError);
  });

  it("accepts complete signal, budget, reason, and policy views", () => {
    const input = mutableSnapshot();
    mutate(input, ["operations", 0, "state", "policyState"], {
      initialized: true,
      currentStrategyId: "high",
      currentQualityTier: 2,
      modeSince: 10,
      budgets: { load: { engaged: true, aboveStreak: 2, belowStreak: 0 } },
      pendingStrategyId: "low",
      pendingStreak: 1,
      lastSampleSequence: 3,
    });
    mutate(
      input,
      ["operations", 0, "state", "decision"],
      rawDecision({
        signals: [
          {
            name: "test.value",
            unit: "ratio",
            status: "ok",
            value: 0.5,
            observedAt: 10,
            ageMs: 0,
            detail: "fresh",
          },
          { name: "test.missing", status: "missing" },
        ],
        budgets: [
          {
            id: "load",
            signal: "test.value",
            engaged: true,
            status: "ok",
            value: 0.5,
            ageMs: 0,
            limit: 0.7,
            recoverBelow: 0.3,
            tierReduction: 1,
          },
        ],
        reasons: [{ code: "quality-pressure", message: "load engaged", details: { load: 0.5 } }],
        sampleSequence: 3,
      }),
    );
    const output = validate(input);
    assert.equal(output.operations[0]?.state.policyState.pendingStrategyId, "low");
    assert.equal(output.operations[0]?.state.decision?.signals.length, 2);
    assert.equal(output.operations[0]?.state.decision?.budgets[0]?.id, "load");

    for (const signals of [
      [{ name: "test.value", unit: "bogus", status: "ok", value: 1 }],
      [{ name: "test.value", status: "bogus", value: 1 }],
      [{ name: "test.value", status: "ok", value: 1, observedAt: -1 }],
      [{ name: "test.value", status: "ok", value: 1, ageMs: -1 }],
      [{ name: "test.value", status: "ok", value: 1, detail: 1 }],
    ]) {
      const invalid = mutableSnapshot();
      mutate(invalid, ["operations", 0, "state", "decision"], rawDecision({ signals }));
      assert.throws(() => validate(invalid), ConfigurationError);
    }

    for (const budgets of [
      [{ id: "load", signal: "test.value", engaged: false, status: "bogus" }],
      [{ id: "load", signal: "test.value", engaged: false, status: "ok" }],
      [
        {
          id: "load",
          signal: "test.value",
          engaged: false,
          status: "missing",
          limit: 0.7,
          recoverBelow: 0.3,
          tierReduction: 1,
          ageMs: -1,
        },
      ],
    ]) {
      const invalid = mutableSnapshot();
      mutate(invalid, ["operations", 0, "state", "decision"], rawDecision({ budgets }));
      assert.throws(() => validate(invalid), ConfigurationError);
    }
  });

  it("validates stats and cross-checks strategy run maps", () => {
    const positiveStats = {
      operationId: "op",
      runs: 1,
      successes: 1,
      failures: 0,
      lastDurationMs: 5,
      averageDurationMs: 5,
      ewmaDurationMs: 5,
      durationSamples: 1,
      errorRate: 0,
      strategyRuns: { high: 1 },
      strategies: {
        high: {
          runs: 1,
          successes: 1,
          failures: 0,
          lastDurationMs: 5,
          averageDurationMs: 5,
          ewmaDurationMs: 5,
          durationSamples: 1,
          errorRate: 0,
        },
      },
    };

    const setStats = (overrides: Record<string, unknown>): Record<string, unknown> => {
      const snapshot = mutableSnapshot();
      mutate(snapshot, ["operations", 0, "state", "stats"], {
        ...positiveStats,
        ...overrides,
      });
      return snapshot;
    };

    for (const invalid of [
      { operationId: "other" },
      { successes: 2 },
      { durationSamples: 2 },
      { lastDurationMs: null },
      { errorRate: 1.5 },
      { strategyRuns: { high: 2 } },
      { strategyRuns: { high: 1, low: 1 } },
      { strategies: {} },
      { strategies: { high: { ...positiveStats.strategies.high, runs: 2 } } },
      { strategies: { high: { ...positiveStats.strategies.high, successes: 2 } } },
    ]) {
      assert.throws(() => validate(setStats(invalid)), ConfigurationError);
    }

    const baseStats = validSnapshot().operations[0]?.state.stats;
    assert.ok(baseStats);
    const zeroWithDuration = mutableSnapshot();
    mutate(zeroWithDuration, ["operations", 0, "state", "stats"], {
      ...baseStats,
      lastDurationMs: 1,
    });
    assert.throws(() => validate(zeroWithDuration), ConfigurationError);

    const paddedStatsOperation = mutableSnapshot();
    mutate(paddedStatsOperation, ["operations", 0, "state", "stats", "operationId"], " op ");
    assert.throws(() => validate(paddedStatsOperation), ConfigurationError);

    const paddedStrategyKey = mutableSnapshot();
    mutate(paddedStrategyKey, ["operations", 0, "state", "stats"], {
      ...positiveStats,
      strategyRuns: { " high ": 1 },
      strategies: {
        " high ": positiveStats.strategies.high,
      },
    });
    assert.throws(() => validate(paddedStrategyKey), ConfigurationError);
  });
});
