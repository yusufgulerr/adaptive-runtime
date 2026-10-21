import type { RuntimeStats } from "../types/run.js";

interface MutableStats {
  runs: number;
  successes: number;
  failures: number;
  lastDurationMs: number | null;
  totalDurationMs: number;
  durationSamples: number;
  strategyRuns: Map<string, number>;
}

function emptyStats(): MutableStats {
  return {
    runs: 0,
    successes: 0,
    failures: 0,
    lastDurationMs: null,
    totalDurationMs: 0,
    durationSamples: 0,
    strategyRuns: new Map(),
  };
}

export class StatsRegistry {
  readonly #stats = new Map<string, MutableStats>();

  has(operationId: string): boolean {
    return this.#stats.has(operationId);
  }

  begin(operationId: string): void {
    const stats = this.#get(operationId);
    stats.runs += 1;
  }

  strategySelected(operationId: string, strategyId: string): void {
    const stats = this.#get(operationId);
    stats.strategyRuns.set(strategyId, (stats.strategyRuns.get(strategyId) ?? 0) + 1);
  }

  success(operationId: string, durationMs: number): void {
    const stats = this.#get(operationId);
    stats.successes += 1;
    this.#recordDuration(stats, durationMs);
  }

  failure(operationId: string, durationMs: number | undefined): void {
    const stats = this.#get(operationId);
    stats.failures += 1;
    if (durationMs !== undefined) {
      this.#recordDuration(stats, durationMs);
    }
  }

  get(operationId: string): RuntimeStats {
    const stats = this.#stats.get(operationId);
    if (stats === undefined) {
      return {
        operationId,
        runs: 0,
        successes: 0,
        failures: 0,
        lastDurationMs: null,
        averageDurationMs: null,
        strategyRuns: {},
      };
    }
    return {
      operationId,
      runs: stats.runs,
      successes: stats.successes,
      failures: stats.failures,
      lastDurationMs: stats.lastDurationMs,
      averageDurationMs:
        stats.durationSamples === 0 ? null : stats.totalDurationMs / stats.durationSamples,
      strategyRuns: Object.fromEntries(stats.strategyRuns),
    };
  }

  reset(operationId: string): void {
    if (this.#stats.has(operationId)) {
      this.#stats.set(operationId, emptyStats());
    }
  }

  clear(): void {
    this.#stats.clear();
  }

  remove(operationId: string): boolean {
    return this.#stats.delete(operationId);
  }

  #get(operationId: string): MutableStats {
    let stats = this.#stats.get(operationId);
    if (stats === undefined) {
      stats = emptyStats();
      this.#stats.set(operationId, stats);
    }
    return stats;
  }

  #recordDuration(stats: MutableStats, durationMs: number): void {
    stats.lastDurationMs = durationMs;
    stats.totalDurationMs += durationMs;
    stats.durationSamples += 1;
  }
}
