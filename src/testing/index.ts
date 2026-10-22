import { ConfigurationError } from "../errors/index.js";
import type { Clock, ClockTimer } from "../types/clock.js";
import type {
  ResourceSignal,
  SignalDescriptor,
  SignalProvider,
  SignalReadContext,
  SignalStatus,
  SignalUnit,
} from "../types/signals.js";

const SIGNAL_UNITS: readonly SignalUnit[] = ["bytes", "milliseconds", "ratio", "count", "custom"];

const SIGNAL_STATUSES: readonly SignalStatus[] = ["ok", "unknown", "unsupported", "stale", "error"];

const UNAVAILABLE_STATUSES: readonly Exclude<SignalStatus, "ok">[] = [
  "unknown",
  "unsupported",
  "stale",
  "error",
];

function isSignalUnit(value: unknown): value is SignalUnit {
  return typeof value === "string" && SIGNAL_UNITS.includes(value as SignalUnit);
}

function isUnavailableStatus(value: unknown): value is Exclude<SignalStatus, "ok"> {
  return (
    typeof value === "string" && UNAVAILABLE_STATUSES.includes(value as Exclude<SignalStatus, "ok">)
  );
}

/**
 * A deterministic clock for tests. Timers fire only when `advance()` is called;
 * wall-clock time never influences a test run.
 */
export interface FakeClock extends Clock {
  /** Moves time forward and executes every timer that becomes due, in order. */
  advance(ms: number): void;
  /** Sets the current time without executing timers. Overdue timers fire on advance(0). */
  set(ms: number): void;
  /** Number of scheduled timers that have neither fired nor been cancelled. */
  pendingTimers(): number;
}

interface FakeTimer {
  readonly at: number;
  readonly sequence: number;
  readonly callback: () => void;
  cancelled: boolean;
  fired: boolean;
}

class FakeClockImpl implements FakeClock {
  #now: number;
  #sequence = 0;
  readonly #timers: FakeTimer[] = [];

  constructor(initialMs: number) {
    this.#now = initialMs;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, delayMs: number): ClockTimer {
    if (typeof callback !== "function") {
      throw new TypeError("FakeClock setTimeout callback must be a function.");
    }
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new RangeError("FakeClock delay must be a finite number greater than or equal to 0.");
    }
    this.#sequence += 1;
    const timer: FakeTimer = {
      at: this.#now + delayMs,
      sequence: this.#sequence,
      callback,
      cancelled: false,
      fired: false,
    };
    this.#timers.push(timer);
    return {
      cancel: () => {
        timer.cancelled = true;
      },
    };
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError("FakeClock advance must be a finite number greater than or equal to 0.");
    }
    const target = this.#now + ms;
    for (;;) {
      let next: FakeTimer | undefined;
      for (const timer of this.#timers) {
        if (timer.cancelled || timer.fired || timer.at > target) {
          continue;
        }
        if (
          next === undefined ||
          timer.at < next.at ||
          (timer.at === next.at && timer.sequence < next.sequence)
        ) {
          next = timer;
        }
      }
      if (next === undefined) {
        break;
      }
      next.fired = true;
      this.#now = next.at;
      next.callback();
    }
    this.#now = target;
  }

  set(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError("FakeClock time must be a finite number greater than or equal to 0.");
    }
    this.#now = ms;
  }

  pendingTimers(): number {
    let pending = 0;
    for (const timer of this.#timers) {
      if (!timer.cancelled && !timer.fired) {
        pending += 1;
      }
    }
    return pending;
  }
}

/**
 * Creates a deterministic clock for provider, policy, and runtime tests.
 * Defaults to time 0. The returned clock is not automatically disposed.
 */
export function createFakeClock(initialMs = 0): FakeClock {
  if (!Number.isFinite(initialMs) || initialMs < 0) {
    throw new RangeError(
      "FakeClock initial time must be a finite number greater than or equal to 0.",
    );
  }
  return new FakeClockImpl(initialMs);
}

/**
 * One scripted value: a finite measurement, or an explicit unavailable status.
 * A number always becomes an `ok` reading with `confidence: 1`.
 */
export type ScriptedSignalValue =
  | number
  | {
      readonly status: Exclude<SignalStatus, "ok">;
      readonly error?: string;
    };

export interface ScriptedSignal {
  readonly name: string;
  readonly unit: SignalUnit;
  readonly description?: string;
  readonly values: readonly ScriptedSignalValue[];
}

