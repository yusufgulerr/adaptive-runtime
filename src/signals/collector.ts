import { ConfigurationError, ProviderTimeoutError, RuntimeClosedError } from "../errors/index.js";
import type { Clock, ClockTimer } from "../types/clock.js";
import type {
  ResourceSignal,
  SignalDescriptor,
  SignalProvider,
  SignalStatus,
  SignalUnit,
} from "../types/signals.js";
import { toError } from "../utils/errors.js";

export interface SignalSnapshot {
  readonly readings: readonly ResourceSignal[];
  readonly collectedAt: number;
  readonly sequence: number;
  readonly cached: boolean;
}

export interface SignalCollectorOptions {
  readonly providers: readonly SignalProvider[];
  readonly evaluationIntervalMs: number;
  readonly providerTimeoutMs: number;
  readonly clock: Clock;
  readonly onProviderError: (providerId: string, error: Error) => void;
}

interface ProviderEntry {
  readonly provider: SignalProvider;
  readonly descriptors: ReadonlyMap<string, SignalDescriptor>;
  /** Resolves once start() settles; reused so start() runs at most once. */
  startPromise: Promise<void> | null;
  started: boolean;
  startError: Error | null;
}

type ProviderWaitResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: Error; readonly aborted: boolean };

interface SharedRead {
  readonly controller: AbortController;
  readonly promise: Promise<SignalSnapshot>;
  waiters: number;
  settled: boolean;
}

const SIGNAL_UNITS: readonly SignalUnit[] = ["bytes", "milliseconds", "ratio", "count", "custom"];
const SIGNAL_STATUSES: readonly SignalStatus[] = ["ok", "unknown", "unsupported", "stale", "error"];

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigurationError(`${label} must be a non-empty string.`);
  }
  if (value !== value.trim()) {
    throw new ConfigurationError(`${label} must not have leading or trailing whitespace.`);
  }
  return value;
}

function validateDescriptor(
  descriptor: SignalDescriptor,
  providerId: string,
  seenNames: Set<string>,
): SignalDescriptor {
  if (descriptor === null || typeof descriptor !== "object") {
    throw new ConfigurationError(`Provider "${providerId}" has a non-object signal descriptor.`);
  }
  const name = requireNonEmpty(descriptor.name, `Provider "${providerId}" signal name`);
  if (seenNames.has(name)) {
    throw new ConfigurationError(`Duplicate signal name "${name}" across providers.`);
  }
  seenNames.add(name);
  if (!SIGNAL_UNITS.includes(descriptor.unit)) {
    throw new ConfigurationError(
      `Signal "${name}" has an unsupported unit: ${String(descriptor.unit)}.`,
    );
  }
  if (descriptor.description !== undefined && typeof descriptor.description !== "string") {
    throw new ConfigurationError(`Signal "${name}" description must be a string.`);
  }
  return descriptor;
}

/**
 * Owns provider lifecycle, caching, timeouts, and validation. A provider failure
 * becomes error readings for that provider; it does not crash the runtime.
 */
export class SignalCollector {
  readonly #entries: readonly ProviderEntry[];
  readonly #evaluationIntervalMs: number;
  readonly #providerTimeoutMs: number;
  readonly #clock: Clock;
  readonly #onProviderError: (providerId: string, error: Error) => void;
  #snapshot: SignalSnapshot | null = null;
  #inflight: SharedRead | null = null;
  #sequence = 0;
  #closed = false;
  #closePromise: Promise<void> | null = null;

