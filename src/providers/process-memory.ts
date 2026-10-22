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

export interface ProcessMemoryProviderOptions {
  readonly id?: string;
  readonly heapSignalName?: string;
  readonly rssSignalName?: string;
  /** Injection point for tests. Defaults to process.memoryUsage(). */
  readonly memoryUsage?: () => MemoryUsageSnapshot;
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
    return [
      {
        name: this.#heapSignalName,
        unit: "bytes",
        status: "ok",
        value: usage.heapUsed,
        observedAt: context.now,
        confidence: 1,
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
