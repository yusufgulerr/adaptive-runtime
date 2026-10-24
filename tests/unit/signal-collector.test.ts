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
  options: { evaluationIntervalMs?: number; providerTimeoutMs?: number; clock?: FakeClock } = {},
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
});