export interface ScriptedSignalProviderOptions {
  readonly id?: string;
  /** At least one signal, each with at least one scripted value. */
  readonly script: readonly ScriptedSignal[];
  /**
   * When true (default), the last value repeats after the script is exhausted.
   * When false, the provider reports `unknown` readings after exhaustion.
   */
  readonly repeatLast?: boolean;
}

function resolveScriptedId(id: string | undefined): string {
  if (id === undefined) {
    return "scripted-signals";
  }
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new ConfigurationError("ScriptedSignalProvider id must be a non-empty string.");
  }
  if (id !== id.trim()) {
    throw new ConfigurationError(
      "ScriptedSignalProvider id must not have leading or trailing whitespace.",
    );
  }
  return id;
}

function validateScriptedSignal(
  signal: ScriptedSignal,
  index: number,
  seenNames: Set<string>,
): void {
  if (signal === null || typeof signal !== "object") {
    throw new ConfigurationError(`script[${index}] must be an object.`);
  }
  if (
    typeof signal.name !== "string" ||
    signal.name.trim().length === 0 ||
    signal.name !== signal.name.trim()
  ) {
    throw new ConfigurationError(`script[${index}].name must be a non-empty trimmed string.`);
  }
  if (seenNames.has(signal.name)) {
    throw new ConfigurationError(`Duplicate scripted signal name "${signal.name}".`);
  }
  seenNames.add(signal.name);
  if (!isSignalUnit(signal.unit)) {
    throw new ConfigurationError(
      `script[${index}].unit must be one of ${SIGNAL_UNITS.join(", ")}.`,
    );
  }
  if (signal.description !== undefined && typeof signal.description !== "string") {
    throw new ConfigurationError(`script[${index}].description must be a string.`);
  }
  if (!Array.isArray(signal.values) || signal.values.length === 0) {
    throw new ConfigurationError(`script[${index}].values must be a non-empty array.`);
  }
  for (const [valueIndex, value] of signal.values.entries()) {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new ConfigurationError(
          `script[${index}].values[${valueIndex}] must be a finite number or status object.`,
        );
      }
      continue;
    }
    if (value === null || typeof value !== "object") {
      throw new ConfigurationError(
        `script[${index}].values[${valueIndex}] must be a finite number or status object.`,
      );
    }
    if (!isUnavailableStatus(value.status)) {
      throw new ConfigurationError(
        `script[${index}].values[${valueIndex}].status must be an unavailable signal status.`,
      );
    }
    if (value.error !== undefined && typeof value.error !== "string") {
      throw new ConfigurationError(
        `script[${index}].values[${valueIndex}].error must be a string.`,
      );
    }
  }
}

/**
 * A deterministic provider that replays one step of a scripted sequence per
 * read. It is intended for tests and examples, not production measurement.
 */
export class ScriptedSignalProvider implements SignalProvider {
  readonly id: string;
  readonly signals: readonly SignalDescriptor[];
  readonly #script: readonly ScriptedSignal[];
  readonly #repeatLast: boolean;
  #index = 0;
  #closed = false;

