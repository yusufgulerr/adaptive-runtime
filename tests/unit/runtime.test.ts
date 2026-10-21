import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ConfigurationError,
  MissingSignalError,
  NoEligibleStrategyError,
  OperationAbortedError,
  OperationTimeoutError,
  PinnedStrategyError,
  QualityCheckError,
  RuntimeClosedError,
  StrategyApplicabilityError,
  StrategyExecutionError,
} from "../../src/errors/index.js";
import { createAdaptiveRuntime } from "../../src/runtime/runtime.js";
import type { Policy } from "../../src/types/policy.js";
import type { ResourceSignal, SignalProvider } from "../../src/types/signals.js";
import type { Strategy } from "../../src/types/strategy.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { FunctionSignalProvider, okSignal, SequenceSignalProvider } from "../helpers/providers.js";

const SIGNAL = "test.value";

function strategy(
  id: string,
  qualityTier: number,
  run: Strategy<number, string>["run"],
  extra: Partial<Strategy<number, string>> = {},
): Strategy<number, string> {
  return { id, qualityTier, run, ...extra };
}

function fixedProvider(value: number, id = "fixed"): SignalProvider {
  return new FunctionSignalProvider({
    id,
    signalName: SIGNAL,
    read: (context) => [okSignal(SIGNAL, value, context.now)],
  });
}

function policy(overrides: Policy = {}): Policy {
  return {
    evaluationIntervalMs: 0,
    consecutiveSamples: 1,
    budgets: [
      {
        id: "pressure",
        signal: SIGNAL,
        limit: 100,
        recoverBelow: 50,
        tierReduction: 1,
        consecutiveSamples: 1,
      },
    ],
    ...overrides,
  };
}

function basicStrategies(
  calls: string[] = [],
): [Strategy<number, string>, Strategy<number, string>] {
  return [
    strategy("high", 2, ({ input }) => {
      calls.push("high");
      return `high:${input}`;
    }),
    strategy("economy", 1, ({ input }) => {
      calls.push("economy");
      return `economy:${input}`;
    }),
  ];
}

