// Swarm 1.3.3 row 42 (ST-3 item 3, gap matrix N17): edge labels stay off container borders; a container label has a
// plain ground; a clamped container label is reported (code ZONE_LABEL_CLAMP, the existing fit note).
//
// Inputs: byte copies of three round-2 replay specs (R2 u1-arsitektur 1, 2, 4: the three of the 16 that carry zones
// and print an edge label over a zone frame at BASE), plus synthetic geometry for the pure functions.
// Geometry is read from the SVG only: a zone frame is the dashed `fill="none"` rect without `data-node`; an edge-label
// band is the filled, unstroked rect drawn right before a middle-anchored text (core/svg.ts `labelKnockoutSvg`).
//
// Scope note: the placement below runs on the fit path (`withDiagramFit`), which is where build/fitlabels.ts and
// fit/labels.ts act. Whether the default pipeline enters that path for a label on a zone frame is decided by the
// geometry lint (fit/lint.ts) and the first-render position (build/svg.ts), both outside row 42.
import { useStudioEnv } from "../ported/_env";
useStudioEnv();
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DIAGRAM_LAYOUTS } from "@/lib/studio/contract/dispatch";
import { buildDiagramSvg, buildDiagramSvgRaw, placeDiagram } from "@/lib/studio/engine/diagram/build";
import { Sheet } from "@/lib/studio/engine/diagram/core";
import { lintDiagramGeometry } from "@/lib/studio/engine/diagram/fit/lint";
import { withDiagramFit, type DiagramFitNote } from "@/lib/studio/engine/diagram/fit/state";

type J = Record<string, any>;
type Box = [number, number, number, number];
// Namespace imports, so a run on the BASE engine fails on assertions, not on a missing export.
const fitlabels = (await import("@/lib/studio/engine/diagram/build/fitlabels")) as J;
const labels = (await import("@/lib/studio/engine/diagram/fit/labels")) as J;

const FIX = path.join(import.meta.dir, "fixtures");
const PRINT_TOL = 0.01; // coordinates are printed to 0.01 mm
const OPTS = { release: false, keyLabel: "KUNCI" } as any;

function r2(n: number): J {
  const raw = JSON.parse(readFileSync(path.join(FIX, `r2_u1_${n}.json`), "utf8"));
  return {
    $schema: "studio.diagram/v1",
    id: "2.1",
    title: raw.caption.text,
    classification: "TERBATAS",
    width_mm: 166,
    apparatus: "page",
    sources: [raw.source.text],
    ...raw.spec,
  };
}

const attrs = (tag: string): Record<string, string> => Object.fromEntries([...tag.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g)].map((m) => [m[1], m[2]]));

function scan(svg: string): { zones: Box[]; bands: Array<{ box: Box; text: string }>; texts: Array<{ a: Record<string, string>; c: string; raw: string }> } {
  const els = [...svg.matchAll(/<(rect|text|line|path)\b([^>]*?)(\/>|>([\s\S]*?)<\/text>)/g)].map((m) => ({ tag: m[1], a: attrs(m[2]), c: (m[4] ?? "").replace(/<[^>]+>/g, ""), raw: m[0] }));
  const zones: Box[] = [];
  const bands: Array<{ box: Box; text: string }> = [];
  els.forEach((e, i) => {
    if (e.tag === "rect" && e.a.fill === "none" && e.a["stroke-dasharray"] && !e.a["data-node"]) zones.push([+e.a.x, +e.a.y, +e.a.x + +e.a.width, +e.a.y + +e.a.height]);
    const n = els[i + 1];
    if (e.tag === "rect" && e.a.fill && e.a.fill !== "none" && e.a.stroke === undefined && !e.a["data-node"] && n && n.tag === "text" && n.a["text-anchor"] === "middle") {
      bands.push({ box: [+e.a.x, +e.a.y, +e.a.x + +e.a.width, +e.a.y + +e.a.height], text: n.c });
    }
  });
  return { zones, bands, texts: els.filter((e) => e.tag === "text") };
}

