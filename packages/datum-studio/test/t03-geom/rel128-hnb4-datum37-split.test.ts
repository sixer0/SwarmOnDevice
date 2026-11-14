/**
 * Swarm 1.2.8 row 35b (H-NB4, AC-HNB4, register N8-340 / N8-214 / N8-215): one meaning per DATUM-37 id in engine
 * messages. A flow rank that holds too many nodes is refused `DATUM-37-rank`; a graph node or column block that leaves
 * the sheet width is refused `DATUM-37-sheet`. The closure lint on a rendered element past the sheet edge
 * (`engine/lint/render/index.ts` check37) keeps `DATUM-37`.
 * Fixtures: test/fixtures/syn128/hnb4_flow_rank_overflow.json, hnb4_graph_sheet_overflow.json (row 25b).
 * BASE (e1f9673772): both fixtures are refused with the same checkId `DATUM-37-lebar`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildDiagramSvg } from "@/lib/studio/engine/diagram/build";
import { buildDiagramSvgAuto } from "@/lib/studio/engine/diagram/elk";
import { lintRendered } from "@/lib/studio/engine/lint/render";

type Rec = Record<string, any>;
const fix = (f: string) => JSON.parse(readFileSync(path.join(import.meta.dir, "..", "fixtures", "syn128", f), "utf8")) as Rec;
const FLOW = fix("hnb4_flow_rank_overflow.json");
const GRAPH = fix("hnb4_graph_sheet_overflow.json");

async function refusal(run: () => unknown): Promise<Rec> {
  try {
    await run();
  } catch (e) {
    return e as Rec;
  }
  throw new Error("expected a refusal, the diagram was built");
}

describe("H-NB4 DATUM-37 split (engine refusals)", () => {
  for (const [name, build] of [
    ["buildDiagramSvg", buildDiagramSvg],
    ["buildDiagramSvgAuto", buildDiagramSvgAuto],
  ] as const) {
    test(`${name}: flow rank overflow -> DATUM-37-rank, graph sheet overflow -> DATUM-37-sheet`, async () => {
      const f = await refusal(() => build(FLOW.spec as never, FLOW.buildOptions));
      const g = await refusal(() => build(GRAPH.spec as never, GRAPH.buildOptions));
      expect(f.checkId).not.toBe(g.checkId);
      expect(f.checkId).toBe("DATUM-37-rank");
      expect(String(f.message)).toStartWith("DATUM-37-rank: peringkat 1 memuat 8 simpul");
      expect(g.checkId).toBe("DATUM-37-sheet");
      expect(String(g.message)).toStartWith("DATUM-37-sheet: simpul c3 keluar lebar lembar");
    });
  }
});

describe("H-NB4 closure lint unchanged (CHAR)", () => {
  test("a rendered element past the sheet edge still gives DATUM-37 FAIL", () => {
    const metrics = { pageCount: 1, elements: [{ kind: "page", page: 1, colors: ["#101418"] }, { kind: "overflow", page: 1, overflowMm: 3.2, axis: "right", label: "gambar lebar" }] };
    const out = lintRendered({ svgs: [], metrics } as never);
    const d37 = out.filter((i) => String(i.checkId).startsWith("DATUM-37"));
    expect(d37.map((i) => i.checkId)).toEqual(["DATUM-37"]);
    expect(d37[0].status).toBe("FAIL");
  });
});
