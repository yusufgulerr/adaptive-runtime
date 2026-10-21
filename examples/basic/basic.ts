import {
  createAdaptiveRuntime,
  ProcessMemoryProvider,
  type SignalProvider,
  type Strategy,
} from "../../src/index.js";

export const SUM_OPERATION = "sum-to-n";

export interface BasicExampleOptions {
  readonly provider?: SignalProvider;
  readonly logger?: (line: string) => void;
}

export interface BasicExampleResult {
  readonly value: number;
  readonly strategyId: string;
  readonly qualityTier: number;
  readonly decisionKind: string;
  readonly qualityStatus: string;
  readonly signals: readonly { name: string; status: string; value?: number; unit?: string }[];
}

/**
 * Minimal end-to-end example: one provider, two strategies, one soft memory
 * budget, one run, then shutdown.
 */
export async function runBasicExample(
  options: BasicExampleOptions = {},
): Promise<BasicExampleResult> {
  const logger = options.logger ?? (() => undefined);
  const provider = options.provider ?? (await createDefaultProvider());

  const runtime = createAdaptiveRuntime({
    providers: [provider],
    policy: {
      evaluationIntervalMs: 0,
      consecutiveSamples: 1,
      budgets: [
        {
          id: "heap-budget",
          signal: "process.memory.heapUsed",
          limit: 512 * 1024 * 1024,
          recoverBelow: 384 * 1024 * 1024,
          tierReduction: 1,
        },
      ],
      fallbackStrategyId: "economy",
      missingSignalBehavior: "fallback",
    },
  });

  const strategies: readonly Strategy<number, number>[] = [
    {
      id: "high-quality",
      qualityTier: 2,
      description: "Iterative sum with explicit validation.",
      checkQuality: (value, context) => ({
        ok: value === expectedSum(context.input),
        detail: "Checks the arithmetic identity, not a business-domain result.",
      }),
      run: ({ input }) => {
        let total = 0;
        for (let index = 1; index <= input; index += 1) {
          total += index;
        }
        return total;
      },
    },
    {
      id: "economy",
      qualityTier: 1,
      description: "Closed-form sum with the same result.",
      checkQuality: (value, context) => ({
        ok: value === expectedSum(context.input),
      }),
      run: ({ input }) => (input * (input + 1)) / 2,
    },
  ];

  try {
    const result = await runtime.run({
      operationId: SUM_OPERATION,
      input: 10_000,
      strategies,
    });
    const summary: BasicExampleResult = {
      value: result.value,
      strategyId: result.metadata.strategyId,
      qualityTier: result.metadata.qualityTier,
      decisionKind: result.metadata.decision.kind,
      qualityStatus: result.metadata.quality.status,
      signals: result.metadata.decision.signals.map((signal) => ({
        name: signal.name,
        status: signal.status,
        value: signal.value,
        unit: signal.unit,
      })),
    };

    logger(`sum(1..10000) = ${summary.value}`);
    logger(`selected strategy: ${summary.strategyId} (tier ${summary.qualityTier})`);
    logger(`decision: ${summary.decisionKind}; quality check: ${summary.qualityStatus}`);
    for (const signal of summary.signals) {
      const display =
        signal.value === undefined
          ? signal.status
          : `${(signal.value / (1024 * 1024)).toFixed(1)} MB`;
      logger(`signal ${signal.name}: ${display}`);
    }
    return summary;
  } finally {
    await runtime.close();
  }
}

async function createDefaultProvider(): Promise<SignalProvider> {
  return new ProcessMemoryProvider();
}

function expectedSum(input: number): number {
  return (input * (input + 1)) / 2;
}
