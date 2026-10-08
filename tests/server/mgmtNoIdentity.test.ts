import { afterEach, describe, expect, it } from "vitest";
import { api, startTestServer } from "./helpers";
import type { TestEnvironment } from "./helpers";

/**
 * The Management Number is locked on an existing record, and the lock is enforced at the server.
 *
 * `mgmtNo` is not a label: `getRecordFingerprint` makes it the key the import matches records on, so
 * renaming a record detaches it from its own source row. These tests pin four things: a real change
 * is refused (whether or not it would collide), a save that merely carries the unchanged number
 * still works and does not rewrite the stored bytes, creation and import keep setting numbers as
 * before, and the fingerprint rules themselves are untouched.
 *
 * The import whitelist (`status` + `dueDate`) and the identity algorithm are deliberately NOT what
 * these tests negotiate — they are pinned by `tests/server/import.test.ts` and must stay as they are.
 */

let environment: TestEnvironment | undefined;

afterEach(async () => {
  await environment?.close();
  environment = undefined;
});

interface StoredRecord {
  id: number | string;
  mgmtNo: string;
  status: string;
  notes: string | null;
  recordSource: string;
  version: number;
}

interface ImportSummary {
  added: number;
  updated: number;
  unchanged: number;
  total: number;
}

async function readRecord(id: number | string): Promise<StoredRecord> {
  const { status, body } = await api<{ record: StoredRecord }>(
    environment!.baseUrl,
    "GET",
    `/api/records/${String(id)}`,
  );
  expect(status).toBe(200);
  return body.record;
}

async function patchRecord(
  id: number | string,
  patch: Record<string, unknown>,
  expectedVersion: number,
): Promise<{
  status: number;
  body: { record?: StoredRecord; message?: string; field?: string };
}> {
  return api<{ record?: StoredRecord; message?: string; field?: string }>(
    environment!.baseUrl,
    "PATCH",
    `/api/records/${String(id)}`,
    { patch, expectedVersion },
  );
}

async function importRows(
  rows: Record<string, unknown>[],
): Promise<ImportSummary> {
  const { status, body } = await api<ImportSummary>(
    environment!.baseUrl,
    "POST",
    "/api/import/commit",
    {
      rows,
      fileName: "identity.xlsx",
    },
  );
  expect(status).toBe(200);
  return body;
}

