# Verification record

This document records the local and remote checks performed for the 0.1.0
release baseline on **2026-10-21**. It distinguishes local verification, GitHub
Actions execution, GitHub repository settings, and npm registry evidence.

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
| Package | adaptive-runtime 0.1.0 |

## Commands and results

| Command | Result |
| --- | --- |
| `npm run lint` | **PASS** — 54 files checked, no fixes applied |
| `npm run typecheck` | **PASS** — `tsc -p tsconfig.check.json` |
| `npm test` | **PASS** — 96 tests, 14 suites, 0 failures, 0 skipped |
| `npm run test:coverage` | **PASS** — 97.42% lines, 92.59% branches, 97.76% functions |
| `npm run build` | **PASS** — ESM, declarations, and maps emitted to `dist/` |
| `npm run example:basic` | **PASS** — selected `high-quality`, quality check passed |
| `npm run example:search` | **PASS** — `exhaustive, balanced, balanced, economy, economy, exhaustive` |
| `npm run example:planning` | **PASS** — `optimal, optimal, optimal, economy, economy, economy, economy, optimal` |
| `npm run example:quick-start` | **PASS** — `iterative`, `50005000`, `initial` |
| `npm run example:observability` | **PASS** — success, provider-error, and strategy-error metrics printed |
| `npm run benchmark` | **PASS** — results below |
| `npm run benchmark:concurrency` | **PASS** — concurrency and retained-heap observations below |
| `npm pack --dry-run` | **PASS** — 124 files, 89.7 kB packed, 392.9 kB unpacked |
| Clean consumer install from tarball | **PASS** — root, `/policy`, and `/providers` imports; run, remove, close |
| Clean consumer TypeScript compile | **PASS** — declarations resolve under NodeNext with `@types/node` |
| `npm ls --omit=dev --depth=0` | **PASS** — `(empty)`; no runtime dependencies |
| `npm audit` | **PASS** — 0 vulnerabilities (including dev dependencies) |
| YAML parse of `.github/**/*.yml` | **PASS** — 9 files parsed with PyYAML |
| Markdown local-link check | **PASS** — 30 Markdown files, all relative targets exist |
| Source policy purity check | **PASS** — no `node:` imports under `src/policy/` or `dist/policy/` |
| Banned diminishing-language scan | **PASS** — no matches in tracked docs |

The test suite is split across ten test files: seven unit files and three
integration files, plus shared helpers. `node:test` reports 14 suites because of
nested `describe` blocks.

## Coverage

Global result:

| Metric | Result | Threshold | Status |
| --- | ---: | ---: | --- |
| Lines | 97.42% | 80% | PASS |
| Branches | 92.59% | 80% | PASS |
| Functions | 97.76% | 80% | PASS |

Every `src/**` file is above 80% branch coverage. The lowest per-file branches
are `signals/collector.ts` at 81.20%, `providers/cpu-utilization.ts` at 83.33%,
and `policy/budgets.ts` at 88.00%. The global gate remains lines/branches/
functions >= 80, enforced by `npm run test:coverage`. V8 coverage can move by a
few tenths of a percentage point between runs because cooperative-cancellation
paths depend on timer scheduling; repeated runs stayed above 97.3% lines and
92.2% branches, and every per-file branch result stayed above 80%.

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
and selected the high-quality/iterative path on this machine. Neither example
asserts that selection in a machine-dependent way.

The observability example maps `decision`, `run:start`, `run:success`,
`run:error`, `provider:error`, and `runtime:closed` into an in-memory metrics
sink. It prints counters, gauges, and histograms for one success and one pinned
strategy failure; its integration test asserts the deterministic counter values.

## Benchmark

Command: `npm run benchmark` (Node 24.15.0, `--expose-gc`, 20,000 runs per round,
7 rounds, 2,000 warmups per round, median of per-round means).

| Mode | Median µs/run | Relative to direct |
| --- | ---: | ---: |
| Direct call | 0.310 | 1.00x |
| Runtime, static policy | 4.026 | 12.99x |
| Runtime, adaptive (fresh in-memory read) | 9.340 | 30.15x |
| Runtime, adaptive (cached read) | 4.632 | 14.95x |

This is sequential call overhead, not throughput or production performance.
Timings vary between runs; see [BENCHMARKS.md](BENCHMARKS.md) for method and
caveats.

