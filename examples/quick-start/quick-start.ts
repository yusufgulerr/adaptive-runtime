import { createAdaptiveRuntime, ProcessMemoryProvider } from "../../src/index.js";

/**
 * The README quick start, runnable from the repository with `npm run example:quick-start`.
 * A published package would import from "adaptive-runtime" instead of src/.
 */
const runtime = createAdaptiveRuntime({
  providers: [new ProcessMemoryProvider()],
  policy: {
    evaluationIntervalMs: 1_000,
    budgets: [
      {
        id: "heap-pressure",
        signal: "process.memory.heapUsed",
        limit: 512 * 1024 * 1024,
        recoverBelow: 384 * 1024 * 1024,
        tierReduction: 1,
      },
    ],
  },
});

try {
  const { value, metadata } = await runtime.run({
    operationId: "sum-to-n",
    input: 10_000,
    strategies: [
      {
        id: "iterative",
        qualityTier: 2,
        run: ({ input }) => {
          let total = 0;
          for (let index = 1; index <= input; index += 1) total += index;
          return total;
        },
      },
      {
        id: "closed-form",
        qualityTier: 1,
        run: ({ input }) => (input * (input + 1)) / 2,
      },
    ],
  });

  console.log(`strategy: ${metadata.strategyId}`);
  console.log(`value: ${value}`);
  console.log(`decision: ${metadata.decision.kind}`);
} finally {
  await runtime.close();
}
