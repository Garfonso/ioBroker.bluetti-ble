import { expect } from 'chai';
import { buildDevice, SUPPORTED_TYPES } from './devices';
import { stateMeta } from './stateroles';

/**
 * Roles this adapter may hand out, all of them taken from the ioBroker role
 * catalogue. The repository check rejects anything else with E1008.
 */
const VALID_ROLES = new Set([
    'json',
    'text',
    'indicator',
    'switch',
    'level',
    'level.battery.min',
    'level.battery.max',
    'level.voltage',
    'level.current',
    'level.frequency',
    'value',
    'value.battery',
    'value.energy.produced',
    'value.power',
    'value.voltage',
    'value.current',
    'value.frequency',
]);

describe('state roles', () => {
    it('only uses roles from the catalogue, for every field of every profile', () => {
        for (const type of SUPPORTED_TYPES) {
            const device = buildDevice(type)!;
            for (const field of device.struct.fields) {
                for (const writable of [false, true]) {
                    const role = stateMeta(field, writable).role;
                    expect(VALID_ROLES.has(role), `${type}.${field.name} (writable=${writable}): ${role}`).to.equal(
                        true,
                    );
                }
            }
        }
    });

    it('matches the role to common.write', () => {
        for (const type of SUPPORTED_TYPES) {
            const device = buildDevice(type)!;
            for (const field of device.struct.fields) {
                // A level.* role promises a writable state (E1011) ...
                expect(stateMeta(field, false).role.startsWith('level'), `${type}.${field.name} read-only`).to.equal(
                    false,
                );
                // ... and the read-only roles must not show up on a control.
                if (!device.struct.writableField(field.name)) {
                    continue;
                }
                const writableRole = stateMeta(field, true).role;
                const readOnly = writableRole === 'indicator' || writableRole.startsWith('value');
                expect(readOnly, `${type}.${field.name} writable: ${writableRole}`).to.equal(false);
            }
        }
    });

    it('keeps the roles that were reported by the repository check', () => {
        const device = buildDevice('AC500')!;
        const field = (name: string): (typeof device.struct.fields)[number] =>
            device.struct.fields.find(f => f.name === name)!;

        // "level.mode" is not in the catalogue (E1008).
        expect(stateMeta(field('ups_mode'), true).role).to.equal('level');
        expect(stateMeta(field('auto_sleep_mode'), true).role).to.equal('level');
        expect(stateMeta(field('split_phase_machine_mode'), true).role).to.equal('level');

        // These are writable, so they cannot keep a "value.*" role (E1011).
        expect(stateMeta(field('battery_range_start'), true).role).to.equal('level.battery.min');
        expect(stateMeta(field('battery_range_end'), true).role).to.equal('level.battery.max');
        expect(stateMeta(field('pack_num'), true).role).to.equal('level');

        // Read-only mode keeps the same states readable with a matching role.
        expect(stateMeta(field('battery_range_start'), false).role).to.equal('value.battery');
        expect(stateMeta(field('pack_num'), false).role).to.equal('value');

        // kWh is energy, not power.
        expect(stateMeta(field('power_generation'), false).role).to.equal('value.energy.produced');
    });
});