describe("AdaptiveRuntime", () => {
  it("runs one strategy and exposes decision metadata, stats, and events", async () => {
    const clock = new FakeClock();
    const runtime = createAdaptiveRuntime({
      clock,
      providers: [fixedProvider(10)],
      policy: policy(),
    });
    const calls: string[] = [];
    const events: string[] = [];
    runtime.on("decision", () => events.push("decision"));
    runtime.on("run:start", () => events.push("run:start"));
    runtime.on("run:success", () => events.push("run:success"));

    const result = await runtime.run({
      operationId: "op-basic",
      input: 7,
      strategies: basicStrategies(calls),
    });

    assert.equal(result.value, "high:7");
    assert.deepEqual(calls, ["high"]);
    assert.equal(result.metadata.strategyId, "high");
    assert.equal(result.metadata.qualityTier, 2);
    assert.equal(result.metadata.attempts, 1);
    assert.equal(result.metadata.quality.status, "not-configured");
    assert.equal(result.metadata.decision.strategyId, "high");
    assert.equal(result.metadata.decision.operationId, "op-basic");
    assert.equal(result.metadata.decision.signals[0]?.status, "ok");
    assert.ok(result.metadata.durationMs >= 0);
    assert.deepEqual(events, ["decision", "run:start", "run:success"]);
    assert.equal(runtime.getDecision("op-basic"), result.metadata.decision);

    const stats = runtime.getStats("op-basic");
    assert.equal(stats.runs, 1);
    assert.equal(stats.successes, 1);
    assert.equal(stats.failures, 0);
    assert.equal(stats.strategyRuns.high, 1);
    assert.ok(stats.lastDurationMs !== null);

    await runtime.close();
    await assert.rejects(
      () =>
        runtime.run({
          operationId: "op-basic",
          input: 1,
          strategies: basicStrategies(),
        }),
      RuntimeClosedError,
    );
    await runtime.close();
  });

  it("adapts across runs when pressure changes", async () => {
    const clock = new FakeClock();
    const runtime = createAdaptiveRuntime({
      clock,
      providers: [new SequenceSignalProvider({ signalName: SIGNAL, values: [10, 150, 150] })],
      policy: policy(),
    });
    const calls: string[] = [];
    const strategies = basicStrategies(calls);

    const first = await runtime.run({ operationId: "adapt", input: 1, strategies });
    const second = await runtime.run({ operationId: "adapt", input: 2, strategies });
    const third = await runtime.run({ operationId: "adapt", input: 3, strategies });

    assert.equal(first.metadata.strategyId, "high");
    assert.equal(second.metadata.strategyId, "economy");
    assert.equal(third.metadata.strategyId, "economy");
    assert.deepEqual(calls, ["high", "economy", "economy"]);
  });

  it("reuses a signal snapshot inside evaluationIntervalMs and refreshes afterwards", async () => {
    const clock = new FakeClock();
    const runtime = createAdaptiveRuntime({
      clock,
      providers: [new SequenceSignalProvider({ signalName: SIGNAL, values: [10, 150] })],
      policy: policy({ evaluationIntervalMs: 1000 }),
    });
    const strategies = basicStrategies();

    const first = await runtime.run({ operationId: "cache", input: 1, strategies });
    const second = await runtime.run({ operationId: "cache", input: 2, strategies });
    assert.equal(first.metadata.decision.signalsCached, false);
    assert.equal(second.metadata.decision.signalsCached, true);
    assert.equal(second.metadata.strategyId, "high");

    clock.advance(1000);
    const third = await runtime.run({ operationId: "cache", input: 3, strategies });
    assert.equal(third.metadata.decision.signalsCached, false);
    assert.equal(third.metadata.strategyId, "economy");
  });

  it("supports manual pins and per-operation adaptation overrides", async () => {
    const clock = new FakeClock();
    const runtime = createAdaptiveRuntime({
      clock,
      providers: [fixedProvider(150)],
      policy: policy(),
    });
    const strategies = basicStrategies();

    runtime.pinStrategy("pinned", "high");
    const pinned = await runtime.run({ operationId: "pinned", input: 1, strategies });
    assert.equal(pinned.metadata.strategyId, "high");
    assert.equal(pinned.metadata.decision.kind, "pinned");

    runtime.unpinStrategy("pinned");
    const afterUnpin = await runtime.run({ operationId: "pinned", input: 2, strategies });
    assert.equal(afterUnpin.metadata.strategyId, "economy");

    runtime.setAdaptationEnabled("static", false);
    const staticResult = await runtime.run({ operationId: "static", input: 1, strategies });
    assert.equal(staticResult.metadata.strategyId, "high");
    assert.equal(staticResult.metadata.decision.kind, "static");

    runtime.pinStrategy("pinned", "does-not-exist");
    await assert.rejects(
      () => runtime.run({ operationId: "pinned", input: 3, strategies }),
      PinnedStrategyError,
    );
  });

  it("wraps strategy failures and never retries automatically", async () => {
    const clock = new FakeClock();
    const runtime = createAdaptiveRuntime({
      clock,
      providers: [fixedProvider(10)],
      policy: policy(),
    });
    let calls = 0;
    const failing = strategy("high", 2, () => {
      calls += 1;
      throw new Error("boom");
    });
    const fallback = strategy("economy", 1, () => "fallback");

    await assert.rejects(
      () =>
        runtime.run({
          operationId: "failure",
          input: 1,
          strategies: [failing, fallback],
        }),
      (error: unknown) =>
        error instanceof StrategyExecutionError &&
        error.strategyId === "high" &&
        error.decision.strategyId === "high" &&
        error.cause instanceof Error,
    );
    assert.equal(calls, 1);
    const stats = runtime.getStats("failure");
    assert.equal(stats.failures, 1);
    assert.equal(stats.successes, 0);
    assert.equal(stats.strategyRuns.high, 1);
  });

  it("reports no eligible strategy and applicability failures", async () => {
    const clock = new FakeClock();
    const runtime = createAdaptiveRuntime({
      clock,
      providers: [fixedProvider(10)],
      policy: policy(),
    });

    await assert.rejects(
      () =>
        runtime.run({
          operationId: "none",
          input: 1,
          strategies: [
            strategy("a", 2, () => "a", { isApplicable: () => false }),
            strategy("b", 1, () => "b", { isApplicable: () => false }),
          ],
        }),
      NoEligibleStrategyError,
    );

    await assert.rejects(
      () =>
        runtime.run({
          operationId: "applicability",
          input: 1,
          strategies: [
            strategy("a", 2, () => "a", {
              isApplicable: () => {
                throw new Error("cannot decide");
              },
            }),
          ],
        }),
      StrategyApplicabilityError,
    );
  });

  it("reports quality checks without claiming correctness", async () => {
    const clock = new FakeClock();
    const runtime = createAdaptiveRuntime({
      clock,
      providers: [fixedProvider(10)],
      policy: policy(),
    });
    const checked = strategy("high", 2, () => "value", {
      checkQuality: () => ({ ok: true, score: 0.9 }),
    });
    const passed = await runtime.run({
      operationId: "quality-pass",
      input: 1,
      strategies: [checked],
    });
    assert.deepEqual(passed.metadata.quality, { status: "passed", score: 0.9 });

    const failed = strategy("high", 2, () => "value", {
      checkQuality: () => ({ ok: false, detail: "too short" }),
    });
    const reported = await runtime.run({
      operationId: "quality-report",
      input: 1,
      strategies: [failed],
    });
    assert.equal(reported.metadata.quality.status, "failed");
    assert.equal(reported.value, "value");

    const throwing = strategy("high", 2, () => "value", {
      checkQuality: () => {
        throw new Error("validator exploded");
      },
    });
    const errored = await runtime.run({
      operationId: "quality-throw",
      input: 1,
      strategies: [throwing],
    });
    assert.equal(errored.metadata.quality.status, "error");

    const enforced = createAdaptiveRuntime({
      clock,
      providers: [fixedProvider(10)],
      policy: policy({ qualityCheck: "error" }),
    });
    await assert.rejects(
      () =>
        enforced.run({
          operationId: "quality-enforced",
          input: 1,
          strategies: [failed],
        }),
      QualityCheckError,
    );
  });

  it("rejects on timeout and aborts the strategy signal", async () => {
    const clock = new FakeClock();
    const runtime = createAdaptiveRuntime({
      clock,
      providers: [fixedProvider(10)],
      policy: policy(),
    });
    let signalAborted = false;
    let releaseStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    const hanging = strategy("high", 2, ({ signal }) => {
      signal.addEventListener("abort", () => {
        signalAborted = true;
      });
      releaseStarted?.();
      return new Promise<string>(() => undefined);
    });

    const promise = runtime.run({
      operationId: "timeout",
      input: 1,
      strategies: [hanging],
      timeoutMs: 100,
    });
    const rejection = assert.rejects(promise, (error: unknown) => {
      return error instanceof OperationTimeoutError && error.name === "TimeoutError";
    });
    await started;
    clock.advance(100);
    await rejection;
    assert.equal(signalAborted, true);
  });

  it("supports pre-aborted and mid-run cancellation", async () => {
    const clock = new FakeClock();
    const runtime = createAdaptiveRuntime({
      clock,
      providers: [fixedProvider(10)],
      policy: policy(),
    });
    let calls = 0;
    const cancelling = strategy("high", 2, () => {
      calls += 1;
      return "value";
    });

    const preAborted = new AbortController();
    preAborted.abort(new Error("early"));
    await assert.rejects(
      () =>
        runtime.run({
          operationId: "abort-pre",
          input: 1,
          strategies: [cancelling],
          signal: preAborted.signal,
        }),
      (error: unknown) => error instanceof OperationAbortedError && error.name === "AbortError",
    );
    assert.equal(calls, 0);

    const controller = new AbortController();
    let releaseStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    const slow = strategy("high", 2, () => {
      releaseStarted?.();
      return new Promise<string>(() => undefined);
    });
    const promise = runtime.run({
      operationId: "abort-during",
      input: 1,
      strategies: [slow],
      signal: controller.signal,
    });
    const rejection = assert.rejects(promise, OperationAbortedError);
    await started;
    controller.abort(new Error("stop"));
    await rejection;
  });

  it("uses fallback on provider failure and can surface missing signals", async () => {
    const clock = new FakeClock();
    const errors: string[] = [];
    const failingProvider: SignalProvider = {
      id: "broken",
      signals: [{ name: SIGNAL, unit: "bytes" }],
      read: () => {
        throw new Error("broken sensor");
      },
    };
    const runtime = createAdaptiveRuntime({
      clock,
      providers: [failingProvider],
      policy: policy({
        missingSignalBehavior: "fallback",
        fallbackStrategyId: "safe",
      }),
    });
    runtime.on("provider:error", ({ providerId }) => errors.push(providerId));
    const strategies = [strategy("high", 3, () => "high"), strategy("safe", 1, () => "safe")];
    const result = await runtime.run({
      operationId: "provider-fallback",
      input: 1,
      strategies,
    });
    assert.equal(result.value, "safe");
    assert.equal(result.metadata.decision.kind, "fallback");
    assert.deepEqual(errors, ["broken"]);

    const strict = createAdaptiveRuntime({
      clock,
      providers: [failingProvider],
      policy: policy({ missingSignalBehavior: "error" }),
    });
    await assert.rejects(
      () =>
        strict.run({
          operationId: "provider-error",
          input: 1,
          strategies,
        }),
      MissingSignalError,
    );
  });

  it("times out a provider read and continues with policy fallback", async () => {
    const clock = new FakeClock();
    let providerStarted = false;
    const slowProvider: SignalProvider = {
      id: "slow",
      signals: [{ name: SIGNAL, unit: "bytes" }],
      read: () => {
        providerStarted = true;
        return new Promise<readonly ResourceSignal[]>(() => undefined);
      },
    };
    const runtime = createAdaptiveRuntime({
      clock,
      providers: [slowProvider],
      providerTimeoutMs: 50,
      policy: policy({
        missingSignalBehavior: "fallback",
        fallbackStrategyId: "safe",
      }),
    });
    const promise = runtime.run({
      operationId: "provider-timeout",
      input: 1,
      strategies: [strategy("high", 2, () => "high"), strategy("safe", 1, () => "safe")],
    });
    while (!providerStarted) {
      await Promise.resolve();
    }
    clock.advance(50);
    const result = await promise;
    assert.equal(result.value, "safe");
    assert.equal(result.metadata.decision.budgets[0]?.status, "error");
  });

  it("isolates listener errors and emits listener:error", async () => {
    const clock = new FakeClock();
    const runtime = createAdaptiveRuntime({
      clock,
      providers: [fixedProvider(10)],
      policy: policy(),
    });
    const seen: string[] = [];
    runtime.on("decision", () => {
      throw new Error("listener failed");
    });
    runtime.on("listener:error", ({ event }) => {
      seen.push(event);
    });
    const result = await runtime.run({
      operationId: "listener",
      input: 1,
      strategies: basicStrategies(),
    });
    assert.equal(result.value, "high:1");
    assert.deepEqual(seen, ["decision"]);
  });

  it("handles concurrent runs for the same and different operations", async () => {
    const clock = new FakeClock();
    const runtime = createAdaptiveRuntime({
      clock,
      providers: [fixedProvider(10)],
      policy: policy(),
    });
    let calls = 0;
    const strategies = [
      strategy("high", 2, async ({ input }) => {
        calls += 1;
        await Promise.resolve();
        return `value:${input}`;
      }),
    ];
    const results = await Promise.all([
      runtime.run({ operationId: "concurrent", input: 1, strategies }),
      runtime.run({ operationId: "concurrent", input: 2, strategies }),
      runtime.run({ operationId: "other", input: 3, strategies }),
    ]);
    assert.deepEqual(
      results.map((result) => result.value),
      ["value:1", "value:2", "value:3"],
    );
    assert.equal(calls, 3);
    assert.equal(runtime.getStats("concurrent").runs, 2);
    assert.equal(runtime.getStats("other").runs, 1);
  });

  it("validates operations and configuration before executing", async () => {
    const clock = new FakeClock();
    const runtime = createAdaptiveRuntime({
      clock,
      providers: [fixedProvider(10)],
      policy: policy(),
    });
    let calls = 0;
    const valid = strategy("high", 2, () => {
      calls += 1;
      return "value";
    });

    await assert.rejects(
      () =>
        runtime.run({
          operationId: "bad",
          input: 1,
          strategies: [],
        }),
      ConfigurationError,
    );
    await assert.rejects(
      () =>
        runtime.run({
          operationId: "bad",
          input: 1,
          strategies: [valid, valid],
        }),
      ConfigurationError,
    );
    await assert.rejects(
      () =>
        runtime.run({
          operationId: "bad",
          input: 1,
          strategies: [strategy("high", Number.NaN, () => "value")],
        }),
      ConfigurationError,
    );
    await assert.rejects(
      () =>
        runtime.run({
          operationId: "bad",
          input: 1,
          strategies: [valid],
          timeoutMs: 0,
        }),
      ConfigurationError,
    );
    assert.equal(calls, 0);

    assert.throws(
      () =>
        createAdaptiveRuntime({
          policy: policy({ missingSignalBehavior: "fallback" }),
        }),
      ConfigurationError,
    );
    assert.throws(
      () =>
        createAdaptiveRuntime({
          providers: [fixedProvider(10), fixedProvider(20)],
        }),
      ConfigurationError,
    );
  });

  it("closes providers and reports close through an event", async () => {
    let closed = false;
    const provider: SignalProvider = {
      id: "closable",
      signals: [{ name: SIGNAL, unit: "bytes" }],
      read: (context) => [okSignal(SIGNAL, 1, context.now)],
      close: () => {
        closed = true;
      },
    };
    const runtime = createAdaptiveRuntime({ providers: [provider] });
    let closeEvent = false;
    runtime.on("runtime:closed", () => {
      closeEvent = true;
    });
    await runtime.run({
      operationId: "close",
      input: 1,
      strategies: [strategy("high", 1, () => "value")],
    });
    await runtime.close();
    assert.equal(closed, true);
    assert.equal(closeEvent, true);
  });

  it("rejects non-function listeners and whitespace strategy ids", async () => {
    const runtime = createAdaptiveRuntime();
    assert.throws(() => runtime.on("decision", null as unknown as () => void), ConfigurationError);
    await assert.rejects(
      runtime.run({
        operationId: "spacing",
        input: 1,
        strategies: [strategy(" spaced ", 1, () => "value")],
      }),
      ConfigurationError,
    );
    await runtime.close();
  });

  it("rejects a waiter with OperationAbortedError without cancelling the shared read", async () => {
    let release: (() => void) | undefined;
    let reads = 0;
    const provider = new FunctionSignalProvider({
      read: () => {
        reads += 1;
        return new Promise<readonly ResourceSignal[]>((resolve) => {
          release = () => resolve([okSignal(SIGNAL, 1, Date.now())]);
        });
      },
    });
    const runtime = createAdaptiveRuntime({
      providers: [provider],
      policy: { evaluationIntervalMs: 0 },
    });
    const first = runtime.run({
      operationId: "shared-first",
      input: 1,
      strategies: [strategy("high", 1, () => "one")],
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reads, 1);

    const controller = new AbortController();
    const second = runtime.run({
      operationId: "shared-second",
      input: 1,
      strategies: [strategy("high", 1, () => "two")],
      signal: controller.signal,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(new Error("stop waiting"));

    await assert.rejects(second, OperationAbortedError);
    release?.();
    assert.equal((await first).value, "one");
    assert.equal(reads, 1);
    await runtime.close();
  });

  it("continues the shared read for a waiter when the initiator aborts", async () => {
    let release: (() => void) | undefined;
    let reads = 0;
    const provider = new FunctionSignalProvider({
      read: () => {
        reads += 1;
        return new Promise<readonly ResourceSignal[]>((resolve) => {
          release = () => resolve([okSignal(SIGNAL, 1, Date.now())]);
        });
      },
    });
    const runtime = createAdaptiveRuntime({
      providers: [provider],
      policy: { evaluationIntervalMs: 0 },
    });
    const initiator = new AbortController();
    const first = runtime.run({
      operationId: "shared-initiator",
      input: 1,
      strategies: [strategy("high", 1, () => "initiator")],
      signal: initiator.signal,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reads, 1);

    const second = runtime.run({
      operationId: "shared-survivor",
      input: 1,
      strategies: [strategy("high", 1, () => "survivor")],
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    initiator.abort(new Error("stop initiator"));

    await assert.rejects(first, OperationAbortedError);
    release?.();
    assert.equal((await second).value, "survivor");
    assert.equal(reads, 1);
    await runtime.close();
  });
});
