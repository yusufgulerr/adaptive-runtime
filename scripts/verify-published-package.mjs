#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_PACKAGE = "adaptive-runtime";
const DEFAULT_REPOSITORY = "git+https://github.com/yusufgulerr/adaptive-runtime.git";
const DEFAULT_WAIT_ATTEMPTS = 30;
const DEFAULT_WAIT_DELAY_MS = 10_000;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const HELP = `Usage: node scripts/verify-published-package.mjs --version <version> [options]

Verifies that a package version is published on npm with the expected repository
metadata, a sha512 integrity hash, a provenance attestation, and a working
clean-consumer install.

Required:
  --version <version>              Exact published version, without a leading "v".

Options:
  --package <name>                 Package name (default: ${DEFAULT_PACKAGE}).
  --expected-repository <url>      Expected repository.url
                                   (default: ${DEFAULT_REPOSITORY}).
  --wait-attempts <count>          Registry propagation attempts (default: ${DEFAULT_WAIT_ATTEMPTS}).
  --wait-delay-ms <milliseconds>   Delay between attempts (default: ${DEFAULT_WAIT_DELAY_MS}).
  --metadata-file <path>           Read registry metadata from JSON instead of npm.
                                   Disables all registry access.
  --attestations-file <path>       Read the provenance attestation from JSON.
  --tarball <path>                 Install from a packed tarball (.tgz) instead of npm registry.
  --skip-provenance                Skip the provenance attestation check.
  --skip-consumer                  Skip the clean-consumer install and smoke test.
  --json                           Print exactly one JSON summary to stdout.
  --help                           Show this help.

Offline example:
  node scripts/verify-published-package.mjs --version 0.3.0 --metadata-file metadata.json --attestations-file attestations.json --skip-consumer --json

Exit codes: 0 on success, 1 on verification failure.`;

function parsePositiveInteger(raw, name, { allowZero = false } = {}) {
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`--${name} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    package: DEFAULT_PACKAGE,
    expectedRepository: DEFAULT_REPOSITORY,
    waitAttempts: DEFAULT_WAIT_ATTEMPTS,
    waitDelayMs: DEFAULT_WAIT_DELAY_MS,
    metadataFile: undefined,
    attestationsFile: undefined,
    tarball: undefined,
    skipProvenance: false,
    skipConsumer: false,
    json: false,
    version: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (typeof argument !== "string" || !argument.startsWith("--")) {
      throw new Error(`Unexpected argument "${String(argument)}".`);
    }

    const separator = argument.indexOf("=");
    const name = separator === -1 ? argument.slice(2) : argument.slice(2, separator);
    const inlineValue = separator === -1 ? undefined : argument.slice(separator + 1);

    const takeValue = () => {
      if (inlineValue !== undefined) {
        if (inlineValue.length === 0) {
          throw new Error(`--${name} requires a value.`);
        }
        return inlineValue;
      }
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`--${name} requires a value.`);
      }
      index += 1;
      return next;
    };

    const rejectValue = () => {
      if (inlineValue !== undefined) {
        throw new Error(`--${name} does not take a value.`);
      }
    };

    switch (name) {
      case "version":
        options.version = takeValue();
        break;
      case "package":
        options.package = takeValue();
        break;
      case "expected-repository":
        options.expectedRepository = takeValue();
        break;
      case "wait-attempts":
        options.waitAttempts = parsePositiveInteger(takeValue(), name);
        break;
      case "wait-delay-ms":
        options.waitDelayMs = parsePositiveInteger(takeValue(), name, { allowZero: true });
        break;
      case "metadata-file":
        options.metadataFile = takeValue();
        break;
      case "attestations-file":
        options.attestationsFile = takeValue();
        break;
      case "tarball":
        options.tarball = takeValue();
        break;
      case "skip-provenance":
        rejectValue();
        options.skipProvenance = true;
        break;
      case "skip-consumer":
        rejectValue();
        options.skipConsumer = true;
        break;
      case "json":
        rejectValue();
        options.json = true;
        break;
      default:
        throw new Error(`Unknown option "--${name}". Use --help for usage.`);
    }
  }

  if (options.tarball !== undefined && !existsSync(resolve(options.tarball))) {
    throw new Error(`--tarball points to a missing file: "${options.tarball}".`);
  }

  if (options.version === undefined) {
    throw new Error("--version is required. Use --help for usage.");
  }
  if (/^[vV]/.test(options.version)) {
    throw new Error(
      `--version must be an exact version without a leading "v" (received "${options.version}").`,
    );
  }
  if (!VERSION_PATTERN.test(options.version)) {
    throw new Error(
      `--version must be an exact version such as "0.3.0" (received "${options.version}").`,
    );
  }
  if (!PACKAGE_NAME_PATTERN.test(options.package)) {
    throw new Error(`--package is not a valid npm package name (received "${options.package}").`);
  }
  if (options.expectedRepository.length === 0) {
    throw new Error("--expected-repository must not be empty.");
  }

  return options;
}

function createReporter(json) {
  return {
    step(index, label, message) {
      if (!json) {
        console.log(`[${index}/4] ${label}: ${message}`);
      }
    },
    success(packageName, version) {
      if (!json) {
        console.log(`Verified ${packageName}@${version}.`);
      }
    },
  };
}

function firstOutputLine(text) {
  const line = text.split(/\r?\n/).find((entry) => entry.trim().length > 0);
  return line === undefined ? "" : line.trim();
}

function runNpm(args, label, { cwd, timeoutMs } = {}) {
  const isWindows = process.platform === "win32";
  const executable = isWindows ? "npm.cmd" : "npm";
  const options = {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_update_notifier: "false" },
    shell: isWindows,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    windowsHide: true,
  };
  try {
    // All npm arguments come from validated package names and exact versions, so
    // joining them for the Windows shell cannot inject metacharacters.
    const output = isWindows
      ? execFileSync([executable, ...args].join(" "), options)
      : execFileSync(executable, args, options);
    return output.trim();
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    const detail = firstOutputLine(stderr);
    const suffix =
      detail.length > 0
        ? `: ${detail}`
        : typeof error?.status === "number"
          ? ` (exit code ${error.status})`
          : "";
    throw new Error(`${label} failed${suffix}`);
  }
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function readJsonFile(path, label) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${label} "${path}": ${error.message}`);
  }
  return parseJson(raw, `${label} "${path}"`);
}

