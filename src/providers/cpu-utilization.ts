import { ConfigurationError } from "../errors/index.js";
import type {
  ResourceSignal,
  SignalDescriptor,
  SignalProvider,
  SignalReadContext,
} from "../types/signals.js";

export const PROCESS_CPU_UTILIZATION = "process.cpu.utilization";

export interface CpuUsageSnapshot {
  readonly user: number;
  readonly system: number;
}

export interface CpuUtilizationProviderOptions {
  readonly id?: string;
  readonly signalName?: string;
  /** Injection point for tests. Defaults to process.cpuUsage(). */
  readonly cpuUsage?: () => CpuUsageSnapshot;
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
 * Measures process CPU time between reads. The returned ratio is relative to
 * one CPU core of wall time, so it can exceed 1 for multi-threaded work. The
 * first read establishes a baseline and is reported as "unknown", never as 0.
 */
export class CpuUtilizationProvider implements SignalProvider {
  readonly id: string;
  readonly signals: readonly SignalDescriptor[];
  readonly #signalName: string;
  readonly #cpuUsage: () => CpuUsageSnapshot;
  #lastUsage: CpuUsageSnapshot | null = null;
  #lastObservedAt: number | null = null;
  #closed = false;

  constructor(options: CpuUtilizationProviderOptions = {}) {
    if (options === null || typeof options !== "object") {
      throw new ConfigurationError("CpuUtilizationProvider options must be an object.");
    }
    this.id = validateId(options.id, "process-cpu");
    this.#signalName = validateSignalName(options.signalName, PROCESS_CPU_UTILIZATION);
    if (options.cpuUsage !== undefined && typeof options.cpuUsage !== "function") {
      throw new ConfigurationError("CpuUtilizationProvider cpuUsage must be a function.");
    }
    this.#cpuUsage = options.cpuUsage ?? (() => process.cpuUsage());
    this.signals = [
      {
        name: this.#signalName,
        unit: "ratio" as const,
        description: "Process CPU time divided by elapsed wall time, relative to one CPU core.",
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
          name: this.#signalName,
          unit: "ratio",
          status: "unsupported",
          observedAt: context.now,
          error: "Provider is closed.",
        },
      ];
    }
    const usage = this.#cpuUsage();
    const previousUsage = this.#lastUsage;
    const previousObservedAt = this.#lastObservedAt;
    this.#lastUsage = usage;
    this.#lastObservedAt = context.now;

    if (previousUsage === null || previousObservedAt === null) {
      return [
        {
          name: this.#signalName,
          unit: "ratio",
          status: "unknown",
          observedAt: context.now,
          error: "Baseline established; a second reading is required.",
        },
      ];
    }

    const elapsedMs = context.now - previousObservedAt;
    const userDelta = usage.user - previousUsage.user;
    const systemDelta = usage.system - previousUsage.system;
    if (elapsedMs <= 0 || userDelta < 0 || systemDelta < 0) {
      return [
        {
          name: this.#signalName,
          unit: "ratio",
          status: "unknown",
          observedAt: context.now,
          error: "Clock or CPU counters moved backwards (or elapsed time was zero).",
        },
      ];
    }

    const utilization = (userDelta + systemDelta) / (elapsedMs * 1000);
    return [
      {
        name: this.#signalName,
        unit: "ratio",
        status: "ok",
        value: utilization,
        observedAt: context.now,
        confidence: 1,
        details: {
          elapsedMs,
          userMicros: userDelta,
          systemMicros: systemDelta,
          relativeToOneCore: true,
        },
      },
    ];
  }
}
