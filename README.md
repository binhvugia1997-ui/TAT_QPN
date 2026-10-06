# TNP Defect Management System — Development

Development-only local-first TNP defect tracking workspace. The legacy HTML was audited before implementation; see [`docs/legacy-analysis.md`](docs/legacy-analysis.md), [`docs/architecture.md`](docs/architecture.md) and the approved [`docs/phase2-simplification-review.md`](docs/phase2-simplification-review.md).

## Run locally

```bash
npm ci
npm run dev        # builds the local server, then runs server + Vite
```

`npm run dev` starts the authoritative Node/SQLite server on `127.0.0.1:8787` and the Vite dev
server, which proxies `/api` to it. Other useful commands:

```bash
npm start          # server only (builds first)
npm start:lan      # server bound to 0.0.0.0, for trusted-LAN use
npm run build      # browser bundle into dist/, which the server also serves
```

Since **Phase 5** the authoritative runtime database is **SQLite at `data/tnp.db`, owned by the
local Node server**. The path is:

```
React → API data service → local Node server → SQLite
```

The browser never opens the database file. First run creates the schema, applies migrations and
seeds exactly the 191 canonical records; an existing database is never reseeded or overwritten.
The canonical model retains all 34 original source fields and recognized extensions.

Runtime data lives in `data/`, `backups/` and `reports/` at the project root. All three are
gitignored and outside the build output, so rebuilding never destroys operator data. See
[`docs/phase5-server-runtime.md`](docs/phase5-server-runtime.md).

> LAN access is **off** by default. Enable it explicitly with `--lan` or `TNP_LAN=1` and
> restart. LAN mode has **no authentication and no TLS** — trusted internal networks only, and
> other PCs may need the app allowed through the Windows Private-network firewall.

## Phase 1–3 workspace

- **Home** stays compact and links into Active, Overdue, Completed and Rejected records, plus Analysis, TAT and Corrective workspaces.
- **Records** remains the detailed operational workspace, with shared search/facets, Active / All / Completed views, effective-TAT priority, record detail and TNP import.
- **Analysis** aggregates the current repository records by registered month, Plant, Project / Model, reason, defect code and exact source status. Compact bars and trend columns drill down to `/records` with the selected filters.
- **TAT** uses the shared effective-deadline helper: valid `dueDate`, otherwise `registeredDate + 7` calendar days. Active buckets are Overdue, Today, +1 day, +2 days and Later; Completed records are excluded. Bucket and overdue-by-Plant links open the corresponding Records subset.
- **Corrective Actions** reuses the shared Records table and detail drawer for active/Rejected follow-up. It prioritizes effective TAT, offers compact missing-PIC / missing-CA-link scopes, and edits PIC, Remark/Notes and CA File Link through the existing record service.
- **Rejected** is the exact source-status subset `Rejected (xét)`, kept open for TAT and ordered by effective deadline. Status changes from import or detail editing update the derived list automatically.
- Dashboard filters share one canonical filter model and UI. More-used controls stay visible; date range, month and less-used facets are in More Filters. Drill-down parameters are preserved on the Records URL.
- All modules receive the same canonical records loaded through the repository. There are no dashboard-specific databases, cached record copies, chart packages or cloud services.

The existing-record TNP sync whitelist remains exactly `status` and `dueDate`; `registeredDate` and app-managed values are preserved on a match. Blank incoming `dueDate` still clears the stored value before the confirmed +7 fallback is calculated. That blank-import choice remains unresolved and unchanged.

Existing legacy `overrides`, imported/manual records and import history are scoped to the legacy browser origin; this app does not access or delete them. Cross-origin data needs an explicit, separately confirmed export/import migration.

## Phase 5 acceptance

The local server owns SQLite, append-only audit history, optimistic concurrency, backups and
managed report storage; the browser is a client. Concretely:

- **Concurrency** — every record carries a revision. Saving a stale revision returns
  **HTTP 409**; the drawer refetches and asks the operator to review, so two workstations never
  silently overwrite each other.
- **Audit** — one save produces one grouped event with the changed fields and their old/new
  values. The table is append-only, enforced by SQL triggers. Client address and label identify
  a connection, not a person.
