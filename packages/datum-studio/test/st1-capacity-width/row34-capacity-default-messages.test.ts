// Swarm 1.3.3 row 34 (ST-1 items 3-4): the capacity helper defaults to the registry width (128 mm, was 166) and
// capacity messages state the numbers at both widths, computed, and name the choice (`full` or split).
import { describe, expect, it } from "bun:test";
import { useStudioEnv } from "../ported/_env";
import type { StudioDiagramV1 } from "@/lib/studio/contract";
import { FIGURE_WIDTH_DEFAULT, FIGURE_WIDTH_MM } from "@/lib/studio/contract/schema/v2/common.schema";
import { PARAMS_FIGURE } from "@/lib/studio/params/figure";
import { ALLOWED_WIDTHS, DiagramDefect, LATTICE_X } from "@/lib/studio/engine/diagram/core";
import { GRAPH_EDGE_INSET_MM } from "@/lib/studio/engine/diagram/core/sheet";
import { buildDiagramSvg } from "@/lib/studio/engine/diagram/build";
import { buildDiagramSvgAuto } from "@/lib/studio/engine/diagram/elk";
import {
  CAPACITY_DEFAULT_WIDTH_MM,
  CAPACITY_SPLIT_TEXT,
  capacityAction,
  capacityWidthChoice,
  capacityWidthOf,
  overCapacityOf,
} from "@/lib/studio/engine/diagram/build/capacity";
import {
  FIGURE_FULL_WIDTH_MM,
  FIGURE_TEXT_WIDTH_MM,
  FLOW_LR_MAX_PARALLEL,
  flowLrMaxRanks,
  flowRankOverload,
  flowTbMaxPerRank,
} from "@/lib/studio/engine/diagram/layout-a/flow";
import { OVER_CAPACITY } from "../figure-capacity/fixtures";

useStudioEnv();

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const spec = (o: Record<string, unknown>): StudioDiagramV1 => o as unknown as StudioDiagramV1;
const node = (id: string, cls: Record<string, unknown> = {}) => ({ id, label: id, class: cls });
const nodes = (n: number) => Array.from({ length: n }, (_, i) => node(`n${i}`)) as never[];
// Independent of the helper: graph columns at a width (3 lattice pitch, 2 lattice node, T-02 inset on both sides).
const graphCols = (W: number) => Math.floor((W - 2 * GRAPH_EDGE_INSET_MM - LATTICE_X * 2) / (LATTICE_X * 3) + 1e-9) + 1;
const graphSpec = (cols: number, width_mm?: number) =>
  spec({ family: "graph", ...(width_mm ? { width_mm } : {}), nodes: Array.from({ length: cols }, (_, c) => node(`g${c}`, { col: c, row: 0 })), edges: [] });
const sheetDefect = () => new DiagramDefect("DATUM-37-sheet: uji", { checkId: "DATUM-37-sheet" });
const suggestionOf = (s: StudioDiagramV1): string => String((overCapacityOf(sheetDefect(), s)!.details as { suggestion: string }).suggestion);

describe("row 34: the capacity helper defaults to the registry width", () => {
  it("default is 128 mm, read from the tokens and equal to the registry and contract values", () => {
    const registry = PARAMS_FIGURE.find((p) => p.key === "diagram.widthMm")!.default;
    expect(CAPACITY_DEFAULT_WIDTH_MM).toBe(128);
    expect(CAPACITY_DEFAULT_WIDTH_MM).toBe(registry as number);
    expect(CAPACITY_DEFAULT_WIDTH_MM).toBe(FIGURE_WIDTH_MM[FIGURE_WIDTH_DEFAULT]);
    expect(CAPACITY_DEFAULT_WIDTH_MM).toBe(ALLOWED_WIDTHS[0]);
    expect(FIGURE_TEXT_WIDTH_MM).toBe(FIGURE_WIDTH_MM.text);
    expect(FIGURE_FULL_WIDTH_MM).toBe(FIGURE_WIDTH_MM.full);
  });

  it("a spec without width_mm is measured at 128 mm; a spec with a width keeps it", () => {
    expect(capacityWidthOf(spec({ family: "graph" }))).toBe(128);
    expect(capacityWidthOf(spec({ family: "graph", width_mm: 166 }))).toBe(166);
    const a = capacityAction(graphSpec(7), "DATUM-37-sheet")!;
    expect(a).toContain(`maks ${graphCols(128)} kolom pada 128 mm`);
    expect(a).not.toContain("kolom pada 166 mm;");
    const o = overCapacityOf(sheetDefect(), graphSpec(7))!;
    expect(o.details).toMatchObject({ quantity: "kolom graph", measured: 7, limit: graphCols(128) });
  });
});

