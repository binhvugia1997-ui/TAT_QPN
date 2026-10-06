# TNP Defect Management System — Development Architecture (Phases 1–5)

## 1. Scope and decisions

Phase 1 is a **local-first development web application**. It does not add cloud sync, authentication, a paid API, backend service, production deployment, installer, portable build or executable. Development uses React + TypeScript + Vite; the browser persists business data in IndexedDB. Dependencies are open-source npm packages. The shell uses local system fonts and makes no runtime network requests.

The legacy HTML has been reverse-engineered first; detailed behaviors are in [`legacy-analysis.md`](./legacy-analysis.md). Existing business rules are implemented as pure modules before a full dashboard is started. Any deviation from legacy behavior needs a recorded reason and, where business intent is uncertain, user confirmation.

Phase 2 provides a validated local TNP file-import flow and a compact Records workspace. Phase 3 adds repository-backed Analysis and TAT dashboards plus Corrective Actions and Rejected work views on the shared Records workspace. The approved Phase 2 boundaries and Phase 3 addendum are documented in [`phase2-simplification-review.md`](./phase2-simplification-review.md).

Phase 4 validates the flow against the real TNP export workbook.

**Phase 5 changes the authoritative persistence and runtime architecture, not the approved business behavior.** The browser no longer owns the data: a local Node server owns a SQLite database, and React reaches it through an API data service. Every rule from Phases 1–4 is unchanged — the canonical record model, the 191-record seed, all 34 source fields and `sourceExtras`, the Records workspace, the detail drawer, Home, Analysis, TAT Monitoring, Corrective Actions, Rejected, the effective-TAT rule, priority sorting, the import parser and the strict `status` + `dueDate` matched-record whitelist. Phase 5 adds the server, append-only audit history, optimistic concurrency, SQLite backups, managed report storage and explicit IndexedDB migration. Full detail is in [`phase5-server-runtime.md`](./phase5-server-runtime.md). Release packaging and production deployment remain out of scope.

## 2. Dependency direction

```text
React pages/components (UI state only)
               ↓ calls
        Application services
               ↓ coordinates
    Pure business modules + models
               ↓ repository interface
        IndexedDB repository
               ↓
             Browser
```

- `pages/` and `components/` do not import IndexedDB or read/write `localStorage`.
- `services/records` and `services/import` own normalization, orchestration, duplicate upsert and transaction boundaries.
- `business/` contains side-effect-free status, TAT, duplicate, filter and KPI functions.
- `services/database` is the only IndexedDB boundary. UI code never receives an `IDBDatabase`.
- `models/` defines the canonical record and import-history contracts. `utils/` contains reusable date and ID helpers.
- `i18n/` owns user-facing translations; business values such as status remain source strings rather than UI labels.

## 3. Source data and canonical records

`src/data/legacy-base-data.json` is an extracted, value-preserving copy of all 191 rows and 34 original BASE_DATA fields from the reference HTML. It is read-only seed/reference data; application code does not mutate the imported JSON object. IDs and source text are retained. The database stores normalized copies with an application provenance field (`recordSource`: `legacy-seed`, `import`, or `manual`). Provenance is metadata, not a legacy TNP field.

The canonical `DefectRecord` includes the complete union of:

1. all 34 BASE_DATA fields;
2. all recognized import fields (`mqisCode`, vendor/audit/PLM/initial-countermeasure fields, etc.);
3. user-managed legacy fields (`pic`, `caFileLink`, `notes`);
4. optional source extensions so later import work can preserve recognized fields without requiring UI rendering.

Date-only values are represented as `YYYY-MM-DD | null`; numeric quantities/rates/TAT are normalized to finite numbers or null. The static JSON is not rewritten by normalization. Missing fields in an import patch remain absent (rather than being defaulted to blank), so an absent source column cannot erase stored data. A present empty cell retains its explicit blank/null meaning. `id` is immutable during update/upsert.

See section B in the legacy analysis for per-field meaning, source, editability and legacy screens.

## 4. Persistence design

**Since Phase 5 the authoritative runtime database is SQLite, owned by the local Node server.**
The browser never opens the database file and never receives a path to it. The IndexedDB
design below is retained because the old store still exists in operators' browsers and is
the source for the explicit one-way migration; the runtime code path is
`React → API data service → local Node server → SQLite`. See
[`phase5-server-runtime.md`](./phase5-server-runtime.md) and section 11.

