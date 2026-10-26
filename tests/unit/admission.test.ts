import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigurationError, OperationAbortedError } from "../../src/errors/index.js";
import {
  type AcquirePermitOptions,
  type AdaptiveLimiter,
  type AdaptiveLimiterOptions,
  AdmissionRejectedError,
  createAdaptiveLimiter,
  type LimiterLimitChangeEvent,
} from "../../src/runtime/admission.js";
import { createFakeClock } from "../../src/testing/index.js";

function admissionRejection(
  reason: "queue-full" | "timeout" | "closed",
  label?: string,
): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof AdmissionRejectedError, "expected AdmissionRejectedError");
    assert.equal(error.reason, reason);
    assert.equal(error.code, "ADMISSION_REJECTED");
    assert.equal(error.name, "AdmissionRejectedError");
    if (label !== undefined) {
      assert.ok(
        error.message.includes(`"${label}"`),
        `expected rejection message to mention ${label}`,
      );
    }
    return true;
  };
}

function abortRejection(label: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof OperationAbortedError, "expected OperationAbortedError");
    assert.equal(error.code, "OPERATION_ABORTED");
    assert.equal(error.name, "AbortError");
    assert.ok(error.message.includes(`"${label}"`));
    return true;
  };
}

async function releaseSuccess(limiter: AdaptiveLimiter): Promise<void> {
  const permit = await limiter.acquire();
  permit.release();
}

