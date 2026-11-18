// Swarm 1.3.3 row 40 (ST-3 item 1; round-2 retest R2-06, R2-16): the KUNCI and SUMBER rows of a figure start below
// every drawn element. Before this row the foot rows were placed below the lowest NODE only: a container frame that
// reaches two lattice rows below its members ran through the key row (R2-06, Gambar 2.1 / 2.2 / 3.2) and a sequence
// lifeline was drawn down to the sheet edge, through every foot row (R2-16).
//
// The check is geometric, on the emitted SVG: top of the first foot row (its baseline minus the cap height of its
// font size) >= the largest y of every other drawn element (node outlines, container frames, lifelines, connector
// paths, edge-label knockouts, texts).
//
// Fixtures: fixtures/r2_*.json are unchanged copies of four of the 16 round-2 specs (replay set R2); the swimlane
// specs come from test/fixtures/syn128 (rows 33b, 55b) with a legend added here.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { useStudioEnv } from "../ported/_env";
import { buildDiagramSvg, buildDiagramSvgRaw } from "@/lib/studio/engine/diagram/build";
import { withDiagramFit } from "@/lib/studio/engine/diagram/fit/state";

useStudioEnv();

type J = Record<string, any>;
const HERE = path.join(import.meta.dir, "fixtures");
const SYN = path.join(import.meta.dir, "..", "fixtures", "syn128");
const read = (dir: string, name: string): J => JSON.parse(readFileSync(path.join(dir, name), "utf8"));
const LEGEND = ["garis penuh = data", "garis putus = kontrol"];

/** A round-2 block (`{caption, source, spec}`) as a full diagram spec. */
function r2(name: string, apparatus: "page" | "figure", width = 166): J {
  const raw = read(HERE, name);
  return { $schema: "studio.diagram/v1", id: "2.1", title: raw.caption.text, classification: "TERBATAS", width_mm: width, sources: [raw.source.text], ...raw.spec, apparatus };
}
function syn(name: string, variant: string, apparatus: "page" | "figure"): J {
  const raw = read(SYN, name);
  const base = { $schema: "studio.diagram/v1", id: "1.1", title: "Alur sintetis uji.", classification: "TERBATAS", sources: ["Sumber sintetis uji."] };
  return { ...base, ...raw[variant], width_mm: 166, legend: LEGEND, apparatus };
}

