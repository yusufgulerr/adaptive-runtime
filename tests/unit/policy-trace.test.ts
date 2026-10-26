import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigurationError } from "../../src/errors/index.js";
import type { PolicyState, StrategyCandidate } from "../../src/policy/engine.js";
import type { PolicyTimelineStep, SimulatedStrategy } from "../../src/testing/index.js";
import {
  capturePolicyTrace,
  createPolicyTraceRecorder,
  diffPolicyTraces,
  importPolicyTrace,
  type PolicyTrace,
  type RecordPolicyTraceEntryInput,
  replayPolicyTrace,
  summarizePolicyTrace,
} from "../../src/testing/trace.js";
import type { Clock } from "../../src/types/clock.js";
import type { StrategyDecision } from "../../src/types/decision.js";
import type { OperationPolicy } from "../../src/types/policy.js";
import type { ResourceSignal } from "../../src/types/signals.js";

const STRATEGIES: readonly SimulatedStrategy[] = [
  { id: "high", qualityTier: 3 },
  { id: "mid", qualityTier: 2 },
  { id: "low", qualityTier: 1 },
];

const BUDGET_POLICY: OperationPolicy = {
  evaluationIntervalMs: 1000,
  minimumModeDurationMs: 0,
  consecutiveSamples: 1,
  budgets: [
    {
      id: "memory",
      signal: "memory",
      limit: 0.8,
      recoverBelow: 0.7,
      tierReduction: 2,
      consecutiveSamples: 1,
    },
  ],
};

function createTestClock(start = 0): Clock & { set(value: number): void } {
  let current = start;
  return {
    now: () => current,
    setTimeout: () => ({ cancel: () => undefined }),
    set: (value: number) => {
      current = value;
    },
  };
}

function memorySignal(value: number, observedAt: number): ResourceSignal {
  return { name: "memory", unit: "ratio", status: "ok", value, observedAt };
}

function budgetSteps(): readonly PolicyTimelineStep[] {
  return [
    { label: "start", now: 0, signals: [memorySignal(0.1, 0)], sampleSequence: 0 },
    { label: "pressure", now: 1000, signals: [memorySignal(0.9, 1000)], sampleSequence: 1 },
    { label: "recovery", now: 2000, signals: [memorySignal(0.1, 2000)], sampleSequence: 2 },
    {
      label: "cached",
      now: 3000,
      signals: [memorySignal(0.1, 3000)],
      sampleSequence: 2,
      signalsCached: true,
    },
  ];
}

function budgetTrace(): PolicyTrace {
  return capturePolicyTrace({
    operationId: "budget-op",
    policy: BUDGET_POLICY,
    strategies: STRATEGIES,
    steps: budgetSteps(),
    clock: createTestClock(5555),
  });
}

function plainTrace(): PolicyTrace {
  return capturePolicyTrace({
    operationId: "plain-op",
    strategies: STRATEGIES,
    steps: budgetSteps(),
    clock: createTestClock(7777),
  });
}

function entryInput(trace: PolicyTrace, index: number): RecordPolicyTraceEntryInput {
  const entry = trace.entries[index];
  assert.ok(entry, `expected trace entry ${index}`);
  return {
    ...(entry.label === undefined ? {} : { label: entry.label }),
    now: entry.now,
    stateBefore: entry.stateBefore,
    decision: entry.decision,
    stateAfter: entry.stateAfter,
    signals: entry.signals,
    strategies: entry.strategies,
    pinnedStrategyId: entry.pinnedStrategyId,
    adaptationEnabled: entry.adaptationEnabled,
    sampleSequence: entry.sampleSequence,
    signalsCached: entry.signalsCached,
  };
}

function mutableTrace(trace: PolicyTrace): Record<string, unknown> {
  return JSON.parse(JSON.stringify(trace)) as Record<string, unknown>;
}

function mutableEntries(traceJson: Record<string, unknown>): Record<string, unknown>[] {
  const entries = traceJson.entries;
  assert.ok(Array.isArray(entries), "expected entries array");
  return entries as Record<string, unknown>[];
}

function mutableRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), label);
  return value as Record<string, unknown>;
}

function firstMutableEntry(traceJson: Record<string, unknown>): Record<string, unknown> {
  const entry = mutableEntries(traceJson)[0];
  assert.ok(entry, "expected a first entry");
  return entry;
}

