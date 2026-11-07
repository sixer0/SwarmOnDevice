// Row 109 (Prisma cut, 01_specs_studio.md §1.2): the vendored services that used Prisma now run
// against a REAL temp DATUM Studio store (SqliteStudioStore over bun:sqlite). No mocks.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeHostStore, openHostStore, type SqliteStudioStore } from "../../src/store-bridge/index.ts";
import type { StudioCaller } from "../../vendor/src/lib/studio/contract/auth";
import type { StudioChapterV2, StudioDocV2 } from "../../vendor/src/lib/studio/contract";

const PKG = path.resolve(import.meta.dir, "..", "..");
const VENDOR = path.join(PKG, "vendor");
const TEMPLATES = path.join(PKG, "templates");
const base = process.env.ROW109_TEST_DIR ?? tmpdir();
mkdirSync(base, { recursive: true });
const WORK = realpathSync(mkdtempSync(path.join(base, "row109-")));
const ROOT = path.join(WORK, "datum-studio");
const LOG = path.join(WORK, "logs", "store.jsonl");

// Host contract (row 107 C53 + studio spec §2 B): absolute roots, the workspace root IS the store root.
process.env.STUDIO_WORKSPACE_ROOT = ROOT;
process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets");

const caller: StudioCaller = { kind: "INTERNAL_AGENT", requester: "agent:row109-test", agentId: "row109-test", canWriteClassK: false };

let store: SqliteStudioStore;
let templates: typeof import("../../vendor/src/lib/studio/services/templates");
let submit: typeof import("../../vendor/src/lib/studio/services/submit");
let structure: typeof import("../../vendor/src/lib/studio/services/structure");
let skeleton: typeof import("../../vendor/src/lib/studio/services/skeleton");
let images: typeof import("../../vendor/src/lib/studio/services/images");
let storage: typeof import("../../vendor/src/lib/studio/services/storage");
let job: typeof import("../../vendor/src/lib/studio/services/render/job");
let ingest: typeof import("../../vendor/src/lib/studio/services/ingest");

const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
);

function docBody(title: string, missionFolder: string): StudioDocV2 {
  return {
    $schema: "studio.doc/v2",
    template: { slug: "datum-gsp" },
    meta: { title, typeCode: "KT", tier: "NOTA", classification: "BIASA", language: "ID", author: "Row 109", issueDate: "2026-11-07", rev: "A" },
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
                  { type: "paragraph", text: "Kalibrasi sensor tekanan dicatat dalam lembar kerja." },
                ],
              },
            ],
          },
        ],
      },
    },
  } as unknown as StudioDocV2;
}

function counts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of ["document", "revision", "doc_section", "doc_chapter", "doc_subsection", "doc_block", "block", "doc_identity", "asset", "output_file", "render_job", "template", "template_version"]) {
    out[t] = Number((store as unknown as { requireReader(): { get(s: string): { n: number } } }).requireReader().get(`SELECT count(*) AS n FROM ${t}`).n);
  }
  return out;
}

beforeAll(async () => {
  // T-1 (C65): getStudioEnv() caches the first root it reads (contract/env.ts `cached`); an earlier
  // suite in the same bun process leaves its own root there. Re-assert this suite's roots and drop
  // that cache so writeOutput writes under the store root this suite opens.
  process.env.STUDIO_WORKSPACE_ROOT = ROOT;
  process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets");
  (await import("../../vendor/src/lib/studio/contract/env")).resetStudioEnvCache();
  store = await openHostStore(ROOT, { release: "1.2.0", logFile: LOG });
  templates = await import("../../vendor/src/lib/studio/services/templates");
  templates.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.0" });
  submit = await import("../../vendor/src/lib/studio/services/submit");
  structure = await import("../../vendor/src/lib/studio/services/structure");
  skeleton = await import("../../vendor/src/lib/studio/services/skeleton");
  images = await import("../../vendor/src/lib/studio/services/images");
  storage = await import("../../vendor/src/lib/studio/services/storage");
  job = await import("../../vendor/src/lib/studio/services/render/job");
  ingest = await import("../../vendor/src/lib/studio/services/ingest");
});

