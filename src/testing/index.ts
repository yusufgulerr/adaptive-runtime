import { ConfigurationError } from "../errors/index.js";
import {
  createInitialPolicyState,
  evaluatePolicy,
  type PolicyState,
  type StrategyCandidate,
} from "../policy/engine.js";

/** Thrown when testing configuration or simulation parameters are invalid. */
export class InvalidConfigurationError extends ConfigurationError {
  readonly field: string;

  constructor(field: string, message?: string) {
    super(message ?? `${field} must be a non-negative integer or null when present.`);
    this.name = "InvalidConfigurationError";
    this.field = field;
  }
}

export {
  capturePolicyTrace,
  createPolicyTraceRecorder,
  diffPolicyTraces,
  importPolicyTrace,
  type PolicyTrace,
  type PolicyTraceDiff,
  type PolicyTraceDivergence,
  type PolicyTraceEntry,
  type PolicyTraceRecorder,
  type PolicyTraceRecorderOptions,
  type PolicyTraceReplayDivergence,
  type PolicyTraceReplayReport,
  type PolicyTraceSummary,
  type RecordPolicyTraceEntryInput,
  replayPolicyTrace,
  summarizePolicyTrace,
} from "./trace.js";

import { resolvePolicy } from "../policy/resolve.js";
import type { Clock, ClockTimer } from "../types/clock.js";
import type { DecisionReason, StrategyDecision } from "../types/decision.js";
import type { OperationPolicy, Policy } from "../types/policy.js";
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
  /**
   * When true (the default), a provider that defines `close()` is read once
   * more after closing, and every reading must report `status: "unsupported"`.
   */
  readonly checkPostClose?: boolean;
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
  readonly drainProviderErrors?: unknown;
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

