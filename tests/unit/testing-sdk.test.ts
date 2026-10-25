import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigurationError } from "../../src/errors/index.js";
import { createErrorRateGuardSelector } from "../../src/policy/selectors.js";
import {
  CompositeSignalProvider,
  ComputePressureProvider,
  CpuUtilizationProvider,
  DeviceMemoryProvider,
  EventLoopDelayProvider,
  EventLoopUtilizationProvider,
  ExecutionBudgetProvider,
  FrameTimingProvider,
  NetworkInformationProvider,
  NetworkLatencyProvider,
  ProcessMemoryProvider,
} from "../../src/providers/index.js";
import {
  createFakeClock,
  InvalidConfigurationError,
  runProviderConformanceCheck,
  type ScriptedSignal,
  ScriptedSignalProvider,
  type SimulatedStrategy,
  simulatePolicyTimeline,
} from "../../src/testing/index.js";
import type {
  ResourceSignal,
  SignalDescriptor,
  SignalProvider,
  SignalReadContext,
} from "../../src/types/signals.js";
import { requireOk } from "../helpers/providers.js";

function basicScript(): readonly ScriptedSignal[] {
  return [
    {
      name: "test.load",
      unit: "ratio",
      description: "Scripted load.",
      values: [0.1, 0.5, { status: "unsupported", error: "not available" }],
    },
  ];
}

describe("createFakeClock", () => {
  it("starts at zero, accepts an initial time, and supports set/advance", () => {
    const clock = createFakeClock();
    assert.equal(clock.now(), 0);
    clock.set(500);
    assert.equal(clock.now(), 500);
    clock.advance(250);
    assert.equal(clock.now(), 750);

    const initialized = createFakeClock(1_000);
    assert.equal(initialized.now(), 1_000);
  });

  it("executes timers in time and insertion order", () => {
    const clock = createFakeClock(100);
    const order: string[] = [];

    clock.setTimeout(() => order.push("late"), 20);
    clock.setTimeout(() => order.push("first"), 10);
    clock.setTimeout(() => order.push("second"), 10);
    assert.equal(clock.pendingTimers(), 3);

    clock.advance(10);
    assert.deepEqual(order, ["first", "second"]);
    assert.equal(clock.now(), 110);
    assert.equal(clock.pendingTimers(), 1);

    clock.advance(10);
    assert.deepEqual(order, ["first", "second", "late"]);
    assert.equal(clock.pendingTimers(), 0);
  });

  it("executes timers scheduled from callbacks within the same advance", () => {
    const clock = createFakeClock();
    const order: string[] = [];
    clock.setTimeout(() => {
      order.push("outer");
      clock.setTimeout(() => order.push("inner"), 5);
    }, 5);

    clock.advance(10);
    assert.deepEqual(order, ["outer", "inner"]);
    assert.equal(clock.now(), 10);
  });

  it("does not fire cancelled timers and fires overdue timers on advance(0)", () => {
    const clock = createFakeClock(100);
    let fired = 0;
    const timer = clock.setTimeout(() => {
      fired += 1;
    }, 5);

    timer.cancel();
    assert.equal(clock.pendingTimers(), 0);
    clock.advance(10);
    assert.equal(fired, 0);

    clock.setTimeout(() => {
      fired += 1;
    }, 1);
    clock.set(200);
    assert.equal(fired, 0);
    clock.advance(0);
    assert.equal(fired, 1);
  });

  it("rejects invalid constructor, delay, advance, set, and callback inputs", () => {
    assert.throws(() => createFakeClock(Number.NaN), RangeError);
    assert.throws(() => createFakeClock(-1), RangeError);

    const clock = createFakeClock();
    assert.throws(() => clock.setTimeout(null as unknown as () => void, 1), TypeError);
    assert.throws(() => clock.setTimeout(() => undefined, Number.NaN), RangeError);
    assert.throws(() => clock.setTimeout(() => undefined, -1), RangeError);
    assert.throws(() => clock.advance(Number.POSITIVE_INFINITY), RangeError);
    assert.throws(() => clock.advance(-1), RangeError);
    assert.throws(() => clock.set(Number.NaN), RangeError);
    assert.throws(() => clock.set(-1), RangeError);
  });
});

