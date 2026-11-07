// Row 122 (Swarm 1.2.0, decisions C40/C56): Rev A fixes in the vendored Studio engine, DOCX and front matter.
// Each describe block is one conformance point of research/14_rev_a_conformance_points.md with the Manual Rev A
// page it enforces. Rendering goes through normalizeDocument -> assembleDocx (no DB, no browser, no network).
import { describe, expect, test } from "bun:test";
import type { NormBlock, StudioDocV1 } from "../../../vendor/src/lib/studio/contract";
import { bodyBlocks, canonicalTemplate, loadFixture, makeCtx, paragraphs, renderDocx, runs, snapshotOf, textOf } from "./_kit";

const texts = await import("../../../vendor/src/lib/studio/engine/front/texts");
const figure = await import("../../../vendor/src/lib/studio/engine/docx/figures/figure");
const browser = await import("../../../vendor/src/lib/studio/engine/browser/index");

const EM_DASH = "—";
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function coverTables(docXml: string): string[] {
  const blocks = bodyBlocks(docXml);
  const end = blocks.findIndex((b) => b.includes("<w:sectPr"));
  return blocks.slice(0, end + 1).filter((b) => b.startsWith("<w:tbl"));
}

/** Body blocks of section n (0-based), split at paragraphs that carry a sectPr. */
function sectionBlocks(docXml: string, n: number): string[] {
  const out: string[][] = [[]];
  for (const b of bodyBlocks(docXml)) {
    out[out.length - 1].push(b);
    if (b.startsWith("<w:p") && b.includes("<w:sectPr")) out.push([]);
  }
  return out[n] ?? [];
}

describe("CP-14 issue stamp: U+2014 and the classification letter (ID p.1, p.37 Tabel 6.2, p.49)", () => {
  test("registry default format prints U+2014 and T for TERBATAS (ID) / ISSUE (EN)", async () => {
    const tpl = await canonicalTemplate();
    const meta = loadFixture().meta;
    expect(texts.issueStampTextOf(meta, tpl.params)).toBe(`// 20261106 ID T ${EM_DASH} TERBITAN 1`);
    expect(texts.issueStampTextOf({ ...meta, language: "EN" }, tpl.params)).toBe(`// 20261106 EN T ${EM_DASH} ISSUE 1`);
  });

  test("a hand-written stamp with middle dot and wrong letter is re-derived in the DOCX colophon", async () => {
    const r = await renderDocx();
    const colophon = coverTables(r.doc).find((t) => textOf(t).includes("TERBITAN"))!;
    expect(textOf(colophon)).toContain(`// 20261106 ID T ${EM_DASH} TERBITAN 1`);
    expect(textOf(colophon)).not.toContain("ID A ·");
  });

  test("ASCII -- (case 05 form) is also re-derived; a colophon that is not a stamp is untouched", () => {
    const meta = loadFixture().meta;
    expect(texts.normalizedIssueStampText("// 20261106 ID T -- TERBITAN 2", meta, {})).toBe(`// 20261106 ID T ${EM_DASH} TERBITAN 2`);
    expect(texts.normalizedIssueStampText("Oktober 2026", meta, {})).toBeUndefined();
  });
});

describe("CP-15 classification line under the number (DT-28c ID p.14)", () => {
  test("number cell of the cover control block carries a line break, then 'Klasifikasi : ' and TERBATAS bold seal", async () => {
    const r = await renderDocx();
    const control = coverTables(r.doc).find((t) => textOf(t).includes("Nomor dokumen"))!;
    const cellP = paragraphs(control).find((p) => textOf(p).startsWith("012/GSP/KT/XI/2026"))!;
    expect(cellP).toBeDefined();
    expect(cellP).toContain("<w:br/>");
    const rs = runs(cellP);
    const label = rs.find((x) => x.text === "Klasifikasi : ")!;
    const level = rs.find((x) => x.text === "TERBATAS")!;
    expect(label).toBeDefined();
    expect(level.rPr).toContain("<w:b/>");
    expect(level.rPr).toContain('w:val="6E1420"');
  });

  test("not printed twice when the block already has a Klasifikasi field", async () => {
    const doc = clone(loadFixture());
    const cover = doc.front!.cover!.data as { control: { rows: unknown[][] } };
    cover.control.rows.push([{ text: "Klasifikasi" }, { text: "TERBATAS" }, { text: "" }, { text: "" }]);
    const r = await renderDocx(doc);
    const control = coverTables(r.doc).find((t) => textOf(t).includes("Nomor dokumen"))!;
    expect(textOf(control).split("TERBATAS").length - 1).toBe(1);
  });
});

