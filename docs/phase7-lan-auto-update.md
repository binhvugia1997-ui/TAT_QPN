# Phase 7 — Safe LAN auto-update (TEST channel)

## 1. What this is

The Owner PC can update itself from a shared network folder, with no internet access, no
installer, no Git, no Node and no Python on that machine. A build machine produces a
**runtime-only** package, publishes it to the share, and publishes `version.json` **last**.
Client PCs notice a newer build at startup, copy it, verify it, and swap the application
while preserving every byte of production data.

There are two roles and they must never be confused:

| | Build / test machine | Owner PC |
|---|---|---|
| `data/tnp.db` | test data | **authoritative production data** |
| `backups/` | test snapshots | production snapshots |
| `reports/` | test attachments | production attachments |
| Role | builds, tests, publishes | runs, updates itself |

LAN clients are browsers talking to the Owner PC's server. They have no runtime and no
database of their own, so there is no client-side updater and nothing to distribute to them.

## 2. Version model

The authoritative pair lives in `package.json`:

```json
{ "version": "0.2.0", "tnpBuild": 1 }
```

`version` is a human label. **`tnpBuild` is the only ordering key.** An update is offered when
and only when `remote.build > local.build`. A higher version *label* with an equal build never
triggers an update, and a lower build is never installed. The packager copies both values into
`resources/app/package.json`, which is what the packaged app reads at runtime.

## 3. Manifest

`version.json` on the share, validated strictly — an unexpected shape is rejected, never
coerced:

```json
{
  "product": "TNP Defect Management System",
  "channel": "test",
  "version": "0.2.0",
  "build": 1,
  "architecture": "win-x64",
  "package": "tnp-test-0.2.0-build1-win-x64.zip",
  "sha256": "…64 hex…",
  "size": 12345678,
  "publishedAt": "2026-10-06T09:00:00.000Z",
  "releaseNotes": "optional"
}
```

`product` must be exactly `TNP Defect Management System`; `architecture` must be exactly
`win-x64`. `package` must be one plain `.zip` file name: separators, `..`, drive letters
(`C:`) and UNC prefixes (`\\server\…`) are all rejected, so a hostile manifest cannot make a
client read or write outside the update folder.

**Channel separation.** This phase publishes `test` only. A client accepts only its own
channel and ignores any other manifest, so a TEST publish can never overwrite or be picked up
as a future production manifest. Production would be a different folder *and* a different
channel value.

## 4. Where the update files live

Everything the updater writes goes into one working area next to the runtime:

```
<TNP folder>/
  TNP Defect Management TEST.exe      ← runtime (replaced by an update)
  ffmpeg.dll, libEGL.dll, …           ← runtime
  resources/app/…                     ← runtime
  .tnp-update/                        ← updater working area (never packaged, never backed up)
    download/     the copied package, then its SHA256 check
    staging/      the extracted, validated candidate runtime
    runtime-backup/  rollback copy of the RUNTIME only
    update-plan.json, update.log, last-update-result.json
  data/      ← PRODUCTION: tnp.db, tnp.lock, desktop-settings.json, logs
  backups/   ← PRODUCTION: SQLite snapshots
  reports/   ← PRODUCTION: attached report files
```

Update packages are never stored in `data/`, `backups/` or `reports/`. Those are production
state: putting a package there would drag it into the backup set and into the owner's own file
copies.

### Two different backups

| | SQLite data backup | Runtime rollback copy |
|---|---|---|
| Where | `backups/` | `.tnp-update/runtime-backup/` |
| Made by | the server's `BackupService` | the updater |
| Contains | the production database | exe, DLLs, `resources/app` |
| Purpose | recover owner data | undo a failed runtime swap |

A failed update rolls the **application** back. It never restores a database, because rolling
the database back to undo a runtime problem would destroy real work.

## 5. Publishing

`BUILD_AND_PUBLISH_TNP_TEST.bat ["\\SERVER\Share\TAT QPN\updates"]`

With no argument it publishes to the default test folder, which is itself a spaced path:

```
\\192.168.103.12\ReportExtractor_Update\TAT QPN\updates
```

1. verify `git` and `node` are present
2. verify the branch is the expected one
3. **refuse** if any tracked file has uncommitted changes
4. `git fetch`, then require a **safe fast-forward** (`git merge --ff-only`, which can only move
   the pointer forward and refuses rather than reconciling histories)
5. run every gate: typecheck, unit/business tests, server tests, portable tests, portable
   runtime tests, update tests, `npm audit`
6. `npm run package:portable` — build the win-x64 portable TEST runtime
7. **pre-flight the update folder** — `publish.js --target <share> --check-only`, which reports
   reachability, the current published build, and the build that *would* be used, and refuses to
   continue if the folder cannot be written or belongs to another channel
