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
import { errorMessage, toError } from "../utils/errors.js";

export type CompositeCombinerMode = "median" | "spread" | "min" | "max" | "mean" | "sum" | "p95";

export const VALID_COMPOSITE_COMBINER_MODES: readonly CompositeCombinerMode[] = [
  "median",
  "spread",
  "min",
  "max",
  "mean",
  "sum",
  "p95",
];

export interface SourceUnavailableInfo {
  readonly ruleSignalName: string;
  readonly sourceSignalName: string;
  readonly status: string;
  readonly reason?: string;
}

export type OnSourceUnavailableListener = (info: SourceUnavailableInfo) => void;

export interface CompositeSignalRule {
  readonly name: string;
  readonly unit: SignalUnit;
  readonly description?: string;
  readonly inputs?: readonly string[];
  readonly sources?: readonly string[];
  readonly compute?: (values: Readonly<Record<string, number>>) => number;
  readonly mode?: CompositeCombinerMode;
  readonly minAvailableSources?: number;
}

export interface CompositeSignalProviderOptions {
  readonly id?: string;
  readonly providers: readonly SignalProvider[];
  readonly rules?: readonly CompositeSignalRule[];
  readonly passthroughInputs?: boolean;
  readonly onSourceUnavailable?: OnSourceUnavailableListener;
  readonly name?: string;
  readonly unit?: SignalUnit;
  readonly description?: string;
  readonly sources?: readonly string[];
  readonly inputs?: readonly string[];
  readonly mode?: CompositeCombinerMode;
  readonly compute?: (values: Readonly<Record<string, number>>) => number;
  readonly minAvailableSources?: number;
}

export type CreateCompositeSignalProviderOptions = CompositeSignalProviderOptions;

interface NormalizedCompositeSignalRule {
  readonly name: string;
  readonly unit: SignalUnit;
  readonly description?: string;
  readonly inputs: readonly string[];
  readonly sources: readonly string[];
  readonly compute?: (values: Readonly<Record<string, number>>) => number;
  readonly mode?: CompositeCombinerMode;
  readonly minAvailableSources?: number;
}

interface ChildReadResult {
  readonly readings: readonly ResourceSignal[];
  readonly errors: readonly Error[];
}

const VALID_SIGNAL_UNITS: readonly SignalUnit[] = [
  "bytes",
  "milliseconds",
  "ratio",
  "count",
  "custom",
];

const STATUS_PRIORITY: Record<string, number> = {
  error: 4,
  stale: 3,
  unsupported: 2,
  unknown: 1,
  unavailable: 1,
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
  const currentPriority = STATUS_PRIORITY[current] ?? 1;
  const incomingPriority = STATUS_PRIORITY[incoming] ?? 1;
  return incomingPriority > currentPriority ? incoming : current;
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

function computeCombinerMode(mode: CompositeCombinerMode, values: readonly number[]): number {
  switch (mode) {
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
    case "sum":
      return values.reduce((acc, v) => acc + v, 0);
    case "mean":
      return values.reduce((acc, v) => acc + v, 0) / values.length;
    case "spread": {
      if (values.length <= 1) {
        return 0;
      }
      return Math.max(...values) - Math.min(...values);
    }
    case "median": {
      const sorted = [...values].sort((a, b) => a - b);
      const len = sorted.length;
      if (len % 2 === 1) {
        return sorted[Math.floor(len / 2)] ?? 0;
      }
      const mid2 = len / 2;
      const mid1 = mid2 - 1;
      return ((sorted[mid1] ?? 0) + (sorted[mid2] ?? 0)) / 2;
    }
    case "p95": {
      const sorted = [...values].sort((a, b) => a - b);
      const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1));
      return sorted[idx] ?? 0;
    }
    default:
      throw new ConfigurationError(`Unsupported combiner mode: ${String(mode)}`);
  }
}

/**
 * Derives higher-level signals from one or more child SignalProviders by executing
 * user-defined compute rules or multi-signal aggregation operators with strict
 * priority-based status propagation, quorum guarding, and diagnostics.
 */
export class CompositeSignalProvider implements SignalProvider {
  readonly id: string;
  readonly signals: readonly SignalDescriptor[];
  readonly #providers: readonly SignalProvider[];
  readonly #rules: readonly NormalizedCompositeSignalRule[];
  readonly #childDescriptors: readonly SignalDescriptor[];
  readonly #passthroughInputs: boolean;
  readonly #onSourceUnavailable?: OnSourceUnavailableListener;
  #providerErrors: Error[] = [];
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

    if (
      options.onSourceUnavailable !== undefined &&
      typeof options.onSourceUnavailable !== "function"
    ) {
      throw new ConfigurationError(
        "CompositeSignalProvider onSourceUnavailable must be a function.",
      );
    }
    this.#onSourceUnavailable = options.onSourceUnavailable;

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