describe("CP-05 eight control fields from template data (ID p.47 butir 10)", () => {
  const FIELDS = ["NOMOR DOKUMEN", "REVISI", "PENYUSUN", "KUSTODIAN", "DITUJUKAN KEPADA", "HALAMAN", "DATUM GEODETIK", "VERIFIKASI"];
  test("auto control block prints HALAMAN (NUMPAGES), DATUM GEODETIK (R-83) and VERIFIKASI (chain) in 4 x 2", async () => {
    const doc = clone(loadFixture());
    delete (doc.front!.cover!.data as { control?: unknown }).control;
    const r = await renderDocx(doc, {
      "cover.controlBlock.fields": FIELDS,
      "cover.controlBlock.preparerUnit": "Divisi Engineering PT GSP",
      "cover.controlBlock.geodeticDatum": "SRGI2013",
    });
    const control = coverTables(r.doc).find((t) => textOf(t).includes("Nomor dokumen"))!;
    const rows = control.match(/<w:tr[\s>]/g) ?? [];
    expect(rows.length).toBe(4);
    const t = textOf(control);
    for (const label of ["Nomor dokumen", "Revisi", "Penyusun", "Kustodian", "Ditujukan kepada", "Halaman", "Datum geodetik", "Verifikasi"]) expect(t).toContain(label);
    expect(t).toContain("Divisi Engineering PT GSP");
    expect(t).toContain("SRGI2013");
    expect(t).toContain("V2 · lulus");
    expect(control).toMatch(/NUMPAGES/);
  });
});

describe("CP-06 / CP-09 control sheet content and signatures from template data (ID p.48, p.10 DT-02)", () => {
  const OV = {
    "controlSheet.methodStatement.text": "Angka dibaca dari register ruang Rev A dan dihitung ulang oleh mesin.",
    "controlSheet.distribution.defaults": { rows: [["Induk", "Divisi Engineering PT GSP (ENG-01)", "Word dan PDF", "Tidak"]] },
  };
  test("three-layer chain, method statement, distribution and three signature columns in the control-sheet section", async () => {
    const r = await renderDocx(loadFixture(), OV);
    const sheet = sectionBlocks(r.doc, 1).map(textOf).join("\n");
    expect(sheet).toContain("Lembar Kendali");
    for (const id of ["V1", "V2", "V3"]) expect(sheet).toContain(id);
    expect(sheet).toContain("Pernyataan metode");
    expect(sheet).toContain(OV["controlSheet.methodStatement.text"]);
    expect(sheet).toContain("Distribusi terkendali");
    expect(sheet).toContain("Divisi Engineering PT GSP (ENG-01)");
    for (const role of ["DISUSUN", "DIPERIKSA", "DISAHKAN"]) expect(sheet).toContain(role);
    // order (CP-09): cover, control sheet with signatures, then contents
    expect(sectionBlocks(r.doc, 2).map(textOf).join("\n")).toContain("Daftar Isi");
  });

  test("the document's own verification rows are kept; added layers carry no result", async () => {
    const r = await renderDocx(loadFixture(), OV);
    const chain = sectionBlocks(r.doc, 1).find((b) => b.startsWith("<w:tbl") && textOf(b).includes("Lapis"))!;
    const rowsText = (chain.match(/<w:tr[\s>][\s\S]*?<\/w:tr>/g) ?? []).map(textOf);
    expect(rowsText).toEqual(["LapisPeranNamaTanggal", "V1", "V2Verifikasilulus", "V3"]);
  });

  test("a document signature payload wins over the template roles", async () => {
    const doc = clone(loadFixture());
    doc.front!.signature = { type: "signatureBlock", roles: [{ role: { text: "Disusun" }, holder: { text: "Penulis uji" } }] };
    const r = await renderDocx(doc, OV);
    const sheet = sectionBlocks(r.doc, 1).map(textOf).join("\n");
    expect(sheet).toContain("Penulis uji");
    expect(sheet).not.toContain("Direktur Utama");
  });
});

describe("CP-11 sheet numbering restarts at Bab 1 (ID p.48; EN p.50 counts from the cover)", () => {
  test("ID: the first chapter section restarts PAGE at 1, front sections do not", async () => {
    const r = await renderDocx();
    const sects = r.doc.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/g) ?? [];
    expect(sects.length).toBe(4);
    expect(sects.slice(0, 3).some((s) => s.includes("w:pgNumType"))).toBe(false);
    expect(sects[3]).toContain('<w:pgNumType w:start="1"/>');
  });
  test("EN keeps counting from the cover (no restart)", async () => {
    const doc = clone(loadFixture());
    doc.meta.language = "EN";
    const r = await renderDocx(doc);
    expect(r.doc).not.toContain("w:pgNumType");
  });
});

