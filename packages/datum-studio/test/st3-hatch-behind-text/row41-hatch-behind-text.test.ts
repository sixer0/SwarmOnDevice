// Swarm 1.3.3 row 41 (ST-3 item 2; round-2 retest R2-13, R2-21): no accent hatch behind node text.
//
// Row 165J already put a paper ground behind every text line of a hatched node (label, sub-label, tag, mark glyph).
// Replaying the 15 round-2 diagram specs (replay set R2; the 16th file is a chart) showed that ground in place for
// every text line, and one element it did not cover: the symbol badge of a hatched node (`symbol: "iec:..."`), drawn
// straight on the hatch. As authored that is node `fa1` (iec:fuse) of u2-listrik-urutan/5; some symbols also carry
// letters ("UPS" in iec:enclosure), which then lay on the hatch like any label.
//
// The check is structural, on the emitted SVG (`_overlap.ts`): an element's box crossed by a hatch line that no opaque
// rect painted between the two covers. Fixtures: fixtures/r2_*.json are unchanged copies of the 16 round-2 specs.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { useStudioEnv } from "../ported/_env";
import { buildDiagramSvg, buildDiagramSvgRaw } from "@/lib/studio/engine/diagram/build";
import { nodeSvg } from "@/lib/studio/engine/diagram/core/svg";
import { PAPER } from "@/lib/studio/engine/diagram/core/tokens";
import { withDiagramFit } from "@/lib/studio/engine/diagram/fit/state";
import { SYMBOL_CELL, labelOnHatch, parse } from "./_overlap";

useStudioEnv();

type J = Record<string, any>;
const HERE = path.join(import.meta.dir, "fixtures");
const FILES = readdirSync(HERE).filter((f) => f.endsWith(".json")).sort();
const attrs = (tag: string): Record<string, string> => Object.fromEntries([...tag.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g)].map((m) => [m[1], m[2]]));

/** A round-2 block (`{caption, source, spec}`, or the same under `diagram`) as a full diagram spec; null for a chart. */
function r2(name: string, apparatus: "page" | "figure" = "page", width = 166): J | null {
  const file = JSON.parse(readFileSync(path.join(HERE, name), "utf8"));
  const raw = file.diagram ?? file;
  if (!raw.spec?.family) return null;
  const text = (v: any): string => (typeof v === "string" ? v : v.text);
  return { $schema: "studio.diagram/v1", id: "2.1", title: text(raw.caption), classification: "TERBATAS", width_mm: width, sources: [text(raw.source)], ...structuredClone(raw.spec), apparatus };
}
const MODES = ["auto", "raw", "fit"] as const;
function render(spec: J, mode: (typeof MODES)[number] = "auto"): string {
  const o = { release: false } as any;
  if (mode === "auto") return buildDiagramSvg(spec as any, o).svg;
  if (mode === "raw") return buildDiagramSvgRaw(spec as any, o).svg;
  return withDiagramFit({ notes: [] } as any, () => buildDiagramSvgRaw(spec as any, o)).svg;
}
/** Moves the one hatch class of the figure to node `id`. */
function hatchOn(spec: J, id: string, cls: "accent" | "secondary" = "accent"): J {
  for (const n of spec.nodes) {
    if (n.class) { delete n.class.accent; delete n.class.secondary; }
    if (n.id === id) n.class = { ...(n.class ?? {}), [cls]: true };
  }
  return spec;
}

interface Badge { x0: number; y0: number; x1: number; y1: number; at: number }
/** Cell of the symbol badge of node `id`, and its position in the document. */
function badge(svg: string, id: string): Badge {
  const m = new RegExp(`<g data-symbol="[^"]*" data-symbol-of="${id}" transform="translate\\(([-\\d.]+) ([-\\d.]+)\\) scale\\(([-\\d.]+)\\)">`).exec(svg)!;
  return { x0: +m[1], y0: +m[2], x1: +m[1] + SYMBOL_CELL * +m[3], y1: +m[2] + SYMBOL_CELL * +m[3], at: m.index };
}
function nodeBox(svg: string, id: string) {
  const a = attrs(new RegExp(`<rect\\b[^>]*data-node="${id}"[^>]*/>`).exec(svg)![0]);
  return { x0: +a.x, y0: +a.y, x1: +a.x + +a.width, y1: +a.y + +a.height };
}
/** Ground rects of the figure with the document position of their group. */
function grounds(svg: string) {
  return [...svg.matchAll(/<g data-text-ground="1"[^>]*>(.*?)<\/g>/g)].flatMap((g) => [...g[1].matchAll(/<rect\b([^>]*)\/>/g)].map((r) => ({ a: attrs(r[1]), at: g.index! })));
}