describe("ScriptedSignalProvider", () => {
  it("declares signals and replays values, repeating the last value by default", () => {
    const provider = new ScriptedSignalProvider({ script: basicScript() });
    assert.equal(provider.id, "scripted-signals");
    assert.deepEqual(provider.signals, [
      { name: "test.load", unit: "ratio", description: "Scripted load." },
    ]);

    const first = provider.read({ now: 10, signal: new AbortController().signal });
    const firstReading = requireOk(first[0]);
    assert.equal(firstReading.value, 0.1);
    assert.equal(firstReading.observedAt, 10);
    assert.equal(firstReading.confidence, 1);

    const second = provider.read({ now: 20, signal: new AbortController().signal });
    assert.equal(requireOk(second[0]).value, 0.5);

    const third = provider.read({ now: 30, signal: new AbortController().signal });
    assert.equal(third[0]?.status, "unsupported");
    assert.equal(third[0]?.error, "not available");

    const fourth = provider.read({ now: 40, signal: new AbortController().signal });
    assert.equal(fourth[0]?.status, "unsupported");
  });

  it("supports multiple signals with different script lengths", () => {
    const provider = new ScriptedSignalProvider({
      id: "multi-script",
      script: [
        { name: "a", unit: "count", values: [1] },
        { name: "b", unit: "milliseconds", values: [10, 20] },
      ],
    });

    assert.equal(
      requireOk(provider.read({ now: 1, signal: new AbortController().signal })[0]).value,
      1,
    );
    const second = provider.read({ now: 2, signal: new AbortController().signal });
    assert.equal(requireOk(second[0]).value, 1);
    assert.equal(requireOk(second[1]).value, 20);
  });

  it("reports unknown after exhaustion when repeatLast is false", () => {
    const provider = new ScriptedSignalProvider({
      script: [{ name: "a", unit: "count", values: [1] }],
      repeatLast: false,
    });

    assert.equal(
      requireOk(provider.read({ now: 1, signal: new AbortController().signal })[0]).value,
      1,
    );
    const exhausted = provider.read({ now: 2, signal: new AbortController().signal });
    assert.equal(exhausted[0]?.status, "unknown");
    assert.match(exhausted[0]?.error ?? "", /exhausted/);
  });

  it("reset restarts the script and close makes readings explicitly unsupported", () => {
    const provider = new ScriptedSignalProvider({ script: basicScript() });
    provider.read({ now: 1, signal: new AbortController().signal });
    provider.reset();
    assert.equal(
      requireOk(provider.read({ now: 2, signal: new AbortController().signal })[0]).value,
      0.1,
    );

    provider.close();
    const closed = provider.read({ now: 3, signal: new AbortController().signal });
    assert.equal(closed[0]?.status, "unsupported");
    assert.match(closed[0]?.error ?? "", /closed/);
  });

  it("supports unavailable statuses without an explicit error", () => {
    const provider = new ScriptedSignalProvider({
      script: [
        {
          name: "a",
          unit: "count",
          values: [{ status: "stale" }, { status: "error" }, { status: "unknown" }],
        },
      ],
    });

    assert.equal(
      provider.read({ now: 1, signal: new AbortController().signal })[0]?.status,
      "stale",
    );
    assert.equal(
      provider.read({ now: 2, signal: new AbortController().signal })[0]?.status,
      "error",
    );
    assert.equal(
      provider.read({ now: 3, signal: new AbortController().signal })[0]?.status,
      "unknown",
    );
  });

  it("validates constructor input thoroughly", () => {
    assert.throws(
      () => new ScriptedSignalProvider(null as unknown as { script: readonly ScriptedSignal[] }),
      /options object/,
    );
    assert.throws(() => new ScriptedSignalProvider({ script: [] }), /non-empty script/);
    assert.throws(() => new ScriptedSignalProvider({ script: basicScript(), id: "" }), /non-empty/);
    assert.throws(
      () => new ScriptedSignalProvider({ script: basicScript(), id: " padded " }),
      /whitespace/,
    );
    assert.throws(
      () =>
        new ScriptedSignalProvider({
          script: basicScript(),
          repeatLast: "yes" as unknown as boolean,
        }),
      /repeatLast/,
    );
  });

  it("validates every scripted signal field", () => {
    const invalid =
      (script: unknown): (() => void) =>
      () =>
        new ScriptedSignalProvider({ script: script as readonly ScriptedSignal[] });

    assert.throws(invalid([null]), /must be an object/);
    assert.throws(invalid([{ name: "", unit: "count", values: [1] }]), /name/);
    assert.throws(invalid([{ name: " padded", unit: "count", values: [1] }]), /name/);
    assert.throws(
      invalid([
        { name: "a", unit: "count", values: [1] },
        { name: "a", unit: "count", values: [1] },
      ]),
      /Duplicate/,
    );
    assert.throws(invalid([{ name: "a", unit: "bogus", values: [1] }]), /unit/);
    assert.throws(
      invalid([{ name: "a", unit: "count", values: [1], description: 42 }]),
      /description/,
    );
    assert.throws(invalid([{ name: "a", unit: "count", values: [] }]), /values/);
    assert.throws(invalid([{ name: "a", unit: "count", values: [Number.NaN] }]), /finite/);
    assert.throws(invalid([{ name: "a", unit: "count", values: [null] }]), /finite/);
    assert.throws(
      invalid([{ name: "a", unit: "count", values: [{ status: "ok", value: 1 }] }]),
      /status/,
    );
    assert.throws(
      invalid([{ name: "a", unit: "count", values: [{ status: "unknown", error: 42 }] }]),
      /error/,
    );
  });
});

