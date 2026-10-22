# Verification record

This document records the local and remote checks performed for the 0.3.0 line on
**2026-10-22**. It distinguishes local verification, remote workflow evidence,
GitHub repository settings, and npm registry status. The 0.3.0 tree was merged to
`main` at `5504f21`; the release-workflow fix and the OpenSSF readiness
documentation merged at `953a484` and `6f67ff3`. Remote CI, CodeQL, and Scorecard
pass for all three commits. The `v0.3.0` tag points to `5504f21` and the GitHub
release is published; npm publication remains pending.

## Environment

| Item | Value |
| --- | --- |
| Operating system | Windows 11 (`win32 10.0.26300`) |
| Node.js | v24.15.0 |
| npm | 11.12.1 |
| CPU | Intel Core Ultra 5 225H, 14 logical cores |
| RAM | 31.4 GiB |
| TypeScript | 7.0.2 |
| @types/node | 26.6.5 |
| Biome | 2.5.15 |
| fast-check | 4.10.2 (development only) |
| Package | adaptive-runtime 0.3.0 |

## Commands and results

| Command | Result |
| --- | --- |
| `npm run format` | **PASS** — 83 files checked, no fixes applied |
| `npm run lint` | **PASS** — 83 files checked, no fixes applied |
| `npm run typecheck` | **PASS** — `tsc -p tsconfig.check.json` |
| `npm test` | **PASS** — 265 tests, 49 suites, 0 failures, 0 skipped |
| `npm run test:fuzz` | **PASS** — 9 property tests, 4 suites, 0 failures |
| `FUZZ_RUNS=5000 FUZZ_SEED=12345 npm run test:fuzz` | **PASS** — 5,000 runs per pure property, 50 runtime runs |
| `npm run test:coverage` | **PASS** — 99.10% lines, 97.00% branches, 98.64% functions |
| `npm run build` | **PASS** — ESM, declarations, and maps emitted to `dist/` |
| `npm run verify:exports` | **PASS** — 10 export entries, 27 files, and 27 runtime symbols |
| `npm run example:basic` | **PASS** — selected `high-quality`, quality check passed |
| `npm run example:search` | **PASS** — `exhaustive, balanced, balanced, economy, economy, exhaustive` |
| `npm run example:planning` | **PASS** — `optimal, optimal, optimal, economy, economy, economy, economy, optimal` |
| `npm run example:quick-start` | **PASS** — `iterative`, `50005000`, `initial` |
| `npm run example:observability` | **PASS** — success, provider-error, and strategy-error metrics printed |
| `npm run example:edge` | **PASS** — deterministic three-tier sequence and Prometheus text |
| `npm run benchmark` | **PASS** — results below |
| `npm run benchmark:concurrency` | **PASS** — concurrency and retained-heap observations below |
| `npm pack --dry-run` | **PASS** — 168 files, 144.7 kB packed, 672.5 kB unpacked |
| Clean consumer install from tarball | **PASS** — all ten documented subpaths imported; core run, web/edge reads, testing SDK, and observability collector succeeded |
| Clean consumer TypeScript compile | **PASS** — all subpaths resolve under NodeNext with `@types/node` |
| Portable source scan | **PASS** — zero `node:` / `process.` matches across 33 files |
| `npm ls --omit=dev --depth=0` | **PASS** — `(empty)`; no runtime dependencies |
| `npm audit` | **PASS** — 0 vulnerabilities (including dev dependencies) |
| Markdown relative-link check | **PASS** — 192 Markdown files, 219 relative links, all targets exist |

The suite covers unit tests in `tests/unit/`, integration tests in
`tests/integration/`, and deterministic property/fuzz tests in `tests/property/`,
plus shared helpers. `node:test` reports 49 suites because of nested `describe`
blocks. The property suite uses `fast-check` with a fixed default seed; set
`FUZZ_RUNS` and `FUZZ_SEED` to run a longer reproducible campaign. The scheduled
campaign and scope limits are documented in [FUZZING.md](FUZZING.md). The checks
in this line include the testing SDK, entry-point isolation, package subpath
assertions, the built-package export verifier, the PR title validator, the
portability source scan, and deterministic edge-example assertions.

## Coverage

Global result from `npm run test:coverage`:

| Metric | Result | Threshold | Status |
| --- | ---: | ---: | --- |
| Lines | 99.10% | 80% | PASS |
| Branches | 97.00% | 80% | PASS |
| Functions | 98.64% | 80% | PASS |

Every `src/**` file is above 80% branch coverage. The lowest per-file branch
results are:

| File | Branch coverage |
| --- | ---: |
| `providers/cpu-utilization.ts` | 83.33% |
| `runtime/runtime.ts` | 90.21% |
| `providers/event-loop-delay.ts` | 91.18% |
| `runtime/executor.ts` | 91.30% |
| `observability/index.ts` | 93.44% |

