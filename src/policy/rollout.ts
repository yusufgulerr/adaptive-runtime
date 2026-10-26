import { ConfigurationError } from "../errors/index.js";
import type { OperationPolicy } from "../types/policy.js";

const DEFAULT_ROLLOUT_SALT = "adaptive-runtime";
const BUCKET_COUNT = 10_000;
const BASIS_POINT_COUNT = 10_000;
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * Cohort selected for an operation by a deterministic policy rollout.
 *
 * - `"baseline"` receives `baselinePolicy`.
 * - `"candidate"` receives `candidatePolicy`.
 */
export type PolicyCohort = "baseline" | "candidate";

/**
 * Configuration for a deterministic policy rollout.
 *
 * The rollout is stateless: the same operation id and salt always map to the
 * same cohort on every replica and after every process restart.
 */
export interface PolicyRolloutOptions {
  /** Policy assigned to operations that fall outside the candidate percentage. */
  readonly baselinePolicy: OperationPolicy;
  /** Policy assigned to operations inside the candidate percentage. */
  readonly candidatePolicy: OperationPolicy;
  /** Percentage of the bucket space assigned to the candidate, from `0` to `100`. */
  readonly percentage: number;
  /**
   * Stable hash salt. Defaults to `"adaptive-runtime"`. Must be a non-empty
   * string without leading or trailing whitespace. A different salt produces a
   * different (but equally stable) assignment set.
   */
  readonly salt?: string;
}

/**
 * The deterministic outcome of assigning one operation to a rollout cohort.
 *
 * Assignments are frozen. `policy` is the exact policy reference supplied in
 * {@link PolicyRolloutOptions}; the rollout never clones or mutates policies.
 */
export interface PolicyRolloutAssignment {
  /** Canonical operation id used for the assignment. */
  readonly operationId: string;
  /** Cohort that owns the operation. */
  readonly cohort: PolicyCohort;
  /** Hash bucket from `0` to `9999`; candidate when `bucket < basisPoints`. */
  readonly bucket: number;
  /** `baselinePolicy` or `candidatePolicy`, by reference. */
  readonly policy: OperationPolicy;
}

/**
 * Frozen, non-disturbing view of a rollout's normalized configuration.
 *
 * `percentage` is the configured value clamped to `0..100`, `basisPoints` is
 * `Math.round(percentage * 100)`, and policy fields are the original references.
 */
export interface PolicyRolloutSnapshot {
  /** Configured candidate percentage, clamped to `0..100`. */
  readonly percentage: number;
  /** Candidate threshold in basis points, from `0` to `10000`. */
  readonly basisPoints: number;
  /** Canonical salt used for hashing. */
  readonly salt: string;
  /** Baseline policy reference. */
  readonly baselinePolicy: OperationPolicy;
  /** Candidate policy reference. */
  readonly candidatePolicy: OperationPolicy;
}

/**
 * Pure, stateless percentage rollout of a candidate policy.
 *
 * Every method validates its input and throws `ConfigurationError` for invalid
 * operation ids. No per-operation state is retained.
 */
export interface PolicyRollout {
  /**
   * Assigns an operation id to a cohort and returns a frozen assignment.
   *
   * @throws `ConfigurationError` when `operationId` is not a canonical non-empty string.
   */
  assign(operationId: string): PolicyRolloutAssignment;
  /**
   * Returns the cohort for an operation id.
   *
   * @throws `ConfigurationError` when `operationId` is not a canonical non-empty string.
   */
  getCohort(operationId: string): PolicyCohort;
  /**
   * Returns `true` when the operation falls inside the candidate percentage.
   *
   * @throws `ConfigurationError` when `operationId` is not a canonical non-empty string.
   */
  isCandidate(operationId: string): boolean;
  /** Returns the frozen snapshot of the normalized rollout configuration. */
  getSnapshot(): PolicyRolloutSnapshot;
}

