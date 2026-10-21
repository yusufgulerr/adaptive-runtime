import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigurationError } from "../../src/errors/index.js";
import {
  EDGE_CONCURRENCY_SATURATION,
  EDGE_EXECUTION_REMAINING_MS,
  EDGE_EXECUTION_USED_RATIO,
  ExecutionBudgetProvider,
} from "../../src/providers/edge/execution-budget.js";
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
});