function validatePostCloseReadings(
  readings: unknown,
  descriptors: ReadonlyMap<string, SignalDescriptor>,
  now: number,
  recorder: ConformanceRecorder,
): void {
  if (!Array.isArray(readings)) {
    recorder.fail("provider.read() after close() must return an array.");
    return;
  }
  recorder.pass();

  const observedSeen = new Set<string>();
  for (const [index, reading] of readings.entries()) {
    validateReading(reading, index, descriptors, observedSeen, now, recorder);
    if (isRecord(reading)) {
      recorder.check(
        reading.status === "unsupported",
        `readings[${index}] must report status "unsupported" after close().`,
      );
    }
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
    try {
      await (maybe.start as () => void | Promise<void>)();
      recorder.pass();
    } catch {
      recorder.fail("provider.start() threw or rejected on second call.");
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

    let concurrentReadings: unknown;
    let concurrentSucceeded = false;
    try {
      concurrentReadings = await Promise.all([
        (maybe.read as (ctx: SignalReadContext) => unknown)(context),
        (maybe.read as (ctx: SignalReadContext) => unknown)(context),
      ]);
      concurrentSucceeded = true;
      recorder.pass();
    } catch {
      recorder.fail("concurrent provider.read() threw or rejected.");
    }

    if (concurrentSucceeded) {
      if (!Array.isArray(concurrentReadings)) {
        recorder.fail("concurrent provider.read() must return an array.");
      } else {
        const [readA, readB] = concurrentReadings;
        if (!Array.isArray(readA) || !Array.isArray(readB)) {
          recorder.fail("concurrent provider.read() calls must both return arrays of signals.");
        } else {
          recorder.pass();
          const observedSeenA = new Set<string>();
          for (const [index, reading] of readA.entries()) {
            validateReading(reading, index, descriptors, observedSeenA, now, recorder);
          }
          const observedSeenB = new Set<string>();
          for (const [index, reading] of readB.entries()) {
            validateReading(reading, index, descriptors, observedSeenB, now, recorder);
          }
        }
      }
    }
  }

  if (typeof maybe.drainProviderErrors === "function") {
    let drained: unknown;
    try {
      drained = await (maybe.drainProviderErrors as () => unknown)();
      recorder.check(
        Array.isArray(drained),
        "provider.drainProviderErrors() must return an array.",
      );
    } catch {
      recorder.fail("provider.drainProviderErrors() threw or rejected.");
    }
  }

  let closeSucceeded = false;
  if (typeof maybe.close === "function") {
    try {
      await (maybe.close as () => void | Promise<void>)();
      recorder.pass();
      closeSucceeded = true;
    } catch {
      recorder.fail("provider.close() threw or rejected.");
    }
    try {
      await (maybe.close as () => void | Promise<void>)();
      recorder.pass();
    } catch {
      recorder.fail("provider.close() threw or rejected on second call.");
    }
  } else {
    recorder.pass();
  }

  if (closeSucceeded && options.checkPostClose !== false && typeof maybe.read === "function") {
    let postCloseReadings: unknown;
    let postCloseSucceeded = false;
    try {
      postCloseReadings = await (maybe.read as (ctx: SignalReadContext) => unknown)(context);
      postCloseSucceeded = true;
      recorder.pass();
    } catch {
      recorder.fail("provider.read() after close() threw or rejected.");
    }
    if (postCloseSucceeded) {
      validatePostCloseReadings(postCloseReadings, descriptors, now, recorder);
    }
  }

  return {
    ok: recorder.failures.length === 0,
    providerId,
    checksPassed: recorder.checksPassed,
    failures: Object.freeze([...recorder.failures]),
  };
}

/** A declared strategy for a simulated policy timeline. */
export interface SimulatedStrategy {
  readonly id: string;
  readonly qualityTier: number;
  readonly costTier?: number;
  /** Defaults to true. */
  readonly applicable?: boolean;
  /** Arithmetic mean of historical durations, or null when untracked. */
  readonly estimatedLatencyMs?: number | null;
  /** Exponentially weighted recent latency, or null when untracked. */
  readonly ewmaLatencyMs?: number | null;
  /** Observed failure ratio in the range 0..1; 0 when no runs exist, or null when untracked. */
  readonly errorRate?: number | null;
  /** Number of execution samples observed for this strategy, or null when untracked. */
  readonly samples?: number | null;
}

/** One clock-and-signal snapshot supplied to the simulator. */
export interface PolicyTimelineStep {
  /** Optional label identifying this step in comparison reports or logs. */
  readonly label?: string;
  /** Clock value for this step. Defaults to index * 1000. */
  readonly now?: number;
  readonly signals: readonly ResourceSignal[];
  /** Optional per-step strategy pool override. */
  readonly strategies?: readonly SimulatedStrategy[];
  readonly pinnedStrategyId?: string | null;
  readonly adaptationEnabled?: boolean;
  /** Defaults to null (every step is treated as a fresh sample). */
  readonly sampleSequence?: number | null;
  /** Defaults to false. */
  readonly signalsCached?: boolean;
}

export interface SimulatePolicyTimelineOptions {
  readonly operationId?: string;
  readonly policy?: Policy;
  readonly strategies: readonly SimulatedStrategy[];
  readonly initialState?: PolicyState;
  readonly steps: readonly PolicyTimelineStep[];
}

export interface PolicyTimelineStepResult {
  readonly index: number;
  readonly now: number;
  readonly decision: StrategyDecision;
  readonly state: PolicyState;
  readonly engagedBudgetIds: readonly string[];
  readonly recoveredBudgetIds: readonly string[];
}

export interface PolicyTimelineResult {
  readonly steps: readonly PolicyTimelineStepResult[];
  readonly decisions: readonly StrategyDecision[];
  readonly finalState: PolicyState;
  readonly strategySwitches: number;
  readonly totalSwitches: number;
  readonly strategyReversals: number;
  readonly engagedBudgetIds: readonly string[];
  readonly recoveredBudgetIds: readonly string[];
}

interface NormalizedPolicyTimelineStep {
  readonly label?: string;
  readonly now: number;
  readonly signals: readonly ResourceSignal[];
  readonly strategies: readonly StrategyCandidate[];
  readonly pinnedStrategyId: string | null;
  readonly adaptationEnabled: boolean;
  readonly sampleSequence: number | null;
  readonly signalsCached: boolean;
}

function isCanonicalIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value === value.trim();
}

