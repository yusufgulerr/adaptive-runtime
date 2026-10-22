# Benchmarks

This document records a **local micro-benchmark** of runtime call overhead. It is
not a production performance claim, a comparison with other libraries, or a
measurement of strategy speed.

## Method

Source: [`benchmarks/runtime-overhead.ts`](../benchmarks/runtime-overhead.ts)

Four modes execute the same deterministic function (`work`) over a 64-element
array:

| Mode | What it includes |
| --- | --- |
| Direct call | The function only |
| Runtime, static policy | Validation, snapshot collection with no providers, policy evaluation, strategy dispatch, stats, events, result metadata |
| Runtime, adaptive, fresh read | The above plus one in-memory provider read and budget evaluation on every run |
| Runtime, adaptive, cached read | The above with `evaluationIntervalMs: 60_000`, so the snapshot is reused |

Procedure:

- 20,000 sequential runs per round; 7 rounds.
- 2,000 warmup runs before each round.
- Median of the seven per-run means is reported.
- Mode order is rotated each round to reduce ordering bias.
- `global.gc()` is called before each round when `--expose-gc` is available.
- Every mode is verified to return the same value for a checked input, so the
  work is not optimized away.
- Calls are sequential (`await` per run). Concurrency is measured separately by
  [`benchmarks/concurrency.ts`](../benchmarks/concurrency.ts).
- The adaptive modes use one budget that stays disengaged (`value = 5`,
  `limit = 100`), so no switching occurs.

Run it:

```bash
npm run benchmark
# Optional: BENCH_ITERATIONS=50000 BENCH_ROUNDS=9 npm run benchmark
npm run benchmark:concurrency
# Optional: CONCURRENCY_RUNS=8192 CONCURRENCY_LEVELS=1,8,32 npm run benchmark:concurrency
```

## JSON output and trend comparison

`--json` switches the existing benchmark to machine-readable output. Measurement
logic, mode order, warmup, round rotation, garbage collection, and checksum
verification are unchanged; only the presentation differs. JSON mode prints exactly
one document with no human-readable lines.

```bash
npm run benchmark -- --json > current.json
node scripts/compare-benchmarks.mjs baseline.json current.json
node scripts/compare-benchmarks.mjs baseline.json current.json --max-regression-percent 15
```

The document uses `schemaVersion: 1`:

| Field | Contents |
| --- | --- |
| `generatedAt` | ISO-8601 timestamp of the run |
| `package` | `name` and `version` read from `package.json` |
| `environment` | Node.js version, platform, OS release, CPU model, logical cores, total memory (GiB) |
| `config` | `iterations`, `rounds`, and `warmup` |
| `verification` | Checked input (`42`) and the value every mode returned |
| `modes` | Per mode: label, median µs/run, relative to the direct call, and raw samples |

The comparison script:

- validates schema version 1, the `modes` array, unique labels, and finite positive
  medians, and requires both files to contain the same mode labels;
- prints the baseline, current, and percent change per mode; positive deltas are
  slower than the baseline;
- is informational by default: regressions are reported, but the exit code stays 0,
  so no CI threshold applies;
- treats `--max-regression-percent <number>` as an explicit manual opt-in that exits
  1 when any mode is slower by more than that percentage. `--json` prints a parseable
  report and keeps the same exit-code rule.

```bash
node scripts/compare-benchmarks.mjs baseline.json current.json --json
```

Absolute numbers are environment-sensitive: CPU model, power state, background load,
antivirus, Node.js version, and `tsx` loader overhead can all shift the medians. Treat
the comparison as a directional signal over time, not a pass/fail build gate, and
compare runs from the same class of machine.

The [`Benchmark trend`](../.github/workflows/benchmark.yml) workflow runs weekly
(Mondays 04:37 UTC) and on manual dispatch. It writes `benchmark.json` and uploads it
as the `runtime-overhead-<run_id>` artifact, retained for 90 days. The workflow does
not compare runs, upload a baseline, fail on performance changes, or enforce a
regression threshold. Download artifacts from the Actions run to keep a local
baseline history; comparisons are always manual.

## Environment

| Item | Value |
| --- | --- |
| Date | 2026-10-22 |
| Node.js | v24.15.0 |
| npm | 11.12.1 |
| OS | Windows 11 (`win32 10.0.26300`) |
| CPU | Intel Core Ultra 5 225H |
| Logical cores | 14 |
| RAM | 31.4 GiB |
| Package | 0.3.0, local source via `tsx` |

`tsx` is used to run TypeScript directly. The compiled `dist/` output is not
separately benchmarked. Type stripping/loader overhead, if any, applies equally
to the runtime modes but not to the direct-call baseline; the absolute numbers
should therefore be treated as indicative.

## Results

Median per sequential run:

