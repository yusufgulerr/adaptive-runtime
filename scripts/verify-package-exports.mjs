#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const EXPECTED_EXPORTS = {
  ".": [
    "createAdaptiveRuntime",
    "CompositeSignalProvider",
    "ProcessMemoryProvider",
    "EventLoopUtilizationProvider",
    "composeSelectors",
    "createCostBudgetSelector",
    "createSafeSelector",
    "inspectStateSnapshot",
    "diffStateSnapshots",
    "filterStateSnapshot",
    "createCompositeSignalProvider",
  ],
  "./core": [
    "createAdaptiveRuntime",
    "CompositeSignalProvider",
    "NetworkLatencyProvider",
    "composeSelectors",
    "createCostBudgetSelector",
    "createSafeSelector",
    "inspectStateSnapshot",
    "diffStateSnapshots",
    "filterStateSnapshot",
    "createCompositeSignalProvider",
  ],
  "./node": [
    "createAdaptiveRuntime",
    "ProcessMemoryProvider",
    "EventLoopDelayProvider",
    "EventLoopUtilizationProvider",
  ],
  "./web": [
    "DeviceMemoryProvider",
    "NetworkInformationProvider",
    "FrameTimingProvider",
    "ComputePressureProvider",
  ],
  "./edge": [
    "ExecutionBudgetProvider",
    "EDGE_EXECUTION_REMAINING_MS",
    "createEdgeExecutionBudgetProvider",
  ],
  "./policy": [
    "definePolicy",
    "resolvePolicy",
    "evaluatePolicy",
    "composeSelectors",
    "createCostBudgetSelector",
    "createSafeSelector",
  ],
  "./providers": [
    "CompositeSignalProvider",
    "ExecutionBudgetProvider",
    "DeviceMemoryProvider",
    "ProcessMemoryProvider",
    "EventLoopUtilizationProvider",
    "ComputePressureProvider",
    "createCompositeSignalProvider",
    "createEdgeExecutionBudgetProvider",
  ],
  "./observability": ["MetricsCollector", "createMetricsCollector", "attachOpenTelemetryMeter"],
  "./testing": [
    "createFakeClock",
    "ScriptedSignalProvider",
    "runProviderConformanceCheck",
    "simulatePolicyTimeline",
  ],
};

async function assertFile(relativePath, label) {
  try {
    await access(join(root, relativePath));
  } catch {
    throw new Error(`${label} points to a missing file: ${relativePath}`);
  }
}

async function main() {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const exportsMap = packageJson.exports ?? {};
  const packageName = packageJson.name;

  if (typeof packageName !== "string" || packageName.length === 0) {
    throw new Error("package.json has no package name.");
  }

  const exportSubpaths = Object.keys(exportsMap).filter((subpath) => subpath !== "./package.json");
  for (const subpath of Object.keys(EXPECTED_EXPORTS)) {
    if (!Object.hasOwn(exportsMap, subpath)) {
      throw new Error(`package.json is missing the expected "${subpath}" export.`);
    }
  }
  for (const subpath of exportSubpaths) {
    if (!Object.hasOwn(EXPECTED_EXPORTS, subpath)) {
      throw new Error(`The "${subpath}" export has no EXPECTED_EXPORTS entry.`);
    }
  }

  let verifiedFiles = 0;

  for (const [subpath, target] of Object.entries(exportsMap)) {
    if (subpath === "./package.json") {
      if (target !== "./package.json") {
        throw new Error('The "./package.json" export must map to "./package.json".');
      }
      continue;
    }

    if (typeof target === "string") {
      await assertFile(target, `${subpath} export`);
      verifiedFiles += 1;
      continue;
    }

    for (const condition of ["types", "import", "default"]) {
      const relativePath = target?.[condition];
      if (typeof relativePath !== "string") {
        throw new Error(`${subpath} is missing the "${condition}" condition.`);
      }
      await assertFile(relativePath, `${subpath} ${condition}`);
      verifiedFiles += 1;
    }
  }

  let verifiedSymbols = 0;

  for (const [subpath, names] of Object.entries(EXPECTED_EXPORTS)) {
    const specifier = subpath === "." ? packageName : `${packageName}/${subpath.slice(2)}`;
    const module = await import(specifier);

    for (const name of names) {
      if (module[name] === undefined) {
        throw new Error(`${specifier} does not export ${name}.`);
      }
      verifiedSymbols += 1;
    }
  }

  console.log(
    `Verified ${Object.keys(exportsMap).length} export entries, ${verifiedFiles} files, and ${verifiedSymbols} runtime symbols.`,
  );
}

main().catch((error) => {
  console.error(`Package export verification failed: ${error.message}`);
  process.exitCode = 1;
});
