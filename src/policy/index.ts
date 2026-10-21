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
  MissingSignalBehavior,
  Policy,
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
