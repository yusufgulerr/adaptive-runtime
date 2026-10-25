import { readFileSync } from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import {
  type AdaptiveRuntime,
  createAdaptiveRuntime,
  type SignalProvider,
  type Strategy,
} from "../src/index.js";

/**
 * Local concurrency and retained-heap observations for the runtime.
 *
 * This is not a production throughput or memory claim. It measures the
 * runtime's own scheduling path with a fixed amount of strategy work, a
 * trivial in-memory provider, and no external I/O. No CI threshold is applied.
 *
 * Environment overrides:
 * - CONCURRENCY_RUNS: total measured runs per level per round (default 4096)
 * - CONCURRENCY_LEVELS: comma-separated concurrency levels (default 1,4,16,64)
 * - CONCURRENCY_ROUNDS: measured rounds, at least 3 (default 3)
 * - CONCURRENCY_HEAP_RUNS: runs per retained-heap sample (default 10000)
 * - CONCURRENCY_HEAP_SAMPLES: retained-heap samples (default 3)
 * - CONCURRENCY_SHARED_CALLERS: callers in the shared-read check (default 64)
 */

const SIGNAL_NAME = "concurrency.pressure";
const CACHE_INTERVAL_MS = 3_600_000;
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

function createProvider(read: SignalProvider["read"]): SignalProvider {
  return {
    id: "concurrency-benchmark",
    signals: [{ name: SIGNAL_NAME, unit: "count" }],
    read,
  };
}

const immediateProvider = createProvider((context) => [
  {
    name: SIGNAL_NAME,
    unit: "count",
    status: "ok",
    value: 5,
    observedAt: context.now,
  },
]);

function createBenchmarkRuntime(
  provider: SignalProvider,
  evaluationIntervalMs: number,
): AdaptiveRuntime {
  return createAdaptiveRuntime({
    providers: [provider],
    policy: {
      evaluationIntervalMs,
      maxSignalAgeMs: Math.max(evaluationIntervalMs, 5_000),
      adaptationEnabled: true,
      consecutiveSamples: 1,
      budgets: [
        {
          id: "concurrency-budget",
          signal: SIGNAL_NAME,
          limit: 100,
          recoverBelow: 80,
          tierReduction: 1,
        },
      ],
    },
  });
}

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function levelsFromEnv(): readonly number[] {
  const raw = process.env.CONCURRENCY_LEVELS ?? "1,4,16,64";
  const levels = raw.split(",").map((part) => Number(part.trim()));
  if (levels.length === 0) {
    throw new Error("CONCURRENCY_LEVELS must contain at least one level.");
  }
  for (const level of levels) {
    if (!Number.isInteger(level) || level < 1) {
      throw new Error(`CONCURRENCY_LEVELS contains an invalid level: ${String(level)}.`);
    }
  }
  return [...new Set(levels)].sort((left, right) => left - right);
}

function operationIds(prefix: string, count: number): readonly string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) {
    return ordered[middle] ?? Number.NaN;
  }
  return ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2;
}

interface WorkerOptions {
  readonly runtime: AdaptiveRuntime;
  readonly operationIds: readonly string[];
  readonly concurrency: number;
  readonly runs: number;
  readonly startIndex: number;
  readonly expected: (input: number) => number;
  readonly latencies?: number[];
}

interface PackageIdentity {
  readonly name: string;
  readonly version: string;
}

interface EnvironmentInfo {
  readonly nodeVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly timestamp: string;
}

interface ConcurrencyConfig {
  readonly concurrencyLevels: readonly number[];
  readonly operationsCount: number;
  readonly iterationsPerLevel: number;
}

interface ConcurrencyLevelResult {
  readonly concurrency: number;
  readonly totalOperations: number;
  readonly opsPerSec: number;
  readonly scalingFactor: number;
  readonly p50Us: number;
  readonly p95Us: number;
  readonly p99Us: number;
  readonly heapDeltaBytes: number;
}

interface ConcurrencyBenchmarkDocument {
  readonly schemaVersion: 1;
  readonly benchmark: "concurrency";
  readonly package: PackageIdentity;
  readonly environment: EnvironmentInfo;
  readonly config: ConcurrencyConfig;
  readonly results: readonly ConcurrencyLevelResult[];
}

