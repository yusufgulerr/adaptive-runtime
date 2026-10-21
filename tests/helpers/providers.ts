import type {
  AvailableSignalReading,
  ResourceSignal,
  SignalDescriptor,
  SignalProvider,
  SignalReadContext,
  SignalUnit,
} from "../../src/types/signals.js";

export class FunctionSignalProvider implements SignalProvider {
  readonly id: string;
  readonly signals: readonly SignalDescriptor[];
  readonly #read: (
    context: SignalReadContext,
  ) => readonly ResourceSignal[] | Promise<readonly ResourceSignal[]>;

  constructor(options: {
    readonly id?: string;
    readonly signalName?: string;
    readonly unit?: SignalUnit;
    readonly read: (
      context: SignalReadContext,
    ) => readonly ResourceSignal[] | Promise<readonly ResourceSignal[]>;
  }) {
    this.id = options.id ?? "test-signals";
    const name = options.signalName ?? "test.value";
    const unit = options.unit ?? "bytes";
    this.signals = [{ name, unit }];
    this.#read = options.read;
  }

  read(context: SignalReadContext): readonly ResourceSignal[] | Promise<readonly ResourceSignal[]> {
    return this.#read(context);
  }
}

export interface SequenceSignalProviderOptions {
  readonly id?: string;
  readonly signalName?: string;
  readonly unit?: SignalUnit;
  /** A null value produces an explicit "unknown" reading. */
  readonly values: readonly (number | null)[];
}

export class SequenceSignalProvider implements SignalProvider {
  readonly id: string;
  readonly signals: readonly SignalDescriptor[];
  readonly #values: readonly (number | null)[];
  #index = 0;

  constructor(options: SequenceSignalProviderOptions) {
    this.id = options.id ?? "sequence-signals";
    const name = options.signalName ?? "test.value";
    const unit = options.unit ?? "bytes";
    this.#values = options.values;
    this.signals = [{ name, unit }];
  }

  read(context: SignalReadContext): readonly ResourceSignal[] {
    const value = this.#values[Math.min(this.#index, this.#values.length - 1)];
    this.#index += 1;
    if (value === null || value === undefined) {
      return [
        {
          name: this.signals[0]?.name ?? "test.value",
          unit: this.signals[0]?.unit ?? "bytes",
          status: "unknown",
          observedAt: context.now,
          error: "Scripted value is unavailable.",
        },
      ];
    }
    return [
      {
        name: this.signals[0]?.name ?? "test.value",
        unit: this.signals[0]?.unit ?? "bytes",
        status: "ok",
        value,
        observedAt: context.now,
        confidence: 1,
      },
    ];
  }
}

export function okSignal(
  name: string,
  value: number,
  observedAt: number,
  unit: SignalUnit = "bytes",
): ResourceSignal {
  return {
    name,
    unit,
    status: "ok",
    value,
    observedAt,
    confidence: 1,
  };
}

export function unavailableSignal(
  name: string,
  observedAt: number,
  status: "unknown" | "unsupported" | "stale" | "error" = "unknown",
  unit: SignalUnit = "bytes",
): ResourceSignal {
  return {
    name,
    unit,
    status,
    observedAt,
    error: `scripted ${status}`,
  };
}

export function requireOk(reading: ResourceSignal | undefined): AvailableSignalReading {
  if (reading === undefined || reading.status !== "ok") {
    throw new Error(`Expected an ok reading, received ${reading?.status ?? "undefined"}.`);
  }
  return reading;
}
