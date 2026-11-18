// Swarm 1.2.7 row 36 (T-06 chart half, AC-T06, N7-102; C8 / D-11b): the chart line-count refusal
// (DATUM-25 for W-03, W-01 maxLines for W-01) lists what it counted — every series with the colour it
// would be drawn with — and the remainder, in the shape of the diagram DATUM-25 detail (row 62,
// colourCountDetail). Red at 04067a9d02: the message was only "<fid> — 5 garis > 3; sorot satu garis
// atau pecah gambarnya". CHAR: the diagram six-colour refusal keeps "dihitung 6:" and "sisa −1".
// Synthetic fixtures (row 20, syn127). Pure engine calls: no network, no model, no browser.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const PKG = path.resolve(import.meta.dir, "..", "..");
const ENGINE = path.join(PKG, "vendor", "src", "lib", "studio", "engine");
const FIX = path.join(PKG, "test", "fixtures", "syn127");
const chart = await import(path.join(ENGINE, "chart", "core", "render.ts"));
const build = await import(path.join(ENGINE, "diagram", "build", "index.ts"));
const tokens = await import(path.join(ENGINE, "diagram", "core", "tokens.ts")); // row 157
const colour = await import(path.join(ENGINE, "diagram", "core", "colour.ts")); // row 157

const fixture = (name: string): any => JSON.parse(readFileSync(path.join(FIX, name), "utf8")).spec;

const refusal = (fn: () => unknown): { message: string; checkId?: string } => {
  try {
    fn();
  } catch (e) {
    const err = e as Error & { details?: { checkId?: string } };
    return { message: String(err.message), checkId: err.details?.checkId };
  }
  throw new Error("expected a refusal");
};

/** `seri "<name>" (#HEX…)` items of the detail, in order. */
const items = (msg: string): Array<{ name: string; src: string }> =>
  [...msg.matchAll(/seri "([^"]+)" \(([^)]*)\)/g)].map((m) => ({ name: m[1], src: m[2] }));

