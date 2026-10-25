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

export interface CpuUtilizationStats {
  readonly sampleCount: number;
  readonly lastRawUtilization: number | null;
  readonly smoothedUtilization: number | null;
  readonly peakUtilization: number | null;
}

export interface CpuUtilizationProviderOptions {
  readonly id?: string;
  readonly signalName?: string;
  /** Injection point for tests. Defaults to process.cpuUsage(). */
  readonly cpuUsage?: () => CpuUsageSnapshot;
  /** EWMA smoothing factor in (0, 1]. When undefined or 1, raw instantaneous utilization is reported. */
  readonly smoothingAlpha?: number;
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
  readonly #smoothingAlpha?: number;
  #lastUsage: CpuUsageSnapshot | null = null;
  #lastObservedAt: number | null = null;
  #closed = false;
  #sampleCount = 0;
  #lastRawUtilization: number | null = null;
  #smoothedUtilization: number | null = null;
  #peakUtilization: number | null = null;

  constructor(options: CpuUtilizationProviderOptions = {}) {
    if (options === null || typeof options !== "object") {
      throw new ConfigurationError("CpuUtilizationProvider options must be an object.");
    }
    this.id = validateId(options.id, "process-cpu");
    this.#signalName = validateSignalName(options.signalName, PROCESS_CPU_UTILIZATION);
    if (options.cpuUsage !== undefined && typeof options.cpuUsage !== "function") {
      throw new ConfigurationError("CpuUtilizationProvider cpuUsage must be a function.");
    }
    if (
      options.smoothingAlpha !== undefined &&
      (typeof options.smoothingAlpha !== "number" ||
        !Number.isFinite(options.smoothingAlpha) ||
        options.smoothingAlpha <= 0 ||
        options.smoothingAlpha > 1)
    ) {
      throw new ConfigurationError("smoothingAlpha must be a finite number in (0, 1].");
    }
    this.#smoothingAlpha = options.smoothingAlpha;
    this.#cpuUsage = options.cpuUsage ?? (() => process.cpuUsage());
    this.signals = [
      {
        name: this.#signalName,
        unit: "ratio" as const,
        description: "Process CPU time divided by elapsed wall time, relative to one CPU core.",
      },
    ];
  }

  getCpuStats(): CpuUtilizationStats {
    return Object.freeze({
      sampleCount: this.#sampleCount,
      lastRawUtilization: this.#lastRawUtilization,
      smoothedUtilization: this.#smoothedUtilization,
      peakUtilization: this.#peakUtilization,
    });
  }

  resetBaseline(): void {
    this.#lastUsage = null;
    this.#lastObservedAt = null;
    this.#sampleCount = 0;
    this.#lastRawUtilization = null;
    this.#smoothedUtilization = null;
    this.#peakUtilization = null;
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
    this.#sampleCount += 1;
    this.#lastRawUtilization = utilization;
    if (this.#peakUtilization === null || utilization > this.#peakUtilization) {
      this.#peakUtilization = utilization;
    }

    if (this.#smoothingAlpha !== undefined) {
      this.#smoothedUtilization =
        this.#smoothedUtilization === null
          ? utilization
          : this.#smoothingAlpha * utilization +
            (1 - this.#smoothingAlpha) * this.#smoothedUtilization;
    }

    const reportedValue =
      this.#smoothingAlpha !== undefined && this.#smoothingAlpha < 1
        ? (this.#smoothedUtilization as number)
        : utilization;

    return [
      {
        name: this.#signalName,
        unit: "ratio",
        status: "ok",
        value: reportedValue,
        observedAt: context.now,
        confidence: 1,
        details: {
          elapsedMs,
          userMicros: userDelta,
          systemMicros: systemDelta,
          relativeToOneCore: true,
          rawUtilization: utilization,
          smoothedUtilization: this.#smoothedUtilization,
        },
      },
    ];
  }
}
