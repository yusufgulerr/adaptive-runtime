import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../../scripts/verify-zero-dependencies.mjs", import.meta.url),
);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

const temporaryDirectories: string[] = [];

after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function run(args: readonly string[], cwd: string): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

function createFixture(packageJson: unknown, lockfile: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "adaptive-runtime-zero-deps-"));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  writeFileSync(join(directory, "package-lock.json"), `${JSON.stringify(lockfile, null, 2)}\n`);
  return directory;
}

function createLockfile(packages: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "fixture-package",
    version: "0.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "fixture-package", version: "0.0.0", devDependencies: { typescript: "^7.0.2" } },
      ...packages,
    },
  };
}

const devOnlyPackages = {
  "node_modules/typescript": { version: "7.0.2", dev: true },
  "node_modules/optional-native": { version: "1.0.0", dev: true, optional: true },
  "node_modules/peer-library": { version: "1.0.0", peer: true },
};

function runFixture(directory: string, extraArguments: readonly string[] = []): RunResult {
  return run(
    [
      "--package",
      join(directory, "package.json"),
      "--lockfile",
      join(directory, "package-lock.json"),
      ...extraArguments,
    ],
    repoRoot,
  );
}

describe("zero runtime dependency verification", () => {
  it("accepts a package with dev-only lockfile entries", () => {
    const directory = createFixture(
      {
        name: "fixture-package",
        version: "0.0.0",
        dependencies: {},
        optionalDependencies: {},
        peerDependencies: {},
        bundledDependencies: [],
        devDependencies: { typescript: "^7.0.2" },
      },
      createLockfile(devOnlyPackages),
    );

    const result = runFixture(directory);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Zero runtime dependencies verified/);
    assert.match(result.stdout, /4 lockfile entries, no production packages/);
  });

  it("rejects runtime, optional, peer, and bundled dependency fields", () => {
    const cases = [
      { field: "dependencies", value: { "left-pad": "^1.0.0" } },
      { field: "optionalDependencies", value: { fsevents: "^2.0.0" } },
      { field: "peerDependencies", value: { react: "^18.0.0" } },
      { field: "bundledDependencies", value: ["left-pad"] },
      { field: "bundleDependencies", value: ["left-pad"] },
    ] as const;

    for (const { field, value } of cases) {
      const directory = createFixture(
        { name: "fixture-package", version: "0.0.0", [field]: value },
        createLockfile(),
      );

      const result = runFixture(directory);
      assert.equal(result.status, 1, `${field} should be rejected`);
      assert.match(result.stderr, new RegExp(field));
      assert.match(result.stdout, /^$/);
    }
  });

  it("rejects production packages in the lockfile", () => {
    const directory = createFixture(
      { name: "fixture-package", version: "0.0.0" },
      createLockfile({
        "node_modules/runtime-dependency": { version: "1.0.0" },
        "node_modules/typescript": { version: "7.0.2", dev: true },
      }),
    );

    const result = runFixture(directory);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /node_modules\/runtime-dependency/);
    assert.match(result.stderr, /production dependency/);
  });

  it("rejects dependency fields on the lockfile root entry", () => {
    const lockfile = createLockfile();
    const packages = lockfile.packages as Record<string, unknown>;
    packages[""] = {
      name: "fixture-package",
      version: "0.0.0",
      dependencies: { "left-pad": "^1.0.0" },
    };

    const directory = createFixture({ name: "fixture-package", version: "0.0.0" }, lockfile);
    const result = runFixture(directory);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /lockfile root entry.*declares dependencies/);
  });

  it("rejects unsupported and missing lockfile structures", () => {
    const oldLockfileDirectory = createFixture(
      { name: "fixture-package", version: "0.0.0" },
      { name: "fixture-package", version: "0.0.0", lockfileVersion: 2, packages: {} },
    );
    const oldResult = runFixture(oldLockfileDirectory);
    assert.equal(oldResult.status, 1);
    assert.match(oldResult.stderr, /Unsupported lockfileVersion 2/);

    const noPackagesDirectory = createFixture(
      { name: "fixture-package", version: "0.0.0" },
      { name: "fixture-package", version: "0.0.0", lockfileVersion: 3 },
    );
    const noPackagesResult = runFixture(noPackagesDirectory);
    assert.equal(noPackagesResult.status, 1);
    assert.match(noPackagesResult.stderr, /no "packages" map/);
  });

  it("prints a parseable JSON summary for success and failure", () => {
    const successDirectory = createFixture(
      { name: "fixture-package", version: "0.0.0" },
      createLockfile(devOnlyPackages),
    );
    const success = runFixture(successDirectory, ["--json"]);
    assert.equal(success.status, 0, success.stderr);

    const successReport = JSON.parse(success.stdout) as {
      ok: boolean;
      lockfileVersion: number;
      lockfileEntries: number;
      productionPackages: string[];
      errors: string[];
    };
    assert.equal(successReport.ok, true);
    assert.equal(successReport.lockfileVersion, 3);
    assert.equal(successReport.lockfileEntries, 4);
    assert.deepEqual(successReport.productionPackages, []);
    assert.deepEqual(successReport.errors, []);

    const failureDirectory = createFixture(
      { name: "fixture-package", version: "0.0.0", optionalDependencies: { fsevents: "^2.0.0" } },
      createLockfile(),
    );
    const failure = runFixture(failureDirectory, ["--json"]);
    assert.equal(failure.status, 1);

    const failureReport = JSON.parse(failure.stdout) as {
      ok: boolean;
      productionPackages: string[];
      errors: string[];
    };
    assert.equal(failureReport.ok, false);
    assert.deepEqual(failureReport.productionPackages, []);
    assert.ok(failureReport.errors.some((error) => error.includes("optionalDependencies")));
  });

  it("fails clearly for missing and unreadable package files", () => {
    const directory = createFixture(
      { name: "fixture-package", version: "0.0.0" },
      createLockfile(),
    );

    const missing = run(
      [
        "--package",
        join(directory, "missing-package.json"),
        "--lockfile",
        join(directory, "package-lock.json"),
      ],
      repoRoot,
    );
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Unable to read package\.json/);
    assert.match(missing.stderr, /missing-package\.json/);

    const unreadable = run(
      ["--package", directory, "--lockfile", join(directory, "package-lock.json")],
      repoRoot,
    );
    assert.equal(unreadable.status, 1);
    assert.match(unreadable.stderr, /Unable to read package\.json/);
  });

  it("passes against the repository package and lockfile", () => {
    const result = run([], repoRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /Zero runtime dependencies verified: package\.json and package-lock\.json/,
    );
  });
});
