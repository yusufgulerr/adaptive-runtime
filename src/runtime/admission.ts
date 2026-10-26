import {
  AdaptiveRuntimeError,
  ConfigurationError,
  OperationAbortedError,
} from "../errors/index.js";
import type { Clock, ClockTimer } from "../types/clock.js";
import { systemClock } from "./clock.js";

/**
 * Error thrown when the adaptive concurrency limiter refuses an admission
 * request. The inherited `code` is always `"ADMISSION_REJECTED"`.
 *
 * Close rejections are not counted as shed work.
 */
export class AdmissionRejectedError extends AdaptiveRuntimeError {
  /** Why the admission attempt was rejected. */
  readonly reason: "queue-full" | "timeout" | "closed";

  /**
   * Creates an admission rejection.
   *
   * @param reason Rejection reason.
   * @param label Optional acquire label included in the message.
   */
  constructor(reason: "queue-full" | "timeout" | "closed", label?: string) {
    const suffix = label === undefined ? "" : ` for "${label}"`;
    super("ADMISSION_REJECTED", `Admission rejected (${reason})${suffix}.`);
    this.reason = reason;
  }
}

/**
 * Per-acquire overrides for {@link AdaptiveLimiter.acquire} and
 * {@link AdaptiveLimiter.withPermit}.
 */
export interface AcquirePermitOptions {
  /** Overrides `acquireTimeoutMs`; `0` disables the queue timeout for this call. */
  readonly timeoutMs?: number;
  /** Aborts the pending acquisition while it is queued. */
  readonly signal?: AbortSignal;
  /** Optional non-empty label attached to rejections. */
  readonly label?: string;
}

/**
 * Feedback recorded when a permit is released or when
 * {@link AdaptiveLimiter.observe} is called.
 */
export interface LimiterOutcome {
  /** Measured latency in milliseconds; finite and `>= 0` when present. */
  readonly latencyMs?: number;
  /** Whether the downstream call succeeded. Defaults to `true`. */
  readonly succeeded?: boolean;
}

/** A permit granting one unit of downstream concurrency. */
export interface AdaptiveLimiterPermit {
  /** Monotonic permit id, starting at `1`. */
  readonly id: number;
  /** Clock time at which the permit was acquired. */
  readonly acquiredAt: number;
  /** Whether the permit has been released. */
  readonly released: boolean;
  /**
   * Releases the permit exactly once and feeds AIMD. Later calls are no-ops.
   *
   * @param outcome Optional success/latency feedback.
   */
  release(outcome?: LimiterOutcome): void;
}

/** Configuration for {@link createAdaptiveLimiter}. */
export interface AdaptiveLimiterOptions {
  /** Starting concurrency limit. Defaults to `8`. */
  readonly initialLimit?: number;
  /** Lowest limit the limiter may decrease to. Defaults to `1`. */
  readonly minLimit?: number;
  /** Highest limit the limiter may increase to. Defaults to `64`. */
  readonly maxLimit?: number;
  /** Maximum queued acquisitions; `0` disables queueing. Defaults to `0`. */
  readonly maxQueueSize?: number;
  /** Default queue wait timeout in milliseconds; `0` disables it. Defaults to `0`. */
  readonly acquireTimeoutMs?: number;
  /** Limit increase per AIMD window. Defaults to `1`. */
  readonly increaseStep?: number;
  /** Multiplicative decrease factor in `(0, 1)`. Defaults to `0.8`. */
  readonly decreaseFactor?: number;
  /** Consecutive successes required before an increase. Defaults to `10`. */
  readonly increaseEvery?: number;
  /** EWMA latency smoothing factor in `(0, 1]`. Defaults to `0.2`. */
  readonly latencyAlpha?: number;
  /** When set, EWMA pressure above `targetLatencyMs * latencyThresholdRatio` decreases. */
  readonly targetLatencyMs?: number;
  /** EWMA multiplier that triggers latency pressure. Defaults to `1.5`. */
  readonly latencyThresholdRatio?: number;
  /** Time source used for permit timing and queue timeouts. Defaults to `systemClock`. */
  readonly clock?: Clock;
  /** Called whenever the limit actually changes. Listener failures are isolated. */
  readonly onLimitChanged?: (event: LimiterLimitChangeEvent) => void;
  /** Called when work is shed. Listener failures are isolated. */
  readonly onShed?: (event: { readonly reason: "queue-full" | "timeout" | "no-permit" }) => void;
}

