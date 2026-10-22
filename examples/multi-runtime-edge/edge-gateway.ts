import {
  type Clock,
  type ClockTimer,
  CompositeSignalProvider,
  createAdaptiveRuntime,
  definePolicy,
  type Strategy,
} from "../../src/core.js";
import {
  EDGE_CONCURRENCY_SATURATION,
  EDGE_EXECUTION_USED_RATIO,
  ExecutionBudgetProvider,
  type ExecutionBudgetSnapshot,
} from "../../src/edge.js";
import { createMetricsCollector } from "../../src/observability/index.js";

export const EDGE_GATEWAY_OPERATION = "edge-gateway";
export const EDGE_HEADROOM_RATIO = "edge.headroom.ratio";
export const EDGE_PRESSURE_SCORE = "edge.pressure.score";

const TOTAL_BUDGET_MS = 30_000;
const FIXED_NOW = 1_700_000_000_000;

/**
 * A deterministic clock keeps the example output stable. Timers never fire,
 * which is safe here because the example uses no operation or provider timeout.
 */
class FixedClock implements Clock {
  now(): number {
    return FIXED_NOW;
  }

  setTimeout(_callback: () => void, _delayMs: number): ClockTimer {
    return { cancel: () => undefined };
  }
}

const FALLBACK_SNAPSHOT: ExecutionBudgetSnapshot = {
  totalBudgetMs: TOTAL_BUDGET_MS,
  elapsedMs: TOTAL_BUDGET_MS,
  activeRequests: 0,
  maxConcurrency: 20,
};

/**
 * Simulated request windows. Each row describes the wall-clock budget and
 * in-flight concurrency visible to the edge runtime.
 */
const SNAPSHOTS: readonly ExecutionBudgetSnapshot[] = [
  { totalBudgetMs: TOTAL_BUDGET_MS, elapsedMs: 1_000, activeRequests: 2, maxConcurrency: 20 },
  { totalBudgetMs: TOTAL_BUDGET_MS, elapsedMs: 15_000, activeRequests: 5, maxConcurrency: 20 },
  { totalBudgetMs: TOTAL_BUDGET_MS, elapsedMs: 19_500, activeRequests: 12, maxConcurrency: 20 },
  { totalBudgetMs: TOTAL_BUDGET_MS, elapsedMs: 26_000, activeRequests: 17, maxConcurrency: 20 },
  { totalBudgetMs: TOTAL_BUDGET_MS, elapsedMs: 12_000, activeRequests: 3, maxConcurrency: 20 },
];

