import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SOURCE_ROOT = fileURLToPath(new URL("../../src", import.meta.url));

function collectTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

function relativeSourcePath(filePath: string): string {
  return relative(SOURCE_ROOT, filePath).replaceAll("\\", "/");
}

const ISOLATED_FILES = [
  join(SOURCE_ROOT, "core.ts"),
  join(SOURCE_ROOT, "web.ts"),
  join(SOURCE_ROOT, "edge.ts"),
  ...collectTypeScriptFiles(join(SOURCE_ROOT, "policy")),
  ...collectTypeScriptFiles(join(SOURCE_ROOT, "runtime")),
  ...collectTypeScriptFiles(join(SOURCE_ROOT, "signals")),
  ...collectTypeScriptFiles(join(SOURCE_ROOT, "errors")),
  ...collectTypeScriptFiles(join(SOURCE_ROOT, "types")),
  ...collectTypeScriptFiles(join(SOURCE_ROOT, "observability")),
  ...collectTypeScriptFiles(join(SOURCE_ROOT, "testing")),
  ...collectTypeScriptFiles(join(SOURCE_ROOT, "providers", "web")),
  ...collectTypeScriptFiles(join(SOURCE_ROOT, "providers", "edge")),
  join(SOURCE_ROOT, "providers", "composite.ts"),
];

describe("zero-Node portability", () => {
  it("keeps node: imports and process access out of portable modules", () => {
    const offenders: string[] = [];
    for (const filePath of ISOLATED_FILES) {
      const content = readFileSync(filePath, "utf8");
      if (/(?:node:|process\.)/.test(content)) {
        offenders.push(relativeSourcePath(filePath));
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("covers the documented portable module list", () => {
    const paths = ISOLATED_FILES.map(relativeSourcePath);
    for (const required of [
      "core.ts",
      "web.ts",
      "edge.ts",
      "policy/engine.ts",
      "runtime/runtime.ts",
      "signals/collector.ts",
      "observability/index.ts",
      "testing/index.ts",
      "providers/web/device-memory.ts",
      "providers/edge/execution-budget.ts",
      "providers/composite.ts",
    ]) {
      assert.ok(paths.includes(required), `${required} must be checked for portability`);
    }
  });
});