A separate concurrency/memory observation (`npm run benchmark:concurrency`)
measured 1/4/16/64 worker loops with distinct and same operation ids. With 64
concurrent distinct operations and a provider resolving on a later macrotask, it
observed 64 in-flight `run()` calls and **1 provider read** in 3.31 ms. Median
distinct-id throughput ranged from 170,599 to 235,214 runs/s across the tested
levels. These are single-event-loop observations, not multi-core scaling or
production throughput claims. The fixed-id retained-heap sample had a median
delta of **+18.4 KiB** (+1.89 B/run); it is noisy and not a leak test. Full
results are in
[BENCHMARKS.md](BENCHMARKS.md#concurrency-and-retained-heap-observations).

## Package inspection

- The tarball contains `dist/`, `README.md`, `LICENSE`, `NOTICE`, and
  `package.json`. `npm pack` reports **124 files**, **89.7 kB packed**, and
  **392.9 kB unpacked**.
- No `src/`, `tests/`, `examples/`, `benchmarks/`, `docs/`, coverage, or
  `node_modules/` files are included.
- `dist/index.js`, `dist/policy/index.js`, and `dist/providers/index.js` are
  present and referenced by the `exports` map.
- The tarball was installed into a clean temporary project. Root, `/policy`, and
  `/providers` imports resolved; a run, `removeOperation`, and `close` succeeded.
- A strict TypeScript consumer compiled against the published declarations under
  `NodeNext` with `@types/node` installed. Provider/root declarations reference
  the `NodeJS` namespace, so Node consumers need `@types/node` as usual.
- `npm pack --dry-run` runs the `prepack` build and validates the package shape.

## GitHub repository state

Queried with `gh api` on 2026-10-21:

| Item | State |
| --- | --- |
| Visibility | Public |
| Description | Matches `package.json` |
| Homepage | `https://github.com/yusufgulerr/adaptive-runtime#readme` |
| Discussions | Enabled |
| Topics | 14, including `adaptive-runtime`, `policy-engine`, `hysteresis`, and `zero-dependencies` |
| Labels | 28 (`type:*`, `area:*`, `priority:*`, status, accessibility, and defaults) |
| Collaborators | `@yusufgulerr` only, role `admin` |
| Deploy keys | 0 |
| Branch protection | PR required, 1 approval, code-owner review, stale approvals dismissed, last push approved, conversations resolved, linear history, no force push/deletion, admin bypass |
| Required checks | `Node 22`, `Node 24`, `Node 26`, `Analyze JavaScript/TypeScript` |
| Tag ruleset | `Protect release tags`, `refs/tags/v*`, creation/update/deletion restricted, admin bypass only |
| Actions | Selected GitHub-owned actions, SHA pinning required, read-only default token, external forks require approval |
| Security | Private vulnerability reporting, secret scanning, push protection, Dependabot alerts, and automated security fixes enabled |
| Release environment | `release`, required reviewer `@yusufgulerr`, tag deployment policy |

Remote workflow evidence:

| Workflow | Result |
| --- | --- |
| CI on `main` baseline | **PASS** — run [39626683262](https://github.com/yusufgulerr/adaptive-runtime/actions/runs/39626683262) |
| CodeQL on `main` baseline | **PASS** — run [39626682970](https://github.com/yusufgulerr/adaptive-runtime/actions/runs/39626682970) |
| CI on PR #6 (Node 22/24/26 plus Windows/macOS) | **PASS** — run [39636395046](https://github.com/yusufgulerr/adaptive-runtime/actions/runs/39636395046) |
| CodeQL on PR #6 | **PASS** — run [39636395012](https://github.com/yusufgulerr/adaptive-runtime/actions/runs/39636395012) |
| Dependency Review on PR #6 | **PASS** — run [39636395231](https://github.com/yusufgulerr/adaptive-runtime/actions/runs/39636395231) |

The cross-platform and Dependency Review workflows executed successfully on
PR [#6](https://github.com/yusufgulerr/adaptive-runtime/pull/6). The OIDC release
workflow has not executed because no `v*` tag exists; publishing remains pending.

## Release status

| Artifact | Status on 2026-10-21 |
| --- | --- |
| npm registry package | **NOT PUBLISHED** — `npm view adaptive-runtime version` returns 404 |
| Git tag `v0.1.0` | **NOT CREATED** |
| GitHub release | **NOT CREATED** |
| npm provenance attestation | **NOT AVAILABLE** until the first successful publish |

The source repository is public, but the npm release is a separate, irreversible
step. Do not describe the package as published until the registry, provenance,
and clean-consumer checks pass.

## Not verified

- Node.js 22 and 26 locally: only Node 24.15.0 was available. Remote CI has passed
  on 22, 24, and 26, including the Windows and macOS jobs on PR #6.
- The OIDC release path has not executed because no release tag exists. Its first
  real execution is the approved publish step.
- Post-publication npm registry install and provenance attestation: the release
  workflow performs the publish; verify the registry and attestation after it
  completes.
- Fuzzing, long-run load testing, soak testing, and memory profiling. The
  concurrency benchmark is a short local observation, not a soak test.
- Security audit or penetration testing.
- Behavior beyond the CI checks on macOS, and any behavior on browsers, Deno,
  Bun, or worker-thread isolation.
- Benchmark behavior under real provider I/O or multi-core scaling.

## Release assessment

The source, tests, examples, docs, package contents, subpath imports, and clean
consumer installs are coherent for 0.1.0. Release preparation completed:

1. created the public repository and pushed the initial commit;
2. ran CI on Node 22, 24, and 26 and CodeQL successfully;
3. added repository metadata, topics, Discussions, labels, governance, and a
   support channel;
4. configured branch protection, tag protection, Actions policy, and security
   features;
5. configured the protected `release` environment and OIDC release workflow;
6. bounded per-operation state, split the policy core, and added subpath exports;
7. verified the full local gate, package tarball, and consumer imports;
8. verified Linux, Windows, macOS, CodeQL, and Dependency Review on PR #6.

The source repository is public and verified. The npm publish, `v0.1.0` tag, and
GitHub release are **pending**. Publishing requires explicit owner approval. Once
approved, the tag triggers the release workflow, which publishes with npm
provenance and creates the GitHub release. Post-publication registry, provenance,
and clean-consumer checks must be recorded here after they actually succeed.
