import { ConfigurationError } from "../errors/index.js";
import type {
  ResourceSignal,
  SignalDescriptor,
  SignalProvider,
  SignalReadContext,
} from "../types/signals.js";

export const PROCESS_MEMORY_HEAP_USED = "process.memory.heapUsed";
export const PROCESS_MEMORY_RSS = "process.memory.rss";

export type MemoryUsageSnapshot = Pick<NodeJS.MemoryUsage, "heapUsed" | "rss">;

export interface ProcessMemoryStats {
  readonly lastRssBytes: number | null;
  readonly lastHeapUsedBytes: number | null;
  readonly peakRssBytes: number | null;
  readonly peakHeapUsedBytes: number | null;
  readonly heapUtilizationRatio: number | null;
  readonly remainingHeapBytes: number | null;
}

export interface ProcessMemoryProviderOptions {
  readonly id?: string;
  readonly heapSignalName?: string;
  readonly rssSignalName?: string;
  /** Injection point for tests. Defaults to process.memoryUsage(). */
  readonly memoryUsage?: () => MemoryUsageSnapshot;
  /** Optional heap limit in bytes to calculate heap utilization ratio and headroom. */
  readonly heapLimitBytes?: number;
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

function validateSignalName(name: string | undefined, defaultName: string): string {
  if (name === undefined) {
    return defaultName;
  }
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new ConfigurationError("Signal name must be a non-empty string.");
  }
  if (name !== name.trim()) {
    throw new ConfigurationError("Signal name must not have leading or trailing whitespace.");
  }
  return name;
}

/**
 * Reports process-level heap and resident set size. These values describe this
 * Node.js process, not total system memory or memory pressure from other apps.
 */
export class ProcessMemoryProvider implements SignalProvider {
  readonly id: string;
  readonly signals: readonly SignalDescriptor[];
  readonly #heapSignalName: string;
  readonly #rssSignalName: string;
  readonly #memoryUsage: () => MemoryUsageSnapshot;
  readonly #heapLimitBytes?: number;
  #lastRssBytes: number | null = null;
  #lastHeapUsedBytes: number | null = null;
  #peakRssBytes: number | null = null;
  #peakHeapUsedBytes: number | null = null;
  #closed = false;

  constructor(options: ProcessMemoryProviderOptions = {}) {
    if (options === null || typeof options !== "object") {
      throw new ConfigurationError("ProcessMemoryProvider options must be an object.");
    }
    this.id = validateId(options.id, "process-memory");
    this.#heapSignalName = validateSignalName(options.heapSignalName, PROCESS_MEMORY_HEAP_USED);
    this.#rssSignalName = validateSignalName(options.rssSignalName, PROCESS_MEMORY_RSS);
    if (this.#heapSignalName === this.#rssSignalName) {
      throw new ConfigurationError("heapSignalName and rssSignalName must be distinct.");
    }
    if (options.memoryUsage !== undefined && typeof options.memoryUsage !== "function") {
      throw new ConfigurationError("ProcessMemoryProvider memoryUsage must be a function.");
    }
    if (
      options.heapLimitBytes !== undefined &&
      (typeof options.heapLimitBytes !== "number" ||
        !Number.isFinite(options.heapLimitBytes) ||
        options.heapLimitBytes <= 0)
    ) {
      throw new ConfigurationError("heapLimitBytes must be a positive finite number.");
    }
    this.#heapLimitBytes = options.heapLimitBytes;
    this.#memoryUsage = options.memoryUsage ?? (() => process.memoryUsage());
    this.signals = [
      {
        name: this.#heapSignalName,
        unit: "bytes" as const,
        description: "V8 heap used by this process (process.memoryUsage().heapUsed).",
      },
      {
        name: this.#rssSignalName,
        unit: "bytes" as const,
        description: "Resident set size of this process (process.memoryUsage().rss).",
      },
    ];
  }

  getMemoryStats(): ProcessMemoryStats {
    const heapUtilizationRatio =
      this.#heapLimitBytes !== undefined && this.#lastHeapUsedBytes !== null
        ? Math.min(1, this.#lastHeapUsedBytes / this.#heapLimitBytes)
        : null;
    const remainingHeapBytes =
      this.#heapLimitBytes !== undefined && this.#lastHeapUsedBytes !== null
        ? Math.max(0, this.#heapLimitBytes - this.#lastHeapUsedBytes)
        : null;

    return Object.freeze({
      lastRssBytes: this.#lastRssBytes,
      lastHeapUsedBytes: this.#lastHeapUsedBytes,
      peakRssBytes: this.#peakRssBytes,
      peakHeapUsedBytes: this.#peakHeapUsedBytes,
      heapUtilizationRatio,
      remainingHeapBytes,
    });
  }

  close(): void {
    this.#closed = true;
  }

  read(context: SignalReadContext): readonly ResourceSignal[] {
    if (this.#closed) {
      return [
        {
          name: this.#heapSignalName,
          unit: "bytes",
          status: "unsupported",
          observedAt: context.now,
          error: "Provider is closed.",
        },
        {
          name: this.#rssSignalName,
          unit: "bytes",
          status: "unsupported",
          observedAt: context.now,
          error: "Provider is closed.",
        },
      ];
    }
    const usage = this.#memoryUsage();
    this.#lastHeapUsedBytes = usage.heapUsed;
    this.#lastRssBytes = usage.rss;
    if (this.#peakHeapUsedBytes === null || usage.heapUsed > this.#peakHeapUsedBytes) {
      this.#peakHeapUsedBytes = usage.heapUsed;
    }
    if (this.#peakRssBytes === null || usage.rss > this.#peakRssBytes) {
      this.#peakRssBytes = usage.rss;
    }

    const heapDetails: Record<string, unknown> = {};
    if (this.#heapLimitBytes !== undefined) {
      heapDetails.heapLimitBytes = this.#heapLimitBytes;
      heapDetails.heapUtilizationRatio = Math.min(1, usage.heapUsed / this.#heapLimitBytes);
      heapDetails.remainingHeapBytes = Math.max(0, this.#heapLimitBytes - usage.heapUsed);
    }

    return [
      {
        name: this.#heapSignalName,
        unit: "bytes",
        status: "ok",
        value: usage.heapUsed,
        observedAt: context.now,
        confidence: 1,
        ...(this.#heapLimitBytes !== undefined ? { details: heapDetails } : {}),
      },
      {
        name: this.#rssSignalName,
        unit: "bytes",
        status: "ok",
        value: usage.rss,
        observedAt: context.now,
        confidence: 1,
      },
    ];
  }
}