### IndexedDB schema (legacy development store, isolated since Phase 5)

Database name is namespaced for the new app and does not overwrite the legacy database. Stores:

- `records`, key path `id` — canonical records, including seeded reference records;
- `importHistory`, key path `id` — batch-level import summaries;
- `metadata`, key path `key` — schema/seed markers and migration state.

Indexes can be added with a future schema version without changing record IDs. Database opening/upgrading is centralized. Upgrade failures, blocked connections, constraint errors, request errors and transaction aborts reject with typed, meaningful errors; they are not swallowed.

### Seed safety

On startup, seed initialization runs transactionally only when the metadata marker is absent. It adds reference records without overwriting an existing record with the same ID, then records the seed version in the same transaction. It never calls `deleteDatabase`, clears the database or resets records at boot. A partially completed transaction rolls back. `legacy-base-data.json` remains the recovery/reference snapshot. Seed count and skipped ID collisions are reported to the caller instead of silently ignored.

The reference HTML contains `BASE_DATA` only; legacy `overrides`, `newRecords` and `importLog` live in the user’s browser origin. Browsers do not let a Vite development origin silently read another origin’s IndexedDB/localStorage. This project leaves the legacy origin and its data untouched; bringing runtime data across requires an explicit export/import snapshot and user confirmation, not an implicit reset or best-effort migration.

### Write safety

- `addRecord` uses IndexedDB `add`, not `put`, so an ID collision fails rather than overwrites.
- `updateRecord` reads the current record, merges an explicit patch while pinning its original ID, then writes it.
- `bulkUpsert` and import-history persistence are one read/write transaction. Import analysis happens before commit; invalid data or a transaction failure leaves the old database unchanged.
- `deleteRecord` and `clearImportedData` require an explicit confirmation argument at the service boundary. The Phase 1 shell has no destructive controls.
- No automatic localStorage fallback is used for canonical records in the new app: an IndexedDB failure is reported to the caller. This intentionally avoids silently splitting an atomic batch between IndexedDB and quota-limited localStorage. Legacy localStorage data is not removed or modified by this project.

`getAllRecords`, `getRecord`, `addRecord`, `updateRecord`, `deleteRecord`, `bulkUpsert`, `clearImportedData` and `getImportHistory` are exposed through repository/service APIs, not the UI.

## 5. Import and duplicate foundation

The Phase 2 import UI accepts one local `.xlsx`, `.xls` or `.csv` file at a time, using the small open-source SheetJS-compatible `@e965/xlsx` 0.20.3 parser package. `tnpFileParser` reads the first worksheet, scans the first ten rows for the audited header aliases, normalizes canonical fields and reports row/header errors before any write. The exact misspelled source header `Reply expeced date for final countermeasure` maps to `dueDate`. Unknown source columns are shown in the preview and retained under `sourceExtras` on new records; they are never synchronized to existing records. Ambiguous numeric date strings and duplicate identities within a file block the batch rather than being guessed or processed last-row-wins. A read-only preview uses the same matching and whitelist rules as commit. There is no per-file mapping wizard when the known aliases match.

The duplicate module mirrors the legacy key exactly: normalized non-empty Management Number has priority; otherwise the fallback is the lowercase/trimmed composite `registeredDate|plant|partCode|title|defectQty` with the legacy `fp` prefix. Tests cover same/different Management Numbers, blank Management Number fallback matches/non-matches, and repeated imports. Existing IDs are retained on a match. Existing-record TNP sync uses the explicit `buildTnpSyncPatch(existingRecord, importedRow)` whitelist: `status` and `dueDate` only. `dueDate` maps the exact legacy Excel header `Reply expeced date for final countermeasure`; it is the current/effective TAT deadline for applicable open records. `registeredDate` remains the stored historical value on existing records and is used only as the +7-day fallback when the TNP deadline is blank. Other source columns and app-managed fields (including PIC, notes, CA file link, and local corrective information) are never merged into existing records. `UPDATED` is counted only if `status` or `dueDate` changes; otherwise the row is `UNCHANGED`, regardless of unrelated row differences. New records retain every recognized normalized canonical source field plus unknown source extras. Database writes and the import history entry commit atomically.

