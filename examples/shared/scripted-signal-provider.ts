import type {
  ResourceSignal,
  SignalDescriptor,
  SignalProvider,
  SignalReadContext,
  SignalUnit,
} from "../../src/types/signals.js";

export interface ScriptedSignal {
  readonly name: string;
  readonly unit: SignalUnit;
  readonly values: readonly number[];
}

/**
 * Example-only provider that replays measurements. It lets examples and tests
 * demonstrate policy behavior without depending on the local machine.
 */
export class ScriptedSignalProvider implements SignalProvider {
  readonly id: string;
  readonly signals: readonly SignalDescriptor[];
  readonly #script: readonly ScriptedSignal[];
  #index = 0;

  constructor(options: { id?: string; script: readonly ScriptedSignal[] }) {
    this.id = options.id ?? "scripted-signals";
    this.#script = options.script;
    this.signals = options.script.map(({ name, unit }) => ({ name, unit }));
  }

  read(context: SignalReadContext): readonly ResourceSignal[] {
    const index = this.#index;
    this.#index += 1;
    return this.#script.map((signal) => ({
      name: signal.name,
      unit: signal.unit,
      status: "ok" as const,
      value: signal.values[Math.min(index, signal.values.length - 1)] ?? 0,
      observedAt: context.now,
      confidence: 1,
    }));
  }
}
