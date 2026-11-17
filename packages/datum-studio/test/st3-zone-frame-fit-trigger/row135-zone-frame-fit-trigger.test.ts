// Swarm 1.3.3 row 135 (ST-3 item 3, follow-up of row 42): in the default pipeline (no fit option, `buildDiagramSvg` /
// `buildDiagramSvgRaw`) an edge-label band on a zone frame line is a `labelCollision` ("garis wadah") of the geometry
// lint, so `autoFitDiagram` enters the fit pass and row 42's `zoneFrameRules` moves the label off the frame.
//
// Inputs: row 42's byte copies of the three round-2 replay specs that carry zones (R2 u1-arsitektur 1, 2, 4), read from
// `../st3-edge-container-labels/fixtures`, plus hand-written SVG for the lint alone.
// Geometry is read from the SVG only, as in row 42's test: a zone frame is the dashed `fill="none"` rect without
// `data-node`; an edge-label band is the filled, unstroked rect right before a middle-anchored text.
import { useStudioEnv } from "../ported/_env";
useStudioEnv();
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildDiagramSvg, buildDiagramSvgRaw } from "@/lib/studio/engine/diagram/build";
import { decorationOf, lintDiagramGeometry } from "@/lib/studio/engine/diagram/fit/lint";

type J = Record<string, any>;
type Box = [number, number, number, number];

const FIX = path.join(import.meta.dir, "..", "st3-edge-container-labels", "fixtures");
const PRINT_TOL = 0.01; // coordinates are printed to 0.01 mm
const OPTS = { release: false, keyLabel: "KUNCI" } as any;

function r2(n: number, width: number, apparatus: string): J {
  const raw = JSON.parse(readFileSync(path.join(FIX, `r2_u1_${n}.json`), "utf8"));
  return { $schema: "studio.diagram/v1", id: "2.1", title: raw.caption.text, classification: "TERBATAS", width_mm: width, apparatus, sources: [raw.source.text], ...raw.spec };
}

const attrs = (tag: string): Record<string, string> => Object.fromEntries([...tag.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g)].map((m) => [m[1], m[2]]));

/** Texts of the edge-label bands that a zone frame side runs through. */
function onBorder(svg: string): string[] {
  const els = [...svg.matchAll(/<(rect|text|line|path)\b([^>]*?)(\/>|>([\s\S]*?)<\/text>)/g)].map((m) => ({ tag: m[1], a: attrs(m[2]), c: (m[4] ?? "").replace(/<[^>]+>/g, "") }));
  const zones: Box[] = [];
  const bands: Array<{ box: Box; text: string }> = [];
  els.forEach((e, i) => {
    if (e.tag === "rect" && e.a.fill === "none" && e.a["stroke-dasharray"] && !e.a["data-node"]) zones.push([+e.a.x, +e.a.y, +e.a.x + +e.a.width, +e.a.y + +e.a.height]);
    const n = els[i + 1];
    if (e.tag === "rect" && e.a.fill && e.a.fill !== "none" && e.a.stroke === undefined && !e.a["data-node"] && n && n.tag === "text" && n.a["text-anchor"] === "middle") {
      bands.push({ box: [+e.a.x, +e.a.y, +e.a.x + +e.a.width, +e.a.y + +e.a.height], text: n.c });
    }
  });
  const sides = (z: Box): Box[] => [[z[0], z[1], z[2], z[1]], [z[2], z[1], z[2], z[3]], [z[0], z[3], z[2], z[3]], [z[0], z[1], z[0], z[3]]];
  const through = (s: Box, r: Box) => s[2] > r[0] + PRINT_TOL && s[0] < r[2] - PRINT_TOL && s[3] > r[1] + PRINT_TOL && s[1] < r[3] - PRINT_TOL;
  return bands.filter((b) => zones.some((z) => sides(z).some((s) => through(s, b.box)))).map((b) => b.text);
}