describe("row 34: capacityWidthChoice states both widths and names the choice", () => {
  const at = (w: number) => (w === 128 ? 4 : w === 166 ? 5 : -1);
  it("below the full width, full holds the figure: full or split", () => {
    expect(capacityWidthChoice({ unit: "per tingkat", at, width: 128, need: 5 })).toBe(
      'muat 4 per tingkat pada 128 mm, 5 pada 166 mm; pilih width "full" (width_mm 166) atau pecah menjadi 2 diagram',
    );
  });
  it("other remedies sit between the width and the split", () => {
    expect(capacityWidthChoice({ unit: "kolom", at, width: 128, others: ["pakai layered"] })).toBe(
      'muat 4 kolom pada 128 mm, 5 pada 166 mm; pilih width "full" (width_mm 166), pakai layered, atau pecah menjadi 2 diagram',
    );
  });
  it("at the full width full is not offered", () => {
    expect(capacityWidthChoice({ unit: "kolom", at, width: 166, need: 7 })).toBe('muat 4 kolom pada 128 mm, 5 pada 166 mm; width "full" sudah dipakai: pecah menjadi 2 diagram');
  });
  it("when the full width does not hold the figure full is not offered", () => {
    expect(capacityWidthChoice({ unit: "kolom", at, width: 128, need: 7 })).toBe('muat 4 kolom pada 128 mm, 5 pada 166 mm; width "full" tidak cukup: pecah menjadi 2 diagram');
  });
  it("every form ends with the split text (row 51 seam)", () => {
    for (const width of [128, 166]) for (const need of [5, 7]) expect(capacityWidthChoice({ unit: "kolom", at, width, need }).endsWith(CAPACITY_SPLIT_TEXT)).toBe(true);
  });
});

describe("row 34: graph messages at both widths", () => {
  const n128 = graphCols(128);
  const n166 = graphCols(166);
  it("the numbers differ per width (the test would not see a constant)", () => {
    expect(n128).toBeLessThan(n166);
  });
  it("128 mm, one column too many: full is offered", () => {
    const a = capacityAction(graphSpec(n128 + 1, 128), "DATUM-37-sheet")!;
    expect(a).toBe(
      `maks ${n128} kolom pada 128 mm; bagi menjadi dua gambar atau pakai layered; muat ${n128} kolom pada 128 mm, ${n166} pada 166 mm; pilih width "full" (width_mm 166) atau pecah menjadi 2 diagram`,
    );
  });
  it("128 mm, more columns than 166 mm holds: full is not offered", () => {
    expect(capacityAction(graphSpec(n166 + 1, 128), "DATUM-37-sheet")).toContain(`muat ${n128} kolom pada 128 mm, ${n166} pada 166 mm; width "full" tidak cukup: pecah menjadi 2 diagram`);
  });
  it("166 mm: full is in use", () => {
    const a = capacityAction(graphSpec(n166 + 2, 166), "DATUM-37-sheet")!;
    expect(a).toBe(
      `maks ${n166} kolom pada 166 mm; bagi menjadi dua gambar atau pakai layered; muat ${n128} kolom pada 128 mm, ${n166} pada 166 mm; width "full" sudah dipakai: pecah menjadi 2 diagram`,
    );
  });
  it("a real refusal (row 158 fixture, 7 columns at 166 mm) carries the text in suggestion and message", () => {
    let e: { message: string; details: { suggestion: string } } | undefined;
    try {
      buildDiagramSvg(clone(OVER_CAPACITY.graph7.spec) as unknown as StudioDiagramV1, { release: true });
    } catch (x) {
      e = x as never;
    }
    expect(e).toBeDefined();
    expect(e!.details.suggestion).toContain(`muat ${n128} kolom pada 128 mm, ${n166} pada 166 mm; width "full" sudah dipakai: pecah menjadi 2 diagram`);
    expect(e!.message).toContain(`muat ${n128} kolom pada 128 mm, ${n166} pada 166 mm`);
  });
});

