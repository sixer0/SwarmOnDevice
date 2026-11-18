// Row 80 (ST-11, decision C6): a revision stores each block once. `writeRevisionRows` no longer writes the
// legacy `block` row beside the `doc_block` row; the readers of `block` go through one shared reader that
// uses the stored rows when the revision has them and derives the same rows when it has not.
// Real temp store (SqliteStudioStore over bun:sqlite), the real vendored writers. No port, no mock.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeHostStore, openHostStore, type SqliteStudioStore } from "../../src/store-bridge/index.ts";
import type { StudioCaller } from "../../vendor/src/lib/studio/contract/auth";
import type { StudioChapterV2, StudioDocV2 } from "../../vendor/src/lib/studio/contract";

const PKG = path.resolve(import.meta.dir, "..", "..");
const VENDOR = path.join(PKG, "vendor");
const TEMPLATES = path.join(PKG, "templates");
const base = process.env.ROW80_TEST_DIR ?? tmpdir();
mkdirSync(base, { recursive: true });
const WORK = realpathSync(mkdtempSync(path.join(base, "row80-")));
const ROOT = path.join(WORK, "datum-studio");

process.env.STUDIO_WORKSPACE_ROOT = ROOT;
process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets");

const caller: StudioCaller = { kind: "INTERNAL_AGENT", requester: "agent:row80-test", agentId: "row80-test", canWriteClassK: false };
const CHANGE = (what: string) => ({ what, why: "uji row 80", impact: "revisi baru" });

type Sql = { get<T>(s: string, p?: unknown[]): T; all<T>(s: string, p?: unknown[]): T[] };
let store: SqliteStudioStore;
let templates: typeof import("../../vendor/src/lib/studio/services/templates");
let submit: typeof import("../../vendor/src/lib/studio/services/submit");
let ingest: typeof import("../../vendor/src/lib/studio/services/ingest");
let repo: typeof import("../../vendor/src/lib/studio/services/structure/repository");
let revisions: typeof import("../../vendor/src/lib/studio/services/revisions");
let localDb: typeof import("../../src/mcp-host/local-api/db.ts");

const sql = (): Sql => (store as unknown as { requireReader(): Sql }).requireReader();
const count = (table: string, revisionId?: string): number =>
  Number(sql().get<{ n: number }>(`SELECT count(*) AS n FROM ${table}${revisionId ? " WHERE revision_id = ?" : ""}`, revisionId ? [revisionId] : []).n);
/** Stored bytes of the block payload columns of one revision in one table. */
const payloadBytes = (table: "block" | "doc_block", revisionId: string): number =>
  Number(
    sql().get<{ n: number | null }>(
      `SELECT sum(length(CAST(content AS BLOB)) + length(CAST(text_plain AS BLOB)) + length(CAST(content_sha256 AS BLOB))) AS n FROM ${table} WHERE revision_id = ?`,
      [revisionId],
    ).n ?? 0,
  );
const revisionId = (documentId: string, n: number): string =>
  sql().get<{ id: string }>("SELECT id FROM revision WHERE document_id = ? AND revision_no = ?", [documentId, n]).id;