describe("runProviderConformanceCheck", () => {
  it("passes a valid provider, verifying double start/close idempotency and concurrent reads", async () => {
    let starts = 0;
    let reads = 0;
    let closes = 0;
    let closed = false;
    const provider: SignalProvider = {
      id: "conforming",
      signals: [{ name: "test.value", unit: "count", description: "A value." }],
      start: () => {
        starts += 1;
      },
      read: (context) => {
        reads += 1;
        return [
          closed
            ? {
                name: "test.value",
                unit: "count",
                status: "unsupported",
                observedAt: context.now,
                error: "Provider is closed.",
              }
            : {
                name: "test.value",
                unit: "count",
                status: "ok",
                value: 7,
                observedAt: context.now,
                confidence: 0.5,
              },
        ];
      },
      close: () => {
        closes += 1;
        closed = true;
      },
    };

    const report = await runProviderConformanceCheck(provider, { now: 42 });
    assert.equal(report.ok, true);
    assert.equal(report.providerId, "conforming");
    assert.ok(report.checksPassed > 0);
    assert.deepEqual(report.failures, []);
    assert.equal(starts, 2);
    assert.equal(reads, 4);
    assert.equal(closes, 2);
  });

  it("reports when provider.start() is not idempotent (second start throws)", async () => {
    let starts = 0;
    const provider: SignalProvider = {
      id: "non-idempotent-start",
      signals: [{ name: "test.value", unit: "count" }],
      start: () => {
        starts += 1;
        if (starts > 1) {
          throw new Error("Already started");
        }
      },
      read: (context) => [
        { name: "test.value", unit: "count", status: "ok", value: 1, observedAt: context.now },
      ],
    };
    const report = await runProviderConformanceCheck(provider);
    assert.equal(report.ok, false);
    assert.match(report.failures.join(" "), /provider\.start\(\) threw or rejected on second call/);
  });

  it("reports when provider.close() is not idempotent (second close throws)", async () => {
    let closes = 0;
    const provider: SignalProvider = {
      id: "non-idempotent-close",
      signals: [{ name: "test.value", unit: "count" }],
      read: (context) => [
        { name: "test.value", unit: "count", status: "ok", value: 1, observedAt: context.now },
      ],
      close: () => {
        closes += 1;
        if (closes > 1) {
          throw new Error("Already closed");
        }
      },
    };
    const report = await runProviderConformanceCheck(provider, { checkPostClose: false });
    assert.equal(report.ok, false);
    assert.match(report.failures.join(" "), /provider\.close\(\) threw or rejected on second call/);
  });

  it("reports when concurrent provider.read() throws or rejects", async () => {
    let callCount = 0;
    const provider: SignalProvider = {
      id: "failing-concurrent-read",
      signals: [{ name: "test.value", unit: "count" }],
      read: (context) => {
        callCount += 1;
        if (callCount > 1) {
          throw new Error("Concurrent read conflict");
        }
        return [
          { name: "test.value", unit: "count", status: "ok", value: 1, observedAt: context.now },
        ];
      },
    };
    const report = await runProviderConformanceCheck(provider, { checkPostClose: false });
    assert.equal(report.ok, false);
    assert.match(report.failures.join(" "), /concurrent provider\.read\(\) threw or rejected/);
  });

  it("reports when concurrent provider.read() returns malformed or non-array results", async () => {
    let callCount = 0;
    const provider: SignalProvider = {
      id: "corrupted-concurrent-read",
      signals: [{ name: "test.value", unit: "count" }],
      read: (context) => {
        callCount += 1;
        if (callCount === 2) {
          return "not-an-array" as unknown as readonly ResourceSignal[];
        }
        return [
          { name: "test.value", unit: "count", status: "ok", value: 1, observedAt: context.now },
        ];
      },
    };
    const report = await runProviderConformanceCheck(provider, { checkPostClose: false });
    assert.equal(report.ok, false);
    assert.match(
      report.failures.join(" "),
      /concurrent provider\.read\(\) calls must both return arrays/,
    );
  });

  it("skips the post-close read when checkPostClose is false", async () => {
    let reads = 0;
    const provider: SignalProvider = {
      id: "skip-post-close",
      signals: [{ name: "test.value", unit: "count" }],
      read: (context) => {
        reads += 1;
        return [
          {
            name: "test.value",
            unit: "count",
            status: "ok",
            value: 1,
            observedAt: context.now,
          },
        ];
      },
      close: () => undefined,
    };

    const report = await runProviderConformanceCheck(provider, { checkPostClose: false });
    assert.equal(report.ok, true);
    assert.equal(reads, 3);
  });

  it("reports post-close readings that are not unsupported", async () => {
    const provider: SignalProvider = {
      id: "still-live",
      signals: [{ name: "test.value", unit: "count" }],
      read: (context) => [
        {
          name: "test.value",
          unit: "count",
          status: "ok",
          value: 1,
          observedAt: context.now,
        },
      ],
      close: () => undefined,
    };

    const report = await runProviderConformanceCheck(provider);
    assert.equal(report.ok, false);
    assert.match(report.failures.join(" "), /status "unsupported" after close\(\)/);
  });

  it("reports throwing and malformed post-close reads", async () => {
    const throwing: SignalProvider = {
      id: "throwing-post-close",
      signals: [{ name: "test.value", unit: "count" }],
      read: () => [
        {
          name: "test.value",
          unit: "count",
          status: "ok",
          value: 1,
          observedAt: 1_000_000,
        },
      ],
      close: () => {
        throw new Error("close failed");
      },
    };
    const throwReport = await runProviderConformanceCheck(throwing);
    assert.match(throwReport.failures.join(" "), /close\(\) threw/);
    // A failed close must not trigger the post-close read.
    assert.doesNotMatch(throwReport.failures.join(" "), /after close/);

    let closed = false;
    const malformed: SignalProvider = {
      id: "malformed-post-close",
      signals: [{ name: "test.value", unit: "count" }],
      read: (context) =>
        closed
          ? (undefined as unknown as readonly ResourceSignal[])
          : [
              {
                name: "test.value",
                unit: "count",
                status: "ok",
                value: 1,
                observedAt: context.now,
              },
            ],
      close: () => {
        closed = true;
      },
    };
    const malformedReport = await runProviderConformanceCheck(malformed);
    assert.match(malformedReport.failures.join(" "), /after close\(\) must return an array/);

    let closeThenThrow = false;
    const postCloseThrow: SignalProvider = {
      id: "post-close-throw",
      signals: [{ name: "test.value", unit: "count" }],
      read: (context) => {
        if (closeThenThrow) {
          throw new Error("post-close read failed");
        }
        return [
          {
            name: "test.value",
            unit: "count",
            status: "ok",
            value: 1,
            observedAt: context.now,
          },
        ];
      },
      close: () => {
        closeThenThrow = true;
      },
    };
    const postCloseThrowReport = await runProviderConformanceCheck(postCloseThrow);
    assert.match(postCloseThrowReport.failures.join(" "), /after close\(\) threw/);
  });

  it("accepts drainProviderErrors implementations that return an array", async () => {
    let drains = 0;
    const provider: SignalProvider = {
      id: "draining",
      signals: [{ name: "test.value", unit: "count" }],
      read: (context) => [
        {
          name: "test.value",
          unit: "count",
          status: "ok",
          value: 1,
          observedAt: context.now,
        },
      ],
      drainProviderErrors: () => {
        drains += 1;
        return [new Error("child failure")];
      },
    };

    const report = await runProviderConformanceCheck(provider);
    assert.equal(report.ok, true, report.failures.join("; "));
    assert.equal(drains, 1);
  });

  it("reports non-array and throwing drainProviderErrors implementations", async () => {
    const nonArray = await runProviderConformanceCheck({
      id: "bad-drain",
      signals: [{ name: "test.value", unit: "count" }],
      read: (context: SignalReadContext) => [
        {
          name: "test.value",
          unit: "count",
          status: "ok",
          value: 1,
          observedAt: context.now,
        },
      ],
      drainProviderErrors: () => "not-an-array",
    } as unknown as SignalProvider);
    assert.match(nonArray.failures.join(" "), /drainProviderErrors\(\) must return an array/);

    const throwing = await runProviderConformanceCheck({
      id: "throwing-drain",
      signals: [{ name: "test.value", unit: "count" }],
      read: (context: SignalReadContext) => [
        {
          name: "test.value",
          unit: "count",
          status: "ok",
          value: 1,
          observedAt: context.now,
        },
      ],
      drainProviderErrors: () => {
        throw new Error("drain failed");
      },
    } as unknown as SignalProvider);
    assert.match(throwing.failures.join(" "), /drainProviderErrors\(\) threw/);
  });

  it("passes providers without lifecycle hooks and forwards the aborted signal", async () => {
    const controller = new AbortController();
    let receivedNow = 0;
    let receivedSignal: AbortSignal | undefined;
    const provider: SignalProvider = {
      id: "no-lifecycle",
      signals: [{ name: "test.value", unit: "count" }],
      read: (context) => {
        receivedNow = context.now;
        receivedSignal = context.signal;
        return [
          {
            name: "test.value",
            unit: "count",
            status: "unknown",
            observedAt: context.now,
          },
        ];
      },
    };

    const report = await runProviderConformanceCheck(provider, {
      now: 77,
      signal: controller.signal,
    });
    assert.equal(report.ok, true);
    assert.equal(receivedNow, 77);
    assert.equal(receivedSignal, controller.signal);
  });

  it("rejects a null provider", async () => {
    const report = await runProviderConformanceCheck(null as unknown as SignalProvider);
    assert.equal(report.ok, false);
    assert.equal(report.providerId, "");
    assert.match(report.failures.join(" "), /must be an object/);
  });

  it("reports invalid ids and descriptor lists", async () => {
    const report = await runProviderConformanceCheck({
      id: " padded ",
      signals: [],
      read: () => [],
    } as unknown as SignalProvider);
    assert.equal(report.ok, false);
    assert.match(report.failures.join(" "), /whitespace/);
    assert.match(report.failures.join(" "), /non-empty array/);

    const emptyId = await runProviderConformanceCheck({
      id: "",
      signals: "not-an-array",
      read: () => [],
    } as unknown as SignalProvider);
    assert.equal(emptyId.providerId, "");
    assert.match(emptyId.failures.join(" "), /non-empty string/);
    assert.match(emptyId.failures.join(" "), /non-empty array/);
  });

  it("reports every descriptor validation failure", async () => {
    const report = await runProviderConformanceCheck({
      id: "descriptors",
      signals: [
        null,
        { name: "", unit: "count" },
        { name: " padded", unit: "count" },
        { name: "bad-unit", unit: "bogus" },
        { name: "bad-description", unit: "count", description: 7 },
        { name: "duplicate", unit: "count" },
        { name: "duplicate", unit: "count" },
      ],
      read: () => [],
    } as unknown as SignalProvider);

    const failures = report.failures.join("\n");
    assert.match(failures, /must be an object/);
    assert.match(failures, /non-empty string/);
    assert.match(failures, /surrounding whitespace/);
    assert.match(failures, /invalid unit/);
    assert.match(failures, /description must be a string/);
    assert.match(failures, /Duplicate signal name/);
  });

  it("reports lifecycle failures without throwing", async () => {
    const report = await runProviderConformanceCheck({
      id: "lifecycle",
      signals: [{ name: "a", unit: "count" }],
      start: () => {
        throw new Error("start failed");
      },
      read: () => {
        throw new Error("read failed");
      },
      close: () => {
        throw new Error("close failed");
      },
    } as unknown as SignalProvider);

    const failures = report.failures.join("\n");
    assert.match(failures, /start\(\) threw/);
    assert.match(failures, /read\(\) threw/);
    assert.match(failures, /close\(\) threw/);
    assert.equal(report.ok, false);
  });

  it("reports a missing read function and a non-array result", async () => {
    const missingRead = await runProviderConformanceCheck({
      id: "missing-read",
      signals: [{ name: "a", unit: "count" }],
    } as unknown as SignalProvider);
    assert.match(missingRead.failures.join(" "), /read must be a function/);

    const nonArray = await runProviderConformanceCheck({
      id: "non-array",
      signals: [{ name: "a", unit: "count" }],
      read: () => ({ name: "a" }),
    } as unknown as SignalProvider);
    assert.match(nonArray.failures.join(" "), /must return an array/);

    const undefinedResult = await runProviderConformanceCheck({
      id: "undefined-result",
      signals: [{ name: "a", unit: "count" }],
      read: () => undefined,
    } as unknown as SignalProvider);
    assert.match(undefinedResult.failures.join(" "), /must return an array/);
  });

  it("reports every reading validation failure", async () => {
    const report = await runProviderConformanceCheck({
      id: "readings",
      signals: [
        { name: "ok", unit: "count", description: "valid description" },
        { name: "duplicate", unit: "count" },
        { name: "bad-unit", unit: "count" },
        { name: "bad-time", unit: "count" },
        { name: "bad-status", unit: "count" },
        { name: "bad-value", unit: "count" },
        { name: "bad-confidence", unit: "count" },
        { name: "bad-error", unit: "count" },
      ],
      read: (context) =>
        [
          null,
          { name: "", unit: "count", status: "ok", value: 1, observedAt: context.now },
          { name: "undeclared", unit: "count", status: "ok", value: 1, observedAt: context.now },
          {
            name: "ok",
            unit: "count",
            status: "ok",
            value: 1,
            observedAt: context.now,
            confidence: 0.8,
          },
          {
            name: "ok",
            unit: "count",
            status: "ok",
            value: 1,
            observedAt: context.now,
          },
          {
            name: "duplicate",
            unit: "count",
            status: "ok",
            value: 1,
            observedAt: context.now,
          },
          {
            name: "duplicate",
            unit: "count",
            status: "ok",
            value: 1,
            observedAt: context.now,
          },
          { name: "bad-unit", unit: "bytes", status: "ok", value: 1, observedAt: context.now },
          { name: "bad-time", unit: "count", status: "ok", value: 1, observedAt: -1 },
          {
            name: "bad-status",
            unit: "count",
            status: "bogus",
            value: 1,
            observedAt: context.now,
          },
          {
            name: "bad-value",
            unit: "count",
            status: "ok",
            value: Number.NaN,
            observedAt: context.now,
          },
          {
            name: "bad-confidence",
            unit: "count",
            status: "ok",
            value: 1,
            observedAt: context.now,
            confidence: 2,
          },
          {
            name: "bad-error",
            unit: "count",
            status: "unknown",
            observedAt: context.now,
            error: 42,
          },
          {
            name: "ok",
            unit: "count",
            status: "unsupported",
            observedAt: context.now,
            error: "explicitly unavailable",
          },
        ] as unknown as readonly ResourceSignal[],
    });

    const failures = report.failures.join("\n");
    assert.match(failures, /must be an object/);
    assert.match(failures, /name must be a non-empty string/);
    assert.match(failures, /undeclared signal/);
    assert.match(failures, /returned more than once/);
    assert.match(failures, /unit must match/);
    assert.match(failures, /observedAt must equal/);
    assert.match(failures, /invalid status/);
    assert.match(failures, /no finite value/);
    assert.match(failures, /confidence must be/);
    assert.match(failures, /error must be a string/);
  });

  it("passes when optional start/close are absent and descriptions are omitted", async () => {
    const provider: SignalProvider = {
      id: "minimal",
      signals: [{ name: "a", unit: "custom" }] as readonly SignalDescriptor[],
      read: (context: SignalReadContext) => [
        {
          name: "a",
          unit: "custom",
          status: "unsupported",
          observedAt: context.now,
        },
      ],
    };
    const report = await runProviderConformanceCheck(provider);
    assert.equal(report.ok, true);
    assert.equal(report.failures.length, 0);
  });
});

