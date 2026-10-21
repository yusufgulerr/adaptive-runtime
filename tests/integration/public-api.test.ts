import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createAdaptiveRuntime,
  MissingSignalError,
  NoEligibleStrategyError,
  OperationAbortedError,
  OperationTimeoutError,
  QualityCheckError,
  RuntimeClosedError,
  type Strategy,
} from "../../src/index.js";
import { FunctionSignalProvider } from "../helpers/providers.js";

function constantProvider(id: string, signalName: string, value: number) {
  return new FunctionSignalProvider({
    id,
    signalName,
    unit: "milliseconds",
    read: (context) => [
      {
        name: signalName,
        unit: "milliseconds",
        status: "ok",
        value,
        observedAt: context.now,
      },
    ],
  });
}

const identityStrategies: readonly Strategy<number, number>[] = [
  {
    id: "thorough",
    qualityTier: 2,
    run: ({ input }) => input * 2,
  },
  {
    id: "quick",
    qualityTier: 1,
    run: ({ input }) => input * 2,
  },
];

describe("public API integration", () => {
  it("uses only the published entry point for a full adapt/close lifecycle", async () => {
    const runtime = createAdaptiveRuntime({
      providers: [constantProvider("latency", "net.latency", 10)],
      policy: {
        evaluationIntervalMs: 0,
        consecutiveSamples: 1,
        budgets: [
          {
            id: "slow-network",
            signal: "net.latency",
            limit: 100,
            recoverBelow: 80,
            tierReduction: 1,
          },
        ],
      },
    });

    const result = await runtime.run({
      operationId: "double",
      input: 21,
      strategies: identityStrategies,
    });

    assert.equal(result.value, 42);
    assert.equal(result.metadata.strategyId, "thorough");
    assert.equal(result.metadata.attempts, 1);
    assert.equal(runtime.getDecision("double")?.strategyId, "thorough");
    assert.equal(runtime.getStats("double").successes, 1);

    await runtime.close();
    await assert.rejects(
      runtime.run({ operationId: "double", input: 1, strategies: identityStrategies }),
      RuntimeClosedError,
    );
  });

  it("surfaces missing-signal, quality, timeout, and abort errors end to end", async () => {
    const missingRuntime = createAdaptiveRuntime({
      policy: {
        evaluationIntervalMs: 0,
        missingSignalBehavior: "error",
        budgets: [{ id: "missing", signal: "absent.signal", limit: 1 }],
      },
    });
    await assert.rejects(
      missingRuntime.run({ operationId: "missing", input: 1, strategies: identityStrategies }),
      MissingSignalError,
    );
    await missingRuntime.close();

    const qualityRuntime = createAdaptiveRuntime({ policy: { qualityCheck: "error" } });
    const failing: readonly Strategy<number, number>[] = [
      {
        id: "failing",
        qualityTier: 1,
        run: ({ input }) => input,
        checkQuality: () => ({ ok: false, detail: "scripted failure" }),
      },
    ];
    await assert.rejects(
      qualityRuntime.run({ operationId: "quality", input: 1, strategies: failing }),
      QualityCheckError,
    );
    await qualityRuntime.close();

    const hangingRuntime = createAdaptiveRuntime();
    const hanging: readonly Strategy<number, number>[] = [
      {
        id: "hanging",
        qualityTier: 1,
        run: ({ signal }) =>
          new Promise<number>((resolve) => {
            signal.addEventListener("abort", () => resolve(0), { once: true });
          }),
      },
    ];
    await assert.rejects(
      hangingRuntime.run({
        operationId: "timeout",
        input: 1,
        strategies: hanging,
        timeoutMs: 10,
      }),
      OperationTimeoutError,
    );
    await hangingRuntime.close();

    const abortRuntime = createAdaptiveRuntime();
    const controller = new AbortController();
    controller.abort(new Error("caller stopped"));
    await assert.rejects(
      abortRuntime.run({
        operationId: "abort",
        input: 1,
        strategies: identityStrategies,
        signal: controller.signal,
      }),
      (error: unknown) => error instanceof OperationAbortedError && error.name === "AbortError",
    );
    await abortRuntime.close();
  });

  it("rejects operations with no eligible strategy and emits no success", async () => {
    const runtime = createAdaptiveRuntime();
    const successes: number[] = [];
    runtime.on("run:success", () => successes.push(1));
    const inapplicable: readonly Strategy<number, number>[] = [
      {
        id: "never",
        qualityTier: 1,
        isApplicable: () => false,
        run: ({ input }) => input,
      },
    ];

    await assert.rejects(
      runtime.run({ operationId: "empty", input: 1, strategies: inapplicable }),
      NoEligibleStrategyError,
    );
    assert.deepEqual(successes, []);
    assert.equal(runtime.getStats("empty").failures, 1);
    await runtime.close();
  });
});
