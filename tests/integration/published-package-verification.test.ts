import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../../scripts/verify-published-package.mjs", import.meta.url),
);
const VERSION = "0.3.0";
const EXPECTED_REPOSITORY = "git+https://github.com/yusufgulerr/adaptive-runtime.git";
const INTEGRITY = "sha512-fixture-integrity";

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface RunOptions {
  readonly env?: NodeJS.ProcessEnv;
}

const temporaryDirectories: string[] = [];

function createTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "adaptive-runtime-verify-"));
  temporaryDirectories.push(directory);
  return directory;
}

after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

function writeJsonFile(directory: string, name: string, value: unknown): string {
  const path = join(directory, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

function validMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "adaptive-runtime",
    version: VERSION,
    dist: { integrity: INTEGRITY },
    repository: { type: "git", url: EXPECTED_REPOSITORY },
    ...overrides,
  };
}

function run(args: readonly string[], options: RunOptions = {}): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...options.env },
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

function withPrependedPath(directory: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  const pathKey = Object.keys(environment).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  environment[pathKey] = `${directory}${delimiter}${environment[pathKey] ?? ""}`;
  return environment;
}

function createNpmTripwire(): { readonly marker: string; readonly env: NodeJS.ProcessEnv } {
  const directory = createTempDirectory();
  const marker = join(directory, "npm-invoked.txt");
  if (process.platform === "win32") {
    writeFileSync(
      join(directory, "npm.cmd"),
      '@echo off\r\necho invoked>"%~dp0npm-invoked.txt"\r\nexit /b 0\r\n',
      "utf8",
    );
  } else {
    const shim = join(directory, "npm");
    writeFileSync(
      shim,
      '#!/bin/sh\nprintf invoked > "$(dirname "$0")/npm-invoked.txt"\nexit 0\n',
      "utf8",
    );
    chmodSync(shim, 0o755);
  }
  return { marker, env: withPrependedPath(directory) };
}

