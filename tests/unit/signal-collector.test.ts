import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigurationError, RuntimeClosedError } from "../../src/errors/index.js";
import { CompositeSignalProvider } from "../../src/providers/composite.js";
import { SignalCollector } from "../../src/signals/collector.js";
import type {
  ResourceSignal,
  SignalProvider,
  SignalStartContext,
} from "../../src/types/signals.js";
import { FakeClock } from "../helpers/fake-clock.js";
import {
  FunctionSignalProvider,
  okSignal,
  requireOk,
  SequenceSignalProvider,
} from "../helpers/providers.js";

const PROVIDER_SIGNAL = "test.value";

function makeCollector(
  providers: readonly SignalProvider[],
  options: {
    evaluationIntervalMs?: number;
    providerTimeoutMs?: number;
    clock?: FakeClock;
    maxConsecutiveFailures?: number;
    failureCooldownMs?: number;
  } = {},
): {
  collector: SignalCollector;
  clock: FakeClock;
  errors: Array<{ providerId: string; error: Error }>;
} {
  const clock = options.clock ?? new FakeClock();
  const errors: Array<{ providerId: string; error: Error }> = [];
  const collector = new SignalCollector({
    providers,
    evaluationIntervalMs: options.evaluationIntervalMs ?? 1000,
    providerTimeoutMs: options.providerTimeoutMs ?? 1000,
    clock,
    onProviderError: (providerId, error) => errors.push({ providerId, error }),
    maxConsecutiveFailures: options.maxConsecutiveFailures,
    failureCooldownMs: options.failureCooldownMs,
  });
  return { collector, clock, errors };
}

