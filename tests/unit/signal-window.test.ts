import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigurationError } from "../../src/errors/index.js";
import { createSignalWindow, type SignalWindowOptions } from "../../src/signals/window.js";
import type { ResourceSignal, SignalStatus } from "../../src/types/signals.js";

const SIGNAL_NAME = "test.signal";

function ok(value: number, observedAt = 0): ResourceSignal {
  return { name: SIGNAL_NAME, unit: "count", status: "ok", value, observedAt };
}

function unavailable(
  observedAt = 0,
  status: Exclude<SignalStatus, "ok"> = "unknown",
): ResourceSignal {
  return { name: SIGNAL_NAME, unit: "count", status, observedAt };
}

function assertClose(actual: number | null, expected: number, epsilon = 1e-12): void {
  assert.ok(actual !== null, `expected a numeric value, received null (wanted ${expected})`);
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

describe("createSignalWindow options", () => {
  it("uses documented defaults for an empty window", () => {
    const window = createSignalWindow();
    assert.equal(window.size(), 0);

    const summary = window.summary();
    assert.deepEqual(summary, {
      count: 0,
      okCount: 0,
      unavailableCount: 0,
      min: null,
      max: null,
      mean: null,
      stdDev: null,
      quantiles: {},
      latest: null,
      latestAt: null,
      ageMs: 0,
      slopePerMs: null,
      trend: "insufficient-data",
      stale: false,
    });
    assert.ok(Object.isFrozen(summary));
    assert.ok(Object.isFrozen(summary.quantiles));

    const aged = window.summary(1000);
    assert.equal(aged.ageMs, null);
    assert.equal(aged.stale, false);
  });

  it("retains 100 readings by default", () => {
    const window = createSignalWindow();
    for (let value = 1; value <= 105; value += 1) {
      window.push(ok(value, value));
    }

    assert.equal(window.size(), 100);
    const summary = window.summary();
    assert.equal(summary.count, 100);
    assert.equal(summary.min, 6);
    assert.equal(summary.max, 105);
    assert.equal(summary.latest, 105);
    assert.equal(summary.latestAt, 105);
  });

  it("accepts valid custom options", () => {
    assert.doesNotThrow(() => createSignalWindow({}));
    assert.doesNotThrow(() => createSignalWindow({ capacity: 1 }));
    assert.doesNotThrow(() => createSignalWindow({ quantiles: [] }));
    assert.doesNotThrow(() => createSignalWindow({ quantiles: [0.99, 0.5, 0.95] }));
    assert.doesNotThrow(() => createSignalWindow({ staleAfterMs: 0 }));
    assert.doesNotThrow(() => createSignalWindow({ trendThresholdPerMs: 0 }));
    assert.doesNotThrow(() =>
      createSignalWindow({ capacity: 2, staleAfterMs: 10, trendThresholdPerMs: 0.5 }),
    );
  });

  it("rejects invalid options with ConfigurationError", () => {
    const invalidOptions: ReadonlyArray<readonly [string, unknown]> = [
      ["null options", null],
      ["array options", []],
      ["zero capacity", { capacity: 0 }],
      ["negative capacity", { capacity: -1 }],
      ["fractional capacity", { capacity: 1.5 }],
      ["NaN capacity", { capacity: Number.NaN }],
      ["infinite capacity", { capacity: Number.POSITIVE_INFINITY }],
      ["unsafe capacity", { capacity: 2 ** 53 }],
      ["null capacity", { capacity: null }],
      ["string capacity", { capacity: "100" }],
      ["non-array quantiles", { quantiles: "0.5" }],
      ["null quantiles", { quantiles: null }],
      ["zero quantile", { quantiles: [0] }],
      ["one quantile", { quantiles: [1] }],
      ["negative quantile", { quantiles: [-0.1] }],
      ["NaN quantile", { quantiles: [Number.NaN] }],
      ["infinite quantile", { quantiles: [Number.POSITIVE_INFINITY] }],
      ["string quantile", { quantiles: [0.5, "0.9"] }],
      ["duplicate quantiles", { quantiles: [0.5, 0.5] }],
      ["negative staleAfterMs", { staleAfterMs: -1 }],
      ["NaN staleAfterMs", { staleAfterMs: Number.NaN }],
      ["infinite staleAfterMs", { staleAfterMs: Number.POSITIVE_INFINITY }],
      ["null staleAfterMs", { staleAfterMs: null }],
      ["string staleAfterMs", { staleAfterMs: "10" }],
      ["negative trendThresholdPerMs", { trendThresholdPerMs: -0.1 }],
      ["NaN trendThresholdPerMs", { trendThresholdPerMs: Number.NaN }],
      ["infinite trendThresholdPerMs", { trendThresholdPerMs: Number.POSITIVE_INFINITY }],
      ["null trendThresholdPerMs", { trendThresholdPerMs: null }],
      ["string trendThresholdPerMs", { trendThresholdPerMs: "0.1" }],
    ];

    for (const [label, options] of invalidOptions) {
      assert.throws(
        () => createSignalWindow(options as unknown as SignalWindowOptions),
        ConfigurationError,
        label,
      );
    }

    assert.throws(() => createSignalWindow({ capacity: 0 }), /capacity/);
    assert.throws(() => createSignalWindow({ quantiles: [0.5, 0.5] }), /duplicate/);
    assert.throws(() => createSignalWindow({ staleAfterMs: -1 }), /staleAfterMs/);
    assert.throws(() => createSignalWindow({ trendThresholdPerMs: -1 }), /trendThresholdPerMs/);
  });
});

describe("createSignalWindow retention", () => {
  it("evicts FIFO and reports the newest values", () => {
    const window = createSignalWindow({ capacity: 3 });
    for (let value = 1; value <= 5; value += 1) {
      window.push(ok(value, value * 100));
    }

    assert.equal(window.size(), 3);
    const summary = window.summary();
    assert.equal(summary.count, 3);
    assert.equal(summary.okCount, 3);
    assert.equal(summary.unavailableCount, 0);
    assert.equal(summary.min, 3);
    assert.equal(summary.max, 5);
    assert.equal(summary.mean, 4);
    assert.equal(summary.latest, 5);
    assert.equal(summary.latestAt, 500);
    assertClose(summary.quantiles["0.5"] as number, 4);
  });

  it("evicts unavailable readings alongside available readings", () => {
    const window = createSignalWindow({ capacity: 2 });
    window.push(ok(10, 100));
    window.push(unavailable(200));
    window.push(ok(30, 300));

    const summary = window.summary();
    assert.equal(summary.count, 2);
    assert.equal(summary.okCount, 1);
    assert.equal(summary.unavailableCount, 1);
    assert.equal(summary.min, 30);
    assert.equal(summary.max, 30);
    assert.equal(summary.mean, 30);
    assert.equal(summary.latest, 30);
    assert.equal(summary.latestAt, 300);
  });

  it("supports capacity 1", () => {
    const window = createSignalWindow({ capacity: 1 });
    window.push(ok(1, 10));
    window.push(ok(2, 20));

    assert.equal(window.size(), 1);
    const summary = window.summary();
    assert.equal(summary.count, 1);
    assert.equal(summary.okCount, 1);
    assert.equal(summary.latest, 2);
    assert.equal(summary.latestAt, 20);
    assert.equal(summary.slopePerMs, null);
    assert.equal(summary.trend, "insufficient-data");

    window.push(unavailable(30));
    const evicted = window.summary();
    assert.equal(evicted.count, 1);
    assert.equal(evicted.okCount, 0);
    assert.equal(evicted.unavailableCount, 1);
    assert.equal(evicted.latest, null);
    assert.equal(evicted.latestAt, null);
  });

  it("clears all retained state and can be reused", () => {
    const window = createSignalWindow();
    window.push(ok(5, 100));
    window.push(unavailable(200));
    assert.equal(window.size(), 2);

    window.clear();
    assert.equal(window.size(), 0);
    const cleared = window.summary();
    assert.equal(cleared.count, 0);
    assert.equal(cleared.okCount, 0);
    assert.equal(cleared.unavailableCount, 0);
    assert.equal(cleared.latest, null);
    assert.equal(cleared.latestAt, null);
    assert.equal(cleared.trend, "insufficient-data");

    window.push(ok(7, 300));
    assert.equal(window.size(), 1);
    assert.equal(window.summary().latest, 7);
    assert.equal(window.summary().latestAt, 300);
  });
});

describe("createSignalWindow statistics", () => {
  it("computes min, max, mean, and population standard deviation", () => {
    const window = createSignalWindow();
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    values.forEach((value, index) => {
      window.push(ok(value, index));
    });

    const summary = window.summary();
    assert.equal(summary.count, 8);
    assert.equal(summary.okCount, 8);
    assert.equal(summary.unavailableCount, 0);
    assert.equal(summary.min, 2);
    assert.equal(summary.max, 9);
    assert.equal(summary.mean, 5);
    assert.equal(summary.stdDev, 2);
    assert.equal(summary.latest, 9);
    assert.equal(summary.latestAt, 7);
  });

  it("reports zero standard deviation for a single value", () => {
    const window = createSignalWindow();
    window.push(ok(7, 42));

    const summary = window.summary();
    assert.equal(summary.min, 7);
    assert.equal(summary.max, 7);
    assert.equal(summary.mean, 7);
    assert.equal(summary.stdDev, 0);
    assert.equal(summary.latest, 7);
    assert.equal(summary.latestAt, 42);
    for (const quantile of ["0.5", "0.95", "0.99"]) {
      assert.equal(summary.quantiles[quantile], 7);
    }
  });

  it("excludes unavailable readings from value statistics without zero coercion", () => {
    const window = createSignalWindow();
    window.push(ok(5, 100));
    window.push(unavailable(200));
    window.push(ok(15, 300));

    const summary = window.summary();
    assert.equal(summary.count, 3);
    assert.equal(summary.okCount, 2);
    assert.equal(summary.unavailableCount, 1);
    assert.equal(summary.min, 5);
    assert.notEqual(summary.min, 0);
    assert.equal(summary.max, 15);
    assert.equal(summary.mean, 10);
    assert.equal(summary.stdDev, 5);
    assert.equal(summary.latest, 15);
    assert.equal(summary.latestAt, 300);
  });

  it("counts every unavailable status without producing values", () => {
    const window = createSignalWindow();
    for (const status of ["unknown", "unsupported", "stale", "error"] as const) {
      window.push(unavailable(1000, status));
    }

    const summary = window.summary(1500);
    assert.equal(summary.count, 4);
    assert.equal(summary.okCount, 0);
    assert.equal(summary.unavailableCount, 4);
    assert.equal(summary.min, null);
    assert.equal(summary.max, null);
    assert.equal(summary.mean, null);
    assert.equal(summary.stdDev, null);
    assert.deepEqual(summary.quantiles, {});
    assert.equal(summary.latest, null);
    assert.equal(summary.latestAt, null);
    assert.equal(summary.ageMs, null);
    assert.equal(summary.slopePerMs, null);
    assert.equal(summary.trend, "insufficient-data");
    assert.equal(summary.stale, false);
  });
});

describe("createSignalWindow quantiles", () => {
  it("interpolates linearly between closest ranks", () => {
    const window = createSignalWindow();
    window.push(ok(0, 0));
    window.push(ok(10, 1));

    const summary = window.summary();
    assertClose(summary.quantiles["0.5"] as number, 5);
    assertClose(summary.quantiles["0.95"] as number, 9.5);
    assertClose(summary.quantiles["0.99"] as number, 9.9);
    assert.deepEqual(Object.keys(summary.quantiles), ["0.5", "0.95", "0.99"]);
  });

  it("sorts configured quantiles ascending and supports custom levels", () => {
    const window = createSignalWindow({ quantiles: [0.9, 0.5, 0.25] });
    [1, 2, 3, 4].forEach((value, index) => {
      window.push(ok(value, index));
    });

    const summary = window.summary();
    assert.deepEqual(Object.keys(summary.quantiles), ["0.25", "0.5", "0.9"]);
    assertClose(summary.quantiles["0.25"] as number, 1.75);
    assertClose(summary.quantiles["0.5"] as number, 2.5);
    assertClose(summary.quantiles["0.9"] as number, 3.7);
  });

  it("reports no quantiles when none are configured", () => {
    const window = createSignalWindow({ quantiles: [] });
    window.push(ok(1, 0));

    const summary = window.summary();
    assert.deepEqual(summary.quantiles, {});
    assert.ok(Object.isFrozen(summary.quantiles));
  });
});

describe("createSignalWindow trends", () => {
  it("detects a rising OLS slope", () => {
    const window = createSignalWindow();
    window.push(ok(0, 0));
    window.push(ok(10, 1000));
    window.push(ok(20, 2000));

    const summary = window.summary();
    assertClose(summary.slopePerMs, 0.01);
    assert.equal(summary.trend, "rising");
  });

  it("detects a falling OLS slope", () => {
    const window = createSignalWindow();
    window.push(ok(20, 0));
    window.push(ok(10, 1000));
    window.push(ok(0, 2000));

    const summary = window.summary();
    assertClose(summary.slopePerMs, -0.01);
    assert.equal(summary.trend, "falling");
  });

  it("classifies slopes inside the threshold as stable", () => {
    const window = createSignalWindow({ trendThresholdPerMs: 0.01 });
    window.push(ok(0, 0));
    window.push(ok(10, 1000));

    const summary = window.summary();
    assertClose(summary.slopePerMs, 0.01);
    assert.equal(summary.trend, "stable");

    const sensitive = createSignalWindow({ trendThresholdPerMs: 0.001 });
    sensitive.push(ok(0, 0));
    sensitive.push(ok(10, 1000));
    assert.equal(sensitive.summary().trend, "rising");
  });

  it("classifies a flat slope as stable with the default threshold", () => {
    const window = createSignalWindow();
    window.push(ok(5, 0));
    window.push(ok(5, 1000));
    window.push(ok(5, 2000));

    const summary = window.summary();
    assert.equal(summary.slopePerMs, 0);
    assert.equal(summary.trend, "stable");
  });

  it("reports insufficient data without a fittable slope", () => {
    const empty = createSignalWindow().summary();
    assert.equal(empty.slopePerMs, null);
    assert.equal(empty.trend, "insufficient-data");

    const single = createSignalWindow();
    single.push(ok(1, 0));
    assert.equal(single.summary().slopePerMs, null);
    assert.equal(single.summary().trend, "insufficient-data");

    const duplicateTimestamps = createSignalWindow();
    duplicateTimestamps.push(ok(1, 0));
    duplicateTimestamps.push(ok(2, 0));
    assert.equal(duplicateTimestamps.summary().slopePerMs, null);
    assert.equal(duplicateTimestamps.summary().trend, "insufficient-data");

    const singleAvailable = createSignalWindow();
    singleAvailable.push(unavailable(0));
    singleAvailable.push(ok(1, 1000));
    assert.equal(singleAvailable.summary().slopePerMs, null);
    assert.equal(singleAvailable.summary().trend, "insufficient-data");
  });

  it("uses every available sample when at least two timestamps are distinct", () => {
    const window = createSignalWindow();
    window.push(ok(0, 0));
    window.push(ok(10, 0));
    window.push(ok(20, 1000));

    const summary = window.summary();
    assert.notEqual(summary.slopePerMs, null);
    assert.equal(summary.trend, "rising");
  });
});

describe("createSignalWindow freshness", () => {
  it("computes age and strict staleness from an explicit now", () => {
    const window = createSignalWindow({ staleAfterMs: 100 });
    window.push(ok(1, 1000));

    const omitted = window.summary();
    assert.equal(omitted.ageMs, 0);
    assert.equal(omitted.stale, false);

    assert.equal(window.summary(1000).ageMs, 0);
    assert.equal(window.summary(1000).stale, false);
    assert.equal(window.summary(1050).ageMs, 50);
    assert.equal(window.summary(1050).stale, false);
    assert.equal(window.summary(1100).ageMs, 100);
    assert.equal(window.summary(1100).stale, false);
    assert.equal(window.summary(1101).ageMs, 101);
    assert.equal(window.summary(1101).stale, true);
  });

  it("clamps age to zero when now is before the latest reading", () => {
    const window = createSignalWindow({ staleAfterMs: 100 });
    window.push(ok(1, 1000));

    const summary = window.summary(500);
    assert.equal(summary.ageMs, 0);
    assert.equal(summary.stale, false);
  });

  it("never reports stale when staleAfterMs is not configured", () => {
    const window = createSignalWindow();
    window.push(ok(1, 0));

    const summary = window.summary(1_000_000);
    assert.equal(summary.ageMs, 1_000_000);
    assert.equal(summary.stale, false);
  });

  it("treats the staleAfterMs boundary as strictly greater than", () => {
    const window = createSignalWindow({ staleAfterMs: 0 });
    window.push(ok(1, 100));

    assert.equal(window.summary(100).stale, false);
    assert.equal(window.summary(101).stale, true);
  });

  it("keeps freshness tied to the latest available reading", () => {
    const window = createSignalWindow({ staleAfterMs: 100 });
    window.push(ok(5, 100));
    window.push(unavailable(200));

    const summary = window.summary(250);
    assert.equal(summary.latest, 5);
    assert.equal(summary.latestAt, 100);
    assert.equal(summary.ageMs, 150);
    assert.equal(summary.stale, true);
  });

  it("rejects an invalid now", () => {
    const window = createSignalWindow();
    for (const now of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.throws(() => window.summary(now), ConfigurationError);
    }
    assert.throws(() => window.summary("100" as unknown as number), ConfigurationError);
  });
});

describe("createSignalWindow defensiveness", () => {
  it("rejects invalid readings without changing the window", () => {
    const window = createSignalWindow();
    const invalidReadings: unknown[] = [
      null,
      undefined,
      42,
      "ok",
      [],
      {},
      { status: "bogus", observedAt: 0 },
      { status: "unavailable", observedAt: 0 },
      { status: "ok" },
      { status: "ok", observedAt: 0 },
      { status: "ok", observedAt: 0, value: Number.NaN },
      { status: "ok", observedAt: 0, value: Number.POSITIVE_INFINITY },
      { status: "ok", observedAt: 0, value: Number.NEGATIVE_INFINITY },
      { status: "ok", observedAt: 0, value: "5" },
      { status: "ok", observedAt: Number.NaN, value: 5 },
      { status: "ok", observedAt: Number.POSITIVE_INFINITY, value: 5 },
      { status: "ok", observedAt: "0", value: 5 },
      { status: "unknown", observedAt: Number.NaN },
    ];

    for (const reading of invalidReadings) {
      assert.throws(() => window.push(reading as ResourceSignal), ConfigurationError);
    }
    assert.equal(window.size(), 0);
    assert.equal(window.summary().count, 0);
  });

  it("accepts unavailable readings and ignores any stray value field", () => {
    const window = createSignalWindow();
    window.push({
      name: SIGNAL_NAME,
      unit: "count",
      status: "error",
      observedAt: 0,
      value: 123,
    } as unknown as ResourceSignal);

    const summary = window.summary();
    assert.equal(summary.count, 1);
    assert.equal(summary.unavailableCount, 1);
    assert.equal(summary.min, null);
    assert.equal(summary.mean, null);
    assert.equal(summary.latest, null);
  });

  it("copies pushed readings so later mutation cannot change statistics", () => {
    const window = createSignalWindow();
    const reading: {
      name: string;
      unit: "count";
      status: "ok";
      value: number;
      observedAt: number;
    } = {
      name: SIGNAL_NAME,
      unit: "count",
      status: "ok",
      value: 12,
      observedAt: 10,
    };

    window.push(reading);
    reading.value = 99;
    reading.observedAt = 999;

    const summary = window.summary();
    assert.equal(summary.latest, 12);
    assert.equal(summary.latestAt, 10);
    assert.equal(summary.mean, 12);
  });

  it("returns frozen, deterministic summaries", () => {
    const window = createSignalWindow();
    [1, 2, 3].forEach((value, index) => {
      window.push(ok(value, index * 1000));
    });

    const first = window.summary(2000);
    const second = window.summary(2000);
    assert.deepEqual(first, second);
    assert.ok(Object.isFrozen(first));
    assert.ok(Object.isFrozen(first.quantiles));

    assert.throws(() => {
      (first as unknown as { count: number }).count = 99;
    }, TypeError);
    assert.throws(() => {
      (first.quantiles as unknown as Record<string, number>)["0.5"] = 99;
    }, TypeError);

    const replica = createSignalWindow();
    [1, 2, 3].forEach((value, index) => {
      replica.push(ok(value, index * 1000));
    });
    assert.deepEqual(replica.summary(2000), first);

    window.push(ok(1000, 3000));
    assert.equal(first.count, 3);
    assert.equal(first.latest, 3);
    assert.equal(window.summary().latest, 1000);
  });
});
