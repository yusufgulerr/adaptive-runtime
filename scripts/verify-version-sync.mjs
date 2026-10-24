#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function requireVersion(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is missing a version.`);
  }
  return value;
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(join(root, relativePath), "utf8"));
}

async function main() {
  const packageJson = await readJson("package.json");
  const lock = await readJson("package-lock.json");
  const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");

  const citation = await readFile(join(root, "CITATION.cff"), "utf8");

  const packageName = packageJson.name;
  if (typeof packageName !== "string" || packageName.length === 0) {
    throw new Error("package.json has no package name.");
  }

  const packageVersion = requireVersion(packageJson.version, "package.json");
  const lockVersion = requireVersion(lock.version, "package-lock.json");
  const lockedRootVersion = requireVersion(
    lock.packages?.[""]?.version,
    'package-lock.json packages[""]',
  );

  if (lock.name !== packageName) {
    throw new Error(
      `package-lock.json name "${String(lock.name)}" does not match package.json "${packageName}".`,
    );
  }
  if (lockVersion !== packageVersion || lockedRootVersion !== packageVersion) {
    throw new Error(
      `Version mismatch: package.json=${packageVersion}, package-lock.json=${lockVersion}, locked root=${lockedRootVersion}.`,
    );
  }
  if (!changelog.includes(`## [${packageVersion}]`)) {
    throw new Error(`CHANGELOG.md has no "## [${packageVersion}]" section.`);
  }

  const citationMatch = citation.match(/^version:\s*["']?([^"'\r\n]+)["']?/m);
  if (!citationMatch) {
    throw new Error("CITATION.cff is missing a version field.");
  }
  const citationVersion = requireVersion(citationMatch[1].trim(), "CITATION.cff");
  if (citationVersion !== packageVersion) {
    throw new Error(
      `Version mismatch: package.json=${packageVersion}, CITATION.cff=${citationVersion}.`,
    );
  }
  if (!/^date-released:\s*["']?2026-10-24["']?/m.test(citation)) {
    throw new Error("CITATION.cff is missing or has incorrect date-released field.");
  }

  console.log(
    `Version sync verified: ${packageName} ${packageVersion} (package.json, package-lock.json, CHANGELOG.md, CITATION.cff).`,
  );
}

main().catch((error) => {
  console.error(`Version sync verification failed: ${error.message}`);
  process.exitCode = 1;
});
