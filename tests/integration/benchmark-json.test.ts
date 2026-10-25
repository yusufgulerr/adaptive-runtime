import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const benchmark = fileURLToPath(new URL("../../benchmarks/runtime-overhead.ts", import.meta.url));
const concurrencyBenchmark = fileURLToPath(
  new URL("../../benchmarks/concurrency.ts", import.meta.url),
);
const compareScript = fileURLToPath(
  new URL("../../scripts/compare-benchmarks.mjs", import.meta.url),
);
const packageFile = fileURLToPath(new URL("../../package.json", import.meta.url));

type ModeEntry = {
  readonly label: string;
  readonly medianUsPerRun: number;
  readonly relativeToDirect: number;
  readonly samplesUsPerRun: readonly number[];
};

type BenchmarkDocument = {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly package: { readonly name: string; readonly version: string };
  readonly environment: {
    readonly node: string;
    readonly platform: string;
    readonly release: string;
    readonly cpu: string;
    readonly logicalCores: number;
    readonly totalMemoryGiB: number;
  };
  readonly config: {
    readonly iterations: number;
    readonly rounds: number;
    readonly warmup: number;
    readonly entrypoint: string;
  };
  readonly verification: { readonly input: number; readonly expected: number };
  readonly modes: readonly ModeEntry[];
};

const EXPECTED_LABELS = [
  "direct call",
  "runtime, static policy",
  "runtime, adaptive (fresh read)",
  "runtime, adaptive (cached read)",
];