const attrs = (tag: string): Record<string, string> => Object.fromEntries([...tag.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const CAP_EM = 0.7; // cap height of IBM Plex Sans Condensed, in em

interface Measured {
  /** Baselines of the key lines and the SUMBER lines, top to bottom. */
  foot: Array<{ y: number; size: number; text: string }>;
  /** Top of the first foot row: baseline minus cap height. */
  footTop: number;
  /** Largest y of every drawn element that is not a foot row, with the element that holds it. */
  drawn: { y: number; el: string };
  lifelineEnds: number[];
  height: number;
}

/** Foot rows and the bounding bottom of everything else, from a raw sheet (caption = lowest foot line). */
function measure(svg: string): Measured {
  const body = svg.replace(/<defs>[\s\S]*?<\/defs>/, "");
  const height = Number(/viewBox="0 0 [\d.]+ ([\d.]+)"/.exec(svg)![1]);
  const texts = [...body.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)].map((m) => ({ a: attrs(m[1]), text: m[2].replace(/<[^>]+>/g, ""), el: m[0] }));
  // Foot rows are the texts at x = 0 from the first KUNCI / SUMBER line down (wrapped lines included).
  const heads = texts.filter((t) => t.a.x === "0" && /^(KUNCI|SUMBER)\b/.test(t.text));
  const first = Math.min(...heads.map((t) => Number(t.a.y)));
  const isFoot = (t: (typeof texts)[number]) => t.a.x === "0" && Number(t.a.y) >= first - 1e-6;
  const foot = texts
    .filter((t) => isFoot(t) && !("data-st-caption" in t.a) && !t.el.includes("data-st-caption"))
    .map((t) => ({ y: Number(t.a.y), size: Number(t.a["font-size"]), text: t.text }))
    .sort((a, b) => a.y - b.y);
  let drawn = { y: -Infinity, el: "" };
  const see = (y: number, el: string) => {
    if (y > drawn.y) drawn = { y, el: el.slice(0, 160) };
  };
  for (const t of texts) if (!isFoot(t)) see(Number(t.a.y), t.el);
  const rects = [...body.matchAll(/<rect\b[^>]*\/>/g)].map((m) => m[0]);
  for (const el of rects.slice(1)) see(Number(attrs(el).y) + Number(attrs(el).height), el); // rects[0] = paper
  const lifelineEnds: number[] = [];
  for (const m of body.matchAll(/<line\b[^>]*\/>/g)) {
    const a = attrs(m[0]);
    see(Math.max(Number(a.y1), Number(a.y2)), m[0]);
    if (a.x1 === a.x2 && a["stroke-dasharray"]) lifelineEnds.push(Math.max(Number(a.y1), Number(a.y2)));
  }
  for (const m of body.matchAll(/<(?:polygon|polyline)\b[^>]*\/>/g)) for (const p of attrs(m[0]).points.trim().split(/\s+/)) see(Number(p.split(",")[1]), m[0]);
  for (const m of body.matchAll(/<(?:circle|ellipse)\b[^>]*\/>/g)) see(Number(attrs(m[0]).cy) + Number(attrs(m[0]).r ?? attrs(m[0]).ry), m[0]);
  for (const m of body.matchAll(/<path\b[^>]*\/>/g)) {
    // Connector and outline paths use absolute M / L / A / Q / C / Z: the y of every coordinate pair bounds the path.
    const nums = (attrs(m[0]).d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    const cmds = attrs(m[0]).d.match(/[A-Za-z]/g) ?? [];
    if (cmds.every((c) => "MLZ".includes(c))) for (let i = 1; i < nums.length; i += 2) see(nums[i], m[0]);
    else see(Math.max(...nums.filter((_, i) => i % 2 === 1)), m[0]);
  }
  return { foot, footTop: foot[0].y - CAP_EM * foot[0].size, drawn, lifelineEnds, height };
}

const raw = (s: J, fit = false): string => {
  const run = () => buildDiagramSvgRaw(structuredClone(s) as any, { release: false, keyLabel: "KUNCI" }).svg;
  return fit ? withDiagramFit({ notes: [] }, run) : run();
};

function expectFootBelowContent(svg: string): Measured {
  const m = measure(svg);
  expect(m.foot.length).toBeGreaterThan(0);
  // [top of first foot row, lowest drawn element]: the pair is printed on failure
  expect({ footTop: Number(m.footTop.toFixed(2)), drawnBottom: Number(m.drawn.y.toFixed(2)), el: m.drawn.el, ok: m.footTop >= m.drawn.y - 1e-6 }).toMatchObject({ ok: true });
  // every foot baseline is inside the sheet
  for (const f of m.foot) expect(f.y).toBeLessThanOrEqual(m.height + 1e-6);
  return m;
}

describe("row 40 ST-3.1: KUNCI and SUMBER start below every drawn element", () => {
  for (const apparatus of ["page", "figure"] as const) {
    for (const fit of [false, true]) {
      const mode = `${apparatus}${fit ? ", fit" : ""}`;
      test(`container (R2 u1 sheet 2, layered with two zones) [${mode}]`, () => {
        expectFootBelowContent(raw(r2("r2_u1_2_layered_zones.json", apparatus), fit));
      });
      test(`container (R2 u1 sheet 4, topology with two zones) [${mode}]`, () => {
        expectFootBelowContent(raw(r2("r2_u1_4_topology_zones.json", apparatus), fit));
      });
      test(`lifelines (R2 u2 sheet 6, sequence) [${mode}]`, () => {
        const m = expectFootBelowContent(raw(r2("r2_u2_6_sequence.json", apparatus), fit));
        expect(m.lifelineEnds.length).toBe(3);
        for (const y of m.lifelineEnds) expect(y).toBeLessThanOrEqual(m.footTop + 1e-6);
      });
      test(`plain (R2 u2 sheet 5, layered without container) [${mode}]`, () => {
        expectFootBelowContent(raw(r2("r2_u2_5_layered_plain.json", apparatus), fit));
      });
      test(`lanes and pools (swimlane, horizontal pools with a group) [${mode}]`, () => {
        expectFootBelowContent(raw(syn("vis2_pools_group.json", "spec", apparatus), fit));
      });
      test(`connector below the lowest node (parity dg_sld_good, the "ke beban" run) [${mode}]`, () => {
        const s = read(path.join(import.meta.dir, "..", "ported", "_fixtures", "tests", "parity", "fixtures", "diagram"), "dg_sld_good.json");
        expectFootBelowContent(raw({ ...s, apparatus }, fit));
      });
      test(`lanes and pools (swimlane, vertical pools) [${mode}]`, () => {
        expectFootBelowContent(raw(syn("vis2_pools_group.json", "vertical", apparatus), fit));
      });
    }
  }
});

describe("row 40: what stays as it was", () => {
  test("a plain figure keeps its height and key baseline (no container, no lifeline: nothing moves)", () => {
    // measured before the row 40 change (R2 u2 sheet 5 at 166 mm)
    const page = measure(raw(r2("r2_u2_5_layered_plain.json", "page")));
    expect([Number(page.height.toFixed(2)), Number(page.foot[0].y.toFixed(2))]).toEqual([90.49, 76.2]);
    const figure = measure(raw(r2("r2_u2_5_layered_plain.json", "figure")));
    expect([Number(figure.height.toFixed(2)), Number(figure.foot[0].y.toFixed(2))]).toEqual([100.01, 76.2]);
  });
  test("a sequence without a key keeps its lifelines and height (page apparatus, no legend)", () => {
    const s = r2("r2_u2_6_sequence.json", "page");
    const withKey = raw(s);
    delete s.legend;
    const noKey = buildDiagramSvgRaw(s as any, { release: false }).svg;
    const ends = (svg: string) => [...svg.matchAll(/<line\b[^>]*stroke-dasharray[^>]*\/>/g)].map((m) => Number(attrs(m[0]).y2));
    // the lifelines end at the same y with and without a key: the key is added below them
    expect(ends(withKey)).toEqual(ends(noKey));
    expect(Number(/viewBox="0 0 [\d.]+ ([\d.]+)"/.exec(noKey)![1])).toBeCloseTo(Math.max(...ends(noKey)) + 4.7625, 2);
  });
  test("row 42 request: every zone frame is drawn first, then per zone a plain ground right before its label", () => {
    const s = r2("r2_u1_2_layered_zones.json", "page");
    const svg = raw(s);
    const frames = [...svg.matchAll(/<rect\b[^>]*fill="none"[^>]*stroke-dasharray[^>]*\/>/g)].map((m) => m.index!);
    expect(frames.length).toBe(s.zones.length);
    for (const z of s.zones as J[]) {
      const at = svg.indexOf(`>${String(z.label).toUpperCase()}</text>`);
      expect(at).toBeGreaterThan(Math.max(...frames)); // label after every frame
      const text = svg.lastIndexOf("<text ", at);
      const before = svg.slice(0, text).trimEnd();
      const ground = before.slice(before.lastIndexOf("<rect "));
      expect(ground).toMatch(/^<rect\b[^>]*stroke="none"\/>$/); // the element right before the label is its ground
      expect(ground).not.toContain("data-mark");
    }
  });
  test("the stand-alone figure (caption moved above the drawing) keeps the order KUNCI, then SUMBER, inside the sheet", () => {
    const r = buildDiagramSvg(r2("r2_u2_6_sequence.json", "figure") as any, { release: false, keyLabel: "KUNCI" });
    const ys = (re: RegExp) => [...r.svg.matchAll(/<text\b([^>]*)>([^<]*)/g)].filter((m) => re.test(m[2])).map((m) => Number(attrs(m[1]).y));
    const key = ys(/^KUNCI\b/)[0];
    const src = ys(/^SUMBER\b/)[0];
    expect(key).toBeLessThan(src);
    expect(src).toBeLessThanOrEqual(r.heightMm + 1e-6);
  });
});
