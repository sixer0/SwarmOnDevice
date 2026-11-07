// Row 124b (C62, C69): two follow-ups of row 124 in the vendored Studio diagram engine.
// (1) CP-45: `nodes[].symbol` reaches the engine through the Studio contract (schema v1 and the v2
//     DiagramSpecV2 that reuses its node schema), is drawn, and has a key row.
// (2) CP-35: the key drawn inside a diagram SVG is worded in the document language (ID: KUNCI and the
//     edge kinds by line pattern; EN: KEY), passed by the figure caller (services/render/figures.ts).
// Each describe block fails on the tree before row 124b (red run in implementation/61_row124b_symbol_key.md).
// Pure calls: no network, no model, no browser, no file writes.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const PKG = path.resolve(import.meta.dir, "..", "..", "..");
const STUDIO = path.join(PKG, "vendor", "src", "lib", "studio");
const build = await import(path.join(STUDIO, "engine", "diagram", "build", "index.ts"));
const validate = await import(path.join(STUDIO, "services", "ingest", "validate.ts"));
const commonV2 = await import(path.join(STUDIO, "contract", "schema", "v2", "common.schema.ts"));
const compose = await import(path.join(STUDIO, "services", "compose", "blocks.ts"));
const figures = await import(path.join(STUDIO, "services", "render", "figures.ts"));
const geom = await import(path.join(STUDIO, "engine", "diagram", "fit", "lint.ts"));

const fixture = (name: string) => JSON.parse(readFileSync(path.join(import.meta.dir, "fixtures", name), "utf8"));
/** Byte copy of test/material_rev_a_v2/Kasus 04 Diagram/gambar.studio.json (frozen material v2, sha256 9f5fb939...44ba). */
const CASE04 = fixture("case04_v2.studio.json");
/** The diagram block of test/material_rev_a_v2/Kasus 05 Lembar/lembar.studio.json (sha256 4802c21e...166d, language ID), chapters[0].sections[2].blocks[0]. */
const CASE05_BLOCK = fixture("case05_diagram_block.json");

/** Case 04 with the symbol the original DATUM spec names (test/material/Kasus 04 Diagram/gambar.json:23). */
const case04WithBattery = () => {
  const s = structuredClone(CASE04);
  s.nodes.find((n: { id: string }) => n.id === "ups").symbol = "iec:battery";
  return s;
};

const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
/** Key lines drawn in the SVG: table_header role at the left margin (SemiBold, tracked). */
const keyLines = (svg: string): string[] =>
  [...svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)]
    .filter((m) => /\bx="0"/.test(m[1]) && /font-weight="600"/.test(m[1]) && /letter-spacing=/.test(m[1]))
    .map((m) => unesc(m[2].replace(/<[^>]+>/g, "")));

// ── CP-45: the symbol is part of the spec contract, drawn, and named in the key ─────────────────
describe("CP-45 node symbol reaches the engine (Table 10.1, SM-01/03/04, ID p.63, 66)", () => {
  test("the frozen case 04 Studio material names no symbol (the fixture adds it)", () => {
    expect(CASE04.nodes.some((n: Record<string, unknown>) => "symbol" in n)).toBe(false);
  });

  test("studio.diagram/v1 accepts nodes[].symbol", () => {
    expect(validate.validateAgainst("studio.diagram/v1", case04WithBattery())).toEqual([]);
  });

  test("the v2 document diagram spec (DiagramSpecV2) accepts nodes[].symbol", () => {
    const v = validate.studioValidator(`${commonV2.COMMON_V2_SCHEMA_ID}#/$defs/DiagramSpecV2`);
    const spec = structuredClone(CASE05_BLOCK.spec);
    spec.nodes.find((n: { id: string }) => n.id === "ups").symbol = "iec:battery";
    expect(v(spec)).toBe(true);
  });

  test("the schema still refuses a malformed symbol (empty, not a string, over 64 chars)", () => {
    for (const bad of ["", 7, "x".repeat(65)]) {
      const s = case04WithBattery();
      s.nodes.find((n: { id: string }) => n.id === "ups").symbol = bad;
      const issues = validate.validateAgainst("studio.diagram/v1", s);
      expect(issues.some((i: { pointer: string }) => i.pointer.startsWith("/nodes/6/symbol"))).toBe(true);
    }
  });

  test("a validated spec with iec:battery on ups draws the symbol inside the UPS box", () => {
    const s = case04WithBattery();
    expect(validate.validateAgainst("studio.diagram/v1", s)).toEqual([]);
    const svg = build.buildDiagramSvg(s, { release: false }).svg;
    const g = /<g\b[^>]*\bdata-symbol="iec:battery"[^>]*\bdata-symbol-of="ups"[^>]*>/.exec(svg);
    expect(g).not.toBeNull();
  });

  test("the key of that figure has a row naming the symbol, besides every legend row", () => {
    const key = keyLines(build.buildDiagramSvg(case04WithBattery(), { release: false }).svg).join("  ·  ");
    expect(key).toContain("IEC:BATTERY = BATERAI (IEC 60617 DB)");
    for (const row of CASE04.legend) expect(key).toContain(String(row).toUpperCase());
  });
});

