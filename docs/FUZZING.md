# Fuzzing

Adaptive Runtime uses deterministic property-based fuzzing for the pure policy
engine and the exactly-one-execution runtime contract. The harness uses
[fast-check](https://github.com/dubzzz/fast-check) as a development-only
dependency. The published package keeps zero runtime dependencies.

The suite is a bounded property campaign, not a coverage-guided fuzzer. It
complements the unit, integration, example, and benchmark checks; it does not
replace them or act as a security sandbox.

## What is covered

| File | Properties |
| --- | --- |
| `tests/property/policy-budget-model.test.ts` | Budget hysteresis matches a reference transition model for arbitrary readings and states. Unavailable readings never expose a numeric value. |
| `tests/property/policy-selection.test.ts` | Candidate ordering by quality, cost, and code-unit id. Automatic filtering respects applicability and tier bounds. Base tiers and target clamping stay inside the available pool. |
| `tests/property/policy-evaluation.test.ts` | Policy evaluation is pure and deterministic, does not mutate its inputs, and selects an applicable candidate inside the configured bounds. |
| `tests/property/runtime-invariants.test.ts` | One `run()` selects and executes exactly one strategy once, records one attempt, and updates per-operation stats consistently. |

The generated data includes boundary values at budget limits and recovery
thresholds, unavailable signal statuses, inapplicable candidates, optional cost
tiers, and arbitrary tier bounds. Strategy identifiers are canonicalized so the
runtime's public validation rules are exercised without testing whitespace
rejection repeatedly.

## Running locally

```bash
npm ci
npm run test:fuzz
```

`npm test` and `npm run test:coverage` also include the property suite. The
default campaign is 100 runs per property with a fixed seed, so ordinary CI is
deterministic and fast.

Run a longer campaign with the following controls:

| Variable | Meaning | Default |
| --- | --- | --- |
| `FUZZ_RUNS` | Runs per property, capped at 100,000 | `100` |
| `FUZZ_SEED` | 32-bit fast-check seed | `0x5eed1234` |

PowerShell:

```powershell
$env:FUZZ_RUNS = "5000"
$env:FUZZ_SEED = "12345"
npm run test:fuzz
Remove-Item Env:FUZZ_RUNS
Remove-Item Env:FUZZ_SEED
```

POSIX shell:

```bash
FUZZ_RUNS=5000 FUZZ_SEED=12345 npm run test:fuzz
```

The asynchronous runtime property is capped at 50 runs even when `FUZZ_RUNS` is
higher. That keeps the runtime campaign bounded while the pure policy properties
use the full run count.

## Reproducing a failure

fast-check prints the failing seed, shrink path, and counterexample. To reproduce:

1. Copy the printed seed into `FUZZ_SEED`.
2. Run with at least the same `FUZZ_RUNS` value, for example
   `FUZZ_SEED=12345 FUZZ_RUNS=5000 npm run test:fuzz`.
3. Keep the shrunk counterexample and add a focused regression test in
   `tests/unit` or `tests/integration` for any confirmed bug.
4. Do not paper over a failure by changing the default seed.

A property failure is a real signal about the generated input space. Triage it
against the policy and runtime invariants before changing either the property or
the implementation.

## Continuous campaign

[`.github/workflows/fuzz.yml`](../.github/workflows/fuzz.yml) runs the property
suite:

- weekly on Monday at 03:17 UTC with 10,000 runs per property;
- on manual dispatch with configurable `runs` and `seed` inputs;
- on pull requests that change the fuzz harness, policy/runtime source, or
  dependency lockfile, with 1,000 runs per property.

The seed defaults to the workflow run id. A manual run can select a fixed seed
for a reproducible campaign. The workflow uses the same SHA-pinned checkout and
Node setup actions as CI and has read-only repository permissions.

## Scope and limitations

- The generator covers plain policy and runtime inputs; it does not fuzz real
  provider I/O, network calls, browser APIs, worker threads, or strategy code.
- There is no coverage-guided feedback loop and no OSS-Fuzz/Jazzer/libFuzzer
  integration.
- TypeScript/JavaScript is memory-safe in the sense relevant here; this suite
  makes no native memory-safety claim.
- The scheduler and separately installed providers remain trusted code. The
  runtime is not a security sandbox.
- Long-run soak testing, load testing, and memory profiling are separate
  hardening items tracked in [VERIFICATION.md](VERIFICATION.md).

See [CONTRIBUTING.md § Tests](../CONTRIBUTING.md#tests) for the contribution
policy and [OPENSSF_BEST_PRACTICES.md](OPENSSF_BEST_PRACTICES.md) for the
dynamic-analysis evidence record.