  constructor(options: SignalCollectorOptions) {
    this.#evaluationIntervalMs = options.evaluationIntervalMs;
    this.#providerTimeoutMs = options.providerTimeoutMs;
    this.#clock = options.clock;
    this.#onProviderError = options.onProviderError;

    const seenProviderIds = new Set<string>();
    const seenSignalNames = new Set<string>();
    const entries: ProviderEntry[] = [];
    for (const provider of options.providers) {
      if (provider === null || typeof provider !== "object") {
        throw new ConfigurationError("Signal providers must be objects.");
      }
      const providerId = requireNonEmpty(provider.id, "Provider id");
      if (seenProviderIds.has(providerId)) {
        throw new ConfigurationError(`Duplicate provider id "${providerId}".`);
      }
      seenProviderIds.add(providerId);
      if (typeof provider.read !== "function") {
        throw new ConfigurationError(`Provider "${providerId}" must implement read().`);
      }
      if (!Array.isArray(provider.signals) || provider.signals.length === 0) {
        throw new ConfigurationError(`Provider "${providerId}" must declare at least one signal.`);
      }
      const descriptors = new Map<string, SignalDescriptor>();
      for (const descriptor of provider.signals) {
        const validated = validateDescriptor(descriptor, providerId, seenSignalNames);
        descriptors.set(validated.name, validated);
      }
      entries.push({
        provider,
        descriptors,
        startPromise: null,
        started: false,
        startError: null,
      });
    }
    this.#entries = entries;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async collect(now: number, signal: AbortSignal): Promise<SignalSnapshot> {
    if (this.#closed) {
      throw new RuntimeClosedError();
    }
    const cached = this.#snapshot;
    if (cached !== null) {
      const age = now - cached.collectedAt;
      if (age >= 0 && age < this.#evaluationIntervalMs) {
        return { ...cached, cached: true };
      }
    }
    if (this.#inflight !== null && !this.#inflight.controller.signal.aborted) {
      const snapshot = await this.#joinSharedRead(this.#inflight, signal);
      return { ...snapshot, cached: true };
    }

    if (this.#entries.length === 0) {
      this.#sequence += 1;
      const snapshot: SignalSnapshot = {
        readings: [],
        collectedAt: now,
        sequence: this.#sequence,
        cached: false,
      };
      this.#snapshot = snapshot;
      return snapshot;
    }

    const entry = this.#startSharedRead(now);
    this.#inflight = entry;
    const snapshot = await this.#joinSharedRead(entry, signal);
    return { ...snapshot, cached: false };
  }

