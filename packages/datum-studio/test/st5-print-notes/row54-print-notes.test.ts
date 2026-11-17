// Swarm 1.3.3 row 54 (ST-5; gap matrix section 5 #5, section 2.1 "Note line"): `spec.notes[]` was accepted by the
// schema and carried by compose, and printed on 0 of 33 round-1 figures. Each entry now prints as a note row in the
// foot of the figure, label word CATATAN, above KUNCI and SUMBER.
//
// Checks, all on the emitted SVG:
//   1. every `notes[]` entry is in the SVG verbatim (letter case kept), in a row marked `data-st-note`;
//   2. every note row starts below the bounding box of the drawn content;
//   3. the order top to bottom is: engine-made label notes, CATATAN rows, KUNCI, SUMBER;
//   4. a long note wraps to the sheet width and loses no word;
//   5. a figure without `notes[]` (absent, empty, blank entries) has no note row and the same bytes in all three forms;
//   6. the sheet grows by exactly one lattice row per printed note line (the formula row 57 mirrors).
//
// Fixtures: the four round-2 specs of row 40 (read only, test/st3-key-source-placement/fixtures).
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { useStudioEnv } from "../ported/_env";
import { buildDiagramSvg, buildDiagramSvgRaw } from "@/lib/studio/engine/diagram/build";
import { withDiagramFit } from "@/lib/studio/engine/diagram/fit/state";

useStudioEnv();

type J = Record<string, any>;
const R2 = path.join(import.meta.dir, "..", "st3-key-source-placement", "fixtures");
const LATTICE_Y = 4.7625;
const CAP_EM = 0.7;

const SHORT = "Jalur cadangan hanya aktif saat Core-1 padam.";
const MIXED = "VRRP dipakai di lapisan Distribusi; nilai Mb/s = hasil ukur iPerf3 <uji A & B>.";
const LONG =
  "Angka kapasitas pada gambar ini adalah nilai rancangan dari dokumen sumber dan belum diukur di lapangan; pengukuran ulang dijadwalkan " +
  "setelah serah terima tahap pertama, dan hasilnya menggantikan angka rancangan pada revisi berikutnya tanpa mengubah susunan gambar.";
const NOTES = [SHORT, MIXED, LONG];

