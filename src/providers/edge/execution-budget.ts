import { ConfigurationError } from "../../errors/index.js";
import { systemClock } from "../../runtime/clock.js";
import type { Clock } from "../../types/clock.js";
import type {
  ResourceSignal,
  SignalDescriptor,
  SignalProvider,
  SignalReadContext,
} from "../../types/signals.js";
import { errorMessage } from "../../utils/errors.js";

export const EDGE_EXECUTION_REMAINING_MS = "edge.execution.remainingMs";
export const EDGE_EXECUTION_USED_RATIO = "edge.execution.usedRatio";
export const EDGE_CONCURRENCY_SATURATION = "edge.concurrency.saturation";

export interface ExecutionBudgetSnapshot {
  readonly totalBudgetMs?: number;
  readonly elapsedMs?: number;
  readonly activeRequests?: number;
  readonly maxConcurrency?: number;
  readonly cpuBudgetMs?: number;
  readonly cpuElapsedMs?: number;
}

export interface EdgeBudgetSnapshot {
  readonly elapsedWallClockMs: number;
  readonly remainingWallClockMs: number;
  readonly wallClockUtilizationRatio: number;
  readonly recordedSubrequests: number;
  readonly remainingSubrequests: number | null;
  readonly payloadBytes: number | null;
}

export interface BaseEdgeBudgetProviderOptions {
  readonly id?: string;
  readonly clock?: Clock;
  readonly cpuBudgetMs?: number;
  readonly maxSubrequests?: number;
  readonly reserveWallClockMs?: number;
  readonly reserveCpuMs?: number;
}

export interface WallClockBudgetOptions extends BaseEdgeBudgetProviderOptions {
  readonly wallClockBudgetMs: number;
  readonly getBudgetSnapshot?: (
    context: SignalReadContext,
  ) => ExecutionBudgetSnapshot | Promise<ExecutionBudgetSnapshot>;
}

export interface SnapshotBudgetOptions extends BaseEdgeBudgetProviderOptions {
  readonly wallClockBudgetMs?: number;
  readonly getBudgetSnapshot: (
    context: SignalReadContext,
  ) => ExecutionBudgetSnapshot | Promise<ExecutionBudgetSnapshot>;
}

export type EdgeExecutionBudgetProviderOptions = WallClockBudgetOptions | SnapshotBudgetOptions;

export type ExecutionBudgetProviderOptions = EdgeExecutionBudgetProviderOptions;

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
 * Tracks execution deadline budgets, concurrency saturation, and reserve headroom
 * in Edge/WinterCG runtimes.
 */
