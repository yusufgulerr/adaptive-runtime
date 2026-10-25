import { ConfigurationError, ProviderTimeoutError, RuntimeClosedError } from "../errors/index.js";
import type { Clock, ClockTimer } from "../types/clock.js";
import type {
  ResourceSignal,
  SignalDescriptor,
  SignalProvider,
  SignalStartContext,
  SignalStatus,
  SignalUnit,
} from "../types/signals.js";
import { errorMessage, toError } from "../utils/errors.js";

export interface SignalSnapshot {
  readonly readings: readonly ResourceSignal[];
  readonly collectedAt: number;
  readonly sequence: number;
  readonly cached: boolean;
  readonly coalesced: boolean;
}

export interface SignalCollectorOptions {
  readonly providers: readonly SignalProvider[];
  readonly evaluationIntervalMs: number;
  readonly providerTimeoutMs: number;
  readonly clock: Clock;
  readonly onProviderError: (providerId: string, error: Error) => void;
  readonly maxConsecutiveFailures?: number;
  readonly failureCooldownMs?: number;
}

export interface ProviderHealthStatus {
  readonly id: string;
  readonly signals: readonly string[];
  readonly consecutiveFailures: number;
  readonly totalFailures: number;
  readonly totalReads: number;
  readonly circuitOpen: boolean;
  readonly cooldownUntilMs: number | null;
}

interface ProviderEntry {
  readonly provider: SignalProvider;
  readonly descriptors: ReadonlyMap<string, SignalDescriptor>;
  /** Resolves once start() settles; reused so start() runs at most once. */
  startPromise: Promise<void> | null;
  started: boolean;
  startError: Error | null;
  consecutiveFailures: number;
  totalFailures: number;
  totalReads: number;
  cooldownUntilMs: number | null;
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
const SIGNAL_STATUSES: readonly string[] = [
  "ok",
  "unknown",
  "unsupported",
  "stale",
  "error",
  "unavailable",
];

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigurationError(`${label} must be a non-empty string.`);
  }
  if (value !== value.trim()) {
    throw new ConfigurationError(`${label} must not have leading or trailing whitespace.`);
  }
  return value;
}

function requireEvaluationInterval(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ConfigurationError(
      "evaluationIntervalMs must be a finite number greater than or equal to 0.",
    );
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
  return Object.freeze({ ...descriptor });
}

/**
 * Owns provider lifecycle, caching, timeouts, and validation. A provider failure
 * becomes error readings for that provider; it does not crash the runtime.
 */
export class SignalCollector {
  readonly #entries: readonly ProviderEntry[];
  readonly #descriptors: readonly SignalDescriptor[];
  readonly #evaluationIntervalMs: number;
  readonly #providerTimeoutMs: number;
  readonly #clock: Clock;
  readonly #onProviderError: (providerId: string, error: Error) => void;
  readonly #maxConsecutiveFailures: number | undefined;
  readonly #failureCooldownMs: number | undefined;
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

    if (options.maxConsecutiveFailures !== undefined) {
      if (
        typeof options.maxConsecutiveFailures !== "number" ||
        !Number.isSafeInteger(options.maxConsecutiveFailures) ||
        options.maxConsecutiveFailures < 1
      ) {
        throw new ConfigurationError(
          "maxConsecutiveFailures must be a safe positive integer greater than or equal to 1.",
        );
      }
    }
    this.#maxConsecutiveFailures = options.maxConsecutiveFailures;

    if (options.failureCooldownMs !== undefined) {
      if (
        typeof options.failureCooldownMs !== "number" ||
        !Number.isFinite(options.failureCooldownMs) ||
        options.failureCooldownMs <= 0
      ) {
        throw new ConfigurationError("failureCooldownMs must be a finite positive number.");
      }
    }
    this.#failureCooldownMs = options.failureCooldownMs;

