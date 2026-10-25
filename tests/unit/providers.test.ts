import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigurationError } from "../../src/errors/index.js";
import type {
  CpuUtilizationStats,
  NetworkLatencyStats,
  ProcessMemoryStats,
} from "../../src/node.js";
import {
  CpuUtilizationProvider,
  type CpuUtilizationProviderOptions,
  EVENT_LOOP_UTILIZATION,
  EventLoopDelayProvider,
  type EventLoopDelayProviderOptions,
  EventLoopUtilizationProvider,
  type EventLoopUtilizationProviderOptions,
  type EventLoopUtilizationSnapshot,
  type HistogramLike,
  NetworkLatencyProvider,
  type NetworkLatencyProviderOptions,
  PROCESS_MEMORY_HEAP_USED,
  PROCESS_MEMORY_RSS,
  ProcessMemoryProvider,
  type ProcessMemoryProviderOptions,
} from "../../src/providers/index.js";
import { requireOk } from "../helpers/providers.js";

const NOW = 1_000_000;
const signal = new AbortController().signal;

describe("ProcessMemoryProvider", () => {
  it("reports heap and RSS with the runtime clock timestamp", () => {
    const provider = new ProcessMemoryProvider({
      memoryUsage: () => ({ heapUsed: 1234, rss: 5678 }),
    });
    const readings = provider.read({ now: NOW, signal });
    assert.equal(readings.length, 2);
    assert.deepEqual(
      readings.map((reading) => {
        const ok = requireOk(reading);
        return [ok.name, ok.status, ok.value, ok.unit];
      }),
      [
        ["process.memory.heapUsed", "ok", 1234, "bytes"],
        ["process.memory.rss", "ok", 5678, "bytes"],
      ],
    );
    assert.ok(readings.every((reading) => reading.observedAt === NOW));
  });

  it("uses default signal names and process.memoryUsage when no options are supplied", () => {
    const provider = new ProcessMemoryProvider();
    assert.equal(provider.id, "process-memory");
    assert.deepEqual(
      provider.signals.map((descriptor) => descriptor.name),
      [PROCESS_MEMORY_HEAP_USED, PROCESS_MEMORY_RSS],
    );
    const readings = provider.read({ now: NOW, signal });
    assert.equal(readings.length, 2);
    assert.ok(readings.every((reading) => reading.status === "ok"));
  });

  it("accepts custom ids and signal names", () => {
    const provider = new ProcessMemoryProvider({
      id: "custom-memory",
      heapSignalName: "custom.heap",
      rssSignalName: "custom.rss",
      memoryUsage: () => ({ heapUsed: 1, rss: 2 }),
    });
    assert.equal(provider.id, "custom-memory");
    assert.deepEqual(
      provider.signals.map((descriptor) => descriptor.name),
      ["custom.heap", "custom.rss"],
    );
  });

  it("validates id thoroughly", () => {
    const invalidIds = ["", "   ", " leading", "trailing ", 123, null, {}];
    for (const id of invalidIds) {
      assert.throws(
        () => new ProcessMemoryProvider({ id: id as unknown as string }),
        ConfigurationError,
      );
    }
  });

  it("validates constructor options and signal names", () => {
    assert.throws(
      () => new ProcessMemoryProvider(null as unknown as ProcessMemoryProviderOptions),
      ConfigurationError,
    );
    assert.throws(
      () =>
        new ProcessMemoryProvider({
          memoryUsage: 123 as unknown as () => { heapUsed: number; rss: number },
        }),
      ConfigurationError,
    );
    assert.throws(() => new ProcessMemoryProvider({ heapSignalName: "" }), ConfigurationError);
    assert.throws(
      () => new ProcessMemoryProvider({ heapSignalName: " padded " }),
      ConfigurationError,
    );
    assert.throws(() => new ProcessMemoryProvider({ rssSignalName: "" }), ConfigurationError);
    assert.throws(
      () => new ProcessMemoryProvider({ rssSignalName: " padded " }),
      ConfigurationError,
    );
    assert.throws(
      () =>
        new ProcessMemoryProvider({
          heapSignalName: "same.signal",
          rssSignalName: "same.signal",
        }),
      ConfigurationError,
    );
  });

  it("handles provider close() lifecycle and returns unsupported readings", () => {
    const provider = new ProcessMemoryProvider({
      memoryUsage: () => ({ heapUsed: 1234, rss: 5678 }),
    });
    const beforeClose = provider.read({ now: NOW, signal });
    assert.equal(beforeClose.length, 2);
    assert.equal(beforeClose[0]?.status, "ok");

    provider.close();
    provider.close(); // idempotent

    const afterClose = provider.read({ now: NOW + 100, signal });
    assert.equal(afterClose.length, 2);
    assert.deepEqual(afterClose, [
      {
        name: PROCESS_MEMORY_HEAP_USED,
        unit: "bytes",
        status: "unsupported",
        observedAt: NOW + 100,
        error: "Provider is closed.",
      },
      {
        name: PROCESS_MEMORY_RSS,
        unit: "bytes",
        status: "unsupported",
        observedAt: NOW + 100,
        error: "Provider is closed.",
      },
    ]);
  });

  it("validates heapLimitBytes option thoroughly", () => {
    const invalidHeapLimits = [0, -1, -500, Number.NaN, Number.POSITIVE_INFINITY, "1000", null, {}];
    for (const heapLimitBytes of invalidHeapLimits) {
      assert.throws(
        () =>
          new ProcessMemoryProvider({
            heapLimitBytes: heapLimitBytes as unknown as number,
          }),
        ConfigurationError,
      );
    }
    assert.doesNotThrow(() => new ProcessMemoryProvider({ heapLimitBytes: 1024 }));
  });

  it("tracks memory stats and exposes frozen getMemoryStats()", () => {
    const provider = new ProcessMemoryProvider({
      memoryUsage: () => ({ heapUsed: 1000, rss: 2000 }),
    });

    const initialStats: ProcessMemoryStats = provider.getMemoryStats();
    assert.ok(Object.isFrozen(initialStats));
    assert.deepEqual(initialStats, {
      lastRssBytes: null,
      lastHeapUsedBytes: null,
      peakRssBytes: null,
      peakHeapUsedBytes: null,
      heapUtilizationRatio: null,
      remainingHeapBytes: null,
    });

    provider.read({ now: NOW, signal });
    const afterFirst = provider.getMemoryStats();
    assert.ok(Object.isFrozen(afterFirst));
    assert.deepEqual(afterFirst, {
      lastRssBytes: 2000,
      lastHeapUsedBytes: 1000,
      peakRssBytes: 2000,
      peakHeapUsedBytes: 1000,
      heapUtilizationRatio: null,
      remainingHeapBytes: null,
    });
  });

  it("calculates heap utilization ratio and remaining headroom when heapLimitBytes is configured", () => {
    const usages = [
      { heapUsed: 2500, rss: 4000 },
      { heapUsed: 8000, rss: 9000 },
      { heapUsed: 12000, rss: 15000 },
      { heapUsed: 2000, rss: 3000 },
    ];
    const provider = new ProcessMemoryProvider({
      heapLimitBytes: 10_000,
      memoryUsage: () => usages.shift() ?? { heapUsed: 0, rss: 0 },
    });

    const first = provider.read({ now: NOW, signal });
    const heapFirst = requireOk(first[0]);
    assert.equal(heapFirst.value, 2500);
    assert.deepEqual(heapFirst.details, {
      heapLimitBytes: 10_000,
      heapUtilizationRatio: 0.25,
      remainingHeapBytes: 7500,
    });
    assert.deepEqual(provider.getMemoryStats(), {
      lastRssBytes: 4000,
      lastHeapUsedBytes: 2500,
      peakRssBytes: 4000,
      peakHeapUsedBytes: 2500,
      heapUtilizationRatio: 0.25,
      remainingHeapBytes: 7500,
    });

    provider.read({ now: NOW + 100, signal });
    assert.deepEqual(provider.getMemoryStats(), {
      lastRssBytes: 9000,
      lastHeapUsedBytes: 8000,
      peakRssBytes: 9000,
      peakHeapUsedBytes: 8000,
      heapUtilizationRatio: 0.8,
      remainingHeapBytes: 2000,
    });

    const third = provider.read({ now: NOW + 200, signal });
    const heapThird = requireOk(third[0]);
    assert.equal(heapThird.value, 12000);
    assert.deepEqual(heapThird.details, {
      heapLimitBytes: 10_000,
      heapUtilizationRatio: 1,
      remainingHeapBytes: 0,
    });
    assert.deepEqual(provider.getMemoryStats(), {
      lastRssBytes: 15000,
      lastHeapUsedBytes: 12000,
      peakRssBytes: 15000,
      peakHeapUsedBytes: 12000,
      heapUtilizationRatio: 1,
      remainingHeapBytes: 0,
    });

    // Fourth read drops heap usage; peaks are retained
    provider.read({ now: NOW + 300, signal });
    assert.deepEqual(provider.getMemoryStats(), {
      lastRssBytes: 3000,
      lastHeapUsedBytes: 2000,
      peakRssBytes: 15000,
      peakHeapUsedBytes: 12000,
      heapUtilizationRatio: 0.2,
      remainingHeapBytes: 8000,
    });
  });
});

