import { ConfigurationError } from "../../errors/index.js";
import type {
  ResourceSignal,
  SignalDescriptor,
  SignalProvider,
  SignalReadContext,
} from "../../types/signals.js";
import { errorMessage } from "../../utils/errors.js";

export const WEB_NETWORK_RTT_MS = "web.network.rttMs";
export const WEB_NETWORK_DOWNLINK_MBPS = "web.network.downlinkMbps";
export const WEB_NETWORK_SAVE_DATA = "web.network.saveData";

export interface NetworkInformationLike {
  readonly rtt?: number;
  readonly downlink?: number;
  readonly saveData?: boolean;
  readonly effectiveType?: string;
  readonly type?: string;
}

export interface NetworkInformationProviderOptions {
  readonly id?: string;
  readonly getConnection?: () => NetworkInformationLike | undefined;
  readonly saveDataPenaltyRttMs?: number;
}

function validateId(id: string | undefined, defaultId: string): string {
  if (id === undefined) {
    return defaultId;
  }
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new ConfigurationError("Provider id must be a non-empty string.");
  }
  if (id !== id.trim()) {
    throw new ConfigurationError("Provider id must not have leading or trailing whitespace.");
  }
  return id;
}

/**
 * Provides network connection metrics (RTT, downlink bandwidth, data-saver flag)
 * in web browser environments via NetworkInformation API duck-typing.
 */
export class NetworkInformationProvider implements SignalProvider {
  readonly id: string;
  readonly signals: readonly SignalDescriptor[];
  readonly #getConnection: () => NetworkInformationLike | undefined;
  readonly #saveDataPenaltyRttMs: number | undefined;
  #closed = false;

  constructor(options: NetworkInformationProviderOptions = {}) {
    this.id = validateId(options.id, "web-network-information");
    if (options.getConnection !== undefined && typeof options.getConnection !== "function") {
      throw new ConfigurationError("NetworkInformationProvider getConnection must be a function.");
    }
    if (
      options.saveDataPenaltyRttMs !== undefined &&
      (typeof options.saveDataPenaltyRttMs !== "number" ||
        !Number.isFinite(options.saveDataPenaltyRttMs) ||
        options.saveDataPenaltyRttMs < 0)
    ) {
      throw new ConfigurationError(
        "NetworkInformationProvider saveDataPenaltyRttMs must be a non-negative finite number.",
      );
    }
    this.#getConnection =
      options.getConnection ??
      (() => {
        const g = globalThis as unknown as {
          navigator?: { connection?: NetworkInformationLike };
        };
        return g.navigator?.connection;
      });
    this.#saveDataPenaltyRttMs = options.saveDataPenaltyRttMs;

    this.signals = [
      {
        name: WEB_NETWORK_RTT_MS,
        unit: "milliseconds",
        description: "Estimated round-trip time in milliseconds.",
      },
      {
        name: WEB_NETWORK_DOWNLINK_MBPS,
        unit: "custom",
        description: "Estimated downlink bandwidth in megabits per second.",
      },
      {
        name: WEB_NETWORK_SAVE_DATA,
        unit: "count",
        description: "User-agent data saver mode active (1 = true, 0 = false).",
      },
    ];
  }

  read(context: SignalReadContext): readonly ResourceSignal[] {
    const observedAt = context.now;

    if (this.#closed) {
      return this.signals.map((descriptor) => ({
        name: descriptor.name,
        unit: descriptor.unit,
        status: "unsupported",
        observedAt,
        error: "Provider is closed.",
      }));
    }

    try {
      const connection = this.#getConnection();

      if (connection === undefined || connection === null) {
        return this.signals.map((descriptor) => ({
          name: descriptor.name,
          unit: descriptor.unit,
          status: "unsupported",
          observedAt,
          error: "navigator.connection is not supported in this environment.",
        }));
      }

      const details: Record<string, unknown> = {};
      if (connection.effectiveType !== undefined) {
        details.effectiveType = connection.effectiveType;
      }
      if (connection.type !== undefined) {
        details.type = connection.type;
      }

      const readings: ResourceSignal[] = [];

      // 1. RTT
      if (
        typeof connection.rtt === "number" &&
        Number.isFinite(connection.rtt) &&
        connection.rtt >= 0
      ) {
        const applyPenalty =
          connection.saveData === true && typeof this.#saveDataPenaltyRttMs === "number";
        const penalty = applyPenalty ? this.#saveDataPenaltyRttMs : 0;
        const effectiveRtt = connection.rtt + penalty;
        const rttDetails: Record<string, unknown> = {
          ...details,
          rtt: connection.rtt,
        };
        if (applyPenalty) {
          rttDetails.rawRtt = connection.rtt;
          rttDetails.saveDataPenaltyRttMs = this.#saveDataPenaltyRttMs;
          rttDetails.effectiveRtt = effectiveRtt;
        }

        readings.push({
          name: WEB_NETWORK_RTT_MS,
          unit: "milliseconds",
          status: "ok",
          value: effectiveRtt,
          observedAt,
          confidence: 1,
          details: rttDetails,
        });
      } else {
        readings.push({
          name: WEB_NETWORK_RTT_MS,
          unit: "milliseconds",
          status: "unknown",
          observedAt,
          error: "Network RTT is unavailable or invalid.",
          ...(Object.keys(details).length > 0 ? { details } : {}),
        });
      }

      // 2. Downlink
      if (
        typeof connection.downlink === "number" &&
        Number.isFinite(connection.downlink) &&
        connection.downlink >= 0
      ) {
        readings.push({
          name: WEB_NETWORK_DOWNLINK_MBPS,
          unit: "custom",
          status: "ok",
          value: connection.downlink,
          observedAt,
          confidence: 1,
          details: { ...details, downlink: connection.downlink },
        });
      } else {
        readings.push({
          name: WEB_NETWORK_DOWNLINK_MBPS,
          unit: "custom",
          status: "unknown",
          observedAt,
          error: "Network downlink bandwidth is unavailable or invalid.",
          ...(Object.keys(details).length > 0 ? { details } : {}),
        });
      }

      // 3. SaveData
      if (typeof connection.saveData === "boolean") {
        readings.push({
          name: WEB_NETWORK_SAVE_DATA,
          unit: "count",
          status: "ok",
          value: connection.saveData ? 1 : 0,
          observedAt,
          confidence: 1,
          details: { ...details, saveData: connection.saveData },
        });
      } else {
        readings.push({
          name: WEB_NETWORK_SAVE_DATA,
          unit: "count",
          status: "unknown",
          observedAt,
          error: "Network saveData flag is unavailable or invalid.",
          ...(Object.keys(details).length > 0 ? { details } : {}),
        });
      }

      return readings;
    } catch (err) {
      const msg = errorMessage(err);
      return this.signals.map((descriptor) => ({
        name: descriptor.name,
        unit: descriptor.unit,
        status: "error",
        observedAt,
        error: `Failed to read network connection: ${msg}`,
      }));
    }
  }

  close(): void {
    this.#closed = true;
  }
}
