import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigurationError } from "../../src/errors/index.js";
import { createAdaptiveRuntime } from "../../src/runtime/runtime.js";
import { validateRuntimeStateSnapshot } from "../../src/runtime/state.js";
import type { StrategyDecision } from "../../src/types/decision.js";
import type { RuntimeStateSnapshot } from "../../src/types/state.js";
import { FakeClock } from "../helpers/fake-clock.js";

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

    // totalDurationMs validation on stats and strategies
    const validWithTotalDuration = mutableSnapshot();
    mutate(validWithTotalDuration, ["operations", 0, "state", "stats"], {
      ...positiveStats,
      totalDurationMs: 5,
      strategies: {
        high: {
          ...positiveStats.strategies.high,
          totalDurationMs: 5,
        },
      },
    });
    const validatedWithTotal = validate(validWithTotalDuration);
    assert.equal(validatedWithTotal.operations[0]?.state.stats.totalDurationMs, 5);
    assert.equal(validatedWithTotal.operations[0]?.state.stats.strategies.high?.totalDurationMs, 5);

    // Negative totalDurationMs rejected on stats
    const negativeTotalOnStats = mutableSnapshot();
    mutate(negativeTotalOnStats, ["operations", 0, "state", "stats"], {
      ...positiveStats,
      totalDurationMs: -1,
    });
    assert.throws(
      () => validate(negativeTotalOnStats),
      (err: unknown) =>
        err instanceof ConfigurationError &&
        err.message.includes("totalDurationMs must be greater than or equal to 0."),
    );

    // Non-finite totalDurationMs rejected on stats
    for (const nonFinite of [NaN, Infinity, -Infinity]) {
      const nonFiniteStats = mutableSnapshot();
      mutate(nonFiniteStats, ["operations", 0, "state", "stats"], {
        ...positiveStats,
        totalDurationMs: nonFinite,
      });
      assert.throws(
        () => validate(nonFiniteStats),
        (err: unknown) =>
          err instanceof ConfigurationError &&
          err.message.includes("totalDurationMs must be a finite number."),
      );
    }

    // totalDurationMs > 0 when durationSamples === 0 rejected on stats
    const zeroSamplesWithTotal = mutableSnapshot();
    mutate(zeroSamplesWithTotal, ["operations", 0, "state", "stats", "totalDurationMs"], 10);
    assert.throws(
      () => validate(zeroSamplesWithTotal),
      (err: unknown) =>
        err instanceof ConfigurationError &&
        err.message.includes("totalDurationMs must be 0 when durationSamples is 0."),
    );

    // Negative totalDurationMs rejected on strategy
    const negativeTotalOnStrat = mutableSnapshot();
    mutate(negativeTotalOnStrat, ["operations", 0, "state", "stats"], {
      ...positiveStats,
      strategies: {
        high: {
          ...positiveStats.strategies.high,
          totalDurationMs: -1,
        },
      },
    });
    assert.throws(
      () => validate(negativeTotalOnStrat),
      (err: unknown) =>
        err instanceof ConfigurationError &&
        err.message.includes("totalDurationMs must be greater than or equal to 0."),
    );

    // Non-finite totalDurationMs rejected on strategy
    for (const nonFinite of [NaN, Infinity, -Infinity]) {
      const nonFiniteStrat = mutableSnapshot();
      mutate(nonFiniteStrat, ["operations", 0, "state", "stats"], {
        ...positiveStats,
        strategies: {
          high: {
            ...positiveStats.strategies.high,
            totalDurationMs: nonFinite,
          },
        },
      });
      assert.throws(
        () => validate(nonFiniteStrat),
        (err: unknown) =>
          err instanceof ConfigurationError &&
          err.message.includes("totalDurationMs must be a finite number."),
      );
    }

    // totalDurationMs > 0 when durationSamples === 0 rejected on strategy
    const zeroStratWithTotal = mutableSnapshot();
    mutate(zeroStratWithTotal, ["operations", 0, "state", "stats"], {
      ...baseStats,
      strategyRuns: { high: 0 },
      strategies: {
        high: {
          runs: 0,
          successes: 0,
          failures: 0,
          lastDurationMs: null,
          averageDurationMs: null,
          ewmaDurationMs: null,
          durationSamples: 0,
          totalDurationMs: 10,
          errorRate: 0,
        },
      },
    });
    assert.throws(
      () => validate(zeroStratWithTotal),
      (err: unknown) =>
        err instanceof ConfigurationError &&
        err.message.includes("totalDurationMs must be 0 when durationSamples is 0."),
    );
  });

  describe("exact totalDurationMs preservation across hydration cycles", () => {
    it("eliminates floating-point drift across repeated export/import cycles", async () => {
      const clock = new FakeClock();
      const runtime = createAdaptiveRuntime({
        clock,
        policy: { evaluationIntervalMs: 0 },
      });

      // Execute 3 runs with durations 3ms, 3ms, 4ms (sum = 10, avg = 3.3333333333333335)
      const durations = [3, 3, 4];
      for (const dur of durations) {
        await runtime.run({
          operationId: "drift-test",
          input: dur,
          strategies: [
            {
              id: "strat",
              qualityTier: 1,
              run: () => {
                clock.advance(dur);
                return "done";
              },
            },
          ],
        });
      }

      const initialStats = runtime.getStats("drift-test");
      assert.equal(initialStats.runs, 3);
      assert.equal(initialStats.durationSamples, 3);
      assert.equal(initialStats.totalDurationMs, 10);
      assert.equal(initialStats.strategies.strat?.totalDurationMs, 10);

      // Export state
      let state = runtime.exportState();
      await runtime.close();

      // Cycle 20 times across fresh runtimes
      for (let i = 0; i < 20; i++) {
        const nextRuntime = createAdaptiveRuntime({
          clock,
          policy: { evaluationIntervalMs: 0 },
        });
        nextRuntime.importState(state);
        const currentStats = nextRuntime.getStats("drift-test");
        // Verify exact integer 10 without floating-point drift (not 10.000000000000002)
        assert.equal(currentStats.totalDurationMs, 10);
        assert.equal(currentStats.strategies.strat?.totalDurationMs, 10);
        state = nextRuntime.exportState();
        await nextRuntime.close();
      }

      // Restore into final runtime and perform a 4th run of 5ms
      const finalRuntime = createAdaptiveRuntime({
        clock,
        policy: { evaluationIntervalMs: 0 },
      });
      finalRuntime.importState(state);
      await finalRuntime.run({
        operationId: "drift-test",
        input: 5,
        strategies: [
          {
            id: "strat",
            qualityTier: 1,
            run: () => {
              clock.advance(5);
              return "done";
            },
          },
        ],
      });

      const finalStats = finalRuntime.getStats("drift-test");
      assert.equal(finalStats.runs, 4);
      assert.equal(finalStats.durationSamples, 4);
      assert.equal(finalStats.totalDurationMs, 15);
      assert.equal(finalStats.strategies.strat?.totalDurationMs, 15);
      await finalRuntime.close();
    });

    it("falls back to averageDurationMs * durationSamples when restoring legacy snapshot without totalDurationMs", async () => {
      const clock = new FakeClock();
      const runtime = createAdaptiveRuntime({
        clock,
        policy: { evaluationIntervalMs: 0 },
      });

      // Construct a valid snapshot without totalDurationMs
      const legacySnapshot: RuntimeStateSnapshot = {
        version: 1,
        exportedAt: 100,
        operations: [
          {
            operationId: "legacy-op",
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
                operationId: "legacy-op",
                runs: 2,
                successes: 2,
                failures: 0,
                lastDurationMs: 10,
                averageDurationMs: 10,
                ewmaDurationMs: 10,
                durationSamples: 2,
                errorRate: 0,
                strategyRuns: { high: 2 },
                strategies: {
                  high: {
                    runs: 2,
                    successes: 2,
                    failures: 0,
                    lastDurationMs: 10,
                    averageDurationMs: 10,
                    ewmaDurationMs: 10,
                    durationSamples: 2,
                    errorRate: 0,
                  },
                },
              },
            },
          },
        ],
      };

      runtime.importState(legacySnapshot);
      const stats = runtime.getStats("legacy-op");
      assert.equal(stats.totalDurationMs, 20);
      assert.equal(stats.strategies.high?.totalDurationMs, 20);

      await runtime.close();
    });
  });
});