async function waitForRegistry(options, reporter) {
  if (options.tarball !== undefined) {
    reporter.step(1, "Registry propagation", `skipped (--tarball "${options.tarball}").`);
    return;
  }
  const specifier = `${options.package}@${options.version}`;
  for (let attempt = 1; attempt <= options.waitAttempts; attempt += 1) {
    let published = "";
    try {
      published = runNpm(["view", specifier, "version"], `npm view ${specifier} version`, {
        timeoutMs: 15_000,
      });
    } catch {
      published = "";
    }

    if (published === options.version) {
      reporter.step(
        1,
        "Registry propagation",
        `${specifier} available after ${attempt} attempt(s).`,
      );
      return;
    }

    reporter.step(
      1,
      "Registry propagation",
      `attempt ${attempt}/${options.waitAttempts}: registry has not served ${specifier} yet.`,
    );
    if (attempt < options.waitAttempts) {
      await delay(options.waitDelayMs);
    }
  }
  throw new Error(`registry did not serve ${specifier} within ${options.waitAttempts} attempt(s).`);
}

function loadMetadata(options) {
  if (options.metadataFile !== undefined) {
    return readJsonFile(options.metadataFile, "metadata file");
  }
  if (options.tarball !== undefined) {
    const tarballPath = resolve(options.tarball);
    const tarballContent = readFileSync(tarballPath);
    const integrity = `sha512-${createHash("sha512").update(tarballContent).digest("base64")}`;
    const packageJsonPath = join(process.cwd(), "package.json");
    let pkg = {};
    if (existsSync(packageJsonPath)) {
      pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    }
    return {
      name: pkg.name ?? options.package,
      version: pkg.version ?? options.version,
      dist: { integrity },
      repository: typeof pkg.repository === "string" ? { url: pkg.repository } : pkg.repository,
    };
  }
  const specifier = `${options.package}@${options.version}`;
  const raw = runNpm(["view", specifier, "--json"], `npm view ${specifier} --json`, {
    timeoutMs: 60_000,
  });
  return parseJson(raw, `npm view ${specifier} --json output`);
}

