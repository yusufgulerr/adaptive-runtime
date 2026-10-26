import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigurationError } from "../../src/errors/index.js";
import {
  attachSloMonitor,
  createSloMonitor,
  type SloMonitor,
  type SloMonitorOptions,
  type SloMonitorSnapshot,
  type SloObjective,
  type SloObjectiveSnapshot,
  type SloObservation,
} from "../../src/observability/slo.js";
import { createAdaptiveRuntime } from "../../src/runtime/runtime.js";
import type { AdaptiveRuntime } from "../../src/types/runtime.js";
import type { Strategy } from "../../src/types/strategy.js";
import { FakeClock } from "../helpers/fake-clock.js";

function cast<T>(value: unknown): T {
  return value as T;
}

function availabilityObjective(overrides: Partial<SloObjective> = {}): SloObjective {
  return { id: "availability", metric: "availability", target: 0.9, ...overrides };
}

function objectiveAt(snapshot: SloMonitorSnapshot, index: number): SloObjectiveSnapshot {
  const objective = snapshot.objectives[index];
  assert.ok(objective !== undefined, `missing objective at index ${index}`);
  return objective;
}

function recordBatch(
  monitor: SloMonitor,
  samples: number,
  successes: number,
  durationMs = 5,
): void {
  for (let index = 0; index < samples; index += 1) {
    monitor.record({ durationMs, succeeded: index < successes });
  }
}

function recordDurations(monitor: SloMonitor, durations: readonly number[]): void {
  for (const durationMs of durations) {
    monitor.record({ durationMs, succeeded: true });
  }
}

function expectConfigurationError(action: () => unknown, pattern?: RegExp): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ConfigurationError);
    if (pattern !== undefined) {
      assert.match(error.message, pattern);
    }
    return true;
  });
}