## 6. Business modules

- `business/status/`: completed status set is exactly `Hoàn thành`, `Đợi duyệt`, `Đợi xét`; `Rejected (xét)` remains a separate rejection predicate and is not treated as completed. Unknown status strings are preserved and treated as open, matching the legacy set-based logic.
- `business/tat/`: the legacy/source rule is `registeredDate + 7 calendar days`. The user-confirmed current rule uses TNP `dueDate` (Excel header `Reply expeced date for final countermeasure`) as the effective deadline for all applicable open records when it contains a valid date; only a blank/missing `dueDate` falls back to `registeredDate + 7`. Completed statuses remain excluded. Dashboard buckets: overdue, due today, one day, two days, later (>2 days) and no deadline. Active records without either source or fallback date appear in the no-deadline bucket. Corrective-action checks continue using the source `dueDate` as its effective current deadline.
- `business/duplicate/`: identity fingerprint and existing-record lookup.
- `business/kpi/`: KPI calculations are pure and independently testable. The overdue count uses the current/effective TAT deadline (source `dueDate`, falling back to `registeredDate + 7`); the legacy on-time denominator behavior is retained.
- `business/filters/`: typed filter/sort functions are separated from page rendering. `parseRecordFilters`, `writeRecordFilters` and `buildRecordsHref` keep dashboard drill-downs on the same filter contract as Records.
- `business/analysis/`: pure top-N category, monthly trend and filtered summary aggregation over canonical records. It applies the existing exact status set and effective-TAT overdue helper; the UI renders CSS bars without adding a chart dependency.
- `business/tat/dashboard.ts`: bucket aggregation and bucket predicates call the existing effective-deadline helper. Active buckets are overdue, due today, one day, two days, later and no deadline; Completed is excluded. It also aggregates overdue counts by Plant.
- `business/corrective/`: selects active follow-up records, exposes missing-PIC / missing-CA-link scopes and returns them in the shared effective-TAT operational priority.
- `business/rejected/`: selects only exact `Rejected (xét)` status and uses the shared TAT priority sorter.

Date calculations use calendar-day arithmetic on date-only values. This preserves the +7-day fallback while avoiding the legacy mixture of UTC and local-midnight parsing around timezone/DST boundaries. All applicable open-record TAT calculations use the current `dueDate` when available. “Today” comes from the user’s local calendar date; tests pass an explicit reference date.

## 7. UI shell and state

The app has routes for Home, Records, Analysis, TAT, Corrective and Rejected. Home remains a compact KPI/plant overview, with direct navigation to all workspaces and drill-downs for Active, Overdue, Rejected and Completed. Records is the primary detailed workspace; it owns the shared table, filter panel, sorting and record-detail drawer. Corrective and Rejected are configurations of that shared Records workspace, not duplicate tables or stores. Completed stays accessible and below active records in the All view.

Analysis and TAT are compact dashboards over the same repository-loaded records. Analysis aggregates registered-month trend, Plant, Project/Model, reason, defect code and exact source status. TAT uses shared effective-deadline/TAT business helpers and shows urgency buckets plus overdue-by-Plant; its bucket links return to the Records table rather than embedding another record list. The shared `RecordFiltersPanel` uses `RecordFilters`/`applyRecordFilters` across Records and both dashboards. Dashboard drill-down URLs serialize those filters plus the selected chart/bucket segment; Records restores them from query parameters. Clear filters returns to the unfiltered active work view.

Corrective exposes open follow-up work ordered with the operational TAT priority engine, plus missing-PIC and missing-CA-link scopes. Its CA link status is visible in the compact table; editing PIC, Remark/Notes, CA File Link, status and deadlines remains in the existing `RecordDetailDrawer` → `RecordService.updateRecord` path. Rejected uses exact `Rejected (xét)` matching and the shared priority sorter. After import or detail edits, `refreshRecords` reloads from `RecordService`; every route receives the updated canonical collection, so Analysis/TAT/Corrective/Rejected require no dashboard cache or re-seed.

The application has no giant mutable global object: route, selected language and filters belong to React/UI state; records and import history come from services/IndexedDB. The shell and operational screens have English, Vietnamese and Korean labels; source field/status values remain unchanged. Dashboard charts use simple local CSS bars and no charting framework.

