# Deprecation and Stability Policy

This document formalizes the stability contract for `adaptive-runtime` as it enters
1.0.0-RC and reaches general availability. It outlines export guarantees, platform
portability constraints, the frozen error-code catalog, semantic versioning rules, and
the deprecation lifecycle.

---

## 1. Public Subpath Export Guarantees

`adaptive-runtime` is an **ESM-only package** (`"type": "module"`) with **zero runtime
dependencies**. The package export map in `package.json` defines the complete, sealed
public surface area. Internal modules under `src/` or `dist/` not explicitly exposed in
the export map are private and subject to refactoring without notice.

The following 9 entry points are guaranteed stable across all 1.x releases:

| Export Subpath | Target File | Environment Compatibility | Description |
| --- | --- | --- | --- |
| `.` (`adaptive-runtime`) | `./dist/index.js` | Node.js `>=22.0.0` | Primary entry point. Includes core runtime, all built-in Node.js providers, policy engines, and utilities. |
| `./core` | `./dist/core.js` | Universal (Node.js, Browser, Edge/WinterCG) | Platform-neutral core runtime excluding OS-specific providers. Ideal for custom bundles and embedded environments. |
| `./node` | `./dist/node.js` | Node.js `>=22.0.0` | Node.js platform bundle: core runtime re-exports plus `ProcessMemoryProvider`, `CpuUtilizationProvider`, `EventLoopDelayProvider`, `EventLoopUtilizationProvider`, and `NetworkLatencyProvider`. |
| `./web` | `./dist/web.js` | Browser / Web Workers | Browser platform bundle: core runtime re-exports plus `DeviceMemoryProvider`, `NetworkInformationProvider`, `FrameTimingProvider`, and `ComputePressureProvider`. |
| `./edge` | `./dist/edge.js` | Edge / WinterCG (Cloudflare Workers, Deno, Bun, Vercel Edge) | Edge platform bundle: core runtime re-exports plus `ExecutionBudgetProvider` and edge resource constants. |
| `./policy` | `./dist/policy/index.js` | Universal | Policy engine components, deterministic percentage rollout (`createPolicyRollout`), combinators (`composeSelectors`), built-in selectors (`createCostBudgetSelector`, `createSafeSelector`, `createErrorRateGuardSelector`, `createLatencyBudgetSelector`), and budget evaluators. |
| `./providers` | `./dist/providers/index.js` | Mixed | Comprehensive provider barrel containing all Node.js, Web, and Edge providers alongside composite signal utilities. |
| `./observability` | `./dist/observability/index.js` | Universal | Zero-dependency metrics collection (`MetricsCollector`), Prometheus text exposition, structural OpenTelemetry adapters, and SLO/error-budget monitoring (`createSloMonitor`, `attachSloMonitor`). |
| `./testing` | `./dist/testing/index.js` | Universal | Deterministic testing SDK: `createFakeClock`, `ScriptedSignalProvider`, `runProviderConformanceCheck`, `simulatePolicyTimeline`, and policy trace capture/replay/diff. |
| `./package.json` | `./package.json` | Universal | Standard package metadata export. |

### Environment Portability Guarantee
- Subpaths marked **Universal** (`./core`, `./policy`, `./observability`, `./testing`) must never access platform-specific globals (such as Node `process`, `perf_hooks`, `v8`, or Browser `window`, `navigator`, `document`) without defensive capability checks.
- Zero runtime dependencies: No external runtime dependencies will be introduced in 1.x.

---

## 2. Frozen 13-Error-Code Catalog

Every error thrown by the runtime inherits from `AdaptiveRuntimeError` and provides a
machine-readable `code` property. In 1.0-RC and all 1.x releases, this catalog of 13
error codes is **frozen**. No code will be renamed, removed, or repurposed.