describe("SignalCollector", () => {
  it("collects and caches snapshots according to evaluationIntervalMs", async () => {
    const provider = new SequenceSignalProvider({ values: [10, 20] });
    const { collector, clock } = makeCollector([provider], { evaluationIntervalMs: 1000 });

    const first = await collector.collect(clock.now(), new AbortController().signal);
    assert.equal(first.cached, false);
    assert.equal(first.coalesced, false);
    assert.equal(requireOk(first.readings[0]).value, 10);

    const second = await collector.collect(clock.now(), new AbortController().signal);
    assert.equal(second.cached, true);
    assert.equal(second.coalesced, false);
    assert.equal(second.sequence, first.sequence);
    assert.equal(requireOk(second.readings[0]).value, 10);

    clock.advance(1000);
    const third = await collector.collect(clock.now(), new AbortController().signal);
    assert.equal(third.cached, false);
    assert.equal(third.coalesced, false);
    assert.notEqual(third.sequence, first.sequence);
    assert.equal(requireOk(third.readings[0]).value, 20);
  });

  it("accepts a per-call evaluation interval and validates it", async () => {
    let reads = 0;
    const provider = new FunctionSignalProvider({
      id: "per-call",
      signalName: PROVIDER_SIGNAL,
      read: (context) => {
        reads += 1;
        return [okSignal(PROVIDER_SIGNAL, reads, context.now)];
      },
    });
    const { collector, clock } = makeCollector([provider], { evaluationIntervalMs: 10_000 });

    const first = await collector.collect(clock.now(), new AbortController().signal);
    assert.equal(first.cached, false);
    assert.equal(reads, 1);

    clock.advance(10);
    const second = await collector.collect(clock.now(), new AbortController().signal, 0);
    assert.equal(second.cached, false);
    assert.equal(reads, 2);

    const third = await collector.collect(clock.now(), new AbortController().signal, 10_000);
    assert.equal(third.cached, true);
    assert.equal(reads, 2);

    for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY, "0", null]) {
      await assert.rejects(
        () =>
          collector.collect(
            clock.now(),
            new AbortController().signal,
            invalid as unknown as number,
          ),
        ConfigurationError,
      );
    }

    await collector.close();
  });

  it("drains provider-isolated failures only on fresh reads and isolates broken drains", async () => {
    let drains = 0;
    let pending: Error[] = [];
    const provider: SignalProvider = {
      id: "draining",
      signals: [{ name: PROVIDER_SIGNAL, unit: "bytes" }],
      read: (context) => [okSignal(PROVIDER_SIGNAL, 1, context.now)],
      drainProviderErrors: () => {
        drains += 1;
        const errors = pending;
        pending = [];
        return errors;
      },
    };
    const { collector, clock, errors } = makeCollector([provider], {
      evaluationIntervalMs: 1000,
    });

    await collector.collect(clock.now(), new AbortController().signal);
    assert.equal(drains, 1);
    assert.equal(errors.length, 0);

    pending.push(new Error("first isolated failure"));
    await collector.collect(clock.now(), new AbortController().signal);
    assert.equal(drains, 1);
    assert.equal(errors.length, 0);

    clock.advance(1000);
    pending.push(new Error("second isolated failure"));
    await collector.collect(clock.now(), new AbortController().signal);
    assert.equal(drains, 2);
    assert.deepEqual(
      errors.map((entry) => entry.error.message),
      ["first isolated failure", "second isolated failure"],
    );

    const broken: SignalProvider = {
      id: "broken-drain",
      signals: [{ name: "broken.value", unit: "bytes" }],
      read: (context) => [okSignal("broken.value", 1, context.now)],
      drainProviderErrors: () => {
        throw new Error("drain exploded");
      },
    };
    const brokenCollector = makeCollector([broken], { evaluationIntervalMs: 0 });
    await brokenCollector.collector.collect(
      brokenCollector.clock.now(),
      new AbortController().signal,
    );
    assert.deepEqual(
      brokenCollector.errors.map((entry) => entry.error.message),
      ["drain exploded"],
    );

    const nonArray: SignalProvider = {
      id: "non-array-drain",
      signals: [{ name: "nonarray.value", unit: "bytes" }],
      read: (context) => [okSignal("nonarray.value", 1, context.now)],
      drainProviderErrors: () => "not an array" as unknown as readonly Error[],
    };
    const nonArrayCollector = makeCollector([nonArray], { evaluationIntervalMs: 0 });
    await nonArrayCollector.collector.collect(
      nonArrayCollector.clock.now(),
      new AbortController().signal,
    );
    assert.match(
      nonArrayCollector.errors[0]?.error.message ?? "",
      /drainProviderErrors\(\) must return an array/,
    );

    const shared = new Error("shared read failure");
    const deduped: SignalProvider = {
      id: "deduped",
      signals: [{ name: "deduped.value", unit: "bytes" }],
      read: () => {
        throw shared;
      },
      drainProviderErrors: () => [shared, new Error("queued sibling")],
    };
    const dedupedCollector = makeCollector([deduped], { evaluationIntervalMs: 0 });
    await dedupedCollector.collector.collect(
      dedupedCollector.clock.now(),
      new AbortController().signal,
    );
    assert.deepEqual(
      dedupedCollector.errors.map((entry) => entry.error.message),
      ["shared read failure", "queued sibling"],
    );
  });

  it("lets a waiter abort a shared read without cancelling the initiator", async () => {
    let release: ((readings: readonly ResourceSignal[]) => void) | undefined;
    const provider = new FunctionSignalProvider({
      read: () =>
        new Promise<readonly ResourceSignal[]>((resolve) => {
          release = resolve;
        }),
    });
    const { collector, clock } = makeCollector([provider]);
    const firstPromise = collector.collect(clock.now(), new AbortController().signal);
    const controller = new AbortController();
    const secondPromise = collector.collect(clock.now(), controller.signal);
    const reason = new Error("stop waiting");
    controller.abort(reason);

    await assert.rejects(secondPromise, (error: unknown) => error === reason);
    release?.([okSignal(PROVIDER_SIGNAL, 1, clock.now())]);
    const first = await firstPromise;
    assert.equal(first.cached, false);
    assert.equal(first.coalesced, false);
    assert.equal(requireOk(first.readings[0]).value, 1);
  });

  it("keeps a shared read alive when the initiator aborts", async () => {
    let release: ((readings: readonly ResourceSignal[]) => void) | undefined;
    let reads = 0;
    const provider = new FunctionSignalProvider({
      read: () => {
        reads += 1;
        return new Promise<readonly ResourceSignal[]>((resolve) => {
          release = resolve;
        });
      },
    });
    const { collector, clock } = makeCollector([provider]);
    const initiator = new AbortController();
    const firstPromise = collector.collect(clock.now(), initiator.signal);
    const secondPromise = collector.collect(clock.now(), new AbortController().signal);

    const reason = new Error("stop initiator");
    initiator.abort(reason);
    await assert.rejects(firstPromise, (error: unknown) => error === reason);

    release?.([okSignal(PROVIDER_SIGNAL, 2, clock.now())]);
    const second = await secondPromise;
    assert.equal(second.cached, false);
    assert.equal(second.coalesced, true);
    assert.equal(requireOk(second.readings[0]).value, 2);
    assert.equal(reads, 1);

    const third = await collector.collect(clock.now(), new AbortController().signal);
    assert.equal(third.cached, true);
    assert.equal(third.coalesced, false);
    assert.equal(requireOk(third.readings[0]).value, 2);
    assert.equal(reads, 1);
  });

  it("shares an in-flight read and marks the second caller as coalesced", async () => {
    let releases: (() => void) | undefined;
    const provider = new FunctionSignalProvider({
      read: () =>
        new Promise((resolve) => {
          releases = () =>
            resolve([
              {
                name: PROVIDER_SIGNAL,
                unit: "bytes",
                status: "ok",
                value: 1,
                observedAt: 1,
              },
            ]);
        }),
    });
    const { collector, clock } = makeCollector([provider]);
    const firstPromise = collector.collect(clock.now(), new AbortController().signal);
    const secondPromise = collector.collect(clock.now(), new AbortController().signal);
    await Promise.resolve();
    releases?.();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    assert.equal(first.cached, false);
    assert.equal(first.coalesced, false);
    assert.equal(second.cached, false);
    assert.equal(second.coalesced, true);
    assert.equal(second.sequence, first.sequence);
  });

  it("turns provider failures into error readings without crashing", async () => {
    const provider = new FunctionSignalProvider({
      read: () => {
        throw new Error("sensor unavailable");
      },
    });
    const { collector, clock, errors } = makeCollector([provider]);
    const snapshot = await collector.collect(clock.now(), new AbortController().signal);
    assert.equal(snapshot.readings[0]?.status, "error");
    assert.match(snapshot.readings[0]?.error ?? "", /sensor unavailable/);
    assert.equal(errors.length, 1);
  });

  it("times out a slow provider and reports an error reading", async () => {
    let aborted = false;
    let started = false;
    const provider = new FunctionSignalProvider({
      read: (context) => {
        started = true;
        return new Promise((_resolve) => {
          context.signal.addEventListener("abort", () => {
            aborted = true;
          });
        });
      },
    });
    const { collector, clock, errors } = makeCollector([provider], {
      providerTimeoutMs: 500,
    });
    const promise = collector.collect(clock.now(), new AbortController().signal);
    while (!started) {
      await Promise.resolve();
    }
    clock.advance(500);
    const snapshot = await promise;
    assert.equal(aborted, true);
    assert.equal(snapshot.readings[0]?.status, "error");
    assert.match(snapshot.readings[0]?.error ?? "", /did not finish/);
    assert.equal(errors.length, 1);
  });

  it("rejects malformed readings from a provider", async () => {
    const provider = new FunctionSignalProvider({
      read: (_context) => [
        {
          name: PROVIDER_SIGNAL,
          unit: "count",
          status: "ok",
          value: 1,
          observedAt: 1,
        },
      ],
    });
    const { collector, clock, errors } = makeCollector([provider]);
    const snapshot = await collector.collect(clock.now(), new AbortController().signal);
    assert.equal(snapshot.readings[0]?.status, "error");
    assert.match(snapshot.readings[0]?.error ?? "", /unit/);
    assert.equal(errors.length, 1);
  });

  it("synthesizes unknown readings for declared signals a provider omits", async () => {
    const provider = new FunctionSignalProvider({
      read: () => [],
    });
    const { collector, clock } = makeCollector([provider]);
    const snapshot = await collector.collect(clock.now(), new AbortController().signal);
    assert.equal(snapshot.readings[0]?.status, "unknown");
  });

  it("starts providers once and closes them", async () => {
    let starts = 0;
    let closes = 0;
    const provider: SignalProvider = {
      id: "lifecycle",
      signals: [{ name: PROVIDER_SIGNAL, unit: "bytes" }],
      start: () => {
        starts += 1;
      },
      read: (context) => [okSignal(PROVIDER_SIGNAL, 1, context.now)],
      close: () => {
        closes += 1;
      },
    };
    const { collector, clock } = makeCollector([provider], { evaluationIntervalMs: 0 });
    await collector.collect(clock.now(), new AbortController().signal);
    await collector.collect(clock.now(), new AbortController().signal);
    assert.equal(starts, 1);
    await collector.close();
    await collector.close();
    assert.equal(closes, 1);
    await assert.rejects(
      () => collector.collect(clock.now(), new AbortController().signal),
      RuntimeClosedError,
    );
  });

  it("validates provider registration", () => {
    const duplicateSignalA = new FunctionSignalProvider({ read: () => [] });
    const duplicateSignalB = new FunctionSignalProvider({ read: () => [], id: "other" });
    assert.throws(() => makeCollector([duplicateSignalA, duplicateSignalB]), ConfigurationError);

    const duplicateIdA = new FunctionSignalProvider({ read: () => [] });
    const duplicateIdB = new FunctionSignalProvider({
      read: () => [],
      signalName: "other.signal",
    });
    assert.throws(() => makeCollector([duplicateIdA, duplicateIdB]), ConfigurationError);

    const emptySignals: SignalProvider = {
      id: "empty",
      signals: [],
      read: () => [],
    };
    assert.throws(() => makeCollector([emptySignals]), ConfigurationError);

    const paddedId: SignalProvider = {
      id: " padded ",
      signals: [{ name: "test.value", unit: "bytes" }],
      read: () => [],
    };
    assert.throws(() => makeCollector([paddedId]), ConfigurationError);

    const paddedSignal: SignalProvider = {
      id: "padded-signal",
      signals: [{ name: " padded.signal ", unit: "bytes" }],
      read: () => [],
    };
    assert.throws(() => makeCollector([paddedSignal]), ConfigurationError);
  });

  it("rejects promptly when the caller aborts a hanging provider read", async () => {
    const provider = new FunctionSignalProvider({
      read: () => new Promise(() => undefined),
    });
    const { collector, clock, errors } = makeCollector([provider], { providerTimeoutMs: 0 });
    const controller = new AbortController();
    const promise = collector.collect(clock.now(), controller.signal);
    const rejection = assert.rejects(
      promise,
      (error: unknown) => error instanceof Error && error.message === "user cancelled",
    );
    controller.abort(new Error("user cancelled"));
    await rejection;
    assert.equal(errors.length, 0);
  });

  it("does not cache a read aborted by every caller", async () => {
    let reads = 0;
    const provider = new FunctionSignalProvider({
      read: () => {
        reads += 1;
        if (reads === 1) {
          return new Promise<readonly ResourceSignal[]>(() => undefined);
        }
        return [okSignal(PROVIDER_SIGNAL, 3, 0)];
      },
    });
    const { collector, clock } = makeCollector([provider], { providerTimeoutMs: 0 });
    const controller = new AbortController();
    const first = collector.collect(clock.now(), controller.signal);
    const reason = new Error("stop the only caller");
    const rejection = assert.rejects(first, (error: unknown) => error === reason);
    controller.abort(reason);
    await rejection;
    assert.equal(reads, 1);

    const second = await collector.collect(clock.now(), new AbortController().signal);
    assert.equal(second.cached, false);
    assert.equal(requireOk(second.readings[0]).value, 3);
    assert.equal(reads, 2);
  });

  it("rejects pre-aborted callers and normalizes non-Error abort reasons", async () => {
    const provider = new FunctionSignalProvider({
      read: () => new Promise<readonly ResourceSignal[]>(() => undefined),
    });
    const { collector, clock } = makeCollector([provider], { providerTimeoutMs: 0 });

    const reason = new Error("already cancelled");
    const first = new AbortController();
    first.abort(reason);
    await assert.rejects(
      collector.collect(clock.now(), first.signal),
      (error: unknown) => error === reason,
    );

    const second = new AbortController();
    second.abort("not an Error");
    await assert.rejects(
      collector.collect(clock.now(), second.signal),
      (error: unknown) =>
        error instanceof Error && error.message === "Signal collection was aborted.",
    );
  });

  it("does not reuse a snapshot with a negative age", async () => {
    const provider = new SequenceSignalProvider({ values: [1, 2] });
    const { collector, clock } = makeCollector([provider], { evaluationIntervalMs: 1000 });
    const now = clock.now();

    const first = await collector.collect(now, new AbortController().signal);
    assert.equal(requireOk(first.readings[0]).value, 1);
    assert.equal(first.cached, false);

    const second = await collector.collect(now - 1, new AbortController().signal);
    assert.equal(second.cached, false);
    assert.equal(requireOk(second.readings[0]).value, 2);

    const third = await collector.collect(now + 500, new AbortController().signal);
    assert.equal(third.cached, true);
    assert.equal(requireOk(third.readings[0]).value, 2);
  });

  it("reports a provider start failure once and reuses the error readings within the evaluation interval", async () => {
    let starts = 0;
    let reads = 0;
    const provider: SignalProvider = {
      id: "start-failure",
      signals: [{ name: PROVIDER_SIGNAL, unit: "bytes" }],
      start: () => {
        starts += 1;
        throw new Error("start failed");
      },
      read: () => {
        reads += 1;
        return [];
      },
    };
    const { collector, clock, errors } = makeCollector([provider], { evaluationIntervalMs: 1000 });

    const first = await collector.collect(clock.now(), new AbortController().signal);
    assert.equal(first.readings[0]?.status, "error");
    assert.match(first.readings[0]?.error ?? "", /start failed/);

    const second = await collector.collect(clock.now(), new AbortController().signal);
    assert.equal(second.readings[0]?.status, "error");
    assert.equal(second.cached, true);
    assert.equal(starts, 1);
    assert.equal(reads, 0);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.providerId, "start-failure");
  });

  it("awaits an asynchronous start before the first read", async () => {
    let starts = 0;
    let reads = 0;
    let started = false;
    let resolveStart: (() => void) | undefined;
    const provider: SignalProvider = {
      id: "async-start",
      signals: [{ name: PROVIDER_SIGNAL, unit: "bytes" }],
      start: () => {
        starts += 1;
        return new Promise<void>((resolve) => {
          resolveStart = () => {
            started = true;
            resolve();
          };
        });
      },
      read: (context) => {
        reads += 1;
        return [okSignal(PROVIDER_SIGNAL, started ? 7 : 0, context.now)];
      },
    };
    const { collector, clock } = makeCollector([provider], { evaluationIntervalMs: 0 });

    const promise = collector.collect(clock.now(), new AbortController().signal);
    assert.equal(starts, 1);
    assert.equal(reads, 0);
    resolveStart?.();
    const first = await promise;
    assert.equal(reads, 1);
    assert.equal(requireOk(first.readings[0]).value, 7);

    const second = await collector.collect(clock.now(), new AbortController().signal);
    assert.equal(requireOk(second.readings[0]).value, 7);
    assert.equal(starts, 1);
  });

  it("caches an asynchronous start rejection and does not leak it within the evaluation interval", async () => {
    let starts = 0;
    let reads = 0;
    const provider: SignalProvider = {
      id: "async-start-failure",
      signals: [{ name: PROVIDER_SIGNAL, unit: "bytes" }],
      start: async () => {
        starts += 1;
        throw new Error("async start failed");
      },
      read: () => {
        reads += 1;
        return [];
      },
    };
    const { collector, clock, errors } = makeCollector([provider], { evaluationIntervalMs: 1000 });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const first = await collector.collect(clock.now(), new AbortController().signal);
      assert.equal(first.readings[0]?.status, "error");
      assert.match(first.readings[0]?.error ?? "", /async start failed/);

      const second = await collector.collect(clock.now(), new AbortController().signal);
      assert.equal(second.readings[0]?.status, "error");
      assert.equal(second.cached, true);
      assert.match(second.readings[0]?.error ?? "", /async start failed/);

      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      assert.equal(unhandled.length, 0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    assert.equal(starts, 1);
    assert.equal(reads, 0);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.providerId, "async-start-failure");
  });

  it("times out a hanging asynchronous start and caches the failure within the evaluation interval", async () => {
    let starts = 0;
    let reads = 0;
    const provider: SignalProvider = {
      id: "async-start-timeout",
      signals: [{ name: PROVIDER_SIGNAL, unit: "bytes" }],
      start: () => {
        starts += 1;
        return new Promise<void>(() => undefined);
      },
      read: () => {
        reads += 1;
        return [okSignal(PROVIDER_SIGNAL, 1, 0)];
      },
    };
    const { collector, clock, errors } = makeCollector([provider], {
      evaluationIntervalMs: 1000,
      providerTimeoutMs: 500,
    });

    const promise = collector.collect(clock.now(), new AbortController().signal);
    assert.equal(starts, 1);
    assert.equal(clock.pendingTimers(), 1);
    clock.advance(500);
    const first = await promise;
    assert.equal(first.readings[0]?.status, "error");
    assert.match(first.readings[0]?.error ?? "", /did not finish/);
    assert.equal(reads, 0);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.providerId, "async-start-timeout");

    // Second read at 500ms is still within evaluation interval (500 < 1000)
    const second = await collector.collect(clock.now(), new AbortController().signal);
    assert.equal(second.readings[0]?.status, "error");
    assert.equal(second.cached, true);
    assert.equal(starts, 1);
    assert.equal(reads, 0);
    assert.equal(errors.length, 1);
    assert.equal(clock.pendingTimers(), 0);
  });

  it("does not cache a caller abort during a pending start", async () => {
    let starts = 0;
    let reads = 0;
    let resolveStart: (() => void) | undefined;
    const provider: SignalProvider = {
      id: "async-start-abort",
      signals: [{ name: PROVIDER_SIGNAL, unit: "bytes" }],
      start: () => {
        starts += 1;
        return new Promise<void>((resolve) => {
          resolveStart = resolve;
        });
      },
      read: (context) => {
        reads += 1;
        return [okSignal(PROVIDER_SIGNAL, 4, context.now)];
      },
    };
    const { collector, clock, errors } = makeCollector([provider], { providerTimeoutMs: 0 });

    const controller = new AbortController();
    const first = collector.collect(clock.now(), controller.signal);
    const reason = new Error("cancel the start wait");
    const rejection = assert.rejects(first, (error: unknown) => error === reason);
    controller.abort(reason);
    await rejection;
    assert.equal(errors.length, 0);

    resolveStart?.();
    const second = await collector.collect(clock.now(), new AbortController().signal);
    assert.equal(second.cached, false);
    assert.equal(requireOk(second.readings[0]).value, 4);
    assert.equal(starts, 1);
    assert.equal(reads, 1);
  });

  it("contains provider close failures and still resolves close", async () => {
    const provider: SignalProvider = {
      id: "close-failure",
      signals: [{ name: PROVIDER_SIGNAL, unit: "bytes" }],
      read: (context) => [okSignal(PROVIDER_SIGNAL, 1, context.now)],
      close: () => {
        throw new Error("close failed");
      },
    };
    const { collector, clock, errors } = makeCollector([provider]);
    await collector.collect(clock.now(), new AbortController().signal);
    await collector.close();
    await collector.close();
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.providerId, "close-failure");
    assert.match(errors[0]?.error.message ?? "", /close failed/);
  });

  it("validates every malformed reading shape", async () => {
    const duplicate = {
      name: PROVIDER_SIGNAL,
      unit: "bytes",
      status: "ok",
      value: 1,
      observedAt: 1,
    };
    const cases: readonly { label: string; raw: unknown; match: RegExp }[] = [
      { label: "non-array", raw: { readings: [] }, match: /must return an array/ },
      { label: "non-object", raw: [null], match: /non-object reading/ },
      {
        label: "undeclared",
        raw: [{ ...duplicate, name: "other.signal" }],
        match: /undeclared signal/,
      },
      { label: "duplicate", raw: [duplicate, duplicate], match: /more than once/ },
      {
        label: "negative observedAt",
        raw: [{ ...duplicate, observedAt: -1 }],
        match: /invalid observedAt/,
      },
      {
        label: "NaN observedAt",
        raw: [{ ...duplicate, observedAt: Number.NaN }],
        match: /invalid observedAt/,
      },
      {
        label: "non-number observedAt",
        raw: [{ ...duplicate, observedAt: "1" }],
        match: /invalid observedAt/,
      },
      {
        label: "invalid status",
        raw: [{ ...duplicate, status: "bogus" }],
        match: /invalid status/,
      },
      {
        label: "non-finite value",
        raw: [{ ...duplicate, value: Number.POSITIVE_INFINITY }],
        match: /non-finite value/,
      },
      {
        label: "negative confidence",
        raw: [{ ...duplicate, confidence: -0.1 }],
        match: /confidence/,
      },
      {
        label: "confidence above one",
        raw: [{ ...duplicate, confidence: 1.1 }],
        match: /confidence/,
      },
      {
        label: "non-finite confidence",
        raw: [{ ...duplicate, confidence: Number.NaN }],
        match: /confidence/,
      },
      {
        label: "non-string error",
        raw: [{ ...duplicate, status: "error", value: undefined, error: 42 }],
        match: /error must be a string/,
      },
    ];

    for (const testCase of cases) {
      const provider: SignalProvider = {
        id: "malformed-readings",
        signals: [{ name: PROVIDER_SIGNAL, unit: "bytes" }],
        read: () => testCase.raw as readonly ResourceSignal[],
      };
      const { collector, clock, errors } = makeCollector([provider], {
        evaluationIntervalMs: 0,
      });
      const snapshot = await collector.collect(clock.now(), new AbortController().signal);
      assert.equal(snapshot.readings[0]?.status, "error", testCase.label);
      assert.match(snapshot.readings[0]?.error ?? "", testCase.match, testCase.label);
      assert.equal(errors.length, 1, testCase.label);
    }
  });

  it("truncates provider reading error strings to at most 1000 characters", async () => {
    const longError = "E".repeat(1500);
    const provider: SignalProvider = {
      id: "long-error-provider",
      signals: [{ name: PROVIDER_SIGNAL, unit: "bytes" }],
      read: (context) => [
        {
          name: PROVIDER_SIGNAL,
          unit: "bytes",
          status: "unsupported",
          observedAt: context.now,
          error: longError,
        },
      ],
    };
    const { collector, clock } = makeCollector([provider], { evaluationIntervalMs: 0 });
    const snapshot = await collector.collect(clock.now(), new AbortController().signal);
    assert.equal(snapshot.readings.length, 1);
    const reading = snapshot.readings[0];
    assert.equal(reading?.status, "unsupported");
    assert.equal(reading?.error?.length, 1001);
    assert.equal(reading?.error?.slice(0, 1000), "E".repeat(1000));
    assert.ok(reading?.error?.endsWith("…"));
  });

  it("passes SignalStartContext with valid now and signal to provider.start()", async () => {
    let capturedContext: SignalStartContext | undefined;
    const provider: SignalProvider = {
      id: "start-context-provider",
      signals: [{ name: PROVIDER_SIGNAL, unit: "bytes" }],
      start: (context) => {
        capturedContext = context;
      },
      read: (context) => [okSignal(PROVIDER_SIGNAL, 42, context.now)],
    };
    const { collector, clock } = makeCollector([provider], { evaluationIntervalMs: 1000 });
    clock.advance(1234);
    const snapshot = await collector.collect(clock.now(), new AbortController().signal);

    assert.equal(requireOk(snapshot.readings[0]).value, 42);
    assert.ok(capturedContext !== undefined);
    assert.equal(capturedContext.now, clock.now());
    assert.ok(capturedContext.signal instanceof AbortSignal);
    assert.equal(capturedContext.signal.aborted, false);
  });

  it("recovers from transient start failure on the next evaluation interval when clock advances", async () => {
    let startAttempts = 0;
    let readCalls = 0;
    const provider: SignalProvider = {
      id: "transient-failure-provider",
      signals: [{ name: PROVIDER_SIGNAL, unit: "bytes" }],
      start: () => {
        startAttempts += 1;
        if (startAttempts === 1) {
          throw new Error("transient network blip on boot");
        }
      },
      read: (context) => {
        readCalls += 1;
        return [okSignal(PROVIDER_SIGNAL, 99, context.now)];
      },
    };
    const { collector, clock, errors } = makeCollector([provider], { evaluationIntervalMs: 1000 });

    // Cycle 1: start fails, returns synthesized error reading
    const first = await collector.collect(clock.now(), new AbortController().signal);
    assert.equal(first.readings[0]?.status, "error");
    assert.match(first.readings[0]?.error ?? "", /transient network blip/);
    assert.equal(startAttempts, 1);
    assert.equal(readCalls, 0);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.providerId, "transient-failure-provider");

    // Still within evaluation interval (age 500 < 1000): returns cached error readings without retry
    clock.advance(500);
    const cached = await collector.collect(clock.now(), new AbortController().signal);
    assert.equal(cached.cached, true);
    assert.equal(cached.readings[0]?.status, "error");
    assert.equal(startAttempts, 1);
    assert.equal(errors.length, 1);

    // Evaluation interval passes (age 1000 >= 1000): fresh cycle retries start and succeeds
    clock.advance(500);
    const recovered = await collector.collect(clock.now(), new AbortController().signal);
    assert.equal(recovered.cached, false);
    assert.equal(recovered.readings[0]?.status, "ok");
    assert.equal(requireOk(recovered.readings[0]).value, 99);
    assert.equal(startAttempts, 2);
    assert.equal(readCalls, 1);
    assert.equal(errors.length, 1); // No new errors emitted on recovery

    // Subsequent call within new evaluation interval serves cached ok snapshot
    const stable = await collector.collect(clock.now(), new AbortController().signal);
    assert.equal(stable.cached, true);
    assert.equal(requireOk(stable.readings[0]).value, 99);
    assert.equal(startAttempts, 2);
    assert.equal(readCalls, 1);
  });

  it("retries start on every fresh collection cycle when evaluationIntervalMs is 0", async () => {
    let startAttempts = 0;
    const provider: SignalProvider = {
      id: "uninterrupted-failure-provider",
      signals: [{ name: PROVIDER_SIGNAL, unit: "bytes" }],
      start: () => {
        startAttempts += 1;
        throw new Error(`failure attempt ${startAttempts}`);
      },
      read: () => [],
    };
    const { collector, clock, errors } = makeCollector([provider], { evaluationIntervalMs: 0 });

    const first = await collector.collect(clock.now(), new AbortController().signal);
    assert.equal(first.readings[0]?.status, "error");
    assert.match(first.readings[0]?.error ?? "", /failure attempt 1/);
    assert.equal(startAttempts, 1);
    assert.equal(errors.length, 1);

    clock.advance(10);
    const second = await collector.collect(clock.now(), new AbortController().signal);
    assert.equal(second.readings[0]?.status, "error");
    assert.match(second.readings[0]?.error ?? "", /failure attempt 2/);
    assert.equal(startAttempts, 2);
    assert.equal(errors.length, 2);
  });

  it("forwards SignalStartContext through CompositeSignalProvider to child providers", async () => {
    let childAContext: SignalStartContext | undefined;
    let childBContext: SignalStartContext | undefined;

    const childA: SignalProvider = {
      id: "child-a",
      signals: [{ name: "child.a", unit: "ratio" }],
      start: (context) => {
        childAContext = context;
      },
      read: (context) => [
        { name: "child.a", unit: "ratio", status: "ok", value: 0.8, observedAt: context.now },
      ],
    };

    const childB: SignalProvider = {
      id: "child-b",
      signals: [{ name: "child.b", unit: "ratio" }],
      start: async (context) => {
        childBContext = context;
      },
      read: (context) => [
        { name: "child.b", unit: "ratio", status: "ok", value: 0.2, observedAt: context.now },
      ],
    };

    const composite = new CompositeSignalProvider({
      id: "test-composite",
      providers: [childA, childB],
      rules: [
        {
          name: "composite.sum",
          unit: "ratio",
          inputs: ["child.a", "child.b"],
          compute: (v) => (v["child.a"] ?? 0) + (v["child.b"] ?? 0),
        },
      ],
    });

    const { collector, clock } = makeCollector([composite], { evaluationIntervalMs: 1000 });
    clock.advance(5555);

    const snapshot = await collector.collect(clock.now(), new AbortController().signal);
    assert.equal(snapshot.readings.length, 3);
    const sumReading = snapshot.readings.find((r) => r.name === "composite.sum");
    assert.equal(sumReading?.status, "ok");

    assert.ok(childAContext !== undefined);
    assert.equal(childAContext.now, clock.now());
    assert.ok(childAContext.signal instanceof AbortSignal);

    assert.ok(childBContext !== undefined);
    assert.equal(childBContext.now, clock.now());
    assert.ok(childBContext.signal instanceof AbortSignal);
  });

  it("collects empty snapshot with cached: false and coalesced: false when no providers registered", async () => {
    const { collector, clock } = makeCollector([], { evaluationIntervalMs: 1000 });
    const first = await collector.collect(clock.now(), new AbortController().signal);
    assert.deepEqual(first.readings, []);
    assert.equal(first.cached, false);
    assert.equal(first.coalesced, false);
    assert.equal(first.sequence, 1);

    const second = await collector.collect(clock.now(), new AbortController().signal);
    assert.deepEqual(second.readings, []);
    assert.equal(second.cached, true);
    assert.equal(second.coalesced, false);
    assert.equal(second.sequence, 1);

    clock.advance(1000);
    const third = await collector.collect(clock.now(), new AbortController().signal);
    assert.deepEqual(third.readings, []);
    assert.equal(third.cached, false);
    assert.equal(third.coalesced, false);
    assert.equal(third.sequence, 2);
  });

  it("marks multiple concurrent joiners as coalesced: true and cached: false", async () => {
    let release: (() => void) | undefined;
    const provider = new FunctionSignalProvider({
      read: (ctx) =>
        new Promise((resolve) => {
          release = () => resolve([okSignal(PROVIDER_SIGNAL, 99, ctx.now)]);
        }),
    });
    const { collector, clock } = makeCollector([provider]);
    const callers = Array.from({ length: 4 }, () =>
      collector.collect(clock.now(), new AbortController().signal),
    );
    await Promise.resolve();
    release?.();
    const snapshots = await Promise.all(callers);
    assert.equal(snapshots[0]?.cached, false);
    assert.equal(snapshots[0]?.coalesced, false);
    for (let i = 1; i < snapshots.length; i++) {
      assert.equal(snapshots[i]?.cached, false);
      assert.equal(snapshots[i]?.coalesced, true);
      assert.equal(snapshots[i]?.sequence, snapshots[0]?.sequence);
    }
  });

  describe("getDescriptors()", () => {
    it("exposes frozen signal descriptors in provider registration and declaration order", () => {
      const providerA: SignalProvider = {
        id: "provider-a",
        signals: [
          { name: "sig.a1", unit: "count", description: "first" },
          { name: "sig.a2", unit: "bytes" },
        ],
        read: () => [],
      };
      const providerB: SignalProvider = {
        id: "provider-b",
        signals: [{ name: "sig.b1", unit: "ratio" }],
        read: () => [],
      };
      const { collector } = makeCollector([providerA, providerB]);
      const descriptors = collector.getDescriptors();

      assert.equal(descriptors.length, 3);
      assert.equal(Object.isFrozen(descriptors), true);
      assert.deepEqual(
        descriptors.map((d) => d.name),
        ["sig.a1", "sig.a2", "sig.b1"],
      );
      assert.deepEqual(descriptors[0], {
        name: "sig.a1",
        unit: "count",
        description: "first",
      });
      for (const descriptor of descriptors) {
        assert.equal(Object.isFrozen(descriptor), true);
      }
      assert.throws(() => {
        (descriptors as unknown as unknown[]).push({ name: "illegal", unit: "count" });
      }, TypeError);
      assert.throws(() => {
        (descriptors[0] as unknown as { description: string }).description = "mutated";
      }, TypeError);
    });

    it("returns empty frozen descriptors array when collector has no providers", () => {
      const { collector } = makeCollector([]);
      const descriptors = collector.getDescriptors();

      assert.deepEqual(descriptors, []);
      assert.equal(Object.isFrozen(descriptors), true);
    });

    it("preserves descriptors reference across collect and close calls", async () => {
      const provider = new FunctionSignalProvider({
        read: (ctx) => [okSignal(PROVIDER_SIGNAL, 1, ctx.now)],
      });
      const { collector, clock } = makeCollector([provider]);
      const initialDescriptors = collector.getDescriptors();

      assert.equal(collector.getDescriptors(), initialDescriptors);
      await collector.collect(clock.now(), new AbortController().signal);
      assert.equal(collector.getDescriptors(), initialDescriptors);
      await collector.close();
      assert.equal(collector.getDescriptors(), initialDescriptors);
    });
  });

  describe("circuit breaker and provider health", () => {
    it("validates maxConsecutiveFailures strictly in constructor", () => {
      const provider = new FunctionSignalProvider({
        read: (ctx) => [okSignal(PROVIDER_SIGNAL, 1, ctx.now)],
      });

      for (const invalid of [
        0,
        -1,
        -10,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        "2",
        null,
        false,
        {},
      ]) {
        assert.throws(
          () =>
            makeCollector([provider], {
              maxConsecutiveFailures: invalid as unknown as number,
            }),
          ConfigurationError,
        );
      }

      for (const valid of [1, 2, 5, 100]) {
        const { collector } = makeCollector([provider], { maxConsecutiveFailures: valid });
        assert.ok(collector);
      }
    });

    it("validates failureCooldownMs strictly in constructor", () => {
      const provider = new FunctionSignalProvider({
        read: (ctx) => [okSignal(PROVIDER_SIGNAL, 1, ctx.now)],
      });

      for (const invalid of [
        0,
        -1,
        -500,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        "500",
        null,
        false,
        {},
      ]) {
        assert.throws(
          () =>
            makeCollector([provider], {
              failureCooldownMs: invalid as unknown as number,
            }),
          ConfigurationError,
        );
      }

      for (const valid of [0.5, 1, 500, 10_000]) {
        const { collector } = makeCollector([provider], { failureCooldownMs: valid });
        assert.ok(collector);
      }
    });

    it("opens circuit after maxConsecutiveFailures consecutive failures and fast-fails during cooldown", async () => {
      let readCount = 0;
      let shouldFail = true;
      const provider = new FunctionSignalProvider({
        id: "flaky-provider",
        signalName: PROVIDER_SIGNAL,
        read: (ctx) => {
          readCount += 1;
          if (shouldFail) {
            throw new Error(`failure-${readCount}`);
          }
          return [okSignal(PROVIDER_SIGNAL, 42, ctx.now)];
        },
      });

      const { collector, clock, errors } = makeCollector([provider], {
        evaluationIntervalMs: 1000,
        maxConsecutiveFailures: 2,
        failureCooldownMs: 5000,
      });

      // Read 1: first failure
      const snap1 = await collector.collect(clock.now(), new AbortController().signal);
      assert.equal(snap1.readings[0]?.status, "error");
      assert.equal(readCount, 1);
      assert.equal(errors.length, 1);

      let health = collector.getProviderHealth();
      assert.equal(health[0]?.consecutiveFailures, 1);
      assert.equal(health[0]?.totalFailures, 1);
      assert.equal(health[0]?.totalReads, 1);
      assert.equal(health[0]?.circuitOpen, false);
      assert.equal(health[0]?.cooldownUntilMs, null);

      // Read 2: second consecutive failure -> opens circuit!
      clock.advance(1000);
      const snap2 = await collector.collect(clock.now(), new AbortController().signal);
      assert.equal(snap2.readings[0]?.status, "error");
      assert.equal(readCount, 2);
      assert.equal(errors.length, 2);

      const expectedCooldownUntil = clock.now() + 5000;
      health = collector.getProviderHealth();
      assert.equal(health[0]?.consecutiveFailures, 2);
      assert.equal(health[0]?.totalFailures, 2);
      assert.equal(health[0]?.totalReads, 2);
      assert.equal(health[0]?.circuitOpen, true);
      assert.equal(health[0]?.cooldownUntilMs, expectedCooldownUntil);

      // Read 3: within cooldown (now + 1000 < cooldownUntil) -> fast-fail, read() skipped!
      clock.advance(1000);
      const snap3 = await collector.collect(clock.now(), new AbortController().signal);
      assert.equal(readCount, 2); // Provider read() was NOT called!
      assert.equal(errors.length, 2); // No new error reported!
      const reading3 = snap3.readings[0] as unknown as Record<string, unknown>;
      assert.equal(reading3.status, "unavailable");
      assert.equal(reading3.reason, "provider_circuit_open");
      assert.equal(reading3.error, "provider_circuit_open");
      assert.equal(reading3.value, null);
      assert.equal((reading3.details as Record<string, unknown>)?.reason, "provider_circuit_open");

      // Read 4: still within cooldown (now + 2000 < cooldownUntil) -> fast-fail
      clock.advance(2000);
      const snap4 = await collector.collect(clock.now(), new AbortController().signal);
      assert.equal(readCount, 2);
      assert.equal(snap4.readings[0]?.status, "unavailable");

      // Read 5: half-open probe at now >= cooldownUntil (advance remaining 2000ms)
      clock.advance(2000);
      assert.equal(clock.now(), expectedCooldownUntil);
      // Health shows circuitOpen = false at probe time
      health = collector.getProviderHealth();
      assert.equal(health[0]?.circuitOpen, false);

      // Provider recovers
      shouldFail = false;
      const snap5 = await collector.collect(clock.now(), new AbortController().signal);
      assert.equal(readCount, 3); // Half-open probe invoked read()!
      assert.equal(snap5.readings[0]?.status, "ok");
      assert.equal(requireOk(snap5.readings[0]).value, 42);

      // Circuit is closed, consecutiveFailures reset
      health = collector.getProviderHealth();
      assert.equal(health[0]?.consecutiveFailures, 0);
      assert.equal(health[0]?.totalFailures, 2);
      assert.equal(health[0]?.totalReads, 3);
      assert.equal(health[0]?.circuitOpen, false);
      assert.equal(health[0]?.cooldownUntilMs, null);

      await collector.close();
    });

    it("half-open probe re-opens circuit for another failureCooldownMs upon failure", async () => {
      let readCount = 0;
      const provider = new FunctionSignalProvider({
        id: "always-broken",
        signalName: PROVIDER_SIGNAL,
        read: () => {
          readCount += 1;
          throw new Error("still broken");
        },
      });

      const { collector, clock } = makeCollector([provider], {
        evaluationIntervalMs: 100,
        maxConsecutiveFailures: 1,
        failureCooldownMs: 2000,
      });

      // Read 1: fails and immediately opens circuit (maxConsecutiveFailures = 1)
      await collector.collect(clock.now(), new AbortController().signal);
      assert.equal(readCount, 1);
      const firstCooldownUntil = clock.now() + 2000;
      assert.equal(collector.getProviderHealth()[0]?.cooldownUntilMs, firstCooldownUntil);
      assert.equal(collector.getProviderHealth()[0]?.circuitOpen, true);

      // Read 2: during cooldown -> skipped
      clock.advance(500);
      const snap2 = await collector.collect(clock.now(), new AbortController().signal);
      assert.equal(readCount, 1);
      assert.equal(snap2.readings[0]?.status, "unavailable");

      // Read 3: half-open probe (advance past 2000ms)
      clock.advance(1600); // clock.now() = 2100 > 2000
      const snap3 = await collector.collect(clock.now(), new AbortController().signal);
      assert.equal(readCount, 2); // Probe executed!
      assert.equal(snap3.readings[0]?.status, "error");

      // Circuit re-opened for another 2000ms from 2100 -> cooldown until 4100!
      const secondCooldownUntil = clock.now() + 2000;
      assert.equal(collector.getProviderHealth()[0]?.cooldownUntilMs, secondCooldownUntil);
      assert.equal(collector.getProviderHealth()[0]?.circuitOpen, true);
      assert.equal(collector.getProviderHealth()[0]?.consecutiveFailures, 2);

      // Read 4: skipped during second cooldown
      clock.advance(500);
      const snap4 = await collector.collect(clock.now(), new AbortController().signal);
      assert.equal(readCount, 2);
      assert.equal(snap4.readings[0]?.status, "unavailable");

      await collector.close();
    });

    it("resets consecutiveFailures on intermediate success before reaching threshold", async () => {
      let failNext = true;
      let readCount = 0;
      const provider = new FunctionSignalProvider({
        id: "intermittent",
        signalName: PROVIDER_SIGNAL,
        read: (ctx) => {
          readCount += 1;
          if (failNext) {
            throw new Error("intermittent failure");
          }
          return [okSignal(PROVIDER_SIGNAL, 99, ctx.now)];
        },
      });

      const { collector, clock } = makeCollector([provider], {
        evaluationIntervalMs: 100,
        maxConsecutiveFailures: 2,
        failureCooldownMs: 5000,
      });

      // Call 1: fails (1 failure)
      await collector.collect(clock.now(), new AbortController().signal);
      assert.equal(collector.getProviderHealth()[0]?.consecutiveFailures, 1);
      assert.equal(collector.getProviderHealth()[0]?.circuitOpen, false);

      // Call 2: succeeds -> resets consecutiveFailures to 0
      clock.advance(200);
      failNext = false;
      await collector.collect(clock.now(), new AbortController().signal);
      assert.equal(collector.getProviderHealth()[0]?.consecutiveFailures, 0);
      assert.equal(collector.getProviderHealth()[0]?.circuitOpen, false);

      // Call 3: fails again -> consecutiveFailures is 1, NOT 2! Circuit stays closed
      clock.advance(200);
      failNext = true;
      await collector.collect(clock.now(), new AbortController().signal);
      assert.equal(collector.getProviderHealth()[0]?.consecutiveFailures, 1);
      assert.equal(collector.getProviderHealth()[0]?.circuitOpen, false);
      assert.equal(collector.getProviderHealth()[0]?.totalFailures, 2);
      assert.equal(collector.getProviderHealth()[0]?.totalReads, 3);
      assert.equal(readCount, 3);

      await collector.close();
    });

    it("opens circuit on async rejection and timeouts, eliminating latency spikes during cooldown", async () => {
      let readCount = 0;
      const provider: SignalProvider = {
        id: "hanging-provider",
        signals: [{ name: PROVIDER_SIGNAL, unit: "bytes" }],
        read: () => {
          readCount += 1;
          // Hangs forever
          return new Promise<readonly ResourceSignal[]>(() => undefined);
        },
      };

      const { collector, clock } = makeCollector([provider], {
        evaluationIntervalMs: 100,
        providerTimeoutMs: 500,
        maxConsecutiveFailures: 1,
        failureCooldownMs: 10_000,
      });

      // Call 1: hangs, times out after 500ms
      const pending1 = collector.collect(clock.now(), new AbortController().signal);
      clock.advance(500);
      const snap1 = await pending1;
      assert.equal(snap1.readings[0]?.status, "error");
      assert.equal(readCount, 1);
      assert.equal(collector.getProviderHealth()[0]?.circuitOpen, true);

      // Call 2: during cooldown -> returns immediately without waiting for provider timeout!
      clock.advance(1000);
      const snap2 = await collector.collect(clock.now(), new AbortController().signal);
      assert.equal(readCount, 1); // read() was NOT called
      assert.equal(snap2.readings[0]?.status, "unavailable");
      assert.equal(
        (snap2.readings[0] as unknown as Record<string, unknown>).reason,
        "provider_circuit_open",
      );

      await collector.close();
    });

    it("isolates circuit breakers between multiple providers", async () => {
      let healthyReads = 0;
      let failingReads = 0;

      const failingProvider = new FunctionSignalProvider({
        id: "failing-provider",
        signalName: "fail.signal",
        read: () => {
          failingReads += 1;
          throw new Error("provider A down");
        },
      });

      const healthyProvider = new FunctionSignalProvider({
        id: "healthy-provider",
        signalName: "ok.signal",
        read: (ctx) => {
          healthyReads += 1;
          return [okSignal("ok.signal", 100, ctx.now)];
        },
      });

      const { collector, clock } = makeCollector([failingProvider, healthyProvider], {
        evaluationIntervalMs: 100,
        maxConsecutiveFailures: 1,
        failureCooldownMs: 5000,
      });

      // Cycle 1: failing provider trips circuit; healthy provider succeeds
      const snap1 = await collector.collect(clock.now(), new AbortController().signal);
      assert.equal(snap1.readings.length, 2);
      assert.equal(failingReads, 1);
      assert.equal(healthyReads, 1);

      const health = collector.getProviderHealth();
      const failHealth = health.find((h) => h.id === "failing-provider");
      const okHealth = health.find((h) => h.id === "healthy-provider");
      assert.equal(failHealth?.circuitOpen, true);
      assert.equal(okHealth?.circuitOpen, false);

      // Cycle 2: failing provider is skipped; healthy provider is still read!
      clock.advance(500);
      const snap2 = await collector.collect(clock.now(), new AbortController().signal);
      assert.equal(failingReads, 1); // Skipped!
      assert.equal(healthyReads, 2); // Read!

      const failReading = snap2.readings.find((r) => r.name === "fail.signal");
      const okReading = snap2.readings.find((r) => r.name === "ok.signal");
      assert.equal(failReading?.status, "unavailable");
      assert.equal(okReading?.status, "ok");

      await collector.close();
    });

    it("getProviderHealth returns deeply frozen status array with dynamic circuitOpen evaluation", async () => {
      const provider: SignalProvider = {
        id: "telemetry-provider",
        signals: [
          { name: "telemetry.a", unit: "bytes" },
          { name: "telemetry.b", unit: "count" },
        ],
        read: (ctx) => [
          okSignal("telemetry.a", 1, ctx.now),
          { name: "telemetry.b", unit: "count", status: "ok", value: 2, observedAt: ctx.now },
        ],
      };

      const { collector } = makeCollector([provider], {
        maxConsecutiveFailures: 2,
        failureCooldownMs: 5000,
      });

      const health = collector.getProviderHealth();
      assert.equal(health.length, 1);
      assert.equal(Object.isFrozen(health), true);
      assert.equal(Object.isFrozen(health[0]), true);
      assert.equal(Object.isFrozen(health[0]?.signals), true);
      assert.deepEqual(health[0]?.signals, ["telemetry.a", "telemetry.b"]);
      assert.equal(health[0]?.consecutiveFailures, 0);
      assert.equal(health[0]?.totalFailures, 0);
      assert.equal(health[0]?.totalReads, 0);
      assert.equal(health[0]?.circuitOpen, false);
      assert.equal(health[0]?.cooldownUntilMs, null);

      const firstHealth = health[0];
      assert.ok(firstHealth);

      assert.throws(() => {
        (health as unknown as unknown[]).push({});
      }, TypeError);
      assert.throws(() => {
        (firstHealth as unknown as Record<string, unknown>).consecutiveFailures = 99;
      }, TypeError);
      assert.throws(() => {
        (firstHealth.signals as unknown as unknown[]).push("bad");
      }, TypeError);

      await collector.close();
    });

    it("resetProviderHealth resets single provider or all providers and validates providerId", async () => {
      let p1Fails = true;
      let p2Fails = true;

      const provider1 = new FunctionSignalProvider({
        id: "p1",
        signalName: "p1.signal",
        read: (ctx) => {
          if (p1Fails) throw new Error("p1 error");
          return [okSignal("p1.signal", 1, ctx.now)];
        },
      });

      const provider2 = new FunctionSignalProvider({
        id: "p2",
        signalName: "p2.signal",
        read: (ctx) => {
          if (p2Fails) throw new Error("p2 error");
          return [okSignal("p2.signal", 2, ctx.now)];
        },
      });

      const { collector, clock } = makeCollector([provider1, provider2], {
        evaluationIntervalMs: 100,
        maxConsecutiveFailures: 1,
        failureCooldownMs: 10_000,
      });

      // Trip both circuits
      await collector.collect(clock.now(), new AbortController().signal);
      let health = collector.getProviderHealth();
      assert.equal(health.find((h) => h.id === "p1")?.circuitOpen, true);
      assert.equal(health.find((h) => h.id === "p2")?.circuitOpen, true);
      assert.equal(health.find((h) => h.id === "p1")?.totalFailures, 1);
      assert.equal(health.find((h) => h.id === "p2")?.totalFailures, 1);

      // Validation for resetProviderHealth(providerId)
      for (const invalid of ["", "   ", " leading", "trailing ", 123, null, false, {}]) {
        assert.throws(
          () => collector.resetProviderHealth(invalid as unknown as string),
          ConfigurationError,
        );
      }

      // Reset single provider: "p1"
      p1Fails = false;
      collector.resetProviderHealth("p1");
      health = collector.getProviderHealth();
      const p1Health = health.find((h) => h.id === "p1");
      const p2Health = health.find((h) => h.id === "p2");
      assert.equal(p1Health?.circuitOpen, false);
      assert.equal(p1Health?.consecutiveFailures, 0);
      assert.equal(p1Health?.totalFailures, 0);
      assert.equal(p1Health?.totalReads, 0);
      assert.equal(p1Health?.cooldownUntilMs, null);
      // p2 is still open!
      assert.equal(p2Health?.circuitOpen, true);
      assert.equal(p2Health?.totalFailures, 1);

      // Now reset all providers
      p2Fails = false;
      collector.resetProviderHealth();
      health = collector.getProviderHealth();
      for (const entry of health) {
        assert.equal(entry.circuitOpen, false);
        assert.equal(entry.consecutiveFailures, 0);
        assert.equal(entry.totalFailures, 0);
        assert.equal(entry.totalReads, 0);
        assert.equal(entry.cooldownUntilMs, null);
      }

      // Next collect executes both reads normally
      clock.advance(200);
      const snap = await collector.collect(clock.now(), new AbortController().signal);
      assert.equal(snap.readings.length, 2);
      assert.equal(snap.readings[0]?.status, "ok");
      assert.equal(snap.readings[1]?.status, "ok");

      await collector.close();
    });
  });
});
