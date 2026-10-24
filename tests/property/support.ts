import fc from "fast-check";

const DEFAULT_NUM_RUNS = 100;
const MAX_NUM_RUNS = 100_000;
const DEFAULT_SEED = 0x5eed_1234;

function readRunCount(raw: string | undefined, fallback: number, maximum: number): number {
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(parsed, maximum);
}

function readSeed(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_SEED;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed >>> 0 : DEFAULT_SEED;
}

export const fuzzRuns = readRunCount(process.env.FUZZ_RUNS, DEFAULT_NUM_RUNS, MAX_NUM_RUNS);
export const fuzzSeed = readSeed(process.env.FUZZ_SEED);
export const asyncFuzzRuns = Math.min(fuzzRuns, 50);
export const identifierArb = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_-]{0,7}$/);

export const errorRateGuardOptionsArb = fc.record({
  maxErrorRate: fc.double({ min: 0, max: 1, noNaN: true }),
});

export const latencyBudgetOptionsArb = fc.record({
  maxLatencyMs: fc.double({ min: 0.1, max: 10_000, noNaN: true }),
  preferLowestCost: fc.boolean(),
});

fc.configureGlobal({ numRuns: fuzzRuns, seed: fuzzSeed });

export { fc };
