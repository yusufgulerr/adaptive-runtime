import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as edgeApi from "../../src/edge.js";
import { definePolicy } from "../../src/policy/index.js";
import type { Strategy } from "../../src/types/strategy.js";
import * as webApi from "../../src/web.js";

describe("Tier 4 E2E: Web/Edge Simulated Environments & Providers", () => {
  it("simulates browser/web environment and verifies multi-tier degradation with web providers and composite pressure signal", async () => {
    // 1. Synthetic environment state for web
    let currentHeapUsed = 30_000_000;
    const heapLimit = 100_000_000;
    let currentRtt = 40;

    const deviceMemProvider = new webApi.DeviceMemoryProvider({
      getEnvironment: () => ({
        deviceMemory: 8,
        memory: {
          usedJSHeapSize: currentHeapUsed,
          totalJSHeapSize: 50_000_000,
          jsHeapSizeLimit: heapLimit,
        },
      }),
    });

    const networkProvider = new webApi.NetworkInformationProvider({
      getConnection: () => ({
        rtt: currentRtt,
        downlink: 15,
        saveData: false,
      }),
    });

    const frameTimingProvider = new webApi.FrameTimingProvider({
      targetFrameBudgetMs: 16.67,
      minSamples: 3,
      windowSize: 60,
    });

    // Feed initial smooth frames (16ms)
    for (let i = 0; i < 20; i++) {
      frameTimingProvider.recordFrameDuration(15.5);
    }

    // 2. Composite UX pressure signal combining frame drops and network latency
    const compositeUXProvider = new webApi.CompositeSignalProvider({
      id: "web-ux-composite",
      providers: [networkProvider, frameTimingProvider],
      rules: [
        {
          name: "web.ux.pressure",
          unit: "ratio",
          description: "Combined UI and network pressure ratio",
          inputs: [webApi.WEB_FRAME_DROPPED_RATIO, webApi.WEB_NETWORK_RTT_MS],
          compute: (values) => {
            const dropped = values[webApi.WEB_FRAME_DROPPED_RATIO] ?? 0;
            const rtt = values[webApi.WEB_NETWORK_RTT_MS] ?? 0;
            const rttNormalized = Math.min(rtt, 500) / 500;
            return dropped * 0.7 + rttNormalized * 0.3;
          },
        },
      ],
      passthroughInputs: true,
    });

    // 3. Multi-tier web rendering strategies
    const webgl3D: Strategy<string, string> = {
      id: "webgl-3d",
      qualityTier: 3,
      costTier: 3,
      run: async (context) => `rendered-3d:${context.input}`,
    };

    const canvas2D: Strategy<string, string> = {
      id: "canvas-2d",
      qualityTier: 2,
      costTier: 2,
      run: async (context) => `rendered-2d:${context.input}`,
    };

    const staticDom: Strategy<string, string> = {
      id: "static-dom",
      qualityTier: 1,
      costTier: 1,
      run: async (context) => `rendered-static:${context.input}`,
    };

    const policy = definePolicy({
      evaluationIntervalMs: 0,
      defaultStrategyId: "webgl-3d",
      fallbackStrategyId: "static-dom",
      minQualityTier: 1,
      maxQualityTier: 3,
      consecutiveSamples: 1,
      budgets: [
        {
          id: "ux-pressure-budget",
          signal: "web.ux.pressure",
          limit: 0.4,
          recoverBelow: 0.3,
          tierReduction: 1, // Degrades Tier 3 -> Tier 2
          consecutiveSamples: 1,
        },
        {
          id: "heap-budget",
          signal: webApi.WEB_JS_HEAP_USED_RATIO,
          limit: 0.75,
          recoverBelow: 0.6,
          tierReduction: 2, // Severe memory pressure degrades directly to Tier 1
          consecutiveSamples: 1,
        },
      ],
    });

    const runtime = webApi.createAdaptiveRuntime({
      providers: [deviceMemProvider, compositeUXProvider],
      policy,
    });

    try {
      const opId = "web-ui-render";

      // Step A: Baseline (low heap 30%, rtt 40ms, 0% frame drops -> web.ux.pressure = 0.024)
      const res1 = await runtime.run({
        operationId: opId,
        input: "scene-1",
        strategies: [webgl3D, canvas2D, staticDom],
      });
      assert.equal(res1.value, "rendered-3d:scene-1", "Baseline must select Tier 3 WebGL");
      assert.equal(res1.metadata.strategyId, "webgl-3d");

      // Step B: Frame drop spike (simulate animation stutter: 30 dropped frames at 35ms)
      for (let i = 0; i < 30; i++) {
        frameTimingProvider.recordFrameDuration(35.0);
      }
      currentRtt = 150; // Moderate network lag

      const res2 = await runtime.run({
        operationId: opId,
        input: "scene-2",
        strategies: [webgl3D, canvas2D, staticDom],
      });
      assert.equal(
        res2.value,
        "rendered-2d:scene-2",
        "High UX pressure must degrade to Tier 2 Canvas",
      );
      assert.equal(res2.metadata.strategyId, "canvas-2d");

      // Step C: Severe memory pressure (heap usage exceeds 85%)
      currentHeapUsed = 85_000_000;

      const res3 = await runtime.run({
        operationId: opId,
        input: "scene-3",
        strategies: [webgl3D, canvas2D, staticDom],
      });
      assert.equal(
        res3.value,
        "rendered-static:scene-3",
        "Severe memory pressure must degrade to Tier 1 Static DOM",
      );
      assert.equal(res3.metadata.strategyId, "static-dom");

      // Step D: Recovery (heap clears, smooth frames resume)
      currentHeapUsed = 25_000_000;
      currentRtt = 30;
      frameTimingProvider.clearSamples();
      for (let i = 0; i < 20; i++) {
        frameTimingProvider.recordFrameDuration(16.0);
      }

      const res4 = await runtime.run({
        operationId: opId,
        input: "scene-4",
        strategies: [webgl3D, canvas2D, staticDom],
      });
      assert.equal(res4.value, "rendered-3d:scene-4", "System recovery must restore Tier 3 WebGL");
      assert.equal(res4.metadata.strategyId, "webgl-3d");
    } finally {
      await runtime.close();
    }
  });

  it("simulates WinterCG/Cloudflare Edge environment with limited wall-clock execution budget", async () => {
    // 1. Synthetic edge environment state
    let totalBudgetMs = 50;
    let elapsedMs = 8;
    let activeRequests = 15;
    const maxConcurrency = 100;

    const edgeProvider = new edgeApi.ExecutionBudgetProvider({
      getBudgetSnapshot: () => ({
        totalBudgetMs,
        elapsedMs,
        activeRequests,
        maxConcurrency,
      }),
    });

    // 2. Multi-tier edge API gateway strategies
    const aiDeepInference: Strategy<string, string> = {
      id: "ai-deep-inference",
      qualityTier: 3,
      costTier: 3,
      run: async (context) => `deep-ai-response:${context.input}`,
    };

    const fastRegexCache: Strategy<string, string> = {
      id: "fast-regex-cache",
      qualityTier: 2,
      costTier: 2,
      run: async (context) => `fast-cached-response:${context.input}`,
    };

    const staticBypass: Strategy<string, string> = {
      id: "static-bypass",
      qualityTier: 1,
      costTier: 1,
      run: async (context) => `static-fallback-response:${context.input}`,
    };

    const policy = definePolicy({
      evaluationIntervalMs: 0,
      defaultStrategyId: "ai-deep-inference",
      fallbackStrategyId: "static-bypass",
      minQualityTier: 1,
      maxQualityTier: 3,
      consecutiveSamples: 1,
      budgets: [
        {
          id: "concurrency-saturation-budget",
          signal: edgeApi.EDGE_CONCURRENCY_SATURATION,
          limit: 0.7,
          recoverBelow: 0.5,
          tierReduction: 1, // High concurrency reduces quality tier from 3 down to 2
          consecutiveSamples: 1,
        },
        {
          id: "remaining-execution-budget",
          signal: edgeApi.EDGE_EXECUTION_USED_RATIO,
          limit: 0.75, // When >= 75% of execution time is spent, degrade to Tier 1
          recoverBelow: 0.5,
          tierReduction: 2,
          consecutiveSamples: 1,
        },
      ],
    });

    const runtime = edgeApi.createAdaptiveRuntime({
      providers: [edgeProvider],
      policy,
    });

    try {
      const opId = "edge-request-gateway";

      // Step A: Plentiful execution budget (elapsed 8ms / 50ms = 16%), low concurrency (15%)
      const res1 = await runtime.run({
        operationId: opId,
        input: "query-1",
        strategies: [aiDeepInference, fastRegexCache, staticBypass],
      });
      assert.equal(
        res1.value,
        "deep-ai-response:query-1",
        "Plentiful edge budget must select Tier 3 AI Inference",
      );
      assert.equal(res1.metadata.strategyId, "ai-deep-inference");

      // Step B: High concurrency spike (activeRequests = 85 -> saturation = 0.85 > 0.70)
      activeRequests = 85;

      const res2 = await runtime.run({
        operationId: opId,
        input: "query-2",
        strategies: [aiDeepInference, fastRegexCache, staticBypass],
      });
      assert.equal(
        res2.value,
        "fast-cached-response:query-2",
        "High concurrency saturation must degrade to Tier 2 Fast Regex/Cache",
      );
      assert.equal(res2.metadata.strategyId, "fast-regex-cache");

      // Step C: Budget near-exhaustion (elapsed = 42ms / 50ms = 84% used, only 8ms remaining)
      elapsedMs = 42;

      const res3 = await runtime.run({
        operationId: opId,
        input: "query-3",
        strategies: [aiDeepInference, fastRegexCache, staticBypass],
      });
      assert.equal(
        res3.value,
        "static-fallback-response:query-3",
        "Near-exhausted execution budget must degrade directly to Tier 1 Static Bypass",
      );
      assert.equal(res3.metadata.strategyId, "static-bypass");

      // Step D: Fresh edge request with reset budget
      totalBudgetMs = 50;
      elapsedMs = 5;
      activeRequests = 20;

      const res4 = await runtime.run({
        operationId: opId,
        input: "query-4",
        strategies: [aiDeepInference, fastRegexCache, staticBypass],
      });
      assert.equal(
        res4.value,
        "deep-ai-response:query-4",
        "Subsequent request with restored budget must select Tier 3",
      );
      assert.equal(res4.metadata.strategyId, "ai-deep-inference");
    } finally {
      await runtime.close();
    }
  });

  it("verifies zero-Node isolation in portable web and edge modules", () => {
    // Structural isolation validation: web and edge entrypoints do not export Node-specific providers
    const webExports = Object.keys(webApi);
    const edgeExports = Object.keys(edgeApi);

    const nodeOnlySymbols = [
      "ProcessMemoryProvider",
      "CpuUtilizationProvider",
      "EventLoopDelayProvider",
    ];

    for (const sym of nodeOnlySymbols) {
      assert.equal(
        webExports.includes(sym),
        false,
        `Symbol ${sym} must not be exported from web entry point`,
      );
      assert.equal(
        edgeExports.includes(sym),
        false,
        `Symbol ${sym} must not be exported from edge entry point`,
      );
    }

    // Both web and edge must export portable primitives
    assert.ok(webExports.includes("createAdaptiveRuntime"));
    assert.ok(webExports.includes("definePolicy"));
    assert.ok(webExports.includes("DeviceMemoryProvider"));
    assert.ok(webExports.includes("NetworkInformationProvider"));
    assert.ok(webExports.includes("FrameTimingProvider"));

    assert.ok(edgeExports.includes("createAdaptiveRuntime"));
    assert.ok(edgeExports.includes("definePolicy"));
    assert.ok(edgeExports.includes("ExecutionBudgetProvider"));
    assert.ok(edgeExports.includes("CompositeSignalProvider"));
  });
});