describe("createAdaptiveLimiter configuration", () => {
  it("applies documented defaults", () => {
    const limiter = createAdaptiveLimiter();
    const snapshot = limiter.getSnapshot();
    assert.equal(snapshot.limit, 8);
    assert.equal(snapshot.minLimit, 1);
    assert.equal(snapshot.maxLimit, 64);
    assert.equal(snapshot.inFlight, 0);
    assert.equal(snapshot.availablePermits, 8);
    assert.equal(snapshot.queueDepth, 0);
    assert.equal(snapshot.successCount, 0);
    assert.equal(snapshot.failureCount, 0);
    assert.equal(snapshot.shedCount, 0);
    assert.equal(snapshot.timeoutCount, 0);
    assert.equal(snapshot.limitChangeCount, 0);
    assert.equal(snapshot.ewmaLatencyMs, null);
    assert.equal(snapshot.closed, false);
    limiter.close();
  });

  it("accepts every documented boundary value", () => {
    const limiter = createAdaptiveLimiter({
      initialLimit: 1,
      minLimit: 1,
      maxLimit: 1,
      maxQueueSize: 0,
      acquireTimeoutMs: 0,
      increaseStep: 1,
      decreaseFactor: 0.99,
      increaseEvery: 1,
      latencyAlpha: 1,
      targetLatencyMs: 1,
      latencyThresholdRatio: 1,
    });
    assert.equal(limiter.getSnapshot().limit, 1);
    limiter.close();
  });

  it("rejects invalid configuration", () => {
    const invalid: ReadonlyArray<readonly [string, unknown]> = [
      ["null options", null],
      ["array options", []],
      ["initialLimit zero", { initialLimit: 0 }],
      ["initialLimit fractional", { initialLimit: 1.5 }],
      ["initialLimit NaN", { initialLimit: Number.NaN }],
      ["initialLimit infinity", { initialLimit: Number.POSITIVE_INFINITY }],
      ["minLimit zero", { minLimit: 0 }],
      ["maxLimit zero", { maxLimit: 0 }],
      ["initial below min", { initialLimit: 2, minLimit: 3 }],
      ["initial above max", { initialLimit: 9, maxLimit: 8 }],
      ["maxQueueSize negative", { maxQueueSize: -1 }],
      ["maxQueueSize fractional", { maxQueueSize: 1.5 }],
      ["acquireTimeoutMs negative", { acquireTimeoutMs: -1 }],
      ["acquireTimeoutMs infinite", { acquireTimeoutMs: Number.POSITIVE_INFINITY }],
      ["increaseStep zero", { increaseStep: 0 }],
      ["increaseStep fractional", { increaseStep: 2.5 }],
      ["decreaseFactor zero", { decreaseFactor: 0 }],
      ["decreaseFactor one", { decreaseFactor: 1 }],
      ["decreaseFactor above one", { decreaseFactor: 1.2 }],
      ["decreaseFactor NaN", { decreaseFactor: Number.NaN }],
      ["increaseEvery zero", { increaseEvery: 0 }],
      ["increaseEvery fractional", { increaseEvery: 3.5 }],
      ["latencyAlpha zero", { latencyAlpha: 0 }],
      ["latencyAlpha above one", { latencyAlpha: 1.1 }],
      ["targetLatencyMs zero", { targetLatencyMs: 0 }],
      ["targetLatencyMs negative", { targetLatencyMs: -5 }],
      ["targetLatencyMs NaN", { targetLatencyMs: Number.NaN }],
      ["latencyThresholdRatio below one", { latencyThresholdRatio: 0.5 }],
      ["latencyThresholdRatio infinite", { latencyThresholdRatio: Number.POSITIVE_INFINITY }],
      ["clock without now", { clock: { setTimeout: () => ({ cancel: () => undefined }) } }],
      ["clock without setTimeout", { clock: { now: () => 0 } }],
      ["onLimitChanged wrong type", { onLimitChanged: "nope" }],
      ["onShed wrong type", { onShed: 42 }],
    ];
    for (const [name, value] of invalid) {
      assert.throws(
        () => createAdaptiveLimiter(value as AdaptiveLimiterOptions),
        ConfigurationError,
        name,
      );
    }
  });

  it("validates acquire options and outcomes without consuming capacity", async () => {
    const limiter = createAdaptiveLimiter({ initialLimit: 2, minLimit: 1, maxLimit: 2 });
    await assert.rejects(
      limiter.acquire(null as unknown as AcquirePermitOptions),
      ConfigurationError,
    );
    await assert.rejects(limiter.acquire({ timeoutMs: -1 }), ConfigurationError);
    await assert.rejects(limiter.acquire({ timeoutMs: Number.NaN }), ConfigurationError);
    await assert.rejects(limiter.acquire({ label: "" }), ConfigurationError);
    await assert.rejects(limiter.acquire({ label: "   " }), ConfigurationError);
    await assert.rejects(
      limiter.acquire({ signal: {} as unknown as AbortSignal }),
      ConfigurationError,
    );

    let snapshot = limiter.getSnapshot();
    assert.equal(snapshot.inFlight, 0);
    assert.equal(snapshot.queueDepth, 0);
    assert.equal(snapshot.shedCount, 0);

    const permit = await limiter.acquire();
    assert.throws(() => permit.release({ latencyMs: -1 }), ConfigurationError);
    assert.throws(() => permit.release({ latencyMs: Number.NaN }), ConfigurationError);
    assert.throws(
      () => permit.release({ succeeded: "yes" as unknown as boolean }),
      ConfigurationError,
    );
    assert.equal(permit.released, false);
    assert.equal(limiter.getSnapshot().inFlight, 1);
    assert.throws(
      () => limiter.observe({ latencyMs: Number.POSITIVE_INFINITY }),
      ConfigurationError,
    );
    permit.release();
    assert.equal(permit.released, true);
    snapshot = limiter.getSnapshot();
    assert.equal(snapshot.failureCount, 0);
    assert.equal(snapshot.successCount, 1);
  });
});

