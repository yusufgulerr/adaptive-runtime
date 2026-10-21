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

## Environment

| Item | Value |
| --- | --- |
| Date | 2026-10-21 |
| Node.js | v24.15.0 |
| npm | 11.12.1 |
| OS | Windows 11 (`win32 10.0.26300`) |
| CPU | Intel Core Ultra 5 225H |
| Logical cores | 14 |
| RAM | 31.4 GiB |
| Package | 0.1.0, local source via `tsx` |

`tsx` is used to run TypeScript directly. The compiled `dist/` output is not
separately benchmarked. Type stripping/loader overhead, if any, applies equally
to the runtime modes but not to the direct-call baseline; the absolute numbers
should therefore be treated as indicative.

## Results

Median per sequential run:

| Mode | µs/run | Relative to direct | Samples (µs/run) |
| --- | ---: | ---: | --- |
| Direct call | 0.310 | 1.00x | 0.34, 0.31, 0.31, 0.29, 0.29, 0.30, 0.75 |
| Runtime, static policy | 4.026 | 12.99x | 4.77, 4.10, 3.85, 4.03, 3.98, 3.68, 10.16 |
| Runtime, adaptive (fresh read) | 9.340 | 30.15x | 10.56, 9.50, 8.93, 9.25, 10.19, 9.34, 9.34 |
| Runtime, adaptive (cached read) | 4.632 | 14.95x | 4.63, 4.79, 4.21, 4.23, 4.50, 4.71, 10.10 |

Approximate added overhead relative to direct call:

- static policy: ~3.7 µs per run;
- adaptive with a fresh in-memory read: ~9.0 µs per run;
- adaptive with a cached snapshot: ~4.3 µs per run.

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
| 1 | 170,599 | 170,599; 136,472; 216,779 |
| 4 | 235,214 | 184,110; 235,214; 242,602 |
| 16 | 211,623 | 133,485; 211,623; 252,326 |
| 64 | 227,254 | 175,916; 229,212; 227,254 |

Same operation id (selection queues on the per-operation lock; this is a
distinct scenario, not a pass/fail comparison):

| Worker loops | Median runs/s | Samples (runs/s) |
| ---: | ---: | --- |
| 1 | 202,236 | 163,988; 202,236; 220,937 |
| 4 | 233,649 | 233,649; 249,206; 203,082 |
| 16 | 210,796 | 190,029; 210,796; 241,662 |
| 64 | 199,153 | 199,153; 236,039; 175,981 |

This is a single-threaded event-loop workload. Levels above 1 measure scheduling
and interleaving, not multi-core scaling. Runs/s includes the fixed strategy work,
promise scheduling, and the runtime path. Same-id results can be similar to or
higher than distinct-id results because strategy execution is outside the
selection lock and the event loop is still single-threaded.

### Shared provider read

With 64 concurrent distinct operations and a provider that resolves on a later
macrotask, the run observed 64 in-flight `run()` calls, **1 provider read**, and
3.31 ms elapsed. Sharing is opportunistic; the script prints the count and does
not assert an exact value.

### Retained heap

The script uses a fixed set of 64 operation ids, concurrency 64, 10,000 runs per
sample, and 3 samples. The median `heapUsed` delta was **+18.4 KiB**
(**+1.89 B/run**); samples were +43.7 KiB, +18.4 KiB, and +9.3 KiB. GC timing,
JIT, and process state make this noisy, and negative values are possible. It is
not a leak test and does not exercise unbounded operation-id cardinality.

## Interpretation

- The runtime is designed for operations that take **microseconds to seconds**,
  not for inner-loop primitives. At ~9.3 µs overhead, a 1 ms operation pays ~0.93%.
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

These are candidates for a future CI trend suite. No CI benchmark has been run,
and no performance regression threshold is enforced.
