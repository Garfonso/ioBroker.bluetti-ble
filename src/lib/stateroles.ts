/*
 * Mapping from a device field to the ioBroker state common properties.
 *
 * The roles come from the ioBroker role catalogue
 * (https://github.com/ioBroker/ioBroker.docs/blob/master/docs/en/dev/stateroles.md).
 * Two rules the repository check enforces: a role must exist in the catalogue
 * (E1008) and it has to agree with common.write (E1011) - "value.*" roles are
 * read-only, "level.*" roles are writable.
 */
import { BoolField, EnumField, SerialNumberField, StringField, SwapStringField, VersionField } from './fields';
import type { DeviceField } from './fields';

export interface StateMeta {
    type: ioBroker.CommonType;
    role: string;
    unit?: string;
}

export function stateMeta(field: DeviceField, writable: boolean): StateMeta {
    const name = field.name;
    if (name === 'cell_voltages') {
        return { type: 'string', role: 'json' };
    }
    if (field instanceof BoolField) {
        return { type: 'boolean', role: writable ? 'switch' : 'indicator' };
    }
    if (field instanceof EnumField) {
        // None of the level.mode.* roles (fan, swing, thermostat, ...) fits a
        // power station and plain "level.mode" is not in the role catalogue.
        return { type: 'number', role: writable ? 'level' : 'value' };
    }
    if (field instanceof StringField || field instanceof SwapStringField || field instanceof SerialNumberField) {
        return { type: 'string', role: 'text' };
    }
    if (field instanceof VersionField) {
        return { type: 'number', role: 'value' };
    }
    if (name === 'power_generation') {
        // Total energy the unit produced, not a power reading.
        return { type: 'number', role: 'value.energy.produced', unit: 'kWh' };
    }
    if (name.startsWith('battery_range')) {
        // The charge window: "start" is the lower, "end" the upper limit.
        const role = writable ? (name.endsWith('start') ? 'level.battery.min' : 'level.battery.max') : 'value.battery';
        return { type: 'number', role, unit: '%' };
    }
    if (name.endsWith('percent')) {
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
        return { type: 'number', role: writable ? 'level.frequency' : 'value.frequency', unit: 'Hz' };
    }
    // Anything else is a plain number: a setpoint when writable, a reading
    // otherwise. "value" requires common.write = false (E1011).
    return { type: 'number', role: writable ? 'level' : 'value' };
}