describe("createPolicyTraceRecorder", () => {
  it("assigns monotonic sequences, evicts oldest entries, and clears", () => {
    const source = budgetTrace();
    const clock = createTestClock(100);
    const recorder = createPolicyTraceRecorder({
      operationId: "recorder-op",
      maxEntries: 2,
      clock,
    });

    assert.equal(recorder.size(), 0);
    const first = recorder.record(entryInput(source, 0));
    const second = recorder.record(entryInput(source, 1));
    const third = recorder.record(entryInput(source, 2));
    assert.equal(first.sequence, 1);
    assert.equal(second.sequence, 2);
    assert.equal(third.sequence, 3);

    assert.equal(recorder.size(), 2);
    assert.deepEqual(
      recorder.getEntries().map((entry) => entry.sequence),
      [2, 3],
    );

    const exported = recorder.exportTrace();
    assert.equal(exported.version, 1);
    assert.equal(exported.operationId, "recorder-op");
    assert.equal(exported.createdAt, 100);
    assert.deepEqual(
      exported.entries.map((entry) => entry.sequence),
      [2, 3],
    );

    assert.ok(Object.isFrozen(exported));
    assert.ok(Object.isFrozen(exported.entries));
    const retained = exported.entries[0];
    assert.ok(retained);
    assert.ok(Object.isFrozen(retained));
    assert.ok(Object.isFrozen(retained.stateBefore));
    assert.ok(Object.isFrozen(retained.stateBefore.budgets));
    assert.ok(Object.isFrozen(retained.stateAfter));
    assert.ok(Object.isFrozen(retained.decision));
    assert.ok(Object.isFrozen(retained.decision.reasons));
    assert.ok(Object.isFrozen(retained.decision.budgets));
    assert.ok(Object.isFrozen(retained.signals));
    assert.ok(Object.isFrozen(retained.strategies));
    assert.ok(Object.isFrozen(retained.strategies[0]));
    assert.equal(JSON.stringify(exported).includes("undefined"), false);

    clock.set(250);
    recorder.clear();
    assert.equal(recorder.size(), 0);
    assert.deepEqual(recorder.getEntries(), []);
    assert.equal(recorder.exportTrace().createdAt, 250);
    assert.equal(recorder.record(entryInput(source, 3)).sequence, 1);
  });

  it("defaults the operation id and applies the recorded label policy", () => {
    const source = budgetTrace();
    const recorder = createPolicyTraceRecorder();
    const labeled = recorder.record(entryInput(source, 0));
    const unlabeled = recorder.record({
      ...entryInput(source, 1),
      label: undefined,
    });

    assert.equal(recorder.exportTrace().operationId, "traced-operation");
    assert.equal(labeled.label, "start");
    assert.equal("label" in unlabeled, false);
    assert.equal(unlabeled.sequence, 2);
    assert.equal(JSON.stringify(recorder.exportTrace()).includes("undefined"), false);
  });

  it("deep-copies inputs so later mutation cannot alter a recorded entry", () => {
    const source = budgetTrace();
    const input = entryInput(source, 1);
    const stateBefore = JSON.parse(JSON.stringify(input.stateBefore)) as {
      currentStrategyId: string | null;
      budgets: Record<string, { engaged: boolean }>;
    };
    const decision = JSON.parse(JSON.stringify(input.decision)) as {
      strategyId: string;
      reasons: { message: string }[];
    };
    const signals = JSON.parse(JSON.stringify(input.signals)) as { value?: number }[];
    const strategies = JSON.parse(JSON.stringify(input.strategies)) as {
      id: string;
      samples?: number | null;
    }[];

    const recorder = createPolicyTraceRecorder();
    const recorded = recorder.record({
      ...input,
      stateBefore: stateBefore as unknown as PolicyState,
      decision: decision as unknown as StrategyDecision,
      signals: signals as unknown as readonly ResourceSignal[],
      strategies: strategies as unknown as readonly StrategyCandidate[],
    });
    const snapshot = JSON.stringify(recorded);

    const memoryBudget = stateBefore.budgets.memory;
    assert.ok(memoryBudget);
    memoryBudget.engaged = false;
    stateBefore.currentStrategyId = "tampered";
    decision.strategyId = "tampered";
    const firstReason = decision.reasons[0];
    assert.ok(firstReason);
    firstReason.message = "tampered";
    const firstSignal = signals[0];
    assert.ok(firstSignal);
    firstSignal.value = 0.99;
    const firstStrategy = strategies[0];
    assert.ok(firstStrategy);
    firstStrategy.id = "tampered";
    firstStrategy.samples = 99;

    assert.equal(JSON.stringify(recorded), snapshot);
    assert.equal(recorded.decision.strategyId, "low");
    assert.equal(recorded.stateBefore.currentStrategyId, "high");
    const recordedSignal = recorded.signals[0];
    assert.ok(recordedSignal);
    assert.equal(recordedSignal.status === "ok" ? recordedSignal.value : undefined, 0.9);
    assert.equal(recorded.strategies[0]?.id, "high");
    assert.equal(recorded.strategies[0]?.samples, null);
  });

  it("rejects invalid recorder options and entry shapes", () => {
    assert.throws(() => createPolicyTraceRecorder({ operationId: "" }), ConfigurationError);
    assert.throws(() => createPolicyTraceRecorder({ operationId: " padded" }), ConfigurationError);
    assert.throws(() => createPolicyTraceRecorder({ maxEntries: 0 }), ConfigurationError);
    assert.throws(() => createPolicyTraceRecorder({ maxEntries: 1.5 }), ConfigurationError);
    assert.throws(() => createPolicyTraceRecorder({ maxEntries: Number.NaN }), ConfigurationError);
    assert.throws(
      () => createPolicyTraceRecorder({ clock: {} as unknown as Clock }),
      ConfigurationError,
    );

    const source = budgetTrace();
    const recorder = createPolicyTraceRecorder();
    assert.throws(
      () => recorder.record(null as unknown as RecordPolicyTraceEntryInput),
      ConfigurationError,
    );
    assert.throws(
      () =>
        recorder.record({
          ...entryInput(source, 0),
          now: -1,
        }),
      ConfigurationError,
    );
    assert.throws(
      () =>
        recorder.record({
          ...entryInput(source, 0),
          signals: "not-an-array" as unknown as readonly ResourceSignal[],
        }),
      ConfigurationError,
    );
    assert.throws(
      () =>
        recorder.record({
          ...entryInput(source, 0),
          strategies: [],
        }),
      ConfigurationError,
    );
    assert.throws(
      () =>
        recorder.record({
          ...entryInput(source, 0),
          pinnedStrategyId: " padded",
        }),
      ConfigurationError,
    );
  });
});