The entry points (`core.ts`, `node.ts`, `web.ts`, `edge.ts`), the composite
provider, the testing SDK, the observability module, the web providers, and the
edge provider are covered by integration and unit tests. V8 coverage can move by
a few tenths of a percentage point between runs because cooperative-cancellation
paths depend on timer scheduling; this final run remains above 99.0% lines and
96.7% branches, and every per-file branch result stays above 80%.

## Examples

The search, planning, observability, and edge examples use scripted providers and
a fixed clock, so their strategy sequences, signal values, and metric counters
are deterministic and independent of machine load. Reported durations are local
observations only.

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

Edge:

```text
request 1: strategy=deep-rerank kind=initial pressure=0.06
request 2: strategy=deep-rerank kind=retained pressure=0.40
request 3: strategy=fast-vector kind=adapted pressure=0.63
request 4: strategy=cached-lexical kind=adapted pressure=0.86
request 5: strategy=deep-rerank kind=adapted pressure=0.30
strategy sequence: deep-rerank, deep-rerank, fast-vector, cached-lexical, deep-rerank
```

The edge example imports only `adaptive-runtime/core`, `/edge`, and
`/observability`. It exercises an execution-budget snapshot, a composite
`edge.pressure.score`, a three-tier strategy ladder, and Prometheus exposition.
The integration test asserts the sequence, decision kinds, pressure scores,
`edge_gateway_runs_total` values, the latest `edge.pressure.score` gauge of
`0.3`, and `edge_gateway_runtime_closed_total 1`.

The basic example runs against the real `ProcessMemoryProvider` and selected the
high-quality path on this machine (heap 9.3 MB, RSS 52.0 MB); it does not assert
machine-dependent values. The quick-start example selected `iterative` and
returned `50005000`. The observability example mapped events into an in-memory
sink and printed counters, gauges, and histograms for one success and one pinned
strategy failure.

## Benchmark

Command: `npm run benchmark` (Node 24.15.0, `--expose-gc`, 20,000 runs per round,
7 rounds, 2,000 warmups per round, median per run).

| Mode | Median µs/run | Relative to direct |
| --- | ---: | ---: |
| Direct call | 0.257 | 1.00x |
| Runtime, static policy | 3.332 | 12.95x |
| Runtime, adaptive (fresh in-memory read) | 7.645 | 29.72x |
| Runtime, adaptive (cached read) | 3.481 | 13.53x |

Every mode returned `299533` for the checked input, so the runtime path was not
dead-code-eliminated. This is sequential call overhead, not throughput or
production performance. Timings vary between runs; see
[BENCHMARKS.md](BENCHMARKS.md) for method and caveats.

A separate concurrency/memory observation (`npm run benchmark:concurrency`)
measured 1/4/16/64 worker loops with distinct and same operation ids:

- distinct-id median throughput: 218,078 / 264,897 / 262,283 / 266,104 runs/s;
- same-id median throughput: 280,494 / 288,298 / 285,559 / 250,044 runs/s;
- with 64 concurrent callers and a provider resolving on a later macrotask,
  64 `run()` calls were in flight and **1 provider read** was observed in
  2.76 ms;
- the fixed-id retained-heap sample had a median delta of **+16.3 KiB**
  (+1.66 B/run), with samples of +25.2 KiB, +16.3 KiB, and +1.6 KiB.