describe("built-in provider conformance", () => {
  const cases: readonly (readonly [string, () => SignalProvider])[] = [
    ["ProcessMemoryProvider", () => new ProcessMemoryProvider()],
    ["CpuUtilizationProvider", () => new CpuUtilizationProvider()],
    ["EventLoopDelayProvider", () => new EventLoopDelayProvider()],
    ["EventLoopUtilizationProvider", () => new EventLoopUtilizationProvider()],
    ["NetworkLatencyProvider", () => new NetworkLatencyProvider({ probe: () => 1 })],
    ["DeviceMemoryProvider", () => new DeviceMemoryProvider()],
    ["NetworkInformationProvider", () => new NetworkInformationProvider()],
    ["FrameTimingProvider", () => new FrameTimingProvider()],
    ["ComputePressureProvider", () => new ComputePressureProvider()],
    [
      "ExecutionBudgetProvider",
      () =>
        new ExecutionBudgetProvider({
          getBudgetSnapshot: () => ({
            totalBudgetMs: 1_000,
            elapsedMs: 100,
            activeRequests: 1,
            maxConcurrency: 4,
          }),
        }),
    ],
    [
      "CompositeSignalProvider",
      () =>
        new CompositeSignalProvider({
          providers: [
            new ScriptedSignalProvider({
              script: [{ name: "scripted.value", unit: "count", values: [1] }],
            }),
          ],
          rules: [
            {
              name: "composite.value",
              unit: "count",
              inputs: ["scripted.value"],
              compute: (values) => {
                const value = values["scripted.value"];
                if (value === undefined) {
                  throw new Error("missing scripted value");
                }
                return value * 2;
              },
            },
          ],
        }),
    ],
    [
      "ScriptedSignalProvider",
      () =>
        new ScriptedSignalProvider({
          script: [{ name: "scripted.value", unit: "count", values: [1] }],
        }),
    ],
  ];

  for (const [label, create] of cases) {
    it(`passes for ${label}`, async () => {
      const report = await runProviderConformanceCheck(create());
      assert.equal(report.ok, true, `${label}: ${report.failures.join("; ")}`);
    });
  }
});