    let rawRules = options.rules;
    if (rawRules === undefined) {
      const hasShorthand =
        options.name !== undefined ||
        options.mode !== undefined ||
        options.sources !== undefined ||
        options.inputs !== undefined ||
        options.compute !== undefined;

      if (hasShorthand) {
        if (
          typeof options.name !== "string" ||
          options.name.trim().length === 0 ||
          options.name !== options.name.trim()
        ) {
          throw new ConfigurationError(
            "CompositeSignalRule name must be a non-empty trimmed string.",
          );
        }
        if (options.unit === undefined || !VALID_SIGNAL_UNITS.includes(options.unit)) {
          throw new ConfigurationError(
            `CompositeSignalRule "${options.name}" has invalid unit: ${String(options.unit)}.`,
          );
        }
        const sources = options.sources ?? options.inputs;
        if (!Array.isArray(sources) || sources.length === 0) {
          throw new ConfigurationError(
            `CompositeSignalRule "${options.name}" inputs must be a non-empty array.`,
          );
        }
        rawRules = [
          {
            name: options.name,
            unit: options.unit,
            description: options.description,
            sources,
            inputs: sources,
            mode: options.mode,
            compute: options.compute,
            minAvailableSources: options.minAvailableSources,
          },
        ];
      }
    }

    if (!Array.isArray(rawRules) || rawRules.length === 0) {
      throw new ConfigurationError("CompositeSignalProvider requires a non-empty array of rules.");
    }

    const seenRuleNames = new Set<string>();
    const ruleDescriptors: SignalDescriptor[] = [];
    const normalizedRules: NormalizedCompositeSignalRule[] = [];

    for (const rule of rawRules) {
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

      if (
        rule.sources !== undefined &&
        (!Array.isArray(rule.sources) || rule.sources.length === 0)
      ) {
        throw new ConfigurationError(
          `CompositeSignalRule "${rule.name}" sources must be a non-empty array.`,
        );
      }

      if (rule.inputs !== undefined && (!Array.isArray(rule.inputs) || rule.inputs.length === 0)) {
        throw new ConfigurationError(
          `CompositeSignalRule "${rule.name}" inputs must be a non-empty array.`,
        );
      }

      const ruleSources = rule.sources ?? rule.inputs;
      if (!Array.isArray(ruleSources) || ruleSources.length === 0) {
        throw new ConfigurationError(
          `CompositeSignalRule "${rule.name}" inputs must be a non-empty array.`,
        );
      }

      for (const input of ruleSources) {
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

      if (rule.compute !== undefined && typeof rule.compute !== "function") {
        throw new ConfigurationError(
          `CompositeSignalRule "${rule.name}" compute must be a function.`,
        );
      }

      if (rule.mode !== undefined) {
        if (
          typeof rule.mode !== "string" ||
          !VALID_COMPOSITE_COMBINER_MODES.includes(rule.mode as CompositeCombinerMode)
        ) {
          throw new ConfigurationError(
            `CompositeSignalRule "${rule.name}" has invalid combiner mode: ${String(rule.mode)}.`,
          );
        }
      }

      if (rule.compute === undefined && rule.mode === undefined) {
        throw new ConfigurationError(
          `CompositeSignalRule "${rule.name}" compute must be a function.`,
        );
      }

      if (rule.minAvailableSources !== undefined) {
        if (
          typeof rule.minAvailableSources !== "number" ||
          !Number.isSafeInteger(rule.minAvailableSources) ||
          rule.minAvailableSources < 1 ||
          rule.minAvailableSources > ruleSources.length
        ) {
          throw new ConfigurationError(
            `CompositeSignalRule "${rule.name}" minAvailableSources must be a safe integer between 1 and ${ruleSources.length}.`,
          );
        }
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

      normalizedRules.push({
        name: rule.name,
        unit: rule.unit,
        description: rule.description,
        inputs: [...ruleSources],
        sources: [...ruleSources],
        compute: rule.compute,
        mode: rule.mode,
        minAvailableSources: rule.minAvailableSources,
      });
    }

    this.#providers = [...options.providers];
    this.#rules = normalizedRules;
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

  /**
   * Returns child failures isolated during reads in FIFO order and clears the
   * queue, so the collector reports them without failing the combined read.
   */
  drainProviderErrors(): readonly Error[] {
    const errors = this.#providerErrors;
    this.#providerErrors = [];
    return errors;
  }

  /**
   * Drains a child's isolated failures so nested composites bubble them to the
   * outer provider. A broken child drain becomes a queued failure of its own.
   */
  #drainChild(provider: SignalProvider): readonly Error[] {
    let drained: unknown;
    try {
      const drain = provider.drainProviderErrors;
      if (typeof drain !== "function") {
        return [];
      }
      drained = drain.call(provider);
    } catch (error) {
      return [
        new Error(`Provider "${provider.id}" drainProviderErrors failed: ${errorMessage(error)}`, {
          cause: error,
        }),
      ];
    }

    if (!Array.isArray(drained)) {
      return [
        new TypeError(`Provider "${provider.id}" drainProviderErrors() must return an array.`),
      ];
    }

    return (drained as readonly unknown[]).map((error) => toError(error));
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
      this.#providers.map(async (provider): Promise<ChildReadResult> => {
        const errors: Error[] = [];
        let readings: readonly ResourceSignal[];
        try {
          const value = await provider.read(context);
          if (Array.isArray(value)) {
            readings = value;
          } else {
            const message = `Provider "${provider.id}" returned a non-array reading.`;
            errors.push(new TypeError(message));
            readings = provider.signals.map((descriptor) => ({
              name: descriptor.name,
              unit: descriptor.unit,
              status: "error" as const,
              observedAt,
              error: message,
            }));
          }
        } catch (error) {
          const message = `Provider "${provider.id}" read failed: ${errorMessage(error)}`;
          errors.push(new Error(message, { cause: error }));
          readings = provider.signals.map((descriptor) => ({
            name: descriptor.name,
            unit: descriptor.unit,
            status: "error" as const,
            observedAt,
            error: message,
          }));
        }
        errors.push(...this.#drainChild(provider));
        return { readings, errors };
      }),
    );

