import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigurationError } from "../../src/errors/index.js";
import { createAdaptiveRuntime } from "../../src/runtime/runtime.js";
import {
  diffStateSnapshots,
  filterStateSnapshot,
  inspectStateSnapshot,
  validateRuntimeStateSnapshot,
  validateStateSnapshot,
} from "../../src/runtime/state.js";
import type { StrategyDecision } from "../../src/types/decision.js";
import type {
  OperationStateSnapshot,
  RuntimeStateSnapshot,
  SerializedOperationState,
} from "../../src/types/state.js";
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

function createTestOp(
  operationId: string,
  options: {
    initialized?: boolean;
    currentStrategyId?: string | null;
    runs?: number;
    strategies?: Record<
      string,
      {
        runs: number;
        successes: number;
        failures: number;
        durationSamples: number;
        averageDurationMs: number | null;
        lastDurationMs: number | null;
        ewmaDurationMs: number | null;
        errorRate: number;
        totalDurationMs?: number;
      }
    >;
  } = {},
): OperationStateSnapshot {
  const currentStrategyId = options.currentStrategyId ?? null;
  const initialized = options.initialized ?? currentStrategyId !== null;
  const runs = options.runs ?? 0;
  const strategies = options.strategies ?? {};
  const strategyRuns: Record<string, number> = {};
  for (const [id, s] of Object.entries(strategies)) {
    strategyRuns[id] = s.runs;
  }

  return {
    operationId,
    state: {
      policyState: {
        initialized,
        currentStrategyId,
        currentQualityTier: currentStrategyId !== null ? 1 : null,
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
        operationId,
        runs,
        successes: runs,
        failures: 0,
        lastDurationMs: runs > 0 ? 10 : null,
        averageDurationMs: runs > 0 ? 10 : null,
        ewmaDurationMs: runs > 0 ? 10 : null,
        durationSamples: runs > 0 ? runs : 0,
        errorRate: 0,
        strategyRuns,
        strategies,
      },
    },
  };
}

describe("validateStateSnapshot", () => {
  it("acts as a drop-in alias for validateRuntimeStateSnapshot", () => {
    const snapshot = validSnapshot();
    const result = validateStateSnapshot(snapshot);
    assert.equal(result.version, 1);
    assert.equal(result.exportedAt, 10);
    assert.equal(result.operations.length, 1);
    assert.ok(Object.isFrozen(result));

    assert.throws(() => validateStateSnapshot(null), ConfigurationError);
    assert.throws(() => validateStateSnapshot({ version: 2 }), ConfigurationError);
  });
});

