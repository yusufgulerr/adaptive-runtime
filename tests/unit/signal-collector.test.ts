import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigurationError, RuntimeClosedError } from "../../src/errors/index.js";
import { SignalCollector } from "../../src/signals/collector.js";
import type { ResourceSignal, SignalProvider } from "../../src/types/signals.js";
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
    assert.equal(requireOk(first.readings[0]).value, 10);

    const second = await collector.collect(clock.now(), new AbortController().signal);
    assert.equal(second.cached, true);
    assert.equal(second.sequence, first.sequence);
    assert.equal(requireOk(second.readings[0]).value, 10);

    clock.advance(1000);
    const third = await collector.collect(clock.now(), new AbortController().signal);
    assert.equal(third.cached, false);
    assert.notEqual(third.sequence, first.sequence);
    assert.equal(requireOk(third.readings[0]).value, 20);
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
    assert.equal(second.cached, true);
    assert.equal(requireOk(second.readings[0]).value, 2);
    assert.equal(reads, 1);

    const third = await collector.collect(clock.now(), new AbortController().signal);
    assert.equal(third.cached, true);
    assert.equal(requireOk(third.readings[0]).value, 2);
    assert.equal(reads, 1);
  });

  it("shares an in-flight read and marks the second caller as cached", async () => {
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
    assert.equal(second.cached, true);
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
});
