import { ConfigurationError } from "../../errors/index.js";
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
}

export interface ExecutionBudgetProviderOptions {
  readonly id?: string;
  readonly getBudgetSnapshot: (
    context: SignalReadContext,
  ) => ExecutionBudgetSnapshot | Promise<ExecutionBudgetSnapshot>;
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
 * Tracks execution deadline budgets and concurrency saturation in Edge/WinterCG runtimes.
 */
export class ExecutionBudgetProvider implements SignalProvider {
  readonly id: string;
  readonly signals: readonly SignalDescriptor[];
  readonly #getBudgetSnapshot: (
    context: SignalReadContext,
  ) => ExecutionBudgetSnapshot | Promise<ExecutionBudgetSnapshot>;
  #closed = false;

  constructor(options: ExecutionBudgetProviderOptions) {
    if (options === null || typeof options !== "object") {
      throw new ConfigurationError("ExecutionBudgetProvider requires an options object.");
    }
    this.id = validateId(options.id, "edge-execution-budget");
    if (typeof options.getBudgetSnapshot !== "function") {
      throw new ConfigurationError("ExecutionBudgetProvider getBudgetSnapshot must be a function.");
    }
    this.#getBudgetSnapshot = options.getBudgetSnapshot;

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
      const snapshot = await this.#getBudgetSnapshot(context);

      if (snapshot === null || typeof snapshot !== "object") {
        return this.signals.map((descriptor) => ({
          name: descriptor.name,
          unit: descriptor.unit,
          status: "unknown",
          observedAt,
          error: "Execution budget snapshot is unavailable or invalid.",
        }));
      }

      const readings: ResourceSignal[] = [];
      const { totalBudgetMs, elapsedMs, activeRequests, maxConcurrency } = snapshot;

      const hasValidTiming =
        typeof totalBudgetMs === "number" &&
        Number.isFinite(totalBudgetMs) &&
        totalBudgetMs > 0 &&
        typeof elapsedMs === "number" &&
        Number.isFinite(elapsedMs) &&
        elapsedMs >= 0;

      // 1. EDGE_EXECUTION_REMAINING_MS
      if (hasValidTiming) {
        const remainingMs = Math.max(0, totalBudgetMs - elapsedMs);
        readings.push({
          name: EDGE_EXECUTION_REMAINING_MS,
          unit: "milliseconds",
          status: "ok",
          value: remainingMs,
          observedAt,
          confidence: 1,
          details: { totalBudgetMs, elapsedMs, remainingMs },
        });
      } else {
        readings.push({
          name: EDGE_EXECUTION_REMAINING_MS,
          unit: "milliseconds",
          status: "unknown",
          observedAt,
          error: "Execution budget timing is unavailable or invalid.",
        });
      }

      // 2. EDGE_EXECUTION_USED_RATIO
      if (hasValidTiming) {
        const usedRatio = elapsedMs / totalBudgetMs;
        readings.push({
          name: EDGE_EXECUTION_USED_RATIO,
          unit: "ratio",
          status: "ok",
          value: usedRatio,
          observedAt,
          confidence: 1,
          details: { totalBudgetMs, elapsedMs, usedRatio },
        });
      } else {
        readings.push({
          name: EDGE_EXECUTION_USED_RATIO,
          unit: "ratio",
          status: "unknown",
          observedAt,
          error: "Execution budget ratio is unavailable or invalid.",
        });
      }

      // 3. EDGE_CONCURRENCY_SATURATION
      const hasValidConcurrency =
        typeof activeRequests === "number" &&
        Number.isFinite(activeRequests) &&
        activeRequests >= 0 &&
        typeof maxConcurrency === "number" &&
        Number.isFinite(maxConcurrency) &&
        maxConcurrency > 0;

      if (hasValidConcurrency) {
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