describe("published package verification", () => {
  it("accepts valid registry metadata without provenance or a consumer install", () => {
    const directory = createTempDirectory();
    const metadataFile = writeJsonFile(directory, "metadata.json", validMetadata());

    const result = run([
      "--version",
      VERSION,
      "--metadata-file",
      metadataFile,
      "--skip-provenance",
      "--skip-consumer",
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /Metadata: version, sha512-fixture-integrity, and repository verified\./,
    );
    assert.match(result.stdout, /Provenance: skipped \(--skip-provenance\)\./);
    assert.match(result.stdout, /Consumer: skipped \(--skip-consumer\)\./);
    assert.match(result.stdout, new RegExp(`Verified adaptive-runtime@${VERSION}\\.`));
  });

  it("rejects a metadata version that does not match --version", () => {
    const directory = createTempDirectory();
    const metadataFile = writeJsonFile(
      directory,
      "metadata.json",
      validMetadata({ version: "0.2.9" }),
    );

    const result = run([
      "--version",
      VERSION,
      "--metadata-file",
      metadataFile,
      "--skip-provenance",
      "--skip-consumer",
    ]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /version mismatch/);
    assert.match(result.stderr, /0\.3\.0/);
    assert.match(result.stderr, /0\.2\.9/);
  });

  it("rejects missing and non-sha512 integrity values", () => {
    const directory = createTempDirectory();
    const cases: ReadonlyArray<readonly [string, Record<string, unknown>, RegExp]> = [
      ["missing dist", { dist: undefined }, /missing dist\.integrity/],
      ["missing integrity", { dist: {} }, /missing dist\.integrity/],
      ["sha1 integrity", { dist: { integrity: "sha1-obsolete" } }, /sha512-/],
    ];

    for (const [label, overrides, expected] of cases) {
      const metadataFile = writeJsonFile(
        directory,
        `${label.replaceAll(" ", "-")}.json`,
        validMetadata(overrides),
      );
      const result = run([
        "--version",
        VERSION,
        "--metadata-file",
        metadataFile,
        "--skip-provenance",
        "--skip-consumer",
      ]);

      assert.equal(result.status, 1, `${label} should fail`);
      assert.match(result.stderr, expected, `${label} should report ${expected}`);
    }
  });

  it("rejects an unexpected repository URL", () => {
    const directory = createTempDirectory();
    const metadataFile = writeJsonFile(
      directory,
      "metadata.json",
      validMetadata({
        repository: { type: "git", url: "git+https://github.com/example/fork.git" },
      }),
    );

    const result = run([
      "--version",
      VERSION,
      "--metadata-file",
      metadataFile,
      "--skip-provenance",
      "--skip-consumer",
    ]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /repository\.url mismatch/);
    assert.match(result.stderr, /example\/fork/);
    assert.match(result.stderr, /yusufgulerr\/adaptive-runtime/);
  });

  it("accepts attestation files in array and object form", () => {
    const directory = createTempDirectory();
    const metadataFile = writeJsonFile(directory, "metadata.json", validMetadata());
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ["array", [{ url: "https://registry.npmjs.org/-/npm/v1/attestations/array.json" }]],
      ["object", { url: "https://registry.npmjs.org/-/npm/v1/attestations/object.json" }],
    ];

    for (const [label, attestations] of cases) {
      const attestationsFile = writeJsonFile(directory, `${label}.json`, attestations);
      const result = run([
        "--version",
        VERSION,
        "--metadata-file",
        metadataFile,
        "--attestations-file",
        attestationsFile,
        "--skip-consumer",
      ]);

      assert.equal(result.status, 0, `${label}: ${result.stderr}`);
      assert.match(result.stdout, /Provenance: verified from file/);
      assert.ok(
        result.stdout.includes(`https://registry.npmjs.org/-/npm/v1/attestations/${label}.json`),
        `${label}: ${result.stdout}`,
      );
    }
  });

  it("rejects attestation files without a non-empty URL", () => {
    const directory = createTempDirectory();
    const metadataFile = writeJsonFile(directory, "metadata.json", validMetadata());
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ["empty-array", []],
      ["empty-object", {}],
      ["empty-url", { url: "" }],
      ["missing-url", { url: 42 }],
    ];

    for (const [label, attestations] of cases) {
      const attestationsFile = writeJsonFile(directory, `${label}.json`, attestations);
      const result = run([
        "--version",
        VERSION,
        "--metadata-file",
        metadataFile,
        "--attestations-file",
        attestationsFile,
        "--skip-consumer",
      ]);

      assert.equal(result.status, 1, `${label} should fail`);
      assert.match(result.stderr, /missing provenance attestation/);
    }
  });

  it("prints exactly one parseable JSON summary with the expected fields", () => {
    const directory = createTempDirectory();
    const metadataFile = writeJsonFile(directory, "metadata.json", validMetadata());

    const result = run([
      "--version",
      VERSION,
      "--metadata-file",
      metadataFile,
      "--skip-provenance",
      "--skip-consumer",
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim().split("\n").length, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      package: "adaptive-runtime",
      version: VERSION,
      metadataSource: "file",
      integrity: INTEGRITY,
      repository: EXPECTED_REPOSITORY,
      provenance: "skipped",
      attestationUrl: null,
      consumer: "skipped",
    });
  });

  it("rejects a version with a leading v", () => {
    const result = run(["--version", "v0.3.0"]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /leading "v"/);
    assert.match(result.stderr, /0\.3\.0/);
  });

  it("requires --version", () => {
    const result = run([]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--version is required/);
  });

  it("does not invoke npm when metadata and provenance come from files", () => {
    const directory = createTempDirectory();
    const metadataFile = writeJsonFile(directory, "metadata.json", validMetadata());
    const attestationsFile = writeJsonFile(directory, "attestations.json", {
      url: "https://registry.npmjs.org/-/npm/v1/attestations/offline.json",
    });
    const tripwire = createNpmTripwire();

    const control = run(
      [
        "--version",
        VERSION,
        "--wait-attempts",
        "1",
        "--wait-delay-ms",
        "0",
        "--skip-provenance",
        "--skip-consumer",
      ],
      { env: tripwire.env },
    );
    assert.equal(control.status, 1);
    assert.ok(
      existsSync(tripwire.marker),
      "the npm tripwire should observe online-mode registry calls",
    );

    rmSync(tripwire.marker, { force: true });

    const offline = run(
      [
        "--version",
        VERSION,
        "--metadata-file",
        metadataFile,
        "--attestations-file",
        attestationsFile,
        "--skip-consumer",
      ],
      { env: tripwire.env },
    );

    assert.equal(offline.status, 0, offline.stderr);
    assert.equal(existsSync(tripwire.marker), false, "offline verification must not invoke npm");
  });

  it("prints help without requiring --version", () => {
    const result = run(["--help"]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: node scripts\/verify-published-package\.mjs/);
    assert.match(result.stdout, /--metadata-file/);
  });
});
