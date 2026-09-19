/*
 * ioBroker Bluetti BLE adapter.
 * MODBUS-over-Bluetooth port of warhammerkid/bluetti_mqtt.
 */
import * as utils from '@iobroker/adapter-core';
import { ReadHoldingRegisters, WriteSingleRegister } from './lib/commands';
import { BoolField, EnumField, SerialNumberField, StringField, SwapStringField, VersionField } from './lib/fields';
import type { DeviceField, FieldValue } from './lib/fields';
import { BluetoothClient, ModbusError } from './lib/bluetoothClient';
import { buildDevice, detectFromName, SUPPORTED_TYPES } from './lib/devices';
import type { DeviceDefinition } from './lib/devices';

const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const PACK_SELECT_REGISTER = 3006;
/** Time to wait after switching packs before the new pack data is readable. */
const PACK_SWITCH_DELAY_MS = 3000;
/** Consecutive failed poll cycles tolerated before info.connection drops to false. */
const POLL_FAILURES_BEFORE_DISCONNECT = 3;

class BluettiBle extends utils.Adapter {
    private client?: BluetoothClient;
    private device?: DeviceDefinition;
    private pollTimer?: ioBroker.Timeout;
    private reconnectTimer?: ioBroker.Timeout;
    private polling = false;
    private stopping = false;
    /** Consecutive failed poll cycles (transient BLE errors), for info.connection. */
    private pollFailures = 0;
    /** Register start addresses already warned about (avoid log spam). */
    private readonly modbusWarned = new Set<number>();
    /** Pack numbers whose objects have been created. */
    private readonly createdPacks = new Set<number>();

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'bluetti-ble' });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        await this.setState('info.connection', { val: false, ack: true });

        const mac = (this.config.macAddress || '').trim();
        if (!MAC_RE.test(mac)) {
            this.log.error(`Invalid or missing MAC address: "${mac}". Configure it in the adapter settings.`);
            return;
        }
        if (!(this.config.pollInterval > 0)) {
            this.config.pollInterval = 10;
        }

        this.subscribeStates('*');
        await this.connectLoop(mac);
    }

    /**
     * Connect with retry, then build objects and start polling.
     *
     * @param mac
     */
    private async connectLoop(mac: string): Promise<void> {
        if (this.stopping) {
            return;
        }
        this.client = new BluetoothClient(mac, this.log, () => this.handleDisconnect(mac), {
            setTimeout: (cb, ms) => this.setTimeout(cb, ms),
            clearTimeout: handle => this.clearTimeout(handle),
        });
        try {
            await this.client.connect();
        } catch (err) {
            this.log.warn(`Connection failed: ${(err as Error).message}. Retrying in 15s.`);
            await this.client.disconnect().catch(() => undefined);
            this.scheduleReconnect(mac, 15000);
            return;
        }

        const device = this.resolveDevice(this.client.name);
        if (!device) {
            this.log.error(
                `Could not determine device type. Advertised name: "${this.client.name ?? '?'}". ` +
                    `Set the device type manually in settings. Supported: ${SUPPORTED_TYPES.join(', ')}.`,
            );
            await this.client.disconnect().catch(() => undefined);
            return;
        }
        this.device = device;
        this.log.info(`Using device profile: ${device.type}`);

        const encrypted = this.resolveEncryption(device);
        try {
            await this.client.beginSession(encrypted);
        } catch (err) {
            this.log.warn(`Session setup failed: ${(err as Error).message}. Retrying in 15s.`);
            await this.client.disconnect().catch(() => undefined);
            this.scheduleReconnect(mac, 15000);
            return;
        }

        await this.createObjects(device);
        this.pollFailures = 0;
        await this.setState('info.connection', { val: true, ack: true });
        await this.poll();
    }

    /** Decide whether to use the encrypted v2 protocol (config override wins). */
    private resolveEncryption(device: DeviceDefinition): boolean {
        const mode = (this.config.encryption || 'auto').trim();
        if (mode === 'on') {
            return true;
        }
        if (mode === 'off') {
            return false;
        }
        return !!device.encrypted;
    }

    private resolveDevice(name?: string): DeviceDefinition | undefined {
        const configured = (this.config.deviceType || 'auto').trim();
        if (configured && configured !== 'auto') {
            return buildDevice(configured);
        }
        if (name) {
            const detected = detectFromName(name);
            if (detected) {
                return buildDevice(detected.type);
            }
        }
        return undefined;
    }

    private handleDisconnect(mac: string): void {
        if (this.stopping) {
            return;
        }
        this.pollFailures = 0;
        void this.setState('info.connection', { val: false, ack: true });
        this.clearTimers();
        this.scheduleReconnect(mac, 5000);
    }

    private scheduleReconnect(mac: string, delayMs: number): void {
        if (this.stopping) {
            return;
        }
        this.clearTimers();
        this.reconnectTimer = this.setTimeout(() => {
            void this.connectLoop(mac);
        }, delayMs);
    }

    private clearTimers(): void {
        if (this.pollTimer) {
            this.clearTimeout(this.pollTimer);
            this.pollTimer = undefined;
        }
        if (this.reconnectTimer) {
            this.clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
    }

    // --- Polling --------------------------------------------------------------

    private async poll(): Promise<void> {
        if (this.polling || this.stopping || !this.client?.connected || !this.device) {
            return;
        }
        this.polling = true;
        try {
            const merged: Record<string, FieldValue> = {};
            for (const cmd of this.device.pollingCommands) {
                try {
                    const body = await this.client.perform(cmd);
                    Object.assign(merged, this.device.struct.parse(cmd.startingAddress, body));
                } catch (err) {
                    if (err instanceof ModbusError) {
                        // The device does not support this register range - skip it
                        // and keep polling the rest. Warn once per range, then quietly.
                        const msg = `Device rejected registers ${cmd.startingAddress}+${cmd.quantity} (MODBUS exception ${err.code}); skipping this range`;
                        if (this.modbusWarned.has(cmd.startingAddress)) {
                            this.log.debug(msg);
                        } else {
                            this.modbusWarned.add(cmd.startingAddress);
                            this.log.warn(msg);
                        }
                        continue;
                    }
                    throw err;
                }
            }
            this.device.postParse?.(merged);
            await this.writeValues('', merged);

            if (this.config.pollPacks && this.device.packPollingCommands.length) {
                await this.pollPacks();
            }

            this.pollFailures = 0;
            await this.setState('info.connection', { val: true, ack: true });
        } catch (err) {
            // A single command failing (BLE timeout / corrupt frame) does not mean
            // the link is down. Only report disconnected after several consecutive
            // failed cycles, or immediately if the BLE link actually dropped.
            this.pollFailures++;
            const linkDown = !this.client?.connected;
            const level = linkDown || this.pollFailures >= POLL_FAILURES_BEFORE_DISCONNECT ? 'warn' : 'debug';
            this.log[level](`Polling failed (${this.pollFailures}x): ${(err as Error).message}`);
            if (linkDown || this.pollFailures >= POLL_FAILURES_BEFORE_DISCONNECT) {
                await this.setState('info.connection', { val: false, ack: true });
            }
        } finally {
            this.polling = false;
        }

        if (!this.stopping) {
            this.pollTimer = this.setTimeout(() => void this.poll(), this.config.pollInterval * 1000);
        }
    }

    private async pollPacks(): Promise<void> {
        if (!this.client || !this.device) {
            return;
        }
        const written = new Set<number>();
        for (let pack = 1; pack <= this.device.packNumMax; pack++) {
            try {
                // Select the pack. The device replies with MODBUS exception 5
                // ("acknowledge" - accepted, needs time), which is expected and
                // not a failure. Then wait for the pack data to switch.
                if (this.device.packNumMax > 1) {
                    await this.selectPack(pack);
                    await this.delay(PACK_SWITCH_DELAY_MS);
                }

                const parsed: Record<string, FieldValue> = {};
                for (const cmd of this.device.packPollingCommands) {
                    const body = await this.client.perform(cmd);
                    Object.assign(parsed, this.device.struct.parse(cmd.startingAddress, body));
                }

                // Label by the pack number the device actually reported, so a
                // single pack in any slot lands in the right channel.
                const idx = typeof parsed.pack_num === 'number' && parsed.pack_num > 0 ? parsed.pack_num : pack;
                if (written.has(idx)) {
                    continue;
                }
                written.add(idx);
                await this.ensurePackObjects(idx);
                await this.writeValues(`packs.${idx}.`, parsed);
            } catch (err) {
                if (err instanceof ModbusError) {
                    this.log.debug(`Pack ${pack} read rejected (MODBUS exception ${err.code})`);
                    continue;
                }
                throw err;
            }
        }
    }

    /** Select a pack for reading, tolerating the "acknowledge" exception. */
    private async selectPack(pack: number): Promise<void> {
        try {
            await this.client!.perform(new WriteSingleRegister(PACK_SELECT_REGISTER, pack));
        } catch (err) {
            // Exception 5 (acknowledge) is the normal response to a pack switch.
            if (!(err instanceof ModbusError)) {
                throw err;
            }
        }
    }

    /** Create the channel + states for a pack the first time it responds. */
    private async ensurePackObjects(pack: number): Promise<void> {
        if (!this.device || this.createdPacks.has(pack)) {
            return;
        }
        this.createdPacks.add(pack);
        await this.setObjectNotExistsAsync(`packs.${pack}`, {
            type: 'channel',
            common: { name: `Battery pack ${pack}` },
            native: {},
        });
        const packNames = this.coveredNames(this.device, this.device.packPollingCommands);
        for (const field of packNames.values()) {
            await this.createStateObject(`packs.${pack}.`, field, this.device);
        }
    }

    private async writeValues(prefix: string, values: Record<string, FieldValue>): Promise<void> {
        for (const [name, value] of Object.entries(values)) {
            const val = Array.isArray(value) ? JSON.stringify(value) : value;
            await this.setState(`${prefix}${name}`, { val, ack: true });
        }
    }

    // --- Object creation ------------------------------------------------------

    private async createObjects(device: DeviceDefinition): Promise<void> {
        const rootNames = this.coveredNames(device, device.pollingCommands);
        for (const field of rootNames.values()) {
            await this.createStateObject('', field, device);
        }
        // Pack channels/states are created on demand as packs respond (see
        // ensurePackObjects), so disconnected packs do not produce empty objects.
    }

    /**
     * Unique field-name -> representative field, for fields covered by the commands.
     *
     * @param device
     * @param cmds
     */
    private coveredNames(device: DeviceDefinition, cmds: ReadHoldingRegisters[]): Map<string, DeviceField> {
        const map = new Map<string, DeviceField>();
        const bpa = device.struct.bytesPerAddress;
        for (const field of device.struct.fields) {
            const span = Math.ceil(field.byteLength / bpa);
            const covered = cmds.some(c => {
                const units = (c.quantity * 2) / bpa; // response is quantity*2 bytes
                return field.address >= c.startingAddress && field.address + span - 1 <= c.startingAddress + units - 1;
            });
            if (covered && !map.has(field.name)) {
                map.set(field.name, field);
            }
        }
        return map;
    }

    private async createStateObject(prefix: string, field: DeviceField, device: DeviceDefinition): Promise<void> {
        const writable = !prefix && !!device.struct.writableField(field.name);
        const meta = stateMeta(field, writable);
        const common: ioBroker.StateCommon = {
            name: field.name.replace(/_/g, ' '),
            type: meta.type,
            role: field.role ?? meta.role,
            read: true,
            write: writable,
        };
        const unit = field.unit ?? meta.unit;
        if (unit) {
            common.unit = unit;
        }
        if (field.min !== undefined) {
            common.min = field.min;
        }
        if (field.max !== undefined) {
            common.max = field.max;
        }
        if (field.enumMap) {
            common.states = { ...field.enumMap };
        }
        await this.extendObject(`${prefix}${field.name}`, { type: 'state', common, native: {} });
    }

    // --- Controls -------------------------------------------------------------

    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state || state.ack || !this.device || !this.client?.connected) {
            return;
        }
        const name = id.substring(id.lastIndexOf('.') + 1);
        const field = this.device.struct.writableField(name);
        if (!field) {
            return;
        }

        try {
            const register = field.toRegister(state.val);
            await this.client.perform(new WriteSingleRegister(field.address, register));
            this.log.info(`Set ${name} = ${String(state.val)} (register ${field.address} = ${register})`);
            await this.setState(id, { val: state.val, ack: true });
        } catch (err) {
            this.log.warn(`Failed to set ${name}: ${(err as Error).message}`);
        }
    }

    // --- Register tooling (for reverse-engineering controls) -------------------

    /**
     * Message handler used to read/scan/write raw MODBUS registers. Useful for
     * finding undocumented settings: dump a range, change the setting in the
     * Bluetti app, dump again and diff to see which register changed.
     *
     * Commands (obj.command):
     *  - readRegisters { address, quantity }  -> { values: number[] }
     *  - scanRange     { start, end }         -> { registers: { addr: value } }
     *  - writeRegister { address, value }     -> { ok: true }
     *
     * @param obj
     */
    private async onMessage(obj: ioBroker.Message): Promise<void> {
        const respond = (payload: Record<string, unknown>): void => {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, payload, obj.callback);
            }
        };
        if (!this.client?.connected) {
            respond({ error: 'not connected to a device' });
            return;
        }
        const msg = (obj.message ?? {}) as Record<string, unknown>;
        const num = (v: unknown, def = 0): number => (typeof v === 'number' ? v : Number(v) || def);

        try {
            switch (obj.command) {
                case 'readRegisters': {
                    const address = num(msg.address);
                    const quantity = num(msg.quantity, 1);
                    const values = await this.readRegisters(address, quantity);
                    respond({ address, quantity, values });
                    break;
                }
                case 'scanRange': {
                    const start = num(msg.start);
                    const end = num(msg.end, start);
                    const registers = await this.scanRange(start, end);
                    respond({ start, end, registers });
                    break;
                }
                case 'writeRegister': {
                    const address = num(msg.address);
                    const value = num(msg.value);
                    try {
                        await this.client.perform(new WriteSingleRegister(address, value));
                    } catch (err) {
                        // Exception 5 (acknowledge) means the write was accepted.
                        if (!(err instanceof ModbusError)) {
                            throw err;
                        }
                    }
                    respond({ ok: true, address, value });
                    break;
                }
                default:
                    respond({ error: `unknown command "${obj.command}"` });
            }
        } catch (err) {
            respond({ error: (err as Error).message });
        }
    }

    /** Read `quantity` holding registers starting at `address` as uint16 values. */
    private async readRegisters(address: number, quantity: number): Promise<number[]> {
        const body = await this.client!.perform(new ReadHoldingRegisters(address, quantity));
        const values: number[] = [];
        for (let i = 0; i + 1 < body.length; i += 2) {
            values.push(body.readUInt16BE(i));
        }
        return values;
    }

    /** Scan [start, end] in small chunks, returning the readable registers. */
    private async scanRange(start: number, end: number): Promise<Record<number, number>> {
        const result: Record<number, number> = {};
        const chunk = 16;
        for (let addr = start; addr <= end; addr += chunk) {
            const quantity = Math.min(chunk, end - addr + 1);
            try {
                const values = await this.readRegisters(addr, quantity);
                values.forEach((v, i) => (result[addr + i] = v));
            } catch (err) {
                if (!(err instanceof ModbusError)) {
                    throw err;
                }
                // Chunk unreadable as a whole - probe each register individually.
                for (let a = addr; a < addr + quantity; a++) {
                    try {
                        result[a] = (await this.readRegisters(a, 1))[0];
                    } catch (inner) {
                        if (!(inner instanceof ModbusError)) {
                            throw inner;
                        }
                    }
                }
            }
        }
        return result;
    }

    private onUnload(callback: () => void): void {
        this.stopping = true;
        this.clearTimers();
        const done = (): void => {
            try {
                callback();
            } catch {
                /* ignore */
            }
        };
        if (this.client) {
            this.client.disconnect().then(done, done);
        } else {
            done();
        }
    }
}

