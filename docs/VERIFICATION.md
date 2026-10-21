# Verification record

This document records the checks performed for the 0.1.0 MVP on **2026-10-21**.
It is a local verification record, not evidence that GitHub Actions, npm
publication, or other unreleased platforms have been validated.

## Environment

| Item | Value |
| --- | --- |
| Operating system | Windows 11 (`win32 10.0.26300`) |
| Node.js | v24.15.0 |
| npm | 11.12.1 |
| CPU | Intel Core Ultra 5 225H, 14 logical cores |
| RAM | 31.4 GiB |
| TypeScript | 5.9.3 |
| Biome | 2.5.15 |
| Package | adaptive-runtime 0.1.0 (local, unpublished) |

## Commands and results

| Command | Result |
| --- | --- |
| `npm run lint` | **PASS** — 50 files checked, no fixes applied |
| `npm run typecheck` | **PASS** — `tsc -p tsconfig.check.json` |
| `npm test` | **PASS** — 77 tests, 13 suites, 0 failures, 0 skipped |
| `npm run test:coverage` | **PASS** — 96.52% lines, 87.56% branches, 96.46% functions |
| `npm run build` | **PASS** — ESM, declarations, maps emitted to `dist/` |
| `npm run example:basic` | **PASS** — selected `high-quality`, quality check passed |
| `npm run example:search` | **PASS** — `exhaustive, balanced, balanced, economy, economy, exhaustive` |
| `npm run example:planning` | **PASS** — `optimal, optimal, optimal, economy, economy, economy, economy, optimal` |
| `npm run example:quick-start` | **PASS** — `iterative`, `50005000`, `initial` |
| `npm run example:observability` | **PASS** — success, provider-error, and strategy-error metrics printed |
| `npm run benchmark` | **PASS** — results below |
| `npm run benchmark:concurrency` | **PASS** — concurrency and retained-heap observations below |
| `npm pack --dry-run` | **PASS** — package contents inspected |
| `npm ls --omit=dev --depth=0` | **PASS** — `(empty)`; no runtime dependencies |
| `npm audit` | **PASS** — 0 vulnerabilities (including dev dependencies) |
| YAML parse of `.github/**/*.yml` | **PASS** — 7 files parsed with PyYAML |
| Markdown local-link check | **PASS** — all local links resolve |
| Clean consumer install + `node test.mjs` | **PASS** — import, run, close, and typed error behavior |
| Clean consumer `tsc -p tsconfig.json` | **PASS** — declarations resolve under NodeNext |
| Git repository | **Not initialized** — no repository remote exists |

The test suite is split across ten test files: seven unit files and three
integration files, plus shared helpers. `node:test` reports 13 suites because of
nested `describe` blocks.

## Coverage

Global result:

| Metric | Result | Threshold | Status |
| --- | ---: | ---: | --- |
| Lines | 96.52% | 80% | PASS |
| Branches | 87.56% | 80% | PASS |
| Functions | 96.46% | 80% | PASS |

The threshold is enforced globally by `npm run test:coverage`. Per-file branch
coverage is below 80% in a few modules (`runtime/validate.ts` 79.07%,
`providers/event-loop-delay.ts` 74.07%, `providers/process-memory.ts` 75.00%).
Those files still contribute to a passing global gate; no per-file threshold is
configured. Branch coverage varied by about 0.3 percentage points across repeated
local runs; the figures above are from the last recorded run.

## Examples

The search, planning, and observability examples use scripted providers, so their
strategy sequences and metric counters are deterministic and independent of
machine load. Reported durations are local observations only.

Search:

```text
exhaustive (100% recall), balanced (60%), balanced (60%),
economy (25-item cap), economy, exhaustive (100%)
```

Planning:

```text
optimal, optimal, optimal, economy, economy, economy, economy, optimal
priority: 85/85 at the optimal tier, 80/85 at the economy tier
```

The basic and quick-start examples run against the real `ProcessMemoryProvider`
and selected the high-quality path on this machine. Neither example asserts that
selection in a machine-dependent way.

