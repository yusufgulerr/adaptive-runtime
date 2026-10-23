import { ConfigurationError } from "../../errors/index.js";
import type {
  ResourceSignal,
  SignalDescriptor,
  SignalProvider,
  SignalReadContext,
} from "../../types/signals.js";

export const WEB_COMPUTE_PRESSURE = "web.computePressure";

export type ComputePressureState = "nominal" | "fair" | "serious" | "critical";

export interface ComputePressureRecordLike {
  readonly source: string;
  readonly state: ComputePressureState;
  readonly time: number;
}

export interface PressureObserverLike {
  observe(source: string, options?: { readonly sampleInterval?: number }): void | Promise<void>;
  unobserve(source: string): void;
  disconnect(): void;
}

export type PressureObserverFactory = new (
  callback: (records: readonly ComputePressureRecordLike[]) => void,
) => PressureObserverLike;

export interface ComputePressureProviderOptions {
  readonly id?: string;
  readonly signalName?: string;
  /** Defaults to "cpu". */
  readonly source?: string;
  /** Positive sampling interval in milliseconds. */
  readonly sampleIntervalMs?: number;
  /** Injection point. Defaults to globalThis.PressureObserver when available. */
  readonly pressureObserverFactory?: PressureObserverFactory;
}

const PRESSURE_VALUES: Readonly<Record<ComputePressureState, number>> = {
  nominal: 0.25,
  fair: 0.5,
  serious: 0.75,
  critical: 1,
};

function validateId(id: string | undefined, defaultId: string): string {
  if (id === undefined) {
    return defaultId;
  }
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new ConfigurationError("Provider id must be a non-empty string.");
  }
  if (id !== id.trim()) {
    throw new ConfigurationError("Provider id must not have leading or trailing whitespace.");
  }
  return id;
}

function validateSignalName(name: string | undefined, defaultName: string): string {
  if (name === undefined) {
    return defaultName;
  }
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new ConfigurationError("Signal name must be a non-empty string.");
  }
  if (name !== name.trim()) {
    throw new ConfigurationError("Signal name must not have leading or trailing whitespace.");
  }
  return name;
}

function validateSource(source: string | undefined, defaultSource: string): string {
  if (source === undefined) {
    return defaultSource;
  }
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new ConfigurationError("ComputePressureProvider source must be a non-empty string.");
  }
  if (source !== source.trim()) {
    throw new ConfigurationError(
      "ComputePressureProvider source must not have leading or trailing whitespace.",
    );
  }
  return source;
}

function isComputePressureState(state: unknown): state is ComputePressureState {
  return state === "nominal" || state === "fair" || state === "serious" || state === "critical";
}

function getGlobalPressureObserverFactory(): PressureObserverFactory | undefined {
  const candidate = (globalThis as { PressureObserver?: unknown }).PressureObserver;
  if (typeof candidate === "function") {
    return candidate as unknown as PressureObserverFactory;
  }
  return undefined;
}

/**
 * Reports browser compute pressure from the W3C Compute Pressure API.
 *
 * Pressure records arrive asynchronously through a PressureObserver. Until the
 * first valid record is observed, the provider reports an explicit unknown
 * reading rather than assuming nominal pressure.
 */
export class ComputePressureProvider implements SignalProvider {
  readonly id: string;
  readonly signals: readonly SignalDescriptor[];
  readonly #signalName: string;
  readonly #source: string;
  readonly #sampleIntervalMs: number | undefined;
  readonly #pressureObserverFactory: PressureObserverFactory | undefined;
  #observer: PressureObserverLike | null = null;
  #state: ComputePressureState | null = null;
  #started = false;
  #closed = false;

  constructor(options: ComputePressureProviderOptions = {}) {
    if (options === null || typeof options !== "object") {
      throw new ConfigurationError("ComputePressureProvider options must be an object.");
    }
    this.id = validateId(options.id, "compute-pressure");
    this.#signalName = validateSignalName(options.signalName, WEB_COMPUTE_PRESSURE);
    this.#source = validateSource(options.source, "cpu");
    if (
      options.sampleIntervalMs !== undefined &&
      (typeof options.sampleIntervalMs !== "number" ||
        !Number.isFinite(options.sampleIntervalMs) ||
        options.sampleIntervalMs <= 0)
    ) {
      throw new ConfigurationError(
        "ComputePressureProvider sampleIntervalMs must be a positive finite number.",
      );
    }
    if (
      options.pressureObserverFactory !== undefined &&
      typeof options.pressureObserverFactory !== "function"
    ) {
      throw new ConfigurationError(
        "ComputePressureProvider pressureObserverFactory must be a constructor.",
      );
    }
    this.#sampleIntervalMs = options.sampleIntervalMs;
    this.#pressureObserverFactory = options.pressureObserverFactory;
    this.signals = [
      {
        name: this.#signalName,
        unit: "ratio" as const,
        description: "W3C Compute Pressure state mapped to the ratio range 0.25..1.",
      },
    ];
  }

  recordPressureState(state: ComputePressureState): void {
    if (this.#closed) {
      return;
    }
    if (!isComputePressureState(state)) {
      throw new ConfigurationError(
        "ComputePressureProvider state must be one of: nominal, fair, serious, critical.",
      );
    }
    this.#state = state;
  }

  async start(): Promise<void> {
    if (this.#started || this.#closed) {
      return;
    }
    this.#started = true;
    const factory = this.#pressureObserverFactory ?? getGlobalPressureObserverFactory();
    if (factory === undefined) {
      return;
    }

    let observer: PressureObserverLike;
    try {
      observer = new factory((records) => {
        this.#consumeRecords(records);
      });
    } catch (error) {
      this.#started = false;
      throw error;
    }
    this.#observer = observer;

    try {
      const result = observer.observe(
        this.#source,
        this.#sampleIntervalMs === undefined
          ? undefined
          : { sampleInterval: this.#sampleIntervalMs },
      );
      if (result !== undefined) {
        await result;
      }
    } catch (error) {
      this.#started = false;
      this.#observer = null;
      observer.disconnect();
      throw error;
    }
  }

  read(context: SignalReadContext): readonly ResourceSignal[] {
    const observedAt = context.now;
    if (this.#closed) {
      return [
        {
          name: this.#signalName,
          unit: "ratio",
          status: "unsupported",
          observedAt,
          error: "Provider is closed.",
        },
      ];
    }
    if (this.#state === null) {
      return [
        {
          name: this.#signalName,
          unit: "ratio",
          status: "unknown",
          observedAt,
          error: "No compute pressure state has been observed yet.",
        },
      ];
    }
    return [
      {
        name: this.#signalName,
        unit: "ratio",
        status: "ok",
        value: PRESSURE_VALUES[this.#state],
        observedAt,
        confidence: 1,
        details: {
          source: this.#source,
          state: this.#state,
          scale: "w3c-compute-pressure",
        },
      },
    ];
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const observer = this.#observer;
    this.#observer = null;
    observer?.disconnect();
  }

  #consumeRecords(records: readonly ComputePressureRecordLike[]): void {
    if (!Array.isArray(records)) {
      return;
    }
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index];
      if (record !== null && typeof record === "object" && isComputePressureState(record.state)) {
        this.recordPressureState(record.state);
        return;
      }
    }
  }
}
