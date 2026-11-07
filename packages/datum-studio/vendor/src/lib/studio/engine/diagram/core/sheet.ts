/**
 * Permukaan gambar diagram dalam mm (port `class Sheet`, `_node_size`,
 * `_foot_lines`, `_foot_reserve_mm`, `node_stroke_token` dan kunci-kisi
 * DATUM-37 dari `build_svg`; `datum_diagram.py:391-449, 1127-1141, 1363-1372`).
 *
 * 1 satuan SVG = 1 mm (E-08). Kisi 10,6667 x 4,7625 mm (`LATTICE_X` = 128/12,
 * `LATTICE_Y` = 13,5 pt). Simpul disimpan dalam `Map` agar urutan sisip Python
 * (dict) terjaga, termasuk id berbentuk angka.
 *
 * Kontrak tata letak (S27-S29): fungsi layout menerima `Sheet` ini (sebagai
 * `DiagramSheet`), menempatkan simpul lewat `placeNode` dalam urutan Python,
 * mengisi `lanes`/`lifelines`/`bus`/`msgY`/`msgStep`/`gutterW`/`rackX`/`rowpack`
 * seperti atribut Python, lalu mengembalikan `sheet.toLayoutResult()`.
 */
import type { DiagramBox, DiagramNode, DiagramSheet, LayoutResult, StudioDiagramV1 } from "../../../contract";
import { DiagramDefect } from "./defect";
import { pyFixed, pyNum } from "./pyfmt";
import { nodeSize as latticeNodeSize, sheetHeight } from "./geometry";
import { LATTICE_X, LATTICE_Y, pt2mm, role, snap, snapCeil, snapFloor, TRACK } from "./tokens";
import { measure, wrap } from "../../chart/core/textfit";
import { symbolLegendName } from "../../symbols/sheet-fit";

export interface SheetNode extends DiagramBox {
  id: string;
  spec: DiagramNode;
  /** Tingkat (layered) sebagai string, seperti Python. */
  tier?: string;
}

export interface SheetLane {
  name: string;
  y: number;
  h: number;
}

export interface SheetLifeline {
  x: number;
  top: number;
}

export class Sheet implements DiagramSheet {
  /** Kisi horizontal (mm): `LATTICE_X` (A4) atau `grid.latticeXMm` turunan templat (D-245). */
  readonly colMm: number;
  readonly rowMm = LATTICE_Y;
  readonly widthMm: number;
  /** Simpul terpasang, urutan sisip = urutan Python `sheet.nodes`. */
  readonly nodes = new Map<string, SheetNode>();
  readonly zones: DiagramBox[] = [];
  readonly lanes: SheetLane[] = [];
  readonly lifelines: SheetLifeline[] = [];
  bus: { y: number; id: string } | null = null;
  /** Tepi atas isi (2 kisi vertikal). */
  top = LATTICE_Y * 2;
  /** Cadangan kaki apparatus (mm), diisi build/estimate. */
  foot = 0;
  /** FIG-02b2: tepi bawah rute konektor (hanya diisi saat fit bila rute menembus kaki). */
  routeBottom?: number;
  /** Atribut opsional tata letak (padanan `getattr(sheet, ...)` Python). */
  msgY?: number;
  msgStep?: number;
  msgEnd?: number | null;
  gutterW?: number;
  rackX?: number;
  rowpack?: { baseline_hits: number; rounds: number; strategy: string; pitch_mm: number };
  private fixedHeight?: number;
  private readonly elements: string[] = [];

  /**
   * `heightMm` opsional: bila tidak diberikan, tinggi = `height()` (Python).
   * `colMm` opsional (D-245): kisi horizontal turunan templat; bawaan `LATTICE_X`.
   */
  constructor(widthMm: number, heightMm?: number, colMm: number = LATTICE_X) {
    this.widthMm = Number(widthMm);
    this.colMm = colMm;
    if (heightMm !== undefined && Number.isFinite(heightMm) && heightMm > 0) this.fixedHeight = heightMm;
  }

  /**
   * D-290: kunci tinggi lembar hasil penyesuaian kotak pembatas (graph) agar
   * akar SVG (`rootOpenTag`) = tinggi yang dipakai kertas dan kaki aparatus.
   */
  fixHeight(heightMm: number): void {
    if (Number.isFinite(heightMm) && heightMm > 0) this.fixedHeight = heightMm;
  }

  /** Alias Python `sheet.W`. */
  get W(): number {
    return this.widthMm;
  }

