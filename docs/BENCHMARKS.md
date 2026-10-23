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
node --expose-gc --import tsx benchmarks/runtime-overhead.ts --json > current.json
node scripts/compare-benchmarks.mjs baseline.json current.json
node scripts/compare-benchmarks.mjs baseline.json current.json --max-regression-percent 15
```

Use the direct Node command when redirecting the document to a file: `npm run`
writes lifecycle headers to stdout, which would corrupt the JSON.

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
| Date | 2026-10-23 |
| Node.js | v24.15.0 |
| npm | 11.12.1 |
| OS | Windows 11 (`win32 10.0.26300`) |
| CPU | Intel Core Ultra 5 225H |
| Logical cores | 14 |
| RAM | 31.4 GiB |
| Package | 0.5.0, local source via `tsx` |

`tsx` is used to run TypeScript directly. The compiled `dist/` output is not
separately benchmarked. Type stripping/loader overhead, if any, applies equally
to the runtime modes but not to the direct-call baseline; the absolute numbers
should therefore be treated as indicative.

## Results

Median per sequential run:

| Mode | µs/run | Relative to direct | Samples (µs/run) |
| --- | ---: | ---: | --- |
| Direct call | 0.405 | 1.00x | 0.41, 0.30, 0.30, 0.32, 0.75, 0.83, 0.99 |
| Runtime, static policy | 8.180 | 20.17x | 8.18, 7.48, 6.98, 7.13, 19.93, 18.66, 19.06 |
| Runtime, adaptive (fresh read) | 14.980 | 36.95x | 14.98, 14.45, 14.62, 14.31, 33.00, 32.60, 35.17 |
| Runtime, adaptive (cached read) | 8.911 | 21.98x | 8.59, 8.85, 7.79, 8.91, 19.66, 19.45, 21.57 |

Approximate added overhead relative to direct call:

- static policy: ~7.8 µs per run;
- adaptive with a fresh in-memory read: ~14.6 µs per run;
- adaptive with a cached snapshot: ~8.5 µs per run.

A second run on the same machine immediately afterward measured 8.470 µs/run for
static policy, 24.809 µs/run for adaptive with a fresh read, and 8.006 µs/run for
adaptive with a cached read (direct call 0.419 µs/run). The samples are bimodal:
the host intermittently entered a lower-power state, and the direct-call baseline
also moved, so these absolute values are not directly comparable to the earlier
0.3.0 run. Use the JSON trend comparison for directional evidence, not a fixed
threshold.

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
| 1 | 118,279 | 87,574; 119,785; 118,279 |
| 4 | 123,568 | 94,670; 123,568; 150,306 |
| 16 | 130,935 | 93,308; 130,935; 135,639 |
| 64 | 113,035 | 112,284; 113,035; 141,950 |

Same operation id (selection queues on the per-operation lock; this is a
distinct scenario, not a pass/fail comparison):

| Worker loops | Median runs/s | Samples (runs/s) |
| ---: | ---: | --- |
| 1 | 136,269 | 130,734; 165,481; 136,269 |
| 4 | 134,557 | 157,292; 134,557; 92,013 |
| 16 | 143,178 | 140,315; 143,178; 151,422 |
| 64 | 123,925 | 123,925; 108,383; 124,684 |

This is a single-threaded event-loop workload. Levels above 1 measure scheduling
and interleaving, not multi-core scaling. Runs/s includes the fixed strategy work,
promise scheduling, and the runtime path. Same-id results can be similar to or
higher than distinct-id results because strategy execution is outside the
selection lock and the event loop is still single-threaded.

### Shared provider read

With 64 concurrent distinct operations and a provider that resolves on a later
macrotask, the run observed 64 in-flight `run()` calls, **1 provider read**, and
6.75 ms elapsed. Sharing is opportunistic; the script prints the count and does
not assert an exact value.

### Retained heap

The script uses a fixed set of 64 operation ids, concurrency 64, 10,000 runs per
sample, and 3 samples. The median `heapUsed` delta was **+19.0 KiB**
(**+1.94 B/run**); samples were +48.9 KiB, +8.3 KiB, and +19.0 KiB. GC timing,
JIT, and process state make this noisy, and negative values are possible. It is
not a leak test and does not exercise unbounded operation-id cardinality.

## Interpretation

- The runtime is designed for operations that take **microseconds to seconds**,
  not for inner-loop primitives. At ~7.8 µs static overhead, a 1 ms operation pays
  ~0.78%.
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