describe("row 34: ranked flow messages at both widths", () => {
  const tb128 = flowTbMaxPerRank(128, LATTICE_X);
  const tb166 = flowTbMaxPerRank(166, LATTICE_X);
  const lr128 = flowLrMaxRanks(128, LATTICE_X);
  const lr166 = flowLrMaxRanks(166, LATTICE_X);
  const ranks = (...sizes: number[]) => sizes.map((n) => nodes(n));
  it("the numbers differ per width", () => {
    expect(tb128).toBeLessThan(tb166);
    expect(lr128).toBeLessThan(lr166);
  });
  it("TB at 128 mm, a rank that 166 mm holds: full, LR or split", () => {
    const o = flowRankOverload("TB", ranks(1, tb166), 128, LATTICE_X)!;
    expect(o.limit).toBe(tb128);
    expect(o.suggestion).toBe(
      `muat ${tb128} simpul per peringkat pada 128 mm, ${tb166} pada 166 mm; pilih width "full" (width_mm 166), direction "LR" (maks ${FLOW_LR_MAX_PARALLEL} per peringkat), atau pecah menjadi 2 diagram`,
    );
  });
  it("TB at 128 mm, a rank 166 mm does not hold: full is not offered", () => {
    const o = flowRankOverload("TB", ranks(1, tb166 + 1), 128, LATTICE_X)!;
    expect(o.suggestion).toBe(
      `muat ${tb128} simpul per peringkat pada 128 mm, ${tb166} pada 166 mm; width "full" tidak cukup: direction "LR" (maks ${FLOW_LR_MAX_PARALLEL} per peringkat) atau pecah menjadi 2 diagram`,
    );
    expect(o.suggestion).not.toContain("width_mm");
  });
  it("TB at 166 mm: full is in use, the limit is the 166 mm number", () => {
    const o = flowRankOverload("TB", ranks(tb166 + 1), 166, LATTICE_X)!;
    expect(o.limit).toBe(tb166);
    expect(o.message).toContain(`maks ${tb166} pada 166 mm`);
    expect(o.suggestion).toBe(
      `muat ${tb128} simpul per peringkat pada 128 mm, ${tb166} pada 166 mm; width "full" sudah dipakai: direction "LR" (maks ${FLOW_LR_MAX_PARALLEL} per peringkat) atau pecah menjadi 2 diagram`,
    );
  });
  it("LR ranks at 128 mm and 166 mm", () => {
    const a = flowRankOverload("LR", ranks(...Array<number>(lr166).fill(1)), 128, LATTICE_X)!;
    expect(a.suggestion).toBe(`muat ${lr128} peringkat pada 128 mm, ${lr166} pada 166 mm; pilih width "full" (width_mm 166), direction "TB", atau pecah menjadi 2 diagram`);
    const b = flowRankOverload("LR", ranks(...Array<number>(lr166 + 1).fill(1)), 166, LATTICE_X)!;
    expect(b.suggestion).toBe(`muat ${lr128} peringkat pada 128 mm, ${lr166} pada 166 mm; width "full" sudah dipakai: direction "TB" atau pecah menjadi 2 diagram`);
  });
  it("a fit returns null at either width", () => {
    expect(flowRankOverload("TB", ranks(tb128), 128, LATTICE_X)).toBeNull();
    expect(flowRankOverload("TB", ranks(tb166), 166, LATTICE_X)).toBeNull();
  });
});

