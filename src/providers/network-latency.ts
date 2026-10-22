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

export interface NetworkLatencyProviderOptions {
  readonly id?: string;
  readonly signalName?: string;
  /**
   * User-supplied measurement. Return latency in milliseconds. The runtime never
   * creates network traffic on its own; this probe is the only source of I/O.
   */
  readonly probe: (context: NetworkProbeContext) => number | Promise<number>;
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
  #closed = false;

  constructor(options: NetworkLatencyProviderOptions) {
    if (options === null || typeof options !== "object") {
      throw new ConfigurationError("NetworkLatencyProvider requires an options object.");
    }
    if (typeof options.probe !== "function") {
      throw new ConfigurationError("NetworkLatencyProvider requires a probe function.");
    }
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