/** A frozen record of an actual limit change. */
export interface LimiterLimitChangeEvent {
  /** Limit before the change. */
  readonly previousLimit: number;
  /** Limit after the change. */
  readonly limit: number;
  /** Direction of the change. */
  readonly reason: "increase" | "decrease";
}

/** A frozen point-in-time view of limiter state. */
export interface AdaptiveLimiterSnapshot {
  /** Current concurrency limit. */
  readonly limit: number;
  /** Configured lower bound. */
  readonly minLimit: number;
  /** Configured upper bound. */
  readonly maxLimit: number;
  /** Permits currently held by callers. */
  readonly inFlight: number;
  /** `max(0, limit - inFlight)`. */
  readonly availablePermits: number;
  /** Number of queued acquisitions. */
  readonly queueDepth: number;
  /** Successful outcomes recorded through release/observe. */
  readonly successCount: number;
  /** Failed outcomes recorded through release/observe. */
  readonly failureCount: number;
  /** Rejections caused by a full queue, a timed-out wait, or a failed `tryAcquire()`. */
  readonly shedCount: number;
  /** Timed-out queued acquisitions. */
  readonly timeoutCount: number;
  /** Number of actual limit changes. */
  readonly limitChangeCount: number;
  /** Smoothed latency, or `null` when no finite sample was recorded. */
  readonly ewmaLatencyMs: number | null;
  /** Whether {@link AdaptiveLimiter.close} has been called. */
  readonly closed: boolean;
}

/**
 * Deterministic AIMD admission controller for downstream work.
 *
 * Wrap protected calls with {@link AdaptiveLimiter.withPermit} so concurrency
 * shrinks under failure or latency pressure and grows slowly while healthy.
 */
export interface AdaptiveLimiter {
  /**
   * Resolves with a permit when capacity is available, or queues the caller in
   * FIFO order until capacity frees.
   *
   * Rejects with {@link AdmissionRejectedError} when the queue is full, the wait
   * times out, or the limiter is closed, and with `OperationAbortedError` when
   * the supplied signal aborts.
   */
  acquire(options?: AcquirePermitOptions): Promise<AdaptiveLimiterPermit>;
  /**
   * Acquires without queueing. Returns `null`, increments `shedCount`, and calls
   * `onShed({ reason: "no-permit" })` when no capacity is available.
   */
  tryAcquire(): AdaptiveLimiterPermit | null;
  /**
   * Acquires a permit, runs the task, measures elapsed clock time, releases the
   * permit once, and returns the task result. A task failure is rethrown
   * unchanged after releasing with `succeeded: false`.
   */
  withPermit<T>(task: () => T | Promise<T>, options?: AcquirePermitOptions): Promise<T>;
  /**
   * Records AIMD feedback without consuming a permit. The feedback itself never
   * releases a permit, but an increase can immediately admit queued waiters,
   * which increases `inFlight` and decreases `queueDepth`.
   */
  observe(outcome?: LimiterOutcome): void;
  /** Returns a frozen snapshot of the current state. */
  getSnapshot(): AdaptiveLimiterSnapshot;
  /**
   * Rejects every queued waiter with `AdmissionRejectedError("closed")`, clears
   * timers and abort listeners, and prevents new acquisitions. In-flight permits
   * remain releasable and snapshots remain usable. Idempotent.
   */
  close(): void;
}

interface NormalizedAcquireOptions {
  readonly timeoutMs: number;
  readonly signal: AbortSignal | undefined;
  readonly label: string | undefined;
}

interface NormalizedOutcome {
  readonly succeeded: boolean;
  readonly latencyMs: number | undefined;
}

interface QueuedWaiter {
  readonly label: string | undefined;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (permit: AdaptiveLimiterPermit) => void;
  readonly reject: (error: Error) => void;
  timer: ClockTimer | null;
  abortHandler: (() => void) | null;
  settled: boolean;
}

function requireSafeInteger(value: unknown, label: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new ConfigurationError(`${label} must be a safe integer >= ${minimum}.`);
  }
  return value;
}

