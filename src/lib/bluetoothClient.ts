import { createBluetooth } from 'node-ble';
import type { Adapter, Bluetooth, Device, GattCharacteristic } from 'node-ble';
import type { EventEmitter } from 'node:events';
import type { DeviceCommand } from './commands';
import { EncryptedConnection, PassthroughConnection } from './v2/connection';
import type { Connection } from './v2/connection';

const SERVICE_UUID = '0000ff00-0000-1000-8000-00805f9b34fb';
const WRITE_UUID = '0000ff02-0000-1000-8000-00805f9b34fb';
const NOTIFY_UUID = '0000ff01-0000-1000-8000-00805f9b34fb';

const RESPONSE_TIMEOUT_MS = 5000;
const CONNECT_TIMEOUT_MS = 30000;
const HANDSHAKE_TIMEOUT_MS = 15000;
const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 200;

export interface ClientLogger {
    debug(msg: string): void;
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
}

/** Adapter-backed timers so all timeouts are cleaned up on unload. */
export interface AdapterTimers {
    setTimeout: (cb: () => void, ms: number) => ioBroker.Timeout | undefined;
    clearTimeout: (handle: ioBroker.Timeout | undefined) => void;
}

interface PendingCommand {
    command: DeviceCommand;
    resolve: (body: Buffer) => void;
    reject: (err: Error) => void;
    timer: ioBroker.Timeout | undefined;
}

/**
 * Talks MODBUS-over-Bluetooth to a single Bluetti device via BlueZ (node-ble).
 * Commands are serialized: one request is on the wire at a time, matching the
 * original bluetti_mqtt client behaviour.
 */
export class BluetoothClient {
    private bluetooth?: Bluetooth;
    private destroyBluetooth?: () => void;
    private adapter?: Adapter;
    private device?: Device;
    private writeChar?: GattCharacteristic;
    private notifyChar?: GattCharacteristic;
    private connection?: Connection;

    private notifyBuffer = Buffer.alloc(0);
    private pending?: PendingCommand;
    private readonly queue: Array<() => void> = [];
    private busy = false;
    private closed = false;
    private busErrorSeen = false;

    /** Advertised device name, available after connect(). */
    name?: string;

    constructor(
        private readonly address: string,
        private readonly log: ClientLogger,
        private readonly onDisconnect: () => void,
        private readonly timers: AdapterTimers,
    ) {}

    private delayMs(ms: number): Promise<void> {
        return new Promise(resolve => {
            this.timers.setTimeout(resolve, ms);
        });
    }

    get connected(): boolean {
        return !!this.device && !!this.writeChar && !!this.notifyChar && !!this.connection && !this.closed;
    }

    async connect(): Promise<void> {
        this.closed = false;
        this.busErrorSeen = false;
        const { bluetooth, destroy } = createBluetooth();
        this.bluetooth = bluetooth;
        this.destroyBluetooth = destroy;

        // The bus is not part of node-ble's public API and therefore missing from
        // its type declarations, hence the cast.
        const bus = (bluetooth as { dbus?: EventEmitter }).dbus;
        if (bus) {
            bus.on('error', (err: Error) => this.handleBusError(err));
        } else {
            this.log.warn('node-ble no longer exposes the D-Bus connection, bus errors cannot be handled');
        }

        this.adapter = await bluetooth.defaultAdapter();
        if (!(await this.adapter.isPowered())) {
            throw new Error('Bluetooth adapter is not powered on');
        }
        if (!(await this.adapter.isDiscovering())) {
            await this.adapter.startDiscovery();
        }

        this.log.debug(`Waiting for device ${this.address}...`);
        this.device = await this.adapter.waitDevice(this.address.toUpperCase(), CONNECT_TIMEOUT_MS);

        this.device.on('disconnect', () => this.handleDisconnect());

        await this.device.connect();
        this.name = await this.device.getName().catch(() => undefined);
        this.log.info(`Connected to ${this.address}${this.name ? ` (${this.name})` : ''}`);

        const gatt = await this.device.gatt();
        const service = await gatt.getPrimaryService(SERVICE_UUID);
        this.writeChar = await service.getCharacteristic(WRITE_UUID);
        this.notifyChar = await service.getCharacteristic(NOTIFY_UUID);
    }

