/**
 * Device register maps + polling commands.
 * Ported from bluetti_mqtt/core/devices/*.py.
 */
import { ReadHoldingRegisters } from './commands';
import { DeviceStruct } from './fields';
import type { EnumMap, FieldValue } from './fields';
import { buildV2Device } from './v2/v2device';

// --- Shared enums (value -> name) ---------------------------------------------

const OutputMode: EnumMap = {
    0: 'STOP',
    1: 'INVERTER_OUTPUT',
    2: 'BYPASS_OUTPUT_C',
    3: 'BYPASS_OUTPUT_D',
    4: 'LOAD_MATCHING',
};
const AutoSleepMode: EnumMap = { 2: 'THIRTY_SECONDS', 3: 'ONE_MINUTE', 4: 'FIVE_MINUTES', 5: 'NEVER' };
const BatteryState: EnumMap = { 0: 'STANDBY', 1: 'CHARGE', 2: 'DISCHARGE' };
const UpsMode: EnumMap = { 1: 'CUSTOMIZED', 2: 'PV_PRIORITY', 3: 'STANDARD', 4: 'TIME_CONTROL' };
const MachineAddress: EnumMap = { 0: 'SLAVE', 1: 'MASTER' };
const LedMode: EnumMap = { 1: 'LOW', 2: 'HIGH', 3: 'SOS', 4: 'OFF' };
const EcoShutdown: EnumMap = { 1: 'ONE_HOUR', 2: 'TWO_HOURS', 3: 'THREE_HOURS', 4: 'FOUR_HOURS' };
const ChargingMode: EnumMap = { 0: 'STANDARD', 1: 'SILENT', 2: 'TURBO' };

// --- Definition type ----------------------------------------------------------

export interface DeviceDefinition {
    type: string;
    /** Max number of battery packs (including internal), for pack polling. */
    packNumMax: number;
    struct: DeviceStruct;
    pollingCommands: ReadHoldingRegisters[];
    /** Commands run once per pack (after selecting the pack via register 3006). */
    packPollingCommands: ReadHoldingRegisters[];
    /** True for v2 devices that require the encrypted BLE handshake. */
    encrypted?: boolean;
    /**
     * True when the register map is unverified (reverse-engineered from community
     * forks, partly guessed). With writeMode "auto" the adapter stays read-only
     * for these, so a wrong register cannot be written by accident.
     */
    experimental?: boolean;
    /** Optional hook to derive virtual fields after parsing (e.g. v2 bitfields). */
    postParse?: (parsed: Record<string, FieldValue>) => void;
}

type Builder = () => DeviceDefinition;

// --- AC200M -------------------------------------------------------------------

const buildAC200M: Builder = () => {
    const s = new DeviceStruct();
    s.addString('device_type', 10, 6);
    s.addSerialNumber('serial_number', 17);
    s.addVersion('arm_version', 23);
    s.addVersion('dsp_version', 25);
    s.addUint('dc_input_power', 36);
    s.addUint('ac_input_power', 37);
    s.addUint('ac_output_power', 38);
    s.addUint('dc_output_power', 39);
    s.addDecimal('power_generation', 41, 1);
    s.addUint('total_battery_percent', 43);
    s.addBool('ac_output_on', 48);
    s.addBool('dc_output_on', 49);

    s.addEnum('ac_output_mode', 70, OutputMode);
    s.addUint('internal_ac_voltage', 71);
    s.addDecimal('internal_current_one', 72, 1);
    s.addUint('internal_power_one', 73);
    s.addDecimal('internal_ac_frequency', 74, 1);
    s.addUint('internal_dc_input_voltage', 86);
    s.addDecimal('internal_dc_input_power', 87, 1);
    s.addDecimal('internal_dc_input_current', 88, 2);

    s.addUint('pack_num_max', 91);
    s.addDecimal('total_battery_voltage', 92, 2);
    s.addUint('pack_num', 96);
    s.addDecimal('pack_voltage', 98, 2);
    s.addUint('pack_battery_percent', 99);
    s.addDecimalArray('cell_voltages', 105, 16, 2);

    s.addUint('pack_num', 3006);
    s.addBool('ac_output_on', 3007);
    s.addBool('dc_output_on', 3008);
    s.addBool('power_off', 3060);
    s.addEnum('auto_sleep_mode', 3061, AutoSleepMode);

    s.markWritable([[3000, 3062]]);
    return {
        type: 'AC200M',
        packNumMax: 3,
        struct: s,
        pollingCommands: [
            new ReadHoldingRegisters(10, 40),
            new ReadHoldingRegisters(70, 21),
            new ReadHoldingRegisters(3001, 61),
        ],
        packPollingCommands: [new ReadHoldingRegisters(91, 37)],
    };
};

