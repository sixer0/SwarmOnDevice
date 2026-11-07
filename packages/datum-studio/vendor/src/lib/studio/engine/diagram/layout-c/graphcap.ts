/**
 * Kapasitas graph yang membantu (FIG-02b2, audit research/18 §6 P1-14). Hanya dipakai bila render
 * pertama ditolak DATUM-37 (`diagramFitCapacity`) dan kolom agen bersambung (0..k-1 tanpa celah;
 * kolom bercelah tetap ditolak seperti sebelumnya). Pitch dipadatkan: lebar simpul 3 kisi lalu
 * 2 kisi, celah 1 kisi, label dibungkus (`fit/text`) dan tinggi tumbuh. Tidak muat -> DATUM-37
 * dengan aksi konkret.
 */
import type { DiagramBox, DiagramNode, LayoutResult, StudioDiagramV1 } from "../../../contract";
import { diagramFitAllows, diagramFitNote } from "../fit/state";
import { grownHeight, planNodeText } from "../fit/text";
import { type Lattice, baselineStepMm, classGet, diagramDefect, nodeSize, pyInt, sheetHeight, snap, snapFloor } from "./geometry";

/** Kolom graph terbanyak yang muat pada lebar `W` dengan simpul 2 kisi dan celah 1 kisi. */
export function graphMaxCols(L: Pick<Lattice, "x" | "W">): number {
  return Math.max(1, Math.floor((L.W - L.x * 2) / (L.x * 3) + 1e-9) + 1);
}

/** Kolom agen bersambung (tanpa kolom kosong di antaranya)? */
export function contiguousCols(cols: readonly number[]): boolean {
  return cols.every((c, i) => i === 0 || c === cols[i - 1] + 1);
}

export function layoutGraphCapacity(s: StudioDiagramV1, L: Lattice, padUnits: number, rowGapBaselines: number): LayoutResult {
  const colOf = (n: DiagramNode) => pyInt(classGet(n, "col", 0), `simpul ${n.id}: class.col`);
  const rowOf = (n: DiagramNode) => pyInt(classGet(n, "row", 0), `simpul ${n.id}: class.row`);
  const cols = [...new Set(s.nodes.map(colOf))].sort((a, b) => a - b);
  const k = cols.length;
  let w = 0;
  for (const cand of [L.x * 3, L.x * 2]) {
    if ((k - 1) * (cand + L.x) + cand <= L.W + 1e-6) {
      w = cand;
      break;
    }
  }
  if (!w) {
    throw diagramDefect(
      `DATUM-37: ${k} kolom graph tidak muat di ${L.W.toFixed(1)} mm walau pitch dipadatkan; ` +
        `maks ${graphMaxCols(L)} kolom pada ${L.W.toFixed(0)} mm; bagi menjadi dua gambar atau pakai layered (P8, P1-14)`,
      "DATUM-37",
    );
  }
  const p = w + L.x;
  const total = (k - 1) * p + w;
  const x0 = snapFloor(Math.max(0, (L.W - total) / 2), L.x);
  const hs = new Map<string, number>();
  for (const n of s.nodes) {
    const [, h] = nodeSize(n, L, undefined, padUnits);
    hs.set(n.id, diagramFitAllows("grow") ? grownHeight(h, planNodeText(n, w, h), L.y) : h);
  }
  const hmax = Math.max(...hs.values());
  const rowPitch = hmax + baselineStepMm(rowGapBaselines, L);
  const nodes: Record<string, DiagramBox> = {};
  for (const n of s.nodes) {
    nodes[n.id] = { x: snap(x0 + cols.indexOf(colOf(n)) * p, L.x), y: snap(L.top + rowOf(n) * rowPitch, L.y), w, h: hs.get(n.id)! };
  }
  diagramFitNote(
    "CAPACITY_ADAPT",
    `${k} kolom graph tidak muat dengan pitch bawaan di ${L.W.toFixed(1)} mm; pitch dipadatkan ke ${p.toFixed(2)} mm (simpul ${w.toFixed(2)} mm, label dibungkus)`,
    `maks ${graphMaxCols(L)} kolom pada ${L.W.toFixed(0)} mm; persingkat label (maks ~40 karakter), bagi menjadi dua gambar, atau pakai layered`,
  );
  return { nodes, widthMm: L.W, heightMm: sheetHeight(L, Object.values(nodes)) };
}
