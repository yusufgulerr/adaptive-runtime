import { ConfigurationError } from "../../errors/index.js";
import type {
  ResourceSignal,
  SignalDescriptor,
  SignalProvider,
  SignalReadContext,
} from "../../types/signals.js";

export const WEB_FRAME_DURATION_P95_MS = "web.frame.durationP95Ms";
export const WEB_FRAME_DROPPED_RATIO = "web.frame.droppedRatio";

export interface FrameTimingProviderOptions {
  readonly id?: string;
  readonly targetFrameBudgetMs?: number;
  readonly targetFrameDurationMs?: number;
  readonly droppedFrameThresholdMs?: number;
  readonly windowSize?: number;
  readonly minSamples?: number;
}

export interface FrameTimingStats {
  readonly sampleCount: number;
  readonly droppedFrames: number;
  readonly maxFrameDurationMs: number | null;
  readonly running: boolean;
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

/**
 * Tracks recent animation frame durations in a sliding window, reporting P95 duration
 * and the ratio of dropped frames exceeding a target frame budget.
 */
export class FrameTimingProvider implements SignalProvider {
  readonly id: string;
  readonly signals: readonly SignalDescriptor[];
  readonly #targetFrameBudgetMs: number;
  readonly #droppedFrameThresholdMs: number;
  readonly #windowSize: number;
  readonly #minSamples: number;
  #samples: number[] = [];
  #closed = false;

  constructor(options: FrameTimingProviderOptions = {}) {
    this.id = validateId(options.id, "web-frame-timing");

    if (
      options.targetFrameBudgetMs !== undefined &&
      (typeof options.targetFrameBudgetMs !== "number" ||
        !Number.isFinite(options.targetFrameBudgetMs) ||
        options.targetFrameBudgetMs <= 0)
    ) {
      throw new ConfigurationError("targetFrameBudgetMs must be a positive finite number.");
    }
    if (
      options.targetFrameDurationMs !== undefined &&
      (typeof options.targetFrameDurationMs !== "number" ||
        !Number.isFinite(options.targetFrameDurationMs) ||
        options.targetFrameDurationMs <= 0)
    ) {
      throw new ConfigurationError("targetFrameDurationMs must be a positive finite number.");
    }
    if (
      options.targetFrameBudgetMs !== undefined &&
      options.targetFrameDurationMs !== undefined &&
      options.targetFrameBudgetMs !== options.targetFrameDurationMs
    ) {
      throw new ConfigurationError(
        "targetFrameBudgetMs and targetFrameDurationMs must match when both are provided.",
      );
    }

    const targetFrameBudgetMs =
      options.targetFrameDurationMs ?? options.targetFrameBudgetMs ?? 16.67;
    this.#targetFrameBudgetMs = targetFrameBudgetMs;

    const droppedFrameThresholdMs = options.droppedFrameThresholdMs ?? 50;
    if (
      typeof droppedFrameThresholdMs !== "number" ||
      !Number.isFinite(droppedFrameThresholdMs) ||
      droppedFrameThresholdMs <= this.#targetFrameBudgetMs
    ) {
      throw new ConfigurationError(
        `droppedFrameThresholdMs must be a finite number greater than targetFrameDurationMs (${this.#targetFrameBudgetMs}).`,
      );
    }
    this.#droppedFrameThresholdMs = droppedFrameThresholdMs;

    const windowSize = options.windowSize ?? 60;
    if (typeof windowSize !== "number" || !Number.isInteger(windowSize) || windowSize < 5) {
      throw new ConfigurationError("windowSize must be an integer >= 5.");
    }
    this.#windowSize = windowSize;

    const minSamples = options.minSamples ?? 3;
    if (
      typeof minSamples !== "number" ||
      !Number.isInteger(minSamples) ||
      minSamples < 1 ||
      minSamples > this.#windowSize
    ) {
      throw new ConfigurationError(
        `minSamples must be an integer between 1 and windowSize (${this.#windowSize}).`,
      );
    }
    this.#minSamples = minSamples;

    this.signals = [
      {
        name: WEB_FRAME_DURATION_P95_MS,
        unit: "milliseconds",
        description: "P95 frame duration over recent animation frames.",
      },
      {
        name: WEB_FRAME_DROPPED_RATIO,
        unit: "ratio",
        description: "Ratio of sampled frames exceeding target frame budget.",
      },
    ];
  }

  recordFrameDuration(durationMs: number): void {
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
      throw new ConfigurationError("durationMs must be a non-negative finite number.");
    }
    if (this.#closed) {
      throw new ConfigurationError("FrameTimingProvider is closed.");
    }
    this.#samples.push(durationMs);
    if (this.#samples.length > this.#windowSize) {
      this.#samples.shift();
    }
  }

  getFrameStats(): FrameTimingStats {
    let droppedFrames = 0;
    let maxFrameDurationMs: number | null = null;
    for (const d of this.#samples) {
      if (d > this.#droppedFrameThresholdMs) {
        droppedFrames += 1;
      }
      if (maxFrameDurationMs === null || d > maxFrameDurationMs) {
        maxFrameDurationMs = d;
      }
    }
    return Object.freeze({
      sampleCount: this.#samples.length,
      droppedFrames,
      maxFrameDurationMs,
      running: !this.#closed,
    });
  }

  resetSamples(): void {
    this.#samples = [];
  }

  clearSamples(): void {
    this.#samples = [];
  }

  close(): void {
    this.#closed = true;
    this.#samples = [];
  }

  read(context: SignalReadContext): readonly ResourceSignal[] {
    const observedAt = context.now;

    if (this.#closed) {
      return this.signals.map((descriptor) => ({
        name: descriptor.name,
        unit: descriptor.unit,
        status: "unsupported",
        observedAt,
        error: "Provider is closed.",
      }));
    }

    if (this.#samples.length < this.#minSamples) {
      const error = `Insufficient frame samples: have ${this.#samples.length}, require ${this.#minSamples}.`;
      return this.signals.map((descriptor) => ({
        name: descriptor.name,
        unit: descriptor.unit,
        status: "unknown",
        observedAt,
        error,
      }));
    }

    const sorted = [...this.#samples].sort((a, b) => a - b);
    const p95Index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
    const p95Duration = sorted[p95Index] as number;

    let droppedCount = 0;
    for (const d of this.#samples) {
      if (d > this.#targetFrameBudgetMs) {
        droppedCount += 1;
      }
    }
    const droppedRatio = droppedCount / this.#samples.length;

    return [
      {
        name: WEB_FRAME_DURATION_P95_MS,
        unit: "milliseconds",
        status: "ok",
        value: p95Duration,
        observedAt,
        confidence: 1,
        details: {
          samples: this.#samples.length,
          windowSize: this.#windowSize,
          minSamples: this.#minSamples,
          targetFrameBudgetMs: this.#targetFrameBudgetMs,
        },
      },
      {
        name: WEB_FRAME_DROPPED_RATIO,
        unit: "ratio",
        status: "ok",
        value: droppedRatio,
        observedAt,
        confidence: 1,
        details: {
          droppedCount,
          totalCount: this.#samples.length,
          targetFrameBudgetMs: this.#targetFrameBudgetMs,
        },
      },
    ];
  }
}