describe("row 41: the 16 round-2 specs replayed, as authored", () => {
  test("15 diagram specs (the 16th is a chart): 0 label-on-hatch cases at 166 and 128 mm, page and figure apparatus, all three build paths", () => {
    let renders = 0;
    let hatched = 0;
    const cases: string[] = [];
    const charts: string[] = [];
    for (const f of FILES) {
      if (r2(f) === null) { charts.push(f); continue; }
      for (const apparatus of ["page", "figure"] as const) for (const width of [166, 128]) for (const mode of MODES) {
        const svg = render(r2(f, apparatus, width)!, mode);
        renders++;
        if (parse(svg).segs.length) hatched++;
        for (const h of labelOnHatch(svg)) cases.push(`${f} ${apparatus} ${width} ${mode}: ${h.text} (${h.visibleMm} mm of hatch visible)`);
      }
    }
    expect(FILES.length).toBe(16);
    expect(charts).toEqual(["r2_u3_3_1.json"]);
    expect(renders).toBe(180);
    expect(hatched).toBe(72); // 6 specs carry an accent node: u2 1, 2, 3, 5 and u3 2.1, 2.2
    expect(cases).toEqual([]);
  }, 60000);

  test("the check sees hatch: with the ground groups removed every hatched render reports cases", () => {
    for (const f of ["r2_u2_1.json", "r2_u2_5.json", "r2_u3_2_1.json", "r2_u3_2_2.json"]) {
      const svg = render(r2(f)!);
      expect(labelOnHatch(svg.replace(/<g data-text-ground="1"[^>]*>.*?<\/g>/g, "")).length).toBeGreaterThan(0);
    }
  });

  test("R2-13 and R2-21 as reported: label, sub-label and tag of the accented node each lie on the ground", () => {
    // u2 Gambar 2.1 (=G01-WD1, MDP 400/230 V) and u3 Gambar 2.1 (A1 ..., tag "Gbr 2.2")
    for (const [f, wanted] of [["r2_u2_1.json", ["=G01-WD1", "MDP 400/230 V"]], ["r2_u3_2_1.json", ["A1 Stolen investigator session", "GBR 2.2"]]] as const) {
      const svg = render(r2(f)!);
      const p = parse(svg);
      for (const w of wanted) {
        const t = p.texts.find((x) => x.text === w || w.startsWith(x.text))!;
        expect(t).toBeDefined();
        const crossing = p.segs.filter((s) => Math.max(s.x1, s.x2) > t.x0 && Math.min(s.x1, s.x2) < t.x1 && Math.max(s.y1, s.y2) > t.y0 && Math.min(s.y1, s.y2) < t.y1);
        expect(crossing.length).toBeGreaterThan(0); // the hatch does run under the line
      }
      expect(labelOnHatch(svg)).toEqual([]);
    }
  });
});

describe("row 41 case 1: symbol badge of a hatched node (u2-listrik-urutan/5, node fa1, iec:fuse)", () => {
  test("the badge cell lies on a paper rect inside the node, painted after the hatch and before the symbol", () => {
    for (const mode of MODES) for (const width of [166, 128]) {
      const svg = render(r2("r2_u2_5.json", "page", width)!, mode);
      const b = badge(svg, "fa1");
      const box = nodeBox(svg, "fa1");
      const hatchAt = svg.indexOf('data-hatch="45"');
      const cover = grounds(svg).filter((r) => +r.a.x <= b.x0 + 1e-6 && +r.a.y <= b.y0 + 1e-6 && +r.a.x + +r.a.width >= b.x1 - 1e-6 && +r.a.y + +r.a.height >= b.y1 - 1e-6);
      expect(cover.length).toBe(1);
      const r = cover[0];
      expect(r.a.fill).toBe(PAPER);
      expect(r.at).toBeGreaterThan(hatchAt);
      expect(r.at).toBeLessThan(b.at);
      expect(+r.a.x).toBeGreaterThanOrEqual(box.x0);
      expect(+r.a.y).toBeGreaterThanOrEqual(box.y0);
      expect(+r.a.x + +r.a.width).toBeLessThanOrEqual(box.x1 + 1e-9);
      expect(+r.a.y + +r.a.height).toBeLessThanOrEqual(box.y1 + 1e-9);
      expect(labelOnHatch(svg)).toEqual([]);
    }
  });

  test("a tagged node keeps its badge at the bottom left: the ground follows it (u2/5 fa1 with a tag)", () => {
    const s = r2("r2_u2_5.json")!;
    s.nodes.find((n: J) => n.id === "fa1").tag = "RQ-12";
    const svg = render(s);
    const b = badge(svg, "fa1");
    const box = nodeBox(svg, "fa1");
    expect(b.y1).toBeGreaterThan((box.y0 + box.y1) / 2); // bottom half
    expect(labelOnHatch(svg)).toEqual([]);
  });
});