## 8. Error handling

Parser validation errors identify the source row/field where available and block the full batch. Unreadable-file, save, refresh and import failures show a localized user-facing message; technical causes are available in a collapsed details disclosure. A successful write is distinguished from a later list-refresh failure. Services reject failed operations, and no catch converts a failed write into apparent success.

## 9. Test foundation

Vitest tests pure status/TAT/duplicate/KPI/filters logic and IndexedDB repository operations with `fake-indexeddb`. Required persistence cases include add, update without ID change, reload from a new repository instance, bulk write, import history, and protection against repeated duplicate imports. Tests use isolated database names and never touch the user’s browser data.

## 10. Deferred work

Manual record-entry UI, CSV export and persisted personal filter preferences remain deferred.
Destructive one-click restore/reset is deliberately **not** implemented: backups are listed and
sized, and a restore is a manual operator action taken while the server is stopped.
Authentication, TLS and any public-Internet exposure are out of scope, as are an auto-updater,
code signing, a production release and any deployment. The legacy on-time KPI denominator and
status semantics for `Đợi duyệt` / `Đợi xét` are unchanged and are not redefined by Analysis.

Native Windows file opening and a portable executable were deferred until **Phase 6** and are
now implemented; see section 12.

## 11. Phase 5 server runtime

### Dependency direction

```
React UI → src/services/server (API data service) → HTTP → server/ (Node) → SQLite (data/tnp.db)
```

UI components contain no SQL and no server logic. `ServerRecordRepository` implements the same
`RecordStore` surface the IndexedDB repository did, so the approved `RecordService` runs
unchanged against either backend.

### SQLite schema

`PRAGMA user_version` is the schema level; migrations are an ordered, append-only list and run
once inside a transaction. Version 1 creates `records`, `audit_events`, `import_history`,
`reports`, `report_files`, `backups` and `metadata`.

`records` stores the full canonical record as a JSON `payload` — which keeps all 34 source
fields, `sourceExtras` and any extension field losslessly — plus indexed projection columns
(`mgmt_no`, `status`, `fingerprint`, dates) and a `version` revision counter. Record identity
keeps its type: `id_key` is `number:1` or `string:i-…`, so `1` and `"1"` never collide.
Record ordering mirrors the IndexedDB store (numeric ids first, then string ids) because the
shared identity index is last-entry-wins.

`audit_events` is append-only, enforced by `BEFORE UPDATE` / `BEFORE DELETE` triggers that
`RAISE(ABORT)`.

### Seeding and idempotency

A fresh database is seeded with exactly the 191 canonical records and a seed marker, in one
transaction. An existing database is never reseeded or overwritten; startup is idempotent and
reports `alreadyInitialized`.

### Optimistic concurrency

Every record carries a revision. A write must present the revision it read
(`expectedVersion`); a stale write is rejected with **HTTP 409** and the client refetches, so
two workstations can never silently overwrite each other.

### Audit history

One save produces one grouped event carrying the timestamp, operation, canonical record id,
management number, every changed field with old and new values, the import batch id, the
transport client address and an optional self-declared workstation label. The address and label
identify a connection, **not** a person. Anything that looks like an absolute host path is
reduced to its file name before storage, and report bytes never enter history.

### Backups

Snapshots use SQLite's own online backup API, which is safe on a live WAL database — a plain
file copy is never used. Three kinds exist: an automatic daily snapshot on the first write of
each calendar day, a pre-import snapshot taken before every import transaction, and manual
snapshots. Retention is bounded, so the folder cannot grow without bound.

### Reports

Reports are linked to a canonical record id; the file name is never identity. Stored names are
server-generated and may not contain a path separator, traversal sequence or absolute path.
Containment is verified lexically **and** on the real path, so file and directory symlinks
cannot escape managed storage. A missing file reports an explicit unavailable state and keeps
its link; unlinking removes only the association and leaves the bytes on disk. There is no
general filesystem endpoint.

### Import transaction

`pre-import backup → transaction (match, whitelist sync, audit, import history) → commit`.
Any failure rolls the transaction back, so a partially applied import is impossible. The
matched-record whitelist remains exactly `status` and `dueDate`, enforced by the same shared
module the browser preview uses.

