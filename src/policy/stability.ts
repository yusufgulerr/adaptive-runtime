/** The stability fields that survive between automatic evaluations. */
export interface StabilityState {
  readonly modeSince: number;
  readonly pendingStrategyId: string | null;
  readonly pendingStreak: number;
}

export type StabilityBlock = "minimum-mode-duration" | "candidate-stability";

export interface StabilityGate {
  readonly blocked: StabilityBlock | null;
  readonly pendingStrategyId: string | null;
  readonly pendingStreak: number;
  readonly elapsedMs: number;
}

/**
 * Applies the two anti-flapping gates in order: minimum mode duration first,
 * then candidate stability. The pending candidate is retained while either
 * gate blocks the switch.
 */
export function evaluateStabilityGate(
  state: StabilityState,
  candidateId: string,
  now: number,
  minimumModeDurationMs: number,
  consecutiveSamples: number,
): StabilityGate {
  const pendingStreak = state.pendingStrategyId === candidateId ? state.pendingStreak + 1 : 1;
  const elapsedMs = now - state.modeSince;

  if (elapsedMs < minimumModeDurationMs) {
    return {
      blocked: "minimum-mode-duration",
      pendingStrategyId: candidateId,
      pendingStreak,
      elapsedMs,
    };
  }

  if (pendingStreak < consecutiveSamples) {
    return {
      blocked: "candidate-stability",
      pendingStrategyId: candidateId,
      pendingStreak,
      elapsedMs,
    };
  }

  return {
    blocked: null,
    pendingStrategyId: null,
    pendingStreak: 0,
    elapsedMs,
  };
}
