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
import { resolveOperationPolicy, resolvePolicy } from "../policy/resolve.js";
import { SignalCollector } from "../signals/collector.js";
import type { Clock } from "../types/clock.js";
import type { StrategyDecision } from "../types/decision.js";
import type { AdaptiveRuntimeEvents, RuntimeEventName } from "../types/events.js";
import type { Policy, ResolvedPolicy } from "../types/policy.js";
import type {
  Operation,
  QualityMetadata,
  RunMetadata,
  RunResult,
  RuntimeStats,
} from "../types/run.js";
import type { AdaptiveRuntime, CreateRuntimeOptions, EvaluateOptions } from "../types/runtime.js";
import type { OperationRuntimeState, RuntimeStateSnapshot } from "../types/state.js";
import type { QualityCheckResult, Strategy, StrategyRunContext } from "../types/strategy.js";
import { errorMessage, toError } from "../utils/errors.js";
import { systemClock } from "./clock.js";
import { RuntimeEmitter } from "./emitter.js";
import { executeStrategy } from "./executor.js";
import { validateRuntimeStateSnapshot } from "./state.js";
import { StatsRegistry } from "./stats.js";
import {
  validateOperation,
  validateOperationId,
  validateProviderTimeout,
  validateStrategyId,
} from "./validate.js";

const NEVER_ABORTED = new AbortController().signal;

/**
 * Freezes the decision's own structures without recursively freezing opaque
 * user-provided `reason.details` values. This keeps published decisions
 * immutable while avoiding side effects on application objects.
 */
function freezeDecision(decision: StrategyDecision): StrategyDecision {
  for (const signal of decision.signals) {
    Object.freeze(signal);
  }
  for (const budget of decision.budgets) {
    Object.freeze(budget);
  }
  for (const reason of decision.reasons) {
    if (reason.details !== undefined) {
      Object.freeze(reason.details);
    }
    Object.freeze(reason);
  }
  Object.freeze(decision.signals);
  Object.freeze(decision.budgets);
  Object.freeze(decision.reasons);
  return Object.freeze(decision);
}

function freezeMetadata(metadata: RunMetadata): RunMetadata {
  Object.freeze(metadata.quality);
  Object.freeze(metadata.signals);
  Object.freeze(metadata.decision);
  return Object.freeze(metadata);
}

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

