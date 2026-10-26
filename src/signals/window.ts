import { ConfigurationError } from "../errors/index.js";
import type { ResourceSignal, SignalStatus } from "../types/signals.js";

/**
 * Direction of a signal's least-squares trend across the retained window.
 *
 * `"insufficient-data"` means the window does not hold at least two available
 * readings with at least two distinct timestamps, so a slope cannot be fitted.
 */
export type SignalTrend = "rising" | "falling" | "stable" | "insufficient-data";

/**
 * Options for {@link createSignalWindow}. Every option is optional; invalid
 * values throw `ConfigurationError` when the window is created.
 */
export interface SignalWindowOptions {
  /** Maximum number of readings retained. Defaults to `100`; must be a safe integer `>= 1`. */
  readonly capacity?: number;
  /**
   * Quantile levels to compute. Defaults to `[0.5, 0.95, 0.99]`.
   *
   * Each level must be a finite number strictly between `0` and `1`, levels
   * must be unique, and they are evaluated in ascending order regardless of
   * the input order.
   */
  readonly quantiles?: readonly number[];
  /**
   * Age in milliseconds above which a summary is marked stale. When omitted,
   * summaries are never stale. Must be a finite number `>= 0` when present.
   */
  readonly staleAfterMs?: number;
  /**
   * Absolute slope per millisecond at or below which the trend is `"stable"`.
   * Defaults to `0`, so any non-zero slope is classified as rising or falling.
   * Must be a finite number `>= 0`.
   */
  readonly trendThresholdPerMs?: number;
}

/**
 * Immutable statistics for the readings currently retained by a
 * {@link SignalWindow}.
 *
 * Value statistics (`min`, `max`, `mean`, `stdDev`, `quantiles`, `latest`,
 * `slopePerMs`) are computed only from readings whose status is `"ok"`.
 * Unavailable readings are counted but never coerced to `0`.
 */
export interface SignalWindowSummary {
  /** Number of retained readings, both available and unavailable. */
  readonly count: number;
  /** Number of retained readings whose status is `"ok"`. */
  readonly okCount: number;
  /** Number of retained readings whose status is not `"ok"`. */
  readonly unavailableCount: number;
  /** Smallest available value, or `null` when no available reading is retained. */
  readonly min: number | null;
  /** Largest available value, or `null` when no available reading is retained. */
  readonly max: number | null;
  /** Arithmetic mean of available values, or `null` when none are retained. */
  readonly mean: number | null;
  /** Population standard deviation of available values, or `null` when none are retained. */
  readonly stdDev: number | null;
  /**
   * Computed quantiles keyed by `String(level)` and ordered by ascending level.
   * Empty when no available reading is retained or no quantiles are configured.
   */
  readonly quantiles: Readonly<Record<string, number>>;
  /** Most recently pushed available value, or `null` when none is retained. */
  readonly latest: number | null;
  /** `observedAt` of the most recently pushed available reading, or `null`. */
  readonly latestAt: number | null;
  /**
   * Age of `latestAt` relative to the supplied `now`, clamped to `>= 0`.
   * `0` when `now` is omitted; `null` when `now` is supplied but no available
   * reading is retained.
   */
  readonly ageMs: number | null;
  /**
   * Ordinary least-squares slope of available values against `observedAt`,
   * in value units per millisecond, or `null` when it cannot be fitted.
   */
  readonly slopePerMs: number | null;
  /** Trend classification derived from `slopePerMs` and `trendThresholdPerMs`. */
  readonly trend: SignalTrend;
  /** Whether `ageMs` exceeds the configured `staleAfterMs`. Always `false` without `now`. */
  readonly stale: boolean;
}

/**
 * A bounded FIFO window of readings for one signal stream.
 *
 * The window retains the newest `capacity` readings (available and unavailable),
 * evicting the oldest first. All returned summaries are deeply frozen.
 */
export interface SignalWindow {
  /**
   * Appends a reading, evicting the oldest retained reading when the window is full.
   *
   * @throws {ConfigurationError} when the reading is not an object, has an unknown
   * status, has a non-finite `observedAt`, or has status `"ok"` without a finite value.
   */
  push(reading: ResourceSignal): void;
  /**
   * Computes a frozen summary over the retained readings.
   *
   * @param now Optional current epoch milliseconds used for freshness. When
   * omitted, `ageMs` is `0` and `stale` is `false`.
   * @throws {ConfigurationError} when `now` is not a finite number `>= 0`.
   */
  summary(now?: number): SignalWindowSummary;
  /** Removes every retained reading and resets the summary counts. */
  clear(): void;
  /** Number of readings currently retained. */
  size(): number;
}

const DEFAULT_CAPACITY = 100;
const DEFAULT_QUANTILES: readonly number[] = Object.freeze([0.5, 0.95, 0.99]);
const SIGNAL_STATUSES: readonly SignalStatus[] = Object.freeze([
  "ok",
  "unknown",
  "unsupported",
  "stale",
  "error",
]);
const EMPTY_QUANTILES: Readonly<Record<string, number>> = Object.freeze({});

