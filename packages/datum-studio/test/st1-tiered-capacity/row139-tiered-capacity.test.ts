// Swarm 1.3.3 row 139 (ST-1, engine defects E3 and E4 of row 36, ruling C23).
// E3: in the tiered families (layered, topology, stack) and sld the fourth node of a tier at 128 mm was placed exactly on
// the right edge (`128.000..128.000 dari 128.0 mm`), the case row 33 fixed for graph only; the refusal advised
// `persingkat label atau pecah menjadi 2 diagram (lebar 128 mm)`, which does not offer `width "full"` although four pass
// at 166 mm, and because the text lacked that offer the split skeleton was computed too.
// E4: the sld text said `maks 3 cabang per tingkat` at every width; four branches render at 166 mm.
// After the fix the layout checks the tier capacity before it places a node, the refusal carries row 34's two-width
// text, the skeleton is only computed when neither width holds the figure, and the sld number is the width's own.
// Synthetic specs shaped like row 36's generator (capacity-harness.ts `tiered`, `sld`).
import { describe, expect, it } from "bun:test";
import { useStudioEnv } from "../ported/_env";
import type { StudioDiagramV1 } from "@/lib/studio/contract";
import { DIAGRAM_LAYOUTS } from "@/lib/studio/contract/dispatch";
import { buildDiagramSvg, placeDiagram } from "@/lib/studio/engine/diagram/build";
import { Sheet } from "@/lib/studio/engine/diagram/core";
import { tierCapacity } from "@/lib/studio/engine/diagram/layout-a/layered";
import { sldBranchCapacity } from "@/lib/studio/engine/diagram/layout-c/sld";

useStudioEnv();

type J = Record<string, any>;
const LX = 128 / 12;
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

const base = (family: string, width: number, nodes: J[], edges: J[], extra: J = {}): StudioDiagramV1 =>
  ({
    $schema: "studio.diagram/v1",
    id: "9.1",
    title: "Uji kapasitas tingkat.",
    classification: "BIASA",
    width_mm: width,
    apparatus: "page",
    labels_verified: true,
    sources: ["Uji"],
    family,
    nodes,
    edges,
    ...extra,
  }) as unknown as StudioDiagramV1;

/** Two tiers of `per` nodes; node i of tier 0 feeds node i of tier 1 (row 36 `tiered(family, 2, per)`). */
const tiered = (family: string, width: number, per: number, extra: J = {}) =>
  base(
    family,
    width,
    range(2).flatMap((t) => range(per).map((i) => ({ id: `t${t}n${i}`, label: `Simpul ${t * per + i + 1}`, class: { tier: t } }))),
    range(per).map((i) => ({ from: `t0n${i}`, to: `t1n${i}`, kind: "data", label: "data" })),
    extra,
  );

/** One bus and `n` branches (row 36 `sld(n)`). */
const sld = (width: number, n: number) =>
  base(
    "sld",
    width,
    [{ id: "bus", label: "Rel bus", shape: "bus", class: { tier: 0 } }, ...range(n).map((b) => ({ id: `b${b}`, label: `Simpul ${b + 1}`, class: { tier: 1 } }))],
    range(n).map((b) => ({ from: "bus", to: `b${b}`, kind: "data", label: "data" })),
  );

const BAND = { tiers: [{ tier: 0, label: "Tier 2" }] }; // a two-column band (row 56 measured "Tier 2" at 2-3 columns)

const caught = (fn: () => unknown): J => {
  try {
    fn();
  } catch (e) {
    return e as J;
  }
  throw new Error("expected a refusal, the figure was placed");
};

const rects = (svg: string) =>
  [...svg.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)" height="[\d.]+"[^>]*data-node=/g)].map((m) => ({ x: Number(m[1]), w: Number(m[2]) }));

const TIERED = [
  ["layered", "simpul per tingkat"],
  ["topology", "simpul per tingkat"],
  ["stack", "simpul per lapis"],
] as const;

