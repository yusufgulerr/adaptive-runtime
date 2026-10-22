/**
 * Web entry point: the platform-neutral core plus browser providers.
 * Uses structural interfaces so TypeScript projects without the DOM lib compile.
 */

export * from "./core.js";
export {
  type DeviceMemoryEnvironmentLike,
  DeviceMemoryProvider,
  type DeviceMemoryProviderOptions,
  type MemoryInfoLike,
  WEB_DEVICE_MEMORY_GIB,
  WEB_JS_HEAP_USED_RATIO,
} from "./providers/web/device-memory.js";
export {
  FrameTimingProvider,
  type FrameTimingProviderOptions,
  WEB_FRAME_DROPPED_RATIO,
  WEB_FRAME_DURATION_P95_MS,
} from "./providers/web/frame-timing.js";
export {
  type NetworkInformationLike,
  NetworkInformationProvider,
  type NetworkInformationProviderOptions,
  WEB_NETWORK_DOWNLINK_MBPS,
  WEB_NETWORK_RTT_MS,
  WEB_NETWORK_SAVE_DATA,
} from "./providers/web/network-info.js";
