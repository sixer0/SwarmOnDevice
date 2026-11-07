// Row 150c (C144 option A): the HS symbol sheet no longer prints overlapping text, and the diagram
// geometry lint reads the text inside `<g data-symbol>` groups that are only translated (sheet cells).
// Before the fix every dialect's unfitted sheet linted textOverlap (implementation/118_row150b_symbol_lint.md,
// implementation/119_row150c_symbol_sheet.md has the red and green runs).
// Pure engine calls: no network, no model, no browser, no file writes.
import { describe, expect, test } from "bun:test";
import path from "node:path";

const PKG = path.resolve(import.meta.dir, "..", "..", "..");
const STUDIO = path.join(PKG, "vendor", "src", "lib", "studio");
const { symbolSheetSvg } = await import(path.join(STUDIO, "engine", "symbols", "index.ts"));
const { SYMBOL_DIALECTS } = await import(path.join(STUDIO, "contract", "index.ts"));
const { lintDiagramGeometry, translateOnly } = await import(path.join(STUDIO, "engine", "diagram", "fit", "lint.ts"));
const { PARAMS_BY_KEY } = await import(path.join(STUDIO, "params", "index.ts"));

const MM_PER_PT = 25.4 / 72;
const kinds = (svg: string): string[] => lintDiagramGeometry(svg).defects.map((d: { kind: string }) => d.kind);
const texts = (svg: string): Array<{ x: number; y: number; size: number; body: string }> =>
  [...svg.matchAll(/<text\b[^>]*\bx="([^"]+)" y="([^"]+)"[^>]*font-size="([^"]+)"[^>]*>([^<]*)<\/text>/g)].map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
    size: Number(m[3]),
    body: m[4],
  }));

describe("row 150c: HS symbol sheet layout (manual Rev A ID Table 8.2, p. 50: Caption 7.6 / 11 pt)", () => {
  test("all 4 full sheets lint with 0 defects, default size and a 2-page 160 x 230 mm size", () => {
    for (const d of SYMBOL_DIALECTS) {
      for (const opts of [{}, { widthMm: 160, heightMm: 230 }]) {
        const sheets: string[] = symbolSheetSvg(d, undefined, opts);
        for (const s of sheets) expect({ d, opts, kinds: kinds(s) }).toEqual({ d, opts, kinds: [] });
      }
    }
  });

  test("fit sheets stay at 0 defects with cell text now read", () => {
    for (const d of SYMBOL_DIALECTS) expect(kinds(symbolSheetSvg(d, undefined, { fit: true })[0])).toEqual([]);
  });

  test("note lines and cell labels are set at the caption scale: leading >= size, from the registry", () => {
    const size = Number(PARAMS_BY_KEY.get("type.scale.caption.size").default) * MM_PER_PT;
    const lead = Number(PARAMS_BY_KEY.get("type.scale.caption.leading").default) * MM_PER_PT;
    expect(lead).toBeGreaterThanOrEqual(size);
    const t = texts(symbolSheetSvg("iec", undefined, {})[0]);
    const notes = t.filter((x) => x.x === 4 && x.y > 8 && x.y < 18); // sheet-level note lines (symbol letters sit in cells)
    expect(notes.length).toBe(2);
    for (const n of notes) expect(n.size).toBeCloseTo(size, 3);
    expect(notes[1].y - notes[0].y).toBeCloseTo(lead, 3);
    // the full IEC note now fits in 2 lines (HS cut it after "basis data")
    expect(notes.map((n) => n.body).join(" ")).toContain("(SM-11).");
    const ids = t.filter((x) => x.body === "iec:battery");
    const subs = t.filter((x) => x.body === "geometri konvensional");
    expect(ids.length).toBe(1);
    expect(subs.length).toBeGreaterThan(0);
    for (const x of [ids[0], subs[0]]) expect(x.size).toBeCloseTo(size, 3);
    expect(subs[0].y - ids[0].y).toBeCloseTo(lead, 3);
  });

  test("page counts are unchanged by the re-set labels (cell pitch untouched)", () => {
    expect(symbolSheetSvg("iec", undefined, { widthMm: 160, heightMm: 230 }).length).toBe(2);
    for (const d of SYMBOL_DIALECTS) expect(symbolSheetSvg(d, undefined, {}).length).toBe(1);
  });
});

describe("row 150c: lint reads text in translate-only data-symbol groups", () => {
  const head = '<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="60mm" viewBox="0 0 100 60">';
  const lbl = (x: number, y: number, size: number, body: string, bold = false) =>
    `<text x="${x}" y="${y}" font-family="IBM Plex Sans Condensed" font-size="${size}" text-anchor="middle"${bold ? ' font-weight="600"' : ""}>${body}</text>`;
  // The HS cell before row 150c: bold id at 6 mm and subtitle at 5 mm, 3.6 mm apart.
  const cell = (transform: string) =>
    `${head}<g transform="${transform}" data-mark="node" data-symbol="iec:battery">` +
    `<g transform="translate(2,0)"><line x1="0" y1="0" x2="24" y2="24" stroke="#000" stroke-width="0.35"/></g>` +
    lbl(14, 28, 6, "iec:battery", true) +
    lbl(14, 31.6, 5, "geometri konvensional") +
    `</g></svg>`;

  test("a constructed collision between two cell labels is caught (translate-only cell)", () => {
    const l = lintDiagramGeometry(cell("translate(10,4)"));
    expect(l.counts.textOverlap).toBe(1);
    expect(l.defects[0]).toMatchObject({ kind: "textOverlap", text: "iec:battery", other: "geometri konvensional" });
  });

  test("the group offset is applied: a cell translated past the viewBox reports textOutside", () => {
    const ok = lintDiagramGeometry(cell("translate(10,4)")).counts.textOutside;
    const out = lintDiagramGeometry(cell("translate(80,40)")).counts.textOutside;
    expect(ok).toBe(0);
    expect(out).toBeGreaterThan(0);
  });

  test("a scaled group (node badge, row 124 CP-45) keeps its text skipped", () => {
    expect(kinds(cell("translate(10 4) scale(0.5)"))).toEqual([]);
  });

  test("a cell label colliding with a sheet label outside the group is caught", () => {
    const svg =
      `${head}<g transform="translate(10,4)" data-mark="node" data-symbol="iec:battery">${lbl(14, 28, 3, "iec:battery", true)}</g>` +
      `${lbl(24, 32, 3, "iec:battery LEGEND")}</svg>`;
    expect(kinds(svg)).toContain("textOverlap");
  });

  test("translateOnly parses translate(x[, y]) and refuses any other transform", () => {
    expect(translateOnly(undefined)).toEqual([0, 0]);
    expect(translateOnly("translate(4.5,18)")).toEqual([4.5, 18]);
    expect(translateOnly("translate(3 -2)")).toEqual([3, -2]);
    expect(translateOnly("translate(7)")).toEqual([7, 0]);
    expect(translateOnly("translate(1,2) scale(0.5)")).toBeNull();
    expect(translateOnly("scale(2)")).toBeNull();
    expect(translateOnly("matrix(1 0 0 1 2 3)")).toBeNull();
  });
});
