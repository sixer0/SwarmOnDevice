// Row 165C (wave 165, decision C188): figure engine fixes F113-9 (CP-37) and F113-10 (CP-47).
// - F113-9: a node outline on the sheet edge had half of its 0.45 mm stroke outside the canvas, so the PNG/SVG cut
//   it (row 113: dark pixels in the PNG's first and last columns). Every drawn node outline now lies inside the
//   canvas with its whole stroke.
// - F113-10: the hatch was an SVG <pattern> fill, which Chromium prints into the PDF as a raster image (row 113:
//   get_image_info 364 x 528 px block under the figure). The hatch is now plain vector lines, cut to the node.
//   The PDF side (get_image_info = 0) is proved with the real Electron bridge in the row report; here the SVG.
// Pure engine calls: no network, no model, no browser, no file writes.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const PKG = path.resolve(import.meta.dir, "..", "..", "..");
const ENGINE = path.join(PKG, "vendor", "src", "lib", "studio", "engine");
const build = await import(path.join(ENGINE, "diagram", "build", "index.ts"));
const elk = await import(path.join(ENGINE, "diagram", "elk", "index.ts"));
const core = await import(path.join(ENGINE, "diagram", "core", "index.ts"));
const sanitize = await import(path.join(ENGINE, "html", "tables", "svg.ts"));

/** Case 04 stand-alone spec (row 124 fixture, v2 material: apparatus "figure", width 128 mm, one accent node). */
const CASE04 = JSON.parse(readFileSync(path.join(PKG, "test", "engine-rev-a", "svg", "fixtures", "case04_v2.studio.json"), "utf8"));
const spec = (patch?: (s: any) => void): any => {
  const s = structuredClone(CASE04);
  patch?.(s);
  return s;
};

const attrs = (tag: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
};
const rootSize = (svg: string) => {
  const a = attrs(/<svg\b[^>]*>/.exec(svg)![0]);
  const vb = a.viewBox.split(/\s+/).map(Number);
  return { w: vb[2], h: vb[3] };
};
/** Outer extent of every drawn node outline (rect/polygon/path/circle with data-mark="node"), stroke included. */
function nodeExtents(svg: string): Array<{ id: string; x0: number; y0: number; x1: number; y1: number }> {
  const out: Array<{ id: string; x0: number; y0: number; x1: number; y1: number }> = [];
  for (const m of svg.matchAll(/<(rect|polygon|path|circle)\b([^>]*\bdata-mark="node"[^>]*)\/>/g)) {
    const a = attrs(m[2]);
    const half = Number(a["stroke-width"] ?? 0) / 2;
    let xs: number[] = [];
    let ys: number[] = [];
    if (m[1] === "rect") {
      xs = [+a.x, +a.x + +a.width];
      ys = [+a.y, +a.y + +a.height];
    } else if (m[1] === "circle") {
      xs = [+a.cx - +a.r, +a.cx + +a.r];
      ys = [+a.cy - +a.r, +a.cy + +a.r];
    } else if (m[1] === "polygon") {
      const p = a.points.split(/[\s,]+/).map(Number);
      xs = p.filter((_, i) => i % 2 === 0);
      ys = p.filter((_, i) => i % 2 === 1);
    } else {
      // cylinder path: M x y a rx ry ... w 0 L ... ; the bbox is x..x+w, y..y+h
      const nums = a.d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      const x = nums[0];
      const w = nums[7];
      xs = [x, x + w];
      ys = [nums[1] - nums[3], nums[9] + nums[3]];
    }
    out.push({ id: a["data-node"], x0: Math.min(...xs) - half, y0: Math.min(...ys) - half, x1: Math.max(...xs) + half, y1: Math.max(...ys) + half });
  }
  return out;
}

describe("F113-9 (CP-37): no node stroke is cut at the canvas edge", () => {
  test("case 04: every node outline, stroke included, lies inside the 128 mm canvas (engine and ELK path)", async () => {
    for (const r of [build.buildDiagramSvg(spec(), { release: false }), await elk.buildDiagramSvgAuto(spec(), { release: false })]) {
      const { w, h } = rootSize(r.svg);
      expect(w).toBe(128);
      const ext = nodeExtents(r.svg);
      expect(ext.length).toBeGreaterThanOrEqual(7);
      const out = ext.filter((e) => e.x0 < -1e-9 || e.y0 < -1e-9 || e.x1 > w + 1e-9 || e.y1 > h + 1e-9).map((e) => `${e.id} ${e.x0.toFixed(3)}..${e.x1.toFixed(3)}`);
      expect(out).toEqual([]);
    }
  });

  test("the edge boxes still reach the sheet edge (inset is half a stroke, not more): outer stroke edge within 0.01 mm of 0 and 128", () => {
    const r = build.buildDiagramSvg(spec(), { release: false });
    const ext = nodeExtents(r.svg);
    expect(Math.min(...ext.map((e) => e.x0))).toBeGreaterThanOrEqual(0);
    expect(Math.min(...ext.map((e) => e.x0))).toBeLessThanOrEqual(0.011);
    expect(Math.max(...ext.map((e) => e.x1))).toBeLessThanOrEqual(128);
    expect(Math.max(...ext.map((e) => e.x1))).toBeGreaterThanOrEqual(127.989);
  });

  test("insetForStroke: only the sides on the edge move, by half a stroke on the 0.01 mm grid; inner nodes unchanged", () => {
    const canvas = { widthMm: 128, heightMm: 100 };
    expect(core.insetForStroke({ x: 10, y: 10, w: 20, h: 10 }, canvas, 0.45)).toEqual({ x: 10, y: 10, w: 20, h: 10 });
    expect(core.insetForStroke({ x: 0, y: 10, w: 64, h: 10 }, canvas, 0.45)).toEqual({ x: 0.23, y: 10, w: 63.77, h: 10 });
    const right = core.insetForStroke({ x: 74.67, y: 10, w: 53.33, h: 10 }, canvas, 0.45);
    expect(right.x).toBe(74.67);
    expect(right.x + right.w).toBeCloseTo(127.77, 9);
    expect(core.insetForStroke({ x: 0, y: 10, w: 64, h: 10 }, undefined, 0.45)).toEqual({ x: 0, y: 10, w: 64, h: 10 });
  });
});

