#!/usr/bin/env node

import { readFileSync } from "node:fs";

const USAGE = `Usage: node scripts/compare-benchmarks.mjs <baseline.json> <current.json> [options]

Compares two adaptive-runtime benchmark JSON documents (schemaVersion 1;
runtime-overhead or concurrency) and prints the percentage change of every mode.

Options:
  --max-regression-percent <number>  Exit 1 if any mode is slower than the baseline by
                                     more than this percentage. Manual opt-in only.
  --json                             Print one machine-readable report to stdout.
  --help, -h                         Show this help.

Exit codes:
  0  comparison completed; no threshold configured or every mode is within it
  1  a mode exceeded the explicitly configured regression threshold
  2  invalid arguments or malformed benchmark input

Without --max-regression-percent the comparison is informational only: a
regression is reported but the process still exits 0. No threshold is enforced
by default or by CI.
`;

class InputError extends Error {}

function parsePercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent) || percent < 0) {
    throw new InputError(
      `--max-regression-percent must be a finite number >= 0 (received ${value}).`,
    );
  }
  return percent;
}

function parseArguments(argv) {
  const positional = [];
  let maxRegressionPercent = null;
  let json = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      json = true;
    } else if (argument === "--help" || argument === "-h") {
      help = true;
    } else if (argument === "--max-regression-percent") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new InputError("--max-regression-percent requires a number.");
      }
      maxRegressionPercent = parsePercent(value);
      index += 1;
    } else if (argument.startsWith("--max-regression-percent=")) {
      maxRegressionPercent = parsePercent(argument.slice("--max-regression-percent=".length));
    } else if (argument.startsWith("-")) {
      throw new InputError(`unknown option "${argument}".`);
    } else {
      positional.push(argument);
    }
  }

  if (help) {
    return { help: true };
  }
  if (positional.length !== 2) {
    throw new InputError("expected exactly two paths: <baseline.json> <current.json>.");
  }
  const [baselinePath, currentPath] = positional;
  return { help: false, baselinePath, currentPath, maxRegressionPercent, json };
}

function assertRecord(value, context) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InputError(`${context} must be a JSON object.`);
  }
  return value;
}

function optionalString(value) {
  return typeof value === "string" ? value : null;
}

function readPackage(document) {
  if (typeof document.package !== "object" || document.package === null) {
    return null;
  }
  const name = optionalString(document.package.name);
  const version = optionalString(document.package.version);
  if (name === null || version === null) {
    return null;
  }
  return { name, version };
}