describe("createSloMonitor validation", () => {
  it("rejects malformed monitor options", () => {
    expectConfigurationError(
      () => createSloMonitor(cast<SloMonitorOptions>(undefined)),
      /options must be an object/,
    );
    expectConfigurationError(
      () => createSloMonitor(cast<SloMonitorOptions>(null)),
      /options must be an object/,
    );
    expectConfigurationError(() => createSloMonitor({ objectives: [] }), /non-empty array/);
    expectConfigurationError(
      () => createSloMonitor(cast<SloMonitorOptions>({ objectives: null })),
      /non-empty array/,
    );
    expectConfigurationError(
      () => createSloMonitor(cast<SloMonitorOptions>({ objectives: "availability" })),
      /non-empty array/,
    );
    expectConfigurationError(
      () => createSloMonitor({ objectives: [cast<SloObjective>(null)] }),
      /objectives\[0\] must be an object/,
    );
    expectConfigurationError(
      () => createSloMonitor({ objectives: [cast<SloObjective>([])] }),
      /objectives\[0\] must be an object/,
    );
    expectConfigurationError(
      () => createSloMonitor({ objectives: [cast<SloObjective>({})] }),
      /objectives\[0\]\.id/,
    );
  });

  it("rejects non-canonical and duplicate objective ids", () => {
    expectConfigurationError(
      () =>
        createSloMonitor({
          objectives: [{ id: "", metric: "availability", target: 0.9 }],
        }),
      /objectives\[0\]\.id must be a non-empty string/,
    );
    expectConfigurationError(
      () =>
        createSloMonitor({
          objectives: [{ id: "   ", metric: "availability", target: 0.9 }],
        }),
      /objectives\[0\]\.id must be a non-empty string/,
    );
    expectConfigurationError(
      () =>
        createSloMonitor({
          objectives: [{ id: cast<string>(42), metric: "availability", target: 0.9 }],
        }),
      /objectives\[0\]\.id must be a non-empty string/,
    );
    expectConfigurationError(
      () =>
        createSloMonitor({
          objectives: [
            { id: "availability", metric: "availability", target: 0.9 },
            { id: " availability ", metric: "latency", target: 10 },
          ],
        }),
      /slo objective id "availability" must be unique/,
    );
  });

  it("rejects invalid metric, target, window, sample, margin, and operation values", () => {
    expectConfigurationError(
      () =>
        createSloMonitor({
          objectives: [
            { id: "bad-metric", metric: cast<SloObjective["metric"]>("throughput"), target: 1 },
          ],
        }),
      /metric must be one of/,
    );

    const badTargets: readonly SloObjective[] = [
      { id: "missing", metric: "availability", target: cast<number>(undefined) },
      { id: "nan", metric: "availability", target: Number.NaN },
      { id: "negative", metric: "availability", target: -0.01 },
      { id: "above-one", metric: "error-rate", target: 1.01 },
      { id: "latency-zero", metric: "latency", target: 0 },
      { id: "latency-negative", metric: "latency", target: -5 },
      { id: "latency-infinite", metric: "latency", target: Number.POSITIVE_INFINITY },
    ];
    for (const objective of badTargets) {
      expectConfigurationError(() => createSloMonitor({ objectives: [objective] }), /target/);
    }

    const badWindows: readonly unknown[] = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5"];
    for (const windowSize of badWindows) {
      expectConfigurationError(
        () =>
          createSloMonitor({
            objectives: [
              {
                id: "window",
                metric: "availability",
                target: 0.9,
                windowSize: cast<number>(windowSize),
              },
            ],
          }),
        /windowSize must be a safe integer/,
      );
    }

    const badSamples: readonly unknown[] = [0, -1, 1.5, Number.NaN, "3"];
    for (const minSamples of badSamples) {
      expectConfigurationError(
        () =>
          createSloMonitor({
            objectives: [
              {
                id: "samples",
                metric: "latency",
                target: 10,
                minSamples: cast<number>(minSamples),
              },
            ],
          }),
        /minSamples must be a safe integer/,
      );
    }

    const badMargins: readonly unknown[] = [
      -0.01,
      1.01,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "0.1",
    ];
    for (const warningMargin of badMargins) {
      expectConfigurationError(
        () =>
          createSloMonitor({
            objectives: [
              {
                id: "margin",
                metric: "availability",
                target: 0.9,
                warningMargin: cast<number>(warningMargin),
              },
            ],
          }),
        /warningMargin must be a finite number/,
      );
    }

    const badOperations: readonly unknown[] = ["", "   ", 42, null];
    for (const operationId of badOperations) {
      expectConfigurationError(
        () =>
          createSloMonitor({
            objectives: [
              {
                id: "operation",
                metric: "availability",
                target: 0.9,
                operationId: cast<string>(operationId),
              },
            ],
          }),
        /operationId must be a non-empty string/,
      );
    }
  });

  it("rejects malformed observations", () => {
    const monitor = createSloMonitor({ objectives: [availabilityObjective()] });
    const badObservations: readonly unknown[] = [
      null,
      [],
      {},
      { durationMs: -1, succeeded: true },
      { durationMs: Number.NaN, succeeded: true },
      { durationMs: Number.POSITIVE_INFINITY, succeeded: true },
      { durationMs: 5 },
      { durationMs: 5, succeeded: "yes" },
      { durationMs: 5, succeeded: true, operationId: "" },
      { durationMs: 5, succeeded: true, operationId: 7 },
      { durationMs: 5, succeeded: true, at: -1 },
      { durationMs: 5, succeeded: true, at: Number.NaN },
      { durationMs: 5, succeeded: true, at: "now" },
    ];
    for (const observation of badObservations) {
      expectConfigurationError(
        () => monitor.record(cast<SloObservation>(observation)),
        /observation/,
      );
    }
    assert.equal(monitor.getSnapshot().observationCount, 0);
  });
});