8. `node dist-desktop/desktop/update/publish.js --source <portable> --target <share> --project <repo>`

The publisher then runs, in this fixed order:

```
collect-runtime → inspect-tree → create-zip → inspect-archive → sha256
→ copy-temp-package → verify-destination-size → verify-destination-sha256
→ rename-package → write-manifest-temp → replace-manifest-LAST → verify-published-manifest
```

The package is copied under a `.tmp` name, its size and SHA256 are re-checked **at the
destination**, and only then is it renamed into place. The manifest is written to
`version.json.tmp` and renamed over the real file **last**, so a client can never read a
manifest that points at a package which is not fully present. If any step fails, the previously
published manifest stays exactly as it was.

Before anything is written the publisher also:

- **proves write permission** by creating, reading and removing a probe file. `fs.access(W_OK)`
  reports "writable" on a read-only SMB mount, so the only test that means anything is a write;
- **refuses a channel mismatch**: a folder whose `version.json` says `production` is never replaced
  by a test publish, which is what makes "one folder per channel" a safety rule instead of a
  convention someone has to remember;
- **advances the build number** when the folder is already at or ahead of `package.json`'s
  `tnpBuild`, publishes as the next integer, and writes that number back to `package.json` so the
  client's reported installed build and the manifest cannot drift apart. `--no-bump-build` restores
  the strict rule that `package.json` is the only authority; `--fail-if-exists` refuses any folder
  that already publishes a manifest.

It refuses to publish an equal or older build over a newer one, cleans up `.tmp` files abandoned by
earlier failed runs, and leaves unrelated files on the share alone.

**What the script never does:** `git reset --hard`, `git stash`, `git rebase`, force-push, or
an auto-merge. It never touches `data/`, `backups/` or `reports/`.

`UPDATE_AND_BUILD_TNP.bat` is a developer convenience for the build machine only: fetch,
fast-forward, install, test, build locally. **A production update on the Owner PC never
depends on GitHub** — the Owner PC reads the LAN share and nothing else.

### The path itself is the fragile part

A UNC path has to survive four escaping regimes before it reaches the share — a TypeScript string
literal, JSON on disk, a `cmd.exe` command line, and the Windows path parser — and every failure is
silent. Two rules are load-bearing:

1. **Quote it in batch.** Batch has no backslash escape, so `"..."` is the only thing that keeps
   `\\SERVER\TAT QPN\updates` in one piece. Unquoted, `cmd.exe` splits at the space and the publish
   lands in `\\SERVER\TAT` — which the script now detects and refuses (`…\TAT$` at the top), because
   a manifest in the wrong folder is read by every client as an update that cannot be downloaded.
2. **Normalise it on the way in.** `normalizeUpdateSource` folds `/` to `\`, collapses separator
   runs and drops a trailing separator, and rejects drive letters, `\\?\` / `\\.\` namespace paths,
   `.` / `..` segments, control characters and paths over 260 characters. Case is **preserved**:
   Windows matches these names case-insensitively, so rewriting them would only make the stored
   value disagree with what the operator sees in Explorer.

Both rules live in `src/utils/uncPath.ts`, which the desktop main process and the tests share, so
there is one definition rather than three copies that can drift.

### Checking the folder from the client

Owner PC → Desktop panel → **Check update folder** validates the value in the field without saving
or writing anything, and distinguishes what an operator otherwise cannot tell apart:
`not-configured` (checking is off, normal), `unreachable` (server, share or network), `not-readable`
(the folder exists but this PC may not read it), `no-manifest` (reachable, nothing published yet),
and `invalid-manifest` (unparseable, wrong channel, or a manifest whose package file is missing or
the wrong size — a half-finished publish).

The check is **not** run while the panel loads. Reading a dead share is discovered by SMB timeout,
which can take seconds, and the panel state is read on every open and refresh.

### Manual publish

```
npm run package:portable
node dist-desktop/desktop/update/publish.js --source "artifacts\TNP Defect Management System TEST" --target "\\192.168.103.12\ReportExtractor_Update\TAT QPN\updates" --channel test --project . --notes "…"