describe("row 139: the capacity numbers", () => {
  it("a tier holds 3 nodes at 128 mm and 4 at 166 mm; a two-column label band takes one node", () => {
    expect(tierCapacity(128, LX)).toBe(3);
    expect(tierCapacity(166, LX)).toBe(4);
    expect(tierCapacity(128 - 2 * LX, LX)).toBe(2);
    expect(tierCapacity(166 - 2 * LX, LX)).toBe(3);
  });

  it("an sld rail holds 3 branches at 128 mm and 4 at 166 mm (rail span 128 and 160 mm)", () => {
    expect(sldBranchCapacity(128, LX)).toBe(3);
    expect(sldBranchCapacity(166, LX)).toBe(4);
  });
});

describe("row 139 E3: tiered families, 4 per tier at 128 mm", () => {
  for (const [family, unit] of TIERED) {
    it(`${family}: refused before placement with the two-width advice and no skeleton`, () => {
      const e = caught(() => buildDiagramSvg(tiered(family, 128, 4), { release: true }));
      expect(e.code).toBe("FIGURE_OVER_CAPACITY");
      expect(e.details.checkId).toBe("DATUM-37-sheet");
      expect(e.message).not.toContain("128.000..128.000");
      expect(e.message).not.toContain("keluar lebar lembar");
      expect(e.details.quantity).toBe(unit);
      expect(e.details.limit).toBe(3);
      expect(e.details.measured).toBe(4);
      expect(e.details.suggestion).toContain(`muat 3 ${unit} pada 128 mm, 4 pada 166 mm; pilih width "full" (width_mm 166) atau pecah menjadi 2 diagram`);
      expect(e.details.suggestion).not.toContain("persingkat label");
      expect(e.details.split).toBeUndefined();
      expect(e.message).not.toContain("kerangka pecahan");
    });

    it(`${family}: placeDiagram refuses too (no node is ever placed on the edge)`, () => {
      const e = caught(() => placeDiagram(tiered(family, 128, 4), new Sheet(128), DIAGRAM_LAYOUTS));
      expect(e.details?.checkId ?? e.checkId).toBe("DATUM-37-sheet");
      expect(String(e.message)).toContain("maks 3");
    });

    it(`${family}: the same figure at 166 mm passes, every node inside the sheet with its full width`, () => {
      const r = rects(buildDiagramSvg(tiered(family, 166, 4), { release: true }).svg);
      expect(r.length).toBe(8);
      for (const n of r) {
        expect(n.x).toBeGreaterThanOrEqual(0);
        expect(n.x + n.w).toBeLessThanOrEqual(166 + 1e-6);
        expect(n.w).toBeGreaterThan(3 * LX - 0.5);
      }
    });

    it(`${family}: 5 per tier at 166 mm: full width already in use, the skeleton question is left to row 140`, () => {
      const e = caught(() => buildDiagramSvg(tiered(family, 166, 5), { release: true }));
      expect(e.code).toBe("FIGURE_OVER_CAPACITY");
      expect(e.details.limit).toBe(4);
      expect(e.details.measured).toBe(5);
      expect(e.details.suggestion).toContain(`muat 3 ${unit} pada 128 mm, 4 pada 166 mm; width "full" sudah dipakai: pecah menjadi 2 diagram`);
      expect(e.message).not.toContain("170.667..170.667");
    });
  }

  it("layered 5 per tier at 128 mm: neither width holds it (width full not enough)", () => {
    const e = caught(() => buildDiagramSvg(tiered("layered", 128, 5), { release: true }));
    expect(e.details.suggestion).toContain('muat 3 simpul per tingkat pada 128 mm, 4 pada 166 mm; width "full" tidak cukup: pecah menjadi 2 diagram');
    expect(e.details.suggestion).not.toContain('width "full" (width_mm');
  });
});

