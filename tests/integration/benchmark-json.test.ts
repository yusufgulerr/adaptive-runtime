import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cpus } from "node:os";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const benchmark = fileURLToPath(new URL("../../benchmarks/runtime-overhead.ts", import.meta.url));
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