  constructor(options: ScriptedSignalProviderOptions) {
    if (options === null || typeof options !== "object") {
      throw new ConfigurationError("ScriptedSignalProvider requires an options object.");
    }
    this.id = resolveScriptedId(options.id);
    if (!Array.isArray(options.script) || options.script.length === 0) {
      throw new ConfigurationError("ScriptedSignalProvider requires a non-empty script array.");
    }
    if (options.repeatLast !== undefined && typeof options.repeatLast !== "boolean") {
      throw new ConfigurationError("ScriptedSignalProvider repeatLast must be a boolean.");
    }
    this.#repeatLast = options.repeatLast ?? true;

    const seenNames = new Set<string>();
    for (const [index, signal] of options.script.entries()) {
      validateScriptedSignal(signal, index, seenNames);
    }

    this.#script = options.script.map((signal) => ({
      name: signal.name,
      unit: signal.unit,
      ...(signal.description === undefined ? {} : { description: signal.description }),
      values: [...signal.values],
    }));
    this.signals = this.#script.map((signal) => ({
      name: signal.name,
      unit: signal.unit,
      ...(signal.description === undefined ? {} : { description: signal.description }),
    }));
  }

  /** Restarts the script without changing descriptors or lifecycle. */
  reset(): void {
    this.#index = 0;
  }

  read(context: SignalReadContext): readonly ResourceSignal[] {
    const observedAt = context.now;
    if (this.#closed) {
      return this.#script.map((signal) => ({
        name: signal.name,
        unit: signal.unit,
        status: "unsupported",
        observedAt,
        error: "Scripted provider is closed.",
      }));
    }

    const step = this.#index;
    this.#index += 1;

    return this.#script.map((signal) => {
      if (!this.#repeatLast && step >= signal.values.length) {
        return {
          name: signal.name,
          unit: signal.unit,
          status: "unknown",
          observedAt,
          error: "Scripted sequence is exhausted.",
        };
      }
      const valueIndex = this.#repeatLast ? Math.min(step, signal.values.length - 1) : step;
      const value = signal.values[valueIndex] as ScriptedSignalValue;
      if (typeof value === "number") {
        return {
          name: signal.name,
          unit: signal.unit,
          status: "ok",
          value,
          observedAt,
          confidence: 1,
        };
      }
      return {
        name: signal.name,
        unit: signal.unit,
        status: value.status,
        observedAt,
        ...(value.error === undefined ? {} : { error: value.error }),
      };
    });
  }

  close(): void {
    this.#closed = true;
  }
}

export interface ConformanceOptions {
  /** Clock value supplied to read(); defaults to 1_000_000. */
  readonly now?: number;
  /** Abort signal supplied to read(); defaults to a fresh, un-aborted signal. */
  readonly signal?: AbortSignal;
}

export interface ProviderConformanceReport {
  readonly ok: boolean;
  readonly providerId: string;
  readonly checksPassed: number;
  readonly failures: readonly string[];
}

class ConformanceRecorder {
  checksPassed = 0;
  readonly failures: string[] = [];

  pass(): void {
    this.checksPassed += 1;
  }

  fail(message: string): void {
    this.failures.push(message);
  }

  check(condition: boolean, message: string): void {
    if (condition) {
      this.pass();
    } else {
      this.fail(message);
    }
  }
}