    for (const result of childResults) {
      this.#providerErrors.push(...result.errors);
    }

    const readingsByName = new Map<string, ResourceSignal>();

    for (const result of childResults) {
      for (const reading of result.readings) {
        if (reading !== null && typeof reading === "object" && typeof reading.name === "string") {
          readingsByName.set(reading.name, reading);
        }
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
      const availableValues: number[] = [];
      const values: Record<string, number> = Object.create(null);

      for (const input of rule.inputs) {
        const reading = readingsByName.get(input);
        const status = getInputStatus(reading);

        if (status === "ok") {
          const okReading = reading as AvailableSignalReading;
          availableValues.push(okReading.value);
          values[input] = okReading.value;
        } else {
          failedInputs.push(`${input} (${status})`);
          dominantStatus =
            dominantStatus === null ? status : resolvePriority(dominantStatus, status);

          if (this.#onSourceUnavailable !== undefined) {
            let reason: string | undefined;
            if (reading === undefined) {
              reason = "missing";
            } else if ("error" in reading && typeof reading.error === "string") {
              reason = reading.error;
            } else if (
              "reason" in reading &&
              typeof (reading as Record<string, unknown>).reason === "string"
            ) {
              reason = (reading as Record<string, unknown>).reason as string;
            }
            try {
              this.#onSourceUnavailable({
                ruleSignalName: rule.name,
                sourceSignalName: input,
                status,
                reason,
              });
            } catch {
              // listener errors never crash read()
            }
          }
        }
      }

      // Quorum check: minAvailableSources
      if (
        rule.minAvailableSources !== undefined &&
        availableValues.length < rule.minAvailableSources
      ) {
        compositeReadings.push({
          name: rule.name,
          unit: rule.unit,
          status: "unavailable" as unknown as SignalStatus,
          value: null as unknown as number,
          reason: "quorum_not_met",
          observedAt,
          error: `Composite signal "${rule.name}" quorum not met: ${availableValues.length} available, required ${rule.minAvailableSources}.`,
          details: {
            reason: "quorum_not_met",
            availableSources: availableValues.length,
            minAvailableSources: rule.minAvailableSources,
            failedInputs,
            dominantStatus,
          },
        } as unknown as ResourceSignal);
        continue;
      }

      // If combiner mode is defined:
      if (rule.mode !== undefined) {
        if (availableValues.length === 0) {
          const effectiveStatus = dominantStatus ?? "unknown";
          compositeReadings.push({
            name: rule.name,
            unit: rule.unit,
            status: effectiveStatus,
            observedAt,
            error: `Composite signal "${rule.name}" input signals unavailable: ${failedInputs.join(", ")} (dominant: "${effectiveStatus}").`,
            details: { failedInputs, dominantStatus: effectiveStatus },
          });
          continue;
        }

        const computedValue = computeCombinerMode(rule.mode, availableValues);
        compositeReadings.push({
          name: rule.name,
          unit: rule.unit,
          status: "ok",
          value: computedValue,
          observedAt,
        });
        continue;
      }

      // If compute function is defined:
      if (rule.minAvailableSources === undefined && dominantStatus !== null) {
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

      Object.freeze(values);

      let computedValue: number;
      try {
        computedValue = rule.compute !== undefined ? rule.compute(values) : 0;
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

export function createCompositeSignalProvider(
  options: CompositeSignalProviderOptions,
): CompositeSignalProvider {
  return new CompositeSignalProvider(options);
}
