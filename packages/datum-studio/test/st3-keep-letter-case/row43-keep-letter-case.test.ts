// Swarm 1.3.3 row 43 (ST-3 item 4, gap matrix N6: "Edge labels and legend[] rows are forced to upper case: KW, MB/S,
// KN/M², COMMITEVIDENCE"). The author's own text of an edge label and of a key (legend) row prints with the letter
// case of the spec: Mb/s, kW, message names. Container titles, node tags and the fixed words KUNCI / SUMBER keep the
// house style (capitals).
//
// Replay: byte copies of the 16 round-2 specs (research/replay/R2_round2_specs). 15 are diagrams; u3/3.1 is a chart
// block (no edge label, no diagram key), so it is read and counted as "no diagram text", not rendered here.
// The assertion counts mismatches: an edge label or key row of the spec that is not printed character for character.
import { useStudioEnv } from "../ported/_env";
useStudioEnv();
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { buildDiagramSvg, buildDiagramSvgRaw } from "@/lib/studio/engine/diagram/build";
import { withDiagramFit } from "@/lib/studio/engine/diagram/fit/state";
import { svgText, svgTextLines, edgeLabelSvg } from "@/lib/studio/engine/diagram/core/svg";
import { role } from "@/lib/studio/engine/diagram/core/tokens";
import { keyLineTexts, keyRowTextOf, KEY_ROW_SEP } from "@/lib/studio/engine/diagram/core/sheet";
import { railPrintedText, railTextWidthMm } from "@/lib/studio/engine/diagram/fit/labels";
import { keyLineText } from "@/lib/studio/engine/front/texts";
import { measure } from "@/lib/studio/engine/chart/core/textfit";

type J = Record<string, any>;
const tokens = (await import("@/lib/studio/engine/diagram/core/tokens")) as J;
// Page-side kits, as row 45's test uses them (composed case document, template, render context).
const K = (await import("../engine-rev-a/row165a/_kit")) as J;
const R = (await import("../ported/renderers/_kit")) as J;
const compose = (await import("@/lib/studio/services/compose")) as J;
const inline = (await import("@/lib/studio/services/compose/inline")) as J;
const htmlApp = (await import("@/lib/studio/engine/html/tables/apparatus")) as J;
const docxFig = (await import("@/lib/studio/engine/docx/figures/figure")) as J;
const BCTX = { glyphs: compose.glyphSet(undefined), params: {}, classification: "TERBATAS", artifactLabel: "Gambar 2.1" };

const FIX = path.join(import.meta.dir, "fixtures");
const FILES = readdirSync(FIX)
  .filter((f) => f.startsWith("r2_") && f.endsWith(".json"))
  .sort();
const KEY = "KUNCI";

/** The block of a replay file: u1/u2 files are the block; u3 files wrap it as `{diagram}` or `{chart}`. */
function blockOf(file: string): { kind: "diagram" | "chart"; block: J } {
  const raw = JSON.parse(readFileSync(path.join(FIX, file), "utf8")) as J;
  if (raw.chart) return { kind: "chart", block: raw.chart };
  return { kind: "diagram", block: raw.diagram ?? raw };
}
const textOf = (v: unknown): string => (typeof v === "string" ? v : String((v as J)?.text ?? ""));

/** A stand-alone `studio.diagram/v1` spec of a replay block; `apparatus: "figure"` so the SVG draws its own key row. */
function specOf(block: J, apparatus: "figure" | "page" = "figure"): J {
  return {
    $schema: "studio.diagram/v1",
    id: "2.1",
    title: textOf(block.caption),
    classification: "TERBATAS",
    width_mm: 166,
    apparatus,
    sources: [textOf(block.source)],
    ...block.spec,
  };
}