function readBenchmark(filePath, label) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new InputError(`cannot read ${label} file "${filePath}": ${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new InputError(`${label} file "${filePath}" is not valid JSON: ${error.message}`);
  }

  const document = assertRecord(parsed, `${label} file "${filePath}"`);
  if (document.schemaVersion !== 1) {
    throw new InputError(
      `${label} file must use schemaVersion 1 (received ${JSON.stringify(document.schemaVersion)}).`,
    );
  }

  const isConcurrency = document.benchmark === "concurrency" || Array.isArray(document.results);
  if (isConcurrency) {
    if (!Array.isArray(document.results)) {
      throw new InputError(`${label} file must contain a "results" array.`);
    }
    if (document.results.length === 0) {
      throw new InputError(`${label} file must contain at least one result.`);
    }

    const results = [];
    const seen = new Set();
    for (const [index, entry] of document.results.entries()) {
      const item = assertRecord(entry, `${label} results[${index}]`);
      if (
        typeof item.concurrency !== "number" ||
        !Number.isInteger(item.concurrency) ||
        item.concurrency < 1
      ) {
        throw new InputError(
          `${label} results[${index}] must have a positive integer concurrency.`,
        );
      }
      if (seen.has(item.concurrency)) {
        throw new InputError(
          `${label} file has a duplicate concurrency level "${item.concurrency}".`,
        );
      }
      seen.add(item.concurrency);
      if (
        typeof item.opsPerSec !== "number" ||
        !Number.isFinite(item.opsPerSec) ||
        item.opsPerSec <= 0
      ) {
        throw new InputError(
          `${label} concurrency ${item.concurrency} must have a finite positive opsPerSec.`,
        );
      }
      results.push({
        concurrency: item.concurrency,
        label: `concurrency ${item.concurrency}`,
        opsPerSec: item.opsPerSec,
      });
    }

    return {
      type: "concurrency",
      path: filePath,
      generatedAt: optionalString(document.environment?.timestamp ?? document.generatedAt),
      package: readPackage(document),
      results,
    };
  }

  if (!Array.isArray(document.modes)) {
    throw new InputError(`${label} file must contain a "modes" array.`);
  }
  if (document.modes.length === 0) {
    throw new InputError(`${label} file must contain at least one mode.`);
  }

  const modes = [];
  const seen = new Set();
  for (const [index, entry] of document.modes.entries()) {
    const mode = assertRecord(entry, `${label} modes[${index}]`);
    if (typeof mode.label !== "string" || mode.label.trim().length === 0) {
      throw new InputError(`${label} modes[${index}] must have a non-empty string label.`);
    }
    if (seen.has(mode.label)) {
      throw new InputError(`${label} file has a duplicate mode label "${mode.label}".`);
    }
    seen.add(mode.label);
    if (
      typeof mode.medianUsPerRun !== "number" ||
      !Number.isFinite(mode.medianUsPerRun) ||
      mode.medianUsPerRun <= 0
    ) {
      throw new InputError(
        `${label} mode "${mode.label}" must have a finite positive medianUsPerRun.`,
      );
    }
    modes.push({ label: mode.label, medianUsPerRun: mode.medianUsPerRun });
  }

  return {
    type: "runtime-overhead",
    path: filePath,
    generatedAt: optionalString(document.generatedAt),
    package: readPackage(document),
    modes,
  };
}

function compareDocuments(baseline, current, maxRegressionPercent) {
  if (baseline.type !== current.type) {
    throw new InputError(
      `cannot compare ${baseline.type} benchmark with ${current.type} benchmark.`,
    );
  }

  if (baseline.type === "concurrency") {
    const currentByLevel = new Map(current.results.map((r) => [r.concurrency, r]));
    const baselineLevels = new Set(baseline.results.map((r) => r.concurrency));
    const missing = baseline.results
      .filter((r) => !currentByLevel.has(r.concurrency))
      .map((r) => r.concurrency);
    const unexpected = current.results
      .filter((r) => !baselineLevels.has(r.concurrency))
      .map((r) => r.concurrency);

    if (missing.length > 0 || unexpected.length > 0) {
      const details = [];
      if (missing.length > 0) {
        details.push(`missing from current: ${missing.join(", ")}`);
      }
      if (unexpected.length > 0) {
        details.push(`not present in baseline: ${unexpected.join(", ")}`);
      }
      throw new InputError(`concurrency level sets differ (${details.join("; ")}).`);
    }

    return baseline.results.map((baselineItem) => {
      const currentItem = currentByLevel.get(baselineItem.concurrency);
      const deltaPercent =
        ((currentItem.opsPerSec - baselineItem.opsPerSec) / baselineItem.opsPerSec) * 100;
      const regressionPercent =
        ((baselineItem.opsPerSec - currentItem.opsPerSec) / baselineItem.opsPerSec) * 100;
      const regressed = regressionPercent > 0;
      const exceedsThreshold =
        maxRegressionPercent !== null && regressionPercent > maxRegressionPercent;
      return {
        concurrency: baselineItem.concurrency,
        label: baselineItem.label,
        baselineOpsPerSec: baselineItem.opsPerSec,
        currentOpsPerSec: currentItem.opsPerSec,
        deltaPercent,
        regressed,
        exceedsThreshold,
      };
    });
  }

  const currentByLabel = new Map(current.modes.map((mode) => [mode.label, mode]));
  const baselineLabels = new Set(baseline.modes.map((mode) => mode.label));
  const missing = baseline.modes
    .filter((mode) => !currentByLabel.has(mode.label))
    .map((mode) => mode.label);
  const unexpected = current.modes
    .filter((mode) => !baselineLabels.has(mode.label))
    .map((mode) => mode.label);

  if (missing.length > 0 || unexpected.length > 0) {
    const details = [];
    if (missing.length > 0) {
      details.push(`missing from current: ${missing.join(", ")}`);
    }
    if (unexpected.length > 0) {
      details.push(`not present in baseline: ${unexpected.join(", ")}`);
    }
    throw new InputError(`mode label sets differ (${details.join("; ")}).`);
  }

  return baseline.modes.map((baselineMode) => {
    const currentMode = currentByLabel.get(baselineMode.label);
    const deltaPercent =
      ((currentMode.medianUsPerRun - baselineMode.medianUsPerRun) / baselineMode.medianUsPerRun) *
      100;
    const exceedsThreshold = maxRegressionPercent !== null && deltaPercent > maxRegressionPercent;
    return {
      label: baselineMode.label,
      baselineUsPerRun: baselineMode.medianUsPerRun,
      currentUsPerRun: currentMode.medianUsPerRun,
      deltaPercent,
      regressed: deltaPercent > 0,
      exceedsThreshold,
    };
  });
}

function formatSignedPercent(value) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatPathMetadata(path, document) {
  const packageLabel =
    document.package === null
      ? "unknown package"
      : `${document.package.name} ${document.package.version}`;
  const generatedLabel = document.generatedAt ?? "unknown date";
  return `${path} (${packageLabel}, generated ${generatedLabel})`;
}

function printHuman(report) {
  const labelWidth = Math.max("mode".length, ...report.modes.map((mode) => mode.label.length));
  const numberWidth = Math.max(
    "baseline µs/run".length,
    ...report.modes.map((mode) => mode.baselineUsPerRun.toFixed(3).length),
  );
  const currentWidth = Math.max(
    "current µs/run".length,
    ...report.modes.map((mode) => mode.currentUsPerRun.toFixed(3).length),
  );
  const deltaWidth = Math.max(
    "delta".length,
    ...report.modes.map((mode) => formatSignedPercent(mode.deltaPercent).length),
  );

  console.log("Benchmark comparison");
  console.log(`baseline: ${formatPathMetadata(report.baseline.path, report.baseline)}`);
  console.log(`current:  ${formatPathMetadata(report.current.path, report.current)}`);
  console.log("");
  console.log(
    `${"mode".padEnd(labelWidth)}  ${"baseline µs/run".padStart(numberWidth)}  ${"current µs/run".padStart(currentWidth)}  ${"delta".padStart(deltaWidth)}  note`,
  );
  for (const mode of report.modes) {
    const note = mode.exceedsThreshold
      ? "REGRESSION"
      : mode.deltaPercent > 0
        ? "slower"
        : mode.deltaPercent < 0
          ? "faster"
          : "unchanged";
    console.log(
      `${mode.label.padEnd(labelWidth)}  ${mode.baselineUsPerRun.toFixed(3).padStart(numberWidth)}  ${mode.currentUsPerRun.toFixed(3).padStart(currentWidth)}  ${formatSignedPercent(mode.deltaPercent).padStart(deltaWidth)}  ${note}`,
    );
  }
  console.log("");

  if (report.maxRegressionPercent === null) {
    if (report.regressions.length > 0) {
      console.log(
        `Regression warning (informational): ${report.regressions.length} mode(s) slower than the baseline: ${report.regressions.join(", ")}.`,
      );
    } else {
      console.log("No mode was slower than the baseline.");
    }
    console.log(
      "No regression threshold configured: differences are informational only and the exit code is 0.",
    );
    return;
  }

  if (report.thresholdExceeded) {
    const offenders = report.modes
      .filter((mode) => mode.exceedsThreshold)
      .map((mode) => `${mode.label} (${formatSignedPercent(mode.deltaPercent)})`);
    console.log(
      `Regression threshold +${report.maxRegressionPercent}% exceeded by ${offenders.length} mode(s): ${offenders.join(", ")}.`,
    );
    return;
  }

  console.log(`All modes are within +${report.maxRegressionPercent}%.`);
}

function printHumanConcurrency(report) {
  const items = report.results ?? report.modes;
  const labelWidth = Math.max(
    "concurrency".length,
    ...items.map((item) => String(item.concurrency).length),
  );
  const numberWidth = Math.max(
    "baseline ops/s".length,
    ...items.map((item) => item.baselineOpsPerSec.toFixed(2).length),
  );
  const currentWidth = Math.max(
    "current ops/s".length,
    ...items.map((item) => item.currentOpsPerSec.toFixed(2).length),
  );
  const deltaWidth = Math.max(
    "delta".length,
    ...items.map((item) => formatSignedPercent(item.deltaPercent).length),
  );

  console.log("Concurrency benchmark comparison");
  console.log(`baseline: ${formatPathMetadata(report.baseline.path, report.baseline)}`);
  console.log(`current:  ${formatPathMetadata(report.current.path, report.current)}`);
  console.log("");
  console.log(
    `${"concurrency".padEnd(labelWidth)}  ${"baseline ops/s".padStart(numberWidth)}  ${"current ops/s".padStart(currentWidth)}  ${"delta".padStart(deltaWidth)}  note`,
  );
  for (const item of items) {
    const note = item.exceedsThreshold
      ? "REGRESSION"
      : item.deltaPercent < 0
        ? "slower"
        : item.deltaPercent > 0
          ? "faster"
          : "unchanged";
    console.log(
      `${String(item.concurrency).padEnd(labelWidth)}  ${item.baselineOpsPerSec.toFixed(2).padStart(numberWidth)}  ${item.currentOpsPerSec.toFixed(2).padStart(currentWidth)}  ${formatSignedPercent(item.deltaPercent).padStart(deltaWidth)}  ${note}`,
    );
  }
  console.log("");

  if (report.maxRegressionPercent === null) {
    if (report.regressions.length > 0) {
      console.log(
        `Regression warning (informational): ${report.regressions.length} concurrency level(s) slower than the baseline: ${report.regressions.join(", ")}.`,
      );
    } else {
      console.log("No concurrency level was slower than the baseline.");
    }
    console.log(
      "No regression threshold configured: differences are informational only and the exit code is 0.",
    );
    return;
  }

  if (report.thresholdExceeded) {
    const offenders = items
      .filter((item) => item.exceedsThreshold)
      .map((item) => `${item.label} (${formatSignedPercent(item.deltaPercent)})`);
    console.log(
      `Regression threshold +${report.maxRegressionPercent}% exceeded by ${offenders.length} level(s): ${offenders.join(", ")}.`,
    );
    return;
  }

  console.log(`All concurrency levels are within +${report.maxRegressionPercent}%.`);
}

function buildReport(options, baseline, current, modes) {
  const thresholdExceeded = modes.some((mode) => mode.exceedsThreshold);
  const report = {
    schemaVersion: 1,
    benchmark: baseline.type,
    baseline: {
      path: baseline.path,
      generatedAt: baseline.generatedAt,
      package: baseline.package,
    },
    current: {
      path: current.path,
      generatedAt: current.generatedAt,
      package: current.package,
    },
    maxRegressionPercent: options.maxRegressionPercent,
    modes,
    regressions: modes.filter((mode) => mode.regressed).map((mode) => mode.label),
    thresholdExceeded,
    exitCode: thresholdExceeded ? 1 : 0,
  };
  if (baseline.type === "concurrency") {
    report.results = modes;
  }
  return report;
}

function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    if (error instanceof InputError) {
      console.error(`error: ${error.message}`);
      console.error("");
      console.error('Run with "--help" for usage.');
      return 2;
    }
    throw error;
  }

  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  let baseline;
  let current;
  let modes;
  try {
    baseline = readBenchmark(options.baselinePath, "baseline");
    current = readBenchmark(options.currentPath, "current");
    modes = compareDocuments(baseline, current, options.maxRegressionPercent);
  } catch (error) {
    if (error instanceof InputError) {
      console.error(`error: ${error.message}`);
      return 2;
    }
    throw error;
  }

  const report = buildReport(options, baseline, current, modes);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (baseline.type === "concurrency") {
    printHumanConcurrency(report);
  } else {
    printHuman(report);
  }
  return report.exitCode;
}

process.exitCode = main(process.argv.slice(2));
