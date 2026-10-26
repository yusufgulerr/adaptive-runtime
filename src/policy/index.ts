/**
 * Platform-independent policy surface. This subpath has no Node.js imports and
 * can be used to evaluate policy state in any ESM runtime.
 */

export type {
  BudgetView,
  DecisionKind,
  DecisionReason,
  DecisionReasonCode,
  SignalView,
  StrategyDecision,
} from "../types/decision.js";
export type {
  BudgetRule,
  CustomPolicySelection,
  CustomPolicySelector,
  CustomPolicySelectorContext,
  CustomSelectorCandidate,
  CustomSelectorContext,
  MissingSignalBehavior,
  Policy,
  PolicyCandidate,
  ResolvedBudgetRule,
  ResolvedPolicy,
} from "../types/policy.js";
export { definePolicy } from "./define-policy.js";
export {
  type BudgetState,
  createInitialPolicyState,
  evaluatePolicy,
  type PolicyEvaluation,
  type PolicyEvaluationInput,
  type PolicyState,
  type StrategyCandidate,
} from "./engine.js";
export { resolvePolicy } from "./resolve.js";
export {
  computeRolloutBucket,
  createPolicyRollout,
  type PolicyCohort,
  type PolicyRollout,
  type PolicyRolloutAssignment,
  type PolicyRolloutOptions,
  type PolicyRolloutSnapshot,
} from "./rollout.js";
export {
  type CostBudgetSelectorOptions,
  composeSelectors,
  createCostBudgetSelector,
  createErrorRateGuardSelector,
  createLatencyBudgetSelector,
  createSafeSelector,
  createSignalTrendGuardSelector,
  createWeightedUtilitySelector,
  type ErrorRateGuardSelectorOptions,
  formatDecisionSummary,
  InvalidConfigurationError,
  type LatencyBudgetSelectorOptions,
  type SafeSelectorOptions,
  type SignalTrendGuardSelector,
  type SignalTrendGuardSelectorOptions,
  type WeightedUtilitySelectorOptions,
} from "./selectors.js";