describe("row 41 case 2: letters inside a symbol on a hatched node (u2-listrik-urutan/2, iec:enclosure \"UPS\")", () => {
  test("accent or secondary hatch on the UPS node: the badge and its letters are free of hatch", () => {
    for (const cls of ["accent", "secondary"] as const) for (const mode of MODES) {
      const svg = render(hatchOn(r2("r2_u2_2.json")!, "upsa", cls), mode);
      expect(svg).toContain(`data-hatch="${cls === "accent" ? 45 : 135}"`);
      expect(parse(svg).texts.some((t) => t.text === "UPS")).toBe(true);
      expect(labelOnHatch(svg)).toEqual([]);
    }
  });

  test("every symbol node of the five single-line specs, hatched in turn: 0 cases", () => {
    let n = 0;
    for (const f of ["r2_u2_1.json", "r2_u2_2.json", "r2_u2_3.json", "r2_u2_4.json", "r2_u2_5.json"]) {
      for (const node of r2(f)!.nodes.filter((x: J) => x.symbol)) for (const width of [166, 128]) {
        const svg = render(hatchOn(r2(f, "page", width)!, node.id));
        n++;
        expect(labelOnHatch(svg).map((h) => `${f} ${node.id} ${width}: ${h.text}`)).toEqual([]);
      }
    }
    expect(n).toBe(30); // 15 symbol nodes x 2 widths
  });
});

describe("row 41 case 3: symbol on a hatched label-below shape (BPMN event)", () => {
  test("the part of the badge over the hatched outline has a ground, clipped to the outline", () => {
    const nd: any = { id: "e1", spec: { id: "e1", label: "Mulai", shape: "event_start", class: { accent: true }, symbol: "iec:breaker" }, x: 10, y: 10, w: 21.33, h: 19.05 };
    const svg = nodeSvg(nd, { index: 0 }).join("");
    // without the ground the badge is on the hatch (the check is not vacuous)
    expect(labelOnHatch(svg.replace(/<g data-text-ground="1"[^>]*>.*?<\/g>/g, "")).map((h) => h.text)).toEqual(["symbol iec:breaker of e1"]);
    expect(svg).toContain('data-hatch="45"');
    expect(svg).toMatch(/<g data-text-ground="1" clip-path="url\(#datum-hatch-clip-0\)">/);
    expect(svg.indexOf("data-text-ground")).toBeGreaterThan(svg.indexOf("data-hatch"));
    expect(svg.indexOf("data-text-ground")).toBeLessThan(svg.indexOf("data-symbol="));
    expect(labelOnHatch(svg)).toEqual([]);
  });
});

describe("row 41: nothing else moves", () => {
  test("a symbol node without hatch gets no ground", () => {
    const s = r2("r2_u2_5.json")!;
    for (const n of s.nodes) if (n.class) delete n.class.accent;
    const svg = render(s);
    expect(svg).toContain('data-symbol-of="fa1"');
    expect(svg).not.toContain("data-text-ground");
    expect(svg).not.toContain("data-hatch");
  });

  test("a hatched node without a symbol keeps exactly the row 165J rects (u2/1: label and sub-label)", () => {
    const svg = render(r2("r2_u2_1.json")!);
    expect(grounds(svg).length).toBe(2);
  });
});
