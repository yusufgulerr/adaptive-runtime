import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const script = fileURLToPath(new URL("../../scripts/compare-benchmarks.mjs", import.meta.url));
const fixtures = mkdtempSync(join(tmpdir(), "adaptive-runtime-benchmark-"));

type InputMode = {
  readonly label: string;
  readonly medianUsPerRun: number;
};

type ComparisonMode = {
  readonly label: string;
  readonly baselineUsPerRun: number;
  readonly currentUsPerRun: number;
  readonly deltaPercent: number;
  readonly regressed: boolean;
  readonly exceedsThreshold: boolean;
};

type ComparisonReport = {
  readonly schemaVersion: number;
  readonly maxRegressionPercent: number | null;
  readonly modes: readonly ComparisonMode[];
  readonly regressions: readonly string[];
  readonly thresholdExceeded: boolean;
  readonly exitCode: number;
};

type RunResult = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
};

const BASELINE_MODES: readonly InputMode[] = [
  { label: "direct call", medianUsPerRun: 0.25 },
  { label: "runtime, static policy", medianUsPerRun: 3.5 },
];

function benchmarkDocument(
  modes: readonly InputMode[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    generatedAt: "2026-10-22T00:00:00.000Z",
    package: { name: "adaptive-runtime", version: "0.3.0" },
    environment: {
      node: "v24.0.0",
      platform: "linux",
      release: "6.0.0",
      cpu: "test cpu",
      logicalCores: 2,
      totalMemoryGiB: 4,
    },
    config: { iterations: 100, rounds: 1, warmup: 25 },
    verification: { input: 42, expected: 123 },
    modes,
    ...overrides,
  };
}

function writeFixture(name: string, value: unknown): string {
  const path = join(fixtures, name);
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2), "utf8");
  return path;
}

