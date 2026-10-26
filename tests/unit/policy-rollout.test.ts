import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigurationError } from "../../src/errors/index.js";
import {
  computeRolloutBucket,
  createPolicyRollout,
  type PolicyCohort,
  type PolicyRollout,
  type PolicyRolloutAssignment,
  type PolicyRolloutOptions,
  type PolicyRolloutSnapshot,
} from "../../src/policy/rollout.js";
import type { OperationPolicy } from "../../src/types/policy.js";

const baselinePolicy: OperationPolicy = {
  adaptationEnabled: false,
  minQualityTier: 0,
  budgets: [{ id: "heap", signal: "heap.used", limit: 0.9 }],
};

const candidatePolicy: OperationPolicy = {
  adaptationEnabled: true,
  minQualityTier: 2,
  consecutiveSamples: 3,
};

function invalid(action: () => unknown): ConfigurationError {
  try {
    action();
  } catch (error) {
    assert.ok(
      error instanceof ConfigurationError,
      `expected ConfigurationError, got ${String(error)}`,
    );
    return error;
  }
  assert.fail("expected action to throw ConfigurationError");
}

function optionsWith(overrides: Record<string, unknown>): unknown {
  return {
    baselinePolicy,
    candidatePolicy,
    percentage: 50,
    ...overrides,
  };
}

function createWith(overrides: Record<string, unknown>): PolicyRollout {
  return createPolicyRollout(optionsWith(overrides) as PolicyRolloutOptions);
}

function candidateCount(rollout: PolicyRollout, total: number): number {
  let candidates = 0;
  for (let index = 0; index < total; index += 1) {
    if (rollout.isCandidate(`op-${index}`)) {
      candidates += 1;
    }
  }
  return candidates;
}

describe("computeRolloutBucket", () => {
  it("returns an integer bucket in 0..9999", () => {
    const ids = ["op-1", "op-42", "checkout", "op-\u00fc-\ud83d\ude80", "\ud83d\ude80", "a b"];
    for (const id of ids) {
      const bucket = computeRolloutBucket(id);
      assert.ok(Number.isInteger(bucket), `bucket for ${id} must be an integer`);
      assert.ok(bucket >= 0 && bucket <= 9999, `bucket for ${id} out of range: ${bucket}`);
    }
  });

  it("matches known FNV-1a vectors for the default salt", () => {
    assert.equal(computeRolloutBucket("op-1"), 7127);
    assert.equal(computeRolloutBucket("op-42"), 2862);
    assert.equal(computeRolloutBucket("checkout"), 4898);
    assert.equal(computeRolloutBucket("op-\u00fc-\ud83d\ude80"), 6202);
  });

  it("is deterministic across repeated calls", () => {
    for (const id of ["alpha", "beta", "op-\u00e7-\u011f", "x".repeat(512)]) {
      assert.equal(computeRolloutBucket(id), computeRolloutBucket(id));
      assert.equal(computeRolloutBucket(id, "salt-a"), computeRolloutBucket(id, "salt-a"));
    }
  });

  it("uses the default salt exactly when salt is omitted", () => {
    for (const id of ["op-1", "op-2", "unicode-\ud83d\ude80"]) {
      assert.equal(computeRolloutBucket(id), computeRolloutBucket(id, "adaptive-runtime"));
    }
  });

  it("produces a different assignment set for a different salt", () => {
    let different = 0;
    for (let index = 0; index < 500; index += 1) {
      const id = `op-${index}`;
      if (computeRolloutBucket(id) !== computeRolloutBucket(id, "experiment-b")) {
        different += 1;
      }
    }
    assert.ok(different > 0, "different salts must produce different buckets");
  });

  it("rejects invalid operation ids and salts", () => {
    for (const operationId of ["", "   ", " leading", "trailing ", 42, null, undefined]) {
      assert.match(
        invalid(() => computeRolloutBucket(operationId as string)).message,
        /operationId/,
      );
    }
    for (const salt of ["", "   ", " leading", "trailing ", 42, null]) {
      assert.match(invalid(() => computeRolloutBucket("op-1", salt as string)).message, /salt/);
    }
  });
});

