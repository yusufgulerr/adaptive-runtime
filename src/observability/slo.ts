import { ConfigurationError } from "../errors/index.js";
import type { AdaptiveRuntime } from "../types/runtime.js";

/**
 * Metric family evaluated by an SLO objective.
 *
 * - `availability`: successful observations divided by all observations.
 * - `error-rate`: failed observations divided by all observations.
 * - `latency`: arithmetic mean of `durationMs` across all observations.
 */
export type SloMetric = "availability" | "error-rate" | "latency";

/**
 * Evaluation result for one SLO objective.
 *
 * - `met`: the objective currently satisfies its target.
 * - `at-risk`: the objective misses its target but is still inside the
 *   configured warning margin.
 * - `breached`: the objective misses its target and the warning margin.
 * - `insufficient-data`: fewer than `minSamples` observations are available;
 *   the metric value is withheld as `null`.
 */
export type SloStatus = "met" | "at-risk" | "breached" | "insufficient-data";

/**
 * Declarative service-level objective evaluated over a rolling observation
 * window.
 */
export interface SloObjective {
  /** Stable, non-empty objective identifier. Must be unique within a monitor. */
  readonly id: string;
  /** Metric family evaluated for this objective. */
  readonly metric: SloMetric;
  /**
   * Objective target. `availability` and `error-rate` targets must be finite
   * numbers between `0` and `1` inclusive. `latency` targets are milliseconds
   * and must be finite and greater than `0`.
   */
  readonly target: number;
  /**
   * Number of most recent observations evaluated for this objective.
   * Defaults to `1000`; must be a safe integer greater than or equal to `1`.
   */
  readonly windowSize?: number;
  /**
   * Minimum number of observations required before a value is computed.
   * Defaults to `1`; must be a safe integer greater than or equal to `1`.
   */
  readonly minSamples?: number;
  /**
   * Relative warning band around the target used to classify `at-risk`.
   * Defaults to `0.1`; must be a finite number between `0` and `1` inclusive.
   */
  readonly warningMargin?: number;
  /**
   * Optional operation filter. When present, only observations with the same
   * canonical operation id contribute to this objective.
   */
  readonly operationId?: string;
}

/**
 * One operational outcome recorded by an SLO monitor.
 */
export interface SloObservation {
  /** Observed duration in milliseconds. Must be finite and `>= 0`. */
  readonly durationMs: number;
  /** Whether the observed operation succeeded. */
  readonly succeeded: boolean;
  /** Optional canonical operation id used by filtered objectives. */
  readonly operationId?: string;
  /** Optional observation timestamp in milliseconds. Must be finite and `>= 0`. */
  readonly at?: number;
}

/**
 * Frozen evaluation of one configured objective at snapshot time.
 */
export interface SloObjectiveSnapshot {
  /** Objective id, canonicalized from configuration. */
  readonly id: string;
  /** Metric family evaluated for this objective. */
  readonly metric: SloMetric;
  /** Configured objective target. */
  readonly target: number;
  /** Number of observations that contributed to this evaluation. */
  readonly sampleCount: number;
  /** Computed metric value, or `null` while below `minSamples`. */
  readonly value: number | null;
  /** Evaluation status derived from `value` and the objective target. */
  readonly status: SloStatus;
}

/**
 * Frozen monitor state. Objectives appear in configuration order.
 */
export interface SloMonitorSnapshot {
  /** One snapshot per configured objective, in configuration order. */
  readonly objectives: readonly SloObjectiveSnapshot[];
  /**
   * Number of observations currently retained in the bounded ring buffer.
   * Never exceeds the largest configured objective `windowSize`.
   */
  readonly observationCount: number;
  /**
   * `false` only when at least one objective is `breached`. Objectives that
   * are `at-risk` or `insufficient-data` do not make the monitor unhealthy.
   */
  readonly healthy: boolean;
}

/**
 * SLO evaluator over a bounded rolling observation window.
 */