function requireFiniteAtLeast(value: unknown, label: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new ConfigurationError(`${label} must be a finite number >= ${minimum}.`);
  }
  return value;
}

function normalizeAcquireOptions(
  options: AcquirePermitOptions | undefined,
  defaultTimeoutMs: number,
): NormalizedAcquireOptions {
  const raw: unknown = options;
  if (raw === undefined) {
    return { timeoutMs: defaultTimeoutMs, signal: undefined, label: undefined };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigurationError("acquire options must be an object.");
  }
  const record = raw as {
    readonly timeoutMs?: unknown;
    readonly signal?: unknown;
    readonly label?: unknown;
  };

  let timeoutMs = defaultTimeoutMs;
  if (record.timeoutMs !== undefined) {
    timeoutMs = requireFiniteAtLeast(record.timeoutMs, "timeoutMs", 0);
  }

  let label: string | undefined;
  if (record.label !== undefined) {
    if (typeof record.label !== "string" || record.label.trim().length === 0) {
      throw new ConfigurationError("label must be a non-empty string.");
    }
    label = record.label.trim();
  }

  let signal: AbortSignal | undefined;
  if (record.signal !== undefined) {
    const candidate = record.signal;
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      !("aborted" in candidate) ||
      typeof (candidate as AbortSignal).addEventListener !== "function" ||
      typeof (candidate as AbortSignal).removeEventListener !== "function"
    ) {
      throw new ConfigurationError("signal must be an AbortSignal.");
    }
    signal = candidate as AbortSignal;
  }

  return { timeoutMs, signal, label };
}

function normalizeOutcome(outcome: LimiterOutcome | undefined): NormalizedOutcome {
  const raw: unknown = outcome;
  if (raw === undefined) {
    return { succeeded: true, latencyMs: undefined };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigurationError("outcome must be an object.");
  }
  const record = raw as { readonly latencyMs?: unknown; readonly succeeded?: unknown };

  let succeeded = true;
  if (record.succeeded !== undefined) {
    if (typeof record.succeeded !== "boolean") {
      throw new ConfigurationError("outcome.succeeded must be a boolean.");
    }
    succeeded = record.succeeded;
  }

  let latencyMs: number | undefined;
  if (record.latencyMs !== undefined) {
    latencyMs = requireFiniteAtLeast(record.latencyMs, "outcome.latencyMs", 0);
  }

  return { succeeded, latencyMs };
}

class AdaptiveLimiterImpl implements AdaptiveLimiter {
  readonly #clock: Clock;
  readonly #minLimit: number;
  readonly #maxLimit: number;
  readonly #maxQueueSize: number;
  readonly #acquireTimeoutMs: number;
  readonly #increaseStep: number;
  readonly #decreaseFactor: number;
  readonly #increaseEvery: number;
  readonly #latencyAlpha: number;
  readonly #targetLatencyMs: number | undefined;
  readonly #latencyThresholdRatio: number;
  readonly #onLimitChanged: ((event: LimiterLimitChangeEvent) => void) | undefined;
  readonly #onShed:
    | ((event: { readonly reason: "queue-full" | "timeout" | "no-permit" }) => void)
    | undefined;
  readonly #waiters: QueuedWaiter[] = [];

  #limit: number;
  #inFlight = 0;
  #successStreak = 0;
  #ewmaLatencyMs: number | null = null;
  #nextPermitId = 1;
  #successCount = 0;
  #failureCount = 0;
  #shedCount = 0;
  #timeoutCount = 0;
  #limitChangeCount = 0;
  #closed = false;