describe("CpuUtilizationProvider", () => {
  it("returns unknown for the baseline, then a measured core ratio", () => {
    const usage = [
      { user: 0, system: 0 },
      { user: 2_500_000, system: 1_000_000 },
    ];
    const provider = new CpuUtilizationProvider({
      cpuUsage: () => usage.shift() ?? { user: 0, system: 0 },
    });

    const first = provider.read({ now: NOW, signal })[0];
    assert.equal(first?.status, "unknown");

    const second = provider.read({ now: NOW + 1000, signal })[0];
    assert.equal(second?.status, "ok");
    assert.equal(requireOk(second).value, 3.5);
    assert.equal(second?.unit, "ratio");
  });

  it("reports unknown when elapsed time is zero", () => {
    const provider = new CpuUtilizationProvider({
      cpuUsage: () => ({ user: 1, system: 1 }),
    });
    provider.read({ now: NOW, signal });
    const second = provider.read({ now: NOW, signal })[0];
    assert.equal(second?.status, "unknown");
  });

  it("validates id thoroughly", () => {
    const invalidIds = ["", "   ", " leading", "trailing ", 456, null, {}];
    for (const id of invalidIds) {
      assert.throws(
        () => new CpuUtilizationProvider({ id: id as unknown as string }),
        ConfigurationError,
      );
    }
  });

  it("validates constructor options and signal name", () => {
    assert.throws(
      () => new CpuUtilizationProvider(null as unknown as CpuUtilizationProviderOptions),
      ConfigurationError,
    );
    assert.throws(
      () =>
        new CpuUtilizationProvider({
          cpuUsage: 123 as unknown as () => { user: number; system: number },
        }),
      ConfigurationError,
    );
    assert.throws(() => new CpuUtilizationProvider({ signalName: "" }), ConfigurationError);
    assert.throws(
      () => new CpuUtilizationProvider({ signalName: "  padded  " }),
      ConfigurationError,
    );
  });

  it("handles provider close() lifecycle and returns unsupported reading", () => {
    const provider = new CpuUtilizationProvider({
      cpuUsage: () => ({ user: 100, system: 50 }),
    });
    provider.close();
    provider.close(); // idempotent

    const readings = provider.read({ now: NOW, signal });
    assert.equal(readings.length, 1);
    assert.deepEqual(readings[0], {
      name: "process.cpu.utilization",
      unit: "ratio",
      status: "unsupported",
      observedAt: NOW,
      error: "Provider is closed.",
    });
  });

  it("validates smoothingAlpha option thoroughly", () => {
    const invalidAlphas = [
      0,
      -0.1,
      -5,
      1.0001,
      2,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      "0.5",
      null,
      {},
    ];
    for (const alpha of invalidAlphas) {
      assert.throws(
        () =>
          new CpuUtilizationProvider({
            smoothingAlpha: alpha as unknown as number,
          }),
        ConfigurationError,
      );
    }
    assert.doesNotThrow(() => new CpuUtilizationProvider({ smoothingAlpha: 1 }));
    assert.doesNotThrow(() => new CpuUtilizationProvider({ smoothingAlpha: 0.5 }));
    assert.doesNotThrow(() => new CpuUtilizationProvider({ smoothingAlpha: 0.001 }));
  });

  it("tracks cpu stats and EWMA smoothed utilization", () => {
    const usage = [
      { user: 0, system: 0 },
      { user: 1_000_000, system: 0 },
      { user: 3_000_000, system: 0 },
      { user: 3_000_000, system: 0 },
    ];
    const provider = new CpuUtilizationProvider({
      smoothingAlpha: 0.5,
      cpuUsage: () => usage.shift() ?? { user: 0, system: 0 },
    });

    const initialStats: CpuUtilizationStats = provider.getCpuStats();
    assert.ok(Object.isFrozen(initialStats));
    assert.deepEqual(initialStats, {
      sampleCount: 0,
      lastRawUtilization: null,
      smoothedUtilization: null,
      peakUtilization: null,
    });

    // Baseline read
    const baseline = provider.read({ now: NOW, signal })[0];
    assert.equal(baseline?.status, "unknown");
    assert.deepEqual(provider.getCpuStats(), {
      sampleCount: 0,
      lastRawUtilization: null,
      smoothedUtilization: null,
      peakUtilization: null,
    });

    // First sample (raw: 1.0)
    const sample1 = provider.read({ now: NOW + 1000, signal })[0];
    assert.equal(sample1?.status, "ok");
    assert.equal(requireOk(sample1).value, 1.0);
    assert.deepEqual(provider.getCpuStats(), {
      sampleCount: 1,
      lastRawUtilization: 1.0,
      smoothedUtilization: 1.0,
      peakUtilization: 1.0,
    });

    // Second sample (raw: 2.0 -> smoothed: 0.5 * 2.0 + 0.5 * 1.0 = 1.5)
    const sample2 = provider.read({ now: NOW + 2000, signal })[0];
    assert.equal(sample2?.status, "ok");
    assert.equal(requireOk(sample2).value, 1.5);
    assert.equal(sample2?.details?.smoothedUtilization, 1.5);
    assert.equal(sample2?.details?.rawUtilization, 2.0);
    assert.deepEqual(provider.getCpuStats(), {
      sampleCount: 2,
      lastRawUtilization: 2.0,
      smoothedUtilization: 1.5,
      peakUtilization: 2.0,
    });

    // Third sample (raw: 0.0 -> smoothed: 0.5 * 0.0 + 0.5 * 1.5 = 0.75, peak retained at 2.0)
    const sample3 = provider.read({ now: NOW + 3000, signal })[0];
    assert.equal(sample3?.status, "ok");
    assert.equal(requireOk(sample3).value, 0.75);
    assert.deepEqual(provider.getCpuStats(), {
      sampleCount: 3,
      lastRawUtilization: 0.0,
      smoothedUtilization: 0.75,
      peakUtilization: 2.0,
    });
  });

  it("reports raw instantaneous utilization when smoothingAlpha is 1 or undefined", () => {
    // When smoothingAlpha is 1
    const usageAlpha1 = [
      { user: 0, system: 0 },
      { user: 1_000_000, system: 0 },
      { user: 4_000_000, system: 0 },
    ];
    const providerAlpha1 = new CpuUtilizationProvider({
      smoothingAlpha: 1,
      cpuUsage: () => usageAlpha1.shift() ?? { user: 0, system: 0 },
    });
    providerAlpha1.read({ now: NOW, signal });
    const s1 = providerAlpha1.read({ now: NOW + 1000, signal })[0];
    assert.equal(requireOk(s1).value, 1.0);
    const s2 = providerAlpha1.read({ now: NOW + 2000, signal })[0];
    assert.equal(requireOk(s2).value, 3.0);
    assert.deepEqual(providerAlpha1.getCpuStats(), {
      sampleCount: 2,
      lastRawUtilization: 3.0,
      smoothedUtilization: 3.0,
      peakUtilization: 3.0,
    });

    // When smoothingAlpha is undefined
    const usageUndefined = [
      { user: 0, system: 0 },
      { user: 2_500_000, system: 0 },
      { user: 4_000_000, system: 0 },
    ];
    const providerUndefined = new CpuUtilizationProvider({
      cpuUsage: () => usageUndefined.shift() ?? { user: 0, system: 0 },
    });
    providerUndefined.read({ now: NOW, signal });
    const u1 = providerUndefined.read({ now: NOW + 1000, signal })[0];
    assert.equal(requireOk(u1).value, 2.5);
    const u2 = providerUndefined.read({ now: NOW + 2000, signal })[0];
    assert.equal(requireOk(u2).value, 1.5);
    assert.deepEqual(providerUndefined.getCpuStats(), {
      sampleCount: 2,
      lastRawUtilization: 1.5,
      smoothedUtilization: null,
      peakUtilization: 2.5,
    });
  });

  it("resets baseline and statistics on resetBaseline()", () => {
    const usage = [
      { user: 0, system: 0 },
      { user: 1_000_000, system: 0 },
      { user: 2_000_000, system: 0 },
      { user: 2_500_000, system: 0 },
    ];
    const provider = new CpuUtilizationProvider({
      smoothingAlpha: 0.5,
      cpuUsage: () => usage.shift() ?? { user: 0, system: 0 },
    });

    provider.read({ now: NOW, signal });
    provider.read({ now: NOW + 1000, signal });
    assert.equal(provider.getCpuStats().sampleCount, 1);

    provider.resetBaseline();
    const statsAfterReset = provider.getCpuStats();
    assert.deepEqual(statsAfterReset, {
      sampleCount: 0,
      lastRawUtilization: null,
      smoothedUtilization: null,
      peakUtilization: null,
    });

    // Next reading establishes baseline again
    const baselineAfterReset = provider.read({ now: NOW + 2000, signal })[0];
    assert.equal(baselineAfterReset?.status, "unknown");

    // Next reading computes fresh sample
    const freshSample = provider.read({ now: NOW + 3000, signal })[0];
    assert.equal(freshSample?.status, "ok");
    assert.equal(requireOk(freshSample).value, 0.5);
    assert.deepEqual(provider.getCpuStats(), {
      sampleCount: 1,
      lastRawUtilization: 0.5,
      smoothedUtilization: 0.5,
      peakUtilization: 0.5,
    });
  });
});