// --- AC300 / AC500 / EP500 / EP500P share most of their layout ----------------

interface AcEpOptions {
    type: string;
    packNumMax: number;
    /** EP500/EP500P expose pack_voltage at 92 and pack_battery_percent at 94. */
    ep500Battery?: boolean;
    /** AC300 has a few extra detail registers. */
    ac300Extras?: boolean;
    /** AC240 adds a writable max grid charge current register. */
    gridChargeCurrent?: boolean;
}

const buildAcEp = (opts: AcEpOptions): DeviceDefinition => {
    const s = new DeviceStruct();
    s.addString('device_type', 10, 6);
    s.addSerialNumber('serial_number', 17);
    s.addVersion('arm_version', 23);
    s.addVersion('dsp_version', 25);
    s.addUint('dc_input_power', 36);
    s.addUint('ac_input_power', 37);
    s.addUint('ac_output_power', 38);
    s.addUint('dc_output_power', 39);
    s.addDecimal('power_generation', 41, 1);
    s.addUint('total_battery_percent', 43);
    s.addBool('ac_output_on', 48);
    s.addBool('dc_output_on', 49);

    s.addEnum('ac_output_mode', 70, OutputMode);
    s.addDecimal('internal_ac_voltage', 71, 1);
    s.addDecimal('internal_current_one', 72, 1);
    s.addUint('internal_power_one', 73);
    s.addDecimal('internal_ac_frequency', 74, 2);
    s.addDecimal('internal_current_two', 75, 1);
    s.addUint('internal_power_two', 76);
    s.addDecimal('ac_input_voltage', 77, 1);
    s.addDecimal('internal_current_three', 78, 1, opts.ac300Extras ? [0, 100] : undefined);
    s.addUint('internal_power_three', 79);
    s.addDecimal('ac_input_frequency', 80, 2);
    s.addDecimal('internal_dc_input_voltage', 86, 1);
    s.addUint('internal_dc_input_power', 87);
    // AC500 leaves this unbounded; AC300/EP500/EP500P clamp to 0..15.
    s.addDecimal('internal_dc_input_current', 88, 1, opts.ac300Extras || opts.ep500Battery ? [0, 15] : undefined);

    s.addUint('pack_num_max', 91);
    s.addDecimal('total_battery_voltage', 92, 1);
    if (opts.ep500Battery) {
        s.addDecimal('pack_voltage', 92, 1);
        s.addUint('pack_battery_percent', 94);
        s.addUint('pack_num', 96);
    } else {
        if (opts.ac300Extras) {
            s.addDecimal('total_battery_current', 93, 1);
        }
        s.addUint('pack_num', 96);
        if (opts.ac300Extras) {
            s.addEnum('pack_status', 97, BatteryState);
        }
        s.addDecimal('pack_voltage', 98, 2);
        s.addUint('pack_battery_percent', 99);
    }
    s.addDecimalArray('cell_voltages', 105, 16, 2);
    if (opts.ac300Extras) {
        s.addVersion('pack_bms_version', 201);
    }

    s.addEnum('ups_mode', 3001, UpsMode);
    s.addBool('split_phase_on', 3004);
    s.addEnum('split_phase_machine_mode', 3005, MachineAddress);
    s.addUint('pack_num', 3006);
    s.addBool('ac_output_on', 3007);
    s.addBool('dc_output_on', 3008);
    s.addBool('grid_charge_on', 3011);
    s.addBool('time_control_on', 3013);
    s.addUint('battery_range_start', 3015);
    s.addUint('battery_range_end', 3016);
    if (opts.gridChargeCurrent) {
        s.addUint('max_grid_charge_current', 3019);
        const f = s.fields[s.fields.length - 1];
        f.min = 1;
        f.max = 10; // 10 A in non-pro mode (app limit)
        f.unit = 'A';
        f.role = 'level.current';
    }
    s.addBool('bluetooth_connected', 3036);
    s.addEnum('auto_sleep_mode', 3061, AutoSleepMode);

    s.markWritable([[3000, 3062]]);
    return {
        type: opts.type,
        packNumMax: opts.packNumMax,
        struct: s,
        pollingCommands: [
            new ReadHoldingRegisters(10, 40),
            new ReadHoldingRegisters(70, 21),
            new ReadHoldingRegisters(3001, 61),
        ],
        packPollingCommands: [new ReadHoldingRegisters(91, 37)],
    };
};

