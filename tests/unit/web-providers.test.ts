import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigurationError } from "../../src/errors/index.js";
import {
  ComputePressureProvider,
  type ComputePressureProviderOptions,
  type ComputePressureRecordLike,
  type ComputePressureState,
  WEB_COMPUTE_PRESSURE,
} from "../../src/providers/web/compute-pressure.js";
import {
  DeviceMemoryProvider,
  type MemoryInfoLike,
  WEB_DEVICE_MEMORY_GIB,
  WEB_JS_HEAP_USED_RATIO,
} from "../../src/providers/web/device-memory.js";
import {
  FrameTimingProvider,
  type FrameTimingStats,
  WEB_FRAME_DROPPED_RATIO,
  WEB_FRAME_DURATION_P95_MS,
} from "../../src/providers/web/frame-timing.js";
import {
  NetworkInformationProvider,
  WEB_NETWORK_DOWNLINK_MBPS,
  WEB_NETWORK_RTT_MS,
  WEB_NETWORK_SAVE_DATA,
} from "../../src/providers/web/network-info.js";
import { createFakeClock } from "../../src/testing/index.js";
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

  it("validates saveDataPenaltyRttMs option thoroughly", () => {
    assert.throws(
      // @ts-expect-error invalid saveDataPenaltyRttMs type
      () => new NetworkInformationProvider({ saveDataPenaltyRttMs: "100" }),
      ConfigurationError,
    );
    assert.throws(
      () => new NetworkInformationProvider({ saveDataPenaltyRttMs: -1 }),
      ConfigurationError,
    );
    assert.throws(
      () => new NetworkInformationProvider({ saveDataPenaltyRttMs: Number.NaN }),
      ConfigurationError,
    );
    assert.throws(
      () => new NetworkInformationProvider({ saveDataPenaltyRttMs: Number.POSITIVE_INFINITY }),
      ConfigurationError,
    );

    // 0 and positive numbers are valid
    const zeroPenalty = new NetworkInformationProvider({ saveDataPenaltyRttMs: 0 });
    assert.equal(zeroPenalty.id, "web-network-information");
    const positivePenalty = new NetworkInformationProvider({ saveDataPenaltyRttMs: 150 });
    assert.equal(positivePenalty.id, "web-network-information");
  });

  it("applies saveDataPenaltyRttMs when saveData is true and penalty is configured", () => {
    const provider = new NetworkInformationProvider({
      saveDataPenaltyRttMs: 150,
      getConnection: () => ({
        rtt: 40,
        downlink: 5,
        saveData: true,
        effectiveType: "4g",
      }),
    });

    const readings = provider.read({ now: NOW, signal });
    const rttReading = readings[0] as AvailableSignalReading;
    assert.equal(rttReading.name, WEB_NETWORK_RTT_MS);
    assert.equal(rttReading.status, "ok");
    assert.equal(rttReading.value, 190); // 40 + 150
    assert.equal(rttReading.details?.rtt, 40);
    assert.equal(rttReading.details?.rawRtt, 40);
    assert.equal(rttReading.details?.saveDataPenaltyRttMs, 150);
    assert.equal(rttReading.details?.effectiveRtt, 190);

    // saveData reading itself remains 1
    const saveDataReading = readings[2] as AvailableSignalReading;
    assert.equal(saveDataReading.value, 1);
  });

  it("does not apply saveDataPenaltyRttMs when saveData is false", () => {
    const provider = new NetworkInformationProvider({
      saveDataPenaltyRttMs: 150,
      getConnection: () => ({
        rtt: 40,
        downlink: 5,
        saveData: false,
        effectiveType: "4g",
      }),
    });

    const readings = provider.read({ now: NOW, signal });
    const rttReading = readings[0] as AvailableSignalReading;
    assert.equal(rttReading.status, "ok");
    assert.equal(rttReading.value, 40); // No penalty added
    assert.equal(rttReading.details?.rtt, 40);
    assert.equal(rttReading.details?.rawRtt, undefined);
  });

  it("does not apply penalty when saveData is true but saveDataPenaltyRttMs is omitted", () => {
    const provider = new NetworkInformationProvider({
      getConnection: () => ({
        rtt: 40,
        downlink: 5,
        saveData: true,
      }),
    });

    const readings = provider.read({ now: NOW, signal });
    const rttReading = readings[0] as AvailableSignalReading;
    assert.equal(rttReading.status, "ok");
    assert.equal(rttReading.value, 40);
  });

  it("preserves unknown status when connection.rtt is invalid even with saveData penalty", () => {
    const provider = new NetworkInformationProvider({
      saveDataPenaltyRttMs: 100,
      getConnection: () => ({
        rtt: undefined,
        saveData: true,
      }),
    });

    const readings = provider.read({ now: NOW, signal });
    assert.equal(readings[0]?.status, "unknown");
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

  it("validates droppedFrameThresholdMs and targetFrameDurationMs options thoroughly", () => {
    // Non-number / invalid types
    assert.throws(
      // @ts-expect-error invalid type
      () => new FrameTimingProvider({ droppedFrameThresholdMs: "50" }),
      ConfigurationError,
    );
    assert.throws(
      () => new FrameTimingProvider({ droppedFrameThresholdMs: Number.NaN }),
      ConfigurationError,
    );
    assert.throws(
      () => new FrameTimingProvider({ droppedFrameThresholdMs: Number.POSITIVE_INFINITY }),
      ConfigurationError,
    );
    assert.throws(
      () => new FrameTimingProvider({ droppedFrameThresholdMs: -10 }),
      ConfigurationError,
    );

    // droppedFrameThresholdMs <= targetFrameBudgetMs (default 16.67)
    assert.throws(
      () => new FrameTimingProvider({ droppedFrameThresholdMs: 16.67 }),
      ConfigurationError,
    );
    assert.throws(
      () => new FrameTimingProvider({ droppedFrameThresholdMs: 10 }),
      ConfigurationError,
    );

    // Target frame budget >= 50 causes default droppedFrameThresholdMs (50) to fail validation
    assert.throws(() => new FrameTimingProvider({ targetFrameBudgetMs: 50 }), ConfigurationError);
    assert.throws(() => new FrameTimingProvider({ targetFrameBudgetMs: 60 }), ConfigurationError);

    // Unless explicit droppedFrameThresholdMs > targetFrameBudgetMs is provided
    const validWide = new FrameTimingProvider({
      targetFrameBudgetMs: 60,
      droppedFrameThresholdMs: 120,
    });
    assert.equal(validWide.id, "web-frame-timing");

    // targetFrameDurationMs validation and aliasing
    assert.throws(() => new FrameTimingProvider({ targetFrameDurationMs: 0 }), ConfigurationError);
    assert.throws(() => new FrameTimingProvider({ targetFrameDurationMs: -5 }), ConfigurationError);
    assert.throws(
      () =>
        new FrameTimingProvider({
          targetFrameBudgetMs: 16.67,
          targetFrameDurationMs: 8.33,
        }),
      ConfigurationError,
    );

    const aliasProvider = new FrameTimingProvider({
      targetFrameDurationMs: 8.33,
      droppedFrameThresholdMs: 25,
    });
    assert.equal(aliasProvider.id, "web-frame-timing");
  });

  it("exposes frozen, non-disturbing getFrameStats()", () => {
    const provider = new FrameTimingProvider({
      targetFrameBudgetMs: 16.67,
      droppedFrameThresholdMs: 50,
      minSamples: 3,
    });

    // Initial stats before any samples
    const initialStats: FrameTimingStats = provider.getFrameStats();
    assert.ok(Object.isFrozen(initialStats));
    assert.deepEqual(initialStats, {
      sampleCount: 0,
      droppedFrames: 0,
      maxFrameDurationMs: null,
      running: true,
    });

    // Record samples: [12, 16, 25, 55, 60]
    provider.recordFrameDuration(12);
    provider.recordFrameDuration(16);
    provider.recordFrameDuration(25);
    provider.recordFrameDuration(55);
    provider.recordFrameDuration(60);

    const stats: FrameTimingStats = provider.getFrameStats();
    assert.ok(Object.isFrozen(stats));
    assert.equal(stats.sampleCount, 5);
    // 55 and 60 exceed droppedFrameThresholdMs (50)
    assert.equal(stats.droppedFrames, 2);
    assert.equal(stats.maxFrameDurationMs, 60);
    assert.equal(stats.running, true);

    // Calling getFrameStats() multiple times is completely non-disturbing
    const stats2 = provider.getFrameStats();
    assert.deepEqual(stats, stats2);

    // read() still works without disturbance
    const readings = provider.read({ now: NOW, signal });
    assert.equal(readings[0]?.status, "ok");
  });

  it("supports resetSamples() to clear sliding window without stopping RAF loop", () => {
    const provider = new FrameTimingProvider({
      targetFrameBudgetMs: 16.67,
      droppedFrameThresholdMs: 50,
      minSamples: 3,
    });

    provider.recordFrameDuration(10);
    provider.recordFrameDuration(20);
    provider.recordFrameDuration(65);

    let stats = provider.getFrameStats();
    assert.equal(stats.sampleCount, 3);
    assert.equal(stats.droppedFrames, 1);
    assert.equal(stats.maxFrameDurationMs, 65);
    assert.equal(stats.running, true);

    // Reset samples
    provider.resetSamples();

    stats = provider.getFrameStats();
    assert.deepEqual(stats, {
      sampleCount: 0,
      droppedFrames: 0,
      maxFrameDurationMs: null,
      running: true, // running remains true!
    });

    // Provider read now reports unknown due to insufficient samples
    const readings = provider.read({ now: NOW, signal });
    assert.equal(readings[0]?.status, "unknown");

    // Can record fresh samples normally
    provider.recordFrameDuration(14);
    assert.equal(provider.getFrameStats().sampleCount, 1);
    assert.equal(provider.getFrameStats().maxFrameDurationMs, 14);
  });

  it("reports running: false in getFrameStats() after close", () => {
    const provider = new FrameTimingProvider({ minSamples: 1 });
    provider.recordFrameDuration(30);
    assert.equal(provider.getFrameStats().running, true);

    provider.close();
    const stats = provider.getFrameStats();
    assert.deepEqual(stats, {
      sampleCount: 0,
      droppedFrames: 0,
      maxFrameDurationMs: null,
      running: false,
    });
  });
});

