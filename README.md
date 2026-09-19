<img src="admin/bluetti-ble.png" alt="Logo" width="120" align="right" />

# ioBroker.bluetti-ble

[![NPM version](https://img.shields.io/npm/v/iobroker.bluetti-ble.svg)](https://www.npmjs.com/package/iobroker.bluetti-ble)
[![Downloads](https://img.shields.io/npm/dm/iobroker.bluetti-ble.svg)](https://www.npmjs.com/package/iobroker.bluetti-ble)
![Number of Installations](https://iobroker.live/badges/bluetti-ble-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/bluetti-ble-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.bluetti-ble.png?downloads=true)](https://nodei.co/npm/iobroker.bluetti-ble/)

**Tests:** ![Test and Release](https://github.com/Garfonso/ioBroker.bluetti-ble/workflows/Test%20and%20Release/badge.svg)

> **Disclaimer:** This is an independent, community-developed adapter. It is
> **not** affiliated with, endorsed by, or supported by Bluetti / PowerOak.
> "Bluetti" and all related names and logos are trademarks of their respective
> owners and are used here only to describe device compatibility. Use at your
> own risk — the authors are not responsible for any damage to your devices.

## bluetti-ble adapter for ioBroker

> **Renamed:** this adapter was previously published as `bluetti-battery`
> (npm `iobroker.bluetti-battery`). It was renamed to `bluetti-ble` to avoid
> confusion with the separate cloud-based `bluetti` adapter. If you used
> `bluetti-battery`, install `bluetti-ble`, copy your settings (MAC address,
> device type, …) into the new instance, update scripts/visualizations from
> `bluetti-battery.0.*` to `bluetti-ble.0.*`, then remove the old adapter.

Monitor and control Bluetti power stations / batteries over Bluetooth Low Energy
(MODBUS-over-BLE). This is a Node.js/TypeScript port of the protocol from
[bluetti_mqtt](https://github.com/warhammerkid/bluetti_mqtt), integrated directly
into ioBroker so no extra Python service or MQTT broker is required.

### Supported devices

One adapter instance talks to one device.

| Status | Devices |
|--------|---------|
| ✅ Confirmed on real hardware | `AC300`, `AC500` (incl. pack polling and controls) |
| ⚙️ Ported, needs a tester | `AC200M`, `AC200L`, `AC240`, `AC60`, `EP500`, `EP500P`, `EP600`, `EB3A` |
| 🧪 Experimental (fork maps / unverified) | `AC180`, `AC2A`, `AC70`, `Apex 300`, `V2` (encrypted) |

If your device is in the "needs a tester" or "experimental" row, please report
how it behaves — see [Testing & reporting](#testing--reporting).

### Testing & reporting

This adapter is young and most device profiles have not been verified on real
hardware. Reports are very welcome. Please open a
[Device report](../../issues/new?template=device_report.yml) issue with:

- your device model and the log line `Using device profile: ...`,
- which values/controls are correct, and which are wrong or missing,
- for wrong values, the value the adapter shows **and** the value in the Bluetti
  app (so scaling can be checked),
- debug-level logs (especially `MODBUS exception` / `rejected` warnings, and the
  handshake lines for encrypted `V2` devices).

### Encrypted (v2) devices

Newer Bluetti units use an encrypted BLE handshake (AES-CBC + ECDH). Select the
`V2` device type, or set **Encryption** to `on`, to enable it. This support is a
port of the [nhurman fork](https://github.com/nhurman/bluetti_mqtt) and is
**experimental**: the crypto primitives are unit-tested, but the full handshake
has not been verified against real hardware. Feedback welcome.

The **Apex 300** is a v2 device and auto-detects to the `V2` profile. The
generic V2 register map decodes the common values (state of charge, power,
AC/DC switches, battery voltage); Apex-specific registers are not mapped yet.
If the handshake completes (`Encrypted handshake complete` in the log), use the
`scanRange` tooling to help map the rest.

### Requirements

- Linux host with **BlueZ** (the standard Linux Bluetooth stack). The adapter
  uses [`node-ble`](https://github.com/chrvadala/node-ble), which talks to BlueZ
  over D-Bus — it does **not** grab the HCI adapter exclusively, so it coexists
  with other BLE adapters and the system Bluetooth stack.
- The user running ioBroker needs D-Bus permission to use BlueZ. If you get
  permission errors, add a D-Bus policy for the `iobroker` user (see the
  [node-ble setup notes](https://github.com/chrvadala/node-ble#provide-permissions)).

### Configuration

| Setting | Description |
|---------|-------------|
| MAC address | Bluetooth MAC of the device, e.g. `AA:BB:CC:DD:EE:FF`. |
| Device type | `auto` detects from the advertised BLE name, or pick the model manually. |
| Polling interval | Seconds between reads (default 10). |
| Poll per-pack data | Also read per-pack cell voltages etc. (slower). |

States that map to writable MODBUS registers (e.g. `ac_output_on`,
`dc_output_on`, `ups_mode`) are created with write access; setting them sends a
`WriteSingleRegister` command to the device.

### Finding undocumented registers / controls

Some app settings (e.g. the AC charge-current limit) are newer than the
register maps. The adapter exposes raw MODBUS access via `sendTo` so you can
discover them the same way the original `bluetti-discovery` tool does: dump a
register range, change the setting in the Bluetti app, dump again, and diff.

From the JavaScript adapter / a script (replace `0` with your instance):

```js
// Read specific registers
sendTo('bluetti-ble.0', 'readRegisters', { address: 3019, quantity: 1 }, console.log);

// Scan a range (readable registers only)
sendTo('bluetti-ble.0', 'scanRange', { start: 3000, end: 3120 }, console.log);

// Write a register to test a control (use with care)
sendTo('bluetti-ble.0', 'writeRegister', { address: 3019, value: 10 }, console.log);
```

Workflow to find a setting: `scanRange` the likely control area (around
`2200–2260` and `3000–3120` on AC/EP devices), note the values, change the
setting in the app, `scanRange` again, and look for the register whose value
matches the new setting. Then `writeRegister` to confirm it controls the
setting before it gets a named state.

## Changelog
<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**
-->
### **WORK IN PROGRESS**
* (Garfonso/Claude) renamed adapter from `bluetti-battery` to `bluetti-ble` to distinguish it from the cloud-based `bluetti` adapter

### 0.1.1 (2026-06-23)
* (Garfonso/Claude) add very experimental support for APEX 300.

### 0.1.0 (2026-06-19)
* (Garfonso/Claude) tolerate issues in BLE connection better.
* (Garfonso/Claude) add support for reverse engineering modbus registers via sendTo commands
* (Garfonso/Claude) make modbus polling more robust.
* (Garfonso/Claude) add experimental support for encrypted (v2) devices
* (Garfonso/Claude) initial release

[Older changelogs can be found there](CHANGELOG_OLD.md)

## License
MIT License

Copyright (c) 2026 Garfonso <garfonso@mobo.info>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.