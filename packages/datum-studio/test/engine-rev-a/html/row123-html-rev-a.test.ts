// Row 123 (Swarm 1.2.0, decisions C40/C56): Rev A fixes in the vendored Studio engine, HTML and the PDF printed from
// it. Each describe block is one conformance point of research/14_rev_a_conformance_points.md with the Manual Rev A
// (ID) page it enforces. Rendering goes through normalizeDocument -> assembleHtml (no DB, no browser, no network).
// The printed-PDF side (real Chromium pagination, fonts, overlaps) is checked by implementation/52's print evidence.
import { describe, expect, test } from "bun:test";
import type { StudioDocV1 } from "../../../vendor/src/lib/studio/contract";
import { cssOf, loadFixture, renderHtml, textOf } from "./_kit";

const texts = await import("../../../vendor/src/lib/studio/engine/front/texts");
const shell = await import("../../../vendor/src/lib/studio/engine/html/base/shell");
const classes = await import("../../../vendor/src/lib/studio/engine/html/assemble/classes");

const EM_DASH = "—";
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const bodyOf = (html: string) => html.slice(html.indexOf("<body"));
const styleOf = (tag: string) => /style="([^"]*)"/.exec(tag)?.[1] ?? "";
/** First opening tag carrying `data-role="<role>"`. */
const roleTag = (html: string, role: string) => new RegExp(`<[a-z0-9]+\\b[^>]*data-role="${role.replace(/\./g, "\\.")}"[^>]*>`).exec(html)?.[0] ?? "";
const PLEX_ONLY_DECL = /font-family:&#39;(IBM Plex[^&]*)&#39;(?!,)/g;