describe("SloMonitor metric evaluation", () => {
  it("evaluates availability met, at-risk, and breached boundaries", () => {
    const monitor = createSloMonitor({
      objectives: [
        {
          id: "availability",
          metric: "availability",
          target: 0.9,
          windowSize: 100,
          warningMargin: 0.1,
        },
      ],
    });

    recordBatch(monitor, 100, 90);
    let objective = objectiveAt(monitor.getSnapshot(), 0);
    assert.equal(objective.sampleCount, 100);
    assert.equal(objective.value, 0.9);
    assert.equal(objective.status, "met");

    monitor.reset();
    recordBatch(monitor, 100, 85);
    objective = objectiveAt(monitor.getSnapshot(), 0);
    assert.equal(objective.value, 0.85);
    assert.equal(objective.status, "at-risk");

    monitor.reset();
    recordBatch(monitor, 100, 81);
    objective = objectiveAt(monitor.getSnapshot(), 0);
    assert.equal(objective.value, 0.81);
    assert.equal(objective.status, "at-risk");

    monitor.reset();
    recordBatch(monitor, 100, 80);
    objective = objectiveAt(monitor.getSnapshot(), 0);
    assert.equal(objective.value, 0.8);
    assert.equal(objective.status, "breached");
  });

  it("evaluates error-rate met, at-risk, and breached boundaries", () => {
    const monitor = createSloMonitor({
      objectives: [
        {
          id: "error-rate",
          metric: "error-rate",
          target: 0.1,
          windowSize: 100,
          warningMargin: 0.2,
        },
      ],
    });

    recordBatch(monitor, 100, 90);
    let objective = objectiveAt(monitor.getSnapshot(), 0);
    assert.equal(objective.value, 0.1);
    assert.equal(objective.status, "met");

    monitor.reset();
    recordBatch(monitor, 100, 89);
    objective = objectiveAt(monitor.getSnapshot(), 0);
    assert.equal(objective.value, 0.11);
    assert.equal(objective.status, "at-risk");

    monitor.reset();
    recordBatch(monitor, 100, 88);
    objective = objectiveAt(monitor.getSnapshot(), 0);
    assert.equal(objective.value, 0.12);
    assert.equal(objective.status, "at-risk");

    monitor.reset();
    recordBatch(monitor, 100, 87);
    objective = objectiveAt(monitor.getSnapshot(), 0);
    assert.equal(objective.value, 0.13);
    assert.equal(objective.status, "breached");
  });

  it("evaluates latency from the arithmetic mean including failed observations", () => {
    const monitor = createSloMonitor({
      objectives: [
        {
          id: "latency",
          metric: "latency",
          target: 100,
          windowSize: 10,
          warningMargin: 0.1,
        },
      ],
    });

    recordDurations(monitor, [100]);
    let objective = objectiveAt(monitor.getSnapshot(), 0);
    assert.equal(objective.value, 100);
    assert.equal(objective.status, "met");

    monitor.reset();
    recordDurations(monitor, [100, 110]);
    objective = objectiveAt(monitor.getSnapshot(), 0);
    assert.equal(objective.value, 105);
    assert.equal(objective.status, "at-risk");

    monitor.reset();
    recordDurations(monitor, [100, 120]);
    objective = objectiveAt(monitor.getSnapshot(), 0);
    assert.equal(objective.value, 110);
    assert.equal(objective.status, "at-risk");

    monitor.reset();
    recordDurations(monitor, [100, 122]);
    objective = objectiveAt(monitor.getSnapshot(), 0);
    assert.equal(objective.value, 111);
    assert.equal(objective.status, "breached");

    monitor.reset();
    monitor.record({ durationMs: 100, succeeded: true });
    monitor.record({ durationMs: 120, succeeded: false });
    objective = objectiveAt(monitor.getSnapshot(), 0);
    assert.equal(objective.sampleCount, 2);
    assert.equal(objective.value, 110);
    assert.equal(objective.status, "at-risk");
  });

  it("withholds values below minSamples", () => {
    const monitor = createSloMonitor({
      objectives: [
        {
          id: "availability",
          metric: "availability",
          target: 0.9,
          windowSize: 10,
          minSamples: 3,
        },
      ],
    });

    let objective = objectiveAt(monitor.getSnapshot(), 0);
    assert.equal(objective.sampleCount, 0);
    assert.equal(objective.value, null);
    assert.equal(objective.status, "insufficient-data");

    recordBatch(monitor, 2, 2);
    objective = objectiveAt(monitor.getSnapshot(), 0);
    assert.equal(objective.sampleCount, 2);
    assert.equal(objective.value, null);
    assert.equal(objective.status, "insufficient-data");

    recordBatch(monitor, 1, 1);
    objective = objectiveAt(monitor.getSnapshot(), 0);
    assert.equal(objective.sampleCount, 3);
    assert.equal(objective.value, 1);
    assert.equal(objective.status, "met");
  });

  it("does not round computed values", () => {
    const availability = createSloMonitor({
      objectives: [{ id: "availability", metric: "availability", target: 0.5, windowSize: 10 }],
    });
    recordBatch(availability, 3, 2);
    assert.equal(objectiveAt(availability.getSnapshot(), 0).value, 2 / 3);

    const errorRate = createSloMonitor({
      objectives: [{ id: "error-rate", metric: "error-rate", target: 0.5, windowSize: 10 }],
    });
    recordBatch(errorRate, 3, 2);
    assert.equal(objectiveAt(errorRate.getSnapshot(), 0).value, 1 / 3);

    const latency = createSloMonitor({
      objectives: [{ id: "latency", metric: "latency", target: 10, windowSize: 10 }],
    });
    recordDurations(latency, [1, 1, 2]);
    assert.equal(objectiveAt(latency.getSnapshot(), 0).value, 4 / 3);
  });
});