- **Backups** — SQLite online snapshots, automatically each day, before every import, and on
  demand, with bounded retention. Destructive one-click restore is deliberately **not** offered.
- **Reports** — attached to a canonical record id and served only through the server. Traversal,
  encoded traversal, absolute paths and file/directory symlink escapes are all rejected. A
  missing report is reported explicitly and keeps its link; unlinking keeps the stored bytes.
- **Migration** — from the old browser IndexedDB is explicit only: a read-only export, a
  dry run, then `--confirm`. Nothing is migrated automatically.
- **System page** (`/system`) — server status, LAN status and usable URLs, backup control,
  change history, and the browser-data export.

Phase 1–4 behavior is unchanged: the canonical record model, the 191-record seed, all 34 source
fields and `sourceExtras`, Home, Records, Analysis, TAT Monitoring, Corrective Actions,
Rejected, effective TAT, priority sorting and the import parser.

## Phase 6 acceptance — Windows TEST portable build

`npm run package:portable` produces a plain folder in `artifacts/` that the owner copies
anywhere and runs by double-clicking. No installer, no administrator rights, no auto-update,
no GitHub Release. See [`docs/phase6-windows-test-portable.md`](docs/phase6-windows-test-portable.md).

- **Same server, same data** — the desktop starts the Phase 5 server as a child process and
  points a window at `http://127.0.0.1:<port>`. It never opens SQLite itself, and no Phase 5
  rule changed: import, TAT, audit, backups, concurrency and report identity are untouched.
- **Portable data** — `data/`, `backups/` and `reports/` are created next to the executable, so
  copying the folder copies the dataset. If that folder is read-only the app falls back to the
  per-user profile and says so on the System page instead of relocating data silently.
- **Honest startup** — the server prints a machine-readable ready/fatal line, so the desktop
  reports the real port and the real reason (database lock, port in use, bad seed) rather than
  a blank window. A busy port causes a retry on a free port; it never attaches to a stranger.
- **Native reports** — inside the desktop the owner opens a record's report in the Windows
  default application and picks files through a native dialog. The page never supplies a path:
  attach uses a single-use expiring token, open uses the server's managed-report resolution and
  is re-checked against the managed folder. There is no shell and no filesystem browser.
- **Loopback-gated path lookup** — `GET /api/records/:id/report-path` exists only when the
  server was started by the desktop *and* the connection is loopback. A LAN client cannot
  obtain a host path.
- **Still a TEST build** — no authentication, no TLS, no code signing. LAN stays off by
  default; enabling it restarts the server bound to `0.0.0.0`, and the Windows Private-network
  firewall may need the owner's approval. This app never changes the firewall.

## Phase 4 acceptance

The real-workbook integration test reads the validation workbook without modifying it and uses an isolated `fake-indexeddb` database. With the 191-record seed, its first import is 110 new rows; a repeat is 110 unchanged rows, with app-managed PIC/notes/CA link retained. The test is skipped when the workbook fixture is absent. Browser interaction remains a user acceptance step; see [`docs/phase4-user-acceptance-checklist.md`](docs/phase4-user-acceptance-checklist.md).

## Checks

```bash
npm test               # full suite (browser logic + server runtime + portable)
npm run test:server    # server/SQLite/LAN/audit/backup/report suite only
npm run test:portable  # desktop layout, settings, bridge security, startup handshake
npm run typecheck      # browser + server + desktop projects
npm run build          # production browser bundle
npm run build:desktop  # compiled Electron main + preload
npm audit
git diff --check
```

## Migrate old browser data

Phase 5 never imports browser data on its own. To move an existing IndexedDB database across:

```bash
# 1. System page → "Export browser data (read-only)" → downloads a JSON file
# 2. inspect what would change, without writing anything
npm run migrate:indexeddb -- --file tnp-indexeddb-export-….json
# 3. apply it (creates a backup first)
npm run migrate:indexeddb -- --file tnp-indexeddb-export-….json --confirm
```

This repository remains development-only. Since Phase 6 a **portable TEST folder** can be built
with `npm run package:portable`; there is still no installer, no auto-updater, no code signing,
no production release and no deployment.