function readPackageIdentity(): PackageIdentity {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const parsed = JSON.parse(raw) as { readonly name?: unknown; readonly version?: unknown };
  if (typeof parsed.name !== "string" || typeof parsed.version !== "string") {
    throw new Error("package.json must define string name and version fields.");
  }
  return { name: parsed.name, version: parsed.version };
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(Math.max(0, Math.floor((p / 100) * sorted.length)), sorted.length - 1);
  return sorted[index] ?? 0;
}

const JSON_OUTPUT = process.argv.includes("--json");

function parseIterationsArg(): number | undefined {
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === undefined) {
      continue;
    }
    if (arg.startsWith("--iterations=")) {
      const val = Number(arg.slice("--iterations=".length));
      if (Number.isInteger(val) && val >= 1) {
        return val;
      }
    } else if (arg === "--iterations") {
      const next = process.argv[i + 1];
      if (next !== undefined) {
        const val = Number(next);
        if (Number.isInteger(val) && val >= 1) {
          return val;
        }
      }
    }
  }
  return undefined;
}

const ITERATIONS_OVERRIDE = parseIterationsArg();

/**
 * Starts `concurrency` worker loops and splits `runs` across them. Each worker
 * awaits one run before starting its next one; while work remains, the in-flight
 * run count is the requested level.
 */
async function runWorkers(options: WorkerOptions): Promise<void> {
  const { runtime, operationIds, concurrency, runs, startIndex, expected, latencies } = options;
  const baseRuns = Math.floor(runs / concurrency);
  const remainder = runs % concurrency;
  const workers = Array.from({ length: concurrency }, (_, workerIndex) => {
    const workerRuns = baseRuns + (workerIndex < remainder ? 1 : 0);
    const inputOffset = workerIndex * baseRuns + Math.min(workerIndex, remainder);
    const operationId = operationIds[workerIndex % operationIds.length];
    if (operationId === undefined) {
      throw new Error("No operation id is available for a benchmark worker.");
    }
    return (async () => {
      for (let offset = 0; offset < workerRuns; offset += 1) {
        const input = startIndex + inputOffset + offset;
        const opStart = latencies !== undefined ? process.hrtime.bigint() : 0n;
        const result = await runtime.run({ operationId, input, strategies });
        if (latencies !== undefined) {
          const elapsedUs = Number(process.hrtime.bigint() - opStart) / 1_000;
          latencies.push(elapsedUs);
        }
        const expectedValue = expected(input);
        if (result.value !== expectedValue) {
          throw new Error(
            `Operation "${operationId}" returned ${String(result.value)}, expected ${expectedValue}.`,
          );
        }
      }
    })();
  });
  const settled = await Promise.allSettled(workers);
  for (const outcome of settled) {
    if (outcome.status === "rejected") {
      throw outcome.reason;
    }
  }
}

interface ThroughputResult {
  readonly level: number;
  readonly samples: readonly number[];
  readonly median: number;
}

function toThroughputResults(
  samples: ReadonlyMap<number, readonly number[]>,
): readonly ThroughputResult[] {
  return [...samples.entries()]
    .sort(([left], [right]) => left - right)
    .map(([level, values]) => ({
      level,
      samples: values,
      median: median(values),
    }));
}

async function measureThroughput(
  mode: "distinct" | "same",
  levels: readonly number[],
  runs: number,
  rounds: number,
  warmupRuns: number,
): Promise<readonly ThroughputResult[]> {
  const runtime = createBenchmarkRuntime(immediateProvider, CACHE_INTERVAL_MS);
  const samples = new Map<number, number[]>();
  try {
    for (let round = 0; round < rounds; round += 1) {
      const offset = round % levels.length;
      const order = [...levels.slice(offset), ...levels.slice(0, offset)];
      for (const level of order) {
        const ids =
          mode === "distinct" ? operationIds(`distinct-${level}`, level) : [`same-${level}`];
        await runWorkers({
          runtime,
          operationIds: ids,
          concurrency: level,
          runs: warmupRuns,
          startIndex: -warmupRuns,
          expected: work,
        });
        const started = process.hrtime.bigint();
        await runWorkers({
          runtime,
          operationIds: ids,
          concurrency: level,
          runs,
          startIndex: round * runs,
          expected: work,
        });
        const elapsedSeconds = Number(process.hrtime.bigint() - started) / 1_000_000_000;
        const existing = samples.get(level) ?? [];
        existing.push(runs / elapsedSeconds);
        samples.set(level, existing);
      }
    }
  } finally {
    await runtime.close();
  }
  return toThroughputResults(samples);
}

