/**
 * A resource signal is a measurement supplied by a provider.
 *
 * Unavailable measurements are represented explicitly. They are never coerced
 * to zero: a missing memory reading is not the same thing as zero memory use.
 */
export type SignalUnit = "bytes" | "milliseconds" | "ratio" | "count" | "custom";

export type SignalStatus = "ok" | "unknown" | "unsupported" | "stale" | "error";

export interface SignalDescriptor {
  /** Stable signal name referenced by policy budget rules. */
  readonly name: string;
  readonly unit: SignalUnit;
  readonly description?: string;
}

export interface SignalReadingBase {
  readonly name: string;
  readonly unit: SignalUnit;
  /** Epoch milliseconds at which the measurement was taken. */
  readonly observedAt: number;
  /** Optional diagnostic data. Do not place secrets in this object. */
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface AvailableSignalReading extends SignalReadingBase {
  readonly status: "ok";
  readonly value: number;
  /** Optional confidence in the range 0..1. Informational; policy does not act on it. */
  readonly confidence?: number;
}

export interface UnavailableSignalReading extends SignalReadingBase {
  readonly status: Exclude<SignalStatus, "ok">;
  /** Short, non-secret explanation of why the reading is unavailable. */
  readonly error?: string;
}

export type ResourceSignal = AvailableSignalReading | UnavailableSignalReading;
export type SignalReading = ResourceSignal;

export interface SignalReadContext {
  /** Clock value supplied by the runtime. Providers should use it for observedAt. */
  readonly now: number;
  /** Aborted on provider timeout, or when every caller waiting on the shared read has aborted. */
  readonly signal: AbortSignal;
}

/**
 * Providers isolate measurement from policy. The runtime owns provider
 * lifecycle: start() is called lazily before the first read, close() on shutdown.
 */
export interface SignalProvider {
  /** Stable identifier, unique within one runtime. */
  readonly id: string;
  /** Declares every signal this provider may return. */
  readonly signals: readonly SignalDescriptor[];
  start?(): void;
  read(context: SignalReadContext): Promise<readonly ResourceSignal[]> | readonly ResourceSignal[];
  close?(): void | Promise<void>;
}
