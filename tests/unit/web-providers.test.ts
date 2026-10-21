import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigurationError } from "../../src/errors/index.js";
import {
  DeviceMemoryProvider,
  type MemoryInfoLike,
  WEB_DEVICE_MEMORY_GIB,
  WEB_JS_HEAP_USED_RATIO,
} from "../../src/providers/web/device-memory.js";
import {
  FrameTimingProvider,
  WEB_FRAME_DROPPED_RATIO,
  WEB_FRAME_DURATION_P95_MS,
} from "../../src/providers/web/frame-timing.js";
import {
  NetworkInformationProvider,
  WEB_NETWORK_DOWNLINK_MBPS,
  WEB_NETWORK_RTT_MS,
  WEB_NETWORK_SAVE_DATA,
} from "../../src/providers/web/network-info.js";
import type { AvailableSignalReading, UnavailableSignalReading } from "../../src/types/signals.js";

const NOW = 1_500_000;
const signal = new AbortController().signal;

describe("DeviceMemoryProvider", () => {
  it("initializes with default options and signal descriptors", () => {
    const provider = new DeviceMemoryProvider();
    assert.equal(provider.id, "web-device-memory");
    assert.deepEqual(
      provider.signals.map((s) => [s.name, s.unit]),
      [
        [WEB_DEVICE_MEMORY_GIB, "custom"],
        [WEB_JS_HEAP_USED_RATIO, "ratio"],
      ],
    );

    // Default getEnvironment reads globalThis safely in Node environment
    const readings = provider.read({ now: NOW, signal });
    assert.equal(readings.length, 2);
    // In standard Node test runner without DOM globals, navigator.deviceMemory and performance.memory are undefined
    assert.equal(readings[0]?.status, "unsupported");
    assert.equal(readings[1]?.status, "unsupported");
  });

  it("accepts custom valid id and custom getEnvironment", () => {
    const provider = new DeviceMemoryProvider({
      id: "custom-web-mem",
      getEnvironment: () => ({
        deviceMemory: 8,
        memory: {
          usedJSHeapSize: 50_000_000,
          totalJSHeapSize: 80_000_000,
          jsHeapSizeLimit: 100_000_000,
        },
      }),
    });
    assert.equal(provider.id, "custom-web-mem");

    const readings = provider.read({ now: NOW, signal });
    assert.equal(readings.length, 2);

    const devMem = readings[0] as AvailableSignalReading;
    assert.equal(devMem.name, WEB_DEVICE_MEMORY_GIB);
    assert.equal(devMem.status, "ok");
    assert.equal(devMem.value, 8);
    assert.equal(devMem.unit, "custom");
    assert.equal(devMem.confidence, 1);
    assert.equal(devMem.observedAt, NOW);
    assert.deepEqual(devMem.details, { deviceMemory: 8 });

    const heapRatio = readings[1] as AvailableSignalReading;
    assert.equal(heapRatio.name, WEB_JS_HEAP_USED_RATIO);
    assert.equal(heapRatio.status, "ok");
    assert.equal(heapRatio.value, 0.5);
    assert.equal(heapRatio.unit, "ratio");
    assert.equal(heapRatio.confidence, 1);
    assert.equal(heapRatio.observedAt, NOW);
    assert.deepEqual(heapRatio.details, {
      usedJSHeapSize: 50_000_000,
      totalJSHeapSize: 80_000_000,
      jsHeapSizeLimit: 100_000_000,
    });
  });

  it("handles valid memory metrics when totalJSHeapSize is omitted", () => {
    const provider = new DeviceMemoryProvider({
      getEnvironment: () => ({
        deviceMemory: 16,
        memory: {
          usedJSHeapSize: 200,
          jsHeapSizeLimit: 1000,
        },
      }),
    });
    const readings = provider.read({ now: NOW, signal });
    const heapRatio = readings[1] as AvailableSignalReading;
    assert.equal(heapRatio.status, "ok");
    assert.equal(heapRatio.value, 0.2);
    assert.deepEqual(heapRatio.details, {
      usedJSHeapSize: 200,
      jsHeapSizeLimit: 1000,
    });
  });

  it("validates id properly", () => {
    // Non-string
    assert.throws(
      // @ts-expect-error invalid id type
      () => new DeviceMemoryProvider({ id: 123 }),
      ConfigurationError,
    );
    // Empty string
    assert.throws(() => new DeviceMemoryProvider({ id: "" }), ConfigurationError);
    // Whitespace only
    assert.throws(() => new DeviceMemoryProvider({ id: "   " }), ConfigurationError);
    // Leading/trailing whitespace
    assert.throws(() => new DeviceMemoryProvider({ id: " web-memory " }), ConfigurationError);
  });

  it("validates getEnvironment properly", () => {
    assert.throws(
      // @ts-expect-error invalid getEnvironment type
      () => new DeviceMemoryProvider({ getEnvironment: "not-a-function" }),
      ConfigurationError,
    );
  });

  it("handles provider close() lifecycle", () => {
    const provider = new DeviceMemoryProvider({
      getEnvironment: () => ({ deviceMemory: 8 }),
    });
    provider.close();

    const readings = provider.read({ now: NOW, signal });
    assert.equal(readings.length, 2);
    for (const r of readings) {
      assert.equal(r.status, "unsupported");
      assert.equal((r as UnavailableSignalReading).error, "Provider is closed.");
    }
  });

  it("handles getEnvironment throwing Error or non-Error", () => {
    const errorProvider = new DeviceMemoryProvider({
      getEnvironment: () => {
        throw new Error("simulated DOM exception");
      },
    });
    const errorReadings = errorProvider.read({ now: NOW, signal });
    assert.equal(errorReadings[0]?.status, "error");
    assert.ok(
      (errorReadings[0] as UnavailableSignalReading).error?.includes("simulated DOM exception"),
    );
    assert.equal(errorReadings[1]?.status, "error");

    const nonErrorProvider = new DeviceMemoryProvider({
      getEnvironment: () => {
        throw "custom string error";
      },
    });
    const nonErrorReadings = nonErrorProvider.read({ now: NOW, signal });
    assert.equal(nonErrorReadings[0]?.status, "error");
    assert.ok(
      (nonErrorReadings[0] as UnavailableSignalReading).error?.includes("custom string error"),
    );
  });

  it("handles getEnvironment returning undefined", () => {
    const provider = new DeviceMemoryProvider({
      getEnvironment: () => undefined,
    });
    const readings = provider.read({ now: NOW, signal });
    assert.equal(readings[0]?.status, "unsupported");
    assert.equal(readings[1]?.status, "unsupported");
  });

  it("validates deviceMemory values (unsupported, error, and ok)", () => {
    // Missing deviceMemory
    const undefProvider = new DeviceMemoryProvider({
      getEnvironment: () => ({ deviceMemory: undefined }),
    });
    assert.equal(undefProvider.read({ now: NOW, signal })[0]?.status, "unsupported");

    // Invalid: non-number
    const strProvider = new DeviceMemoryProvider({
      // @ts-expect-error invalid value
      getEnvironment: () => ({ deviceMemory: "8gb" }),
    });
    assert.equal(strProvider.read({ now: NOW, signal })[0]?.status, "error");

    // Invalid: NaN
    const nanProvider = new DeviceMemoryProvider({
      getEnvironment: () => ({ deviceMemory: Number.NaN }),
    });
    assert.equal(nanProvider.read({ now: NOW, signal })[0]?.status, "error");

    // Invalid: 0 or negative
    const zeroProvider = new DeviceMemoryProvider({
      getEnvironment: () => ({ deviceMemory: 0 }),
    });
    assert.equal(zeroProvider.read({ now: NOW, signal })[0]?.status, "error");

    const negProvider = new DeviceMemoryProvider({
      getEnvironment: () => ({ deviceMemory: -2 }),
    });
    assert.equal(negProvider.read({ now: NOW, signal })[0]?.status, "error");
  });

  it("validates performance.memory values (unsupported, error, and ok)", () => {
    // Missing memory
    const undefProvider = new DeviceMemoryProvider({
      getEnvironment: () => ({ memory: undefined }),
    });
    assert.equal(undefProvider.read({ now: NOW, signal })[1]?.status, "unsupported");

    // usedJSHeapSize < 0 or NaN or non-number
    const negUsedProvider = new DeviceMemoryProvider({
      getEnvironment: () => ({
        memory: { usedJSHeapSize: -10, jsHeapSizeLimit: 1000 },
      }),
    });
    assert.equal(negUsedProvider.read({ now: NOW, signal })[1]?.status, "error");

    const nanUsedProvider = new DeviceMemoryProvider({
      getEnvironment: () => ({
        memory: { usedJSHeapSize: Number.NaN, jsHeapSizeLimit: 1000 },
      }),
    });
    assert.equal(nanUsedProvider.read({ now: NOW, signal })[1]?.status, "error");

    const strUsedProvider = new DeviceMemoryProvider({
      // @ts-expect-error invalid memory metrics type
      getEnvironment: () => ({
        memory: { usedJSHeapSize: "100", jsHeapSizeLimit: 1000 },
      }),
    });
    assert.equal(strUsedProvider.read({ now: NOW, signal })[1]?.status, "error");

    // jsHeapSizeLimit <= 0 or NaN or non-number
    const zeroLimitProvider = new DeviceMemoryProvider({
      getEnvironment: () => ({
        memory: { usedJSHeapSize: 100, jsHeapSizeLimit: 0 },
      }),
    });
    assert.equal(zeroLimitProvider.read({ now: NOW, signal })[1]?.status, "error");

    const nanLimitProvider = new DeviceMemoryProvider({
      getEnvironment: () => ({
        memory: { usedJSHeapSize: 100, jsHeapSizeLimit: Number.NaN },
      }),
    });
    assert.equal(nanLimitProvider.read({ now: NOW, signal })[1]?.status, "error");

    const strLimitProvider = new DeviceMemoryProvider({
      // @ts-expect-error invalid memory metrics type
      getEnvironment: () => ({
        memory: { usedJSHeapSize: 100, jsHeapSizeLimit: "unlimited" },
      }),
    });
    assert.equal(strLimitProvider.read({ now: NOW, signal })[1]?.status, "error");

    // totalJSHeapSize defined but invalid (negative, NaN, non-number)
    const negTotalProvider = new DeviceMemoryProvider({
      getEnvironment: () => ({
        memory: { usedJSHeapSize: 100, totalJSHeapSize: -5, jsHeapSizeLimit: 1000 },
      }),
    });
    assert.equal(negTotalProvider.read({ now: NOW, signal })[1]?.status, "error");

    const nanTotalProvider = new DeviceMemoryProvider({
      getEnvironment: () => ({
        memory: { usedJSHeapSize: 100, totalJSHeapSize: Number.NaN, jsHeapSizeLimit: 1000 },
      }),
    });
    assert.equal(nanTotalProvider.read({ now: NOW, signal })[1]?.status, "error");

    const strTotalProvider = new DeviceMemoryProvider({
      // @ts-expect-error invalid memory metrics type
      getEnvironment: () => ({
        memory: { usedJSHeapSize: 100, totalJSHeapSize: "total", jsHeapSizeLimit: 1000 },
      }),
    });
    assert.equal(strTotalProvider.read({ now: NOW, signal })[1]?.status, "error");
  });

  it("handles memory: null or non-object memory as unsupported", () => {
    // memory: null
    const nullMemProvider = new DeviceMemoryProvider({
      getEnvironment: () => ({ memory: null as unknown as undefined }),
    });
    const nullReadings = nullMemProvider.read({ now: NOW, signal });
    assert.equal(nullReadings[1]?.status, "unsupported");
    assert.equal(
      (nullReadings[1] as UnavailableSignalReading).error,
      "performance.memory is not supported in this environment.",
    );

    // memory: null with valid deviceMemory
    const nullMemWithDevMem = new DeviceMemoryProvider({
      getEnvironment: () => ({ deviceMemory: 8, memory: null as unknown as undefined }),
    });
    const readings2 = nullMemWithDevMem.read({ now: NOW, signal });
    assert.equal((readings2[0] as AvailableSignalReading).status, "ok");
    assert.equal((readings2[0] as AvailableSignalReading).value, 8);
    assert.equal(readings2[1]?.status, "unsupported");

    // non-object memory (e.g. string primitive)
    const nonObjMemProvider = new DeviceMemoryProvider({
      getEnvironment: () => ({ memory: "not-an-object" as unknown as undefined }),
    });
    const nonObjReadings = nonObjMemProvider.read({ now: NOW, signal });
    assert.equal(nonObjReadings[1]?.status, "unsupported");
    assert.equal(
      (nonObjReadings[1] as UnavailableSignalReading).error,
      "performance.memory is not supported in this environment.",
    );
  });

  it("handles throwing property getters on environment", () => {
    // throwing getter on deviceMemory
    const throwingDevMemProvider = new DeviceMemoryProvider({
      getEnvironment: () => ({
        get deviceMemory(): number {
          throw new Error("SecurityError: deviceMemory access denied");
        },
      }),
    });
    const devMemReadings = throwingDevMemProvider.read({ now: NOW, signal });
    assert.equal(devMemReadings[0]?.status, "error");
    assert.ok(
      (devMemReadings[0] as UnavailableSignalReading).error?.includes(
        "SecurityError: deviceMemory access denied",
      ),
    );
    assert.equal(devMemReadings[1]?.status, "error");

    // throwing getter on memory
    const throwingMemProvider = new DeviceMemoryProvider({
      getEnvironment: () => ({
        get memory(): MemoryInfoLike {
          throw new Error("SecurityError: memory access denied");
        },
      }),
    });
    const memReadings = throwingMemProvider.read({ now: NOW, signal });
    assert.equal(memReadings[0]?.status, "error");
    assert.equal(memReadings[1]?.status, "error");
    assert.ok(
      (memReadings[1] as UnavailableSignalReading).error?.includes(
        "SecurityError: memory access denied",
      ),
    );

    // throwing getter inside memory object
    const throwingHeapProvider = new DeviceMemoryProvider({
      getEnvironment: () => ({
        memory: {
          get usedJSHeapSize(): number {
            throw new Error("HeapAccessError");
          },
          jsHeapSizeLimit: 1000,
        } as unknown as MemoryInfoLike,
      }),
    });
    const heapReadings = throwingHeapProvider.read({ now: NOW, signal });
    assert.equal(heapReadings[0]?.status, "error");
    assert.equal(heapReadings[1]?.status, "error");
    assert.ok((heapReadings[1] as UnavailableSignalReading).error?.includes("HeapAccessError"));
  });
});

