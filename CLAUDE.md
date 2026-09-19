# Project notes for Claude

## Commit workflow

- **One commit per feature or fix.** Keep commits small and focused; do not batch
  unrelated changes.
- A commit does **not** need to build or run successfully on its own — work in
  progress is fine to commit.
- **Before committing:** run `npm run lint` (or `npm run lint:fix`) and clean up
  all errors and warnings, then run the tests (`npm run test:ts` and
  `npm run test:package`; also `npm run check` for types).
- Use [Conventional Commits](https://www.conventionalcommits.org/) style subjects
  (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).

## Releasing

- Run the ioBroker repo checker periodically and **before every release**; fix
  all reported errors:
  ```bash
  npx @iobroker/repochecker@latest https://github.com/Garfonso/ioBroker.bluetti-ble/ --local
  ```
  It queries the GitHub API, so it needs network access and a pushed `main`.

## Module system: stay CommonJS — do NOT migrate to ESM

The package is CommonJS (no `"type": "module"`), `tsconfig` uses
`module: commonjs` (extending `@tsconfig/node22` but overriding resolution).
**Keep it that way.** A full ESM migration was attempted (2026-06-15) and
**proven to break the adapter in production** — `npm run test:integration`
failed where CommonJS passed.

Why (so it can be re-explained):

- An adapter installed normally lives under `node_modules/iobroker.<name>/`.
- js-controller runs a `.ts` main by forking it with `-r @alcalzone/esbuild-register`
  (see `getDefaultNodeArgs` in `@iobroker/js-controller-common-db`). That is a
  **CommonJS `require` hook** — it transpiles `.ts` only when loaded via `require()`.
- A CommonJS adapter is `require()`d → the hook transpiles it → it starts. ✅
- An ESM adapter (`"type": "module"`) is loaded via Node's `import`, which the
  `-r` require hook does NOT intercept. Node then falls back to its **native type
  stripping**, which **refuses any `.ts` under `node_modules`** →
  `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` → the adapter process exits 1. ❌
- `@alcalzone/esbuild-register` ships **no ESM loader**, so there is no drop-in fix
  on our side. ESM TS adapters would require js-controller to register an ESM
  loader (`--import`/`register()`), which it currently does not.

Consequences:
- TypeScript 6 is **not** adoptable cleanly: it deprecates the classic `node`
  module resolution that pairs with `module: commonjs` (error TS5107). The only
  TS 6 path that keeps the working runtime is `"ignoreDeprecations": "6.0"`.
  Staying on TS 5.9 is the supported choice; the W0083 repo-checker item is only
  a "newer version available" warning.
- ts-node version is irrelevant to production — **production does not use ts-node**
  (it uses esbuild-register). ts-node is only our local test/dev runner.

## Code style

- **Never mix `type` and value specifiers in one import statement.** The ts-node
  setup ioBroker uses fails to parse e.g. `import { Foo, type Bar } from './x'`.
  Split them: `import { Foo } from './x';` + `import type { Bar } from './x';`.

## Environment quirks

- Repo lives on a VirtualBox `vboxsf` shared folder (no symlinks, root-owned):
  - `npm install` must use `--no-bin-links`.
  - git has `core.fileMode false` set locally to avoid spurious exec-bit diffs.
- Local npm is 12.x, which **does not run dependency install scripts**. This
  breaks `npm run test:integration` for any adapter (not our code): in the
  harness dir `/tmp/test-iobroker.bluetti-ble` js-controller's `install` script
  (`iobroker.js setup first`, creates `iobroker-data/`) and esbuild's binary
  download are skipped. Symptoms: `iobroker-data/iobroker.json: ENOENT`, then
  `esbuild: Failed to install correctly`. Workaround after a failing first run:
  ```bash
  cd /tmp/test-iobroker.bluetti-ble/node_modules/iobroker.js-controller && node iobroker.js setup first
  cd /tmp/test-iobroker.bluetti-ble/node_modules/esbuild && node install.js
  ```
  then rerun `npm run test:integration`. CI uses the Node-bundled npm (< 12),
  so it should be unaffected.

## Project

ioBroker adapter for Bluetti power stations. TypeScript port of the BLE/MODBUS
protocol from [bluetti_mqtt](https://github.com/warhammerkid/bluetti_mqtt).
Runs TS directly, no build step: js-controller transpiles via
`@alcalzone/esbuild-register` (CommonJS); our local tests/dev use `ts-node`.
BLE via `node-ble` (BlueZ/D-Bus). One device per adapter instance. See
`src/lib/` for the protocol layer. See the module-system note above before
touching `tsconfig`/`package.json` module settings.