describe("inspectStateSnapshot", () => {
  it("produces deterministic summary inspection with sorted operation IDs and active strategies", () => {
    const opAlpha = createTestOp("alpha", {
      currentStrategyId: "fast",
      runs: 1,
      strategies: {
        fast: {
          runs: 1,
          successes: 1,
          failures: 0,
          durationSamples: 1,
          lastDurationMs: 10,
          averageDurationMs: 10,
          ewmaDurationMs: 10,
          errorRate: 0,
        },
      },
    });

    const opGamma = createTestOp("gamma", {
      currentStrategyId: null,
      initialized: false,
    });

    const opBeta = createTestOp("beta", {
      currentStrategyId: "slow",
      runs: 3,
      strategies: {
        fast: {
          runs: 1,
          successes: 1,
          failures: 0,
          durationSamples: 1,
          lastDurationMs: 10,
          averageDurationMs: 10,
          ewmaDurationMs: 10,
          errorRate: 0,
        },
        slow: {
          runs: 2,
          successes: 2,
          failures: 0,
          durationSamples: 2,
          lastDurationMs: 20,
          averageDurationMs: 20,
          ewmaDurationMs: 20,
          errorRate: 0,
        },
      },
    });

    // Provide operations in non-sorted order: gamma, alpha, beta
    const snapshot: RuntimeStateSnapshot = {
      version: 1,
      exportedAt: 500,
      operations: [opGamma, opAlpha, opBeta],
    };

    const inspection = inspectStateSnapshot(snapshot);

    assert.equal(inspection.version, 1);
    assert.equal(inspection.exportedAtMs, 500);
    assert.equal(inspection.operationCount, 3);
    // Deterministic code-unit sort order: alpha, beta, gamma
    assert.deepEqual(inspection.operationIds, ["alpha", "beta", "gamma"]);
    // totalStrategyRecords: opAlpha has 1, opBeta has 2, opGamma has 0 => 3
    assert.equal(inspection.totalStrategyRecords, 3);
    assert.deepEqual(inspection.activeStrategiesByOperation, {
      alpha: "fast",
      beta: "slow",
      gamma: null,
    });
    // Active strategies keys should also match deterministic code-unit order
    assert.deepEqual(Object.keys(inspection.activeStrategiesByOperation), [
      "alpha",
      "beta",
      "gamma",
    ]);

    // Immutability checks
    assert.ok(Object.isFrozen(inspection));
    assert.ok(Object.isFrozen(inspection.operationIds));
    assert.ok(Object.isFrozen(inspection.activeStrategiesByOperation));

    assert.throws(() => {
      (inspection as { operationCount: number }).operationCount = 99;
    }, TypeError);
    assert.throws(() => {
      (inspection.operationIds as string[]).push("delta");
    }, TypeError);
    assert.throws(() => {
      (inspection.activeStrategiesByOperation as Record<string, string | null>).alpha = "mutated";
    }, TypeError);
  });

  it("handles empty snapshot properly", () => {
    const emptySnapshot: RuntimeStateSnapshot = {
      version: 1,
      exportedAt: 1234,
      operations: [],
    };

    const inspection = inspectStateSnapshot(emptySnapshot);
    assert.equal(inspection.version, 1);
    assert.equal(inspection.exportedAtMs, 1234);
    assert.equal(inspection.operationCount, 0);
    assert.deepEqual(inspection.operationIds, []);
    assert.equal(inspection.totalStrategyRecords, 0);
    assert.deepEqual(inspection.activeStrategiesByOperation, {});
    assert.ok(Object.isFrozen(inspection));
  });

  it("validates input and throws ConfigurationError on malformed snapshots", () => {
    for (const invalid of [null, undefined, 42, "string", [], {}, { version: 2 }]) {
      assert.throws(() => inspectStateSnapshot(invalid), ConfigurationError);
    }
  });
});

