import { ConfigurationError } from "../errors/index.js";
import type { Operation } from "../types/run.js";
import type { Strategy } from "../types/strategy.js";

export function validateOperationId(value: unknown, label = "operationId"): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigurationError(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

/** Strategy ids are matched verbatim, so padding is rejected instead of trimmed. */
export function validateStrategyId(value: unknown, label = "strategyId"): string {
  const id = validateOperationId(value, label);
  if (id !== value) {
    throw new ConfigurationError(`${label} must not have leading or trailing whitespace.`);
  }
  return id;
}

export function validateOptionalAbortSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    value === null ||
    typeof value !== "object" ||
    !("aborted" in value) ||
    typeof (value as AbortSignal).addEventListener !== "function"
  ) {
    throw new ConfigurationError("operation.signal must be an AbortSignal.");
  }
  return value as AbortSignal;
}

export function validateTimeout(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ConfigurationError("operation.timeoutMs must be a positive finite number.");
  }
  return value;
}

export function validateProviderTimeout(value: number | undefined): number {
  if (value === undefined) {
    return 1000;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ConfigurationError("providerTimeoutMs must be a finite number >= 0.");
  }
  return value;
}

export function validateStrategies<TInput, TOutput>(
  value: unknown,
): readonly Strategy<TInput, TOutput>[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigurationError("operation.strategies must be a non-empty array.");
  }
  const seen = new Set<string>();
  for (const [index, item] of (value as readonly unknown[]).entries()) {
    if (item === null || typeof item !== "object") {
      throw new ConfigurationError(`strategies[${index}] must be an object.`);
    }
    const strategy = item as Strategy<TInput, TOutput>;
    const id = validateStrategyId(strategy.id, `strategies[${index}].id`);
    if (seen.has(id)) {
      throw new ConfigurationError(`Duplicate strategy id "${id}".`);
    }
    seen.add(id);
    if (typeof strategy.qualityTier !== "number" || !Number.isFinite(strategy.qualityTier)) {
      throw new ConfigurationError(`Strategy "${id}" qualityTier must be a finite number.`);
    }
    if (
      strategy.costTier !== undefined &&
      (typeof strategy.costTier !== "number" || !Number.isFinite(strategy.costTier))
    ) {
      throw new ConfigurationError(`Strategy "${id}" costTier must be a finite number.`);
    }
    if (typeof strategy.run !== "function") {
      throw new ConfigurationError(`Strategy "${id}" must implement run().`);
    }
    if (strategy.checkQuality !== undefined && typeof strategy.checkQuality !== "function") {
      throw new ConfigurationError(`Strategy "${id}" checkQuality must be a function.`);
    }
    if (strategy.isApplicable !== undefined && typeof strategy.isApplicable !== "function") {
      throw new ConfigurationError(`Strategy "${id}" isApplicable must be a function.`);
    }
  }
  return value as readonly Strategy<TInput, TOutput>[];
}

export function validateOperation<TInput, TOutput>(value: unknown): Operation<TInput, TOutput> {
  if (value === null || typeof value !== "object") {
    throw new ConfigurationError("operation must be an object.");
  }
  const operation = value as Operation<TInput, TOutput>;
  validateOperationId(operation.operationId);
  validateStrategies<TInput, TOutput>(operation.strategies);
  validateOptionalAbortSignal(operation.signal);
  validateTimeout(operation.timeoutMs);
  return operation;
}
