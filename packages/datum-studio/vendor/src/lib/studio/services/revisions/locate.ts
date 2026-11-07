/**
 * Penelusur dokumen `studio.doc/v1` untuk sunting per alamat (S50, 01_specs.md §4.1-4.2).
 *
 * Penomoran blok: `C.S.P` dengan seksi 0 = intro bab; P menghitung semua blok
 * isi (21 jenis) berurutan, `spacer`/`device` tidak dihitung. Kunci bab =
 * `chapter.key` atau posisi 1-based; kunci lampiran = `key` atau huruf posisi.
 * Label artefak (Tabel/Gambar/Turunan) TIDAK dihitung ulang di sini: layanan
 * memetakan label -> alamat lewat snapshot revisi (sumber kebenaran per revisi).
 */
import {
  type Block,
  type Cell,
  type Chapter,
  type FlowItem,
  type NormDocSnapshot,
  type Section,
  type StudioDocV1,
  type TableBlock,
  TABLE_BLOCK_TYPES,
} from "../../contract";

export interface FlowLocation {
  address: string;
  chapterKey: string;
  sectionNo: number;
  paraNo: number;
  /** Larik pemilik item (intro bab atau `section.blocks`). */
  container: FlowItem[];
  index: number;
  item: Block;
}

export interface HeadingLocation {
  address: string;
  kind: "chapter" | "section";
  node: Chapter | Section;
}

export interface DocWalk {
  blocks: FlowLocation[];
  headings: HeadingLocation[];
}

const TABLE_TYPES: ReadonlySet<string> = new Set<string>(TABLE_BLOCK_TYPES);

export function isAddressable(item: FlowItem): item is Block {
  return item.type !== "spacer" && item.type !== "device";
}

export function isTableBlock(v: unknown): v is TableBlock {
  return (
    !!v &&
    typeof v === "object" &&
    TABLE_TYPES.has(String((v as { type?: unknown }).type)) &&
    Array.isArray((v as { rows?: unknown }).rows)
  );
}

function appendixKey(i: number): string {
  return String.fromCharCode(65 + (i % 26));
}

function walkFlow(items: FlowItem[] | undefined, chapterKey: string, sectionNo: number, out: FlowLocation[]): void {
  if (!items) return;
  let p = 0;
  items.forEach((item, index) => {
    if (!isAddressable(item)) return;
    p += 1;
    out.push({ address: `${chapterKey}.${sectionNo}.${p}`, chapterKey, sectionNo, paraNo: p, container: items, index, item });
  });
}

function walkChapter(ch: Chapter, key: string, w: DocWalk): void {
  w.headings.push({ address: key, kind: "chapter", node: ch });
  walkFlow(ch.intro, key, 0, w.blocks);
  (ch.sections ?? []).forEach((sec, si) => {
    w.headings.push({ address: `${key}.${si + 1}`, kind: "section", node: sec });
    walkFlow(sec.blocks, key, si + 1, w.blocks);
  });
}

/** Telusuri bab + lampiran; referensi `container`/`item` menunjuk ke objek `doc` asli (mutasi in-place). */
export function walkDoc(doc: StudioDocV1): DocWalk {
  const w: DocWalk = { blocks: [], headings: [] };
  (doc.chapters ?? []).forEach((ch, i) => walkChapter(ch, ch.key ?? String(i + 1), w));
  (doc.appendices ?? []).forEach((ch, i) => walkChapter(ch, ch.key ?? appendixKey(i), w));
  return w;
}

/**
 * Pasang `blockId` snapshot ke setiap blok isi, bab, dan seksi di `doc` yang
 * belum memilikinya, agar normalisasi ulang mempertahankan identitas lintas
 * revisi (§4.2 butir 2) meskipun ordinal bergeser. Mengembalikan jumlah yang
 * tidak dapat dipasangkan (alamat tidak ada di snapshot).
 */
export function stampBlockIds(doc: StudioDocV1, snapshot: NormDocSnapshot): number {
  const byAddress = new Map<string, string>();
  for (const b of snapshot.blocks) if (b.address) byAddress.set(b.address, b.blockId);
  const w = walkDoc(doc);
  let unmatched = 0;
  const stamp = (address: string, node: { blockId?: string }) => {
    if (node.blockId) return;
    const id = byAddress.get(address);
    if (id) node.blockId = id;
    else unmatched += 1;
  };
  for (const loc of w.blocks) stamp(loc.address, loc.item);
  for (const h of w.headings) stamp(h.address, h.node);
  return unmatched;
}

/**
 * Sel tabel per alamat `r.c` (1-based): r menghitung semua `rows` berurutan,
 * c = kolom grid tempat sel MULAI (sadar gridSpan). Sel `vMerge: continue`
 * tidak beralamat (null).
 */
export function locateCell(table: TableBlock, row: number, col: number): { rowIdx: number; cellIdx: number; cell: Cell } | null {
  const r = table.rows[row - 1];
  if (!r || !Array.isArray(r.cells)) return null;
  let gridCol = 1;
  for (let ci = 0; ci < r.cells.length; ci++) {
    const cell = r.cells[ci];
    if (gridCol === col) return cell.vMerge === "continue" ? null : { rowIdx: row - 1, cellIdx: ci, cell };
    if (gridCol > col) return null;
    gridCol += Math.max(1, cell.gridSpan ?? 1);
  }
  return null;
}

/** Butir di dalam blok (`C.S.P/n`): list, aside, monoBlock, derivation. */
export function blockItems(content: unknown): unknown[] | null {
  if (!content || typeof content !== "object") return null;
  const c = content as { type?: unknown; items?: unknown; body?: unknown; lines?: unknown };
  switch (c.type) {
    case "list":
      return Array.isArray(c.items) ? c.items : null;
    case "aside":
      return Array.isArray(c.body) ? c.body : null;
    case "monoBlock":
    case "derivation":
      return Array.isArray(c.lines) ? c.lines : null;
    default:
      return null;
  }
}

/** Sub-artefak `/caption`, `/source`, `/key`. */
export function artifactSub(content: unknown, sub: "caption" | "source" | "key"): unknown {
  if (!content || typeof content !== "object") return undefined;
  const c = content as { caption?: unknown; source?: unknown; keyRow?: unknown };
  return sub === "caption" ? c.caption : sub === "source" ? c.source : c.keyRow;
}
