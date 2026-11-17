// Swarm 1.3.3 row 44 (ST-3 item 5, gap matrix N5): the edge-label budget follows the space actually available.
//
// Before this row the placement had no count budget, but two fixed numbers decided when a label lost its place:
// the leader search looked at most 10 rings away from its connector (`k < 10`, fit/labels.ts `withLeader`), and every
// fallback note suggested "persingkat label tepi (maks ~20 karakter)" (build/fitlabels.ts `SUGGEST_EDGE`) whatever room
// the connector had. Now the leader search reaches as far as the drawing area does, and the remedy names the room of
// the label's own connector.
//
// Inputs: synthetic geometry for the pure placement (`placeEdgeLabels`), plus the 16 round-2 replay specs (R2) read
// from the task folder when present.
import { useStudioEnv } from "../ported/_env";
useStudioEnv();
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { replayPath } from "../replay-dir";
import { buildDiagramSvgRaw } from "@/lib/studio/engine/diagram/build";
import { withDiagramFit, type DiagramFitNote } from "@/lib/studio/engine/diagram/fit/state";

type J = Record<string, any>;
type Pt = [number, number];
type Box = [number, number, number, number];
// Namespace import, so a run on the engine before this row fails on assertions, not on a missing export.
const labels = (await import("@/lib/studio/engine/diagram/fit/labels")) as J;

const W = 166;
const edge = (y: number, label: string, x0 = 10, x1 = 156): J => ({ points: [[x0, y], [x1, y]] as Pt[], label, kind: "data", orig: [(x0 + x1) / 2, y - 0.42] as Pt });

/**
 * A horizontal connector at y = 100 from x 10 to 150 inside two text walls (obstacles) 45 mm deep above and below it.
 * With `channel` the walls leave a 1 mm gap at x = 80 (the connector's midpoint), so a leader can run straight up or
 * down out of the walls; the label box itself does not fit in the gap.
 */
function walled(channel: boolean): { edges: J[]; ctx: J } {
  const walls: Box[] = channel
    ? [
        [0, 55, 79.5, 99.4],
        [80.5, 55, W, 99.4],
        [0, 100.6, 79.5, 145],
        [80.5, 100.6, W, 145],
      ]
    : [
        [0, 55, W, 99.4],
        [0, 100.6, W, 145],
      ];
  return { edges: [edge(100, "VLAN 30 · 10 Gb/s", 10, 150)], ctx: { W, yMin: 0, yMax: 200, nodeBoxes: [], obstacles: walls } };
}

const box = (p: J): Box => labels.knockBox(p.x, p.y, p.kw) as Box;
const hit = (a: Box, b: Box) => Math.min(a[2], b[2]) > Math.max(a[0], b[0]) && Math.min(a[3], b[3]) > Math.max(a[1], b[1]);