  async close(): Promise<void> {
    if (this.#closePromise !== null) {
      return this.#closePromise;
    }
    this.#closed = true;
    this.#snapshot = null;
    this.#closePromise = (async () => {
      await Promise.allSettled(
        this.#entries.map(async (entry) => {
          if (entry.provider.close === undefined) {
            return;
          }
          try {
            await entry.provider.close();
          } catch (error) {
            this.#onProviderError(entry.provider.id, toError(error));
          }
        }),
      );
    })();
    return this.#closePromise;
  }

  /**
   * Starts a read with its own controller. Callers never abort this controller
   * directly; they leave the shared read, and the last waiter aborts it.
   */
  #startSharedRead(now: number): SharedRead {
    const controller = new AbortController();
    const entry: SharedRead = {
      controller,
      waiters: 0,
      settled: false,
      promise: this.#collectFresh(now, controller.signal),
    };
    const settle = (snapshot: SignalSnapshot | null): void => {
      entry.settled = true;
      if (snapshot !== null && !controller.signal.aborted && !this.#closed) {
        this.#snapshot = snapshot;
      }
      if (this.#inflight === entry) {
        this.#inflight = null;
      }
    };
    entry.promise.then(
      (snapshot) => settle(snapshot),
      () => settle(null),
    );
    return entry;
  }

  /**
   * Joins a shared read. The waiter count makes cancellation ref-counted: one
   * caller leaving, even the initiator, does not cancel the read for the rest.
   */
  async #joinSharedRead(entry: SharedRead, signal: AbortSignal): Promise<SignalSnapshot> {
    entry.waiters += 1;
    try {
      return await this.#awaitShared(entry.promise, signal);
    } finally {
      entry.waiters -= 1;
      if (entry.waiters === 0 && !entry.settled && !entry.controller.signal.aborted) {
        entry.controller.abort(new Error("All callers aborted the shared signal read."));
      }
    }
  }

  /**
   * Waits for a shared in-flight read without letting this caller's abort
   * cancel the read for everyone else. The caller still rejects promptly.
   */
  #awaitShared<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      return Promise.reject(this.#abortReason(signal));
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        signal.removeEventListener("abort", onAbort);
        reject(this.#abortReason(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  #abortReason(signal: AbortSignal): Error {
    const reason = signal.reason;
    return reason instanceof Error ? reason : new Error("Signal collection was aborted.");
  }

  async #collectFresh(now: number, signal: AbortSignal): Promise<SignalSnapshot> {
    const results = await Promise.all(
      this.#entries.map(async (entry) => this.#readEntry(entry, now, signal)),
    );
    const readings = results.flat();
    this.#sequence += 1;
    return {
      readings,
      collectedAt: now,
      sequence: this.#sequence,
      cached: false,
    };
  }

  async #readEntry(
    entry: ProviderEntry,
    now: number,
    signal: AbortSignal,
  ): Promise<readonly ResourceSignal[]> {
    if (entry.startError !== null) {
      return this.#errorReadings(entry, now, entry.startError.message);
    }

    if (!entry.started) {
      const start = this.#beginStart(entry, now);
      if (start.errorReadings !== null) {
        return start.errorReadings;
      }
      if (start.promise !== null) {
        const startFailure = await this.#awaitStart(entry, now, signal, start.promise);
        if (startFailure !== null) {
          return startFailure;
        }
      }
    }

    const result = await this.#waitForProvider(entry, signal, (providerSignal) =>
      entry.provider.read({ now, signal: providerSignal }),
    );
    if (!result.ok) {
      if (!result.aborted) {
        this.#onProviderError(entry.provider.id, result.error);
      }
      return this.#errorReadings(entry, now, result.error.message);
    }

    try {
      return this.#normalizeReadings(entry, result.value, now);
    } catch (error) {
      const failure = toError(error);
      if (!signal.aborted) {
        this.#onProviderError(entry.provider.id, failure);
      }
      return this.#errorReadings(entry, now, failure.message);
    }
  }

  /**
   * Invokes start() at most once. Synchronous starts keep their immediate
   * behavior; a returned promise is stored so later reads reuse it.
   */
  #beginStart(
    entry: ProviderEntry,
    now: number,
  ): {
    readonly errorReadings: readonly ResourceSignal[] | null;
    readonly promise: Promise<void> | null;
  } {
    if (entry.startPromise !== null) {
      return { errorReadings: null, promise: entry.startPromise };
    }

    let result: void | Promise<void>;
    try {
      result = entry.provider.start?.();
    } catch (error) {
      const failure = toError(error);
      entry.startError = failure;
      entry.started = true;
      this.#onProviderError(entry.provider.id, failure);
      return { errorReadings: this.#errorReadings(entry, now, failure.message), promise: null };
    }

    if (result === undefined) {
      entry.started = true;
      return { errorReadings: null, promise: null };
    }

    const promise = Promise.resolve(result);
    // A caller can abandon the wait through its abort signal; observe any late
    // rejection so it never surfaces as an unhandled rejection.
    promise.catch(() => undefined);
    entry.startPromise = promise;
    return { errorReadings: null, promise };
  }

  /**
   * Waits for a pending start under the provider timeout. A caller abort keeps
   * the start promise reusable and caches nothing; a timeout or rejection is
   * cached as startError and reported once.
   */
  async #awaitStart(
    entry: ProviderEntry,
    now: number,
    signal: AbortSignal,
    startPromise: Promise<void>,
  ): Promise<readonly ResourceSignal[] | null> {
    const result = await this.#waitForProvider(entry, signal, () => startPromise);
    if (result.ok) {
      entry.started = true;
      return null;
    }

    if (!result.aborted) {
      entry.startError = result.error;
      entry.started = true;
      this.#onProviderError(entry.provider.id, result.error);
    }
    return this.#errorReadings(entry, now, result.error.message);
  }

  /**
   * Runs a provider operation with the configured timeout and the caller's
   * abort signal applied to the wait. The operation itself is cooperative.
   */
  async #waitForProvider<T>(
    entry: ProviderEntry,
    signal: AbortSignal,
    operation: (signal: AbortSignal) => T | Promise<T>,
  ): Promise<ProviderWaitResult<T>> {
    const controller = new AbortController();
    let rejectAborted: ((error: Error) => void) | undefined;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      rejectAborted = reject;
    });
    const onAbort = (): void => {
      controller.abort(signal.reason);
      const reason = signal.reason;
      rejectAborted?.(
        reason instanceof Error ? reason : new Error("Signal collection was aborted."),
      );
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    let timer: ClockTimer | undefined;
    let timeoutError: ProviderTimeoutError | null = null;
    const timeoutPromise =
      this.#providerTimeoutMs > 0
        ? new Promise<never>((_resolve, reject) => {
            timer = this.#clock.setTimeout(() => {
              timeoutError = new ProviderTimeoutError(entry.provider.id, this.#providerTimeoutMs);
              controller.abort(timeoutError);
              reject(timeoutError);
            }, this.#providerTimeoutMs);
          })
        : null;

    try {
      const operationPromise = Promise.resolve().then(() => operation(controller.signal));
      const racers: Promise<unknown>[] = [operationPromise, abortPromise];
      if (timeoutPromise !== null) {
        racers.push(timeoutPromise);
      }
      const value = await Promise.race(racers);
      return { ok: true, value: value as T };
    } catch (error) {
      return {
        ok: false,
        error: timeoutError ?? toError(error),
        aborted: signal.aborted,
      };
    } finally {
      timer?.cancel();
      signal.removeEventListener("abort", onAbort);
    }
  }

  #normalizeReadings(entry: ProviderEntry, raw: unknown, now: number): readonly ResourceSignal[] {
    if (!Array.isArray(raw)) {
      throw new TypeError(`Provider "${entry.provider.id}" read() must return an array.`);
    }
    const received = new Map<string, ResourceSignal>();
    for (const value of raw as readonly unknown[]) {
      if (value === null || typeof value !== "object") {
        throw new TypeError(`Provider "${entry.provider.id}" returned a non-object reading.`);
      }
      const reading = value as ResourceSignal;
      const descriptor = entry.descriptors.get(reading.name);
      if (descriptor === undefined) {
        throw new TypeError(
          `Provider "${entry.provider.id}" returned undeclared signal "${String(reading.name)}".`,
        );
      }
      if (received.has(reading.name)) {
        throw new TypeError(
          `Provider "${entry.provider.id}" returned signal "${reading.name}" more than once.`,
        );
      }
      if (reading.unit !== descriptor.unit) {
        throw new TypeError(
          `Signal "${reading.name}" unit "${String(reading.unit)}" does not match declared unit "${descriptor.unit}".`,
        );
      }
      if (
        typeof reading.observedAt !== "number" ||
        !Number.isFinite(reading.observedAt) ||
        reading.observedAt < 0
      ) {
        throw new TypeError(`Signal "${reading.name}" has an invalid observedAt timestamp.`);
      }
      if (!SIGNAL_STATUSES.includes(reading.status)) {
        throw new TypeError(
          `Signal "${reading.name}" has an invalid status "${String(reading.status)}".`,
        );
      }
      if (reading.status === "ok") {
        if (!Number.isFinite(reading.value)) {
          throw new TypeError(`Signal "${reading.name}" has a non-finite value.`);
        }
        if (
          reading.confidence !== undefined &&
          (!Number.isFinite(reading.confidence) || reading.confidence < 0 || reading.confidence > 1)
        ) {
          throw new TypeError(`Signal "${reading.name}" confidence must be between 0 and 1.`);
        }
      } else if (reading.error !== undefined && typeof reading.error !== "string") {
        throw new TypeError(`Signal "${reading.name}" error must be a string.`);
      }
      received.set(reading.name, reading);
    }

    const readings: ResourceSignal[] = [];
    for (const [name, descriptor] of entry.descriptors) {
      const reading = received.get(name);
      if (reading !== undefined) {
        readings.push(reading);
      } else {
        readings.push({
          name,
          unit: descriptor.unit,
          status: "unknown",
          observedAt: now,
          error: "Provider did not return a reading for this declared signal.",
        });
      }
    }
    return readings;
  }

  #errorReadings(entry: ProviderEntry, now: number, message: string): readonly ResourceSignal[] {
    return [...entry.descriptors.values()].map((descriptor) => ({
      name: descriptor.name,
      unit: descriptor.unit,
      status: "error" as const,
      observedAt: now,
      error: message,
    }));
  }
}