// --- AC60 / EP600 (newer register layout) -------------------------------------

interface Ep600Options {
    type: string;
    extended: boolean; // EP600 has extra power/version registers AC60 lacks
}

const buildAc60Ep600 = (opts: Ep600Options): DeviceDefinition => {
    const s = new DeviceStruct();
    s.addUint('total_battery_percent', 102);
    s.addSwapString('device_type', 110, 6);
    s.addSerialNumber('serial_number', 116);
    s.addDecimal('power_generation', 154, 1);
    s.addSwapString('device_type', 1101, 6);
    s.addSerialNumber('serial_number', 1107);
    s.addDecimal('power_generation', 1202, 1);
    if (opts.extended) {
        s.addUint('battery_range_start', 2022);
        s.addUint('battery_range_end', 2023);
        s.addUint('max_ac_input_power', 2213);
        s.addUint('max_ac_input_current', 2214);
        s.addUint('max_ac_output_power', 2215);
        s.addUint('max_ac_output_current', 2216);
    }
    s.addSwapString('battery_type', 6101, 6);
    s.addSerialNumber('battery_serial_number', 6107);
    s.addVersion('bcu_version', 6175);
    if (opts.extended) {
        s.addVersion('bmu_version', 6178);
        s.addVersion('safety_module_version', 6181);
        s.addVersion('high_voltage_module_version', 6184);
    }

    const pollingCommands = [new ReadHoldingRegisters(100, 62)];
    if (opts.extended) {
        pollingCommands.push(new ReadHoldingRegisters(2022, 2));
    }
    return { type: opts.type, packNumMax: 1, struct: s, pollingCommands, packPollingCommands: [] };
};

// --- EB3A ---------------------------------------------------------------------

const buildEB3A: Builder = () => {
    const s = new DeviceStruct();
    s.addString('device_type', 10, 6);
    s.addSerialNumber('serial_number', 17);
    s.addVersion('arm_version', 23);
    s.addVersion('dsp_version', 25);
    s.addUint('dc_input_power', 36);
    s.addUint('ac_input_power', 37);
    s.addUint('ac_output_power', 38);
    s.addUint('dc_output_power', 39);
    s.addUint('total_battery_percent', 43);
    s.addBool('ac_output_on', 48);
    s.addBool('dc_output_on', 49);

    s.addDecimal('ac_input_voltage', 77, 1);
    s.addDecimal('internal_dc_input_voltage', 86, 2);

    s.addUint('pack_num_max', 91);

    s.addBool('ac_output_on', 3007);
    s.addBool('dc_output_on', 3008);
    s.addEnum('led_mode', 3034, LedMode);
    s.addBool('power_off', 3060);
    s.addBool('eco_on', 3063);
    s.addEnum('eco_shutdown', 3064, EcoShutdown);
    s.addEnum('charging_mode', 3065, ChargingMode);
    s.addBool('power_lifting_on', 3066);

    s.markWritable([[3000, 3067]]);
    return {
        type: 'EB3A',
        packNumMax: 1,
        struct: s,
        pollingCommands: [
            new ReadHoldingRegisters(10, 40),
            new ReadHoldingRegisters(70, 21),
            new ReadHoldingRegisters(3034, 1),
            new ReadHoldingRegisters(3060, 7),
        ],
        packPollingCommands: [],
    };
};

// --- AC200L (ported from the ftrueck fork; close to AC200M) -------------------