describe("capturePolicyTrace", () => {
  it("captures a multi-step budget timeline with normalized strategies", () => {
    const trace = budgetTrace();
    assert.equal(trace.version, 1);
    assert.equal(trace.operationId, "budget-op");
    assert.equal(trace.createdAt, 5555);
    assert.deepEqual(
      trace.entries.map((entry) => entry.sequence),
      [1, 2, 3, 4],
    );
    assert.deepEqual(
      trace.entries.map((entry) => entry.label),
      ["start", "pressure", "recovery", "cached"],
    );
    assert.deepEqual(
      trace.entries.map((entry) => entry.now),
      [0, 1000, 2000, 3000],
    );
    assert.deepEqual(
      trace.entries.map((entry) => entry.decision.strategyId),
      ["high", "low", "high", "high"],
    );
    assert.deepEqual(
      trace.entries.map((entry) => entry.decision.kind),
      ["initial", "adapted", "adapted", "retained"],
    );
    assert.deepEqual(
      trace.entries.map((entry) => entry.decision.changed),
      [false, true, true, false],
    );

    const firstEntry = trace.entries[0];
    assert.ok(firstEntry);
    assert.equal(firstEntry.stateBefore.initialized, false);
    assert.equal(firstEntry.stateAfter.initialized, true);
    const lastEntry = trace.entries[3];
    assert.ok(lastEntry);
    assert.equal(lastEntry.stateAfter.currentStrategyId, "high");

    for (const entry of trace.entries) {
      for (const strategy of entry.strategies) {
        assert.equal(strategy.applicable, true);
        assert.equal(strategy.samples, null);
      }
    }
    assert.equal(JSON.stringify(trace).includes("undefined"), false);
    assert.deepEqual(importPolicyTrace(JSON.parse(JSON.stringify(trace))), trace);
  });

  it("defaults step clocks, operation id, and initial state", () => {
    const trace = capturePolicyTrace({
      strategies: [{ id: "only", qualityTier: 1 }],
      steps: [{ signals: [] }, { signals: [] }],
    });
    assert.equal(trace.operationId, "traced-operation");
    assert.deepEqual(
      trace.entries.map((entry) => entry.now),
      [0, 1000],
    );
    assert.equal(trace.entries[0]?.stateBefore.initialized, false);
    assert.equal(trace.entries[1]?.stateBefore.initialized, true);
  });

  it("passes through optional stats and per-step strategy overrides", () => {
    const trace = capturePolicyTrace({
      strategies: [
        { id: "a", qualityTier: 2 },
        {
          id: "b",
          qualityTier: 1,
          costTier: 0.5,
          estimatedLatencyMs: null,
          ewmaLatencyMs: 12,
          errorRate: 0,
          samples: 5,
        },
      ],
      steps: [
        {
          label: "explicit",
          now: 42,
          signals: [],
          strategies: [{ id: "c", qualityTier: 4 }],
        },
        { now: 84, signals: [] },
      ],
    });

    assert.equal(trace.entries[0]?.now, 42);
    assert.equal(trace.entries[1]?.now, 84);
    assert.equal(trace.entries[0]?.label, "explicit");
    assert.equal(trace.entries[1]?.label, undefined);
    assert.equal(trace.entries[0]?.decision.strategyId, "c");
    assert.equal(trace.entries[0]?.strategies[0]?.applicable, true);
    assert.equal(trace.entries[0]?.strategies[0]?.samples, null);
    assert.equal(trace.entries[0]?.strategies[0]?.costTier, undefined);
    assert.equal(trace.entries[1]?.strategies[1]?.costTier, 0.5);
    assert.equal(trace.entries[1]?.strategies[1]?.estimatedLatencyMs, null);
    assert.equal(trace.entries[1]?.strategies[1]?.ewmaLatencyMs, 12);
    assert.equal(trace.entries[1]?.strategies[1]?.errorRate, 0);
    assert.equal(trace.entries[1]?.strategies[1]?.samples, 5);
  });

  it("rejects invalid capture options and steps", () => {
    assert.throws(
      () => capturePolicyTrace(null as unknown as Parameters<typeof capturePolicyTrace>[0]),
      ConfigurationError,
    );
    assert.throws(
      () =>
        capturePolicyTrace({
          strategies: [],
          steps: [{ signals: [] }],
        }),
      ConfigurationError,
    );
    assert.throws(
      () =>
        capturePolicyTrace({
          strategies: [{ id: "only", qualityTier: 1 }],
          steps: [],
        }),
      ConfigurationError,
    );
    assert.throws(
      () =>
        capturePolicyTrace({
          strategies: [
            { id: "duplicate", qualityTier: 2 },
            { id: "duplicate", qualityTier: 1 },
          ],
          steps: [{ signals: [] }],
        }),
      ConfigurationError,
    );
    assert.throws(
      () =>
        capturePolicyTrace({
          strategies: [{ id: "only", qualityTier: 1 }],
          steps: [{ now: -1, signals: [] }],
        }),
      ConfigurationError,
    );
    assert.throws(
      () =>
        capturePolicyTrace({
          strategies: [{ id: "only", qualityTier: 1 }],
          steps: [{ signals: [] }, {} as unknown as PolicyTimelineStep],
        }),
      ConfigurationError,
    );
    assert.throws(
      () =>
        capturePolicyTrace({
          strategies: [{ id: "only", qualityTier: 1, samples: -1 }],
          steps: [{ signals: [] }],
        }),
      ConfigurationError,
    );
  });
});