# The pre-flight on its own, with nothing written: reachability, write permission,
# the published build, and the build that would be used next.
node dist-desktop/desktop/update/publish.js --target "\\192.168.103.12\ReportExtractor_Update\TAT QPN\updates" --channel test --check-only
```

## 6. The client

### Check

At startup, if the packaged build has an update source configured, the desktop starts a
background check about four seconds after the window opens. It is **non-blocking and
optional**: TNP is fully usable while it runs, and the result never delays or blocks startup.

The source comes from `data/desktop-settings.json` (`updateSource`, `updateChannel`,
`updateChecksEnabled`) and can be overridden for development with `TNP_UPDATE_SOURCE` /
`TNP_UPDATE_CHANNEL`. Nothing is hard-coded. It is configured in the Desktop panel
(System page → Desktop → "LAN update folder").

An unreachable share, a malformed manifest, a wrong channel or a slow source all produce the
same **soft failure**: one line in the diagnostic log, no dialog, no retry storm.

When `remote.build > local.build`, the owner sees:

> **New TNP version available**
> Current: Version 0.2.0 / Build 1
> Available: Version 0.3.0 / Build 2
> `[Later]` `[Update]`

`[Later]` suppresses that build for the rest of the session. The suppression is in memory only,
so restarting TNP is allowed to remind the owner again.

### Install

```
COPYING → VERIFYING → VALIDATING → STAGING → WAITING_FOR_EXIT → (helper) INSTALLING → RESTARTING → COMPLETE
```

Progress is **real byte progress** from the chunked copy loop — `bytesTransferred`,
`totalBytes`, `percent`, `transferRate`, `stage` — not a timer and not an estimate. The
destination is written as `.partial` and renamed only on success.

Before a single runtime file is touched:

1. **VERIFYING** — SHA256 of the copied package must match the manifest, and so must the byte
   count. On mismatch the download is deleted and the running runtime is left completely alone.
2. **VALIDATING** — the ZIP central directory is read directly. Entries are checked for
   ZIP-slip (`..`, absolute paths, drive letters) **before** extraction, then the package is
   inspected: no `data/`, `backups/`, `reports/`, `tnp.db`, `desktop-settings.json`, `.git`,
   `node_modules` or caches; and every required runtime file present, including the launcher,
   the Electron markers, `resources/app`, and the server runtime.
3. **STAGING** — extract into `.tnp-update/staging/`, then re-check on disk: the archive
   listing is not proof the bytes landed. The staged `resources/app/package.json` must identify
   as TNP for win-x64 and must carry the version and build the manifest announced.

### The swap

A running process cannot replace its own executable, and on Windows its DLLs are locked while
it runs. So the desktop spawns the **staged** runtime as a plain Node host:

```
<staging>/TNP Defect Management TEST.exe   (ELECTRON_RUN_AS_NODE=1)
   <staging>/resources/app/dist/desktop/update/helperMain.js --plan <update-plan.json>
```

detached, then asks TNP to quit. The helper's own executable and libraries live in the staging
folder, which the install never touches, so nothing is self-overwritten. No Node, npm or other
tool is needed on the Owner PC — the Electron binary is the runtime.

TNP's `before-quit` handler stops the server child and lets it close SQLite and release its
lock. The helper then:

1. waits for the TNP process to exit (never force-killed while waiting); if it does not exit in
   time the update is abandoned and the working runtime is left untouched
2. copies the current runtime to `.tnp-update/runtime-backup/`
3. replaces the runtime entries from staging — production directories are excluded by
   construction and every path is guarded
4. relaunches TNP
5. on any failure, restores the runtime backup and relaunches the previous build

The helper writes `.tnp-update/last-update-result.json`, which the restarted app reads and
reports.

### Post-update health check

The restarted app runs the normal Phase 6 startup verification: the server child must answer on
loopback, the window must load `/`, and React must actually mount into `#root`. A build that
loads but renders nothing is reported rather than left as a blank window.

The health check must **not** assert a specific record count. The 191 records in
`src/data/legacy-base-data.json` are the fresh-seed count; the Owner PC's production database
holds whatever the owner has entered. "Production records are readable" is the assertion, not a
number.

## 7. Data safety

**Preserved, always:** `data/tnp.db`, `data/tnp.lock`, `data/desktop-settings.json`,
`data/server.log`, `data/desktop-diagnostic.log`, everything in `backups/`, everything in
`reports/`.

**Replaced by an update:** the launcher EXE, the Electron DLLs and resources, `resources/app`.

**Backed up by an update:** the runtime only, into `.tnp-update/runtime-backup/`.

**Never touched:** nothing in `data/`, `backups/` or `reports/` is ever read, moved, renamed,
recreated or deleted by the updater. This is enforced in code, not by convention:

- `resolveUpdateLayout` records the persistent directories as `preservedDirs`
- `runtimeEntryNames` filters them out of the runtime entry list
- `assertNotPreserved` throws before any operation on a preserved path
- `applyRuntime` refuses a staged runtime that contains `data/`, `backups/` or `reports/`
- `verifyPreserved` re-checks after the install and rolls back if anything is missing
- the package inspection rejects production content on both the publishing and the installing
  side

