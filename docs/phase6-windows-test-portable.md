# Phase 6 — Windows TEST portable build

Phase 6 wraps the Phase 5 server and React UI in a plain Electron folder the owner can copy
anywhere and double-click. It adds **no new business logic, no new data model and no new
screen layout**. Everything Phase 5 established still holds: SQLite is authoritative, the
Node server owns every read and write, LAN is off by default, and the audit trail is
append-only.

> **This is a TEST build.** No sign-in, no encryption, no auto-update, no code signing.
> Anyone who can reach the server can read and change every record.

---

## 1. What the owner gets

`npm run package:portable` produces `artifacts/TNP-Defect-Management-TEST-win-x64/`:

```
TNP Defect Management TEST.exe     double-click to run
*.dll, *.pak, locales/, ...        Electron runtime
resources/app/
  package.json                     Electron entry: dist/desktop/main/main.js
  dist/desktop/main/               compiled desktop main process (CommonJS)
  dist/desktop/preload/            compiled preload bridge
  dist/server/                     modules the desktop imports from server/ (startupSignals)
  server-runtime/                  the Phase 5 server, unchanged (node: builtins only)
  seed/legacy-base-data.json       the 191 canonical records
  web/                             the built React UI
READ ME FIRST.txt                  owner instructions
```

There is no installer, no registry write, no administrator requirement and no GitHub
Release. Deleting the folder removes the app.

`resources/app/dist` is the **whole** of `dist-desktop`, not just its `desktop/` subtree. `tsc`
emits the desktop program with its original directory shape, so
`dist/desktop/main/serverProcess.js` contains `require("../../server/startupSignals")` and
needs `dist/server/` sitting beside it. Copying only the `desktop/` subtree produced a folder
that assembled cleanly and then died on launch with `Cannot find module
'../../server/startupSignals'`. Shipping the compiler output verbatim keeps the entire require
closure intact, including anything the desktop imports from `server/` later.
`tests/portable/runtime.test.ts` assembles a real build and resolves that chain the way Node
does, so this cannot regress silently.

## 2. Where data lives

On first run the app creates three folders **next to the executable**:

| Folder | Contents |
| --- | --- |
| `data/` | `tnp.db`, `tnp.lock`, `desktop-settings.json`, `server.log` |
| `backups/` | daily, pre-import and manual SQLite snapshots |
| `reports/` | report files attached to records |

Copying the whole portable folder therefore copies the entire TEST dataset.

If the folder holding the executable is **not writable** — a read-only share, or a location
Windows protects — the app falls back to the per-user app-data folder and **says so** on the
System page, including the reason. It never relocates data silently. `TNP_DATA_ROOT`
overrides both, which is what the development script uses.

A fresh `data/tnp.db` is created, migrated and filled with exactly the 191 canonical records.
An existing database is preserved and never reseeded.

## 3. Process model

```
Electron main ──spawns──> node (ELECTRON_RUN_AS_NODE) ──> Phase 5 server ──> SQLite
      │                                                        │
      └──────────────── BrowserWindow ──── http://127.0.0.1:<port> ────────┘
```

The desktop **never touches SQLite**. It starts the same server the browser build uses,
waits for a machine-readable handshake, then points the window at it.

- The child is launched with `ELECTRON_RUN_AS_NODE=1`, reusing the Electron binary as a plain
  Node runtime, so the owner needs no separate Node install.
- On startup the server prints one JSON line — `TNP_READY {"port":…}` on success,
  `TNP_FATAL {"reason":"lock"|"port"|"database"|"seed"|"unknown", …}` on refusal — so the
  desktop reports the *actual* port and the *actual* reason instead of parsing the banner or
  showing a blank window.
- The desktop then confirms `GET /api/status` answers before loading the page.
- `app.requestSingleInstanceLock()` plus the Phase 5 database lock mean two copies cannot
  own the same data folder; the second one explains itself and quits.

**Port conflicts.** If something already holds 8787 the desktop does **not** attach to that
stranger — it finds a free port and retries (up to three attempts). A database lock or a
corrupt database is *not* retried, because retrying cannot fix it.

**Unexpected exit.** If the child dies later, the desktop says so in a dialog rather than
leaving a window that silently no longer saves.

## 4. LAN access

Default is loopback only: the server binds `127.0.0.1` and no other PC can reach the data.

The owner turns LAN on from the System page. That writes `data/desktop-settings.json` and
restarts the server bound to `0.0.0.0`. The owner's IP is never hardcoded — the server
reports the usable LAN addresses it detects.

**Windows Firewall.** This app never modifies the firewall. The first LAN start may need the
owner to allow the app on **Private networks** through the Windows prompt; if other PCs still
cannot connect, that is the setting to check.

## 5. Native file bridge

The only Phase 5 limitation Phase 6 removes: the owner can now open a record's attached
report in the Windows default application, and pick a local file to attach through a native
dialog.