describe("row 135: default pipeline, R2 specs with zones", () => {
  for (const k of [1, 2, 4]) {
    for (const width of [166, 128]) {
      for (const apparatus of ["page", "figure"]) {
        test(`R2 u1/${k}, ${width} mm, ${apparatus}: no edge-label band on a zone frame, no fit option given`, () => {
          const s = r2(k, width, apparatus);
          const raw = buildDiagramSvgRaw(s as any, OPTS);
          expect(onBorder(raw.svg)).toEqual([]);
          expect(onBorder(buildDiagramSvg(s as any, OPTS).svg)).toEqual([]);
          // every label of the spec is still printed (on its connector or as a numbered note row)
          const printed = [...raw.svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").toUpperCase());
          for (const e of s.edges as J[]) if (e.label) expect(printed.some((t) => t.includes(String(e.label).toUpperCase().replace(/&/g, "&amp;")))).toBe(true);
        });
      }
    }
  }

  test("R2 u1/4, 166 mm: the first render was otherwise fit-clean; the build report now shows the fit pass and the moved labels", () => {
    // Before row 135 this spec printed two bands on a zone frame ('CR1 + CR2 · D1/D2', 'duct D1 + D2') and its report
    // carried no AUTO_FIT line: the lint counted nothing in `score`, so the fit pass never started.
    const r = buildDiagramSvgRaw(r2(4, 166, "page") as any, OPTS);
    const ids = (r.report.geometry ?? []).map((g: J) => g.checkId);
    expect(ids).toContain("AUTO_FIT");
    expect(ids).toContain("LABEL_MOVED");
    expect(ids).not.toContain("GEOM_LABEL_COLLISION");
    const auto = (r.report.geometry ?? []).find((g: J) => g.checkId === "AUTO_FIT") as J;
    // two bands on a frame before the fit; the candidate taken scores 0 (what remains are T-03 kinds, outside `score`,
    // which this spec carried before as well: GEOM_EDGE_ALONG, GEOM_EDGE_DOUBLE_BACK)
    expect(auto.detail).toMatch(/sebelum fit 2, /);
    expect(auto.detail).toMatch(/dicoba: penuh: 0/);
    const g = lintDiagramGeometry(r.svg);
    expect(g.score).toBe(0);
    expect(g.counts.labelCollision).toBe(0);
  });
});

// Hand-written sheets for the lint alone. A zone frame as build/svg.ts draws it; the label ground carries stroke="none".
const FRAME = '<rect x="10" y="10" width="60" height="30" fill="none" stroke="#8A8A86" stroke-width="0.18" stroke-dasharray="1.2 0.8"/>';
const GROUND = '<rect x="11" y="10.4" width="12" height="2.6" fill="#FCFCFB" stroke="none"/>';
const ZLABEL = '<text x="11.4" y="12.4" font-size="2.4" font-weight="600" letter-spacing="0.1">ZONA A</text>';
const band = (x: number, y: number, w = 12) => `<rect x="${x}" y="${y}" width="${w}" height="3" fill="#FCFCFB"/><text x="${x + w / 2}" y="${y + 2.2}" font-size="2.4" text-anchor="middle">DATA</text>`;
const sheet = (...parts: string[]) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60" width="100mm" height="60mm">${parts.join("")}</svg>`;
const collisions = (svg: string) => lintDiagramGeometry(svg).defects.filter((d) => d.kind === "labelCollision");

describe("row 135: the geometry lint reads a zone frame side under an edge-label band", () => {
  test("a band across the right side of a zone frame is one labelCollision 'garis wadah', counted in score", () => {
    const g = lintDiagramGeometry(sheet(FRAME, GROUND, ZLABEL, band(64, 20)));
    expect(collisions(sheet(FRAME, GROUND, ZLABEL, band(64, 20)))).toEqual([{ kind: "labelCollision", text: "DATA", other: "garis wadah" }]);
    expect(g.counts.labelCollision).toBe(1);
    expect(g.score).toBeGreaterThanOrEqual(1);
  });

  test("each side counts: top, bottom, left", () => {
    expect(collisions(sheet(FRAME, GROUND, ZLABEL, band(30, 8.5))).length).toBe(1);
    expect(collisions(sheet(FRAME, GROUND, ZLABEL, band(30, 38.5))).length).toBe(1);
    expect(collisions(sheet(FRAME, GROUND, ZLABEL, band(4, 20))).length).toBe(1);
  });

  test("a group frame (dashdot, rounded) counts as well", () => {
    const group = FRAME.replace("fill=", 'rx="1.6" ry="1.6" fill=').replace("1.2 0.8", "2.4 0.8 0.4 0.8");
    expect(collisions(sheet(group, GROUND, ZLABEL, band(64, 20))).length).toBe(1);
  });

  test("a band that only comes near the frame (0.06 mm off, as JALUR UTAMA in dg_topology) is not a finding", () => {
    // frame right side at x 70, stroke half 0.09; the lint shrinks the band by 0.05 mm
    expect(collisions(sheet(FRAME, GROUND, ZLABEL, band(70.15, 20)))).toEqual([]);
    expect(collisions(sheet(FRAME, GROUND, ZLABEL, band(40, 20)))).toEqual([]); // inside the zone
    expect(collisions(sheet(FRAME, GROUND, ZLABEL, band(80, 20)))).toEqual([]); // outside
  });

  test("strict: a connector running along the frame line does not excuse the band (a lane rule would be excused)", () => {
    const link = '<path data-mark="link" d="M 20 10 L 60 10" fill="none" stroke="#111" stroke-width="0.35"/>';
    expect(collisions(sheet(FRAME, GROUND, ZLABEL, link, band(34, 8.5))).some((d) => d.other === "garis wadah")).toBe(true);
    const lane = '<line x1="10" y1="10" x2="70" y2="10" stroke="#8A8A86" stroke-width="0.18"/>';
    expect(collisions(sheet(lane, link, band(34, 8.5))).some((d) => d.other === "garis wadah")).toBe(false);
  });

  test("a legacy flow (frame followed at once by its label text, no ground) gets no zone rule: its reports stay", () => {
    expect(collisions(sheet(FRAME, ZLABEL, band(64, 20)))).toEqual([]);
    // two zones, each frame followed by its own label
    const second = FRAME.replace('x="10"', 'x="72"').replace('width="60"', 'width="20"');
    expect(collisions(sheet(FRAME, ZLABEL, second, ZLABEL.replace('x="11.4"', 'x="73"'), band(64, 20)))).toEqual([]);
  });

  test("a dashed node outline is not a zone frame; a solid hair rect is not one either", () => {
    expect(collisions(sheet(FRAME.replace("fill=", 'data-node="n1" fill='), band(80, 30))).some((d) => d.other === "garis wadah")).toBe(false);
    const solid = FRAME.replace(' stroke-dasharray="1.2 0.8"', "");
    expect(collisions(sheet(solid, GROUND, ZLABEL, band(64, 20)))).toEqual([]);
  });

  test("decorationOf hands no zone frame on: the placement's lane rules are as before", () => {
    expect(decorationOf([FRAME, GROUND, ZLABEL], 100).rules).toEqual([]);
  });

  test("a zoned sheet without a band on a frame has the same lint result as the sheet without its frame rule", () => {
    const withFrame = lintDiagramGeometry(sheet(FRAME, GROUND, ZLABEL, band(40, 20)));
    expect(withFrame.score).toBe(0);
    expect(withFrame.counts.labelCollision).toBe(0);
  });
});