describe("createAdaptiveLimiter acquisition", () => {
  it("issues monotonic permits and tracks in-flight state", async () => {
    const clock = createFakeClock(500);
    const limiter = createAdaptiveLimiter({ clock, initialLimit: 3, minLimit: 3, maxLimit: 3 });

    const first = await limiter.acquire();
    const second = await limiter.acquire();
    assert.equal(first.id, 1);
    assert.equal(first.acquiredAt, 500);
    assert.equal(first.released, false);
    assert.equal(second.id, 2);

    let snapshot = limiter.getSnapshot();
    assert.equal(snapshot.inFlight, 2);
    assert.equal(snapshot.availablePermits, 1);

    first.release();
    assert.equal(first.released, true);
    assert.equal(limiter.getSnapshot().inFlight, 1);

    first.release({ succeeded: false, latencyMs: 999 });
    snapshot = limiter.getSnapshot();
    assert.equal(snapshot.inFlight, 1);
    assert.equal(snapshot.successCount, 1);
    assert.equal(snapshot.failureCount, 0);
    assert.equal(snapshot.ewmaLatencyMs, null);

    second.release({ succeeded: true, latencyMs: 40 });
    snapshot = limiter.getSnapshot();
    assert.equal(snapshot.inFlight, 0);
    assert.equal(snapshot.successCount, 2);
    assert.equal(snapshot.ewmaLatencyMs, 40);
  });

  it("keeps permit ids monotonic across tryAcquire and queued grants", async () => {
    const limiter = createAdaptiveLimiter({
      initialLimit: 2,
      minLimit: 2,
      maxLimit: 2,
      maxQueueSize: 1,
    });
    const first = await limiter.acquire();
    const second = limiter.tryAcquire();
    assert.ok(second !== null);
    assert.equal(first.id, 1);
    assert.equal(second.id, 2);

    const queued = limiter.acquire();
    first.release();
    const third = await queued;
    assert.equal(third.id, 3);
    assert.equal(limiter.getSnapshot().inFlight, 2);

    second.release();
    third.release();
    assert.equal(limiter.getSnapshot().inFlight, 0);
  });

  it("transfers a released slot to the oldest waiter in FIFO order", async () => {
    const limiter = createAdaptiveLimiter({
      initialLimit: 1,
      minLimit: 1,
      maxLimit: 1,
      maxQueueSize: 3,
    });
    const holder = await limiter.acquire();
    const order: string[] = [];
    const second = limiter.acquire({ label: "second" }).then((permit) => {
      order.push("second");
      return permit;
    });
    const third = limiter.acquire({ label: "third" }).then((permit) => {
      order.push("third");
      return permit;
    });
    assert.equal(limiter.getSnapshot().queueDepth, 2);

    holder.release();
    const secondPermit = await second;
    assert.deepEqual(order, ["second"]);
    let snapshot = limiter.getSnapshot();
    assert.equal(snapshot.inFlight, 1);
    assert.equal(snapshot.queueDepth, 1);

    secondPermit.release();
    const thirdPermit = await third;
    assert.deepEqual(order, ["second", "third"]);
    snapshot = limiter.getSnapshot();
    assert.equal(snapshot.inFlight, 1);
    assert.equal(snapshot.queueDepth, 0);

    thirdPermit.release();
    assert.equal(limiter.getSnapshot().inFlight, 0);
  });

  it("sheds queue-full acquisitions and calls onShed", async () => {
    const shed: Array<{ readonly reason: string }> = [];
    const limiter = createAdaptiveLimiter({
      initialLimit: 1,
      minLimit: 1,
      maxLimit: 1,
      maxQueueSize: 1,
      onShed: (event) => shed.push(event),
    });
    const holder = await limiter.acquire();
    const queued = limiter.acquire({ label: "queued" });
    await assert.rejects(limiter.acquire({ label: "overflow" }), admissionRejection("queue-full"));
    let snapshot = limiter.getSnapshot();
    assert.equal(snapshot.shedCount, 1);
    assert.equal(snapshot.queueDepth, 1);
    assert.equal(shed.length, 1);
    assert.deepEqual(shed[0], { reason: "queue-full" });

    holder.release();
    const granted = await queued;
    snapshot = limiter.getSnapshot();
    assert.equal(snapshot.inFlight, 1);
    granted.release();
  });

  it("tryAcquire sheds when no permit is available", async () => {
    const shed: Array<{ readonly reason: string }> = [];
    const limiter = createAdaptiveLimiter({
      initialLimit: 1,
      minLimit: 1,
      maxLimit: 1,
      onShed: (event) => shed.push(event),
    });
    const holder = limiter.tryAcquire();
    assert.ok(holder !== null);
    assert.equal(limiter.tryAcquire(), null);
    const snapshot = limiter.getSnapshot();
    assert.equal(snapshot.shedCount, 1);
    assert.deepEqual(shed, [{ reason: "no-permit" }]);

    holder.release();
    const granted = limiter.tryAcquire();
    assert.ok(granted !== null);
    assert.equal(granted.id, 2);
    granted.release();
  });

  it("clamps availablePermits at zero after a decrease", async () => {
    const limiter = createAdaptiveLimiter({
      initialLimit: 4,
      minLimit: 1,
      maxLimit: 4,
      decreaseFactor: 0.5,
    });
    const permits = await Promise.all([
      limiter.acquire(),
      limiter.acquire(),
      limiter.acquire(),
      limiter.acquire(),
    ]);
    permits[0]?.release({ succeeded: false });
    const snapshot = limiter.getSnapshot();
    assert.equal(snapshot.limit, 2);
    assert.equal(snapshot.inFlight, 3);
    assert.equal(snapshot.availablePermits, 0);
    permits[1]?.release();
    permits[2]?.release();
    permits[3]?.release();
    assert.equal(limiter.getSnapshot().inFlight, 0);
  });
});

