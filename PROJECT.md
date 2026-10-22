# Project: Adaptive Runtime — Phase 3 (v0.3.0)

## Architecture
Phase 3 expands Adaptive Runtime into a universal, multi-runtime adaptive control plane across Node.js, WinterCG (Cloudflare Workers, Deno, Bun), and modern Web Browsers.
Core architecture principles:
1. **Zero Runtime Dependencies**: Pure TypeScript, structural interfaces (`*Like`), zero external npm dependencies.
2. **Zero-Node Isolation**: Platform-neutral core (`src/core.ts`), web (`src/web.ts`), edge (`src/edge.ts`), policy (`src/policy/*`), runtime (`src/runtime/*`), signals (`src/signals/*`), observability (`src/observability/*`), and testing (`src/testing/*`). Node-dependent code is isolated strictly to Node providers and `src/node.ts`.
3. **No Zero-Coercion**: Non-ok signal statuses (`unsupported`, `stale`, `unknown`, `error`) are never coerced to `0`.
4. **Deterministic Tie-Breaking**: Canonical code-unit string comparisons; deterministic policy evaluation.
5. **Full Test & Branch Coverage**: All files strictly maintain >= 80% branch coverage with native Node test runner.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | DeviceMemoryProvider | Web provider for `deviceMemory` and `usedJSHeapSize/jsHeapSizeLimit` ratio | M1 | ORIGINAL_REQUEST §1.1 |
| 2 | NetworkInformationProvider | Web provider for RTT (ms), downlink (Mbps), and saveData | M1 | ORIGINAL_REQUEST §1.2 |
| 3 | FrameTimingProvider | Web provider with frame sample recording, P95 duration, and dropped frame ratio | M1 | ORIGINAL_REQUEST §1.3 |
| 4 | ExecutionBudgetProvider | Edge provider for remaining execution time, elapsed ratio, and concurrency saturation | M1 | ORIGINAL_REQUEST §1.4 |
| 5 | CompositeSignalProvider | Multi-provider signal aggregator with priority status resolution and custom compute rules | M2 | ORIGINAL_REQUEST §2 |
| 6 | CustomPolicySelector Types & Validation | `DecisionReasonCode` `"custom-selector"` and policy resolution validation | M3 | ORIGINAL_REQUEST §3 |
| 7 | CustomPolicySelector Execution | Dynamic candidate selection hook evaluated before stability/hysteresis gating | M3 | ORIGINAL_REQUEST §3 |
| 8 | OpenTelemetry Meter Bridge | Zero-dependency structural attachment to any OpenTelemetry Meter | M4 | ORIGINAL_REQUEST §4 |
| 9 | Prometheus Metrics Collector | Standalone collector with non-zero-coercion status tracking and Prometheus text generation | M4 | ORIGINAL_REQUEST §4 |
| 10 | Testing FakeClock | Virtual time control (`now`, `advance`, `set`, `setTimeout`) | M5 | ORIGINAL_REQUEST §5 |
| 11 | ScriptedSignalProvider | Deterministic scripted signal sequences for reproducible scenario testing | M5 | ORIGINAL_REQUEST §5 |
| 12 | Provider Conformance Check | Comprehensive lifecycle and descriptor validation suite for all providers | M5 | ORIGINAL_REQUEST §5 |
| 13 | Multi-Runtime Entrypoints | `src/core.ts`, `src/web.ts`, `src/edge.ts`, `src/node.ts`, `src/index.ts` exports | M6 | ORIGINAL_REQUEST §6 |
| 14 | Automated Zero-Node Test | Cross-platform AST/regex isolation test ensuring zero node:* in universal files | M6 | ORIGINAL_REQUEST §6 |
| 15 | Edge Gateway Example | Complete example in `examples/multi-runtime-edge` and `npm run example:edge` | M6 | ORIGINAL_REQUEST §6 |
| 16 | ADRs & Documentation Updates | ADR 0007, ADR 0008, and comprehensive documentation updates | M6 | ORIGINAL_REQUEST §6 |
| 17 | Clean Consumer Verification | Independent packaging and multi-subpath import test in temporary project | M6 | ORIGINAL_REQUEST §6 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Multi-Runtime Web & Edge Providers | `src/providers/web/*`, `src/providers/edge/*`, unit tests | none | DONE |
| M2 | Composite Signal Provider | `src/providers/composite.ts`, unit tests | M1 | DONE |
| M3 | Custom Policy Selector Hook | `src/types/decision.ts`, `src/types/policy.ts`, `src/policy/resolve.ts`, `src/policy/engine.ts`, unit tests | none | DONE |
| M4 | Zero-Dependency Observability Bridge | `src/observability/*`, Prometheus text exporter, unit tests | none | DONE |
| M5 | Conformance Testing SDK | `src/testing/*`, FakeClock, ScriptedSignalProvider, conformance runner, unit tests | M1, M2 | DONE |
| M6 | Packaging, Entrypoints, Examples, ADRs & Clean Consumer | `src/core.ts`, `src/web.ts`, `src/edge.ts`, `src/node.ts`, `package.json`, docs, ADRs, edge example, isolation test, clean consumer | M1, M2, M3, M4, M5 | DONE |
| M7 | E2E Testing & Final Verification | Full opaque-box E2E test suite (Tiers 1-4) & adversarial coverage hardening (Tier 5) | M6 | PLANNED (post-0.3.0) |

## Interface Contracts