  constructor(options?: AdaptiveLimiterOptions) {
    const raw: unknown = options;
    if (raw !== undefined && (raw === null || typeof raw !== "object" || Array.isArray(raw))) {
      throw new ConfigurationError("options must be an object.");
    }
    const config = (raw ?? {}) as AdaptiveLimiterOptions;

    const initialLimit = requireSafeInteger(config.initialLimit ?? 8, "initialLimit", 1);
    const minLimit = requireSafeInteger(config.minLimit ?? 1, "minLimit", 1);
    const maxLimit = requireSafeInteger(config.maxLimit ?? 64, "maxLimit", 1);
    if (initialLimit < minLimit || initialLimit > maxLimit) {
      throw new ConfigurationError(
        `initialLimit (${initialLimit}) must satisfy minLimit <= initialLimit <= maxLimit ` +
          `(${minLimit}..${maxLimit}).`,
      );
    }
    this.#limit = initialLimit;
    this.#minLimit = minLimit;
    this.#maxLimit = maxLimit;
    this.#maxQueueSize = requireSafeInteger(config.maxQueueSize ?? 0, "maxQueueSize", 0);
    this.#acquireTimeoutMs = requireFiniteAtLeast(
      config.acquireTimeoutMs ?? 0,
      "acquireTimeoutMs",
      0,
    );
    this.#increaseStep = requireSafeInteger(config.increaseStep ?? 1, "increaseStep", 1);

    const decreaseFactor = config.decreaseFactor ?? 0.8;
    if (
      typeof decreaseFactor !== "number" ||
      !Number.isFinite(decreaseFactor) ||
      decreaseFactor <= 0 ||
      decreaseFactor >= 1
    ) {
      throw new ConfigurationError(
        "decreaseFactor must be a finite number greater than 0 and less than 1.",
      );
    }
    this.#decreaseFactor = decreaseFactor;
    this.#increaseEvery = requireSafeInteger(config.increaseEvery ?? 10, "increaseEvery", 1);

    const latencyAlpha = config.latencyAlpha ?? 0.2;
    if (
      typeof latencyAlpha !== "number" ||
      !Number.isFinite(latencyAlpha) ||
      latencyAlpha <= 0 ||
      latencyAlpha > 1
    ) {
      throw new ConfigurationError(
        "latencyAlpha must be a finite number greater than 0 and at most 1.",
      );
    }
    this.#latencyAlpha = latencyAlpha;

