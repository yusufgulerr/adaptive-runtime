import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createEdgeExecutionBudgetProvider,
  EDGE_CONCURRENCY_SATURATION,
  EDGE_EXECUTION_REMAINING_MS,
  EDGE_EXECUTION_USED_RATIO,
  type EdgeBudgetSnapshot,
  EdgeExecutionBudgetProvider,
  ExecutionBudgetProvider,
} from "../../src/edge.js";
import { ConfigurationError } from "../../src/errors/index.js";
import { createFakeClock } from "../../src/testing/index.js";
import type { AvailableSignalReading, UnavailableSignalReading } from "../../src/types/signals.js";

const NOW = 2_000_000;
const signal = new AbortController().signal;

describe("ExecutionBudgetProvider", () => {
  it("initializes with default id and signal descriptors", () => {
    const provider = new ExecutionBudgetProvider({
      getBudgetSnapshot: () => ({}),
    });
    assert.equal(provider.id, "edge-execution-budget");
    assert.deepEqual(
      provider.signals.map((s) => [s.name, s.unit]),
      [
        [EDGE_EXECUTION_REMAINING_MS, "milliseconds"],
        [EDGE_EXECUTION_USED_RATIO, "ratio"],
        [EDGE_CONCURRENCY_SATURATION, "ratio"],
      ],
    );
  });

  it("validates constructor options thoroughly", () => {
    // null or non-object options
    assert.throws(
      // @ts-expect-error invalid options
      () => new ExecutionBudgetProvider(null),
      ConfigurationError,
    );
    assert.throws(
      // @ts-expect-error invalid options
      () => new ExecutionBudgetProvider("options"),
      ConfigurationError,
    );

    // invalid id
    assert.throws(
      // @ts-expect-error invalid id
      () => new ExecutionBudgetProvider({ id: 123, getBudgetSnapshot: () => ({}) }),
      ConfigurationError,
    );
    assert.throws(
      () => new ExecutionBudgetProvider({ id: "", getBudgetSnapshot: () => ({}) }),
      ConfigurationError,
    );
    assert.throws(
      () => new ExecutionBudgetProvider({ id: "   ", getBudgetSnapshot: () => ({}) }),
      ConfigurationError,
    );
    assert.throws(
      () => new ExecutionBudgetProvider({ id: " edge-budget ", getBudgetSnapshot: () => ({}) }),
      ConfigurationError,
    );

    // getBudgetSnapshot not a function
    assert.throws(
      // @ts-expect-error invalid getBudgetSnapshot
      () => new ExecutionBudgetProvider({ getBudgetSnapshot: undefined }),
      ConfigurationError,
    );
    assert.throws(
      // @ts-expect-error invalid getBudgetSnapshot
      () => new ExecutionBudgetProvider({ getBudgetSnapshot: "not-a-func" }),
      ConfigurationError,
    );
  });

  it("accepts custom valid id and passes context to getBudgetSnapshot", async () => {
    let capturedNow = 0;
    let capturedSignal: AbortSignal | undefined;

    const provider = new ExecutionBudgetProvider({
      id: "custom-edge-budget",
      getBudgetSnapshot: (context) => {
        capturedNow = context.now;
        capturedSignal = context.signal;
        return {
          totalBudgetMs: 50,
          elapsedMs: 20,
          activeRequests: 10,
          maxConcurrency: 100,
        };
      },
    });

    assert.equal(provider.id, "custom-edge-budget");
    const readings = await provider.read({ now: NOW, signal });
    assert.equal(capturedNow, NOW);
    assert.equal(capturedSignal, signal);
    assert.equal(readings.length, 3);

    const remaining = readings[0] as AvailableSignalReading;
    assert.equal(remaining.name, EDGE_EXECUTION_REMAINING_MS);
    assert.equal(remaining.status, "ok");
    assert.equal(remaining.value, 30); // 50 - 20
    assert.equal(remaining.unit, "milliseconds");
    assert.equal(remaining.confidence, 1);
    assert.equal(remaining.observedAt, NOW);
    assert.deepEqual(remaining.details, {
      totalBudgetMs: 50,
      elapsedMs: 20,
      remainingMs: 30,
    });

    const usedRatio = readings[1] as AvailableSignalReading;
    assert.equal(usedRatio.name, EDGE_EXECUTION_USED_RATIO);
    assert.equal(usedRatio.status, "ok");
    assert.equal(usedRatio.value, 0.4); // 20 / 50
    assert.equal(usedRatio.unit, "ratio");
    assert.deepEqual(usedRatio.details, {
      totalBudgetMs: 50,
      elapsedMs: 20,
      usedRatio: 0.4,
    });

    const saturation = readings[2] as AvailableSignalReading;
    assert.equal(saturation.name, EDGE_CONCURRENCY_SATURATION);
    assert.equal(saturation.status, "ok");
    assert.equal(saturation.value, 0.1); // 10 / 100
    assert.equal(saturation.unit, "ratio");
    assert.deepEqual(saturation.details, {
      activeRequests: 10,
      maxConcurrency: 100,
      saturation: 0.1,
    });
  });

  it("handles async Promise resolution for getBudgetSnapshot", async () => {
    const provider = new ExecutionBudgetProvider({
      getBudgetSnapshot: async () => {
        return Promise.resolve({
          totalBudgetMs: 100,
          elapsedMs: 50,
          activeRequests: 25,
          maxConcurrency: 50,
        });
      },
    });

    const readings = await provider.read({ now: NOW, signal });
    assert.equal(readings[0]?.status, "ok");
    assert.equal((readings[0] as AvailableSignalReading).value, 50);
    assert.equal((readings[1] as AvailableSignalReading).value, 0.5);
    assert.equal((readings[2] as AvailableSignalReading).value, 0.5);
  });

  it("clamps remainingMs to 0 and allows usedRatio > 1 when overdue", async () => {
    const provider = new ExecutionBudgetProvider({
      getBudgetSnapshot: () => ({
        totalBudgetMs: 50,
        elapsedMs: 75, // 25ms over deadline
      }),
    });

    const readings = await provider.read({ now: NOW, signal });
    const remaining = readings[0] as AvailableSignalReading;
    assert.equal(remaining.status, "ok");
    assert.equal(remaining.value, 0); // clamped to 0

    const usedRatio = readings[1] as AvailableSignalReading;
    assert.equal(usedRatio.status, "ok");
    assert.equal(usedRatio.value, 1.5); // 75 / 50 = 1.5
  });

  it("reports unknown when timing metrics are missing or invalid", async () => {
    // Missing totalBudgetMs
    const noTotalProvider = new ExecutionBudgetProvider({
      getBudgetSnapshot: () => ({ elapsedMs: 10 }),
    });
    const r1 = await noTotalProvider.read({ now: NOW, signal });
    assert.equal(r1[0]?.status, "unknown");
    assert.equal(r1[1]?.status, "unknown");

    // Invalid totalBudgetMs <= 0 or NaN
    const zeroTotalProvider = new ExecutionBudgetProvider({
      getBudgetSnapshot: () => ({ totalBudgetMs: 0, elapsedMs: 10 }),
    });
    const r2 = await zeroTotalProvider.read({ now: NOW, signal });
    assert.equal(r2[0]?.status, "unknown");
    assert.equal(r2[1]?.status, "unknown");

    const nanTotalProvider = new ExecutionBudgetProvider({
      getBudgetSnapshot: () => ({ totalBudgetMs: Number.NaN, elapsedMs: 10 }),
    });
    const r3 = await nanTotalProvider.read({ now: NOW, signal });
    assert.equal(r3[0]?.status, "unknown");

    // Missing or invalid elapsedMs
    const noElapsedProvider = new ExecutionBudgetProvider({
      getBudgetSnapshot: () => ({ totalBudgetMs: 100 }),
    });
    const r4 = await noElapsedProvider.read({ now: NOW, signal });
    assert.equal(r4[0]?.status, "unknown");

    const negElapsedProvider = new ExecutionBudgetProvider({
      getBudgetSnapshot: () => ({ totalBudgetMs: 100, elapsedMs: -5 }),
    });
    const r5 = await negElapsedProvider.read({ now: NOW, signal });
    assert.equal(r5[0]?.status, "unknown");

    const nanElapsedProvider = new ExecutionBudgetProvider({
      getBudgetSnapshot: () => ({ totalBudgetMs: 100, elapsedMs: Number.NaN }),
    });
    const r6 = await nanElapsedProvider.read({ now: NOW, signal });
    assert.equal(r6[0]?.status, "unknown");
  });

  it("reports unknown when concurrency metrics are missing or invalid", async () => {
    // Missing activeRequests or maxConcurrency
    const missingProvider = new ExecutionBudgetProvider({
      getBudgetSnapshot: () => ({ activeRequests: 10 }),
    });
    const r1 = await missingProvider.read({ now: NOW, signal });
    assert.equal(r1[2]?.status, "unknown");

    // Invalid maxConcurrency <= 0
    const zeroMaxProvider = new ExecutionBudgetProvider({
      getBudgetSnapshot: () => ({ activeRequests: 10, maxConcurrency: 0 }),
    });
    const r2 = await zeroMaxProvider.read({ now: NOW, signal });
    assert.equal(r2[2]?.status, "unknown");

    // Negative activeRequests
    const negActiveProvider = new ExecutionBudgetProvider({
      getBudgetSnapshot: () => ({ activeRequests: -1, maxConcurrency: 10 }),
    });
    const r3 = await negActiveProvider.read({ now: NOW, signal });
    assert.equal(r3[2]?.status, "unknown");

    // NaN activeRequests or maxConcurrency
    const nanProvider = new ExecutionBudgetProvider({
      getBudgetSnapshot: () => ({ activeRequests: Number.NaN, maxConcurrency: 10 }),
    });
    const r4 = await nanProvider.read({ now: NOW, signal });
    assert.equal(r4[2]?.status, "unknown");
  });

  it("handles getBudgetSnapshot throwing Error or non-Error", async () => {
    const errProvider = new ExecutionBudgetProvider({
      getBudgetSnapshot: () => {
        throw new Error("cloud worker context timeout");
      },
    });
    const errReadings = await errProvider.read({ now: NOW, signal });
    assert.equal(errReadings.length, 3);
    for (const r of errReadings) {
      assert.equal(r.status, "error");
      assert.ok((r as UnavailableSignalReading).error?.includes("cloud worker context timeout"));
    }

    const nonErrProvider = new ExecutionBudgetProvider({
      getBudgetSnapshot: () => {
        throw "rejected snapshot promise";
      },
    });
    const nonErrReadings = await nonErrProvider.read({ now: NOW, signal });
    assert.equal(nonErrReadings[0]?.status, "error");
    assert.ok(
      (nonErrReadings[0] as UnavailableSignalReading).error?.includes("rejected snapshot promise"),
    );
  });

  it("handles null or non-object snapshot returns", async () => {
    const nullProvider = new ExecutionBudgetProvider({
      // @ts-expect-error invalid return
      getBudgetSnapshot: () => null,
    });
    const r1 = await nullProvider.read({ now: NOW, signal });
    assert.equal(r1.length, 3);
    for (const r of r1) {
      assert.equal(r.status, "unknown");
    }

    const primitiveProvider = new ExecutionBudgetProvider({
      // @ts-expect-error invalid return
      getBudgetSnapshot: () => "invalid-snapshot",
    });
    const r2 = await primitiveProvider.read({ now: NOW, signal });
    for (const r of r2) {
      assert.equal(r.status, "unknown");
    }
  });

  it("handles provider close() lifecycle", async () => {
    const provider = new ExecutionBudgetProvider({
      getBudgetSnapshot: () => ({ totalBudgetMs: 50, elapsedMs: 10 }),
    });
    provider.close();

    const readings = await provider.read({ now: NOW, signal });
    assert.equal(readings.length, 3);
    for (const r of readings) {
      assert.equal(r.status, "unsupported");
      assert.equal((r as UnavailableSignalReading).error, "Provider is closed.");
    }
  });

  it("handles throwing property getters on execution budget snapshot", async () => {
    const throwingSnapshotProvider = new ExecutionBudgetProvider({
      getBudgetSnapshot: () => ({
        get totalBudgetMs(): number {
          throw new Error("SecurityError: totalBudgetMs access denied");
        },
      }),
    });
    const readings = await throwingSnapshotProvider.read({ now: NOW, signal });
    assert.equal(readings.length, 3);
    for (const r of readings) {
      assert.equal(r.status, "error");
      assert.ok(
        (r as UnavailableSignalReading).error?.includes(
          "SecurityError: totalBudgetMs access denied",
        ),
      );
    }
  });

  describe("headroom reserves and validation", () => {
    it("validates wallClockBudgetMs, cpuBudgetMs, and reserve options strictly", () => {
      // wallClockBudgetMs validation
      assert.throws(
        // @ts-expect-error invalid wallClockBudgetMs
        () => new EdgeExecutionBudgetProvider({ wallClockBudgetMs: "100" }),
        ConfigurationError,
      );
      assert.throws(
        () => new EdgeExecutionBudgetProvider({ wallClockBudgetMs: 0 }),
        ConfigurationError,
      );
      assert.throws(
        () => new EdgeExecutionBudgetProvider({ wallClockBudgetMs: -10 }),
        ConfigurationError,
      );
      assert.throws(
        () => new EdgeExecutionBudgetProvider({ wallClockBudgetMs: Number.NaN }),
        ConfigurationError,
      );
      assert.throws(
        () => new EdgeExecutionBudgetProvider({ wallClockBudgetMs: Number.POSITIVE_INFINITY }),
        ConfigurationError,
      );

      // cpuBudgetMs validation
      assert.throws(
        // @ts-expect-error invalid cpuBudgetMs
        () => new EdgeExecutionBudgetProvider({ wallClockBudgetMs: 100, cpuBudgetMs: "50" }),
        ConfigurationError,
      );
      assert.throws(
        () => new EdgeExecutionBudgetProvider({ wallClockBudgetMs: 100, cpuBudgetMs: 0 }),
        ConfigurationError,
      );
      assert.throws(
        () => new EdgeExecutionBudgetProvider({ wallClockBudgetMs: 100, cpuBudgetMs: -5 }),
        ConfigurationError,
      );
      assert.throws(
        () => new EdgeExecutionBudgetProvider({ wallClockBudgetMs: 100, cpuBudgetMs: Number.NaN }),
        ConfigurationError,
      );

      // reserveWallClockMs validation
      assert.throws(
        // @ts-expect-error invalid reserveWallClockMs
        () => new EdgeExecutionBudgetProvider({ wallClockBudgetMs: 100, reserveWallClockMs: "10" }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          new EdgeExecutionBudgetProvider({
            wallClockBudgetMs: 100,
            reserveWallClockMs: Number.NaN,
          }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          new EdgeExecutionBudgetProvider({
            wallClockBudgetMs: 100,
            reserveWallClockMs: Number.POSITIVE_INFINITY,
          }),
        ConfigurationError,
      );
      assert.throws(
        () => new EdgeExecutionBudgetProvider({ wallClockBudgetMs: 100, reserveWallClockMs: -5 }),
        ConfigurationError,
      );
      // reserve >= budget
      assert.throws(
        () => new EdgeExecutionBudgetProvider({ wallClockBudgetMs: 100, reserveWallClockMs: 100 }),
        ConfigurationError,
      );
      assert.throws(
        () => new EdgeExecutionBudgetProvider({ wallClockBudgetMs: 100, reserveWallClockMs: 150 }),
        ConfigurationError,
      );
      // reserve without wallClockBudgetMs
      assert.throws(
        // @ts-expect-error missing budget
        () => new EdgeExecutionBudgetProvider({ reserveWallClockMs: 10 }),
        ConfigurationError,
      );

      // reserveCpuMs validation
      assert.throws(
        () =>
          new EdgeExecutionBudgetProvider({
            wallClockBudgetMs: 100,
            cpuBudgetMs: 50,
            // @ts-expect-error invalid reserveCpuMs
            reserveCpuMs: "10",
          }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          new EdgeExecutionBudgetProvider({
            wallClockBudgetMs: 100,
            cpuBudgetMs: 50,
            reserveCpuMs: Number.NaN,
          }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          new EdgeExecutionBudgetProvider({
            wallClockBudgetMs: 100,
            cpuBudgetMs: 50,
            reserveCpuMs: -1,
          }),
        ConfigurationError,
      );
      // reserveCpuMs without cpuBudgetMs
      assert.throws(
        () => new EdgeExecutionBudgetProvider({ wallClockBudgetMs: 100, reserveCpuMs: 10 }),
        ConfigurationError,
      );
      // reserve >= cpuBudgetMs
      assert.throws(
        () =>
          new EdgeExecutionBudgetProvider({
            wallClockBudgetMs: 100,
            cpuBudgetMs: 50,
            reserveCpuMs: 50,
          }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          new EdgeExecutionBudgetProvider({
            wallClockBudgetMs: 100,
            cpuBudgetMs: 50,
            reserveCpuMs: 60,
          }),
        ConfigurationError,
      );

      // maxSubrequests validation
      assert.throws(
        () =>
          new EdgeExecutionBudgetProvider({
            wallClockBudgetMs: 100,
            // @ts-expect-error invalid maxSubrequests
            maxSubrequests: "5",
          }),
        ConfigurationError,
      );
      assert.throws(
        () => new EdgeExecutionBudgetProvider({ wallClockBudgetMs: 100, maxSubrequests: -1 }),
        ConfigurationError,
      );
      assert.throws(
        () => new EdgeExecutionBudgetProvider({ wallClockBudgetMs: 100, maxSubrequests: 3.5 }),
        ConfigurationError,
      );

      // clock validation
      assert.throws(
        () =>
          new EdgeExecutionBudgetProvider({
            wallClockBudgetMs: 100,
            // @ts-expect-error invalid clock
            clock: "not-a-clock",
          }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          new EdgeExecutionBudgetProvider({
            wallClockBudgetMs: 100,
            // @ts-expect-error invalid clock
            clock: {},
          }),
        ConfigurationError,
      );
    });

    it("validates recording methods and lifecycle boundaries", () => {
      const provider = new EdgeExecutionBudgetProvider({ wallClockBudgetMs: 100 });

      // Subrequests
      assert.throws(
        // @ts-expect-error invalid count
        () => provider.recordSubrequest("one"),
        ConfigurationError,
      );
      assert.throws(() => provider.recordSubrequest(0), ConfigurationError);
      assert.throws(() => provider.recordSubrequest(-1), ConfigurationError);
      assert.throws(() => provider.recordSubrequest(1.5), ConfigurationError);

      // Payload bytes
      assert.throws(
        // @ts-expect-error invalid bytes
        () => provider.recordPayloadBytes("1024"),
        ConfigurationError,
      );
      assert.throws(() => provider.recordPayloadBytes(-10), ConfigurationError);
      assert.throws(() => provider.recordPayloadBytes(Number.NaN), ConfigurationError);

      // CPU time
      assert.throws(
        // @ts-expect-error invalid cpu time
        () => provider.recordCpuTime("5ms"),
        ConfigurationError,
      );
      assert.throws(() => provider.recordCpuTime(-5), ConfigurationError);
      assert.throws(() => provider.recordCpuTime(Number.NaN), ConfigurationError);

      provider.close();

      assert.throws(() => provider.recordSubrequest(1), ConfigurationError);
      assert.throws(() => provider.recordSubrequests(1), ConfigurationError);
      assert.throws(() => provider.recordPayloadBytes(100), ConfigurationError);
      assert.throws(() => provider.recordCpuTime(10), ConfigurationError);
      assert.throws(() => provider.recordCpuMs(10), ConfigurationError);
      assert.throws(() => provider.resetWindow(), ConfigurationError);
    });
  });

  describe("reserveWallClockMs headroom & dynamic wall-clock controls", () => {
    it("subtracts reserve headroom from remaining budget and inflates utilization proportionally", async () => {
      const fakeClock = createFakeClock(1_000_000);
      const provider = createEdgeExecutionBudgetProvider({
        wallClockBudgetMs: 100,
        reserveWallClockMs: 20,
        clock: fakeClock,
      });

      // t = 0: elapsed = 0
      // effectiveBudget = 100 - 20 = 80
      // remaining = Math.max(0, 100 - 0 - 20) = 80
      // usedRatio = 0 / 80 = 0
      let readings = await provider.read({ now: fakeClock.now(), signal });
      let remaining = readings[0] as AvailableSignalReading;
      let usedRatio = readings[1] as AvailableSignalReading;
      assert.equal(remaining.value, 80);
      assert.equal(usedRatio.value, 0);
      assert.deepEqual(remaining.details, {
        totalBudgetMs: 100,
        elapsedMs: 0,
        remainingMs: 80,
        reserveWallClockMs: 20,
      });

      // t = 40ms: elapsed = 40
      // remaining = Math.max(0, 60 - 20) = 40
      // usedRatio = 40 / 80 = 0.5 (instead of 40 / 100 = 0.4)
      fakeClock.advance(40);
      readings = await provider.read({ now: fakeClock.now(), signal });
      remaining = readings[0] as AvailableSignalReading;
      usedRatio = readings[1] as AvailableSignalReading;
      assert.equal(remaining.value, 40);
      assert.equal(usedRatio.value, 0.5);

      // t = 80ms: elapsed = 80 (hits reserve headroom boundary!)
      // remaining = Math.max(0, 20 - 20) = 0
      // usedRatio = 80 / 80 = 1.0 (degrades BEFORE hard worker termination at 100ms)
      fakeClock.advance(40);
      readings = await provider.read({ now: fakeClock.now(), signal });
      remaining = readings[0] as AvailableSignalReading;
      usedRatio = readings[1] as AvailableSignalReading;
      assert.equal(remaining.value, 0);
      assert.equal(usedRatio.value, 1.0);

      // t = 90ms: elapsed = 90 (into reserve headroom)
      // remaining = Math.max(0, 10 - 20) = 0 (clamped)
      // usedRatio = 90 / 80 = 1.125
      fakeClock.advance(10);
      readings = await provider.read({ now: fakeClock.now(), signal });
      remaining = readings[0] as AvailableSignalReading;
      usedRatio = readings[1] as AvailableSignalReading;
      assert.equal(remaining.value, 0);
      assert.equal(usedRatio.value, 1.125);
    });

    it("applies reserveWallClockMs to dynamic getBudgetSnapshot mode", async () => {
      const provider = new ExecutionBudgetProvider({
        reserveWallClockMs: 25,
        wallClockBudgetMs: 100,
        getBudgetSnapshot: () => ({
          totalBudgetMs: 100,
          elapsedMs: 50,
          activeRequests: 2,
          maxConcurrency: 10,
        }),
      });

      const readings = await provider.read({ now: NOW, signal });
      const remaining = readings[0] as AvailableSignalReading;
      const usedRatio = readings[1] as AvailableSignalReading;

      // remaining: Math.max(0, (100 - 50) - 25) = 25
      assert.equal(remaining.value, 25);
      // usedRatio: 50 / (100 - 25) = 50 / 75 = 2/3
      assert.equal(usedRatio.value, 50 / 75);
      assert.deepEqual(remaining.details, {
        totalBudgetMs: 100,
        elapsedMs: 50,
        remainingMs: 25,
        reserveWallClockMs: 25,
      });
    });
  });

  describe("reserveCpuMs dynamic headroom & CPU budget controls", () => {
    it("constrains remaining execution time and inflates utilization when CPU budget is tighter", async () => {
      const fakeClock = createFakeClock(1_000_000);
      const provider = new EdgeExecutionBudgetProvider({
        wallClockBudgetMs: 10_000,
        cpuBudgetMs: 50,
        reserveCpuMs: 10,
        clock: fakeClock,
      });

      // Initially at t=100ms wall-clock, 0ms CPU recorded:
      // Wall: remaining = 9900ms, usedRatio = 0.01
      // CPU: remaining = Math.max(0, 50 - 0 - 10) = 40ms, usedRatio = 0
      // Remaining deadline is constrained by CPU = 40ms!
      fakeClock.advance(100);
      let readings = await provider.read({ now: fakeClock.now(), signal });
      let remaining = readings[0] as AvailableSignalReading;
      let usedRatio = readings[1] as AvailableSignalReading;
      assert.equal(remaining.value, 40);
      assert.equal(usedRatio.value, 0.01);
      assert.deepEqual(remaining.details, {
        totalBudgetMs: 10_000,
        elapsedMs: 100,
        remainingMs: 40,
        cpuBudgetMs: 50,
        cpuElapsedMs: 0,
        reserveCpuMs: 10,
      });

      // Record 30ms of CPU execution:
      // CPU elapsed = 30ms.
      // CPU remaining = Math.max(0, (50 - 30) - 10) = 10ms.
      // CPU usedRatio = 30 / (50 - 10) = 30 / 40 = 0.75 (75% CPU budget consumed).
      // Wall clock elapsed = 200ms -> wall used = 0.02.
      // Final remaining = min(9800, 10) = 10ms.
      // Final usedRatio = max(0.02, 0.75) = 0.75.
      fakeClock.advance(100);
      provider.recordCpuTime(30);
      readings = await provider.read({ now: fakeClock.now(), signal });
      remaining = readings[0] as AvailableSignalReading;
      usedRatio = readings[1] as AvailableSignalReading;
      assert.equal(remaining.value, 10);
      assert.equal(usedRatio.value, 0.75);

      // Record 10ms more via recordCpuMs:
      // CPU elapsed = 40ms (hits CPU reserve headroom!).
      // CPU remaining = Math.max(0, (50 - 40) - 10) = 0ms.
      // CPU usedRatio = 40 / 40 = 1.0.
      provider.recordCpuMs(10);
      readings = await provider.read({ now: fakeClock.now(), signal });
      remaining = readings[0] as AvailableSignalReading;
      usedRatio = readings[1] as AvailableSignalReading;
      assert.equal(remaining.value, 0);
      assert.equal(usedRatio.value, 1.0);

      // Record 5ms more CPU time (exceeding effective CPU budget):
      provider.recordCpuTime(5);
      readings = await provider.read({ now: fakeClock.now(), signal });
      remaining = readings[0] as AvailableSignalReading;
      usedRatio = readings[1] as AvailableSignalReading;
      assert.equal(remaining.value, 0);
      assert.equal(usedRatio.value, 45 / 40); // 1.125
    });

    it("accepts cpuElapsedMs via dynamic getBudgetSnapshot mode", async () => {
      const provider = new EdgeExecutionBudgetProvider({
        wallClockBudgetMs: 10_000,
        cpuBudgetMs: 100,
        reserveCpuMs: 20,
        getBudgetSnapshot: () => ({
          totalBudgetMs: 10_000,
          elapsedMs: 200,
          cpuElapsedMs: 80,
        }),
      });

      const readings = await provider.read({ now: NOW, signal });
      const remaining = readings[0] as AvailableSignalReading;
      const usedRatio = readings[1] as AvailableSignalReading;

      // cpu remaining: Math.max(0, (100 - 80) - 20) = 0
      // cpu used: 80 / (100 - 20) = 1.0
      assert.equal(remaining.value, 0);
      assert.equal(usedRatio.value, 1.0);
    });
  });

  describe("getBudgetSnapshot() runtime inspection", () => {
    it("returns a frozen snapshot with accurate timing and subrequest metrics", () => {
      const fakeClock = createFakeClock(2_000_000);
      const provider = new EdgeExecutionBudgetProvider({
        wallClockBudgetMs: 500,
        reserveWallClockMs: 100,
        maxSubrequests: 50,
        clock: fakeClock,
      });

      // t = 0
      let snapshot = provider.getBudgetSnapshot();
      assert.ok(Object.isFrozen(snapshot), "Snapshot must be frozen");
      assert.deepEqual(snapshot, {
        elapsedWallClockMs: 0,
        remainingWallClockMs: 400, // (500 - 0) - 100
        wallClockUtilizationRatio: 0,
        recordedSubrequests: 0,
        remainingSubrequests: 50,
        payloadBytes: null,
      });

      // Attempting to modify frozen snapshot in strict mode must throw
      assert.throws(() => {
        // @ts-expect-error mutating readonly property
        snapshot.elapsedWallClockMs = 999;
      }, TypeError);

      // Progress clock and record activities
      fakeClock.advance(200);
      provider.recordSubrequest(); // default 1
      provider.recordSubrequests(4); // 4 more -> 5 total
      provider.recordPayloadBytes(4096);

      snapshot = provider.getBudgetSnapshot();
      assert.equal(snapshot.elapsedWallClockMs, 200);
      assert.equal(snapshot.remainingWallClockMs, 200); // (500 - 200) - 100
      assert.equal(snapshot.wallClockUtilizationRatio, 0.5); // 200 / 400
      assert.equal(snapshot.recordedSubrequests, 5);
      assert.equal(snapshot.remainingSubrequests, 45); // 50 - 5
      assert.equal(snapshot.payloadBytes, 4096);

      // Clamping of remainingSubrequests to 0
      provider.recordSubrequests(50);
      snapshot = provider.getBudgetSnapshot();
      assert.equal(snapshot.recordedSubrequests, 55);
      assert.equal(snapshot.remainingSubrequests, 0); // clamped to 0

      // When maxSubrequests is not configured, remainingSubrequests is null
      const unconstrainedProvider = new EdgeExecutionBudgetProvider({
        wallClockBudgetMs: 200,
      });
      const unconstrainedSnapshot = unconstrainedProvider.getBudgetSnapshot();
      assert.equal(unconstrainedSnapshot.remainingSubrequests, null);
      assert.equal(unconstrainedSnapshot.payloadBytes, null);

      // When neither wallClockBudgetMs nor snapshot is available yet
      const lazyProvider = new EdgeExecutionBudgetProvider({
        getBudgetSnapshot: () => ({}),
      });
      const lazySnapshot = lazyProvider.getBudgetSnapshot();
      assert.equal(lazySnapshot.remainingWallClockMs, 0);
      assert.equal(lazySnapshot.wallClockUtilizationRatio, 0);
    });
  });

  describe("resetWindow() isolate reuse", () => {
    it("resets window start time, subrequests, payload bytes, and CPU time across simulated requests", async () => {
      const fakeClock = createFakeClock(10_000_000);
      const provider = new EdgeExecutionBudgetProvider({
        wallClockBudgetMs: 1_000,
        reserveWallClockMs: 200,
        cpuBudgetMs: 50,
        reserveCpuMs: 10,
        maxSubrequests: 20,
        clock: fakeClock,
      });

      // === REQUEST 1 ===
      fakeClock.advance(300);
      provider.recordSubrequest(3);
      provider.recordPayloadBytes(8192);
      provider.recordCpuTime(20);

      const snap1: EdgeBudgetSnapshot = provider.getBudgetSnapshot();
      assert.equal(snap1.elapsedWallClockMs, 300);
      assert.equal(snap1.remainingWallClockMs, 500); // 1000 - 300 - 200 = 500
      assert.equal(snap1.wallClockUtilizationRatio, 300 / 800);
      assert.equal(snap1.recordedSubrequests, 3);
      assert.equal(snap1.remainingSubrequests, 17);
      assert.equal(snap1.payloadBytes, 8192);

      const readings1 = await provider.read({ now: fakeClock.now(), signal });
      const cpuRemaining1 = (readings1[0] as AvailableSignalReading).value;
      assert.equal(cpuRemaining1, 20); // CPU remaining: 50 - 20 - 10 = 20

      // === RESET WINDOW FOR WARM ISOLATE REUSE ===
      fakeClock.advance(50); // 50ms idle time between requests
      provider.resetWindow();

      // Immediately after reset:
      const snap2 = provider.getBudgetSnapshot();
      assert.equal(snap2.elapsedWallClockMs, 0);
      assert.equal(snap2.remainingWallClockMs, 800); // 1000 - 0 - 200 = 800
      assert.equal(snap2.wallClockUtilizationRatio, 0);
      assert.equal(snap2.recordedSubrequests, 0);
      assert.equal(snap2.remainingSubrequests, 20);
      assert.equal(snap2.payloadBytes, null);

      // === REQUEST 2 ===
      fakeClock.advance(100);
      provider.recordSubrequest(1);
      provider.recordPayloadBytes(1024);
      provider.recordCpuTime(10);

      const snap3 = provider.getBudgetSnapshot();
      assert.equal(snap3.elapsedWallClockMs, 100);
      assert.equal(snap3.remainingWallClockMs, 700); // 1000 - 100 - 200 = 700
      assert.equal(snap3.recordedSubrequests, 1);
      assert.equal(snap3.remainingSubrequests, 19);
      assert.equal(snap3.payloadBytes, 1024);

      const readings2 = await provider.read({ now: fakeClock.now(), signal });
      const cpuRemaining2 = (readings2[0] as AvailableSignalReading).value;
      assert.equal(cpuRemaining2, 30); // CPU remaining: 50 - 10 - 10 = 30 (Request 1 CPU cleared!)
    });
  });
});