describe("simulatePolicyTimeline", () => {
  const tiers: readonly SimulatedStrategy[] = [
    { id: "high", qualityTier: 2 },
    { id: "low", qualityTier: 1 },
  ];

  function load(value: number, observedAt: number): ResourceSignal {
    return { name: "test.load", unit: "ratio", status: "ok", value, observedAt };
  }

  it("defaults clock values and reports budget transitions, switches, and reversals", () => {
    const result = simulatePolicyTimeline({
      operationId: "timeline",
      policy: {
        consecutiveSamples: 1,
        budgets: [
          {
            id: "load",
            signal: "test.load",
            limit: 0.7,
            recoverBelow: 0.3,
            tierReduction: 1,
            consecutiveSamples: 1,
          },
        ],
      },
      strategies: tiers,
      steps: [
        { signals: [load(0.1, 0)], sampleSequence: 1 },
        { signals: [load(0.9, 1000)], sampleSequence: 2 },
        { signals: [load(0.1, 2000)], sampleSequence: 3 },
        { signals: [load(0.9, 3000)], sampleSequence: 4 },
      ],
    });

    assert.deepEqual(
      result.steps.map((step) => step.now),
      [0, 1000, 2000, 3000],
    );
    assert.deepEqual(
      result.decisions.map((decision) => decision.strategyId),
      ["high", "low", "high", "low"],
    );
    assert.deepEqual(
      result.steps.map((step) => step.engagedBudgetIds),
      [[], ["load"], [], ["load"]],
    );
    assert.deepEqual(
      result.steps.map((step) => step.recoveredBudgetIds),
      [[], [], ["load"], []],
    );
    assert.deepEqual(result.engagedBudgetIds, ["load"]);
    assert.deepEqual(result.recoveredBudgetIds, ["load"]);
    assert.equal(result.strategySwitches, 3);
    assert.equal(result.strategyReversals, 2);
    assert.equal(result.finalState.currentStrategyId, "low");
    assert.equal(result.steps.length, 4);
  });

  it("honors cached samples, per-step strategy pools, pins, and adaptation overrides", () => {
    const cached = simulatePolicyTimeline({
      policy: {
        consecutiveSamples: 1,
        budgets: [
          {
            id: "load",
            signal: "test.load",
            limit: 0.7,
            recoverBelow: 0.3,
            consecutiveSamples: 1,
          },
        ],
      },
      strategies: tiers,
      steps: [
        { signals: [load(0.9, 0)], sampleSequence: 1 },
        { signals: [load(0.1, 1000)], sampleSequence: 1, signalsCached: true },
        { signals: [load(0.1, 2000)], sampleSequence: 2 },
      ],
    });
    assert.deepEqual(
      cached.decisions.map((decision) => decision.strategyId),
      ["low", "low", "high"],
    );
    assert.deepEqual(cached.steps[1]?.engagedBudgetIds, []);
    assert.deepEqual(cached.steps[2]?.recoveredBudgetIds, ["load"]);

    const overridden = simulatePolicyTimeline({
      strategies: tiers,
      steps: [
        {
          signals: [load(0.1, 0)],
          strategies: [{ id: "only", qualityTier: 5 }],
        },
        { signals: [load(0.1, 1000)], pinnedStrategyId: "low" },
        { signals: [load(0.9, 2000)], adaptationEnabled: false },
      ],
    });
    assert.equal(overridden.steps[0]?.decision.strategyId, "only");
    assert.equal(overridden.steps[1]?.decision.strategyId, "low");
    assert.equal(overridden.steps[1]?.decision.kind, "pinned");
    assert.equal(overridden.steps[2]?.decision.strategyId, "high");
    assert.equal(overridden.steps[2]?.decision.kind, "static");
  });

  it("validates options, strategies, steps, and step fields", () => {
    assert.throws(() => simulatePolicyTimeline(null as never), ConfigurationError);
    assert.throws(() => simulatePolicyTimeline({ strategies: [], steps: [] }), ConfigurationError);
    assert.throws(
      () =>
        simulatePolicyTimeline({
          strategies: [
            { id: "same", qualityTier: 1 },
            { id: "same", qualityTier: 2 },
          ],
          steps: [{ signals: [] }],
        }),
      ConfigurationError,
    );
    assert.throws(
      () =>
        simulatePolicyTimeline({
          strategies: tiers,
          steps: [],
        }),
      ConfigurationError,
    );
    assert.throws(
      () =>
        simulatePolicyTimeline({
          operationId: " padded ",
          strategies: tiers,
          steps: [{ signals: [] }],
        }),
      ConfigurationError,
    );

    const invalidSteps = [
      { signals: [load(0.1, 0)], now: -1 },
      { signals: [load(0.1, 0)], now: Number.NaN },
      { signals: "nope" },
      { signals: [], sampleSequence: -1 },
      { signals: [], sampleSequence: 1.5 },
      { signals: [], pinnedStrategyId: " padded " },
      { signals: [], adaptationEnabled: "yes" },
      { signals: [], signalsCached: "yes" },
      {
        signals: [],
        strategies: [
          { id: "same", qualityTier: 1 },
          { id: "same", qualityTier: 2 },
        ],
      },
    ];
    for (const step of invalidSteps) {
      assert.throws(
        () =>
          simulatePolicyTimeline({
            strategies: tiers,
            steps: [step as never],
          }),
        ConfigurationError,
      );
    }
  });

  it("propagates estimatedLatencyMs, ewmaLatencyMs, and errorRate to custom policy selectors", () => {
    interface InspectedCandidate {
      readonly id: string;
      readonly estimatedLatencyMs?: number | null;
      readonly ewmaLatencyMs?: number | null;
      readonly errorRate?: number | null;
    }
    const inspected: InspectedCandidate[][] = [];
    const result = simulatePolicyTimeline({
      policy: {
        customSelector: (ctx) => {
          inspected.push(
            ctx.candidates.map((c) => ({
              id: c.candidate.id,
              estimatedLatencyMs: c.estimatedLatencyMs,
              ewmaLatencyMs: c.ewmaLatencyMs,
              errorRate: c.errorRate,
            })),
          );
          const eligible = [...ctx.candidates].sort(
            (a, b) => (a.errorRate ?? 1) - (b.errorRate ?? 1),
          );
          return eligible[0]?.candidate.id ?? null;
        },
      },
      strategies: [
        { id: "fast", qualityTier: 2, estimatedLatencyMs: 45, ewmaLatencyMs: 50, errorRate: 0.1 },
        {
          id: "safe",
          qualityTier: 1,
          estimatedLatencyMs: 120,
          ewmaLatencyMs: 110,
          errorRate: 0.01,
        },
        {
          id: "cold",
          qualityTier: 3,
          estimatedLatencyMs: null,
          ewmaLatencyMs: null,
          errorRate: null,
        },
      ],
      steps: [
        { signals: [] },
        {
          signals: [],
          strategies: [
            {
              id: "fast",
              qualityTier: 2,
              estimatedLatencyMs: 80,
              ewmaLatencyMs: 75,
              errorRate: 0.25,
            },
            {
              id: "safe",
              qualityTier: 1,
              estimatedLatencyMs: 100,
              ewmaLatencyMs: 95,
              errorRate: 0.02,
            },
          ],
        },
      ],
    });

    assert.equal(result.decisions[0]?.strategyId, "safe");
    assert.equal(result.decisions[1]?.strategyId, "safe");
    assert.deepEqual(inspected[0], [
      { id: "fast", estimatedLatencyMs: 45, ewmaLatencyMs: 50, errorRate: 0.1 },
      { id: "safe", estimatedLatencyMs: 120, ewmaLatencyMs: 110, errorRate: 0.01 },
      { id: "cold", estimatedLatencyMs: null, ewmaLatencyMs: null, errorRate: null },
    ]);
    assert.deepEqual(inspected[1], [
      { id: "fast", estimatedLatencyMs: 80, ewmaLatencyMs: 75, errorRate: 0.25 },
      { id: "safe", estimatedLatencyMs: 100, ewmaLatencyMs: 95, errorRate: 0.02 },
    ]);
  });

  it("validates simulation parameters: estimatedLatencyMs, ewmaLatencyMs, and errorRate", () => {
    assert.throws(
      () =>
        simulatePolicyTimeline({
          strategies: [{ id: "s1", qualityTier: 1, estimatedLatencyMs: -1 }],
          steps: [{ signals: [] }],
        }),
      (err: unknown) =>
        err instanceof ConfigurationError &&
        err.message.includes(
          "strategies[0].estimatedLatencyMs must be a non-negative finite number or null when present.",
        ),
    );

    assert.throws(
      () =>
        simulatePolicyTimeline({
          strategies: [{ id: "s1", qualityTier: 1, estimatedLatencyMs: Number.NaN }],
          steps: [{ signals: [] }],
        }),
      ConfigurationError,
    );

    assert.throws(
      () =>
        simulatePolicyTimeline({
          strategies: [{ id: "s1", qualityTier: 1, estimatedLatencyMs: Number.POSITIVE_INFINITY }],
          steps: [{ signals: [] }],
        }),
      ConfigurationError,
    );

    assert.throws(
      () =>
        simulatePolicyTimeline({
          strategies: [{ id: "s1", qualityTier: 1, estimatedLatencyMs: "100" as never }],
          steps: [{ signals: [] }],
        }),
      ConfigurationError,
    );

    assert.throws(
      () =>
        simulatePolicyTimeline({
          strategies: [{ id: "s1", qualityTier: 1, ewmaLatencyMs: -0.5 }],
          steps: [{ signals: [] }],
        }),
      (err: unknown) =>
        err instanceof ConfigurationError &&
        err.message.includes(
          "strategies[0].ewmaLatencyMs must be a non-negative finite number or null when present.",
        ),
    );

    assert.throws(
      () =>
        simulatePolicyTimeline({
          strategies: [{ id: "s1", qualityTier: 1, ewmaLatencyMs: Number.NaN }],
          steps: [{ signals: [] }],
        }),
      ConfigurationError,
    );

    assert.throws(
      () =>
        simulatePolicyTimeline({
          strategies: [{ id: "s1", qualityTier: 1, ewmaLatencyMs: "invalid" as never }],
          steps: [{ signals: [] }],
        }),
      ConfigurationError,
    );

    assert.throws(
      () =>
        simulatePolicyTimeline({
          strategies: [{ id: "s1", qualityTier: 1, errorRate: -0.01 }],
          steps: [{ signals: [] }],
        }),
      (err: unknown) =>
        err instanceof ConfigurationError &&
        err.message.includes(
          "strategies[0].errorRate must be a finite number between 0 and 1 or null when present.",
        ),
    );

    assert.throws(
      () =>
        simulatePolicyTimeline({
          strategies: [{ id: "s1", qualityTier: 1, errorRate: 1.01 }],
          steps: [{ signals: [] }],
        }),
      (err: unknown) =>
        err instanceof ConfigurationError &&
        err.message.includes(
          "strategies[0].errorRate must be a finite number between 0 and 1 or null when present.",
        ),
    );

    assert.throws(
      () =>
        simulatePolicyTimeline({
          strategies: [{ id: "s1", qualityTier: 1, errorRate: Number.NaN }],
          steps: [{ signals: [] }],
        }),
      ConfigurationError,
    );

    assert.throws(
      () =>
        simulatePolicyTimeline({
          strategies: [{ id: "s1", qualityTier: 1, errorRate: "0.5" as never }],
          steps: [{ signals: [] }],
        }),
      ConfigurationError,
    );

    assert.throws(
      () =>
        simulatePolicyTimeline({
          strategies: [{ id: "s1", qualityTier: 1, errorRate: 2 }],
          steps: [{ signals: [] }],
        }),
      (err: unknown) =>
        err instanceof ConfigurationError &&
        err.message.includes(
          "strategies[0].errorRate must be a finite number between 0 and 1 or null when present.",
        ),
    );
  });

  it("validates SimulatedStrategy.samples and throws InvalidConfigurationError on invalid values", () => {
    // Valid samples
    assert.doesNotThrow(() =>
      simulatePolicyTimeline({
        strategies: [{ id: "s1", qualityTier: 1, samples: 0 }],
        steps: [{ signals: [] }],
      }),
    );
    assert.doesNotThrow(() =>
      simulatePolicyTimeline({
        strategies: [{ id: "s1", qualityTier: 1, samples: 42 }],
        steps: [{ signals: [] }],
      }),
    );
    assert.doesNotThrow(() =>
      simulatePolicyTimeline({
        strategies: [{ id: "s1", qualityTier: 1, samples: null }],
        steps: [{ signals: [] }],
      }),
    );
    assert.doesNotThrow(() =>
      simulatePolicyTimeline({
        strategies: [{ id: "s1", qualityTier: 1, samples: undefined }],
        steps: [{ signals: [] }],
      }),
    );

    // Negative integer
    assert.throws(
      () =>
        simulatePolicyTimeline({
          strategies: [{ id: "s1", qualityTier: 1, samples: -1 }],
          steps: [{ signals: [] }],
        }),
      (err: unknown) =>
        err instanceof InvalidConfigurationError &&
        err.field === "strategies.samples" &&
        err instanceof ConfigurationError &&
        err.message.includes(
          "strategies[0].samples must be a non-negative integer or null when present.",
        ),
    );

    // Float / non-integer
    assert.throws(
      () =>
        simulatePolicyTimeline({
          strategies: [{ id: "s1", qualityTier: 1, samples: 3.14 }],
          steps: [{ signals: [] }],
        }),
      (err: unknown) =>
        err instanceof InvalidConfigurationError && err.field === "strategies.samples",
    );

    // NaN / Infinity / non-number
    assert.throws(
      () =>
        simulatePolicyTimeline({
          strategies: [{ id: "s1", qualityTier: 1, samples: Number.NaN }],
          steps: [{ signals: [] }],
        }),
      (err: unknown) =>
        err instanceof InvalidConfigurationError && err.field === "strategies.samples",
    );

    assert.throws(
      () =>
        simulatePolicyTimeline({
          strategies: [{ id: "s1", qualityTier: 1, samples: Number.POSITIVE_INFINITY }],
          steps: [{ signals: [] }],
        }),
      (err: unknown) =>
        err instanceof InvalidConfigurationError && err.field === "strategies.samples",
    );

    assert.throws(
      () =>
        simulatePolicyTimeline({
          strategies: [{ id: "s1", qualityTier: 1, samples: "10" as unknown as number }],
          steps: [{ signals: [] }],
        }),
      (err: unknown) =>
        err instanceof InvalidConfigurationError && err.field === "strategies.samples",
    );

    // Step strategy override validation
    assert.throws(
      () =>
        simulatePolicyTimeline({
          strategies: [{ id: "s1", qualityTier: 1 }],
          steps: [
            {
              signals: [],
              strategies: [{ id: "s1", qualityTier: 1, samples: -5 }],
            },
          ],
        }),
      (err: unknown) =>
        err instanceof InvalidConfigurationError &&
        err.field === "strategies.samples" &&
        err.message.includes("steps[0].strategies[0].samples"),
    );
  });

  it("propagates samples into candidate objects and respects cold-start guards in simulatePolicyTimeline", () => {
    const errorGuard = createErrorRateGuardSelector({
      maxErrorRate: 0.1,
      minSamples: 5,
    });

    // Step 0: high-tier strategy has errorRate 0.5 (> 0.1), but samples: 2 (< 5) -> protected cold-start!
    // Step 1: high-tier strategy now has samples: 6 (>= 5) with errorRate 0.5 -> disqualified! safe-tier selected.
    const result = simulatePolicyTimeline({
      policy: {
        consecutiveSamples: 1,
        customSelector: errorGuard,
      },
      strategies: [
        { id: "high-tier", qualityTier: 2, errorRate: 0.5, samples: 2 },
        { id: "safe-tier", qualityTier: 1, errorRate: 0.01, samples: 20 },
      ],
      steps: [
        { signals: [] },
        {
          signals: [],
          strategies: [
            { id: "high-tier", qualityTier: 2, errorRate: 0.5, samples: 6 },
            { id: "safe-tier", qualityTier: 1, errorRate: 0.01, samples: 20 },
          ],
        },
      ],
    });

    assert.equal(result.decisions[0]?.strategyId, "high-tier");
    assert.equal(result.decisions[1]?.strategyId, "safe-tier");
    assert.equal(result.strategySwitches, 1);
  });
});