These are single-event-loop observations, not multi-core scaling, production
throughput, or leak tests. Heap deltas vary with GC timing and JIT state. Full
results are in
[BENCHMARKS.md](BENCHMARKS.md#concurrency-and-retained-heap-observations).

## Package inspection

- `npm pack --dry-run` reports **168 files**, **144.7 kB packed**, and
  **672.5 kB unpacked**, version **0.3.0**, shasum
  `e14ab895b2ab0d06d0a0fea0b6644a2ab38fc751`.
- The tarball contains `dist/`, `README.md`, `LICENSE`, `NOTICE`, and
  `package.json`. No `src/`, `tests/`, `examples/`, `benchmarks/`, `docs/`,
  coverage, or `node_modules/` files are included.
- `dist/index.js`, `dist/core.js`, `dist/node.js`, `dist/web.js`, `dist/edge.js`,
  `dist/policy/index.js`, `dist/providers/index.js`,
  `dist/observability/index.js`, and `dist/testing/index.js` are present and
  referenced by the `exports` map.
- The actual tarball was installed into a clean temporary project. These imports
  all resolved and executed: `adaptive-runtime`, `/core`, `/node`, `/web`,
  `/edge`, `/policy`, `/providers`, `/observability`, `/testing`, and
  `/package.json`.
- The consumer ran a core operation and asserted the returned value, strategy,
  and metadata, read a web device-memory provider and an edge execution-budget
  provider, ran the testing SDK conformance check, attached the metrics
  collector, closed the runtime, and asserted the Prometheus text.
- A strict TypeScript consumer compiled against the packaged declarations under
  `NodeNext` with `@types/node` installed. Root and `/node` declarations reference
  the `NodeJS` namespace, so Node consumers need `@types/node` as usual.
- The temporary consumer directory and tarball were removed after verification.
- `npm pack --dry-run` runs the `prepack` build and validates the package shape.

## Portability scan

The portable set contains 33 files: `src/core.ts`, `src/web.ts`, `src/edge.ts`,
all of `src/policy`, `src/runtime`, `src/signals`, `src/errors`, `src/types`,
`src/observability`, `src/testing`, `src/providers/web`, `src/providers/edge`,
and `src/providers/composite.ts`. Scanning those files for `node:` and
`process.` returned:

```text
ZERO MATCHES across 33 portable files
```

`tests/unit/isolation.test.ts` enforces the same rule in CI, and
`tests/integration/entrypoints.test.ts` asserts that Node.js providers do not
leak into `/core`, `/web`, or `/edge`.

## GitHub repository state

Repository settings were last queried with `gh api` on 2026-10-21 and were not
re-queried for this local 0.3.0 run:

| Item | State |
| --- | --- |
| Visibility | Public |
| Description | Matches `package.json` |
| Homepage | `https://github.com/yusufgulerr/adaptive-runtime#readme` |
| Discussions | Enabled |
| Topics | 14, including `adaptive-runtime`, `policy-engine`, `hysteresis`, and `zero-dependencies` |
| Labels | 28 recorded labels (`type:*`, `area:*`, `priority:*`, status, accessibility, `skip-changelog`, and defaults) |
| Collaborators | `@yusufgulerr` only, role `admin` |
| Deploy keys | 0 |
| Branch protection | PR required, 1 approval, code-owner review, stale approvals dismissed, last push approved, conversations resolved, linear history, no force push/deletion, admin bypass |
| Required checks | `Node 22`, `Node 24`, `Node 26`, `Analyze JavaScript/TypeScript`, `PR title` |
| Tag ruleset | `Protect release tags`, `refs/tags/v*`, creation/update/deletion restricted, admin bypass only |
| Actions | Selected actions (GitHub-owned plus the SHA-pinned `ossf/scorecard-action`), SHA pinning required, read-only default token, external forks require approval |
| Security | Private vulnerability reporting, secret scanning, push protection, Dependabot alerts, and automated security fixes enabled |
| Release environment | `release`, required reviewer `@yusufgulerr`, tag deployment policy |
| Repository automation | Release-note categories, Discussion forms, PR title validator, citation metadata, Scorecard workflow, required checks, labels, and action allow-list configured and verified |
| OpenSSF Best Practices | **NOT APPLIED** — passing-level self-assessment prepared; badge not registered or earned. See [OPENSSF_BEST_PRACTICES.md](OPENSSF_BEST_PRACTICES.md) |

The `PR title` required check, `ossf/scorecard-action` allow-list entry,
`status:needs-triage` and `skip-changelog` labels, and Discussions are configured
as described in [GITHUB_SETTINGS.md](GITHUB_SETTINGS.md). The first Scorecard run
on `main` succeeded and published a score; see the current evidence below.

Current remote workflow evidence for the 0.3.0 release tree:

| Workflow | Result |
| --- | --- |
| CI on `main` at `6f67ff3` | **PASS** — run [39707436345](https://github.com/yusufgulerr/adaptive-runtime/actions/runs/39707436345) |
| CodeQL on `main` at `6f67ff3` | **PASS** — run [39707436457](https://github.com/yusufgulerr/adaptive-runtime/actions/runs/39707436457) |
| OpenSSF Scorecard on `main` at `6f67ff3` | **PASS** — run [39707436347](https://github.com/yusufgulerr/adaptive-runtime/actions/runs/39707436347), score 7/10 |
| CI on `main` at `953a484` | **PASS** — run [39706082330](https://github.com/yusufgulerr/adaptive-runtime/actions/runs/39706082330) |
| CodeQL on `main` at `953a484` | **PASS** — run [39706082359](https://github.com/yusufgulerr/adaptive-runtime/actions/runs/39706082359) |
| OpenSSF Scorecard on `main` at `953a484` | **PASS** — run [39706082319](https://github.com/yusufgulerr/adaptive-runtime/actions/runs/39706082319), score 7/10 |
| CI on `main` at `5504f21` | **PASS** — run [39705496725](https://github.com/yusufgulerr/adaptive-runtime/actions/runs/39705496725) |
| CodeQL on `main` at `5504f21` | **PASS** — run [39705496817](https://github.com/yusufgulerr/adaptive-runtime/actions/runs/39705496817) |
| OpenSSF Scorecard on `main` at `5504f21` | **PASS** — run [39705496768](https://github.com/yusufgulerr/adaptive-runtime/actions/runs/39705496768), score 7/10 |
| Release tag verification (`v0.3.0`) | **PASS** — run [39705537214](https://github.com/yusufgulerr/adaptive-runtime/actions/runs/39705537214) |
| Automated GitHub release (`v0.3.0`) | **FAILED** — `gh` ran without a git checkout; the release was created manually from the same tag |
| Release `verify-publish` job | **NOT EXECUTED** — requires the npm publication phase |

The earlier `ad7fd2f` tree also passed CI
([39702926008](https://github.com/yusufgulerr/adaptive-runtime/actions/runs/39702926008)),
CodeQL
([39702925914](https://github.com/yusufgulerr/adaptive-runtime/actions/runs/39702925914)),
and Scorecard
([39703457017](https://github.com/yusufgulerr/adaptive-runtime/actions/runs/39703457017)).

Historical remote workflow evidence from the 0.1.0 baseline commit:

| Workflow | Result |
| --- | --- |
| CI on `main` baseline | **PASS** — run [39626683262](https://github.com/yusufgulerr/adaptive-runtime/actions/runs/39626683262) |
| CodeQL on `main` baseline | **PASS** — run [39626682970](https://github.com/yusufgulerr/adaptive-runtime/actions/runs/39626682970) |
| CI on PR #6 (Node 22/24/26 plus Windows/macOS) | **PASS** — run [39636395046](https://github.com/yusufgulerr/adaptive-runtime/actions/runs/39636395046) |
| CodeQL on PR #6 | **PASS** — run [39636395012](https://github.com/yusufgulerr/adaptive-runtime/actions/runs/39636395012) |
| Dependency Review on PR #6 | **PASS** — run [39636395231](https://github.com/yusufgulerr/adaptive-runtime/actions/runs/39636395231) |
| Release `verify-publish` job | **NOT EXECUTED** — requires a `v*` tag and an approved publish |

The 0.3.0 tree, repository automation, release-workflow fix, and OpenSSF
readiness documentation are merged to `main` at `6f67ff3`. Remote CI, CodeQL, and
Scorecard pass for that commit, and the required checks are active. The `v0.3.0`
tag points to `5504f21`; its verification job passed. The automated release step
failed because `gh` had no git checkout, so the GitHub release was created manually
from the same tag. The `GH_REPO` fix merged at `953a484`. The OpenSSF Best
Practices readiness record is prepared, but the badge has not been applied for or
earned.

## Release status

| Artifact | Status on 2026-10-22 |
| --- | --- |
| npm registry package | **NOT PUBLISHED** — no 0.3.0 publish was attempted; the name returned 404 on 2026-10-22 |
| Git tag `v0.3.0` | **CREATED** at `5504f21` |
| GitHub release | **CREATED** — <https://github.com/yusufgulerr/adaptive-runtime/releases/tag/v0.3.0> |
| npm provenance attestation | **NOT AVAILABLE** until the first successful publish |

The source repository is public, but the npm release is a separate, irreversible
phase. The GitHub release does not imply that the package is on npm. Do not
describe the package as published, released, or remotely verified until the
registry, provenance, remote CI, and clean-consumer checks pass after an approved
npm dispatch.

## Not verified

- Node.js 22 and 26 locally: only Node 24.15.0 was available. Remote CI exercises
  all three lines.
- Real browser, Cloudflare Workers, Vercel Edge, Deno, and Bun execution. Web and
  edge providers are tested through structural injection points and a Node.js
  edge example; no vendor runtime was available locally.
- The OIDC npm publication path. It has not executed because the npm phase has not
  been dispatched.
- Post-publication npm registry install and provenance attestation.
- Coverage-guided fuzzing, long-run load testing, soak testing, and memory
  profiling. The property/fuzz suite is a bounded deterministic campaign, not a
  coverage-guided fuzzer or a soak test. The concurrency benchmark is a short
  local observation, not a soak test.
- Security audit or penetration testing.
- Benchmark behavior under real provider I/O or multi-core scaling.

## Release assessment

Local verification for 0.3.0 is complete: 265 tests, 99.10% line / 97.00% branch /
98.64% function coverage, build, six examples, both benchmarks, package
inspection, all documented subpath imports, a strict TypeScript consumer, the
built-package export verifier, and the zero-Node portability scan. The source is
coherent for the 0.x line.

The 0.3.0 source is merged at `5504f21` and tagged `v0.3.0`; the GitHub release is
published. The tag verification job passed, and the release was created manually
after the automated release step failed to find a git checkout. npm publication is
a separate owner-approved dispatch. After the npm workflow completes, update this
document with the registry version, integrity, provenance, and clean-consumer
result.