describe("F113-10 (CP-47): the hatch is vector lines, not a <pattern>", () => {
  test("case 04: no <pattern>, no url(#datum-hatch...), the accent node carries hatch lines inside its box", () => {
    const r = build.buildDiagramSvg(spec(), { release: false });
    expect(r.svg).not.toContain("<pattern");
    expect(r.svg).not.toContain("url(#datum-hatch");
    const g = /<g ([^>]*data-hatch="45"[^>]*)>([\s\S]*?)<\/g>/.exec(r.svg);
    expect(g).not.toBeNull();
    const ga = attrs(g![1]);
    expect(ga.stroke).toBe("#6B7783");
    expect(ga["stroke-width"]).toBe("0.3");
    const srv = attrs(/<rect\b[^>]*data-node="srv"[^>]*\/>/.exec(r.svg)![0]);
    expect(srv.fill).toBe("none");
    const box = { x0: +srv.x, y0: +srv.y, x1: +srv.x + +srv.width, y1: +srv.y + +srv.height };
    const lines = [...g![2].matchAll(/<line ([^>]*)\/>/g)].map((m) => attrs(m[1]));
    expect(lines.length).toBeGreaterThan(40);
    for (const l of lines) {
      for (const [x, y] of [[+l.x1, +l.y1], [+l.x2, +l.y2]]) {
        expect(x).toBeGreaterThanOrEqual(box.x0 - 0.006);
        expect(x).toBeLessThanOrEqual(box.x1 + 0.006);
        expect(y).toBeGreaterThanOrEqual(box.y0 - 0.006);
        expect(y).toBeLessThanOrEqual(box.y1 + 0.006);
      }
      // where the old pattern put them: pattern space x = 0 mod 1.6 after rotate(45), i.e. (x + y) / sqrt 2 = 1.6 k
      const u = (+l.x1 + +l.y1) / Math.SQRT2 / 1.6;
      expect(Math.abs(u - Math.round(u))).toBeLessThan(0.01);
      // 45 degree lines
      expect(Math.abs(Math.abs(+l.x2 - +l.x1) - Math.abs(+l.y2 - +l.y1))).toBeLessThan(0.02);
    }
    // the hatch is drawn before (under) the outline of the same node
    expect(r.svg.indexOf('data-hatch="45"')).toBeLessThan(r.svg.indexOf('data-node="srv"'));
  });

  test("secondary class: 135 degree lines; a non-box accent node is cut by a clipPath of its outline", () => {
    const r = build.buildDiagramSvg(
      spec((s) => {
        s.nodes[0].class = { ...(s.nodes[0].class ?? {}), secondary: true };
        const db = s.nodes.find((n: any) => n.shape === "cylinder");
        db.class = { ...(db.class ?? {}), accent: true };
      }),
      { release: false },
    );
    expect(r.svg).not.toContain("<pattern");
    expect(r.svg).toMatch(/data-hatch="135"/);
    const clip = /<clipPath id="([^"]+)"><path d="[^"]+"\/><\/clipPath><g [^>]*data-hatch="45"[^>]*clip-path="url\(#([^)]+)\)"/.exec(r.svg);
    expect(clip).not.toBeNull();
    expect(clip![1]).toBe(clip![2]);
  });

  test("the hatch survives the HTML sanitiser (the PDF path): lines kept, clip ids prefixed, no pattern", () => {
    const r = build.buildDiagramSvg(
      spec((s) => {
        const db = s.nodes.find((n: any) => n.shape === "cylinder");
        db.class = { ...(db.class ?? {}), accent: true };
      }),
      { release: false },
    );
    const san = sanitize.sanitizeSvg(r.svg, { idPrefix: "f1-", widthMm: r.widthMm, heightMm: r.heightMm, ariaLabel: "Gambar 4.1" }).svg;
    expect(san).not.toContain("<pattern");
    expect((san.match(/<line /g) ?? []).length).toBeGreaterThan(40);
    expect(san).toMatch(/<clipPath id="f1-datum-hatch-clip-\d+">/);
    expect(san).toMatch(/clip-path="url\(#f1-datum-hatch-clip-\d+\)"/);
  });

  test("DATUM-25: the colour values are unchanged by the line hatch (ink400 as the pattern line was)", () => {
    const r = build.buildDiagramSvg(spec(), { release: false });
    expect(r.report.colourValues).toContain("#6B7783");
    expect(r.report.nColour).toBeLessThanOrEqual(5);
  });
});