describe("diffStateSnapshots", () => {
  it("detects added and removed operations in deterministic code-unit order", () => {
    const before: RuntimeStateSnapshot = {
      version: 1,
      exportedAt: 100,
      operations: [createTestOp("delta"), createTestOp("beta"), createTestOp("alpha")],
    };

    const after: RuntimeStateSnapshot = {
      version: 1,
      exportedAt: 200,
      operations: [
        createTestOp("beta"),
        createTestOp("gamma"),
        createTestOp("epsilon"),
        createTestOp("alpha"),
      ],
    };

    const diff = diffStateSnapshots(before, after);

    // Added: in after but not before -> epsilon, gamma (sorted)
    assert.deepEqual(diff.addedOperations, ["epsilon", "gamma"]);
    // Removed: in before but not after -> delta
    assert.deepEqual(diff.removedOperations, ["delta"]);
    // Unchanged: alpha, beta (both null strategy, same strategy)
    assert.deepEqual(diff.unchangedOperations, ["alpha", "beta"]);
    assert.deepEqual(diff.strategyTransitions, []);

    assert.ok(Object.isFrozen(diff));
    assert.ok(Object.isFrozen(diff.addedOperations));
    assert.ok(Object.isFrozen(diff.removedOperations));
    assert.ok(Object.isFrozen(diff.unchangedOperations));
    assert.ok(Object.isFrozen(diff.strategyTransitions));
  });

  it("detects strategy switches and initial selections with switchCountDelta = 1", () => {
    const before: RuntimeStateSnapshot = {
      version: 1,
      exportedAt: 100,
      operations: [
        createTestOp("switched", { currentStrategyId: "fast" }),
        createTestOp("initialized", { currentStrategyId: null, initialized: false }),
        createTestOp("steady", { currentStrategyId: "steady-strat" }),
        createTestOp("uninit-steady", { currentStrategyId: null, initialized: false }),
      ],
    };

    const after: RuntimeStateSnapshot = {
      version: 1,
      exportedAt: 200,
      operations: [
        createTestOp("switched", { currentStrategyId: "slow" }),
        createTestOp("initialized", { currentStrategyId: "first-strat" }),
        createTestOp("steady", { currentStrategyId: "steady-strat", runs: 5 }),
        createTestOp("uninit-steady", { currentStrategyId: null, initialized: false }),
      ],
    };

    const diff = diffStateSnapshots(before, after);

    assert.deepEqual(diff.addedOperations, []);
    assert.deepEqual(diff.removedOperations, []);
    assert.deepEqual(diff.unchangedOperations, ["steady", "uninit-steady"]);

    // strategyTransitions sorted deterministically by operationId: initialized, switched
    assert.equal(diff.strategyTransitions.length, 2);
    assert.deepEqual(diff.strategyTransitions[0], {
      operationId: "initialized",
      previousStrategyId: null,
      currentStrategyId: "first-strat",
      switchCountDelta: 1,
    });
    assert.deepEqual(diff.strategyTransitions[1], {
      operationId: "switched",
      previousStrategyId: "fast",
      currentStrategyId: "slow",
      switchCountDelta: 1,
    });

    assert.ok(Object.isFrozen(diff.strategyTransitions[0]));
    assert.ok(Object.isFrozen(diff.strategyTransitions[1]));
  });

  it("handles complex mixed snapshot diffing with code-unit sorting", () => {
    const before: RuntimeStateSnapshot = {
      version: 1,
      exportedAt: 100,
      operations: [
        createTestOp("B", { currentStrategyId: "strat1" }),
        createTestOp("a", { currentStrategyId: "strat1" }),
        createTestOp("z", { currentStrategyId: "strat1" }),
        createTestOp("rem", { currentStrategyId: "strat1" }),
      ],
    };

    const after: RuntimeStateSnapshot = {
      version: 1,
      exportedAt: 200,
      operations: [
        createTestOp("add2", { currentStrategyId: "strat1" }),
        createTestOp("add1", { currentStrategyId: "strat1" }),
        createTestOp("B", { currentStrategyId: "strat1" }), // unchanged
        createTestOp("a", { currentStrategyId: "strat2" }), // switched
        createTestOp("z", { currentStrategyId: "strat1" }), // unchanged
      ],
    };

    const diff = diffStateSnapshots(before, after);

    assert.deepEqual(diff.addedOperations, ["add1", "add2"]);
    assert.deepEqual(diff.removedOperations, ["rem"]);
    assert.deepEqual(diff.unchangedOperations, ["B", "z"]);
    assert.deepEqual(diff.strategyTransitions, [
      {
        operationId: "a",
        previousStrategyId: "strat1",
        currentStrategyId: "strat2",
        switchCountDelta: 1,
      },
    ]);
  });

  it("validates both before and after snapshots and rejects invalid inputs", () => {
    const valid = validSnapshot();

    assert.throws(() => diffStateSnapshots(null, valid), ConfigurationError);
    assert.throws(() => diffStateSnapshots(valid, null), ConfigurationError);
    assert.throws(() => diffStateSnapshots({ version: 2 }, valid), ConfigurationError);
    assert.throws(() => diffStateSnapshots(valid, { version: 2 }), ConfigurationError);
    assert.throws(() => diffStateSnapshots("bad", "worse"), ConfigurationError);
  });
});

