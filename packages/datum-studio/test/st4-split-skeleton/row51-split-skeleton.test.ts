// Swarm 1.3.3 row 51 (ST-4, last sentence): a capacity refusal that width `full` cannot solve carries a split skeleton
// in `details.split`: two specs that together hold the original, cut without dividing a zone, every cut connector
// replaced by a pair of offpage nodes with equal `ref.key` and a `{{...}}` placeholder in `ref.figure`.
import { describe, expect, it } from "bun:test";
import { useStudioEnv } from "../ported/_env";
import type { StudioDiagramV1 } from "@/lib/studio/contract";
import { PID_PATTERN } from "@/lib/studio/contract/env";
import { validateAgainst } from "@/lib/studio/services/ingest/validate";
import { DiagramDefect } from "@/lib/studio/engine/diagram/core";
import { buildDiagramSvg } from "@/lib/studio/engine/diagram/build";
import {
  CAPACITY_SPLIT_RULE,
  CAPACITY_SPLIT_TEXT,
  SPLIT_PLACEHOLDER_PART_1,
  SPLIT_PLACEHOLDER_PART_2,
  overCapacityOf,
  splitSkeletonOf,
  type DiagramOverCapacityDetails,
  type DiagramSplitSkeleton,
} from "@/lib/studio/engine/diagram/build/capacity";
import { OVER_CAPACITY } from "../figure-capacity/fixtures";

useStudioEnv();

type Rec = Record<string, any>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const spec = (o: Rec): StudioDiagramV1 => o as unknown as StudioDiagramV1;
const root = (family: string, extra: Rec): Rec => ({
  $schema: "studio.diagram/v1",
  family,
  id: "Gambar 2.1",
  title: "Arsitektur jaringan.",
  classification: "INTERNAL",
  width_mm: 166,
  sources: ["Dokumen desain"],
  ...extra,
});
/** 7 graph columns (6 fit at 166 mm, 4 at 128), a chain, a back connector across the cut and a zone over columns 2-3. */
const graph7 = (width_mm = 166): Rec =>
  root("graph", {
    width_mm,
    nodes: Array.from({ length: 7 }, (_, c) => ({ id: `g${c}`, label: `Simpul ${c + 1}`, sub: `kolom ${c}`, class: { col: c, row: 0 } })),
    edges: [
      ...Array.from({ length: 6 }, (_, c) => ({ from: `g${c}`, to: `g${c + 1}`, kind: "data", label: `alir ${c + 1}` })),
      { from: "g6", to: "g0", kind: "control", label: "umpan balik", dash: "dashed", via: [{ col: 3, row: 2 }] },
    ],
    zones: [{ id: "z1", label: "Zona inti", members: ["g2", "g3"] }],
    notes: ["Catatan uji."],
  });
const sheetDefect = () => new DiagramDefect("DATUM-37-sheet: uji", { checkId: "DATUM-37-sheet" });
const refuse = (s: Rec, e: unknown = sheetDefect()) => overCapacityOf(e, spec(s))!;
const splitOf = (s: Rec): DiagramSplitSkeleton | undefined => (refuse(s).details as DiagramOverCapacityDetails).split;
const issues = (s: unknown) => validateAgainst("studio.diagram/v1", s) as { pointer: string; message: string }[];
const fill = (k: DiagramSplitSkeleton): [Rec, Rec] =>
  JSON.parse(JSON.stringify(k.specs).replaceAll(SPLIT_PLACEHOLDER_PART_1, "blok-bagian-satu").replaceAll(SPLIT_PLACEHOLDER_PART_2, "blok-bagian-dua"));
const offpages = (s: Rec): Rec[] => (s.nodes as Rec[]).filter((n) => n.shape === "offpage");