### LAN

The server binds `127.0.0.1` by default. LAN exposure requires an explicit `--lan`,
`TNP_LAN=1` or `data/server.json`, and binds `0.0.0.0`. No owner IP is hardcoded, no firewall
rule is modified, and the status endpoint reports the live bind address, the actual port, the
LAN state and usable LAN URLs. LAN mode has **no authentication and no TLS** and must only be
used on a trusted internal network; other PCs may need the app allowed through the Windows
Private-network firewall. Configuration is deliberately not writable over HTTP, so a LAN client
cannot change it.

### Process ownership

A lock file in `data/` ensures one server owns a data directory at a time. A second start is
refused with an explicit message; a stale lock from a dead process is taken over.

## 12. Phase 6 desktop wrapper

Phase 6 adds an Electron shell around the Phase 5 runtime without changing any Phase 5 rule.
See [`phase6-windows-test-portable.md`](phase6-windows-test-portable.md) for the owner-facing
detail.

### Dependency direction

```
Electron main ─spawn→ node (ELECTRON_RUN_AS_NODE) → Phase 5 server → SQLite
      └──────────── BrowserWindow → http://127.0.0.1:<port> ────────┘
```

The desktop never imports the database layer and never issues SQL. It is a window, a process
supervisor and a native-file bridge. `desktop/main/paths.ts` and `desktop/main/bridgeCore.ts`
import no Electron API, so the layout and security rules are unit tested directly.

### Startup handshake

`server/startupSignals.ts` emits one JSON line per outcome — `TNP_READY {…}` on success and
`TNP_FATAL {reason, message}` on refusal — parsed from **both** stdout and stderr, because a
refusal is written to stderr. This is how the desktop learns the port it actually bound and
distinguishes a database lock from a port conflict from a missing seed. Only a port conflict
is retried, on a freshly probed free port; the desktop never attaches to whatever already
holds the preferred port.

### Portable layout

The data root is the executable's folder when that folder is writable, otherwise the per-user
app-data folder, with the reason surfaced in the UI. `TNP_DATA_ROOT` overrides both. `data/`,
`backups/` and `reports/` sit under that root exactly as in Phase 5.

### Native file bridge

The renderer is untrusted. It cannot pass a filesystem path in: attaching uses an opaque,
single-use, five-minute token minted from a native picker, and opening asks the loopback
server to resolve the record's managed report. `GET /api/records/:id/report-path` is gated on
`config.desktopBridge` **and** a loopback peer address, so a plain server returns 404 and a
LAN client is rejected; the desktop then re-checks containment against the managed folder
before calling `shell.openPath`. There is no `exec`, no `openExternal` and no filesystem
browser. The preload exposes nine named channels, with `contextIsolation` on,
`nodeIntegration` off, `sandbox` on, popups denied and navigation pinned to its own server.

### Static bundle serving

The server serves the built UI from `staticDir`. Bundle assets live in subfolders, so the
static route resolves them with `resolveContainedSubPath`, which permits nesting while still
rejecting traversal, absolute paths, drive letters and symlink escapes. The flat
`resolveContainedPath` remains the rule for reports and backups. A missing asset returns 404;
only a navigation falls back to the SPA entry point, because answering a `.js` request with
`index.html` and HTTP 200 makes the browser refuse to execute it and renders a blank window.

### Packaging

`scripts/package-portable.mjs` assembles a plain folder — Electron runtime plus
`resources/app/{dist,server-runtime,seed,web}` — with no installer and no release. It refuses
to ship the company workbook or any runtime folder, verifies the seed is exactly 191 records,
and verifies the assembled tree.

`resources/app/dist` must be the whole of `dist-desktop`, preserving the layout `tsc` emitted.
The desktop main process requires `../../server/startupSignals`, so `dist/server/` has to sit
beside `dist/desktop/`; copying only the `desktop/` subtree yields a folder that assembles
cleanly and then fails at startup. `tests/portable/runtime.test.ts` assembles a real build
against a stand-in runtime, walks every `require()` in the packaged chain resolving it as Node
would, and actually loads the packaged `serverProcess` and `startupSignals` modules. If the pinned Electron runtime cannot be downloaded the
script reports `BLOCKED` and changes nothing: no version bump, no mirror substitution.
