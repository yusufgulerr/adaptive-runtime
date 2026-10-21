import type {
  AdaptiveRuntimeEvents,
  RuntimeEventListener,
  RuntimeEventName,
} from "../types/events.js";

type AnyListener = (payload: never) => void;

/**
 * Tiny typed event emitter. Listener failures are isolated so observability
 * never changes the outcome of an operation. They are reported via
 * "listener:error" instead.
 */
export class RuntimeEmitter {
  readonly #listeners = new Map<RuntimeEventName, Set<AnyListener>>();

  on<K extends RuntimeEventName>(event: K, listener: RuntimeEventListener<K>): () => void {
    let set = this.#listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    const stored = listener as AnyListener;
    set.add(stored);
    return () => {
      set.delete(stored);
    };
  }

  emit<K extends RuntimeEventName>(event: K, payload: AdaptiveRuntimeEvents[K]): void {
    const set = this.#listeners.get(event);
    if (set === undefined) {
      return;
    }
    for (const listener of [...set]) {
      try {
        (listener as (value: AdaptiveRuntimeEvents[K]) => void)(payload);
      } catch (error) {
        if (event === "listener:error") {
          continue;
        }
        this.emit("listener:error", {
          event,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
  }
}