function normalizeSimulatedStrategies(
  strategies: unknown,
  label: string,
): readonly StrategyCandidate[] {
  if (!Array.isArray(strategies) || strategies.length === 0) {
    throw new ConfigurationError(`${label} must be a non-empty array.`);
  }
  const seenIds = new Set<string>();
  return strategies.map((strategy, index) => {
    if (!isRecord(strategy)) {
      throw new ConfigurationError(`${label}[${index}] must be an object.`);
    }
    const id = strategy.id;
    const qualityTier = strategy.qualityTier;
    const costTier = strategy.costTier;
    const applicable = strategy.applicable;
    const estimatedLatencyMs = strategy.estimatedLatencyMs;
    const ewmaLatencyMs = strategy.ewmaLatencyMs;
    const errorRate = strategy.errorRate;
    const samples = (strategy as { samples?: unknown }).samples;
    if (!isCanonicalIdentifier(id)) {
      throw new ConfigurationError(`${label}[${index}].id must be a non-empty trimmed string.`);
    }
    if (seenIds.has(id)) {
      throw new ConfigurationError(`${label} contains duplicate strategy id "${id}".`);
    }
    seenIds.add(id);
    if (typeof qualityTier !== "number" || !Number.isFinite(qualityTier)) {
      throw new ConfigurationError(`${label}[${index}].qualityTier must be a finite number.`);
    }
    if (costTier !== undefined && (typeof costTier !== "number" || !Number.isFinite(costTier))) {
      throw new ConfigurationError(
        `${label}[${index}].costTier must be a finite number when present.`,
      );
    }
    if (applicable !== undefined && typeof applicable !== "boolean") {
      throw new ConfigurationError(`${label}[${index}].applicable must be a boolean when present.`);
    }
    if (
      estimatedLatencyMs !== undefined &&
      estimatedLatencyMs !== null &&
      (typeof estimatedLatencyMs !== "number" ||
        !Number.isFinite(estimatedLatencyMs) ||
        estimatedLatencyMs < 0)
    ) {
      throw new ConfigurationError(
        `${label}[${index}].estimatedLatencyMs must be a non-negative finite number or null when present.`,
      );
    }
    if (
      ewmaLatencyMs !== undefined &&
      ewmaLatencyMs !== null &&
      (typeof ewmaLatencyMs !== "number" || !Number.isFinite(ewmaLatencyMs) || ewmaLatencyMs < 0)
    ) {
      throw new ConfigurationError(
        `${label}[${index}].ewmaLatencyMs must be a non-negative finite number or null when present.`,
      );
    }
    if (
      errorRate !== undefined &&
      errorRate !== null &&
      (typeof errorRate !== "number" ||
        !Number.isFinite(errorRate) ||
        errorRate < 0 ||
        errorRate > 1)
    ) {
      throw new ConfigurationError(
        `${label}[${index}].errorRate must be a finite number between 0 and 1 or null when present.`,
      );
    }
    if (
      samples !== undefined &&
      samples !== null &&
      (typeof samples !== "number" || !Number.isSafeInteger(samples) || samples < 0)
    ) {
      throw new InvalidConfigurationError(
        "strategies.samples",
        `${label}[${index}].samples must be a non-negative integer or null when present.`,
      );
    }
    return {
      id,
      qualityTier,
      ...(costTier === undefined ? {} : { costTier }),
      applicable: applicable ?? true,
      ...(estimatedLatencyMs !== undefined ? { estimatedLatencyMs } : {}),
      ...(ewmaLatencyMs !== undefined ? { ewmaLatencyMs } : {}),
      ...(errorRate !== undefined ? { errorRate } : {}),
      samples: (strategy as { samples?: number | null }).samples ?? null,
    } as StrategyCandidate;
  });
}

