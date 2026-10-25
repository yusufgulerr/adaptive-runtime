/**
 * Platform-neutral core entry point.
 *
 * Everything exported here runs in Node.js, browsers, Cloudflare Workers,
 * Vercel Edge, Deno, and Bun. It contains no Node.js built-in imports and no references
 * to the Node.js `process` object.
 */

export {
  AdaptiveRuntimeError,
  ConfigurationError,
  FallbackStrategyError,
  MissingSignalError,
  NoEligibleStrategyError,
  OperationAbortedError,
  OperationTimeoutError,
  PinnedStrategyError,
  ProviderTimeoutError,
  QualityCheckError,
  RuntimeClosedError,
  StrategyApplicabilityError,
  StrategyExecutionError,
} from "./errors/index.js";
export { definePolicy } from "./policy/define-policy.js";
export {
  type CostBudgetSelectorOptions,
  composeSelectors,
  createCostBudgetSelector,
  createErrorRateGuardSelector,
  createLatencyBudgetSelector,
  createSafeSelector,
  type ErrorRateGuardSelectorOptions,
  formatDecisionSummary,
  InvalidConfigurationError,
  type LatencyBudgetSelectorOptions,
  type SafeSelectorOptions,
} from "./policy/selectors.js";
export {
  CompositeSignalProvider,
  type CompositeSignalProviderOptions,
  type CompositeSignalRule,
} from "./providers/composite.js";
export {
  NETWORK_LATENCY,
  NetworkLatencyProvider,
  type NetworkLatencyProviderOptions,
  type NetworkProbeContext,
} from "./providers/network-latency.js";
export { createAdaptiveRuntime } from "./runtime/runtime.js";
export type { Clock, ClockTimer } from "./types/clock.js";
export type {
  BudgetView,
  DecisionKind,
  DecisionReason,
  DecisionReasonCode,
  SignalView,
  StrategyDecision,
} from "./types/decision.js";
export type {
  AdaptiveRuntimeEvents,
  RuntimeEventListener,
  RuntimeEventName,
} from "./types/events.js";
export type {
  BudgetRule,
  CustomPolicySelection,
  CustomPolicySelector,
  CustomPolicySelectorContext,
  CustomSelectorCandidate,
  CustomSelectorContext,
  MissingSignalBehavior,
  Policy,
  ResolvedBudgetRule,
  ResolvedPolicy,
} from "./types/policy.js";
export type {
  Operation,
  QualityMetadata,
  RunMetadata,
  RunResult,
  RuntimeStats,
  StrategyStats,
} from "./types/run.js";
export type { AdaptiveRuntime, CreateRuntimeOptions, EvaluateOptions } from "./types/runtime.js";
export type {
  AvailableSignalReading,
  ResourceSignal,
  SignalDescriptor,
  SignalProvider,
  SignalReadContext,
  SignalReadingBase,
  SignalStatus,
  SignalUnit,
  UnavailableSignalReading,
} from "./types/signals.js";
export type {
  OperationRuntimeState,
  OperationStateSnapshot,
  RuntimeStateSnapshot,
} from "./types/state.js";
export type {
  QualityCheckResult,
  Strategy,
  StrategyApplicabilityContext,
  StrategyRunContext,
} from "./types/strategy.js";
