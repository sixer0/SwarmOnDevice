/**
 * Port `layout_graph` (`HS/datum_diagram.py:799-854`) dan `_graph_column_pos`
 * (:630-796, BUG-DIAG-ROWPACK): simpul ditempatkan lewat `col` dan `row` pada
 * kisi. Pitch 4 kisi selama muat; bila tidak, dirapatkan lalu dipusatkan;
 * tumpuan se-baris diurai dengan relaksasi kolom ke kanan dan rapat-lebar
 * bertingkat; keadaan yang sungguh tak muat ditolak bernama (DATUM-37).
 *
 * Catatan paritas: `ests` (lebar perkiraan) DIMUTASI oleh penyelesai dan
 * mutasinya terbawa lintas anak tangga serta ke lebar akhir simpul, persis
 * seperti dict `ests` Python yang dibagi `layout_graph` dan `_graph_column_pos`.
 */
import type { DiagramBox, DiagramNode, DiagramSheet, LayoutResult, StudioDiagramV1 } from "../../../contract";
import {
  type Lattice,
  classGet,
  diagramDefect,
  graphMinWidth,
  baselineStepMm,
  latticeOf,
  nodeSize,
  pyInt,
  pyStrCmp,
  sheetHeight,
  snap,
  snapCeil,
  snapFloor,
} from "./geometry";
import { diagramFitCapacity } from "../fit/state";
import { contiguousCols, layoutGraphCapacity } from "./graphcap";

/** Padanan `sheet.rowpack` Python (hanya diisi bila ada tumpuan basal). */
export interface GraphRowpack {
  baselineHits: number;
  rounds: number;
  strategy: string;
  pitchMm: number;
}

export interface GraphDetail {
  result: LayoutResult;
  adaptive: boolean;
  rowpack?: GraphRowpack;
}

/** `[w, h]` per id, urutan sisip = urutan simpul spek (dict Python). */
type Ests = Map<string, [number, number]>;
type ColPos = Map<number, number>;

const colOfNode = (n: DiagramNode) => pyInt(classGet(n, "col", 0), `simpul ${n.id}: class.col`);
const rowOfNode = (n: DiagramNode) => pyInt(classGet(n, "row", 0), `simpul ${n.id}: class.row`);

function wOf(ests: Ests, id: string): number {
  return (ests.get(id) as [number, number])[0];
}

/** Python `round(x, 2)` untuk angka diagnostik `pitch_mm` (bukan geometri). */
function round2(x: number): number {
  return Number.parseFloat(x.toFixed(2));
}