function normalizePolicyTimelineStep(
  step: unknown,
  index: number,
  fallbackStrategies: readonly StrategyCandidate[],
  defaultAdaptationEnabled: boolean,
): NormalizedPolicyTimelineStep {
  if (!isRecord(step)) {
    throw new ConfigurationError(`steps[${index}] must be an object.`);
  }
  if (!Array.isArray(step.signals)) {
    throw new ConfigurationError(`steps[${index}].signals must be an array.`);
  }

  let label: string | undefined;
  if (step.label !== undefined) {
    if (typeof step.label !== "string") {
      throw new ConfigurationError(`steps[${index}].label must be a string when present.`);
    }
    label = step.label;
  }

  let now = index * 1000;
  if (step.now !== undefined) {
    if (typeof step.now !== "number" || !Number.isFinite(step.now) || step.now < 0) {
      throw new ConfigurationError(
        `steps[${index}].now must be a finite number greater than or equal to 0.`,
      );
    }
    now = step.now;
  }

  let pinnedStrategyId: string | null = null;
  if (step.pinnedStrategyId !== undefined && step.pinnedStrategyId !== null) {
    if (!isCanonicalIdentifier(step.pinnedStrategyId)) {
      throw new ConfigurationError(
        `steps[${index}].pinnedStrategyId must be a non-empty trimmed string or null.`,
      );
    }
    pinnedStrategyId = step.pinnedStrategyId;
  }

  let adaptationEnabled = defaultAdaptationEnabled;
  if (step.adaptationEnabled !== undefined) {
    if (typeof step.adaptationEnabled !== "boolean") {
      throw new ConfigurationError(`steps[${index}].adaptationEnabled must be a boolean.`);
    }
    adaptationEnabled = step.adaptationEnabled;
  }

  let sampleSequence: number | null = null;
  if (step.sampleSequence !== undefined && step.sampleSequence !== null) {
    if (
      typeof step.sampleSequence !== "number" ||
      !Number.isInteger(step.sampleSequence) ||
      step.sampleSequence < 0
    ) {
      throw new ConfigurationError(
        `steps[${index}].sampleSequence must be a non-negative integer or null.`,
      );
    }
    sampleSequence = step.sampleSequence;
  }

  let signalsCached = false;
  if (step.signalsCached !== undefined) {
    if (typeof step.signalsCached !== "boolean") {
      throw new ConfigurationError(`steps[${index}].signalsCached must be a boolean.`);
    }
    signalsCached = step.signalsCached;
  }

  return {
    ...(label !== undefined ? { label } : {}),
    now,
    signals: step.signals as readonly ResourceSignal[],
    strategies:
      step.strategies === undefined
        ? fallbackStrategies
        : normalizeSimulatedStrategies(step.strategies, `steps[${index}].strategies`),
    pinnedStrategyId,
    adaptationEnabled,
    sampleSequence,
    signalsCached,
  };
}

/**
 * Replays policy decisions over a fixed timeline without providers, strategy
 * execution, or timers. The result is a pure simulation: each step advances the
 * policy state exactly once, budget transitions are derived from consecutive
 * state snapshots, and the same options always produce the same decisions.
 */
