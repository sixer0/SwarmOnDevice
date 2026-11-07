/**
 * Port `layout_sld` (`HS/datum_diagram.py:582-602`): rel bus di atas, cabang
 * menggantung di bawahnya (P2 sld; P9 E-17).
 *
 * INT-J (F-022): Python hanya menempatkan rel PERTAMA dan diam-diam membuang
 * rel berikutnya. Di sini:
 *  - default (paritas Garis A): spec dengan tepat satu rel = keluaran Python
 *    bit-identik; spec dengan > 1 rel ditolak `BY_CONSTRUCTION_FAILED`
 *    (checkId `E-17/MULTI-BUS`), tidak pernah dibuang diam-diam;
 *  - opt-in eksplisit `multiBus` (lihat `SldLayoutOptions`): tata letak
 *    multi-rel deterministik, rel ditumpuk vertikal, cabang di bawah relnya.
 *
 * FIX-B (B-2, D-241/F-052): rentang rel = lebar lembar bila lebar itu tepat
 * pada kisi horizontal (128 mm = 12 kisi: keluaran Python bit-identik); bila
 * tidak (mis. 166 mm = 15,56 kisi), rel = kelipatan kisi TERBESAR yang muat
 * (`snapFloor`), dan baris cabang dibagi di rentang rel yang sama. Python
 * membulatkan rel 166 ke 170,667 mm lalu gagal DATUM-37; aturan DATUM-37 tetap
 * ketat (`core/sheet.ts` snapToLattice), tata letaklah yang kini muat.
 *
 * FIX-B2 (D-277, D-139): rel HILIR yang dicatu dari cabang rel sebelumnya
 * (edge `cabang -> rel`, mis. rel distribusi UPS di bawah pemutusnya) adalah
 * isi diagram satu garis, bukan pilihan tampilan; kontrak v2 tidak membawa
 * `sld.multiBus` (DiagramSpecV2), jadi agen tidak dapat memintanya. Aturan umum:
 * bila SETIAP rel tambahan dicatu cabang rel sebelumnya, rel ditumpuk dengan
 * rumus multi-rel yang sama tanpa opt-in. Rel tambahan yang tidak dicatu
 * (sistem terpisah) tetap ditolak `E-17/MULTI-BUS`, tidak pernah dibuang.
 */
import type { DiagramBox, DiagramNode, DiagramSheet, LayoutResult, StudioDiagramV1 } from "../../../contract";
import { baselineStepMm, diagramDefect, latticeOf, nodeGet, nodeSize, sheetHeight, snap, snapFloor, type Lattice } from "./geometry";

export interface SldBus {
  y: number;
  id: string;
}

export interface SldDetail {
  result: LayoutResult;
  /** Padanan `sheet.bus` Python: garis tengah rel dan id simpul rel (rel pertama). */
  bus: SldBus;
  /** Semua rel yang ditempatkan, urut atas ke bawah (mode default: satu rel). */
  buses: SldBus[];
}

/**
 * Opsi tata letak sld. `multiBus: true` mengaktifkan tata letak multi-rel.
 * Bila opsi tidak diberikan, nilai dibaca dari spec `sld.multiBus` (seam ke
 * depan: kunci itu belum ada di kontrak `studio.diagram/v1`, permintaan
 * tercatat di `file_requests.md` INT-J). Tanpa keduanya = perilaku Python.
 */
export interface SldLayoutOptions {
  multiBus?: boolean;
}

const isBus = (n: DiagramNode) => nodeGet(n, "shape", undefined) === "bus";

/** Opt-in dari spec (`sld.multiBus === true`); medan di luar kontrak dibaca defensif. */
function specMultiBus(s: StudioDiagramV1): boolean {
  const sld = (s as unknown as { sld?: unknown }).sld;
  return typeof sld === "object" && sld !== null && (sld as { multiBus?: unknown }).multiBus === true;
}

/**
 * Rentang rel (mm): lebar lembar bila sudah pada kisi (`snap(W) <= W`, paritas
 * Python), selain itu kelipatan kisi terbesar <= lebar lembar. Deterministik,
 * berlaku untuk semua lebar (D-139: tanpa pengecualian per figur).
 */
export function sldRailWidth(L: Lattice): number {
  return snap(L.W, L.x) <= L.W + 1e-6 ? L.W : snapFloor(L.W, L.x);
}

/**
 * Satu baris cabang di bawah rel bertepi atas `top` (rumus Python baris per
 * baris: lebar seragam `w`, y = (top + bh) + langkah). Mengembalikan tepi
 * bawah baris (maks y + h), atau `null` bila tanpa cabang. `span` = rentang
 * rel (`sldRailWidth`); = `L.W` pada lebar berkisi (Python).
 */
function placeBranchRow(
  nodes: Record<string, DiagramBox>,
  others: DiagramNode[],
  top: number,
  bh: number,
  L: Lattice,
  span: number,
): number | null {
  const m = Math.max(1, others.length);
  const gap = L.x;
  let w = snap((span - (m - 1) * gap) / m, L.x);
  w = Math.max(Math.min(w, L.x * 8), L.x * 3);
  // Python: `sheet.top + bh + snap(...)` = (top + bh) + langkah; D-242: dua baseline.
  const y = top + bh + baselineStepMm(2, L);
  let bottom: number | null = null;
  others.forEach((n, i) => {
    const [nw0, nh] = nodeSize(n, L);
    const nw = Math.min(nw0, w);
    nodes[n.id] = { x: snap(i * (w + gap) + (w - nw) / 2.0, L.x), y, w: nw, h: nh };
    bottom = bottom === null ? y + nh : Math.max(bottom, y + nh);
  });
  return bottom;
}