/** A document with a paragraph, a captioned table, a list and a second chapter: block kinds whose stored legacy form differs from the v2 form. */
function docBody(title: string, missionFolder: string): StudioDocV2 {
  return {
    $schema: "studio.doc/v2",
    template: { slug: "datum-gsp" },
    meta: { title, typeCode: "KT", tier: "NOTA", classification: "BIASA", language: "ID", author: "Row 80", issueDate: "2026-11-17", rev: "A" },
    mission: { folder: missionFolder },
    sections: {
      content: {
        type: "chapter",
        chapters: [
          {
            key: "1",
            title: { text: "Ringkasan pemeriksaan" },
            sections: [
              {
                title: { text: "Kondisi katup" },
                blocks: [
                  { type: "paragraph", text: "Katup pengaman tekanan tinggi diperiksa pada tiga pompa." },
                  {
                    type: "table",
                    caption: { text: "Hasil pemeriksaan katup" },
                    columns: [{}, {}],
                    rows: [
                      { kind: "header", cells: [{ text: "Pompa" }, { text: "Tekanan (bar)" }] },
                      { cells: [{ text: "P-101" }, { text: "12,5" }] },
                      { cells: [{ text: "P-102" }, { text: "12,1" }] },
                    ],
                  },
                  { type: "paragraph", text: "Kalibrasi sensor tekanan dicatat dalam lembar kerja." },
                ],
              },
              { title: { text: "Tindak lanjut" }, blocks: [{ type: "paragraph", text: "Katup P-102 dijadwalkan untuk diganti." }] },
            ],
          },
          { key: "2", title: { text: "Penutup" }, sections: [{ title: { text: "Simpulan" }, blocks: [{ type: "paragraph", text: "Ketiga pompa layak operasi." }] }] },
        ],
      },
    },
  } as unknown as StudioDocV2;
}

const chapterBody = (documentId: string, baseRevisionNo: number): StudioChapterV2 =>
  ({
    $schema: "studio.chapter/v2",
    target: { documentId },
    baseRevisionNo,
    chapter: { key: "2", title: { text: "Penutup" }, sections: [{ title: { text: "Simpulan" }, blocks: [{ type: "paragraph", text: "Ketiga pompa layak operasi sesudah katup diganti." }] }] },
    change: CHANGE("Bab 2 diperbarui"),
  }) as unknown as StudioChapterV2;

const v1Doc = (title: string) => ({
  $schema: "studio.doc/v1",
  template: { slug: "datum-gsp" },
  meta: { title, typeCode: "KT", tier: "NOTA", classification: "BIASA", language: "ID", author: "Row 80", issueDate: "2026-11-17", rev: "A" },
  chapters: [{ key: "1", title: { text: "Bab uji v1" }, sections: [{ title: { text: "Bagian" }, blocks: [{ type: "paragraph", text: "Paragraf dokumen versi satu." }] }] }],
});

/** The three v2 writers of `writeRevisionRows`: submit pipeline (create, chapter), revisions v2 commit (pid edit). Returns the document id; revisions 1..3. */
async function writeThreeRevisions(title: string, folder: string): Promise<string> {
  const created = await submit.submitDocumentV2(caller, docBody(title, folder));
  const documentId = created.document.id;
  await submit.submitChapter(caller, chapterBody(documentId, 1));
  const para = sql().get<{ pid: string }>("SELECT pid FROM doc_block WHERE revision_id = ? AND address = '1.1.1'", [revisionId(documentId, 2)]).pid;
  await revisions.patchPid(caller, documentId, para, {
    op: "replace",
    baseRevisionNo: 2,
    block: { type: "paragraph", text: "Katup pengaman tekanan tinggi diperiksa ulang pada tiga pompa." },
    change: CHANGE("Paragraf 1.1.1"),
  });
  return documentId;
}

/** The query every legacy reader ran before row 80 (db.ts:70, revisions/index.ts:655), verbatim columns. */
const storedLegacy = (rid: string) =>
  sql()
    .all<Record<string, unknown>>("SELECT block_id, address, artifact_label, ordinal, type, content, text_plain, content_sha256 FROM block WHERE revision_id = ? ORDER BY ordinal ASC", [rid])
    .map((r) => ({
      blockId: String(r.block_id),
      address: String(r.address),
      artifactLabel: (r.artifact_label ?? null) as string | null,
      ordinal: Number(r.ordinal),
      type: String(r.type),
      content: JSON.parse(String(r.content)) as unknown,
      textPlain: String(r.text_plain),
      contentSha256: String(r.content_sha256),
    }));

let oldDoc = ""; // written with the double write on: the shape every store has before 1.3.3
let newDoc = ""; // written by the 1.3.3 default
const measured: Record<string, unknown> & { fixtures?: Record<string, unknown> } = {};