function runBenchmark(args: readonly string[] = []): BenchmarkDocument {
  const stdout = execFileSync(process.execPath, ["--import", "tsx", benchmark, "--json", ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, BENCH_ITERATIONS: "100", BENCH_ROUNDS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  assert.ok(stdout.trimStart().startsWith("{"), "JSON mode must not print human-readable chatter");
  return JSON.parse(stdout) as BenchmarkDocument;
}

function assertFinitePositive(value: number, label: string): void {
  assert.ok(Number.isFinite(value), `${label} must be finite`);
  assert.ok(value > 0, `${label} must be positive`);
}

describe("benchmark JSON output", () => {
  let document: BenchmarkDocument;
  let packageJson: { readonly name: string; readonly version: string };

  before(() => {
    document = runBenchmark();
    packageJson = JSON.parse(readFileSync(packageFile, "utf8")) as {
      readonly name: string;
      readonly version: string;
    };
  });

  it("emits the documented schema and package identity", () => {
    assert.equal(document.schemaVersion, 1);
    assert.equal(Number.isNaN(Date.parse(document.generatedAt)), false);
    assert.match(document.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(document.package.name, packageJson.name);
    assert.equal(document.package.version, packageJson.version);
  });

  it("describes the environment and run configuration", () => {
    assert.equal(document.environment.node, process.version);
    assert.equal(document.environment.platform, process.platform);
    assert.ok(document.environment.release.length > 0);
    assert.ok(document.environment.cpu.length > 0);
    assert.equal(document.environment.logicalCores, cpus().length);
    assertFinitePositive(document.environment.totalMemoryGiB, "totalMemoryGiB");

    assert.equal(document.config.iterations, 100);
    assert.equal(document.config.rounds, 1);
    assert.equal(document.config.warmup, 25);
    assert.equal(document.config.entrypoint, "source");
  });

  it("preserves mode order and reports finite measurements", () => {
    assert.deepEqual(
      document.modes.map((mode) => mode.label),
      EXPECTED_LABELS,
    );
    assert.equal(document.verification.input, 42);
    assert.ok(Number.isFinite(document.verification.expected));

    for (const mode of document.modes) {
      assertFinitePositive(mode.medianUsPerRun, `${mode.label} medianUsPerRun`);
      assertFinitePositive(mode.relativeToDirect, `${mode.label} relativeToDirect`);
      assert.equal(mode.samplesUsPerRun.length, 1);
      for (const sample of mode.samplesUsPerRun) {
        assertFinitePositive(sample, `${mode.label} sample`);
      }
    }
  });

  it("uses the direct call as the 1x reference", () => {
    const direct = document.modes.find((mode) => mode.label === "direct call");
    assert.ok(direct !== undefined);
    assert.equal(direct.relativeToDirect, 1);
  });
});

describe("benchmark compiled entry point", () => {
  let document: BenchmarkDocument;

  before(() => {
    const tsc = fileURLToPath(new URL("../../node_modules/typescript/bin/tsc", import.meta.url));
    execFileSync(process.execPath, [tsc, "-p", "tsconfig.json"], {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    document = runBenchmark(["--dist"]);
  });

  it("measures the compiled dist entry point with the same schema", () => {
    assert.equal(document.schemaVersion, 1);
    assert.equal(document.config.entrypoint, "dist");
    assert.equal(document.package.name, "adaptive-runtime");
    assert.equal(document.package.version, JSON.parse(readFileSync(packageFile, "utf8")).version);
    assert.deepEqual(
      document.modes.map((mode) => mode.label),
      EXPECTED_LABELS,
    );
    for (const mode of document.modes) {
      assertFinitePositive(mode.medianUsPerRun, `${mode.label} medianUsPerRun`);
      assertFinitePositive(mode.relativeToDirect, `${mode.label} relativeToDirect`);
      for (const sample of mode.samplesUsPerRun) {
        assertFinitePositive(sample, `${mode.label} sample`);
      }
    }
  });
});

type ConcurrencyLevelResult = {
  readonly concurrency: number;
  readonly totalOperations: number;
  readonly opsPerSec: number;
  readonly scalingFactor: number;
  readonly p50Us: number;
  readonly p95Us: number;
  readonly p99Us: number;
  readonly heapDeltaBytes: number;
};

type ConcurrencyBenchmarkDocument = {
  readonly schemaVersion: number;
  readonly benchmark: string;
  readonly package: { readonly name: string; readonly version: string };
  readonly environment: {
    readonly nodeVersion: string;
    readonly platform: string;
    readonly arch: string;
    readonly timestamp: string;
  };
  readonly config: {
    readonly concurrencyLevels: readonly number[];
    readonly operationsCount: number;
    readonly iterationsPerLevel: number;
  };
  readonly results: readonly ConcurrencyLevelResult[];
};

function runConcurrencyBenchmark(args: readonly string[] = []): ConcurrencyBenchmarkDocument {
  const stdout = execFileSync(
    process.execPath,
    ["--import", "tsx", concurrencyBenchmark, "--json", ...args],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    },
  );
  assert.ok(stdout.trimStart().startsWith("{"), "JSON mode must not print human-readable chatter");
  return JSON.parse(stdout) as ConcurrencyBenchmarkDocument;
}

describe("concurrency benchmark JSON output", () => {
  let document: ConcurrencyBenchmarkDocument;
  let packageJson: { readonly name: string; readonly version: string };

  before(() => {
    document = runConcurrencyBenchmark(["--iterations=20"]);
    packageJson = JSON.parse(readFileSync(packageFile, "utf8")) as {
      readonly name: string;
      readonly version: string;
    };
  });

  it("emits the documented schema, benchmark type, and package identity", () => {
    assert.equal(document.schemaVersion, 1);
    assert.equal(document.benchmark, "concurrency");
    assert.equal(Number.isNaN(Date.parse(document.environment.timestamp)), false);
    assert.equal(document.package.name, packageJson.name);
    assert.equal(document.package.version, packageJson.version);
  });

  it("describes the environment and concurrency configuration", () => {
    assert.equal(document.environment.nodeVersion, process.version);
    assert.equal(document.environment.platform, process.platform);
    assert.equal(document.environment.arch, process.arch);
    assert.ok(document.environment.timestamp.length > 0);

    assert.equal(document.config.iterationsPerLevel, 20);
    assert.ok(Array.isArray(document.config.concurrencyLevels));
    assert.ok(document.config.concurrencyLevels.length > 0);
    assert.equal(document.config.operationsCount, document.config.concurrencyLevels.length * 20);
  });

  it("reports per-level metrics with finite measurements", () => {
    assert.equal(document.results.length, document.config.concurrencyLevels.length);

    for (const [index, result] of document.results.entries()) {
      assert.equal(result.concurrency, document.config.concurrencyLevels[index]);
      assert.equal(result.totalOperations, 20);
      assertFinitePositive(result.opsPerSec, `level ${result.concurrency} opsPerSec`);
      assertFinitePositive(result.scalingFactor, `level ${result.concurrency} scalingFactor`);
      assertFinitePositive(result.p50Us, `level ${result.concurrency} p50Us`);
      assertFinitePositive(result.p95Us, `level ${result.concurrency} p95Us`);
      assertFinitePositive(result.p99Us, `level ${result.concurrency} p99Us`);
      assert.ok(
        result.p50Us <= result.p95Us && result.p95Us <= result.p99Us,
        `percentiles ordered for level ${result.concurrency}`,
      );
      assert.ok(Number.isFinite(result.heapDeltaBytes), "heapDeltaBytes must be finite");
    }

    const baseline = document.results[0];
    assert.ok(baseline !== undefined);
    assert.equal(baseline.scalingFactor, 1);
  });
});

describe("concurrency benchmark comparison via compare-benchmarks.mjs", () => {
  const fixturesDir = mkdtempSync(join(tmpdir(), "adaptive-concurrency-bench-"));

  after(() => {
    rmSync(fixturesDir, { recursive: true, force: true });
  });

  function writeDoc(name: string, doc: unknown): string {
    const path = join(fixturesDir, name);
    writeFileSync(path, JSON.stringify(doc, null, 2), "utf8");
    return path;
  }

  it("compares two concurrency JSON documents successfully", () => {
    const baseline = runConcurrencyBenchmark(["--iterations=20"]);
    const current = runConcurrencyBenchmark(["--iterations=20"]);

    const baselinePath = writeDoc("baseline.json", baseline);
    const currentPath = writeDoc("current.json", current);

    const result = spawnSync(
      process.execPath,
      [compareScript, baselinePath, currentPath, "--json"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as {
      readonly schemaVersion: number;
      readonly benchmark: string;
      readonly results: readonly unknown[];
      readonly thresholdExceeded: boolean;
      readonly exitCode: number;
    };
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.benchmark, "concurrency");
    assert.equal(parsed.exitCode, 0);
    assert.equal(parsed.thresholdExceeded, false);
    assert.equal(parsed.results.length, baseline.results.length);
  });

  it("detects regressions when opsPerSec drops beyond maxRegressionPercent", () => {
    const baselineDoc = {
      schemaVersion: 1,
      benchmark: "concurrency",
      package: { name: "adaptive-runtime", version: "0.7.0" },
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        timestamp: new Date().toISOString(),
      },
      config: { concurrencyLevels: [1, 4], operationsCount: 40, iterationsPerLevel: 20 },
      results: [
        {
          concurrency: 1,
          totalOperations: 20,
          opsPerSec: 10000,
          scalingFactor: 1,
          p50Us: 50,
          p95Us: 80,
          p99Us: 90,
          heapDeltaBytes: 0,
        },
        {
          concurrency: 4,
          totalOperations: 20,
          opsPerSec: 30000,
          scalingFactor: 3,
          p50Us: 40,
          p95Us: 60,
          p99Us: 70,
          heapDeltaBytes: 0,
        },
      ],
    };

    const regressedDoc = {
      ...baselineDoc,
      results: [
        { ...baselineDoc.results[0], opsPerSec: 7500 }, // -25% regression
        { ...baselineDoc.results[1], opsPerSec: 31000 },
      ],
    };

    const baselinePath = writeDoc("synth-base.json", baselineDoc);
    const regressedPath = writeDoc("synth-reg.json", regressedDoc);

    const failing = spawnSync(
      process.execPath,
      [compareScript, baselinePath, regressedPath, "--max-regression-percent", "15"],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    assert.equal(failing.status, 1);
    assert.match(failing.stdout, /Regression threshold \+15% exceeded/);

    const passing = spawnSync(
      process.execPath,
      [compareScript, baselinePath, regressedPath, "--max-regression-percent", "30"],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    assert.equal(passing.status, 0, passing.stderr);
    assert.match(passing.stdout, /All concurrency levels are within \+30%/);
  });
});
