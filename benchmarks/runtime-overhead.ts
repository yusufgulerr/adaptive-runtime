import { cpus, platform, release, totalmem } from "node:os";
import { createAdaptiveRuntime, type SignalProvider, type Strategy } from "../src/index.js";

/**
 * Measures end-to-end call overhead on the local machine.
 *
 * This is a micro-benchmark of the runtime's own selection and dispatch path,
 * not a claim about application throughput or production performance. The
 * "direct" row is the same pure function without the runtime. All modes do the
 * same deterministic work and are checked for identical results.
 */

const ITERATIONS = Number.parseInt(process.env.BENCH_ITERATIONS ?? "20000", 10);
const ROUNDS = Number.parseInt(process.env.BENCH_ROUNDS ?? "7", 10);
const WARMUP = Math.min(2_000, Math.floor(ITERATIONS / 4));
const WORK = Array.from({ length: 64 }, (_, index) => (index * 17) % 29);

function work(input: number): number {
  let total = input + 1;
  for (const value of WORK) {
    total = (total * 31 + value) % 1_000_003;
  }
  return total;
}

const strategies: readonly Strategy<number, number>[] = [
  {
    id: "primary",
    qualityTier: 2,
    costTier: 1,
    run: ({ input }) => work(input),
  },
  {
    id: "economy",
    qualityTier: 1,
    costTier: 0,
    run: ({ input }) => work(input),
  },
];

const provider: SignalProvider = {
  id: "benchmark-pressure",
  signals: [{ name: "benchmark.pressure", unit: "count" }],
  read: (context) => [
    {
      name: "benchmark.pressure",
      unit: "count",
      status: "ok",
      value: 5,
      observedAt: context.now,
    },
  ],
};

type Mode = {
  readonly label: string;
  readonly run: (operationId: string, input: number) => Promise<number> | number;
  readonly close?: () => Promise<void>;
};

async function createModes(): Promise<readonly Mode[]> {
  const manual = createAdaptiveRuntime({
    policy: { adaptationEnabled: false, evaluationIntervalMs: 0 },
  });
  const adaptive = createAdaptiveRuntime({
    providers: [provider],
    policy: {
      evaluationIntervalMs: 0,
      consecutiveSamples: 1,
      budgets: [
        {
          id: "benchmark",
          signal: "benchmark.pressure",
          limit: 100,
          recoverBelow: 80,
          tierReduction: 1,
        },
      ],
    },
  });
  const cached = createAdaptiveRuntime({
    providers: [provider],
    policy: {
      evaluationIntervalMs: 60_000,
      consecutiveSamples: 1,
      budgets: [
        {
          id: "benchmark",
          signal: "benchmark.pressure",
          limit: 100,
          recoverBelow: 80,
          tierReduction: 1,
        },
      ],
    },
  });

  return [
    {
      label: "direct call",
      run: (_operationId, input) => work(input),
    },
    {
      label: "runtime, static policy",
      run: async (operationId, input) => {
        const result = await manual.run({ operationId, input, strategies });
        return result.value;
      },
      close: () => manual.close(),
    },
    {
      label: "runtime, adaptive (fresh read)",
      run: async (operationId, input) => {
        const result = await adaptive.run({ operationId, input, strategies });
        return result.value;
      },
      close: () => adaptive.close(),
    },
    {
      label: "runtime, adaptive (cached read)",
      run: async (operationId, input) => {
        const result = await cached.run({ operationId, input, strategies });
        return result.value;
      },
      close: () => cached.close(),
    },
  ];
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) {
    return ordered[middle] ?? Number.NaN;
  }
  return ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2;
}

async function measure(mode: Mode, rounds: number): Promise<number[]> {
  const samples: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    if (globalThis.gc !== undefined) {
      globalThis.gc();
    }
    for (let index = 0; index < WARMUP; index += 1) {
      await mode.run(`warmup-${mode.label}`, index);
    }
    let checksum = 0;
    const started = process.hrtime.bigint();
    for (let index = 0; index < ITERATIONS; index += 1) {
      checksum ^= await mode.run(`bench-${mode.label}`, index);
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    if (!Number.isFinite(checksum)) {
      throw new Error(`Benchmark checksum for "${mode.label}" is not finite.`);
    }
    samples.push((elapsedMs * 1_000) / ITERATIONS);
  }
  return samples;
}

async function main(): Promise<void> {
  if (!Number.isInteger(ITERATIONS) || ITERATIONS < 100) {
    throw new Error("BENCH_ITERATIONS must be an integer >= 100.");
  }
  if (!Number.isInteger(ROUNDS) || ROUNDS < 1) {
    throw new Error("BENCH_ROUNDS must be an integer >= 1.");
  }

  const modes = await createModes();
  const results = new Map<string, number[]>();
  let verification = 0;
  try {
    for (let round = 0; round < ROUNDS; round += 1) {
      for (let offset = 0; offset < modes.length; offset += 1) {
        const mode = modes[(round + offset) % modes.length];
        if (mode === undefined) {
          continue;
        }
        const existing = results.get(mode.label) ?? [];
        existing.push(...(await measure(mode, 1)));
        results.set(mode.label, existing);
      }
    }

    const referenceMode = modes[0];
    if (referenceMode === undefined) {
      throw new Error("No benchmark modes were created.");
    }
    verification = await referenceMode.run("verify", 42);
    for (const mode of modes.slice(1)) {
      const value = await mode.run("verify", 42);
      if (value !== verification) {
        throw new Error(`Mode "${mode.label}" returned ${value}, expected ${verification}.`);
      }
    }
  } finally {
    await Promise.all(modes.map((mode) => mode.close?.()));
  }

  console.log("Adaptive Runtime local micro-benchmark");
  console.log(
    `Node ${process.version}; ${platform()} ${release()}; ${cpus()[0]?.model ?? "unknown CPU"}; ${cpus().length} logical cores; ${(totalmem() / 1024 ** 3).toFixed(1)} GiB RAM`,
  );
  console.log(
    `${ITERATIONS.toLocaleString("en-US")} runs per round, ${ROUNDS} rounds, ${WARMUP.toLocaleString("en-US")} warmup runs per round; median per run.`,
  );
  console.log("");
  console.log(
    "mode                              median µs/run   relative to direct   samples (µs)",
  );
  const directMedian = median(results.get("direct call") ?? [Number.NaN]);
  for (const mode of modes) {
    const samples = results.get(mode.label) ?? [];
    const value = median(samples);
    const relative = value / directMedian;
    console.log(
      `${mode.label.padEnd(33)} ${value.toFixed(3).padStart(13)}   ${`${relative.toFixed(2)}x`.padStart(18)}   ${samples
        .map((sample) => sample.toFixed(2))
        .join(", ")}`,
    );
  }
  console.log("");
  console.log(
    `Verification: every mode returned ${verification} for the checked input. Runtime behavior is not dead-code-eliminated.`,
  );
  console.log(
    "Interpretation: lower is better; the difference from direct call is runtime overhead, not algorithm speed.",
  );
}

await main();
