#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const DEPENDENCY_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundledDependencies",
  "bundleDependencies",
];

const USAGE = `Usage: node scripts/verify-zero-dependencies.mjs [options]

Verifies that package.json declares no runtime dependencies and that the
lockfile contains no production packages.

Options:
  --package <path>   package.json path (default: package.json at the repository root)
  --lockfile <path>  lockfile path (default: package-lock.json at the repository root)
  --json             print one JSON summary instead of human-readable text
  --help             show this help message
`;

function parseArguments(argv) {
  const options = {
    packagePath: resolve(repoRoot, "package.json"),
    lockfilePath: resolve(repoRoot, "package-lock.json"),
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--json") {
      options.json = true;
      continue;
    }

    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }

    if (argument === "--package" || argument === "--lockfile") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${argument} requires a path.`);
      }
      if (argument === "--package") {
        options.packagePath = resolve(value);
      } else {
        options.lockfilePath = resolve(value);
      }
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${argument}`);
  }

  return options;
}

function displayPath(path) {
  const relativePath = relative(process.cwd(), path);
  return relativePath === "" ? "." : relativePath;
}

async function readJsonFile(path, label) {
  let contents;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Unable to read ${label} at ${displayPath(path)}: ${error.message}`);
  }

  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`Unable to parse ${label} at ${displayPath(path)}: ${error.message}`);
  }
}

function isNonEmptyField(value) {
  if (value === undefined || value === null) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return true;
}

function describeFieldValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry)).join(", ");
  }
  if (value !== null && typeof value === "object") {
    return Object.keys(value).join(", ");
  }
  return String(value);
}

function checkDependencyFields(manifest, label, errors) {
  for (const field of DEPENDENCY_FIELDS) {
    if (isNonEmptyField(manifest[field])) {
      errors.push(`${label} declares ${field}: ${describeFieldValue(manifest[field])}`);
    }
  }
}

function checkPackageJson(manifest) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["package.json must contain a JSON object."];
  }

  const errors = [];
  checkDependencyFields(manifest, "package.json", errors);
  return errors;
}

function checkLockfile(lockfile) {
  if (lockfile === null || typeof lockfile !== "object" || Array.isArray(lockfile)) {
    return {
      errors: ["The lockfile must contain a JSON object."],
      lockfileVersion: null,
      lockfileEntries: 0,
      productionPackages: [],
    };
  }

  const errors = [];
  const lockfileVersion = lockfile.lockfileVersion ?? null;
  const packages = lockfile.packages;

  if (lockfileVersion !== 3) {
    errors.push(
      `Unsupported lockfileVersion ${String(lockfileVersion)}; expected 3 with a packages map.`,
    );
    return { errors, lockfileVersion, lockfileEntries: 0, productionPackages: [] };
  }

  if (packages === null || typeof packages !== "object" || Array.isArray(packages)) {
    errors.push('The lockfile has no "packages" map; lockfileVersion 3 requires one.');
    return { errors, lockfileVersion, lockfileEntries: 0, productionPackages: [] };
  }

  const rootEntry = packages[""];
  if (rootEntry === undefined) {
    errors.push('The lockfile packages map has no root entry (packages[""]).');
  } else if (rootEntry === null || typeof rootEntry !== "object" || Array.isArray(rootEntry)) {
    errors.push('The lockfile root entry (packages[""]) is not an object.');
  } else {
    checkDependencyFields(rootEntry, 'The lockfile root entry (packages[""])', errors);
  }

  const productionPackages = [];
  for (const [packagePath, entry] of Object.entries(packages)) {
    if (packagePath === "") {
      continue;
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`The lockfile entry "${packagePath}" is not an object.`);
      continue;
    }
    if (entry.dev === true || entry.optional === true || entry.peer === true) {
      continue;
    }
    productionPackages.push(packagePath);
    errors.push(`The lockfile entry "${packagePath}" is a production dependency.`);
  }

  return {
    errors,
    lockfileVersion,
    lockfileEntries: Object.keys(packages).length,
    productionPackages,
  };
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`Zero dependency verification failed: ${error.message}`);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    console.log(USAGE);
    return;
  }

  const report = {
    ok: false,
    package: displayPath(options.packagePath),
    lockfile: displayPath(options.lockfilePath),
    lockfileVersion: null,
    lockfileEntries: 0,
    productionPackages: [],
    errors: [],
  };

  try {
    const manifest = await readJsonFile(options.packagePath, "package.json");
    report.errors.push(...checkPackageJson(manifest));

    const lockfile = await readJsonFile(options.lockfilePath, "lockfile");
    const lockfileResult = checkLockfile(lockfile);
    report.errors.push(...lockfileResult.errors);
    report.lockfileVersion = lockfileResult.lockfileVersion;
    report.lockfileEntries = lockfileResult.lockfileEntries;
    report.productionPackages = lockfileResult.productionPackages;
  } catch (error) {
    report.errors.push(error.message);
  }

  report.ok = report.errors.length === 0;

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (!report.ok) {
    for (const error of report.errors) {
      console.error(`Zero dependency verification failed: ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `Zero runtime dependencies verified: ${report.package} and ${report.lockfile} ` +
      `(${report.lockfileEntries} lockfile entries, no production packages).`,
  );
}

main().catch((error) => {
  console.error(`Zero dependency verification failed: ${error.message}`);
  process.exitCode = 1;
});