function r2(name: string, apparatus: "page" | "figure", extra: J = {}, width = 166): J {
  const raw = JSON.parse(readFileSync(path.join(R2, name), "utf8"));
  return { $schema: "studio.diagram/v1", id: "2.1", title: raw.caption.text, classification: "TERBATAS", width_mm: width, sources: [raw.source.text], ...raw.spec, apparatus, ...extra };
}
const raw = (s: J, fit = false): string => {
  const run = () => buildDiagramSvgRaw(structuredClone(s) as any, { release: false, keyLabel: "KUNCI" }).svg;
  return fit ? withDiagramFit({ notes: [] }, run) : run();
};
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unesc = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const attrs = (tag: string): Record<string, string> => Object.fromEntries([...tag.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const squash = (s: string): string => s.replace(/\s+/g, "");

interface Row {
  y: number;
  size: number;
  text: string;
  note?: string;
}
interface Measured {
  noteRows: Row[];
  key: Row[];
  source: Row[];
  /** Largest y of every drawn element that is not a row at x = 0 from the first foot row down. */
  drawnBottom: number;
  drawnEl: string;
  height: number;
}

function measure(svg: string): Measured {
  const body = svg.replace(/<defs>[\s\S]*?<\/defs>/, "");
  const height = Number(/viewBox="0 0 [\d.]+ ([\d.]+)"/.exec(svg)![1]);
  const texts = [...body.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)].map((m) => ({ a: attrs(m[1]), text: unesc(m[2].replace(/<[^>]+>/g, "")), el: m[0] }));
  const row = (t: (typeof texts)[number]): Row => ({ y: Number(t.a.y), size: Number(t.a["font-size"]), text: t.text, note: t.a["data-st-note"] });
  const noteRows = texts.filter((t) => "data-st-note" in t.a).map(row).sort((a, b) => a.y - b.y);
  const heads = texts.filter((t) => t.a.x === "0" && (/^(KUNCI|SUMBER)\b/.test(t.text) || "data-st-note" in t.a));
  const first = Math.min(...heads.map((t) => Number(t.a.y)));
  const isFoot = (t: (typeof texts)[number]) => t.a.x === "0" && Number(t.a.y) >= first - 1e-6;
  const key = texts.filter((t) => isFoot(t) && /^KUNCI\b/.test(t.text)).map(row);
  const source = texts.filter((t) => isFoot(t) && /^SUMBER\b/.test(t.text)).map(row);
  let drawnBottom = -Infinity;
  let drawnEl = "";
  const see = (y: number, el: string) => {
    if (y > drawnBottom) [drawnBottom, drawnEl] = [y, el.slice(0, 140)];
  };
  // Engine-made label notes (numbered, role evidence_rail) are foot rows too: they are not at x = 0 for the number
  // and its text, so they are told apart by sitting at or below the row above the first CATATAN row.
  for (const t of texts) if (!isFoot(t) && !("data-st-caption" in t.a) && !t.el.includes("data-st-caption")) see(Number(t.a.y) - 0, t.el);
  const rects = [...body.matchAll(/<rect\b[^>]*\/>/g)].map((m) => m[0]);
  for (const el of rects.slice(1)) see(Number(attrs(el).y) + Number(attrs(el).height), el);
  for (const m of body.matchAll(/<line\b[^>]*\/>/g)) see(Math.max(Number(attrs(m[0]).y1), Number(attrs(m[0]).y2)), m[0]);
  for (const m of body.matchAll(/<(?:polygon|polyline)\b[^>]*\/>/g)) for (const p of attrs(m[0]).points.trim().split(/\s+/)) see(Number(p.split(",")[1]), m[0]);
  for (const m of body.matchAll(/<(?:circle|ellipse)\b[^>]*\/>/g)) see(Number(attrs(m[0]).cy) + Number(attrs(m[0]).r ?? attrs(m[0]).ry), m[0]);
  for (const m of body.matchAll(/<path\b[^>]*\/>/g)) {
    const nums = (attrs(m[0]).d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    const cmds = attrs(m[0]).d.match(/[A-Za-z]/g) ?? [];
    if (cmds.every((c) => "MLZ".includes(c))) for (let i = 1; i < nums.length; i += 2) see(nums[i], m[0]);
    else see(Math.max(...nums.filter((_, i) => i % 2 === 1)), m[0]);
  }
  return { noteRows, key, source, drawnBottom, drawnEl, height };
}

/** The printed text of note `i` (0-based): its rows joined, the label of its first row removed. */
function printedNote(m: Measured, i: number): { rows: Row[]; text: string } {
  const rows = m.noteRows.filter((r) => r.note === String(i + 1));
  return { rows, text: rows.map((r, k) => (k === 0 ? r.text.replace(/^CATATAN {2}/, "") : r.text)).join(" ") };
}

const FIXTURES = [
  ["layered with two zones (R2 u1 sheet 2)", "r2_u1_2_layered_zones.json"],
  ["topology with two zones (R2 u1 sheet 4)", "r2_u1_4_topology_zones.json"],
  ["sequence (R2 u2 sheet 6)", "r2_u2_6_sequence.json"],
  ["layered plain (R2 u2 sheet 5)", "r2_u2_5_layered_plain.json"],
] as const;

describe("row 54 ST-5: notes[] print as CATATAN rows below the content", () => {
  for (const [label, file] of FIXTURES) {
    for (const apparatus of ["page", "figure"] as const) {
      for (const fit of [false, true]) {
        test(`${label} [${apparatus}${fit ? ", fit" : ""}]`, () => {
          const svg = raw(r2(file, apparatus, { notes: NOTES }), fit);
          const m = measure(svg);
          // 1. verbatim, letter case kept; a note that fits one row is one text element with the label
          expect(svg).toContain(`>CATATAN  ${esc(SHORT)}</text>`);
          expect(svg).toContain(`>CATATAN  ${esc(MIXED)}</text>`);
          NOTES.forEach((note, i) => {
            const p = printedNote(m, i);
            expect(p.rows.length).toBeGreaterThan(0);
            expect(p.rows[0].text.startsWith("CATATAN  ")).toBe(true);
            expect(squash(p.text)).toBe(squash(note));
          });
          // 4. the long note wraps, every row inside the sheet width
          expect(printedNote(m, 2).rows.length).toBeGreaterThan(1);
          // 2. below the content bounding box
          const top = m.noteRows[0].y - CAP_EM * m.noteRows[0].size;
          expect({ noteTop: Number(top.toFixed(2)), drawnBottom: Number(m.drawnBottom.toFixed(2)), el: m.drawnEl, ok: top >= m.drawnBottom - 1e-6 }).toMatchObject({ ok: true });
          // rows one lattice row apart, in the order of notes[]
          m.noteRows.forEach((r, k) => {
            if (k > 0) expect(r.y - m.noteRows[k - 1].y).toBeCloseTo(LATTICE_Y, 1);
            if (k > 0) expect(Number(r.note)).toBeGreaterThanOrEqual(Number(m.noteRows[k - 1].note));
            expect(r.y).toBeLessThanOrEqual(m.height + 1e-6);
          });
          // 3. order: CATATAN, then KUNCI, then SUMBER
          const lastNote = m.noteRows[m.noteRows.length - 1].y;
          expect(m.key.length).toBeGreaterThan(0);
          expect(m.key[0].y - lastNote).toBeCloseTo(LATTICE_Y, 1);
          if (apparatus === "figure") {
            expect(m.source.length).toBe(1);
            expect(m.source[0].y).toBeGreaterThan(m.key[0].y);
          }
        });
      }
    }
  }

  test("a figure whose only foot row is a note (page apparatus, no legend) prints it below the content", () => {
    // `keyRowOnPage`: the page prints the key row, so the sheet itself draws none (D-288)
    const s = r2("r2_u2_5_layered_plain.json", "page", { notes: [SHORT], keyRowOnPage: true });
    const svg = raw(s);
    const m = measure(svg);
    expect(m.key.length).toBe(0);
    expect(m.noteRows.map((r) => r.text)).toEqual([`CATATAN  ${SHORT}`]);
    expect(m.noteRows[0].y - CAP_EM * m.noteRows[0].size).toBeGreaterThanOrEqual(m.drawnBottom - 1e-6);
    expect(m.noteRows[0].y).toBeLessThanOrEqual(m.height + 1e-6);
  });

  test("the built figure (caption above, apparatus figure) carries the notes too", () => {
    const s = r2("r2_u1_2_layered_zones.json", "figure", { notes: NOTES });
    const r = buildDiagramSvg(structuredClone(s) as any, { release: false, keyLabel: "KUNCI" });
    const m = measure(r.svg);
    NOTES.forEach((note, i) => expect(squash(printedNote(m, i).text)).toBe(squash(note)));
    expect(m.noteRows[0].y - CAP_EM * m.noteRows[0].size).toBeGreaterThanOrEqual(m.drawnBottom - 1e-6);
    expect(r.heightMm).toBeCloseTo(m.height, 3);
  });

  test("a note with no space to break at is printed whole, never cut", () => {
    const word = "X".repeat(400);
    const svg = raw(r2("r2_u2_5_layered_plain.json", "figure", { notes: [word] }));
    expect(svg).toContain(`>CATATAN  ${word}</text>`);
  });

  test("the label word can be passed (English document); default CATATAN", () => {
    const s = r2("r2_u2_5_layered_plain.json", "figure", { notes: [SHORT] });
    const svg = buildDiagramSvgRaw(structuredClone(s) as any, { release: false, keyLabel: "KEY", noteLabel: "NOTE" } as any).svg;
    expect(svg).toContain(`>NOTE  ${esc(SHORT)}</text>`);
    expect(svg).not.toContain("CATATAN");
  });
});

describe("row 54: the height formula (for row 57, core/estimate.ts)", () => {
  for (const [label, file] of FIXTURES) {
    for (const apparatus of ["page", "figure"] as const) {
      test(`height = height without notes + note lines x 4.7625 mm: ${label} [${apparatus}]`, () => {
        const base = measure(raw(r2(file, apparatus)));
        const m = measure(raw(r2(file, apparatus, { notes: NOTES })));
        expect(m.height - base.height).toBeCloseTo(m.noteRows.length * LATTICE_Y, 2);
        // the rows that were there keep their distance from the sheet bottom
        expect(m.height - m.key[0].y).toBeCloseTo(base.height - base.key[0].y, 1);
      });
    }
  }

  test("the report names the note lines of a stand-alone figure", () => {
    const s = r2("r2_u2_5_layered_plain.json", "figure", { notes: NOTES });
    const r = buildDiagramSvgRaw(structuredClone(s) as any, { release: false, keyLabel: "KUNCI" });
    const n = measure(r.svg).noteRows.length;
    expect((r.report.furniture as any).noteLines).toBe(n);
    const plain = buildDiagramSvgRaw(structuredClone(r2("r2_u2_5_layered_plain.json", "figure")) as any, { release: false, keyLabel: "KUNCI" });
    expect("noteLines" in (plain.report.furniture as any)).toBe(false);
    expect((r.report.furniture as any).heightMm - (plain.report.furniture as any).heightMm).toBeCloseTo(n * LATTICE_Y, 3);
  });
});

describe("row 54: engine-made label notes keep working and are not mixed up with author notes", () => {
  // Three graph nodes in one row at 128 mm with labels longer than their runs: the fit pass numbers the labels and
  // prints the numbered notes (role evidence_rail) under the drawing.
  const LABEL = "permintaan data mentah dari sensor lapangan yang panjang";
  const crowded = (notes?: string[]): J => ({
    $schema: "studio.diagram/v1",
    id: "3.1",
    title: "Alur uji catatan label.",
    classification: "TERBATAS",
    width_mm: 128,
    family: "graph",
    apparatus: "figure",
    sources: ["Sumber sintetis uji."],
    legend: ["garis penuh = data"],
    nodes: [0, 1, 2].map((i) => ({ id: `n${i}`, label: `Simpul ${i}`, class: { col: i, row: 0 } })),
    edges: [0, 1].map((i) => ({ from: `n${i}`, to: `n${i + 1}`, kind: "data", label: `${LABEL} ${i}` })),
    ...(notes ? { notes } : {}),
  });
  const build = (s: J): string => withDiagramFit({ notes: [], numbered: true }, () => buildDiagramSvgRaw(structuredClone(s) as any, { release: false, keyLabel: "KUNCI" }).svg);
  const numbered = (svg: string): Array<{ y: number; text: string }> =>
    [...svg.matchAll(/<text\b([^>]*)>(\d+)<\/text>/g)].map((m) => ({ y: Number(attrs(m[1]).y), text: m[2] }));

  test("numbered label notes, then CATATAN rows, then KUNCI and SUMBER", () => {
    const before = build(crowded());
    const svg = build(crowded([SHORT, MIXED]));
    const nBefore = numbered(before);
    const nAfter = numbered(svg);
    // this fixture must produce engine-made notes, or the test checks nothing
    expect(nBefore.length).toBe(4); // two marks on the runs + the two numbers of their note rows
    // the note text of each numbered label, in whatever letter case the rail role prints (row 43 / 44)
    for (const i of [0, 1]) expect(svg.toLowerCase()).toContain(`>${LABEL} ${i}</text>`);
    // the engine notes are the same rows at the same place
    expect(nAfter).toEqual(nBefore);
    const m = measure(svg);
    expect(m.noteRows.map((r) => r.text)).toEqual([`CATATAN  ${SHORT}`, `CATATAN  ${MIXED}`]);
    // author rows carry no number and sit below every engine note
    expect(m.noteRows[0].y).toBeGreaterThan(Math.max(...nAfter.map((n) => n.y)));
    expect(m.key[0].y).toBeGreaterThan(m.noteRows[m.noteRows.length - 1].y);
    expect(m.source[0].y).toBeGreaterThan(m.key[0].y);
    // no engine note is marked as an author note
    expect([...svg.matchAll(/<text\b[^>]*data-st-note[^>]*>/g)].length).toBe(2);
    for (const t of svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)) if (t[2].toLowerCase().startsWith(LABEL) || /^\d+$/.test(t[2])) expect(t[1]).not.toContain("data-st-note");
  });
});

describe("row 54: a figure without notes[] is byte-identical to before", () => {
  // In the test: absent, empty and blank `notes` give the same bytes and no note row. The comparison with the tree
  // before the row 54 edit is an A/B run on a frozen copy (implementation/54_st5_print_notes.md section 5); a pinned
  // hash here would break on every later row that moves a figure for its own reason.
  for (const [label, file] of FIXTURES) {
    for (const apparatus of ["page", "figure"] as const) {
      for (const fit of [false, true]) {
        test(`${label} [${apparatus}${fit ? ", fit" : ""}]: absent, empty and blank notes give the same bytes`, () => {
          const absent = raw(r2(file, apparatus), fit);
          expect(absent).not.toContain("CATATAN");
          expect(absent).not.toContain("data-st-note");
          expect(raw(r2(file, apparatus, { notes: [] }), fit)).toBe(absent);
          expect(raw(r2(file, apparatus, { notes: ["", "   "] }), fit)).toBe(absent);
          expect(sha(raw(r2(file, apparatus, { notes: undefined }), fit))).toBe(sha(absent));
        });
      }
    }
  }
});