describe("SloMonitor rolling window and filtering", () => {
  it("evaluates only the newest windowSize observations", () => {
    const monitor = createSloMonitor({
      objectives: [{ id: "availability", metric: "availability", target: 0.5, windowSize: 3 }],
    });

    monitor.record({ durationMs: 1, succeeded: true });
    monitor.record({ durationMs: 1, succeeded: true });
    monitor.record({ durationMs: 1, succeeded: false });
    monitor.record({ durationMs: 1, succeeded: false });

    const snapshot = monitor.getSnapshot();
    assert.equal(snapshot.observationCount, 3);
    const objective = objectiveAt(snapshot, 0);
    assert.equal(objective.sampleCount, 3);
    assert.equal(objective.value, 1 / 3);
    assert.equal(objective.status, "breached");
  });

  it("keeps only the newest values when recording far beyond capacity", () => {
    const monitor = createSloMonitor({
      objectives: [
        { id: "short", metric: "availability", target: 0.5, windowSize: 3 },
        { id: "wide", metric: "latency", target: 1, windowSize: 8 },
      ],
    });

    for (let index = 0; index < 1000; index += 1) {
      monitor.record({ durationMs: index, succeeded: index >= 995 });
    }

    const snapshot = monitor.getSnapshot();
    assert.equal(snapshot.observationCount, 8);
    const short = objectiveAt(snapshot, 0);
    assert.equal(short.sampleCount, 3);
    assert.equal(short.value, 1);
    assert.equal(short.status, "met");
    const wide = objectiveAt(snapshot, 1);
    assert.equal(wide.sampleCount, 8);
    assert.equal(wide.value, 995.5);
    assert.equal(wide.status, "breached");
  });

  it("supports very large window sizes without eager allocation", () => {
    const monitor = createSloMonitor({
      objectives: [{ id: "huge", metric: "availability", target: 0.5, windowSize: 2 ** 32 }],
    });

    monitor.record({ durationMs: 1, succeeded: true });
    monitor.record({ durationMs: 1, succeeded: false });

    const snapshot = monitor.getSnapshot();
    assert.equal(snapshot.observationCount, 2);
    const objective = objectiveAt(snapshot, 0);
    assert.equal(objective.sampleCount, 2);
    assert.equal(objective.value, 0.5);
    assert.equal(objective.status, "met");
  });

  it("filters observations by canonical operation id", () => {
    const monitor = createSloMonitor({
      objectives: [
        { id: "op-a", metric: "availability", target: 1, operationId: "op-a" },
        { id: "all", metric: "availability", target: 0.5 },
        { id: "missing", metric: "error-rate", target: 0.5, operationId: "op-missing" },
      ],
    });

    monitor.record({ durationMs: 4, succeeded: true, operationId: " op-a " });
    monitor.record({ durationMs: 4, succeeded: true, operationId: "op-a" });
    monitor.record({ durationMs: 4, succeeded: false, operationId: "op-b" });
    monitor.record({ durationMs: 4, succeeded: false, operationId: "op-b" });

    const snapshot = monitor.getSnapshot();
    assert.equal(snapshot.observationCount, 4);

    const opA = objectiveAt(snapshot, 0);
    assert.equal(opA.sampleCount, 2);
    assert.equal(opA.value, 1);
    assert.equal(opA.status, "met");

    const all = objectiveAt(snapshot, 1);
    assert.equal(all.sampleCount, 4);
    assert.equal(all.value, 0.5);
    assert.equal(all.status, "met");

    const missing = objectiveAt(snapshot, 2);
    assert.equal(missing.sampleCount, 0);
    assert.equal(missing.value, null);
    assert.equal(missing.status, "insufficient-data");
  });
});

