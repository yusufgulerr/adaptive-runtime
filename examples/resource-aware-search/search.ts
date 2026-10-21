import { createAdaptiveRuntime, type Strategy } from "../../src/index.js";
import { ScriptedSignalProvider } from "../shared/scripted-signal-provider.js";

export const HEAP_SIGNAL = "process.memory.heapUsed";
export const SEARCH_OPERATION = "product-search";

const MEBIBYTE = 1024 * 1024;

export interface Product {
  readonly id: number;
  readonly title: string;
  readonly price: number;
}

export interface SearchInput {
  readonly query: string;
  readonly corpus: readonly Product[];
}

export interface SearchResult {
  readonly items: readonly Product[];
  readonly scanned: number;
  readonly strategyId: string;
}

export interface SearchRunSummary {
  readonly run: number;
  readonly heapUsedMb: number;
  readonly strategyId: string;
  readonly scanned: number;
  readonly matches: number;
  readonly recall: number;
  readonly durationMs: number;
  readonly decisionKind: string;
  readonly reasons: readonly string[];
}

export interface SearchExampleResult {
  readonly summary: readonly SearchRunSummary[];
  readonly expectedMatches: number;
  readonly corpusSize: number;
  readonly strategySequence: readonly string[];
}

export interface SearchExampleOptions {
  readonly corpusSize?: number;
  readonly logger?: (line: string) => void;
}

const STRATEGIES: readonly Strategy<SearchInput, SearchResult>[] = [
  {
    id: "exhaustive",
    qualityTier: 3,
    costTier: 3,
    description: "Scans the entire corpus and returns every match.",
    checkQuality: structuralCheck,
    run: (context) => search(context.input, 1, Number.POSITIVE_INFINITY, "exhaustive"),
  },
  {
    id: "balanced",
    qualityTier: 2,
    costTier: 2,
    description: "Scans 60% of the corpus; trades recall for less work.",
    checkQuality: structuralCheck,
    run: (context) => search(context.input, 0.6, Number.POSITIVE_INFINITY, "balanced"),
  },
  {
    id: "economy",
    qualityTier: 1,
    costTier: 1,
    description: "Scans 15% of the corpus and caps results at 25 items.",
    checkQuality: structuralCheck,
    run: (context) => search(context.input, 0.15, 25, "economy"),
  },
];

function structuralCheck(value: SearchResult, context: { input: SearchInput }) {
  const query = context.input.query.toLowerCase();
  const ids = new Set(value.items.map((item) => item.id));
  return {
    ok:
      value.items.length === ids.size &&
      value.items.every((item) => item.title.toLowerCase().includes(query)),
    detail: "Structural check only: verifies matching items and unique ids, not recall.",
  };
}

function search(
  input: SearchInput,
  fraction: number,
  cap: number,
  strategyId: string,
): SearchResult {
  const query = input.query.toLowerCase();
  const limit = Math.max(1, Math.floor(input.corpus.length * fraction));
  const items: Product[] = [];
  let scanned = 0;
  for (const product of input.corpus) {
    if (scanned >= limit || items.length >= cap) {
      break;
    }
    scanned += 1;
    if (product.title.toLowerCase().includes(query)) {
      items.push(product);
    }
  }
  return { items, scanned, strategyId };
}

function makeCorpus(size: number): readonly Product[] {
  return Array.from({ length: size }, (_, index) => {
    const id = index + 1;
    const wireless = index % 7 === 0;
    return {
      id,
      title: `Gadget ${id} ${wireless ? "wireless" : "wired"} keyboard`,
      price: 20 + ((index * 37) % 180),
    };
  });
}

/**
 * Demonstrates quality/recall trade-offs under simulated heap pressure.
 * Timings are local observations; selection and recall are deterministic.
 */
export async function runSearchExample(
  options: SearchExampleOptions = {},
): Promise<SearchExampleResult> {
  const logger = options.logger ?? (() => undefined);
  const corpus = makeCorpus(options.corpusSize ?? 20_000);
  const query = "wireless";
  const expectedMatches = corpus.filter((product) =>
    product.title.toLowerCase().includes(query),
  ).length;

  const heapMb = [100, 300, 300, 600, 600, 100];
  const provider = new ScriptedSignalProvider({
    id: "simulated-heap",
    script: [
      {
        name: HEAP_SIGNAL,
        unit: "bytes",
        values: heapMb.map((value) => value * MEBIBYTE),
      },
    ],
  });

  const runtime = createAdaptiveRuntime({
    providers: [provider],
    policy: {
      evaluationIntervalMs: 0,
      consecutiveSamples: 1,
      budgets: [
        {
          id: "memory-high",
          signal: HEAP_SIGNAL,
          limit: 256 * MEBIBYTE,
          recoverBelow: 200 * MEBIBYTE,
          tierReduction: 1,
          consecutiveSamples: 1,
        },
        {
          id: "memory-critical",
          signal: HEAP_SIGNAL,
          limit: 512 * MEBIBYTE,
          recoverBelow: 450 * MEBIBYTE,
          tierReduction: 1,
          consecutiveSamples: 1,
        },
      ],
      missingSignalBehavior: "fallback",
      fallbackStrategyId: "economy",
    },
  });

  const summary: SearchRunSummary[] = [];
  try {
    for (const [index, heap] of heapMb.entries()) {
      const startedAt = performance.now();
      const result = await runtime.run({
        operationId: SEARCH_OPERATION,
        input: { query, corpus },
        strategies: STRATEGIES,
      });
      const durationMs = performance.now() - startedAt;
      summary.push({
        run: index + 1,
        heapUsedMb: heap,
        strategyId: result.metadata.strategyId,
        scanned: result.value.scanned,
        matches: result.value.items.length,
        recall: result.value.items.length / expectedMatches,
        durationMs,
        decisionKind: result.metadata.decision.kind,
        reasons: result.metadata.decision.reasons.map((reason) => reason.code),
      });
    }
  } finally {
    await runtime.close();
  }

  logger("Resource-aware product search (simulated heap readings)");
  logger(
    `corpus: ${corpus.length} products; query: "${query}"; reference matches: ${expectedMatches}`,
  );
  logger("");
  logger("run  heap   selected    scanned  matches  recall   ms");
  for (const row of summary) {
    logger(
      `${String(row.run).padEnd(4)} ${`${row.heapUsedMb} MB`.padEnd(6)} ${row.strategyId.padEnd(11)} ${String(row.scanned).padStart(7)}  ${String(row.matches).padStart(7)}  ${`${(row.recall * 100).toFixed(1)}%`.padStart(6)}  ${row.durationMs.toFixed(2)}`,
    );
  }
  logger("");
  logger("Quality is measured externally as recall against the exhaustive result.");
  logger("The runtime itself only sees declared quality tiers and an optional structural check.");

  return {
    summary,
    expectedMatches,
    corpusSize: corpus.length,
    strategySequence: summary.map((row) => row.strategyId),
  };
}
