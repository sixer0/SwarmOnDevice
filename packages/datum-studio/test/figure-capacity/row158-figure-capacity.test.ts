// Row 158 (decision U24 B): diagram and chart engines refuse over-capacity input with
// FIGURE_OVER_CAPACITY {limit, measured, suggestion} instead of squeezing a messy result.
// At-capacity figures render byte-identical to the pre-row-158 engine (sha recorded before the
// patch at swarm HEAD 503f8651c9, implementation/112_row158_capacity_refusal.md).
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { useStudioEnv } from "../ported/_env";
import type { StudioChartV1, StudioDiagramV1 } from "@/lib/studio/contract";
import { STUDIO_ERROR_CODES } from "@/lib/studio/contract/enums";
import { STUDIO_ERROR_HTTP, StudioEngineError } from "@/lib/studio/contract/errors";
import { renderChart } from "@/lib/studio/engine/chart/core";
import { buildDiagramSvg } from "@/lib/studio/engine/diagram/build";
import { DiagramDefect, estimate } from "@/lib/studio/engine/diagram/core";
import { DIAGRAM_LAYOUTS } from "@/lib/studio/contract/dispatch";
import { FIGURE_OVER_CAPACITY, isFigureOverCapacity } from "@/lib/studio/engine/figure-capacity";
import { AT_CAPACITY, OVER_CAPACITY, type Fixture } from "./fixtures";

useStudioEnv();

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const render = (f: Fixture): string =>
  f.type === "chart" ? renderChart(clone(f.spec) as unknown as StudioChartV1).svg : buildDiagramSvg(clone(f.spec) as unknown as StudioDiagramV1, { release: true }).svg;
const caught = (fn: () => unknown): StudioEngineError => {
  try {
    fn();
  } catch (e) {
    return e as StudioEngineError;
  }
  throw new Error("expected a refusal, the figure rendered");
};
type Details = { checkId: string; figure: string; family: string; quantity: string; unit: string; limit: number | null; measured: number | null; suggestion: string };
const det = (e: StudioEngineError): Details => e.details as Details;

describe("row 158: FIGURE_OVER_CAPACITY is a registered code (like row 69a TEMPLATE_ARCHIVED)", () => {
  it("in STUDIO_ERROR_CODES (last entry) with HTTP 422", () => {
    expect(STUDIO_ERROR_CODES.at(-1)).toBe(FIGURE_OVER_CAPACITY);
    expect(STUDIO_ERROR_HTTP.FIGURE_OVER_CAPACITY).toBe(422);
  });
});

describe("row 158: over-capacity diagrams are refused with limit, measured and suggestion", () => {
  it("graph with 7 columns at 166 mm: measured 7 kolom > limit 5, split suggestion", () => {
    const e = caught(() => render(OVER_CAPACITY.graph7));
    expect(e.code).toBe(FIGURE_OVER_CAPACITY);
    expect(e.httpStatus).toBe(422);
    expect(e).toBeInstanceOf(DiagramDefect);
    expect(det(e)).toMatchObject({ figure: "diagram", family: "graph", quantity: "kolom graph", unit: "kolom", measured: 7, limit: 5 });
    expect(det(e).checkId).toMatch(/^DATUM-37/);
    expect(det(e).suggestion).toMatch(/maks 5 kolom pada 166 mm; bagi menjadi dua gambar/);
    expect(e.message).toContain("batas: kolom graph maks 5 kolom, terukur 7 kolom");
    expect(e.message).toContain("saran: maks 5 kolom pada 166 mm");
  });

  it("layered with 10 tiers: measured height > 247 mm text block", () => {
    const e = caught(() => render(OVER_CAPACITY.layered10));
    expect(e.code).toBe(FIGURE_OVER_CAPACITY);
    expect(det(e)).toMatchObject({ checkId: "DATUM-33", quantity: "tinggi gambar", unit: "mm", limit: 247 });
    expect(det(e).measured!).toBeGreaterThan(247);
    expect(det(e).suggestion).toContain("pecah menjadi 2 diagram (10 simpul, 9 konektor");
    expect(e.message).toMatch(/melewati blok teks 247/);
  });

  it("diagram estimate() refuses the same height with the same code", () => {
    const s = clone(OVER_CAPACITY.layered10.spec) as unknown as StudioDiagramV1;
    const e = caught(() => estimate(s, DIAGRAM_LAYOUTS[s.family]));
    expect(e.code).toBe(FIGURE_OVER_CAPACITY);
    expect(det(e)).toMatchObject({ checkId: "DATUM-33", limit: 247, unit: "mm" });
    expect(det(e).measured!).toBeGreaterThan(247);
  });

  it("swimlane with 6 steps per lane: busiest lane vs the 3 a lane row holds", () => {
    const e = caught(() => render(OVER_CAPACITY.swimlane12));
    expect(e.code).toBe(FIGURE_OVER_CAPACITY);
    expect(det(e)).toMatchObject({ family: "swimlane", quantity: "simpul per baris lajur", unit: "simpul", measured: 6, limit: 3 });
    expect(det(e).suggestion).toMatch(/^kurangi simpul per lajur, bagi lajur, atau pecah menjadi 2 diagram/);
  });

  it("swimlane whose capacity layout is not clean (crossings) is refused, not squeezed (rendered before row 158)", () => {
    const e = caught(() => render(OVER_CAPACITY.swimlaneMessy));
    expect(e.code).toBe(FIGURE_OVER_CAPACITY);
    expect(det(e)).toMatchObject({ family: "swimlane", measured: 4, limit: 3 });
    expect(e.message).toContain("tata letak kapasitas tidak bersih (dicoba: time: 2 (ditolak: tidak bersih)");
  });
});