describe("the management number as a locked identity field", () => {
  it("refuses a change to a number that belongs to another record", async () => {
    environment = await startTestServer();
    const first = await readRecord(1);
    const second = await readRecord(2);
    expect(second.mgmtNo).not.toBe(first.mgmtNo);

    const attempt = await patchRecord(
      1,
      { mgmtNo: second.mgmtNo },
      first.version,
    );

    expect(attempt.status).toBe(400);
    expect(attempt.body.field).toBe("mgmtNo");
    expect(attempt.body.message).toMatch(/cannot be changed/u);
    expect((await readRecord(1)).mgmtNo).toBe(first.mgmtNo);
    expect((await readRecord(2)).mgmtNo).toBe(second.mgmtNo);
  });

  it("refuses a change to a number nobody holds, which is the case a duplicate check cannot catch", async () => {
    environment = await startTestServer();
    const target = await readRecord(3);

    const attempt = await patchRecord(
      3,
      { mgmtNo: "RENAMED-0003" },
      target.version,
    );

    // The point of the guard: the collision check would happily allow this, and the damage
    // (a record that no longer matches its source row) is invisible until a duplicate appears.
    expect(attempt.status).toBe(400);
    expect(attempt.body.field).toBe("mgmtNo");
    expect((await readRecord(3)).mgmtNo).toBe(target.mgmtNo);
  });

  it("refuses clearing or blanking the number too", async () => {
    environment = await startTestServer();
    const target = await readRecord(4);

    for (const value of ["", "   ", null]) {
      const attempt = await patchRecord(
        4,
        { mgmtNo: value },
        (await readRecord(4)).version,
      );
      expect(attempt.status, String(value)).toBe(400);
    }
    expect((await readRecord(4)).mgmtNo).toBe(target.mgmtNo);
  });

  it("accepts a save that carries the unchanged number, and leaves the stored bytes alone", async () => {
    environment = await startTestServer();
    const before = await readRecord(5);

    // The repository layer saves whole records, so every legitimate edit arrives with `mgmtNo` in
    // the patch. Refusing the key would break the UI; refusing only a real change does not.
    const result = await patchRecord(
      5,
      { mgmtNo: `  ${before.mgmtNo}  `, notes: "line 3 verified" },
      before.version,
    );
    expect(result.status).toBe(200);

    const after = await readRecord(5);
    expect(after.notes).toBe("line 3 verified");
    // Byte-for-byte what was stored, not the padded copy the client sent.
    expect(after.mgmtNo).toBe(before.mgmtNo);
  });

  it("preserves the internal id, the provenance and the version chain on a normal update", async () => {
    environment = await startTestServer();
    const before = await readRecord(6);

    const result = await patchRecord(
      6,
      { status: "Hoàn thành", notes: "closed on the line" },
      before.version,
    );
    expect(result.status).toBe(200);

    const after = await readRecord(6);
    // The storage key is the id, never the number, so a lock on the number cannot disturb identity.
    expect(after.id).toBe(before.id);
    expect(after.recordSource).toBe(before.recordSource);
    expect(after.version).toBe(before.version + 1);
    expect(after.status).toBe("Hoàn thành");
  });

  it("keeps a record matched to its own import row, which is what the lock buys", async () => {
    environment = await startTestServer();
    const target = await readRecord(7);

    const correction = await patchRecord(
      7,
      { notes: "verified on line 3" },
      target.version,
    );
    expect(correction.status).toBe(200);

    // The rename that used to be possible (and that nothing else could detect or repair).
    const rename = await patchRecord(
      7,
      { mgmtNo: "RENAMED-0007" },
      (await readRecord(7)).version,
    );
    expect(rename.status).toBe(400);

    // So the source row still finds its record: one update, no second record.
    const summary = await importRows([
      { mgmtNo: target.mgmtNo, status: "Hoàn thành", notes: "from import" },
    ]);
    expect(summary).toMatchObject({ added: 0, updated: 1, total: 1 });

    const after = await readRecord(7);
    expect(after.status).toBe("Hoàn thành");
    // The local correction is not stranded on an orphan, because there is no orphan.
    expect(after.notes).toBe("verified on line 3");
  });

  it("still lets a new record be created with any number", async () => {
    environment = await startTestServer();

    const { status, body } = await api<{ record: StoredRecord }>(
      environment.baseUrl,
      "POST",
      "/api/records",
      {
        record: {
          mgmtNo: "BRAND-NEW-1",
          title: "Raised on the line",
          plant: "SIEL",
        },
      },
    );

    // Creation has no lineage to lose, so the lock applies to updates only.
    expect(status).toBe(201);
    expect(body.record.mgmtNo).toBe("BRAND-NEW-1");
  });

  it("still lets the import set a number on the records it inserts", async () => {
    environment = await startTestServer();

    const summary = await importRows([
      {
        mgmtNo: "IMPORTED-777",
        status: "Đợi đối sách",
        title: "Imported defect",
      },
    ]);
    expect(summary.added).toBe(1);

    const { body } = await api<{ records: StoredRecord[] }>(
      environment.baseUrl,
      "GET",
      "/api/records",
    );
    const inserted = body.records.find(
      (record) => record.mgmtNo === "IMPORTED-777",
    );
    expect(inserted?.recordSource).toBe("import");
  });

  it("still matches on the legacy composite fingerprint when the number is blank", async () => {
    environment = await startTestServer();
    const rows = [
      {
        mgmtNo: "",
        registeredDate: "2020-01-02",
        plant: "SIEL",
        partCode: "PART-9",
        title: "Composite identity defect",
        defectQty: 3,
        status: "Đợi đối sách",
      },
    ];

    expect((await importRows(rows)).added).toBe(1);

    // No number means the composite key takes over, and that key is stable, so no duplicate.
    expect(await importRows(rows)).toMatchObject({
      added: 0,
      unchanged: 1,
      total: 1,
    });
  });
});