interface WindowEntry {
  readonly observedAt: number;
  /** Available value, or `null` for an unavailable reading. Never coerced to `0`. */
  readonly value: number | null;
}

interface ResolvedOptions {
  readonly capacity: number;
  readonly quantiles: readonly number[];
  readonly staleAfterMs: number | undefined;
  readonly trendThresholdPerMs: number;
}

function resolveOptions(options: SignalWindowOptions | undefined): ResolvedOptions {
  if (
    options !== undefined &&
    (options === null || typeof options !== "object" || Array.isArray(options))
  ) {
    throw new ConfigurationError("SignalWindow options must be an object.");
  }

  const rawCapacity = options?.capacity;
  const capacity = rawCapacity === undefined ? DEFAULT_CAPACITY : rawCapacity;
  if (typeof capacity !== "number" || !Number.isSafeInteger(capacity) || capacity < 1) {
    throw new ConfigurationError("capacity must be a safe integer greater than or equal to 1.");
  }

  const rawQuantiles = options?.quantiles;
  if (rawQuantiles !== undefined && !Array.isArray(rawQuantiles)) {
    throw new ConfigurationError(
      "quantiles must be an array of finite numbers strictly between 0 and 1.",
    );
  }
  const configuredQuantiles = rawQuantiles === undefined ? DEFAULT_QUANTILES : rawQuantiles;
  const seenQuantiles = new Set<number>();
  for (let index = 0; index < configuredQuantiles.length; index += 1) {
    const quantile = configuredQuantiles[index];
    if (
      typeof quantile !== "number" ||
      !Number.isFinite(quantile) ||
      quantile <= 0 ||
      quantile >= 1
    ) {
      throw new ConfigurationError(
        `quantiles[${index}] must be a finite number strictly between 0 and 1.`,
      );
    }
    if (seenQuantiles.has(quantile)) {
      throw new ConfigurationError(
        `quantiles must not contain duplicate values; "${String(quantile)}" appears more than once.`,
      );
    }
    seenQuantiles.add(quantile);
  }
  const quantiles = Object.freeze([...configuredQuantiles].sort((a, b) => a - b));

  const staleAfterMs = options?.staleAfterMs;
  if (
    staleAfterMs !== undefined &&
    (typeof staleAfterMs !== "number" || !Number.isFinite(staleAfterMs) || staleAfterMs < 0)
  ) {
    throw new ConfigurationError(
      "staleAfterMs must be a finite number greater than or equal to 0.",
    );
  }

  const rawThreshold = options?.trendThresholdPerMs;
  const trendThresholdPerMs = rawThreshold === undefined ? 0 : rawThreshold;
  if (
    typeof trendThresholdPerMs !== "number" ||
    !Number.isFinite(trendThresholdPerMs) ||
    trendThresholdPerMs < 0
  ) {
    throw new ConfigurationError(
      "trendThresholdPerMs must be a finite number greater than or equal to 0.",
    );
  }

  return { capacity, quantiles, staleAfterMs, trendThresholdPerMs };
}

function normalizeReading(reading: unknown): WindowEntry {
  if (reading === null || typeof reading !== "object" || Array.isArray(reading)) {
    throw new ConfigurationError("A signal reading must be an object.");
  }
  const candidate = reading as {
    readonly status?: unknown;
    readonly observedAt?: unknown;
    readonly value?: unknown;
  };

  const status = candidate.status;
  if (typeof status !== "string" || !SIGNAL_STATUSES.includes(status as SignalStatus)) {
    throw new ConfigurationError(
      `Signal reading status must be one of: ${SIGNAL_STATUSES.join(", ")}.`,
    );
  }

  const observedAt = candidate.observedAt;
  if (typeof observedAt !== "number" || !Number.isFinite(observedAt)) {
    throw new ConfigurationError("Signal reading observedAt must be a finite number.");
  }

  if (status === "ok") {
    const value = candidate.value;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new ConfigurationError('Signal reading with status "ok" must have a finite value.');
    }
    return { observedAt, value };
  }

  return { observedAt, value: null };
}

function validateNow(now: number): void {
  if (typeof now !== "number" || !Number.isFinite(now) || now < 0) {
    throw new ConfigurationError("now must be a finite number greater than or equal to 0.");
  }
}

function computeQuantiles(
  sortedValues: readonly number[],
  quantiles: readonly number[],
): Readonly<Record<string, number>> {
  const lastIndex = sortedValues.length - 1;
  const record: Record<string, number> = {};
  for (const quantile of quantiles) {
    const position = lastIndex * quantile;
    const lower = Math.floor(position);
    const upper = lower < lastIndex ? lower + 1 : lastIndex;
    const fraction = position - lower;
    const lowerValue = sortedValues[lower] as number;
    const upperValue = sortedValues[upper] as number;
    record[String(quantile)] = lowerValue + fraction * (upperValue - lowerValue);
  }
  return Object.freeze(record);
}