function formatRate(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function printThroughput(
  title: string,
  description: string,
  results: readonly ThroughputResult[],
): void {
  console.log(title);
  console.log(description);
  console.log("level   median runs/s   samples (runs/s)");
  for (const result of results) {
    const samples = result.samples.map((value) => formatRate(value)).join(", ");
    console.log(
      `${String(result.level).padStart(5)}   ${formatRate(result.median).padStart(14)}   ${samples}`,
    );
  }
  console.log("");
}

async function runSharedReadCheck(callers: number): Promise<void> {
  let providerReads = 0;
  const provider = createProvider(async (context) => {
    providerReads += 1;
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 0);
    });
    return [
      {
        name: SIGNAL_NAME,
        unit: "count",
        status: "ok",
        value: 5,
        observedAt: context.now,
      },
    ];
  });
  const runtime = createAdaptiveRuntime({
    providers: [provider],
    policy: {
      evaluationIntervalMs: 0,
      adaptationEnabled: false,
    },
  });
  let activeCallers = 0;
  let maxActiveCallers = 0;
  try {
    const started = process.hrtime.bigint();
    const pending = Array.from({ length: callers }, (_, index) => {
      const operationId = `shared-${index}`;
      activeCallers += 1;
      maxActiveCallers = Math.max(maxActiveCallers, activeCallers);
      return runtime
        .run({ operationId, input: index, strategies })
        .then((result) => {
          const expected = work(index);
          if (result.value !== expected) {
            throw new Error(
              `Operation "${operationId}" returned ${String(result.value)}, expected ${expected}.`,
            );
          }
        })
        .finally(() => {
          activeCallers -= 1;
        });
    });
    const settled = await Promise.allSettled(pending);
    for (const outcome of settled) {
      if (outcome.status === "rejected") {
        throw outcome.reason;
      }
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    const stats = runtime.getStats("shared-0");
    console.log("Shared provider read observation");
    console.log(
      `  concurrent callers launched: ${callers}; max observed in-flight run() calls: ${maxActiveCallers}`,
    );
    console.log(
      `  provider reads observed: ${providerReads} (sharing is opportunistic; no exact count is asserted)`,
    );
    console.log(
      `  elapsed: ${elapsedMs.toFixed(2)} ms; sample stats for "shared-0": runs=${stats.runs}, successes=${stats.successes}, failures=${stats.failures}`,
    );
    console.log(
      "  The provider resolves on a later macrotask. Callers that arrive while the read is in flight can share it.",
    );
    console.log("");
  } finally {
    await runtime.close();
  }
}

function formatBytes(value: number): string {
  const sign = value >= 0 ? "+" : "-";
  const absolute = Math.abs(value);
  if (absolute < 1024) {
    return `${sign}${absolute.toFixed(0)} B`;
  }
  if (absolute < 1024 ** 2) {
    return `${sign}${(absolute / 1024).toFixed(1)} KiB`;
  }
  return `${sign}${(absolute / 1024 ** 2).toFixed(2)} MiB`;
}

async function heapUsedAfterGc(): Promise<number> {
  const gc = globalThis.gc;
  if (typeof gc !== "function") {
    throw new Error("global.gc is not available.");
  }
  gc();
  await new Promise<void>((resolve) => {
    setImmediate(() => {
      resolve();
    });
  });
  gc();
  return process.memoryUsage().heapUsed;
}