/** The four sides of a frame as segments. */
const sides = (z: Box): Array<[[number, number], [number, number]]> => [
  [[z[0], z[1]], [z[2], z[1]]],
  [[z[2], z[1]], [z[2], z[3]]],
  [[z[2], z[3]], [z[0], z[3]]],
  [[z[0], z[3]], [z[0], z[1]]],
];
/** An axis segment runs through the inside of box `r` (shrunk by the print tolerance). */
const segInBox = (a: [number, number], b: [number, number], r: Box): boolean =>
  Math.max(a[0], b[0]) > r[0] + PRINT_TOL && Math.min(a[0], b[0]) < r[2] - PRINT_TOL && Math.max(a[1], b[1]) > r[1] + PRINT_TOL && Math.min(a[1], b[1]) < r[3] - PRINT_TOL;

function onBorder(svg: string): string[] {
  const { zones, bands } = scan(svg);
  return bands.filter((b) => zones.some((z) => sides(z).some(([p, q]) => segInBox(p, q, b.box)))).map((b) => b.text);
}

function fitRender(s: J): { svg: string; notes: DiagramFitNote[] } {
  const notes: DiagramFitNote[] = [];
  const r = withDiagramFit({ notes }, () => buildDiagramSvgRaw(s as any, OPTS));
  return { svg: r.svg, notes };
}

describe("row 42 (a): edge labels stay off container borders", () => {
  // At the time of writing (release/1.3.3 worktree, 2026-11-17) the three specs printed 2 + 2 + 2 edge-label bands over a
  // zone frame, on the first render and on the fit path alike. The first render is not asserted here: it belongs to
  // build/svg.ts and the layouts, which other rows of this patch change.
  for (const k of [1, 2, 4]) {
    test(`R2 u1/${k}: on the fit path no edge-label band crosses a zone frame, and no label text is lost`, () => {
      const s = r2(k);
      const { svg, notes } = fitRender(s);
      const sc = scan(svg);
      expect(sc.zones.length).toBe(s.zones.length);
      expect(onBorder(svg)).toEqual([]);
      // every label of the spec is still printed: on its connector, or as a numbered note row (LABEL_NUMBERED)
      const printed = sc.texts.map((t) => t.c);
      for (const e of s.edges as J[]) {
        if (!e.label) continue;
        expect(printed.some((t) => t.toUpperCase() === String(e.label).toUpperCase())).toBe(true);
      }
      // a moved label is reported
      expect(notes.some((x) => ["LABEL_MOVED", "LABEL_LEADER", "LABEL_NUMBERED"].includes(x.checkId))).toBe(true);
    });
  }

  test("placeEdgeLabels: a default position on a container rule is moved off it (pure, synthetic)", () => {
    // one horizontal connector, 60 mm long; a vertical frame side crosses it at its midpoint
    const edge = { points: [[20, 30], [80, 30]] as Array<[number, number]>, label: "DATA 10G", kind: "data", orig: [50, 30 - 0.42] as [number, number] };
    const rule = { a: [50, 10] as [number, number], b: [50, 50] as [number, number], half: 0.1 };
    const ctx = { W: 166, yMax: Infinity, nodeBoxes: [[10, 25, 20, 35], [80, 25, 90, 35]], obstacles: [] };
    const free = labels.placeEdgeLabels([edge], ctx).placed[0];
    expect(free.mode).toBe("keep");
    const p = labels.placeEdgeLabels([edge], { ...ctx, rules: [rule] }).placed[0];
    expect(["moved", "leader"]).toContain(p.mode);
    const b = labels.knockBox(p.x, p.y, p.kw) as Box;
    expect(segInBox(rule.a, rule.b, b)).toBe(false);
    expect(p.text).toBe("DATA 10G");
  });

  test("fitlabels.zoneFrameRules: the four strict sides of each zone frame as drawn; none, and no ground, for a legacy flow", () => {
    expect(typeof fitlabels.zoneFrameRules).toBe("function");
    const s = r2(2);
    const sheet = placeDiagram(s as any, new Sheet(166), DIAGRAM_LAYOUTS).sheet;
    const rules = fitlabels.zoneFrameRules(s, sheet, false) as Array<{ a: [number, number]; b: [number, number]; half: number; strict?: boolean }>;
    expect(rules.length).toBe(4 * s.zones.length);
    expect(rules.every((r) => r.strict === true && r.half > 0.1)).toBe(true);
    // the same frames as the SVG prints (two decimals)
    const drawn = scan(buildDiagramSvgRaw(s as any, OPTS).svg).zones;
    for (let i = 0; i < drawn.length; i++) {
      const xs = rules.slice(4 * i, 4 * i + 4).flatMap((r) => [r.a[0], r.b[0]]);
      const ys = rules.slice(4 * i, 4 * i + 4).flatMap((r) => [r.a[1], r.b[1]]);
      const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      box.forEach((v, j) => expect(Math.abs(v - drawn[i][j])).toBeLessThanOrEqual(PRINT_TOL));
    }
    // every zone of a non-legacy spec carries its ground
    for (const z of s.zones as J[]) {
      const g = fitlabels.zoneGeom(z, z.members.map((m: string) => sheet.nodes.get(m)), sheet, false, fitlabels.zoneClearOn(s));
      expect(g.ground).toMatch(/^<rect\b[^>]*stroke="none"\/>$/);
    }
    // negative control: a legacy flow (family `flow` without `direction`) is frozen at its bytes (C10(a), C12)
    const legacy = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "fixtures", "syn128", "vis0_carry_b.json"), "utf8")).spec as J;
    expect(legacy.family).toBe("flow");
    expect(legacy.direction).toBeUndefined();
    expect(legacy.zones.length).toBeGreaterThan(0);
    const ls = { $schema: "studio.diagram/v1", id: "1.1", title: "t", classification: "TERBATAS", width_mm: 166, sources: ["s"], ...legacy };
    const lsheet = placeDiagram(ls as any, new Sheet(166), DIAGRAM_LAYOUTS).sheet;
    expect(fitlabels.zoneClearOn(ls)).toBe(false);
    expect(fitlabels.zoneFrameRules(ls, lsheet, false)).toEqual([]);
    const lz = legacy.zones[0] as J;
    expect(fitlabels.zoneGeom(lz, lz.members.map((m: string) => lsheet.nodes.get(m)), lsheet, false, false).ground).toBeUndefined();
  });
});

