import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createFakeClock,
  runProviderConformanceCheck,
  type ScriptedSignal,
  ScriptedSignalProvider,
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
  it("passes a valid provider and invokes the lifecycle once", async () => {
    let starts = 0;
    let reads = 0;
    let closes = 0;
    const provider: SignalProvider = {
      id: "conforming",
      signals: [{ name: "test.value", unit: "count", description: "A value." }],
      start: () => {
        starts += 1;
      },
      read: (context) => {
        reads += 1;
        return [
          {
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
      },
    };

    const report = await runProviderConformanceCheck(provider, { now: 42 });
    assert.equal(report.ok, true);
    assert.equal(report.providerId, "conforming");
    assert.ok(report.checksPassed > 0);
    assert.deepEqual(report.failures, []);
    assert.equal(starts, 1);
    assert.equal(reads, 1);
    assert.equal(closes, 1);
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
        { name: "ok", unit: "count" },
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
          { name: "ok", unit: "count", status: "ok", value: 1, observedAt: context.now },
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
