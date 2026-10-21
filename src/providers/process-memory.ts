import type { ResourceSignal, SignalProvider, SignalReadContext } from "../types/signals.js";

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

/**
 * Reports process-level heap and resident set size. These values describe this
 * Node.js process, not total system memory or memory pressure from other apps.
 */
export class ProcessMemoryProvider implements SignalProvider {
  readonly id: string;
  readonly signals;
  readonly #heapSignalName: string;
  readonly #rssSignalName: string;
  readonly #memoryUsage: () => MemoryUsageSnapshot;

  constructor(options: ProcessMemoryProviderOptions = {}) {
    this.id = options.id ?? "process-memory";
    this.#heapSignalName = options.heapSignalName ?? PROCESS_MEMORY_HEAP_USED;
    this.#rssSignalName = options.rssSignalName ?? PROCESS_MEMORY_RSS;
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

  read(context: SignalReadContext): readonly ResourceSignal[] {
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
