// Row 110d (Swarm 1.2.0, decisions C61, C69, C72): the shipped builtin templates carry the Manual Rev A control
// block (ID p.47 butir 10, EN p.49: 8 fields, no KLASIFIKASI) and the control-sheet / cover data of the new params
// R-81, R-82, R-83 per edition. Every check reads the SHIPPED files: catalog.json + each definition, folded by the
// vendored template service (configureTemplateSource, no store), and the datum-gsp builtin is rendered through the
// row 122 (DOCX) and row 123 (HTML) kits. No DB, no browser, no network, no model.
import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ResolvedTemplate, StudioDocV1 } from "../../vendor/src/lib/studio/contract";
import { loadFixture, makeCtx, snapshotOf, textOf, assemble as docxAssemble, bodyBlocks, paragraphs, runs } from "../engine-rev-a/docx/_kit";

const htmlKit = await import("../engine-rev-a/html/_kit");
const templates = await import("../../vendor/src/lib/studio/services/templates");
const { unzipSync } = await import("fflate");

const PKG = path.resolve(import.meta.dir, "..", "..");
const TEMPLATES = path.join(PKG, "templates");
const VENDOR = path.join(PKG, "vendor");

/** ID p.47 butir 10 / EN p.49, in the manual's order. */
const MANUAL_FIELDS = ["NOMOR DOKUMEN", "REVISI", "PENYUSUN", "KUSTODIAN", "DITUJUKAN KEPADA", "HALAMAN", "DATUM GEODETIK", "VERIFIKASI"];
const DISTRIBUTION = {
  ID: { rows: [["Induk", "Divisi Engineering PT GSP (ENG-01)", "Word dan PDF, folder standar", "Tidak"]] }, // ID p.2 C
  EN: { rows: [["Master", "Engineering Division, PT GSP (ENG-01)", "Word and PDF, standards folder", "No"]] }, // EN p.2 C
};
/** Kicker = document type (ID p.47 butir 6; type names ID p.15 Tabel 3.1, EN p.15). Generic templates carry none. */
const KICKERS: Record<string, string> = {
  "datum-proposal-teknis": "PROPOSAL TEKNIS",
  "datum-proposal-teknis-en": "TECHNICAL PROPOSAL",
  "datum-laporan": "LAPORAN",
  "datum-laporan-en": "REPORT",
  "datum-laporan-verifikasi": "LAPORAN VERIFIKASI",
  "datum-laporan-verifikasi-en": "VERIFICATION REPORT",
  "datum-standar": "STANDAR",
  "datum-standar-en": "STANDARD",
  "datum-nota": "NOTA INTERNAL",
  "datum-nota-en": "INTERNAL NOTE",
};

interface Entry {
  slug: string;
  file: string;
  sha256: string;
  isPreset: boolean;
  language: string | null;
}
const catalog = JSON.parse(readFileSync(path.join(TEMPLATES, "catalog.json"), "utf8")) as { count: number; templates: Entry[] };

beforeAll(() => {
  templates.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.0" });
});

const resolvedOf = (slug: string) => templates.builtinTemplate(slug)!.payload.resolvedParams as Record<string, unknown>;
const ownLayer = (def: Record<string, unknown>) => ({ ...((def.essentials ?? {}) as Record<string, unknown>), ...((def.advanced ?? {}) as Record<string, unknown>) });

describe("catalog.json + every shipped file: 8 control fields in manual order, no KLASIFIKASI (ID p.47 butir 10, EN p.49)", () => {
  test("16 shipped templates, each file matches its catalog sha256", () => {
    expect(catalog.count).toBe(16);
    expect(catalog.templates.length).toBe(16);
    for (const e of catalog.templates) expect(createHash("sha256").update(readFileSync(path.join(TEMPLATES, e.file))).digest("hex")).toBe(e.sha256);
  });

  for (const e of catalog.templates) {
    test(`${e.slug}: resolved and own cover.controlBlock.fields`, () => {
      const fields = resolvedOf(e.slug)["cover.controlBlock.fields"];
      expect(fields).toEqual(MANUAL_FIELDS);
      expect(fields as string[]).not.toContain("KLASIFIKASI");
      const def = JSON.parse(readFileSync(path.join(TEMPLATES, e.file), "utf8")) as Record<string, unknown>;
      const own = ownLayer(def)["cover.controlBlock.fields"];
      // A file either inherits the list from its preset or carries exactly the manual's list.
      if (own !== undefined) expect(own).toEqual(MANUAL_FIELDS);
      if (!def.preset) expect(own).toEqual(MANUAL_FIELDS);
    });
  }
});

describe("R-81 / R-82 / R-83 values per edition", () => {
  for (const e of catalog.templates) {
    test(`${e.slug} (${e.language})`, () => {
      const p = resolvedOf(e.slug);
      const lang = p["doc.language"] === "EN" ? "EN" : "ID";
      expect(lang).toBe((e.language ?? "ID") as "ID" | "EN");
      expect(p["cover.controlBlock.geodeticDatum"]).toBe("WGS 84"); // ID p.37 DT-30i, EN p.38 DT-30i
      expect(p["controlSheet.distribution.defaults"]).toEqual(DISTRIBUTION[lang]);
      expect(p["controlSheet.methodStatement.text"]).toBe(""); // the manual gives no generic method statement
    });
  }
});