describe("createAdaptiveLimiter timeouts and aborts", () => {
  it("times out a queued acquire and clears its timer", async () => {
    const clock = createFakeClock(1_000);
    const shed: string[] = [];
    const limiter = createAdaptiveLimiter({
      initialLimit: 1,
      minLimit: 1,
      maxLimit: 1,
      maxQueueSize: 2,
      acquireTimeoutMs: 100,
      clock,
      onShed: (event) => shed.push(event.reason),
    });
    const holder = await limiter.acquire();
    const pending = limiter.acquire({ label: "timed" });
    assert.equal(clock.pendingTimers(), 1);
    clock.advance(99);
    assert.equal(limiter.getSnapshot().timeoutCount, 0);
    clock.advance(1);
    await assert.rejects(pending, admissionRejection("timeout", "timed"));

    const snapshot = limiter.getSnapshot();
    assert.equal(snapshot.queueDepth, 0);
    assert.equal(snapshot.shedCount, 1);
    assert.equal(snapshot.timeoutCount, 1);
    assert.equal(clock.pendingTimers(), 0);
    assert.deepEqual(shed, ["timeout"]);

    holder.release();
    assert.equal(limiter.getSnapshot().inFlight, 0);
  });

  it("honors per-acquire timeout overrides, including disabling", async () => {
    const clock = createFakeClock(0);
    const limiter = createAdaptiveLimiter({
      initialLimit: 1,
      minLimit: 1,
      maxLimit: 1,
      maxQueueSize: 2,
      acquireTimeoutMs: 50,
      clock,
    });
    const holder = await limiter.acquire();
    const extended = limiter.acquire({ timeoutMs: 200 });
    clock.advance(50);
    assert.equal(limiter.getSnapshot().timeoutCount, 0);
    clock.advance(150);
    await assert.rejects(extended, admissionRejection("timeout"));

    const disabled = limiter.acquire({ timeoutMs: 0 });
    assert.equal(clock.pendingTimers(), 0);
    holder.release();
    const granted = await disabled;
    assert.equal(limiter.getSnapshot().inFlight, 1);
    granted.release();
  });

  it("rejects an already-aborted signal before queueing", async () => {
    const limiter = createAdaptiveLimiter({ maxQueueSize: 2 });
    const controller = new AbortController();
    controller.abort("cancelled");
    await assert.rejects(
      limiter.acquire({ signal: controller.signal, label: "pre" }),
      abortRejection("pre"),
    );
    const snapshot = limiter.getSnapshot();
    assert.equal(snapshot.inFlight, 0);
    assert.equal(snapshot.queueDepth, 0);
    assert.equal(snapshot.shedCount, 0);
  });

  it("removes a queued waiter on abort and clears its timer", async () => {
    const clock = createFakeClock(0);
    const limiter = createAdaptiveLimiter({
      initialLimit: 1,
      minLimit: 1,
      maxLimit: 1,
      maxQueueSize: 1,
      acquireTimeoutMs: 1_000,
      clock,
    });
    const controller = new AbortController();
    const holder = await limiter.acquire();
    const pending = limiter.acquire({ signal: controller.signal, label: "mid" });
    assert.equal(clock.pendingTimers(), 1);

    controller.abort();
    await assert.rejects(pending, abortRejection("mid"));
    const snapshot = limiter.getSnapshot();
    assert.equal(snapshot.queueDepth, 0);
    assert.equal(snapshot.shedCount, 0);
    assert.equal(snapshot.timeoutCount, 0);
    assert.equal(clock.pendingTimers(), 0);
    holder.release();
  });
});

