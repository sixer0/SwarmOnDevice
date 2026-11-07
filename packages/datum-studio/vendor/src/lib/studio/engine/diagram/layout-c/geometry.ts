/**
 * Geometri tata letak sld/rack/graph (S29, I19). Utilitas bersama (kisi
 * :98-103, `Sheet.top`/`Sheet.height` :391-413, `_node_size` :432, `snap`
 * :193, `snap_floor` :197, `snap_ceil` :204, `est_text_mm` :244, truthiness,
 * `n.get`) kini berasal dari SATU modul `../core/geometry` (IP-39b, S84 #7);
 * berkas ini mengekspor ulangnya dan memuat helper khusus layout-c
 * (`int()`, perbandingan string Python, `class.get`, `_graph_min_width`).
 * Urutan operasi floating-point tetap = Python `HS/datum_diagram.py`:
 *  - `round()` Python 3 = pembulatan setengah-ke-genap (bukan Math.round);
 *  - `len(str)` = jumlah code point, bukan unit UTF-16;
 *  - perbandingan string `<` Python = urutan code point.
 * Kelas `Sheet` milik core tidak diimpor; hanya antarmuka kontrak `DiagramSheet`.
 */
import type { DiagramNode } from "../../../contract";
import { type Lattice, layoutDefect, textNeedMm } from "../core/geometry";

export {
  GARIS_A_TOKENS,
  type Lattice,
  baselineStepMm,
  layoutDefect as diagramDefect,
  latticeOf,
  nodeGet,
  nodeSize,
  sheetHeight,
  snap,
  snapCeil,
  snapFloor,
} from "../core/geometry";

const PY_INT_TEXT = /^\s*[+-]?\d+(?:_\d+)*\s*$/;

/**
 * Python `int(x)` untuk nilai JSON: float dipotong menuju nol, bool 0/1,
 * string bilangan bulat diurai; selain itu Python melempar (TypeError /
 * ValueError / OverflowError) -> di sini cacat bernama.
 */
export function pyInt(v: unknown, what: string): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw layoutDefect(`${what} bukan bilangan bulat sah (${String(v)})`);
    const t = Math.trunc(v);
    return t === 0 ? 0 : t; // -0 -> 0
  }
  if (typeof v === "string" && PY_INT_TEXT.test(v)) return Number.parseInt(v.replace(/_/g, "").trim(), 10);
  throw layoutDefect(`${what} bukan bilangan bulat sah (${JSON.stringify(v) ?? "undefined"})`);
}

/** Perbandingan string Python (urutan code point). */
export function pyStrCmp(a: string, b: string): number {
  if (a === b) return 0;
  const ca = Array.from(a);
  const cb = Array.from(b);
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const x = ca[i].codePointAt(0) as number;
    const y = cb[i].codePointAt(0) as number;
    if (x !== y) return x < y ? -1 : 1;
  }
  return ca.length - cb.length;
}

/** `n.get("class", {}).get(key, dflt)`. */
export function classGet(n: DiagramNode, key: string, dflt: unknown): unknown {
  const cls = n.class as unknown;
  if (cls === undefined) return dflt;
  if (cls === null || typeof cls !== "object") {
    throw layoutDefect(`simpul ${n.id}: class bukan objek (P1 nodes[].class)`);
  }
  const rec = cls as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(rec, key) ? rec[key] : dflt;
}

/** HS `_graph_min_width(n)` (:620-627). */
export function graphMinWidth(n: DiagramNode, L: Lattice): number {
  return Math.max(textNeedMm(n), L.x * 3);
}
