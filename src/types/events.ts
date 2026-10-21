import type { StrategyDecision } from "./decision.js";
import type { RunMetadata } from "./run.js";

export interface AdaptiveRuntimeEvents {
  decision: {
    readonly decision: StrategyDecision;
  };
  "run:start": {
    readonly operationId: string;
    readonly strategyId: string;
    readonly decision: StrategyDecision;
  };
  "run:success": {
    readonly metadata: RunMetadata;
  };
  "run:error": {
    readonly operationId: string;
    readonly strategyId?: string;
    readonly error: Error;
    readonly decision?: StrategyDecision;
    readonly durationMs?: number;
  };
  "provider:error": {
    readonly providerId: string;
    readonly error: Error;
  };
  "listener:error": {
    readonly event: keyof AdaptiveRuntimeEvents;
    readonly error: Error;
  };
  "runtime:closed": Record<string, never>;
}

export type RuntimeEventName = keyof AdaptiveRuntimeEvents;
export type RuntimeEventListener<K extends RuntimeEventName> = (
  payload: AdaptiveRuntimeEvents[K],
) => void;
