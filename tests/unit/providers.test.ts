import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CpuUtilizationProvider,
  EventLoopDelayProvider,
  type HistogramLike,
  NetworkLatencyProvider,
  PROCESS_MEMORY_HEAP_USED,
  PROCESS_MEMORY_RSS,
  ProcessMemoryProvider,
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
    assert.throws(() => new EventLoopDelayProvider({ percentile: 101 }), RangeError);
    assert.throws(() => new EventLoopDelayProvider({ resolutionMs: 0 }), RangeError);
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
      TypeError,
    );
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
});
