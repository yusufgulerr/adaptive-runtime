import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type BudgetState,
  buildBudgetViews,
  defaultBudgetState,
  evaluateBudgets,
  type ResolvedReading,
} from "../../src/policy/budgets.js";
import { resolvePolicy } from "../../src/policy/resolve.js";
import { fc, fuzzRuns } from "./support.js";

interface RuleSpec {
  readonly limit: number;
  readonly recoverBelow: number;
  readonly consecutiveSamples: number;
}

interface StateSpec {
  readonly initialized: boolean;
  readonly budgets: Readonly<Record<string, BudgetState>>;
}

type ReadingSpec =
  | { readonly kind: "missing" }
  | { readonly kind: "ok"; readonly value: number }
  | {
      readonly kind: "unavailable";
      readonly status: "unknown" | "unsupported" | "stale" | "error";
    };

interface ExpectedBudget {
  readonly state: BudgetState;
  readonly missing: boolean;
  readonly engagedNow: boolean;
  readonly recoveredNow: boolean;
}

const ruleArb: fc.Arbitrary<RuleSpec> = fc.integer({ min: -1_000, max: 1_000 }).chain((limit) =>
  fc.record({
    limit: fc.constant(limit),
    recoverBelow: fc.integer({ min: -1_000, max: limit }),
    consecutiveSamples: fc.integer({ min: 1, max: 5 }),
  }),
);

const budgetStateArb: fc.Arbitrary<BudgetState> = fc.record({
  engaged: fc.boolean(),
  aboveStreak: fc.integer({ min: 0, max: 6 }),
  belowStreak: fc.integer({ min: 0, max: 6 }),
});

const stateArb: fc.Arbitrary<StateSpec> = fc.record({
  initialized: fc.boolean(),
  budgets: fc.oneof(
    fc.constant<Readonly<Record<string, BudgetState>>>({}),
    budgetStateArb.map((budget) => ({ pressure: budget })),
  ),
});

function readingArb(rule: RuleSpec): fc.Arbitrary<ReadingSpec> {
  return fc.oneof(
    fc.constant({ kind: "missing" } as const),
    fc.record({
      kind: fc.constant("ok" as const),
      value: fc.oneof(
        fc.integer({ min: -1_000, max: 1_000 }),
        fc.constant(rule.limit),
        fc.constant(rule.recoverBelow),
        fc.constant(rule.limit + 1),
        fc.constant(rule.recoverBelow - 1),
      ),
    }),
    fc.record({
      kind: fc.constant("unavailable" as const),
      status: fc.constantFrom(
        "unknown" as const,
        "unsupported" as const,
        "stale" as const,
        "error" as const,
      ),
    }),
  );
}

const scenarioArb = ruleArb.chain((rule) =>
  fc.record({
    rule: fc.constant(rule),
    state: stateArb,
    fresh: fc.boolean(),
    reading: readingArb(rule),
  }),
);

function toResolvedReading(reading: ReadingSpec): ResolvedReading {
  switch (reading.kind) {
    case "missing":
      return { status: "missing" };
    case "unavailable":
      return { status: reading.status, detail: "scripted unavailable reading" };
    case "ok":
      return { status: "ok", value: reading.value };
  }
}

function expectedBudget(
  rule: RuleSpec,
  state: StateSpec,
  fresh: boolean,
  reading: ReadingSpec,
): ExpectedBudget {
  const previous = state.budgets.pressure ?? defaultBudgetState();

  if (reading.kind !== "ok") {
    return { state: previous, missing: true, engagedNow: false, recoveredNow: false };
  }
  if (!fresh) {
    return { state: previous, missing: false, engagedNow: false, recoveredNow: false };
  }
  if (!state.initialized) {
    const engaged = reading.value > rule.limit;
    return {
      state: { engaged, aboveStreak: 0, belowStreak: 0 },
      missing: false,
      engagedNow: engaged,
      recoveredNow: false,
    };
  }
  if (previous.engaged) {
    const belowStreak = reading.value < rule.recoverBelow ? previous.belowStreak + 1 : 0;
    if (belowStreak >= rule.consecutiveSamples) {
      return {
        state: { engaged: false, aboveStreak: 0, belowStreak: 0 },
        missing: false,
        engagedNow: false,
        recoveredNow: true,
      };
    }
    return {
      state: { ...previous, belowStreak },
      missing: false,
      engagedNow: false,
      recoveredNow: false,
    };
  }
  const aboveStreak = reading.value > rule.limit ? previous.aboveStreak + 1 : 0;
  if (aboveStreak >= rule.consecutiveSamples) {
    return {
      state: { engaged: true, aboveStreak: 0, belowStreak: 0 },
      missing: false,
      engagedNow: true,
      recoveredNow: false,
    };
  }
  return {
    state: { ...previous, aboveStreak },
    missing: false,
    engagedNow: false,
    recoveredNow: false,
  };
}

function makePolicy(rule: RuleSpec) {
  return resolvePolicy({
    budgets: [
      {
        id: "pressure",
        signal: "s",
        limit: rule.limit,
        recoverBelow: rule.recoverBelow,
        consecutiveSamples: rule.consecutiveSamples,
        tierReduction: 1,
      },
    ],
    consecutiveSamples: 1,
  });
}

describe("property: budget hysteresis", () => {
  it("matches the reference transition model for arbitrary readings and states", () => {
    fc.assert(
      fc.property(scenarioArb, ({ rule, state, fresh, reading }) => {
        const policy = makePolicy(rule);
        const resolutions = new Map<string, ResolvedReading>([["s", toResolvedReading(reading)]]);
        const actual = evaluateBudgets(state, resolutions, policy, fresh);
        const expected = expectedBudget(rule, state, fresh, reading);

        const actualBudget = actual.nextBudgets.pressure;
        assert.ok(actualBudget, "the pressure budget state must always be present");
        assert.equal(actualBudget.engaged, expected.state.engaged);
        assert.equal(actualBudget.aboveStreak, expected.state.aboveStreak);
        assert.equal(actualBudget.belowStreak, expected.state.belowStreak);
        assert.equal(actual.missing.length, expected.missing ? 1 : 0);
        assert.equal(actual.engagedNow.has("pressure"), expected.engagedNow);
        assert.equal(actual.recoveredNow.has("pressure"), expected.recoveredNow);
      }),
      { numRuns: fuzzRuns },
    );
  });

  it("never exposes a numeric value for an unavailable budget reading", () => {
    fc.assert(
      fc.property(
        ruleArb,
        fc.constantFrom(
          "unknown" as const,
          "unsupported" as const,
          "stale" as const,
          "error" as const,
        ),
        (rule, status) => {
          const policy = makePolicy(rule);
          const resolution: ResolvedReading = { status, detail: "scripted unavailable reading" };
          const resolutions = new Map<string, ResolvedReading>([["s", resolution]]);
          const result = evaluateBudgets(
            { initialized: false, budgets: {} },
            resolutions,
            policy,
            true,
          );
          const views = buildBudgetViews(result.nextBudgets, resolutions, policy);

          assert.equal(views[0]?.status, status);
          assert.equal(views[0]?.value, undefined);
          assert.equal(views[0]?.engaged, false);
        },
      ),
      { numRuns: fuzzRuns },
    );
  });
});
