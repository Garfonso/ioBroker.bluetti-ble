/**
 * Generic Bluetti "v2" device (byte-addressed, encrypted BLE).
 * Ported from the nhurman fork (core/devices/v2_device.py).
 *
 * EXPERIMENTAL: register map and encryption are unverified on real hardware.
 * Covers the newer encrypted models (e.g. AC180 on recent firmware).
 */
import { ReadHoldingRegisters } from '../commands';
import { DeviceStruct } from '../fields';
import type { EnumMap, FieldValue } from '../fields';
import type { DeviceDefinition } from '../devices';

const ChargingMode: EnumMap = { 0: 'STANDARD', 1: 'SILENT', 2: 'TURBO' };

// Protocol byte-offset bases (ProtocolAddress in the fork).
const BASE_CONFIG = 1;
const HOME_DATA = 100;
const INV_GRID_INFO = 1300;
const INV_LOAD_INFO = 1400;
const PACK_MAIN_INFO = 6000;
const AC_SWITCH = 2011;
const DC_SWITCH = 2012;

// CtrlStatusMask bits.
const AC_ENABLE = 1 << 1;
const DC_ENABLE = 1 << 2;

/** Original field name -> canonical name shared with the classic devices. */
const NAME_MAP: Record<string, string> = {
    ac_switch: 'ac_output_on',
    dc_switch: 'dc_output_on',
    total_pv_power: 'dc_input_power',
    total_grid_power: 'ac_input_power',
    total_ac_power: 'ac_output_power',
    total_dc_power: 'dc_output_power',
    pack_soc: 'total_battery_percent',
    inv_phase0_voltage: 'internal_ac_voltage',
    inv_phase0_current: 'internal_current_one',
    inv_phase0_power: 'internal_power_one',
    grid_phase0_voltage: 'ac_input_voltage',
    grid_frequency: 'ac_input_frequency',
    pack_voltage: 'total_battery_voltage',
    pack_current: 'total_battery_current',
};

