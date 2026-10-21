import type { Policy } from "../types/policy.js";

/**
 * Returns the given policy unchanged, preserving its literal type. This is a
 * type-only convenience for editor completion; it performs no validation,
 * defaulting, or cloning.
 */
export function definePolicy<const TPolicy extends Policy>(policy: TPolicy): TPolicy {
  return policy;
}