  get heightMm(): number {
    return this.fixedHeight ?? this.height();
  }

  /** Tinggi lembar (Python `Sheet.height`): kunci kisi + 2 kisi + cadangan kaki. */
  height(): number {
    const h = sheetHeight({ y: LATTICE_Y, top: this.top }, this.nodes.values(), this.lanes, this.msgEnd, this.foot);
    if (this.routeBottom === undefined) return h;
    // FIG-02b2: rute di bawah simpul terbawah -> kaki turun agar baris kaki tidak ditembus rute.
    const floor = snapCeil(this.routeBottom, LATTICE_Y) + LATTICE_Y;
    return Math.max(h, sheetHeight({ y: LATTICE_Y, top: this.top }, [{ y: floor, h: 0 }], [], undefined, this.foot));
  }

  /** Pasang/ganti simpul (padanan `sheet.nodes[id] = {...}`; posisi sisip lama dipertahankan). */
  placeNode(node: SheetNode): SheetNode {
    this.nodes.set(node.id, node);
    return node;
  }

  /** Tambah satu elemen SVG (string; boleh berisi beberapa tag seperti Python). */
  add(svgElement: string): void {
    this.elements.push(svgElement);
  }

  addAll(svgElements: readonly string[]): void {
    for (const e of svgElements) this.elements.push(e);
  }

  /** Elemen yang sudah ditambahkan (salinan). */
  elementList(): string[] {
    return [...this.elements];
  }

  /** Tag root SVG Garis A (mm, E-08). */
  rootOpenTag(heightMm: number = this.heightMm): string {
    const w = pyNum(this.widthMm, 3);
    const h = pyNum(heightMm, 3);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}" version="1.1">`;
  }

  /**
   * Dokumen SVG: deklarasi XML, root mm, elemen sesuai urutan `add`, `</svg>`,
   * digabung "\n" plus "\n" akhir (sama dengan `"\n".join(out) + "\n"`).
   */
  toSvg(): string {
    const out = ['<?xml version="1.0" encoding="UTF-8"?>', this.rootOpenTag(), ...this.elements, "</svg>"];
    return `${out.join("\n")}\n`;
  }

  /**
   * Kunci kisi + clamp lebar + DATUM-37 (blok `build_svg` 1127-1141). Rel bus
   * memang selebar lembar. Mengembalikan id cek `DATUM-37-lebar`.
   */
  snapToLattice(): "DATUM-37-lebar" {
    const lx = this.colMm;
    for (const nd of this.nodes.values()) {
      nd.x = snap(nd.x, lx);
      nd.y = snap(nd.y, LATTICE_Y);
      nd.w = snap(nd.w, lx);
      nd.h = snap(nd.h, LATTICE_Y);
      if (nd.spec.shape !== "bus") {
        const avail = snapFloor(this.widthMm - nd.x, lx);
        if (nd.w > avail) nd.w = avail;
      }
      if (nd.x < -1e-6 || nd.x >= this.widthMm || nd.w <= 0 || nd.x + nd.w > this.widthMm + 1e-6) {
        throw new DiagramDefect(
          `DATUM-37: simpul ${nd.id} keluar lebar lembar (${pyFixed(nd.x, 3)}..${pyFixed(nd.x + nd.w, 3)} dari ${pyFixed(this.widthMm, 1)} mm) (P8)`,
          { checkId: "DATUM-37-lebar" },
        );
      }
    }
    return "DATUM-37-lebar";
  }

  /** Ringkasan kontrak `LayoutResult` dari keadaan lembar. */
  toLayoutResult(): LayoutResult {
    const nodes: Record<string, DiagramBox> = {};
    for (const n of this.nodes.values()) nodes[n.id] = { x: n.x, y: n.y, w: n.w, h: n.h };
    const res: LayoutResult = { nodes, widthMm: this.widthMm, heightMm: this.height() };
    if (this.lanes.length > 0) {
      const lanes: Record<string, DiagramBox> = {};
      for (const l of this.lanes) lanes[l.name] = { x: 0, y: l.y, w: this.widthMm, h: l.h };
      res.lanes = lanes;
    }
    return res;
  }

  /**
   * Isi lembar dari `LayoutResult` bila fungsi layout tidak memasang simpul
   * lewat `placeNode`. Urutan simpul = urutan kunci objek hasil. Data samping
   * tata letak (urutan lajur, garis kehidupan, parit, baris waktu sequence)
   * disalin seperti `build/place.ts` agar `estimate` = build (IP-39b: tanpa
   * ini estimate sequence tanpa garis kehidupan ink200 dan tinggi salah).
   */
  applyLayout(res: LayoutResult, spec: StudioDiagramV1): void {
    const r = res as LayoutResult & {
      laneOrder?: string[];
      lifelines?: Array<{ x: number; top: number }>;
      gutterMm?: number;
      msgY?: number;
      msgStep?: number;
    };
    if (this.nodes.size === 0) {
      const byId = new Map<string, DiagramNode>();
      for (const n of spec.nodes ?? []) byId.set(String(n.id), n);
      for (const [id, b] of Object.entries(r.nodes ?? {})) {
        const sn = byId.get(id);
        if (!sn) continue;
        this.placeNode({ id, spec: sn, x: b.x, y: b.y, w: b.w, h: b.h });
      }
    }
    if (this.lanes.length === 0 && r.lanes) {
      const lanes = r.lanes;
      for (const name of r.laneOrder ?? Object.keys(lanes)) {
        const b = lanes[name];
        if (b) this.lanes.push({ name, y: b.y, h: b.h });
      }
    }
    if (this.lifelines.length === 0 && Array.isArray(r.lifelines)) {
      for (const l of r.lifelines) this.lifelines.push({ x: l.x, top: l.top });
    }
    if (this.gutterW === undefined && typeof r.gutterMm === "number") this.gutterW = r.gutterMm;
    if (this.msgY === undefined && typeof r.msgY === "number") this.msgY = r.msgY;
    if (this.msgStep === undefined && typeof r.msgStep === "number") this.msgStep = r.msgStep;
  }
}