async function runHeapScenario(
  level: number,
  runsPerSample: number,
  sampleCount: number,
): Promise<void> {
  if (typeof globalThis.gc !== "function") {
    console.log("Retained-heap observation");
    console.log("  not measured: global.gc() is unavailable. Re-run with --expose-gc.");
    console.log("");
    return;
  }

  const runtime = createBenchmarkRuntime(immediateProvider, CACHE_INTERVAL_MS);
  const ids = operationIds("heap", level);
  try {
    await runWorkers({
      runtime,
      operationIds: ids,
      concurrency: level,
      runs: Math.min(512, runsPerSample),
      startIndex: -512,
      expected: work,
    });

    const deltas: number[] = [];
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const before = await heapUsedAfterGc();
      await runWorkers({
        runtime,
        operationIds: ids,
        concurrency: level,
        runs: runsPerSample,
        startIndex: sample * runsPerSample,
        expected: work,
      });
      const after = await heapUsedAfterGc();
      deltas.push(after - before);
    }

    const medianDelta = median(deltas);
    const perRun = medianDelta / runsPerSample;
    console.log("Retained-heap observation (approximate and noisy; not a leak test)");
    console.log(
      `  fixed operation-id set: ${ids.length}; concurrency: ${level}; ${runsPerSample.toLocaleString("en-US")} runs per sample; ${sampleCount} samples`,
    );
    console.log(
      `  median heapUsed delta: ${formatBytes(medianDelta)} (${perRun >= 0 ? "+" : "-"}${Math.abs(perRun).toFixed(2)} B/run); samples: ${deltas.map((delta) => formatBytes(delta)).join(", ")}`,
    );
    console.log(
      "  Negative values mean GC reclaimed more than was retained. This fixed-id run does not exercise unbounded operation-id cardinality and does not prove the absence of leaks.",
    );
    console.log("");
  } finally {
    await runtime.close();
  }
}

async function getHeapUsed(): Promise<number> {
  if (typeof globalThis.gc === "function") {
    return heapUsedAfterGc();
  }
  return process.memoryUsage().heapUsed;
}