The observability example maps `decision`, `run:start`, `run:success`,
`run:error`, `provider:error`, and `runtime:closed` into an in-memory metrics
sink. It prints counters, gauges, and histograms for one success and one pinned
strategy failure; its integration test asserts the deterministic counter values.

## Benchmark

Command: `npm run benchmark` (Node 24.15.0, `--expose-gc`, 20,000 runs per round,
7 rounds, 2,000 warmups per round, median of per-round means).

| Mode | Median µs/run | Relative to direct |
| --- | ---: | ---: |
| Direct call | 0.254 | 1.00x |
| Runtime, static policy | 2.759 | 10.86x |
| Runtime, adaptive (fresh in-memory read) | 6.708 | 26.40x |
| Runtime, adaptive (cached read) | 3.071 | 12.09x |

This is sequential call overhead, not throughput or production performance.
Timings vary between runs; see [BENCHMARKS.md](BENCHMARKS.md) for method and
caveats.

A separate concurrency/memory observation (`npm run benchmark:concurrency`)
measured 1/4/16/64 worker loops with distinct and same operation ids. With 64
concurrent distinct operations and a provider resolving on a later macrotask, it
observed 64 in-flight `run()` calls and **1 provider read**. Median distinct-id
throughput ranged from 255,918 to 319,274 runs/s across the tested levels. These
are single-event-loop observations, not multi-core scaling or production
throughput claims. The fixed-id retained-heap sample had a median delta of
**+27.7 KiB** (+2.83 B/run); it is noisy and not a leak test. Full results are in
[BENCHMARKS.md](BENCHMARKS.md#concurrency-and-retained-heap-observations).

## Package inspection

- Tarball includes `dist/`, README, license, notice, changelog, community files,
  and the `docs/` tree.
- No `src/`, `tests/`, `examples/`, `benchmarks/`, or `node_modules/` files are
  included.
- `dist/index.js` and `dist/index.d.ts` are present and referenced by `exports`.
- The package was installed from the tarball into a clean temporary project.
  Both a plain ESM consumer and a strict TypeScript consumer succeeded; the
  TypeScript consumer had `@types/node` installed.
- `npm pack --dry-run` runs the `prepack` build and validates the package shape.

The last recorded dry run reports **130 files**, including this document. The
tarball is roughly **133.5 KB packed** and **516.4 KB unpacked**. Exact byte
counts change with any edit to this document, so run `npm pack --dry-run --json`
for the current value.

## npm and GitHub availability

- `npm view adaptive-runtime version` still returns **404** on 2026-10-21, so the
  name appears unpublished. Availability must be rechecked immediately before
  publishing; a 404 is not a reservation.
- The GitHub repository `sevlaq-labs/adaptive-runtime` exists and is unrelated to
  this project (description: "Adaptive Runtime Layer for Stateful AI Systems").
  A different owner/name or an explicit upstream decision is required.
- No repository remote, GitHub organization, npm token, or release environment
  was configured during this verification.

## Not verified

- GitHub Actions execution: the workflows were parsed locally but never ran.
- Node.js 22 and 26 locally: only Node 24.15.0 was available. CI is configured
  for 22, 24, and 26.
- npm publication, provenance attestation, and install from the public registry.
- Fuzzing, long-run load testing, soak testing, and memory profiling. The
  concurrency benchmark is a short local observation, not a soak test.
- Security audit or penetration testing.
- Behavior on Linux, macOS, browsers, Deno, Bun, or worker-thread isolation.
- Benchmark behavior under real provider I/O or multi-core scaling.

## Release assessment

The source, tests, examples, docs, package contents, and local consumer install
are in a coherent MVP state. Before any public release:

1. create a repository under an available name and push the project;
2. run CI on Node 22, 24, and 26;
3. add repository/bugs/homepage metadata and a support channel;
4. recheck the npm name and configure provenance/trusted publishing;
5. decide whether to accept the known limitations in the README;
6. obtain explicit approval for the irreversible publish step.

No commits, pushes, or npm publications were performed during this work.