describe("row 158: over-capacity charts are refused with limit, measured and suggestion", () => {
  it("60 horizontal bars: estimated height 438 mm > 247 mm", () => {
    const e = caught(() => render(OVER_CAPACITY.bars60));
    expect(e.code).toBe(FIGURE_OVER_CAPACITY);
    expect(det(e)).toMatchObject({ figure: "chart", family: "P-01", checkId: "DATUM-33", quantity: "tinggi taksiran", unit: "mm", limit: 247, measured: 438 });
    expect(det(e).suggestion).toContain("(60 kategori)");
    expect(det(e).suggestion).toContain("topN: 8");
    expect(det(e).suggestion).toContain("pisah menjadi dua gambar");
  });

  it("20 long column labels kept vertical: refused instead of ~100 overlapping labels (rendered before row 158)", () => {
    const e = caught(() => render(OVER_CAPACITY.columns20Vertical));
    expect(e.code).toBe(FIGURE_OVER_CAPACITY);
    expect(det(e)).toMatchObject({ figure: "chart", family: "P-02", checkId: "CAPACITY-LABELS", quantity: "kategori sebagai kolom", unit: "kategori", measured: 20 });
    expect(det(e).limit!).toBeGreaterThan(0);
    expect(det(e).limit!).toBeLessThan(20);
    expect(det(e).suggestion).toContain(`kurangi menjadi maks ${det(e).limit} kategori pada 128 mm`);
    expect(det(e).suggestion).toContain("persingkat label (labelShort");
    expect(isFigureOverCapacity(e)).toBe(true);
  });
});

describe("row 158: at-capacity figures render unchanged (sha256 before the patch)", () => {
  const BEFORE: Record<keyof typeof AT_CAPACITY, string> = {
    swimlane6: "6d9b0b5f257a9f7088a77c6479ad279a3bf1003daccbabc6c3927fb9da7255cc",
    graph5: "28b63edf50ac499fa5d9deb995606e10e82cde0236dcb1dd92c51144675364b4",
    bars30: "4c083a8330ada122686d85bce992ef43590e83479b0261f0c01eca1bb956390f",
    columns12: "1060e9b9d8043480cde380c532614a7f5ec3331e64590f5e20217cc19f90a107",
    columns20: "319d26993d5eeb7011530be6bda27249035d55b5155bb3c7741c91e35f63a1f6",
  };
  for (const [name, f] of Object.entries(AT_CAPACITY)) {
    it(`${name}: sha256 unchanged`, () => {
      expect(createHash("sha256").update(render(f)).digest("hex")).toBe(BEFORE[name as keyof typeof AT_CAPACITY]);
    });
  }
});
