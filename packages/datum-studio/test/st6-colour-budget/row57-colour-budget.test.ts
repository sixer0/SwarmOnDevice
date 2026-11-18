// Swarm 1.3.3 row 57 (ST-6, B-16; decision C23): DATUM-25 counts fill and accent colours only; line patterns and
// value-origin marks are not colours. The manual's six line kinds can be used together, pattern first.
//
//   1. six line kinds + one accented node pass DATUM-25 and DATUM-25L (page and figure apparatus); the same SVG holds 6
//      printed values, which the rule before this row refused (count > 5);
//   2. a value printed only by a value-origin mark is not counted;
//   3. too many fill colours still fail (build budget and the document-level render lint);
//   4. DATUM-25L: limit 6 with or without a mark; 7 styles and two styles that print alike are refused;
//   5. Gambar 16.6 of the manual (five styles, row 36 fixture) passes DATUM-25L;
//   6. estimate height = build height on the fixtures of rows 40 and 54 (key, SUMBER and note rows).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { useStudioEnv } from "../ported/_env";
import { buildDiagramSvg } from "@/lib/studio/engine/diagram/build";
import { estimate, svgColourValues, validateSpec } from "@/lib/studio/engine/diagram/core";
import { colourBudget, svgColourBudget } from "@/lib/studio/engine/diagram/core/colour";
import { LIMITS } from "@/lib/studio/engine/diagram/core/tokens";
import { DIAGRAM_LAYOUTS } from "@/lib/studio/contract/dispatch";
import { lintRendered } from "@/lib/studio/engine/lint/render";
import { FIXTURE_FILE, gambar166Spec, readJson } from "../st1-capacity-table/capacity-harness";

useStudioEnv();

type J = Record<string, any>;
const SIX = ["data", "control", "sync", "accent", "alert", "verify"] as const;

function lines(kinds: readonly string[], extra: J = {}, nodeExtra: J = {}): J {
  const nodes: J[] = [{ id: "n0", label: "Pusat", class: { tier: 0, accent: true }, ...nodeExtra }];
  const edges: J[] = [];
  kinds.forEach((k, i) => {
    nodes.push({ id: `n${i + 1}`, label: `Simpul ${i + 1}`, class: { tier: i < 3 ? 1 : 2 } }); // 6 boxes do not fit one tier
    edges.push({ from: "n0", to: `n${i + 1}`, kind: k, label: `uji ${i + 1}` });
  });
  return {
    $schema: "studio.diagram/v1",
    family: "layered",
    id: "6.1",
    title: "Enam jenis garis manual dalam satu gambar.",
    classification: "BIASA",
    width_mm: 166,
    apparatus: "page",
    labels_verified: true,
    sources: ["Manual Diagram GSP, Gambar 6.1"],
    nodes,
    edges,
    legend: [],
    ...extra,
  };
}
const fails = (s: J): J[] => (validateSpec(structuredClone(s) as never, { release: false }) as unknown as J[]).filter((i) => i.status === "FAIL");
const ran = (s: J): string[] => (validateSpec(structuredClone(s) as never, { release: false }) as unknown as J[]).map((i) => i.checkId);
const build = (s: J) => buildDiagramSvg(structuredClone(s) as never, { release: false });