function computeSlope(timestamps: readonly number[], values: readonly number[]): number {
  const count = timestamps.length;
  let sumX = 0;
  let sumY = 0;
  for (let index = 0; index < count; index += 1) {
    sumX += timestamps[index] as number;
    sumY += values[index] as number;
  }
  const meanX = sumX / count;
  const meanY = sumY / count;

  let covariance = 0;
  let varianceX = 0;
  for (let index = 0; index < count; index += 1) {
    const deltaX = (timestamps[index] as number) - meanX;
    covariance += deltaX * ((values[index] as number) - meanY);
    varianceX += deltaX * deltaX;
  }
  return covariance / varianceX;
}

function classifyTrend(slopePerMs: number, thresholdPerMs: number): SignalTrend {
  if (Math.abs(slopePerMs) <= thresholdPerMs) {
    return "stable";
  }
  return slopePerMs > 0 ? "rising" : "falling";
}

/**
 * Creates a bounded FIFO window that computes portable rolling statistics for
 * one signal stream: min/max/mean/population standard deviation, linearly
 * interpolated quantiles, an ordinary least-squares slope, trend classification,
 * and freshness.
 *
 * The window retains the newest `capacity` readings (default `100`) in push
 * order. Unavailable readings are counted but never enter value statistics and
 * are never coerced to `0`. Summaries are frozen and deterministic for a given
 * window state.
 *
 * @param options Optional capacity, quantile levels, staleness threshold, and
 * trend threshold. See {@link SignalWindowOptions} for defaults.
 * @returns A window whose summaries include quantiles `[0.5, 0.95, 0.99]` by default.
 * @throws {ConfigurationError} when an option is invalid.
 */
export function createSignalWindow(options?: SignalWindowOptions): SignalWindow {
  const { capacity, quantiles, staleAfterMs, trendThresholdPerMs } = resolveOptions(options);
  const entries: WindowEntry[] = [];
  let head = 0;

  return {
    push(reading: ResourceSignal): void {
      const entry = normalizeReading(reading);
      if (entries.length < capacity) {
        entries.push(entry);
        return;
      }
      entries[head] = entry;
      head = (head + 1) % capacity;
    },

    summary(now?: number): SignalWindowSummary {
      const values: number[] = [];
      const timestamps: number[] = [];
      let latest: number | null = null;
      let latestAt: number | null = null;

      for (let offset = 0; offset < entries.length; offset += 1) {
        const entry = entries[(head + offset) % entries.length] as WindowEntry;
        if (entry.value === null) {
          continue;
        }
        values.push(entry.value);
        timestamps.push(entry.observedAt);
        latest = entry.value;
        latestAt = entry.observedAt;
      }

      const okCount = values.length;
      const count = entries.length;
      const unavailableCount = count - okCount;

      let min: number | null = null;
      let max: number | null = null;
      let mean: number | null = null;
      let stdDev: number | null = null;
      let quantileValues: Readonly<Record<string, number>> = EMPTY_QUANTILES;
      let slopePerMs: number | null = null;
      let trend: SignalTrend = "insufficient-data";

      if (okCount > 0) {
        const sortedValues = [...values].sort((a, b) => a - b);
        min = sortedValues[0] as number;
        max = sortedValues[okCount - 1] as number;

        let sum = 0;
        for (const value of values) {
          sum += value;
        }
        mean = sum / okCount;

        let squaredDeviations = 0;
        for (const value of values) {
          const delta = value - mean;
          squaredDeviations += delta * delta;
        }
        stdDev = Math.sqrt(squaredDeviations / okCount);

        quantileValues = computeQuantiles(sortedValues, quantiles);
      }

      if (okCount >= 2 && new Set(timestamps).size >= 2) {
        slopePerMs = computeSlope(timestamps, values);
        trend = classifyTrend(slopePerMs, trendThresholdPerMs);
      }

      let ageMs: number | null;
      let stale = false;
      if (now === undefined) {
        ageMs = 0;
      } else {
        validateNow(now);
        if (latestAt === null) {
          ageMs = null;
        } else {
          ageMs = Math.max(0, now - latestAt);
          stale = staleAfterMs !== undefined && ageMs > staleAfterMs;
        }
      }

      return Object.freeze({
        count,
        okCount,
        unavailableCount,
        min,
        max,
        mean,
        stdDev,
        quantiles: quantileValues,
        latest,
        latestAt,
        ageMs,
        slopePerMs,
        trend,
        stale,
      });
    },

    clear(): void {
      entries.length = 0;
      head = 0;
    },

    size(): number {
      return entries.length;
    },
  };
}