| Error Class | Frozen `code` | Description / Trigger Condition |
| --- | --- | --- |
| `ConfigurationError` | `"CONFIGURATION_ERROR"` | Invalid runtime, policy, budget, or provider configuration supplied at construction. |
| `AdmissionRejectedError` | `"ADMISSION_REJECTED"` | The adaptive concurrency limiter rejected an acquire because the queue is full, the acquire timed out, or the limiter is closed. |
| `RuntimeClosedError` | `"RUNTIME_CLOSED"` | Attempted to execute `run()` or evaluate decisions after calling `runtime.close()`. |
| `NoEligibleStrategyError` | `"NO_ELIGIBLE_STRATEGY"` | No declared strategy satisfied quality floor, applicability checks, or budget constraints. |
| `PinnedStrategyError` | `"PINNED_STRATEGY_UNAVAILABLE"` | A pinned strategy is not present in declared strategies or failed its applicability check. |
| `FallbackStrategyError` | `"FALLBACK_STRATEGY_UNAVAILABLE"` | The configured `fallbackStrategyId` is missing or failed its applicability check. |
| `MissingSignalError` | `"MISSING_SIGNAL"` | A required budget signal is unavailable and `missingSignalBehavior` is configured to `"error"`. |
| `StrategyApplicabilityError` | `"STRATEGY_APPLICABILITY_FAILED"` | A strategy's `isApplicable()` predicate threw an uncaught error or returned a non-boolean value. |
| `StrategyExecutionError` | `"STRATEGY_EXECUTION_FAILED"` | The chosen strategy's `run()` method threw or rejected during execution. |
| `OperationAbortedError` | `"OPERATION_ABORTED"` | The caller's `AbortSignal` was triggered before or during strategy execution (name: `"AbortError"`). |
| `OperationTimeoutError` | `"OPERATION_TIMEOUT"` | The execution exceeded the configured `timeoutMs` threshold (name: `"TimeoutError"`). |
| `QualityCheckError` | `"QUALITY_CHECK_FAILED"` | The strategy's `checkQuality` callback returned `{ pass: false }` under `qualityCheck: "error"`. |
| `ProviderTimeoutError` | `"PROVIDER_TIMEOUT"` | A registered `SignalProvider` failed to resolve its `read()` method within `providerTimeoutMs`. |

### Error Handling Guarantees
- Applications can safely match error types using `error.code` or `instanceof`:
  ```ts
  try {
    await runtime.run({ operationId, input, strategies });
  } catch (err) {
    if (err instanceof AdaptiveRuntimeError) {
      switch (err.code) {
        case "NO_ELIGIBLE_STRATEGY":
          // handle graceful fallback
          break;
        case "OPERATION_TIMEOUT":
          // handle timeout
          break;
      }
    }
  }
  ```
- Error names for standard web abort and timeout ergonomics are preserved: `OperationAbortedError.name === "AbortError"` and `OperationTimeoutError.name === "TimeoutError"`.

---

## 3. Semantic Versioning (SemVer 2.0.0)

Following the 1.0.0 release, `adaptive-runtime` strictly follows [SemVer 2.0.0](https://semver.org/):

- **Patch Releases (`1.0.X`)**:
  - Bug fixes, internal performance enhancements, documentation updates, and test additions.
  - No changes to exported TypeScript types, function signatures, or behavior contracts.
  - Zero behavioral regressions on supported Node.js and browser versions.
- **Minor Releases (`1.X.0`)**:
  - New backwards-compatible capabilities (e.g., new signal providers, built-in selectors, configuration options).
  - Introduction of deprecation notices for APIs slated for future removal.
  - Additive changes to exported interfaces (all new parameters or properties must be optional).
  - No removal or renaming of public subpaths, functions, classes, error codes, or properties.
- **Major Releases (`2.0.0`)**:
  - Removal of deprecated features that completed the required deprecation cycle.
  - Breaking alterations to existing method signatures, types, or default behaviors.
  - Raising minimum platform support baselines (e.g., requiring newer Node.js LTS).

---

## 4. The 2-Minor-Cycle Deprecation Policy

To provide stability and adequate migration runways for mission-critical enterprise
and edge deployments, any API scheduled for retirement must follow the **2-Minor-Cycle
Deprecation Policy**:

1. **Phase 1: Deprecation Notice (Minor Release `N`)**:
   - The symbol is marked with `@deprecated` in JSDoc/TypeScript annotations, referencing the replacement pattern.
   - Documentation in `docs/API.md` and `docs/MIGRATION.md` is updated with upgrade guides.
   - The functionality continues to operate with 100% backwards compatibility and identical semantics.
2. **Phase 2: Continued Support (Minor Release `N + 1`)**:
   - The deprecated API remains fully operational and tested across the entire test suite.
   - CI continues to verify backwards compatibility.
3. **Phase 3: Retirement (Major Release `N + 2` or Next Major)**:
   - The deprecated symbol may be removed or replaced only when cutting a new major release (e.g., `2.0.0`).
   - Deprecated features will **never** be removed in a minor or patch release.

---

## 5. Platform Baselines

The package declares `"engines": { "node": ">=22.0.0" }`.
- We support all Active and Maintenance Node.js LTS lines.
- Dropping support for an end-of-life Node.js line is handled according to our roadmap policy: once an LTS release reaches official EOL according to the Node.js Foundation release schedule, dropping CI coverage for that release in a subsequent minor update is permissible if no code changes are required, but raising `"engines.node"` beyond supported baselines will only occur in major releases.