interface StateMeta {
    type: ioBroker.CommonType;
    role: string;
    unit?: string;
}

function stateMeta(field: DeviceField, writable: boolean): StateMeta {
    const name = field.name;
    if (name === 'cell_voltages') {
        return { type: 'string', role: 'json' };
    }
    if (field instanceof BoolField) {
        return { type: 'boolean', role: writable ? 'switch' : 'indicator' };
    }
    if (field instanceof EnumField) {
        return { type: 'number', role: writable ? 'level.mode' : 'value' };
    }
    if (field instanceof StringField || field instanceof SwapStringField || field instanceof SerialNumberField) {
        return { type: 'string', role: 'text' };
    }
    if (field instanceof VersionField) {
        return { type: 'number', role: 'value' };
    }
    if (name === 'power_generation') {
        return { type: 'number', role: 'value.power.consumed', unit: 'kWh' };
    }
    if (name.endsWith('percent') || name.startsWith('battery_range')) {
        return { type: 'number', role: name.includes('battery') ? 'value.battery' : 'value', unit: '%' };
    }
    if (name.endsWith('power')) {
        return { type: 'number', role: 'value.power', unit: 'W' };
    }
    if (name.includes('voltage')) {
        return { type: 'number', role: writable ? 'level.voltage' : 'value.voltage', unit: 'V' };
    }
    if (name.includes('current')) {
        return { type: 'number', role: writable ? 'level.current' : 'value.current', unit: 'A' };
    }
    if (name.includes('frequency')) {
        return { type: 'number', role: 'value', unit: 'Hz' };
    }
    return { type: 'number', role: 'value' };
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new BluettiBle(options);
} else {
    (() => new BluettiBle())();
}