export function buildV2Device(type = 'V2'): DeviceDefinition {
    const s = new DeviceStruct(1); // byte-addressed

    // Setters (bitfield status is read separately via ctrl_status).
    s.addBool('ac_switch', AC_SWITCH);
    s.addBool('dc_switch', DC_SWITCH);

    // BaseConfig (logging only - outside the polling ranges).
    s.addUint8('cfg_specs', BASE_CONFIG + 0);
    s.addUint8('cfg_voltage_type', BASE_CONFIG + 1);
    s.addUint('cfg_guest_mode_enabled', BASE_CONFIG + 2);
    s.addUint('cfg_bt_psw_enabled', BASE_CONFIG + 10);
    s.addSwapString('cfg_bt_password', BASE_CONFIG + 12, 9);
    s.addUint('cfg_modbus_version', BASE_CONFIG + 28);
    s.addUint('cfg_protocol_version', BASE_CONFIG + 30);

    // HomeData
    s.addDecimal('pack_voltage', HOME_DATA + 0, 2);
    s.addDecimal('pack_current', HOME_DATA + 2, 1);
    s.addUint('pack_soc', HOME_DATA + 4);
    s.addUint('pack_charging_status', HOME_DATA + 6);
    s.addUint('pack_chg_full_time', HOME_DATA + 8);
    s.addUint('pack_dsg_empty_time', HOME_DATA + 10);
    s.addUint8('pack_cnts', HOME_DATA + 15);
    s.addSwapString('device_model', HOME_DATA + 20, 6);
    s.addSerialNumber('device_sn', HOME_DATA + 32);
    s.addUint8('inv_number', HOME_DATA + 41);
    s.addUint8('inv_power_type', HOME_DATA + 45);
    s.addUint('energy_lines', HOME_DATA + 46);
    s.addUint('ctrl_status', HOME_DATA + 48);
    s.addUint8('grid_parallel_soc', HOME_DATA + 51);
    s.addUint32('total_dc_power', HOME_DATA + 80);
    s.addUint32('total_ac_power', HOME_DATA + 84);
    s.addUint32('total_pv_power', HOME_DATA + 88);
    s.addUint32('total_grid_power', HOME_DATA + 92);
    s.addUint32('total_inv_power', HOME_DATA + 96);
    s.addDecimal32('total_dc_energy', HOME_DATA + 100, 1);
    s.addDecimal32('total_ac_energy', HOME_DATA + 104, 1);
    s.addDecimal32('total_pv_charging_energy', HOME_DATA + 108, 1);
    s.addDecimal32('total_grid_charging_energy', HOME_DATA + 112, 1);
    s.addDecimal32('total_feedback_energy', HOME_DATA + 116, 1);
    s.addEnum('charging_mode', HOME_DATA + 120, ChargingMode);
    s.addUint8('inv_working_status', HOME_DATA + 123);
    s.addUint8('self_sufficiency_rate', HOME_DATA + 129);
    s.addUint('rate_voltage', HOME_DATA + 138);
    s.addUint('rate_frequency', HOME_DATA + 140);

    // Inverter GridInfo
    s.addDecimal('grid_frequency', INV_GRID_INFO + 0, 1);
    s.addUint8('grid_num_phases', INV_GRID_INFO + 25);
    s.addUint('grid_phase0_power', INV_GRID_INFO + 26);
    s.addDecimal('grid_phase0_voltage', INV_GRID_INFO + 28, 1);
    s.addDecimal('grid_phase0_current', INV_GRID_INFO + 30, 1);

    // Inverter LoadInfo
    s.addUint('dc_5v_power', INV_LOAD_INFO + 8);
    s.addDecimal('dc_5v_current', INV_LOAD_INFO + 10, 1);
    s.addUint('dc_12v_power', INV_LOAD_INFO + 12);
    s.addDecimal('dc_12v_current', INV_LOAD_INFO + 14, 1);
    s.addUint('dc_24v_power', INV_LOAD_INFO + 16);
    s.addDecimal('dc_24v_current', INV_LOAD_INFO + 18, 1);
    s.addUint8('inv_num_phases', INV_LOAD_INFO + 59);
    s.addUint('inv_phase0_power', INV_LOAD_INFO + 60);
    s.addDecimal('inv_phase0_voltage', INV_LOAD_INFO + 62, 1);
    s.addDecimal('inv_phase0_current', INV_LOAD_INFO + 64, 1);

    // Pack info
    s.addUint('pack_volt_type', PACK_MAIN_INFO + 0);
    s.addUint8('pack_cnts', PACK_MAIN_INFO + 3);
    s.addDecimal('pack_voltage', PACK_MAIN_INFO + 6, 2);
    s.addDecimal('pack_current', PACK_MAIN_INFO + 8, 1);
    s.addUint8('pack_soc', PACK_MAIN_INFO + 11);
    s.addUint8('pack_soh', PACK_MAIN_INFO + 13);
    s.addUint('pack_avg_temp', PACK_MAIN_INFO + 14);
    s.addUint8('pack_running_status', PACK_MAIN_INFO + 17);
    s.addUint8('pack_charging_status', PACK_MAIN_INFO + 19);
    s.addDecimal('pack_max_chg_voltage', PACK_MAIN_INFO + 20, 2);
    s.addDecimal('pack_max_chg_current', PACK_MAIN_INFO + 22, 1);
    s.addDecimal('pack_max_dsg_current', PACK_MAIN_INFO + 24, 1);

    // Rename to canonical names where a mapping exists.
    for (const f of s.fields) {
        const mapped = NAME_MAP[f.name];
        if (mapped) {
            f.name = mapped;
        }
    }

    s.markWritable([[AC_SWITCH, DC_SWITCH + 1]]);

    return {
        type,
        packNumMax: 1,
        struct: s,
        encrypted: true,
        experimental: true,
        pollingCommands: [
            new ReadHoldingRegisters(HOME_DATA, 67),
            new ReadHoldingRegisters(INV_GRID_INFO, 31),
            new ReadHoldingRegisters(INV_LOAD_INFO, 48),
            new ReadHoldingRegisters(PACK_MAIN_INFO, 31),
        ],
        packPollingCommands: [],
        postParse: (parsed: Record<string, FieldValue>): void => {
            const ctrl = parsed.ctrl_status;
            if (typeof ctrl === 'number') {
                parsed.ac_output_on = (ctrl & AC_ENABLE) !== 0;
                parsed.dc_output_on = (ctrl & DC_ENABLE) !== 0;
            }
        },
    };
}
