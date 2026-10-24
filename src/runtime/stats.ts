import type { RuntimeStats, StrategyStats } from "../types/run.js";

/**
 * Smoothing factor for the recent-latency estimate. A 0.2 alpha keeps roughly
 * the last five samples dominant while still damping a single noisy observation.
 */
export const EWMA_ALPHA = 0.2;

interface MutableStrategyStats {
  runs: number;
  successes: number;
  failures: number;
  lastDurationMs: number | null;
  totalDurationMs: number;
  durationSamples: number;
  ewmaDurationMs: number | null;
}

function emptyStrategyStats(): MutableStrategyStats {
  return {
    runs: 0,
    successes: 0,
    failures: 0,
    lastDurationMs: null,
    totalDurationMs: 0,
    durationSamples: 0,
    ewmaDurationMs: null,
  };
}

interface MutableStats {
  runs: number;
  successes: number;
  failures: number;
  lastDurationMs: number | null;
  totalDurationMs: number;
  durationSamples: number;
  ewmaDurationMs: number | null;
  strategyRuns: Map<string, number>;
  strategies: Map<string, MutableStrategyStats>;
}

function emptyStats(): MutableStats {
  return {
    runs: 0,
    successes: 0,
    failures: 0,
    lastDurationMs: null,
    totalDurationMs: 0,
    durationSamples: 0,
    ewmaDurationMs: null,
    strategyRuns: new Map(),
    strategies: new Map(),
  };
}

function nextEwma(previous: number | null, sample: number): number {
  return previous === null ? sample : EWMA_ALPHA * sample + (1 - EWMA_ALPHA) * previous;
}

function errorRate(failures: number, runs: number): number {
  return runs === 0 ? 0 : failures / runs;
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
    const strategy = this.#getStrategy(stats, strategyId);
    strategy.runs += 1;
  }

  success(operationId: string, strategyId: string, durationMs: number): void {
    const stats = this.#get(operationId);
    stats.successes += 1;
    this.#recordDuration(stats, durationMs);
    const strategy = this.#getStrategy(stats, strategyId);
    strategy.successes += 1;
    this.#recordStrategyDuration(strategy, durationMs);
  }

  failure(operationId: string, strategyId?: string, durationMs?: number): void {
    const stats = this.#get(operationId);
    stats.failures += 1;
    if (durationMs !== undefined) {
      this.#recordDuration(stats, durationMs);
    }
    if (strategyId !== undefined) {
      // A decision can exist without a selected strategy only for defensive
      // configuration failures. Do not create a strategy record that would make
      // an exported snapshot internally inconsistent.
      const strategy = stats.strategies.get(strategyId);
      if (strategy !== undefined) {
        strategy.failures += 1;
        if (durationMs !== undefined) {
          this.#recordStrategyDuration(strategy, durationMs);
        }
      }
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
        totalDurationMs: 0,
        ewmaDurationMs: null,
        durationSamples: 0,
        errorRate: 0,
        strategyRuns: {},
        strategies: {},
      };
    }
    const strategies: Record<string, StrategyStats> = {};
    for (const [id, s] of stats.strategies) {
      strategies[id] = {
        runs: s.runs,
        successes: s.successes,
        failures: s.failures,
        lastDurationMs: s.lastDurationMs,
        averageDurationMs: s.durationSamples === 0 ? null : s.totalDurationMs / s.durationSamples,
        totalDurationMs: s.totalDurationMs,
        ewmaDurationMs: s.ewmaDurationMs,
        durationSamples: s.durationSamples,
        errorRate: errorRate(s.failures, s.runs),
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
      totalDurationMs: stats.totalDurationMs,
      ewmaDurationMs: stats.ewmaDurationMs,
      durationSamples: stats.durationSamples,
      errorRate: errorRate(stats.failures, stats.runs),
      strategyRuns: Object.fromEntries(stats.strategyRuns),
      strategies,
    };
  }

  getAllStats(operationIds?: readonly string[]): Readonly<Record<string, RuntimeStats>> {
    const ids = operationIds ?? [...this.#stats.keys()];
    const result: Record<string, RuntimeStats> = {};
    for (const id of ids) {
      result[id] = this.get(id);
    }
    return Object.freeze(result);
  }

  /**
   * Replaces one operation's counters with a validated snapshot. Used by state
   * hydration; callers are responsible for structural validation.
   */
  restore(operationId: string, snapshot: RuntimeStats): void {
    const stats = emptyStats();
    stats.runs = snapshot.runs;
    stats.successes = snapshot.successes;
    stats.failures = snapshot.failures;
    stats.lastDurationMs = snapshot.lastDurationMs;
    stats.durationSamples = snapshot.durationSamples;
    stats.totalDurationMs =
      snapshot.totalDurationMs !== undefined
        ? snapshot.totalDurationMs
        : snapshot.averageDurationMs === null
          ? 0
          : snapshot.averageDurationMs * snapshot.durationSamples;
    stats.ewmaDurationMs = snapshot.ewmaDurationMs;
    for (const [strategyId, count] of Object.entries(snapshot.strategyRuns)) {
      stats.strategyRuns.set(strategyId, count);
    }
    for (const [strategyId, strategySnapshot] of Object.entries(snapshot.strategies)) {
      stats.strategies.set(strategyId, {
        runs: strategySnapshot.runs,
        successes: strategySnapshot.successes,
        failures: strategySnapshot.failures,
        lastDurationMs: strategySnapshot.lastDurationMs,
        durationSamples: strategySnapshot.durationSamples,
        totalDurationMs:
          strategySnapshot.totalDurationMs !== undefined
            ? strategySnapshot.totalDurationMs
            : strategySnapshot.averageDurationMs === null
              ? 0
              : strategySnapshot.averageDurationMs * strategySnapshot.durationSamples,
        ewmaDurationMs: strategySnapshot.ewmaDurationMs,
      });
    }
    this.#stats.set(operationId, stats);
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

  #getStrategy(stats: MutableStats, strategyId: string): MutableStrategyStats {
    let strategy = stats.strategies.get(strategyId);
    if (strategy === undefined) {
      strategy = emptyStrategyStats();
      stats.strategies.set(strategyId, strategy);
    }
    return strategy;
  }

  #recordDuration(stats: MutableStats, durationMs: number): void {
    stats.lastDurationMs = durationMs;
    stats.totalDurationMs += durationMs;
    stats.durationSamples += 1;
    stats.ewmaDurationMs = nextEwma(stats.ewmaDurationMs, durationMs);
  }

  #recordStrategyDuration(strategy: MutableStrategyStats, durationMs: number): void {
    strategy.lastDurationMs = durationMs;
    strategy.totalDurationMs += durationMs;
    strategy.durationSamples += 1;
    strategy.ewmaDurationMs = nextEwma(strategy.ewmaDurationMs, durationMs);
  }
}