const buildAC200L: Builder = () => {
    const s = new DeviceStruct();
    s.addString('device_type', 10, 6);
    s.addSerialNumber('serial_number', 17);
    s.addVersion('arm_version', 23);
    s.addVersion('dsp_version', 25);
    s.addUint('dc_input_power', 36);
    s.addUint('ac_input_power', 37);
    s.addUint('ac_output_power', 38);
    s.addUint('dc_output_power', 39);
    s.addDecimal('power_generation', 41, 1);
    s.addUint('total_battery_percent', 43);
    s.addBool('ac_output_on', 48);
    s.addBool('dc_output_on', 49);

    s.addEnum('ac_output_mode', 70, OutputMode);
    s.addUint('internal_ac_voltage', 71);
    s.addDecimal('internal_current_one', 72, 1);
    s.addDecimal('internal_power_one', 73, 1);
    s.addDecimal('internal_ac_frequency', 74, 1);
    s.addDecimal('internal_dc_input_voltage', 86, 1);
    s.addDecimal('internal_dc_input_power', 87, 1);
    s.addDecimal('internal_dc_input_current', 88, 2);

    s.addUint('pack_num_max', 91);
    s.addDecimal('total_battery_voltage', 92, 2);
    s.addUint('pack_num', 96);
    s.addDecimal('pack_voltage', 98, 2);
    s.addUint('pack_battery_percent', 99);
    s.addDecimalArray('cell_voltages', 105, 16, 2);

    s.addUint('pack_num', 3006);
    s.addBool('ac_output_on', 3007);
    s.addBool('dc_output_on', 3008);
    s.addBool('power_off', 3060);
    s.addEnum('auto_sleep_mode', 3061, AutoSleepMode);

    s.markWritable([[3000, 3062]]);
    return {
        type: 'AC200L',
        packNumMax: 3,
        struct: s,
        pollingCommands: [
            new ReadHoldingRegisters(10, 40),
            new ReadHoldingRegisters(70, 21),
            new ReadHoldingRegisters(3001, 61),
        ],
        packPollingCommands: [new ReadHoldingRegisters(91, 37)],
    };
};

// --- AC180 (ported from the semitop7 fork; experimental, 100-range layout) -----

const buildAC180: Builder = () => {
    const s = new DeviceStruct();
    s.addUint('total_battery_percent', 102);
    s.addUint('output_mode', 123); // bitfield: 32 both off, 40 AC on, 48 DC on, 56 both
    s.addUint('dc_output_power', 140);
    s.addUint('ac_output_power', 142);
    s.addUint('dc_input_power', 144);
    s.addUint('ac_input_power', 146);
    // The following live outside the polling range and are logging-only.
    s.addSwapString('device_type', 1101, 6);
    s.addSerialNumber('serial_number', 1107);
    s.addDecimal('power_generation', 1202, 1);
    s.addSwapString('battery_type', 6101, 6);
    s.addSerialNumber('battery_serial_number', 6107);
    s.addVersion('bcu_version', 6175);

    return {
        type: 'AC180',
        packNumMax: 1,
        struct: s,
        experimental: true,
        pollingCommands: [new ReadHoldingRegisters(100, 62)],
        packPollingCommands: [],
    };
};

// --- AC70 / AC2A (ported from semitop7/ftrueck forks; shared layout) -----------

const buildAc70Style = (type: string): DeviceDefinition => {
    const s = new DeviceStruct();
    // Core (100)
    s.addUint('total_battery_percent', 102);
    s.addDecimal('estimated_time_hr', 104, 1);
    s.addSwapString('device_type', 110, 6);
    s.addSerialNumber('serial_number', 116);
    s.addUint('dc_output_power', 140);
    s.addUint('ac_output_power', 142);
    s.addUint('dc_input_power', 144);
    s.addUint('ac_input_power', 146);
    // Input details (1100-1300)
    s.addSwapString('device_type', 1101, 6);
    s.addSerialNumber('serial_number', 1107);
    s.addUint('num_packs_connected', 1209);
    s.addBool('charging_from_internal_dc', 1210);
    s.addUint('internal_dc_input_power', 1212);
    s.addDecimal('internal_dc_input_voltage', 1213, 1);
    s.addDecimal('internal_dc_input_current', 1214, 1);
    s.addBool('charging_from_pack_dc', 1218);
    s.addUint('pack_dc_input_power', 1220);
    s.addDecimal('pack_dc_input_voltage', 1221, 1);
    s.addDecimal('pack_dc_input_current', 1222, 1);
    s.addDecimal('ac_input_frequency', 1300, 1);
    s.addUint('internal_ac_input_power', 1313);
    s.addDecimal('ac_input_voltage', 1314, 1);
    s.addDecimal('ac_input_current', 1315, 1);
    // Output details (1400-1500)
    s.addUint('total_dc_output_power', 1400);
    s.addUint('dc_usb_output_power', 1404);
    s.addUint('dc_12v_output_power', 1406);
    s.addUint('dc_output_uptime_minutes', 1410);
    s.addUint('ac_output_uptime_minutes', 1424);
    s.addDecimal('ac_output_frequency', 1500, 1);
    s.addBool('ac_output_on', 1509);
    s.addUint('battery_inputoutput_power', 1510);
    s.addDecimal('ac_output_voltage', 1511, 1);
    s.addDecimal('ac_output_amps', 1512, 1);
    // Controls (2000)
    s.addBool('ac_output_on', 2011);
    s.addBool('dc_output_on', 2012);
    s.addBool('dc_eco_on', 2014);
    s.addUint('dc_eco_hours', 2015);
    s.addUint('dc_eco_watts', 2016);
    s.addBool('ac_eco_on', 2017);
    s.addUint('ac_eco_hours', 2018);
    s.addUint('ac_eco_watts', 2019);
    s.addEnum('charging_mode', 2020, ChargingMode);
    s.addBool('power_lifting_on', 2021);
    // More controls (2200) - 2225 is read-only (outside writable range)
    s.addBool('grid_enhancement_mode_on', 2225);
    // Battery data (6000/6100)
    s.addDecimal('total_battery_voltage', 6003, 2);
    s.addSwapString('battery_type', 6101, 6);
    s.addSerialNumber('pack_serial_number', 6107);
    s.addDecimal('pack_voltage', 6111, 2);
    s.addUint('pack_battery_percent', 6113);
    s.addVersion('bcu_version', 6175);

    s.markWritable([[2000, 2225]]);
    return {
        type,
        packNumMax: 1,
        struct: s,
        experimental: true,
        pollingCommands: [
            new ReadHoldingRegisters(100, 50),
            new ReadHoldingRegisters(1100, 51),
            new ReadHoldingRegisters(1200, 90),
            new ReadHoldingRegisters(1300, 31),
            new ReadHoldingRegisters(1400, 48),
            new ReadHoldingRegisters(1500, 30),
            new ReadHoldingRegisters(2000, 67),
            new ReadHoldingRegisters(2200, 29),
            new ReadHoldingRegisters(6000, 31),
            new ReadHoldingRegisters(6100, 100),
            new ReadHoldingRegisters(6300, 52),
        ],
        packPollingCommands: [],
    };
};