The renderer is a web page and is treated as untrusted. Three rules hold:

1. **The page never supplies a path.** The desktop opens a native picker and hands back an
   opaque, single-use, five-minute token. The path stays in the main process.
2. **The desktop never invents a path to open.** It asks the loopback server for
   `GET /api/records/:id/report-path`, which resolves the record's managed report through the
   Phase 5 containment and symlink checks, then re-verifies containment against the managed
   `reports/` folder itself before opening anything.
3. **No shell.** Only `shell.openPath` on a verified managed report. There is no `exec`, no
   command construction from record data, and no general filesystem browser.

`/api/records/:id/report-path` is doubly gated: the server must have been started by the
desktop (`TNP_DESKTOP_BRIDGE=1`) **and** the connection must be loopback. A plain server run
returns 404, and a LAN client gets a security error. No host path ever reaches a LAN client.

The preload exposes exactly nine named channels and no generic `invoke`; `contextIsolation`
is on, `nodeIntegration` is off, `sandbox` is on, popups are denied and the window cannot
navigate away from its own server.

Everything else about reports is unchanged from Phase 5: files are stored inside managed
storage under a server-generated name, a missing file shows an explicit *unavailable* state
instead of silently clearing the link, and unlinking removes the association while keeping
the bytes.

## 6. What Phase 6 deliberately does not do

- No installer, no auto-update, no code signing, no GitHub Release.
- No authentication and no TLS — the build warns about this in the UI and in
  `READ ME FIRST.txt`.
- No change to the import rule, TAT rule, priority sorting, audit shape, backup retention or
  report-link identity. Phase 5 behaviour is preserved as approved.
- No destructive one-click restore. Backups are snapshots you copy back by hand.
- No Electron-based access to arbitrary files on the owner's PC.

## 7. Building it

```bash
npm install                 # downloads the Electron runtime for this platform
npm run package:portable    # -> artifacts/TNP-Defect-Management-TEST-win-x64/
```

`package:portable` runs the web build, the server build and the desktop build first. The only
network step is the Electron runtime zip for the **pinned** version (`44.5.1`), fetched from
the official `github.com` release. Options:

| Flag | Effect |
| --- | --- |
| `--zip` | also produce `…-win-x64.zip` (uses PowerShell on Windows) |
| `--platform=win32 --arch=x64` | target runtime (defaults to `win32-x64`) |
| `--electron-version=<v>` | override the pinned version, if ever needed |
| `--out=<dir>` | write the folder somewhere other than `artifacts/` (used by the tests) |
| `--folder-name=<name>` | override the folder name |

Before writing anything, the script verifies the seed contains exactly 191 records and refuses
to ship the company workbook, or any `data/`, `backups/` or `reports/` folder. After
assembling, it verifies the launcher and eight packaged files exist, including
`dist/server/startupSignals.js`.

**If the Electron download is blocked**, the script stops and prints `BLOCKED` with the exact
version and URL it wanted. It does **not** change the pinned version, does **not** substitute a
mirror, and leaves **no** partially built folder behind. Two recoveries, both offline:

- run the same command on the Windows PC that will use the build; or
- place the runtime in `.cache/` yourself, either as the zip
  `electron-v44.5.1-win32-x64.zip` or already extracted into
  `.cache/electron-v44.5.1-win32-x64/`, then re-run. An extracted runtime is used as-is with
  no network access at all.

Everything except that one download is verifiable without it: the assembler, the packaged
layout and the packaged server runtime can all be exercised against a stand-in runtime, and
the packaged server is what actually reads and writes the data.

For wrapper development without packaging: `npm run desktop`.

## 8. Source layout

| Path | Role |
| --- | --- |
| `desktop/main/main.ts` | app lifecycle: single instance, layout, server start, window |
| `desktop/main/paths.ts` | portable data-folder resolution (no Electron API) |
| `desktop/main/settings.ts` | `desktop-settings.json` read/write with safe defaults |
| `desktop/main/serverProcess.ts` | spawn, handshake, health, port retry, clean stop |
| `desktop/main/bridgeCore.ts` | token store, record-id and path validation (no Electron API) |
| `desktop/main/bridge.ts` | the nine IPC channels |
| `desktop/preload/preload.ts` | whitelisted `contextBridge` surface |
| `desktop/types/tnpDesktop.ts` | the shared bridge type |
| `server/startupSignals.ts` | `TNP_READY` / `TNP_FATAL` handshake lines |
| `scripts/package-portable.mjs` | portable folder assembler |
| `tests/portable/runtime.test.ts` | assembles a real build and resolves/loads the packaged require chain |
| `tests/portable/` | layout, settings, bridge security, handshake, packaged contract |

`paths.ts` and `bridgeCore.ts` are deliberately Electron-free so their rules are unit tested
directly.