describe("row 57 ST-6: six line kinds and one accent pass DATUM-25", () => {
  for (const apparatus of ["page", "figure"] as const) {
    test(`${apparatus}: build passes; the SVG prints 6 values (refused by the rule before), 4 are counted`, () => {
      const s = lines(SIX, { apparatus });
      expect(fails(s)).toEqual([]);
      const r = build(s);
      expect(r.report.checksRun).toContain("DATUM-25");
      // Before this row DATUM-25 compared the printed values with the limit: 6 > 5 refused this figure.
      const printed = svgColourValues(r.svg);
      expect(printed.length).toBeGreaterThan(LIMITS.max_colour_values);
      expect(printed).toEqual(["#101418", "#2B3640", "#2F6F6B", "#6B7783", "#9B1C1C", "#B45309"]);
      const b = svgColourBudget(r.svg);
      expect(b.counted).toEqual(["tinta", "#2F6F6B", "#9B1C1C", "#B45309"]);
      expect(b.ink).toEqual(["#101418", "#2B3640", "#6B7783"]);
      expect(b.count).toBeLessThanOrEqual(LIMITS.max_colour_values);
      // the estimate counts the same way
      expect(estimate(structuredClone(s) as never, DIAGRAM_LAYOUTS.layered).checksRun).toContain("DATUM-25");
    });
  }

  test("the document-level render lint passes the same figure", () => {
    const r = build(lines(SIX));
    const out = lintRendered({ svgs: [{ svg: r.svg, widthMm: r.widthMm, heightMm: r.heightMm } as never], metrics: { pageCount: 0, elements: [] } }).filter((i) => i.checkId === "DATUM-25");
    expect(out.map((i) => i.status)).toEqual(["PASS"]);
    expect(out[0].detail).toContain("maks 4 nilai warna");
  });

  test("a value printed only by a value-origin mark is not counted (ASUMSI glyph in the alert colour)", () => {
    const s = lines(["data", "control", "sync", "accent"], { legend: ["ASUMSI"] }, { mark: "ASUMSI" });
    expect(fails(s)).toEqual([]);
    const r = build(s);
    expect(svgColourValues(r.svg)).toContain("#9B1C1C");
    const b = svgColourBudget(r.svg);
    expect(b.marksOnly).toEqual(["#9B1C1C"]);
    expect(b.counted).not.toContain("#9B1C1C");
  });
});

