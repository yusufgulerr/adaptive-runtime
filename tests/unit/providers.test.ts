import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigurationError } from "../../src/errors/index.js";
import {
  CpuUtilizationProvider,
  type CpuUtilizationProviderOptions,
  EventLoopDelayProvider,
  type EventLoopDelayProviderOptions,
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
});
