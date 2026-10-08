# Windows TEST acceptance runbook — build, publish, verify, update

This is the checklist for the checks that **cannot** be done in the development sandbox. Every
step here runs on a real Windows 10/11 x64 machine against the real LAN share, because each one
depends on something the sandbox does not have: `cmd.exe`, an SMB share, NTFS file locking, the
Electron binary, and the Owner PC's production data.

**Read the last column before reporting.** An item marked *static only* has been proven by reading
and by unit tests that run on Linux; it has **not** been executed. Saying "the batch script works"
without having run it on Windows is not supported by anything in this repository.

Companion documents: `docs/phase6-windows-test-portable.md` (what the portable build is) and
`docs/phase7-lan-auto-update.md` (the update protocol: manifest, ordering, data safety).

## 0. Scope and ground rules

| | |
|---|---|
| Channel | `test` only. Nothing here publishes a production manifest. |
| Update folder | `\\192.168.103.12\ReportExtractor_Update\TAT QPN\updates` (note the space in `TAT QPN`) |
| Roles | **build machine** = builds, tests, publishes. **Owner PC** = runs and updates itself. |
| Never touched | `data\`, `backups\`, `reports\` on either machine — including `data\tnp.db` |
| Expected launcher | `artifacts\TNP-Defect-Management-TEST-win-x64\TNP Defect Management TEST.exe` |

Do step 2 and step 3 on the build machine, then step 4 to publish, and only then step 5–6 on the
Owner PC. Step 7 are the negative drills that prove the safety claims; skip nothing there, because
the whole design rests on refusing a bad package.

## 1. Build machine prerequisites

Each item is one command; all of them must succeed before anything is built.

```bat
where git
where node
node --version
git --version
```

```powershell
# 1. PowerShell is the only zip tool the publisher uses on Windows.
Get-Command Compress-Archive, Expand-Archive | Format-Table Name, Version
$ExecutionContext.SessionState.LanguageMode      # must be FullLanguage, not ConstrainedLanguage

# 2. The share is readable, writable, and is the folder you think it is.
#    -Path rather than -LiteralPath for New-Item: it has no -LiteralPath parameter set on Windows
#    PowerShell 5.1, and this path contains no wildcard character, so nothing is globbed.
Get-Item -LiteralPath '\\192.168.103.12\ReportExtractor_Update\TAT QPN\updates' | Select-Object FullName
New-Item -ItemType File -Path '\\192.168.103.12\ReportExtractor_Update\TAT QPN\updates\write-probe.tmp' -Force
Remove-Item -LiteralPath '\\192.168.103.12\ReportExtractor_Update\TAT QPN\updates\write-probe.tmp'

# 3. A previous version.json (if any) parses, and says which channel owns this folder.
Get-Content -Raw -LiteralPath '\\192.168.103.12\ReportExtractor_Update\TAT QPN\updates\version.json'
```

**What each proves.** `Compress-Archive` missing or the session in `ConstrainedLanguage` mode
(AppLocker/WDAC on a locked-down corporate PC) stops the publisher with
*"the update package could not be created; no zip tool is available"* — the run dies before
anything is written, which is correct, but it is a share-access or policy problem to solve first,
not a code bug. Creating and removing the probe file is the only meaningful write test: a read-only
SMB mount reports "writable" to `fs.access(W_OK)`, which is why the publisher probes too.

The Electron runtime for the pinned version is downloaded from GitHub. If this machine has no
internet, place `electron-v44.5.1-win32-x64.zip` (or the extracted
`electron-v44.5.1-win32-x64\`) into `.cache\` first — see `docs/phase6-windows-test-portable.md` §7.

## 2. Build the TEST Portable folder

```bat
cd /d D:\TAT TNP\TAT_QPN-main
git status
npm ci
npm run package:portable
```

Verify the assembled folder, not just the exit code:

```powershell
$portable = 'artifacts\TNP-Defect-Management-TEST-win-x64'
Get-ChildItem -LiteralPath $portable | Measure-Object | Select-Object Count
# These are the entries scripts/package-portable.mjs verifies before it declares the build done, so a
# mismatch here is a broken build rather than a wrong checklist. `server-runtime` sits *inside*
# resources\app — checking for it at the top level of the folder is a false alarm.
foreach ($p in "$portable\TNP Defect Management TEST.exe",
               "$portable\resources\app\package.json",
               "$portable\resources\app\dist\desktop\main\main.js",
               "$portable\resources\app\dist\desktop\preload\preload.js",
               "$portable\resources\app\dist\desktop\update\helperMain.js",
               "$portable\resources\app\dist\server\startupSignals.js",
               "$portable\resources\app\dist\src\utils\uncPath.js",
               "$portable\resources\app\server-runtime\server\index.js",
               "$portable\resources\app\server-runtime\package.json",
               "$portable\resources\app\web\index.html",
               "$portable\resources\app\seed\legacy-base-data.json") {
  "{0,-6} {1}" -f (Test-Path -LiteralPath $p), $p
}
Get-Content -Raw -LiteralPath "$portable\resources\app\package.json" |
  ConvertFrom-Json | Select-Object version, tnpBuild