/** The checks of the row: every node once, verbatim; every connector kept; each cut connector has a mirrored pair. */
function expectWholeSplit(original: Rec, k: DiagramSplitSkeleton) {
  const [a, b] = k.specs as unknown as [Rec, Rec];
  const real = (s: Rec) => (s.nodes as Rec[]).filter((n) => n.shape !== "offpage" || original.nodes.some((o: Rec) => o.id === n.id));
  // every original node exactly once, unchanged
  const got = [...real(a), ...real(b)];
  expect(got.map((n) => n.id).sort()).toEqual(original.nodes.map((n: Rec) => n.id).sort());
  for (const n of got) expect(n).toEqual(original.nodes.find((o: Rec) => o.id === n.id));
  // every connector: uncut ones verbatim in one part, cut ones as two halves around a pair
  const inA = new Set(real(a).map((n) => n.id));
  const cut = (original.edges as Rec[]).filter((e) => inA.has(e.from) !== inA.has(e.to));
  expect(k.pairs.length).toBe(cut.length);
  expect(a.edges.length + b.edges.length).toBe(original.edges.length + cut.length);
  for (const e of (original.edges as Rec[]).filter((x) => !cut.includes(x))) expect([...a.edges, ...b.edges]).toContainEqual(e);
  expect(new Set(k.pairs.map((p) => p.key)).size).toBe(k.pairs.length);
  for (const p of k.pairs) {
    const na = offpages(a).filter((n) => n.ref.key === p.key);
    const nb = offpages(b).filter((n) => n.ref.key === p.key);
    expect(na.length).toBe(1);
    expect(nb.length).toBe(1);
    expect(na[0].ref.figure).toBe(SPLIT_PLACEHOLDER_PART_2);
    expect(nb[0].ref.figure).toBe(SPLIT_PLACEHOLDER_PART_1);
    expect([na[0].id, nb[0].id]).toEqual(p.offpage);
    const o = cut.find((e) => e.from === p.from && e.to === p.to)!;
    const fromInA = inA.has(o.from);
    const { via: _via, ...kept } = o;
    // the half in the part of `from` ends on that part's offpage node; the other half starts on its offpage node
    expect((fromInA ? a : b).edges).toContainEqual({ ...kept, to: (fromInA ? na : nb)[0].id });
    expect((fromInA ? b : a).edges).toContainEqual({ ...kept, from: (fromInA ? nb : na)[0].id });
  }
  // no offpage node without a pair
  expect(offpages(a).length + offpages(b).length).toBe(2 * k.pairs.length);
}

