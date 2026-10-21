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
  OWN_GITHUB_TOKEN="$(gh auth token)" \
    npx @iobroker/repochecker@latest https://github.com/Garfonso/ioBroker.bluetti-ble/ --local
  ```
  It queries the GitHub API, so it needs network access and a pushed `main`.
  **Always pass the token**: the variable is `OWN_GITHUB_TOKEN` (not
  `GITHUB_TOKEN`). Without it the checker runs unauthenticated, cannot download
  workflow job logs and reports phantom `W3039`/`W3050`/`W3052` warnings; after
  a few runs the anonymous rate limit (60/h) turns those into a `403`
  `E9999 GLOBAL ERROR`.

- **Pre-fill the release news** in `io-package.json` before running
  `npm run release <bump>`, under the key of the *upcoming* version (e.g.
  `"0.2.1"`), translated into all 11 languages. The release-script iobroker
  plugin then logs "current news is already in io-package.json, not changing
  it" and does **not** call the online translator
  (`translator.iobroker.in`/DeepL), which would otherwise abort the release
  with `cli.fatal` when unreachable.
  Do **not** use the plugin's `"NEXT"` shortcut: since `@iobroker/testing` 6
  validates `io-package.json` against the js-controller schema, which allows
  only semver keys, a committed `NEXT` fails `npm run test:package` with
  `/common/news: must NOT have additional properties "NEXT"`.
  Side effect: until that version is on npm, the repo checker reports `E2004`
  ("version listed at common.news does not exist at NPM") - that resolves
  itself with the release.

- **Keep the required versions in sync** whenever one of them is bumped. The
  adapter review checklist wants the minimum node.js version documented in the
  README, so these three must always agree:
  - `package.json` -> `engines.node`
  - `io-package.json` -> `common.dependencies` (`js-controller`) and
    `common.globalDependencies` (`admin`)
  - `README.md` -> first bullet of the "Requirements" section

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

## Dependency: `node-ble` is an alias to a fork

`package.json` pulls the BLE library as

```json
"node-ble": "npm:@naugehyde/node-ble@^1.13.5"
```

The alias keeps the import specifier `node-ble`, so `src/lib/bluetoothClient.ts`
and the hand-written `src/lib/node-ble.d.ts` (`declare module 'node-ble'`) stay
unchanged. **Do not "clean this up"** to a plain `node-ble` dependency.

Why: upstream `node-ble` -> `dbus-next@0.10.2` declares `usocket` as an
*optionalDependency*, and `usocket@0.3.0` lists `node-gyp: ^7.1.2` in its
regular `dependencies` (node-gyp is a build tool and does not belong there).
Consequences on a user's machine:

- **`npm rebuild` / `iobroker rebuild` breaks.** npm prefers the nested
  node-gyp 7 over the system one (12.x), and node-gyp 7 cannot build with a
  modern Python - `distutils` was removed in 3.12. Users had to add a manual
  `overrides` entry to get rebuilds working again.
- node-gyp 7 drags in `request@2.88.2` (deprecated since 2020) and with it
  3 critical + several further advisories.

`usocket` is never used by this adapter: `node-ble` calls `systemBus()` without
options, so `negotiateUnixFd` is false and the bus address is
`unix:path=/var/run/dbus/system_bus_socket`. `dbus-next` takes the `params.path`
branch, `require('usocket')` throws (no bindings built) and it falls back to
`net.createConnection()`. So the whole subtree is dead weight that only breaks
installs.

The fork differs from upstream 1.13.0 in exactly two things: three
`require('dbus-next')` changed to `require('@jellybrick/dbus-next')`, and an
added `Adapter.setPowered()`. `@jellybrick/dbus-next` drops `usocket`
altogether and ships `xml2js ^0.6.2` (upstream pins the vulnerable `^0.4.17`).
Effect: the `node-ble` subtree goes from **122 to 17 packages**, and
`npm audit --omit=dev` from **16 to 4** findings - the remaining 4 are
`node-forge` via `@iobroker/adapter-core` and not ours to fix.

**`overrides` is not a fix here.** npm honours `overrides` only in the *root*
package.json. Ours is ignored as soon as the adapter is installed as a
dependency under `/opt/iobroker`, so it would clean up this repo and CI while
leaving every user's install broken.

Switch back when upstream fixes it: issue
[chrvadala/node-ble#64](https://github.com/chrvadala/node-ble/issues/64) has
been open since 2024-01-31 and the last upstream code commit is 2025-01-19, so
do not hold the release for it. Should `node-ble` ever ship without `usocket`,
drop the alias and verify with `npm ls node-gyp`.

## Code style

- **Never mix `type` and value specifiers in one import statement.** The ts-node
  setup ioBroker uses fails to parse e.g. `import { Foo, type Bar } from './x'`.
  Split them: `import { Foo } from './x';` + `import type { Bar } from './x';`.

## Environment quirks

- Repo lives on a VirtualBox `vboxsf` shared folder (no symlinks, root-owned):
  - `npm install` must use `--no-bin-links`.
  - Side effect: a newly installed package gets **no wrapper in
    `node_modules/.bin`**, so its CLI is "command not found" even though the
    package is there (hit after bumping `@iobroker/testing` to 6: `mocha:
    command not found`). A manual `ln -s` into `.bin` does work, so relink by
    hand, e.g. `ln -s ../mocha/bin/mocha.js node_modules/.bin/mocha`. CI is
    unaffected (`npm ci` there links normally).
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