`reports/` is never deleted or replaced, and the report-path containment and symlink protections
in `server/services/safePath.ts` and `reportStorage.ts` are unchanged by this phase.

## 8. SHA256 proves integrity, not authenticity

The SHA256 in the manifest detects corruption and truncation, and it means a client will not
install a package that was partially copied or modified in transit. **It does not prove who
published the package.** Anyone with write access to the update share can replace the package
and recompute its digest. There is no code signing in this phase — adding it needs the owner's
explicit approval and a certificate.

The practical control is therefore access control on the share: write permission on the update
folder is equivalent to the ability to update every client that reads it.

## 9. Diagnostics

Updater events are **not** written to the business Change History. Two separate logs exist:

- `data/desktop-diagnostic.log` — the Phase 6 desktop diagnostic log, `update` stage
- `.tnp-update/update.log` — the helper's own log, written while TNP is closed

Neither is part of the audit trail, and neither is included in an update package.

## 10. Configuration reference

`data/desktop-settings.json`:

```json
{
  "lanEnabled": false,
  "port": 8787,
  "workstationLabel": "",
  "updateSource": "\\\\192.168.103.12\\ReportExtractor_Update\\TAT QPN\\updates",
  "updateChannel": "test",
  "updateChecksEnabled": true
}
```

Empty `updateSource` means update checking is off, which is a normal state rather than an
error. Environment overrides (development only): `TNP_UPDATE_SOURCE`, `TNP_UPDATE_CHANNEL`.

## 11. Tests

| Suite | File | Covers |
|---|---|---|
| §29 client | `tests/update/client.test.ts` | manifest validation, package-name safety, build ordering, the soft-failure check, `[Later]`, the full install path, SHA mismatch, size mismatch, ZIP-slip, forbidden content, missing runtime files, version drift, backup/install/rollback, the helper, the working area |
| §30 publisher | `tests/update/publisher.test.ts` | step ordering with the manifest last, production exclusion, leaky source, the build gate, atomicity, stale temp cleanup, unrelated files preserved, unsafe names, channel validation, CLI contract |
| §31 packaged layout | `tests/update/packageLayout.test.ts` | the real assembled portable build: required entries, launcher name, version/build, identity, the shipped helper, the Phase 6 `startupSignals` regression, the Phase 7 blank-renderer asset regression, publish + extract round trip |
| target checks and the build bump | `tests/update/publisher.test.ts` (Phase E cases) | probe-based write detection, the `…\TAT` truncation guard, channel-mismatch refusal, `--check-only` / `--bump-build` / `--no-bump-build` / `--fail-if-exists` parsing, `package.json` written back on a bump |
| the path rules | `src/utils/uncPath.test.ts` | parsing and normalisation, the four escaping regimes, the IPv4 and illegal-character rules, and a static read of `BUILD_AND_PUBLISH_TNP_TEST.bat` asserting the default target and its quoting |
| client-side folder check | `tests/portable/updateSourceValidation.test.ts` | every state above, the wrong-size package, the other-channel manifest, and that a check never writes |
| bridge wiring | `tests/portable/bridgeChannels.test.ts` | registered channels vs the preload whitelist vs the interface, the push channel staying un-invokable, and the folder check staying out of state loading |

Each suite was verified by **reintroducing the bug it guards** and confirming it fails: removing
the persistent-directory filter fails 9 client tests; removing the publisher's package-name
validation fails the unsafe-name test; reintroducing the Phase 6 copy mistake (with the
assembler's own check weakened) fails 5 packaged-layout tests.

For the Phase E additions the same discipline was applied where a bug was actually found: the path
rules were written first and the implementation was corrected twice by them (a separator-collapse
that left `//server/share` unconverted, and a host-name pattern that rejected every IPv4 literal).
The folder-check states and the bridge wiring assertions are new coverage for behaviour that had
none, not reproductions of a defect that was then fixed.

## 12. Not verified here

The following need real Windows and a real LAN share and are **NOT VERIFIED** in this
environment:

- running `BUILD_AND_PUBLISH_TNP_TEST.bat` on Windows (a `.bat` cannot execute in this sandbox).
  Its new behaviour — the quoted target, the truncation guard, running `--check-only` before the
  publish and `--project` on both calls — is asserted **statically against the file text**
  (`src/utils/uncPath.test.ts`), which proves the lines are present and in order but not that
  `cmd.exe` behaves as documented
- a real end-to-end update on the Owner PC over a UNC share
- the helper launching from a real Electron binary (`ELECTRON_RUN_AS_NODE=1`)
- Windows file-locking behaviour while the helper replaces the runtime
- the Electron download itself, which is blocked in this sandbox

The publisher, the manifest handling, the copy/verify/validate path, the install plan, the
rollback and the helper logic are all exercised here against real files.
