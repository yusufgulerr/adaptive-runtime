import { ConfigurationError } from "../errors/index.js";
import type {
  ResourceSignal,
  SignalDescriptor,
  SignalProvider,
  SignalReadContext,
} from "../types/signals.js";

export const NETWORK_LATENCY = "network.latency";

export interface NetworkProbeContext {
  readonly signal: AbortSignal;
}

export interface NetworkLatencyStats {
  readonly sampleCount: number;
  readonly lastLatencyMs: number | null;
  readonly minLatencyMs: number | null;
  readonly maxLatencyMs: number | null;
  readonly jitterMs: number | null;
  readonly p95LatencyMs: number | null;
}

export interface NetworkLatencyProviderOptions {
  readonly id?: string;
  readonly signalName?: string;
  /**
   * User-supplied measurement. Return latency in milliseconds. The runtime never
   * creates network traffic on its own; this probe is the only source of I/O.
   */
  readonly probe: (context: NetworkProbeContext) => number | Promise<number>;
  /** Sliding window size for latency samples. Safe integer between 2 and 1000. Defaults to 20. */
  readonly windowSize?: number;
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
 * Turns an application-provided latency probe into a resource signal. The
 * meaning of the measurement (DNS, TCP, TLS, server time, etc.) is defined by
 * the probe, not by this library.
 */
export class NetworkLatencyProvider implements SignalProvider {
  readonly id: string;
  readonly signals: readonly SignalDescriptor[];
  readonly #signalName: string;
  readonly #probe: (context: NetworkProbeContext) => number | Promise<number>;
  readonly #windowSize: number;
  #samples: number[] = [];
  #closed = false;

  constructor(options: NetworkLatencyProviderOptions) {
    if (options === null || typeof options !== "object") {
      throw new ConfigurationError("NetworkLatencyProvider requires an options object.");
    }
    if (typeof options.probe !== "function") {
      throw new ConfigurationError("NetworkLatencyProvider requires a probe function.");
    }
    if (
      options.windowSize !== undefined &&
      (typeof options.windowSize !== "number" ||
        !Number.isSafeInteger(options.windowSize) ||
        options.windowSize < 2 ||
        options.windowSize > 1000)
    ) {
      throw new ConfigurationError("windowSize must be a safe integer between 2 and 1000.");
    }
    this.#windowSize = options.windowSize ?? 20;
    this.id = validateId(options.id, "network-latency");
    this.#signalName = validateSignalName(options.signalName, NETWORK_LATENCY);
    this.#probe = options.probe;
    this.signals = [
      {
        name: this.#signalName,
        unit: "milliseconds" as const,
        description: "Application-defined network latency probe result in milliseconds.",
      },
    ];
  }

  getLatencyStats(): NetworkLatencyStats {
    const count = this.#samples.length;
    if (count === 0) {
      return Object.freeze({
        sampleCount: 0,
        lastLatencyMs: null,
        minLatencyMs: null,
        maxLatencyMs: null,
        jitterMs: null,
        p95LatencyMs: null,
      });
    }

    const lastLatencyMs = this.#samples[count - 1] as number;

    let minLatencyMs = this.#samples[0] as number;
    let maxLatencyMs = this.#samples[0] as number;
    for (let i = 1; i < count; i++) {
      const val = this.#samples[i] as number;
      if (val < minLatencyMs) minLatencyMs = val;
      if (val > maxLatencyMs) maxLatencyMs = val;
    }

    let jitterMs: number;
    if (count < 2) {
      jitterMs = 0;
    } else {
      let diffSum = 0;
      for (let i = 1; i < count; i++) {
        diffSum += Math.abs((this.#samples[i] as number) - (this.#samples[i - 1] as number));
      }
      jitterMs = diffSum / (count - 1);
    }

    const sorted = [...this.#samples].sort((a, b) => a - b);
    const p95Index = Math.min(count - 1, Math.max(0, Math.ceil(count * 0.95) - 1));
    const p95LatencyMs = sorted[p95Index] as number;

    return Object.freeze({
      sampleCount: count,
      lastLatencyMs,
      minLatencyMs,
      maxLatencyMs,
      jitterMs,
      p95LatencyMs,
    });
  }

  resetSamples(): void {
    this.#samples = [];
  }

  close(): void {
    this.#closed = true;
  }

  async read(context: SignalReadContext): Promise<readonly ResourceSignal[]> {
    if (this.#closed) {
      return [
        {
          name: this.#signalName,
          unit: "milliseconds",
          status: "unsupported",
          observedAt: context.now,
          error: "Provider is closed.",
        },
      ];
    }
    const value = await this.#probe({ signal: context.signal });
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new TypeError(
        "NetworkLatencyProvider probe must resolve to a finite, non-negative number.",
      );
    }
    this.#samples.push(value);
    if (this.#samples.length > this.#windowSize) {
      this.#samples.shift();
    }
    return [
      {
        name: this.#signalName,
        unit: "milliseconds",
        status: "ok",
        value,
        observedAt: context.now,
        confidence: 1,
      },
    ];
  }
}