interface ProviderShape {
  readonly id?: unknown;
  readonly signals?: unknown;
  readonly start?: unknown;
  readonly read?: unknown;
  readonly close?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function validateDescriptors(
  signals: unknown,
  recorder: ConformanceRecorder,
): Map<string, SignalDescriptor> {
  const descriptors = new Map<string, SignalDescriptor>();
  if (!Array.isArray(signals) || signals.length === 0) {
    recorder.fail("provider.signals must be a non-empty array.");
    return descriptors;
  }
  recorder.pass();

  for (const [index, descriptor] of signals.entries()) {
    if (!isRecord(descriptor)) {
      recorder.fail(`provider.signals[${index}] must be an object.`);
      continue;
    }
    const name = descriptor.name;
    if (typeof name !== "string" || name.trim().length === 0) {
      recorder.fail(`provider.signals[${index}].name must be a non-empty string.`);
      continue;
    }
    if (name !== name.trim()) {
      recorder.fail(`provider.signals[${index}].name must not have surrounding whitespace.`);
      continue;
    }
    recorder.pass();

    if (!isSignalUnit(descriptor.unit)) {
      recorder.fail(`Signal "${name}" has an invalid unit.`);
      continue;
    }
    recorder.pass();

    if (descriptor.description !== undefined && typeof descriptor.description !== "string") {
      recorder.fail(`Signal "${name}" description must be a string.`);
      continue;
    }
    recorder.pass();

    if (descriptors.has(name)) {
      recorder.fail(`Duplicate signal name "${name}".`);
      continue;
    }
    descriptors.set(name, {
      name,
      unit: descriptor.unit,
      ...(descriptor.description === undefined
        ? {}
        : { description: descriptor.description as string }),
    });
  }

  return descriptors;
}

function validateReading(
  reading: unknown,
  index: number,
  descriptors: ReadonlyMap<string, SignalDescriptor>,
  observedSeen: Set<string>,
  now: number,
  recorder: ConformanceRecorder,
): void {
  if (!isRecord(reading)) {
    recorder.fail(`readings[${index}] must be an object.`);
    return;
  }
  const name = reading.name;
  if (typeof name !== "string" || name.length === 0) {
    recorder.fail(`readings[${index}].name must be a non-empty string.`);
    return;
  }
  const descriptor = descriptors.get(name);
  if (descriptor === undefined) {
    recorder.fail(`readings[${index}] uses undeclared signal "${name}".`);
    return;
  }
  recorder.pass();

  if (observedSeen.has(name)) {
    recorder.fail(`Signal "${name}" was returned more than once.`);
  } else {
    observedSeen.add(name);
    recorder.pass();
  }

  recorder.check(
    reading.unit === descriptor.unit,
    `Signal "${name}" unit must match its descriptor ("${descriptor.unit}").`,
  );
  recorder.check(
    reading.observedAt === now,
    `Signal "${name}" observedAt must equal context.now (${now}).`,
  );

  if (!SIGNAL_STATUSES.includes(reading.status as SignalStatus)) {
    recorder.fail(`Signal "${name}" has an invalid status.`);
    return;
  }
  recorder.pass();

  if (reading.status === "ok") {
    recorder.check(
      typeof reading.value === "number" && Number.isFinite(reading.value),
      `Signal "${name}" has status "ok" but no finite value.`,
    );
    if (reading.confidence !== undefined) {
      recorder.check(
        typeof reading.confidence === "number" &&
          Number.isFinite(reading.confidence) &&
          reading.confidence >= 0 &&
          reading.confidence <= 1,
        `Signal "${name}" confidence must be a finite number between 0 and 1.`,
      );
    }
    return;
  }

  if (reading.error !== undefined) {
    recorder.check(
      typeof reading.error === "string",
      `Signal "${name}" error must be a string when present.`,
    );
  }
}

/**
 * Verifies that a provider satisfies the signal-provider contract without
 * requiring the runtime. Lifecycle hooks are invoked once. The function reports
 * failures instead of throwing, so it can be used in generated test suites.
 */
export async function runProviderConformanceCheck(
  provider: SignalProvider,
  options: ConformanceOptions = {},
): Promise<ProviderConformanceReport> {
  const recorder = new ConformanceRecorder();
  const maybe = provider as unknown as ProviderShape | null;
  const providerId = typeof maybe?.id === "string" ? maybe.id : "";

  if (maybe === null || typeof maybe !== "object") {
    recorder.fail("Provider must be an object.");
    return {
      ok: false,
      providerId,
      checksPassed: recorder.checksPassed,
      failures: Object.freeze([...recorder.failures]),
    };
  }

  recorder.check(
    typeof maybe.id === "string" && maybe.id.trim().length > 0,
    "provider.id must be a non-empty string.",
  );
  if (typeof maybe.id === "string" && maybe.id.trim().length > 0) {
    recorder.check(
      maybe.id === maybe.id.trim(),
      "provider.id must not have leading or trailing whitespace.",
    );
  }

  const descriptors = validateDescriptors(maybe.signals, recorder);

  if (typeof maybe.start === "function") {
    try {
      await (maybe.start as () => void | Promise<void>)();
      recorder.pass();
    } catch {
      recorder.fail("provider.start() threw or rejected.");
    }
  } else {
    recorder.pass();
  }

  const now = options.now ?? 1_000_000;
  const signal = options.signal ?? new AbortController().signal;
  const context: SignalReadContext = { now, signal };

  if (typeof maybe.read !== "function") {
    recorder.fail("provider.read must be a function.");
  } else {
    let readSucceeded = false;
    let readings: unknown;
    try {
      readings = await (maybe.read as (ctx: SignalReadContext) => unknown)(context);
      readSucceeded = true;
      recorder.pass();
    } catch {
      recorder.fail("provider.read() threw or rejected.");
    }

    if (readSucceeded) {
      if (!Array.isArray(readings)) {
        recorder.fail("provider.read() must return an array.");
      } else {
        recorder.pass();
        const observedSeen = new Set<string>();
        for (const [index, reading] of readings.entries()) {
          validateReading(reading, index, descriptors, observedSeen, now, recorder);
        }
      }
    }
  }

  if (typeof maybe.close === "function") {
    try {
      await (maybe.close as () => void | Promise<void>)();
      recorder.pass();
    } catch {
      recorder.fail("provider.close() threw or rejected.");
    }
  } else {
    recorder.pass();
  }

  return {
    ok: recorder.failures.length === 0,
    providerId,
    checksPassed: recorder.checksPassed,
    failures: Object.freeze([...recorder.failures]),
  };
}