describe("CP-28 caption label bold capitals (DT-15 ID p.41)", () => {
  test("table caption label stays bold caps with a template caption role that has no labelRun", async () => {
    const r = await renderDocx(loadFixture(), {}, (tpl) => ({
      ...tpl,
      roleFormats: { ...tpl.roleFormats, caption: { run: { faceRole: "condensed", szHalfPt: 15, color: "2B3640", b: false } } },
    }));
    const cap = paragraphs(r.doc).find((p) => textOf(p).startsWith("Tabel 1.1"))!;
    const label = runs(cap)[0];
    expect(label.text).toBe("Tabel 1.1 ");
    expect(label.rPr).toContain("<w:b/>");
    expect(label.rPr).toContain("<w:caps/>");
  });
  test("figure caption label is bold caps even when the role labelRun says b:false", async () => {
    const base = await canonicalTemplate();
    const tpl = { ...base, roleFormats: { ...base.roleFormats, caption: { labelRun: { faceRole: "condensed", b: false, caps: false, szHalfPt: 14 }, run: { faceRole: "condensed", b: false, szHalfPt: 15 } } } } as typeof base;
    const { ctx } = makeCtx(snapshotOf(loadFixture()), tpl);
    const block = { blockId: "fig-1", type: "diagram", artifactLabel: "Gambar 1.1", address: "1/1", content: {} } as unknown as NormBlock;
    const xml = figure.captionXml(block, { inline: { text: "Arsitektur sistem pemantauan." } } as never, ctx);
    const label = runs(xml)[0];
    expect(label.text).toBe("Gambar 1.1 ");
    expect(label.rPr).toContain("<w:b/>");
    expect(label.rPr).toContain("<w:caps/>");
  });
});

describe("CP-30 derivation label printed once (DT-24 ID p.40)", () => {
  test("title that already carries 'Turunan D-1.1 ·' is not repeated", async () => {
    const r = await renderDocx();
    const label = paragraphs(r.doc).find((p) => textOf(p).includes("Beban puncak perangkat"))!;
    expect(textOf(label)).toBe("Turunan D-1.1 · Beban puncak perangkat");
  });
  test("helper: plain title, EN, and title equal to the label", () => {
    expect(texts.derivationLabelText("D-1.1", "Beban puncak", "ID")).toBe("Turunan D-1.1 · Beban puncak");
    expect(texts.derivationLabelText("D-1.1", "Derivation D-1.1 · Peak load", "EN")).toBe("Derivation D-1.1 · Peak load");
    expect(texts.derivationLabelText("D-1.1", "Turunan D-1.1", "ID")).toBe("Turunan D-1.1");
    // case 05 material: the title carries another number than the engine's numbering
    expect(texts.derivationLabelText("D-4.1", "Turunan D-4.2 · Panjang kabel dan batas bus", "ID")).toBe("Turunan D-4.1 · Panjang kabel dan batas bus");
    expect(texts.derivationLabelText("D-4.1", "Turunan tegangan jatuh", "ID")).toBe("Turunan D-4.1 · Turunan tegangan jatuh");
  });
});

describe("CP-47 DOCX raster width: 128 mm = 1512 px +-2 at 300 dpi (ID p.61, p.70, p.80 cek 13)", () => {
  // The bridge (runtime.ts) and Chromium truncate the CSS clip before scaling: device px = floor(trunc(cssW) * scale).
  const devicePx = (css: number, scale: number) => Math.floor(Math.trunc(css) * scale);
  test("128 mm and 166 mm, with and without a matching SVG root size", () => {
    for (const [mm, want] of [[128, 1512], [166, 1961]] as const) {
      for (const root of [null, { width: (mm * 96) / 25.4, height: (60 * 96) / 25.4 }]) {
        const g = browser.rasterGeometry(mm, 60, 300, root);
        expect(Math.abs(devicePx(g.cssW, g.scale) - want)).toBeLessThanOrEqual(2);
        expect(Math.abs(devicePx(g.cssH, g.scale) - 709)).toBeLessThanOrEqual(2);
      }
    }
    expect(devicePx(browser.rasterGeometry(128, 60, 300).cssW, 300 / 96)).toBe(1512);
  });
});

describe("CP-51 no stranded heading: caption, table header and first row kept together (ID p.80 cek 33)", () => {
  test("header-row and first body-row paragraphs keep with next; later rows do not", async () => {
    const r = await renderDocx();
    const tbl = bodyBlocks(r.doc).find((b) => b.startsWith("<w:tbl") && textOf(b).startsWith("NoUraianVolume"))!;
    const trs: string[] = tbl.match(/<w:tr[\s>][\s\S]*?<\/w:tr>/g) ?? [];
    expect(trs.length).toBeGreaterThanOrEqual(3);
    const keepAll = (tr: string) => paragraphs(tr).every((p) => p.includes("<w:keepNext/>"));
    expect(keepAll(trs[0])).toBe(true);
    expect(keepAll(trs[1])).toBe(true);
    expect(paragraphs(trs[2]).some((p) => p.includes("<w:keepNext/>"))).toBe(false);
    // section heading and caption already keep with next (unchanged)
    const heading = paragraphs(r.doc).find((p) => textOf(p).startsWith("1.1   "))!;
    expect(heading).toContain("<w:keepNext/>");
  });
});

describe("fixture sanity", () => {
  test("fixture is a TERBIT ID document", () => {
    const d: StudioDocV1 = loadFixture();
    expect(d.meta.tier).toBe("TERBIT");
    expect(d.meta.language).toBe("ID");
  });
});