async function main(): Promise<void> {
  const runs = ITERATIONS_OVERRIDE ?? positiveIntegerFromEnv("CONCURRENCY_RUNS", 4_096);
  const defaultRounds = ITERATIONS_OVERRIDE !== undefined ? 1 : 3;
  const rounds = positiveIntegerFromEnv("CONCURRENCY_ROUNDS", defaultRounds);
  const levels = levelsFromEnv();
  const maxLevel = levels[levels.length - 1] ?? 1;
  if (rounds < 1) {
    throw new Error("CONCURRENCY_ROUNDS must be at least 1.");
  }
  if (rounds < 3 && ITERATIONS_OVERRIDE === undefined && !JSON_OUTPUT) {
    throw new Error("CONCURRENCY_ROUNDS must be at least 3 to report a median.");
  }
  if (runs < maxLevel && ITERATIONS_OVERRIDE === undefined) {
    throw new Error(
      `CONCURRENCY_RUNS (${runs}) must be at least the largest concurrency level (${maxLevel}).`,
    );
  }
  const warmupRuns =
    ITERATIONS_OVERRIDE !== undefined
      ? Math.min(512, Math.max(1, Math.floor(runs / 4)))
      : Math.max(maxLevel, Math.min(512, Math.floor(runs / 4)));
  const heapRuns = positiveIntegerFromEnv("CONCURRENCY_HEAP_RUNS", 10_000);
  const heapSamples = positiveIntegerFromEnv("CONCURRENCY_HEAP_SAMPLES", 3);
  const sharedCallers = positiveIntegerFromEnv("CONCURRENCY_SHARED_CALLERS", 64);
  const heapLevel = Math.min(maxLevel, 64);

  if (JSON_OUTPUT) {
    const runtime = createBenchmarkRuntime(immediateProvider, CACHE_INTERVAL_MS);
    const results: ConcurrencyLevelResult[] = [];
    let baselineOpsPerSec = 0;
    try {
      for (const level of levels) {
        const ids = operationIds(`distinct-${level}`, level);
        await runWorkers({
          runtime,
          operationIds: ids,
          concurrency: level,
          runs: warmupRuns,
          startIndex: -warmupRuns,
          expected: work,
        });

        const roundRates: number[] = [];
        const latencies: number[] = [];
        let totalHeapDelta = 0;

        for (let round = 0; round < rounds; round += 1) {
          const heapBefore = await getHeapUsed();
          const started = process.hrtime.bigint();
          await runWorkers({
            runtime,
            operationIds: ids,
            concurrency: level,
            runs,
            startIndex: round * runs,
            expected: work,
            latencies,
          });
          const elapsedSeconds = Number(process.hrtime.bigint() - started) / 1_000_000_000;
          const heapAfter = await getHeapUsed();
          roundRates.push(runs / Math.max(elapsedSeconds, 1e-9));
          totalHeapDelta += heapAfter - heapBefore;
        }

        const opsPerSec = median(roundRates);
        if (baselineOpsPerSec === 0) {
          baselineOpsPerSec = opsPerSec;
        }
        const scalingFactor = baselineOpsPerSec > 0 ? opsPerSec / baselineOpsPerSec : 1;

        latencies.sort((left, right) => left - right);
        const p50Us = percentile(latencies, 50);
        const p95Us = percentile(latencies, 95);
        const p99Us = percentile(latencies, 99);
        const heapDeltaBytes = Math.round(totalHeapDelta / rounds);

        results.push({
          concurrency: level,
          totalOperations: runs,
          opsPerSec: Number(opsPerSec.toFixed(2)),
          scalingFactor: Number(scalingFactor.toFixed(3)),
          p50Us: Number(p50Us.toFixed(3)),
          p95Us: Number(p95Us.toFixed(3)),
          p99Us: Number(p99Us.toFixed(3)),
          heapDeltaBytes,
        });
      }
    } finally {
      await runtime.close();
    }

    const document: ConcurrencyBenchmarkDocument = {
      schemaVersion: 1,
      benchmark: "concurrency",
      package: readPackageIdentity(),
      environment: {
        nodeVersion: process.version,
        platform: platform(),
        arch: arch(),
        timestamp: new Date().toISOString(),
      },
      config: {
        concurrencyLevels: [...levels],
        operationsCount: levels.length * runs,
        iterationsPerLevel: runs,
      },
      results,
    };

    console.log(JSON.stringify(document, null, 2));
    return;
  }

  console.log("Adaptive Runtime local concurrency and memory observations");
  console.log(
    `Node ${process.version}; ${platform()} ${release()}; ${cpus()[0]?.model ?? "unknown CPU"}; ${cpus().length} logical cores; ${(totalmem() / 1024 ** 3).toFixed(1)} GiB RAM`,
  );
  console.log(
    `Config: ${runs.toLocaleString("en-US")} runs per level per round; ${rounds} rounds; levels ${levels.join(", ")}; ${warmupRuns} warmup runs per level per round.`,
  );
  console.log(
    "Local observation only; not a production throughput or memory claim. No CI threshold is enforced.",
  );
  console.log("");

  const distinct = await measureThroughput("distinct", levels, runs, rounds, warmupRuns);
  printThroughput(
    "Concurrent throughput, distinct operationIds",
    "Each worker uses its own operationId, so selection is not serialized across workers. Higher is better.",
    distinct,
  );

  const same = await measureThroughput("same", levels, runs, rounds, warmupRuns);
  printThroughput(
    "Same operationId concurrency (selection serialized per id)",
    "All workers share one operationId, so selection queues on the runtime's per-operation lock. This is a distinct scenario, not a pass/fail comparison.",
    same,
  );

  await runSharedReadCheck(sharedCallers);
  await runHeapScenario(heapLevel, heapRuns, heapSamples);

  console.log("Interpretation");
  console.log(
    "  Concurrency level is the number of worker loops; each worker awaits one run before starting its next run.",
  );
  console.log(
    "  This is a single-threaded event-loop workload; levels above 1 measure scheduling and interleaving, not multi-core scaling.",
  );
  console.log(
    "  Runs/s includes the fixed strategy work, promise scheduling, and the runtime path. It is not a production throughput claim.",
  );
  console.log(
    "  Same-id runs queue for selection; strategy execution is outside that lock and may overlap with other selections.",
  );
  console.log(
    "  Distinct ids avoid per-id lock contention, but this is still one event loop; same-id results may be similar or higher.",
  );
  console.log(
    "  Heap deltas vary with GC timing, JIT, and process state; negative values are possible. Do not infer a leak or its absence.",
  );
}

await main();