describe("createPolicyRollout validation", () => {
  it("requires an options object", () => {
    for (const value of [undefined, null, [], "rollout", 42]) {
      assert.match(
        invalid(() => createPolicyRollout(value as unknown as PolicyRolloutOptions)).message,
        /options must be an object/,
      );
    }
  });

  it("requires both policies to be objects", () => {
    for (const value of [undefined, null, [], "policy", 1]) {
      assert.match(
        invalid(() => createWith({ baselinePolicy: value })).message,
        /baselinePolicy must be an object/,
      );
      assert.match(
        invalid(() => createWith({ candidatePolicy: value })).message,
        /candidatePolicy must be an object/,
      );
    }
  });

  it("requires percentage to be a finite number in 0..100", () => {
    const values = [
      undefined,
      null,
      "50",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -0.01,
      100.01,
      -1,
      101,
    ];
    for (const percentage of values) {
      assert.match(
        invalid(() => createWith({ percentage })).message,
        /percentage must be a finite number between 0 and 100/,
      );
    }
  });

  it("accepts the 0 and 100 percentage boundaries", () => {
    assert.equal(createWith({ percentage: 0 }).getSnapshot().basisPoints, 0);
    assert.equal(createWith({ percentage: 100 }).getSnapshot().basisPoints, 10000);
    assert.equal(createWith({ percentage: 0.5 }).getSnapshot().basisPoints, 50);
  });

  it("requires salt to be a canonical non-empty string", () => {
    for (const salt of ["", "   ", 42, null, false]) {
      assert.match(invalid(() => createWith({ salt })).message, /salt must be a non-empty string/);
    }
    for (const salt of [" leading", "trailing ", "\tadaptive"]) {
      assert.match(
        invalid(() => createWith({ salt })).message,
        /salt must not have leading or trailing whitespace/,
      );
    }
  });

  it("defaults the salt and keeps explicit salts", () => {
    assert.equal(createWith({ salt: undefined }).getSnapshot().salt, "adaptive-runtime");
    assert.equal(createWith({ salt: "experiment-b" }).getSnapshot().salt, "experiment-b");
  });
});

