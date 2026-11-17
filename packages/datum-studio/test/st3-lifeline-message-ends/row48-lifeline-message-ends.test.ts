// Swarm 1.3.3 row 48 (ST-3 item 8; manual test 2026-11-17 finding 13, gap matrix line 384): the geometry lint must
// not refuse a message end on a lifeline of the sequence family.
//
// Cause found by replay: `connectorEnds` (fit/lint.ts) recognised a lifeline only when its x lay strictly inside its
// actor box. The sequence layout snaps the actor box and the lifeline to the lattice separately; with 4 actors on
// 128 mm, or 5 on 166 mm, the lifeline hangs from a bottom corner of its actor (x = box edge), was not recognised,
// and every message end on it came back as `edgeEndOffNode` ("konektor 0 / 32.00, ..." in the manual test). The
// 3-actor round-2 specs have every lifeline inside its box and were clean before this row.
//
// Fixtures: fixtures/r2_u2_*.json and r3_p4_18_2_sequence.json are byte copies of the replay sets R2 and R3.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { useStudioEnv } from "../ported/_env";
import { buildDiagramSvgRaw } from "@/lib/studio/engine/diagram/build";
import { withDiagramFit } from "@/lib/studio/engine/diagram/fit/state";
import { lintDiagramGeometry } from "@/lib/studio/engine/diagram/fit/lint";

useStudioEnv();

type J = Record<string, any>;
const HERE = path.join(import.meta.dir, "fixtures");
const BASE = { $schema: "studio.diagram/v1", id: "2.1", title: "Urutan uji.", classification: "TERBATAS", sources: ["Sumber uji."] };

function svgOf(spec: J, width: 128 | 166, fit = false): string {
  const s = { ...spec, width_mm: width, apparatus: "page" };
  const run = () => buildDiagramSvgRaw(structuredClone(s) as any, { release: false, keyLabel: "KUNCI" }).svg;
  return fit ? withDiagramFit({ notes: [] }, run) : run();
}
const endDefects = (svg: string) => lintDiagramGeometry(svg).defects.filter((d) => d.kind === "edgeEndOffNode");
const actors = (k: number): J[] => Array.from({ length: k }, (_, i) => ({ id: `a${i}`, label: `:Aktor${i}`, class: {} }));
/** Calls left to right, then replies right to left: every lifeline carries a head and a tail. */
const there = (k: number): J[] => Array.from({ length: k - 1 }, (_, i) => ({ from: `a${i}`, to: `a${i + 1}`, kind: "data", label: `m${i}()` }));
const back = (k: number): J[] => Array.from({ length: k - 1 }, (_, i) => ({ from: `a${k - 1 - i}`, to: `a${k - 2 - i}`, kind: "control", label: `r${i}` }));
const seq = (k: number, edges: J[], extra: J = {}): J => ({ ...BASE, family: "sequence", nodes: actors(k), edges, ...extra });

