import type { RuntimeStats, StrategyStats } from "../types/run.js";

interface MutableStrategyStats {
  runs: number;
  successes: number;
  failures: number;
  lastDurationMs: number | null;
  totalDurationMs: number;
  durationSamples: number;
}

function emptyStrategyStats(): MutableStrategyStats {
  return {
    runs: 0,
    successes: 0,
    failures: 0,
    lastDurationMs: null,
    totalDurationMs: 0,
    durationSamples: 0,
  };
}

interface MutableStats {
  runs: number;
  successes: number;
  failures: number;
  lastDurationMs: number | null;
  totalDurationMs: number;
  durationSamples: number;
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
    strategyRuns: new Map(),
    strategies: new Map(),
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
      const strategy = this.#getStrategy(stats, strategyId);
      strategy.failures += 1;
      if (durationMs !== undefined) {
        this.#recordStrategyDuration(strategy, durationMs);
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
      strategies,
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
  }

  #recordStrategyDuration(strategy: MutableStrategyStats, durationMs: number): void {
    strategy.lastDurationMs = durationMs;
    strategy.totalDurationMs += durationMs;
    strategy.durationSamples += 1;
  }
}