describe("createAdaptiveLimiter withPermit", () => {
  it("measures latency, releases the permit, and returns the task result", async () => {
    const clock = createFakeClock(1_000);
    const limiter = createAdaptiveLimiter({ clock, initialLimit: 2, minLimit: 1, maxLimit: 2 });
    const result = await limiter.withPermit(() => {
      clock.advance(25);
      return "value";
    });
    assert.equal(result, "value");
    const snapshot = limiter.getSnapshot();
    assert.equal(snapshot.inFlight, 0);
    assert.equal(snapshot.successCount, 1);
    assert.equal(snapshot.ewmaLatencyMs, 25);
  });

  it("supports async tasks and passes through their resolved value", async () => {
    const clock = createFakeClock(2_000);
    const limiter = createAdaptiveLimiter({ clock, initialLimit: 1, minLimit: 1, maxLimit: 1 });
    const result = await limiter.withPermit(async () => {
      clock.advance(7);
      await Promise.resolve();
      return 42;
    });
    assert.equal(result, 42);
    assert.equal(limiter.getSnapshot().ewmaLatencyMs, 7);
    assert.equal(limiter.getSnapshot().inFlight, 0);
  });

  it("records failure and rethrows the original task error", async () => {
    const clock = createFakeClock(3_000);
    const limiter = createAdaptiveLimiter({ clock, initialLimit: 8, minLimit: 1, maxLimit: 8 });
    const failure = new Error("downstream failed");
    await assert.rejects(
      limiter.withPermit(async () => {
        clock.advance(10);
        throw failure;
      }),
      (error: unknown) => error === failure,
    );
    const snapshot = limiter.getSnapshot();
    assert.equal(snapshot.inFlight, 0);
    assert.equal(snapshot.failureCount, 1);
    assert.equal(snapshot.limit, 6);
    assert.equal(snapshot.ewmaLatencyMs, 10);
  });

  it("rejects closed limiters and invalid tasks", async () => {
    const limiter = createAdaptiveLimiter();
    await assert.rejects(
      limiter.withPermit(undefined as unknown as () => void),
      ConfigurationError,
    );
    limiter.close();
    await assert.rejects(
      limiter.withPermit(() => "never"),
      admissionRejection("closed"),
    );
  });
});