function requireCanonicalIdentifier(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigurationError(`${name} must be a non-empty string.`);
  }
  if (value !== value.trim()) {
    throw new ConfigurationError(`${name} must not have leading or trailing whitespace.`);
  }
  return value;
}

function requirePolicy(value: unknown, name: string): OperationPolicy {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigurationError(`${name} must be an object.`);
  }
  return value as OperationPolicy;
}

function hashString(value: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

function bucketFor(operationId: string, salt: string): number {
  return hashString(`${salt}\u0000${operationId}`) % BUCKET_COUNT;
}

/**
 * Computes the stable rollout bucket for an operation id.
 *
 * Uses 32-bit FNV-1a over the UTF-16 code units of `${salt}\u0000${operationId}`
 * and returns `(hash >>> 0) % 10000`, an integer in `0..9999`. The default salt
 * is `"adaptive-runtime"`.
 *
 * @throws `ConfigurationError` when the operation id or salt is not a canonical
 * non-empty string.
 */
export function computeRolloutBucket(operationId: string, salt?: string): number {
  const canonicalOperationId = requireCanonicalIdentifier(operationId, "operationId");
  const canonicalSalt =
    salt === undefined ? DEFAULT_ROLLOUT_SALT : requireCanonicalIdentifier(salt, "salt");
  return bucketFor(canonicalOperationId, canonicalSalt);
}

/**
 * Creates a deterministic percentage rollout from a baseline and candidate
 * policy.
 *
 * `basisPoints = Math.round(percentage * 100)` is clamped to `0..10000`; an
 * operation is a candidate when its bucket is less than `basisPoints`. This
 * means `0` percent always selects the baseline and `100` percent always selects
 * the candidate. Policies are stored by reference, never cloned, and the rollout
 * never mutates them.
 *
 * @throws `ConfigurationError` when options are not an object, a policy is not
 * an object, `percentage` is not a finite number in `0..100`, or `salt` is not a
 * canonical non-empty string.
 */
export function createPolicyRollout(options: PolicyRolloutOptions): PolicyRollout {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new ConfigurationError("options must be an object.");
  }

  const baselinePolicy = requirePolicy(options.baselinePolicy, "baselinePolicy");
  const candidatePolicy = requirePolicy(options.candidatePolicy, "candidatePolicy");

  if (
    typeof options.percentage !== "number" ||
    !Number.isFinite(options.percentage) ||
    options.percentage < 0 ||
    options.percentage > 100
  ) {
    throw new ConfigurationError("percentage must be a finite number between 0 and 100.");
  }
  const percentage = Math.min(100, Math.max(0, options.percentage));
  const basisPoints = Math.min(BASIS_POINT_COUNT, Math.max(0, Math.round(percentage * 100)));

  const salt =
    options.salt === undefined
      ? DEFAULT_ROLLOUT_SALT
      : requireCanonicalIdentifier(options.salt, "salt");

  const snapshot: PolicyRolloutSnapshot = Object.freeze({
    percentage,
    basisPoints,
    salt,
    baselinePolicy,
    candidatePolicy,
  });

  const assign = (operationId: string): PolicyRolloutAssignment => {
    const canonicalOperationId = requireCanonicalIdentifier(operationId, "operationId");
    const bucket = bucketFor(canonicalOperationId, salt);
    const cohort: PolicyCohort = bucket < basisPoints ? "candidate" : "baseline";
    return Object.freeze({
      operationId: canonicalOperationId,
      cohort,
      bucket,
      policy: cohort === "candidate" ? candidatePolicy : baselinePolicy,
    });
  };

  return Object.freeze({
    assign,
    getCohort(operationId: string): PolicyCohort {
      return assign(operationId).cohort;
    },
    isCandidate(operationId: string): boolean {
      return assign(operationId).cohort === "candidate";
    },
    getSnapshot(): PolicyRolloutSnapshot {
      return snapshot;
    },
  });
}
