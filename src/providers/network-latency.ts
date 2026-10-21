import type { ResourceSignal, SignalProvider, SignalReadContext } from "../types/signals.js";

export const NETWORK_LATENCY = "network.latency";

export interface NetworkProbeContext {
  readonly signal: AbortSignal;
}

export interface NetworkLatencyProviderOptions {
  readonly id?: string;
  readonly signalName?: string;
  /**
   * User-supplied measurement. Return latency in milliseconds. The runtime never
   * creates network traffic on its own; this probe is the only source of I/O.
   */
  readonly probe: (context: NetworkProbeContext) => number | Promise<number>;
}

/**
 * Turns an application-provided latency probe into a resource signal. The
 * meaning of the measurement (DNS, TCP, TLS, server time, etc.) is defined by
 * the probe, not by this library.
 */
export class NetworkLatencyProvider implements SignalProvider {
  readonly id: string;
  readonly signals;
  readonly #signalName: string;
  readonly #probe: (context: NetworkProbeContext) => number | Promise<number>;

  constructor(options: NetworkLatencyProviderOptions) {
    if (typeof options.probe !== "function") {
      throw new TypeError("NetworkLatencyProvider requires a probe function.");
    }
    this.id = options.id ?? "network-latency";
    this.#signalName = options.signalName ?? NETWORK_LATENCY;
    this.#probe = options.probe;
    this.signals = [
      {
        name: this.#signalName,
        unit: "milliseconds" as const,
        description: "Application-defined network latency probe result in milliseconds.",
      },
    ];
  }

  async read(context: SignalReadContext): Promise<readonly ResourceSignal[]> {
    const value = await this.#probe({ signal: context.signal });
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new TypeError(
        "NetworkLatencyProvider probe must resolve to a finite, non-negative number.",
      );
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