describe("replayPolicyTrace", () => {
  it("reports a deterministic round trip for the original policy", () => {
    const report = replayPolicyTrace(budgetTrace(), { policy: BUDGET_POLICY });
    assert.equal(report.operationId, "budget-op");
    assert.equal(report.totalEntries, 4);
    assert.equal(report.matchedEntries, 4);
    assert.equal(report.mismatchedEntries, 0);
    assert.equal(report.deterministic, true);
    assert.deepEqual(report.divergences, []);
    assert.ok(Object.isFrozen(report));
    assert.ok(Object.isFrozen(report.divergences));
  });

  it("detects a policy change and reports changed decision fields", () => {
    const report = replayPolicyTrace(budgetTrace());
    assert.equal(report.totalEntries, 4);
    assert.equal(report.matchedEntries, 0);
    assert.equal(report.mismatchedEntries, 4);
    assert.equal(report.deterministic, false);
    assert.equal(report.divergences.length, 4);

    const pressure = report.divergences.find((divergence) => divergence.sequence === 2);
    assert.ok(pressure);
    assert.equal(pressure.label, "pressure");
    assert.equal(pressure.expectedStrategyId, "low");
    assert.equal(pressure.actualStrategyId, "high");
    assert.deepEqual(pressure.fields, [
      "strategyId",
      "qualityTier",
      "changed",
      "kind",
      "modeSince",
      "targetQualityTier",
    ]);
    assert.equal(pressure.stateMatched, false);

    const cached = report.divergences.find((divergence) => divergence.sequence === 4);
    assert.ok(cached);
    assert.deepEqual(cached.fields, []);
    assert.equal(cached.stateMatched, false);
    assert.equal(cached.expectedStrategyId, "high");
    assert.equal(cached.actualStrategyId, "high");
  });

  it("detects a decision-strategy mismatch", () => {
    const json = mutableTrace(budgetTrace());
    const entry = firstMutableEntry(json);
    mutableRecord(entry.decision, "decision").strategyId = "tampered";
    const tampered = importPolicyTrace(json);

    const report = replayPolicyTrace(tampered, { policy: BUDGET_POLICY });
    assert.equal(report.deterministic, false);
    assert.equal(report.divergences.length, 1);
    const divergence = report.divergences[0];
    assert.ok(divergence);
    assert.equal(divergence.sequence, 1);
    assert.equal(divergence.label, "start");
    assert.equal(divergence.expectedStrategyId, "tampered");
    assert.equal(divergence.actualStrategyId, "high");
    assert.deepEqual(divergence.fields, ["strategyId"]);
    assert.equal(divergence.stateMatched, true);
  });

  it("structurally compares the replayed next state", () => {
    const json = mutableTrace(budgetTrace());
    const entry = firstMutableEntry(json);
    mutableRecord(entry.stateAfter, "stateAfter").modeSince = 999;
    const tampered = importPolicyTrace(json);

    const report = replayPolicyTrace(tampered, { policy: BUDGET_POLICY });
    assert.equal(report.deterministic, false);
    assert.equal(report.mismatchedEntries, 1);
    const divergence = report.divergences[0];
    assert.ok(divergence);
    assert.deepEqual(divergence.fields, []);
    assert.equal(divergence.stateMatched, false);
  });
});

