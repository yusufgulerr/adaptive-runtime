import {
  ConfigurationError,
  OperationAbortedError,
  QualityCheckError,
  RuntimeClosedError,
  StrategyApplicabilityError,
} from "../errors/index.js";
import {
  createInitialPolicyState,
  evaluatePolicy,
  type PolicyState,
  type StrategyCandidate,
} from "../policy/engine.js";
import { resolvePolicy } from "../policy/resolve.js";
import { SignalCollector } from "../signals/collector.js";
import type { Clock } from "../types/clock.js";
import type { StrategyDecision } from "../types/decision.js";
import type { AdaptiveRuntimeEvents, RuntimeEventName } from "../types/events.js";
import type { ResolvedPolicy } from "../types/policy.js";
import type {
  Operation,
  QualityMetadata,
  RunMetadata,
  RunResult,
  RuntimeStats,
} from "../types/run.js";
import type { AdaptiveRuntime, CreateRuntimeOptions } from "../types/runtime.js";
import type { QualityCheckResult, Strategy, StrategyRunContext } from "../types/strategy.js";
import { errorMessage, toError } from "../utils/errors.js";
import { systemClock } from "./clock.js";
import { RuntimeEmitter } from "./emitter.js";
import { executeStrategy } from "./executor.js";
import { StatsRegistry } from "./stats.js";
import { validateOperation, validateOperationId, validateProviderTimeout } from "./validate.js";

const NEVER_ABORTED = new AbortController().signal;

function validateClock(clock: Clock): void {
  if (
    clock === null ||
    typeof clock !== "object" ||
    typeof clock.now !== "function" ||
    typeof clock.setTimeout !== "function"
  ) {
    throw new ConfigurationError("clock must implement now() and setTimeout().");
  }
}

function isQualityCheckResult(value: unknown): value is QualityCheckResult {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const result = value as QualityCheckResult;
  if (typeof result.ok !== "boolean") {
    return false;
  }
  if (result.detail !== undefined && typeof result.detail !== "string") {
    return false;
  }
  if (result.score !== undefined && !Number.isFinite(result.score)) {
    return false;
  }
  return true;
}

class AdaptiveRuntimeImpl implements AdaptiveRuntime {
  readonly #policy: ResolvedPolicy;
  readonly #clock: Clock;
  readonly #collector: SignalCollector;
  readonly #emitter = new RuntimeEmitter();
  readonly #states = new Map<string, PolicyState>();
  readonly #decisions = new Map<string, StrategyDecision>();
  readonly #pins = new Map<string, string>();
  readonly #adaptationOverrides = new Map<string, boolean>();
  readonly #stats = new StatsRegistry();
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #tracked = new Map<string, true>();
  readonly #activeRuns = new Map<string, number>();
  #closed = false;
  #closePromise: Promise<void> | null = null;