describe("createAdaptiveLimiter AIMD", () => {
  it("increases after increaseEvery successes and clamps at maxLimit", async () => {
    const events: LimiterLimitChangeEvent[] = [];
    const limiter = createAdaptiveLimiter({
      initialLimit: 1,
      minLimit: 1,
      maxLimit: 3,
      increaseEvery: 3,
      increaseStep: 2,
      onLimitChanged: (event) => events.push(event),
    });

    for (let i = 0; i < 3; i += 1) {
      await releaseSuccess(limiter);
    }
    let snapshot = limiter.getSnapshot();
    assert.equal(snapshot.limit, 3);
    assert.equal(snapshot.limitChangeCount, 1);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], { previousLimit: 1, limit: 3, reason: "increase" });
    assert.equal(Object.isFrozen(events[0]), true);

    for (let i = 0; i < 3; i += 1) {
      await releaseSuccess(limiter);
    }
    snapshot = limiter.getSnapshot();
    assert.equal(snapshot.limit, 3);
    assert.equal(snapshot.limitChangeCount, 1);
    assert.equal(events.length, 1);
  });

  it("applies multiplicative decrease on failure down to minLimit", async () => {
    const events: LimiterLimitChangeEvent[] = [];
    const limiter = createAdaptiveLimiter({
      initialLimit: 8,
      minLimit: 1,
      maxLimit: 16,
      decreaseFactor: 0.8,
      onLimitChanged: (event) => events.push(event),
    });
    for (let i = 0; i < 5; i += 1) {
      const permit = await limiter.acquire();
      permit.release({ succeeded: false });
    }
    let snapshot = limiter.getSnapshot();
    assert.equal(snapshot.limit, 1);
    assert.equal(snapshot.failureCount, 5);
    assert.equal(snapshot.limitChangeCount, 5);
    assert.deepEqual(
      events.map((event) => [event.previousLimit, event.limit]),
      [
        [8, 6],
        [6, 4],
        [4, 3],
        [3, 2],
        [2, 1],
      ],
    );

    const permit = await limiter.acquire();
    permit.release({ succeeded: false });
    snapshot = limiter.getSnapshot();
    assert.equal(snapshot.limit, 1);
    assert.equal(snapshot.limitChangeCount, 5);
    assert.equal(events.length, 5);
  });

  it("resets the success streak after a failure", async () => {
    const limiter = createAdaptiveLimiter({
      initialLimit: 2,
      minLimit: 1,
      maxLimit: 4,
      increaseEvery: 2,
    });
    const first = await limiter.acquire();
    first.release();
    const failed = await limiter.acquire();
    failed.release({ succeeded: false });
    assert.equal(limiter.getSnapshot().limit, 1);

    const second = await limiter.acquire();
    second.release();
    assert.equal(limiter.getSnapshot().limit, 1);

    const third = await limiter.acquire();
    third.release();
    assert.equal(limiter.getSnapshot().limit, 2);
  });

  it("decreases under latency pressure even for successful outcomes", async () => {
    const events: LimiterLimitChangeEvent[] = [];
    const limiter = createAdaptiveLimiter({
      initialLimit: 4,
      minLimit: 1,
      maxLimit: 4,
      targetLatencyMs: 100,
      latencyThresholdRatio: 1.5,
      latencyAlpha: 0.5,
      decreaseFactor: 0.8,
      onLimitChanged: (event) => events.push(event),
    });

    const first = await limiter.acquire();
    first.release({ latencyMs: 100 });
    assert.equal(limiter.getSnapshot().limit, 4);

    const second = await limiter.acquire();
    second.release({ latencyMs: 200 });
    assert.equal(limiter.getSnapshot().ewmaLatencyMs, 150);
    assert.equal(limiter.getSnapshot().limit, 4);

    const third = await limiter.acquire();
    third.release({ latencyMs: 300 });
    const snapshot = limiter.getSnapshot();
    assert.equal(snapshot.ewmaLatencyMs, 225);
    assert.equal(snapshot.successCount, 3);
    assert.equal(snapshot.limit, 3);
    assert.equal(snapshot.limitChangeCount, 1);
    assert.deepEqual(events, [{ previousLimit: 4, limit: 3, reason: "decrease" }]);
  });

  it("smooths EWMA samples with latencyAlpha", async () => {
    const limiter = createAdaptiveLimiter({
      initialLimit: 4,
      minLimit: 1,
      maxLimit: 4,
      latencyAlpha: 0.5,
    });
    const first = await limiter.acquire();
    first.release({ latencyMs: 100 });
    assert.equal(limiter.getSnapshot().ewmaLatencyMs, 100);
    const second = await limiter.acquire();
    second.release({ latencyMs: 200 });
    assert.equal(limiter.getSnapshot().ewmaLatencyMs, 150);
    const third = await limiter.acquire();
    third.release({ latencyMs: 0 });
    assert.equal(limiter.getSnapshot().ewmaLatencyMs, 75);
  });

  it("observe feeds AIMD without changing in-flight", async () => {
    const limiter = createAdaptiveLimiter({
      initialLimit: 1,
      minLimit: 1,
      maxLimit: 4,
      increaseEvery: 2,
    });
    const permit = await limiter.acquire();
    limiter.observe({ succeeded: true });
    limiter.observe({ succeeded: true, latencyMs: 20 });
    let snapshot = limiter.getSnapshot();
    assert.equal(snapshot.inFlight, 1);
    assert.equal(snapshot.limit, 2);
    assert.equal(snapshot.successCount, 2);
    assert.equal(snapshot.ewmaLatencyMs, 20);

    limiter.observe({ succeeded: false });
    snapshot = limiter.getSnapshot();
    assert.equal(snapshot.inFlight, 1);
    assert.equal(snapshot.limit, 1);
    assert.equal(snapshot.failureCount, 1);
    permit.release();
    assert.equal(limiter.getSnapshot().inFlight, 0);
  });

  it("admits a queued waiter when observe raises the limit", async () => {
    const limiter = createAdaptiveLimiter({
      initialLimit: 1,
      minLimit: 1,
      maxLimit: 2,
      maxQueueSize: 1,
      increaseEvery: 1,
    });
    const holder = await limiter.acquire();
    const queued = limiter.acquire({ label: "queued" });
    assert.equal(limiter.getSnapshot().queueDepth, 1);
    assert.equal(limiter.getSnapshot().inFlight, 1);

    limiter.observe({ succeeded: true });
    const admitted = await queued;
    const snapshot = limiter.getSnapshot();
    assert.equal(snapshot.limit, 2);
    assert.equal(snapshot.inFlight, 2);
    assert.equal(snapshot.queueDepth, 0);

    admitted.release();
    holder.release();
    assert.equal(limiter.getSnapshot().inFlight, 0);
  });
});

