import {
  OperationAbortedError,
  OperationTimeoutError,
  StrategyExecutionError,
} from "../errors/index.js";
import type { Clock, ClockTimer } from "../types/clock.js";
import type { StrategyDecision } from "../types/decision.js";
import type { Strategy, StrategyRunContext } from "../types/strategy.js";

export interface ExecuteStrategyParams<TInput, TOutput> {
  readonly operationId: string;
  readonly input: TInput;
  readonly context: unknown;
  readonly strategy: Strategy<TInput, TOutput>;
  readonly decision: StrategyDecision;
  readonly timeoutMs: number | undefined;
  readonly userSignal: AbortSignal | undefined;
  readonly clock: Clock;
}

export interface ExecutionResult<TInput, TOutput> {
  readonly value: TOutput;
  readonly context: StrategyRunContext<TInput>;
}

/**
 * Executes a strategy exactly once.
 *
 * Abort and timeout reject the returned promise and abort the context signal.
 * They cannot forcibly stop synchronous code or an uncooperative promise; such
 * work may continue and cause side effects after the caller has observed failure.
 */
export async function executeStrategy<TInput, TOutput>(
  params: ExecuteStrategyParams<TInput, TOutput>,
): Promise<ExecutionResult<TInput, TOutput>> {
  const { operationId, strategy, decision, userSignal, clock } = params;
  if (userSignal?.aborted) {
    throw new OperationAbortedError(operationId, userSignal.reason);
  }

  const startedAt = clock.now();
  const controller = new AbortController();
  let aborted = false;
  let timedOut = false;
  let timer: ClockTimer | undefined;

  let abortPromise: Promise<never> | null = null;
  let rejectAbort: ((error: Error) => void) | undefined;
  const onAbort = (): void => {
    aborted = true;
    controller.abort(userSignal?.reason);
    rejectAbort?.(new OperationAbortedError(operationId, userSignal?.reason));
  };
  if (userSignal !== undefined) {
    abortPromise = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    if (userSignal.aborted) {
      onAbort();
    } else {
      userSignal.addEventListener("abort", onAbort, { once: true });
    }
  }

  let timeoutPromise: Promise<never> | null = null;
  let rejectTimeout: ((error: Error) => void) | undefined;
  if (params.timeoutMs !== undefined) {
    timeoutPromise = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    timer = clock.setTimeout(() => {
      timedOut = true;
      const timeoutError = new OperationTimeoutError(operationId, params.timeoutMs ?? 0);
      controller.abort(timeoutError);
      rejectTimeout?.(timeoutError);
    }, params.timeoutMs);
  }

  const runContext: StrategyRunContext<TInput> = {
    input: params.input,
    signal: controller.signal,
    operationId,
    strategyId: strategy.id,
    decision,
    context: params.context,
  };

  try {
    const execution = Promise.resolve().then(() => strategy.run(runContext));
    const racers: Promise<unknown>[] = [execution];
    if (abortPromise !== null) {
      racers.push(abortPromise);
    }
    if (timeoutPromise !== null) {
      racers.push(timeoutPromise);
    }
    const value = (await Promise.race(racers)) as TOutput;
    return { value, context: runContext };
  } catch (error) {
    if (timedOut) {
      throw new OperationTimeoutError(operationId, params.timeoutMs ?? 0);
    }
    if (aborted) {
      throw new OperationAbortedError(operationId, userSignal?.reason);
    }
    throw new StrategyExecutionError(
      operationId,
      strategy.id,
      decision,
      Math.max(0, clock.now() - startedAt),
      error,
    );
  } finally {
    timer?.cancel();
    userSignal?.removeEventListener("abort", onAbort);
  }
}