describe("CP-02 logo once, on the cover, 44-46 mm (ID p.47 butir 2, DT-14)", () => {
  test("the cover logo carries a 44 mm width (before: no size, printed at 2390 px = 421.6 mm)", async () => {
    const r = await renderHtml();
    const imgs = [...bodyOf(r.html).matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
    expect(imgs.length).toBe(1);
    expect(r.unit("cover")).toContain(imgs[0]);
    expect(styleOf(imgs[0])).toContain("width:44mm");
  });
});

describe("CP-04 cover kicker 7,4 pt Cond 600 seal capitals +0,20 em (ID p.47 butir 6)", () => {
  test("kicker run: 7.4 pt, #6E1420, bold caps, tracking 1.48 pt (before: 7 pt amber #B45309)", async () => {
    const r = await renderHtml();
    const tag = roleTag(r.unit("cover"), "wrapper.kicker");
    const st = styleOf(tag);
    expect(st).toContain("font-size:7.4pt");
    expect(st).toContain("color:#6E1420");
    expect(st).toContain("letter-spacing:1.48pt");
    expect(tag).toMatch(/class="[^"]*\bst-b\b[^"]*\bst-caps\b/);
  });
});

describe("CP-07 seal band: text #F4F5F6, classification left, copy control right (ID p.49 Tabel 8.1)", () => {
  test("band texts and colour on cover, control sheet and contents; no band in a chapter", async () => {
    const r = await renderHtml();
    for (const kind of ["cover", "controlSheet", "toc"]) {
      const u = r.unit(kind);
      const band = /<div class="st-device st-seal-band[^>]*>[\s\S]*?<\/div>/.exec(u)?.[0] ?? "";
      expect(band).not.toBe("");
      expect(styleOf(band)).toContain("color:#F4F5F6");
      expect(textOf(/<span class="st-seal-left">[\s\S]*?<\/span>/.exec(band)?.[0] ?? "")).toBe("KLASIFIKASI · TERBATAS");
      expect(textOf(/<span class="st-seal-right">[\s\S]*?<\/span>/.exec(band)?.[0] ?? "")).toBe("SALINAN INDUK · PENGGUNAAN INTERNAL GSP");
    }
    for (const u of r.units("chapter")) expect(u).not.toContain("st-seal-band");
  });
});

describe("CP-14 issue stamp U+2014 and the classification letter (ID p.1, p.37 Tabel 6.2, p.49)", () => {
  test("hand-written stamp `// 20261106 ID A · TERBITAN 1` prints as `// 20261106 ID T — TERBITAN 1`", async () => {
    const r = await renderHtml();
    const right = /<span class="st-colophon-right[^>]*>[\s\S]*?<\/span>/.exec(r.unit("cover"))?.[0] ?? "";
    expect(textOf(right)).toBe(`// 20261106 ID T ${EM_DASH} TERBITAN 1`);
  });
  test("explicit cover body colophon is re-derived too", async () => {
    const doc = clone(loadFixture());
    doc.front!.cover = { mode: "explicit", body: [{ type: "colophon", left: { text: "PT GSP" }, right: { text: "// 20261106 ID T -- TERBITAN 2" } }] } as never;
    const r = await renderHtml(doc);
    expect(textOf(r.unit("cover"))).toContain(`// 20261106 ID T ${EM_DASH} TERBITAN 2`);
  });
});

describe("CP-15 classification line under the document number (DT-28c ID p.14)", () => {
  test("number cell: line break, `Klasifikasi : ` and TERBATAS bold seal", async () => {
    const r = await renderHtml();
    const cell = /<td[^>]*data-role="cover\.controlValue"[^>]*>012\/GSP\/KT\/XI\/2026[\s\S]*?<\/td>/.exec(r.unit("cover"))?.[0] ?? "";
    expect(cell).toContain("<br>");
    expect(textOf(cell)).toBe("012/GSP/KT/XI/2026\nKlasifikasi : TERBATAS");
    const level = /<span[^>]*>TERBATAS<\/span>/.exec(cell)?.[0] ?? "";
    expect(level).toMatch(/\bst-b\b/);
    expect(styleOf(level)).toContain("color:#6E1420");
  });
});

describe("CP-05 control block fields from shared helpers (ID p.47 butir 10)", () => {
  const FIELDS = ["NOMOR DOKUMEN", "REVISI", "PENYUSUN", "KUSTODIAN", "DITUJUKAN KEPADA", "HALAMAN", "DATUM GEODETIK", "VERIFIKASI"];
  test("auto block prints DATUM GEODETIK (R-83) and VERIFIKASI (chain summary); HALAMAN is not invented in HTML", async () => {
    const doc = clone(loadFixture());
    delete (doc.front!.cover!.data as { control?: unknown }).control;
    const r = await renderHtml(doc, {
      "cover.controlBlock.fields": FIELDS,
      "cover.controlBlock.preparerUnit": "Divisi Engineering PT GSP",
      "cover.controlBlock.geodeticDatum": "SRGI2013",
    });
    const block = /<table class="st-control">[\s\S]*?<\/table>/.exec(r.unit("cover"))?.[0] ?? "";
    const t = textOf(block);
    for (const label of ["Nomor dokumen", "Revisi", "Penyusun", "Kustodian", "Ditujukan kepada", "Datum geodetik", "Verifikasi"]) expect(t).toContain(label);
    expect(t).toContain("SRGI2013");
    expect(t).toContain("V2 · lulus");
    expect(t).not.toContain("Halaman");
  });
});

describe("CP-06 / CP-09 control sheet content and signatures from template data (ID p.48, p.10 DT-02)", () => {
  const OV = {
    "controlSheet.methodStatement.text": "Angka dibaca dari register ruang Rev A dan dihitung ulang oleh mesin.",
    "controlSheet.distribution.defaults": { rows: [["Induk", "Divisi Engineering PT GSP (ENG-01)", "Word dan PDF", "Tidak"]] },
  };
  test("three-layer chain, method statement, distribution and three signature columns on the control sheet", async () => {
    const r = await renderHtml(loadFixture(), OV);
    const sheet = r.unit("controlSheet");
    const t = textOf(sheet);
    for (const s of ["Pernyataan metode", OV["controlSheet.methodStatement.text"], "Distribusi terkendali", "Divisi Engineering PT GSP (ENG-01)"]) expect(t).toContain(s);
    const sig = /<table class="st-signature"[\s\S]*?<\/table>/.exec(sheet)?.[0] ?? "";
    expect([...sig.matchAll(/<th\b/g)].length).toBe(3);
    for (const role of ["DISUSUN", "DIPERIKSA", "DISAHKAN"]) expect(textOf(sig)).toContain(role);
    // order (CP-09): cover, control sheet with signatures, contents
    const order = ["cover", "controlSheet", "toc"].map((k) => r.html.indexOf(`data-unit="${k}"`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
  test("document verification rows kept, added layers carry no result", async () => {
    const r = await renderHtml(loadFixture(), OV);
    const chain = [...r.unit("controlSheet").matchAll(/<table[\s\S]*?<\/table>/g)].map((m) => m[0]).find((x) => textOf(x).includes("Lapis"))!;
    const rows = [...chain.matchAll(/<tr[\s\S]*?<\/tr>/g)].map((m) => textOf(m[0]).replace(/\s+/g, ""));
    expect(rows).toEqual(["LapisPeranNamaTanggal", "V1", "V2Verifikasilulus", "V3"]);
  });
  test("a document signature wins; NOTA gets no template wrapper parts", async () => {
    const doc = clone(loadFixture());
    doc.front!.signature = { type: "signatureBlock", roles: [{ role: { text: "Disusun" }, holder: { text: "Penulis uji" } }] };
    const r = await renderHtml(doc, OV);
    expect(textOf(r.unit("controlSheet"))).toContain("Penulis uji");
    expect(textOf(r.unit("controlSheet"))).not.toContain("Direktur Utama");
    const nota = clone(loadFixture());
    nota.meta.tier = "NOTA";
    const n = await renderHtml(nota, OV);
    expect(textOf(n.unit("controlSheet"))).not.toContain("DISAHKAN");
    expect(textOf(n.unit("controlSheet"))).not.toContain("V3");
  });
});

describe("CP-11 sheet numbering starts at Bab 1 (ID p.48; EN p.50 counts from the cover)", () => {
  const pageRule = (css: string, unitKey: string) => {
    const name = new RegExp(`\\.st-unit\\[data-unit-key="${unitKey.replace(/[:]/g, "\\:")}"\\]\\{page:(st-u-\\d+)\\}`).exec(css)?.[1];
    return name ? (new RegExp(`@page ${name}\\{[^\\n]*`).exec(css)?.[0] ?? "") : "";
  };
  test("ID: cover, control sheet and contents set the page counter to 0 and carry no register; Bab 1 does", async () => {
    const r = await renderHtml();
    const css = cssOf(r.html);
    for (const k of ["F:cover", "F:controlSheet", "F:toc"]) {
      const rule = pageRule(css, k);
      expect(rule).toContain("counter-set:page 0;");
      expect(rule).not.toContain("counter(page)");
    }
    const ch1 = pageRule(css, "1");
    expect(ch1).not.toContain("counter-set");
    expect(ch1).toContain("counter(page)");
    expect(ch1).toContain("counter(pages)");
  });
  test("EN: no restart", async () => {
    const doc = clone(loadFixture());
    doc.meta.language = "EN";
    const r = await renderHtml(doc);
    expect(cssOf(r.html)).not.toContain("counter-set:page");
  });
});

describe("CP-19 glyph fallback to DejaVu Sans, never a system font (ID p.50, p.89 A.2)", () => {
  test("no run declares a Plex face without the embedded symbol face after it", async () => {
    const r = await renderHtml();
    const body = bodyOf(r.html);
    expect([...body.matchAll(PLEX_ONLY_DECL)].map((m) => m[1])).toEqual([]);
    expect(body).toContain("font-family:&#39;IBM Plex Mono&#39;,&#39;DejaVu Sans&#39;");
  });
  test("figure SVG font-family attributes list DejaVu Sans before any generic family", async () => {
    const r = await renderHtml();
    const fig = /<figure[\s\S]*?<\/figure>/.exec(bodyOf(r.html))?.[0] ?? "";
    const fams = [...fig.matchAll(/\sfont-family="([^"]*)"/g)].map((m) => m[1]);
    expect(fams.length).toBeGreaterThan(0);
    for (const f of fams) expect(f).toMatch(/DejaVu Sans/);
  });
  test("DejaVu Sans is embedded as @font-face (data: URL)", async () => {
    const r = await renderHtml();
    expect(r.html).toMatch(/@font-face\{font-family:"DejaVu Sans";src:url\(data:font\/ttf;base64,/);
  });
});

describe("CP-23 Datum Rule lead grows with the page (ID p.53 DT-13f; tokens fill = page / pages)", () => {
  test("lead = width x sheet / sheets per unit; cover 166 x 1/5, Bab 1 128 x 4/5, Bab 2 128 x 5/5 (before: 9 mm everywhere)", async () => {
    const r = await renderHtml();
    const leads = [...bodyOf(r.html).matchAll(/<svg class="st-datum-rule"[^>]*viewBox="0 0 ([0-9.]+) [^"]*"[^>]*>[\s\S]*?<line data-st-lead="1" x1="0" y1="[^"]*" x2="([^"]*)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(leads).toEqual([
      [166, 33.2],
      [128, 102.4],
      [128, 128],
    ]);
  });
  test("helper clamps and rounds", () => {
    expect(texts.datumRuleLeadMm(128, 1, 8)).toBe(16);
    expect(texts.datumRuleLeadMm(128, 9, 8)).toBe(128);
    expect(texts.datumRuleLeadMm(166, 1, 3)).toBe(55.333);
  });
});

describe("CP-26 SUMBER within the 166 mm text span (ID p.51 DT-10a)", () => {
  test("table and figure SUMBER paragraphs are capped at 166 mm and wrap anywhere", async () => {
    const r = await renderHtml();
    const srcs = [...bodyOf(r.html).matchAll(/<p class="st-source" style="([^"]*)"/g)].map((m) => m[1]);
    expect(srcs.length).toBe(2);
    for (const s of srcs) {
      expect(s).toContain("max-width:166mm");
      expect(s).toContain("overflow-wrap:anywhere");
    }
  });
});

describe("CP-28 caption label bold capitals (DT-15 ID p.41)", () => {
  test("table and figure caption labels are weight 600 caps", async () => {
    const r = await renderHtml();
    const labels = [...bodyOf(r.html).matchAll(/<span class="st-caption-label" style="([^"]*)">([^<]*)</g)];
    expect(labels.map((m) => m[2])).toEqual(["Tabel 1.1", "Gambar 1.1"]);
    for (const m of labels) {
      expect(m[1]).toContain("font-weight:600");
      expect(m[1]).toContain("text-transform:uppercase");
    }
  });
});

describe("CP-30 derivation label printed once (DT-24 ID p.40)", () => {
  test("`Turunan D-1.1 · Beban puncak perangkat` (before: `Turunan Turunan D-1.1 · Turunan D-1.1 · ...`)", async () => {
    const r = await renderHtml();
    const label = /<p class="st-derivation-label"[^>]*>([\s\S]*?)<\/p>/.exec(r.html)?.[1] ?? "";
    expect(textOf(label)).toBe("Turunan D-1.1 · Beban puncak perangkat");
  });
});

describe("CP-35 figure key in the document language (ID p.13, p.67 Tabel 10.4)", () => {
  test("ID: KUNCI and the edge kinds by line pattern; the author's meanings unchanged", async () => {
    const r = await renderHtml();
    const key = textOf(/<p class="st-key"[\s\S]*?<\/p>/.exec(r.html)?.[0] ?? "");
    expect(key.startsWith("KUNCI")).toBe(true);
    expect(key).toContain("PENUH = ALIRAN DATA SENSOR · PUTUS-PUTUS = CATU DAYA · TITIK-TITIK = PEREKAMAN");
    expect(key).not.toMatch(/\b(KEY|CONTROL|SYNC)\b/);
  });
  test("EN document keeps the English key", async () => {
    const doc = clone(loadFixture()) as StudioDocV1;
    doc.meta.language = "EN";
    const r = await renderHtml(doc);
    const key = textOf(/<p class="st-key"[\s\S]*?<\/p>/.exec(r.html)?.[0] ?? "");
    expect(key).toContain("KEY  DATA = ALIRAN DATA SENSOR · CONTROL = CATU DAYA");
  });
  test("helper: row starts only; words inside a meaning stay", () => {
    expect(texts.keyLineText("KEY  DATA = ALIRAN DATA SENSOR · SYNC = PEREKAMAN DATA", "ID")).toBe("KUNCI  PENUH = ALIRAN DATA SENSOR · TITIK-TITIK = PEREKAMAN DATA");
    expect(texts.keyLineText("KEY  DATA = X", "EN")).toBe("KEY  DATA = X");
  });
});

describe("CP-37 no overlaps (ID p.52 Tabel 8.3, p.80 cek 37)", () => {
  // Row 122c (C96 O1): the row 123 raise to the line box (31.7 pt) is replaced by the manual's own cover pitch
  // (ID p.1: 24 pt title lines 28 pt apart; the line boxes overlap there too), shared with DOCX; see test/engine-rev-a/cover-title.
  test("cover title leading = the manual's 28 pt for 24 pt (row 123 had 31.7 pt; before 29 pt)", async () => {
    const r = await renderHtml();
    const line = roleTag(r.unit("cover"), "cover.titleFirst");
    const lh = Number(/line-height:([0-9.]+)pt/.exec(styleOf(line))?.[1]);
    expect(lh).toBe(28);
  });
  test("PROVENANS glyphs take the SUMBER size and the SUMBER paragraph has its own size (before: inherited 9.5 pt)", async () => {
    const r = await renderHtml();
    const src = /<p class="st-source" style="([^"]*)">([\s\S]*?)<\/p>/.exec(r.html)!;
    const size = /font-size:([0-9.]+pt)/.exec(src[1])?.[1];
    expect(size).toBeDefined();
    const glyphs = [...src[2].matchAll(/<span class="st-mark"[^>]*><span style="([^"]*)">/g)].map((m) => m[1]);
    expect(glyphs.length).toBe(2);
    for (const g of glyphs) expect(g).toContain(`font-size:${size}`);
  });
});

describe("CP-51 no stranded heading (ID p.80 cek 33, p.52)", () => {
  test("structural CSS keeps headings and captions with what follows and a table's first row with its head", () => {
    const css = classes.STUDIO_HTML_STRUCTURAL_CSS;
    expect(css).toContain(".st-chapter-head,.st-section-heading,.st-appendix-head,.st-caption,.st-derivation-label{break-after:avoid");
    expect(css).toContain("tr:first-child{break-before:avoid");
  });
});

describe("shell helpers (row 123)", () => {
  test("withSheetRestart leaves EN and documents without a front alone", async () => {
    const r = await renderHtml();
    const tpl = (await import("./_kit")).canonicalTemplate;
    const t = await tpl();
    const units = shell.scanUnits(t, bodyOf(r.html));
    const id = shell.withSheetRestart(t, loadFixture().meta, units);
    expect(id.filter((u) => u.beforeSheetOne).map((u) => u.kind)).toEqual(["cover", "controlSheet", "toc"]);
    const en = shell.withSheetRestart(t, { ...loadFixture().meta, language: "EN" }, units);
    expect(en.some((u) => u.beforeSheetOne)).toBe(false);
  });
});
