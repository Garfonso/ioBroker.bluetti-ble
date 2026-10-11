// This file extends the AdapterConfig type from "@iobroker/types"

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
    namespace ioBroker {
        interface AdapterConfig {
            /** Bluetooth MAC address of the device, e.g. "AA:BB:CC:DD:EE:FF". */
            macAddress: string;
            /** Device type, or "auto" to detect from the advertised BLE name. */
            deviceType: string;
            /** Polling interval in seconds. */
            pollInterval: number;
            /** Whether to poll per-pack battery data (cell voltages etc.). */
            pollPacks: boolean;
            /** Encrypted v2 protocol: "auto" (per device profile), "on" or "off". */
            encryption: string;
            /**
             * Writing to the device: "auto" (allowed, except for experimental
             * device profiles), "on" (always allowed) or "off" (read-only).
             */
            writeMode: string;
        }
    }
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};