describe("EventLoopDelayProvider", () => {
  function makeHistogram(): {
    histogram: HistogramLike;
    state: { enabled: boolean; disabled: boolean; resets: number; samples: number };
  } {
    const state = { enabled: false, disabled: false, resets: 0, samples: 0 };
    const histogram: HistogramLike = {
      get count() {
        return state.samples;
      },
      percentile(percentile) {
        void percentile;
        return 2_500_000;
      },
      reset() {
        state.resets += 1;
        state.samples = 0;
      },
      enable() {
        state.enabled = true;
      },
      disable() {
        state.disabled = true;
      },
    };
    return { histogram, state };
  }

  it("starts lazily, reports unknown before samples, then converts nanoseconds to ms", () => {
    const { histogram, state } = makeHistogram();
    const provider = new EventLoopDelayProvider({
      histogramFactory: () => histogram,
    });

    const beforeStart = provider.read({ now: NOW, signal })[0];
    assert.equal(beforeStart?.status, "unknown");
    assert.equal(state.enabled, true);

    state.samples = 10;
    const reading = provider.read({ now: NOW + 1000, signal })[0];
    assert.equal(reading?.status, "ok");
    assert.equal(requireOk(reading).value, 2.5);
    assert.equal(state.resets, 1);

    provider.close();
    assert.equal(state.disabled, true);
    const afterClose = provider.read({ now: NOW + 2000, signal })[0];
    assert.equal(afterClose?.status, "unsupported");
  });

  it("validates percentile and resolution", () => {
    assert.throws(() => new EventLoopDelayProvider({ percentile: 101 }), ConfigurationError);
    assert.throws(() => new EventLoopDelayProvider({ percentile: -1 }), ConfigurationError);
    assert.throws(() => new EventLoopDelayProvider({ percentile: Number.NaN }), ConfigurationError);
    assert.throws(() => new EventLoopDelayProvider({ resolutionMs: 0 }), ConfigurationError);
    assert.throws(() => new EventLoopDelayProvider({ resolutionMs: -5 }), ConfigurationError);
    assert.throws(
      () => new EventLoopDelayProvider({ resolutionMs: Number.NaN }),
      ConfigurationError,
    );
    assert.throws(() => new EventLoopDelayProvider({ minSamples: 0 }), ConfigurationError);
    assert.throws(() => new EventLoopDelayProvider({ minSamples: -1 }), ConfigurationError);
    assert.throws(() => new EventLoopDelayProvider({ minSamples: 1.5 }), ConfigurationError);
    assert.throws(() => new EventLoopDelayProvider({ minSamples: Number.NaN }), ConfigurationError);
  });

  it("retains the last valid reading only within the bounded sampling window", () => {
    const { histogram, state } = makeHistogram();
    const provider = new EventLoopDelayProvider({
      minSamples: 3,
      resolutionMs: 20,
      histogramFactory: () => histogram,
    });

    assert.equal(provider.read({ now: NOW, signal })[0]?.status, "unknown");
    state.samples = 3;
    const fresh = provider.read({ now: NOW, signal })[0];
    assert.equal(fresh?.status, "ok");
    assert.equal(requireOk(fresh).value, 2.5);
    assert.equal(fresh?.confidence, 1);
    assert.deepEqual(fresh?.details, {
      percentile: 95,
      resolutionMs: 20,
      samples: 3,
      retained: false,
    });

    const retained = provider.read({ now: NOW + 60, signal })[0];
    assert.equal(retained?.status, "ok");
    assert.equal(requireOk(retained).value, 2.5);
    assert.equal(retained?.confidence, 0.5);
    assert.deepEqual(retained?.details, {
      percentile: 95,
      resolutionMs: 20,
      samples: 3,
      retained: true,
    });

    assert.equal(provider.read({ now: NOW + 61, signal })[0]?.status, "unknown");
    assert.equal(provider.read({ now: NOW - 1, signal })[0]?.status, "unknown");
  });

  it("reports an error reading when the histogram percentile is invalid", () => {
    const histogram: HistogramLike = {
      count: 1,
      percentile: () => Number.NaN,
      reset: () => undefined,
    };
    const provider = new EventLoopDelayProvider({ histogramFactory: () => histogram });
    const reading = provider.read({ now: NOW, signal })[0];
    assert.equal(reading?.status, "error");
    assert.match(reading?.status === "error" ? (reading.error ?? "") : "", /percentile/);
  });

  it("validates id, options object, histogramFactory, and signalName", () => {
    const invalidIds = ["", "   ", " leading", "trailing ", 789, null];
    for (const id of invalidIds) {
      assert.throws(
        () => new EventLoopDelayProvider({ id: id as unknown as string }),
        ConfigurationError,
      );
    }
    assert.throws(
      () => new EventLoopDelayProvider(null as unknown as EventLoopDelayProviderOptions),
      ConfigurationError,
    );
    assert.throws(
      () =>
        new EventLoopDelayProvider({
          histogramFactory: 123 as unknown as (resolutionMs: number) => HistogramLike,
        }),
      ConfigurationError,
    );
    assert.throws(() => new EventLoopDelayProvider({ signalName: "" }), ConfigurationError);
    assert.throws(
      () => new EventLoopDelayProvider({ signalName: "  padded.signal  " }),
      ConfigurationError,
    );
  });

  it("uses default options and degrades to unknown before samples exist", () => {
    const provider = new EventLoopDelayProvider();
    assert.equal(provider.id, "event-loop-delay");
    assert.equal(provider.signals[0]?.name, "eventLoop.delay.p95");
    const reading = provider.read({ now: NOW, signal })[0];
    assert.equal(reading?.status, "unknown");
    provider.close();
    provider.close();
  });

  it("formats fractional percentiles and honors custom signal names", () => {
    const { histogram, state } = makeHistogram();
    const fractional = new EventLoopDelayProvider({
      percentile: 99.5,
      resolutionMs: 10,
      histogramFactory: (resolutionMs) => {
        assert.equal(resolutionMs, 10);
        return histogram;
      },
    });
    assert.equal(fractional.signals[0]?.name, "eventLoop.delay.p99_5");
    fractional.read({ now: NOW, signal });
    assert.equal(state.enabled, true);

    const custom = new EventLoopDelayProvider({
      percentile: 0,
      signalName: "custom.delay",
      histogramFactory: () => histogram,
    });
    assert.equal(custom.signals[0]?.name, "custom.delay");
    state.samples = 2;
    assert.equal(custom.read({ now: NOW, signal })[0]?.status, "ok");
  });

  it("closes a histogram that omits optional enable/disable hooks", () => {
    const histogram: HistogramLike = {
      count: 0,
      percentile: () => 0,
      reset: () => undefined,
    };
    const provider = new EventLoopDelayProvider({ histogramFactory: () => histogram });
    assert.equal(provider.read({ now: NOW, signal })[0]?.status, "unknown");
    provider.close();
    assert.equal(provider.read({ now: NOW, signal })[0]?.status, "unsupported");
  });
});