function requireInput(values: Readonly<Record<string, number>>, name: string): number {
  const value = values[name];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Composite rule received no finite value for "${name}".`);
  }
  return value;
}

function createBudgetProvider(): ExecutionBudgetProvider {
  let index = 0;
  return new ExecutionBudgetProvider({
    id: "edge-request-budget",
    getBudgetSnapshot: () => {
      const snapshot = SNAPSHOTS[index] ?? FALLBACK_SNAPSHOT;
      index += 1;
      return snapshot;
    },
  });
}

const STRATEGIES: readonly Strategy<string, string>[] = [
  {
    id: "deep-rerank",
    qualityTier: 3,
    costTier: 3,
    description: "Cross-encoder reranking of the candidate set.",
    run: ({ input }) => `${input}:deep-rerank`,
  },
  {
    id: "fast-vector",
    qualityTier: 2,
    costTier: 2,
    description: "ANN vector search without a reranking pass.",
    run: ({ input }) => `${input}:fast-vector`,
  },
  {
    id: "cached-lexical",
    qualityTier: 1,
    costTier: 1,
    description: "Cached lexical retrieval for the tightest deadlines.",
    run: ({ input }) => `${input}:cached-lexical`,
  },
];

export interface EdgeGatewayExampleOptions {
  readonly logger?: (line: string) => void;
}

export interface EdgeGatewayExampleResult {
  readonly strategySequence: readonly string[];
  readonly decisionKinds: readonly string[];
  readonly pressureScores: readonly (number | undefined)[];
  readonly values: readonly string[];
  readonly prometheusText: string;
  readonly logLines: readonly string[];
}

/**
 * Runs an edge gateway under a simulated wall-clock budget and concurrency
 * load. Two soft budgets drive a three-tier strategy ladder:
 *
 *   deep-rerank (3) -> fast-vector (2) -> cached-lexical (1)
 *
 * Composite signals combine used budget and concurrency saturation. The final
 * snapshot simulates a fresh, low-pressure request window, so the runtime
 * recovers to the highest tier.
 */
export async function runEdgeGatewayExample(
  options: EdgeGatewayExampleOptions = {},
): Promise<EdgeGatewayExampleResult> {
  const logger = options.logger ?? (() => undefined);
  const logLines: string[] = [];
  const log = (line: string): void => {
    logLines.push(line);
    logger(line);
  };

  const budgetProvider = createBudgetProvider();
  const compositeProvider = new CompositeSignalProvider({
    id: "edge-composite-signals",
    providers: [budgetProvider],
    rules: [
      {
        name: EDGE_HEADROOM_RATIO,
        unit: "ratio",
        description: "Remaining execution budget as a ratio of the total budget.",
        inputs: [EDGE_EXECUTION_USED_RATIO],
        compute: (values) => 1 - requireInput(values, EDGE_EXECUTION_USED_RATIO),
      },
      {
        name: EDGE_PRESSURE_SCORE,
        unit: "ratio",
        description: "Weighted pressure from used budget (60%) and concurrency saturation (40%).",
        inputs: [EDGE_EXECUTION_USED_RATIO, EDGE_CONCURRENCY_SATURATION],
        compute: (values) =>
          0.6 * requireInput(values, EDGE_EXECUTION_USED_RATIO) +
          0.4 * requireInput(values, EDGE_CONCURRENCY_SATURATION),
      },
    ],
  });

  const runtime = createAdaptiveRuntime({
    providers: [compositeProvider],
    clock: new FixedClock(),
    policy: definePolicy({
      evaluationIntervalMs: 0,
      consecutiveSamples: 1,
      minimumModeDurationMs: 0,
      budgets: [
        {
          id: "edge-pressure",
          signal: EDGE_PRESSURE_SCORE,
          limit: 0.55,
          recoverBelow: 0.35,
          tierReduction: 1,
        },
        {
          id: "edge-deadline",
          signal: EDGE_EXECUTION_USED_RATIO,
          limit: 0.8,
          recoverBelow: 0.7,
          tierReduction: 1,
        },
      ],
    }),
  });

  const collector = createMetricsCollector({ prefix: "edge_gateway" });
  const detach = collector.attach(runtime);
  const strategySequence: string[] = [];
  const decisionKinds: string[] = [];
  const pressureScores: Array<number | undefined> = [];
  const values: string[] = [];

  try {
    for (const [index] of SNAPSHOTS.entries()) {
      const result = await runtime.run({
        operationId: EDGE_GATEWAY_OPERATION,
        input: `request-${index + 1}`,
        strategies: STRATEGIES,
      });
      const pressure = result.metadata.decision.signals.find(
        (signal) => signal.name === EDGE_PRESSURE_SCORE,
      );

      strategySequence.push(result.metadata.strategyId);
      decisionKinds.push(result.metadata.decision.kind);
      pressureScores.push(pressure?.value);
      values.push(result.value);

      const pressureLabel =
        pressure?.value === undefined ? "unavailable" : pressure.value.toFixed(2);
      log(
        `request ${index + 1}: strategy=${result.metadata.strategyId} kind=${result.metadata.decision.kind} pressure=${pressureLabel} value=${result.value}`,
      );
    }
  } finally {
    try {
      await runtime.close();
    } finally {
      detach();
    }
  }

  const prometheusText = collector.toPrometheusText();
  log(`strategy sequence: ${strategySequence.join(", ")}`);
  log("prometheus exposition:");
  for (const line of prometheusText.trimEnd().split("\n")) {
    log(`  ${line}`);
  }

  return {
    strategySequence,
    decisionKinds,
    pressureScores,
    values,
    prometheusText,
    logLines,
  };
}