describe("row 34: swimlane messages at both widths", () => {
  const lane = (n: number, width_mm: number, extra: Record<string, unknown> = {}) =>
    spec({ family: "swimlane", width_mm, nodes: Array.from({ length: n }, (_, i) => node(`s${i}`, { lane: "A" })), edges: [], ...extra });
  // layout-b/swimcap.ts: gutter 3 lattice + 1 edge, node 3 lattice + 1 gap.
  const perRow = (W: number) => Math.max(1, Math.floor((W - LATTICE_X * 4 + LATTICE_X) / (LATTICE_X * 4) + 1e-9));
  it("128 mm: nodes per lane row at both widths, full offered when it holds the lane", () => {
    expect(perRow(128)).toBeLessThan(perRow(166));
    const t = suggestionOf(lane(perRow(166), 128));
    expect(t).toContain(`maks ${perRow(128)} per baris lajur pada 128 mm`);
    expect(t.endsWith(`muat ${perRow(128)} simpul per baris lajur pada 128 mm, ${perRow(166)} pada 166 mm; pilih width "full" (width_mm 166) atau pecah menjadi 2 diagram`)).toBe(true);
  });
  it("166 mm: full is in use", () => {
    const t = suggestionOf(lane(perRow(166) + 3, 166));
    expect(t).toContain(`maks ${perRow(166)} per baris lajur pada 166 mm`);
    expect(t.endsWith(`muat ${perRow(128)} simpul per baris lajur pada 128 mm, ${perRow(166)} pada 166 mm; width "full" sudah dipakai: pecah menjadi 2 diagram`)).toBe(true);
  });
  it("vertical pools: 'pakai 166 mm' is offered only below the full width; both widths are stated", () => {
    const pools = (n: number, width_mm: number) =>
      spec({
        family: "swimlane",
        width_mm,
        lane_orientation: "vertical",
        pools: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, label: `P${i}` })),
        nodes: Array.from({ length: n }, (_, i) => node(`v${i}`, { pool: `p${i}`, lane: "L" })),
        edges: [],
      });
    const at128 = suggestionOf(pools(12, 128));
    const at166 = suggestionOf(pools(12, 166));
    const m128 = /muat (\d+) kolom lajur pada 128 mm, (\d+) pada 166 mm/.exec(at128)!;
    const m166 = /muat (\d+) kolom lajur pada 128 mm, (\d+) pada 166 mm/.exec(at166)!;
    expect(m128).not.toBeNull();
    expect(m166).not.toBeNull();
    expect(Number(m128[1])).toBeLessThan(Number(m128[2]));
    expect([m166[1], m166[2]]).toEqual([m128[1], m128[2]]); // the same two numbers whichever width is in use
    expect(at128).toContain(`maks ${m128[1]} kolom pada 128 mm`);
    expect(at166).toContain(`maks ${m166[2]} kolom pada 166 mm`);
    expect(at166).not.toContain("pakai 166 mm");
    expect(at166).toContain('width "full" sudah dipakai');
    expect(at128).toContain('width "full" tidak cukup'); // 12 columns exceed what 166 mm holds
    expect(at128).not.toContain("pakai 166 mm");
  });
});

describe("row 34: the stated numbers agree with real renders (vertical pools, one lane column each)", () => {
  const pools = (n: number, width_mm: number) => {
    const ids = Array.from({ length: n }, (_, i) => `p${i + 1}`);
    return {
      $schema: "studio.diagram/v1",
      id: "1.1",
      title: "Alur sintetis uji.",
      classification: "TERBATAS",
      sources: ["Sumber sintetis uji."],
      apparatus: "page",
      width_mm,
      family: "swimlane",
      labels_verified: true,
      lane_orientation: "vertical",
      pools: ids.map((id, i) => ({ id, label: `Kolam ${i + 1}` })),
      nodes: ids.map((id, i) => ({ id: `n${i}`, label: `Langkah ${i + 1}`, class: { lane: "Lajur", pool: id } })),
      edges: ids.slice(1).map((_, i) => ({ from: `n${i}`, to: `n${i + 1}`, kind: "control", label: "kirim" })),
    };
  };
  const run = async (n: number, w: number): Promise<string | null> => {
    try {
      await (buildDiagramSvgAuto as unknown as (s: unknown, o: unknown) => Promise<unknown>)(pools(n, w), { release: false });
      return null;
    } catch (e) {
      return String((e as { details?: { suggestion?: string } }).details?.suggestion);
    }
  };
  it("3 columns: refused at 128 mm with full offered, and 166 mm renders them", async () => {
    expect(await run(3, 128)).toEndWith('muat 2 kolom lajur pada 128 mm, 3 pada 166 mm; pilih width "full" (width_mm 166) atau pecah menjadi 2 diagram');
    expect(await run(3, 166)).toBeNull();
  });
  it("4 columns: full is not offered at 128 mm, and 166 mm refuses them", async () => {
    expect(await run(4, 128)).toEndWith('muat 2 kolom lajur pada 128 mm, 3 pada 166 mm; width "full" tidak cukup: pecah menjadi 2 diagram');
    expect(await run(4, 166)).toEndWith('muat 2 kolom lajur pada 128 mm, 3 pada 166 mm; width "full" sudah dipakai: pecah menjadi 2 diagram');
  });
});