describe("row 139 E3 with labelled tiers (row 56 band: one node fewer per tier)", () => {
  it("layered 3 per tier at 128 mm with a band: muat 2 at 128, 3 at 166, width full offered", () => {
    const e = caught(() => buildDiagramSvg(tiered("layered", 128, 3, BAND), { release: true }));
    expect(e.code).toBe("FIGURE_OVER_CAPACITY");
    expect(e.details.limit).toBe(2);
    expect(e.details.measured).toBe(3);
    expect(e.details.suggestion).toContain('muat 2 simpul per tingkat pada 128 mm, 3 pada 166 mm; pilih width "full" (width_mm 166) atau pecah menjadi 2 diagram');
    expect(e.details.split).toBeUndefined();
  });

  it("the offer holds: the same figure at 166 mm renders", () => {
    expect(() => buildDiagramSvg(tiered("layered", 166, 3, BAND), { release: true })).not.toThrow();
  });

  it("layered 4 per tier at 166 mm with a band: limit 3, full width already in use", () => {
    const e = caught(() => buildDiagramSvg(tiered("layered", 166, 4, BAND), { release: true }));
    expect(e.details.limit).toBe(3);
    expect(e.details.suggestion).toContain('muat 2 simpul per tingkat pada 128 mm, 3 pada 166 mm; width "full" sudah dipakai');
  });
});

describe("row 139 E3/E4: sld", () => {
  it("4 branches at 128 mm: refused before placement, two-width advice, no skeleton", () => {
    const e = caught(() => buildDiagramSvg(sld(128, 4), { release: true }));
    expect(e.code).toBe("FIGURE_OVER_CAPACITY");
    expect(e.details.checkId).toBe("DATUM-37-sheet");
    expect(e.message).not.toContain("128.000..128.000");
    expect(e.details.quantity).toBe("cabang per tingkat");
    expect(e.details.limit).toBe(3);
    expect(e.details.measured).toBe(4);
    expect(e.details.suggestion).toContain('maks 3 cabang per tingkat pada 128 mm');
    expect(e.details.suggestion).toContain('muat 3 cabang per tingkat pada 128 mm, 4 pada 166 mm; pilih width "full" (width_mm 166), pecah rel, atau pecah menjadi 2 diagram');
    expect(e.details.split).toBeUndefined();
    expect(e.message).not.toContain("kerangka pecahan");
  });

  it("4 branches at 166 mm render inside the sheet", () => {
    const r = rects(buildDiagramSvg(sld(166, 4), { release: true }).svg).filter((n) => n.w < 100); // the rail spans the sheet
    expect(r.length).toBe(4);
    for (const n of r) expect(n.x + n.w).toBeLessThanOrEqual(166 + 1e-6);
  });

  it("5 branches at 166 mm: the message states the real limit of 166 mm (4), not 3", () => {
    const e = caught(() => buildDiagramSvg(sld(166, 5), { release: true }));
    expect(e.details.limit).toBe(4);
    expect(e.details.measured).toBe(5);
    expect(e.details.suggestion).toContain("maks 4 cabang per tingkat pada 166 mm");
    expect(e.details.suggestion).not.toContain("maks 3 cabang");
    expect(e.details.suggestion).toContain('width "full" sudah dipakai: pecah rel atau pecah menjadi 2 diagram');
  });
});

describe("row 139: figures within capacity keep their placement", () => {
  // x / width of the first tier as measured before the change (probe in implementation/139_st1_tiered_capacity.md)
  const XS: Record<string, string> = {
    "128x3": "10.67+32.0 53.33+32.0 96.0+31.77",
    "166x3": "0.23+53.1 64.0+53.33 128.0+32.0",
    "166x4": "0.23+31.77 42.67+32.0 85.33+32.0 128.0+32.0",
  };
  for (const [family] of TIERED) {
    for (const [k, want] of Object.entries(XS)) {
      it(`${family} ${k}`, () => {
        const [w, n] = k.split("x").map(Number);
        const svg = buildDiagramSvg(tiered(family, w, n), { release: true }).svg;
        const raw = [...svg.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)"[^>]*data-node=/g)].map((m) => `${m[1]}+${m[2]}`);
        expect(raw.slice(0, n).join(" ")).toBe(want);
      });
    }
  }
});
