import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigurationError } from "../../src/errors/index.js";
import {
  CompositeSignalProvider,
  type CompositeSignalProviderOptions,
  type CompositeSignalRule,
} from "../../src/providers/composite.js";
import { createAdaptiveRuntime } from "../../src/runtime/runtime.js";
import type {
  ResourceSignal,
  SignalDescriptor,
  SignalProvider,
  SignalReadContext,
  SignalUnit,
} from "../../src/types/signals.js";

function createMockProvider(options: {
  id: string;
  signals: readonly SignalDescriptor[];
  read?: (
    context: SignalReadContext,
  ) => Promise<readonly ResourceSignal[]> | readonly ResourceSignal[];
  start?: (context?: unknown) => void | Promise<void>;
  close?: () => void | Promise<void>;
  drainProviderErrors?: () => readonly Error[];
}): SignalProvider {
  return {
    id: options.id,
    signals: options.signals,
    read: options.read ?? (() => []),
    start: options.start,
    close: options.close,
    drainProviderErrors: options.drainProviderErrors,
  };
}

const mockContext: SignalReadContext = {
  now: 1_700_000_000,
  signal: new AbortController().signal,
};

describe("CompositeSignalProvider", () => {
  describe("constructor options validation", () => {
    it("rejects non-object or null options", () => {
      assert.throws(
        () => new CompositeSignalProvider(null as unknown as CompositeSignalProviderOptions),
        ConfigurationError,
      );
      assert.throws(
        () => new CompositeSignalProvider(undefined as unknown as CompositeSignalProviderOptions),
        ConfigurationError,
      );
      assert.throws(
        () => new CompositeSignalProvider("invalid" as unknown as CompositeSignalProviderOptions),
        ConfigurationError,
      );
      assert.throws(
        () => new CompositeSignalProvider(123 as unknown as CompositeSignalProviderOptions),
        ConfigurationError,
      );
    });

    it("validates id correctly and applies default id 'composite'", () => {
      const child = createMockProvider({
        id: "child-p",
        signals: [{ name: "sig.a", unit: "ratio" }],
      });
      const rule: CompositeSignalRule = {
        name: "rule.a",
        unit: "ratio",
        inputs: ["sig.a"],
        compute: (v) => (v["sig.a"] ?? 0) * 2,
      };

      // Default id
      const defaultProvider = new CompositeSignalProvider({
        providers: [child],
        rules: [rule],
      });
      assert.equal(defaultProvider.id, "composite");

      // Custom valid id
      const customProvider = new CompositeSignalProvider({
        id: "custom-composite",
        providers: [child],
        rules: [rule],
      });
      assert.equal(customProvider.id, "custom-composite");

      // Invalid id types and whitespace
      assert.throws(
        () =>
          new CompositeSignalProvider({
            id: 123 as unknown as string,
            providers: [child],
            rules: [rule],
          }),
        ConfigurationError,
      );
      assert.throws(
        () => new CompositeSignalProvider({ id: "", providers: [child], rules: [rule] }),
        ConfigurationError,
      );
      assert.throws(
        () => new CompositeSignalProvider({ id: "   ", providers: [child], rules: [rule] }),
        ConfigurationError,
      );
      assert.throws(
        () => new CompositeSignalProvider({ id: " leading", providers: [child], rules: [rule] }),
        ConfigurationError,
      );
      assert.throws(
        () => new CompositeSignalProvider({ id: "trailing ", providers: [child], rules: [rule] }),
        ConfigurationError,
      );
    });

    it("validates passthroughInputs option", () => {
      const child = createMockProvider({
        id: "child-p",
        signals: [{ name: "sig.a", unit: "ratio" }],
      });
      const rule: CompositeSignalRule = {
        name: "rule.a",
        unit: "ratio",
        inputs: ["sig.a"],
        compute: (v) => v["sig.a"] ?? 0,
      };

      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: [child],
            rules: [rule],
            passthroughInputs: "yes" as unknown as boolean,
          }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: [child],
            rules: [rule],
            passthroughInputs: 1 as unknown as boolean,
          }),
        ConfigurationError,
      );

      const pTrue = new CompositeSignalProvider({
        providers: [child],
        rules: [rule],
        passthroughInputs: true,
      });
      assert.equal(pTrue.signals.length, 2);

      const pFalse = new CompositeSignalProvider({
        providers: [child],
        rules: [rule],
        passthroughInputs: false,
      });
      assert.equal(pFalse.signals.length, 1);
    });
  });

  describe("child providers validation", () => {
    const validRule: CompositeSignalRule = {
      name: "rule.test",
      unit: "count",
      inputs: ["sig.test"],
      compute: () => 1,
    };

    it("rejects non-array or empty providers", () => {
      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: "not-array" as unknown as readonly SignalProvider[],
            rules: [validRule],
          }),
        ConfigurationError,
      );
      assert.throws(
        () => new CompositeSignalProvider({ providers: [], rules: [validRule] }),
        ConfigurationError,
      );
    });

    it("rejects invalid provider instances", () => {
      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: [null as unknown as SignalProvider],
            rules: [validRule],
          }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: ["p" as unknown as SignalProvider],
            rules: [validRule],
          }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: [{ signals: [], read: () => [] } as unknown as SignalProvider],
            rules: [validRule],
          }),
        ConfigurationError,
      );
      // Provider with empty or whitespace id
      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: [{ id: "", signals: [], read: () => [] }],
            rules: [validRule],
          }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: [{ id: "  padded  ", signals: [], read: () => [] }],
            rules: [validRule],
          }),
        ConfigurationError,
      );
      // Provider missing read method
      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: [{ id: "p1", signals: [] } as unknown as SignalProvider],
            rules: [validRule],
          }),
        ConfigurationError,
      );
      // Provider with non-array signals
      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: [
              {
                id: "p1",
                signals: "not-array" as unknown as readonly SignalDescriptor[],
                read: () => [],
              },
            ],
            rules: [validRule],
          }),
        ConfigurationError,
      );
    });

    it("rejects invalid child signal descriptors", () => {
      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: [
              {
                id: "p1",
                signals: [null as unknown as SignalDescriptor],
                read: () => [],
              },
            ],
            rules: [validRule],
          }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: [
              {
                id: "p1",
                signals: ["descriptor" as unknown as SignalDescriptor],
                read: () => [],
              },
            ],
            rules: [validRule],
          }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: [
              {
                id: "p1",
                signals: [{ name: 123 as unknown as string, unit: "ratio" }],
                read: () => [],
              },
            ],
            rules: [validRule],
          }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: [{ id: "p1", signals: [{ name: "", unit: "ratio" }], read: () => [] }],
            rules: [validRule],
          }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: [
              { id: "p1", signals: [{ name: " padded ", unit: "ratio" }], read: () => [] },
            ],
            rules: [validRule],
          }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: [
              {
                id: "p1",
                signals: [{ name: "sig.x", unit: "unsupported-unit" as unknown as SignalUnit }],
                read: () => [],
              },
            ],
            rules: [validRule],
          }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: [
              {
                id: "p1",
                signals: [{ name: "sig.x", unit: "count", description: 123 as unknown as string }],
                read: () => [],
              },
            ],
            rules: [validRule],
          }),
        ConfigurationError,
      );
    });

    it("rejects duplicate signal names across child providers with ConfigurationError", () => {
      const p1 = createMockProvider({
        id: "p1",
        signals: [
          { name: "shared.sig", unit: "ratio", description: "Shared signal desc" },
          { name: "p1.sig", unit: "bytes" },
        ],
      });
      const p2 = createMockProvider({
        id: "p2",
        signals: [
          { name: "shared.sig", unit: "ratio" },
          { name: "p2.sig", unit: "milliseconds" },
        ],
      });
      const rule: CompositeSignalRule = {
        name: "composite.out",
        unit: "custom",
        inputs: ["shared.sig"],
        compute: (v) => v["shared.sig"] ?? 0,
      };

      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: [p1, p2],
            rules: [rule],
          }),
        (err: unknown) => {
          assert.ok(err instanceof ConfigurationError);
          assert.match(err.message, /Duplicate signal name across child providers: shared\.sig/);
          return true;
        },
      );
    });

    it("handles multiple child providers with distinct descriptors cleanly", () => {
      const p1 = createMockProvider({
        id: "p1",
        signals: [{ name: "p1.sig", unit: "bytes" }],
      });
      const p2 = createMockProvider({
        id: "p2",
        signals: [{ name: "p2.sig", unit: "milliseconds" }],
      });
      const rule: CompositeSignalRule = {
        name: "composite.out",
        unit: "custom",
        inputs: ["p1.sig", "p2.sig"],
        compute: (v) => (v["p1.sig"] ?? 0) + (v["p2.sig"] ?? 0),
      };

      const provider = new CompositeSignalProvider({
        providers: [p1, p2],
        rules: [rule],
      });

      assert.equal(provider.signals.length, 3);
      assert.deepEqual(
        provider.signals.map((s) => s.name),
        ["p1.sig", "p2.sig", "composite.out"],
      );
    });
  });

  describe("rules validation", () => {
    const child = createMockProvider({
      id: "child-p",
      signals: [
        { name: "cpu.util", unit: "ratio" },
        { name: "mem.used", unit: "bytes" },
      ],
    });

    it("rejects non-array or empty rules", () => {
      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: [child],
            rules: null as unknown as readonly CompositeSignalRule[],
          }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: [child],
            rules: "not-array" as unknown as readonly CompositeSignalRule[],
          }),
        ConfigurationError,
      );
      assert.throws(
        () => new CompositeSignalProvider({ providers: [child], rules: [] }),
        ConfigurationError,
      );
    });

    it("rejects invalid rule shapes and names", () => {
      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: [child],
            rules: [null as unknown as CompositeSignalRule],
          }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: [child],
            rules: ["rule" as unknown as CompositeSignalRule],
          }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: [child],
            rules: [
              {
                name: 123 as unknown as string,
                unit: "ratio",
                inputs: ["cpu.util"],
                compute: () => 1,
              },
            ],
          }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: [child],
            rules: [{ name: "", unit: "ratio", inputs: ["cpu.util"], compute: () => 1 }],
          }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: [child],
            rules: [{ name: " padded ", unit: "ratio", inputs: ["cpu.util"], compute: () => 1 }],
          }),
        ConfigurationError,
      );
    });

    it("rejects duplicate rule names", () => {
      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: [child],
            rules: [
              { name: "rule.one", unit: "ratio", inputs: ["cpu.util"], compute: () => 1 },
              { name: "rule.one", unit: "ratio", inputs: ["mem.used"], compute: () => 2 },
            ],
          }),
        ConfigurationError,
      );
    });

    it("rejects rule name collision with child provider when passthroughInputs is true", () => {
      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: [child],
            rules: [{ name: "cpu.util", unit: "ratio", inputs: ["mem.used"], compute: () => 1 }],
            passthroughInputs: true,
          }),
        ConfigurationError,
      );
    });

    it("allows rule name collision with child provider when passthroughInputs is false", () => {
      const provider = new CompositeSignalProvider({
        providers: [child],
        rules: [
          {
            name: "cpu.util",
            unit: "ratio",
            inputs: ["mem.used"],
            compute: (v) => (v["mem.used"] ?? 0) / 100,
          },
        ],
        passthroughInputs: false,
      });
      assert.equal(provider.signals.length, 1);
      assert.equal(provider.signals[0]?.name, "cpu.util");
    });

    it("rejects invalid unit and non-string description on rules", () => {
      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: [child],
            rules: [
              {
                name: "rule.invalid.unit",
                unit: "kelvin" as unknown as SignalUnit,
                inputs: ["cpu.util"],
                compute: () => 1,
              },
            ],
          }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: [child],
            rules: [
              {
                name: "rule.desc",
                unit: "ratio",
                description: 42 as unknown as string,
                inputs: ["cpu.util"],
                compute: () => 1,
              },
            ],
          }),
        ConfigurationError,
      );
    });

    it("rejects non-array, empty, or invalid rule inputs", () => {
      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: [child],
            rules: [
              {
                name: "rule.x",
                unit: "ratio",
                inputs: "cpu.util" as unknown as readonly string[],
                compute: () => 1,
              },
            ],
          }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: [child],
            rules: [{ name: "rule.x", unit: "ratio", inputs: [], compute: () => 1 }],
          }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: [child],
            rules: [
              {
                name: "rule.x",
                unit: "ratio",
                inputs: [123 as unknown as string],
                compute: () => 1,
              },
            ],
          }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: [child],
            rules: [{ name: "rule.x", unit: "ratio", inputs: [" cpu.util "], compute: () => 1 }],
          }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: [child],
            rules: [{ name: "rule.x", unit: "ratio", inputs: [""], compute: () => 1 }],
          }),
        ConfigurationError,
      );
      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: [child],
            rules: [
              {
                name: "rule.x",
                unit: "ratio",
                inputs: ["non.existent.signal"],
                compute: () => 1,
              },
            ],
          }),
        ConfigurationError,
      );
    });

    it("rejects non-function compute", () => {
      assert.throws(
        () =>
          new CompositeSignalProvider({
            providers: [child],
            rules: [
              {
                name: "rule.x",
                unit: "ratio",
                inputs: ["cpu.util"],
                compute: "not-a-func" as unknown as (v: Readonly<Record<string, number>>) => number,
              },
            ],
          }),
        ConfigurationError,
      );
    });

    it("accepts valid rules with and without description across all valid units", () => {
      const units: readonly SignalUnit[] = ["bytes", "milliseconds", "ratio", "count", "custom"];
      const rules: CompositeSignalRule[] = units.map((unit, index) => ({
        name: `rule.unit.${unit}`,
        unit,
        description: index % 2 === 0 ? `Description for ${unit}` : undefined,
        inputs: ["cpu.util"],
        compute: () => index,
      }));

      const provider = new CompositeSignalProvider({
        providers: [child],
        rules,
      });

      assert.equal(provider.signals.length, child.signals.length + rules.length);
      const descRule = provider.signals.find((s) => s.name === "rule.unit.bytes");
      assert.equal(descRule?.description, "Description for bytes");
      const noDescRule = provider.signals.find((s) => s.name === "rule.unit.milliseconds");
      assert.equal(noDescRule?.description, undefined);
    });
  });

  describe("lifecycle (start and close)", () => {
    it("propagates start and close in parallel to child providers that implement them", async () => {
      let p1Started = false;
      let p1Closed = false;
      let p2StartedWith: unknown = null;
      let p2Closed = false;

      const p1 = createMockProvider({
        id: "p1",
        signals: [{ name: "sig.1", unit: "ratio" }],
        start: () => {
          p1Started = true;
        },
        close: async () => {
          p1Closed = true;
        },
      });

      const p2 = createMockProvider({
        id: "p2",
        signals: [{ name: "sig.2", unit: "count" }],
        start: (ctx) => {
          p2StartedWith = ctx;
        },
        close: () => {
          p2Closed = true;
        },
      });

      // Child with neither start nor close
      const p3 = createMockProvider({
        id: "p3",
        signals: [{ name: "sig.3", unit: "custom" }],
      });

      const composite = new CompositeSignalProvider({
        providers: [p1, p2, p3],
        rules: [
          {
            name: "rule.all",
            unit: "ratio",
            inputs: ["sig.1", "sig.2", "sig.3"],
            compute: () => 1,
          },
        ],
      });

      // Call start with context
      const startCtx = { customOption: true };
      await composite.start(startCtx);
      assert.equal(p1Started, true);
      assert.deepEqual(p2StartedWith, startCtx);

      // Call close
      await composite.close();
      assert.equal(p1Closed, true);
      assert.equal(p2Closed, true);
    });

    it("settles close() cleanly even when a child provider's close() throws", async () => {
      let p2Closed = false;
      const failingChild = createMockProvider({
        id: "failing-child",
        signals: [{ name: "failing.sig", unit: "count" }],
        close: async () => {
          throw new Error("child close failure");
        },
      });
      const healthyChild = createMockProvider({
        id: "healthy-child",
        signals: [{ name: "healthy.sig", unit: "count" }],
        close: () => {
          p2Closed = true;
        },
      });
      const composite = new CompositeSignalProvider({
        providers: [failingChild, healthyChild],
        rules: [
          {
            name: "composite.rule",
            unit: "count",
            inputs: ["healthy.sig"],
            compute: (v) => v["healthy.sig"] ?? 0,
          },
        ],
      });

      await composite.close();
      assert.equal(p2Closed, true);
    });

    it("returns unsupported signals when read() is called on a closed provider", async () => {
      const p = createMockProvider({
        id: "p",
        signals: [{ name: "sig.a", unit: "ratio" }],
        read: () => [{ name: "sig.a", unit: "ratio", status: "ok", value: 0.5, observedAt: 100 }],
      });
      const composite = new CompositeSignalProvider({
        providers: [p],
        rules: [
          {
            name: "rule.a",
            unit: "ratio",
            inputs: ["sig.a"],
            compute: (v) => (v["sig.a"] ?? 0) * 2,
          },
        ],
      });

      await composite.close();
      const readings = await composite.read(mockContext);
      assert.equal(readings.length, 2);
      for (const reading of readings) {
        assert.equal(reading.status, "unsupported");
        assert.equal(reading.observedAt, mockContext.now);
        assert.equal((reading as { value?: unknown }).value, undefined);
        assert.equal((reading as { error?: string }).error, "Provider is closed.");
      }
    });
  });

  describe("read() validation and child provider fault isolation", () => {
    it("validates read context", async () => {
      const p = createMockProvider({
        id: "p",
        signals: [{ name: "sig.a", unit: "ratio" }],
      });
      const composite = new CompositeSignalProvider({
        providers: [p],
        rules: [{ name: "rule.a", unit: "ratio", inputs: ["sig.a"], compute: () => 1 }],
      });

      await assert.rejects(
        () => composite.read(null as unknown as SignalReadContext),
        ConfigurationError,
      );
      await assert.rejects(
        () => composite.read({} as unknown as SignalReadContext),
        ConfigurationError,
      );
      await assert.rejects(
        () => composite.read({ now: "now" } as unknown as SignalReadContext),
        ConfigurationError,
      );
    });

    it("synthesizes error readings when child provider read() throws or rejects", async () => {
      const failingChild = createMockProvider({
        id: "failing-provider",
        signals: [{ name: "sig.fail", unit: "ratio" }],
        read: () => {
          throw new Error("Provider hardware probe failed");
        },
      });

      const composite = new CompositeSignalProvider({
        providers: [failingChild],
        rules: [
          {
            name: "rule.comp",
            unit: "ratio",
            inputs: ["sig.fail"],
            compute: (v) => v["sig.fail"] ?? 0,
          },
        ],
      });

      const readings = await composite.read(mockContext);
      assert.equal(readings.length, 2);

      // Child reading synthesized as error
      const childReading = readings.find((r) => r.name === "sig.fail");
      assert.ok(childReading);
      assert.equal(childReading.status, "error");
      assert.ok(
        (childReading as { error?: string })?.error?.includes(
          'Provider "failing-provider" read failed',
        ),
      );
      assert.equal((childReading as { value?: unknown }).value, undefined);

      // Composite reading resolved to error (because input failed with error)
      const compReading = readings.find((r) => r.name === "rule.comp");
      assert.ok(compReading);
      assert.equal(compReading.status, "error");
      assert.ok((compReading as { error?: string })?.error?.includes('dominant: "error"'));
      assert.equal((compReading as { value?: unknown }).value, undefined);
    });

    it("queues child failures for drainProviderErrors without changing read results", async () => {
      const rootCause = new Error("Provider hardware probe failed");
      const failingChild = createMockProvider({
        id: "drain-child",
        signals: [{ name: "sig.drain", unit: "ratio" }],
        read: () => {
          throw rootCause;
        },
      });
      const composite = new CompositeSignalProvider({
        providers: [failingChild],
        rules: [
          {
            name: "rule.drain",
            unit: "ratio",
            inputs: ["sig.drain"],
            compute: (values) => values["sig.drain"] ?? 0,
          },
        ],
      });

      const readings = await composite.read(mockContext);
      assert.equal(readings.find((reading) => reading.name === "sig.drain")?.status, "error");

      const drained = composite.drainProviderErrors();
      assert.equal(drained.length, 1);
      assert.match(drained[0]?.message ?? "", /Provider "drain-child" read failed/);
      assert.equal((drained[0] as { cause?: unknown }).cause, rootCause);
      assert.deepEqual(composite.drainProviderErrors(), []);
    });

    it("turns broken child drains into queued failures and bubbles nested composite errors", async () => {
      const throwingDrainChild = createMockProvider({
        id: "throw-drain",
        signals: [{ name: "sig.throw-drain", unit: "count" }],
        drainProviderErrors: () => {
          throw new Error("drain exploded");
        },
      });
      const throwingComposite = new CompositeSignalProvider({
        providers: [throwingDrainChild],
        rules: [
          {
            name: "rule.throw-drain",
            unit: "count",
            inputs: ["sig.throw-drain"],
            compute: (values) => values["sig.throw-drain"] ?? 0,
          },
        ],
      });
      await throwingComposite.read(mockContext);
      const throwingErrors = throwingComposite.drainProviderErrors();
      assert.equal(throwingErrors.length, 1);
      assert.match(throwingErrors[0]?.message ?? "", /drainProviderErrors failed/);
      assert.equal((throwingErrors[0] as { cause?: unknown }).cause instanceof Error, true);

      const nonArrayDrainChild = createMockProvider({
        id: "non-array-drain",
        signals: [{ name: "sig.non-array-drain", unit: "count" }],
        drainProviderErrors: () => "not-an-array" as unknown as readonly Error[],
      });
      const nonArrayComposite = new CompositeSignalProvider({
        providers: [nonArrayDrainChild],
        rules: [
          {
            name: "rule.non-array-drain",
            unit: "count",
            inputs: ["sig.non-array-drain"],
            compute: (values) => values["sig.non-array-drain"] ?? 0,
          },
        ],
      });
      await nonArrayComposite.read(mockContext);
      const nonArrayErrors = nonArrayComposite.drainProviderErrors();
      assert.equal(nonArrayErrors.length, 1);
      assert.equal(nonArrayErrors[0] instanceof TypeError, true);

      const rootCause = new Error("deep sensor failure");
      const grandchild = createMockProvider({
        id: "grandchild",
        signals: [{ name: "sig.deep", unit: "ratio" }],
        read: () => {
          throw rootCause;
        },
      });
      const inner = new CompositeSignalProvider({
        providers: [grandchild],
        rules: [
          {
            name: "inner.rule",
            unit: "ratio",
            inputs: ["sig.deep"],
            compute: (values) => values["sig.deep"] ?? 0,
          },
        ],
        passthroughInputs: true,
      });
      const outer = new CompositeSignalProvider({
        providers: [inner],
        rules: [
          {
            name: "outer.rule",
            unit: "ratio",
            inputs: ["inner.rule"],
            compute: (values) => values["inner.rule"] ?? 0,
          },
        ],
        passthroughInputs: true,
      });

      const nestedReadings = await outer.read(mockContext);
      assert.equal(
        nestedReadings.find((reading) => reading.name === "outer.rule")?.status,
        "error",
      );
      const nestedErrors = outer.drainProviderErrors();
      assert.equal(nestedErrors.length, 1);
      assert.match(nestedErrors[0]?.message ?? "", /Provider "grandchild" read failed/);
      assert.equal((nestedErrors[0] as { cause?: unknown }).cause, rootCause);
      assert.deepEqual(inner.drainProviderErrors(), []);
      assert.deepEqual(outer.drainProviderErrors(), []);
    });

    it("synthesizes error readings when child provider returns a non-array", async () => {
      const nonArrayChild = createMockProvider({
        id: "non-array-provider",
        signals: [{ name: "sig.na", unit: "count" }],
        read: () => "invalid-readings" as unknown as readonly ResourceSignal[],
      });

      const composite = new CompositeSignalProvider({
        providers: [nonArrayChild],
        rules: [
          {
            name: "rule.comp",
            unit: "count",
            inputs: ["sig.na"],
            compute: (v) => v["sig.na"] ?? 0,
          },
        ],
      });

      const readings = await composite.read(mockContext);
      assert.equal(readings.length, 2);

      const childReading = readings.find((r) => r.name === "sig.na");
      assert.ok(childReading);
      assert.equal(childReading.status, "error");
      assert.ok(
        (childReading as { error?: string })?.error?.includes("returned a non-array reading"),
      );
    });

    it("ignores malformed readings emitted by child providers (null or missing name)", async () => {
      const dirtyChild = createMockProvider({
        id: "dirty-provider",
        signals: [
          { name: "sig.good", unit: "count" },
          { name: "sig.omitted", unit: "count" },
        ],
        read: () =>
          [
            null,
            { unit: "count" }, // missing name
            {
              name: "sig.good",
              unit: "count",
              status: "ok",
              value: 10,
              observedAt: mockContext.now,
            },
            // sig.omitted is not returned
          ] as unknown as readonly ResourceSignal[],
      });

      const composite = new CompositeSignalProvider({
        providers: [dirtyChild],
        rules: [
          {
            name: "rule.good",
            unit: "count",
            inputs: ["sig.good"],
            compute: (v) => v["sig.good"] ?? 0,
          },
          {
            name: "rule.missing",
            unit: "count",
            inputs: ["sig.omitted"],
            compute: (v) => v["sig.omitted"] ?? 0,
          },
        ],
      });

      const readings = await composite.read(mockContext);
      const ruleGood = readings.find((r) => r.name === "rule.good");
      assert.equal(ruleGood?.status, "ok");
      assert.equal((ruleGood as { value?: number })?.value, 10);

      // rule.missing expects sig.omitted which was not returned -> treated as unknown
      const ruleMissing = readings.find((r) => r.name === "rule.missing");
      assert.equal(ruleMissing?.status, "unknown");
      assert.ok((ruleMissing as { error?: string })?.error?.includes('dominant: "unknown"'));
    });

    it("sanitizes undeclared child signals and never returns them in childReadings", async () => {
      const child = createMockProvider({
        id: "leaky-child",
        signals: [{ name: "declared.sig", unit: "ratio" }],
        read: () => [
          {
            name: "declared.sig",
            unit: "ratio",
            status: "ok",
            value: 0.8,
            observedAt: mockContext.now,
          },
          {
            name: "undeclared.sig",
            unit: "ratio",
            status: "ok",
            value: 0.2,
            observedAt: mockContext.now,
          },
        ],
      });

      const composite = new CompositeSignalProvider({
        providers: [child],
        rules: [
          {
            name: "rule.out",
            unit: "ratio",
            inputs: ["declared.sig"],
            compute: (v) => v["declared.sig"] ?? 0,
          },
        ],
        passthroughInputs: true,
      });

      const readings = await composite.read(mockContext);
      const names = readings.map((r) => r.name);
      assert.deepEqual(names, ["declared.sig", "rule.out"]);
      assert.equal(names.includes("undeclared.sig"), false);
    });

    it("never emits duplicate readings even if child provider returns duplicate readings", async () => {
      const child = createMockProvider({
        id: "duplicate-emitter",
        signals: [{ name: "single.sig", unit: "ratio" }],
        read: () => [
          {
            name: "single.sig",
            unit: "ratio",
            status: "ok",
            value: 0.3,
            observedAt: mockContext.now,
          },
          {
            name: "single.sig",
            unit: "ratio",
            status: "ok",
            value: 0.7,
            observedAt: mockContext.now,
          },
        ],
      });

      const composite = new CompositeSignalProvider({
        providers: [child],
        rules: [
          {
            name: "rule.out",
            unit: "ratio",
            inputs: ["single.sig"],
            compute: (v) => v["single.sig"] ?? 0,
          },
        ],
        passthroughInputs: true,
      });

      const readings = await composite.read(mockContext);
      assert.equal(readings.length, 2);
      assert.deepEqual(
        readings.map((r) => r.name),
        ["single.sig", "rule.out"],
      );
    });
  });

  describe("priority status resolution (error > stale > unsupported > unknown)", () => {
    it("resolves strict priority order among input signals", async () => {
      const multiChild = createMockProvider({
        id: "status-provider",
        signals: [
          { name: "s.ok", unit: "ratio" },
          { name: "s.unknown", unit: "ratio" },
          { name: "s.unsupported", unit: "ratio" },
          { name: "s.stale", unit: "ratio" },
          { name: "s.error", unit: "ratio" },
        ],
        read: () => [
          { name: "s.ok", unit: "ratio", status: "ok", value: 0.9, observedAt: mockContext.now },
          {
            name: "s.unknown",
            unit: "ratio",
            status: "unknown",
            observedAt: mockContext.now,
            error: "Not yet warm",
          },
          {
            name: "s.unsupported",
            unit: "ratio",
            status: "unsupported",
            observedAt: mockContext.now,
            error: "Not supported on platform",
          },
          {
            name: "s.stale",
            unit: "ratio",
            status: "stale",
            observedAt: mockContext.now,
            error: "Sensor expired",
          },
          {
            name: "s.error",
            unit: "ratio",
            status: "error",
            observedAt: mockContext.now,
            error: "Sensor hardware fault",
          },
        ],
      });

      const composite = new CompositeSignalProvider({
        providers: [multiChild],
        rules: [
          // 1. error > stale
          {
            name: "r.error_over_stale",
            unit: "ratio",
            inputs: ["s.stale", "s.error"],
            compute: () => 1,
          },
          // 2. stale > unsupported
          {
            name: "r.stale_over_unsupported",
            unit: "ratio",
            inputs: ["s.unsupported", "s.stale"],
            compute: () => 1,
          },
          // 3. unsupported > unknown
          {
            name: "r.unsupported_over_unknown",
            unit: "ratio",
            inputs: ["s.unknown", "s.unsupported"],
            compute: () => 1,
          },
          // 4. error > unknown
          {
            name: "r.error_over_unknown",
            unit: "ratio",
            inputs: ["s.unknown", "s.error"],
            compute: () => 1,
          },
          // 5. error > all
          {
            name: "r.error_over_all",
            unit: "ratio",
            inputs: ["s.ok", "s.unknown", "s.unsupported", "s.stale", "s.error"],
            compute: () => 1,
          },
          // 6. unknown with ok (unknown dominant)
          {
            name: "r.unknown_with_ok",
            unit: "ratio",
            inputs: ["s.ok", "s.unknown"],
            compute: () => 1,
          },
          // 7. multiple same status (checks incoming <= current branch in resolvePriority)
          {
            name: "r.multiple_unknown",
            unit: "ratio",
            inputs: ["s.unknown", "s.unknown"],
            compute: () => 1,
          },
        ],
      });

      const readings = await composite.read(mockContext);
      const findRule = (name: string) => readings.find((r) => r.name === name);

      assert.equal(findRule("r.error_over_stale")?.status, "error");
      assert.equal(findRule("r.stale_over_unsupported")?.status, "stale");
      assert.equal(findRule("r.unsupported_over_unknown")?.status, "unsupported");
      assert.equal(findRule("r.error_over_unknown")?.status, "error");
      assert.equal(findRule("r.error_over_all")?.status, "error");
      assert.equal(findRule("r.unknown_with_ok")?.status, "unknown");
      assert.equal(findRule("r.multiple_unknown")?.status, "unknown");

      // Verify that no value: 0 is ever set on unavailable readings
      for (const ruleName of [
        "r.error_over_stale",
        "r.stale_over_unsupported",
        "r.unsupported_over_unknown",
        "r.error_over_unknown",
        "r.error_over_all",
        "r.unknown_with_ok",
        "r.multiple_unknown",
      ]) {
        const reading = findRule(ruleName);
        assert.equal(
          (reading as { value?: unknown })?.value,
          undefined,
          `Rule ${ruleName} must not emit value`,
        );
        assert.ok(
          (reading as { error?: string })?.error,
          `Rule ${ruleName} must have an error explanation`,
        );
      }
    });

    it("treats corrupted 'ok' values (NaN, Infinity, non-number) and unrecognized statuses as error", async () => {
      const corruptedChild = createMockProvider({
        id: "corrupted-child",
        signals: [
          { name: "s.nan", unit: "ratio" },
          { name: "s.inf", unit: "ratio" },
          { name: "s.nonnum", unit: "ratio" },
          { name: "s.bogus_status", unit: "ratio" },
        ],
        read: () =>
          [
            {
              name: "s.nan",
              unit: "ratio",
              status: "ok",
              value: Number.NaN,
              observedAt: mockContext.now,
            },
            {
              name: "s.inf",
              unit: "ratio",
              status: "ok",
              value: Number.POSITIVE_INFINITY,
              observedAt: mockContext.now,
            },
            {
              name: "s.nonnum",
              unit: "ratio",
              status: "ok",
              value: "not-a-number" as unknown as number,
              observedAt: mockContext.now,
            },
            {
              name: "s.bogus_status",
              unit: "ratio",
              status: "unexpected_status" as unknown as "ok",
              observedAt: mockContext.now,
            },
          ] as unknown as readonly ResourceSignal[],
      });

      const composite = new CompositeSignalProvider({
        providers: [corruptedChild],
        rules: [
          { name: "r.nan", unit: "ratio", inputs: ["s.nan"], compute: () => 1 },
          { name: "r.inf", unit: "ratio", inputs: ["s.inf"], compute: () => 1 },
          { name: "r.nonnum", unit: "ratio", inputs: ["s.nonnum"], compute: () => 1 },
          { name: "r.bogus", unit: "ratio", inputs: ["s.bogus_status"], compute: () => 1 },
        ],
      });

      const readings = await composite.read(mockContext);
      const findRule = (name: string) => readings.find((r) => r.name === name);

      assert.equal(findRule("r.nan")?.status, "error");
      assert.equal(findRule("r.inf")?.status, "error");
      assert.equal(findRule("r.nonnum")?.status, "error");
      assert.equal(findRule("r.bogus")?.status, "error");
    });
  });

  describe("compute execution (exceptions, non-finite values, and happy path)", () => {
    it("handles compute throwing Error or non-Error safely as status: 'error'", async () => {
      const child = createMockProvider({
        id: "child-p",
        signals: [{ name: "s.in", unit: "ratio" }],
        read: () => [
          {
            name: "s.in",
            unit: "ratio",
            status: "ok",
            value: 10,
            observedAt: mockContext.now,
          },
        ],
      });

      const composite = new CompositeSignalProvider({
        providers: [child],
        rules: [
          {
            name: "r.throw_err",
            unit: "ratio",
            inputs: ["s.in"],
            compute: () => {
              throw new Error("Mathematical singularity");
            },
          },
          {
            name: "r.throw_string",
            unit: "ratio",
            inputs: ["s.in"],
            compute: () => {
              // eslint-disable-next-line @typescript-eslint/no-throw-literal
              throw "Literal error string";
            },
          },
        ],
      });

      const readings = await composite.read(mockContext);
      const r1 = readings.find((r) => r.name === "r.throw_err");
      assert.equal(r1?.status, "error");
      assert.ok((r1 as { error?: string })?.error?.includes("Mathematical singularity"));
      assert.equal((r1 as { value?: unknown })?.value, undefined);

      const r2 = readings.find((r) => r.name === "r.throw_string");
      assert.equal(r2?.status, "error");
      assert.ok((r2 as { error?: string })?.error?.includes("Literal error string"));
      assert.equal((r2 as { value?: unknown })?.value, undefined);
    });

    it("handles compute returning non-finite values (NaN, Infinity, -Infinity) or non-number as status: 'error'", async () => {
      const child = createMockProvider({
        id: "child-p",
        signals: [{ name: "s.in", unit: "ratio" }],
        read: () => [
          {
            name: "s.in",
            unit: "ratio",
            status: "ok",
            value: 10,
            observedAt: mockContext.now,
          },
        ],
      });

      const composite = new CompositeSignalProvider({
        providers: [child],
        rules: [
          {
            name: "r.return_nan",
            unit: "ratio",
            inputs: ["s.in"],
            compute: () => Number.NaN,
          },
          {
            name: "r.return_pos_inf",
            unit: "ratio",
            inputs: ["s.in"],
            compute: () => Number.POSITIVE_INFINITY,
          },
          {
            name: "r.return_neg_inf",
            unit: "ratio",
            inputs: ["s.in"],
            compute: () => Number.NEGATIVE_INFINITY,
          },
          {
            name: "r.return_non_number",
            unit: "ratio",
            inputs: ["s.in"],
            compute: () => "not-a-number" as unknown as number,
          },
        ],
      });

      const readings = await composite.read(mockContext);
      for (const name of [
        "r.return_nan",
        "r.return_pos_inf",
        "r.return_neg_inf",
        "r.return_non_number",
      ]) {
        const r = readings.find((item) => item.name === name);
        assert.equal(r?.status, "error", `Expected ${name} to have status error`);
        assert.ok(
          (r as { error?: string })?.error?.includes("non-finite value"),
          `Expected ${name} error to describe non-finite value`,
        );
        assert.equal((r as { value?: unknown })?.value, undefined);
      }
    });

    it("computes happy path composite signals and passes frozen values record", async () => {
      let inspectedValues: Readonly<Record<string, number>> | null = null;
      const child = createMockProvider({
        id: "metrics-provider",
        signals: [
          { name: "cpu.percent", unit: "ratio" },
          { name: "memory.heap.ratio", unit: "ratio" },
        ],
        read: () => [
          {
            name: "cpu.percent",
            unit: "ratio",
            status: "ok",
            value: 0.4,
            observedAt: mockContext.now,
          },
          {
            name: "memory.heap.ratio",
            unit: "ratio",
            status: "ok",
            value: 0.6,
            observedAt: mockContext.now,
          },
        ],
      });

      const composite = new CompositeSignalProvider({
        providers: [child],
        rules: [
          {
            name: "system.pressure.score",
            unit: "ratio",
            description: "Weighted system pressure (0.7 * cpu + 0.3 * mem)",
            inputs: ["cpu.percent", "memory.heap.ratio"],
            compute: (v) => {
              inspectedValues = v;
              const cpu = v["cpu.percent"] ?? 0;
              const mem = v["memory.heap.ratio"] ?? 0;
              return Math.round((0.7 * cpu + 0.3 * mem) * 100) / 100;
            },
          },
          {
            name: "system.is_idle",
            unit: "count",
            inputs: ["cpu.percent"],
            compute: (v) => ((v["cpu.percent"] ?? 0) < 0.1 ? 1 : 0),
          },
        ],
      });

      const readings = await composite.read(mockContext);
      assert.equal(readings.length, 4); // 2 child + 2 composite

      const pressureReading = readings.find((r) => r.name === "system.pressure.score");
      assert.ok(pressureReading);
      assert.equal(pressureReading.status, "ok");
      assert.equal(pressureReading.observedAt, mockContext.now);
      // 0.7 * 0.4 + 0.3 * 0.6 = 0.28 + 0.18 = 0.46
      assert.equal((pressureReading as { value: number }).value, 0.46);

      const idleReading = readings.find((r) => r.name === "system.is_idle");
      assert.ok(idleReading);
      assert.equal(idleReading.status, "ok");
      assert.equal((idleReading as { value: number }).value, 0); // valid 0 value when status: ok

      // Values object must be frozen and have null prototype
      assert.ok(inspectedValues);
      assert.ok(Object.isFrozen(inspectedValues));
      assert.equal(Object.getPrototypeOf(inspectedValues), null);
      assert.throws(() => {
        (inspectedValues as Record<string, number>)["cpu.percent"] = 1;
      });
    });
  });

  describe("passthroughInputs true vs false", () => {
    it("includes child readings when passthroughInputs is true (default)", async () => {
      const child = createMockProvider({
        id: "child-p",
        signals: [{ name: "child.sig", unit: "count" }],
        read: () => [
          {
            name: "child.sig",
            unit: "count",
            status: "ok",
            value: 5,
            observedAt: mockContext.now,
          },
        ],
      });
      const composite = new CompositeSignalProvider({
        providers: [child],
        rules: [
          {
            name: "rule.sig",
            unit: "count",
            inputs: ["child.sig"],
            compute: (v) => (v["child.sig"] ?? 0) * 10,
          },
        ],
      });

      assert.deepEqual(
        composite.signals.map((s) => s.name),
        ["child.sig", "rule.sig"],
      );

      const readings = await composite.read(mockContext);
      assert.equal(readings.length, 2);
      assert.equal(readings[0]?.name, "child.sig");
      assert.equal(readings[1]?.name, "rule.sig");
    });

    it("omits child readings and descriptors when passthroughInputs is false", async () => {
      const child = createMockProvider({
        id: "child-p",
        signals: [{ name: "child.sig", unit: "count" }],
        read: () => [
          {
            name: "child.sig",
            unit: "count",
            status: "ok",
            value: 5,
            observedAt: mockContext.now,
          },
        ],
      });
      const composite = new CompositeSignalProvider({
        providers: [child],
        rules: [
          {
            name: "rule.sig",
            unit: "count",
            inputs: ["child.sig"],
            compute: (v) => (v["child.sig"] ?? 0) * 10,
          },
        ],
        passthroughInputs: false,
      });

      assert.deepEqual(
        composite.signals.map((s) => s.name),
        ["rule.sig"],
      );

      const readings = await composite.read(mockContext);
      assert.equal(readings.length, 1);
      assert.equal(readings[0]?.name, "rule.sig");
      assert.equal((readings[0] as { value: number }).value, 50);
    });
  });

  describe("realistic domain scenarios", () => {
    it("derives network bandwidth-delay product (BDP) in bytes", async () => {
      const networkProvider = createMockProvider({
        id: "network-provider",
        signals: [
          { name: "web.network.rttMs", unit: "milliseconds", description: "RTT" },
          { name: "web.network.downlinkMbps", unit: "custom", description: "Downlink" },
        ],
        read: () => [
          {
            name: "web.network.rttMs",
            unit: "milliseconds",
            status: "ok",
            value: 50,
            observedAt: mockContext.now,
          },
          {
            name: "web.network.downlinkMbps",
            unit: "custom",
            status: "ok",
            value: 100,
            observedAt: mockContext.now,
          },
        ],
      });

      // BDP (bytes) = (bandwidth (bits/sec) * RTT (sec)) / 8
      // 100 Mbps = 100 * 1,000,000 bits/sec
      // 50 ms = 0.05 sec
      // BDP = (100_000_000 * 0.05) / 8 = 625,000 bytes
      const bdpRule: CompositeSignalRule = {
        name: "network.bandwidthDelayProductBytes",
        unit: "bytes",
        description: "Bandwidth-delay product buffer recommendation in bytes",
        inputs: ["web.network.rttMs", "web.network.downlinkMbps"],
        compute: (v) => {
          const rttSec = (v["web.network.rttMs"] ?? 0) / 1000;
          const bitsPerSec = (v["web.network.downlinkMbps"] ?? 0) * 1_000_000;
          return (bitsPerSec * rttSec) / 8;
        },
      };

      const composite = new CompositeSignalProvider({
        id: "network-composite",
        providers: [networkProvider],
        rules: [bdpRule],
      });

      const readings = await composite.read(mockContext);
      const bdp = readings.find((r) => r.name === "network.bandwidthDelayProductBytes");
      assert.ok(bdp);
      assert.equal(bdp.status, "ok");
      assert.equal((bdp as { value: number }).value, 625_000);
      assert.equal(bdp.unit, "bytes");
    });
  });

  describe("integration with AdaptiveRuntime", () => {
    it("runs within AdaptiveRuntime without provider:error events", async () => {
      const child = createMockProvider({
        id: "child-provider",
        signals: [{ name: "child.metric", unit: "ratio", description: "Child metric" }],
        read: (ctx) => [
          {
            name: "child.metric",
            unit: "ratio",
            status: "ok",
            value: 0.75,
            observedAt: ctx.now,
          },
        ],
      });

      const composite = new CompositeSignalProvider({
        id: "composite-provider",
        providers: [child],
        rules: [
          {
            name: "composite.ratio",
            unit: "ratio",
            inputs: ["child.metric"],
            compute: (v) => (v["child.metric"] ?? 0) * 2,
          },
        ],
      });

      const runtime = createAdaptiveRuntime({
        providers: [composite],
      });

      const providerErrors: unknown[] = [];
      runtime.on("provider:error", (evt) => {
        providerErrors.push(evt);
      });

      const result = await runtime.run({
        operationId: "composite-integration-test",
        input: undefined,
        strategies: [
          {
            id: "strat-primary",
            qualityTier: 1,
            run: () => "success",
          },
        ],
      });

      assert.equal(result.value, "success");
      assert.equal(providerErrors.length, 0);

      const decisionSignals = result.metadata.decision.signals;
      assert.equal(decisionSignals.length, 2);

      const childSignal = decisionSignals.find((s) => s.name === "child.metric");
      assert.ok(childSignal);
      assert.equal(childSignal?.status, "ok");
      assert.equal(childSignal?.value, 0.75);

      const compSignal = decisionSignals.find((s) => s.name === "composite.ratio");
      assert.ok(compSignal);
      assert.equal(compSignal?.status, "ok");
      assert.equal(compSignal?.value, 1.5);

      await runtime.close();
    });

    it("sanitizes undeclared child signals so SignalCollector never throws or emits provider:error", async () => {
      const child = createMockProvider({
        id: "child-provider-undeclared",
        signals: [{ name: "declared.signal", unit: "ratio" }],
        read: (ctx) => [
          {
            name: "declared.signal",
            unit: "ratio",
            status: "ok",
            value: 0.5,
            observedAt: ctx.now,
          },
          {
            name: "rogue.undeclared",
            unit: "ratio",
            status: "ok",
            value: 0.99,
            observedAt: ctx.now,
          },
        ],
      });

      const composite = new CompositeSignalProvider({
        id: "composite-sanitizer",
        providers: [child],
        rules: [
          {
            name: "composite.normalized",
            unit: "ratio",
            inputs: ["declared.signal"],
            compute: (v) => (v["declared.signal"] ?? 0) * 10,
          },
        ],
        passthroughInputs: true,
      });

      const runtime = createAdaptiveRuntime({
        providers: [composite],
      });

      const providerErrors: unknown[] = [];
      runtime.on("provider:error", (evt) => {
        providerErrors.push(evt);
      });

      const result = await runtime.run({
        operationId: "undeclared-sanitization-test",
        input: undefined,
        strategies: [
          {
            id: "strat-1",
            qualityTier: 1,
            run: () => "ok",
          },
        ],
      });

      assert.equal(result.value, "ok");
      assert.equal(providerErrors.length, 0);

      const signalNames = [...result.metadata.decision.signals.map((s) => s.name)].sort();
      assert.deepEqual(signalNames, ["composite.normalized", "declared.signal"]);
      assert.equal(signalNames.includes("rogue.undeclared"), false);

      await runtime.close();
    });
  });
});
