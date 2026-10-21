import { monitorEventLoopDelay } from "node:perf_hooks";
import type { ResourceSignal, SignalProvider, SignalReadContext } from "../types/signals.js";

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
  /** Injection point for tests. */
  readonly histogramFactory?: (resolutionMs: number) => HistogramLike;
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
  readonly signals;
  readonly #percentile: number;
  readonly #resolutionMs: number;
  readonly #histogramFactory: (resolutionMs: number) => HistogramLike;
  #histogram: HistogramLike | null = null;
  #started = false;
  #closed = false;

  constructor(options: EventLoopDelayProviderOptions = {}) {
    this.id = options.id ?? "event-loop-delay";
    this.#percentile = options.percentile ?? 95;
    this.#resolutionMs = options.resolutionMs ?? 20;
    if (!Number.isFinite(this.#percentile) || this.#percentile < 0 || this.#percentile > 100) {
      throw new RangeError("EventLoopDelayProvider percentile must be between 0 and 100.");
    }
    if (!Number.isFinite(this.#resolutionMs) || this.#resolutionMs <= 0) {
      throw new RangeError("EventLoopDelayProvider resolutionMs must be greater than 0.");
    }
    const percentileLabel = Number.isInteger(this.#percentile)
      ? String(this.#percentile)
      : String(this.#percentile).replace(".", "_");
    const signalName = options.signalName ?? `eventLoop.delay.p${percentileLabel}`;
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
    if (this.#closed) {
      return [
        {
          name: this.signals[0]?.name ?? "eventLoop.delay",
          unit: "milliseconds",
          status: "unsupported",
          observedAt: context.now,
          error: "Provider is closed.",
        },
      ];
    }
    this.start();
    const histogram = this.#histogram;
    if (histogram === null || histogram.count === 0) {
      return [
        {
          name: this.signals[0]?.name ?? "eventLoop.delay",
          unit: "milliseconds",
          status: "unknown",
          observedAt: context.now,
          error: "No event-loop delay samples have been collected yet.",
        },
      ];
    }

    const nanoseconds = histogram.percentile(this.#percentile);
    const samples = histogram.count;
    histogram.reset();
    return [
      {
        name: this.signals[0]?.name ?? "eventLoop.delay",
        unit: "milliseconds",
        status: "ok",
        value: nanoseconds / 1_000_000,
        observedAt: context.now,
        confidence: 1,
        details: {
          percentile: this.#percentile,
          resolutionMs: this.#resolutionMs,
          samples,
        },
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