    /**
     * Start receiving notifications and, for v2 devices, run the encryption
     * handshake. Must be called after {@link connect} and before {@link perform}.
     *
     * @param encrypted
     */
    async beginSession(encrypted: boolean): Promise<void> {
        if (!this.writeChar || !this.notifyChar) {
            throw new Error('not connected');
        }
        const writeRaw = (buffer: Buffer): Promise<void> => this.writeChar!.writeValue(buffer, { type: 'command' });
        const onPlaintext = (buffer: Buffer): void => this.handlePlaintext(buffer);
        this.connection = encrypted
            ? new EncryptedConnection(onPlaintext, writeRaw)
            : new PassthroughConnection(onPlaintext, writeRaw);

        await this.notifyChar.startNotifications();
        this.notifyChar.on('valuechanged', (data: Buffer) => {
            void this.connection?.onPacket(data).catch((err: Error) => this.log.debug(`packet error: ${err.message}`));
        });

        if (encrypted) {
            this.log.info('Performing encrypted handshake...');
            await Promise.race([
                this.connection.waitUntilReady(),
                this.delayMs(HANDSHAKE_TIMEOUT_MS).then(() => {
                    throw new Error('encryption handshake timed out');
                }),
            ]);
            this.log.info('Encrypted handshake complete');
        }
    }

    /**
     * Queue a command and resolve with its parsed response body. Commands are
     * serialized (one in flight at a time) and retried on timeout / checksum
     * failure, mirroring the original bluetti_mqtt client.
     *
     * @param command
     */
    perform(command: DeviceCommand): Promise<Buffer> {
        return new Promise<Buffer>((resolve, reject) => {
            if (this.closed) {
                reject(new Error('client closed'));
                return;
            }
            const task = async (): Promise<void> => {
                try {
                    resolve(await this.attemptWithRetries(command));
                } catch (err) {
                    reject(err instanceof Error ? err : new Error(String(err)));
                } finally {
                    this.settlePending();
                }
            };
            this.queue.push(task);
            this.runNext();
        });
    }

