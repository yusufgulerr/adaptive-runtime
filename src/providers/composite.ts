import { ConfigurationError } from "../errors/index.js";
import type {
  AvailableSignalReading,
  ResourceSignal,
  SignalDescriptor,
  SignalProvider,
  SignalReadContext,
  SignalStartContext,
  SignalStatus,
  SignalUnit,
} from "../types/signals.js";
import { errorMessage } from "../utils/errors.js";

export interface CompositeSignalRule {
  readonly name: string;
  readonly unit: SignalUnit;
  readonly description?: string;
  readonly inputs: readonly string[];
  readonly compute: (values: Readonly<Record<string, number>>) => number;
}

export interface CompositeSignalProviderOptions {
  readonly id?: string;
  readonly providers: readonly SignalProvider[];
  readonly rules: readonly CompositeSignalRule[];
  readonly passthroughInputs?: boolean;
}

const VALID_SIGNAL_UNITS: readonly SignalUnit[] = [
  "bytes",
  "milliseconds",
  "ratio",
  "count",
  "custom",
];

const STATUS_PRIORITY: Record<Exclude<SignalStatus, "ok">, number> = {
  error: 4,
  stale: 3,
  unsupported: 2,
  unknown: 1,
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

function resolvePriority(
  current: Exclude<SignalStatus, "ok">,
  incoming: Exclude<SignalStatus, "ok">,
): Exclude<SignalStatus, "ok"> {
  return STATUS_PRIORITY[incoming] > STATUS_PRIORITY[current] ? incoming : current;
}

function getInputStatus(reading: ResourceSignal | undefined): SignalStatus {
  if (reading === undefined) {
    return "unknown";
  }
  if (reading.status === "ok") {
    if (typeof reading.value !== "number" || !Number.isFinite(reading.value)) {
      return "error";
    }
    return "ok";
  }
  if (
    reading.status === "error" ||
    reading.status === "stale" ||
    reading.status === "unsupported" ||
    reading.status === "unknown"
  ) {
    return reading.status;
  }
  return "error";
}

/**
 * Derives higher-level signals from one or more child SignalProviders by executing
 * user-defined compute rules with strict priority-based status propagation.
 */
export class CompositeSignalProvider implements SignalProvider {
  readonly id: string;
  readonly signals: readonly SignalDescriptor[];
  readonly #providers: readonly SignalProvider[];
  readonly #rules: readonly CompositeSignalRule[];
  readonly #childDescriptors: readonly SignalDescriptor[];
  readonly #passthroughInputs: boolean;
  #closed = false;

  constructor(options: CompositeSignalProviderOptions) {
    if (options === null || typeof options !== "object") {
      throw new ConfigurationError("CompositeSignalProvider requires an options object.");
    }

    this.id = validateId(options.id, "composite");

    if (options.passthroughInputs !== undefined && typeof options.passthroughInputs !== "boolean") {
      throw new ConfigurationError("CompositeSignalProvider passthroughInputs must be a boolean.");
    }
    this.#passthroughInputs = options.passthroughInputs ?? true;

    if (!Array.isArray(options.providers) || options.providers.length === 0) {
      throw new ConfigurationError(
        "CompositeSignalProvider requires a non-empty array of providers.",
      );
    }

    const childDescriptors: SignalDescriptor[] = [];
    const seenChildSignalNames = new Set<string>();

    for (const provider of options.providers) {
      if (
        provider === null ||
        typeof provider !== "object" ||
        typeof provider.id !== "string" ||
        provider.id.trim().length === 0 ||
        provider.id !== provider.id.trim() ||
        !Array.isArray(provider.signals) ||
        typeof provider.read !== "function"
      ) {
        throw new ConfigurationError(
          "CompositeSignalProvider requires valid SignalProvider instances.",
        );
      }

      for (const descriptor of provider.signals) {
        if (
          descriptor === null ||
          typeof descriptor !== "object" ||
          typeof descriptor.name !== "string" ||
          descriptor.name.trim().length === 0 ||
          descriptor.name !== descriptor.name.trim() ||
          !VALID_SIGNAL_UNITS.includes(descriptor.unit)
        ) {
          throw new ConfigurationError(
            `Provider "${provider.id}" contains an invalid signal descriptor.`,
          );
        }
        if (descriptor.description !== undefined && typeof descriptor.description !== "string") {
          throw new ConfigurationError(
            `Provider "${provider.id}" signal "${descriptor.name}" description must be a string.`,
          );
        }
        if (seenChildSignalNames.has(descriptor.name)) {
          throw new ConfigurationError(
            `Duplicate signal name across child providers: ${descriptor.name}`,
          );
        }
        seenChildSignalNames.add(descriptor.name);
        childDescriptors.push(descriptor);
      }
    }

    if (!Array.isArray(options.rules) || options.rules.length === 0) {
      throw new ConfigurationError("CompositeSignalProvider requires a non-empty array of rules.");
    }

    const seenRuleNames = new Set<string>();
    const ruleDescriptors: SignalDescriptor[] = [];

    for (const rule of options.rules) {
      if (rule === null || typeof rule !== "object") {
        throw new ConfigurationError("CompositeSignalRule must be an object.");
      }

      if (
        typeof rule.name !== "string" ||
        rule.name.trim().length === 0 ||
        rule.name !== rule.name.trim()
      ) {
        throw new ConfigurationError(
          "CompositeSignalRule name must be a non-empty trimmed string.",
        );
      }

      if (seenRuleNames.has(rule.name)) {
        throw new ConfigurationError(`Duplicate composite signal rule name "${rule.name}".`);
      }
      seenRuleNames.add(rule.name);

      if (this.#passthroughInputs && seenChildSignalNames.has(rule.name)) {
        throw new ConfigurationError(
          `CompositeSignalRule "${rule.name}" conflicts with a child provider signal name.`,
        );
      }

      if (!VALID_SIGNAL_UNITS.includes(rule.unit)) {
        throw new ConfigurationError(
          `CompositeSignalRule "${rule.name}" has invalid unit: ${String(rule.unit)}.`,
        );
      }

      if (rule.description !== undefined && typeof rule.description !== "string") {
        throw new ConfigurationError(
          `CompositeSignalRule "${rule.name}" description must be a string.`,
        );
      }

      if (!Array.isArray(rule.inputs) || rule.inputs.length === 0) {
        throw new ConfigurationError(
          `CompositeSignalRule "${rule.name}" inputs must be a non-empty array.`,
        );
      }

      for (const input of rule.inputs) {
        if (typeof input !== "string" || input.trim().length === 0 || input !== input.trim()) {
          throw new ConfigurationError(
            `CompositeSignalRule "${rule.name}" input name must be a non-empty trimmed string.`,
          );
        }
        if (!seenChildSignalNames.has(input)) {
          throw new ConfigurationError(
            `CompositeSignalRule "${rule.name}" references undeclared input "${input}".`,
          );
        }
      }

      if (typeof rule.compute !== "function") {
        throw new ConfigurationError(
          `CompositeSignalRule "${rule.name}" compute must be a function.`,
        );
      }

      const descriptor: SignalDescriptor =
        rule.description !== undefined
          ? {
              name: rule.name,
              unit: rule.unit,
              description: rule.description,
            }
          : {
              name: rule.name,
              unit: rule.unit,
            };

      ruleDescriptors.push(descriptor);
    }

    this.#providers = [...options.providers];
    this.#rules = [...options.rules];
    this.#childDescriptors = [...childDescriptors];

    this.signals = Object.freeze(
      this.#passthroughInputs ? [...childDescriptors, ...ruleDescriptors] : [...ruleDescriptors],
    );
  }

  async start(context?: SignalStartContext): Promise<void>;
  async start(context?: unknown): Promise<void>;
  async start(context?: unknown): Promise<void> {
    await Promise.all(
      this.#providers.map(async (provider) => {
        if (typeof provider.start === "function") {
          await (provider.start as (ctx?: unknown) => void | Promise<void>)(context);
        }
      }),
    );
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled(
      this.#providers.map((p) => (typeof p.close === "function" ? p.close() : Promise.resolve())),
    );
  }

  async read(context: SignalReadContext): Promise<readonly ResourceSignal[]> {
    if (context === null || typeof context !== "object" || typeof context.now !== "number") {
      throw new ConfigurationError("SignalReadContext with numeric now is required.");
    }

    const observedAt = context.now;

    if (this.#closed) {
      return this.signals.map((descriptor) => ({
        name: descriptor.name,
        unit: descriptor.unit,
        status: "unsupported" as const,
        observedAt,
        error: "Provider is closed.",
      }));
    }

    const childResults = await Promise.all(
      this.#providers.map(async (provider) => {
        try {
          const readings = await provider.read(context);
          if (!Array.isArray(readings)) {
            return provider.signals.map((descriptor) => ({
              name: descriptor.name,
              unit: descriptor.unit,
              status: "error" as const,
              observedAt,
              error: `Provider "${provider.id}" returned a non-array reading.`,
            }));
          }
          return readings;
        } catch (error) {
          return provider.signals.map((descriptor) => ({
            name: descriptor.name,
            unit: descriptor.unit,
            status: "error" as const,
            observedAt,
            error: `Provider "${provider.id}" read failed: ${errorMessage(error)}`,
          }));
        }
      }),
    );

    const readingsByName = new Map<string, ResourceSignal>();

    for (const reading of childResults.flat()) {
      if (reading !== null && typeof reading === "object" && typeof reading.name === "string") {
        readingsByName.set(reading.name, reading);
      }
    }

    const childReadings: ResourceSignal[] = [];
    for (const descriptor of this.#childDescriptors) {
      const reading = readingsByName.get(descriptor.name);
      if (reading !== undefined) {
        childReadings.push(reading);
      } else {
        childReadings.push({
          name: descriptor.name,
          unit: descriptor.unit,
          status: "unknown",
          observedAt,
          error: `Provider did not return a reading for signal "${descriptor.name}".`,
        });
      }
    }

    const compositeReadings: ResourceSignal[] = [];

    for (const rule of this.#rules) {
      let dominantStatus: Exclude<SignalStatus, "ok"> | null = null;
      const failedInputs: string[] = [];

      for (const input of rule.inputs) {
        const reading = readingsByName.get(input);
        const status = getInputStatus(reading);
        if (status !== "ok") {
          failedInputs.push(`${input} (${status})`);
          dominantStatus =
            dominantStatus === null ? status : resolvePriority(dominantStatus, status);
        }
      }

      if (dominantStatus !== null) {
        compositeReadings.push({
          name: rule.name,
          unit: rule.unit,
          status: dominantStatus,
          observedAt,
          error: `Composite signal "${rule.name}" input signals unavailable: ${failedInputs.join(", ")} (dominant: "${dominantStatus}").`,
          details: { failedInputs, dominantStatus },
        });
        continue;
      }

      const values: Record<string, number> = Object.create(null);
      for (const input of rule.inputs) {
        const reading = readingsByName.get(input) as AvailableSignalReading;
        values[input] = reading.value;
      }
      Object.freeze(values);

      let computedValue: number;
      try {
        computedValue = rule.compute(values);
      } catch (error) {
        compositeReadings.push({
          name: rule.name,
          unit: rule.unit,
          status: "error",
          observedAt,
          error: `Composite signal "${rule.name}" compute threw an error: ${errorMessage(error)}`,
        });
        continue;
      }

      if (typeof computedValue !== "number" || !Number.isFinite(computedValue)) {
        compositeReadings.push({
          name: rule.name,
          unit: rule.unit,
          status: "error",
          observedAt,
          error: `Composite signal "${rule.name}" compute returned non-finite value: ${String(computedValue)}`,
        });
        continue;
      }

      compositeReadings.push({
        name: rule.name,
        unit: rule.unit,
        status: "ok",
        value: computedValue,
        observedAt,
      });
    }

    return this.#passthroughInputs ? [...childReadings, ...compositeReadings] : compositeReadings;
  }
}