beforeAll(async () => {
  process.env.STUDIO_WORKSPACE_ROOT = ROOT;
  process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets");
  (await import("../../vendor/src/lib/studio/contract/env")).resetStudioEnvCache();
  store = await openHostStore(ROOT, { release: "1.3.3", logFile: path.join(WORK, "logs", "store.jsonl") });
  templates = await import("../../vendor/src/lib/studio/services/templates");
  templates.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.3.3" });
  submit = await import("../../vendor/src/lib/studio/services/submit");
  ingest = await import("../../vendor/src/lib/studio/services/ingest");
  repo = await import("../../vendor/src/lib/studio/services/structure/repository");
  revisions = await import("../../vendor/src/lib/studio/services/revisions");
  localDb = await import("../../src/mcp-host/local-api/db.ts");
});

afterAll(async () => {
  repo?.setLegacyBlockDualWrite(false);
  templates?.configureTemplateSource(null);
  if (store) await closeHostStore(store);
  (await import("../../vendor/src/lib/studio/contract/env")).resetStudioEnvCache();
  console.log(`ROW80_MEASURED ${JSON.stringify(measured)}`);
});

describe("row 80: one stored copy per block", () => {
  test("old shape (double write on): every block is stored twice; the fixture of the pre-1.3.3 store", async () => {
    expect(repo.setLegacyBlockDualWrite(true)).toBe(false); // the default is off
    const before = { block: count("block"), doc_block: count("doc_block") };
    oldDoc = await writeThreeRevisions("Nota katup bentuk lama", "2026-11-17_row80-lama").finally(() => repo.setLegacyBlockDualWrite(false));
    const delta = { block: count("block") - before.block, doc_block: count("doc_block") - before.doc_block };
    expect(delta.doc_block).toBeGreaterThanOrEqual(3 * 5);
    expect(delta.block).toBe(delta.doc_block);
    const rid = revisionId(oldDoc, 3);
    measured.old = { revisions: 3, blockRows: delta.block, docBlockRows: delta.doc_block, rev3: { block: count("block", rid), doc_block: count("doc_block", rid), blockPayloadBytes: payloadBytes("block", rid), docBlockPayloadBytes: payloadBytes("doc_block", rid) } };
  });

  test("new shape (default): the same three writes add doc_block rows only", async () => {
    const before = { block: count("block"), doc_block: count("doc_block") };
    newDoc = await writeThreeRevisions("Nota katup bentuk baru", "2026-11-17_row80-baru");
    const delta = { block: count("block") - before.block, doc_block: count("doc_block") - before.doc_block };
    expect(delta.block).toBe(0);
    expect(delta.doc_block).toBe((measured.old as { docBlockRows: number }).docBlockRows);
    for (const n of [1, 2, 3]) {
      const rid = revisionId(newDoc, n);
      expect(count("block", rid)).toBe(0);
      expect(count("doc_block", rid)).toBe(count("doc_block", revisionId(oldDoc, n)));
      // one row per block: no pid and no address twice in the revision
      expect(sql().get<{ n: number }>("SELECT count(DISTINCT pid) AS n FROM doc_block WHERE revision_id = ?", [rid]).n).toBe(count("doc_block", rid));
    }
    const rid = revisionId(newDoc, 3);
    measured.new = { revisions: 3, blockRows: delta.block, docBlockRows: delta.doc_block, rev3: { block: count("block", rid), doc_block: count("doc_block", rid), blockPayloadBytes: payloadBytes("block", rid), docBlockPayloadBytes: payloadBytes("doc_block", rid) } };
  });

  test("v1-adapter ingest (ingest/repository.ts writer) also writes once; a legacy v1 document keeps its only table", async () => {
    const before = { block: count("block"), doc_block: count("doc_block") };
    const a = await ingest.ingestDocument({ document: v1Doc("Dokumen v1 adaptor row 80") } as never, caller, { dryRun: false } as never);
    const adapted = { block: count("block") - before.block, doc_block: count("doc_block") - before.doc_block };
    expect(adapted.doc_block).toBeGreaterThan(0);
    expect(adapted.block).toBe(0);
    const l = await ingest.ingestDocument({ document: v1Doc("Dokumen v1 lama row 80") } as never, caller, { dryRun: false, legacyV1: true, trustedHarness: true } as never);
    const rid = revisionId(l.document!.id, 1);
    expect(count("doc_block", rid)).toBe(0);
    expect(count("block", rid)).toBeGreaterThan(0); // v1: `block` is the single copy, not a second one
    const rows = repo.legacyBlockRowsIn(sql() as never, rid);
    expect(rows).toEqual(storedLegacy(rid));
    expect((await revisions.openRevision(l.document!.id)).blocks.length).toBe(rows.length);
    measured.v1 = { adapterDocBlockRows: adapted.doc_block, adapterBlockRows: adapted.block, legacyV1BlockRows: rows.length, adapterDocumentId: a.document!.id.length > 0 };
  });
});

