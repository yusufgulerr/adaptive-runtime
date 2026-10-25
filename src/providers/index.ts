/**
 * Provider barrel. It includes Node.js, web, and edge providers, so it is not a
 * platform-neutral entry point. Prefer `adaptive-runtime/web`,
 * `adaptive-runtime/edge`, or `adaptive-runtime/core` for portable bundles.
 */

export {
  type CompositeCombinerMode,
  CompositeSignalProvider,
  type CompositeSignalProviderOptions,
  type CompositeSignalRule,
  createCompositeSignalProvider,
} from "./composite.js";
export {
  type CpuUsageSnapshot,
  CpuUtilizationProvider,
  type CpuUtilizationProviderOptions,
  PROCESS_CPU_UTILIZATION,
} from "./cpu-utilization.js";
export {
  createEdgeExecutionBudgetProvider,
  EDGE_CONCURRENCY_SATURATION,
  EDGE_EXECUTION_REMAINING_MS,
  EDGE_EXECUTION_USED_RATIO,
  type EdgeBudgetSnapshot,
  EdgeExecutionBudgetProvider,
  type EdgeExecutionBudgetProviderOptions,
  ExecutionBudgetProvider,
  type ExecutionBudgetProviderOptions,
  type ExecutionBudgetSnapshot,
} from "./edge/execution-budget.js";
export {
  EventLoopDelayProvider,
  type EventLoopDelayProviderOptions,
  type HistogramLike,
} from "./event-loop-delay.js";
export {
  EVENT_LOOP_UTILIZATION,
  EventLoopUtilizationProvider,
  type EventLoopUtilizationProviderOptions,
  type EventLoopUtilizationSnapshot,
} from "./event-loop-utilization.js";
export {
  NETWORK_LATENCY,
  NetworkLatencyProvider,
  type NetworkLatencyProviderOptions,
  type NetworkProbeContext,
} from "./network-latency.js";
export {
  type MemoryUsageSnapshot,
  PROCESS_MEMORY_HEAP_USED,
  PROCESS_MEMORY_RSS,
  ProcessMemoryProvider,
  type ProcessMemoryProviderOptions,
} from "./process-memory.js";
export {
  ComputePressureProvider,
  type ComputePressureProviderOptions,
  type ComputePressureRecordLike,
  type ComputePressureState,
  type PressureObserverFactory,
  type PressureObserverLike,
  WEB_COMPUTE_PRESSURE,
} from "./web/compute-pressure.js";
export {
  type DeviceMemoryEnvironmentLike,
  DeviceMemoryProvider,
  type DeviceMemoryProviderOptions,
  type MemoryInfoLike,
  WEB_DEVICE_MEMORY_GIB,
  WEB_JS_HEAP_USED_RATIO,
} from "./web/device-memory.js";
export {
  FrameTimingProvider,
  type FrameTimingProviderOptions,
  WEB_FRAME_DROPPED_RATIO,
  WEB_FRAME_DURATION_P95_MS,
} from "./web/frame-timing.js";
export {
  type NetworkInformationLike,
  NetworkInformationProvider,
  type NetworkInformationProviderOptions,
  WEB_NETWORK_DOWNLINK_MBPS,
  WEB_NETWORK_RTT_MS,
  WEB_NETWORK_SAVE_DATA,
} from "./web/network-info.js";