| Mode | µs/run | Relative to direct | Samples (µs/run) |
| --- | ---: | ---: | --- |
| Direct call | 0.257 | 1.00x | 0.32, 0.26, 0.26, 0.25, 0.26, 0.26, 0.25 |
| Runtime, static policy | 3.332 | 12.95x | 4.24, 3.50, 3.33, 3.31, 3.47, 3.06, 3.00 |
| Runtime, adaptive (fresh read) | 7.645 | 29.72x | 9.06, 8.69, 7.75, 7.64, 7.61, 7.15, 7.01 |
| Runtime, adaptive (cached read) | 3.481 | 13.53x | 3.85, 3.48, 3.78, 3.47, 3.51, 3.20, 3.33 |

Approximate added overhead relative to direct call:

- static policy: ~3.1 µs per run;
- adaptive with a fresh in-memory read: ~7.4 µs per run;
- adaptive with a cached snapshot: ~3.2 µs per run.

The adaptive fresh mode includes the ref-counted shared-read bookkeeping: a
per-read abort controller, waiter accounting, and abort-aware waiting. A runtime
with no providers configured uses the no-provider fast path and does not allocate
that machinery.

The provider in this benchmark is intentionally trivial. A real provider that
performs I/O, allocates, or computes will add its own cost; the provider timeout
(1 s default) means a slow provider can add up to that amount before the snapshot
is produced with error readings.

## Concurrency and retained-heap observations

Source: [`benchmarks/concurrency.ts`](../benchmarks/concurrency.ts)

This is a separate **local observation**, not a production throughput or memory
claim. It uses the same deterministic strategy work and a trivial in-memory
provider. Defaults are 4,096 runs per level per round, 3 rounds, levels
1/4/16/64, and 512 warmup runs per level per round. Each level starts that many
worker loops; each worker awaits one run before starting its next run.

### Concurrent throughput

Distinct operation ids (selection is not serialized across workers):

| Worker loops | Median runs/s | Samples (runs/s) |
| ---: | ---: | --- |
| 1 | 218,078 | 218,078; 211,721; 219,944 |
| 4 | 264,897 | 230,931; 264,897; 286,606 |
| 16 | 262,283 | 204,375; 283,051; 262,283 |
| 64 | 266,104 | 222,228; 276,365; 266,104 |

Same operation id (selection queues on the per-operation lock; this is a
distinct scenario, not a pass/fail comparison):

| Worker loops | Median runs/s | Samples (runs/s) |
| ---: | ---: | --- |
| 1 | 280,494 | 267,670; 280,494; 281,804 |
| 4 | 288,298 | 288,298; 256,878; 298,924 |
| 16 | 285,559 | 251,251; 290,602; 285,559 |
| 64 | 250,044 | 250,044; 261,515; 219,783 |

This is a single-threaded event-loop workload. Levels above 1 measure scheduling
and interleaving, not multi-core scaling. Runs/s includes the fixed strategy work,
promise scheduling, and the runtime path. Same-id results can be similar to or
higher than distinct-id results because strategy execution is outside the
selection lock and the event loop is still single-threaded.

### Shared provider read

With 64 concurrent distinct operations and a provider that resolves on a later
macrotask, the run observed 64 in-flight `run()` calls, **1 provider read**, and
2.76 ms elapsed. Sharing is opportunistic; the script prints the count and does
not assert an exact value.

### Retained heap

The script uses a fixed set of 64 operation ids, concurrency 64, 10,000 runs per
sample, and 3 samples. The median `heapUsed` delta was **+16.3 KiB**
(**+1.66 B/run**); samples were +25.2 KiB, +16.3 KiB, and +1.6 KiB. GC timing,
JIT, and process state make this noisy, and negative values are possible. It is
not a leak test and does not exercise unbounded operation-id cardinality.

## Interpretation

- The runtime is designed for operations that take **microseconds to seconds**,
  not for inner-loop primitives. At ~7.6 µs overhead, a 1 ms operation pays ~0.76%.
- Fresh signal reads roughly double overhead relative to a cached snapshot. Use a
  non-zero `evaluationIntervalMs` when provider reads are expensive.
- Sequential overhead is not throughput. Concurrent runs add promise scheduling
  and, for the same operation id, serialize selection.
- Results vary with hardware, Node version, antivirus, power state, and load.
  Re-run on the target environment before making decisions.

## What is not measured

- Tail latency and multi-core scaling.
- Provider I/O (disk, network, DNS).
- Strategy execution time.
- Long-run soak behavior or unbounded operation-id cardinality; the concurrency
  script measures only a fixed-id retained-heap sample.
- Windows vs Linux differences.
- The compiled package versus `tsx` execution.

These remain outside current coverage. The scheduled Benchmark trend workflow
records the runtime-overhead JSON document as an artifact for observation only: it
does not compare results, fail on performance changes, or enforce a regression
threshold. Use the manual comparison command above when a threshold is needed.