describe("EventLoopUtilizationProvider", () => {
  it("reports cumulative utilization first and deltas afterward", () => {
    const snapshots: EventLoopUtilizationSnapshot[] = [
      { idle: 0, active: 0, utilization: 0 },
      { idle: 400, active: 100, utilization: 0.2 },
      { idle: 450, active: 150, utilization: 0.25 },
      { idle: 450, active: 150, utilization: 0.25 },
    ];
    const provider = new EventLoopUtilizationProvider({
      eventLoopUtilization: () => snapshots.shift() ?? { idle: 0, active: 0, utilization: 0 },
    });
    assert.equal(provider.id, "event-loop-utilization");
    assert.equal(provider.signals[0]?.name, EVENT_LOOP_UTILIZATION);
    assert.equal(provider.signals[0]?.unit, "ratio");

    const baseline = provider.read({ now: NOW, signal })[0];
    assert.equal(baseline?.status, "unknown");

    const cumulative = provider.read({ now: NOW + 1000, signal })[0];
    assert.equal(cumulative?.status, "ok");
    assert.equal(requireOk(cumulative).value, 0.2);
    assert.deepEqual(cumulative?.details, { mode: "cumulative", idleMs: 400, activeMs: 100 });

    const delta = provider.read({ now: NOW + 2000, signal })[0];
    assert.equal(delta?.status, "ok");
    assert.equal(requireOk(delta).value, 0.5);
    assert.deepEqual(delta?.details, { mode: "delta", idleMs: 50, activeMs: 50 });

    const noElapsed = provider.read({ now: NOW + 3000, signal })[0];
    assert.equal(noElapsed?.status, "unknown");
  });

  it("reports error readings for backwards counters and invalid snapshots", () => {
    const snapshots: EventLoopUtilizationSnapshot[] = [
      { idle: 100, active: 100, utilization: 0.5 },
      { idle: 50, active: 50, utilization: 0.5 },
    ];
    const provider = new EventLoopUtilizationProvider({
      eventLoopUtilization: () => snapshots.shift() ?? { idle: 0, active: 0, utilization: 0 },
    });
    assert.equal(provider.read({ now: NOW, signal })[0]?.status, "ok");
    const backwards = provider.read({ now: NOW + 1, signal })[0];
    assert.equal(backwards?.status, "error");
    assert.match(backwards?.status === "error" ? (backwards.error ?? "") : "", /backwards/);

    const invalid = new EventLoopUtilizationProvider({
      eventLoopUtilization: () => ({ idle: 1, active: 1, utilization: 1.5 }),
    });
    const invalidReading = invalid.read({ now: NOW, signal })[0];
    assert.equal(invalidReading?.status, "error");
    assert.match(
      invalidReading?.status === "error" ? (invalidReading.error ?? "") : "",
      /between 0 and 1/,
    );

    const throwing = new EventLoopUtilizationProvider({
      eventLoopUtilization: () => {
        throw new Error("perf unavailable");
      },
    });
    const throwingReading = throwing.read({ now: NOW, signal })[0];
    assert.equal(throwingReading?.status, "error");
    assert.match(
      throwingReading?.status === "error" ? (throwingReading.error ?? "") : "",
      /perf unavailable/,
    );
  });

  it("handles close and validates id, signal name, and injection", () => {
    const provider = new EventLoopUtilizationProvider({
      eventLoopUtilization: () => ({ idle: 1, active: 1, utilization: 0.5 }),
    });
    provider.read({ now: NOW, signal });
    provider.close();
    provider.close();
    const reading = provider.read({ now: NOW + 1, signal })[0];
    assert.equal(reading?.status, "unsupported");

    const invalidIds = ["", "   ", " leading", "trailing ", 123, null];
    for (const id of invalidIds) {
      assert.throws(
        () => new EventLoopUtilizationProvider({ id: id as unknown as string }),
        ConfigurationError,
      );
    }
    assert.throws(
      () =>
        new EventLoopUtilizationProvider(null as unknown as EventLoopUtilizationProviderOptions),
      ConfigurationError,
    );
    assert.throws(() => new EventLoopUtilizationProvider({ signalName: "" }), ConfigurationError);
    assert.throws(
      () => new EventLoopUtilizationProvider({ signalName: " padded.signal " }),
      ConfigurationError,
    );
    assert.throws(
      () =>
        new EventLoopUtilizationProvider({
          eventLoopUtilization: 123 as unknown as () => EventLoopUtilizationSnapshot,
        }),
      ConfigurationError,
    );
    assert.throws(
      () =>
        new EventLoopUtilizationProvider({
          signalName: 42 as unknown as string,
        }),
      ConfigurationError,
    );
    assert.throws(
      () =>
        new EventLoopUtilizationProvider({
          eventLoopUtilization: null as unknown as () => EventLoopUtilizationSnapshot,
        }),
      ConfigurationError,
    );
  });

  it("uses the default id and signal name for an empty options object", () => {
    const provider = new EventLoopUtilizationProvider({});
    assert.equal(provider.id, "event-loop-utilization");
    assert.equal(provider.signals[0]?.name, EVENT_LOOP_UTILIZATION);
    assert.equal(provider.signals[0]?.unit, "ratio");
  });

  it("reports explicit errors for every malformed snapshot field", () => {
    const invalidSnapshots: readonly (readonly [unknown, RegExp])[] = [
      [null, /must be an object/],
      ["snapshot", /must be an object/],
      [{ idle: -1, active: 1, utilization: 0.5 }, /idle time/],
      [{ idle: Number.NaN, active: 1, utilization: 0.5 }, /idle time/],
      [{ idle: "1", active: 1, utilization: 0.5 }, /idle time/],
      [{ idle: 1, active: -1, utilization: 0.5 }, /active time/],
      [{ idle: 1, active: Number.POSITIVE_INFINITY, utilization: 0.5 }, /active time/],
      [{ idle: 1, active: null, utilization: 0.5 }, /active time/],
      [{ idle: 1, active: 1, utilization: -0.1 }, /between 0 and 1/],
      [{ idle: 1, active: 1, utilization: Number.NaN }, /between 0 and 1/],
      [{ idle: 1, active: 1, utilization: "0.5" }, /between 0 and 1/],
    ];

    for (const [snapshot, expectedError] of invalidSnapshots) {
      const provider = new EventLoopUtilizationProvider({
        eventLoopUtilization: () => snapshot as EventLoopUtilizationSnapshot,
      });
      const reading = provider.read({ now: NOW, signal })[0];
      assert.equal(reading?.status, "error");
      assert.match(reading?.status === "error" ? (reading.error ?? "") : "", expectedError);
    }
  });

  it("converts a throwing snapshot getter into an error reading", () => {
    const snapshot = Object.defineProperty({}, "idle", {
      get() {
        throw new Error("getter exploded");
      },
    }) as EventLoopUtilizationSnapshot;
    const provider = new EventLoopUtilizationProvider({
      eventLoopUtilization: () => snapshot,
    });

    const reading = provider.read({ now: NOW, signal })[0];
    assert.equal(reading?.status, "error");
    assert.match(
      reading?.status === "error" ? (reading.error ?? "") : "",
      /Failed to read event-loop utilization snapshot: getter exploded/,
    );
  });

  it("distinguishes backwards idle and active counters", () => {
    const createProvider = (
      first: EventLoopUtilizationSnapshot,
      second: EventLoopUtilizationSnapshot,
    ) => {
      let reads = 0;
      return new EventLoopUtilizationProvider({
        eventLoopUtilization: () => {
          reads += 1;
          return reads === 1 ? first : second;
        },
      });
    };

    const idleProvider = createProvider(
      { idle: 100, active: 100, utilization: 0.5 },
      { idle: 90, active: 110, utilization: 0.5 },
    );
    assert.equal(idleProvider.read({ now: NOW, signal })[0]?.status, "ok");
    const idleReading = idleProvider.read({ now: NOW + 1, signal })[0];
    assert.equal(idleReading?.status, "error");
    assert.match(idleReading?.status === "error" ? (idleReading.error ?? "") : "", /backwards/);

    const activeProvider = createProvider(
      { idle: 100, active: 100, utilization: 0.5 },
      { idle: 110, active: 90, utilization: 0.5 },
    );
    assert.equal(activeProvider.read({ now: NOW, signal })[0]?.status, "ok");
    const activeReading = activeProvider.read({ now: NOW + 1, signal })[0];
    assert.equal(activeReading?.status, "error");
    assert.match(activeReading?.status === "error" ? (activeReading.error ?? "") : "", /backwards/);
  });

  it("accepts and clamps snapshot utilization within floating-point tolerance", () => {
    const provider = new EventLoopUtilizationProvider({
      eventLoopUtilization: () => ({ idle: 0, active: 1, utilization: 1 + 1e-10 }),
    });

    const reading = provider.read({ now: NOW, signal })[0];
    assert.equal(reading?.status, "ok");
    assert.equal(requireOk(reading).value, 1);
    assert.deepEqual(reading?.details, { mode: "cumulative", idleMs: 0, activeMs: 1 });
  });
});