describe("filterStateSnapshot", () => {
  it("filters snapshot by allowed operation IDs array", () => {
    const op1 = createTestOp("op1", { currentStrategyId: "fast", runs: 2 });
    const op2 = createTestOp("op2", { currentStrategyId: "slow", runs: 1 });
    const op3 = createTestOp("op3", { currentStrategyId: null });

    const original: RuntimeStateSnapshot = {
      version: 1,
      exportedAt: 300,
      operations: [op1, op2, op3],
    };

    const filtered = filterStateSnapshot(original, ["op1", "op3", "non-existent"]);

    assert.equal(filtered.version, 1);
    assert.equal(filtered.exportedAt, 300);
    assert.equal(filtered.operations.length, 2);
    assert.equal(filtered.operations[0]?.operationId, "op1");
    assert.equal(filtered.operations[0]?.state.policyState.currentStrategyId, "fast");
    assert.equal(filtered.operations[1]?.operationId, "op3");
    assert.equal(filtered.operations[1]?.state.policyState.currentStrategyId, null);

    // Empty array produces snapshot with zero operations
    const emptyFiltered = filterStateSnapshot(original, []);
    assert.equal(emptyFiltered.operations.length, 0);
    assert.equal(emptyFiltered.exportedAt, 300);
  });

  it("filters snapshot using custom predicate function", () => {
    const opA = createTestOp("user-fetch", { currentStrategyId: "fast", runs: 5 });
    const opB = createTestOp("user-save", { currentStrategyId: null, runs: 0 });
    const opC = createTestOp("system-log", { currentStrategyId: "slow", runs: 10 });

    const original: RuntimeStateSnapshot = {
      version: 1,
      exportedAt: 400,
      operations: [opA, opB, opC],
    };

    // Filter by operationId prefix
    const userOps = filterStateSnapshot(original, (id) => id.startsWith("user-"));
    assert.deepEqual(
      userOps.operations.map((op) => op.operationId),
      ["user-fetch", "user-save"],
    );

    // Filter by policy state (only initialized)
    const initializedOps = filterStateSnapshot(
      original,
      (_id, state: SerializedOperationState) => state.policyState.initialized,
    );
    assert.deepEqual(
      initializedOps.operations.map((op) => op.operationId),
      ["user-fetch", "system-log"],
    );

    // Filter by stats runs > 0
    const activeOps = filterStateSnapshot(
      original,
      (_id, state: SerializedOperationState) => state.stats.runs > 0,
    );
    assert.deepEqual(
      activeOps.operations.map((op) => op.operationId),
      ["user-fetch", "system-log"],
    );
  });

  it("ensures deep immutability and independence from source mutations", () => {
    const raw = mutableSnapshot();
    const filtered = filterStateSnapshot(raw, ["op"]);

    assert.ok(Object.isFrozen(filtered));
    assert.ok(Object.isFrozen(filtered.operations));
    assert.ok(Object.isFrozen(filtered.operations[0]));
    assert.ok(Object.isFrozen(filtered.operations[0]?.state));
    assert.ok(Object.isFrozen(filtered.operations[0]?.state.stats));

    // Mutating raw does not affect filtered
    mutate(raw, ["operations", 0, "operationId"], "mutated");
    assert.equal(filtered.operations[0]?.operationId, "op");

    // Mutating filtered throws
    assert.throws(() => {
      (filtered as { version: number }).version = 2;
    }, TypeError);
    assert.throws(() => {
      (filtered.operations as unknown[]).push({});
    }, TypeError);
  });

  it("validates snapshot and predicateOrIds parameter thoroughly", () => {
    const valid = validSnapshot();

    // Invalid snapshot
    assert.throws(() => filterStateSnapshot(null, ["op"]), ConfigurationError);
    assert.throws(() => filterStateSnapshot({ version: 2 }, ["op"]), ConfigurationError);
    assert.throws(() => filterStateSnapshot("invalid", ["op"]), ConfigurationError);

    // Invalid predicateOrIds
    assert.throws(() => filterStateSnapshot(valid, null), ConfigurationError);
    assert.throws(() => filterStateSnapshot(valid, 123), ConfigurationError);
    assert.throws(() => filterStateSnapshot(valid, true), ConfigurationError);
    assert.throws(() => filterStateSnapshot(valid, {}), ConfigurationError);

    // Array containing non-strings
    assert.throws(() => filterStateSnapshot(valid, [123]), ConfigurationError);
    assert.throws(() => filterStateSnapshot(valid, ["op", null]), ConfigurationError);
    assert.throws(() => filterStateSnapshot(valid, [undefined]), ConfigurationError);
  });
});