describe("PolicyRollout", () => {
  it("computes basis points by rounding and stores the normalized percentage", () => {
    const cases: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [0.005, 1],
      [12.345, 1235],
      [33.333, 3333],
      [99.999, 10000],
      [100, 10000],
    ];
    for (const [percentage, basisPoints] of cases) {
      const snapshot = createWith({ percentage }).getSnapshot();
      assert.equal(snapshot.percentage, percentage);
      assert.equal(snapshot.basisPoints, basisPoints);
    }
  });

  it("assigns every operation to the baseline at 0 percent", () => {
    const rollout = createWith({ percentage: 0 });
    assert.equal(rollout.getSnapshot().basisPoints, 0);
    for (let index = 0; index < 1000; index += 1) {
      const assignment = rollout.assign(`op-${index}`);
      assert.equal(assignment.cohort, "baseline");
      assert.equal(assignment.policy, baselinePolicy);
      assert.equal(rollout.getCohort(`op-${index}`), "baseline");
      assert.equal(rollout.isCandidate(`op-${index}`), false);
    }
  });

  it("assigns every operation to the candidate at 100 percent", () => {
    const rollout = createWith({ percentage: 100 });
    assert.equal(rollout.getSnapshot().basisPoints, 10000);
    for (let index = 0; index < 1000; index += 1) {
      const assignment = rollout.assign(`op-${index}`);
      assert.equal(assignment.cohort, "candidate");
      assert.equal(assignment.policy, candidatePolicy);
      assert.equal(rollout.getCohort(`op-${index}`), "candidate");
      assert.equal(rollout.isCandidate(`op-${index}`), true);
    }
  });

  it("selects the candidate exactly when bucket < basisPoints", () => {
    const rollout = createWith({ percentage: 30 });
    const basisPoints = rollout.getSnapshot().basisPoints;
    for (let index = 0; index < 2000; index += 1) {
      const assignment = rollout.assign(`op-${index}`);
      const expected: PolicyCohort = assignment.bucket < basisPoints ? "candidate" : "baseline";
      assert.equal(assignment.cohort, expected);
      assert.equal(assignment.bucket, computeRolloutBucket(`op-${index}`));
      assert.equal(assignment.policy, expected === "candidate" ? candidatePolicy : baselinePolicy);
      assert.equal(rollout.getCohort(`op-${index}`), expected);
      assert.equal(rollout.isCandidate(`op-${index}`), expected === "candidate");
    }
  });

  it("is stable across repeated calls and independent rollout instances", () => {
    const first = createWith({ percentage: 40, salt: "stable-salt" });
    const second = createWith({ percentage: 40, salt: "stable-salt" });
    for (let index = 0; index < 1000; index += 1) {
      const id = `op-${index}`;
      const before = first.assign(id);
      const other = first.assign(`unrelated-${index}`);
      const after = first.assign(id);
      assert.deepEqual(after, before);
      assert.deepEqual(other, second.assign(`unrelated-${index}`));
      assert.deepEqual(second.assign(id), before);
      assert.equal(before.bucket, computeRolloutBucket(id, "stable-salt"));
    }
  });

  it("keeps getCohort and isCandidate consistent for unicode ids", () => {
    const rollout = createWith({ percentage: 55, salt: "unicode-salt" });
    const ids = [
      "op-\u00fc",
      "op-\u00fc-\ud83d\ude80",
      "\ud83d\ude80-\ud83d\ude80",
      "kullan\u0131c\u0131-\u00e7a\u011fr\u0131",
      "e\u0301",
      "\u00e9",
    ];
    for (const id of ids) {
      const first = rollout.assign(id);
      const second = rollout.assign(id);
      assert.equal(first.operationId, id);
      assert.equal(first.bucket, second.bucket);
      assert.equal(first.cohort, second.cohort);
      assert.equal(rollout.getCohort(id), first.cohort);
      assert.equal(rollout.isCandidate(id), first.cohort === "candidate");
      assert.ok(Number.isInteger(first.bucket) && first.bucket >= 0 && first.bucket <= 9999);
    }
  });

  it("keeps the candidate share within 2 percentage points over 10,000 ids", () => {
    for (const percentage of [10, 30, 75]) {
      const rollout = createWith({ percentage });
      const candidates = candidateCount(rollout, 10_000);
      const share = (candidates / 10_000) * 100;
      assert.ok(
        Math.abs(share - percentage) <= 2,
        `percentage ${percentage}: candidate share ${share.toFixed(2)}% outside ±2 points`,
      );
    }
  });

  it("produces different cohort sets for different salts", () => {
    const first = createWith({ percentage: 50, salt: "salt-one" });
    const second = createWith({ percentage: 50, salt: "salt-two" });
    const firstCohorts: PolicyCohort[] = [];
    const secondCohorts: PolicyCohort[] = [];
    let differences = 0;
    for (let index = 0; index < 1000; index += 1) {
      const id = `op-${index}`;
      const firstCohort = first.getCohort(id);
      const secondCohort = second.getCohort(id);
      firstCohorts.push(firstCohort);
      secondCohorts.push(secondCohort);
      if (firstCohort !== secondCohort) {
        differences += 1;
      }
    }
    assert.ok(differences > 0, "different salts must change at least one assignment");
    assert.notDeepEqual(firstCohorts, secondCohorts);
  });

  it("returns a frozen snapshot with normalized values and policy references", () => {
    const rollout = createWith({ percentage: 12.345, salt: "frozen-snapshot" });
    const snapshot: PolicyRolloutSnapshot = rollout.getSnapshot();
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(snapshot.percentage, 12.345);
    assert.equal(snapshot.basisPoints, 1235);
    assert.equal(snapshot.salt, "frozen-snapshot");
    assert.equal(snapshot.baselinePolicy, baselinePolicy);
    assert.equal(snapshot.candidatePolicy, candidatePolicy);
    assert.deepEqual(rollout.getSnapshot(), snapshot);

    const mutable = snapshot as unknown as { percentage: number; salt: string };
    assert.throws(() => {
      mutable.percentage = 0;
    }, TypeError);
    assert.throws(() => {
      mutable.salt = "mutated";
    }, TypeError);
  });

  it("returns frozen assignments that preserve policy references", () => {
    const baseline = { ...baselinePolicy };
    const candidate = { ...candidatePolicy };
    const rollout = createPolicyRollout({
      baselinePolicy: baseline,
      candidatePolicy: candidate,
      percentage: 100,
    });
    const assignment: PolicyRolloutAssignment = rollout.assign("frozen-assignment");
    assert.equal(Object.isFrozen(assignment), true);
    assert.equal(assignment.policy, candidate);
    assert.equal(assignment.operationId, "frozen-assignment");
    assert.equal(assignment.cohort, "candidate");
    assert.equal(Object.isFrozen(baseline), false);
    assert.equal(Object.isFrozen(candidate), false);
    assert.deepEqual(baseline, baselinePolicy);
    assert.deepEqual(candidate, candidatePolicy);

    const mutable = assignment as unknown as { cohort: PolicyCohort; bucket: number };
    assert.throws(() => {
      mutable.cohort = "baseline";
    }, TypeError);
    assert.throws(() => {
      mutable.bucket = 0;
    }, TypeError);
  });

  it("never mutates or freezes the supplied policies", () => {
    const baseline = { ...baselinePolicy };
    const candidate = { ...candidatePolicy };
    const rollout = createPolicyRollout({
      baselinePolicy: baseline,
      candidatePolicy: candidate,
      percentage: 50,
    });
    for (let index = 0; index < 200; index += 1) {
      rollout.assign(`op-${index}`);
    }
    assert.deepEqual(baseline, baselinePolicy);
    assert.deepEqual(candidate, candidatePolicy);
    assert.equal(Object.isFrozen(baseline), false);
    assert.equal(Object.isFrozen(candidate), false);
    assert.equal(rollout.getSnapshot().baselinePolicy, baseline);
    assert.equal(rollout.getSnapshot().candidatePolicy, candidate);
  });

  it("does not disturb assignments between calls", () => {
    const rollout = createWith({ percentage: 25 });
    const id = "state-free-op";
    const before = rollout.assign(id);
    for (let index = 0; index < 5000; index += 1) {
      rollout.assign(`noise-${index}`);
    }
    assert.deepEqual(rollout.assign(id), before);
    assert.deepEqual(rollout.getSnapshot(), createWith({ percentage: 25 }).getSnapshot());
  });

  it("rejects invalid operation ids from every method", () => {
    const rollout = createWith({ percentage: 50 });
    const invalidIds = ["", "   ", " leading", "trailing ", 42, null, undefined];
    for (const operationId of invalidIds) {
      assert.match(invalid(() => rollout.assign(operationId as string)).message, /operationId/);
      assert.match(invalid(() => rollout.getCohort(operationId as string)).message, /operationId/);
      assert.match(
        invalid(() => rollout.isCandidate(operationId as string)).message,
        /operationId/,
      );
    }
  });
});