describe("createAdaptiveLimiter close", () => {
  it("rejects queued waiters, clears timers, and is idempotent", async () => {
    const clock = createFakeClock(0);
    const limiter = createAdaptiveLimiter({
      initialLimit: 1,
      minLimit: 1,
      maxLimit: 1,
      maxQueueSize: 3,
      acquireTimeoutMs: 500,
      clock,
    });
    const holder = await limiter.acquire();
    const first = limiter.acquire({ label: "first" });
    const second = limiter.acquire({ label: "second" });
    const firstRejection = assert.rejects(first, admissionRejection("closed", "first"));
    const secondRejection = assert.rejects(second, admissionRejection("closed", "second"));
    assert.equal(clock.pendingTimers(), 2);

    limiter.close();
    assert.equal(clock.pendingTimers(), 0);
    await firstRejection;
    await secondRejection;

    limiter.close();
    const snapshot = limiter.getSnapshot();
    assert.equal(snapshot.closed, true);
    assert.equal(snapshot.queueDepth, 0);
    assert.equal(snapshot.inFlight, 1);
    assert.equal(snapshot.shedCount, 0);
    assert.equal(snapshot.timeoutCount, 0);

    holder.release();
    assert.equal(limiter.getSnapshot().inFlight, 0);

    await assert.rejects(limiter.acquire(), admissionRejection("closed"));
    assert.equal(limiter.getSnapshot().shedCount, 0);
    assert.equal(limiter.tryAcquire(), null);
  });

  it("does not grant permits to waiters rejected by close", async () => {
    const limiter = createAdaptiveLimiter({
      initialLimit: 1,
      minLimit: 1,
      maxLimit: 1,
      maxQueueSize: 1,
    });
    const holder = await limiter.acquire();
    const queued = limiter.acquire();
    const rejection = assert.rejects(queued, admissionRejection("closed"));
    limiter.close();
    await rejection;
    holder.release();
    const snapshot = limiter.getSnapshot();
    assert.equal(snapshot.inFlight, 0);
    assert.equal(snapshot.queueDepth, 0);
  });
});

describe("createAdaptiveLimiter frozen outputs", () => {
  it("freezes snapshots, limit-change events, and permits", async () => {
    let captured: LimiterLimitChangeEvent | undefined;
    const limiter = createAdaptiveLimiter({
      initialLimit: 1,
      minLimit: 1,
      maxLimit: 2,
      increaseEvery: 1,
      onLimitChanged: (event) => {
        captured = event;
      },
    });
    const permit = await limiter.acquire();
    assert.equal(Object.isFrozen(permit), true);
    permit.release();

    const snapshot = limiter.getSnapshot();
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(snapshot.limit, 2);
    assert.ok(captured !== undefined);
    assert.equal(Object.isFrozen(captured), true);
    assert.deepEqual(captured, { previousLimit: 1, limit: 2, reason: "increase" });

    const mutableSnapshot = snapshot as unknown as { limit: number };
    assert.throws(() => {
      mutableSnapshot.limit = 99;
    }, TypeError);
    assert.equal(limiter.getSnapshot().limit, 2);

    const mutableEvent = captured as unknown as { limit: number };
    assert.throws(() => {
      mutableEvent.limit = 99;
    }, TypeError);
    assert.equal(limiter.getSnapshot().limitChangeCount, 1);
  });
});