export interface SloMonitor {
  /**
   * Validates and records one observation. Older observations are evicted
   * once the largest configured window is full.
   *
   * @throws {ConfigurationError} When the observation is malformed.
   */
  record(observation: SloObservation): void;
  /** Returns a frozen snapshot of every objective in configuration order. */
  getSnapshot(): SloMonitorSnapshot;
  /** Clears all recorded observations while preserving configuration. */
  reset(): void;
}

/**
 * Options for {@link createSloMonitor}.
 */
export interface SloMonitorOptions {
  /** Non-empty list of uniquely identified objectives. */
  readonly objectives: readonly SloObjective[];
}

const DEFAULT_WINDOW_SIZE = 1000;
const DEFAULT_MIN_SAMPLES = 1;
const DEFAULT_WARNING_MARGIN = 0.1;

interface ResolvedSloObjective {
  readonly id: string;
  readonly metric: SloMetric;
  readonly target: number;
  readonly windowSize: number;
  readonly minSamples: number;
  readonly warningMargin: number;
  readonly operationId: string | undefined;
}

interface StoredObservation {
  readonly durationMs: number;
  readonly succeeded: boolean;
  readonly operationId: string | undefined;
  readonly at: number | undefined;
}

function isSloMetric(value: unknown): value is SloMetric {
  return value === "availability" || value === "error-rate" || value === "latency";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigurationError(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function resolveObjective(value: unknown, index: number): ResolvedSloObjective {
  if (!isRecord(value)) {
    throw new ConfigurationError(`slo objectives[${index}] must be an object.`);
  }
  const id = normalizeId(value.id, `slo objectives[${index}].id`);

  const metric: unknown = value.metric;
  if (!isSloMetric(metric)) {
    throw new ConfigurationError(
      `slo objective "${id}" metric must be one of "availability", "error-rate", or "latency".`,
    );
  }

  const target: unknown = value.target;
  if (typeof target !== "number" || !Number.isFinite(target)) {
    throw new ConfigurationError(`slo objective "${id}" target must be a finite number.`);
  }
  if (metric === "latency") {
    if (target <= 0) {
      throw new ConfigurationError(`slo objective "${id}" latency target must be greater than 0.`);
    }
  } else if (target < 0 || target > 1) {
    throw new ConfigurationError(
      `slo objective "${id}" ${metric} target must be between 0 and 1 inclusive.`,
    );
  }

  const windowSizeValue: unknown = value.windowSize;
  const windowSize = windowSizeValue === undefined ? DEFAULT_WINDOW_SIZE : windowSizeValue;
  if (typeof windowSize !== "number" || !Number.isSafeInteger(windowSize) || windowSize < 1) {
    throw new ConfigurationError(
      `slo objective "${id}" windowSize must be a safe integer greater than or equal to 1.`,
    );
  }

  const minSamplesValue: unknown = value.minSamples;
  const minSamples = minSamplesValue === undefined ? DEFAULT_MIN_SAMPLES : minSamplesValue;
  if (typeof minSamples !== "number" || !Number.isSafeInteger(minSamples) || minSamples < 1) {
    throw new ConfigurationError(
      `slo objective "${id}" minSamples must be a safe integer greater than or equal to 1.`,
    );
  }

  const warningMarginValue: unknown = value.warningMargin;
  const warningMargin =
    warningMarginValue === undefined ? DEFAULT_WARNING_MARGIN : warningMarginValue;
  if (
    typeof warningMargin !== "number" ||
    !Number.isFinite(warningMargin) ||
    warningMargin < 0 ||
    warningMargin > 1
  ) {
    throw new ConfigurationError(
      `slo objective "${id}" warningMargin must be a finite number between 0 and 1 inclusive.`,
    );
  }

  const operationIdValue: unknown = value.operationId;
  const operationId =
    operationIdValue === undefined
      ? undefined
      : normalizeId(operationIdValue, `slo objective "${id}" operationId`);

  return Object.freeze({
    id,
    metric,
    target,
    windowSize,
    minSamples,
    warningMargin,
    operationId,
  });
}

function normalizeObservation(value: unknown): StoredObservation {
  if (!isRecord(value)) {
    throw new ConfigurationError("slo observation must be an object.");
  }

  const durationMs: unknown = value.durationMs;
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
    throw new ConfigurationError("slo observation durationMs must be a finite number >= 0.");
  }

  const succeeded: unknown = value.succeeded;
  if (typeof succeeded !== "boolean") {
    throw new ConfigurationError("slo observation succeeded must be a boolean.");
  }

  const operationIdValue: unknown = value.operationId;
  const operationId =
    operationIdValue === undefined
      ? undefined
      : normalizeId(operationIdValue, "slo observation operationId");

  const atValue: unknown = value.at;
  if (atValue !== undefined) {
    if (typeof atValue !== "number" || !Number.isFinite(atValue) || atValue < 0) {
      throw new ConfigurationError("slo observation at must be a finite number >= 0.");
    }
  }

  return { durationMs, succeeded, operationId, at: atValue };
}

/**
 * Fixed-capacity circular buffer holding the newest observations without
 * growing beyond the largest configured objective window.
 */
class ObservationRing {
  readonly #capacity: number;
  readonly #items: Array<StoredObservation | undefined> = [];
  #start = 0;
  #size = 0;

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  get size(): number {
    return this.#size;
  }

  push(observation: StoredObservation): void {
    if (this.#size < this.#capacity) {
      this.#items.push(observation);
      this.#size += 1;
      return;
    }
    this.#items[this.#start] = observation;
    this.#start = (this.#start + 1) % this.#capacity;
  }

  newest(index: number): StoredObservation | undefined {
    if (index < 0 || index >= this.#size) {
      return undefined;
    }
    const position = (this.#start + this.#size - 1 - index + this.#capacity) % this.#capacity;
    return this.#items[position];
  }

  clear(): void {
    this.#items.length = 0;
    this.#start = 0;
    this.#size = 0;
  }
}

function metricValue(
  metric: SloMetric,
  samples: number,
  successes: number,
  durationSum: number,
): number {
  switch (metric) {
    case "availability":
      return successes / samples;
    case "error-rate":
      return (samples - successes) / samples;
    case "latency":
      return durationSum / samples;
  }
}

function classify(metric: SloMetric, target: number, margin: number, value: number): SloStatus {
  if (metric === "availability") {
    if (value >= target) {
      return "met";
    }
    if (value >= target * (1 - margin)) {
      return "at-risk";
    }
    return "breached";
  }
  if (value <= target) {
    return "met";
  }
  if (value <= target * (1 + margin)) {
    return "at-risk";
  }
  return "breached";
}

function summarizeObjective(
  objective: ResolvedSloObjective,
  ring: ObservationRing,
): SloObjectiveSnapshot {
  let samples = 0;
  let successes = 0;
  let durationSum = 0;

  for (let index = 0; index < objective.windowSize; index += 1) {
    const observation = ring.newest(index);
    if (observation === undefined) {
      break;
    }
    if (objective.operationId !== undefined && observation.operationId !== objective.operationId) {
      continue;
    }
    samples += 1;
    if (observation.succeeded) {
      successes += 1;
    }
    durationSum += observation.durationMs;
  }

  if (samples < objective.minSamples) {
    return Object.freeze({
      id: objective.id,
      metric: objective.metric,
      target: objective.target,
      sampleCount: samples,
      value: null,
      status: "insufficient-data",
    });
  }

  const value = metricValue(objective.metric, samples, successes, durationSum);
  return Object.freeze({
    id: objective.id,
    metric: objective.metric,
    target: objective.target,
    sampleCount: samples,
    value,
    status: classify(objective.metric, objective.target, objective.warningMargin, value),
  });
}

class BoundedSloMonitor implements SloMonitor {
  readonly #objectives: readonly ResolvedSloObjective[];
  readonly #ring: ObservationRing;

  constructor(objectives: readonly ResolvedSloObjective[], capacity: number) {
    this.#objectives = Object.freeze([...objectives]);
    this.#ring = new ObservationRing(capacity);
  }

  record(observation: SloObservation): void {
    this.#ring.push(normalizeObservation(observation));
  }

  getSnapshot(): SloMonitorSnapshot {
    const objectives = this.#objectives.map((objective) =>
      summarizeObjective(objective, this.#ring),
    );
    return Object.freeze({
      objectives: Object.freeze(objectives),
      observationCount: this.#ring.size,
      healthy: objectives.every((objective) => objective.status !== "breached"),
    });
  }

  reset(): void {
    this.#ring.clear();
  }
}

/**
 * Creates an SLO monitor that evaluates objectives over a single bounded
 * rolling observation buffer sized to the largest configured `windowSize`.
 *
 * Each objective evaluates the newest `windowSize` observations in that buffer
 * and keeps only those matching its optional `operationId`. Values are never
 * rounded. Objectives with fewer than `minSamples` observations report a `null`
 * value and `insufficient-data` status.
 *
 * @throws {ConfigurationError} When options are missing, no objectives are
 * configured, or an objective is malformed.
 */
export function createSloMonitor(options: SloMonitorOptions): SloMonitor {
  if (options === null || typeof options !== "object") {
    throw new ConfigurationError("slo monitor options must be an object.");
  }

  const rawObjectives: unknown = options.objectives;
  if (!Array.isArray(rawObjectives) || rawObjectives.length === 0) {
    throw new ConfigurationError("slo monitor options.objectives must be a non-empty array.");
  }

  const entries: readonly unknown[] = rawObjectives;
  const objectives: ResolvedSloObjective[] = [];
  const seen = new Set<string>();
  let capacity = 0;

  for (let index = 0; index < entries.length; index += 1) {
    const objective = resolveObjective(entries[index], index);
    if (seen.has(objective.id)) {
      throw new ConfigurationError(`slo objective id "${objective.id}" must be unique.`);
    }
    seen.add(objective.id);
    capacity = Math.max(capacity, objective.windowSize);
    objectives.push(objective);
  }

  return new BoundedSloMonitor(objectives, capacity);
}

/**
 * Observes runtime outcomes without modifying the runtime. Successful runs are
 * recorded from `run:success` with `metadata.durationMs`; failed runs are
 * recorded from `run:error` with `durationMs ?? 0`.
 *
 * Attaching to a closed runtime is allowed and never throws. The returned
 * unsubscribe function removes both listeners and is idempotent.
 *
 * @throws {TypeError} When the runtime does not expose an `on` method or the
 * monitor does not expose a `record` method.
 */
export function attachSloMonitor(runtime: AdaptiveRuntime, monitor: SloMonitor): () => void {
  if (runtime === null || typeof runtime !== "object" || typeof runtime.on !== "function") {
    throw new TypeError(
      "attachSloMonitor requires an AdaptiveRuntime instance with an 'on' method.",
    );
  }
  if (monitor === null || typeof monitor !== "object" || typeof monitor.record !== "function") {
    throw new TypeError("attachSloMonitor requires an SloMonitor instance with a 'record' method.");
  }

  const unsubscribeSuccess = runtime.on("run:success", ({ metadata }) => {
    monitor.record({
      durationMs: metadata.durationMs,
      succeeded: true,
      operationId: metadata.operationId,
      at: metadata.finishedAt,
    });
  });
  const unsubscribeError = runtime.on("run:error", ({ operationId, durationMs }) => {
    monitor.record({
      durationMs: durationMs ?? 0,
      succeeded: false,
      operationId,
    });
  });

  let subscribed = true;
  return () => {
    if (!subscribed) {
      return;
    }
    subscribed = false;
    unsubscribeSuccess();
    unsubscribeError();
  };
}