describe("diffPolicyTraces", () => {
  it("reports full agreement for identical traces", () => {
    const trace = budgetTrace();
    const diff = diffPolicyTraces(trace, trace);
    assert.equal(diff.baselineOperationId, "budget-op");
    assert.equal(diff.candidateOperationId, "budget-op");
    assert.equal(diff.totalEntries, 4);
    assert.equal(diff.comparedEntries, 4);
    assert.equal(diff.divergenceCount, 0);
    assert.equal(diff.agreementRatio, 1);
    assert.equal(diff.strategySwitchDelta, 0);
    assert.deepEqual(diff.divergences, []);
    assert.ok(Object.isFrozen(diff));
    assert.ok(Object.isFrozen(diff.divergences));
  });

  it("reports divergent strategy selections and switch deltas", () => {
    const diff = diffPolicyTraces(budgetTrace(), plainTrace());
    assert.equal(diff.totalEntries, 4);
    assert.equal(diff.comparedEntries, 4);
    assert.equal(diff.divergenceCount, 1);
    assert.equal(diff.agreementRatio, 0.75);
    assert.equal(diff.strategySwitchDelta, -2);

    const divergence = diff.divergences[0];
    assert.ok(divergence);
    assert.equal(divergence.index, 1);
    assert.equal(divergence.baselineSequence, 2);
    assert.equal(divergence.candidateSequence, 2);
    assert.equal(divergence.label, "pressure");
    assert.equal(divergence.baselineStrategyId, "low");
    assert.equal(divergence.candidateStrategyId, "high");
  });

  it("counts missing entries on either side as divergences", () => {
    const short = importPolicyTrace({
      version: 1,
      operationId: "short-op",
      createdAt: 100,
      entries: plainTrace().entries.slice(0, 2),
    });
    const diff = diffPolicyTraces(budgetTrace(), short);

    assert.equal(diff.totalEntries, 4);
    assert.equal(diff.comparedEntries, 4);
    assert.equal(diff.divergenceCount, 3);
    assert.equal(diff.agreementRatio, 0.25);

    const missingIndex = diff.divergences.find((divergence) => divergence.index === 2);
    assert.ok(missingIndex);
    assert.equal(missingIndex.baselineSequence, 3);
    assert.equal(missingIndex.candidateSequence, -1);
    assert.equal(missingIndex.baselineStrategyId, "high");
    assert.equal(missingIndex.candidateStrategyId, "<missing>");
  });

  it("returns agreement 1 for two empty traces", () => {
    const empty = importPolicyTrace({
      version: 1,
      operationId: "empty-op",
      createdAt: 0,
      entries: [],
    });
    const diff = diffPolicyTraces(empty, empty);
    assert.equal(diff.totalEntries, 0);
    assert.equal(diff.comparedEntries, 0);
    assert.equal(diff.divergenceCount, 0);
    assert.equal(diff.agreementRatio, 1);
    assert.equal(diff.strategySwitchDelta, 0);
  });
});