describe("SloMonitor snapshot behavior", () => {
  it("reset clears observations while preserving configuration", () => {
    const monitor = createSloMonitor({
      objectives: [{ id: "availability", metric: "availability", target: 0.5, windowSize: 5 }],
    });

    recordBatch(monitor, 3, 3);
    assert.equal(monitor.getSnapshot().observationCount, 3);

    monitor.reset();
    const snapshot = monitor.getSnapshot();
    assert.equal(snapshot.observationCount, 0);
    const objective = objectiveAt(snapshot, 0);
    assert.equal(objective.id, "availability");
    assert.equal(objective.metric, "availability");
    assert.equal(objective.target, 0.5);
    assert.equal(objective.sampleCount, 0);
    assert.equal(objective.value, null);
    assert.equal(objective.status, "insufficient-data");

    recordBatch(monitor, 1, 0);
    const afterReset = objectiveAt(monitor.getSnapshot(), 0);
    assert.equal(afterReset.value, 0);
    assert.equal(afterReset.status, "breached");
  });

  it("reports health without treating at-risk or insufficient as unhealthy", () => {
    const monitor = createSloMonitor({
      objectives: [
        { id: "z-latency", metric: "latency", target: 10, minSamples: 2 },
        {
          id: "a-availability",
          metric: "availability",
          target: 0.9,
          warningMargin: 0.1,
          windowSize: 100,
        },
      ],
    });

    let snapshot = monitor.getSnapshot();
    assert.deepEqual(
      snapshot.objectives.map((objective) => objective.id),
      ["z-latency", "a-availability"],
    );
    assert.equal(snapshot.healthy, true);

    recordBatch(monitor, 100, 85);
    snapshot = monitor.getSnapshot();
    assert.equal(objectiveAt(snapshot, 1).status, "at-risk");
    assert.equal(snapshot.healthy, true);

    monitor.reset();
    recordBatch(monitor, 100, 80);
    snapshot = monitor.getSnapshot();
    assert.equal(objectiveAt(snapshot, 1).status, "breached");
    assert.equal(snapshot.healthy, false);
  });

  it("returns frozen snapshots", () => {
    const monitor = createSloMonitor({ objectives: [availabilityObjective()] });
    monitor.record({ durationMs: 2, succeeded: true, at: 1 });

    const snapshot = monitor.getSnapshot();
    assert.ok(Object.isFrozen(snapshot));
    assert.ok(Object.isFrozen(snapshot.objectives));
    assert.ok(Object.isFrozen(objectiveAt(snapshot, 0)));

    assert.throws(() => {
      (snapshot as unknown as { healthy: boolean }).healthy = false;
    }, TypeError);
    assert.throws(() => {
      (objectiveAt(snapshot, 0) as unknown as { value: number | null }).value = 0;
    }, TypeError);
    assert.equal(monitor.getSnapshot().healthy, true);
  });
});

