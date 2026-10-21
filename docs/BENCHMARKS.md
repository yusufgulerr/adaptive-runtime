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
| Direct call | 0.254 | 1.00x | 0.29, 0.26, 0.26, 0.25, 0.25, 0.25, 0.25 |
| Runtime, static policy | 2.759 | 10.86x | 3.74, 3.00, 2.71, 2.76, 2.75, 2.56, 2.79 |
| Runtime, adaptive (fresh read) | 6.708 | 26.40x | 8.32, 7.56, 6.77, 6.58, 6.44, 6.71, 6.51 |
| Runtime, adaptive (cached read) | 3.071 | 12.09x | 3.45, 3.07, 3.03, 2.85, 3.16, 3.08, 2.94 |

Approximate added overhead relative to direct call:

- static policy: ~2.5 µs per run;
- adaptive with a fresh in-memory read: ~6.5 µs per run;
- adaptive with a cached snapshot: ~2.8 µs per run.

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
| 1 | 305,920 | 225,636; 305,920; 315,460 |
| 4 | 255,918 | 252,620; 255,918; 309,979 |
| 16 | 275,210 | 246,241; 308,752; 275,210 |
| 64 | 319,274 | 238,375; 319,274; 332,276 |

Same operation id (selection queues on the per-operation lock; this is a
distinct scenario, not a pass/fail comparison):

| Worker loops | Median runs/s | Samples (runs/s) |
| ---: | ---: | --- |
| 1 | 259,936 | 233,368; 328,318; 259,936 |
| 4 | 286,161 | 286,161; 279,112; 326,398 |
| 16 | 327,601 | 299,799; 351,757; 327,601 |
| 64 | 302,623 | 291,526; 318,341; 302,623 |

This is a single-threaded event-loop workload. Levels above 1 measure scheduling
and interleaving, not multi-core scaling. Runs/s includes the fixed strategy work,
promise scheduling, and the runtime path. Same-id results can be similar to or
higher than distinct-id results because strategy execution is outside the
selection lock and the event loop is still single-threaded.

### Shared provider read

With 64 concurrent distinct operations and a provider that resolves on a later
macrotask, the run observed 64 in-flight `run()` calls, **1 provider read**, and
3.56 ms elapsed. Sharing is opportunistic; the script prints the count and does
not assert an exact value.

### Retained heap

The script uses a fixed set of 64 operation ids, concurrency 64, 10,000 runs per
sample, and 3 samples. The median `heapUsed` delta was **+27.7 KiB**
(**+2.83 B/run**); samples were +27.7 KiB, +260.2 KiB, and +2.3 KiB. GC timing,
JIT, and process state make this noisy, and negative values are possible. It is
not a leak test and does not exercise unbounded operation-id cardinality.

## Interpretation

- The runtime is designed for operations that take **microseconds to seconds**,
  not for inner-loop primitives. At ~6.7 µs overhead, a 1 ms operation pays ~0.7%.
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