```

The packager ends with `Portable build ready: <path>` — **that line is the authority on the folder
name.** The default is `TNP-Defect-Management-TEST-win-x64` (`scripts/package-portable.mjs`,
`FOLDER_NAME`), while the *launcher inside it* carries spaces (`APP_NAME` + `.exe`). A build made
with `--folder-name=` writes elsewhere, and `BUILD_AND_PUBLISH_TNP_TEST.bat` then needs
`set "TNP_PORTABLE_DIR=<that path>"` before it can find the launcher; `tests/portable/packageContract.test.ts`
pins the two files to the same value so the drift cannot come back unremarked.

**Expected.** `npm run package:portable` runs `build`, `build:server`, `build:desktop` and then
`scripts/package-portable.mjs`, which refuses to ship the company workbook or any `data\`,
`backups\`, `reports\` folder and verifies the 191-record seed before writing anything. All five
`Test-Path` checks must be `True` — the last two are the ones a partial build loses: the packaged
server handshake and the shared UNC rule module the desktop main process imports. `version` and
`tnpBuild` are what the client will later report as its installed build.

Also confirm nothing was created inside the production folders:

```powershell
Get-ChildItem -LiteralPath ".\artifacts\TNP-Defect-Management-TEST-win-x64" -Recurse -Directory |
  Where-Object { $_.Name -in 'data', 'backups', 'reports' } | Select-Object FullName   # must print nothing
