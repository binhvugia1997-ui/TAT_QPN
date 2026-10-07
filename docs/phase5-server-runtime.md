# Phase 5 — Server runtime, SQLite, audit, backup and LAN

Phase 5 replaces the authoritative persistence layer. It does **not** change any approved
Phase 1–4 business behavior.

## What changed

| Before (Phase 4) | After (Phase 5) |
| --- | --- |
| Browser IndexedDB is authoritative | Local Node server owns SQLite at `data/tnp.db` |
| One user, one browser | Several workstations can share one server |
| No history | Append-only audit history |
| Last write wins | Optimistic concurrency, HTTP 409 on conflict |
| No backups | Daily, pre-import and manual SQLite snapshots |
| `caFileLink` is a free-text string | Managed, security-checked report storage (in addition to the link) |

Everything else is untouched: the canonical record model, the 191-record seed, all 34 source
fields and `sourceExtras`, the Records workspace, detail drawer, Home, Analysis, TAT
Monitoring, Corrective Actions, Rejected, effective-TAT logic, priority sorting, the import
parser and the matched-record whitelist.

## Architecture

```
React UI
  → src/services/server/apiClient.ts        (fetch, same-origin relative paths)
  → src/services/server/serverRecordRepository.ts
  → HTTP /api/*
  → server/http/app.ts                      (routing, validation, security headers)
  → server/db/*, server/services/*          (SQLite, audit, backup, reports, import)
  → SQLite  data/tnp.db
```

UI components contain no SQL and no server logic. `ServerRecordRepository` implements the same
`RecordStore` interface as the IndexedDB repository, so the approved `RecordService` is shared
by both runtimes.

The server uses Node's **built-in `node:sqlite`** driver. There is no native module to
download, rebuild or match to a platform, and the safe online-backup API is available directly.

## Persistent directories

| Path | Contents | Committed? |
| --- | --- | --- |
| `data/` | `tnp.db`, `tnp.db-wal`, `tnp.db-shm`, `server.json`, `tnp.lock` | No |
| `backups/` | `tnp-<stamp>-<kind>-<hex>.db` snapshots | No |
| `reports/` | Managed report files, server-generated names | No |

All three are gitignored and live outside `dist/` and `dist-server/`, so a rebuild never
destroys operator data. Each is overridable (`TNP_DATA_DIR`, `TNP_BACKUPS_DIR`,
`TNP_REPORTS_DIR`, `TNP_DB_FILE`) which is how tests and the future portable build isolate
themselves.

## Database

`PRAGMA user_version` is the schema level. Migrations are an ordered append-only list applied
once, inside a transaction, in `server/db/schema.ts`. Add new phases by appending a migration;
never edit a released one.

Version 1 tables: `records`, `audit_events`, `import_history`, `reports`, `report_files`,
`backups`, `metadata`.

`records` keeps the full canonical record as a JSON `payload`, which preserves all 34 source
fields, `sourceExtras` and any extension field losslessly, plus indexed projection columns and
a `version` revision counter. Identity keeps its type (`number:1` vs `string:i-…`) so numeric
seed ids and string imported ids can never collide.

`audit_events` has `BEFORE UPDATE` / `BEFORE DELETE` triggers that `RAISE(ABORT)` — history
cannot be rewritten through SQL.

### Seeding

A fresh database is seeded with exactly the 191 canonical records plus a seed marker, in one
transaction. An existing database is **never** reseeded or overwritten; startup is idempotent.

## Running it

```bash
npm run dev        # builds the server, then runs server + Vite (proxies /api)
npm start          # server only
npm start:lan      # server bound to 0.0.0.0
npm run build      # browser bundle into dist/, which the server also serves
```

The Vite dev server proxies `/api` to `http://127.0.0.1:8787`, so the browser only ever calls
same-origin relative URLs. When `dist/` exists the Node server serves it directly, which is
what LAN workstations use.

## LAN

- **Default: `127.0.0.1`, LAN disabled.** It is never on by default and never `0.0.0.0`
  implicitly.
- Enable explicitly with `--lan`, `TNP_LAN=1`, or `{"lanEnabled": true}` in `data/server.json`,
  then restart. Precedence: argument → environment → config file → default.
- No owner IP address is hardcoded. `GET /api/status` reports the **live** bind address, the
  actual port, the LAN state and every usable LAN URL detected on the machine.
- The server never modifies Windows Firewall. If other PCs cannot connect, allow the app
  through the **Private networks** firewall profile.
- Configuration is deliberately not writable over HTTP, so a LAN client cannot change it.

> **Warning.** LAN mode has **no authentication and no TLS**. Any workstation on the network can
> read and change records. Use it only on a trusted internal network. There are no
> public-Internet exposure instructions, and none should be written.

## Optimistic concurrency

Every record carries a revision. `PATCH /api/records/:id` requires the revision the client read:

```
PC A reads revision 4      PC B reads revision 4
                           PC B saves  → revision 5
PC A saves revision 4  →  HTTP 409
```

The 409 response carries `expectedVersion` and `currentVersion`. The drawer then refetches the
record and tells the operator it changed and needs review; nothing is silently overwritten.

## Audit history

One save produces **one** grouped event with: timestamp, operation, canonical record id,
management number, every changed field with old and new values, import batch id, transport
client address, and an optional self-declared workstation label.

- The address and label identify a **connection**, not a person. Nothing claims otherwise.
- Values that look like absolute host paths are reduced to their file name before storage.
- Report file contents never enter history.
- Global history (`GET /api/audit`) supports `limit`, `operation`, `from` and `to`; record
  history is `GET /api/records/:id/history`. Both are read-only — no endpoint can rewrite them.