    const targetLatencyMs = config.targetLatencyMs;
    if (targetLatencyMs !== undefined) {
      if (
        typeof targetLatencyMs !== "number" ||
        !Number.isFinite(targetLatencyMs) ||
        targetLatencyMs <= 0
      ) {
        throw new ConfigurationError("targetLatencyMs must be a positive finite number.");
      }
    }
    this.#targetLatencyMs = targetLatencyMs;
    this.#latencyThresholdRatio = requireFiniteAtLeast(
      config.latencyThresholdRatio ?? 1.5,
      "latencyThresholdRatio",
      1,
    );

    const onLimitChanged = config.onLimitChanged;
    if (onLimitChanged !== undefined && typeof onLimitChanged !== "function") {
      throw new ConfigurationError("onLimitChanged must be a function.");
    }
    this.#onLimitChanged = onLimitChanged;

    const onShed = config.onShed;
    if (onShed !== undefined && typeof onShed !== "function") {
      throw new ConfigurationError("onShed must be a function.");
    }
    this.#onShed = onShed;

    const rawClock: unknown = config.clock === undefined ? systemClock : config.clock;
    if (
      rawClock === null ||
      typeof rawClock !== "object" ||
      typeof (rawClock as Clock).now !== "function" ||
      typeof (rawClock as Clock).setTimeout !== "function"
    ) {
      throw new ConfigurationError("clock must provide now() and setTimeout().");
    }
    this.#clock = rawClock as Clock;
  }

  acquire(options?: AcquirePermitOptions): Promise<AdaptiveLimiterPermit> {
    let normalized: NormalizedAcquireOptions;
    try {
      normalized = normalizeAcquireOptions(options, this.#acquireTimeoutMs);
    } catch (error) {
      return Promise.reject(error);
    }

    if (this.#closed) {
      return Promise.reject(new AdmissionRejectedError("closed", normalized.label));
    }
    const signal = normalized.signal;
    if (signal?.aborted) {
      return Promise.reject(
        new OperationAbortedError(normalized.label ?? "adaptive-limiter", signal.reason),
      );
    }

    this.#drainWaiters();
    if (this.#inFlight < this.#limit) {
      this.#inFlight += 1;
      return Promise.resolve(this.#createPermit());
    }
    if (this.#waiters.length >= this.#maxQueueSize) {
      this.#shedCount += 1;
      this.#emitShed("queue-full");
      return Promise.reject(new AdmissionRejectedError("queue-full", normalized.label));
    }
    return this.#enqueueWaiter(normalized);
  }

  tryAcquire(): AdaptiveLimiterPermit | null {
    if (this.#closed) {
      return null;
    }
    this.#drainWaiters();
    if (this.#inFlight >= this.#limit) {
      this.#shedCount += 1;
      this.#emitShed("no-permit");
      return null;
    }
    this.#inFlight += 1;
    return this.#createPermit();
  }

  async withPermit<T>(task: () => T | Promise<T>, options?: AcquirePermitOptions): Promise<T> {
    if (typeof task !== "function") {
      throw new ConfigurationError("task must be a function.");
    }
    const permit = await this.acquire(options);
    let failed = false;
    try {
      return await task();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      const latencyMs = Math.max(0, this.#clock.now() - permit.acquiredAt);
      permit.release({ succeeded: !failed, latencyMs });
    }
  }

  observe(outcome?: LimiterOutcome): void {
    const normalized = normalizeOutcome(outcome);
    this.#applyOutcome(normalized);
    this.#drainWaiters();
  }

  getSnapshot(): AdaptiveLimiterSnapshot {
    const inFlight = this.#inFlight;
    return Object.freeze({
      limit: this.#limit,
      minLimit: this.#minLimit,
      maxLimit: this.#maxLimit,
      inFlight,
      availablePermits: Math.max(0, this.#limit - inFlight),
      queueDepth: this.#waiters.length,
      successCount: this.#successCount,
      failureCount: this.#failureCount,
      shedCount: this.#shedCount,
      timeoutCount: this.#timeoutCount,
      limitChangeCount: this.#limitChangeCount,
      ewmaLatencyMs: this.#ewmaLatencyMs,
      closed: this.#closed,
    });
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const pending = this.#waiters.splice(0, this.#waiters.length);
    for (const waiter of pending) {
      if (waiter.settled) {
        continue;
      }
      waiter.settled = true;
      this.#cleanupWaiter(waiter);
      waiter.reject(new AdmissionRejectedError("closed", waiter.label));
    }
  }

  #createPermit(): AdaptiveLimiterPermit {
    const id = this.#nextPermitId;
    this.#nextPermitId += 1;
    const acquiredAt = this.#clock.now();
    let released = false;

    const release = (outcome?: LimiterOutcome): void => {
      if (released) {
        return;
      }
      const normalized = normalizeOutcome(outcome);
      released = true;
      this.#inFlight = Math.max(0, this.#inFlight - 1);
      this.#applyOutcome(normalized);
      this.#drainWaiters();
    };

    return Object.freeze({
      id,
      acquiredAt,
      get released(): boolean {
        return released;
      },
      release,
    });
  }

  #enqueueWaiter(options: NormalizedAcquireOptions): Promise<AdaptiveLimiterPermit> {
    return new Promise<AdaptiveLimiterPermit>((resolve, reject) => {
      const waiter: QueuedWaiter = {
        label: options.label,
        signal: options.signal,
        resolve,
        reject,
        timer: null,
        abortHandler: null,
        settled: false,
      };
      this.#waiters.push(waiter);

      if (options.signal !== undefined) {
        const onAbort = (): void => {
          this.#abortWaiter(waiter);
        };
        waiter.abortHandler = onAbort;
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
      if (options.timeoutMs > 0) {
        waiter.timer = this.#clock.setTimeout(() => {
          this.#timeoutWaiter(waiter);
        }, options.timeoutMs);
      }
    });
  }

  #abortWaiter(waiter: QueuedWaiter): void {
    if (waiter.settled) {
      return;
    }
    waiter.settled = true;
    this.#removeWaiter(waiter);
    this.#cleanupWaiter(waiter);
    waiter.reject(
      new OperationAbortedError(waiter.label ?? "adaptive-limiter", waiter.signal?.reason),
    );
  }

  #timeoutWaiter(waiter: QueuedWaiter): void {
    if (waiter.settled) {
      return;
    }
    waiter.settled = true;
    this.#removeWaiter(waiter);
    this.#cleanupWaiter(waiter);
    this.#shedCount += 1;
    this.#timeoutCount += 1;
    this.#emitShed("timeout");
    waiter.reject(new AdmissionRejectedError("timeout", waiter.label));
  }

  #removeWaiter(waiter: QueuedWaiter): void {
    const index = this.#waiters.indexOf(waiter);
    if (index >= 0) {
      this.#waiters.splice(index, 1);
    }
  }

  #cleanupWaiter(waiter: QueuedWaiter): void {
    if (waiter.timer !== null) {
      waiter.timer.cancel();
      waiter.timer = null;
    }
    if (waiter.abortHandler !== null && waiter.signal !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.abortHandler);
    }
    waiter.abortHandler = null;
  }

  #drainWaiters(): void {
    while (this.#waiters.length > 0 && this.#inFlight < this.#limit) {
      const waiter = this.#waiters.shift();
      if (waiter === undefined) {
        return;
      }
      if (waiter.settled) {
        continue;
      }
      waiter.settled = true;
      this.#cleanupWaiter(waiter);
      this.#inFlight += 1;
      waiter.resolve(this.#createPermit());
    }
  }

  #applyOutcome(outcome: NormalizedOutcome): void {
    if (outcome.latencyMs !== undefined) {
      this.#ewmaLatencyMs =
        this.#ewmaLatencyMs === null
          ? outcome.latencyMs
          : this.#latencyAlpha * outcome.latencyMs + (1 - this.#latencyAlpha) * this.#ewmaLatencyMs;
    }

    if (outcome.succeeded) {
      this.#successCount += 1;
    } else {
      this.#failureCount += 1;
    }

    if (!outcome.succeeded) {
      this.#successStreak = 0;
      this.#decreaseLimit();
      return;
    }
    if (this.#hasLatencyPressure()) {
      this.#successStreak = 0;
      this.#decreaseLimit();
      return;
    }

    this.#successStreak = Math.min(this.#increaseEvery, this.#successStreak + 1);
    if (this.#successStreak >= this.#increaseEvery && this.#limit < this.#maxLimit) {
      const previousLimit = this.#limit;
      this.#limit = Math.min(this.#maxLimit, this.#limit + this.#increaseStep);
      this.#successStreak = 0;
      this.#emitLimitChange(previousLimit, this.#limit, "increase");
    }
  }

  #decreaseLimit(): void {
    this.#successStreak = 0;
    const nextLimit = Math.max(this.#minLimit, Math.floor(this.#limit * this.#decreaseFactor));
    if (nextLimit === this.#limit) {
      return;
    }
    const previousLimit = this.#limit;
    this.#limit = nextLimit;
    this.#emitLimitChange(previousLimit, nextLimit, "decrease");
  }

  #hasLatencyPressure(): boolean {
    if (this.#targetLatencyMs === undefined || this.#ewmaLatencyMs === null) {
      return false;
    }
    return this.#ewmaLatencyMs > this.#targetLatencyMs * this.#latencyThresholdRatio;
  }

  #emitLimitChange(previousLimit: number, limit: number, reason: "increase" | "decrease"): void {
    const event: LimiterLimitChangeEvent = Object.freeze({ previousLimit, limit, reason });
    this.#limitChangeCount += 1;
    if (this.#onLimitChanged === undefined) {
      return;
    }
    try {
      this.#onLimitChanged(event);
    } catch {
      // Listener failures must never change admission behavior.
    }
  }

  #emitShed(reason: "queue-full" | "timeout" | "no-permit"): void {
    if (this.#onShed === undefined) {
      return;
    }
    const event: { readonly reason: "queue-full" | "timeout" | "no-permit" } = Object.freeze({
      reason,
    });
    try {
      this.#onShed(event);
    } catch {
      // Listener failures must never change admission behavior.
    }
  }
}

/**
 * Creates a deterministic AIMD admission limiter.
 *
 * Validation failures throw `ConfigurationError`. With the default options the
 * limiter starts with a limit of 8, never queues, and increases by 1 after 10
 * consecutive successful outcomes.
 *
 * @param options Optional limiter configuration.
 */
export function createAdaptiveLimiter(options?: AdaptiveLimiterOptions): AdaptiveLimiter {
  return new AdaptiveLimiterImpl(options);
}