```

## 3. Check the LAN update folder from the client side

Before publishing anything, use the app's own check — it distinguishes states a copy-paste of a path
cannot: **System page → Desktop → "LAN update folder" → Check update folder**.

| State shown | Meaning | What to do |
|---|---|---|
| `not-configured` | checking is switched off | normal, not an error |
| `unreachable` | host, share or network | `Test-NetConnection 192.168.103.12 -Port 445` |
| `not-readable` | folder exists, this PC may not read it | share/NTFS permissions for this account |
| `no-manifest` | reachable, nothing published yet | expected before the first publish |
| `invalid-manifest` | unparseable, wrong channel, or the announced package is missing or the wrong size | a half-finished publish — do not "fix" the manifest by hand; re-publish |

Then the same folder from the publisher's side, which additionally proves write permission and
reports the build number that would be used next:

```bat
node dist-desktop\desktop\update\publish.js --target "\\192.168.103.12\ReportExtractor_Update\TAT QPN\updates" --channel test --check-only
```

**Expected.** Lines of the form `target`, `kind` (`UNC, 2 segments deep`), `reachable: yes`,
`writable: yes`, `published: build N (channel test)` or `nothing yet`, `next build: M`, then
`the update folder is usable.` and **exit code 0** (`echo %errorlevel%`). A folder whose manifest
says `production` must print `BLOCKED: the folder publishes channel "production", not "test".` and
exit 1 — that refusal is the channel-separation rule in action.

## 4. Publish TEST

### 4a. One-click

```bat
BUILD_AND_PUBLISH_TNP_TEST.bat
```

or with an explicit target — **quoted**, which is the single most important keystroke in this
document:

```bat
BUILD_AND_PUBLISH_TNP_TEST.bat "\\192.168.103.12\ReportExtractor_Update\TAT QPN\updates"
```

The script runs, in order: git/node present → expected branch → **refuses a dirty tree** → fetch →
require a safe fast-forward → `npm ci` if needed → typecheck → unit tests → server tests → portable
tests → portable runtime tests → update tests → `npm audit` → `package:portable` → the `--check-only`
pre-flight → publish. Read the log it prints the path of (`artifacts\publish-<stamp>.log`) even when
it succeeds; the order of the `--- step: OK ---` lines is the evidence.

**Expected on success.** `==== PUBLISHED SUCCESSFULLY ====` and exit code 0.
**Expected on any failure.** exactly one `FAILED: …` line, the log stops there, and
**nothing new is in the update folder**. Then deliberately break something — see 7a — and confirm
the run stops at that step instead of continuing to the next gate. The batch file's abort behaviour
is asserted statically in `src/utils/uncPath.test.ts`, which proves the lines are written to stop but
not that `cmd.exe` obeys them; this step is the only way to know.

**Expected side effect, by design.** Publishing advances the build number and writes it back to the
root `package.json`, so the installed build the client reports and the manifest cannot drift. That
makes the working tree dirty, and the *next* run will refuse with "There are uncommitted changes to
tracked files." Commit the bumped `package.json` (or use `--no-bump-build`) — do not work around the
refusal.

### 4b. Manual publish (when you want the steps one at a time)

```bat
npm run package:portable
npm run build:desktop
node dist-desktop\desktop\update\publish.js --source "artifacts\TNP-Defect-Management-TEST-win-x64" --target "\\192.168.103.12\ReportExtractor_Update\TAT QPN\updates" --channel test --project "." --notes "TEST build for Windows acceptance"
```

**Expected.** The step list printed at the end must read exactly:

```
collect-runtime → inspect-tree → create-zip → inspect-archive → sha256 → copy-temp-package →
verify-destination-size → verify-destination-sha256 → rename-package → write-manifest-temp →
replace-manifest-LAST → verify-published-manifest
```

`verify-destination-size` and `verify-destination-sha256` run **on the share**, after the copy, before
the rename — that is what makes a half-copied package impossible to publish.

## 5. Verify the manifest and SHA-256 on the share

```powershell
$share = '\\192.168.103.12\ReportExtractor_Update\TAT QPN\updates'
$m = Get-Content -Raw -LiteralPath "$share\version.json" | ConvertFrom-Json
$m | Select-Object product, channel, version, build, architecture, package, sha256, size, publishedAt

