import type { Clock, ClockTimer } from "../types/clock.js";

/**
 * Real time source. setTimeout is intentionally not unref'd here because
 * operation timeouts must fire even when no other handles are active.
 */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(callback: () => void, delayMs: number): ClockTimer {
    const timer = setTimeout(callback, delayMs);
    return {
      cancel: () => clearTimeout(timer),
    };
  },
};