describe("row 42 (b): a container label has a plain ground", () => {
  const geom = { x: 20, y: 10, w: 60, h: 40, label: "SITE RACK SR-01", lx: 21, ly: 11.76 };

  test("zoneLabelGroundSvg: one paper rect under the label, wider than the text, over the frame line it sits on", () => {
    expect(typeof fitlabels.zoneLabelGroundSvg).toBe("function");
    const g = fitlabels.zoneLabelGroundSvg(geom, 166) as string;
    const m = /^<rect\b([^>]*)\/>$/.exec(g);
    expect(m).not.toBeNull();
    const a = attrs(m![1]);
    expect(a.fill).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(a.stroke).toBe("none"); // not a knock-out band, not a frame, not a rule for the geometry lint
    expect(a["data-mark"]).toBeUndefined(); // decoration carries no mark (G-2)
    const [x0, y0, x1, y1] = [+a.x, +a.y, +a.x + +a.width, +a.y + +a.height];
    const lw = fitlabels.zoneLabelWidthMm(geom.label) as number;
    expect(x0).toBeLessThan(geom.lx);
    expect(x1).toBeGreaterThan(geom.lx + lw);
    expect(y0).toBeLessThan(geom.y); // the frame's top line passes behind the capitals: it is knocked out there
    expect(y1).toBeGreaterThan(geom.ly);
    expect(x0).toBeGreaterThan(geom.x); // the left frame line stays
  });

  test("the ground stays inside the sheet", () => {
    const a = attrs(fitlabels.zoneLabelGroundSvg({ ...geom, x: -3, y: -1, lx: 0.5, ly: 0.9 }, 30) as string);
    expect(+a.x).toBeGreaterThanOrEqual(0);
    expect(+a.y).toBeGreaterThanOrEqual(0);
    expect(+a.x + +a.width).toBeLessThanOrEqual(30 + 1e-9);
  });

  test("drawn before the label text, the ground changes no geometry-lint count (R2 u1/2, fit path)", () => {
    const s = r2(2);
    const { svg } = fitRender(s);
    const before = lintDiagramGeometry(svg);
    let out = svg;
    let n = 0;
    for (const z of s.zones as J[]) {
      const t = scan(svg).texts.find((x) => x.c === String(z.label).toUpperCase() || x.c === z.label);
      expect(t).toBeDefined();
      const ground = fitlabels.zoneLabelGroundSvg({ x: 0, y: 0, w: 0, h: 0, label: z.label, lx: +t!.a.x, ly: +t!.a.y }, 166) as string;
      out = out.replace(t!.raw, ground + t!.raw);
      n++;
    }
    expect(n).toBe(2);
    const after = lintDiagramGeometry(out);
    expect(after.counts).toEqual(before.counts);
    expect(after.score).toBe(before.score);
  });
});