/**
 * Ukuran simpul (`_node_size`) pada kisi inti: lebar kelipatan kisi, satu lebar
 * per tingkat bila `tierNodes` diberikan; tinggi kelipatan baseline (3 unit +
 * sub + tag). Implementasi tunggal di `geometry.ts` (S84 #7).
 */
export function nodeSize(n: DiagramNode, tierNodes?: readonly DiagramNode[]): [number, number] {
  return latticeNodeSize(n, { x: LATTICE_X, y: LATTICE_Y }, tierNodes);
}

/**
 * D-288 (FIX-B2 lanjutan; satu aparatus, D-145/RQ-10): sinyal compose bahwa
 * HALAMAN mencetak baris KUNCI figur ini (blok punya `keyRow`). Medan ini
 * dipasang `services/compose/blocks.ts` pada spec terkomposisi, di luar kontrak
 * `studio.diagram/v1` (dibaca defensif, seperti `sld.multiBus` sebelum
 * kontrak); agen tidak pernah mengirimnya.
 */
export interface DiagramPageKeySignal {
  keyRowOnPage?: boolean;
}

/** Halaman mencetak baris KUNCI figur ini (sinyal compose `keyRowOnPage === true`). */
export function keyRowOnPage(spec: object): boolean {
  return (spec as DiagramPageKeySignal).keyRowOnPage === true;
}

/**
 * Swarm patch (row 124, CP-45; manual Rev A Table 10.1 and SM-01/03/04, ID p.63, 66): symbol id a
 * node asks to be drawn with (`symbol`, e.g. `iec:battery`). Row 124b added the optional field to
 * `studio.diagram/v1` (`DiagramNode.symbol`); still read defensively (engine callers may pass
 * unvalidated specs), and the value is only trusted after `canonicalSymbolId` in the build.
 */
export function nodeSymbolId(n: object): string | undefined {
  const v = (n as { symbol?: unknown }).symbol;
  return typeof v === "string" && v.trim() !== "" ? v.trim().toLowerCase() : undefined;
}

/**
 * Swarm patch (row 124, CP-45): the key rows the figure prints = `spec.legend` plus one row per
 * node symbol that no legend row names yet ("<id> = <nama> (<standar>)"; a GSP house symbol `sec:`
 * reads "<id> = <nama>, bukan simbol standar", SM-03). No symbol on any node = `spec.legend` as is.
 */
export function legendRows(spec: Pick<StudioDiagramV1, "legend"> & { nodes?: readonly object[] }): string[] {
  const rows = Array.isArray(spec.legend) ? spec.legend.map(String) : [];
  const seen = new Set<string>();
  for (const n of spec.nodes ?? []) {
    const id = nodeSymbolId(n);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (rows.some((r) => r.toLowerCase().includes(id))) continue;
    const info = symbolLegendName(id);
    if (!info) continue; // unknown id: refused by the build (canonicalSymbolId), never printed
    rows.push(info.house ? `${id} = ${info.name}, bukan simbol standar` : `${id} = ${info.name} (${info.standard})`);
  }
  return rows;
}