afterAll(async () => {
  templates?.configureTemplateSource(null);
  if (store) await closeHostStore(store);
  // T-1: do not leave this suite's root cached for the next suite in the process.
  (await import("../../vendor/src/lib/studio/contract/env")).resetStudioEnvCache();
});

describe("row 109: no Prisma left", () => {
  test("no runtime @prisma/client or @/lib/prisma import in the vendored runtime code", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts")) {
          readFileSync(p, "utf8")
            .split("\n")
            .forEach((line, i) => {
              if (/^\s*(import|export)\b.*["'](@prisma\/client|@\/lib\/prisma)["']/.test(line) || /import\(\s*["'](@prisma\/client|@\/lib\/prisma)["']\s*\)/.test(line)) hits.push(`${p}:${i + 1}`);
            });
        }
      }
    };
    walk(path.join(VENDOR, "src"));
    walk(path.join(VENDOR, "scripts"));
    expect(hits).toEqual([]);
  });
});

describe("row 109: templates (TemplateSource twin)", () => {
  test("builtins are pinned on first use, idempotent, skeleton sha = catalog", async () => {
    const list = await templates.listTemplates({});
    const catalog = JSON.parse(readFileSync(path.join(TEMPLATES, "catalog.json"), "utf8")) as { templates: Array<{ slug: string; skeletonSha256: string }> };
    expect(list.map((t) => t.slug).sort()).toEqual(catalog.templates.map((t) => t.slug).sort());
    expect(list.every((t) => t.origin === "builtin")).toBe(true);
    const before = counts();
    await templates.listTemplates({});
    await templates.resolveTemplate("datum-gsp");
    expect(counts().template_version).toBe(before.template_version);
    expect(before.template_version).toBe(catalog.templates.length);
    for (const e of catalog.templates) {
      const tpl = await templates.resolveTemplate(e.slug);
      const sk = await skeleton.getSkeleton(tpl.versionId);
      expect(sk.implicit).toBe(false);
      expect(sk.skeletonSha256).toBe(e.skeletonSha256);
    }
  });

  test("resolveTemplateVersion and the preset layer of a builtin", async () => {
    const gsp = await templates.resolveTemplate("datum-gsp");
    const again = await templates.resolveTemplateVersion(gsp.versionId);
    expect(again.params).toEqual(gsp.params);
    const layers = await skeleton.loadTemplateLayers(gsp.versionId);
    expect(layers.slug).toBe("datum-gsp");
    // datum-gsp sits on datum-gsp-preset: its keys are preset pins (clone loadLayers rule).
    expect(layers.presetPins.size).toBeGreaterThan(0);
    const slots = await skeleton.resolveSlotsForVersion(gsp.versionId, { tier: "NOTA" });
    expect(slots.slots.size).toBeGreaterThan(0);
    await expect(templates.resolveTemplate("no-such-template")).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
    await expect(templates.createTemplateV2({ slug: "user-x", name: "x", kind: "DOCUMENT", changeNote: "x", template: {} as never }, caller)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("row 109: documents, revisions, search (submit pipeline over the store)", () => {
  let documentId = "";

  test("create: submitDocumentV2 writes document + revision 1 + structure rows", async () => {
    const before = counts();
    const r = await submit.submitDocumentV2(caller, docBody("Nota pemeriksaan katup pompa", "2026-11-07_row109-katup"));
    expect(r.created).toBe(true);
    documentId = r.document.id;
    expect(r.revision.revisionNo).toBe(1);
    const after = counts();
    expect(after.document - before.document).toBe(1);
    expect(after.revision - before.revision).toBe(1);
    expect(after.doc_block - before.doc_block).toBeGreaterThanOrEqual(2);
    expect(after.block - before.block).toBe(after.doc_block - before.doc_block);
    const detail = await store.getDocument(documentId);
    expect(detail?.document.current_revision_no).toBe(1);
    expect(detail?.document.mission_folder).toBe("2026-11-07_row109-katup");
    expect(detail?.template?.slug).toBe("datum-gsp");
    expect(detail?.document.doc_number).toMatch(/\/GSP\/KT\//);
  });

  test("get: readRows + reconstructSource rebuild revision 1 from its rows (D-258)", async () => {
    const rev = await store.getRevision(documentId, 1);
    expect(rev).not.toBeNull();
    const rows = await structure.readRows(rev!.revision.id);
    expect(rows.chapters.map((c) => c.chapterKey)).toEqual(["1"]);
    expect(rows.blocks.some((b) => b.textPlain.includes("Katup pengaman"))).toBe(true);
    const src = await structure.reconstructSource(rev!.revision.id);
    expect(src.$schema).toBe("studio.doc/v2");
    const rep = await structure.verifyReconstruction(rev!.revision.id);
    expect(rep.matches).toBe(true);
    expect(rep.actualSha256).toBe(rev!.revision.snapshot_sha256);
    expect(rep.blockMismatches).toEqual([]);
  });

  test("search: FTS5 over doc_block finds the paragraph", async () => {
    const res = await store.searchParagraphs({ q: "kalibrasi sensor" });
    expect(res.hits.some((h) => h.documentId === documentId && h.revisionNo === 1)).toBe(true);
  });

  test("revision: submitChapter appends revision 2 on base 1; stale base on the same chapter conflicts", async () => {
    const body: StudioChapterV2 = {
      $schema: "studio.chapter/v2",
      target: { documentId },
      baseRevisionNo: 1,
      chapter: {
        key: "1",
        title: { text: "Ringkasan pemeriksaan" },
        sections: [{ title: { text: "Kondisi katup" }, blocks: [{ type: "paragraph", text: "Katup pengaman diganti dengan unit baru bersertifikat." }] }],
      },
      change: { what: "Bab 1 diperbarui", why: "Katup diganti", impact: "Bab 1" },
    } as unknown as StudioChapterV2;
    const r2 = await submit.submitChapter(caller, body);
    expect(r2.revision.revisionNo).toBe(2);
    const detail = await store.getDocument(documentId);
    expect(detail?.document.current_revision_no).toBe(2);
    expect(detail?.revisions.map((r) => r.revision_no)).toEqual([2, 1]);
    // revision 1 rows are intact (D-06), revision 2 has its own full copy
    const r1 = await store.getRevision(documentId, 1);
    expect(r1!.blocks.some((b) => String(b.text_plain).includes("Kalibrasi sensor"))).toBe(true);
    const latest = await store.searchParagraphs({ q: "bersertifikat" });
    expect(latest.hits.some((h) => h.documentId === documentId && h.revisionNo === 2)).toBe(true);
    // a second write from base 1 on the same chapter: the clone's SCOPE_CONFLICT
    await expect(submit.submitChapter(caller, { ...body, chapter: { ...body.chapter, title: { text: "Lain" } } } as StudioChapterV2)).rejects.toMatchObject({ code: "SCOPE_CONFLICT" });
    expect((await store.getDocument(documentId))?.document.current_revision_no).toBe(2);
  });

  test("dry run writes nothing and leaves the writer writable", async () => {
    const before = counts();
    const dry = await submit.dryRunChapter(caller, {
      $schema: "studio.chapter/v2",
      target: { documentId },
      baseRevisionNo: 2,
      chapter: { key: "2", title: { text: "Bab baru" }, sections: [{ title: { text: "Pendahuluan" }, blocks: [{ type: "paragraph", text: "Isi bab dua untuk uji dry run." }] }] },
    } as unknown as StudioChapterV2);
    expect(dry.result.document.id).toBe(documentId);
    expect(counts()).toEqual(before);
    // the writer is not left in query_only mode
    const r3 = await submit.submitChapter(caller, {
      $schema: "studio.chapter/v2",
      target: { documentId },
      baseRevisionNo: 2,
      chapter: { key: "2", title: { text: "Bab baru" }, sections: [{ title: { text: "Pendahuluan" }, blocks: [{ type: "paragraph", text: "Isi bab dua sesudah dry run." }] }] },
    } as unknown as StudioChapterV2);
    expect(r3.revision.revisionNo).toBe(3);
  });

  test("ingest v2 entry (R04 path) creates a document through the same store", async () => {
    const before = counts();
    const r = await ingest.ingestDocument(docBody("Laporan uji ingest row 109", "2026-11-07_row109-ingest") as never, caller, { dryRun: false });
    expect(r.document?.id).toBeTruthy();
    expect(r.revision?.revisionNo).toBe(1);
    expect(counts().document - before.document).toBe(1);
    const contracts = await store.queryContracts({ mission: "2026-11-07_row109-ingest", includeArchived: true });
    expect(contracts.contracts).toEqual([]); // not a contract document: no mirror rows
    // ingest appends a revision to the existing document (R04 targeting, D-232)
    const body2 = docBody("Laporan uji ingest row 109", "2026-11-07_row109-ingest");
    delete (body2 as { mission?: unknown }).mission; // targeting names the document (one target only)
    ((body2 as unknown as { sections: { content: { chapters: Array<{ sections: Array<{ blocks: unknown[] }> }> } } }).sections.content.chapters[0].sections[0].blocks).push({ type: "paragraph", text: "Paragraf tambahan lewat ingest kedua." });
    const r2 = await ingest.ingestDocument(body2 as never, caller, { dryRun: false, submitTargeting: { target: { documentId: r.document!.id }, baseRevisionNo: 1 } });
    expect(r2.revision?.revisionNo).toBe(2);
    expect((await store.getDocument(r.document!.id))?.revisions.length).toBe(2);
    expect((await store.searchParagraphs({ q: "ingest kedua" })).hits.some((h) => h.documentId === r.document!.id && h.revisionNo === 2)).toBe(true);
  });

  const v1Doc = (title: string) => ({
    $schema: "studio.doc/v1",
    template: { slug: "datum-gsp" },
    meta: { title, typeCode: "KT", tier: "NOTA", classification: "BIASA", language: "ID", author: "Row 109", issueDate: "2026-11-07", rev: "A" },
    chapters: [{ key: "1", title: { text: "Bab uji v1" }, sections: [{ title: { text: "Bagian" }, blocks: [{ type: "paragraph", text: "Paragraf dokumen versi satu untuk jalur adaptor." }] }] }],
  });

  const ingestV1 = async (doc: unknown, opts: Record<string, unknown>) => {
    try {
      return await ingest.ingestDocument({ document: doc } as never, caller, opts as never);
    } catch (e) {
      throw new Error(`${(e as Error).message}: ${JSON.stringify((e as { details?: unknown }).details)}`);
    }
  };

  test("ingest v1 (adapter path, persistAdaptedV1) and legacy v1 (persistIngest) persist through the store", async () => {
    const before = counts();
    const a = await ingestV1(v1Doc("Dokumen v1 adaptor row 109"), { dryRun: false });
    expect(a.revision?.revisionNo).toBe(1);
    const ra = await store.getRevision(a.document!.id, 1);
    expect(ra?.revision.schema_id).toBe("studio.doc/v1");
    expect(ra!.blocks.length).toBeGreaterThan(0);
    const l = await ingestV1(v1Doc("Dokumen v1 lama row 109"), { dryRun: false, legacyV1: true, trustedHarness: true });
    expect(l.revision?.revisionNo).toBe(1);
    const rl = await store.getRevision(l.document!.id, 1);
    expect(rl!.legacyBlocks.length).toBeGreaterThan(0);
    expect(rl!.blocks.length).toBe(0); // norm/v1: M06 index only
    expect(counts().document - before.document).toBe(2);
    // sequence numbers: two documents of the same type/year get consecutive numbers
    const nums = [a.document!.docNumber, l.document!.docNumber];
    expect(new Set(nums).size).toBe(2);
  });
});

describe("row 109: assets, outputs, render jobs", () => {
  test("asset: content-addressed row via putAsset, dedupe, lookup", async () => {
    const a = await images.storeAssetRow(caller, { file: PNG_1X1, mime: "image/png" });
    expect(a.created).toBe(true);
    expect(a.row.relPath).toBe(`assets/${a.row.sha256.slice(0, 2)}/${a.row.sha256}.png`);
    expect(existsSync(path.join(ROOT, a.row.relPath))).toBe(true);
    const b = await images.storeAssetRow(caller, { file: PNG_1X1, mime: "image/png" });
    expect(b.created).toBe(false);
    expect(b.row.id).toBe(a.row.id);
    const found = await images.findAssetBySha(a.row.sha256);
    expect(found?.id).toBe(a.row.id);
    expect((await store.getAsset(a.row.sha256))?.id).toBe(a.row.id);
  });

  test("output: writeOutput writes the file then the row; readOutputFile verifies sha", async () => {
    const doc = (await store.listUserTemplates({}), (store as unknown as { requireReader(): { get(s: string): { id: string; rid: string } } }).requireReader().get(
      "SELECT d.id, r.id AS rid FROM document d JOIN revision r ON r.document_id = d.id AND r.revision_no = d.current_revision_no ORDER BY d.time_created LIMIT 1",
    ));
    const j = await job.createRenderJob({ documentId: doc.id, revisionId: doc.rid }, ["HTML"], caller.requester);
    await expect(job.createRenderJob({ documentId: doc.id, revisionId: doc.rid }, ["HTML"], caller.requester)).rejects.toMatchObject({ code: "RENDER_IN_PROGRESS" });
    const out = await storage.writeOutput({
      documentId: doc.id,
      revisionId: doc.rid,
      renderJobId: j.id,
      relDir: "docs/row109/studio/test/rev-1",
      fileName: "row109_rev1.html",
      data: "<html><body>row 109</body></html>",
      format: "HTML",
      role: "PRIMARY",
      mime: "text/html",
    });
    expect(out.finalFileName).toMatch(/_rev\d+_/);
    const again = await storage.writeOutput({
      documentId: doc.id,
      revisionId: doc.rid,
      renderJobId: j.id,
      relDir: "docs/row109/studio/test/rev-1",
      fileName: "row109_rev1.html",
      data: "<html><body>row 109</body></html>",
      format: "HTML",
      role: "PRIMARY",
      mime: "text/html",
    });
    expect(again.id).toBe(out.id);
    const read = await storage.readOutputFile(out.id, { verifySha: true });
    expect(read.shaMatches).toBe(true);
    expect((await store.getOutput(out.id))?.sha256).toBe(out.sha256);
    const fin = await job.finishRenderJob(j, "SUCCEEDED");
    job.releaseRenderJob(j);
    expect(fin.status).toBe("SUCCEEDED");
    expect(fin.finishedAt).not.toBeNull();
    expect(job.renderJobToDto(fin).status).toBe("SUCCEEDED");
  });

  test("mission refs: HQ ids are labels (no HQ table), a relative SHARED_WORKSPACE is refused (no cwd)", async () => {
    await expect(storage.assertMissionRefs({ folder: "2026-11-07_row109-katup", agentRequestId: "req-1", hermesTaskId: "task-1" })).resolves.toBeUndefined();
    process.env.SHARED_WORKSPACE = "relative/workspace";
    try {
      await expect(storage.assertMissionRefs({ folder: "2026-11-07_row109-katup" })).rejects.toMatchObject({ code: "STORAGE_ROOT_FORBIDDEN" });
    } finally {
      delete process.env.SHARED_WORKSPACE;
    }
  });

  test("the store log is persisted as JSON lines by the opener", () => {
    const lines = readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { level: string; source: string; timestamp: string });
    expect(lines.some((l) => l.source === "StudioStore.open" && l.level === "info")).toBe(true);
    expect(lines.every((l) => typeof l.timestamp === "string")).toBe(true);
  });
});
