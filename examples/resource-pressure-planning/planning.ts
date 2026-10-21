import { createAdaptiveRuntime, type Strategy } from "../../src/index.js";
import { ScriptedSignalProvider } from "../shared/scripted-signal-provider.js";

export const PLANNING_OPERATION = "shift-planning";
export const PLANNING_HEAP_SIGNAL = "process.memory.heapUsed";
export const PLANNING_LOOP_SIGNAL = "eventLoop.delay.p95";

const MEBIBYTE = 1024 * 1024;

export interface Job {
  readonly id: string;
  readonly priority: number;
  readonly duration: number;
}

export interface PlanInput {
  readonly jobs: readonly Job[];
  readonly capacity: number;
}

export interface PlanResult {
  readonly jobs: readonly Job[];
  readonly totalPriority: number;
  readonly totalDuration: number;
  readonly strategyId: string;
}

export interface PlanningRunSummary {
  readonly run: number;
  readonly heapUsedMb: number;
  readonly loopDelayMs: number;
  readonly strategyId: string;
  readonly priority: number;
  readonly qualityRatio: number;
  readonly duration: number;
  readonly decisionKind: string;
  readonly reasons: readonly string[];
}

export interface PlanningExampleResult {
  readonly summary: readonly PlanningRunSummary[];
  readonly optimalPriority: number;
  readonly strategySequence: readonly string[];
}

export interface PlanningExampleOptions {
  readonly logger?: (line: string) => void;
}

const JOBS: readonly Job[] = [
  { id: "j1", priority: 8, duration: 3 },
  { id: "j2", priority: 6, duration: 2 },
  { id: "j3", priority: 9, duration: 4 },
  { id: "j4", priority: 5, duration: 1 },
  { id: "j5", priority: 7, duration: 3 },
  { id: "j6", priority: 10, duration: 5 },
  { id: "j7", priority: 4, duration: 2 },
  { id: "j8", priority: 3, duration: 1 },
  { id: "j9", priority: 6, duration: 3 },
  { id: "j10", priority: 8, duration: 4 },
  { id: "j11", priority: 5, duration: 2 },
  { id: "j12", priority: 7, duration: 1 },
  { id: "j13", priority: 9, duration: 3 },
  { id: "j14", priority: 2, duration: 1 },
  { id: "j15", priority: 6, duration: 2 },
  { id: "j16", priority: 4, duration: 1 },
  { id: "j17", priority: 5, duration: 2 },
  { id: "j18", priority: 3, duration: 1 },
];
const CAPACITY = 30;

function structuralCheck(value: PlanResult, context: { input: PlanInput }) {
  const ids = new Set(value.jobs.map((job) => job.id));
  const duration = value.jobs.reduce((sum, job) => sum + job.duration, 0);
  const priority = value.jobs.reduce((sum, job) => sum + job.priority, 0);
  return {
    ok:
      ids.size === value.jobs.length &&
      duration === value.totalDuration &&
      priority === value.totalPriority &&
      duration <= context.input.capacity,
    detail: "Structural check only: capacity, totals and unique ids; not optimality.",
  };
}

function makeResult(jobs: readonly Job[], strategyId: string): PlanResult {
  return {
    jobs,
    totalDuration: jobs.reduce((sum, job) => sum + job.duration, 0),
    totalPriority: jobs.reduce((sum, job) => sum + job.priority, 0),
    strategyId,
  };
}

/** Exact 0/1 knapsack for the small integer-capacity fixture. */
function solveOptimal(input: PlanInput): PlanResult {
  interface Cell {
    priority: number;
    jobs: readonly Job[];
  }
  const cells: Cell[] = Array.from({ length: input.capacity + 1 }, () => ({
    priority: 0,
    jobs: [],
  }));
  for (const job of input.jobs) {
    for (let capacity = input.capacity; capacity >= job.duration; capacity -= 1) {
      const previous = cells[capacity - job.duration];
      if (previous === undefined) {
        continue;
      }
      const candidate = previous.priority + job.priority;
      const current = cells[capacity];
      if (current !== undefined && candidate > current.priority) {
        cells[capacity] = {
          priority: candidate,
          jobs: [...previous.jobs, job],
        };
      }
    }
  }
  const best = cells[input.capacity];
  return makeResult(best?.jobs ?? [], "optimal");
}

function compareJobIds(left: Job, right: Job): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function solveRatioGreedy(input: PlanInput): PlanResult {
  const ordered = [...input.jobs].sort(
    (left, right) =>
      right.priority / right.duration - left.priority / left.duration ||
      right.priority - left.priority ||
      compareJobIds(left, right),
  );
  const selected: Job[] = [];
  let used = 0;
  for (const job of ordered) {
    if (used + job.duration <= input.capacity) {
      selected.push(job);
      used += job.duration;
    }
  }
  return makeResult(selected, "balanced");
}