// --- Registry + detection -----------------------------------------------------

const BUILDERS: Record<string, Builder> = {
    AC200M: buildAC200M,
    AC300: () => buildAcEp({ type: 'AC300', packNumMax: 4, ac300Extras: true, gridChargeCurrent: true }),
    AC500: () => buildAcEp({ type: 'AC500', packNumMax: 6, gridChargeCurrent: true }),
    AC60: () => buildAc60Ep600({ type: 'AC60', extended: false }),
    EP500: () => buildAcEp({ type: 'EP500', packNumMax: 1, ep500Battery: true, gridChargeCurrent: true }),
    EP500P: () => buildAcEp({ type: 'EP500P', packNumMax: 1, ep500Battery: true, gridChargeCurrent: true }),
    EP600: () => buildAc60Ep600({ type: 'EP600', extended: true }),
    EB3A: buildEB3A,
    AC200L: buildAC200L,
    AC180: buildAC180,
    AC70: () => buildAc70Style('AC70'),
    AC2A: () => buildAc70Style('AC2A'),
    AC240: () => buildAcEp({ type: 'AC240', packNumMax: 6, gridChargeCurrent: true }),
    V2: () => buildV2Device(),
    APEX300: () => buildV2Device('APEX300'),
};

/** Supported device types (canonical builder keys). */
export const SUPPORTED_TYPES = Object.keys(BUILDERS);

/** Advertised-name variants that map to a canonical builder type. */
const TYPE_ALIASES: Record<string, string> = {
    AC200PL: 'AC200L',
    AC180P: 'AC180',
    AC70P: 'AC70',
};

// Tolerate leading/trailing non-word characters that some firmware adds around
// the advertised name (e.g. "\x00AC300123\x00"). Longest literals first so e.g.
// EP500P matches before EP500.
const DEVICE_NAME_RE =
    /^[^\w]*(AC200PL|AC200M|AC200L|AC300|AC500|AC240|AC2A|AC180P|AC180|AC70P|AC70|AC60|APEX300|EP500P|EP500|EP600|EB3A)(\d+)[^\w]*$/;

export interface DetectedDevice {
    type: string;
    serial: string;
}

/**
 * Parse an advertised BLE name (e.g. "AC3001234567890123") into type + serial.
 *
 * @param name
 */
export function detectFromName(name: string): DetectedDevice | undefined {
    const match = DEVICE_NAME_RE.exec(name);
    if (!match) {
        return undefined;
    }
    const raw = match[1];
    return { type: TYPE_ALIASES[raw] ?? raw, serial: match[2] };
}

export function buildDevice(type: string): DeviceDefinition | undefined {
    const builder = BUILDERS[type];
    return builder ? builder() : undefined;
}
