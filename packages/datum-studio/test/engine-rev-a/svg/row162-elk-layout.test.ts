// Row 162 (U24 C, C126, C131, C134): ELK (elkjs 0.12.0, lib/elk.bundled.js only) as the layout engine
// of the layered/topology diagram families. ELK gives the tier order, node x and orthogonal routes;
// Studio keeps its SVG drawing and the Rev A apparatus. The selection rule (R1-R4) is in
// vendor/src/lib/studio/engine/diagram/elk/index.ts. Pure engine calls: no network, no model, no browser.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const PKG = path.resolve(import.meta.dir, "..", "..", "..");
const STUDIO = path.join(PKG, "vendor", "src", "lib", "studio");
const ENGINE = path.join(STUDIO, "engine");
const ELK_DIR = path.join(ENGINE, "diagram", "elk");
const build = await import(path.join(ENGINE, "diagram", "build", "index.ts"));
const core = await import(path.join(ENGINE, "diagram", "core", "index.ts"));
const geom = await import(path.join(ENGINE, "diagram", "fit", "lint.ts"));
const elk = await import(path.join(ELK_DIR, "index.ts"));
const adapter = await import(path.join(ELK_DIR, "adapter.ts"));
const plans = await import(path.join(ELK_DIR, "plan.ts"));
const dispatch = await import(path.join(STUDIO, "contract", "dispatch.ts"));
const place = await import(path.join(ENGINE, "diagram", "build", "place.ts"));
const figures = await import(path.join(STUDIO, "services", "render", "figures.ts"));

const fixture = (f: string) => JSON.parse(readFileSync(path.join(import.meta.dir, "fixtures", f), "utf8"));
/** Byte copies of the Rev A case 04 materials (rows 124 / 124b). */
const CASE04 = fixture("case04.studio.json");
const CASE04_V2 = fixture("case04_v2.studio.json");
/** Synthetic 15-node, 16-edge layered figure (4/4/4/3 per tier at 166 mm) whose edge order makes the old router cross. */
const LARGE = fixture("row162_large_layered.json");
/** Same shape, other edge set: ELK's layout is not better here, so the rule must keep the original. */
const NOT_BETTER = fixture("row162_elk_not_better.json");
const clone = (s: any) => structuredClone(s);

// ── SVG helpers (the shapes this engine emits; same as row124-svg.test.ts) ──
const attrs = (tag: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
};
type Box = { id: string; x: number; y: number; w: number; h: number };
const nodeBoxes = (svg: string): Box[] =>
  [...svg.matchAll(/<rect\b([^>]*\bdata-mark="node"[^>]*)\/>/g)].map((m) => {
    const a = attrs(m[1]);
    return { id: a["data-node"], x: +a.x, y: +a.y, w: +a.width, h: +a.height };
  });
const links = (svg: string): Array<Array<[number, number]>> =>
  [...svg.matchAll(/<path\b([^>]*\bdata-mark="link"[^>]*)\/>/g)].map((m) =>
    [...attrs(m[1]).d.matchAll(/[ML]\s*(-?[\d.]+)\s+(-?[\d.]+)/g)].map((q) => [+q[1], +q[2]] as [number, number]),
  );