/** The lifelines of a sheet (dashed hair verticals) and the actor boxes, read from the SVG. */
function geometry(svg: string) {
  const num = (s: string, k: string) => Number(new RegExp(`\\b${k}="([-\\d.]+)"`).exec(s)![1]);
  const lifelines = [...svg.matchAll(/<line\b[^>]*stroke-dasharray="[^"]*"[^>]*\/>/g)].map((m) => m[0]).filter((l) => num(l, "x1") === num(l, "x2")).map((l) => ({ x: num(l, "x1"), y1: num(l, "y1"), y2: num(l, "y2") }));
  const boxes = [...svg.matchAll(/<rect\b[^>]*data-node="[^"]*"[^>]*\/>/g)].map((m) => ({ x0: num(m[0], "x"), x1: num(m[0], "x") + num(m[0], "width") }));
  const ends = [...svg.matchAll(/<path d="M ([-\d.]+) ([-\d.]+) L ([-\d.]+) ([-\d.]+)"[^>]*data-mark="link"/g)].map((m) => ({ x0: Number(m[1]), x1: Number(m[3]), y: Number(m[2]) }));
  return { lifelines, boxes, ends };
}

describe("row 48: round-2 and round-1 sequence specs pass the connector-end lint", () => {
  for (const name of ["r2_u2_6_sequence.json", "r2_u2_7_sequence.json", "r2_u2_8_sequence.json", "r2_u2_9_sequence.json", "r3_p4_18_2_sequence.json"]) {
    for (const width of [128, 166] as const) {
      for (const fit of [false, true]) {
        test(`${name} at ${width} mm${fit ? " (fit)" : ""}: no message end refused`, () => {
          const raw = JSON.parse(readFileSync(path.join(HERE, name), "utf8"));
          const svg = svgOf({ ...BASE, title: raw.caption.text, sources: [raw.source.text], ...raw.spec }, width, fit);
          expect(raw.spec.family).toBe("sequence");
          expect(endDefects(svg)).toEqual([]);
        });
      }
    }
  }
});

describe("row 48: a lifeline that hangs from a corner of its actor carries its message ends", () => {
  test("the case exists: 5 actors on 166 mm put a lifeline on the edge of its actor box", () => {
    const g = geometry(svgOf(seq(5, there(5)), 166));
    expect(g.lifelines.length).toBe(5);
    const onEdge = g.lifelines.filter((l) => g.boxes.some((b) => Math.abs(l.x - b.x0) < 0.01 || Math.abs(l.x - b.x1) < 0.01));
    expect(onEdge.length).toBeGreaterThan(0);
    // every message end is on a lifeline: the drawing is right, only the lint read it wrong
    for (const e of g.ends) for (const x of [e.x0, e.x1]) expect(g.lifelines.some((l) => Math.abs(l.x - x) < 0.01 && e.y > l.y1 && e.y < l.y2)).toBe(true);
  });
  test("calls: 5 actors on 166 mm (manual test finding 13)", () => expect(endDefects(svgOf(seq(5, there(5)), 166))).toEqual([]));
  test("calls: 4 actors on 128 mm", () => expect(endDefects(svgOf(seq(4, there(4)), 128))).toEqual([]));
  test("calls: 5 and 6 actors on 128 mm", () => {
    expect(endDefects(svgOf(seq(5, there(5)), 128))).toEqual([]);
    expect(endDefects(svgOf(seq(6, there(6)), 128))).toEqual([]);
  });
  test("return messages (kind control, right to left) on the same lifelines", () => {
    expect(endDefects(svgOf(seq(5, [...there(5), ...back(5)]), 166))).toEqual([]);
    expect(endDefects(svgOf(seq(4, [...there(4), ...back(4)]), 128))).toEqual([]);
  });
  test("a message that skips lifelines (first to last and back)", () => {
    const edges = [{ from: "a0", to: "a4", kind: "data", label: "jauh()" }, { from: "a4", to: "a0", kind: "control", label: "balik" }, { from: "a1", to: "a3", kind: "data", label: "tengah()" }];
    expect(endDefects(svgOf(seq(5, edges), 166))).toEqual([]);
  });
  test("8 actors on 166 mm", () => expect(endDefects(svgOf(seq(8, [...there(8), ...back(8)]), 166))).toEqual([]));
  test("actors inside a container, and inside a zone", () => {
    const edges = [...there(4), ...back(4)];
    expect(endDefects(svgOf(seq(4, edges, { containers: [{ id: "c", label: "Zona K1", members: ["a1", "a2"] }] }), 128))).toEqual([]);
    expect(endDefects(svgOf(seq(4, edges, { zones: [{ id: "z", label: "Zona K1", members: ["a1", "a2"] }] }), 128))).toEqual([]);
  });
  test("after the fit pass as well", () => {
    expect(endDefects(svgOf(seq(5, [...there(5), ...back(5)]), 166, true))).toEqual([]);
    expect(endDefects(svgOf(seq(4, [...there(4), ...back(4)]), 128, true))).toEqual([]);
  });
});

describe("row 48: an end that is not on a lifeline is still refused", () => {
  const clean = svgOf(seq(5, there(5)), 166);
  test("the unchanged sheet is clean and has the path this group edits", () => {
    expect(endDefects(clean)).toEqual([]);
    expect(clean).toContain('d="M 42.67 47.62 L 85.33 47.62"');
    expect(clean).toContain('<line x1="85.33" y1="23.81" x2="85.33"');
  });
  test("a message head that stops 10 mm short of its lifeline, in the space between two lifelines", () => {
    const d = endDefects(clean.replace('d="M 42.67 47.62 L 85.33 47.62"', 'd="M 42.67 47.62 L 75.33 47.62"'));
    expect(d.length).toBe(1);
    expect(d[0].text).toBe("konektor 1");
  });
  test("a message head that runs 10 mm past its lifeline", () => {
    const d = endDefects(clean.replace('d="M 42.67 47.62 L 85.33 47.62"', 'd="M 42.67 47.62 L 95.33 47.62"'));
    expect(d.map((x) => x.text)).toEqual(["konektor 1"]);
  });
  test("a dashed vertical that does not start at an actor's bottom side is not a lifeline", () => {
    // the same line 5 mm lower no longer hangs from the actor: the head of message 1 on it is refused
    const d = endDefects(clean.replace('<line x1="85.33" y1="23.81" x2="85.33"', '<line x1="85.33" y1="28.81" x2="85.33"'));
    expect(d.map((x) => x.text)).toContain("konektor 1");
  });
  test("a dashed vertical 2 mm beside the actor box is not a lifeline", () => {
    // a2 spans 64.00..85.33; the line moved to 87.33 starts at the bottom level but beside the box
    const d = endDefects(clean.replace('<line x1="85.33" y1="23.81" x2="85.33"', '<line x1="87.33" y1="23.81" x2="87.33"'));
    expect(d.map((x) => x.text)).toContain("konektor 1");
  });
  test("a message end above the lifeline (beside the actor head) is refused", () => {
    const d = endDefects(clean.replace('d="M 42.67 47.62 L 85.33 47.62"', 'd="M 42.67 5.00 L 95.33 5.00"'));
    expect(d.map((x) => x.text)).toContain("konektor 1");
  });
  // Not built in row 48 (layout, outside fit/lint.ts): the sequence layout draws a self-message as a straight stub to
  // x + 2 lattice columns, which ends on no lifeline; the lint is right to refuse it until the layout folds it back.
  test("a self-message stub ends on no lifeline and stays refused (layout gap, gap matrix line 87)", () => {
    const edges = [{ from: "a0", to: "a1", kind: "data", label: "x()" }, { from: "a1", to: "a1", kind: "data", label: "diri()" }];
    const d = endDefects(svgOf(seq(3, edges), 166));
    expect(d.map((x) => x.text)).toEqual(["konektor 1"]);
  });
});