describe("NetworkInformationProvider", () => {
  it("initializes with default options and signal descriptors", () => {
    const provider = new NetworkInformationProvider();
    assert.equal(provider.id, "web-network-information");
    assert.deepEqual(
      provider.signals.map((s) => [s.name, s.unit]),
      [
        [WEB_NETWORK_RTT_MS, "milliseconds"],
        [WEB_NETWORK_DOWNLINK_MBPS, "custom"],
        [WEB_NETWORK_SAVE_DATA, "count"],
      ],
    );

    // In Node test runner, navigator.connection is undefined
    const readings = provider.read({ now: NOW, signal });
    assert.equal(readings.length, 3);
    for (const r of readings) {
      assert.equal(r.status, "unsupported");
    }
  });

  it("accepts custom valid id and getConnection", () => {
    const provider = new NetworkInformationProvider({
      id: "custom-net-info",
      getConnection: () => ({
        rtt: 45,
        downlink: 12.5,
        saveData: false,
        effectiveType: "4g",
        type: "cellular",
      }),
    });
    assert.equal(provider.id, "custom-net-info");

    const readings = provider.read({ now: NOW, signal });
    assert.equal(readings.length, 3);

    const rtt = readings[0] as AvailableSignalReading;
    assert.equal(rtt.name, WEB_NETWORK_RTT_MS);
    assert.equal(rtt.status, "ok");
    assert.equal(rtt.value, 45);
    assert.equal(rtt.unit, "milliseconds");
    assert.equal(rtt.confidence, 1);
    assert.deepEqual(rtt.details, {
      effectiveType: "4g",
      type: "cellular",
      rtt: 45,
    });

    const downlink = readings[1] as AvailableSignalReading;
    assert.equal(downlink.name, WEB_NETWORK_DOWNLINK_MBPS);
    assert.equal(downlink.status, "ok");
    assert.equal(downlink.value, 12.5);
    assert.equal(downlink.unit, "custom");
    assert.deepEqual(downlink.details, {
      effectiveType: "4g",
      type: "cellular",
      downlink: 12.5,
    });

    const saveData = readings[2] as AvailableSignalReading;
    assert.equal(saveData.name, WEB_NETWORK_SAVE_DATA);
    assert.equal(saveData.status, "ok");
    assert.equal(saveData.value, 0);
    assert.equal(saveData.unit, "count");
    assert.deepEqual(saveData.details, {
      effectiveType: "4g",
      type: "cellular",
      saveData: false,
    });
  });

  it("handles saveData === true as 1", () => {
    const provider = new NetworkInformationProvider({
      getConnection: () => ({
        rtt: 100,
        downlink: 2.5,
        saveData: true,
      }),
    });
    const readings = provider.read({ now: NOW, signal });
    const saveData = readings[2] as AvailableSignalReading;
    assert.equal(saveData.status, "ok");
    assert.equal(saveData.value, 1);
  });

  it("validates id properly", () => {
    assert.throws(
      // @ts-expect-error invalid id
      () => new NetworkInformationProvider({ id: 123 }),
      ConfigurationError,
    );
    assert.throws(() => new NetworkInformationProvider({ id: "" }), ConfigurationError);
    assert.throws(() => new NetworkInformationProvider({ id: "   " }), ConfigurationError);
    assert.throws(() => new NetworkInformationProvider({ id: " net-info " }), ConfigurationError);
  });

  it("validates getConnection properly", () => {
    assert.throws(
      // @ts-expect-error invalid getConnection
      () => new NetworkInformationProvider({ getConnection: "not-a-func" }),
      ConfigurationError,
    );
  });

  it("handles provider close() lifecycle", () => {
    const provider = new NetworkInformationProvider({
      getConnection: () => ({ rtt: 50, downlink: 10, saveData: false }),
    });
    provider.close();
    const readings = provider.read({ now: NOW, signal });
    assert.equal(readings.length, 3);
    for (const r of readings) {
      assert.equal(r.status, "unsupported");
      assert.equal((r as UnavailableSignalReading).error, "Provider is closed.");
    }
  });

  it("handles getConnection throwing Error or non-Error", () => {
    const errProvider = new NetworkInformationProvider({
      getConnection: () => {
        throw new Error("connection read failure");
      },
    });
    const errReadings = errProvider.read({ now: NOW, signal });
    assert.equal(errReadings.length, 3);
    for (const r of errReadings) {
      assert.equal(r.status, "error");
      assert.ok((r as UnavailableSignalReading).error?.includes("connection read failure"));
    }

    const nonErrProvider = new NetworkInformationProvider({
      getConnection: () => {
        throw "string error";
      },
    });
    const nonErrReadings = nonErrProvider.read({ now: NOW, signal });
    assert.equal(nonErrReadings[0]?.status, "error");
    assert.ok((nonErrReadings[0] as UnavailableSignalReading).error?.includes("string error"));
  });

  it("handles null or undefined connection", () => {
    const undefProvider = new NetworkInformationProvider({
      getConnection: () => undefined,
    });
    const undefReadings = undefProvider.read({ now: NOW, signal });
    for (const r of undefReadings) {
      assert.equal(r.status, "unsupported");
    }

    const nullProvider = new NetworkInformationProvider({
      // @ts-expect-error null connection
      getConnection: () => null,
    });
    const nullReadings = nullProvider.read({ now: NOW, signal });
    for (const r of nullReadings) {
      assert.equal(r.status, "unsupported");
    }
  });

  it("handles missing or invalid fields on connection as unknown", () => {
    const provider = new NetworkInformationProvider({
      getConnection: () => ({
        // all undefined
      }),
    });
    const readings = provider.read({ now: NOW, signal });
    assert.equal(readings[0]?.status, "unknown");
    assert.equal(readings[1]?.status, "unknown");
    assert.equal(readings[2]?.status, "unknown");

    const invalidProvider = new NetworkInformationProvider({
      // @ts-expect-error invalid connection types
      getConnection: () => ({
        rtt: -10, // negative is invalid
        downlink: Number.NaN, // NaN is invalid
        saveData: "true", // non-boolean is invalid
        effectiveType: "3g",
      }),
    });
    const invReadings = invalidProvider.read({ now: NOW, signal });
    assert.equal(invReadings[0]?.status, "unknown");
    assert.equal(invReadings[1]?.status, "unknown");
    assert.equal(invReadings[2]?.status, "unknown");
    assert.deepEqual(invReadings[0]?.details, { effectiveType: "3g" });
  });

  it("handles rtt = 0 and downlink = 0 as valid readings", () => {
    const provider = new NetworkInformationProvider({
      getConnection: () => ({
        rtt: 0,
        downlink: 0,
        saveData: false,
      }),
    });
    const readings = provider.read({ now: NOW, signal });
    assert.equal((readings[0] as AvailableSignalReading).status, "ok");
    assert.equal((readings[0] as AvailableSignalReading).value, 0);
    assert.equal((readings[1] as AvailableSignalReading).status, "ok");
    assert.equal((readings[1] as AvailableSignalReading).value, 0);
  });

  it("handles throwing property getters on connection", () => {
    // throwing rtt getter
    const throwingRttProvider = new NetworkInformationProvider({
      getConnection: () => ({
        get rtt(): number {
          throw new Error("SecurityError: rtt access denied");
        },
      }),
    });
    const rttReadings = throwingRttProvider.read({ now: NOW, signal });
    assert.equal(rttReadings.length, 3);
    for (const r of rttReadings) {
      assert.equal(r.status, "error");
      assert.ok(
        (r as UnavailableSignalReading).error?.includes("SecurityError: rtt access denied"),
      );
    }

    // throwing downlink getter
    const throwingDownlinkProvider = new NetworkInformationProvider({
      getConnection: () => ({
        get downlink(): number {
          throw new Error("SecurityError: downlink access denied");
        },
      }),
    });
    const downlinkReadings = throwingDownlinkProvider.read({ now: NOW, signal });
    assert.equal(downlinkReadings[1]?.status, "error");
    assert.ok(
      (downlinkReadings[1] as UnavailableSignalReading).error?.includes(
        "SecurityError: downlink access denied",
      ),
    );

    // throwing saveData getter
    const throwingSaveDataProvider = new NetworkInformationProvider({
      getConnection: () => ({
        get saveData(): boolean {
          throw new Error("SecurityError: saveData access denied");
        },
      }),
    });
    const saveDataReadings = throwingSaveDataProvider.read({ now: NOW, signal });
    assert.equal(saveDataReadings[2]?.status, "error");
    assert.ok(
      (saveDataReadings[2] as UnavailableSignalReading).error?.includes(
        "SecurityError: saveData access denied",
      ),
    );

    // throwing effectiveType getter
    const throwingEffectiveTypeProvider = new NetworkInformationProvider({
      getConnection: () => ({
        get effectiveType(): string {
          throw new Error("SecurityError: effectiveType access denied");
        },
      }),
    });
    const effectiveTypeReadings = throwingEffectiveTypeProvider.read({ now: NOW, signal });
    assert.equal(effectiveTypeReadings[0]?.status, "error");
    assert.ok(
      (effectiveTypeReadings[0] as UnavailableSignalReading).error?.includes(
        "SecurityError: effectiveType access denied",
      ),
    );
  });
});