const lintColours = (svg: string): string[] => {
  const all = new Set([...svg.matchAll(/(?:fill|stroke)="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1].toUpperCase()));
  for (const g of ["#FCFCFB", "#FBFAF7", "#FFFFFF"]) all.delete(g);
  return [...all].sort();
};
const inside = (p: [number, number], b: Box, inset = 0.3) => p[0] > b.x + inset && p[0] < b.x + b.w - inset && p[1] > b.y + inset && p[1] < b.y + b.h - inset;
const onBoundary = (p: [number, number], b: Box) => p[0] >= b.x - 0.01 && p[0] <= b.x + b.w + 0.01 && p[1] >= b.y - 0.01 && p[1] <= b.y + b.h + 0.01 && !inside(p, b, 0.01);
/** CP-41 (ID p.63, 10.3; DT-01b p.62): connectors through the interior of any box, own boxes included. */
const throughBoxes = (svg: string): string[] => {
  const boxes = nodeBoxes(svg);
  const bad: string[] = [];
  links(svg).forEach((pl, li) => {
    for (let i = 0; i + 1 < pl.length; i++) {
      for (let k = 0; k <= 40; k++) {
        const t = k / 40;
        const p: [number, number] = [pl[i][0] + (pl[i + 1][0] - pl[i][0]) * t, pl[i][1] + (pl[i + 1][1] - pl[i][1]) * t];
        for (const b of boxes) if (inside(p, b)) bad.push(`edge ${li} seg ${i} in ${b.id}`);
      }
    }
  });
  return [...new Set(bad)];
};
const routeDefects = (svg: string) => elk.routeDefects(geom.lintDiagramGeometry(svg));

async function auto(s: any, opts: any = { release: false }, deps: any = {}) {
  let decision: any;
  const r = await elk.buildDiagramSvgAuto(s, opts, deps, (d: any) => (decision = d));
  return { r, decision };
}

// ── C10 / C12 / L4 / T8: how ELK is loaded and constructed ──────────────────────────────────
describe("ELK import and construction (row 160 C10, C12, L4; T8 under Bun)", () => {
  const src = readFileSync(path.join(ELK_DIR, "adapter.ts"), "utf8");
  test("only elk.bundled.js is imported; no worker URL, no worker factory, no ELK logging options", () => {
    const imports = [...src.matchAll(/from\s+"(elkjs[^"]*)"/g)].map((m) => m[1]);
    expect(imports).toEqual(["elkjs/lib/elk.bundled.js", "elkjs/lib/elk-api"]);
    expect(src).toMatch(/import type \{[^}]*\} from "elkjs\/lib\/elk-api"/); // types only, erased at build
    expect(src).toMatch(/new ELK\(\)/);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); // comments name the banned options
    for (const banned of [/workerUrl/, /workerFactory/, /new ELK\(\s*\{/, /logging/, /measureExecutionTime/, /web-worker/, /elk-worker/]) {
      expect(`${banned} ${banned.test(code)}`).toBe(`${banned} false`);
    }
    for (const f of ["plan.ts", "routes.ts", "index.ts"]) expect(readFileSync(path.join(ELK_DIR, f), "utf8")).not.toMatch(/from\s+"elkjs/);
  });

  test("ELK lays out a fixture under Bun and globalThis.onmessage stays unchanged (T8, L4)", async () => {
    const before = (globalThis as any).onmessage;
    const plan = await elk.elkLayoutPlan(clone(LARGE));
    expect((globalThis as any).onmessage).toBe(before);
    expect(typeof self).toBe("object"); // `self` restored after the guarded construction
    expect(Object.keys(plan.cx).length).toBe(LARGE.nodes.length);
    expect(plan.layers.map((l: string[]) => l.length)).toEqual([4, 4, 4, 3]);
  });

  test("the ELK graph carries generated ids and fixed options only; no agent text reaches ELK (C10, C9)", () => {
    const s = clone(LARGE);
    s.nodes[0].id = "constructor";
    s.nodes[1].id = "__proto__x";
    s.nodes[2].label = "<script>alert(1)</script>";
    s.edges.forEach((e: any) => {
      if (e.from === LARGE.nodes[0].id) e.from = "constructor";
      if (e.from === LARGE.nodes[1].id) e.from = "__proto__x";
    });
    const { graph } = adapter.elkGraphFor(s);
    const json = JSON.stringify(graph);
    for (const c of graph.children) expect(c.id).toMatch(/^n\d+$/);
    for (const e of graph.edges) {
      expect(e.id).toMatch(/^e\d+$/);
      for (const id of [...e.sources, ...e.targets]) expect(id).toMatch(/^n\d+$/);
    }
    for (const leak of ["constructor", "__proto__", "script", "Sensor", "Gerbang", "Ethernet"]) expect(json.includes(leak)).toBe(false);
    expect(Object.keys(graph.layoutOptions).sort()).toEqual(Object.keys(adapter.elkGraphFor(clone(CASE04)).graph.layoutOptions).sort());
    expect(Object.keys(graph.layoutOptions).some((k) => /logging|measureExecutionTime/i.test(k))).toBe(false);
    expect(({} as any).polluted).toBeUndefined();
  });

  test("specs over the capacity bounds are refused BEFORE ELK runs, as a handled rejection (C8)", async () => {
    const s = clone(LARGE);
    for (let i = 0; i < 10; i++) s.nodes.push({ id: `x${i}`, label: `Tambahan ${i}`, class: { tier: 3 } });
    expect(s.nodes.length).toBe(25);
    expect(adapter.elkRefusal(s)).toMatch(/25 nodes > 24/);
    const rejections: unknown[] = [];
    const onRej = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRej);
    try {
      await expect(elk.elkLayoutPlan(s)).rejects.toThrow(/ELK_LAYOUT: 25 nodes > 24/);
      let planned = 0;
      // the auto entry never asks for a plan for such a spec (the old build refuses the width first here)
      await elk.buildDiagramSvgAuto(s, { release: false }, { plan: async () => (planned++, elk.elkLayoutPlan(s)) }).catch(() => undefined);
      expect(planned).toBe(0);
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      process.off("unhandledRejection", onRej);
    }
    expect(rejections).toEqual([]);
  });

  test("families ELK does not lay out are refused (R1)", () => {
    for (const fam of ["stack", "graph", "flow", "swimlane", "sequence", "sld", "rack"]) expect(adapter.elkRefusal({ ...clone(CASE04), family: fam })).toMatch(/not laid out by ELK/);
    expect(adapter.elkRefusal(clone(CASE04))).toBeNull();
  });
});

// ── The rule: no churn for figures the old router handles well ───────────────────────────────
describe("selection rule R1/R2: existing outputs do not churn", () => {
  for (const [name, s] of [
    ["case 04 (material_rev_a)", CASE04],
    ["case 04 v2 (material_rev_a_v2)", CASE04_V2],
  ] as const) {
    test(`${name}: auto build = original build byte for byte, ELK never asked`, async () => {
      let planned = 0;
      const { r, decision } = await auto(clone(s), { release: false }, { plan: async (sp: any, o: any) => (planned++, elk.elkLayoutPlan(sp, o)) });
      expect(r.svg).toBe(build.buildDiagramSvg(clone(s), { release: false }).svg);
      expect(planned).toBe(0);
      expect(decision).toEqual({ used: false, reason: "R2: original layout has no route defect" });
    });
  }

  test("ID document options pass through unchanged (case 04: GAMBAR caption, KUNCI key)", async () => {
    const opts = { release: false, ...figures.diagramApparatusOptions("ID") };
    const { r } = await auto(clone(CASE04), opts);
    expect(r.svg).toBe(build.buildDiagramSvg(clone(CASE04), opts).svg);
    expect(r.svg).toContain('<tspan font-weight="600">GAMBAR 4.1</tspan>');
    expect(r.svg).toContain("KUNCI  ");
  });

  test("a stack figure is never laid out by ELK (R1)", async () => {
    const s = { ...clone(CASE04), family: "stack" };
    const { r, decision } = await auto(clone(s));
    expect(decision.reason).toBe("R1: family stack");
    expect(r.svg).toBe(build.buildDiagramSvg(clone(s), { release: false }).svg);
  });

  test("without an active plan the synchronous build is the original layout (layered.ts hook inert)", () => {
    const s = clone(LARGE);
    expect(plans.elkPlanFor(s, 166)).toBeUndefined();
    expect(routeDefects(build.buildDiagramSvg(s, { release: false }).svg)).toBe(4); // the old router's result, unchanged
  });
});

// ── R3/R4: a large figure the old router squeezes is laid out cleanly ──────────────────────────
describe("R3/R4: large layered figure", () => {
  const old = build.buildDiagramSvg(clone(LARGE), { release: false });
  const oldG = geom.lintDiagramGeometry(old.svg);

  test("the old layout has route defects (2 crossings, 2 collinear runs)", () => {
    expect({ cross: oldG.counts.edgeCross, collinear: oldG.counts.edgeCollinear, through: oldG.counts.edgeThroughNode }).toEqual({ cross: 2, collinear: 2, through: 0 });
  });

  test("with ELK: no crossing, no collinear run, no connector through a box; geometry score 0; ELK reported", async () => {
    const { r, decision } = await auto(clone(LARGE));
    expect(decision.used).toBe(true);
    expect(decision.before).toEqual({ routeDefects: 4, score: 4 });
    expect(decision.after).toEqual({ routeDefects: 0, score: 0 });
    const g = geom.lintDiagramGeometry(r.svg);
    expect(g.score).toBe(0);
    expect(throughBoxes(r.svg)).toEqual([]);
    const note = (r.report.geometry ?? []).find((i: any) => i.checkId === "ELK_LAYOUT");
    expect(note?.status).toBe("REPORT");
    expect(note?.detail).toMatch(/^ELK layout used: R3\/R4: route defects 4 -> 0/);
    expect(r.report.issues.filter((i: any) => i.status === "FAIL")).toEqual([]);
  });

  test("CP-41: every connector is orthogonal and starts/ends on its own boxes", async () => {
    const { r } = await auto(clone(LARGE));
    const boxes = new Map(nodeBoxes(r.svg).map((b) => [b.id, b]));
    links(r.svg).forEach((pl, li) => {
      for (let i = 0; i + 1 < pl.length; i++) expect(Math.abs(pl[i][0] - pl[i + 1][0]) < 1e-6 || Math.abs(pl[i][1] - pl[i + 1][1]) < 1e-6).toBe(true);
      const e = LARGE.edges[li];
      expect(`edge ${li} start ${onBoundary(pl[0], boxes.get(e.from)!)}`).toBe(`edge ${li} start true`);
      expect(`edge ${li} end ${onBoundary(pl[pl.length - 1], boxes.get(e.to)!)}`).toBe(`edge ${li} end true`);
    });
  });

  test("Rev A apparatus kept: <= 5 colour values, bold GAMBAR caption, KEY row, evidence marks, nodes on the lattice", async () => {
    const { r } = await auto(clone(LARGE));
    expect(lintColours(r.svg).length).toBeLessThanOrEqual(5);
    expect(r.report.nColour).toBeLessThanOrEqual(5);
    expect(r.svg).toContain('<tspan font-weight="600">GAMBAR 9.1</tspan>');
    expect(r.svg).toMatch(/>KEY {2}/);
    for (const mark of ["■", "◈", "◇"]) expect(r.svg).toContain(mark); // TERUKUR, DITURUNKAN (accent), PEMASOK glyphs
    for (const b of nodeBoxes(r.svg)) {
      // the SVG prints 2 decimals: on the lattice within the print rounding (0.005 mm)
      expect(Math.abs(b.x - Math.round(b.x / core.LATTICE_X) * core.LATTICE_X)).toBeLessThan(0.006);
      expect(Math.abs(b.y - Math.round(b.y / core.LATTICE_Y) * core.LATTICE_Y)).toBeLessThan(0.006);
    }
    // same nodes, same tiers (rows), same sheet width as the original; only order and x changed
    const rowsOf = (svg: string) => [...new Set(nodeBoxes(svg).map((b) => b.y))].sort((a, b) => a - b);
    expect(rowsOf(r.svg)).toEqual(rowsOf(old.svg));
    expect(r.widthMm).toBe(old.widthMm);
    expect(nodeBoxes(r.svg).map((b) => b.id).sort()).toEqual(nodeBoxes(old.svg).map((b) => b.id).sort());
  });

  test("deterministic: two auto builds are byte-identical", async () => {
    expect((await auto(clone(LARGE))).r.svg).toBe((await auto(clone(LARGE))).r.svg);
  });

  test("R4: when ELK is not better the original is kept, with a REPORT line", async () => {
    const before = build.buildDiagramSvg(clone(NOT_BETTER), { release: false });
    const { r, decision } = await auto(clone(NOT_BETTER));
    expect(decision.used).toBe(false);
    expect(decision.reason).toMatch(/^R4: ELK not better/);
    expect(r.svg).toBe(before.svg);
    expect((r.report.geometry ?? []).some((i: any) => i.checkId === "ELK_LAYOUT" && /not used/.test(i.detail))).toBe(true);
  });

  test("an ELK failure is handled: the original stands (no unhandled rejection)", async () => {
    const { r, decision } = await auto(clone(LARGE), { release: false }, { plan: async () => Promise.reject(new adapter.ElkUnavailable("probe")) });
    expect(decision.used).toBe(false);
    expect(decision.reason).toBe("ELK_LAYOUT: probe");
    expect(r.svg).toBe(old.svg);
  });

  test("capacity refusals are not retried with ELK (U24 B): a 5-node tier at 166 mm still refuses", async () => {
    const s = clone(LARGE);
    s.nodes.push({ id: "t1n4", label: "Gerbang 5", class: { tier: 1 } });
    let planned = 0;
    await expect(elk.buildDiagramSvgAuto(s, { release: false }, { plan: async () => (planned++, elk.elkLayoutPlan(s)) })).rejects.toThrow(/DATUM-37/);
    expect(planned).toBe(0);
  });
});

// ── ELK routes (for the route seam requested in file_requests.md) ───────────────────────────────
describe("ELK orthogonal routes on the placed sheet", () => {
  const placed = async (s: any) => {
    const plan = await elk.elkLayoutPlan(s);
    const sheet = plans.withElkPlan(plan, () => place.placeDiagram(s, new core.Sheet(Number(s.width_mm)), dispatch.DIAGRAM_LAYOUTS).sheet);
    return { plan, sheet };
  };

  for (const [name, s] of [
    ["case 04", CASE04],
    ["large layered", LARGE],
  ] as const) {
    test(`${name}: one route per edge, orthogonal, on its own boxes, through no box`, async () => {
      const { plan, sheet } = await placed(clone(s));
      const why: string[] = [];
      const routes = elk.elkRoutesOnSheet(plan, s, sheet.nodes, sheet.widthMm, (w: string) => why.push(w));
      expect(why).toEqual([]);
      expect(routes.map((r: any) => r.edge)).toEqual(s.edges.map((_: unknown, i: number) => i));
      const boxes: Box[] = [...sheet.nodes.values()].map((n: any) => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h }));
      for (const { edge, points } of routes) {
        for (let i = 0; i + 1 < points.length; i++) {
          expect(Math.abs(points[i][0] - points[i + 1][0]) < 1e-6 || Math.abs(points[i][1] - points[i + 1][1]) < 1e-6).toBe(true);
          for (let k = 0; k <= 40; k++) {
            const t = k / 40;
            const p: [number, number] = [points[i][0] + (points[i + 1][0] - points[i][0]) * t, points[i][1] + (points[i + 1][1] - points[i][1]) * t];
            for (const b of boxes) expect(`edge ${edge} in ${b.id}: ${inside(p, b)}`).toBe(`edge ${edge} in ${b.id}: false`);
          }
        }
        const e = s.edges[edge];
        expect(onBoundary(points[0], boxes.find((b) => b.id === e.from)!)).toBe(true);
        expect(onBoundary(points[points.length - 1], boxes.find((b) => b.id === e.to)!)).toBe(true);
      }
      if (name === "case 04") expect(geom.edgeConflicts(routes.map((r: any) => r.points))).toEqual({ cross: 0, collinear: 0 });
    });
  }

  test("activeElkRoutes: none without a plan, none when the plan says positions only", async () => {
    const s = clone(LARGE);
    const { plan, sheet } = await placed(s);
    const routesMod = await import(path.join(ELK_DIR, "routes.ts"));
    expect(routesMod.activeElkRoutes(s, sheet)).toBeUndefined();
    expect(plans.withElkPlan({ ...plan, routes: false }, () => routesMod.activeElkRoutes(s, sheet))).toBeUndefined();
    const r = plans.withElkPlan(plan, () => routesMod.activeElkRoutes(s, sheet));
    expect(r.length).toBe(s.edges.length);
    expect(r[0].d.startsWith("M")).toBe(true);
  });

  test("an intra-tier edge has no ELK route, so the whole figure keeps Studio's router", async () => {
    const s = clone(LARGE);
    s.edges.push({ from: "t0n0", to: "t0n1", kind: "data", label: "lokal" });
    const { plan, sheet } = await placed(s);
    const why: string[] = [];
    expect(elk.elkRoutesOnSheet(plan, s, sheet.nodes, sheet.widthMm, (w: string) => why.push(w))).toBeUndefined();
    expect(why).toEqual(["an intra-tier edge has no ELK route"]);
  });
});

// ── layered.ts hook helpers ───────────────────────────────────────────────────────────────────
describe("tier x from ELK centres (plan.ts elkTierXs)", () => {
  const lx = core.LATTICE_X;
  const plan = (cx: Record<string, number>) => ({ key: "", widthMm: 128, order: {}, cx, box: {}, sections: [], layers: [] });
  const g = (ids: string[]) => ids.map((id) => ({ id, label: id, class: {} }));
  test("nodes stay on the lattice, keep the gap and stay inside the sheet", () => {
    const xs = plans.elkTierXs(plan({ a: 0, b: 5, c: 200 }), g(["a", "b", "c"]), lx * 3, lx, 128, lx);
    expect(xs.length).toBe(3);
    for (let i = 0; i < 3; i++) expect(Math.abs(xs[i] / lx - Math.round(xs[i] / lx))).toBeLessThan(1e-6);
    expect(xs[0]).toBeGreaterThanOrEqual(0);
    expect(xs[1] - xs[0]).toBeGreaterThanOrEqual(lx * 4 - 1e-6);
    expect(xs[2] - xs[1]).toBeGreaterThanOrEqual(lx * 4 - 1e-6);
    expect(xs[2] + lx * 3).toBeLessThanOrEqual(128 + 1e-6);
  });
  test("a tier that cannot fit returns undefined (the original centring is used)", () => {
    expect(plans.elkTierXs(plan({ a: 10, b: 50, c: 90, d: 120 }), g(["a", "b", "c", "d"]), lx * 3, lx, 128, lx)).toBeUndefined();
  });
});