function verifyMetadata(metadata, options) {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("registry metadata must be a JSON object.");
  }

  if (metadata.version !== options.version) {
    throw new Error(
      `version mismatch: expected "${options.version}", metadata reports "${String(metadata.version)}".`,
    );
  }

  const integrity = metadata.dist?.integrity;
  if (typeof integrity !== "string" || integrity.length === 0) {
    throw new Error('missing dist.integrity in registry metadata; expected a "sha512-" value.');
  }
  if (!integrity.startsWith("sha512-")) {
    throw new Error(`dist.integrity must start with "sha512-"; received "${integrity}".`);
  }

  const repository = metadata.repository?.url;
  if (repository !== options.expectedRepository) {
    throw new Error(
      `repository.url mismatch: expected "${options.expectedRepository}", received "${String(repository)}".`,
    );
  }

  return { integrity, repository };
}

function extractAttestation(parsed, source) {
  const candidate = Array.isArray(parsed) ? parsed[0] : parsed;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    typeof candidate.url !== "string" ||
    candidate.url.length === 0
  ) {
    throw new Error(`missing provenance attestation in ${source}.`);
  }
  return candidate.url;
}

function verifyProvenance(options, reporter) {
  if (options.skipProvenance) {
    reporter.step(3, "Provenance", "skipped (--skip-provenance).");
    return null;
  }

  if (options.attestationsFile !== undefined) {
    const parsed = readJsonFile(options.attestationsFile, "attestations file");
    const url = extractAttestation(parsed, `attestations file "${options.attestationsFile}"`);
    reporter.step(3, "Provenance", `verified from file (${url}).`);
    return url;
  }

  if (options.metadataFile !== undefined) {
    reporter.step(
      3,
      "Provenance",
      "skipped (--metadata-file; pass --attestations-file to verify without registry access).",
    );
    return null;
  }

  if (options.tarball !== undefined) {
    reporter.step(
      3,
      "Provenance",
      "skipped (--tarball; pass --attestations-file to verify provenance).",
    );
    return null;
  }

  const specifier = `${options.package}@${options.version}`;
  const raw = runNpm(
    ["view", specifier, "dist.attestations", "--json"],
    `npm view ${specifier} dist.attestations --json`,
    { timeoutMs: 60_000 },
  );
  const parsed = parseJson(raw, `npm view ${specifier} dist.attestations --json output`);
  const url = extractAttestation(parsed, "registry metadata");
  reporter.step(3, "Provenance", `verified (${url}).`);
  return url;
}

