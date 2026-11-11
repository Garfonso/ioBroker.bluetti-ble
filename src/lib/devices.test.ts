import { expect } from 'chai';
import { buildDevice, coveredNames, SUPPORTED_TYPES } from './devices';
import type { FieldValue } from './fields';

/*
 * States only exist for fields that a polling command actually reads
 * (coveredNames) or that a profile declares in derivedFields. A field that is
 * neither gets no object, and a setState against a missing object is silently
 * dropped - which is how the v2 AC/DC switches went unnoticed.
 */
describe('device field coverage', () => {
    it('gives every writable field a state', () => {
        for (const type of SUPPORTED_TYPES) {
            const device = buildDevice(type)!;
            const covered = coveredNames(device, device.pollingCommands);
            const derived = device.derivedFields ?? [];
            for (const field of device.struct.fields) {
                if (!field.writable) {
                    continue;
                }
                const hasState = covered.has(field.name) || derived.includes(field.name);
                expect(hasState, `${type}.${field.name} is writable but gets no state`).to.equal(true);
            }
        }
    });

    it('gives every field postParse fills in a state', () => {
        for (const type of SUPPORTED_TYPES) {
            const device = buildDevice(type)!;
            if (!device.postParse) {
                continue;
            }
            // All bits set, so a bitfield hook emits everything it knows.
            const parsed: Record<string, FieldValue> = { ctrl_status: 0xffff };
            device.postParse(parsed);
            const covered = coveredNames(device, device.pollingCommands);
            const derived = device.derivedFields ?? [];
            for (const name of Object.keys(parsed)) {
                const hasState = covered.has(name) || derived.includes(name);
                expect(hasState, `${type}.${name} is written by postParse but gets no state`).to.equal(true);
            }
        }
    });

    it('declares only derived fields that the struct knows and polling misses', () => {
        for (const type of SUPPORTED_TYPES) {
            const device = buildDevice(type)!;
            const covered = coveredNames(device, device.pollingCommands);
            for (const name of device.derivedFields ?? []) {
                expect(
                    device.struct.fields.some(f => f.name === name),
                    `${type}.${name} is declared derived but missing from the struct`,
                ).to.equal(true);
                // Otherwise the entry is dead weight.
                expect(covered.has(name), `${type}.${name} is polled, so it need not be derived`).to.equal(false);
            }
        }
    });

    it('derives the AC and DC output switches on the v2 profiles', () => {
        for (const type of ['V2', 'APEX300']) {
            const device = buildDevice(type)!;
            expect(device.derivedFields, type).to.deep.equal(['ac_output_on', 'dc_output_on']);
        }
    });
});