    const seenProviderIds = new Set<string>();
    const seenSignalNames = new Set<string>();
    const entries: ProviderEntry[] = [];
    const descriptorsList: SignalDescriptor[] = [];
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
        descriptorsList.push(validated);
      }
      entries.push({
        provider,
        descriptors,
        startPromise: null,
        started: false,
        startError: null,
        consecutiveFailures: 0,
        totalFailures: 0,
        totalReads: 0,
        cooldownUntilMs: null,
      });
    }
    this.#entries = entries;
    this.#descriptors = Object.freeze(descriptorsList);
  }

  get closed(): boolean {
    return this.#closed;
  }

  getDescriptors(): readonly SignalDescriptor[] {
    return this.#descriptors;
  }

  getProviderHealth(): readonly ProviderHealthStatus[] {
    const now = this.#clock.now();
    const statuses = this.#entries.map((entry) => {
      const signals = Object.freeze([...entry.descriptors.keys()]);
      const circuitOpen = entry.cooldownUntilMs !== null && now < entry.cooldownUntilMs;
      return Object.freeze({
        id: entry.provider.id,
        signals,
        consecutiveFailures: entry.consecutiveFailures,
        totalFailures: entry.totalFailures,
        totalReads: entry.totalReads,
        circuitOpen,
        cooldownUntilMs: entry.cooldownUntilMs,
      });
    });
    return Object.freeze(statuses);
  }

  resetProviderHealth(providerId?: string): void {
    if (providerId !== undefined) {
      const id = requireNonEmpty(providerId, "Provider id");
      for (const entry of this.#entries) {
        if (entry.provider.id === id) {
          entry.consecutiveFailures = 0;
          entry.totalFailures = 0;
          entry.totalReads = 0;
          entry.cooldownUntilMs = null;
        }
      }
      return;
    }

    for (const entry of this.#entries) {
      entry.consecutiveFailures = 0;
      entry.totalFailures = 0;
      entry.totalReads = 0;
      entry.cooldownUntilMs = null;
    }
  }

  async collect(
    now: number,
    signal: AbortSignal,
    evaluationIntervalMs?: number,
  ): Promise<SignalSnapshot> {
    const effectiveIntervalMs =
      evaluationIntervalMs === undefined
        ? this.#evaluationIntervalMs
        : requireEvaluationInterval(evaluationIntervalMs);
    if (this.#closed) {
      throw new RuntimeClosedError();
    }
    const cached = this.#snapshot;
    if (cached !== null) {
      const age = now - cached.collectedAt;
      if (age >= 0 && age < effectiveIntervalMs) {
        return { ...cached, cached: true, coalesced: false };
      }
    }
    if (this.#inflight !== null && !this.#inflight.controller.signal.aborted) {
      const snapshot = await this.#joinSharedRead(this.#inflight, signal);
      return { ...snapshot, cached: false, coalesced: true };
    }

    if (this.#entries.length === 0) {
      this.#sequence += 1;
      const snapshot: SignalSnapshot = {
        readings: [],
        collectedAt: now,
        sequence: this.#sequence,
        cached: false,
        coalesced: false,
      };
      this.#snapshot = snapshot;
      return snapshot;
    }

    const entry = this.#startSharedRead(now);
    this.#inflight = entry;
    const snapshot = await this.#joinSharedRead(entry, signal);
    return { ...snapshot, cached: false, coalesced: false };
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
    for (const entry of this.#entries) {
      if (!entry.started && entry.startError !== null) {
        entry.startError = null;
        entry.startPromise = null;
      }
    }
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
      coalesced: false,
    };
  }

  async #readEntry(
    entry: ProviderEntry,
    now: number,
    signal: AbortSignal,
  ): Promise<readonly ResourceSignal[]> {
    if (entry.cooldownUntilMs !== null && now < entry.cooldownUntilMs) {
      return this.#synthesizeCircuitOpenReadings(entry, now);
    }

    if (entry.startError !== null) {
      return this.#errorReadings(entry, now, entry.startError.message);
    }

    if (!entry.started) {
      const start = this.#beginStart(entry, now, signal);
      if (start.errorReadings !== null) {
        this.#recordProviderFailure(entry, now);
        return start.errorReadings;
      }
      if (start.promise !== null) {
        const startFailure = await this.#awaitStart(entry, now, signal, start.promise);
        if (startFailure !== null) {
          if (!signal.aborted) {
            this.#recordProviderFailure(entry, now);
          }
          return startFailure;
        }
      }
    }

    const result = await this.#waitForProvider(entry, signal, (providerSignal) =>
      entry.provider.read({ now, signal: providerSignal }),
    );
    let reportedReadError: Error | null = null;
    if (!result.ok && !result.aborted) {
      reportedReadError = result.error;
      this.#onProviderError(entry.provider.id, result.error);
    }
    if (!signal.aborted) {
      this.#drainProviderErrors(entry, reportedReadError);
    }
    if (!result.ok) {
      if (!result.aborted) {
        this.#recordProviderFailure(entry, now);
      }
      return this.#errorReadings(entry, now, result.error.message);
    }

    try {
      const readings = this.#normalizeReadings(entry, result.value, now);
      this.#recordProviderSuccess(entry);
      return readings;
    } catch (error) {
      const failure = toError(error);
      if (!signal.aborted) {
        this.#onProviderError(entry.provider.id, failure);
        this.#recordProviderFailure(entry, now);
      }
      return this.#errorReadings(entry, now, failure.message);
    }
  }

  #recordProviderSuccess(entry: ProviderEntry): void {
    entry.totalReads += 1;
    entry.consecutiveFailures = 0;
    entry.cooldownUntilMs = null;
  }

  #recordProviderFailure(entry: ProviderEntry, now: number): void {
    entry.totalReads += 1;
    entry.totalFailures += 1;
    entry.consecutiveFailures += 1;
    if (
      this.#maxConsecutiveFailures !== undefined &&
      entry.consecutiveFailures >= this.#maxConsecutiveFailures &&
      this.#failureCooldownMs !== undefined &&
      this.#failureCooldownMs > 0
    ) {
      entry.cooldownUntilMs = now + this.#failureCooldownMs;
    }
  }

  #synthesizeCircuitOpenReadings(entry: ProviderEntry, now: number): readonly ResourceSignal[] {
    return Object.freeze(
      [...entry.descriptors.values()].map((descriptor) =>
        Object.freeze({
          name: descriptor.name,
          unit: descriptor.unit,
          status: "unavailable" as unknown as Exclude<SignalStatus, "ok">,
          value: null as unknown as number,
          reason: "provider_circuit_open",
          error: "provider_circuit_open",
          observedAt: now,
          details: Object.freeze({
            reason: "provider_circuit_open",
          }),
        }),
      ),
    );
  }

  /**
   * Drains failures a provider isolated internally. Draining never rejects the
   * collection: a broken drain function or return value is reported instead.
   * The error already reported for this read's own failure is not repeated.
   */
  #drainProviderErrors(entry: ProviderEntry, alreadyReported: Error | null): void {
    const provider = entry.provider;
    let drained: unknown;
    try {
      const drain = provider.drainProviderErrors;
      if (typeof drain !== "function") {
        return;
      }
      drained = drain.call(provider);
    } catch (error) {
      this.#onProviderError(provider.id, toError(error));
      return;
    }

    if (!Array.isArray(drained)) {
      this.#onProviderError(
        provider.id,
        new TypeError(`Provider "${provider.id}" drainProviderErrors() must return an array.`),
      );
      return;
    }

    for (const value of drained as readonly unknown[]) {
      const error = toError(value);
      if (error !== alreadyReported) {
        this.#onProviderError(provider.id, error);
      }
    }
  }

  /**
   * Invokes start() for unstarted providers. Synchronous starts keep their immediate
   * behavior; a returned promise is stored so concurrent or later reads reuse it.
   */
  #beginStart(
    entry: ProviderEntry,
    now: number,
    signal: AbortSignal,
  ): {
    readonly errorReadings: readonly ResourceSignal[] | null;
    readonly promise: Promise<void> | null;
  } {
    if (entry.startPromise !== null) {
      return { errorReadings: null, promise: entry.startPromise };
    }

    if (typeof entry.provider.start !== "function") {
      entry.started = true;
      entry.startError = null;
      return { errorReadings: null, promise: null };
    }

    const context: SignalStartContext = { now, signal };

    let result: void | Promise<void>;
    try {
      result = entry.provider.start(context);
    } catch (error) {
      const failure = toError(error);
      entry.startError = failure;
      entry.started = false;
      this.#onProviderError(entry.provider.id, failure);
      return { errorReadings: this.#errorReadings(entry, now, failure.message), promise: null };
    }

    if (result === undefined) {
      entry.started = true;
      entry.startError = null;
      return { errorReadings: null, promise: null };
    }

    const promise = Promise.resolve(result)
      .then(() => {
        entry.started = true;
        entry.startError = null;
      })
      .catch((error: unknown) => {
        entry.started = false;
        throw toError(error);
      });

    // A caller can abandon the wait through its abort signal; observe any late
    // rejection so it never surfaces as an unhandled rejection.
    promise.catch(() => undefined);
    entry.startPromise = promise;
    return { errorReadings: null, promise };
  }

  /**
   * Waits for a pending start under the provider timeout. A caller abort keeps
   * the start promise reusable and caches nothing; a timeout or rejection is
   * cached as startError and reported once without marking started as true.
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
      entry.startError = null;
      return null;
    }

    if (!result.aborted) {
      entry.startError = result.error;
      entry.started = false;
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
      let normalizedReading: ResourceSignal;
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
        normalizedReading = reading;
      } else {
        if (reading.error !== undefined && typeof reading.error !== "string") {
          throw new TypeError(`Signal "${reading.name}" error must be a string.`);
        }
        normalizedReading =
          reading.error !== undefined
            ? { ...reading, error: errorMessage(reading.error) }
            : reading;
      }
      received.set(reading.name, normalizedReading);
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
      error: errorMessage(message),
    }));
  }
}
