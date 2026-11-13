/**
 * Swarm 1.2.7 row 35b (N-7, AC-N7, register N7-101 / N7-067 / N7-139): the AUTO_FIT remainder counts the T-03
 * connector-end defects. `score` excludes the T-03 kinds (fit/lint.ts), so the auto-fit choice is unchanged; the
 * text now says `sisa {score + t03}` and, when T-03 defects remain, `(termasuk {t03} isu GEOM T-03)`, with suggest
 * `lihat isu GEOM_* berikut`.
 * Fixture: test/fixtures/syn127/n7_autofit_t03_rest.json (row 20, constructed; first score 1, best auto-fit keeps one
 * GEOM_STUB_SEGMENT).
 * BASE (04067a9d02): `-> sisa 0` with suggest `tidak ada` while a GEOM_STUB_SEGMENT line follows; `autoFitRestText`
 * is not exported.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as autofit from "@/lib/studio/engine/diagram/build/autofit";
import { buildDiagramSvg } from "@/lib/studio/engine/diagram/build";
import { buildDiagramSvgAuto } from "@/lib/studio/engine/diagram/elk";

type Rec = Record<string, any>;
const FIX = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "fixtures", "syn127", "n7_autofit_t03_rest.json"), "utf8")) as Rec;
const SRC = (f: string) => readFileSync(path.join(import.meta.dir, "..", "..", "vendor", "src", "lib", "studio", "engine", "diagram", "build", f), "utf8");

const geomOf = (r: Rec): Rec[] => (r.report?.geometry ?? []) as Rec[];
const g = (score: number, kinds: string[]) => ({
  widthMm: 100,
  heightMm: 80,
  counts: {} as never,
  defects: kinds.map((kind, i) => ({ kind, text: `konektor ${i}` })) as never,
  score,
});

describe("N-7 AUTO_FIT remainder (engine, fixture n7_autofit_t03_rest)", () => {
  for (const [name, build] of [
    ["buildDiagramSvg", async () => buildDiagramSvg(FIX.spec, FIX.buildOptions)],
    ["buildDiagramSvgAuto", async () => buildDiagramSvgAuto(FIX.spec, FIX.buildOptions)],
  ] as const) {
    test(`${name}: AUTO_FIT says sisa 1 (termasuk 1 isu GEOM T-03) and points at the GEOM_* lines`, async () => {
      const geo = geomOf((await build()) as Rec);
      const auto = geo.find((i) => i.checkId === "AUTO_FIT");
      expect(auto).toBeDefined();
      expect(String(auto!.detail)).toMatch(/sisa 1 \(termasuk 1 isu GEOM T-03\)/);
      expect(String(auto!.detail)).not.toMatch(/-> sisa 0\b/);
      expect(auto!.suggest).toBe("lihat isu GEOM_* berikut");
      expect(geo.filter((i) => i.checkId === "GEOM_STUB_SEGMENT").length).toBe(1);
    });
  }
});

describe("N-7 autoFitRestText (unit, N7-139)", () => {
  test("one stub defect outside the score: sisa 1 (termasuk 1 isu GEOM T-03)", () => {
    const fn = (autofit as Rec).autoFitRestText;
    expect(typeof fn).toBe("function");
    expect(fn(g(0, ["stubSegment"]))).toEqual({ rest: "sisa 1 (termasuk 1 isu GEOM T-03)", suggest: "lihat isu GEOM_* berikut" });
    expect(fn(g(2, ["labelOverlap", "nodeOverlap", "arrowTangent", "edgeEntryCollision"]))).toEqual({
      rest: "sisa 4 (termasuk 2 isu GEOM T-03)",
      suggest: "lihat isu GEOM_* berikut",
    });
  });

  test("CHAR: no T-03 defect left -> the BASE text sisa {score} exactly", () => {
    const fn = (autofit as Rec).autoFitRestText;
    expect(fn(g(0, []))).toEqual({ rest: "sisa 0", suggest: "tidak ada" });
    expect(fn(g(1, ["labelOverlap"]))).toEqual({ rest: "sisa 1", suggest: "lihat isu GEOM_* berikut" });
  });

  test("both AUTO_FIT sites (autofit.ts, capacity.ts) build their remainder with autoFitRestText", () => {
    expect(SRC("autofit.ts")).toMatch(/-> \$\{autoFitRestText\([^)]*\)\.rest\}/);
    expect(SRC("capacity.ts")).toMatch(/import \{[^}]*\bautoFitRestText\b[^}]*\} from "\.\/autofit"/);
    expect(SRC("capacity.ts")).toMatch(/autoFitRestText\(best\.g\)/);
    expect(SRC("capacity.ts")).not.toMatch(/-> sisa \$\{best\.g\.score\}/);
    expect(SRC("autofit.ts")).not.toMatch(/-> sisa \$\{g\.score\}/);
  });
});