describe("row 57 ST-6: too many fill colours still fail", () => {
  const SIX_FILLS = ["#B45309", "#9B1C1C", "#2F6F6B", "#1D4ED8", "#7C3AED", "#15803D"];
  const svgOf = (fills: readonly string[]) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="128mm" height="40mm" viewBox="0 0 128 40"><rect x="0" y="0" width="128" height="40" fill="#FCFCFB"/>` +
    fills.map((f, i) => `<rect x="${i * 20}" y="5" width="15" height="15" fill="${f}" stroke="#101418" stroke-width="0.45"/>`).join("") +
    `<path d="M0 30 L128 30" stroke="#2B3640" stroke-dasharray="3.2,1.6"/><path d="M0 35 L128 35" stroke="#6B7783" stroke-dasharray="0.2,1.1"/></svg>`;

  test("six fill colours: budget 7 (six fills + the ink), refused by the render lint", () => {
    const b = svgColourBudget(svgOf(SIX_FILLS));
    expect(b.count).toBe(7);
    const out = lintRendered({ svgs: [{ svg: svgOf(SIX_FILLS), widthMm: 128, heightMm: 40 } as never], metrics: { pageCount: 0, elements: [] } }).filter((i) => i.checkId === "DATUM-25");
    expect(out.map((i) => i.status)).toEqual(["FAIL"]);
    expect(out[0].detail).toContain("7 nilai warna > maks 5");
  });

  test("four fill colours and three ink line patterns: 5 counted, passes", () => {
    expect(svgColourBudget(svgOf(SIX_FILLS.slice(0, 4))).count).toBe(5);
  });

  test("six colour values without ink still fail; ink greys alone are one colour", () => {
    expect(colourBudget(SIX_FILLS).count).toBe(6);
    expect(colourBudget(["#101418", "#2B3640", "#6B7783", "#C3CBD1", "#EFF2F4"]).count).toBe(1);
  });
});

describe("row 57 ST-6 / C23: DATUM-25L", () => {
  test("limit is 6 with or without a mark", () => {
    expect([LIMITS.max_line_styles, LIMITS.max_line_styles_with_mark]).toEqual([6, 6]);
  });

  test("six kinds pass, with and without a mark; DATUM-25L is run and listed", () => {
    expect(fails(lines(SIX))).toEqual([]);
    expect(fails(lines(SIX, { legend: ["TERUKUR"] }, { mark: "TERUKUR" }))).toEqual([]);
    expect(ran(lines(SIX))).toContain("DATUM-25L");
  });

  test("seven styles are refused", () => {
    const s = lines([...SIX, "data"]);
    s.edges[6].weight = "thick";
    expect(fails(s).map((i) => i.detail)).toEqual(["DATUM-25L: 7 gaya garis (accent, alert, control, data, data/solid/thick, sync, verify), maksimum 6 (P5)"]);
  });

  test("above the former budget, two styles that print the same pattern, ink and weight are refused", () => {
    const s = lines(["data", "control", "sync", "accent", "alert"]);
    s.edges[0].dash = "dashed";
    expect(fails(s).map((i) => i.detail)).toEqual([
      "DATUM-25L: gaya garis control dan data/dashed/normal tidak terbedakan (pola dashed, warna tinta, tebal normal); beri pola garis lain (P5)",
    ]);
  });

  test("within the former budget (4, 3 with a mark) the verdict is unchanged: the same pair passes", () => {
    const s = lines(["data", "control"]);
    s.edges[0].dash = "dashed";
    expect(fails(s)).toEqual([]);
  });

  test("a spec within 3 styles keeps its check list (DATUM-25L not listed)", () => {
    expect(ran(lines(["data", "control", "sync"]))).not.toContain("DATUM-25L");
  });
});

describe("row 57 C23: Gambar 16.6 of the manual (row 36 fixture), five line styles", () => {
  test("refused before by `DATUM-25L: 5 gaya garis ... maksimum 4`; now passes DATUM-25L", () => {
    const fx = readJson(FIXTURE_FILE);
    const v2 = gambar166Spec(fx, "topology", ["D1"]);
    const s: J = { $schema: "studio.diagram/v1", id: "16.6", title: fx.caption, classification: "BIASA", width_mm: 166, apparatus: "page", labels_verified: true, sources: [fx.sourceLine], ...v2 };
    expect(new Set(s.edges.map((e: J) => e.kind))).toEqual(new Set(["accent", "control", "data", "sync", "verify"]));
    const issues = validateSpec(structuredClone(s) as never, { release: false }) as unknown as J[];
    expect(issues.filter((i) => i.checkId === "DATUM-25L").map((i) => i.status)).toEqual(["PASS"]);
  });
});

describe("row 57 (request of row 40): estimate height = build height", () => {
  const R2 = path.join(import.meta.dir, "..", "st3-key-source-placement", "fixtures");
  const NOTES = [
    "Jalur cadangan hanya aktif saat Core-1 padam.",
    "Angka kapasitas pada gambar ini adalah nilai rancangan dari dokumen sumber dan belum diukur di lapangan; pengukuran ulang dijadwalkan " +
      "setelah serah terima tahap pertama, dan hasilnya menggantikan angka rancangan pada revisi berikutnya tanpa mengubah susunan gambar.",
  ];
  for (const f of ["r2_u1_2_layered_zones.json", "r2_u1_4_topology_zones.json", "r2_u2_6_sequence.json", "r2_u2_5_layered_plain.json"]) {
    for (const apparatus of ["page", "figure"] as const) {
      for (const notes of [[], NOTES]) {
        test(`${f} ${apparatus}, ${notes.length} notes`, () => {
          const raw = JSON.parse(readFileSync(path.join(R2, f), "utf8"));
          const s: J = { $schema: "studio.diagram/v1", id: "2.1", title: raw.caption.text, classification: "TERBATAS", width_mm: 166, sources: [raw.source.text], ...raw.spec, apparatus, notes };
          expect(estimate(structuredClone(s) as never, DIAGRAM_LAYOUTS[s.family as keyof typeof DIAGRAM_LAYOUTS]).heightMm).toBeCloseTo(build(s).heightMm, 6);
        });
      }
    }
  }
});