const unesc = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
/** Printed text of every `<text>` in document order; a wrapped text (tspans) is its lines joined by one space. */
function svgTexts(svg: string): string[] {
  return (svg.match(/<text\b[^>]*>[\s\S]*?<\/text>/g) ?? []).map((t) =>
    unesc(
      t
        .replace(/<\/tspan>\s*<tspan/g, "</tspan> <tspan")
        .replace(/<[^>]+>/g, ""),
    ),
  );
}
/** The key the SVG prints: every line from the one that opens with the label up to the source line, joined. */
function svgKey(svg: string): string {
  const all = svgTexts(svg);
  const at = all.findIndex((t) => t.startsWith(`${KEY}  `));
  if (at < 0) return "";
  const out: string[] = [];
  for (let i = at; i < all.length; i++) {
    if (i > at && /^(SUMBER|SOURCE)\b/.test(all[i])) break;
    out.push(all[i]);
  }
  return out.join(" ");
}
const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

interface Count {
  edgeLabels: number;
  keyRows: number;
  mismatches: string[];
}

/** Edge labels of the spec that the SVG does not print character for character (on the line or as a note row). */
function edgeMismatches(file: string, spec: J, svg: string, c: Count): void {
  const printed = svgTexts(svg);
  for (const e of (spec.edges ?? []) as J[]) {
    if (e.label === undefined || e.label === "") continue;
    c.edgeLabels++;
    if (!printed.includes(String(e.label))) c.mismatches.push(`${file} edge "${e.label}"`);
  }
}
/** Key rows of the spec that the printed key does not hold verbatim. A key may wrap, so it is compared space-squashed. */
function keyMismatches(file: string, rows: string[], printedKey: string, c: Count): void {
  const key = squash(printedKey);
  for (const row of rows) {
    c.keyRows++;
    if (!key.includes(squash(row))) c.mismatches.push(`${file} key "${row}"`);
  }
}

const OPTS = { release: false, keyLabel: KEY } as any;
const fitSvg = (s: J): string => withDiagramFit({ notes: [] }, () => buildDiagramSvgRaw(s as any, OPTS)).svg;
const DIAGRAMS = FILES.map((f) => ({ f, b: blockOf(f) }))
  .filter((x) => x.b.kind === "diagram")
  .map((x) => ({ f: x.f, block: x.b.block, spec: specOf(x.b.block) }));
const idWord = (row: string): string => keyLineText(row, "ID");