describe("row 44: the edge-label budget is the space available", () => {
  test("a leader reaches as far as the drawing area does, not 10 rings (channel 45 mm deep)", () => {
    const { edges, ctx } = walled(true);
    const plan = labels.placeEdgeLabels(edges, ctx);
    const p = plan.placed[0];
    expect(p.mode).toBe("leader");
    expect(plan.numbered).toEqual([]);
    expect(p.text).toBe("VLAN 30 · 10 Gb/s");
    // the box clears every wall and the sheet; the leader leaves the connector at the channel
    for (const o of ctx.obstacles as Box[]) expect(hit(box(p), o)).toBe(false);
    const b = box(p);
    expect(b[1]).toBeGreaterThanOrEqual(0);
    expect(b[3]).toBeLessThanOrEqual(200);
    expect(Math.abs(p.leader[1] - p.leader[3])).toBeGreaterThan(40); // further than the old 10 rings (~38.6 mm)
  });

  test("more labels than the old ~20-character hint, and long ones, all keep their place when there is room", () => {
    const long = "SYSLOG TLS 6514 · 2 x 10 Gb/s · VRF-CCTV"; // 40 characters
    const edges = Array.from({ length: 24 }, (_, i) => edge(10 + i * 7, i === 0 ? long : `L${i} 1 Gb/s`));
    const plan = labels.placeEdgeLabels(edges, { W, yMin: 0, yMax: 200, nodeBoxes: [], obstacles: [] });
    expect(plan.numbered).toEqual([]);
    for (const p of plan.placed) expect(["keep", "moved"]).toContain(p.mode);
    expect(plan.placed[0].text).toBe(long);
  });

  test("truly no room: numbered (or unplaced), never dropped; the remedy names the label's room in characters", () => {
    const { edges, ctx } = walled(false);
    const plan = labels.placeEdgeLabels(edges, ctx);
    expect(plan.placed[0].mode).toBe("numbered");
    expect(plan.numbered).toEqual([{ number: 1, text: "VLAN 30 · 10 Gb/s", kind: "data" }]);
    expect(labels.placeEdgeLabels(edges, { ...ctx, allowNumbered: false }).placed[0].mode).toBe("unplaced");
    expect(typeof labels.edgeLabelRemedy).toBe("function");
    const r: string = labels.edgeLabelRemedy(edges[0]);
    // 140 mm run: the room is computed, not the old fixed "~20"
    expect(r).not.toContain("~20");
    const n = Number(/paling banyak (\d+) karakter/.exec(r)?.[1]);
    expect(n).toBeGreaterThan(20);
    expect(labels.railTextWidthMm("x".repeat(n)) + 1.6).toBeLessThanOrEqual(140);
    expect(r).toContain("tabel pendamping");
    expect(r).toContain("pecah menjadi 2 diagram");
  });

  test("remedy on a short connector: fewer characters, and none when even one does not fit", () => {
    const short = labels.edgeLabelRemedy(edge(50, "ARP", 10, 22));
    const n = Number(/paling banyak (\d+) karakter/.exec(short)?.[1]);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(10);
    const tiny = labels.edgeLabelRemedy({ ...edge(50, "ARP", 10, 12), heads: { end: { L: 1.6, W: 1.4 } } });
    expect(tiny).not.toMatch(/paling banyak/);
    expect(tiny).toContain("tabel pendamping");
  });
});

// R2: the 16 round-2 replay specs, read from SWARM_REPLAY_DIR/R2_round2_specs (research/05_replay_inventory.md; row 146:
// no fixed path, skipped when the variable is unset).
const R2 = replayPath("R2_round2_specs") ?? "";
if (!existsSync(R2)) console.log("[skip] row 44 replay R2: replay input not available; set SWARM_REPLAY_DIR=<1.3.3 patch folder>/research/replay to run");
describe.skipIf(!existsSync(R2))("row 44: R2 specs on the fit path", () => {
  const specs: Array<[string, J]> = [];
  if (existsSync(R2))
    for (const p of readdirSync(R2).sort())
      for (const f of readdirSync(path.join(R2, p)).sort()) {
        const raw = JSON.parse(readFileSync(path.join(R2, p, f), "utf8"));
        const d = raw.diagram ?? raw;
        if (!d.spec?.family) continue; // u3/3.1 is a chart, not a diagram
        const t = (v: any) => (typeof v === "string" ? v : (v?.text ?? ""));
        specs.push([`${p}/${f}`, { $schema: "studio.diagram/v1", id: "2.1", title: t(d.caption), classification: "TERBATAS", width_mm: 166, apparatus: "page", sources: [t(d.source)], ...d.spec }]);
      }
  test("15 diagram specs: every edge label is printed in full, and a fallback names its label and computed room", () => {
    expect(specs.length).toBe(15);
    for (const [, s] of specs) {
      const notes: DiagramFitNote[] = [];
      const svg: string = withDiagramFit({ notes }, () => buildDiagramSvgRaw(structuredClone(s) as any, { release: false, keyLabel: "KUNCI" } as any)).svg;
      const printed = [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
      for (const e of s.edges as J[]) if (String(e.label ?? "").trim()) expect(printed).toContain(String(e.label));
      for (const n of notes.filter((x) => ["LABEL_LEADER", "LABEL_NUMBERED", "LABEL_UNPLACED"].includes(x.checkId))) {
        expect(n.detail).toMatch(/label tepi '.+'/);
        expect(n.suggest ?? "").not.toContain("~20");
      }
    }
  });
});
