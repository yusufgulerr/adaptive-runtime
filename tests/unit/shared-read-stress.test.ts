import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SignalCollector } from "../../src/signals/collector.js";
import type { Clock } from "../../src/types/clock.js";
import type { ResourceSignal, SignalProvider } from "../../src/types/signals.js";

const SIGNAL_NAME = "shared.read.value";
const NOW = 1_000_000;

const clock: Clock = {
  now: () => NOW,
  setTimeout: () => {
    throw new Error("These tests configure providerTimeoutMs = 0 and expect no timers.");
  },
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {
    throw new Error("Deferred resolver called before initialization.");
  };
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function makeCollector(provider: SignalProvider): {
  collector: SignalCollector;
  errors: Array<{ providerId: string; error: Error }>;
} {
  const errors: Array<{ providerId: string; error: Error }> = [];
  const collector = new SignalCollector({
    providers: [provider],
    evaluationIntervalMs: 60_000,
    providerTimeoutMs: 0,
    clock,
    onProviderError: (providerId, error) => errors.push({ providerId, error }),
  });
  return { collector, errors };
}

function makeProvider(read: SignalProvider["read"]): SignalProvider {
  return {
    id: "shared-read-provider",
    signals: [{ name: SIGNAL_NAME, unit: "bytes" }],
    read,
  };
}

function okReading(value: number, observedAt: number): ResourceSignal {
  return {
    name: SIGNAL_NAME,
    unit: "bytes",
    status: "ok",
    value,
    observedAt,
    confidence: 1,
  };
}

describe("SignalCollector shared read stress", () => {
  it("shares one read across 12 callers when a subset aborts", async () => {
    const readStarted = deferred<void>();
    const release = deferred<readonly ResourceSignal[]>();
    let reads = 0;
    let providerAborts = 0;
    const provider = makeProvider((context) => {
      reads += 1;
      context.signal.addEventListener("abort", () => {
        providerAborts += 1;
      });
      readStarted.resolve();
      return release.promise;
    });
    const { collector, errors } = makeCollector(provider);

    const callers = Array.from({ length: 12 }, (_, index) => {
      const controller = new AbortController();
      return {
        index,
        controller,
        promise: collector.collect(NOW, controller.signal),
      };
    });
    await readStarted.promise;
    assert.equal(reads, 1);

    const aborted = callers.slice(1, 6).map((caller) => ({
      ...caller,
      reason: new Error(`caller-${caller.index}-aborted`),
    }));
    const rejectionChecks = aborted.map((caller) =>
      assert.rejects(caller.promise, (error: unknown) => error === caller.reason),
    );
    for (const caller of aborted) {
      caller.controller.abort(caller.reason);
    }
    await Promise.all(rejectionChecks);
    assert.equal(providerAborts, 0);

    const survivors = callers.filter((caller) => caller.index === 0 || caller.index >= 6);
    assert.equal(survivors.length, 7);
    release.resolve([okReading(42, NOW)]);

    const snapshots = await Promise.all(survivors.map((caller) => caller.promise));
    const firstSnapshot = snapshots[0];
    assert.ok(firstSnapshot !== undefined);
    assert.equal(firstSnapshot.cached, false);
    assert.equal(firstSnapshot.sequence, 1);
    assert.deepEqual(firstSnapshot.readings, [okReading(42, NOW)]);

    survivors.forEach((caller, position) => {
      const snapshot = snapshots[position];
      assert.ok(snapshot !== undefined);
      assert.equal(snapshot.cached, caller.index !== 0);
      assert.equal(snapshot.sequence, firstSnapshot.sequence);
      assert.equal(snapshot.collectedAt, firstSnapshot.collectedAt);
      assert.deepEqual(snapshot.readings, firstSnapshot.readings);
    });
    assert.equal(reads, 1);
    assert.equal(providerAborts, 0);
    assert.equal(errors.length, 0);

    await collector.close();
  });

  it("aborts a hanging read for the provider and starts a fresh uncached read later", async () => {
    const firstReadStarted = deferred<void>();
    const providerAborted = deferred<void>();
    let reads = 0;
    let providerSignalAborted = false;
    const provider = makeProvider((context) => {
      reads += 1;
      if (reads === 1) {
        context.signal.addEventListener(
          "abort",
          () => {
            providerSignalAborted = context.signal.aborted;
            providerAborted.resolve();
          },
          { once: true },
        );
        firstReadStarted.resolve();
        return new Promise<readonly ResourceSignal[]>(() => undefined);
      }
      return [okReading(7, context.now)];
    });
    const { collector, errors } = makeCollector(provider);

    const callers = Array.from({ length: 4 }, (_, index) => {
      const controller = new AbortController();
      return {
        controller,
        reason: new Error(`caller-${index}-aborted`),
        promise: collector.collect(NOW, controller.signal),
      };
    });
    await firstReadStarted.promise;
    assert.equal(reads, 1);

    const rejectionChecks = callers.map((caller) =>
      assert.rejects(caller.promise, (error: unknown) => error === caller.reason),
    );
    for (const caller of callers) {
      caller.controller.abort(caller.reason);
    }
    await Promise.all(rejectionChecks);
    await providerAborted.promise;
    assert.equal(providerSignalAborted, true);
    assert.equal(reads, 1);

    const fresh = await collector.collect(NOW, new AbortController().signal);
    assert.equal(fresh.cached, false);
    assert.deepEqual(fresh.readings, [okReading(7, NOW)]);
    assert.equal(reads, 2);
    assert.equal(errors.length, 0);

    await collector.close();
  });

  it("resolves close() during an in-flight read and lets the caller abort", async () => {
    const readStarted = deferred<void>();
    const providerAborted = deferred<void>();
    let providerSignalAborted = false;
    let providerClosed = false;
    const provider = makeProvider((context) => {
      context.signal.addEventListener(
        "abort",
        () => {
          providerSignalAborted = true;
          providerAborted.resolve();
        },
        { once: true },
      );
      readStarted.resolve();
      return new Promise<readonly ResourceSignal[]>(() => undefined);
    });
    const providerWithClose: SignalProvider = {
      ...provider,
      close: () => {
        providerClosed = true;
      },
    };
    const { collector, errors } = makeCollector(providerWithClose);
    const controller = new AbortController();
    const pending = collector.collect(NOW, controller.signal);
    await readStarted.promise;

    await collector.close();
    assert.equal(collector.closed, true);
    assert.equal(providerClosed, true);

    const reason = new Error("cleanup after close");
    const rejection = assert.rejects(pending);
    controller.abort(reason);
    await rejection;
    await providerAborted.promise;
    assert.equal(providerSignalAborted, true);
    assert.equal(errors.length, 0);
  });
});