export function simulatePolicyTimeline(
  options: SimulatePolicyTimelineOptions,
): PolicyTimelineResult {
  if (options === null || typeof options !== "object") {
    throw new ConfigurationError("simulatePolicyTimeline requires an options object.");
  }

  const operationId = options.operationId ?? "simulated-operation";
  if (!isCanonicalIdentifier(operationId)) {
    throw new ConfigurationError("operationId must be a non-empty trimmed string.");
  }

  const defaultStrategies = normalizeSimulatedStrategies(options.strategies, "strategies");

  if (!Array.isArray(options.steps) || options.steps.length === 0) {
    throw new ConfigurationError("steps must be a non-empty array.");
  }

  const resolvedPolicy = resolvePolicy(options.policy);

  const steps = options.steps.map((step, index) =>
    normalizePolicyTimelineStep(step, index, defaultStrategies, resolvedPolicy.adaptationEnabled),
  );

  let state = options.initialState ?? createInitialPolicyState();
  let previousBudgets: PolicyState["budgets"] = state.budgets;

  const stepResults: PolicyTimelineStepResult[] = [];
  const decisions: StrategyDecision[] = [];
  const engagedBudgetIds: string[] = [];
  const recoveredBudgetIds: string[] = [];
  const engagedSeen = new Set<string>();
  const recoveredSeen = new Set<string>();

  let strategySwitches = 0;
  let strategyReversals = 0;
  let lastSwitchFrom: string | null = null;
  let lastSwitchTo: string | null = null;

  for (const [index, step] of steps.entries()) {
    let stepPolicy = resolvedPolicy;
    if (resolvedPolicy.customSelector) {
      const originalSelector = resolvedPolicy.customSelector;
      const candidateSamples = new Map(
        step.strategies.map((s) => [s.id, (s as { samples?: number | null }).samples ?? null]),
      );
      stepPolicy = {
        ...resolvedPolicy,
        customSelector: (ctx) => {
          const enrichedCandidates = ctx.candidates.map((c) => ({
            ...c,
            samples:
              (c as { samples?: number | null }).samples ??
              candidateSamples.get(c.candidate.id) ??
              null,
          }));
          return originalSelector({
            ...ctx,
            candidates: enrichedCandidates,
          });
        },
      };
    }

    const evaluation = evaluatePolicy(
      state,
      {
        operationId,
        now: step.now,
        signals: step.signals,
        strategies: step.strategies,
        pinnedStrategyId: step.pinnedStrategyId,
        adaptationEnabled: step.adaptationEnabled,
        sampleSequence: step.sampleSequence,
        signalsCached: step.signalsCached,
      },
      stepPolicy,
    );

    const decision = evaluation.decision;
    state = evaluation.state;

    const stepEngaged: string[] = [];
    const stepRecovered: string[] = [];
    for (const budgetId of new Set([
      ...Object.keys(previousBudgets),
      ...Object.keys(state.budgets),
    ])) {
      const wasEngaged = previousBudgets[budgetId]?.engaged === true;
      const isEngaged = state.budgets[budgetId]?.engaged === true;
      if (!wasEngaged && isEngaged) {
        stepEngaged.push(budgetId);
        if (!engagedSeen.has(budgetId)) {
          engagedSeen.add(budgetId);
          engagedBudgetIds.push(budgetId);
        }
      } else if (wasEngaged && !isEngaged) {
        stepRecovered.push(budgetId);
        if (!recoveredSeen.has(budgetId)) {
          recoveredSeen.add(budgetId);
          recoveredBudgetIds.push(budgetId);
        }
      }
    }

    stepResults.push({
      index,
      now: step.now,
      decision,
      state,
      engagedBudgetIds: stepEngaged,
      recoveredBudgetIds: stepRecovered,
    });
    decisions.push(decision);

    if (decision.changed) {
      strategySwitches += 1;
      const from = decision.previousStrategyId;
      const to = decision.strategyId;
      if (lastSwitchFrom !== null && from === lastSwitchTo && to === lastSwitchFrom) {
        strategyReversals += 1;
      }
      lastSwitchFrom = from;
      lastSwitchTo = to;
    }

    previousBudgets = state.budgets;
  }

  return {
    steps: stepResults,
    decisions,
    finalState: state,
    strategySwitches,
    totalSwitches: strategySwitches,
    strategyReversals,
    engagedBudgetIds,
    recoveredBudgetIds,
  };
}

function deepFreeze<T>(value: T, seen = new Set<unknown>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const prop of Object.values(value)) {
    if (prop !== null && typeof prop === "object" && !Object.isFrozen(prop)) {
      deepFreeze(prop, seen);
    }
  }
  return Object.freeze(value);
}

export type PolicyTimelineSimulationResult = PolicyTimelineResult;

export interface ComparePolicyTimelinesOptions {
  readonly baselinePolicy: OperationPolicy;
  readonly candidatePolicy: OperationPolicy;
  readonly strategies: readonly SimulatedStrategy[];
  readonly steps: readonly PolicyTimelineStep[];
  readonly initialStrategyId?: string | null;
}

export interface PolicyStepDivergence {
  readonly stepIndex: number;
  readonly timestamp: number;
  readonly label?: string;
  readonly baselineStrategyId: string;
  readonly candidateStrategyId: string;
  readonly baselineReason: DecisionReason;
  readonly candidateReason: DecisionReason;
}