describe("FrameTimingProvider", () => {
  it("initializes with default options and signal descriptors", () => {
    const provider = new FrameTimingProvider();
    assert.equal(provider.id, "web-frame-timing");
    assert.deepEqual(
      provider.signals.map((s) => [s.name, s.unit]),
      [
        [WEB_FRAME_DURATION_P95_MS, "milliseconds"],
        [WEB_FRAME_DROPPED_RATIO, "ratio"],
      ],
    );

    // Initial read before minSamples recorded returns unknown
    const readings = provider.read({ now: NOW, signal });
    assert.equal(readings.length, 2);
    assert.equal(readings[0]?.status, "unknown");
    assert.ok(
      (readings[0] as UnavailableSignalReading).error?.includes(
        "Insufficient frame samples: have 0, require 3.",
      ),
    );
    assert.equal(readings[1]?.status, "unknown");
  });

  it("accepts custom valid id and options", () => {
    const provider = new FrameTimingProvider({
      id: "custom-frame-timing",
      targetFrameBudgetMs: 8.33,
      windowSize: 10,
      minSamples: 1,
    });
    assert.equal(provider.id, "custom-frame-timing");
    provider.recordFrameDuration(5);
    const readings = provider.read({ now: NOW, signal });
    assert.equal(readings[0]?.status, "ok");
    assert.equal(readings[1]?.status, "ok");
  });

  it("validates constructor options thoroughly", () => {
    // id
    assert.throws(
      // @ts-expect-error invalid id
      () => new FrameTimingProvider({ id: 123 }),
      ConfigurationError,
    );
    assert.throws(() => new FrameTimingProvider({ id: "" }), ConfigurationError);
    assert.throws(() => new FrameTimingProvider({ id: "  " }), ConfigurationError);
    assert.throws(() => new FrameTimingProvider({ id: " frame " }), ConfigurationError);

    // targetFrameBudgetMs
    assert.throws(() => new FrameTimingProvider({ targetFrameBudgetMs: 0 }), ConfigurationError);
    assert.throws(() => new FrameTimingProvider({ targetFrameBudgetMs: -1 }), ConfigurationError);
    assert.throws(
      () => new FrameTimingProvider({ targetFrameBudgetMs: Number.NaN }),
      ConfigurationError,
    );
    assert.throws(
      // @ts-expect-error invalid type
      () => new FrameTimingProvider({ targetFrameBudgetMs: "16" }),
      ConfigurationError,
    );

    // windowSize
    assert.throws(
      () => new FrameTimingProvider({ windowSize: 4 }), // < 5
      ConfigurationError,
    );
    assert.throws(
      () => new FrameTimingProvider({ windowSize: 5.5 }), // non-integer
      ConfigurationError,
    );
    assert.throws(() => new FrameTimingProvider({ windowSize: Number.NaN }), ConfigurationError);
    assert.throws(
      // @ts-expect-error invalid type
      () => new FrameTimingProvider({ windowSize: "60" }),
      ConfigurationError,
    );

    // minSamples
    assert.throws(
      () => new FrameTimingProvider({ minSamples: 0 }), // < 1
      ConfigurationError,
    );
    assert.throws(
      () => new FrameTimingProvider({ windowSize: 10, minSamples: 11 }), // > windowSize
      ConfigurationError,
    );
    assert.throws(
      () => new FrameTimingProvider({ minSamples: 2.5 }), // non-integer
      ConfigurationError,
    );
    assert.throws(() => new FrameTimingProvider({ minSamples: Number.NaN }), ConfigurationError);
    assert.throws(
      // @ts-expect-error invalid type
      () => new FrameTimingProvider({ minSamples: "3" }),
      ConfigurationError,
    );
  });

  it("validates recordFrameDuration inputs", () => {
    const provider = new FrameTimingProvider();
    assert.throws(() => provider.recordFrameDuration(-1), ConfigurationError);
    assert.throws(() => provider.recordFrameDuration(Number.NaN), ConfigurationError);
    assert.throws(
      // @ts-expect-error invalid input
      () => provider.recordFrameDuration("16"),
      ConfigurationError,
    );
  });

  it("calculates P95 and dropped frame ratio accurately", () => {
    const provider = new FrameTimingProvider({
      targetFrameBudgetMs: 16.67,
      windowSize: 10,
      minSamples: 5,
    });

    // Record 4 samples -> still insufficient (require 5)
    provider.recordFrameDuration(10);
    provider.recordFrameDuration(12);
    provider.recordFrameDuration(14);
    provider.recordFrameDuration(16);
    assert.equal(provider.read({ now: NOW, signal })[0]?.status, "unknown");

    // Record 5th sample: [10, 12, 14, 16, 20]
    // 5 * 0.95 = 4.75 -> ceil(4.75) - 1 = 4 -> index 4 is 20
    // Dropped frames (> 16.67): [20] -> 1/5 = 0.2
    provider.recordFrameDuration(20);

    const readings = provider.read({ now: NOW, signal });
    const p95 = readings[0] as AvailableSignalReading;
    assert.equal(p95.name, WEB_FRAME_DURATION_P95_MS);
    assert.equal(p95.status, "ok");
    assert.equal(p95.value, 20);
    assert.equal(p95.confidence, 1);
    assert.deepEqual(p95.details, {
      samples: 5,
      windowSize: 10,
      minSamples: 5,
      targetFrameBudgetMs: 16.67,
    });

    const dropped = readings[1] as AvailableSignalReading;
    assert.equal(dropped.name, WEB_FRAME_DROPPED_RATIO);
    assert.equal(dropped.status, "ok");
    assert.equal(dropped.value, 0.2);
    assert.deepEqual(dropped.details, {
      droppedCount: 1,
      totalCount: 5,
      targetFrameBudgetMs: 16.67,
    });
  });

  it("evicts oldest samples beyond windowSize", () => {
    const provider = new FrameTimingProvider({
      windowSize: 5,
      minSamples: 5,
      targetFrameBudgetMs: 16.67,
    });

    // Record 5 frames: [100, 10, 10, 10, 10]
    provider.recordFrameDuration(100);
    for (let i = 0; i < 4; i++) {
      provider.recordFrameDuration(10);
    }

    // Currently droppedCount = 1 (100 > 16.67)
    let readings = provider.read({ now: NOW, signal });
    assert.equal((readings[1] as AvailableSignalReading).value, 0.2);

    // Push 6th sample (12) -> evicts 100!
    // Remaining samples: [10, 10, 10, 10, 12]
    provider.recordFrameDuration(12);

    readings = provider.read({ now: NOW, signal });
    const p95 = readings[0] as AvailableSignalReading;
    assert.equal(p95.value, 12);

    const dropped = readings[1] as AvailableSignalReading;
    assert.equal(dropped.value, 0); // 0 dropped frames
  });

  it("clears samples properly", () => {
    const provider = new FrameTimingProvider({ minSamples: 3 });
    provider.recordFrameDuration(10);
    provider.recordFrameDuration(12);
    provider.recordFrameDuration(14);
    assert.equal(provider.read({ now: NOW, signal })[0]?.status, "ok");

    provider.clearSamples();
    assert.equal(provider.read({ now: NOW, signal })[0]?.status, "unknown");
  });

  it("handles close lifecycle and prevents subsequent operations", () => {
    const provider = new FrameTimingProvider({ minSamples: 3 });
    provider.recordFrameDuration(10);
    provider.recordFrameDuration(12);
    provider.recordFrameDuration(14);

    provider.close();

    // Read after close returns unsupported
    const readings = provider.read({ now: NOW, signal });
    assert.equal(readings.length, 2);
    assert.equal(readings[0]?.status, "unsupported");
    assert.equal((readings[0] as UnavailableSignalReading).error, "Provider is closed.");
    assert.equal(readings[1]?.status, "unsupported");

    // Record after close throws ConfigurationError
    assert.throws(() => provider.recordFrameDuration(16), ConfigurationError);
  });
});
