export interface ClockTimer {
  cancel(): void;
}

/**
 * Injectable time source. Tests can advance a fake clock without sleeping.
 * Timeouts are cooperative: they reject the runtime promise and abort the
 * signal, but cannot stop synchronous code that ignores the signal.
 */
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ClockTimer;
}