    /** Run a single command, retrying transient failures up to MAX_ATTEMPTS times. */
    private async attemptWithRetries(command: DeviceCommand): Promise<Buffer> {
        let lastError: RetryError = new Error('command failed');
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            if (this.closed || !this.writeChar) {
                throw new Error('not connected');
            }
            try {
                return await this.singleAttempt(command);
            } catch (err) {
                lastError = err as RetryError;
                if (!lastError.retryable || attempt === MAX_ATTEMPTS) {
                    throw lastError;
                }
                this.log.debug(`Command failed (${lastError.message}), attempt ${attempt}/${MAX_ATTEMPTS}`);
                await this.delayMs(RETRY_DELAY_MS);
            }
        }
        throw lastError;
    }

    /** A single request/response round-trip. */
    private singleAttempt(command: DeviceCommand): Promise<Buffer> {
        return new Promise<Buffer>((resolve, reject) => {
            if (!this.writeChar || !this.connection) {
                reject(new Error('not connected'));
                return;
            }
            this.notifyBuffer = Buffer.alloc(0);
            const timer = this.timers.setTimeout(() => {
                if (this.pending?.timer === timer) {
                    this.pending = undefined;
                }
                reject(retryable(new Error('response timeout')));
            }, RESPONSE_TIMEOUT_MS);
            this.pending = { command, resolve, reject, timer };

            // Bluetti expects write-without-response on ff02; the connection layer
            // encrypts the frame first for v2 devices.
            this.connection.write(command.frame).catch((err: Error) => {
                if (this.pending?.timer === timer) {
                    this.timers.clearTimeout(timer);
                    this.pending = undefined;
                }
                reject(err);
            });
        });
    }

    async disconnect(): Promise<void> {
        this.closed = true;
        if (this.pending) {
            this.timers.clearTimeout(this.pending.timer);
            this.pending.reject(new Error('disconnecting'));
            this.pending = undefined;
        }
        try {
            await this.notifyChar?.stopNotifications();
        } catch {
            /* ignore */
        }
        try {
            await this.device?.disconnect();
        } catch {
            /* ignore */
        }
        try {
            this.destroyBluetooth?.();
        } catch {
            /* ignore */
        }
        this.writeChar = undefined;
        this.notifyChar = undefined;
        this.connection = undefined;
        this.device = undefined;
    }

    private runNext(): void {
        if (this.busy || this.closed) {
            return;
        }
        const task = this.queue.shift();
        if (!task) {
            return;
        }
        this.busy = true;
        void task();
    }

    private settlePending(): void {
        this.busy = false;
        this.runNext();
    }

    /** Reject the in-flight attempt, clearing its timer. */
    private rejectPending(err: Error): void {
        const pending = this.pending;
        if (!pending) {
            return;
        }
        this.timers.clearTimeout(pending.timer);
        this.pending = undefined;
        pending.reject(err);
    }

    /** Handle a complete (decrypted) plaintext chunk from the connection layer. */
    private handlePlaintext(data: Buffer): void {
        const pending = this.pending;
        if (!pending) {
            return;
        }

        // Garbage that some firmware emits when the connection is unhappy.
        const text = data.toString('latin1');
        if (text === 'AT+NAME?\r' || text === 'AT+ADV?\r') {
            this.rejectPending(new Error('got AT+ notification (bad connection)'));
            return;
        }

        this.notifyBuffer = Buffer.concat([this.notifyBuffer, data]);
        const cmd = pending.command;

        if (this.notifyBuffer.length === cmd.responseSize()) {
            if (cmd.isValidResponse(this.notifyBuffer)) {
                this.timers.clearTimeout(pending.timer);
                this.pending = undefined;
                pending.resolve(cmd.parseResponse(this.notifyBuffer));
            } else {
                // Corrupt frame - retryable.
                this.rejectPending(retryable(new Error('checksum failed')));
            }
        } else if (cmd.isExceptionResponse(this.notifyBuffer)) {
            // The device rejected the request itself - don't retry.
            this.rejectPending(new ModbusError(this.notifyBuffer[2]));
        }
    }

    /**
     * dbus-next forwards stream errors, a failed handshake and a failed "Hello"
     * as an "error" event on the bus. Node turns an unhandled one into an
     * uncaught exception, which would take the whole process down - in compact
     * mode that is js-controller with every other adapter inside it. So treat a
     * broken bus like a disconnected device and let the adapter reconnect.
     *
     * @param err the error dbus-next emitted on the bus
     */
    private handleBusError(err: Error): void {
        if (this.closed) {
            // disconnect() ends the socket, which races a handshake that is
            // still in flight: dbus-next then writes to an ended stream.
            this.log.debug(`D-Bus error while shutting down: ${err.message}`);
            return;
        }
        if (this.busErrorSeen) {
            // A dying stream usually emits more than once.
            this.log.debug(`Further D-Bus error: ${err.message}`);
            return;
        }
        this.busErrorSeen = true;
        this.log.warn(`D-Bus connection to BlueZ failed: ${err.message}`);
        this.handleDisconnect();
    }

    private handleDisconnect(): void {
        if (this.closed) {
            return;
        }
        this.log.warn(`Device ${this.address} disconnected`);
        this.writeChar = undefined;
        this.notifyChar = undefined;
        this.connection = undefined;
        this.rejectPending(new Error('device disconnected'));
        this.onDisconnect();
    }
}

interface RetryError extends Error {
    retryable?: boolean;
}

/** The device returned a MODBUS exception response for a command. */
export class ModbusError extends Error {
    constructor(readonly code: number) {
        super(`MODBUS exception ${code}`);
        this.name = 'ModbusError';
    }
}

/** Tag an error as safe to retry. */
function retryable(err: Error): RetryError {
    (err as RetryError).retryable = true;
    return err;
}