/**
 * Baris KEY digambar DI DALAM SVG: ada legenda DAN halaman tidak mencetak
 * baris KUNCI-nya sendiri (D-288). Tanpa keyRow halaman = perilaku lama
 * (legenda tetap digambar). Legenda tetap di spec untuk DATUM-34.
 */
export function drawsSvgKeyRow(spec: Pick<StudioDiagramV1, "legend"> & { nodes?: readonly object[] }): boolean {
  const hasLegend = legendRows(spec).length > 0;
  return hasLegend && !keyRowOnPage(spec);
}

/** Separator between key rows on one key line (unchanged from the original single line). */
export const KEY_ROW_SEP = "  ·  ";

/**
 * Swarm patch (row 124, CP-46; ID p.63, 80 check 37): the key text broken into lines that fit
 * the sheet width `W` (measured with the calibrated Plex glyph table, caps, SemiBold, tracking of
 * the `table_header` role, as the geometry lint measures). Rows are kept whole where they fit; a
 * single row wider than the sheet is word-wrapped. A key that fits is one line, byte-identical to
 * the original. Nothing is cut.
 */
export function keyLineTexts(
  spec: Pick<StudioDiagramV1, "legend"> & { nodes?: readonly object[] },
  W: number,
  keyLabel = "KEY",
  keyRowText?: (row: string) => string,
): string[] {
  // Row 124b (CP-35, C69): the caller words each row in the document language (ID edge kinds by line
  // pattern) before the rows are packed, so the measured width is the printed width.
  const rows = keyRowText ? legendRows(spec).map(keyRowText) : legendRows(spec);
  const first = `${keyLabel}  `;
  const one = first + rows.join(KEY_ROW_SEP);
  const r = role("table_header");
  const pt = r.size;
  const font = { bold: (r.weight ?? 400) >= 600, trackMm: pt2mm(pt) * TRACK.micro_label_wider, caps: true };
  const maxW = W - 0.5;
  const fits = (t: string) => measure(t, pt, "struct", font) <= maxW;
  if (fits(one)) return [one];
  const lines: string[] = [];
  let cur = "";
  for (const row of rows) {
    const cand = cur === "" ? first + row : cur + KEY_ROW_SEP + row;
    if (fits(cand)) {
      cur = cand;
      continue;
    }
    if (cur !== "") lines.push(cur);
    const head = cur === "" ? first + row : row;
    if (fits(head)) {
      cur = head;
      continue;
    }
    const w = wrap(head, maxW, 8, { pt, face: "struct", ...font });
    lines.push(...w.lines.slice(0, -1));
    cur = w.lines[w.lines.length - 1] ?? "";
  }
  if (cur !== "") lines.push(cur);
  return lines;
}

/**
 * Jumlah baris teks kaki apparatus (`_foot_lines`; baris KEY menurut `drawsSvgKeyRow`).
 * Row 124: with the sheet width `W`, a key that wraps counts all its lines (CP-46).
 */
export function footLines(
  spec: Pick<StudioDiagramV1, "apparatus" | "legend"> & { nodes?: readonly object[] },
  W?: number,
  keyLabel?: string,
  keyRowText?: (row: string) => string,
): number {
  const hasLegend = drawsSvgKeyRow(spec);
  const keyN = hasLegend ? (W !== undefined ? keyLineTexts(spec, W, keyLabel, keyRowText).length : 1) : 0;
  if ((spec.apparatus ?? "page") === "figure") return 2 + keyN;
  return keyN;
}

/** Tinggi cadangan kaki apparatus (`_foot_reserve_mm`); row 124: `W` counts a wrapped key. */
export function footReserveMm(
  spec: Pick<StudioDiagramV1, "apparatus" | "legend"> & { nodes?: readonly object[] },
  W?: number,
  keyLabel?: string,
  keyRowText?: (row: string) => string,
): number {
  return footLines(spec, W, keyLabel, keyRowText) * LATTICE_Y;
}

/** Kelas simpul -> nama token warna garis (`node_stroke_token`). */
export function nodeStrokeToken(nd: Pick<SheetNode, "spec">): string {
  const c = nd.spec.class ?? {};
  if (c.accent) return "signal";
  if (c.external || nd.spec.shape === "shadowed") return "ink400";
  if (nd.spec.shape === "bus") return "ink900";
  return "ink700";
}