describe("row 80: the derived rows are the rows the second write stored", () => {
  test("for each old-shape revision, derived == stored, field by field (content, sha, text, type, label, ordinal, address, id)", async () => {
    let differing = 0;
    for (const n of [1, 2, 3]) {
      const rid = revisionId(oldDoc, n);
      const stored = storedLegacy(rid);
      expect(stored.length).toBeGreaterThanOrEqual(5);
      expect(repo.derivedLegacyBlockRowsIn(sql() as never, rid)).toEqual(stored);
      // the legacy row is not a copy of the doc_block row (design 04, 1.2): the derivation has to use the snapshot
      const v2 = sql().all<{ address: string; content: string }>("SELECT address, content FROM doc_block WHERE revision_id = ? ORDER BY ordinal ASC", [rid]);
      differing += stored.filter((s, i) => JSON.stringify(s.content) !== JSON.stringify(JSON.parse(v2[i].content))).length;
    }
    expect(differing).toBeGreaterThan(0);
    measured.legacyRowsThatDifferFromDocBlock = differing;
  });
});

describe("row 80: the derivation holds for slot rows and the other block kinds", () => {
  // Existing fixtures of other suites, read only: control sheet, signature and register slots (rows without a
  // chapter), derivation, list, financial tables, chart, diagram.
  for (const rel of ["test/engine-rev-a/row143a/fixtures/bfix-datum-kanonik-ID.studio.json", "test/ported/_fixtures/tests/parity/fixtures/doc/v2/doc_serah_handover.json", "test/ported/_fixtures/tests/parity/fixtures/doc/v2/doc_terbit_report.json"]) {
    test(`${path.basename(rel)}: derived == stored; the same document written once reads the same rows apart from ids`, async () => {
      // Only the envelope is adapted to this store: the template version it pins and one mission folder per write.
      const body = (folder: string) => {
        const doc = JSON.parse(readFileSync(path.join(PKG, rel), "utf8")) as { template: { slug: string }; meta: Record<string, unknown> };
        const { docNumber: _n, ...meta } = doc.meta; // the store numbers each of the two documents itself
        return { ...doc, template: { slug: doc.template.slug }, meta, mission: { folder } } as unknown as StudioDocV2;
      };
      const tag = path.basename(rel).replace(/[^a-z0-9]+/gi, "-").toLowerCase();
      repo.setLegacyBlockDualWrite(true);
      const twice = await submit.submitDocumentV2(caller, body(`2026-11-17_row80-${tag}-lama`)).finally(() => repo.setLegacyBlockDualWrite(false));
      const once = await submit.submitDocumentV2(caller, body(`2026-11-17_row80-${tag}-baru`));
      const ridTwice = revisionId(twice.document.id, 1);
      const ridOnce = revisionId(once.document.id, 1);
      const stored = storedLegacy(ridTwice);
      expect(stored.length).toBeGreaterThan(0);
      expect(count("block", ridOnce)).toBe(0);
      expect(count("doc_block", ridOnce)).toBe(stored.length);
      expect(repo.derivedLegacyBlockRowsIn(sql() as never, ridTwice)).toEqual(stored);
      // The two documents differ in generated ids and in their document number, which some slot rows print:
      // compare the row list (address, type, label, ordinal) and, for chapter blocks, the text.
      const once1 = repo.legacyBlockRowsIn(sql() as never, ridOnce);
      const shape = (rows: typeof once1) => rows.map((r) => [r.address, r.type, r.artifactLabel, r.ordinal, /^\d/.test(r.address) ? r.textPlain : ""]);
      expect(shape(once1)).toEqual(shape(stored));
      expect(once1.every((r) => r.content !== undefined && r.contentSha256.length === 64)).toBe(true);
      const slotRows = sql().get<{ n: number }>("SELECT count(*) AS n FROM doc_block WHERE revision_id = ? AND chapter_id IS NULL", [ridTwice]).n;
      (measured.fixtures ??= {} as Record<string, unknown>)[path.basename(rel)] = {
        blocks: stored.length,
        slotRows,
        types: [...new Set(stored.map((r) => r.type))].sort().join(","),
        blockPayloadBytes: payloadBytes("block", ridTwice),
        docBlockPayloadBytes: payloadBytes("doc_block", ridTwice),
      };
    });
  }
});

