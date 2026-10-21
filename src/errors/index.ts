import type { StrategyDecision } from "../types/decision.js";

export class AdaptiveRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class ConfigurationError extends AdaptiveRuntimeError {
  constructor(message: string, options?: ErrorOptions) {
    super("CONFIGURATION_ERROR", message, options);
  }
}

export class RuntimeClosedError extends AdaptiveRuntimeError {
  constructor() {
    super("RUNTIME_CLOSED", "The runtime has been closed and cannot accept new runs.");
  }
}

export class NoEligibleStrategyError extends AdaptiveRuntimeError {
  readonly operationId: string;
  readonly minQualityTier: number | undefined;

  constructor(operationId: string, minQualityTier: number | undefined) {
    const floor =
      minQualityTier === undefined ? "no quality floor" : `quality floor ${minQualityTier}`;
    super(
      "NO_ELIGIBLE_STRATEGY",
      `No applicable strategy is available for operation "${operationId}" (${floor}).`,
    );
    this.operationId = operationId;
    this.minQualityTier = minQualityTier;
  }
}

export class PinnedStrategyError extends AdaptiveRuntimeError {
  readonly operationId: string;
  readonly strategyId: string;
  readonly reason: "not-found" | "not-applicable";

  constructor(operationId: string, strategyId: string, reason: "not-found" | "not-applicable") {
    super(
      "PINNED_STRATEGY_UNAVAILABLE",
      `Pinned strategy "${strategyId}" is ${reason === "not-found" ? "not defined" : "not applicable"} for operation "${operationId}".`,
    );
    this.operationId = operationId;
    this.strategyId = strategyId;
    this.reason = reason;
  }
}

export class FallbackStrategyError extends AdaptiveRuntimeError {
  readonly operationId: string;
  readonly strategyId: string;
  readonly reason: "not-found" | "not-applicable";

  constructor(operationId: string, strategyId: string, reason: "not-found" | "not-applicable") {
    super(
      "FALLBACK_STRATEGY_UNAVAILABLE",
      `Fallback strategy "${strategyId}" is ${reason === "not-found" ? "not defined" : "not applicable"} for operation "${operationId}".`,
    );
    this.operationId = operationId;
    this.strategyId = strategyId;
    this.reason = reason;
  }
}

export class MissingSignalError extends AdaptiveRuntimeError {
  readonly operationId: string;
  readonly signals: readonly string[];

  constructor(operationId: string, signals: readonly string[]) {
    super(
      "MISSING_SIGNAL",
      `Policy requires signal ${signals.map((name) => `"${name}"`).join(", ")} for operation "${operationId}", but no valid reading is available and missingSignalBehavior is "error".`,
    );
    this.operationId = operationId;
    this.signals = signals;
  }
}

export class StrategyApplicabilityError extends AdaptiveRuntimeError {
  readonly operationId: string;
  readonly strategyId: string;

  constructor(operationId: string, strategyId: string, cause: unknown) {
    super(
      "STRATEGY_APPLICABILITY_FAILED",
      `Applicability check for strategy "${strategyId}" failed for operation "${operationId}".`,
      { cause },
    );
    this.operationId = operationId;
    this.strategyId = strategyId;
  }
}

export class StrategyExecutionError extends AdaptiveRuntimeError {
  readonly operationId: string;
  readonly strategyId: string;
  readonly decision: StrategyDecision;
  readonly durationMs: number;

  constructor(
    operationId: string,
    strategyId: string,
    decision: StrategyDecision,
    durationMs: number,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      "STRATEGY_EXECUTION_FAILED",
      `Strategy "${strategyId}" failed for operation "${operationId}": ${detail}`,
      { cause },
    );
    this.operationId = operationId;
    this.strategyId = strategyId;
    this.decision = decision;
    this.durationMs = durationMs;
  }
}

export class OperationAbortedError extends AdaptiveRuntimeError {
  readonly operationId: string;

  constructor(operationId: string, cause?: unknown) {
    super("OPERATION_ABORTED", `Operation "${operationId}" was aborted.`, { cause });
    this.name = "AbortError";
    this.operationId = operationId;
  }
}

export class OperationTimeoutError extends AdaptiveRuntimeError {
  readonly operationId: string;
  readonly timeoutMs: number;

  constructor(operationId: string, timeoutMs: number) {
    super(
      "OPERATION_TIMEOUT",
      `Operation "${operationId}" timed out after ${timeoutMs} ms. The strategy may continue running if it ignores its abort signal.`,
    );
    this.name = "TimeoutError";
    this.operationId = operationId;
    this.timeoutMs = timeoutMs;
  }
}

export class QualityCheckError extends AdaptiveRuntimeError {
  readonly operationId: string;
  readonly strategyId: string;
  readonly decision: StrategyDecision;
  readonly durationMs: number;

  constructor(
    operationId: string,
    strategyId: string,
    decision: StrategyDecision,
    durationMs: number,
    detail: string,
    cause?: unknown,
  ) {
    super(
      "QUALITY_CHECK_FAILED",
      `Quality check for strategy "${strategyId}" failed for operation "${operationId}": ${detail}`,
      { cause },
    );
    this.operationId = operationId;
    this.strategyId = strategyId;
    this.decision = decision;
    this.durationMs = durationMs;
  }
}

export class ProviderTimeoutError extends AdaptiveRuntimeError {
  readonly providerId: string;
  readonly timeoutMs: number;

  constructor(providerId: string, timeoutMs: number) {
    super(
      "PROVIDER_TIMEOUT",
      `Provider "${providerId}" did not finish reading within ${timeoutMs} ms.`,
    );
    this.providerId = providerId;
    this.timeoutMs = timeoutMs;
  }
}