/** Port `_graph_column_pos(spec, sheet, cols, ests)` (:630-796). */
function graphColumnPos(
  s: StudioDiagramV1,
  L: Lattice,
  cols: readonly number[],
  ests: Ests,
): { pos: ColPos; rowpack?: GraphRowpack } {
  const LX = L.x;
  const W = L.W;
  const gap = LX;
  const lastCol = cols[cols.length - 1];
  let lastW = -Infinity;
  for (const n of s.nodes) {
    if (colOfNode(n) === lastCol) lastW = Math.max(lastW, wOf(ests, n.id));
  }
  const pDefault = LX * 4;
  const pCap = (W - lastW) / (cols.length - 1);
  const p = pDefault <= pCap + 1e-9 ? pDefault : snapFloor(pCap, LX);
  if (p < LX * 3 - 1e-9) {
    throw diagramDefect(
      `DATUM-37: ${cols.length} kolom graph tidak muat di ${W.toFixed(1)} mm ` +
        `(pitch tersedia ${pCap.toFixed(2)} mm di bawah lebar minimum simpul ${(LX * 3).toFixed(2)} mm)` +
        " — rapatkan col/row atau persempit label (P8, layout_graph)",
      "DATUM-37",
    );
  }
  const total = (cols.length - 1) * p + lastW;
  const x0 = snapFloor(Math.max(0.0, (W - total) / 2.0), LX);
  const pos: ColPos = new Map(cols.map((c, i) => [c, x0 + i * p]));

  // Indeks deterministik: kolom tiap simpul + urutan simpul per baris.
  const colOf = new Map<string, number>();
  const rows = new Map<number, string[]>();
  for (const n of s.nodes) {
    const c = colOfNode(n);
    const r = rowOfNode(n);
    colOf.set(n.id, c);
    let ids = rows.get(r);
    if (!ids) {
      ids = [];
      rows.set(r, ids);
    }
    ids.push(n.id);
  }
  for (const ids of rows.values()) {
    ids.sort((a, b) => {
      const ca = colOf.get(a) as number;
      const cb = colOf.get(b) as number;
      return ca !== cb ? ca - cb : pyStrCmp(a, b);
    });
  }
  const col = (id: string) => colOf.get(id) as number;
  const at = (x: ColPos, c: number) => x.get(c) as number;
  const sortedRowKeys = [...rows.keys()].sort((a, b) => a - b);

  const collide = (x: ColPos): number => {
    let hits = 0;
    for (const r of sortedRowKeys) {
      const ids = rows.get(r) as string[];
      for (let i = 0; i + 1 < ids.length; i++) {
        const a = ids[i];
        const b = ids[i + 1];
        const ov = at(x, col(a)) + wOf(ests, a) - at(x, col(b));
        if (ov > 1e-6) hits += 1;
      }
    }
    return hits;
  };

  const hits = collide(pos);
  if (hits === 0) return { pos }; // bersih: geometri lama utuh

  const mins = new Map<string, number>(s.nodes.map((n) => [n.id, graphMinWidth(n, L)]));
  // Python juga mengumpulkan himpunan `involved`; tidak dibaca di mana pun, jadi tidak diport.

  const leftBase: ColPos = new Map(cols.map((c) => [c, snap(Math.max(0.0, at(pos, c) - x0), LX)]));

  /** Dorong kolom ke kanan sampai tiap pasangan se-baris ber-celah >= g. */
  const relax = (basePos: ColPos, g: number): ColPos => {
    const x: ColPos = new Map(basePos);
    const iters = cols.length * Math.max(1, rows.size) + 4;
    for (let it = 0; it < iters; it++) {
      let moved = false;
      for (const c of cols.slice(1)) {
        let need: number | undefined;
        for (const r of rows.values()) {
          for (let i = 0; i + 1 < r.length; i++) {
            const a = r[i];
            const b = r[i + 1];
            if (col(b) !== c) continue;
            const req = at(x, col(a)) + wOf(ests, a) + g;
            need = need === undefined ? req : Math.max(need, req);
          }
        }
        if (need !== undefined && need > at(x, c) + 1e-6) {
          x.set(c, snapCeil(need, LX));
          moved = true;
        }
      }
      if (!moved) break;
    }
    return x;
  };

  const overflow = (x: ColPos): boolean => {
    for (const [nid, e] of ests) {
      if (at(x, col(nid)) + e[0] > W + 1e-6) return true;
    }
    return false;
  };

  /** Lebar satu kisi lebih sempit, tidak pernah di bawah kebutuhan teks mentah. */
  const shrinkTarget = (nid: string): number => {
    const floorW = snapCeil(mins.get(nid) as number, LX);
    return Math.max(floorW, snapFloor(wOf(ests, nid) - LX, LX));
  };

  const solve = (basisPos: ColPos, g: number): { x: ColPos | null; r: number } => {
    let x = relax(basisPos, g);
    let r = 0;
    for (const strict of [false, true]) {
      while (overflow(x)) {
        const room = (nid: string): boolean => {
          const tgt = shrinkTarget(nid);
          if (tgt >= wOf(ests, nid) - 1e-9) return false;
          return strict || wOf(ests, nid) > snapCeil(mins.get(nid) as number, LX) + 1e-9;
        };
        const cand = [...ests.keys()].filter(room);
        cand.sort((a, b) => {
          const wa = -wOf(ests, a);
          const wb = -wOf(ests, b);
          return wa !== wb ? (wa < wb ? -1 : 1) : pyStrCmp(a, b);
        });
        if (cand.length === 0 || r > 600) break;
        const victim = cand[0];
        const prev = ests.get(victim) as [number, number];
        ests.set(victim, [shrinkTarget(victim), prev[1]]);
        r += 1;
        x = relax(basisPos, g);
      }
      if (!overflow(x)) return { x, r };
    }
    return { x: null, r };
  };

  const ladder: ReadonlyArray<readonly [ColPos, number, string]> = [
    [pos, LX, "center+gap1"],
    [pos, 0.0, "center+gap0"],
    [leftBase, LX, "left+gap1"],
    [leftBase, 0.0, "left+gap0"],
  ];
  let x: ColPos | null = null;
  let strategy = "";
  let rounds = 0;
  for (const [basis, g, tag] of ladder) {
    const trial = solve(basis, g);
    rounds += trial.r;
    if (trial.x !== null) {
      x = trial.x;
      strategy = tag;
      break;
    }
  }

  if (x === null) {
    let worst = 0.0;
    let any = false;
    for (const ids of rows.values()) {
      if (ids.length <= 1) continue;
      let sum = 0;
      for (const a of ids) sum += wOf(ests, a); // Python sum(): kiri ke kanan mulai 0
      const v = sum + gap * (ids.length - 1);
      worst = any ? Math.max(worst, v) : v;
      any = true;
    }
    throw diagramDefect(
      `DATUM-37/ROWPACK: ${cols.length} kolom graph berbagi baris tidak muat di ` +
        `${W.toFixed(1)} mm setelah dorong-kolom dan rapat-lebar (baris terlapar butuh ` +
        `${worst.toFixed(2)} mm) — beri row berbeda atau persempit label/sub (P8, layout_graph)`,
      "DATUM-37",
    );
  }

  // Pusatkan blok (geser seragam: celah relatif tetap, tepi kanan tetap aman).
  let used = -Infinity;
  for (const c of cols) {
    let colMax = -Infinity;
    let has = false;
    for (const n of s.nodes) {
      if (colOfNode(n) !== c) continue;
      const w = wOf(ests, n.id);
      colMax = has ? Math.max(colMax, w) : w;
      has = true;
    }
    used = Math.max(used, at(x, c) + (has ? colMax : 0.0));
  }
  const shift = snapFloor(Math.max(0.0, (W - used) / 2.0), LX);
  if (shift > 1e-9) {
    const base = x;
    const trial: ColPos = new Map(cols.map((c) => [c, snap(at(base, c) + shift, LX)]));
    if (!overflow(trial) && collide(trial) === 0) x = trial;
  }
  const rowpack: GraphRowpack = {
    baselineHits: hits,
    rounds,
    strategy,
    pitchMm: cols.length > 1 ? round2(at(x, cols[1]) - at(x, cols[0])) : 0.0,
  };
  return { pos: x, rowpack };
}