function runConsumerSmoke(options, reporter) {
  if (options.skipConsumer) {
    reporter.step(4, "Consumer", "skipped (--skip-consumer).");
    return false;
  }

  if (options.metadataFile !== undefined && options.tarball === undefined) {
    reporter.step(4, "Consumer", "skipped (--metadata-file disables registry access).");
    return false;
  }

  const consumerDirectory = mkdtempSync(join(tmpdir(), "adaptive-runtime-consumer-"));
  try {
    runNpm(["init", "-y"], "npm init -y", {
      cwd: consumerDirectory,
      timeoutMs: 60_000,
    });
    const installTarget =
      options.tarball !== undefined
        ? resolve(options.tarball)
        : `${options.package}@${options.version}`;
    runNpm(["install", installTarget], `npm install ${installTarget}`, {
      cwd: consumerDirectory,
      timeoutMs: 300_000,
    });

    const smoke = `
import { createAdaptiveRuntime } from ${JSON.stringify(options.package)};
import { createAdaptiveRuntime as createCoreRuntime } from ${JSON.stringify(`${options.package}/core`)};
import { createAdaptiveRuntime as createNodeRuntime, ProcessMemoryProvider } from ${JSON.stringify(`${options.package}/node`)};
import { DeviceMemoryProvider, NetworkInformationProvider, FrameTimingProvider } from ${JSON.stringify(`${options.package}/web`)};
import { ExecutionBudgetProvider } from ${JSON.stringify(`${options.package}/edge`)};
import { definePolicy, resolvePolicy } from ${JSON.stringify(`${options.package}/policy`)};
import { EventLoopDelayProvider, CompositeSignalProvider } from ${JSON.stringify(`${options.package}/providers`)};
import { createMetricsCollector } from ${JSON.stringify(`${options.package}/observability`)};
import { createFakeClock } from ${JSON.stringify(`${options.package}/testing`)};

// 1. Policy subpath verification
const policy = definePolicy({ evaluationIntervalMs: 0 });
const resolvedPolicy = resolvePolicy(policy);
if (resolvedPolicy.evaluationIntervalMs !== 0) {
  throw new Error("policy subpath mismatch");
}

// 2. Web providers verification
const devMem = new DeviceMemoryProvider();
devMem.close();
const netInfo = new NetworkInformationProvider();
const frameTiming = new FrameTimingProvider();
frameTiming.recordFrameDuration(16);
frameTiming.close();

// 3. Edge provider verification
const edgeProvider = new ExecutionBudgetProvider({
  getBudgetSnapshot: () => ({ totalBudgetMs: 50, elapsedMs: 5 }),
});
const edgeReadings = await edgeProvider.read({
  now: 1000,
  signal: new AbortController().signal,
});
if (!Array.isArray(edgeReadings) || edgeReadings.length === 0) {
  throw new Error("edge provider reading failed");
}

// 4. Testing SDK verification
const clock = createFakeClock(500);
clock.advance(100);
if (clock.now() !== 600) {
  throw new Error("testing subpath fake clock failed");
}

// 5. Observability verification
const collector = createMetricsCollector();

// 6. Core and Node subpaths verification
if (typeof createCoreRuntime !== "function") {
  throw new Error("core subpath missing createAdaptiveRuntime");
}
if (typeof createNodeRuntime !== "function") {
  throw new Error("node subpath missing createAdaptiveRuntime");
}

// 7. Node / composite providers and runtime execution
const memProvider = new ProcessMemoryProvider();
const delayProvider = new EventLoopDelayProvider();
const compositeProvider = new CompositeSignalProvider({
  providers: [memProvider],
  passthroughInputs: false,
  rules: [
    {
      name: "custom.composite.heap",
      unit: "bytes",
      inputs: ["process.memory.heapUsed"],
      compute: (values) => values["process.memory.heapUsed"] ?? 0,
    },
  ],
});

const runtime = createAdaptiveRuntime({
  providers: [memProvider, delayProvider, compositeProvider],
  policy,
});
const detachMetrics = collector.attach(runtime);

try {
  const result = await runtime.run({
    operationId: "post-publish-smoke",
    input: 10,
    strategies: [{ id: "sum", qualityTier: 1, run: ({ input }) => input + 1 }],
  });
  if (result.value !== 11) throw new Error("unexpected strategy result");
  if (result.metadata.strategyId !== "sum") throw new Error("unexpected strategy id");

  const snapshot = collector.getSnapshot();
  if (snapshot.counters.length === 0) throw new Error("observability snapshot missing counters");
} finally {
  detachMetrics();
  memProvider.close();
  delayProvider.close();
  await runtime.close();
}
console.log("clean consumer import across all 9 runtime subpaths, run, metrics, and close OK");
`;
    try {
      execFileSync(process.execPath, ["--input-type=module", "-e", smoke], {
        cwd: consumerDirectory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
        windowsHide: true,
      });
    } catch (error) {
      const stderr = typeof error?.stderr === "string" ? error.stderr : "";
      const detail = firstOutputLine(stderr);
      throw new Error(`clean consumer smoke test failed${detail.length > 0 ? `: ${detail}` : ""}`);
    }

    reporter.step(4, "Consumer", "clean install, all 9 subpath imports, run, and close OK.");
    return true;
  } finally {
    rmSync(consumerDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }

  const json = argv.includes("--json");
  try {
    const options = parseArgs(argv);
    const reporter = createReporter(options.json);
    const metadataFromFile = options.metadataFile !== undefined;

    if (metadataFromFile) {
      reporter.step(1, "Registry propagation", "skipped (--metadata-file).");
    } else {
      await waitForRegistry(options, reporter);
    }

    const metadata = loadMetadata(options);
    const { integrity, repository } = verifyMetadata(metadata, options);
    reporter.step(2, "Metadata", `version, ${integrity}, and repository verified.`);

    const attestationUrl = verifyProvenance(options, reporter);
    const consumerVerified = runConsumerSmoke(options, reporter);

    const metadataSource = metadataFromFile
      ? "file"
      : options.tarball !== undefined
        ? "tarball"
        : "registry";
    const summary = {
      ok: true,
      package: options.package,
      version: options.version,
      metadataSource,
      integrity,
      repository,
      provenance: attestationUrl === null ? "skipped" : "verified",
      attestationUrl,
      consumer: consumerVerified ? "verified" : "skipped",
    };

    if (options.json) {
      console.log(JSON.stringify(summary));
    } else {
      reporter.success(options.package, options.version);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      console.error(JSON.stringify({ ok: false, error: message }));
    } else {
      console.error(`Published package verification failed: ${message}`);
    }
    process.exitCode = 1;
  }
}

await main();
