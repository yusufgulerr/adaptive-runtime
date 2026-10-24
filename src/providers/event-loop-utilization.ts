import { performance } from "node:perf_hooks";
import { ConfigurationError } from "../errors/index.js";
import type {
  ResourceSignal,
  SignalDescriptor,
  SignalProvider,
  SignalReadContext,
} from "../types/signals.js";
import { errorMessage } from "../utils/errors.js";

export const EVENT_LOOP_UTILIZATION = "eventLoop.utilization";

export interface EventLoopUtilizationSnapshot {
  readonly idle: number;
  readonly active: number;
  readonly utilization: number;
}

export interface EventLoopUtilizationProviderOptions {
  readonly id?: string;
  readonly signalName?: string;
  /** Injection point for tests. Defaults to performance.eventLoopUtilization(). */
  readonly eventLoopUtilization?: () => EventLoopUtilizationSnapshot;
}

const DELTA_UTILIZATION_TOLERANCE = 1e-9;

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

function snapshotValidationError(snapshot: EventLoopUtilizationSnapshot): string | null {
  if (snapshot === null || typeof snapshot !== "object") {
    return "Event-loop utilization snapshot must be an object.";
  }
  const { idle, active, utilization } = snapshot;
  if (typeof idle !== "number" || !Number.isFinite(idle) || idle < 0) {
    return "Event-loop utilization snapshot idle time must be a finite, non-negative number.";
  }
  if (typeof active !== "number" || !Number.isFinite(active) || active < 0) {
    return "Event-loop utilization snapshot active time must be a finite, non-negative number.";
  }
  if (
    typeof utilization !== "number" ||
    !Number.isFinite(utilization) ||
    utilization < 0 ||
    utilization > 1 + DELTA_UTILIZATION_TOLERANCE
  ) {
    return "Event-loop utilization snapshot utilization must be a finite number between 0 and 1.";
  }
  return null;
}

/**
 * Measures active event-loop time as a ratio of total event-loop time.
 *
 * The first valid read reports the cumulative utilization. Later reads report
 * the utilization since the previous read, which avoids a long-lived process
 * hiding recent saturation behind its lifetime average.
 */
export class EventLoopUtilizationProvider implements SignalProvider {
  readonly id: string;
  readonly signals: readonly SignalDescriptor[];
  readonly #signalName: string;
  readonly #eventLoopUtilization: () => EventLoopUtilizationSnapshot;
  #previous: EventLoopUtilizationSnapshot | null = null;
  #closed = false;

  constructor(options: EventLoopUtilizationProviderOptions = {}) {
    if (options === null || typeof options !== "object") {
      throw new ConfigurationError("EventLoopUtilizationProvider options must be an object.");
    }
    this.id = validateId(options.id, "event-loop-utilization");
    this.#signalName = validateSignalName(options.signalName, EVENT_LOOP_UTILIZATION);
    if (
      options.eventLoopUtilization !== undefined &&
      typeof options.eventLoopUtilization !== "function"
    ) {
      throw new ConfigurationError(
        "EventLoopUtilizationProvider eventLoopUtilization must be a function.",
      );
    }
    this.#eventLoopUtilization =
      options.eventLoopUtilization ?? (() => performance.eventLoopUtilization());
    this.signals = [
      {
        name: this.#signalName,
        unit: "ratio" as const,
        description: "Active event-loop time divided by total event-loop time.",
      },
    ];
  }

  close(): void {
    this.#closed = true;
  }

  read(context: SignalReadContext): readonly ResourceSignal[] {
    const observedAt = context.now;
    if (this.#closed) {
      return this.#unavailable("unsupported", observedAt, "Provider is closed.");
    }

    let snapshot: EventLoopUtilizationSnapshot;
    try {
      snapshot = this.#eventLoopUtilization();
    } catch (error) {
      return this.#unavailable(
        "error",
        observedAt,
        `Failed to read event-loop utilization: ${errorMessage(error)}`,
      );
    }

    let validationError: string | null;
    try {
      validationError = snapshotValidationError(snapshot);
    } catch (error) {
      validationError = `Failed to read event-loop utilization snapshot: ${errorMessage(error)}`;
    }
    if (validationError !== null) {
      return this.#unavailable("error", observedAt, validationError);
    }

    const previous = this.#previous;
    if (previous === null) {
      const total = snapshot.idle + snapshot.active;
      if (total <= 0) {
        return this.#unavailable(
          "unknown",
          observedAt,
          "No event-loop time has accumulated yet; a later reading is required.",
        );
      }
      this.#previous = snapshot;
      return [
        {
          name: this.#signalName,
          unit: "ratio",
          status: "ok",
          // Snapshots may round to just above 1; keep the public ratio bounded.
          value: Math.min(snapshot.utilization, 1),
          observedAt,
          confidence: 1,
          details: {
            mode: "cumulative",
            idleMs: snapshot.idle,
            activeMs: snapshot.active,
          },
        },
      ];
    }

    this.#previous = snapshot;
    const deltaIdle = snapshot.idle - previous.idle;
    const deltaActive = snapshot.active - previous.active;
    if (deltaIdle < 0 || deltaActive < 0) {
      return this.#unavailable(
        "error",
        observedAt,
        "Event-loop utilization counters moved backwards.",
      );
    }

    const deltaTotal = deltaIdle + deltaActive;
    if (deltaTotal <= 0) {
      return this.#unavailable(
        "unknown",
        observedAt,
        "No event-loop time elapsed since the previous reading.",
      );
    }

    // Both deltas are finite and non-negative and deltaTotal is positive, so the
    // quotient is already inside 0..1; no defensive range branch is reachable.
    const utilization = deltaActive / deltaTotal;

    return [
      {
        name: this.#signalName,
        unit: "ratio",
        status: "ok",
        value: utilization,
        observedAt,
        confidence: 1,
        details: {
          mode: "delta",
          idleMs: deltaIdle,
          activeMs: deltaActive,
        },
      },
    ];
  }

  #unavailable(
    status: "unknown" | "unsupported" | "error",
    observedAt: number,
    error: string,
  ): readonly ResourceSignal[] {
    return [
      {
        name: this.#signalName,
        unit: "ratio",
        status,
        observedAt,
        error,
      },
    ];
  }
}