$pkg = Get-Item -LiteralPath "$share\$($m.package)"
"size on share : $($pkg.Length)   manifest: $($m.size)   match: $($pkg.Length -eq $m.size)"
$hash = (Get-FileHash -LiteralPath "$share\$($m.package)" -Algorithm SHA256).Hash.ToLower()
"sha256 on share: $hash"
"sha256 manifest: $($m.sha256)"
"match          : $($hash -eq $m.sha256)"
```

Or from `cmd.exe`, which is what the Owner PC support tooling tends to have:

```bat
certutil -hashfile "\\192.168.103.12\ReportExtractor_Update\TAT QPN\updates\tnp-test-0.2.0-build1-win-x64.zip" SHA256
```

**Expected.**
1. `product` is exactly `TNP Defect Management System`, `channel` is `test`, `architecture` is
   `win-x64`, `build` is the number from step 4, `publishedAt` is now.
2. `package` is **one plain file name** — no `\`, no `..`, no `C:`, no `\\server\share` prefix. A
   manifest that carries a path is refused by every client, so one appearing here means someone
   hand-edited the file.
3. Size and SHA-256 match the file on the share, byte for byte.
4. The folder contains exactly one `.zip` per published build plus `version.json`, and **no
   `.tmp` leftovers**. A stale `version.json.tmp` means the publish died between writing and renaming.

Use `-LiteralPath` everywhere, never `-Path`: bracket and wildcard characters in a path are treated
as patterns by `-Path`, and a spaced folder is not the problem people expect — globbing is.

**What SHA-256 does not prove.** It proves integrity, not authorship. Anyone who can write to this
folder can publish to every PC that reads it. Treat write access to
`\ReportExtractor_Update\TAT QPN\updates` as an admin-level permission.

## 6. Apply the update from the Owner PC

The Owner PC needs no Git, no Node, no internet — the Electron binary is its own runtime.

1. **Before updating, write down the current state:** `version`/`tnpBuild` shown in the app, record
   counts, one named record you can find again, and the number of files in `backups\` and `reports\`.
2. **Back up deliberately** (this is the operator's own safety net, not the updater's job): copy
   `data\tnp.db` while the app is closed.
3. Open **System page → Desktop** and set the **LAN update folder** to
   `\\192.168.103.12\ReportExtractor_Update\TAT QPN\updates`, leave channel `test`, keep checks on,
   save, then use **Check update folder** → expect a reachable state, not `not-readable`.
4. Close and reopen TNP. Within a few seconds the dialog appears:
   *New TNP version available* with current and available version/build and `[Later]` / `[Update]`.
   Check `[Later]` first: nothing changes, the app stays usable, and a restart reminds you again.
5. Reopen and choose **Update**. Watch the stage sequence, which must advance through
   `COPYING → VERIFYING → VALIDATING → STAGING → WAITING_FOR_EXIT → INSTALLING → RESTARTING → COMPLETE`.
   **COPYING shows real byte progress** — `percent` and `transferRate` move because the copy loop
   counts bytes; a progress bar that animates on a timer is a defect. Note whether the app is still
   usable during the copy (it must be).
6. After the restart, verify all of this:
   - the app reports the new build number, and it matches `version.json` `build` from step 5;
   - the record you named in step 1 is present with the same notes, PIC, status and due date;
   - `backups\` and `reports\` have the same file counts as step 1;
   - **`.tnp-update\runtime-backup\` exists and holds the previous runtime**, and
     `.tnp-update\last-update-result.json` says success;
   - `data\desktop-diagnostic.log` has an `update` entry and no new `TNP_FATAL`;
   - LAN clients opening the Owner PC's address still get the UI (not a blank window).
7. Read `.tnp-update\update.log` too — that is the helper's own log, written while TNP was closed,
   and the only record of the swap itself.

**Blank window after update** is the Phase 6/7 failure mode to watch for: the post-update start runs
the same startup verification (server answers on loopback, `/` loads, React mounts into `#root`). If
it renders nothing, stop, keep `.tnp-update\` intact, and send the two logs plus `last-update-result.json`.

**Rollback drill.** Do not test rollback by hand-deleting runtime files — test it by confirming the
means are in place: `.tnp-update\runtime-backup\` holds the *previous* `TNP Defect Management
TEST.exe` and `resources\app`, and `last-update-result.json` records a success. That copy is what a
failed swap restores, and it is runtime-only by construction: it never contains `data\`, and the
updater never restores a database, because rolling the data back to undo a runtime problem would
destroy real work. If you do want to watch the restore path run, publish a package whose
`resources\app` is broken (7l style: remove `startupSignals.js` from the staged copy before the
swap) and confirm the previous build comes back and the data is untouched.

## 7. Negative drills — the refusals are the product

Each one must **refuse**, with the stated outcome. If any of them "succeeds", the update path is not
safe and the result belongs in a bug report, not in a sign-off.

| ID | On which machine | Do this | Expect |
|---|---|---|---|
| 7a | build | run `BUILD_AND_PUBLISH_TNP_TEST.bat` with the target **unquoted** | refuses immediately: *"The update path was split at a space…"*, and **no** `version.json` is written to `…\TAT` |
| 7b | build | `node …publish.js --target \\PC\share\TAT QPN\updates --source …` (unquoted, manual) | `Unexpected argument QPN\updates. Quote a folder path that contains a space…`, exit 1 |
| 7c | build | pass a `--target` that is a drive path, e.g. `C:\updates` | the check-only pre-flight reports it is not a network path; a real publish still requires a usable, writable folder — and only the `test` channel |
| 7d | share | after a good publish, edit one byte inside the `.zip` (append a space with a hex-safe editor) | client refuses at **VERIFYING** (SHA-256 mismatch), deletes the download, and the running runtime is untouched |
| 7e | share | truncate the `.zip` to half its length and fix nothing | refusal on size mismatch at VERIFYING — same outcome, no install |
| 7f | share | hand-edit `version.json` to `"channel": "production"` | the client ignores the manifest entirely (own channel only), no dialog |
| 7g | share | set `package` to `..\evil.zip` or `\\other\share\x.zip` | `invalid-manifest` in the folder check and refusal in the client — the package name must be one plain file name |
| 7h | share | publish, then remove read permission for the Owner PC's account and re-publish | pre-flight `writable: no` → `BLOCKED`, nothing published |
| 7i | build | build a package containing a `data\` folder by hand and try to publish it | `inspect-tree`/`inspect-archive` rejects production content on both the publishing and the installing side |
| 7j | Owner | start the app while the share is unreachable (pull the network cable) | startup is **not** delayed and no dialog appears: one soft-failure line in the diagnostic log, TNP fully usable |
| 7k | build | add a deliberate typecheck error, then run the publish script | stops at the typecheck step; `version.json` on the share keeps its previous `build` number |

7a and 7k exist because the *stopping* behaviour, not the publishing behaviour, is what protects the
share. Neither can be verified in the development sandbox at all: there is no `cmd.exe` here, so the
batch scripts have been read and asserted as text, never executed.

## 8. Line endings — check once per checkout, not once per release

```powershell
$t = [IO.File]::ReadAllText("$PWD\BUILD_AND_PUBLISH_TNP_TEST.bat")
"CRLF={0}  lone LF={1}" -f ([regex]::Matches($t, "`r`n")).Count, ([regex]::Matches($t, "(?<!`r)`n")).Count
git ls-files --eol BUILD_AND_PUBLISH_TNP_TEST.bat UPDATE_AND_BUILD_TNP.bat
```

**Expected:** `lone LF=0`, and `git ls-files --eol` printing `i/lf w/crlf attr/text eol=crlf`. The
blobs stay LF so the repository and every diff stay normal, while `.gitattributes` makes cmd.exe
receive CRLF. A `w/lf` in that output means this checkout predates the attribute — run
`git rm --cached -q .gitattributes && git checkout -- .` or re-clone, or re-save both files as CRLF
in the editor. An LF-only batch file can fail with *"The system cannot find the batch label
specified"* on exactly the `call :fail` / `goto` paths that stop a bad publish.

## 9. What to send back

1. `artifacts\publish-<stamp>.log` from the build machine, and `sha256` + `size` from step 5.
2. `version.json` as it now sits on the share.
3. From the Owner PC: `data\desktop-diagnostic.log`, `.tnp-update\update.log`,
   `.tnp-update\last-update-result.json`.
4. The answers to step 6.6 (record present, file counts, backup folder contents).
5. For every 7x drill: the refusal message verbatim and the exit code. If a drill produced *no*
   refusal, say so explicitly — a silent success is the finding.

## 10. Verified in the sandbox vs still owed to Windows

| Behaviour | Sandbox status | Windows step |
|---|---|---|
| Publisher step order, manifest last, atomic rename | executed against real files | 4b |
| SHA-256/size verification, ZIP-slip rejection, forbidden content | executed | 7d–7i |
| Build-number bump + write-back to `package.json`, channel mismatch refusal, `--check-only` | executed | 3, 4a |
| UNC normalisation, four escaping regimes, quoting rules | executed (`src/utils/uncPath.ts` unit tests) | 7a, 7b |
| `.bat` structure: quoted target, truncation guard, extra-argument guard, every gate ending in `exit /b 1`, pre-flight not passed through `:step` | **static only** — the file text is asserted, cmd.exe is not run | 4a, 7a, 7k |
| CRLF delivery via `.gitattributes` | **static only** — LF in the blob, CRLF in this working tree | 8 |
| Portable assembly, packaged layout, blank-renderer asset regression | executed against a stand-in Electron runtime | 2 |
| `Compress-Archive` / `Expand-Archive` really zipping and unzipping this layout | **not executable here** (no Windows, no PowerShell) | 2, 4b, 6.5 |
| Electron runtime download and `ELECTRON_RUN_AS_NODE=1` helper launch | **not executable here** | 2, 6.5 |
| NTFS file locking during the runtime swap, SMB timeouts, share permissions | **not reproducible here** | 6, 7h, 7j |
| Real Owner-PC end-to-end update over `\\192.168.103.12\…` | **not done** | 6 |

Anything in the last three rows must stay "not verified" in a report until someone runs it on those
machines. The rows above it are reproducible here and are re-run with
`npm test && npm run test:server && npm run test:portable && npm run test:portable-runtime && npm run test:update`.