## Backups

Snapshots use SQLite's online backup API, which is consistent on a live WAL database. A plain
file copy of an open database is never used.

| Kind | When |
| --- | --- |
| `daily` | First write of each calendar day, at most once per day |
| `pre-import` | Immediately before every import transaction |
| `manual` | On demand from the System page or `POST /api/backups` |

Retention is bounded (`DEFAULT_RETENTION = 30`): the oldest snapshots are deleted with their
files, so the folder cannot grow forever.

**Restore is intentionally not implemented.** The UI lists and sizes backups only. To restore,
stop the server and replace `data/tnp.db` with a snapshot manually.

## Managed reports

- A report is attached to a **canonical record id**; the file name is never identity.
- Stored names are server-generated and may contain no path separator, traversal sequence or
  absolute path.
- Containment is checked lexically **and** on the real path, so file and directory symlinks
  cannot escape `reports/`. Encoded traversal (`%2e%2e`, `%252e`, `%2f`, `%5c`) is rejected
  before any handler runs.
- A missing file returns an explicit `report-unavailable` state and **keeps its link** so it can
  be re-attached; the link is never silently cleared.
- Unlinking removes only the association. The stored bytes stay on disk and are listed as
  orphaned.
- Attach, replace and unlink are audited. File contents are not.
- There is no general filesystem browser, directory listing or shell endpoint.

Phase 5 serves reports through the server only. Native Windows "open with default application"
is deliberately **not** implemented here; the clean boundary for that is
`src/services/server` plus `server/services/reportStorage.ts`.

## Import

```
pre-import backup → transaction (match, whitelist sync, audit, import history) → commit
```

Any failure rolls the transaction back, so a partially applied import is impossible.

**The matched-record whitelist is final and is exactly `status` and `dueDate`.** For new
records the full normalized source row is inserted, including `sourceExtras`. For matched
records nothing else is synchronized — not `registeredDate`, not the canonical id, PIC,
Remark/Notes, CA File Link, `sourceExtras` or any other protected field. Generic
`{...existing, ...imported}` merging is forbidden. If neither whitelisted field changes, the
record counts as UNCHANGED, even when protected fields differ. Reverse status transitions are
allowed.

The rule lives in one shared module, `src/business/import/tnpSyncRules.ts`, imported by both
the browser preview and the server pipeline, so the two cannot drift. A test asserts the server
import produces the same counts and the same resulting record as the browser-side
`ImportService` for identical input.

## Migration from IndexedDB

Migration is **explicit** and one-way. Nothing is imported automatically and no unknown browser
data is silently adopted.

1. **Export** — System page → *Export browser data (read-only)*. This opens the old store with
   read-only transactions, copies it to JSON and downloads it. The source IndexedDB is never
   mutated.
2. **Dry run** — see exactly what would change, without writing anything:
   ```bash
   npm run migrate:indexeddb -- --file tnp-indexeddb-export-….json
   ```
3. **Confirm** — creates a backup first, then applies inside a transaction:
   ```bash
   npm run migrate:indexeddb -- --file tnp-indexeddb-export-….json --confirm
   ```

Canonical ids, app-managed values, `sourceExtras` and import history are preserved. A legacy
`caFileLink` is migrated as data only; it is **not** registered as a managed report, so
unmanaged local paths never become streamable.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/status` | Live server, storage, directory, seed and security state |
| GET | `/api/bootstrap` | Startup seed result and schema version |
| GET | `/api/records` | All records with revisions |
| POST | `/api/records` | Create a manual record |
| GET | `/api/records/:id` | One record |
| PATCH | `/api/records/:id` | Update; requires `expectedVersion`, 409 on conflict |
| DELETE | `/api/records/:id` | Delete |
| GET | `/api/records/:id/history` | Record-level audit history |
| GET | `/api/records/:id/report-info` | Report state and metadata |
| GET | `/api/records/:id/report` | Stream the linked report |
| POST | `/api/records/:id/report` | Attach a report (`X-TNP-File-Name` header) |
| DELETE | `/api/records/:id/report` | Unlink, retaining stored bytes |
| GET | `/api/import-history` | Import batches |
| POST | `/api/import/preview` | Read-only preview |
| POST | `/api/import/commit` | Backup → transaction → audit → history → commit |
| GET | `/api/audit` | Global history; `limit`, `operation`, `from`, `to` |
| GET | `/api/backups` | List snapshots |
| POST | `/api/backups` | Manual snapshot |

`:id` accepts a typed id key (`number:1`, `string:i-…`) or a bare id, which is inferred.

Hardening: parameterized SQL everywhere, request validation with explicit limits, body size
caps (16 MB JSON, 64 MB upload), no arbitrary shell or filesystem endpoint, and security
headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
`Content-Security-Policy`) on every response.

## Process ownership

`data/tnp.lock` records the owning pid, hostname and start time. A second server targeting the
same data directory is refused with an explicit message rather than risking SQLite corruption.
A stale lock from a dead process is taken over automatically.

## Tests

`npm run test:server` covers: SQLite initialization and schema/migrations, the 191-record seed,
idempotent startup and non-reseeding, CRUD through the API, the locked import whitelist and
protected fields, import rollback, browser/server import parity, audit events and field
grouping, append-only enforcement, all three backup kinds, retention, report attach/stream,
traversal and symlink rejection, optimistic concurrency and 409, status transitions, effective
TAT, `sourceExtras` preservation, localhost default versus explicit LAN binding, and the
IndexedDB migration dry-run and confirm paths.