  constructor(options: CreateRuntimeOptions) {
    this.#policy = resolvePolicy(options.policy);
    this.#clock = options.clock ?? systemClock;
    validateClock(this.#clock);
    const providerTimeoutMs = validateProviderTimeout(options.providerTimeoutMs);
    if (options.providers !== undefined && !Array.isArray(options.providers)) {
      throw new ConfigurationError("providers must be an array.");
    }
    this.#collector = new SignalCollector({
      providers: options.providers ?? [],
      evaluationIntervalMs: this.#policy.evaluationIntervalMs,
      providerTimeoutMs,
      clock: this.#clock,
      onProviderError: (providerId, error) => {
        this.#emitter.emit("provider:error", { providerId, error });
      },
    });
  }

  async run<TInput, TOutput>(
    operationValue: Operation<TInput, TOutput>,
  ): Promise<RunResult<TOutput>> {
    this.#ensureOpen();
    const operation = validateOperation<TInput, TOutput>(operationValue);
    const operationId = validateOperationId(operation.operationId);
    const userSignal = operation.signal;
    if (userSignal?.aborted) {
      throw new OperationAbortedError(operationId, userSignal.reason);
    }

    const runStartedAt = this.#clock.now();
    this.#stats.begin(operationId);
    this.#beginActiveRun(operationId);
    let decision: StrategyDecision | undefined;

    try {
      const selection = await this.#select(operation, operationId);
      decision = selection.decision;
      const strategy = operation.strategies.find((item) => item.id === decision?.strategyId);
      if (strategy === undefined) {
        throw new ConfigurationError(
          `Strategy "${decision.strategyId}" was selected but is not part of the operation.`,
        );
      }
      this.#stats.strategySelected(operationId, strategy.id);
      this.#emitter.emit("run:start", {
        operationId,
        strategyId: strategy.id,
        decision,
      });

      if (userSignal?.aborted) {
        throw new OperationAbortedError(operationId, userSignal.reason);
      }

      const execution = await executeStrategy({
        operationId,
        input: operation.input,
        context: operation.context,
        strategy,
        decision,
        timeoutMs: operation.timeoutMs,
        userSignal,
        clock: this.#clock,
      });

      const quality = await this.#checkQuality(
        strategy,
        execution.value,
        execution.context,
        operationId,
        decision,
        runStartedAt,
      );
      const finishedAt = this.#clock.now();
      const metadata: RunMetadata = {
        operationId,
        strategyId: strategy.id,
        qualityTier: strategy.qualityTier,
        startedAt: runStartedAt,
        finishedAt,
        durationMs: Math.max(0, finishedAt - runStartedAt),
        attempts: 1,
        decision,
        signals: decision.signals,
        quality,
      };
      this.#stats.success(operationId, metadata.durationMs);
      this.#emitter.emit("run:success", { metadata });
      return { value: execution.value, metadata };
    } catch (error) {
      const durationMs =
        decision === undefined ? undefined : Math.max(0, this.#clock.now() - runStartedAt);
      this.#stats.failure(operationId, durationMs);
      this.#emitter.emit("run:error", {
        operationId,
        strategyId: decision?.strategyId,
        error: toError(error),
        decision,
        durationMs,
      });
      throw error;
    } finally {
      this.#endActiveRun(operationId);
    }
  }

  pinStrategy(operationId: string, strategyId: string): void {
    this.#ensureOpen();
    const id = validateOperationId(operationId);
    this.#pins.set(id, validateOperationId(strategyId, "strategyId"));
    this.#trackOperation(id);
    this.#enforceTrackingLimit();
  }

  unpinStrategy(operationId: string): void {
    this.#ensureOpen();
    const id = validateOperationId(operationId);
    this.#pins.delete(id);
    this.#pruneTracked(id);
    this.#enforceTrackingLimit();
  }

  setAdaptationEnabled(operationId: string, enabled: boolean): void {
    this.#ensureOpen();
    if (typeof enabled !== "boolean") {
      throw new ConfigurationError("enabled must be a boolean.");
    }
    const id = validateOperationId(operationId);
    this.#adaptationOverrides.set(id, enabled);
    this.#trackOperation(id);
    this.#enforceTrackingLimit();
  }

  getDecision(operationId: string): StrategyDecision | null {
    const id = validateOperationId(operationId);
    const decision = this.#decisions.get(id) ?? null;
    if (this.#hasOperationRecord(id)) {
      this.#trackOperation(id);
    }
    return decision;
  }

  getStats(operationId: string): RuntimeStats {
    const id = validateOperationId(operationId);
    const stats = this.#stats.get(id);
    if (this.#hasOperationRecord(id)) {
      this.#trackOperation(id);
    }
    return stats;
  }

  removeOperation(operationId: string): boolean {
    this.#ensureOpen();
    const id = validateOperationId(operationId);
    if (this.#locks.has(id) || this.#activeRuns.has(id)) {
      return false;
    }
    let removed = false;
    removed = this.#states.delete(id) || removed;
    removed = this.#decisions.delete(id) || removed;
    removed = this.#pins.delete(id) || removed;
    removed = this.#adaptationOverrides.delete(id) || removed;
    removed = this.#stats.remove(id) || removed;
    this.#tracked.delete(id);
    return removed;
  }

  resetStats(operationId?: string): void {
    this.#ensureOpen();
    if (operationId === undefined) {
      this.#stats.clear();
      this.#pruneAllTracked();
      return;
    }
    const id = validateOperationId(operationId);
    this.#stats.reset(id);
    this.#pruneTracked(id);
  }

  on<K extends RuntimeEventName>(
    event: K,
    listener: (payload: AdaptiveRuntimeEvents[K]) => void,
  ): () => void {
    if (typeof listener !== "function") {
      throw new ConfigurationError("listener must be a function.");
    }
    return this.#emitter.on(event, listener);
  }

  async close(): Promise<void> {
    if (this.#closePromise !== null) {
      return this.#closePromise;
    }
    this.#closed = true;
    this.#closePromise = (async () => {
      await this.#collector.close();
      this.#emitter.emit("runtime:closed", {});
    })();
    return this.#closePromise;
  }

  #ensureOpen(): void {
    if (this.#closed) {
      throw new RuntimeClosedError();
    }
  }

  async #select<TInput, TOutput>(
    operation: Operation<TInput, TOutput>,
    operationId: string,
  ): Promise<{ decision: StrategyDecision }> {
    return this.#serialize(operationId, async () => {
      this.#ensureOpen();
      const signal = operation.signal ?? NEVER_ABORTED;
      if (signal.aborted) {
        throw new OperationAbortedError(operationId, signal.reason);
      }

      const snapshot = await this.#collector
        .collect(this.#clock.now(), signal)
        .catch((error: unknown) => {
          if (signal.aborted) {
            throw new OperationAbortedError(operationId, signal.reason);
          }
          throw error;
        });
      this.#ensureOpen();
      if (signal.aborted) {
        throw new OperationAbortedError(operationId, signal.reason);
      }

      const candidates: StrategyCandidate[] = operation.strategies.map((strategy) => ({
        id: strategy.id,
        qualityTier: strategy.qualityTier,
        costTier: strategy.costTier,
        applicable: this.#isApplicable(strategy, operation, operationId),
      }));

      const now = this.#clock.now();
      const state = this.#states.get(operationId) ?? createInitialPolicyState();
      const adaptationOverride = this.#adaptationOverrides.get(operationId);
      const evaluation = evaluatePolicy(
        state,
        {
          operationId,
          now,
          signals: snapshot.readings,
          strategies: candidates,
          pinnedStrategyId: this.#pins.get(operationId) ?? null,
          adaptationEnabled: adaptationOverride ?? this.#policy.adaptationEnabled,
          sampleSequence: snapshot.sequence,
          signalsCached: snapshot.cached,
        },
        this.#policy,
      );
      this.#states.set(operationId, evaluation.state);
      this.#decisions.set(operationId, evaluation.decision);
      this.#trackOperation(operationId);
      this.#emitter.emit("decision", { decision: evaluation.decision });
      return { decision: evaluation.decision };
    });
  }

  #isApplicable<TInput, TOutput>(
    strategy: Strategy<TInput, TOutput>,
    operation: Operation<TInput, TOutput>,
    operationId: string,
  ): boolean {
    if (strategy.isApplicable === undefined) {
      return true;
    }
    try {
      const result = strategy.isApplicable({
        input: operation.input,
        operationId,
        context: operation.context,
      });
      if (typeof result !== "boolean") {
        throw new TypeError("isApplicable() must return a boolean.");
      }
      return result;
    } catch (error) {
      throw new StrategyApplicabilityError(operationId, strategy.id, error);
    }
  }

  async #checkQuality<TInput, TOutput>(
    strategy: Strategy<TInput, TOutput>,
    value: TOutput,
    context: StrategyRunContext<TInput>,
    operationId: string,
    decision: StrategyDecision,
    runStartedAt: number,
  ): Promise<QualityMetadata> {
    if (strategy.checkQuality === undefined) {
      return { status: "not-configured" };
    }

    let result: unknown;
    try {
      result = await strategy.checkQuality(value, context);
    } catch (error) {
      const detail = `Quality check threw: ${errorMessage(error)}`;
      if (this.#policy.qualityCheck === "error") {
        throw new QualityCheckError(
          operationId,
          strategy.id,
          decision,
          Math.max(0, this.#clock.now() - runStartedAt),
          detail,
          error,
        );
      }
      return { status: "error", detail };
    }

    if (!isQualityCheckResult(result)) {
      const detail = "Quality check returned an invalid result.";
      if (this.#policy.qualityCheck === "error") {
        throw new QualityCheckError(
          operationId,
          strategy.id,
          decision,
          Math.max(0, this.#clock.now() - runStartedAt),
          detail,
        );
      }
      return { status: "error", detail };
    }

    if (!result.ok) {
      const detail = result.detail ?? "Quality check returned ok: false.";
      if (this.#policy.qualityCheck === "error") {
        throw new QualityCheckError(
          operationId,
          strategy.id,
          decision,
          Math.max(0, this.#clock.now() - runStartedAt),
          detail,
        );
      }
      return {
        status: "failed",
        detail,
        ...(result.score === undefined ? {} : { score: result.score }),
      };
    }

    return {
      status: "passed",
      ...(result.detail === undefined ? {} : { detail: result.detail }),
      ...(result.score === undefined ? {} : { score: result.score }),
    };
  }

  #serialize<T>(operationId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(operationId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.#locks.set(operationId, next);
    return next.finally(() => {
      if (this.#locks.get(operationId) === next) {
        this.#locks.delete(operationId);
      }
    });
  }

  #hasOperationRecord(operationId: string): boolean {
    return (
      this.#states.has(operationId) ||
      this.#decisions.has(operationId) ||
      this.#pins.has(operationId) ||
      this.#adaptationOverrides.has(operationId) ||
      this.#stats.has(operationId)
    );
  }

  /** Refreshes LRU order by reinserting the id at the newest position. */
  #trackOperation(operationId: string): void {
    this.#tracked.delete(operationId);
    if (this.#hasOperationRecord(operationId)) {
      this.#tracked.set(operationId, true);
    }
  }

  #pruneTracked(operationId: string): void {
    if (!this.#hasOperationRecord(operationId)) {
      this.#tracked.delete(operationId);
    }
  }

  #pruneAllTracked(): void {
    for (const operationId of [...this.#tracked.keys()]) {
      this.#pruneTracked(operationId);
    }
  }

  #beginActiveRun(operationId: string): void {
    this.#activeRuns.set(operationId, (this.#activeRuns.get(operationId) ?? 0) + 1);
    this.#trackOperation(operationId);
    this.#enforceTrackingLimit();
  }

  #endActiveRun(operationId: string): void {
    const active = this.#activeRuns.get(operationId) ?? 1;
    if (active <= 1) {
      this.#activeRuns.delete(operationId);
    } else {
      this.#activeRuns.set(operationId, active - 1);
    }
    this.#trackOperation(operationId);
    this.#enforceTrackingLimit();
  }

  /**
   * Evicts least-recently-used operations when the configured bound is
   * exceeded. Active selections, in-flight runs, and explicit pins are never
   * evicted; the bound can therefore be exceeded when every tracked operation
   * is pinned or active.
   */
  #enforceTrackingLimit(): void {
    const limit = this.#policy.maxTrackedOperations;
    if (limit === null || this.#tracked.size <= limit) {
      return;
    }
    for (const operationId of [...this.#tracked.keys()]) {
      if (this.#tracked.size <= limit) {
        break;
      }
      if (
        this.#locks.has(operationId) ||
        this.#activeRuns.has(operationId) ||
        this.#pins.has(operationId)
      ) {
        continue;
      }
      this.#states.delete(operationId);
      this.#decisions.delete(operationId);
      this.#adaptationOverrides.delete(operationId);
      this.#stats.remove(operationId);
      this.#tracked.delete(operationId);
    }
  }
}

export function createAdaptiveRuntime(options: CreateRuntimeOptions = {}): AdaptiveRuntime {
  if (options === null || typeof options !== "object") {
    throw new ConfigurationError("createAdaptiveRuntime options must be an object.");
  }
  return new AdaptiveRuntimeImpl(options);
}