describe("ComputePressureProvider", () => {
  class FakePressureObserver {
    static readonly instances: FakePressureObserver[] = [];
    readonly callback: (records: readonly ComputePressureRecordLike[]) => void;
    readonly observed: Array<{ source: string; options?: { sampleInterval?: number } }> = [];
    disconnected = false;

    constructor(callback: (records: readonly ComputePressureRecordLike[]) => void) {
      this.callback = callback;
      FakePressureObserver.instances.push(this);
    }

    observe(source: string, options?: { sampleInterval?: number }): void {
      this.observed.push({
        source,
        ...(options === undefined ? {} : { options }),
      });
    }

    unobserve(): void {}

    disconnect(): void {
      this.disconnected = true;
    }

    emit(records: readonly ComputePressureRecordLike[]): void {
      this.callback(records);
    }
  }

  function record(state: ComputePressureState): ComputePressureRecordLike {
    return { source: "cpu", state, time: NOW };
  }

  it("reports unknown until a valid pressure state is observed", async () => {
    FakePressureObserver.instances.length = 0;
    const provider = new ComputePressureProvider({
      pressureObserverFactory: FakePressureObserver,
      sampleIntervalMs: 500,
      source: "gpu",
    });
    assert.equal(provider.id, "compute-pressure");
    assert.equal(provider.signals[0]?.name, WEB_COMPUTE_PRESSURE);
    assert.equal(provider.signals[0]?.unit, "ratio");

    assert.equal(provider.read({ now: NOW, signal })[0]?.status, "unknown");
    await provider.start();
    await provider.start();
    assert.equal(FakePressureObserver.instances.length, 1);
    const observer = FakePressureObserver.instances[0];
    assert.ok(observer);
    assert.deepEqual(observer.observed, [{ source: "gpu", options: { sampleInterval: 500 } }]);

    observer.emit([
      record("nominal"),
      { source: "cpu", state: "bogus" as ComputePressureState, time: NOW },
    ]);
    const reading = provider.read({ now: NOW + 1, signal })[0];
    assert.equal(reading?.status, "ok");
    if (reading?.status !== "ok") {
      throw new Error("expected ok reading");
    }
    assert.equal(reading.value, 0.25);
    assert.deepEqual(reading.details, {
      source: "gpu",
      state: "nominal",
      scale: "w3c-compute-pressure",
    });

    observer.emit([record("serious")]);
    assert.equal(provider.read({ now: NOW + 2, signal })[0]?.status, "ok");
    provider.recordPressureState("critical");
    const critical = provider.read({ now: NOW + 3, signal })[0];
    assert.equal(critical?.status, "ok");
    if (critical?.status !== "ok") {
      throw new Error("expected ok reading");
    }
    assert.equal(critical.value, 1);

    assert.throws(
      () => provider.recordPressureState("bogus" as ComputePressureState),
      ConfigurationError,
    );
    provider.close();
    assert.equal(observer.disconnected, true);
    assert.equal(provider.read({ now: NOW + 4, signal })[0]?.status, "unsupported");
    provider.recordPressureState("nominal");
    assert.equal(provider.read({ now: NOW + 5, signal })[0]?.status, "unsupported");
  });

  it("handles start failures, missing factories, and non-array callback records", async () => {
    class ThrowingObserver extends FakePressureObserver {
      override observe(): void {
        throw new Error("observe failed");
      }
    }

    const failing = new ComputePressureProvider({ pressureObserverFactory: ThrowingObserver });
    await assert.rejects(() => failing.start(), /observe failed/);
    assert.equal(ThrowingObserver.instances.at(-1)?.disconnected, true);
    assert.equal(failing.read({ now: NOW, signal })[0]?.status, "unknown");

    const noFactory = new ComputePressureProvider();
    await noFactory.start();
    assert.equal(noFactory.read({ now: NOW, signal })[0]?.status, "unknown");

    FakePressureObserver.instances.length = 0;
    const provider = new ComputePressureProvider({
      pressureObserverFactory: FakePressureObserver,
    });
    await provider.start();
    const observer = FakePressureObserver.instances[0];
    assert.ok(observer);
    observer.emit(null as unknown as readonly ComputePressureRecordLike[]);
    assert.equal(provider.read({ now: NOW, signal })[0]?.status, "unknown");

    const saved = (globalThis as { PressureObserver?: unknown }).PressureObserver;
    try {
      (globalThis as { PressureObserver?: unknown }).PressureObserver = FakePressureObserver;
      const globalProvider = new ComputePressureProvider();
      await globalProvider.start();
      assert.equal(FakePressureObserver.instances.length, 2);
      globalProvider.close();
    } finally {
      (globalThis as { PressureObserver?: unknown }).PressureObserver = saved;
    }
  });

  it("validates constructor options and pressure states", () => {
    const invalidIds = ["", "   ", " padded", "padded ", 123, null];
    for (const id of invalidIds) {
      assert.throws(
        () => new ComputePressureProvider({ id: id as unknown as string }),
        ConfigurationError,
      );
    }
    assert.throws(
      () => new ComputePressureProvider(null as unknown as ComputePressureProviderOptions),
      ConfigurationError,
    );
    assert.throws(() => new ComputePressureProvider({ signalName: "" }), ConfigurationError);
    assert.throws(
      () => new ComputePressureProvider({ signalName: " padded.signal " }),
      ConfigurationError,
    );
    assert.throws(() => new ComputePressureProvider({ source: "" }), ConfigurationError);
    assert.throws(() => new ComputePressureProvider({ source: " padded " }), ConfigurationError);
    assert.throws(() => new ComputePressureProvider({ sampleIntervalMs: 0 }), ConfigurationError);
    assert.throws(
      () => new ComputePressureProvider({ sampleIntervalMs: Number.NaN }),
      ConfigurationError,
    );
    assert.throws(
      () =>
        new ComputePressureProvider({
          pressureObserverFactory: 123 as unknown as typeof FakePressureObserver,
        }),
      ConfigurationError,
    );
  });

  it("exposes getLastState() reflecting state lifecycle", async () => {
    FakePressureObserver.instances.length = 0;
    const provider = new ComputePressureProvider({
      pressureObserverFactory: FakePressureObserver,
    });

    // 1. Returns null initially
    assert.equal(provider.getLastState(), null);

    // 2. Reflects state recorded via recordPressureState
    provider.recordPressureState("fair");
    assert.equal(provider.getLastState(), "fair");

    // 3. Reflects state emitted by observer
    await provider.start();
    const observer = FakePressureObserver.instances[0];
    assert.ok(observer);
    observer.emit([{ source: "cpu", state: "serious", time: NOW }]);
    assert.equal(provider.getLastState(), "serious");

    // 4. Preserves last state after close
    provider.close();
    assert.equal(provider.getLastState(), "serious");
  });

  it("validates maxSampleAgeMs and clock options", () => {
    assert.throws(() => new ComputePressureProvider({ maxSampleAgeMs: 0 }), ConfigurationError);
    assert.throws(() => new ComputePressureProvider({ maxSampleAgeMs: -50 }), ConfigurationError);
    assert.throws(
      () => new ComputePressureProvider({ maxSampleAgeMs: Number.NaN }),
      ConfigurationError,
    );
    assert.throws(
      () => new ComputePressureProvider({ maxSampleAgeMs: Number.POSITIVE_INFINITY }),
      ConfigurationError,
    );
    assert.throws(
      // @ts-expect-error invalid type
      () => new ComputePressureProvider({ maxSampleAgeMs: "5000" }),
      ConfigurationError,
    );

    // clock validation
    assert.throws(
      // @ts-expect-error invalid clock type
      () => new ComputePressureProvider({ clock: "system" }),
      ConfigurationError,
    );
    assert.throws(
      // @ts-expect-error invalid clock missing now()
      () => new ComputePressureProvider({ clock: {} }),
      ConfigurationError,
    );

    // sampleTime validation on recordPressureState
    const provider = new ComputePressureProvider();
    assert.throws(() => provider.recordPressureState("nominal", -1), ConfigurationError);
    assert.throws(() => provider.recordPressureState("nominal", Number.NaN), ConfigurationError);
    assert.throws(
      // @ts-expect-error invalid sampleTime type
      () => provider.recordPressureState("nominal", "1000"),
      ConfigurationError,
    );
  });

  it("detects stale pressure readings via maxSampleAgeMs and reports unavailable with reason stale_pressure_sample", () => {
    const clock = createFakeClock(1_000_000);
    const provider = new ComputePressureProvider({
      maxSampleAgeMs: 2000,
      clock,
    });

    // Record sample at t = 1_000_000
    provider.recordPressureState("nominal");
    assert.equal(provider.getLastState(), "nominal");

    // Read within maxSampleAgeMs (elapsed = 1500 <= 2000)
    clock.advance(1500);
    const freshReadings = provider.read({ now: clock.now(), signal });
    assert.equal(freshReadings.length, 1);
    const fresh = freshReadings[0] as AvailableSignalReading;
    assert.equal(fresh.status, "ok");
    assert.equal(fresh.value, 0.25);

    // Advance clock past maxSampleAgeMs (elapsed = 2500 > 2000)
    clock.advance(1000); // now = 1_002_500
    const staleReadings = provider.read({ now: clock.now(), signal });
    assert.equal(staleReadings.length, 1);
    const stale = staleReadings[0] as unknown as Record<string, unknown>;
    assert.equal(stale.status, "unavailable");
    assert.equal(stale.value, null);
    assert.equal(stale.reason, "stale_pressure_sample");
    assert.equal(stale.error, "stale_pressure_sample");
    assert.equal((stale.details as Record<string, unknown>)?.reason, "stale_pressure_sample");
    assert.equal((stale.details as Record<string, unknown>)?.sampleAgeMs, 2500);

    // getLastState() still returns the last observed state even when stale!
    assert.equal(provider.getLastState(), "nominal");

    // Recording fresh sample at now restores status ok
    provider.recordPressureState("critical");
    const restoredReadings = provider.read({ now: clock.now(), signal });
    const restored = restoredReadings[0] as AvailableSignalReading;
    assert.equal(restored.status, "ok");
    assert.equal(restored.value, 1);
    assert.equal(provider.getLastState(), "critical");
  });

  it("reports stale readings when PressureObserver records age past maxSampleAgeMs", async () => {
    FakePressureObserver.instances.length = 0;
    const provider = new ComputePressureProvider({
      maxSampleAgeMs: 500,
      pressureObserverFactory: FakePressureObserver,
    });

    await provider.start();
    const observer = FakePressureObserver.instances[0];
    assert.ok(observer);

    // Observer emits record with time = NOW
    observer.emit([{ source: "cpu", state: "fair", time: NOW }]);

    // Read at NOW + 300 (age = 300 <= 500) -> fresh ok
    const fresh = provider.read({ now: NOW + 300, signal })[0] as AvailableSignalReading;
    assert.equal(fresh.status, "ok");
    assert.equal(fresh.value, 0.5);

    // Read at NOW + 600 (age = 600 > 500) -> stale unavailable
    const stale = provider.read({ now: NOW + 600, signal })[0] as unknown as Record<
      string,
      unknown
    >;
    assert.equal(stale.status, "unavailable");
    assert.equal(stale.value, null);
    assert.equal(stale.reason, "stale_pressure_sample");
  });

  it("does not enforce staleness when maxSampleAgeMs is not configured", () => {
    const clock = createFakeClock(1_000_000);
    const provider = new ComputePressureProvider({ clock });

    provider.recordPressureState("serious");
    clock.advance(100_000); // 100 seconds later!

    const reading = provider.read({ now: clock.now(), signal })[0] as AvailableSignalReading;
    assert.equal(reading.status, "ok");
    assert.equal(reading.value, 0.75);
  });
});
