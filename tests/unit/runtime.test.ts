import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { describe, it } from "node:test";
import {
  ConfigurationError,
  FallbackStrategyError,
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
import { resolveOperationPolicy, resolvePolicy } from "../../src/policy/resolve.js";
import { createAdaptiveRuntime } from "../../src/runtime/runtime.js";
import {
  validateOperation,
  validateOperationId,
  validateOptionalAbortSignal,
  validateProviderTimeout,
  validateStrategies,
  validateTimeout,
} from "../../src/runtime/validate.js";
import type { DecisionReason, SignalView, StrategyDecision } from "../../src/types/decision.js";
import type { Policy } from "../../src/types/policy.js";
import type { RunMetadata } from "../../src/types/run.js";
import type { ResourceSignal, SignalProvider } from "../../src/types/signals.js";
import type { Strategy } from "../../src/types/strategy.js";
import { errorMessage, toError } from "../../src/utils/errors.js";
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

  it("rejects padded pin strategy ids without storing a pin", async () => {
    const clock = new FakeClock();
    const runtime = createAdaptiveRuntime({
      clock,
      providers: [fixedProvider(150)],
      policy: policy(),
    });
    const strategies = basicStrategies();

    assert.throws(() => runtime.pinStrategy("padded-pin", " hi "), ConfigurationError);
    const result = await runtime.run({ operationId: "padded-pin", input: 1, strategies });
    assert.equal(result.metadata.decision.kind, "initial");
    assert.equal(result.metadata.strategyId, "economy");
    assert.equal(runtime.getDecision("padded-pin")?.kind, "initial");
    await runtime.close();
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

  it("keeps the stored decision immutable across decision listeners", async () => {
    const clock = new FakeClock();
    const runtime = createAdaptiveRuntime({
      clock,
      providers: [fixedProvider(10)],
      policy: policy(),
    });
    const calls: string[] = [];
    const mutationResults: boolean[] = [];
    const listenerErrors: string[] = [];
    let observedDecision: StrategyDecision | undefined;
    runtime.on("decision", ({ decision }) => {
      observedDecision = decision;
      mutationResults.push(Reflect.set(decision, "strategyId", "economy"));
      mutationResults.push(Reflect.set(decision, "changed", true));
      const signal = decision.signals[0];
      if (signal !== undefined) {
        mutationResults.push(Reflect.set(signal, "status", "error"));
        mutationResults.push(Reflect.set(signal, "value", 999));
      }
      const reason = decision.reasons[0];
      if (reason !== undefined) {
        mutationResults.push(Reflect.set(reason, "message", "tampered"));
      }
      const budget = decision.budgets[0];
      if (budget !== undefined) {
        mutationResults.push(Reflect.set(budget, "limit", -1));
      }
      try {
        (decision.reasons as DecisionReason[]).push({
          code: "cached-sample",
          message: "injected",
        });
        mutationResults.push(true);
      } catch {
        mutationResults.push(false);
      }
      throw new Error("decision listener failed");
    });
    runtime.on("listener:error", ({ event }) => listenerErrors.push(event));

    const result = await runtime.run({
      operationId: "immutable-decision",
      input: 1,
      strategies: basicStrategies(calls),
    });

    assert.deepEqual(calls, ["high"]);
    assert.equal(result.value, "high:1");
    assert.equal(result.metadata.strategyId, "high");
    assert.equal(result.metadata.decision.strategyId, "high");
    assert.equal(result.metadata.decision.kind, "initial");
    const stored = runtime.getDecision("immutable-decision");
    assert.equal(stored, result.metadata.decision);
    assert.equal(stored?.strategyId, "high");
    assert.equal(stored?.signals[0]?.status, "ok");
    assert.equal(stored?.budgets[0]?.limit, 100);
    assert.equal(observedDecision, stored);
    assert.deepEqual(mutationResults, [false, false, false, false, false, false, false]);
    assert.deepEqual(listenerErrors, ["decision"]);
    assert.equal(Object.isFrozen(result.metadata.decision), true);
    assert.equal(Object.isFrozen(result.metadata.decision.signals), true);
    assert.equal(Object.isFrozen(result.metadata.decision.signals[0]), true);
    assert.equal(Object.isFrozen(result.metadata.decision.reasons[0]), true);
    assert.equal(Object.isFrozen(result.metadata.decision.budgets[0]), true);
    await runtime.close();
  });

  it("keeps returned run metadata immutable across success listeners", async () => {
    const clock = new FakeClock();
    const runtime = createAdaptiveRuntime({
      clock,
      providers: [fixedProvider(10)],
      policy: policy(),
    });
    const mutationResults: boolean[] = [];
    const listenerErrors: string[] = [];
    let observedMetadata: RunMetadata | undefined;
    runtime.on("run:success", ({ metadata }) => {
      observedMetadata = metadata;
      mutationResults.push(Reflect.set(metadata, "strategyId", "economy"));
      mutationResults.push(Reflect.set(metadata, "durationMs", 999_999));
      mutationResults.push(Reflect.set(metadata.quality, "status", "failed"));
      mutationResults.push(Reflect.set(metadata.quality, "score", -1));
      const signal = metadata.signals[0];
      if (signal !== undefined) {
        mutationResults.push(Reflect.set(signal, "status", "error"));
        mutationResults.push(Reflect.set(signal, "value", -1));
      }
      mutationResults.push(Reflect.set(metadata.decision, "strategyId", "economy"));
      try {
        (metadata.signals as SignalView[]).push({ name: "tampered", status: "ok" });
        mutationResults.push(true);
      } catch {
        mutationResults.push(false);
      }
      throw new Error("success listener failed");
    });
    runtime.on("listener:error", ({ event }) => listenerErrors.push(event));

    const result = await runtime.run({
      operationId: "immutable-metadata",
      input: 1,
      strategies: [
        strategy("high", 2, () => "value", {
          checkQuality: () => ({ ok: true, score: 0.9 }),
        }),
      ],
    });

    assert.equal(result.metadata.strategyId, "high");
    assert.notEqual(result.metadata.durationMs, 999_999);
    assert.equal(result.metadata.quality.status, "passed");
    assert.equal(result.metadata.quality.score, 0.9);
    assert.equal(result.metadata.signals[0]?.status, "ok");
    assert.equal(result.metadata.signals[0]?.value, 10);
    assert.equal(result.metadata.decision.strategyId, "high");
    assert.equal(runtime.getDecision("immutable-metadata"), result.metadata.decision);
    assert.equal(observedMetadata, result.metadata);
    assert.deepEqual(mutationResults, [false, false, false, false, false, false, false, false]);
    assert.deepEqual(listenerErrors, ["run:success"]);
    assert.equal(Object.isFrozen(result.metadata), true);
    assert.equal(Object.isFrozen(result.metadata.quality), true);
    assert.equal(Object.isFrozen(result.metadata.signals), true);
    assert.equal(Object.isFrozen(result.metadata.decision), true);
    await runtime.close();
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

  it("removes all retained state and stats for one operation", async () => {
    const clock = new FakeClock();
    const runtime = createAdaptiveRuntime({
      clock,
      providers: [fixedProvider(10)],
      policy: policy(),
    });
    const strategies = basicStrategies();
    await runtime.run({ operationId: "remove-me", input: 1, strategies });
    runtime.pinStrategy("remove-me", "high");
    runtime.setAdaptationEnabled("remove-me", false);
    assert.notEqual(runtime.getDecision("remove-me"), null);
    assert.equal(runtime.getStats("remove-me").runs, 1);

    assert.equal(runtime.removeOperation("remove-me"), true);
    assert.equal(runtime.getDecision("remove-me"), null);
    assert.equal(runtime.getStats("remove-me").runs, 0);
    assert.equal(runtime.removeOperation("remove-me"), false);
    assert.throws(() => runtime.removeOperation("   "), ConfigurationError);

    await runtime.close();
    assert.throws(() => runtime.removeOperation("remove-me"), RuntimeClosedError);
  });

  it("resets one operation's stats or every operation's stats", async () => {
    const clock = new FakeClock();
    const runtime = createAdaptiveRuntime({
      clock,
      providers: [fixedProvider(10)],
      policy: policy(),
    });
    const strategies = basicStrategies();
    await runtime.run({ operationId: "stats-a", input: 1, strategies });
    await runtime.run({ operationId: "stats-a", input: 2, strategies });
    await runtime.run({ operationId: "stats-b", input: 3, strategies });

    runtime.resetStats("stats-a");
    assert.equal(runtime.getStats("stats-a").runs, 0);
    assert.equal(runtime.getStats("stats-a").successes, 0);
    assert.equal(runtime.getStats("stats-b").runs, 1);
    assert.notEqual(runtime.getDecision("stats-a"), null);

    runtime.resetStats();
    assert.equal(runtime.getStats("stats-b").runs, 0);
    assert.notEqual(runtime.getDecision("stats-b"), null);

    await runtime.close();
    assert.throws(() => runtime.resetStats(), RuntimeClosedError);
    assert.throws(() => runtime.resetStats("stats-a"), RuntimeClosedError);
  });

  it("evicts the least-recently-used operation when maxTrackedOperations is exceeded", async () => {
    const clock = new FakeClock();
    const runtime = createAdaptiveRuntime({
      clock,
      providers: [fixedProvider(10)],
      policy: policy({ maxTrackedOperations: 2 }),
    });
    const strategies = basicStrategies();
    await runtime.run({ operationId: "lru-a", input: 1, strategies });
    await runtime.run({ operationId: "lru-b", input: 2, strategies });

    assert.notEqual(runtime.getDecision("lru-a"), null);
    await runtime.run({ operationId: "lru-c", input: 3, strategies });

    assert.notEqual(runtime.getDecision("lru-a"), null);
    assert.equal(runtime.getDecision("lru-b"), null);
    assert.equal(runtime.getStats("lru-b").runs, 0);
    assert.notEqual(runtime.getDecision("lru-c"), null);
    await runtime.close();
  });

  it("never evicts pinned operations while enforcing the tracking bound", async () => {
    const clock = new FakeClock();
    const runtime = createAdaptiveRuntime({
      clock,
      providers: [fixedProvider(10)],
      policy: policy({ maxTrackedOperations: 1 }),
    });
    const strategies = basicStrategies();
    runtime.pinStrategy("pinned-keep", "high");
    await runtime.run({ operationId: "pinned-keep", input: 1, strategies });
    await runtime.run({ operationId: "pinned-other", input: 2, strategies });

    assert.notEqual(runtime.getDecision("pinned-keep"), null);
    assert.equal(runtime.getDecision("pinned-other"), null);

    runtime.unpinStrategy("pinned-keep");
    const afterUnpin = await runtime.run({
      operationId: "pinned-keep",
      input: 3,
      strategies,
    });
    assert.equal(afterUnpin.metadata.strategyId, "high");
    assert.equal(afterUnpin.metadata.decision.kind, "retained");
    await runtime.close();
  });

  it("keeps a just-written adaptation override when pins fill the tracking bound", async () => {
    const clock = new FakeClock();
    const runtime = createAdaptiveRuntime({
      clock,
      providers: [fixedProvider(150)],
      policy: policy({ maxTrackedOperations: 1 }),
    });
    const strategies = basicStrategies();

    runtime.pinStrategy("pinned-hold", "high");
    runtime.setAdaptationEnabled("static-survivor", false);
    const result = await runtime.run({
      operationId: "static-survivor",
      input: 1,
      strategies,
    });

    assert.equal(result.metadata.decision.kind, "static");
    assert.equal(result.metadata.strategyId, "high");
    await runtime.close();
  });

  it("re-applies the tracking bound when a pin is released", async () => {
    const clock = new FakeClock();
    const runtime = createAdaptiveRuntime({
      clock,
      providers: [fixedProvider(10)],
      policy: policy({ maxTrackedOperations: 1 }),
    });
    const strategies = basicStrategies();
    runtime.pinStrategy("pin-release-a", "high");
    runtime.pinStrategy("pin-release-b", "high");
    await runtime.run({ operationId: "pin-release-a", input: 1, strategies });
    await runtime.run({ operationId: "pin-release-b", input: 2, strategies });

    assert.notEqual(runtime.getDecision("pin-release-a"), null);
    assert.notEqual(runtime.getDecision("pin-release-b"), null);

    runtime.unpinStrategy("pin-release-a");
    assert.equal(runtime.getDecision("pin-release-a"), null);
    assert.notEqual(runtime.getDecision("pin-release-b"), null);
    await runtime.close();
  });

  it("refuses to remove an operation during an active selection", async () => {
    const clock = new FakeClock();
    let release: (() => void) | undefined;
    const provider = new FunctionSignalProvider({
      read: () => {
        return new Promise<readonly ResourceSignal[]>((resolve) => {
          release = () => resolve([okSignal(SIGNAL, 10, clock.now())]);
        });
      },
    });
    const runtime = createAdaptiveRuntime({
      clock,
      providers: [provider],
      policy: policy(),
    });
    const pending = runtime.run({
      operationId: "busy-operation",
      input: 1,
      strategies: basicStrategies(),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(runtime.removeOperation("busy-operation"), false);
    release?.();
    await pending;
    assert.equal(runtime.removeOperation("busy-operation"), true);
    await runtime.close();
  });

  it("describes both branches of typed error messages", () => {
    assert.match(new NoEligibleStrategyError("op", undefined).message, /no quality floor/);
    assert.match(new NoEligibleStrategyError("op", 2).message, /quality floor 2/);
    assert.match(new PinnedStrategyError("op", "s", "not-found").message, /not defined/);
    assert.match(new PinnedStrategyError("op", "s", "not-applicable").message, /not applicable/);
    assert.match(new FallbackStrategyError("op", "s", "not-found").message, /not defined/);
    assert.match(new FallbackStrategyError("op", "s", "not-applicable").message, /not applicable/);

    const plain = new StrategyExecutionError("op", "s", {} as never, 1, "plain failure");
    assert.match(plain.message, /plain failure/);
    const wrapped = new StrategyExecutionError("op", "s", {} as never, 1, new Error("cause text"));
    assert.match(wrapped.message, /cause text/);
  });

  it("rejects immediately on pre-aborted signal fast-path without modifying lock state", async () => {
    const runtime = createAdaptiveRuntime({
      providers: [fixedProvider(10)],
      policy: policy(),
    });
    const preAborted = new AbortController();
    const abortReason = new Error("pre-aborted before run");
    preAborted.abort(abortReason);

    let strategyCalls = 0;
    const testStrategies = [
      strategy("s1", 1, () => {
        strategyCalls += 1;
        return "val";
      }),
    ];

    await assert.rejects(
      runtime.run({
        operationId: "fast-path-abort",
        input: 1,
        strategies: testStrategies,
        signal: preAborted.signal,
      }),
      (error: unknown) =>
        error instanceof OperationAbortedError &&
        error.name === "AbortError" &&
        error.operationId === "fast-path-abort" &&
        error.cause === abortReason,
    );

    assert.equal(strategyCalls, 0);
    assert.equal(runtime.removeOperation("fast-path-abort"), false);
    assert.equal(getEventListeners(preAborted.signal, "abort").length, 0);
    await runtime.close();
  });

  it("resolves head-of-line blocking with zero delay when queued task is aborted", async () => {
    let releaseTaskA: (() => void) | undefined;
    let taskACompleted = false;
    const provider = new FunctionSignalProvider({
      id: "slow-provider",
      signalName: SIGNAL,
      read: (context) =>
        new Promise<readonly ResourceSignal[]>((resolve) => {
          releaseTaskA = () => {
            taskACompleted = true;
            resolve([okSignal(SIGNAL, 10, context.now)]);
          };
        }),
    });

    const runtime = createAdaptiveRuntime({
      providers: [provider],
      policy: { evaluationIntervalMs: 0 },
    });

    let taskBCalls = 0;
    const taskAPromise = runtime.run({
      operationId: "hol-op",
      input: 1,
      strategies: [strategy("sA", 1, () => "taskA-result")],
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const ctrlB = new AbortController();
    const taskBPromise = runtime.run({
      operationId: "hol-op",
      input: 2,
      strategies: [
        strategy("sB", 1, () => {
          taskBCalls += 1;
          return "taskB-result";
        }),
      ],
      signal: ctrlB.signal,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(getEventListeners(ctrlB.signal, "abort").length, 1);
    const abortReason = new Error("abort task B in queue");
    ctrlB.abort(abortReason);

    await assert.rejects(
      taskBPromise,
      (error: unknown) =>
        error instanceof OperationAbortedError &&
        error.name === "AbortError" &&
        error.operationId === "hol-op" &&
        error.cause === abortReason,
    );

    // Crucial HoL assertion: Task B rejected while Task A is still in-flight
    assert.equal(taskACompleted, false);
    assert.equal(getEventListeners(ctrlB.signal, "abort").length, 0);

    // Release Task A and verify it finishes normally and Task B was never invoked
    releaseTaskA?.();
    const resultA = await taskAPromise;
    assert.equal(resultA.value, "taskA-result");
    assert.equal(taskACompleted, true);
    assert.equal(taskBCalls, 0);

    await runtime.close();
  });

  it("verifies zero HoL delay under wall-clock timing and recovers queue for subsequent task", async () => {
    let releaseTaskA: (() => void) | undefined;
    let reads = 0;
    const provider = new FunctionSignalProvider({
      id: "timed-provider",
      signalName: SIGNAL,
      read: (context) => {
        reads += 1;
        if (reads === 1) {
          return new Promise<readonly ResourceSignal[]>((resolve) => {
            releaseTaskA = () => {
              resolve([okSignal(SIGNAL, 10, context.now)]);
            };
          });
        }
        return [okSignal(SIGNAL, 10, context.now)];
      },
    });

    const runtime = createAdaptiveRuntime({
      providers: [provider],
      policy: { evaluationIntervalMs: 0 },
    });

    let taskBCalls = 0;
    let taskCCalls = 0;

    const taskAPromise = runtime.run({
      operationId: "queue-recovery-op",
      input: 1,
      strategies: [strategy("sA", 1, () => "resA")],
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const timer = setTimeout(() => {
      releaseTaskA?.();
    }, 60);

    const ctrlB = new AbortController();
    const taskBStartTime = Date.now();
    let taskBRejectionElapsed = 0;

    const taskBPromise = runtime
      .run({
        operationId: "queue-recovery-op",
        input: 2,
        strategies: [
          strategy("sB", 1, () => {
            taskBCalls += 1;
            return "resB";
          }),
        ],
        signal: ctrlB.signal,
      })
      .catch((error: unknown) => {
        taskBRejectionElapsed = Date.now() - taskBStartTime;
        throw error;
      });

    const taskCPromise = runtime.run({
      operationId: "queue-recovery-op",
      input: 3,
      strategies: [
        strategy("sC", 1, () => {
          taskCCalls += 1;
          return "resC";
        }),
      ],
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    ctrlB.abort(new Error("abort B after 10ms"));

    await assert.rejects(taskBPromise, OperationAbortedError);
    // Task B rejected well before Task A's 60ms timer completed (< 45ms)
    assert.ok(
      taskBRejectionElapsed < 45,
      `Expected task B to reject with zero HoL delay (<45ms), got ${taskBRejectionElapsed}ms`,
    );

    const [resA, resC] = await Promise.all([taskAPromise, taskCPromise]);
    clearTimeout(timer);

    assert.equal(resA.value, "resA");
    assert.equal(resC.value, "resC");
    assert.equal(taskBCalls, 0);
    assert.equal(taskCCalls, 1);
    assert.equal(getEventListeners(ctrlB.signal, "abort").length, 0);

    // Queue recovered and locks are completely released
    assert.equal(runtime.removeOperation("queue-recovery-op"), true);
    await runtime.close();
  });

  it("prevents listener leaks by cleaning up signal abort listeners across all execution paths", async () => {
    const runtime = createAdaptiveRuntime({
      providers: [fixedProvider(10)],
      policy: policy(),
    });

    // 1. Normal completion
    const ctrlNormal = new AbortController();
    const resNormal = await runtime.run({
      operationId: "leak-test-normal",
      input: 1,
      strategies: basicStrategies(),
      signal: ctrlNormal.signal,
    });
    assert.equal(resNormal.value, "high:1");
    assert.equal(getEventListeners(ctrlNormal.signal, "abort").length, 0);

    // 2. Abort during in-flight strategy run
    const ctrlInFlight = new AbortController();
    let releaseStrategy: (() => void) | undefined;
    const hangingStrategy = strategy("hang", 1, () => {
      return new Promise<string>((resolve) => {
        releaseStrategy = () => resolve("done");
      });
    });
    const inFlightPromise = runtime.run({
      operationId: "leak-test-inflight",
      input: 1,
      strategies: [hangingStrategy],
      signal: ctrlInFlight.signal,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    ctrlInFlight.abort(new Error("abort during execution"));
    await assert.rejects(inFlightPromise, OperationAbortedError);
    releaseStrategy?.();
    assert.equal(getEventListeners(ctrlInFlight.signal, "abort").length, 0);

    // 3. Task failure (strategy throws error)
    const ctrlFailure = new AbortController();
    const failingStrategy = strategy("failing", 1, () => {
      throw new Error("strategy broke");
    });
    await assert.rejects(
      runtime.run({
        operationId: "leak-test-failing",
        input: 1,
        strategies: [failingStrategy],
        signal: ctrlFailure.signal,
      }),
      StrategyExecutionError,
    );
    assert.equal(getEventListeners(ctrlFailure.signal, "abort").length, 0);

    await runtime.close();
  });

  it("tracks strategy-level runtime statistics (StrategyStats) accurately across runs and failures", async () => {
    const clock = new FakeClock();
    const runtime = createAdaptiveRuntime({
      clock,
      providers: [fixedProvider(10)],
      policy: policy(),
    });

    // Verify initial stats for unexecuted operation
    const initialStats = runtime.getStats("strat-stats-op");
    assert.deepEqual(initialStats.strategies, {});
    assert.equal(initialStats.lastDurationMs, null);
    assert.equal(initialStats.averageDurationMs, null);

    const stratFast = strategy("strat-fast", 2, () => {
      clock.advance(20);
      return "fast-result";
    });
    const stratSlow = strategy("strat-slow", 1, () => {
      clock.advance(50);
      return "slow-result";
    });
    const stratFail = strategy("strat-fail", 2, () => {
      clock.advance(15);
      throw new Error("strat-fail explosion");
    });

    // Run 1: strat-fast succeeds with duration 20ms
    await runtime.run({
      operationId: "strat-stats-op",
      input: 1,
      strategies: [stratFast, stratSlow],
    });

    let stats = runtime.getStats("strat-stats-op");
    assert.equal(stats.runs, 1);
    assert.equal(stats.successes, 1);
    assert.equal(stats.failures, 0);
    assert.equal(stats.lastDurationMs, 20);
    assert.equal(stats.averageDurationMs, 20);
    assert.equal(stats.strategyRuns["strat-fast"], 1);

    const fastStats1 = stats.strategies["strat-fast"];
    assert.ok(fastStats1 !== undefined);
    assert.equal(fastStats1?.runs, 1);
    assert.equal(fastStats1?.successes, 1);
    assert.equal(fastStats1?.failures, 0);
    assert.equal(fastStats1?.lastDurationMs, 20);
    assert.equal(fastStats1?.averageDurationMs, 20);

    // Run 2: strat-fast succeeds with duration 40ms
    const fast40 = strategy("strat-fast", 2, () => {
      clock.advance(40);
      return "fast-40";
    });
    await runtime.run({
      operationId: "strat-stats-op",
      input: 2,
      strategies: [fast40, stratSlow],
    });

    stats = runtime.getStats("strat-stats-op");
    assert.equal(stats.runs, 2);
    assert.equal(stats.successes, 2);
    assert.equal(stats.lastDurationMs, 40);
    assert.equal(stats.averageDurationMs, 30); // (20 + 40) / 2 = 30

    const fastStats2 = stats.strategies["strat-fast"];
    assert.equal(fastStats2?.runs, 2);
    assert.equal(fastStats2?.successes, 2);
    assert.equal(fastStats2?.failures, 0);
    assert.equal(fastStats2?.lastDurationMs, 40);
    assert.equal(fastStats2?.averageDurationMs, 30);

    // Run 3: strat-slow pinned, succeeds with duration 50ms
    runtime.pinStrategy("strat-stats-op", "strat-slow");
    await runtime.run({
      operationId: "strat-stats-op",
      input: 3,
      strategies: [stratFast, stratSlow],
    });

    stats = runtime.getStats("strat-stats-op");
    assert.equal(stats.runs, 3);
    assert.equal(stats.strategyRuns["strat-slow"], 1);

    const slowStats = stats.strategies["strat-slow"];
    assert.ok(slowStats !== undefined);
    assert.equal(slowStats?.runs, 1);
    assert.equal(slowStats?.successes, 1);
    assert.equal(slowStats?.failures, 0);
    assert.equal(slowStats?.lastDurationMs, 50);
    assert.equal(slowStats?.averageDurationMs, 50);

    // Run 4: strat-fail pinned, throws after 15ms
    runtime.pinStrategy("strat-stats-op", "strat-fail");
    await assert.rejects(
      runtime.run({
        operationId: "strat-stats-op",
        input: 4,
        strategies: [stratFast, stratFail],
      }),
      StrategyExecutionError,
    );

    stats = runtime.getStats("strat-stats-op");
    assert.equal(stats.runs, 4);
    assert.equal(stats.successes, 3);
    assert.equal(stats.failures, 1);

    const failStats = stats.strategies["strat-fail"];
    assert.ok(failStats !== undefined);
    assert.equal(failStats?.runs, 1);
    assert.equal(failStats?.successes, 0);
    assert.equal(failStats?.failures, 1);
    assert.equal(failStats?.lastDurationMs, 15);
    assert.equal(failStats?.averageDurationMs, 15);

    // Reset stats for this operation
    runtime.resetStats("strat-stats-op");
    const resetStats = runtime.getStats("strat-stats-op");
    assert.equal(resetStats.runs, 0);
    assert.equal(resetStats.successes, 0);
    assert.equal(resetStats.failures, 0);
    assert.equal(resetStats.lastDurationMs, null);
    assert.equal(resetStats.averageDurationMs, null);
    assert.deepEqual(resetStats.strategyRuns, {});
    assert.deepEqual(resetStats.strategies, {});

    await runtime.close();
  });

  it("handles 0ms and sub-millisecond durations cleanly without NaN or null coercion", async () => {
    const clock = new FakeClock();
    const runtime = createAdaptiveRuntime({
      clock,
      providers: [fixedProvider(10)],
      policy: policy(),
    });

    const instantStrategy = strategy("instant", 1, () => "instant-val");

    // Run 1: duration is 0ms
    await runtime.run({
      operationId: "zero-ms-op",
      input: 1,
      strategies: [instantStrategy],
    });

    let stats = runtime.getStats("zero-ms-op");
    assert.equal(stats.lastDurationMs, 0);
    assert.equal(stats.averageDurationMs, 0);
    assert.equal(stats.strategies.instant?.lastDurationMs, 0);
    assert.equal(stats.strategies.instant?.averageDurationMs, 0);
    assert.equal(Number.isNaN(stats.averageDurationMs), false);
    assert.equal(Number.isNaN(stats.strategies.instant?.averageDurationMs), false);

    // Run 2: duration is 0ms again
    await runtime.run({
      operationId: "zero-ms-op",
      input: 2,
      strategies: [instantStrategy],
    });

    stats = runtime.getStats("zero-ms-op");
    assert.equal(stats.lastDurationMs, 0);
    assert.equal(stats.averageDurationMs, 0);
    assert.equal(stats.strategies.instant?.averageDurationMs, 0);

    // Run 3: duration is 10ms
    const timedStrategy = strategy("instant", 1, () => {
      clock.advance(10);
      return "timed-val";
    });
    await runtime.run({
      operationId: "zero-ms-op",
      input: 3,
      strategies: [timedStrategy],
    });

    stats = runtime.getStats("zero-ms-op");
    assert.equal(stats.lastDurationMs, 10);
    // (0 + 0 + 10) / 3 = 3.3333333333333335
    assert.ok(Math.abs((stats.averageDurationMs ?? 0) - 10 / 3) < 1e-9);
    assert.ok(Math.abs((stats.strategies.instant?.averageDurationMs ?? 0) - 10 / 3) < 1e-9);

    await runtime.close();
  });

  it("records operation failure without strategy stats when selection fails before strategy execution", async () => {
    const runtime = createAdaptiveRuntime({
      providers: [fixedProvider(10)],
      policy: policy({ minQualityTier: 5 }),
    });

    // Ineligible strategy (qualityTier 1 < minQualityTier 5)
    await assert.rejects(
      runtime.run({
        operationId: "no-selection-op",
        input: 1,
        strategies: [strategy("low", 1, () => "low")],
      }),
      NoEligibleStrategyError,
    );

    const stats = runtime.getStats("no-selection-op");
    assert.equal(stats.runs, 1);
    assert.equal(stats.failures, 1);
    assert.equal(stats.successes, 0);
    assert.deepEqual(stats.strategyRuns, {});
    assert.deepEqual(stats.strategies, {});

    await runtime.close();
  });

  it("modifies candidate evaluation (minQualityTier, maxQualityTier, budgets, customSelector, qualityCheck) via setOperationPolicy", async () => {
    const clock = new FakeClock();
    const runtime = createAdaptiveRuntime({
      clock,
      providers: [fixedProvider(150)], // SIGNAL = 150
      policy: policy({
        minQualityTier: 1,
        maxQualityTier: 5,
        qualityCheck: "report",
        budgets: [],
      }),
    });

    const low = strategy("strat-low", 1, () => "val-low");
    const mid = strategy("strat-mid", 2, () => "val-mid");
    const high = strategy("strat-high", 3, () => "val-high", {
      checkQuality: () => ({ ok: false, detail: "quality check failed" }),
    });
    const allStrategies = [low, mid, high];

    // 1. Without override: selects highest applicable tier (strat-high, tier 3)
    const defResult = await runtime.run({
      operationId: "op-default",
      input: 1,
      strategies: allStrategies,
    });
    assert.equal(defResult.metadata.strategyId, "strat-high");
    assert.equal(defResult.metadata.quality.status, "failed");

    // 2. Override maxQualityTier: cap at tier 2
    runtime.setOperationPolicy("op-capped", { maxQualityTier: 2 });
    const cappedResult = await runtime.run({
      operationId: "op-capped",
      input: 2,
      strategies: allStrategies,
    });
    assert.equal(cappedResult.metadata.strategyId, "strat-mid");
    assert.equal(cappedResult.metadata.qualityTier, 2);

    // 3. Override minQualityTier: floor at tier 3 (should fail when only low and mid provided)
    runtime.setOperationPolicy("op-floored", { minQualityTier: 3 });
    await assert.rejects(
      runtime.run({
        operationId: "op-floored",
        input: 3,
        strategies: [low, mid],
      }),
      NoEligibleStrategyError,
    );

    // 4. Override budgets: custom budget engaged reduces tier from 3 to 2
    runtime.setOperationPolicy("op-custom-budget", {
      budgets: [
        {
          id: "custom-pressure",
          signal: SIGNAL,
          limit: 100,
          recoverBelow: 50,
          tierReduction: 1,
          consecutiveSamples: 1,
        },
      ],
    });
    const budgetResult = await runtime.run({
      operationId: "op-custom-budget",
      input: 4,
      strategies: allStrategies,
    });
    assert.equal(budgetResult.metadata.strategyId, "strat-mid");
    assert.equal(budgetResult.metadata.decision.budgets[0]?.engaged, true);

    // 5. Override customSelector: selects custom candidate and records reason
    runtime.setOperationPolicy("op-custom-selector", {
      customSelector: (_ctx) => ({
        strategyId: "strat-low",
        reason: "picked-by-custom-hook",
      }),
    });
    const selectorResult = await runtime.run({
      operationId: "op-custom-selector",
      input: 5,
      strategies: allStrategies,
    });
    assert.equal(selectorResult.metadata.strategyId, "strat-low");
    assert.ok(
      selectorResult.metadata.decision.reasons.some(
        (r) => r.code === "custom-selector" && r.detail === "picked-by-custom-hook",
      ),
    );

    // 6. Override qualityCheck: "error" fails the run on checkQuality rejection
    runtime.setOperationPolicy("op-quality-error", {
      qualityCheck: "error",
    });
    await assert.rejects(
      runtime.run({
        operationId: "op-quality-error",
        input: 6,
        strategies: allStrategies,
      }),
      QualityCheckError,
    );

    await runtime.close();
  });

  it("evaluates strictly in precedence order: pinStrategy > setAdaptationEnabled > operationPolicy > globalPolicy", async () => {
    const clock = new FakeClock();
    // Global policy: maxQualityTier is 1, adaptationEnabled is true, budget engaged
    const runtime = createAdaptiveRuntime({
      clock,
      providers: [fixedProvider(200)],
      policy: policy({
        maxQualityTier: 1,
        adaptationEnabled: true,
        budgets: [
          {
            id: "global-press",
            signal: SIGNAL,
            limit: 100,
            recoverBelow: 50,
            tierReduction: 1,
            consecutiveSamples: 1,
          },
        ],
      }),
    });

    const economy = strategy("economy", 1, () => "val-economy");
    const high = strategy("high", 2, () => "val-high");
    const strategies = [economy, high];

    // Level 3 (operationPolicy) > Level 4 (globalPolicy):
    // operationPolicy raises maxQualityTier to 2 and clears budgets
    runtime.setOperationPolicy("prio-op", { maxQualityTier: 2, budgets: [] });
    const opPolicyResult = await runtime.run({
      operationId: "prio-op",
      input: 1,
      strategies,
    });
    assert.equal(opPolicyResult.metadata.strategyId, "high");

    // Level 2 (setAdaptationEnabled) > Level 3 (operationPolicy):
    // operationPolicy has budgets and adaptationEnabled: true
    runtime.setOperationPolicy("prio-adapt", {
      maxQualityTier: 2,
      adaptationEnabled: true,
      budgets: [
        {
          id: "op-press",
          signal: SIGNAL,
          limit: 100,
          recoverBelow: 50,
          tierReduction: 1,
          consecutiveSamples: 1,
        },
      ],
    });
    // Explicitly disable adaptation via setAdaptationEnabled
    runtime.setAdaptationEnabled("prio-adapt", false);
    const adaptDisabledResult = await runtime.run({
      operationId: "prio-adapt",
      input: 2,
      strategies,
    });
    // Adaptation is disabled, so budget reduction does NOT apply; selects high
    assert.equal(adaptDisabledResult.metadata.strategyId, "high");

    // Conversely, operationPolicy has adaptationEnabled: false, but setAdaptationEnabled sets true
    runtime.setOperationPolicy("prio-adapt-true", {
      maxQualityTier: 2,
      adaptationEnabled: false,
      budgets: [
        {
          id: "op-press-2",
          signal: SIGNAL,
          limit: 100,
          recoverBelow: 50,
          tierReduction: 1,
          consecutiveSamples: 1,
        },
      ],
    });
    runtime.setAdaptationEnabled("prio-adapt-true", true);
    const adaptEnabledResult = await runtime.run({
      operationId: "prio-adapt-true",
      input: 3,
      strategies,
    });
    // Adaptation is enabled by override, so budget reduces tier 2 -> 1, selecting economy
    assert.equal(adaptEnabledResult.metadata.strategyId, "economy");

    // Level 1 (pinStrategy) > Level 2, 3, 4:
    // Even with operationPolicy maxQualityTier: 1 and adaptation enabled, pinStrategy bypasses everything
    runtime.setOperationPolicy("prio-pin", { maxQualityTier: 1, adaptationEnabled: true });
    runtime.setAdaptationEnabled("prio-pin", true);
    runtime.pinStrategy("prio-pin", "high");
    const pinResult = await runtime.run({
      operationId: "prio-pin",
      input: 4,
      strategies,
    });
    assert.equal(pinResult.metadata.strategyId, "high");
    assert.equal(pinResult.metadata.decision.kind, "pinned");

    await runtime.close();
  });

  it("restores global policy when setOperationPolicy is passed null", async () => {
    const clock = new FakeClock();
    const runtime = createAdaptiveRuntime({
      clock,
      providers: [fixedProvider(10)],
      policy: policy({ maxQualityTier: 2 }),
    });

    const low = strategy("strat-low", 1, () => "low");
    const high = strategy("strat-high", 2, () => "high");
    const strategies = [low, high];

    // Set override capping at tier 1
    runtime.setOperationPolicy("op-null-test", { maxQualityTier: 1 });
    const overridden = await runtime.run({
      operationId: "op-null-test",
      input: 1,
      strategies,
    });
    assert.equal(overridden.metadata.strategyId, "strat-low");

    // Remove override with null
    runtime.setOperationPolicy("op-null-test", null);
    const restored = await runtime.run({
      operationId: "op-null-test",
      input: 2,
      strategies,
    });
    assert.equal(restored.metadata.strategyId, "strat-high");

    await runtime.close();
  });

  it("validates operationId and policy input in setOperationPolicy", async () => {
    const runtime = createAdaptiveRuntime({
      policy: policy({ minQualityTier: 1, maxQualityTier: 4 }),
    });

    // Invalid operationIds
    assert.throws(() => runtime.setOperationPolicy("", null), ConfigurationError);
    assert.throws(() => runtime.setOperationPolicy("   ", null), ConfigurationError);
    assert.throws(
      () => runtime.setOperationPolicy(null as unknown as string, null),
      ConfigurationError,
    );
    assert.throws(
      () => runtime.setOperationPolicy(123 as unknown as string, null),
      ConfigurationError,
    );

    // Invalid policy inputs (non-object, array)
    assert.throws(
      () => runtime.setOperationPolicy("op", undefined as unknown as Partial<Policy>),
      ConfigurationError,
    );
    assert.throws(
      () => runtime.setOperationPolicy("op", "bad-policy" as unknown as Partial<Policy>),
      ConfigurationError,
    );
    assert.throws(
      () => runtime.setOperationPolicy("op", 42 as unknown as Partial<Policy>),
      ConfigurationError,
    );
    assert.throws(
      () => runtime.setOperationPolicy("op", [] as unknown as Partial<Policy>),
      ConfigurationError,
    );

    // Contradictory / invalid policy fields
    assert.throws(
      () => runtime.setOperationPolicy("op", { minQualityTier: 5, maxQualityTier: 2 }),
      ConfigurationError,
    );
    assert.throws(
      () => runtime.setOperationPolicy("op", { minQualityTier: Number.NaN }),
      ConfigurationError,
    );
    assert.throws(
      () => runtime.setOperationPolicy("op", { minQualityTier: Number.POSITIVE_INFINITY }),
      ConfigurationError,
    );
    assert.throws(
      () => runtime.setOperationPolicy("op", { customSelector: "not-a-func" as unknown as never }),
      ConfigurationError,
    );
    assert.throws(
      () => runtime.setOperationPolicy("op", { budgets: "not-an-array" as unknown as never }),
      ConfigurationError,
    );
    assert.throws(
      () => runtime.setOperationPolicy("op", { missingSignalBehavior: "bad" as unknown as never }),
      ConfigurationError,
    );
    assert.throws(
      () => runtime.setOperationPolicy("op", { missingSignalBehavior: "fallback" }),
      ConfigurationError,
    );
    assert.throws(
      () => runtime.setOperationPolicy("op", { maxSignalAgeMs: 0 }),
      ConfigurationError,
    );
    assert.throws(
      () => runtime.setOperationPolicy("op", { consecutiveSamples: 0 }),
      ConfigurationError,
    );

    // Closed runtime throws RuntimeClosedError
    await runtime.close();
    assert.throws(() => runtime.setOperationPolicy("op", null), RuntimeClosedError);
    assert.throws(
      () => runtime.setOperationPolicy("op", { maxQualityTier: 1 }),
      RuntimeClosedError,
    );
  });

  it("evicts unpinned operation policy under maxTrackedOperations LRU bound and supports removeOperation", async () => {
    const clock = new FakeClock();
    const runtime = createAdaptiveRuntime({
      clock,
      providers: [fixedProvider(10)],
      policy: policy({ maxTrackedOperations: 2, maxQualityTier: 2 }),
    });

    const low = strategy("low", 1, () => "low");
    const high = strategy("high", 2, () => "high");
    const strategies = [low, high];

    // Set operation policies on 3 operations with maxTrackedOperations = 2
    runtime.setOperationPolicy("lru-op-1", { maxQualityTier: 1 });
    runtime.setOperationPolicy("lru-op-2", { maxQualityTier: 1 });
    runtime.setOperationPolicy("lru-op-3", { maxQualityTier: 1 });

    // lru-op-1 is the oldest unpinned and non-executing, so it was evicted
    const res1 = await runtime.run({
      operationId: "lru-op-1",
      input: 1,
      strategies,
    });
    // Since lru-op-1's override was evicted, it falls back to global policy (maxQualityTier 2 -> high)
    assert.equal(res1.metadata.strategyId, "high");

    // lru-op-3 was recently set, so its override is active (maxQualityTier 1 -> low)
    const res3 = await runtime.run({
      operationId: "lru-op-3",
      input: 2,
      strategies,
    });
    assert.equal(res3.metadata.strategyId, "low");

    // Pinned operation with operation policy is NOT evicted
    runtime.pinStrategy("pinned-op", "high");
    runtime.setOperationPolicy("pinned-op", { maxQualityTier: 2 });
    runtime.setOperationPolicy("unpinned-op", { maxQualityTier: 1 });
    runtime.setOperationPolicy("unpinned-op-2", { maxQualityTier: 1 });
    // pinned-op survives despite capacity pressure
    const pinnedRes = await runtime.run({
      operationId: "pinned-op",
      input: 3,
      strategies,
    });
    assert.equal(pinnedRes.metadata.strategyId, "high");

    // removeOperation removes operation policy and returns true
    runtime.setOperationPolicy("op-to-remove", { maxQualityTier: 1 });
    assert.equal(runtime.removeOperation("op-to-remove"), true);
    assert.equal(runtime.removeOperation("op-to-remove"), false);

    // After removal, global policy is used
    const removedRes = await runtime.run({
      operationId: "op-to-remove",
      input: 4,
      strategies,
    });
    assert.equal(removedRes.metadata.strategyId, "high");

    await runtime.close();
  });

  it("covers all branch paths in resolveOperationPolicy", () => {
    const base = resolvePolicy({
      evaluationIntervalMs: 500,
      maxSignalAgeMs: 2000,
      minimumModeDurationMs: 100,
      consecutiveSamples: 3,
      minQualityTier: 1,
      maxQualityTier: 5,
      fallbackStrategyId: "base-fallback",
      missingSignalBehavior: "fallback",
      adaptationEnabled: false,
      qualityCheck: "error",
      maxTrackedOperations: 50,
      customSelector: () => "base-choice",
      budgets: [
        {
          id: "base-b1",
          signal: "base.sig",
          limit: 10,
          recoverBelow: 5,
          tierReduction: 2,
          consecutiveSamples: 2,
        },
      ],
    });

    // 1. Empty override: inherits all base properties
    const inherited = resolveOperationPolicy(base, {});
    assert.equal(inherited.evaluationIntervalMs, 500);
    assert.equal(inherited.maxSignalAgeMs, 2000);
    assert.equal(inherited.minimumModeDurationMs, 100);
    assert.equal(inherited.consecutiveSamples, 3);
    assert.equal(inherited.minQualityTier, 1);
    assert.equal(inherited.maxQualityTier, 5);
    assert.equal(inherited.fallbackStrategyId, "base-fallback");
    assert.equal(inherited.missingSignalBehavior, "fallback");
    assert.equal(inherited.adaptationEnabled, false);
    assert.equal(inherited.qualityCheck, "error");
    assert.equal(inherited.maxTrackedOperations, 50);
    assert.ok(inherited.customSelector !== null);
    assert.equal(inherited.budgets.length, 1);
    assert.equal(inherited.budgets[0]?.id, "base-b1");

    // 2. Full override: overrides every property
    const fullOverride = resolveOperationPolicy(base, {
      evaluationIntervalMs: 200,
      maxSignalAgeMs: 1000,
      minimumModeDurationMs: 50,
      consecutiveSamples: 4,
      minQualityTier: 2,
      maxQualityTier: 4,
      fallbackStrategyId: "override-fallback",
      missingSignalBehavior: "hold",
      adaptationEnabled: true,
      qualityCheck: "report",
      maxTrackedOperations: 20,
      customSelector: () => "override-choice",
      budgets: [
        {
          id: "override-b1",
          signal: "override.sig",
          limit: 20,
        },
      ],
    });
    assert.equal(fullOverride.evaluationIntervalMs, 200);
    assert.equal(fullOverride.maxSignalAgeMs, 1000);
    assert.equal(fullOverride.minimumModeDurationMs, 50);
    assert.equal(fullOverride.consecutiveSamples, 4);
    assert.equal(fullOverride.minQualityTier, 2);
    assert.equal(fullOverride.maxQualityTier, 4);
    assert.equal(fullOverride.fallbackStrategyId, "override-fallback");
    assert.equal(fullOverride.missingSignalBehavior, "hold");
    assert.equal(fullOverride.adaptationEnabled, true);
    assert.equal(fullOverride.qualityCheck, "report");
    assert.equal(fullOverride.maxTrackedOperations, 20);
    assert.equal(fullOverride.budgets.length, 1);
    assert.equal(fullOverride.budgets[0]?.id, "override-b1");

    // 3. Base without customSelector (null), override also without customSelector
    const baseNoSelector = resolvePolicy({});
    const inheritedNoSelector = resolveOperationPolicy(baseNoSelector, {});
    assert.equal(inheritedNoSelector.customSelector, null);

    // 4. Invalid input validation
    assert.throws(
      () => resolveOperationPolicy(base, null as unknown as Partial<Policy>),
      ConfigurationError,
    );
    assert.throws(
      () => resolveOperationPolicy(base, "not-obj" as unknown as Partial<Policy>),
      ConfigurationError,
    );
    assert.throws(
      () => resolveOperationPolicy(base, [] as unknown as Partial<Policy>),
      ConfigurationError,
    );
  });

  it("queries in-flight operation status during selection, execution, after completion, after abort, and rejects invalid IDs", async () => {
    function deferred<T = void>() {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    const selectGate = deferred<void>();
    const execGate = deferred<void>();

    const slowProvider = new FunctionSignalProvider({
      id: "select-gate-provider",
      signalName: "test.select",
      unit: "count",
      read: async (context) => {
        await selectGate.promise;
        return [
          {
            name: "test.select",
            unit: "count",
            status: "ok",
            value: 1,
            observedAt: context.now,
          },
        ];
      },
    });

    const runtime = createAdaptiveRuntime({
      providers: [slowProvider],
      policy: { evaluationIntervalMs: 0 },
    });

    // 1. Initial state: nothing in-flight
    assert.equal(runtime.hasInFlight("op-flight-test"), false);
    assert.equal(runtime.hasInFlight(), false);
    assert.deepEqual(runtime.getActiveOperations(), []);

    const runPromise = runtime.run({
      operationId: "op-flight-test",
      input: 1,
      strategies: [
        strategy("async-flight", 1, async () => {
          await execGate.promise;
          return "done";
        }),
      ],
    });

    // 2. Selection phase: selection lock held while provider read is pending
    await Promise.resolve();
    assert.equal(runtime.hasInFlight("op-flight-test"), true);
    assert.equal(runtime.hasInFlight(), true);
    assert.deepEqual(runtime.getActiveOperations(), ["op-flight-test"]);

    // Selection lock released, entering strategy execution phase
    selectGate.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // 3. Execution phase: activeRuns > 0 while strategy is running
    assert.equal(runtime.hasInFlight("op-flight-test"), true);
    assert.equal(runtime.hasInFlight(), true);
    assert.deepEqual(runtime.getActiveOperations(), ["op-flight-test"]);

    // 4. Completion phase: active runs decremented and cleared
    execGate.resolve();
    const result = await runPromise;
    assert.equal(result.value, "done");
    assert.equal(runtime.hasInFlight("op-flight-test"), false);
    assert.equal(runtime.hasInFlight(), false);
    assert.deepEqual(runtime.getActiveOperations(), []);

    // 5. Aborted run phase
    const abortController = new AbortController();
    const abortGate = deferred<void>();
    const abortPromise = runtime.run({
      operationId: "op-abort-test",
      input: 1,
      signal: abortController.signal,
      strategies: [
        strategy("abort-strat", 1, async ({ signal }) => {
          abortGate.resolve();
          return new Promise<string>((_, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(new OperationAbortedError("op-abort-test", signal.reason)),
              { once: true },
            );
          });
        }),
      ],
    });

    await abortGate.promise;
    assert.equal(runtime.hasInFlight("op-abort-test"), true);
    assert.equal(runtime.hasInFlight(), true);

    abortController.abort(new Error("aborted-by-caller"));
    await assert.rejects(abortPromise, OperationAbortedError);
    assert.equal(runtime.hasInFlight("op-abort-test"), false);
    assert.equal(runtime.hasInFlight(), false);

    // 6. Invalid operationId inputs
    for (const invalid of ["", "   ", null, 456, true, {}, []]) {
      assert.throws(() => runtime.hasInFlight(invalid as unknown as string), ConfigurationError);
    }

    // 7. Non-disturbing: verify LRU tracking is not refreshed
    runtime.setOperationPolicy("tenant-1", { minQualityTier: 1 });
    runtime.setOperationPolicy("tenant-2", { minQualityTier: 1 });
    const trackedOrder = runtime.getTrackedOperations();
    assert.deepEqual(trackedOrder, ["op-flight-test", "op-abort-test", "tenant-1", "tenant-2"]);

    runtime.hasInFlight("tenant-1");
    runtime.hasInFlight("op-flight-test");
    runtime.hasInFlight();
    runtime.getActiveOperations();
    assert.deepEqual(runtime.getTrackedOperations(), trackedOrder);

    // 8. Remains usable after close()
    await runtime.close();
    assert.equal(runtime.hasInFlight("tenant-1"), false);
    assert.equal(runtime.hasInFlight(), false);
    assert.deepEqual(runtime.getActiveOperations(), []);
  });

  it("introspects active operations across concurrent runs with code-unit sorting and immutability", async () => {
    function deferred<T = void>() {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    const runtime = createAdaptiveRuntime();
    const barrier = deferred<void>();

    const makePendingStrategy = (id: string): Strategy<number, string> =>
      strategy(`s-${id}`, 1, async () => {
        await barrier.promise;
        return id;
      });

    // Run multiple operations concurrently
    const pZ = runtime.run({
      operationId: "tenant-z",
      input: 1,
      strategies: [makePendingStrategy("z")],
    });
    const p10 = runtime.run({
      operationId: "tenant-10",
      input: 1,
      strategies: [makePendingStrategy("10")],
    });
    const pA = runtime.run({
      operationId: "tenant-a",
      input: 1,
      strategies: [makePendingStrategy("a")],
    });
    const p2 = runtime.run({
      operationId: "tenant-2",
      input: 1,
      strategies: [makePendingStrategy("2")],
    });
    const pADup = runtime.run({
      operationId: "tenant-a",
      input: 2,
      strategies: [makePendingStrategy("a-dup")],
    });

    await Promise.resolve();

    const active = runtime.getActiveOperations();
    assert.ok(Object.isFrozen(active));
    // Unique and code-unit ascending sorted: "tenant-10" < "tenant-2" < "tenant-a" < "tenant-z"
    assert.deepEqual(active, ["tenant-10", "tenant-2", "tenant-a", "tenant-z"]);

    barrier.resolve();
    await Promise.all([pZ, p10, pA, p2, pADup]);

    const activePost = runtime.getActiveOperations();
    assert.deepEqual(activePost, []);
    assert.ok(Object.isFrozen(activePost));

    await runtime.close();
    assert.deepEqual(runtime.getActiveOperations(), []);
  });

  it("prunes idle unpinned operations in code-unit order while preserving active and pinned operations", async () => {
    function deferred<T = void>() {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    const runtime = createAdaptiveRuntime();
    const holdGate = deferred<void>();

    const syncStrat = (name: string): Strategy<number, string> =>
      strategy(`strat-${name}`, 1, () => name);

    // Setup completed unpinned operations
    await runtime.run({ operationId: "op-idle-beta", input: 1, strategies: [syncStrat("b")] });
    await runtime.run({ operationId: "op-idle-alpha", input: 1, strategies: [syncStrat("a")] });
    // Setup pinned operation
    await runtime.run({ operationId: "op-pinned", input: 1, strategies: [syncStrat("p")] });
    runtime.pinStrategy("op-pinned", "strat-p");

    // Setup active in-flight operation
    const activeRun = runtime.run({
      operationId: "op-active",
      input: 1,
      strategies: [
        strategy("active-s", 1, async () => {
          await holdGate.promise;
          return "active-done";
        }),
      ],
    });

    await Promise.resolve();
    assert.equal(runtime.hasInFlight("op-active"), true);

    // Prune: only completed unpinned operations should be removed
    const pruned = runtime.pruneIdleOperations();
    assert.ok(Object.isFrozen(pruned));
    // Deterministically code-unit sorted
    assert.deepEqual(pruned, ["op-idle-alpha", "op-idle-beta"]);

    // Active and pinned operations remain tracked
    const tracked = runtime.getTrackedOperations();
    assert.ok(tracked.includes("op-pinned"));
    assert.ok(tracked.includes("op-active"));
    assert.ok(!tracked.includes("op-idle-alpha"));
    assert.ok(!tracked.includes("op-idle-beta"));

    // Complete the active run and prune again
    holdGate.resolve();
    await activeRun;
    assert.equal(runtime.hasInFlight("op-active"), false);

    const prunedSecond = runtime.pruneIdleOperations();
    assert.ok(Object.isFrozen(prunedSecond));
    assert.deepEqual(prunedSecond, ["op-active"]);
    assert.deepEqual(runtime.getTrackedOperations(), ["op-pinned"]);

    // Calling pruneIdleOperations when no idle operations exist returns empty frozen array
    const prunedThird = runtime.pruneIdleOperations();
    assert.deepEqual(prunedThird, []);
    assert.ok(Object.isFrozen(prunedThird));

    // Test pruning after close()
    await runtime.run({ operationId: "op-close-test", input: 1, strategies: [syncStrat("c")] });
    assert.ok(runtime.getTrackedOperations().includes("op-close-test"));

    await runtime.close();
    // Must not throw RuntimeClosedError
    const prunedPostClose = runtime.pruneIdleOperations();
    assert.ok(Object.isFrozen(prunedPostClose));
    assert.deepEqual(prunedPostClose, ["op-close-test"]);
    assert.deepEqual(runtime.getTrackedOperations(), ["op-pinned"]);
  });
});

describe("operation validation", () => {
  const strategies = basicStrategies();

  it("rejects malformed operation containers, signals, and timeouts", () => {
    assert.throws(() => validateOperation(null), ConfigurationError);
    assert.throws(
      () =>
        validateOperation({
          operationId: "bad-signal",
          input: 1,
          strategies,
          signal: null as unknown as AbortSignal,
        }),
      ConfigurationError,
    );
    assert.throws(
      () =>
        validateOperation({
          operationId: "bad-signal",
          input: 1,
          strategies,
          signal: {} as AbortSignal,
        }),
      ConfigurationError,
    );
    assert.throws(
      () =>
        validateOperation({
          operationId: "bad-timeout",
          input: 1,
          strategies,
          timeoutMs: Number.NaN,
        }),
      ConfigurationError,
    );
    assert.throws(
      () =>
        validateOperation({
          operationId: "bad-timeout",
          input: 1,
          strategies,
          timeoutMs: -1,
        }),
      ConfigurationError,
    );
  });

  it("covers identifier, signal, timeout, and provider-timeout helpers", () => {
    assert.equal(validateOperationId("  trimmed  "), "trimmed");
    assert.throws(() => validateOperationId("   "), ConfigurationError);
    assert.throws(() => validateOperationId(42), ConfigurationError);
    assert.equal(validateOptionalAbortSignal(undefined), undefined);
    assert.equal(validateTimeout(undefined), undefined);
    assert.equal(validateTimeout(5), 5);
    assert.throws(() => validateTimeout(0), ConfigurationError);
    assert.equal(validateProviderTimeout(undefined), 1000);
    assert.equal(validateProviderTimeout(0), 0);
    assert.throws(() => validateProviderTimeout(-1), ConfigurationError);
    assert.throws(() => validateProviderTimeout(Number.POSITIVE_INFINITY), ConfigurationError);
  });

  it("rejects malformed strategy declarations", () => {
    assert.throws(() => validateStrategies("not-an-array"), ConfigurationError);
    assert.throws(() => validateStrategies([]), ConfigurationError);
    assert.throws(() => validateStrategies([null]), ConfigurationError);
    assert.throws(
      () => validateStrategies([strategy("dup", 1, () => ""), strategy("dup", 2, () => "")]),
      ConfigurationError,
    );
    assert.throws(() => validateStrategies([{ id: "no-run", qualityTier: 1 }]), ConfigurationError);
    assert.throws(
      () =>
        validateStrategies([
          { id: "bad-cost", qualityTier: 1, costTier: Number.NaN, run: () => "" },
        ]),
      ConfigurationError,
    );
    assert.throws(
      () =>
        validateStrategies([
          { id: "bad-quality", qualityTier: 1, checkQuality: "no" as never, run: () => "" },
        ]),
      ConfigurationError,
    );
    assert.throws(
      () =>
        validateStrategies([
          { id: "bad-applicability", qualityTier: 1, isApplicable: "no" as never, run: () => "" },
        ]),
      ConfigurationError,
    );
  });

  it("rejects malformed runtime construction options", () => {
    assert.throws(() => createAdaptiveRuntime({ clock: {} as never }), ConfigurationError);
    assert.throws(() => createAdaptiveRuntime({ providers: {} as never }), ConfigurationError);
    assert.throws(
      () => createAdaptiveRuntime({ policy: { maxTrackedOperations: 0 } }),
      ConfigurationError,
    );
    assert.throws(() => createAdaptiveRuntime(null as never), ConfigurationError);
  });

  it("normalizes and truncates error messages safely", () => {
    assert.equal(errorMessage(new Error("short")), "short");
    assert.equal(errorMessage("plain"), "plain");
    const truncated = errorMessage("x".repeat(1001));
    assert.equal(truncated.length, 1001);
    assert.ok(truncated.endsWith("…"));

    const original = new Error("kept");
    assert.equal(toError(original), original);
    assert.equal(toError("converted").message, "converted");
  });

  describe("waitForIdle graceful drain", () => {
    it("returns true immediately when already idle", async () => {
      const runtime = createAdaptiveRuntime();
      assert.equal(await runtime.waitForIdle(), true);
      assert.equal(await runtime.waitForIdle({ operationId: "any-op" }), true);
      await runtime.close();
    });

    it("waits for concurrent runs and resolves true once settled", async () => {
      const clock = new FakeClock();
      const runtime = createAdaptiveRuntime({ clock, providers: [fixedProvider(10)] });
      let finishRun: () => void = () => {};
      const runGate = new Promise<void>((r) => {
        finishRun = r;
      });

      const blockingStrat = strategy("high", 2, async () => {
        await runGate;
        return "ok";
      });

      const task = runtime.run({
        operationId: "drain-test",
        input: 1,
        strategies: [blockingStrat],
      });
      assert.equal(runtime.hasInFlight("drain-test"), true);

      let settled = false;
      const waiter = runtime.waitForIdle({ operationId: "drain-test" }).then((res) => {
        settled = true;
        return res;
      });

      await new Promise((r) => setImmediate(r));
      assert.equal(settled, false);

      finishRun();
      await task;
      const result = await waiter;
      assert.equal(result, true);
      assert.equal(settled, true);
      await runtime.close();
    });

    it("times out cooperatively and resolves false", async () => {
      const clock = new FakeClock();
      const runtime = createAdaptiveRuntime({ clock, providers: [fixedProvider(10)] });
      let finishRun: () => void = () => {};
      const runGate = new Promise<void>((r) => {
        finishRun = r;
      });

      const blockingStrat = strategy("high", 2, async () => {
        await runGate;
        return "ok";
      });

      const task = runtime.run({
        operationId: "drain-timeout",
        input: 1,
        strategies: [blockingStrat],
      });
      const waiter = runtime.waitForIdle({ timeoutMs: 100 });

      clock.advance(100);
      assert.equal(await waiter, false);

      finishRun();
      await task;
      await runtime.close();
    });

    it("handles abort signal cooperatively and resolves false", async () => {
      const clock = new FakeClock();
      const runtime = createAdaptiveRuntime({ clock, providers: [fixedProvider(10)] });
      let finishRun: () => void = () => {};
      const runGate = new Promise<void>((r) => {
        finishRun = r;
      });

      const blockingStrat = strategy("high", 2, async () => {
        await runGate;
        return "ok";
      });

      const task = runtime.run({
        operationId: "drain-abort",
        input: 1,
        strategies: [blockingStrat],
      });
      const controller = new AbortController();
      const waiter = runtime.waitForIdle({ signal: controller.signal });

      controller.abort();
      assert.equal(await waiter, false);

      finishRun();
      await task;
      await runtime.close();
    });

    it("rejects invalid options with ConfigurationError", async () => {
      const runtime = createAdaptiveRuntime();
      await assert.rejects(() => runtime.waitForIdle(123 as never), ConfigurationError);
      await assert.rejects(() => runtime.waitForIdle({ operationId: "   " }), ConfigurationError);
      await assert.rejects(() => runtime.waitForIdle({ timeoutMs: -1 }), ConfigurationError);
      await assert.rejects(
        () => runtime.waitForIdle({ signal: "not-a-signal" as never }),
        ConfigurationError,
      );
      await runtime.close();
    });
  });

  describe("getRuntimeHealth summary", () => {
    it("provides deep immutability and non-disturbing introspection", async () => {
      const runtime = createAdaptiveRuntime({ policy: { maxTrackedOperations: 10 } });
      runtime.pinStrategy("op-b", "economy");
      runtime.pinStrategy("op-a", "high");
      runtime.setAdaptationEnabled("op-c", false);

      const health = runtime.getRuntimeHealth();
      assert.equal(health.closed, false);
      assert.equal(health.maxTrackedOperations, 10);
      assert.equal(health.trackedOperationCount, 3);
      assert.deepEqual(health.pinnedOperations, ["op-a", "op-b"]);
      assert.deepEqual(health.adaptationDisabledOperations, ["op-c"]);

      assert.throws(() => {
        (health as unknown as { closed: boolean }).closed = true;
      });
      assert.throws(() => {
        (health.pinnedOperations as unknown as string[]).push("op-x");
      });

      await runtime.close();
      const closedHealth = runtime.getRuntimeHealth();
      assert.equal(closedHealth.closed, true);
    });
  });

  describe("importState merge modes", () => {
    it("supports merge mode with incoming, existing, and latest conflict resolution", async () => {
      const runtimeA = createAdaptiveRuntime();
      await runtimeA.run({ operationId: "op-1", input: 1, strategies: basicStrategies() });
      await runtimeA.run({ operationId: "op-2", input: 2, strategies: basicStrategies() });

      const runtimeB = createAdaptiveRuntime();
      await runtimeB.run({ operationId: "op-2", input: 20, strategies: basicStrategies() });
      await runtimeB.run({ operationId: "op-2", input: 21, strategies: basicStrategies() });
      await runtimeB.run({ operationId: "op-3", input: 30, strategies: basicStrategies() });

      const snapshotB = runtimeB.exportState();
      await runtimeB.close();

      // Test existing conflict resolution: op-2 is untouched, op-3 is added
      const runtimeExisting = createAdaptiveRuntime();
      runtimeExisting.importState(runtimeA.exportState());
      const countExisting = runtimeExisting.importState(snapshotB, {
        mode: "merge",
        conflictResolution: "existing",
      });
      assert.equal(countExisting, 1);
      assert.equal(runtimeExisting.getStats("op-2").runs, 1);
      assert.equal(runtimeExisting.getStats("op-3").runs, 1);
      await runtimeExisting.close();

      // Test incoming conflict resolution: op-2 is overwritten, op-3 is added
      const runtimeIncoming = createAdaptiveRuntime();
      runtimeIncoming.importState(runtimeA.exportState());
      const countIncoming = runtimeIncoming.importState(snapshotB, {
        mode: "merge",
        conflictResolution: "incoming",
      });
      assert.equal(countIncoming, 2);
      assert.equal(runtimeIncoming.getStats("op-2").runs, 2);
      assert.equal(runtimeIncoming.getStats("op-3").runs, 1);
      await runtimeIncoming.close();

      // Test latest conflict resolution
      const runtimeLatest = createAdaptiveRuntime();
      runtimeLatest.importState(runtimeA.exportState());
      const countLatest = runtimeLatest.importState(snapshotB, {
        mode: "merge",
        conflictResolution: "latest",
      });
      assert.equal(countLatest >= 1, true);
      await runtimeLatest.close();
      await runtimeA.close();
    });

    it("rejects invalid importState options", () => {
      const runtime = createAdaptiveRuntime();
      const snapshot = runtime.exportState();
      assert.throws(() => runtime.importState(snapshot, null as never), ConfigurationError);
      assert.throws(
        () => runtime.importState(snapshot, { mode: "bad" as never }),
        ConfigurationError,
      );
      assert.throws(
        () => runtime.importState(snapshot, { conflictResolution: "bad" as never }),
        ConfigurationError,
      );
    });
  });
});
