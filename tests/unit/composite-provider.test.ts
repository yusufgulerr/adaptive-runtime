import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigurationError } from "../../src/errors/index.js";
import {
  type CompositeCombinerMode,
  CompositeSignalProvider,
  type CompositeSignalProviderOptions,
  type CompositeSignalRule,
  createCompositeSignalProvider,
  type SourceUnavailableInfo,
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

  describe("createCompositeSignalProvider and Combiner Modes", () => {
    const val = (r: ResourceSignal | undefined): unknown => (r as { value?: unknown })?.value;

    const child1 = createMockProvider({
      id: "child-1",
      signals: [
        { name: "p1.val", unit: "count" },
        { name: "p1.lat", unit: "milliseconds" },
      ],
      read: () => [
        { name: "p1.val", unit: "count", status: "ok", value: 10, observedAt: 1000 },
        { name: "p1.lat", unit: "milliseconds", status: "ok", value: 50, observedAt: 1000 },
      ],
    });

    const child2 = createMockProvider({
      id: "child-2",
      signals: [
        { name: "p2.val", unit: "count" },
        { name: "p2.lat", unit: "milliseconds" },
      ],
      read: () => [
        { name: "p2.val", unit: "count", status: "ok", value: 30, observedAt: 1000 },
        { name: "p2.lat", unit: "milliseconds", status: "ok", value: 20, observedAt: 1000 },
      ],
    });

    const child3 = createMockProvider({
      id: "child-3",
      signals: [
        { name: "p3.val", unit: "count" },
        { name: "p3.lat", unit: "milliseconds" },
      ],
      read: () => [
        { name: "p3.val", unit: "count", status: "ok", value: 20, observedAt: 1000 },
        { name: "p3.lat", unit: "milliseconds", status: "ok", value: 80, observedAt: 1000 },
      ],
    });

    describe("factory validation", () => {
      it("rejects non-object or null options", () => {
        assert.throws(
          () => createCompositeSignalProvider(null as unknown as CompositeSignalProviderOptions),
          ConfigurationError,
        );
        assert.throws(
          () =>
            createCompositeSignalProvider(undefined as unknown as CompositeSignalProviderOptions),
          ConfigurationError,
        );
      });

      it("rejects missing or empty providers", () => {
        assert.throws(
          () =>
            createCompositeSignalProvider({
              providers: [],
              rules: [{ name: "r", unit: "count", inputs: ["p1.val"], compute: () => 1 }],
            }),
          ConfigurationError,
        );
      });

      it("rejects when neither rules nor shorthand is provided", () => {
        assert.throws(
          () =>
            createCompositeSignalProvider({
              providers: [child1],
            }),
          ConfigurationError,
        );
      });

      it("validates shorthand options thoroughly", () => {
        // Invalid name
        assert.throws(
          () =>
            createCompositeSignalProvider({
              providers: [child1],
              name: " ",
              unit: "count",
              sources: ["p1.val"],
              mode: "median",
            }),
          ConfigurationError,
        );
        // Invalid unit
        assert.throws(
          () =>
            createCompositeSignalProvider({
              providers: [child1],
              name: "r.test",
              unit: "lightyears" as unknown as SignalUnit,
              sources: ["p1.val"],
              mode: "median",
            }),
          ConfigurationError,
        );
        // Missing sources
        assert.throws(
          () =>
            createCompositeSignalProvider({
              providers: [child1],
              name: "r.test",
              unit: "count",
              sources: [],
              mode: "median",
            }),
          ConfigurationError,
        );
        // Invalid combiner mode
        assert.throws(
          () =>
            createCompositeSignalProvider({
              providers: [child1],
              name: "r.test",
              unit: "count",
              sources: ["p1.val"],
              mode: "unsupported_mode" as unknown as CompositeCombinerMode,
            }),
          ConfigurationError,
        );
        // Shorthand minAvailableSources out of bounds
        assert.throws(
          () =>
            createCompositeSignalProvider({
              providers: [child1],
              name: "r.test",
              unit: "count",
              sources: ["p1.val"],
              mode: "median",
              minAvailableSources: 2,
            }),
          ConfigurationError,
        );
      });

      it("creates a provider with rules or shorthand", async () => {
        const fromRules = createCompositeSignalProvider({
          id: "from-rules",
          providers: [child1, child2],
          rules: [
            {
              name: "comp.median",
              unit: "count",
              sources: ["p1.val", "p2.val"],
              mode: "median",
            },
          ],
        });
        assert.equal(fromRules.id, "from-rules");
        const resRules = await fromRules.read(mockContext);
        const r1 = resRules.find((r) => r.name === "comp.median");
        assert.equal(r1?.status, "ok");
        assert.equal((r1 as { value?: number })?.value, 20);

        const fromShorthand = createCompositeSignalProvider({
          id: "from-shorthand",
          providers: [child1, child2],
          name: "comp.spread",
          unit: "count",
          sources: ["p1.val", "p2.val"],
          mode: "spread",
        });
        assert.equal(fromShorthand.id, "from-shorthand");
        const resShort = await fromShorthand.read(mockContext);
        const r2 = resShort.find((r) => r.name === "comp.spread");
        assert.equal(r2?.status, "ok");
        assert.equal((r2 as { value?: number })?.value, 20);
      });
    });

    describe("median aggregation operator", () => {
      it("computes exact median for odd count (1, 3, 5 sources)", async () => {
        // 1 source: [42] -> 42
        const p1 = createMockProvider({
          id: "m-odd-1",
          signals: [{ name: "s.single", unit: "count" }],
          read: () => [
            { name: "s.single", unit: "count", status: "ok", value: 42, observedAt: 1000 },
          ],
        });
        const comp1 = createCompositeSignalProvider({
          providers: [p1],
          name: "med.single",
          unit: "count",
          sources: ["s.single"],
          mode: "median",
        });
        const res1 = await comp1.read(mockContext);
        assert.equal(val(res1.find((r) => r.name === "med.single")), 42);

        // 3 sources: [10, 30, 20] -> sorted [10, 20, 30] -> middle is 20
        const comp3 = createCompositeSignalProvider({
          providers: [child1, child2, child3],
          name: "med.three",
          unit: "count",
          sources: ["p1.val", "p2.val", "p3.val"],
          mode: "median",
        });
        const res3 = await comp3.read(mockContext);
        assert.equal(val(res3.find((r) => r.name === "med.three")), 20);

        // 5 sources: [9, 1, 7, 3, 5] -> sorted [1, 3, 5, 7, 9] -> middle is 5
        const pFive = createMockProvider({
          id: "m-five",
          signals: [
            { name: "s1", unit: "count" },
            { name: "s2", unit: "count" },
            { name: "s3", unit: "count" },
            { name: "s4", unit: "count" },
            { name: "s5", unit: "count" },
          ],
          read: () => [
            { name: "s1", unit: "count", status: "ok", value: 9, observedAt: 1000 },
            { name: "s2", unit: "count", status: "ok", value: 1, observedAt: 1000 },
            { name: "s3", unit: "count", status: "ok", value: 7, observedAt: 1000 },
            { name: "s4", unit: "count", status: "ok", value: 3, observedAt: 1000 },
            { name: "s5", unit: "count", status: "ok", value: 5, observedAt: 1000 },
          ],
        });
        const comp5 = createCompositeSignalProvider({
          providers: [pFive],
          name: "med.five",
          unit: "count",
          sources: ["s1", "s2", "s3", "s4", "s5"],
          mode: "median",
        });
        const res5 = await comp5.read(mockContext);
        assert.equal(val(res5.find((r) => r.name === "med.five")), 5);
      });

      it("computes exact median for even count (2, 4 sources and fractional average)", async () => {
        // 2 sources: [10, 30] -> average is 20
        const comp2 = createCompositeSignalProvider({
          providers: [child1, child2],
          name: "med.two",
          unit: "count",
          sources: ["p1.val", "p2.val"],
          mode: "median",
        });
        const res2 = await comp2.read(mockContext);
        assert.equal(val(res2.find((r) => r.name === "med.two")), 20);

        // 4 sources: [10, 40, 20, 30] -> sorted [10, 20, 30, 40] -> (20+30)/2 = 25
        const pFour = createMockProvider({
          id: "m-four",
          signals: [
            { name: "f1", unit: "count" },
            { name: "f2", unit: "count" },
            { name: "f3", unit: "count" },
            { name: "f4", unit: "count" },
          ],
          read: () => [
            { name: "f1", unit: "count", status: "ok", value: 10, observedAt: 1000 },
            { name: "f2", unit: "count", status: "ok", value: 40, observedAt: 1000 },
            { name: "f3", unit: "count", status: "ok", value: 20, observedAt: 1000 },
            { name: "f4", unit: "count", status: "ok", value: 30, observedAt: 1000 },
          ],
        });
        const comp4 = createCompositeSignalProvider({
          providers: [pFour],
          name: "med.four",
          unit: "count",
          sources: ["f1", "f2", "f3", "f4"],
          mode: "median",
        });
        const res4 = await comp4.read(mockContext);
        assert.equal(val(res4.find((r) => r.name === "med.four")), 25);

        // Fractional average: [1, 2] -> 1.5
        const pFrac = createMockProvider({
          id: "m-frac",
          signals: [
            { name: "fr1", unit: "ratio" },
            { name: "fr2", unit: "ratio" },
          ],
          read: () => [
            { name: "fr1", unit: "ratio", status: "ok", value: 1, observedAt: 1000 },
            { name: "fr2", unit: "ratio", status: "ok", value: 2, observedAt: 1000 },
          ],
        });
        const compFrac = createCompositeSignalProvider({
          providers: [pFrac],
          name: "med.frac",
          unit: "ratio",
          sources: ["fr1", "fr2"],
          mode: "median",
        });
        const resFrac = await compFrac.read(mockContext);
        assert.equal(val(resFrac.find((r) => r.name === "med.frac")), 1.5);
      });

      it("handles negative numbers and duplicate values", async () => {
        const pNeg = createMockProvider({
          id: "m-neg",
          signals: [
            { name: "n1", unit: "count" },
            { name: "n2", unit: "count" },
            { name: "n3", unit: "count" },
          ],
          read: () => [
            { name: "n1", unit: "count", status: "ok", value: -10, observedAt: 1000 },
            { name: "n2", unit: "count", status: "ok", value: 0, observedAt: 1000 },
            { name: "n3", unit: "count", status: "ok", value: 10, observedAt: 1000 },
          ],
        });
        const compNeg = createCompositeSignalProvider({
          providers: [pNeg],
          name: "med.neg",
          unit: "count",
          sources: ["n1", "n2", "n3"],
          mode: "median",
        });
        const resNeg = await compNeg.read(mockContext);
        assert.equal(val(resNeg.find((r) => r.name === "med.neg")), 0);

        const pDup = createMockProvider({
          id: "m-dup",
          signals: [
            { name: "d1", unit: "count" },
            { name: "d2", unit: "count" },
            { name: "d3", unit: "count" },
            { name: "d4", unit: "count" },
          ],
          read: () => [
            { name: "d1", unit: "count", status: "ok", value: 5, observedAt: 1000 },
            { name: "d2", unit: "count", status: "ok", value: 5, observedAt: 1000 },
            { name: "d3", unit: "count", status: "ok", value: 5, observedAt: 1000 },
            { name: "d4", unit: "count", status: "ok", value: 5, observedAt: 1000 },
          ],
        });
        const compDup = createCompositeSignalProvider({
          providers: [pDup],
          name: "med.dup",
          unit: "count",
          sources: ["d1", "d2", "d3", "d4"],
          mode: "median",
        });
        const resDup = await compDup.read(mockContext);
        assert.equal(val(resDup.find((r) => r.name === "med.dup")), 5);
      });

      it("computes median over available source values when some sources fail", async () => {
        const pMixed = createMockProvider({
          id: "m-mixed",
          signals: [
            { name: "m1", unit: "count" },
            { name: "m2", unit: "count" },
            { name: "m3", unit: "count" },
            { name: "m4", unit: "count" },
          ],
          read: () => [
            { name: "m1", unit: "count", status: "ok", value: 10, observedAt: 1000 },
            { name: "m2", unit: "count", status: "error", error: "fail", observedAt: 1000 },
            { name: "m3", unit: "count", status: "ok", value: 30, observedAt: 1000 },
            { name: "m4", unit: "count", status: "ok", value: 50, observedAt: 1000 },
          ],
        });
        const comp = createCompositeSignalProvider({
          providers: [pMixed],
          name: "med.mixed",
          unit: "count",
          sources: ["m1", "m2", "m3", "m4"],
          mode: "median",
        });
        const res = await comp.read(mockContext);
        assert.equal(val(res.find((r) => r.name === "med.mixed")), 30);
        assert.equal(res.find((r) => r.name === "med.mixed")?.status, "ok");
      });
    });

    describe("spread aggregation operator", () => {
      it("computes 0 when only 1 available source", async () => {
        const p1 = createMockProvider({
          id: "sp-1",
          signals: [{ name: "s.single", unit: "count" }],
          read: () => [
            { name: "s.single", unit: "count", status: "ok", value: 42, observedAt: 1000 },
          ],
        });
        const comp1 = createCompositeSignalProvider({
          providers: [p1],
          name: "spread.single",
          unit: "count",
          sources: ["s.single"],
          mode: "spread",
        });
        const res1 = await comp1.read(mockContext);
        assert.equal(val(res1.find((r) => r.name === "spread.single")), 0);
      });

      it("computes max - min across multiple sources", async () => {
        // [10, 30] -> 20
        const comp2 = createCompositeSignalProvider({
          providers: [child1, child2],
          name: "spread.two",
          unit: "count",
          sources: ["p1.val", "p2.val"],
          mode: "spread",
        });
        const res2 = await comp2.read(mockContext);
        assert.equal(val(res2.find((r) => r.name === "spread.two")), 20);

        // [50, 20, 80] -> 80 - 20 = 60
        const comp3 = createCompositeSignalProvider({
          providers: [child1, child2, child3],
          name: "spread.three",
          unit: "milliseconds",
          sources: ["p1.lat", "p2.lat", "p3.lat"],
          mode: "spread",
        });
        const res3 = await comp3.read(mockContext);
        assert.equal(val(res3.find((r) => r.name === "spread.three")), 60);
      });

      it("computes 0 when all values are equal", async () => {
        const pEqual = createMockProvider({
          id: "sp-eq",
          signals: [
            { name: "e1", unit: "count" },
            { name: "e2", unit: "count" },
          ],
          read: () => [
            { name: "e1", unit: "count", status: "ok", value: 7, observedAt: 1000 },
            { name: "e2", unit: "count", status: "ok", value: 7, observedAt: 1000 },
          ],
        });
        const comp = createCompositeSignalProvider({
          providers: [pEqual],
          name: "spread.eq",
          unit: "count",
          sources: ["e1", "e2"],
          mode: "spread",
        });
        const res = await comp.read(mockContext);
        assert.equal(val(res.find((r) => r.name === "spread.eq")), 0);
      });

      it("handles negative values in spread calculation", async () => {
        const pNeg = createMockProvider({
          id: "sp-neg",
          signals: [
            { name: "n1", unit: "count" },
            { name: "n2", unit: "count" },
          ],
          read: () => [
            { name: "n1", unit: "count", status: "ok", value: -20, observedAt: 1000 },
            { name: "n2", unit: "count", status: "ok", value: 10, observedAt: 1000 },
          ],
        });
        const comp = createCompositeSignalProvider({
          providers: [pNeg],
          name: "spread.neg",
          unit: "count",
          sources: ["n1", "n2"],
          mode: "spread",
        });
        const res = await comp.read(mockContext);
        assert.equal(val(res.find((r) => r.name === "spread.neg")), 30);
      });

      it("computes spread over available source values when some sources fail", async () => {
        const pMixed = createMockProvider({
          id: "sp-mixed",
          signals: [
            { name: "x1", unit: "count" },
            { name: "x2", unit: "count" },
            { name: "x3", unit: "count" },
          ],
          read: () => [
            { name: "x1", unit: "count", status: "ok", value: 100, observedAt: 1000 },
            {
              name: "x2",
              unit: "count",
              status: "error",
              error: "hardware err",
              observedAt: 1000,
            },
            { name: "x3", unit: "count", status: "ok", value: 80, observedAt: 1000 },
          ],
        });
        const comp = createCompositeSignalProvider({
          providers: [pMixed],
          name: "spread.mixed",
          unit: "count",
          sources: ["x1", "x2", "x3"],
          mode: "spread",
        });
        const res = await comp.read(mockContext);
        assert.equal(val(res.find((r) => r.name === "spread.mixed")), 20);
        assert.equal(res.find((r) => r.name === "spread.mixed")?.status, "ok");

        const pSingleAvailable = createMockProvider({
          id: "sp-one-avail",
          signals: [
            { name: "y1", unit: "count" },
            { name: "y2", unit: "count" },
          ],
          read: () => [
            { name: "y1", unit: "count", status: "ok", value: 55, observedAt: 1000 },
            { name: "y2", unit: "count", status: "unknown", observedAt: 1000 },
          ],
        });
        const compOne = createCompositeSignalProvider({
          providers: [pSingleAvailable],
          name: "spread.one",
          unit: "count",
          sources: ["y1", "y2"],
          mode: "spread",
        });
        const resOne = await compOne.read(mockContext);
        assert.equal(val(resOne.find((r) => r.name === "spread.one")), 0);
      });
    });

    describe("additional combiner modes (min, max, mean, sum, p95)", () => {
      it("computes min, max, mean, sum, and p95 across available values", async () => {
        const pVals = createMockProvider({
          id: "comb-all",
          signals: [
            { name: "v1", unit: "count" },
            { name: "v2", unit: "count" },
            { name: "v3", unit: "count" },
          ],
          read: () => [
            { name: "v1", unit: "count", status: "ok", value: 10, observedAt: 1000 },
            { name: "v2", unit: "count", status: "ok", value: 20, observedAt: 1000 },
            { name: "v3", unit: "count", status: "ok", value: 30, observedAt: 1000 },
          ],
        });
        const comp = new CompositeSignalProvider({
          providers: [pVals],
          rules: [
            { name: "r.min", unit: "count", sources: ["v1", "v2", "v3"], mode: "min" },
            { name: "r.max", unit: "count", sources: ["v1", "v2", "v3"], mode: "max" },
            { name: "r.mean", unit: "count", sources: ["v1", "v2", "v3"], mode: "mean" },
            { name: "r.sum", unit: "count", sources: ["v1", "v2", "v3"], mode: "sum" },
            { name: "r.p95", unit: "count", sources: ["v1", "v2", "v3"], mode: "p95" },
          ],
        });
        const readings = await comp.read(mockContext);
        assert.equal(val(readings.find((r) => r.name === "r.min")), 10);
        assert.equal(val(readings.find((r) => r.name === "r.max")), 30);
        assert.equal(val(readings.find((r) => r.name === "r.mean")), 20);
        assert.equal(val(readings.find((r) => r.name === "r.sum")), 60);
        assert.equal(val(readings.find((r) => r.name === "r.p95")), 30);
      });

      it("returns dominantStatus when no sources are available for combiner mode", async () => {
        const pErr = createMockProvider({
          id: "all-err",
          signals: [
            { name: "e1", unit: "count" },
            { name: "e2", unit: "count" },
          ],
          read: () => [
            { name: "e1", unit: "count", status: "error", error: "e1 fail", observedAt: 1000 },
            { name: "e2", unit: "count", status: "stale", error: "e2 stale", observedAt: 1000 },
          ],
        });
        const comp = createCompositeSignalProvider({
          providers: [pErr],
          name: "r.fail",
          unit: "count",
          sources: ["e1", "e2"],
          mode: "median",
        });
        const readings = await comp.read(mockContext);
        const r = readings.find((x) => x.name === "r.fail");
        assert.equal(r?.status, "error");
      });
    });

    describe("minAvailableSources quorum option", () => {
      it("validates minAvailableSources in CompositeSignalRule", () => {
        // Less than 1
        assert.throws(
          () =>
            new CompositeSignalProvider({
              providers: [child1],
              rules: [
                {
                  name: "r.q0",
                  unit: "count",
                  sources: ["p1.val"],
                  mode: "median",
                  minAvailableSources: 0,
                },
              ],
            }),
          ConfigurationError,
        );
        // Negative
        assert.throws(
          () =>
            new CompositeSignalProvider({
              providers: [child1],
              rules: [
                {
                  name: "r.qneg",
                  unit: "count",
                  sources: ["p1.val"],
                  mode: "median",
                  minAvailableSources: -1,
                },
              ],
            }),
          ConfigurationError,
        );
        // Non-integer
        assert.throws(
          () =>
            new CompositeSignalProvider({
              providers: [child1, child2],
              rules: [
                {
                  name: "r.qfrac",
                  unit: "count",
                  sources: ["p1.val", "p2.val"],
                  mode: "median",
                  minAvailableSources: 1.5,
                },
              ],
            }),
          ConfigurationError,
        );
        // Non-number
        assert.throws(
          () =>
            new CompositeSignalProvider({
              providers: [child1],
              rules: [
                {
                  name: "r.qstr",
                  unit: "count",
                  sources: ["p1.val"],
                  mode: "median",
                  minAvailableSources: "1" as unknown as number,
                },
              ],
            }),
          ConfigurationError,
        );
        // Greater than sources.length
        assert.throws(
          () =>
            new CompositeSignalProvider({
              providers: [child1, child2],
              rules: [
                {
                  name: "r.qhigh",
                  unit: "count",
                  sources: ["p1.val", "p2.val"],
                  mode: "median",
                  minAvailableSources: 3,
                },
              ],
            }),
          ConfigurationError,
        );

        // Valid boundaries: 1 and 2 for 2 sources
        assert.doesNotThrow(
          () =>
            new CompositeSignalProvider({
              providers: [child1, child2],
              rules: [
                {
                  name: "r.q1",
                  unit: "count",
                  sources: ["p1.val", "p2.val"],
                  mode: "median",
                  minAvailableSources: 1,
                },
                {
                  name: "r.q2",
                  unit: "count",
                  sources: ["p1.val", "p2.val"],
                  mode: "median",
                  minAvailableSources: 2,
                },
              ],
            }),
        );
      });

      it("enforces quorum: emits unavailable with quorum_not_met when available < minAvailableSources", async () => {
        const pThree = createMockProvider({
          id: "p-quorum-test",
          signals: [
            { name: "q.s1", unit: "count" },
            { name: "q.s2", unit: "count" },
            { name: "q.s3", unit: "count" },
          ],
          read: () => [
            { name: "q.s1", unit: "count", status: "ok", value: 10, observedAt: 1000 },
            {
              name: "q.s2",
              unit: "count",
              status: "error",
              error: "failed probe",
              observedAt: 1000,
            },
            {
              name: "q.s3",
              unit: "count",
              status: "stale",
              error: "expired reading",
              observedAt: 1000,
            },
          ],
        });

        // 3 sources, only 1 available, requires 2
        const comp = new CompositeSignalProvider({
          providers: [pThree],
          rules: [
            {
              name: "r.quorum.strict",
              unit: "count",
              sources: ["q.s1", "q.s2", "q.s3"],
              mode: "median",
              minAvailableSources: 2,
            },
          ],
        });

        const readings = await comp.read(mockContext);
        const reading = readings.find((r) => r.name === "r.quorum.strict") as {
          status: string;
          value: unknown;
          reason?: string;
          details?: { reason?: string; availableSources?: number; minAvailableSources?: number };
        };

        assert.ok(reading);
        assert.equal(reading.status, "unavailable");
        assert.equal(reading.value, null);
        assert.equal(reading.reason, "quorum_not_met");
        assert.equal(reading.details?.reason, "quorum_not_met");
        assert.equal(reading.details?.availableSources, 1);
        assert.equal(reading.details?.minAvailableSources, 2);
      });

      it("succeeds when available >= minAvailableSources", async () => {
        const pThree = createMockProvider({
          id: "p-quorum-pass",
          signals: [
            { name: "qp.s1", unit: "count" },
            { name: "qp.s2", unit: "count" },
            { name: "qp.s3", unit: "count" },
          ],
          read: () => [
            { name: "qp.s1", unit: "count", status: "ok", value: 10, observedAt: 1000 },
            { name: "qp.s2", unit: "count", status: "ok", value: 30, observedAt: 1000 },
            { name: "qp.s3", unit: "count", status: "error", error: "offline", observedAt: 1000 },
          ],
        });

        const comp = new CompositeSignalProvider({
          providers: [pThree],
          rules: [
            {
              name: "r.quorum.pass.mode",
              unit: "count",
              sources: ["qp.s1", "qp.s2", "qp.s3"],
              mode: "median",
              minAvailableSources: 2,
            },
            {
              name: "r.quorum.pass.compute",
              unit: "count",
              sources: ["qp.s1", "qp.s2", "qp.s3"],
              compute: (vals) => (vals["qp.s1"] ?? 0) + (vals["qp.s2"] ?? 0),
              minAvailableSources: 2,
            },
          ],
        });

        const readings = await comp.read(mockContext);
        const rMode = readings.find((r) => r.name === "r.quorum.pass.mode");
        assert.equal(rMode?.status, "ok");
        assert.equal((rMode as { value?: number })?.value, 20);

        const rCompute = readings.find((r) => r.name === "r.quorum.pass.compute");
        assert.equal(rCompute?.status, "ok");
        assert.equal((rCompute as { value?: number })?.value, 40);
      });

      it("enforces quorum not met when 0 sources are available", async () => {
        const pZero = createMockProvider({
          id: "p-zero-avail",
          signals: [{ name: "z1", unit: "count" }],
          read: () => [
            { name: "z1", unit: "count", status: "error", error: "bad", observedAt: 1000 },
          ],
        });

        const comp = createCompositeSignalProvider({
          providers: [pZero],
          name: "r.zero",
          unit: "count",
          sources: ["z1"],
          mode: "median",
          minAvailableSources: 1,
        });

        const readings = await comp.read(mockContext);
        const r = readings.find((x) => x.name === "r.zero");
        assert.equal(r?.status, "unavailable");
        assert.equal((r as { value?: unknown })?.value, null);
        assert.equal((r as { reason?: string })?.reason, "quorum_not_met");
      });
    });

    describe("onSourceUnavailable diagnostic callback", () => {
      it("validates onSourceUnavailable option in constructor", () => {
        assert.throws(
          () =>
            new CompositeSignalProvider({
              providers: [child1],
              rules: [{ name: "r", unit: "count", sources: ["p1.val"], compute: () => 1 }],
              onSourceUnavailable: "not-a-func" as unknown as () => void,
            }),
          ConfigurationError,
        );

        assert.throws(
          () =>
            new CompositeSignalProvider({
              providers: [child1],
              rules: [{ name: "r", unit: "count", sources: ["p1.val"], compute: () => 1 }],
              onSourceUnavailable: 123 as unknown as () => void,
            }),
          ConfigurationError,
        );

        assert.doesNotThrow(
          () =>
            new CompositeSignalProvider({
              providers: [child1],
              rules: [{ name: "r", unit: "count", sources: ["p1.val"], compute: () => 1 }],
              onSourceUnavailable: () => {},
            }),
        );
      });

      it("invokes onSourceUnavailable when source is missing or not ok", async () => {
        const calls: SourceUnavailableInfo[] = [];

        const pDiag = createMockProvider({
          id: "p-diag",
          signals: [
            { name: "d.ok", unit: "count" },
            { name: "d.err", unit: "count" },
            { name: "d.stale", unit: "count" },
            { name: "d.missing", unit: "count" },
            { name: "d.nan", unit: "count" },
          ],
          read: () => [
            { name: "d.ok", unit: "count", status: "ok", value: 100, observedAt: 1000 },
            {
              name: "d.err",
              unit: "count",
              status: "error",
              error: "sensor faulty",
              observedAt: 1000,
            },
            {
              name: "d.stale",
              unit: "count",
              status: "stale",
              error: "cache stale",
              observedAt: 1000,
            },
            { name: "d.nan", unit: "count", status: "ok", value: NaN, observedAt: 1000 },
          ],
        });

        const comp = new CompositeSignalProvider({
          providers: [pDiag],
          rules: [
            {
              name: "rule.diag",
              unit: "count",
              sources: ["d.ok", "d.err", "d.stale", "d.missing", "d.nan"],
              mode: "median",
            },
          ],
          onSourceUnavailable: (info) => {
            calls.push(info);
          },
        });

        await comp.read(mockContext);

        assert.equal(calls.length, 4);

        const errCall = calls.find((c) => c.sourceSignalName === "d.err");
        assert.ok(errCall);
        assert.equal(errCall.ruleSignalName, "rule.diag");
        assert.equal(errCall.status, "error");
        assert.equal(errCall.reason, "sensor faulty");

        const staleCall = calls.find((c) => c.sourceSignalName === "d.stale");
        assert.ok(staleCall);
        assert.equal(staleCall.ruleSignalName, "rule.diag");
        assert.equal(staleCall.status, "stale");
        assert.equal(staleCall.reason, "cache stale");

        const missingCall = calls.find((c) => c.sourceSignalName === "d.missing");
        assert.ok(missingCall);
        assert.equal(missingCall.ruleSignalName, "rule.diag");
        assert.equal(missingCall.status, "unknown");
        assert.equal(missingCall.reason, "missing");

        const nanCall = calls.find((c) => c.sourceSignalName === "d.nan");
        assert.ok(nanCall);
        assert.equal(nanCall.ruleSignalName, "rule.diag");
        assert.equal(nanCall.status, "error");
      });

      it("does not invoke onSourceUnavailable when all sources are ok", async () => {
        let called = false;
        const comp = new CompositeSignalProvider({
          providers: [child1],
          rules: [{ name: "r.clean", unit: "count", sources: ["p1.val"], mode: "median" }],
          onSourceUnavailable: () => {
            called = true;
          },
        });

        await comp.read(mockContext);
        assert.equal(called, false);
      });

      it("never crashes read() when onSourceUnavailable listener throws an error", async () => {
        const pErr = createMockProvider({
          id: "p-throwing-listener",
          signals: [{ name: "t.err", unit: "count" }],
          read: () => [
            { name: "t.err", unit: "count", status: "error", error: "bad", observedAt: 1000 },
          ],
        });

        let listenerExecuted = false;
        const comp = new CompositeSignalProvider({
          providers: [pErr],
          rules: [
            {
              name: "r.tolerant",
              unit: "count",
              sources: ["t.err"],
              mode: "median",
              minAvailableSources: 1,
            },
          ],
          onSourceUnavailable: () => {
            listenerExecuted = true;
            throw new Error("Crashing listener inside diagnostic subscriber!");
          },
        });

        const readings = await comp.read(mockContext);
        assert.equal(listenerExecuted, true);
        assert.ok(Array.isArray(readings));
        const r = readings.find((x) => x.name === "r.tolerant");
        assert.equal(r?.status, "unavailable");

        // Non-Error thrown
        const compNonError = new CompositeSignalProvider({
          providers: [pErr],
          rules: [
            {
              name: "r.tolerant2",
              unit: "count",
              sources: ["t.err"],
              mode: "median",
              minAvailableSources: 1,
            },
          ],
          onSourceUnavailable: () => {
            throw "non-error failure string";
          },
        });
        const readings2 = await compNonError.read(mockContext);
        assert.ok(Array.isArray(readings2));
      });
    });

    describe("rule sources / inputs alias and boundary validations", () => {
      it("rejects non-array or empty rule sources", () => {
        assert.throws(
          () =>
            new CompositeSignalProvider({
              providers: [child1],
              rules: [
                {
                  name: "r.bad.sources",
                  unit: "count",
                  sources: "not-array" as unknown as readonly string[],
                  compute: () => 1,
                },
              ],
            }),
          ConfigurationError,
        );

        assert.throws(
          () =>
            new CompositeSignalProvider({
              providers: [child1],
              rules: [
                {
                  name: "r.empty.sources",
                  unit: "count",
                  sources: [],
                  compute: () => 1,
                },
              ],
            }),
          ConfigurationError,
        );
      });

      it("rejects non-array or empty inputs when sources is also present", () => {
        assert.throws(
          () =>
            new CompositeSignalProvider({
              providers: [child1],
              rules: [
                {
                  name: "r.bad.inputs",
                  unit: "count",
                  sources: ["p1.val"],
                  inputs: "not-array" as unknown as readonly string[],
                  compute: () => 1,
                },
              ],
            }),
          ConfigurationError,
        );

        assert.throws(
          () =>
            new CompositeSignalProvider({
              providers: [child1],
              rules: [
                {
                  name: "r.empty.inputs",
                  unit: "count",
                  sources: ["p1.val"],
                  inputs: [],
                  compute: () => 1,
                },
              ],
            }),
          ConfigurationError,
        );
      });

      it("rejects invalid mode on rule", () => {
        assert.throws(
          () =>
            new CompositeSignalProvider({
              providers: [child1],
              rules: [
                {
                  name: "r.invalid.mode",
                  unit: "count",
                  sources: ["p1.val"],
                  mode: "invalid_mode" as unknown as CompositeCombinerMode,
                },
              ],
            }),
          ConfigurationError,
        );
      });

      it("rejects NaN and Infinity minAvailableSources", () => {
        assert.throws(
          () =>
            new CompositeSignalProvider({
              providers: [child1],
              rules: [
                {
                  name: "r.nan",
                  unit: "count",
                  sources: ["p1.val"],
                  mode: "median",
                  minAvailableSources: NaN,
                },
              ],
            }),
          ConfigurationError,
        );

        assert.throws(
          () =>
            new CompositeSignalProvider({
              providers: [child1],
              rules: [
                {
                  name: "r.inf",
                  unit: "count",
                  sources: ["p1.val"],
                  mode: "median",
                  minAvailableSources: Infinity,
                },
              ],
            }),
          ConfigurationError,
        );
      });

      it("rejects non-trimmed name in shorthand options", () => {
        assert.throws(
          () =>
            createCompositeSignalProvider({
              providers: [child1],
              name: 123 as unknown as string,
              unit: "count",
              sources: ["p1.val"],
              mode: "median",
            }),
          ConfigurationError,
        );

        assert.throws(
          () =>
            createCompositeSignalProvider({
              providers: [child1],
              name: " leading",
              unit: "count",
              sources: ["p1.val"],
              mode: "median",
            }),
          ConfigurationError,
        );

        assert.throws(
          () =>
            createCompositeSignalProvider({
              providers: [child1],
              name: "trailing ",
              unit: "count",
              sources: ["p1.val"],
              mode: "median",
            }),
          ConfigurationError,
        );
      });

      it("rejects non-array sources in shorthand options", () => {
        assert.throws(
          () =>
            createCompositeSignalProvider({
              providers: [child1],
              name: "r.short",
              unit: "count",
              sources: "not-array" as unknown as readonly string[],
              mode: "median",
            }),
          ConfigurationError,
        );
      });

      it("works with passthroughInputs: false and shorthand options", async () => {
        const comp = createCompositeSignalProvider({
          providers: [child1, child2],
          name: "comp.only",
          unit: "count",
          sources: ["p1.val", "p2.val"],
          mode: "median",
          passthroughInputs: false,
        });

        assert.equal(comp.signals.length, 1);
        assert.equal(comp.signals[0]?.name, "comp.only");

        const readings = await comp.read(mockContext);
        assert.equal(readings.length, 1);
        assert.equal(readings[0]?.name, "comp.only");
        assert.equal((readings[0] as { value?: number })?.value, 20);
      });
    });
  });
});