function run(args: readonly string[]): RunResult {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status === null) {
    throw new Error(`comparison script did not exit: ${result.error?.message ?? "unknown error"}`);
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

after(() => {
  rmSync(fixtures, { recursive: true, force: true });
});

describe("benchmark comparison tool", () => {
  const baseline = writeFixture("baseline.json", benchmarkDocument(BASELINE_MODES));

  it("compares matching modes and prints percent deltas", () => {
    const current = writeFixture(
      "current-comparable.json",
      benchmarkDocument([
        { label: "direct call", medianUsPerRun: 0.275 },
        { label: "runtime, static policy", medianUsPerRun: 3.85 },
      ]),
    );

    const result = run([baseline, current]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Benchmark comparison/);
    assert.match(result.stdout, /baseline µs\/run/);
    assert.match(result.stdout, /direct call/);
    assert.match(result.stdout, /runtime, static policy/);
    assert.match(result.stdout, /\+10\.00%/);
    assert.match(result.stdout, /informational only/);
  });

  it("succeeds by default even when a mode regressed", () => {
    const current = writeFixture(
      "current-regressed.json",
      benchmarkDocument([
        { label: "direct call", medianUsPerRun: 0.25 },
        { label: "runtime, static policy", medianUsPerRun: 7 },
      ]),
    );

    const result = run([baseline, current]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\+100\.00%/);
    assert.match(result.stdout, /exit code is 0/);
  });

  it("fails only with an explicit --max-regression-percent opt-in", () => {
    const current = writeFixture(
      "current-threshold.json",
      benchmarkDocument([
        { label: "direct call", medianUsPerRun: 0.25 },
        { label: "runtime, static policy", medianUsPerRun: 7 },
      ]),
    );

    const failing = run([baseline, current, "--max-regression-percent", "15"]);
    assert.equal(failing.status, 1);
    assert.match(failing.stdout, /Regression threshold \+15% exceeded by 1 mode/);
    assert.match(failing.stdout, /runtime, static policy \(\+100\.00%\)/);

    const passing = run([baseline, current, "--max-regression-percent=150"]);
    assert.equal(passing.status, 0, passing.stderr);
    assert.match(passing.stdout, /within \+150%/);
  });

  it("prints a parseable JSON report and keeps the exit-code rule", () => {
    const current = writeFixture(
      "current-json.json",
      benchmarkDocument([
        { label: "direct call", medianUsPerRun: 0.275 },
        { label: "runtime, static policy", medianUsPerRun: 5.25 },
      ]),
    );

    const informational = run([baseline, current, "--json"]);
    assert.equal(informational.status, 0, informational.stderr);
    assert.ok(informational.stdout.trimStart().startsWith("{"));
    const informationalReport = JSON.parse(informational.stdout) as ComparisonReport;
    assert.equal(informationalReport.schemaVersion, 1);
    assert.equal(informationalReport.maxRegressionPercent, null);
    assert.equal(informationalReport.thresholdExceeded, false);
    assert.equal(informationalReport.exitCode, 0);
    assert.deepEqual(informationalReport.regressions, ["direct call", "runtime, static policy"]);
    const staticMode = informationalReport.modes.find(
      (mode) => mode.label === "runtime, static policy",
    );
    assert.ok(staticMode !== undefined);
    assert.ok(Math.abs(staticMode.deltaPercent - 50) < 1e-9);
    assert.equal(staticMode.regressed, true);
    assert.equal(staticMode.exceedsThreshold, false);

    const failing = run([baseline, current, "--json", "--max-regression-percent", "15"]);
    assert.equal(failing.status, 1);
    const failingReport = JSON.parse(failing.stdout) as ComparisonReport;
    assert.equal(failingReport.maxRegressionPercent, 15);
    assert.equal(failingReport.thresholdExceeded, true);
    assert.equal(failingReport.exitCode, 1);
    assert.deepEqual(failingReport.regressions, ["direct call", "runtime, static policy"]);
  });

  it("rejects malformed documents and mismatched mode sets", () => {
    const cases: readonly {
      readonly name: string;
      readonly value: unknown;
      readonly pattern: RegExp;
    }[] = [
      { name: "invalid-json.json", value: "{ not json", pattern: /not valid JSON/ },
      {
        name: "wrong-schema.json",
        value: benchmarkDocument(BASELINE_MODES, { schemaVersion: 2 }),
        pattern: /schemaVersion 1/,
      },
      {
        name: "missing-modes.json",
        value: { schemaVersion: 1, modes: {} },
        pattern: /"modes" array/,
      },
      {
        name: "duplicate-labels.json",
        value: benchmarkDocument([
          { label: "direct call", medianUsPerRun: 0.25 },
          { label: "direct call", medianUsPerRun: 0.3 },
        ]),
        pattern: /duplicate mode label "direct call"/,
      },
      {
        name: "non-positive-median.json",
        value: benchmarkDocument([{ label: "direct call", medianUsPerRun: 0 }]),
        pattern: /finite positive medianUsPerRun/,
      },
      {
        name: "missing-mode.json",
        value: benchmarkDocument([{ label: "direct call", medianUsPerRun: 0.25 }]),
        pattern: /mode label sets differ \(missing from current: runtime, static policy\)/,
      },
      {
        name: "extra-mode.json",
        value: benchmarkDocument([
          ...BASELINE_MODES,
          { label: "unexpected mode", medianUsPerRun: 1 },
        ]),
        pattern: /not present in baseline: unexpected mode/,
      },
    ];

    for (const testCase of cases) {
      const path = writeFixture(testCase.name, testCase.value);
      const result = run([baseline, path]);
      assert.equal(result.status, 2, `${testCase.name} should be rejected: ${result.stdout}`);
      assert.match(result.stderr, testCase.pattern, testCase.name);
    }

    const missing = run([baseline, join(fixtures, "does-not-exist.json")]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /cannot read current file/);
  });

  it("prints usage for --help", () => {
    const result = run(["--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: node scripts\/compare-benchmarks\.mjs/);
    assert.match(result.stdout, /--max-regression-percent/);
    assert.match(result.stdout, /No threshold is enforced/);
  });
});