describe("row 80: readers", () => {
  test("old-shape revision: the shared reader returns the stored rows, as the old query did", () => {
    for (const n of [1, 2, 3]) {
      const rid = revisionId(oldDoc, n);
      expect(repo.legacyBlockRowsIn(sql() as never, rid)).toEqual(storedLegacy(rid));
      expect(repo.legacyBlockRowsIn(sql() as never, rid, false)).toEqual(storedLegacy(rid).map(({ content: _c, ...r }) => r));
    }
  });

  test("local-api `legacyBlocks` (R05 tree, R04 addresses): old shape unchanged; new shape equals old shape apart from the generated ids", async () => {
    for (const n of [1, 2, 3]) {
      const oldRid = revisionId(oldDoc, n);
      const oldRows = await localDb.legacyBlocks(oldRid);
      expect(oldRows).toEqual(storedLegacy(oldRid).map((r) => ({ address: r.address, blockId: r.blockId, type: r.type, artifactLabel: r.artifactLabel, ordinal: r.ordinal, textPlain: r.textPlain })));
      const newRows = await localDb.legacyBlocks(revisionId(newDoc, n));
      expect(newRows.length).toBe(oldRows.length);
      const noId = (rows: typeof oldRows) => rows.map(({ blockId: _b, ...r }) => r);
      expect(noId(newRows)).toEqual(noId(oldRows));
      expect(newRows.every((r) => r.blockId.length > 0)).toBe(true);
    }
    expect((await localDb.legacyBlocks(revisionId(newDoc, 3))).some((r) => r.artifactLabel === "Tabel 1.1")).toBe(true);
  });

  test("services/revisions `getBlock` and `openRevision`: a new-shape revision answers like an old-shape one", async () => {
    const ids = /"(blockId|id|pid)":"[^"]*"/g;
    const noIds = (v: unknown) => JSON.stringify(v).replace(ids, '"$1":"-"');
    for (const address of ["1.1.1", "1.1.3", "1.2.1", "2.1.1", "Tabel 1.1", "Tabel 1.1/caption"]) {
      const o = await revisions.getBlock(oldDoc, address);
      const n = await revisions.getBlock(newDoc, address);
      expect(n.revisionNo).toBe(3);
      expect(n.type).toBe(o.type);
      expect(noIds(n.content)).toBe(noIds(o.content));
    }
    expect(JSON.stringify((await revisions.getBlock(newDoc, "1.1.1", 1)).content)).toContain("diperiksa pada tiga pompa");
    expect(JSON.stringify((await revisions.getBlock(newDoc, "1.1.1")).content)).toContain("diperiksa ulang");
    await expect(revisions.getBlock(newDoc, "9.9.9")).rejects.toMatchObject({ code: "ADDRESS_NOT_FOUND" });
    const o = await revisions.openRevision(oldDoc);
    const n = await revisions.openRevision(newDoc);
    expect(n.blocks.length).toBe(o.blocks.length);
    expect(n.blocks.map((b) => [b.address, b.type])).toEqual(o.blocks.map((b) => [b.address, b.type]));
    expect(noIds(n.blocks.map((b) => b.content))).toBe(noIds(o.blocks.map((b) => b.content)));
    // the old-shape document reads exactly its stored rows
    expect(o.blocks.map((b) => ({ address: b.address, blockId: b.blockId, type: b.type, content: b.content }))).toEqual(
      storedLegacy(revisionId(oldDoc, 3)).map((r) => ({ address: r.address, blockId: r.blockId, type: r.type, content: r.content })),
    );
  });

  test("store `getRevision`: both shapes return the same doc_block rows; `legacyBlocks` is what the table holds", async () => {
    const o = await store.getRevision(oldDoc, 3);
    const n = await store.getRevision(newDoc, 3);
    expect(o!.legacyBlocks.length).toBe(o!.blocks.length);
    expect(n!.legacyBlocks).toEqual([]);
    expect(n!.blocks.map((b) => [b.address, b.type, b.text_plain])).toEqual(o!.blocks.map((b) => [b.address, b.type, b.text_plain]));
  });

  test("structure `readRows` + reconstruction (D-258) hold for a revision without legacy rows", async () => {
    const structure = await import("../../vendor/src/lib/studio/services/structure");
    for (const doc of [oldDoc, newDoc]) {
      const rid = revisionId(doc, 3);
      const rows = await structure.readRows(rid);
      expect(rows.blocks.length).toBe(count("doc_block", rid));
      const rep = await structure.verifyReconstruction(rid);
      expect([rep.matches, rep.blockMismatches]).toEqual([true, []]);
    }
  });

  test("an old-shape document takes a new revision: the new revision is single, the old ones keep their rows", async () => {
    const before = count("block");
    const body = chapterBody(oldDoc, 3) as unknown as { chapter: { sections: Array<{ blocks: unknown[] }> } };
    body.chapter.sections[0].blocks.push({ type: "paragraph", text: "Pemeriksaan berikutnya enam bulan lagi." });
    const r = await submit.submitChapter(caller, body as unknown as StudioChapterV2);
    expect(r.revision.revisionNo).toBe(4);
    expect(count("block")).toBe(before);
    const rid4 = revisionId(oldDoc, 4);
    expect(count("block", rid4)).toBe(0);
    expect((await localDb.legacyBlocks(rid4)).length).toBe(count("doc_block", rid4));
    expect((await localDb.legacyBlocks(revisionId(oldDoc, 3))).length).toBe(count("block", revisionId(oldDoc, 3)));
  });

  test("stored size of the legacy table per row, pages included (information for the report)", () => {
    // dbstat counts whole pages of the table and its indexes; the temp store holds only this file's rows.
    const pages = (names: string): number => Number(sql().get<{ n: number | null }>(`SELECT sum(pgsize) AS n FROM dbstat WHERE name IN (${names})`).n ?? 0);
    const names = (table: string): string =>
      [table, ...sql().all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?", [table]).map((r) => r.name)].map((n) => `'${n}'`).join(", ");
    measured.dbstat = { blockBytes: pages(names("block")), blockRows: count("block"), docBlockBytes: pages(names("doc_block")), docBlockRows: count("doc_block") };
    expect(count("block")).toBeGreaterThan(0);
  });
});