describe("T-06 chart: line-count refusal names the counted series colours", () => {
  test("W-03 five lines: DATUM-25 lists every series with a hex colour and a negative remainder (N7-102)", () => {
    const spec = fixture("t06_chart_w03_five_lines.json");
    const names: string[] = spec.data.series.map((s: any) => s.name);
    const r = refusal(() => chart.renderChart(structuredClone(spec)));
    console.log("T06 chart refusal:", r.message);
    expect(r.checkId).toBe("DATUM-25");
    expect(r.message).toContain("5 garis > 3");
    expect(r.message).not.toContain("\n");
    expect(r.message).toContain("dihitung 5:");
    const listed = items(r.message);
    expect(listed.map((l) => l.name)).toEqual(names);
    for (const l of listed) expect(l.src).toMatch(/#[0-9A-F]{6}/);
    const m = r.message.match(/sisa (−?\d+)/);
    expect(m).not.toBeNull();
    expect(Number((m as RegExpMatchArray)[1].replace("−", "-"))).toBe(-2);
  });

  test("an accent series is listed with the accent colour, the others with context colours", () => {
    const spec = fixture("t06_chart_w03_five_lines.json");
    spec.data.series[2].accent = true;
    const r = refusal(() => chart.renderChart(spec));
    const listed = items(r.message);
    expect(listed.length).toBe(5);
    const hexOf = (src: string): string => (src.match(/#[0-9A-F]{6}/) as RegExpMatchArray)[0];
    const accent = hexOf(listed[2].src);
    for (const [i, l] of listed.entries()) if (i !== 2) expect(hexOf(l.src)).not.toBe(accent);
  });

  test("W-01 above maxLines uses the same detail under its own check id", () => {
    const spec = fixture("t06_chart_w03_five_lines.json");
    spec.kind = "W-01";
    const r = refusal(() => chart.renderChart(spec));
    expect(r.checkId).not.toBe("DATUM-25");
    expect(r.message).toMatch(/5 garis > 3/);
    expect(r.message).toContain("dihitung 5:");
    expect(items(r.message).length).toBe(5);
    expect(r.message).toMatch(/sisa −2\b/);
  });

  // Swarm 1.2.7 row 48b (M2-04, AC-T06): the detail keys each series case-exactly. Red at HEAD before row 48b:
  // `sources` was keyed by the upper-cased `seri "<name>"`, so "Deret Alfa" took the colour of "DERET ALFA".
  test("M2-04: two series differing only in case keep their own colours", () => {
    const spec = fixture("t06_chart_w03_five_lines.json");
    spec.data.series[1].name = spec.data.series[0].name.toUpperCase();
    spec.data.series[1].accent = true;
    const r = refusal(() => chart.renderChart(spec));
    const listed = items(r.message);
    expect(listed.map((l) => l.name)).toEqual(spec.data.series.map((s: any) => s.name));
    const hexOf = (src: string): string => (src.match(/#[0-9A-F]{6}/) as RegExpMatchArray)[0];
    const accent = hexOf(listed[1].src);
    expect(hexOf(listed[0].src)).not.toBe(accent);
    expect(listed[0].src).not.toBe(listed[1].src);
  });

  // M2-04 CHAR (green before and after): the refusal resolves the accent with the drawing rule (an accent request
  // names the series; the lowest accented index wins).
  test("M2-04: an accent request by series name colours that series as the drawing would", () => {
    const spec = fixture("t06_chart_w03_five_lines.json");
    spec.data.series[3].accent = true;
    spec.accent = { series: spec.data.series[1].name };
    const r = refusal(() => chart.renderChart(spec));
    const listed = items(r.message);
    const hexOf = (src: string): string => (src.match(/#[0-9A-F]{6}/) as RegExpMatchArray)[0];
    // Lowest accented index wins (resolveSeriesAccent): series 1, not series 3.
    for (const [i, l] of listed.entries()) if (i !== 1) expect(hexOf(l.src)).not.toBe(hexOf(listed[1].src));
  });

  // Swarm 1.3.3 row 157 (ST-6, row 57): `t06_diagram_six_colours` prints six values, but three are ink greys (one
  // counted entry, `tinta`) and the alert value is printed only by the ASUMSI mark (not counted): DATUM-25 counts 3 and
  // the build passes. No diagram spec can count more than 4 with today's tokens (`tinta`, signal, alert, verd), so the
  // refusal is a guard for new fill colours. The fixture keeps the spec, turns one data edge into an alert edge (alert
  // now counts: an edge source besides the mark), and gives the data and control kinds two fill colours that no token
  // has today, for the duration of the build only: tinta, the two new fills, verd, signal, alert = 6 > 5.
  test("CHAR: diagram six-colour refusal keeps `dihitung 6:` and `sisa −1`", () => {
    const spec = fixture("t06_diagram_six_colours.json");
    const alertEdge = spec.edges.findIndex((e: any) => e.kind === "data");
    spec.edges[alertEdge].kind = "alert";
    const fills = { data: ["test_fill_a", "#5A3E8C"], control: ["test_fill_b", "#1F6FB2"] } as const;
    const interior = tokens.INTERIOR as Record<string, string>;
    const kinds = tokens.EDGE_KINDS as Record<string, { colour: string }>;
    const saved = Object.keys(fills).map((k) => [k, kinds[k].colour] as const);
    let r: { message: string; checkId?: string };
    try {
      for (const [kind, [tok, value]] of Object.entries(fills)) {
        interior[tok] = value;
        kinds[kind].colour = tok;
      }
      r = refusal(() => build.buildDiagramSvg(spec, { release: false }));
    } finally {
      for (const [k, c] of saved) kinds[k].colour = c;
      for (const [tok] of Object.values(fills)) delete interior[tok];
    }
    expect(r.message).toContain("DATUM-25: 6 nilai warna dalam satu gambar, maksimum 5");
    expect(r.message).toContain("dihitung 6:");
    expect(r.message).toMatch(/sisa −1\b/);
    expect(r.message).toContain("#5A3E8C (edge.kind data");
    expect(r.message).toContain("#1F6FB2 (edge.kind control");
    expect(kinds.data.colour).toBe("ink900");
    expect(interior.test_fill_a).toBeUndefined();
  });

  test("row 157: the former six-colour diagram builds (DATUM-25 counts tinta, verd, signal; the ASUMSI value only by its mark)", () => {
    const spec = fixture("t06_diagram_six_colours.json");
    const out = build.buildDiagramSvg(spec, { release: false });
    const svg: string = typeof out === "string" ? out : out.svg;
    const b = colour.svgColourBudget(svg);
    expect(colour.svgColourValues(svg).length).toBe(6);
    expect(b.count).toBe(3);
    expect(b.marksOnly).toEqual([String(tokens.colourOf("alert")).toUpperCase()]);
  });
});