describe("row 43: replay of the 16 round-2 specs, letter case of edge labels and key rows", () => {
  test("the fixture set is the 16 replay files: 15 diagrams and 1 chart", () => {
    expect(FILES.length).toBe(16);
    expect(DIAGRAMS.length).toBe(15);
    expect(FILES.filter((f) => blockOf(f).kind === "chart")).toEqual(["r2_u3_3.1.json"]);
  });

  test("the specs do carry mixed case (the replay can fail)", () => {
    const texts = DIAGRAMS.flatMap((d) => [...((d.spec.edges ?? []) as J[]).map((e) => String(e.label ?? "")), ...((d.spec.legend ?? []) as string[])]);
    expect(texts.filter((t) => t !== t.toUpperCase()).length).toBe(88);
    expect(texts).toContain("1 CommitEvidence");
  });

  test("edge labels, default pipeline: every label equals the spec text, mismatches = 0", () => {
    const c: Count = { edgeLabels: 0, keyRows: 0, mismatches: [] };
    for (const d of DIAGRAMS) edgeMismatches(d.f, d.spec, buildDiagramSvg(d.spec as any, OPTS).svg, c);
    console.log(`row43 replay, edge labels, default pipeline: ${c.edgeLabels} labels, mismatches ${c.mismatches.length}`);
    expect(c.edgeLabels).toBe(84);
    expect(c.mismatches).toEqual([]);
  });

  test("edge labels, fit path: every label equals the spec text, mismatches = 0", () => {
    const c: Count = { edgeLabels: 0, keyRows: 0, mismatches: [] };
    for (const d of DIAGRAMS) edgeMismatches(d.f, d.spec, fitSvg(d.spec), c);
    console.log(`row43 replay, edge labels, fit path: ${c.edgeLabels} labels, mismatches ${c.mismatches.length}`);
    expect(c.edgeLabels).toBe(84);
    expect(c.mismatches).toEqual([]);
  });

  test("key rows, the key line as core draws it (`upper: false`): every row equals the spec text, mismatches = 0", () => {
    // The two parts build/svg.ts joins for a key line: the producer's lines (core/sheet.ts keyLineTexts) and svgText
    // with role table_header. With `upper: false` the line is printed as written.
    const c: Count = { edgeLabels: 0, keyRows: 0, mismatches: [] };
    for (const d of DIAGRAMS) {
      const lines = keyLineTexts(d.spec as any, d.spec.width_mm, KEY).map((t) => svgText(0, 0, t, { role: "table_header", colourToken: "ink400", anchor: "start", upper: false }));
      keyMismatches(d.f, d.spec.legend ?? [], svgTexts(lines.join("")).join(" "), c);
    }
    console.log(`row43 replay, key rows, core key line: ${c.keyRows} rows, mismatches ${c.mismatches.length}`);
    expect(c.keyRows).toBe(50);
    expect(c.mismatches).toEqual([]);
  });

  test("key rows, page KUNCI row of a document (HTML and DOCX): every row equals the spec text, mismatches = 0", async () => {
    const ctx = R.makeCtx(K.compose(K.loadCase("case01.json")), await K.kanonikTemplate()).ctx;
    const html: Count = { edgeLabels: 0, keyRows: 0, mismatches: [] };
    const docx: Count = { edgeLabels: 0, keyRows: 0, mismatches: [] };
    for (const d of DIAGRAMS) {
      const rows = ((d.spec.legend ?? []) as string[]).map(idWord); // the case document is Indonesian: edge-kind words only
      const field = inline.apparatusInline({ text: keyRowTextOf(d.spec as any) }, "key", BCTX);
      const h = htmlApp.keyRowHtml(field, ctx) as string;
      keyMismatches(d.f, rows, h.replace(/<[^>]+>/g, "").replace(/&#160;|&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"), html);
      // the text run of the row carries no capitals presentation: only the label run does
      expect((h.match(/st-caps|text-transform:\s*uppercase/g) ?? []).length).toBeLessThanOrEqual(1);
      const x = docxFig.keyRowXml(field, ctx) as string;
      keyMismatches(d.f, rows, unesc([...x.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("")), docx);
      expect((x.match(/<w:caps\b/g) ?? []).length).toBeLessThanOrEqual(1);
    }
    console.log(`row43 replay, key rows, page row: HTML ${html.keyRows} rows, mismatches ${html.mismatches.length}; DOCX ${docx.keyRows} rows, mismatches ${docx.mismatches.length}`);
    expect(html.mismatches).toEqual([]);
    expect(docx.mismatches).toEqual([]);
  });

  // build/svg.ts draws the key line with `upper: false` (request of row 43, applied by row 54).
  test("key rows, full SVG: every row equals the spec text, mismatches = 0 (as written, and with the Indonesian wording)", () => {
    const c: Count = { edgeLabels: 0, keyRows: 0, mismatches: [] };
    for (const d of DIAGRAMS) {
      keyMismatches(d.f, d.spec.legend ?? [], svgKey(buildDiagramSvg(d.spec as any, OPTS).svg), c);
      keyMismatches(d.f, ((d.spec.legend ?? []) as string[]).map(idWord), svgKey(buildDiagramSvg(d.spec as any, { ...OPTS, keyRowText: idWord }).svg), c);
      keyMismatches(d.f, d.spec.legend ?? [], svgKey(fitSvg(d.spec)), c);
    }
    console.log(`row43 replay, key rows, full SVG (default, ID wording, fit path): ${c.keyRows} rows, mismatches ${c.mismatches.length}`);
    expect(c.keyRows).toBe(150);
    expect(c.mismatches).toEqual([]);
  });
});

describe("row 43: where the case is decided", () => {
  test("an edge label prints as written; its band and text come from edgeLabelSvg", () => {
    const [, text] = edgeLabelSvg(40, 20, "OS2 · 64 Mb/s", "data", 166);
    expect(text).toContain(">OS2 · 64 Mb/s</text>");
    expect(svgText(0, 0, "12 kW · kN/m²", { role: "evidence_rail" })).toContain(">12 kW · kN/m²</text>");
  });

  test("the token of the role is unchanged (house style); the diagram engine prints the role in source case", () => {
    expect(role("evidence_rail").upper).toBe(true);
    expect(typeof tokens.roleUpper).toBe("function");
    expect(tokens.roleUpper("evidence_rail")).toBe(false);
    expect(tokens.roleUpper("table_header")).toBe(true);
    expect(tokens.roleUpper("caption")).toBe(false);
  });

  test("container titles and node tags (role table_header) keep capitals; `upper: false` prints a key line as written", () => {
    expect(svgText(0, 0, "Zona inti", { role: "table_header" })).toContain(">ZONA INTI</text>");
    expect(svgText(0, 0, "KUNCI  garis penuh = 10 Mb/s", { role: "table_header", upper: false })).toContain(">KUNCI  garis penuh = 10 Mb/s</text>");
    expect(svgText(0, 0, "abc", { role: "caption", upper: true })).toContain(">ABC</text>");
    const wrapped = svgTextLines({ x: 0, y: 0, lines: ["Zona a", "kW b"], lineMm: 3 }, { role: "table_header" });
    expect(wrapped).toContain("ZONA A");
    expect(svgTextLines({ x: 0, y: 0, lines: ["Zona a", "kW b"], lineMm: 3 }, { role: "table_header", upper: false })).toContain("kW b");
    expect(svgTextLines({ x: 0, y: 0, lines: ["Mb/s a", "kW b"], lineMm: 3 }, { role: "evidence_rail" })).toContain("Mb/s a");
  });

  test("the measured text of an edge label is the printed text (seam of row 42)", () => {
    expect(railPrintedText("64 Mb/s")).toBe("64 Mb/s");
    // mono face: 0.6 em per glyph at 5.9 pt, the same for either case
    expect(railTextWidthMm("64 Mb/s")).toBeCloseTo(7 * 0.6 * 5.9 * (25.4 / 72), 6);
    expect(railTextWidthMm("64 Mb/s")).toBeCloseTo(railTextWidthMm("64 MB/S"), 9);
  });

  test("the SVG key row is the single producer's text, verbatim, and its lines are measured in the printed case", () => {
    const spec = { legend: ["garis penuh = data 10 Mb/s", "putus-putus = kendali 3 kW", "CommitEvidence = nama pesan"] };
    expect(keyLineTexts(spec, 166, KEY)).toEqual([`${KEY}  ${keyRowTextOf(spec)}`]);
    expect(keyRowTextOf(spec)).toBe(spec.legend.join(KEY_ROW_SEP));
    // every line the producer returns fits the sheet in the case it is printed in
    const r = role("table_header");
    const font = { bold: true, trackMm: (r.size * 25.4) / 72 * 0.09 };
    for (const W of [60, 90, 128]) for (const line of keyLineTexts(spec, W, KEY)) expect(measure(line, r.size, "struct", font)).toBeLessThanOrEqual(W - 0.5 + 1e-9);
  });

  test("a full figure: edge label and key row as written, container title and fixed words in capitals", () => {
    const s = {
      $schema: "studio.diagram/v1",
      id: "1.1",
      title: "Uji huruf sumber dipertahankan.",
      classification: "TERBATAS",
      width_mm: 166,
      apparatus: "figure",
      sources: ["uji baris 43"],
      family: "layered",
      labels_verified: true,
      legend: ["garis penuh = tautan 10 Mb/s", "kW = daya aktif"],
      zones: [{ id: "z1", label: "Zona inti", members: ["a", "b"] }],
      nodes: [
        { id: "a", label: "Sakelar A", class: { tier: 1 } },
        { id: "b", label: "Sakelar B", class: { tier: 2 } },
      ],
      edges: [{ from: "a", to: "b", kind: "data", label: "10 Mb/s · 3 kW" }],
    };
    const svg = buildDiagramSvg(s as any, OPTS).svg;
    const t = svgTexts(svg);
    expect(t).toContain("10 Mb/s · 3 kW");
    expect(t).toContain(`${KEY}  garis penuh = tautan 10 Mb/s${KEY_ROW_SEP}kW = daya aktif`);
    expect(t).toContain("ZONA INTI"); // container title: house style
    expect(t.some((x) => x.startsWith("SUMBER  "))).toBe(true);
    expect(svg).not.toMatch(/MB\/S|KW/);
  });
});