// ── CP-35: the in-SVG key follows the document language (ID p.13, p.67 Tabel 10.4) ─────────────
describe("CP-35 in-SVG key label from the figure caller", () => {
  // The case 05 figure as compose builds it (apparatus page, no page key row): the key is drawn in the SVG.
  const case05Spec = () =>
    compose.diagramSpec(CASE05_BLOCK.spec, CASE05_BLOCK.caption.text, CASE05_BLOCK.source.text, 128, { artifactLabel: "4.1", classification: "TERBATAS" });
  const svgIn = (lang: "ID" | "EN") => build.buildDiagramSvg(case05Spec(), { release: false, ...figures.diagramApparatusOptions(lang) }).svg;

  test("an ID document's in-SVG key reads KUNCI with the edge kinds by line pattern", () => {
    const lines = keyLines(svgIn("ID"));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0].startsWith("KUNCI  ")).toBe(true);
    const key = lines.join("  ·  ");
    expect(key).not.toMatch(/\bKEY\b/);
    expect(key).toContain("PENUH = ALIRAN DATA SENSOR");
    expect(key).toContain("PUTUS-PUTUS = CATU DAYA");
    expect(key).toContain("TITIK-TITIK = PEREKAMAN");
    expect(key).toContain("DITURUNKAN = NILAI TURUNAN");
  });

  test("an EN document's in-SVG key reads KEY with the rows as written", () => {
    const lines = keyLines(svgIn("EN"));
    expect(lines[0].startsWith("KEY  ")).toBe(true);
    expect(lines.join("  ·  ")).toContain("DATA = ALIRAN DATA SENSOR");
  });

  test("the ID key is reserved in full: every key line inside the sheet, no text past the right edge", () => {
    const r = build.buildDiagramSvg(case05Spec(), { release: false, ...figures.diagramApparatusOptions("ID") });
    for (const m of r.svg.matchAll(/<text\b[^>]*\by="([\d.]+)"/g)) expect(+m[1]).toBeLessThanOrEqual(r.heightMm + 1e-6);
    expect(geom.lintDiagramGeometry(r.svg).defects.filter((d: { kind: string }) => d.kind === "textOutside")).toEqual([]);
  });

  test("the caption label word follows the language on an apparatus-figure SVG (GAMBAR / FIGURE)", () => {
    const fig = { ...case04WithBattery() };
    expect(build.buildDiagramSvg(fig, { release: false, ...figures.diagramApparatusOptions("ID") }).svg).toContain(">GAMBAR 4.1</tspan>");
    expect(build.buildDiagramSvg(fig, { release: false, ...figures.diagramApparatusOptions("EN") }).svg).toContain(">FIGURE 4.1</tspan>");
  });

  test("no language passed = output unchanged (KEY, rows as written)", () => {
    const plain = build.buildDiagramSvg(case05Spec(), { release: false }).svg;
    expect(keyLines(plain)[0].startsWith("KEY  DATA = ")).toBe(true);
  });
});