describe("row 42 (c): a clamped container label is reported", () => {
  /** Topology with a zone on the right sheet edge whose label is far wider than the room right of the frame's left side. */
  const clampSpec = (label: string, members: string[] = ["d"]): J => ({
    $schema: "studio.diagram/v1",
    id: "9.1",
    title: "Zona dengan label panjang di tepi kanan lembar.",
    classification: "TERBATAS",
    width_mm: 128,
    apparatus: "page",
    sources: ["Sumber sintetis uji row 42 (Swarm 1.3.3)."],
    family: "topology",
    labels_verified: true,
    nodes: [
      { id: "a", label: "Alfa", shape: "box", class: { tier: 0 } },
      { id: "b", label: "Bravo", shape: "box", class: { tier: 0 } },
      { id: "d", label: "Delta", shape: "box", class: { tier: 0 } },
      { id: "e", label: "Echo", shape: "box", class: { tier: 1 } },
    ],
    edges: [{ from: "a", to: "e", kind: "data", label: "1G" }, { from: "d", to: "e", kind: "data", label: "10G" }],
    zones: [{ id: "z1", label, members }],
  });
  const LONG = "ZONA PENGAMANAN PERIMETER SISI TIMUR GEDUNG";

  test("fit path: the clamp is a ZONE_LABEL_CLAMP note that names the label and how to avoid it", () => {
    const { notes } = fitRender(clampSpec(LONG));
    const n = notes.filter((x) => x.checkId === "ZONE_LABEL_CLAMP");
    expect(n.length).toBe(1);
    expect(n[0].detail).toContain(LONG);
    expect(n[0].detail).toMatch(/mm/); // how far it was moved
    expect(typeof n[0].suggest).toBe("string");
    expect(n[0].suggest!.length).toBeGreaterThan(0);
  });

  test("default pipeline: the clamp reaches the build report", () => {
    const r = buildDiagramSvg(clampSpec(LONG) as any, OPTS);
    const geo = (r.report.geometry ?? []) as J[];
    const c = geo.find((i) => i.checkId === "ZONE_LABEL_CLAMP");
    expect(c).toBeDefined();
    expect(c!.status).toBe("REPORT");
    expect(String(c!.detail)).toContain(LONG);
  });

  test("a label wider than the sheet is reported as not fitting, never as clamped into the sheet", () => {
    const wide = Array.from({ length: 12 }, () => "ZONA PERIMETER").join(" ");
    const { notes } = fitRender(clampSpec(wide));
    const n = notes.filter((x) => x.checkId === "ZONE_LABEL_CLAMP");
    expect(n.length).toBe(1);
    expect(n[0].detail).toMatch(/lebih lebar dari lembar/);
    expect(n[0].detail).not.toMatch(/dijepit ke dalam lembar/);
  });

  test("a label that fits where it is drawn gives no clamp note", () => {
    // a zone in the second tier: its label is neither at the sheet top nor near the right edge
    const { notes } = fitRender(clampSpec("TIMUR", ["e"]));
    expect(notes.some((x) => x.checkId === "ZONE_LABEL_CLAMP")).toBe(false);
  });
});