describe("row 51: the capacity refusal offers a split skeleton", () => {
  it("placeholders use the register's {{key}} form and are not valid block ids", () => {
    for (const p of [SPLIT_PLACEHOLDER_PART_1, SPLIT_PLACEHOLDER_PART_2]) {
      expect(p).toMatch(/^\{\{[A-Za-z0-9_.-]{1,64}\}\}$/); // PLACEHOLDER_UNFILLED (register 03 section 5), row 52
      expect(new RegExp(PID_PATTERN).test(p)).toBe(false);
    }
    expect(SPLIT_PLACEHOLDER_PART_1).toBe("{{id_blok_bagian_1}}");
    expect(SPLIT_PLACEHOLDER_PART_2).toBe("{{id_blok_bagian_2}}");
  });

  it("graph over capacity at the full width: code, message and suggestion kept, skeleton added", () => {
    const o = refuse(graph7());
    expect(o.code).toBe("FIGURE_OVER_CAPACITY");
    expect(o.message).toContain("DATUM-37-sheet: uji");
    const d = o.details as DiagramOverCapacityDetails;
    expect(d.suggestion).toContain(`width "full" sudah dipakai: ${CAPACITY_SPLIT_TEXT}`);
    expect(o.message).toContain(d.suggestion);
    expect(d.split).toBeDefined();
    expect(d.split!.rule).toBe(CAPACITY_SPLIT_RULE);
    expect(d.split!.axis).toBe("class.col");
    expect(d.split!.placeholders).toEqual([SPLIT_PLACEHOLDER_PART_1, SPLIT_PLACEHOLDER_PART_2]);
  });

  it("the two specs hold every node once and every cut connector as a mirrored offpage pair", () => {
    const s = graph7();
    const k = splitOf(s)!;
    expectWholeSplit(s, k);
    // the chain connector g3->g4 and the back connector g6->g0 cross the cut
    expect(k.pairs.map((p) => `${p.from}>${p.to}`)).toEqual(["g3>g4", "g6>g0"]);
    expect(k.pairs.map((p) => p.key)).toEqual(["S1", "S2"]);
  });

  it("the cut never divides a zone: the middle boundary inside z1 is skipped", () => {
    const k = splitOf(graph7())!;
    const [a, b] = k.specs as unknown as [Rec, Rec];
    // 7 nodes: the boundaries nearest the middle are after g2 and after g3; after g2 would divide z1 (g2, g3)
    expect((a.nodes as Rec[]).filter((n) => n.shape !== "offpage").map((n) => n.id)).toEqual(["g0", "g1", "g2", "g3"]);
    expect((b.nodes as Rec[]).filter((n) => n.shape !== "offpage").map((n) => n.id)).toEqual(["g4", "g5", "g6"]);
    expect(a.zones).toEqual([{ id: "z1", label: "Zona inti", members: ["g2", "g3"] }]);
    expect(b.zones).toEqual([]);
    // without the zone the earlier of the two middle boundaries is used
    const free = splitOf({ ...graph7(), zones: [] })!;
    expect((free.specs[0].nodes as unknown as Rec[]).filter((n) => n.shape !== "offpage").map((n) => n.id)).toEqual(["g0", "g1", "g2"]);
  });

  it("each spec validates against studio.diagram/v1 apart from the placeholder, and fully once it is filled", () => {
    const k = splitOf(graph7())!;
    for (const s of k.specs) {
      const found = issues(s);
      expect(found.length).toBe(offpages(s as unknown as Rec).length);
      for (const i of found) expect(i.pointer).toMatch(/^\/nodes\/\d+\/ref\/figure$/);
    }
    for (const s of fill(k)) expect(issues(s)).toEqual([]);
    // root fields are carried to both parts; the internal compose signal is not
    const withSignal = splitOf({ ...graph7(), keyRowOnPage: true })!;
    for (const s of withSignal.specs as unknown as Rec[]) {
      expect(s.keyRowOnPage).toBeUndefined();
      expect(s.title).toBe("Arsitektur jaringan.");
      expect(s.notes).toEqual(["Catatan uji."]);
      expect(s.width_mm).toBe(166);
    }
  });

  it("an offpage node sits beside the node it hangs on, in a free graph cell", () => {
    const k = splitOf(graph7())!;
    const [a, b] = k.specs as unknown as [Rec, Rec];
    for (const s of [a, b]) {
      const cells = (s.nodes as Rec[]).map((n) => `${n.class.col}:${n.class.row}`);
      expect(new Set(cells).size).toBe(cells.length);
      expect(new Set((s.nodes as Rec[]).map((n) => n.id)).size).toBe(s.nodes.length);
    }
    expect(offpages(a).map((n) => [n.id, n.label, n.class])).toEqual([
      ["offpage-S1", "S1", { col: 3, row: 1 }],
      ["offpage-S2", "S2", { col: 0, row: 1 }],
    ]);
    // an id already in use is not reused
    const clash = graph7();
    clash.nodes[1].id = "offpage-S1";
    clash.edges[0].to = "offpage-S1";
    clash.edges[1].from = "offpage-S1";
    const kc = splitOf(clash)!;
    expectWholeSplit(clash, kc);
    expect(kc.pairs[0].offpage).toEqual(["offpage-S1x", "offpage-S1x"]);
  });

  it("a spec that fits at full gets the width advice, not a split", () => {
    const s = graph7(128);
    s.nodes = s.nodes.slice(0, 5);
    s.edges = s.edges.slice(0, 4);
    const d = refuse(s).details as DiagramOverCapacityDetails;
    expect(d.suggestion).toContain(`pilih width "full" (width_mm 166)`);
    expect(d.split).toBeUndefined();
    // the same 7 columns at 128 mm: full does not hold them, so the split is offered
    const d7 = refuse(graph7(128)).details as DiagramOverCapacityDetails;
    expect(d7.suggestion).toContain(`width "full" tidak cukup: ${CAPACITY_SPLIT_TEXT}`);
    expect(d7.split).toBeDefined();
  });

  it("no cut keeps every zone whole: the refusal stands without a skeleton", () => {
    const s = graph7();
    s.zones = [{ id: "z", label: "Semua", members: s.nodes.map((n: Rec) => n.id) }];
    const o = refuse(s);
    expect((o.details as DiagramOverCapacityDetails).split).toBeUndefined();
    expect(o.message).toContain(CAPACITY_SPLIT_TEXT);
    expect(splitSkeletonOf(spec(s))).toBeNull();
    expect(splitSkeletonOf(spec({ ...graph7(), nodes: [graph7().nodes[0]], edges: [] }))).toBeNull();
  });

  it("layered height refusal: cut between tiers, tier labels follow their tier", () => {
    const s = root("layered", {
      nodes: Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, label: `Lapis ${i}`, class: { tier: Math.floor(i / 2) } })),
      edges: Array.from({ length: 6 }, (_, i) => ({ from: `t${i}`, to: `t${i + 2}`, kind: "data", label: "turun" })),
      tiers: [0, 1, 2, 3].map((tier) => ({ tier, label: `Tingkat ${tier}` })),
    });
    const o = refuse(s, new DiagramDefect("DATUM-33: tinggi gambar 250 mm melewati blok teks 220 mm", { checkId: "DATUM-33" }));
    const k = (o.details as DiagramOverCapacityDetails).split!;
    expect(k.axis).toBe("class.tier");
    expectWholeSplit(s, k);
    const [a, b] = k.specs as unknown as [Rec, Rec];
    expect(a.tiers.map((t: Rec) => t.tier)).toEqual([0, 1]);
    expect(b.tiers.map((t: Rec) => t.tier)).toEqual([2, 3]);
    expect(k.pairs.map((p) => `${p.from}>${p.to}`)).toEqual(["t2>t4", "t3>t5"]);
    for (const x of fill(k)) expect(issues(x)).toEqual([]);
  });

  it("swimlane with phases: cut between phases, each part lists only the phases it uses", () => {
    const s = root("swimlane", {
      phases: ["f1", "f2", "f3"].map((id) => ({ id, label: `Fase ${id}` })),
      nodes: Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, label: `Langkah ${i + 1}`, class: { lane: i % 2 ? "Operator" : "Sistem", phase: `f${Math.floor(i / 3) + 1}` } })),
      edges: Array.from({ length: 8 }, (_, i) => ({ from: `s${i}`, to: `s${i + 1}`, kind: "control", label: "lanjut" })),
    });
    const k = splitOf(s)!;
    expect(k.axis).toBe("fase");
    expectWholeSplit(s, k);
    const [a, b] = k.specs as unknown as [Rec, Rec];
    // Row 140: the cut f1 | f2,f3 (nearest the middle, earlier on a tie) is no longer offered: its part 2 is refused by
    // the build (DATUM-37-sheet: s7 past the sheet edge at 166 mm). The next cut, f1,f2 | f3, has two parts that build.
    expect(a.phases.map((p: Rec) => p.id)).toEqual(["f1", "f2"]);
    expect(b.phases.map((p: Rec) => p.id)).toEqual(["f3"]);
    expect(offpages(a)[0].class).toEqual({ lane: "Operator", phase: "f2" }); // the cut connector s5 -> s6 hangs on s5
    for (const x of fill(k)) expect(issues(x)).toEqual([]);
  });

  it("a real refusal (row 158 fixture, 7 graph columns at 166 mm) carries the skeleton and the old text", () => {
    const original = clone(OVER_CAPACITY.graph7.spec) as Rec;
    let e: { code: string; message: string; details: DiagramOverCapacityDetails } | undefined;
    try {
      buildDiagramSvg(clone(original) as unknown as StudioDiagramV1, { release: true });
    } catch (x) {
      e = x as never;
    }
    expect(e).toBeDefined();
    expect(e!.code).toBe("FIGURE_OVER_CAPACITY");
    expect(e!.message).toContain(`width "full" sudah dipakai: ${CAPACITY_SPLIT_TEXT}`);
    expect(e!.details.split).toBeDefined();
    expectWholeSplit(original, e!.details.split!);
    for (const x of fill(e!.details.split!)) expect(issues(x)).toEqual([]);
  });

  it("a ranked flow refusal thrown ready-made (assertRankCapacity) gains the skeleton too", () => {
    // Row 140: a skeleton is offered only when its parts build. LR with more ranks than 166 mm holds: a cut between
    // ranks relieves it, so the ready-made refusal gains the skeleton (166 mm holds 4 LR ranks; 6 ranks cut 3 | 3, each
    // part with its off-page node as a fourth rank).
    const lr = root("flow", {
      direction: "LR",
      nodes: Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, label: `Tahap ${i + 1}`, class: {} })),
      edges: Array.from({ length: 5 }, (_, i) => ({ from: `r${i}`, to: `r${i + 1}`, kind: "control", label: "lanjut" })),
    });
    let lrErr: { code: string; details: DiagramOverCapacityDetails } | undefined;
    try {
      buildDiagramSvg(clone(lr) as unknown as StudioDiagramV1, { release: false });
    } catch (x) {
      lrErr = x as never;
    }
    expect(lrErr).toBeDefined();
    expect(lrErr!.code).toBe("FIGURE_OVER_CAPACITY");
    expect(lrErr!.details.checkId).toBe("DATUM-37-rank");
    expect(lrErr!.details.split?.axis).toBe("peringkat");
    expectWholeSplit(lr, lrErr!.details.split!);
    // Row 140: TB with 7 parallel nodes in rank 1 at the full width: a cut between ranks cannot relieve one rank, every
    // cut leaves a part the build refuses, so no skeleton is offered (below: the refusal stands, row 140 test names the part)
    const s = root("flow", {
      direction: "TB",
      nodes: [{ id: "a", label: "Mulai", class: {} }, ...Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, label: `Cabang ${i + 1}`, class: {} })), { id: "z", label: "Selesai", class: {} }],
      edges: [...Array.from({ length: 7 }, (_, i) => ({ from: "a", to: `p${i}`, kind: "control", label: "bagi" })), ...Array.from({ length: 7 }, (_, i) => ({ from: `p${i}`, to: "z", kind: "control", label: "gabung" }))],
    });
    let e: { code: string; details: DiagramOverCapacityDetails } | undefined;
    try {
      buildDiagramSvg(clone(s) as unknown as StudioDiagramV1, { release: false });
    } catch (x) {
      e = x as never;
    }
    expect(e).toBeDefined();
    expect(e!.code).toBe("FIGURE_OVER_CAPACITY");
    expect(e!.details.checkId).toBe("DATUM-37-rank");
    expect(e!.details.split).toBeUndefined();
    expect(e!.details.suggestion).toContain("kerangka pecahan tidak ditawarkan");
  });
});
