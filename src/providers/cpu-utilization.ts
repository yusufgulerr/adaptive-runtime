import type { ResourceSignal, SignalProvider, SignalReadContext } from "../types/signals.js";

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

/**
 * Measures process CPU time between reads. The returned ratio is relative to
 * one CPU core of wall time, so it can exceed 1 for multi-threaded work. The
 * first read establishes a baseline and is reported as "unknown", never as 0.
 */
export class CpuUtilizationProvider implements SignalProvider {
  readonly id: string;
  readonly signals;
  readonly #signalName: string;
  readonly #cpuUsage: () => CpuUsageSnapshot;
  #lastUsage: CpuUsageSnapshot | null = null;
  #lastObservedAt: number | null = null;

  constructor(options: CpuUtilizationProviderOptions = {}) {
    this.id = options.id ?? "process-cpu";
    this.#signalName = options.signalName ?? PROCESS_CPU_UTILIZATION;
    this.#cpuUsage = options.cpuUsage ?? (() => process.cpuUsage());
    this.signals = [
      {
        name: this.#signalName,
        unit: "ratio" as const,
        description: "Process CPU time divided by elapsed wall time, relative to one CPU core.",
      },
    ];
  }

  read(context: SignalReadContext): readonly ResourceSignal[] {
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