/**
 * FIX-B2 (D-277, D-242 "ubah mesin ke ukuran BM"): aturan vertikal keluarga
 * graph, diukur pada satu-satunya acuan graph BM Manual 000 (Gambar 3.1,
 * `assets/image5__g31.png`, digambar `datum_diagram.py keluarga graph`;
 * 1961 px = 166 mm, 1 baseline = 56,3 px):
 *  - simpul label + sub = 168-169 px = 3 baseline -> rem 1 unit (baris teks + 1),
 *    bukan 2 unit K-1 (yang memberi 4 baseline = 19,05 mm);
 *  - koridor antarbaris (tepi bawah baris 0 ke tepi atas baris 1) = 169 px
 *    = 3 baseline (tempat label konektor vertikal), bukan 2.
 * Berlaku untuk SEMUA spec graph (D-139: tanpa pengecualian per figur).
 */
export const GRAPH_NODE_PAD_UNITS = 1;
export const GRAPH_ROW_GAP_BASELINES = 3;

export function layoutGraphDetail(s: StudioDiagramV1, sheet: DiagramSheet): GraphDetail {
  const L = latticeOf(sheet);
  if (diagramFitCapacity()) {
    // FIG-02b2 P1-14: render pertama ditolak DATUM-37; kolom bersambung -> pitch dipadatkan.
    const cs = [...new Set(s.nodes.map(colOfNode))].sort((a, b) => a - b);
    if (cs.length > 1 && contiguousCols(cs)) {
      return { result: layoutGraphCapacity(s, L, GRAPH_NODE_PAD_UNITS, GRAPH_ROW_GAP_BASELINES), adaptive: true };
    }
  }
  const ests: Ests = new Map();
  const cols: number[] = [];
  for (const n of s.nodes) {
    const c = colOfNode(n);
    if (!cols.includes(c)) cols.push(c);
    ests.set(n.id, nodeSize(n, L, undefined, GRAPH_NODE_PAD_UNITS));
  }
  cols.sort((a, b) => a - b);
  const maxw = new Map<number, number>();
  for (const n of s.nodes) {
    const c = colOfNode(n);
    maxw.set(c, Math.max(maxw.get(c) ?? 0.0, wOf(ests, n.id)));
  }
  // Jalur lama dipertahankan bila: satu kolom, anchor lama kolom mana pun di luar
  // lembar (basal merah DATUM-37), atau lebar kolom sendiri melewati lembar (DATUM-32).
  const adaptive =
    cols.length > 1 &&
    [...maxw.values()].every((w) => w <= L.W + 1e-6) &&
    cols.every((c) => c * L.x * 4 < L.W - 1e-6);
  let pos: ColPos;
  let rowpack: GraphRowpack | undefined;
  if (adaptive) {
    ({ pos, rowpack } = graphColumnPos(s, L, cols, ests));
  } else {
    pos = new Map(cols.map((c) => [c, c * L.x * 4]));
  }
  const nodes: Record<string, DiagramBox> = {};
  // D-242 + FIX-B2: pitch baris = simpul tertinggi + koridor GRAPH_ROW_GAP_BASELINES
  // (Python: `LATTICE_Y * 8` tetap, = tinggi simpul 3 unit lama 6 kisi + 2 kisi).
  let hmax = 0.0;
  for (const [, h] of ests.values()) hmax = Math.max(hmax, h);
  const rowPitch = hmax + baselineStepMm(GRAPH_ROW_GAP_BASELINES, L);
  for (const n of s.nodes) {
    const c = colOfNode(n);
    const r = rowOfNode(n);
    const [nw, nh] = ests.get(n.id) as [number, number];
    const x = snap(pos.get(c) as number, L.x);
    const y = snap(L.top + r * rowPitch, L.y);
    if (adaptive && x + nw > L.W + 1e-6) {
      throw diagramDefect(
        `DATUM-37: simpul ${n.id} keluar lebar lembar (${x.toFixed(1)}..${(x + nw).toFixed(1)} dari ${L.W.toFixed(1)} mm) ` +
          "setelah penempatan kolom (P8, layout_graph)",
        "DATUM-37",
      );
    }
    nodes[n.id] = { x, y, w: nw, h: nh };
  }
  return { result: { nodes, widthMm: L.W, heightMm: sheetHeight(L, Object.values(nodes)) }, adaptive, rowpack };
}

export function layoutGraph(s: StudioDiagramV1, sheet: DiagramSheet): LayoutResult {
  return layoutGraphDetail(s, sheet).result;
}
