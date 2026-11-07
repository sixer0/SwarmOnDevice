/**
 * Pengurangan persilangan pada lembar tertempat (FIG-02b2, audit research/18 §6 P1-11).
 *
 * Aktif hanya saat fit: bila lint render pertama mengukur persilangan, atau bila agen tidak memberi
 * `col`/`row` dan ada cacat rute terukur (`diagramFitRoute`), untuk keluarga layered, topology dan graph. Lapis = simpul
 * dengan tepi atas sama (tingkat agen / baris graph, tetap). Urutan dalam lapis:
 *  1. barycenter dua arah + transpose (`fit/order.ts`) dari urutan agen sebagai awal;
 *  2. tukar-pasangan dalam lapis (hill climb).
 * Posisi x tetap posisi kisi yang sudah ada (ditukar antarsimpul, tidak pernah digeser), dan setiap
 * langkah dinilai dengan rute NYATA (`routePlaced` + `edgeConflicts`): dipakai hanya bila skor turun
 * tegas, sehingga masukan tanpa silang tidak berubah. Deterministik.
 */
import type { StudioDiagramV1 } from "../../../contract";
import type { Sheet, SheetNode } from "../core";
import { edgeConflicts } from "../fit/lint";
import { orderLayers } from "../fit/order";
import { diagramFitNote, diagramFitQuiet, diagramFitRoute } from "../fit/state";
import { routePlaced } from "./route";

const FAMILIES = new Set(["layered", "topology", "graph"]);
const MAX_EVALS = 400;

function layersOf(sheet: Sheet): SheetNode[][] {
  const byY = new Map<number, SheetNode[]>();
  for (const nd of sheet.nodes.values()) {
    if (nd.spec.shape === "bus") continue;
    const k = Math.round(nd.y * 1000);
    const g = byY.get(k);
    if (g) g.push(nd);
    else byY.set(k, [nd]);
  }
  return [...byY.entries()].sort((a, b) => a[0] - b[0]).map(([, g]) => g.sort((p, q) => p.x - q.x));
}

/**
 * Pasang urutan `ids` ke lapis: dikemas kiri ke kanan dari tepi kiri lapis dengan urutan celah
 * asal (lebar dan celah kelipatan kisi, jadi x tetap di kisi; lebar seragam = tukar slot).
 * Salah bila keluar lembar.
 */
function assign(layer: readonly SheetNode[], ids: readonly string[], W: number): boolean {
  const sorted = [...layer].sort((a, b) => a.x - b.x);
  const gaps = sorted.slice(0, -1).map((n, i) => sorted[i + 1].x - (n.x + n.w));
  const byId = new Map(layer.map((n) => [n.id, n]));
  let x = sorted[0].x;
  const next = ids.map((id, i) => {
    const n = byId.get(id)!;
    const at = x;
    x += n.w + (gaps[i] ?? 0);
    return { n, x: Number(at.toFixed(6)) };
  });
  if (next.some((p) => p.x + p.n.w > W + 1e-6 || p.x < -1e-6)) return false;
  for (const { n, x: nx } of next) n.x = nx;
  return true;
}

function score(s: StudioDiagramV1, sheet: Sheet): number {
  try {
    const paths = diagramFitQuiet(() => routePlaced(s, sheet));
    const c = edgeConflicts(paths.map((p) => p.points));
    return c.cross * 2 + c.collinear;
  } catch {
    return Number.POSITIVE_INFINITY; // DATUM-32: susunan ini tidak dapat dirute
  }
}

/** Tata ulang urutan simpul dalam lapis bila mengurangi konflik rute; mengembalikan true bila berubah. */
export function reorderPlaced(s: StudioDiagramV1, sheet: Sheet): boolean {
  if (!FAMILIES.has(String(s.family))) return false;
  // Brief P1-11: aktif bila agen tidak memberi col/row (urutan bebas; cukup cacat rute apa pun
  // terukur) atau bila lint mengukur persilangan.
  const placedByAgent = (s.nodes ?? []).some((n) => {
    const c = (n.class ?? {}) as Record<string, unknown>;
    return c.col !== undefined || c.row !== undefined;
  });
  if (!(placedByAgent ? diagramFitRoute("edgeCross") : diagramFitRoute("edgeCross", "edgeCollinear"))) return false;
  const layers = layersOf(sheet);
  if (layers.length === 0 || layers.every((l) => l.length < 2)) return false;
  const W = sheet.widthMm;
  const save = new Map([...sheet.nodes.values()].map((n) => [n.id, n.x]));
  const before = score(s, sheet);
  let best = before;
  let evals = 1;
  const edges = (s.edges ?? []).map((e) => [e.from, e.to] as const);
  // 1. barycenter (lapis tetap, urutan agen sebagai awal)
  const bary = orderLayers(layers.map((l) => l.map((n) => n.id)), edges);
  if (bary.changed) {
    const ok = layers.every((l, i) => assign(l, bary.layers[i], W));
    const sc = ok ? score(s, sheet) : Number.POSITIVE_INFINITY;
    evals++;
    if (sc < best) best = sc;
    else for (const n of sheet.nodes.values()) n.x = save.get(n.id)!;
  }
  // 2. tukar-pasangan dalam lapis
  for (let pass = 0; pass < 3 && best > 0 && evals < MAX_EVALS; pass++) {
    let improved = false;
    for (const layer of layersOf(sheet)) {
      for (let i = 0; i < layer.length && evals < MAX_EVALS; i++) {
        for (let j = i + 1; j < layer.length && evals < MAX_EVALS; j++) {
          const ids = layer.map((n) => n.id);
          [ids[i], ids[j]] = [ids[j], ids[i]];
          const prev = new Map(layer.map((n) => [n.id, n.x]));
          if (!assign(layer, ids, W)) continue;
          const sc = score(s, sheet);
          evals++;
          if (sc < best) {
            best = sc;
            improved = true;
            [layer[i], layer[j]] = [layer[j], layer[i]];
          } else for (const n of layer) n.x = prev.get(n.id)!;
        }
      }
    }
    if (!improved) break;
  }
  if (best >= before) {
    for (const n of sheet.nodes.values()) n.x = save.get(n.id)!;
    return false;
  }
  const order = layersOf(sheet).filter((l) => l.length > 1).map((l) => l.map((n) => n.id).join(", ")).join(" | ");
  diagramFitNote(
    "NODE_ORDER",
    `urutan simpul dalam tingkat/baris ditata ulang untuk mengurangi konflik konektor (skor ${before} -> ${best}): ${order}`,
    s.family === "graph" ? "pakai urutan kolom baru di atas, atau hapus class.col agar mesin menata ulang" : "pakai urutan simpul per tingkat di atas, atau pecah menjadi 2 diagram",
  );
  return true;
}
