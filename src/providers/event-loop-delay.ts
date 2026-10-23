import { monitorEventLoopDelay } from "node:perf_hooks";
import { ConfigurationError } from "../errors/index.js";
import type {
  ResourceSignal,
  SignalDescriptor,
  SignalProvider,
  SignalReadContext,
} from "../types/signals.js";

export interface HistogramLike {
  readonly count: number;
  percentile(percentile: number): number;
  reset(): void;
  enable?(): void;
  disable?(): void;
}

export interface EventLoopDelayProviderOptions {
  readonly id?: string;
  readonly signalName?: string;
  /** Percentile in the range 0..100. Defaults to 95. */
  readonly percentile?: number;
  /** Sampling resolution in milliseconds. Defaults to 20. */
  readonly resolutionMs?: number;
  /** Minimum samples required before a fresh reading is reported. Defaults to 1. */
  readonly minSamples?: number;
  /** Injection point for tests. */
  readonly histogramFactory?: (resolutionMs: number) => HistogramLike;
}

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

/**
 * Samples event-loop delay with perf_hooks.monitorEventLoopDelay.
 *
 * The reported number is scheduling delay for callbacks on this event loop. It
 * is not a CPU utilization percentage and does not capture work on worker
 * threads or other processes.
 */
export class EventLoopDelayProvider implements SignalProvider {
  readonly id: string;
  readonly signals: readonly SignalDescriptor[];
  readonly #percentile: number;
  readonly #resolutionMs: number;
  readonly #minSamples: number;
  readonly #histogramFactory: (resolutionMs: number) => HistogramLike;
  #histogram: HistogramLike | null = null;
  #started = false;
  #closed = false;
  #lastValueMs: number | null = null;
  #lastSamples = 0;
  #lastReadingAt: number | null = null;

  constructor(options: EventLoopDelayProviderOptions = {}) {
    if (options === null || typeof options !== "object") {
      throw new ConfigurationError("EventLoopDelayProvider options must be an object.");
    }
    this.id = validateId(options.id, "event-loop-delay");
    if (
      options.percentile !== undefined &&
      (typeof options.percentile !== "number" ||
        !Number.isFinite(options.percentile) ||
        options.percentile < 0 ||
        options.percentile > 100)
    ) {
      throw new ConfigurationError("EventLoopDelayProvider percentile must be between 0 and 100.");
    }
    if (
      options.resolutionMs !== undefined &&
      (typeof options.resolutionMs !== "number" ||
        !Number.isFinite(options.resolutionMs) ||
        options.resolutionMs <= 0)
    ) {
      throw new ConfigurationError("EventLoopDelayProvider resolutionMs must be greater than 0.");
    }
    if (
      options.minSamples !== undefined &&
      (typeof options.minSamples !== "number" ||
        !Number.isInteger(options.minSamples) ||
        options.minSamples < 1)
    ) {
      throw new ConfigurationError("EventLoopDelayProvider minSamples must be a positive integer.");
    }
    if (options.histogramFactory !== undefined && typeof options.histogramFactory !== "function") {
      throw new ConfigurationError("EventLoopDelayProvider histogramFactory must be a function.");
    }
    this.#percentile = options.percentile ?? 95;
    this.#resolutionMs = options.resolutionMs ?? 20;
    this.#minSamples = options.minSamples ?? 1;

    const percentileLabel = Number.isInteger(this.#percentile)
      ? String(this.#percentile)
      : String(this.#percentile).replace(".", "_");
    const defaultSignalName = `eventLoop.delay.p${percentileLabel}`;
    const signalName = validateSignalName(options.signalName, defaultSignalName);
    this.#histogramFactory =
      options.histogramFactory ??
      ((resolutionMs) => monitorEventLoopDelay({ resolution: resolutionMs }));
    this.signals = [
      {
        name: signalName,
        unit: "milliseconds" as const,
        description: `Event-loop delay at the ${this.#percentile}th percentile (milliseconds).`,
      },
    ];
  }

  start(): void {
    if (this.#started || this.#closed) {
      return;
    }
    this.#histogram = this.#histogramFactory(this.#resolutionMs);
    this.#histogram.enable?.();
    this.#started = true;
  }

  read(context: SignalReadContext): readonly ResourceSignal[] {
    const name = this.signals[0]?.name ?? "eventLoop.delay";
    const observedAt = context.now;
    if (this.#closed) {
      return [
        {
          name,
          unit: "milliseconds",
          status: "unsupported",
          observedAt,
          error: "Provider is closed.",
        },
      ];
    }
    this.start();
    const histogram = this.#histogram;
    if (histogram === null) {
      return [
        {
          name,
          unit: "milliseconds",
          status: "unknown",
          observedAt,
          error: "No event-loop delay samples have been collected yet.",
        },
      ];
    }

    if (histogram.count >= this.#minSamples) {
      const nanoseconds = histogram.percentile(this.#percentile);
      if (typeof nanoseconds !== "number" || !Number.isFinite(nanoseconds) || nanoseconds < 0) {
        return [
          {
            name,
            unit: "milliseconds",
            status: "error",
            observedAt,
            error: "Event-loop delay percentile returned a non-finite or negative value.",
          },
        ];
      }
      const samples = histogram.count;
      const value = nanoseconds / 1_000_000;
      histogram.reset();
      this.#lastValueMs = value;
      this.#lastSamples = samples;
      this.#lastReadingAt = observedAt;
      return [
        {
          name,
          unit: "milliseconds",
          status: "ok",
          value,
          observedAt,
          confidence: 1,
          details: {
            percentile: this.#percentile,
            resolutionMs: this.#resolutionMs,
            samples,
            retained: false,
          },
        },
      ];
    }

    if (
      this.#lastValueMs !== null &&
      this.#lastReadingAt !== null &&
      observedAt >= this.#lastReadingAt &&
      observedAt - this.#lastReadingAt <= this.#resolutionMs * this.#minSamples
    ) {
      return [
        {
          name,
          unit: "milliseconds",
          status: "ok",
          value: this.#lastValueMs,
          observedAt,
          confidence: 0.5,
          details: {
            percentile: this.#percentile,
            resolutionMs: this.#resolutionMs,
            samples: this.#lastSamples,
            retained: true,
          },
        },
      ];
    }

    return [
      {
        name,
        unit: "milliseconds",
        status: "unknown",
        observedAt,
        error: `Insufficient event-loop delay samples: have ${histogram.count}, require ${this.#minSamples}.`,
      },
    ];
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    if (this.#histogram !== null) {
      this.#histogram.disable?.();
      this.#histogram = null;
    }
    this.#started = false;
  }
}
