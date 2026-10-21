import type { Clock, ClockTimer } from "../../src/types/clock.js";

interface FakeTimer {
  readonly at: number;
  readonly sequence: number;
  callback: () => void;
  cancelled: boolean;
}

export class FakeClock implements Clock {
  #now: number;
  #sequence = 0;
  readonly #timers: FakeTimer[] = [];

  constructor(startAt = 1_000_000) {
    this.#now = startAt;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, delayMs: number): ClockTimer {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new RangeError("FakeClock delay must be a finite number >= 0.");
    }
    this.#sequence += 1;
    const timer: FakeTimer = {
      at: this.#now + delayMs,
      sequence: this.#sequence,
      callback,
      cancelled: false,
    };
    this.#timers.push(timer);
    return {
      cancel: () => {
        timer.cancelled = true;
      },
    };
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError("FakeClock advance must be a finite number >= 0.");
    }
    const target = this.#now + ms;
    for (;;) {
      const next = this.#timers
        .filter((timer) => !timer.cancelled && timer.at <= target)
        .sort((left, right) => left.at - right.at || left.sequence - right.sequence)[0];
      if (next === undefined) {
        break;
      }
      next.cancelled = true;
      this.#now = next.at;
      next.callback();
    }
    this.#now = target;
  }

  pendingTimers(): number {
    return this.#timers.filter((timer) => !timer.cancelled).length;
  }
}
