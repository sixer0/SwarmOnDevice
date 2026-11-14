// Swarm 1.2.6 row 60 (T-04, E-11 LABEL_LEADER): edge labels sit on the longest segment of their
// path with a paper knockout; a leader line is drawn only when the path has no free spot.
//
// FIX red test = the alternative fixture of 01g section 3.4 (probe 1, the 3-tier chain, was green at
// BASE e363918a69 and is kept as CHAR in row60-t04-probe1.test.ts): an L path whose default label
// position (`labelPos`) lies on the SHORT leg because the midpoint of the long leg sits under a node.
// At BASE `onPath` only tries t = 1/2, 1/4, 3/4 of each segment; all three spots of the long leg
// are under a row of nodes, the short leg is too short, so the label floats away on a leader line
// (mode "leader" = one `LABEL_LEADER` note, build/fitlabels.ts:111) although the long leg has free
// room between the nodes. Synthetic geometry (the rev 160/182 specs are not in the repo).
import { describe, expect, it } from "bun:test";
import { useStudioEnv } from "../ported/_env";
import { knockBox, placeEdgeLabels, type EdgeLabelInput } from "@/lib/studio/engine/diagram/fit/labels";
import { withDiagramFit, type DiagramFitState } from "@/lib/studio/engine/diagram/fit/state";

useStudioEnv();

type Box = readonly [number, number, number, number];
const inter = (a: Box, b: Box) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
const grow = (b: Box, d: number): Box => [b[0] - d, b[1] - d, b[2] + d, b[3] + d];

// Node A (source) above the short leg, node B (target) at the end of the long leg, and a row of
// three nodes whose bottom edge runs just above the long leg (bus-like row of devices).
const A: Box = [15, 8, 45, 20];
const B: Box = [130, 18, 160, 30];
const ROW: Box[] = [
  [48, 5, 62, 21],
  [73, 5, 87, 21],
  [98, 5, 112, 21],
];
const NODES: Box[] = [A, B, ...ROW];
// Short leg x=30, y 20 -> 23 (3 mm); long leg y=23, x 30 -> 130 (100 mm).
const L_PATH: Array<[number, number]> = [
  [30, 20],
  [30, 23],
  [130, 23],
];
const LABEL = "ack"; // well under the 18-char bound

// `labelPos` (build/svg.ts:187): the long-leg midpoint (80, 23) is inside the padded box of the
// middle row node, the short-leg midpoint is inside the padded box of A, so the default falls back
// to the long-leg midpoint (`midLabel`), lifted by pt2mm(1.2); it collides with the row node.
const ORIG: [number, number] = [80, 23 - (1.2 * 25.4) / 72];

const edge = (points: Array<[number, number]>, orig: [number, number], label = LABEL): EdgeLabelInput => ({ label, kind: "data", points, orig });
const ctx = { W: 166, yMax: 120, nodeBoxes: NODES, obstacles: [] as Box[] };

/** Count `LABEL_LEADER` the way build/fitlabels.ts:111 does: one note per label in mode "leader". */
function leaderNotes(placed: ReturnType<typeof placeEdgeLabels>["placed"]): number {
  const state: DiagramFitState = { notes: [] };
  return withDiagramFit(state, () => placed.filter((p) => p.mode === "leader").length);
}

describe("T-04 edge labels on the longest segment (L path, default on the short leg)", () => {
  it("LABEL_LEADER count is 0: the label sits on the long leg, not on a leader line", () => {
    const plan = placeEdgeLabels([edge(L_PATH, ORIG)], ctx);
    const p = plan.placed[0];
    expect(leaderNotes(plan.placed)).toBe(0);
    expect(p.mode).toBe("moved");
    expect(p.leader).toBeUndefined();
    expect(plan.numbered).toHaveLength(0);
  });

  it("the knockout band lies on the long leg (y = 23 inside the band, x within the leg) and clears every node", () => {
    const p = placeEdgeLabels([edge(L_PATH, ORIG)], ctx).placed[0];
    const box = knockBox(p.x, p.y, p.kw);
    expect(box[1]).toBeLessThan(23);
    expect(box[3]).toBeGreaterThan(23);
    expect(p.x).toBeGreaterThanOrEqual(30);
    expect(p.x).toBeLessThanOrEqual(130);
    for (const n of NODES) expect(inter(box, grow(n, 0.3))).toBe(0);
    expect(p.text).toBe(LABEL);
  });

  it("an 18-char label on the same L path also stays on the long leg when a gap fits it", () => {
    // widen the gap between the first two row nodes so an 18-char band (~24.1 mm) fits
    const nodes: Box[] = [A, B, [48, 5, 52, 21], [80, 5, 87, 21], [98, 5, 112, 21]];
    const label = "kirim telemetri 18";
    expect(label.length).toBe(18);
    const plan = placeEdgeLabels([edge(L_PATH, ORIG, label)], { ...ctx, nodeBoxes: nodes });
    expect(leaderNotes(plan.placed)).toBe(0);
    const p = plan.placed[0];
    const box = knockBox(p.x, p.y, p.kw);
    expect(box[1]).toBeLessThan(23);
    expect(box[3]).toBeGreaterThan(23);
    for (const n of nodes) expect(inter(box, grow(n, 0.3))).toBe(0);
  });

  it("a leader is still used when the path has no free spot at all", () => {
    // the whole long leg is under one wide node: no on-path spot exists
    const nodes: Box[] = [A, B, [33, 5, 128, 21]];
    const plan = placeEdgeLabels([edge(L_PATH, ORIG)], { ...ctx, nodeBoxes: nodes });
    // Swarm 1.2.8 row 57c (INTENT): before a leader the label is tried beside its line (below the long leg here, off the
    // line, no knock-out over it); a leader stays the fallback when no spot beside the line is free either.
    const p = plan.placed[0];
    expect(["moved", "leader", "numbered"]).toContain(p.mode);
    if (p.mode === "moved") {
      const box = knockBox(p.x, p.y, p.kw);
      expect(box[1]).toBeGreaterThan(23); // beside: below the long leg
      for (const n of nodes) expect(inter(box, grow(n, 0.3))).toBe(0);
    }
    const none: Box[] = [A, B, [33, 5, 128, 21], [0, 23.3, 166, 60]]; // the band of free room under the leg filled too
    expect(["leader", "numbered"]).toContain(placeEdgeLabels([edge(L_PATH, ORIG)], { ...ctx, nodeBoxes: none }).placed[0].mode);
  });

  it("deterministic: two runs give identical placements", () => {
    expect(placeEdgeLabels([edge(L_PATH, ORIG)], ctx)).toEqual(placeEdgeLabels([edge(L_PATH, ORIG)], ctx));
  });
});