describe("NetworkLatencyProvider", () => {
  it("requires an explicit probe and reports its value", async () => {
    const provider = new NetworkLatencyProvider({
      probe: async () => 42,
    });
    const readings = await provider.read({ now: NOW, signal });
    assert.equal(readings[0]?.status, "ok");
    assert.equal(requireOk(readings[0]).value, 42);
    assert.equal(readings[0]?.unit, "milliseconds");
  });

  it("rejects invalid probe results", async () => {
    const provider = new NetworkLatencyProvider({ probe: () => -1 });
    await assert.rejects(() => provider.read({ now: NOW, signal }), TypeError);
    assert.throws(
      // @ts-expect-error deliberately invalid runtime input
      () => new NetworkLatencyProvider({}),
      ConfigurationError,
    );
  });

  it("validates id, options object, probe, and signal name", () => {
    const invalidIds = ["", "   ", " leading", "trailing ", 999, null];
    for (const id of invalidIds) {
      assert.throws(
        () =>
          new NetworkLatencyProvider({
            id: id as unknown as string,
            probe: () => 1,
          }),
        ConfigurationError,
      );
    }
    assert.throws(
      () => new NetworkLatencyProvider(null as unknown as NetworkLatencyProviderOptions),
      ConfigurationError,
    );
    assert.throws(
      () =>
        new NetworkLatencyProvider({
          probe: "not a function" as unknown as () => number,
        }),
      ConfigurationError,
    );
    assert.throws(
      () =>
        new NetworkLatencyProvider({
          probe: () => 1,
          signalName: "",
        }),
      ConfigurationError,
    );
    assert.throws(
      () =>
        new NetworkLatencyProvider({
          probe: () => 1,
          signalName: " padded.latency ",
        }),
      ConfigurationError,
    );
  });

  it("handles provider close() lifecycle and does not invoke probe", async () => {
    let probeCalled = false;
    const provider = new NetworkLatencyProvider({
      probe: () => {
        probeCalled = true;
        return 15;
      },
    });

    provider.close();
    provider.close(); // idempotent

    const readings = await provider.read({ now: NOW, signal });
    assert.equal(probeCalled, false);
    assert.equal(readings.length, 1);
    assert.deepEqual(readings[0], {
      name: "network.latency",
      unit: "milliseconds",
      status: "unsupported",
      observedAt: NOW,
      error: "Provider is closed.",
    });
  });

  it("passes an abort signal to the user probe", async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const provider = new NetworkLatencyProvider({
      probe: (context) => {
        received = context.signal;
        return 1;
      },
    });
    await provider.read({ now: NOW, signal: controller.signal });
    assert.equal(received, controller.signal);
  });

  it("validates windowSize option thoroughly", () => {
    const invalidWindowSizes = [
      0,
      1,
      -1,
      -20,
      1001,
      10000,
      2.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "20",
      null,
      {},
    ];
    for (const size of invalidWindowSizes) {
      assert.throws(
        () =>
          new NetworkLatencyProvider({
            probe: () => 1,
            windowSize: size as unknown as number,
          }),
        ConfigurationError,
      );
    }
    assert.doesNotThrow(() => new NetworkLatencyProvider({ probe: () => 1, windowSize: 2 }));
    assert.doesNotThrow(() => new NetworkLatencyProvider({ probe: () => 1, windowSize: 20 }));
    assert.doesNotThrow(() => new NetworkLatencyProvider({ probe: () => 1, windowSize: 1000 }));
  });

  it("tracks latency stats, min, max, jitter, and p95 across sliding window", async () => {
    const samples = [50, 70, 40];
    const provider = new NetworkLatencyProvider({
      probe: () => samples.shift() ?? 0,
    });

    const initialStats: NetworkLatencyStats = provider.getLatencyStats();
    assert.ok(Object.isFrozen(initialStats));
    assert.deepEqual(initialStats, {
      sampleCount: 0,
      lastLatencyMs: null,
      minLatencyMs: null,
      maxLatencyMs: null,
      jitterMs: null,
      p95LatencyMs: null,
    });

    // Sample 1: jitter is 0 when < 2 samples
    await provider.read({ now: NOW, signal });
    assert.deepEqual(provider.getLatencyStats(), {
      sampleCount: 1,
      lastLatencyMs: 50,
      minLatencyMs: 50,
      maxLatencyMs: 50,
      jitterMs: 0,
      p95LatencyMs: 50,
    });

    // Sample 2: jitter is |70 - 50| / 1 = 20
    await provider.read({ now: NOW + 100, signal });
    assert.deepEqual(provider.getLatencyStats(), {
      sampleCount: 2,
      lastLatencyMs: 70,
      minLatencyMs: 50,
      maxLatencyMs: 70,
      jitterMs: 20,
      p95LatencyMs: 70,
    });

    // Sample 3: jitter is (|70 - 50| + |40 - 70|) / 2 = 25
    await provider.read({ now: NOW + 200, signal });
    assert.deepEqual(provider.getLatencyStats(), {
      sampleCount: 3,
      lastLatencyMs: 40,
      minLatencyMs: 40,
      maxLatencyMs: 70,
      jitterMs: 25,
      p95LatencyMs: 70,
    });
  });

  it("bounds samples to windowSize and evicts oldest samples", async () => {
    const samples = [10, 20, 30, 40];
    const provider = new NetworkLatencyProvider({
      windowSize: 3,
      probe: () => samples.shift() ?? 0,
    });

    await provider.read({ now: NOW, signal });
    await provider.read({ now: NOW + 10, signal });
    await provider.read({ now: NOW + 20, signal });
    assert.equal(provider.getLatencyStats().sampleCount, 3);
    assert.equal(provider.getLatencyStats().minLatencyMs, 10);

    // 4th sample evicts the 1st (10) -> window is now [20, 30, 40]
    await provider.read({ now: NOW + 30, signal });
    const stats = provider.getLatencyStats();
    assert.equal(stats.sampleCount, 3);
    assert.equal(stats.lastLatencyMs, 40);
    assert.equal(stats.minLatencyMs, 20);
    assert.equal(stats.maxLatencyMs, 40);
    // jitter: (|30 - 20| + |40 - 30|) / 2 = 10
    assert.equal(stats.jitterMs, 10);
  });

  it("calculates P95 accurately with a populated window", async () => {
    let current = 0;
    const provider = new NetworkLatencyProvider({
      windowSize: 20,
      probe: () => {
        current += 10;
        return current;
      },
    });

    for (let i = 0; i < 20; i++) {
      await provider.read({ now: NOW + i * 10, signal });
    }

    const stats = provider.getLatencyStats();
    assert.equal(stats.sampleCount, 20);
    assert.equal(stats.minLatencyMs, 10);
    assert.equal(stats.maxLatencyMs, 200);
    // 20 elements (10, 20, ..., 200): p95 index is ceil(20 * 0.95) - 1 = 18 -> 190
    assert.equal(stats.p95LatencyMs, 190);
    // Constant consecutive step of 10 -> jitter is 10
    assert.equal(stats.jitterMs, 10);
  });

  it("clears samples on resetSamples()", async () => {
    let current = 50;
    const provider = new NetworkLatencyProvider({
      probe: () => {
        current += 10;
        return current;
      },
    });

    await provider.read({ now: NOW, signal });
    await provider.read({ now: NOW + 10, signal });
    assert.equal(provider.getLatencyStats().sampleCount, 2);

    provider.resetSamples();
    assert.deepEqual(provider.getLatencyStats(), {
      sampleCount: 0,
      lastLatencyMs: null,
      minLatencyMs: null,
      maxLatencyMs: null,
      jitterMs: null,
      p95LatencyMs: null,
    });

    // Next read starts with 1 fresh sample
    await provider.read({ now: NOW + 20, signal });
    assert.equal(provider.getLatencyStats().sampleCount, 1);
    assert.equal(provider.getLatencyStats().jitterMs, 0);
  });
});