describe("attachSloMonitor", () => {
  it("records real runtime success and error events until unsubscribe", async () => {
    const clock = new FakeClock();
    const runtime = createAdaptiveRuntime({
      clock,
      policy: { evaluationIntervalMs: 0 },
    });
    const strategy: Strategy<number, string> = {
      id: "primary",
      qualityTier: 1,
      run: ({ input }) => {
        clock.advance(25);
        if (input < 0) {
          throw new Error(`negative input: ${input}`);
        }
        return `value:${input}`;
      },
    };
    const monitor = createSloMonitor({
      objectives: [
        {
          id: "availability",
          metric: "availability",
          target: 0.5,
          windowSize: 10,
        },
        { id: "error-rate", metric: "error-rate", target: 0.5, windowSize: 10 },
        { id: "latency", metric: "latency", target: 25, windowSize: 10 },
      ],
    });

    const unsubscribe = attachSloMonitor(runtime, monitor);

    await runtime.run({ operationId: "attached-op", input: 1, strategies: [strategy] });
    await assert.rejects(
      () => runtime.run({ operationId: "attached-op", input: -1, strategies: [strategy] }),
      /negative input: -1/,
    );

    let snapshot = monitor.getSnapshot();
    assert.equal(snapshot.observationCount, 2);
    const availability = objectiveAt(snapshot, 0);
    assert.equal(availability.sampleCount, 2);
    assert.equal(availability.value, 0.5);
    assert.equal(availability.status, "met");
    const errorRate = objectiveAt(snapshot, 1);
    assert.equal(errorRate.sampleCount, 2);
    assert.equal(errorRate.value, 0.5);
    assert.equal(errorRate.status, "met");
    const latency = objectiveAt(snapshot, 2);
    assert.equal(latency.sampleCount, 2);
    assert.equal(latency.value, 25);
    assert.equal(latency.status, "met");

    unsubscribe();
    unsubscribe();

    await runtime.run({ operationId: "attached-op", input: 2, strategies: [strategy] });
    await assert.rejects(
      () => runtime.run({ operationId: "attached-op", input: -2, strategies: [strategy] }),
      /negative input: -2/,
    );

    snapshot = monitor.getSnapshot();
    assert.equal(snapshot.observationCount, 2);
    assert.equal(objectiveAt(snapshot, 0).sampleCount, 2);
    assert.equal(objectiveAt(snapshot, 1).sampleCount, 2);
    assert.equal(objectiveAt(snapshot, 2).sampleCount, 2);

    await runtime.close();
  });

  it("attaches to a closed runtime without throwing", async () => {
    const runtime = createAdaptiveRuntime();
    await runtime.close();

    const monitor = createSloMonitor({
      objectives: [{ id: "availability", metric: "availability", target: 0.5 }],
    });
    let unsubscribe: (() => void) | undefined;
    assert.doesNotThrow(() => {
      unsubscribe = attachSloMonitor(runtime, monitor);
    });
    assert.equal(monitor.getSnapshot().observationCount, 0);
    assert.equal(objectiveAt(monitor.getSnapshot(), 0).status, "insufficient-data");
    unsubscribe?.();
    unsubscribe?.();
  });

  it("rejects attachments that do not expose the required methods", () => {
    const monitor = createSloMonitor({ objectives: [availabilityObjective()] });
    assert.throws(() => attachSloMonitor(cast<AdaptiveRuntime>({ on: 42 }), monitor), TypeError);
    const runtime = createAdaptiveRuntime();
    assert.throws(() => attachSloMonitor(runtime, cast<SloMonitor>({ record: 42 })), TypeError);
    void runtime.close();
  });
});
