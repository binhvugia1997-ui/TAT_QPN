# TNP Defect Management System — Development

Development-only local-first TNP defect tracking workspace. The legacy HTML was audited before implementation; see [`docs/legacy-analysis.md`](docs/legacy-analysis.md), [`docs/architecture.md`](docs/architecture.md) and the approved [`docs/phase2-simplification-review.md`](docs/phase2-simplification-review.md).

## Run locally

```bash
npm ci
npm run dev
```

Vite binds to `0.0.0.0` for the Arena live preview. The app uses browser-local IndexedDB and makes no API/cloud calls. First run adds the immutable-derived 191-record seed only where IDs do not already exist. The canonical model retains all 34 original source fields and recognized extensions.

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

## Phase 4 acceptance

The real-workbook integration test reads the validation workbook without modifying it and uses an isolated `fake-indexeddb` database. With the 191-record seed, its first import is 110 new rows; a repeat is 110 unchanged rows, with app-managed PIC/notes/CA link retained. The test is skipped when the workbook fixture is absent. Browser interaction remains a user acceptance step; see [`docs/phase4-user-acceptance-checklist.md`](docs/phase4-user-acceptance-checklist.md).

## Checks

```bash
npm test
npm run typecheck
npm audit
git diff --check
```

This repository remains development-only. No installer, portable build, `.exe`, auto-updater, production release or deployment is created.