export class EdgeExecutionBudgetProvider implements SignalProvider {
  readonly id: string;
  readonly signals: readonly SignalDescriptor[];
  readonly #clock: Clock;
  readonly #wallClockBudgetMs: number | undefined;
  readonly #cpuBudgetMs: number | undefined;
  readonly #maxSubrequests: number | undefined;
  readonly #reserveWallClockMs: number;
  readonly #reserveCpuMs: number;
  readonly #getBudgetSnapshotCallback?: (
    context: SignalReadContext,
  ) => ExecutionBudgetSnapshot | Promise<ExecutionBudgetSnapshot>;

  #startMs: number;
  #recordedSubrequests = 0;
  #payloadBytes: number | null = null;
  #recordedCpuMs = 0;
  #lastKnownTotalBudgetMs: number | undefined;
  #closed = false;

  constructor(options: EdgeExecutionBudgetProviderOptions) {
    if (options === null || typeof options !== "object") {
      throw new ConfigurationError("ExecutionBudgetProvider requires an options object.");
    }
    this.id = validateId(options.id, "edge-execution-budget");

    if (options.clock !== undefined) {
      if (
        options.clock === null ||
        typeof options.clock !== "object" ||
        typeof options.clock.now !== "function"
      ) {
        throw new ConfigurationError("clock must be a valid Clock instance.");
      }
      this.#clock = options.clock;
    } else {
      this.#clock = systemClock;
    }

    if (options.wallClockBudgetMs !== undefined) {
      if (
        typeof options.wallClockBudgetMs !== "number" ||
        !Number.isFinite(options.wallClockBudgetMs) ||
        options.wallClockBudgetMs <= 0
      ) {
        throw new ConfigurationError("wallClockBudgetMs must be a positive finite number.");
      }
      this.#wallClockBudgetMs = options.wallClockBudgetMs;
    }

    if (options.cpuBudgetMs !== undefined) {
      if (
        typeof options.cpuBudgetMs !== "number" ||
        !Number.isFinite(options.cpuBudgetMs) ||
        options.cpuBudgetMs <= 0
      ) {
        throw new ConfigurationError("cpuBudgetMs must be a positive finite number.");
      }
      this.#cpuBudgetMs = options.cpuBudgetMs;
    }

    if (options.reserveWallClockMs !== undefined) {
      if (
        typeof options.reserveWallClockMs !== "number" ||
        !Number.isFinite(options.reserveWallClockMs) ||
        options.reserveWallClockMs < 0
      ) {
        throw new ConfigurationError("reserveWallClockMs must be a finite non-negative number.");
      }
      if (
        this.#wallClockBudgetMs !== undefined &&
        options.reserveWallClockMs >= this.#wallClockBudgetMs
      ) {
        throw new ConfigurationError("reserveWallClockMs must be less than wallClockBudgetMs.");
      }
      if (this.#wallClockBudgetMs === undefined && options.reserveWallClockMs > 0) {
        throw new ConfigurationError(
          "reserveWallClockMs requires wallClockBudgetMs to be configured.",
        );
      }
      this.#reserveWallClockMs = options.reserveWallClockMs;
    } else {
      this.#reserveWallClockMs = 0;
    }

    if (options.reserveCpuMs !== undefined) {
      if (
        typeof options.reserveCpuMs !== "number" ||
        !Number.isFinite(options.reserveCpuMs) ||
        options.reserveCpuMs < 0
      ) {
        throw new ConfigurationError("reserveCpuMs must be a finite non-negative number.");
      }
      if (this.#cpuBudgetMs === undefined && options.reserveCpuMs > 0) {
        throw new ConfigurationError("reserveCpuMs requires cpuBudgetMs to be configured.");
      }
      if (this.#cpuBudgetMs !== undefined && options.reserveCpuMs >= this.#cpuBudgetMs) {
        throw new ConfigurationError("reserveCpuMs must be less than cpuBudgetMs.");
      }
      this.#reserveCpuMs = options.reserveCpuMs;
    } else {
      this.#reserveCpuMs = 0;
    }

    if (options.maxSubrequests !== undefined) {
      if (
        typeof options.maxSubrequests !== "number" ||
        !Number.isInteger(options.maxSubrequests) ||
        options.maxSubrequests < 0
      ) {
        throw new ConfigurationError("maxSubrequests must be a non-negative integer.");
      }
      this.#maxSubrequests = options.maxSubrequests;
    }

    if (options.getBudgetSnapshot !== undefined) {
      if (typeof options.getBudgetSnapshot !== "function") {
        throw new ConfigurationError(
          "ExecutionBudgetProvider getBudgetSnapshot must be a function.",
        );
      }
      this.#getBudgetSnapshotCallback = options.getBudgetSnapshot;
    } else if (this.#wallClockBudgetMs === undefined) {
      throw new ConfigurationError("ExecutionBudgetProvider getBudgetSnapshot must be a function.");
    }

    this.#startMs = this.#clock.now();

    this.signals = [
      {
        name: EDGE_EXECUTION_REMAINING_MS,
        unit: "milliseconds",
        description: "Remaining execution budget before edge deadline.",
      },
      {
        name: EDGE_EXECUTION_USED_RATIO,
        unit: "ratio",
        description: "Ratio of elapsed wall time to total execution budget.",
      },
      {
        name: EDGE_CONCURRENCY_SATURATION,
        unit: "ratio",
        description: "Active edge requests divided by maximum concurrency.",
      },
    ];
  }

  recordSubrequest(count = 1): void {
    if (this.#closed) {
      throw new ConfigurationError("ExecutionBudgetProvider is closed.");
    }
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
      throw new ConfigurationError("Subrequest count must be a positive integer.");
    }
    this.#recordedSubrequests += count;
  }

  recordSubrequests(count = 1): void {
    this.recordSubrequest(count);
  }

  recordPayloadBytes(bytes: number): void {
    if (this.#closed) {
      throw new ConfigurationError("ExecutionBudgetProvider is closed.");
    }
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
      throw new ConfigurationError("Payload bytes must be a non-negative finite number.");
    }
    this.#payloadBytes = (this.#payloadBytes ?? 0) + bytes;
  }

  recordCpuTime(ms: number): void {
    if (this.#closed) {
      throw new ConfigurationError("ExecutionBudgetProvider is closed.");
    }
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
      throw new ConfigurationError("CPU time must be a non-negative finite number.");
    }
    this.#recordedCpuMs += ms;
  }

  recordCpuMs(ms: number): void {
    this.recordCpuTime(ms);
  }

  resetWindow(): void {
    if (this.#closed) {
      throw new ConfigurationError("ExecutionBudgetProvider is closed.");
    }
    this.#startMs = this.#clock.now();
    this.#recordedSubrequests = 0;
    this.#payloadBytes = null;
    this.#recordedCpuMs = 0;
  }

  getBudgetSnapshot(): EdgeBudgetSnapshot {
    const elapsedWallClockMs = Math.max(0, this.#clock.now() - this.#startMs);
    const budget = this.#wallClockBudgetMs ?? this.#lastKnownTotalBudgetMs;
    let remainingWallClockMs: number;
    let wallClockUtilizationRatio: number;

    if (budget !== undefined) {
      const rawRemaining = Math.max(0, budget - elapsedWallClockMs);
      remainingWallClockMs = Math.max(0, rawRemaining - this.#reserveWallClockMs);
      const effectiveBudget = budget - this.#reserveWallClockMs;
      wallClockUtilizationRatio =
        effectiveBudget > 0 ? elapsedWallClockMs / effectiveBudget : elapsedWallClockMs > 0 ? 1 : 0;
    } else {
      remainingWallClockMs = 0;
      wallClockUtilizationRatio = 0;
    }

    const remainingSubrequests =
      this.#maxSubrequests !== undefined
        ? Math.max(0, this.#maxSubrequests - this.#recordedSubrequests)
        : null;

    return Object.freeze({
      elapsedWallClockMs,
      remainingWallClockMs,
      wallClockUtilizationRatio,
      recordedSubrequests: this.#recordedSubrequests,
      remainingSubrequests,
      payloadBytes: this.#payloadBytes,
    });
  }

  async read(context: SignalReadContext): Promise<readonly ResourceSignal[]> {
    const observedAt = context.now;

    if (this.#closed) {
      return this.signals.map((descriptor) => ({
        name: descriptor.name,
        unit: descriptor.unit,
        status: "unsupported",
        observedAt,
        error: "Provider is closed.",
      }));
    }

    try {
      let totalBudgetMs: number | undefined;
      let elapsedMs: number | undefined;
      let activeRequests: number | undefined;
      let maxConcurrency: number | undefined;
      let cpuElapsedMs = this.#recordedCpuMs;

      if (this.#getBudgetSnapshotCallback !== undefined) {
        const snapshot = await this.#getBudgetSnapshotCallback(context);

        if (snapshot === null || typeof snapshot !== "object") {
          return this.signals.map((descriptor) => ({
            name: descriptor.name,
            unit: descriptor.unit,
            status: "unknown",
            observedAt,
            error: "Execution budget snapshot is unavailable or invalid.",
          }));
        }

        totalBudgetMs = snapshot.totalBudgetMs ?? this.#wallClockBudgetMs;
        elapsedMs = snapshot.elapsedMs;
        activeRequests = snapshot.activeRequests;
        maxConcurrency = snapshot.maxConcurrency;
        if (snapshot.cpuElapsedMs !== undefined) {
          cpuElapsedMs = snapshot.cpuElapsedMs;
        }
        if (typeof totalBudgetMs === "number" && Number.isFinite(totalBudgetMs)) {
          this.#lastKnownTotalBudgetMs = totalBudgetMs;
        }
      } else {
        totalBudgetMs = this.#wallClockBudgetMs;
        elapsedMs = Math.max(0, observedAt - this.#startMs);
      }

      const readings: ResourceSignal[] = [];

      if (
        typeof totalBudgetMs === "number" &&
        Number.isFinite(totalBudgetMs) &&
        totalBudgetMs > 0 &&
        typeof elapsedMs === "number" &&
        Number.isFinite(elapsedMs) &&
        elapsedMs >= 0
      ) {
        const rawWallClockRemaining = Math.max(0, totalBudgetMs - elapsedMs);
        const effectiveWallClockRemaining = Math.max(
          0,
          rawWallClockRemaining - this.#reserveWallClockMs,
        );
        const effectiveWallClockBudget = totalBudgetMs - this.#reserveWallClockMs;
        const effectiveWallClockUsedRatio =
          effectiveWallClockBudget > 0
            ? elapsedMs / effectiveWallClockBudget
            : elapsedMs > 0
              ? 1
              : 0;

        let finalRemainingMs = effectiveWallClockRemaining;
        let finalUsedRatio = effectiveWallClockUsedRatio;

        if (this.#cpuBudgetMs !== undefined) {
          const rawCpuRemaining = Math.max(0, this.#cpuBudgetMs - cpuElapsedMs);
          const effectiveCpuRemaining = Math.max(0, rawCpuRemaining - this.#reserveCpuMs);
          const effectiveCpuBudget = this.#cpuBudgetMs - this.#reserveCpuMs;
          const effectiveCpuUsedRatio =
            effectiveCpuBudget > 0 ? cpuElapsedMs / effectiveCpuBudget : cpuElapsedMs > 0 ? 1 : 0;

          finalRemainingMs = Math.min(effectiveWallClockRemaining, effectiveCpuRemaining);
          finalUsedRatio = Math.max(effectiveWallClockUsedRatio, effectiveCpuUsedRatio);
        }

        const remainingDetails: Record<string, unknown> = {
          totalBudgetMs,
          elapsedMs,
          remainingMs: finalRemainingMs,
        };
        if (this.#reserveWallClockMs > 0) {
          remainingDetails.reserveWallClockMs = this.#reserveWallClockMs;
        }
        if (this.#cpuBudgetMs !== undefined) {
          remainingDetails.cpuBudgetMs = this.#cpuBudgetMs;
          remainingDetails.cpuElapsedMs = cpuElapsedMs;
          remainingDetails.reserveCpuMs = this.#reserveCpuMs;
        }

        readings.push({
          name: EDGE_EXECUTION_REMAINING_MS,
          unit: "milliseconds",
          status: "ok",
          value: finalRemainingMs,
          observedAt,
          confidence: 1,
          details: remainingDetails,
        });

        const usedDetails: Record<string, unknown> = {
          totalBudgetMs,
          elapsedMs,
          usedRatio: finalUsedRatio,
        };
        if (this.#reserveWallClockMs > 0) {
          usedDetails.reserveWallClockMs = this.#reserveWallClockMs;
        }
        if (this.#cpuBudgetMs !== undefined) {
          usedDetails.cpuBudgetMs = this.#cpuBudgetMs;
          usedDetails.cpuElapsedMs = cpuElapsedMs;
          usedDetails.reserveCpuMs = this.#reserveCpuMs;
        }

        readings.push({
          name: EDGE_EXECUTION_USED_RATIO,
          unit: "ratio",
          status: "ok",
          value: finalUsedRatio,
          observedAt,
          confidence: 1,
          details: usedDetails,
        });
      } else {
        readings.push({
          name: EDGE_EXECUTION_REMAINING_MS,
          unit: "milliseconds",
          status: "unknown",
          observedAt,
          error: "Execution budget timing is unavailable or invalid.",
        });
        readings.push({
          name: EDGE_EXECUTION_USED_RATIO,
          unit: "ratio",
          status: "unknown",
          observedAt,
          error: "Execution budget ratio is unavailable or invalid.",
        });
      }

      if (
        typeof activeRequests === "number" &&
        Number.isFinite(activeRequests) &&
        activeRequests >= 0 &&
        typeof maxConcurrency === "number" &&
        Number.isFinite(maxConcurrency) &&
        maxConcurrency > 0
      ) {
        const saturation = activeRequests / maxConcurrency;
        readings.push({
          name: EDGE_CONCURRENCY_SATURATION,
          unit: "ratio",
          status: "ok",
          value: saturation,
          observedAt,
          confidence: 1,
          details: { activeRequests, maxConcurrency, saturation },
        });
      } else {
        readings.push({
          name: EDGE_CONCURRENCY_SATURATION,
          unit: "ratio",
          status: "unknown",
          observedAt,
          error: "Concurrency metrics are unavailable or invalid.",
        });
      }

      return readings;
    } catch (err) {
      const msg = errorMessage(err);
      return this.signals.map((descriptor) => ({
        name: descriptor.name,
        unit: descriptor.unit,
        status: "error",
        observedAt,
        error: `Failed to retrieve execution budget snapshot: ${msg}`,
      }));
    }
  }

  close(): void {
    this.#closed = true;
  }
}

export { EdgeExecutionBudgetProvider as ExecutionBudgetProvider };

export function createEdgeExecutionBudgetProvider(
  options: EdgeExecutionBudgetProviderOptions,
): EdgeExecutionBudgetProvider {
  return new EdgeExecutionBudgetProvider(options);
}