describe("summarizePolicyTrace", () => {
  it("counts strategies, kinds, switches, reversals, caches, and budgets", () => {
    const summary = summarizePolicyTrace(budgetTrace());
    assert.equal(summary.operationId, "budget-op");
    assert.equal(summary.entryCount, 4);
    assert.equal(summary.firstAt, 0);
    assert.equal(summary.lastAt, 3000);
    assert.deepEqual(summary.strategyCounts, { high: 3, low: 1 });
    assert.deepEqual(summary.kindCounts, { adapted: 2, initial: 1, retained: 1 });
    assert.equal(summary.strategySwitches, 2);
    assert.equal(summary.strategyReversals, 1);
    assert.equal(summary.cachedSamples, 1);
    assert.deepEqual(summary.engagedBudgetIds, ["memory"]);
    assert.ok(Object.isFrozen(summary));
    assert.ok(Object.isFrozen(summary.strategyCounts));
    assert.ok(Object.isFrozen(summary.kindCounts));
    assert.ok(Object.isFrozen(summary.engagedBudgetIds));
  });

  it("does not report a budget that was already engaged before the trace", () => {
    const firstEntry = budgetTrace().entries[0];
    assert.ok(firstEntry);
    const initialState: PolicyState = {
      ...firstEntry.stateBefore,
      budgets: {
        ...firstEntry.stateBefore.budgets,
        memory: { engaged: true, aboveStreak: 90, belowStreak: 0 },
      },
    };
    const trace = capturePolicyTrace({
      operationId: "pre-engaged",
      policy: BUDGET_POLICY,
      strategies: STRATEGIES,
      initialState,
      steps: [{ now: 0, signals: [memorySignal(0.9, 0)], sampleSequence: 0 }],
      clock: createTestClock(0),
    });

    assert.equal(trace.entries[0]?.stateBefore.budgets.memory?.engaged, true);
    assert.equal(trace.entries[0]?.decision.budgets[0]?.engaged, true);
    assert.deepEqual(summarizePolicyTrace(trace).engagedBudgetIds, []);
  });

  it("preserves reserved __proto__ keys in counts, budgets, and JSON details", () => {
    const reservedTrace = capturePolicyTrace({
      operationId: "reserved-keys",
      strategies: [{ id: "__proto__", qualityTier: 1 }],
      steps: [{ now: 0, signals: [memorySignal(0.1, 0)] }],
      clock: createTestClock(0),
    });
    const summary = summarizePolicyTrace(reservedTrace);
    const reservedCount = Object.getOwnPropertyDescriptor(summary.strategyCounts, "__proto__");
    assert.equal(reservedCount?.value, 1);
    assert.ok(Object.isFrozen(summary.strategyCounts));

    const json = mutableTrace(budgetTrace());
    const first = firstMutableEntry(json);
    const stateAfter = mutableRecord(first.stateAfter, "stateAfter");
    const budgets = mutableRecord(stateAfter.budgets, "budgets");
    Object.defineProperty(budgets, "__proto__", {
      configurable: true,
      enumerable: true,
      value: { engaged: true, aboveStreak: 1, belowStreak: 0 },
      writable: true,
    });
    const signals = first.signals;
    assert.ok(Array.isArray(signals));
    const signal = mutableRecord(signals[0], "signal");
    signal.details = JSON.parse('{"__proto__":{"nested":true},"safe":2}');

    const imported = importPolicyTrace(json);
    const importedBudgets = imported.entries[0]?.stateAfter.budgets;
    assert.ok(importedBudgets);
    const reservedBudgetProperty = Object.getOwnPropertyDescriptor(importedBudgets, "__proto__");
    assert.ok(reservedBudgetProperty);
    const reservedBudget = reservedBudgetProperty.value as PolicyState["budgets"][string];
    assert.equal(reservedBudget.engaged, true);
    assert.ok(Object.isFrozen(reservedBudget));

    const details = imported.entries[0]?.signals[0]?.details;
    assert.ok(details);
    const reservedDetailProperty = Object.getOwnPropertyDescriptor(details, "__proto__");
    assert.ok(reservedDetailProperty);
    assert.equal(mutableRecord(reservedDetailProperty.value, "details.__proto__").nested, true);
    assert.ok(Object.isFrozen(reservedDetailProperty.value));
    assert.ok(Object.isFrozen(details));
    assert.equal(details.safe, 2);
  });

  it("summarizes an empty trace without throwing", () => {
    const empty = importPolicyTrace({
      version: 1,
      operationId: "empty-op",
      createdAt: 0,
      entries: [],
    });
    const summary = summarizePolicyTrace(empty);
    assert.equal(summary.entryCount, 0);
    assert.equal(summary.firstAt, 0);
    assert.equal(summary.lastAt, 0);
    assert.deepEqual(summary.strategyCounts, {});
    assert.deepEqual(summary.kindCounts, {});
    assert.equal(summary.strategySwitches, 0);
    assert.equal(summary.strategyReversals, 0);
    assert.equal(summary.cachedSamples, 0);
    assert.deepEqual(summary.engagedBudgetIds, []);
  });
});