/**
 * Penugasan cabang ke rel (mode multi-rel), deterministik:
 *  1. edge pertama (urutan `edges`) yang menghubungkan simpul itu dengan rel;
 *  2. selain itu rel terdekat SEBELUM simpul dalam urutan `nodes`;
 *  3. selain itu (simpul mendahului semua rel) rel pertama.
 * Urutan cabang dalam satu rel = urutan `nodes`.
 */
function assignBranches(s: StudioDiagramV1, buses: DiagramNode[]): Map<string, DiagramNode[]> {
  const busIds = new Set(buses.map((b) => b.id));
  const viaEdge = new Map<string, string>();
  for (const e of s.edges ?? []) {
    if (busIds.has(e.from) && !busIds.has(e.to) && !viaEdge.has(e.to)) viaEdge.set(e.to, e.from);
    else if (busIds.has(e.to) && !busIds.has(e.from) && !viaEdge.has(e.from)) viaEdge.set(e.from, e.to);
  }
  const groups = new Map<string, DiagramNode[]>(buses.map((b) => [b.id, []]));
  let preceding = buses[0].id;
  for (const n of s.nodes) {
    if (isBus(n)) {
      preceding = n.id;
      continue;
    }
    groups.get(viaEdge.get(n.id) ?? preceding)!.push(n);
  }
  return groups;
}

/**
 * FIX-B2: rel tambahan pertama yang TIDAK dicatu cabang rel sebelumnya, atau
 * `null` bila semua rel tambahan dicatu (rel hilir). "Dicatu" = ada edge
 * `X -> rel_k` dengan X simpul non-rel yang ditugaskan (`assignBranches`) ke
 * rel berindeks < k, sehingga baris pencatu selalu di atas rel yang dicatunya.
 */
function firstUnfedBus(s: StudioDiagramV1, buses: DiagramNode[], groups: Map<string, DiagramNode[]>): DiagramNode | null {
  const busIndex = new Map(buses.map((b, i) => [b.id, i]));
  const ownerIndex = new Map<string, number>();
  for (const [busId, members] of groups) for (const m of members) ownerIndex.set(m.id, busIndex.get(busId)!);
  for (let k = 1; k < buses.length; k++) {
    const fed = (s.edges ?? []).some((e) => {
      if (e.to !== buses[k].id) return false;
      const owner = ownerIndex.get(e.from);
      return owner !== undefined && owner < k;
    });
    if (!fed) return buses[k];
  }
  return null;
}

export function layoutSldDetail(s: StudioDiagramV1, sheet: DiagramSheet, options: SldLayoutOptions = {}): SldDetail {
  const L = latticeOf(sheet);
  const buses = s.nodes.filter(isBus);
  if (buses.length === 0) {
    throw diagramDefect(
      "E-17: keluarga sld butuh rel bus sebelum engine dapat merute cabang tanpa konektor menggantung (P6/register E-17)",
      "E-17",
    );
  }
  const multiBus = options.multiBus ?? specMultiBus(s);
  const unfed = buses.length > 1 && !multiBus ? firstUnfedBus(s, buses, assignBranches(s, buses)) : null;
  if (unfed) {
    throw diagramDefect(
      `E-17/MULTI-BUS: spec sld memuat ${buses.length} rel bus (${buses.map((b) => b.id).join(", ")}); ` +
        `rel '${unfed.id}' tidak dicatu cabang rel sebelumnya (edge cabang -> ${unfed.id}), jadi bukan rel hilir. ` +
        "Tata letak tidak membuang rel diam-diam: pecah menjadi satu spec per sistem rel, " +
        "atau catu rel hilir dari cabang rel di atasnya",
      "E-17/MULTI-BUS",
    );
  }

  const nodes: Record<string, DiagramBox> = {};
  const bh = snap(2 * L.y, L.y);
  const step = baselineStepMm(2, L); // D-242: dua baseline
  const railW = sldRailWidth(L);

  if (buses.length === 1) {
    // Paritas Python persis (juga untuk mode multiBus dengan satu rel).
    const b = buses[0];
    nodes[b.id] = { x: 0.0, y: L.top, w: railW, h: bh };
    const bus = { y: L.top + bh / 2.0, id: b.id };
    placeBranchRow(nodes, s.nodes.filter((n) => !isBus(n)), L.top, bh, L, railW);
    return { result: { nodes, widthMm: L.W, heightMm: sheetHeight(L, Object.values(nodes)) }, bus, buses: [bus] };
  }

  // Multi-rel (opt-in multiBus, atau FIX-B2: semua rel tambahan = rel hilir
  // tercatu): segmen [rel, baris cabang] ditumpuk; rel berikutnya mulai satu
  // langkah (2 baseline, di-snap) di bawah tepi bawah segmen sebelumnya.
  const groups = assignBranches(s, buses);
  const placed: SldBus[] = [];
  let top = L.top;
  for (const b of buses) {
    nodes[b.id] = { x: 0.0, y: top, w: railW, h: bh };
    placed.push({ y: top + bh / 2.0, id: b.id });
    const bottom = placeBranchRow(nodes, groups.get(b.id)!, top, bh, L, railW);
    top = (bottom ?? top + bh) + step;
  }
  return {
    result: { nodes, widthMm: L.W, heightMm: sheetHeight(L, Object.values(nodes)) },
    bus: placed[0],
    buses: placed,
  };
}

export function layoutSld(s: StudioDiagramV1, sheet: DiagramSheet): LayoutResult {
  return layoutSldDetail(s, sheet).result;
}
