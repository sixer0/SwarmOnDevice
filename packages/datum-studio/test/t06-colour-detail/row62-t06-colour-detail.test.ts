// Swarm 1.2.6 row 62 (T-06, register E-10): the DATUM-25 refusal names WHICH colour values were
// counted, the source of each (edge.kind, mark, ...) and the remaining allowance. Limit unchanged (5).
// Red at e363918a69: the message printed only "6 nilai warna ... maksimum 5".
// Pure engine calls: no network, no model, no browser.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const PKG = path.resolve(import.meta.dir, "..", "..");
const ENGINE = path.join(PKG, "vendor", "src", "lib", "studio", "engine");
const build = await import(path.join(ENGINE, "diagram", "build", "index.ts"));
const tokens = await import(path.join(ENGINE, "diagram", "core", "tokens.ts"));
// 1.3.3 row 57 (ST-6): the colour budget and the token model, read directly (no engine spec reaches the refusal now).
const colour = await import(path.join(ENGINE, "diagram", "core", "colour.ts"));
const core = await import(path.join(ENGINE, "diagram", "core", "index.ts"));
const dispatch = await import(path.join(PKG, "vendor", "src", "lib", "studio", "contract", "dispatch.ts"));
/** The sheet `estimate` lays out for a spec (same calls), for the token model of colour sources. */
const sheetOf = (s: any): any => {
  const sheet = new core.Sheet(Number(s.width_mm), undefined, core.resolveDiagramGrid(undefined).latticeXMm);
  const res = dispatch.DIAGRAM_LAYOUTS[s.family](s, sheet);
  if (res) sheet.applyLayout(res, s);
  return sheet;
};

const CASE04 = JSON.parse(readFileSync(path.join(PKG, "test", "engine-rev-a", "svg", "fixtures", "case04.studio.json"), "utf8"));
const spec = (patch?: (s: any) => void): any => {
  const s = structuredClone(CASE04);
  patch?.(s);
  return s;
};
const hex = (token: string): string => String(tokens.colourOf(token)).toUpperCase();

/** The six-colour guard of row124-svg.test.ts: a verify edge (verd) plus an ASUMSI glyph (alert). */
const SIX = (s: any) => {
  s.nodes.find((n: any) => n.id === "db").mark = "ASUMSI";
  s.legend.push("ASUMSI = asumsi retensi");
  s.edges[4].kind = "verify";
};

describe("T-06 DATUM-25 detail: counted values, sources, remainder", () => {
  // 1.3.3 row 57 (ST-6, B-16, INTENT): SIX printed 6 values (inks, signal, alert, verd) and was refused; the inks now
  // count as one colour and the ASUMSI glyph (the only alert print) is a value-origin mark, so SIX builds. The limit
  // and the printed values are unchanged.
  test("SIX builds now: 6 printed values, budget 3 (tinta, verd, signal); limit unchanged (1.3.3 row 57)", () => {
    const r = build.buildDiagramSvg(spec(SIX), { release: false });
    expect(r.report.checksRun).toContain("DATUM-25");
    expect(r.report.colourValues.length).toBe(6);
    const b = colour.svgColourBudget(r.svg);
    expect(b.counted).toEqual(["tinta", hex("verd"), hex("signal")]);
    expect(b.marksOnly).toEqual([hex("alert")]);
    expect(tokens.LIMITS.max_colour_values).toBe(5);
  });

  // The detail of a refusal (row 62 intent) on the engine's own token model: every counted entry with its sources, the
  // ink entry with its values, the remainder (negative against a lower limit), and the values left out.
  test("the refusal detail lists every counted entry with its sources and the remainder", () => {
    const s = spec(SIX);
    const sheet = sheetOf(s);
    const sources = colour.diagramColourSources(s, sheet);
    const b = colour.diagramColourBudget(s, sheet);
    const msg = colour.colourBudgetDetail(b, sources, 1);
    expect(msg).toContain(`dihitung ${b.count}:`);
    const listed = [...msg.matchAll(/(#[0-9A-F]{6}) \(([^)]+)\)/g)].map((m) => ({ hex: m[1], src: m[2] }));
    expect(listed.length).toBe(b.count - 1); // plus the `tinta` entry
    for (const l of listed) expect(l.src.length).toBeGreaterThan(0);
    expect(msg).toMatch(/tinta \(#101418[^)]*: [^)]*label simpul/);
    const by = new Map(listed.map((l) => [l.hex, l.src]));
    expect(by.get(hex("verd"))).toContain("edge.kind verify");
    expect(msg).toContain(`tidak dihitung: tanda asal ${hex("alert")}`);
    expect(msg).toMatch(new RegExp(`sisa \u2212${b.count - 1}\\b`));
  });

  test("one value drawn by both a line kind and a glyph names both sources (rev 178/193 shape)", () => {
    // Case 04 carries glyphs TERUKUR, DITURUNKAN, PEMASOK; add an accent line (signal, same hex as the
    // DITURUNKAN glyph), an alert line and an ASUMSI glyph (alert), and a verify line (verd).
    // Since 1.2.8 row 35c the line-style budget (DATUM-25L, max 3 kinds when a node has a mark) is checked
    // first, so the accent line replaces the control line (kinds: data, verify, accent) and the figure
    // still reaches the DATUM-25 colour refusal.
    const s = spec((x: any) => {
      SIX(x);
      x.edges[5].kind = "accent";
      x.legend.push("accent = jalur utama");
    });
    // 1.3.3 row 57 (ST-6): this figure is within the budget now; the sources are read from the token model the
    // refusal detail uses (the intent: one value, both sources), and the value counts once.
    const sources = colour.diagramColourSources(s, sheetOf(s));
    const signal = (sources.get(hex("signal")) ?? []).join(", ");
    expect(signal).toContain("edge.kind accent");
    expect(signal).toContain("mark DITURUNKAN");
    expect((sources.get(hex("verd")) ?? []).join(", ")).toContain("edge.kind verify");
    const b = colour.diagramColourBudget(s, sheetOf(s));
    expect(b.counted.filter((v: string) => v === hex("signal")).length).toBe(1);
  });

  test("a figure within the limit builds unchanged", () => {
    const r = build.buildDiagramSvg(spec(), { release: false });
    expect(r.report.colourValues.length).toBeLessThanOrEqual(5);
  });
});
