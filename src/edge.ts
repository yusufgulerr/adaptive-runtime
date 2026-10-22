/**
 * Edge entry point: the platform-neutral core plus WinterCG/serverless providers
 * and the composite signal provider (also available from the core).
 */

export * from "./core.js";
export {
  EDGE_CONCURRENCY_SATURATION,
  EDGE_EXECUTION_REMAINING_MS,
  EDGE_EXECUTION_USED_RATIO,
  ExecutionBudgetProvider,
  type ExecutionBudgetProviderOptions,
  type ExecutionBudgetSnapshot,
} from "./providers/edge/execution-budget.js";