function validateMaxQualityCheckDetailLength(value: unknown): number {
  if (value === undefined) {
    return 1000;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigurationError("maxQualityCheckDetailLength must be a safe positive integer.");
  }
  return value;
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
  readonly #maxQualityCheckDetailLength: number;
  readonly #emitter = new RuntimeEmitter();
  readonly #states = new Map<string, PolicyState>();
  readonly #decisions = new Map<string, StrategyDecision>();
  readonly #pins = new Map<string, string>();
  readonly #adaptationOverrides = new Map<string, boolean>();
  readonly #operationPolicies = new Map<string, ResolvedPolicy>();
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
    this.#maxQualityCheckDetailLength = validateMaxQualityCheckDetailLength(
      options.maxQualityCheckDetailLength,
    );
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
      decision = await this.#select(operation, operationId, true);
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
      const metadata: RunMetadata = freezeMetadata({
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
      });
      this.#stats.success(operationId, strategy.id, metadata.durationMs);
      this.#emitter.emit("run:success", { metadata });
      return { value: execution.value, metadata };
    } catch (error) {
      const durationMs =
        decision === undefined ? undefined : Math.max(0, this.#clock.now() - runStartedAt);
      this.#stats.failure(operationId, decision?.strategyId, durationMs);
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

  async evaluate<TInput, TOutput>(
    operationValue: Operation<TInput, TOutput>,
    options: EvaluateOptions = {},
  ): Promise<StrategyDecision> {
    this.#ensureOpen();
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new ConfigurationError("evaluate options must be an object.");
    }
    const dryRun = options.dryRun ?? false;
    if (typeof dryRun !== "boolean") {
      throw new ConfigurationError("evaluate options.dryRun must be a boolean.");
    }
    const operation = validateOperation<TInput, TOutput>(operationValue);
    const operationId = validateOperationId(operation.operationId);
    if (operation.signal?.aborted) {
      throw new OperationAbortedError(operationId, operation.signal.reason);
    }
    return this.#select(operation, operationId, dryRun !== true);
  }

  exportState(operationId?: string): RuntimeStateSnapshot {
    this.#ensureOpen();
    let operationIds: readonly string[];
    if (operationId === undefined) {
      operationIds = [...this.#tracked.keys()];
    } else {
      const id = validateOperationId(operationId);
      operationIds = this.#hasOperationRecord(id) ? [id] : [];
    }

    const operations: Array<{ operationId: string; state: OperationRuntimeState }> = [];
    for (const id of operationIds) {
      if (!this.#hasOperationRecord(id)) {
        continue;
      }
      operations.push({
        operationId: id,
        state: {
          policyState: this.#states.get(id) ?? createInitialPolicyState(),
          decision: this.#decisions.get(id) ?? null,
          pinnedStrategyId: this.#pins.get(id) ?? null,
          adaptationEnabled: this.#adaptationOverrides.get(id) ?? null,
          stats: this.#stats.get(id),
        },
      });
    }

    return validateRuntimeStateSnapshot({
      version: 1,
      exportedAt: this.#clock.now(),
      operations,
    });
  }

  importState(snapshot: RuntimeStateSnapshot): number {
    this.#ensureOpen();
    const validated = validateRuntimeStateSnapshot(snapshot);

    // Validate the entire target set before mutating so a rejected import never
    // leaves a partially hydrated runtime.
    for (const { operationId } of validated.operations) {
      if (this.#locks.has(operationId) || this.#activeRuns.has(operationId)) {
        throw new ConfigurationError(
          `Cannot import state for operation "${operationId}" while a selection or run is in flight.`,
        );
      }
    }

    for (const { operationId, state } of validated.operations) {
      this.#states.set(operationId, state.policyState);
      if (state.decision === null) {
        this.#decisions.delete(operationId);
      } else {
        this.#decisions.set(operationId, state.decision);
      }
      if (state.pinnedStrategyId === null) {
        this.#pins.delete(operationId);
      } else {
        this.#pins.set(operationId, state.pinnedStrategyId);
      }
      if (state.adaptationEnabled === null) {
        this.#adaptationOverrides.delete(operationId);
      } else {
        this.#adaptationOverrides.set(operationId, state.adaptationEnabled);
      }
      this.#stats.restore(operationId, state.stats);
      this.#trackOperation(operationId);
    }
    this.#enforceTrackingLimit();
    return validated.operations.length;
  }

  pinStrategy(operationId: string, strategyId: string): void {
    this.#ensureOpen();
    const id = validateOperationId(operationId);
    this.#pins.set(id, validateStrategyId(strategyId));
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
    this.#enforceTrackingLimit(id);
  }

  setOperationPolicy(operationId: string, policy: Partial<Policy> | null): void {
    this.#ensureOpen();
    const id = validateOperationId(operationId);
    if (policy === null) {
      this.#operationPolicies.delete(id);
      this.#pruneTracked(id);
      this.#enforceTrackingLimit();
      return;
    }
    if (typeof policy !== "object" || Array.isArray(policy)) {
      throw new ConfigurationError("policy override must be an object.");
    }
    const resolved = resolveOperationPolicy(this.#policy, policy);
    this.#operationPolicies.set(id, resolved);
    this.#trackOperation(id);
    this.#enforceTrackingLimit(id);
  }

  getOperationPolicy(operationId: string): ResolvedPolicy | null {
    const id = validateOperationId(operationId);
    const policy = this.#operationPolicies.get(id) ?? null;
    if (this.#hasOperationRecord(id)) {
      this.#trackOperation(id);
    }
    return policy;
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

  getTrackedOperations(): readonly string[] {
    return Object.freeze([...this.#tracked.keys()]);
  }

  getAllStats(): Readonly<Record<string, RuntimeStats>> {
    const result: Record<string, RuntimeStats> = {};
    for (const id of this.#tracked.keys()) {
      result[id] = this.#stats.get(id);
    }
    return Object.freeze(result);
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
    removed = this.#operationPolicies.delete(id) || removed;
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

  #effectivePolicy(operationId: string): ResolvedPolicy {
    return this.#operationPolicies.get(operationId) ?? this.#policy;
  }

  async #select<TInput, TOutput>(
    operation: Operation<TInput, TOutput>,
    operationId: string,
    persist: boolean,
  ): Promise<StrategyDecision> {
    const signal = operation.signal ?? NEVER_ABORTED;
    return this.#serialize(operationId, signal, async () => {
      this.#ensureOpen();
      if (signal.aborted) {
        throw new OperationAbortedError(operationId, signal.reason);
      }

      // Resolve the effective policy before collection: evaluationIntervalMs is
      // a per-operation setting and must control this operation's cache window.
      const effectivePolicy = this.#effectivePolicy(operationId);
      const snapshot = await this.#collector
        .collect(this.#clock.now(), signal, effectivePolicy.evaluationIntervalMs)
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

      const stats = this.#stats.get(operationId);
      const candidates: StrategyCandidate[] = operation.strategies.map((strategy) => {
        const strategyStats = stats.strategies[strategy.id];
        return {
          id: strategy.id,
          qualityTier: strategy.qualityTier,
          costTier: strategy.costTier,
          applicable: this.#isApplicable(strategy, operation, operationId),
          estimatedLatencyMs:
            strategyStats?.ewmaDurationMs ?? strategyStats?.averageDurationMs ?? null,
          ewmaLatencyMs: strategyStats?.ewmaDurationMs ?? null,
          errorRate: strategyStats?.errorRate ?? 0,
        };
      });

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
          adaptationEnabled: adaptationOverride ?? effectivePolicy.adaptationEnabled,
          sampleSequence: snapshot.sequence,
          signalsCached: snapshot.cached,
        },
        effectivePolicy,
      );
      const decision = freezeDecision(evaluation.decision);
      if (persist) {
        this.#states.set(operationId, evaluation.state);
        this.#decisions.set(operationId, decision);
        this.#trackOperation(operationId);
        this.#emitter.emit("decision", { decision });
      }
      return decision;
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
    const effectivePolicy = this.#effectivePolicy(operationId);

    let result: unknown;
    try {
      result = await strategy.checkQuality(value, context);
    } catch (error) {
      const detail = `Quality check threw: ${errorMessage(error, this.#maxQualityCheckDetailLength)}`;
      if (effectivePolicy.qualityCheck === "error") {
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
      if (effectivePolicy.qualityCheck === "error") {
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
      const detail =
        result.detail !== undefined
          ? errorMessage(result.detail, this.#maxQualityCheckDetailLength)
          : "Quality check returned ok: false.";
      if (effectivePolicy.qualityCheck === "error") {
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
      ...(result.detail === undefined
        ? {}
        : { detail: errorMessage(result.detail, this.#maxQualityCheckDetailLength) }),
      ...(result.score === undefined ? {} : { score: result.score }),
    };
  }

  #serialize<T>(operationId: string, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    if (signal.aborted) {
      return Promise.reject(new OperationAbortedError(operationId, signal.reason));
    }

    let aborted = false;
    let onAbort: (() => void) | undefined;
    const cleanup = () => {
      if (onAbort !== undefined) {
        signal.removeEventListener("abort", onAbort);
        onAbort = undefined;
      }
    };

    let execution: Promise<unknown>;
    const previous = this.#locks.get(operationId) ?? Promise.resolve();
    execution = previous
      .catch(() => undefined)
      .then(async () => {
        if (aborted || signal.aborted) {
          return;
        }
        return task();
      })
      .finally(() => {
        if (this.#locks.get(operationId) === execution) {
          this.#locks.delete(operationId);
        }
      });

    this.#locks.set(operationId, execution);

    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) {
        aborted = true;
        reject(new OperationAbortedError(operationId, signal.reason));
        return;
      }
      onAbort = () => {
        aborted = true;
        cleanup();
        reject(new OperationAbortedError(operationId, signal.reason));
      };
      signal.addEventListener("abort", onAbort, { once: true });

      execution.then(
        (value) => {
          cleanup();
          if (aborted || signal.aborted) {
            reject(new OperationAbortedError(operationId, signal.reason));
          } else {
            resolve(value as T);
          }
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
    }).finally(() => {
      cleanup();
    });
  }

  #hasOperationRecord(operationId: string): boolean {
    return (
      this.#states.has(operationId) ||
      this.#decisions.has(operationId) ||
      this.#pins.has(operationId) ||
      this.#adaptationOverrides.has(operationId) ||
      this.#operationPolicies.has(operationId) ||
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
   * is pinned or active. A caller that has just written state for one operation
   * can protect it for this call so that the write survives enforcement.
   */
  #enforceTrackingLimit(protectedOperationId?: string): void {
    const limit = this.#policy.maxTrackedOperations;
    if (limit === null || this.#tracked.size <= limit) {
      return;
    }
    for (const operationId of [...this.#tracked.keys()]) {
      if (this.#tracked.size <= limit) {
        break;
      }
      if (operationId === protectedOperationId) {
        continue;
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
      this.#operationPolicies.delete(operationId);
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