export interface PolicyTimelineComparisonReport {
  readonly baseline: PolicyTimelineSimulationResult;
  readonly candidate: PolicyTimelineSimulationResult;
  readonly totalSteps: number;
  readonly divergenceCount: number;
  readonly agreementRatio: number;
  readonly divergences: readonly PolicyStepDivergence[];
  readonly switchCountDelta: number;
}

/**
 * Compares two policies step-by-step across an identical simulated timeline.
 * Calculates selection divergences, agreement ratio, and switch count delta.
 * Returns a deeply frozen report.
 */
export function comparePolicyTimelines(
  options: ComparePolicyTimelinesOptions,
): PolicyTimelineComparisonReport {
  if (options === null || typeof options !== "object") {
    throw new ConfigurationError("comparePolicyTimelines requires an options object.");
  }
  if (options.baselinePolicy === null || typeof options.baselinePolicy !== "object") {
    throw new ConfigurationError("baselinePolicy must be an object.");
  }
  if (options.candidatePolicy === null || typeof options.candidatePolicy !== "object") {
    throw new ConfigurationError("candidatePolicy must be an object.");
  }
  if (!Array.isArray(options.strategies) || options.strategies.length === 0) {
    throw new ConfigurationError("strategies must be a non-empty array.");
  }
  if (!Array.isArray(options.steps) || options.steps.length === 0) {
    throw new ConfigurationError("steps must be a non-empty array.");
  }
  if (options.initialStrategyId !== undefined && options.initialStrategyId !== null) {
    if (!isCanonicalIdentifier(options.initialStrategyId)) {
      throw new ConfigurationError("initialStrategyId must be a non-empty trimmed string or null.");
    }
  }

  let initialState: PolicyState | undefined;
  if (options.initialStrategyId !== undefined && options.initialStrategyId !== null) {
    const matched = options.strategies.find((s) => s.id === options.initialStrategyId);
    initialState = {
      initialized: true,
      currentStrategyId: options.initialStrategyId,
      currentQualityTier: matched?.qualityTier ?? null,
      modeSince: options.steps[0]?.now ?? 0,
      budgets: {},
      pendingStrategyId: null,
      pendingStreak: 0,
      lastSampleSequence: null,
    };
  }

  const baseline = simulatePolicyTimeline({
    policy: options.baselinePolicy,
    strategies: options.strategies,
    steps: options.steps,
    ...(initialState !== undefined ? { initialState } : {}),
  });

  const candidate = simulatePolicyTimeline({
    policy: options.candidatePolicy,
    strategies: options.strategies,
    steps: options.steps,
    ...(initialState !== undefined ? { initialState } : {}),
  });

  const totalSteps = options.steps.length;
  const divergences: PolicyStepDivergence[] = [];

  for (let i = 0; i < totalSteps; i++) {
    const baselineDecision = baseline.decisions[i];
    const candidateDecision = candidate.decisions[i];
    const baselineStep = baseline.steps[i];
    const rawStep = options.steps[i];
    const timestamp = baselineStep ? baselineStep.now : (rawStep?.now ?? i * 1000);
    const label = rawStep?.label;

    if (
      baselineDecision &&
      candidateDecision &&
      baselineDecision.strategyId !== candidateDecision.strategyId
    ) {
      divergences.push({
        stepIndex: i,
        timestamp,
        ...(label !== undefined ? { label } : {}),
        baselineStrategyId: baselineDecision.strategyId,
        candidateStrategyId: candidateDecision.strategyId,
        baselineReason: baselineDecision.reasons[0] ?? {
          code: "strategy-switched",
          message: `Baseline selected "${baselineDecision.strategyId}".`,
        },
        candidateReason: candidateDecision.reasons[0] ?? {
          code: "strategy-switched",
          message: `Candidate selected "${candidateDecision.strategyId}".`,
        },
      });
    }
  }

  const divergenceCount = divergences.length;
  const agreementRatio = totalSteps > 0 ? (totalSteps - divergenceCount) / totalSteps : 1;
  const switchCountDelta = candidate.totalSwitches - baseline.totalSwitches;

  const report: PolicyTimelineComparisonReport = {
    baseline,
    candidate,
    totalSteps,
    divergenceCount,
    agreementRatio,
    divergences,
    switchCountDelta,
  };

  return deepFreeze(report);
}