describe("kicker text per edition (CP-04, row 123 request)", () => {
  for (const e of catalog.templates) {
    test(`${e.slug}`, () => {
      const b = templates.builtinTemplate(e.slug)!;
      const cover = b.skeleton.slots.find((s) => s.slotKey === "cover");
      const kicker = (cover?.essentials as Record<string, unknown> | undefined)?.["cover.kicker.text"] ?? resolvedOf(e.slug)["cover.kicker.text"];
      expect(kicker).toBe(KICKERS[e.slug] ?? "");
    });
  }
});

// ── Render of the datum-gsp builtin through the row 122 / row 123 kits ─────

function builtinResolved(slug: string): ResolvedTemplate {
  const b = templates.builtinTemplate(slug)!;
  return Object.freeze({
    templateId: `builtin:${slug}`,
    versionId: `builtin:${slug}:${b.versionNo}`,
    versionNo: b.versionNo,
    params: Object.freeze({ ...b.payload.resolvedParams }),
    roleFormats: Object.freeze({ ...b.payload.roleFormats }),
    sectionPlan: Object.freeze({ ...b.payload.sectionPlan }),
    assets: Object.freeze({}),
  }) as ResolvedTemplate;
}

/** The row 122 fixture without its own cover control rows, so the block comes from template data. */
function autoControlDoc(base: StudioDocV1): StudioDocV1 {
  const doc = JSON.parse(JSON.stringify(base)) as StudioDocV1;
  delete (doc.front!.cover!.data as { control?: unknown }).control;
  return doc;
}

const ID_LABELS = ["Nomor dokumen", "Revisi", "Penyusun", "Kustodian", "Ditujukan kepada", "Halaman", "Datum geodetik", "Verifikasi"];

describe("datum-gsp builtin rendered (DOCX, row 122 kit): 8 fields and the classification line", () => {
  test("cover control block: 4 x 2, the 8 labels, WGS 84, V2 · lulus, NUMPAGES, Klasifikasi line under the number", async () => {
    const tpl = builtinResolved("datum-gsp");
    const { ctx } = makeCtx(snapshotOf(autoControlDoc(loadFixture())), tpl);
    const { bytes } = await docxAssemble.assembleDocx(ctx);
    const doc = new TextDecoder().decode(unzipSync(bytes)["word/document.xml"]);
    const blocks = bodyBlocks(doc);
    const end = blocks.findIndex((b) => b.includes("<w:sectPr"));
    const control = blocks.slice(0, end + 1).find((b) => b.startsWith("<w:tbl") && textOf(b).includes("Nomor dokumen"))!;
    expect(control).toBeDefined();
    expect((control.match(/<w:tr[\s>]/g) ?? []).length).toBe(4);
    const t = textOf(control);
    const at = ID_LABELS.map((l) => t.indexOf(l));
    for (const i of at) expect(i).toBeGreaterThanOrEqual(0);
    expect(t).not.toMatch(/Klasifikasi(?! : )/); // no KLASIFIKASI field label; only the line "Klasifikasi : "
    expect(t).toContain("Divisi Engineering PT GSP");
    expect(t).toContain("WGS 84");
    expect(t).toContain("V2 · lulus");
    expect(control).toMatch(/NUMPAGES/);
    const numberCell = paragraphs(control).find((p) => textOf(p).startsWith("012/GSP/KT/XI/2026"))!;
    expect(numberCell).toContain("<w:br/>");
    const level = runs(numberCell).find((r) => r.text === "TERBATAS")!;
    expect(runs(numberCell).some((r) => r.text === "Klasifikasi : ")).toBe(true);
    expect(level.rPr).toContain('w:val="6E1420"');
    // control sheet: R-82 distribution printed, R-81 empty so no default method statement
    const sheet = doc.slice(doc.indexOf("Lembar Kendali"));
    expect(textOf(sheet)).toContain("Divisi Engineering PT GSP (ENG-01)");
    expect(textOf(sheet)).toContain("Word dan PDF, folder standar");
    console.log(`row110d docx control block: ${t}`);
  });
});

describe("datum-gsp builtin rendered (HTML, row 123 kit): fields and the classification line", () => {
  test("cover control block labels and Klasifikasi line; HALAMAN in HTML is C69's open two-pass item", async () => {
    const tpl = builtinResolved("datum-gsp");
    const { ctx } = htmlKit.makeCtx(htmlKit.snapshotOf(autoControlDoc(htmlKit.loadFixture())), tpl);
    const html = await htmlKit.assemble.assembleHtml(ctx, { preview: false });
    const text = htmlKit.textOf(html);
    for (const l of ID_LABELS.filter((x) => x !== "Halaman")) expect(text).toContain(l);
    expect(text).toContain("Klasifikasi : TERBATAS");
    expect(text).toContain("WGS 84");
    expect(text).toContain("Divisi Engineering PT GSP (ENG-01)");
    console.log(`row110d html: Halaman label present = ${text.includes("Halaman")}`);
  });
});
