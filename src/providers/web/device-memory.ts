import { ConfigurationError } from "../../errors/index.js";
import type {
  ResourceSignal,
  SignalDescriptor,
  SignalProvider,
  SignalReadContext,
} from "../../types/signals.js";
import { errorMessage } from "../../utils/errors.js";

export const WEB_DEVICE_MEMORY_GIB = "web.device.memoryGib";
export const WEB_JS_HEAP_USED_RATIO = "web.jsHeap.usedRatio";

export interface MemoryInfoLike {
  readonly usedJSHeapSize: number;
  readonly totalJSHeapSize?: number;
  readonly jsHeapSizeLimit: number;
}

export interface DeviceMemoryEnvironmentLike {
  readonly deviceMemory?: number;
  readonly memory?: MemoryInfoLike;
}

export interface DeviceMemoryProviderOptions {
  readonly id?: string;
  readonly getEnvironment?: () => DeviceMemoryEnvironmentLike | undefined;
}

function validateId(id: string | undefined, defaultId: string): string {
  if (id === undefined) {
    return defaultId;
  }
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new ConfigurationError("Provider id must be a non-empty string.");
  }
  if (id !== id.trim()) {
    throw new ConfigurationError("Provider id must not have leading or trailing whitespace.");
  }
  return id;
}

/**
 * Provides client device memory estimation and JavaScript heap memory usage ratio
 * in web browser environments via structural duck-typing.
 */
export class DeviceMemoryProvider implements SignalProvider {
  readonly id: string;
  readonly signals: readonly SignalDescriptor[];
  readonly #getEnvironment: () => DeviceMemoryEnvironmentLike | undefined;
  #closed = false;

  constructor(options: DeviceMemoryProviderOptions = {}) {
    this.id = validateId(options.id, "web-device-memory");
    if (options.getEnvironment !== undefined && typeof options.getEnvironment !== "function") {
      throw new ConfigurationError("DeviceMemoryProvider getEnvironment must be a function.");
    }
    this.#getEnvironment =
      options.getEnvironment ??
      (() => {
        const g = globalThis as unknown as {
          navigator?: { deviceMemory?: number };
          performance?: { memory?: MemoryInfoLike };
        };
        return {
          deviceMemory: g.navigator?.deviceMemory,
          memory: g.performance?.memory,
        };
      });

    this.signals = [
      {
        name: WEB_DEVICE_MEMORY_GIB,
        unit: "custom",
        description: "Client device RAM approximation in GiB from navigator.deviceMemory.",
      },
      {
        name: WEB_JS_HEAP_USED_RATIO,
        unit: "ratio",
        description: "Used JS heap size divided by jsHeapSizeLimit from performance.memory.",
      },
    ];
  }

  read(context: SignalReadContext): readonly ResourceSignal[] {
    const observedAt = context.now;

    if (this.#closed) {
      return [
        {
          name: WEB_DEVICE_MEMORY_GIB,
          unit: "custom",
          status: "unsupported",
          observedAt,
          error: "Provider is closed.",
        },
        {
          name: WEB_JS_HEAP_USED_RATIO,
          unit: "ratio",
          status: "unsupported",
          observedAt,
          error: "Provider is closed.",
        },
      ];
    }

    try {
      const env = this.#getEnvironment();
      const readings: ResourceSignal[] = [];

      // 1. WEB_DEVICE_MEMORY_GIB
      const deviceMemory = env?.deviceMemory;
      if (deviceMemory === undefined) {
        readings.push({
          name: WEB_DEVICE_MEMORY_GIB,
          unit: "custom",
          status: "unsupported",
          observedAt,
          error: "navigator.deviceMemory is not supported in this environment.",
        });
      } else if (
        typeof deviceMemory !== "number" ||
        !Number.isFinite(deviceMemory) ||
        deviceMemory <= 0
      ) {
        readings.push({
          name: WEB_DEVICE_MEMORY_GIB,
          unit: "custom",
          status: "error",
          observedAt,
          error: `navigator.deviceMemory must be a positive finite number, received ${String(deviceMemory)}.`,
        });
      } else {
        readings.push({
          name: WEB_DEVICE_MEMORY_GIB,
          unit: "custom",
          status: "ok",
          value: deviceMemory,
          observedAt,
          confidence: 1,
          details: { deviceMemory },
        });
      }

      // 2. WEB_JS_HEAP_USED_RATIO
      const memory = env?.memory;
      if (memory === undefined || memory === null || typeof memory !== "object") {
        readings.push({
          name: WEB_JS_HEAP_USED_RATIO,
          unit: "ratio",
          status: "unsupported",
          observedAt,
          error: "performance.memory is not supported in this environment.",
        });
      } else {
        const { usedJSHeapSize, totalJSHeapSize, jsHeapSizeLimit } = memory;
        const isValid =
          typeof usedJSHeapSize === "number" &&
          Number.isFinite(usedJSHeapSize) &&
          usedJSHeapSize >= 0 &&
          typeof jsHeapSizeLimit === "number" &&
          Number.isFinite(jsHeapSizeLimit) &&
          jsHeapSizeLimit > 0 &&
          (totalJSHeapSize === undefined ||
            (typeof totalJSHeapSize === "number" &&
              Number.isFinite(totalJSHeapSize) &&
              totalJSHeapSize >= 0));

        if (!isValid) {
          readings.push({
            name: WEB_JS_HEAP_USED_RATIO,
            unit: "ratio",
            status: "error",
            observedAt,
            error: "performance.memory contains invalid heap metric values.",
          });
        } else {
          const ratio = usedJSHeapSize / jsHeapSizeLimit;
          readings.push({
            name: WEB_JS_HEAP_USED_RATIO,
            unit: "ratio",
            status: "ok",
            value: ratio,
            observedAt,
            confidence: 1,
            details: {
              usedJSHeapSize,
              ...(totalJSHeapSize !== undefined ? { totalJSHeapSize } : {}),
              jsHeapSizeLimit,
            },
          });
        }
      }

      return readings;
    } catch (err) {
      const msg = errorMessage(err);
      return [
        {
          name: WEB_DEVICE_MEMORY_GIB,
          unit: "custom",
          status: "error",
          observedAt,
          error: `Failed to read device memory environment: ${msg}`,
        },
        {
          name: WEB_JS_HEAP_USED_RATIO,
          unit: "ratio",
          status: "error",
          observedAt,
          error: `Failed to read device memory environment: ${msg}`,
        },
      ];
    }
  }

  close(): void {
    this.#closed = true;
  }
}