function solveShortestFirst(input: PlanInput): PlanResult {
  const ordered = [...input.jobs].sort(
    (left, right) =>
      left.duration - right.duration ||
      right.priority - left.priority ||
      compareJobIds(left, right),
  );
  const selected: Job[] = [];
  let used = 0;
  for (const job of ordered) {
    if (used + job.duration <= input.capacity) {
      selected.push(job);
      used += job.duration;
    }
  }
  return makeResult(selected, "economy");
}

const STRATEGIES: readonly Strategy<PlanInput, PlanResult>[] = [
  {
    id: "optimal",
    qualityTier: 3,
    costTier: 3,
    description: "Exact knapsack planning; best priority for the fixture.",
    checkQuality: structuralCheck,
    run: ({ input }) => solveOptimal(input),
  },
  {
    id: "balanced",
    qualityTier: 2,
    costTier: 2,
    description: "Priority-per-minute greedy plan.",
    checkQuality: structuralCheck,
    run: ({ input }) => solveRatioGreedy(input),
  },
  {
    id: "economy",
    qualityTier: 1,
    costTier: 1,
    description: "Shortest-job-first plan; cheapest to produce.",
    checkQuality: structuralCheck,
    run: ({ input }) => solveShortestFirst(input),
  },
];

/**
 * Demonstrates stable transitions while two simulated resource readings move
 * from low to high pressure and back. Selection is deterministic; timings are
 * local observations.
 */
export async function runPlanningExample(
  options: PlanningExampleOptions = {},
): Promise<PlanningExampleResult> {
  const logger = options.logger ?? (() => undefined);
  const optimalPriority = solveOptimal({ jobs: JOBS, capacity: CAPACITY }).totalPriority;

  const heapMb = [100, 600, 600, 600, 600, 100, 100, 100];
  const loopDelayMs = [5, 55, 55, 55, 55, 5, 5, 5];
  const provider = new ScriptedSignalProvider({
    id: "simulated-pressure",
    script: [
      {
        name: PLANNING_HEAP_SIGNAL,
        unit: "bytes",
        values: heapMb.map((value) => value * MEBIBYTE),
      },
      {
        name: PLANNING_LOOP_SIGNAL,
        unit: "milliseconds",
        values: loopDelayMs,
      },
    ],
  });

  const runtime = createAdaptiveRuntime({
    providers: [provider],
    policy: {
      evaluationIntervalMs: 0,
      consecutiveSamples: 2,
      budgets: [
        {
          id: "memory-pressure",
          signal: PLANNING_HEAP_SIGNAL,
          limit: 512 * MEBIBYTE,
          recoverBelow: 400 * MEBIBYTE,
          tierReduction: 1,
          consecutiveSamples: 2,
        },
        {
          id: "loop-pressure",
          signal: PLANNING_LOOP_SIGNAL,
          limit: 40,
          recoverBelow: 20,
          tierReduction: 1,
          consecutiveSamples: 2,
        },
      ],
      missingSignalBehavior: "fallback",
      fallbackStrategyId: "economy",
    },
  });

  const summary: PlanningRunSummary[] = [];
  try {
    for (const [index, heap] of heapMb.entries()) {
      const result = await runtime.run({
        operationId: PLANNING_OPERATION,
        input: { jobs: JOBS, capacity: CAPACITY },
        strategies: STRATEGIES,
      });
      summary.push({
        run: index + 1,
        heapUsedMb: heap,
        loopDelayMs: loopDelayMs[index] ?? 0,
        strategyId: result.metadata.strategyId,
        priority: result.value.totalPriority,
        qualityRatio: result.value.totalPriority / optimalPriority,
        duration: result.value.totalDuration,
        decisionKind: result.metadata.decision.kind,
        reasons: result.metadata.decision.reasons.map((reason) => reason.code),
      });
    }
  } finally {
    await runtime.close();
  }

  logger("Shift planning under simulated memory and event-loop pressure");
  logger(`jobs: ${JOBS.length}; capacity: ${CAPACITY}; optimal priority: ${optimalPriority}`);
  logger("");
  logger("run  heap    loop   selected   priority  quality  duration  decision");
  for (const row of summary) {
    logger(
      `${String(row.run).padEnd(4)} ${`${row.heapUsedMb} MB`.padEnd(7)} ${`${row.loopDelayMs} ms`.padEnd(6)} ${row.strategyId.padEnd(10)} ${String(row.priority).padStart(8)}  ${`${(row.qualityRatio * 100).toFixed(1)}%`.padStart(7)}  ${String(row.duration).padStart(8)}  ${row.decisionKind}`,
    );
  }
  logger("");
  logger("Quality is priority completed relative to the exact planner.");
  logger("The runtime only guarantees the metadata and check you provide.");

  return {
    summary,
    optimalPriority,
    strategySequence: summary.map((row) => row.strategyId),
  };
}