describe("importPolicyTrace", () => {
  it("deep-freezes a valid trace and preserves its JSON shape", () => {
    const original = budgetTrace();
    const imported = importPolicyTrace(JSON.parse(JSON.stringify(original)));
    assert.deepEqual(imported, original);
    assert.equal(JSON.stringify(imported), JSON.stringify(original));

    assert.ok(Object.isFrozen(imported));
    assert.ok(Object.isFrozen(imported.entries));
    const entry = imported.entries[1];
    assert.ok(entry);
    assert.ok(Object.isFrozen(entry.stateBefore));
    assert.ok(Object.isFrozen(entry.stateBefore.budgets));
    assert.ok(Object.isFrozen(entry.stateAfter));
    assert.ok(Object.isFrozen(entry.decision));
    assert.ok(Object.isFrozen(entry.decision.signals));
    assert.ok(Object.isFrozen(entry.decision.budgets));
    assert.ok(Object.isFrozen(entry.decision.reasons));
    assert.ok(Object.isFrozen(entry.signals));
    assert.ok(Object.isFrozen(entry.strategies));
  });

  it("accepts and preserves rich optional JSON fields", () => {
    const json = mutableTrace(budgetTrace());
    const firstEntry = firstMutableEntry(json);

    const stateBefore = mutableRecord(firstEntry.stateBefore, "stateBefore");
    stateBefore.pendingStrategyId = "high";

    const signals = firstEntry.signals;
    assert.ok(Array.isArray(signals));
    const signal = signals[0];
    assert.ok(signal !== null && typeof signal === "object");
    (signal as Record<string, unknown>).confidence = 0.75;
    (signal as Record<string, unknown>).details = {
      note: "fresh",
      observed: true,
      count: 2,
    };

    const decision = mutableRecord(firstEntry.decision, "decision");
    const decisionSignals = decision.signals;
    assert.ok(Array.isArray(decisionSignals));
    const signalView = decisionSignals[0];
    assert.ok(signalView !== null && typeof signalView === "object");
    (signalView as Record<string, unknown>).observedAt = 0;
    (signalView as Record<string, unknown>).detail = "initial";

    const budgets = decision.budgets;
    assert.ok(Array.isArray(budgets));
    const budgetView = budgets[0];
    assert.ok(budgetView !== null && typeof budgetView === "object");
    (budgetView as Record<string, unknown>).value = 0.1;
    (budgetView as Record<string, unknown>).ageMs = 0;

    const imported = importPolicyTrace(json);
    assert.equal(imported.entries[0]?.stateBefore.pendingStrategyId, "high");
    const importedSignal = imported.entries[0]?.signals[0];
    assert.ok(importedSignal !== undefined);
    assert.equal(importedSignal.status, "ok");
    assert.equal(importedSignal.confidence, 0.75);
    assert.deepEqual(importedSignal?.details, { note: "fresh", observed: true, count: 2 });
    const importedView = imported.entries[0]?.decision.signals[0];
    assert.equal(importedView?.observedAt, 0);
    assert.equal(importedView?.detail, "initial");
    const importedBudget = imported.entries[0]?.decision.budgets[0];
    assert.equal(importedBudget?.value, 0.1);
    assert.equal(importedBudget?.ageMs, 0);
    assert.ok(Object.isFrozen(importedSignal?.details));
  });

  it("rejects malformed trace values", () => {
    const base = budgetTrace();
    const malformed: {
      readonly name: string;
      readonly mutate: (trace: Record<string, unknown>) => void;
    }[] = [
      { name: "version", mutate: (trace) => (trace.version = 2) },
      { name: "operation id", mutate: (trace) => (trace.operationId = " padded") },
      { name: "empty operation id", mutate: (trace) => (trace.operationId = "") },
      { name: "createdAt", mutate: (trace) => (trace.createdAt = Number.NaN) },
      { name: "entries", mutate: (trace) => (trace.entries = "nope") },
      {
        name: "sequence zero",
        mutate: (trace) => (firstMutableEntry(trace).sequence = 0),
      },
      {
        name: "sequence order",
        mutate: (trace) => {
          const second = mutableEntries(trace)[1];
          assert.ok(second);
          second.sequence = 1;
        },
      },
      {
        name: "label",
        mutate: (trace) => (firstMutableEntry(trace).label = 7),
      },
      {
        name: "now",
        mutate: (trace) => (firstMutableEntry(trace).now = -1),
      },
      {
        name: "signals",
        mutate: (trace) => (firstMutableEntry(trace).signals = "nope"),
      },
      {
        name: "strategies empty",
        mutate: (trace) => (firstMutableEntry(trace).strategies = []),
      },
      {
        name: "pinned strategy",
        mutate: (trace) => (firstMutableEntry(trace).pinnedStrategyId = ""),
      },
      {
        name: "adaptation",
        mutate: (trace) => (firstMutableEntry(trace).adaptationEnabled = "yes"),
      },
      {
        name: "sample sequence",
        mutate: (trace) => (firstMutableEntry(trace).sampleSequence = -1),
      },
      {
        name: "signals cached",
        mutate: (trace) => (firstMutableEntry(trace).signalsCached = 1),
      },
      {
        name: "missing state",
        mutate: (trace) => delete firstMutableEntry(trace).stateBefore,
      },
      {
        name: "budget shape",
        mutate: (trace) =>
          (mutableRecord(firstMutableEntry(trace).stateBefore, "stateBefore").budgets = []),
      },
      {
        name: "decision kind",
        mutate: (trace) =>
          (mutableRecord(firstMutableEntry(trace).decision, "decision").kind = "bogus"),
      },
      {
        name: "decision signals",
        mutate: (trace) =>
          delete mutableRecord(firstMutableEntry(trace).decision, "decision").signals,
      },
      {
        name: "decision reasons",
        mutate: (trace) =>
          (mutableRecord(firstMutableEntry(trace).decision, "decision").reasons = "nope"),
      },
      {
        name: "previous strategy",
        mutate: (trace) =>
          (mutableRecord(firstMutableEntry(trace).decision, "decision").previousStrategyId = 3),
      },
      {
        name: "signal status",
        mutate: (trace) => {
          const signals = mutableEntries(trace)[0]?.signals;
          assert.ok(Array.isArray(signals));
          const signal = signals[0];
          assert.ok(signal !== null && typeof signal === "object");
          (signal as Record<string, unknown>).status = "weird";
        },
      },
      {
        name: "strategy applicability",
        mutate: (trace) => {
          const strategies = mutableEntries(trace)[0]?.strategies;
          assert.ok(Array.isArray(strategies));
          const strategy = strategies[0];
          assert.ok(strategy !== null && typeof strategy === "object");
          (strategy as Record<string, unknown>).applicable = "yes";
        },
      },
      {
        name: "strategy samples",
        mutate: (trace) => {
          const strategies = mutableEntries(trace)[0]?.strategies;
          assert.ok(Array.isArray(strategies));
          const strategy = strategies[0];
          assert.ok(strategy !== null && typeof strategy === "object");
          (strategy as Record<string, unknown>).samples = -1;
        },
      },
    ];

    for (const { name, mutate } of malformed) {
      const json = mutableTrace(base);
      mutate(json);
      assert.throws(() => importPolicyTrace(json), ConfigurationError, name);
    }
  });

  it("rejects non-object inputs and non-JSON decision details", () => {
    assert.throws(() => importPolicyTrace(null), ConfigurationError);
    assert.throws(() => importPolicyTrace([]), ConfigurationError);
    assert.throws(() => importPolicyTrace(7), ConfigurationError);
    assert.throws(() => importPolicyTrace({}), ConfigurationError);

    const json = mutableTrace(budgetTrace());
    const decision = mutableRecord(firstMutableEntry(json).decision, "decision");
    const reasons = decision.reasons;
    assert.ok(Array.isArray(reasons));
    const firstReason = reasons[0];
    assert.ok(firstReason !== null && typeof firstReason === "object");
    (firstReason as Record<string, unknown>).details = { callback: () => undefined };
    assert.throws(() => importPolicyTrace(json), ConfigurationError);

    const circular = mutableTrace(budgetTrace());
    const circularDecision = mutableRecord(firstMutableEntry(circular).decision, "decision");
    const circularDetails: Record<string, unknown> = {};
    circularDetails.self = circularDetails;
    circularDecision.reasons = [
      { code: "strategy-retained", message: "circular", details: circularDetails },
    ];
    assert.throws(() => importPolicyTrace(circular), ConfigurationError);
  });
});