### M1: Web & Edge Providers
- `WEB_DEVICE_MEMORY_GIB = "web.device.memoryGib"` (unit: "custom")
- `WEB_JS_HEAP_USED_RATIO = "web.jsHeap.usedRatio"` (unit: "ratio")
- `WEB_NETWORK_RTT_MS = "web.network.rttMs"` (unit: "milliseconds")
- `WEB_NETWORK_DOWNLINK_MBPS = "web.network.downlinkMbps"` (unit: "custom")
- `WEB_NETWORK_SAVE_DATA = "web.network.saveData"` (unit: "count")
- `WEB_FRAME_DURATION_P95_MS = "web.frame.durationP95Ms"` (unit: "milliseconds")
- `WEB_FRAME_DROPPED_RATIO = "web.frame.droppedRatio"` (unit: "ratio")
- `EDGE_EXECUTION_REMAINING_MS = "edge.execution.remainingMs"` (unit: "milliseconds")
- `EDGE_EXECUTION_USED_RATIO = "edge.execution.usedRatio"` (unit: "ratio")
- `EDGE_CONCURRENCY_SATURATION = "edge.concurrency.saturation"` (unit: "ratio")

### M2: CompositeSignalProvider
- `CompositeSignalRule`: `{ name: string, unit: SignalUnit, description?: string, inputs: readonly string[], compute: (values: Readonly<Record<string, number>>) => number }`
- Priority status resolution: `error` > `stale` > `unsupported` > `unknown`. Compute only runs if all inputs are `ok`.

### M3: CustomPolicySelector
- `DecisionReasonCode`: includes `"custom-selector"`
- `CustomPolicySelector`: `(context: CustomPolicySelectorContext) => CustomPolicySelection | string | null | undefined`
- Candidates expose `{ candidate, estimatedCost, estimatedLatencyMs, id?, qualityTier?, costTier?, applicable? }`; `estimatedLatencyMs` is currently `null`.
- Evaluated after budget checks and automatic candidate filtering, strictly before anti-flapping stability/hysteresis.

### M4: Observability Bridge
- `attachOpenTelemetryMeter(runtime: AdaptiveRuntime, meter: OpenTelemetryMeterLike, options?: ObservabilityOptions): () => void`
- `createMetricsCollector(options?: ObservabilityOptions): RuntimeMetricsCollector`
- Status !== "ok" signals increment status counter with `{ signal, status }`, never emitting 0 gauge values.

### M5: Testing SDK
- `createFakeClock(initialMs?: number): FakeClock`
- `ScriptedSignalProvider`: implements `SignalProvider` with scripted or cyclic sequences.
- `runProviderConformanceCheck(provider: SignalProvider, options?: ConformanceOptions): Promise<ProviderConformanceReport>`

### M6: Multi-Runtime Entrypoints
- `adaptive-runtime`: Node.js defaults (`src/index.ts` -> `src/node.ts`)
- `adaptive-runtime/core`: Pure universal runtime core, network latency, and composite signals (`src/core.ts`)
- `adaptive-runtime/web`: Universal core + Browser providers (`src/web.ts`)
- `adaptive-runtime/edge`: Universal core + Edge execution-budget provider (`src/edge.ts`)
- `adaptive-runtime/policy`: Pure policy engine and definitions
- `adaptive-runtime/providers`: All providers barrel (Node + Web + Edge + Composite)
- `adaptive-runtime/observability`: Pure observability bridge (`src/observability/index.ts`)
- `adaptive-runtime/testing`: Conformance testing SDK (`src/testing/index.ts`)

## Code Layout
```
src/
  ├── core.ts                     # Universal pure core barrel
  ├── node.ts                     # Node-specific runtime barrel
  ├── web.ts                      # Browser runtime barrel
  ├── edge.ts                     # Edge runtime barrel
  ├── index.ts                    # Root default barrel (re-exports node.ts)
  ├── providers/
  │   ├── web/
  │   │   ├── device-memory.ts
  │   │   ├── network-info.ts
  │   │   └── frame-timing.ts
  │   ├── edge/
  │   │   └── execution-budget.ts
  │   ├── composite.ts
  │   └── index.ts
  ├── observability/
  │   └── index.ts
  └── testing/
      └── index.ts
tests/
  ├── unit/
  │   ├── web-providers.test.ts
  │   ├── edge-providers.test.ts
  │   ├── composite-provider.test.ts
  │   ├── custom-selector.test.ts
  │   ├── observability.test.ts
  │   ├── testing-sdk.test.ts
  │   └── isolation.test.ts
  └── integration/
      ├── examples.test.ts
      ├── entrypoints.test.ts
      ├── public-api.test.ts
      └── pr-title.test.ts
scripts/
  ├── check-pr-title.mjs
  └── verify-package-exports.mjs
examples/
  └── multi-runtime-edge/
      ├── edge-gateway.ts
      ├── index.ts
      └── README.md
```

## Verification status

- 256 tests across 45 suites, 0 failures, 0 skipped.
- 99.10% lines, 96.91% branches, 98.64% functions; every `src/**` file is above
  80% branch coverage.
- Full local gate passed on 2026-10-22: format, lint, typecheck, tests, coverage,
  build, six examples, both benchmarks, `npm pack --dry-run`, zero-Node source
  scan, and a clean-consumer install with all documented subpaths plus a NodeNext
  TypeScript compile.
- The `v0.3.0` tag, GitHub release, and npm publication are separate
  owner-approved release steps. See [docs/RELEASING.md](docs/RELEASING.md) and
  [docs/VERIFICATION.md](docs/VERIFICATION.md).
- The OpenSSF Best Practices passing-level self-assessment is documented in
  [docs/OPENSSF_BEST_PRACTICES.md](docs/OPENSSF_BEST_PRACTICES.md). BadgeApp
  registration and the two owner attestations are pending; no badge is claimed.
