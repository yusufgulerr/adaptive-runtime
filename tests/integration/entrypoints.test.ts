import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import * as coreApi from "../../src/core.js";
import * as edgeApi from "../../src/edge.js";
import * as rootApi from "../../src/index.js";
import * as nodeApi from "../../src/node.js";
import * as observabilityApi from "../../src/observability/index.js";
import * as policyApi from "../../src/policy/index.js";
import * as providersApi from "../../src/providers/index.js";
import * as testingApi from "../../src/testing/index.js";
import * as webApi from "../../src/web.js";

function asRecord(module: object): Record<string, unknown> {
  return module as Record<string, unknown>;
}

function expectExport(module: object, name: string): void {
  assert.equal(typeof asRecord(module)[name], "function", `${name} must be exported`);
}

function expectMissing(module: object, name: string): void {
  assert.equal(asRecord(module)[name], undefined, `${name} must not leak into this entry point`);
}

describe("package entry points", () => {
  it("core exposes only platform-neutral runtime and policy primitives", () => {
    expectExport(coreApi, "createAdaptiveRuntime");
    expectExport(coreApi, "definePolicy");
    expectExport(coreApi, "CompositeSignalProvider");
    expectExport(coreApi, "NetworkLatencyProvider");
    expectExport(coreApi, "ConfigurationError");
    expectMissing(coreApi, "ProcessMemoryProvider");
    expectMissing(coreApi, "CpuUtilizationProvider");
    expectMissing(coreApi, "EventLoopDelayProvider");
    expectMissing(coreApi, "EventLoopUtilizationProvider");
    expectMissing(coreApi, "DeviceMemoryProvider");
    expectMissing(coreApi, "ComputePressureProvider");
    expectMissing(coreApi, "NetworkInformationProvider");
    expectMissing(coreApi, "FrameTimingProvider");
    expectMissing(coreApi, "ExecutionBudgetProvider");
    expectMissing(coreApi, "createMetricsCollector");
    expectMissing(coreApi, "createFakeClock");
  });

  it("node bundles the core and Node.js providers", () => {
    expectExport(nodeApi, "createAdaptiveRuntime");
    expectExport(nodeApi, "CompositeSignalProvider");
    expectExport(nodeApi, "NetworkLatencyProvider");
    expectExport(nodeApi, "ProcessMemoryProvider");
    expectExport(nodeApi, "CpuUtilizationProvider");
    expectExport(nodeApi, "EventLoopDelayProvider");
    expectExport(nodeApi, "EventLoopUtilizationProvider");
    assert.equal(nodeApi.EVENT_LOOP_UTILIZATION, "eventLoop.utilization");
    expectMissing(nodeApi, "DeviceMemoryProvider");
    expectMissing(nodeApi, "ComputePressureProvider");
    expectMissing(nodeApi, "ExecutionBudgetProvider");
    assert.equal(nodeApi.createAdaptiveRuntime, coreApi.createAdaptiveRuntime);
  });

  it("web bundles the core and browser providers", () => {
    expectExport(webApi, "createAdaptiveRuntime");
    expectExport(webApi, "CompositeSignalProvider");
    expectExport(webApi, "NetworkLatencyProvider");
    expectExport(webApi, "DeviceMemoryProvider");
    expectExport(webApi, "NetworkInformationProvider");
    expectExport(webApi, "FrameTimingProvider");
    expectExport(webApi, "ComputePressureProvider");
    assert.equal(webApi.WEB_COMPUTE_PRESSURE, "web.computePressure");
    expectMissing(webApi, "ProcessMemoryProvider");
    expectMissing(webApi, "EventLoopUtilizationProvider");
    expectMissing(webApi, "ExecutionBudgetProvider");
    assert.equal(webApi.createAdaptiveRuntime, coreApi.createAdaptiveRuntime);
  });

  it("edge bundles the core and WinterCG providers", () => {
    expectExport(edgeApi, "createAdaptiveRuntime");
    expectExport(edgeApi, "CompositeSignalProvider");
    expectExport(edgeApi, "NetworkLatencyProvider");
    expectExport(edgeApi, "ExecutionBudgetProvider");
    expectMissing(edgeApi, "ProcessMemoryProvider");
    expectMissing(edgeApi, "DeviceMemoryProvider");
    expectMissing(edgeApi, "ComputePressureProvider");
    assert.equal(edgeApi.EDGE_EXECUTION_REMAINING_MS, "edge.execution.remainingMs");
    assert.equal(edgeApi.EDGE_EXECUTION_USED_RATIO, "edge.execution.usedRatio");
    assert.equal(edgeApi.EDGE_CONCURRENCY_SATURATION, "edge.concurrency.saturation");
    assert.equal(edgeApi.createAdaptiveRuntime, coreApi.createAdaptiveRuntime);
  });

  it("the root entry point is the Node.js entry point", () => {
    expectExport(rootApi, "createAdaptiveRuntime");
    expectExport(rootApi, "ProcessMemoryProvider");
    expectExport(rootApi, "EventLoopUtilizationProvider");
    expectMissing(rootApi, "DeviceMemoryProvider");
    expectMissing(rootApi, "ComputePressureProvider");
    expectMissing(rootApi, "ExecutionBudgetProvider");
    assert.equal(rootApi.createAdaptiveRuntime, nodeApi.createAdaptiveRuntime);
    assert.equal(rootApi.ProcessMemoryProvider, nodeApi.ProcessMemoryProvider);
  });

  it("dedicated subpaths expose observability, testing, policy, and every provider", () => {
    expectExport(observabilityApi, "MetricsCollector");
    expectExport(observabilityApi, "createMetricsCollector");
    expectExport(observabilityApi, "attachOpenTelemetryMeter");
    expectExport(testingApi, "createFakeClock");
    expectExport(testingApi, "ScriptedSignalProvider");
    expectExport(testingApi, "runProviderConformanceCheck");
    expectExport(testingApi, "simulatePolicyTimeline");
    expectExport(policyApi, "definePolicy");
    expectExport(policyApi, "evaluatePolicy");
    expectExport(providersApi, "ProcessMemoryProvider");
    expectExport(providersApi, "DeviceMemoryProvider");
    expectExport(providersApi, "NetworkInformationProvider");
    expectExport(providersApi, "FrameTimingProvider");
    expectExport(providersApi, "ExecutionBudgetProvider");
    expectExport(providersApi, "EventLoopUtilizationProvider");
    expectExport(providersApi, "ComputePressureProvider");
    expectExport(providersApi, "CompositeSignalProvider");
  });

  it("package.json declares every documented public subpath", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as {
      version?: string;
      exports?: Record<string, unknown>;
    };
    assert.equal(packageJson.version, "0.5.0");
    const exports = packageJson.exports ?? {};
    const required = [
      ".",
      "./core",
      "./node",
      "./web",
      "./edge",
      "./policy",
      "./providers",
      "./observability",
      "./testing",
      "./package.json",
    ];
    for (const subpath of required) {
      assert.ok(subpath in exports, `package.json must export ${subpath}`);
    }
    for (const subpath of required) {
      if (subpath === "./package.json") {
        assert.equal(exports[subpath], "./package.json");
        continue;
      }
      const entry = exports[subpath];
      assert.ok(entry !== null && typeof entry === "object");
      assert.ok("types" in entry);
      assert.ok("import" in entry);
      assert.ok("default" in entry);
    }
  });

  it("resolves every public subpath through Node.js package resolution", () => {
    for (const subpath of [
      ".",
      "./core",
      "./node",
      "./web",
      "./edge",
      "./policy",
      "./providers",
      "./observability",
      "./testing",
    ]) {
      const specifier =
        subpath === "." ? "adaptive-runtime" : `adaptive-runtime/${subpath.slice(2)}`;
      const resolved = import.meta.resolve(specifier);
      assert.match(resolved, /\/dist\//, `${specifier} must resolve into dist`);
    }
  });
});
