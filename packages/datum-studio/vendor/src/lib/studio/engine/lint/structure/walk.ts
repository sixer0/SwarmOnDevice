/**
 * Penjelajahan dokumen untuk lint struktur: setiap blok (isi, spacer, device,
 * butir halaman depan) beserta JSON pointer, alamat §4.1, label artefak
 * (§4.1 penomoran per bab), dan teks polosnya.
 *
 * Alamat dihitung dari `snapshot.doc` (posisi dalam revisi). Bila snapshot
 * membawa `NormBlock` ber-`blockId` yang sama, alamat snapshot dipakai.
 */
import type {
  Cell,
  Chapter,
  FrontItem,
  Inline,
  NormDocSnapshot,
  RailLine,
  Row,
  StudioDocV1,
  TableBlock,
} from "../../../contract";
import { TABLE_BLOCK_TYPES } from "../../../contract/enums";
import { inlineText } from "../../bind";

export type Zone = "front" | "part" | "chapter" | "appendix";

export interface WalkItem {
  /** Blok apa adanya (bentuk §3.3-3.4). */
  block: { type: string } & Record<string, unknown>;
  pointer: string;
  address?: string;
  zone: Zone;
  /** Kunci bab/lampiran ("3", "A"); undefined di halaman depan/bagian. */
  chap?: string;
  /** "Tabel 3.1" | "Gambar 3.2" | "Turunan D-3.1". */
  artifactLabel?: string;
}

export interface UnitInfo {
  zone: "chapter" | "appendix";
  key: string;
  pointer: string;
  chapter: Chapter;
}

export interface DocWalk {
  items: WalkItem[];
  units: UnitInfo[];
  /** Semua label artefak yang ada di revisi ini. */
  artifacts: Set<string>;
  /** JSON pointer -> alamat (untuk temuan bertingkat dalam blok). */
  addressByPointer: Map<string, string>;
}

const TABLE_TYPES: ReadonlySet<string> = new Set(TABLE_BLOCK_TYPES);
const FIGURE_TYPES: ReadonlySet<string> = new Set(["chart", "diagram", "image", "symbolSheet"]);
const UNCOUNTED: ReadonlySet<string> = new Set(["spacer", "device"]);

export function isTableType(t: string): boolean {
  return TABLE_TYPES.has(t);
}

export function isFigureType(t: string): boolean {
  return FIGURE_TYPES.has(t);
}

function esc(seg: string | number): string {
  return String(seg).replace(/~/g, "~0").replace(/\//g, "~1");
}

export function ptr(...segs: Array<string | number>): string {
  return segs.map((s) => "/" + esc(s)).join("");
}

function appendixKey(i: number): string {
  return i < 26 ? String.fromCharCode(65 + i) : `A${i}`;
}

function asBlock(x: unknown): ({ type: string } & Record<string, unknown>) | undefined {
  return x && typeof x === "object" && typeof (x as { type?: unknown }).type === "string"
    ? (x as { type: string } & Record<string, unknown>)
    : undefined;
}

/** Menerima snapshot v1 maupun v2 (`studio.norm/v2` membawa `doc` internal + `NormBlockV2`). */
export function walkDoc(snap: Pick<NormDocSnapshot, "doc" | "blocks">): DocWalk {
  const doc = snap.doc;
  const items: WalkItem[] = [];
  const units: UnitInfo[] = [];
  const artifacts = new Set<string>();

  const snapAddr = new Map<string, string>();
  for (const b of snap.blocks ?? []) if (b.blockId && b.address) snapAddr.set(b.blockId, b.address);
  // IMPL-W4 (review 15 F5): label artefak tersimpan snapshot (compose; mode sumber "Tabel 6.1"/"Tabel FM.1") menang
  // atas hitungan kunci bab internal, sama dengan DOCX `numbering.ts`; hitungan hanya cadangan.
  const snapLabel = new Map<string, string>();
  for (const b of snap.blocks ?? []) if (b.blockId && typeof b.artifactLabel === "string" && b.artifactLabel !== "") snapLabel.set(b.blockId, b.artifactLabel);
  const pick = (block: Record<string, unknown>, computed: string | undefined): string | undefined => {
    const id = typeof block.blockId === "string" ? block.blockId : undefined;
    return (id && snapAddr.get(id)) ?? computed;
  };

  const frontBody = (key: "cover" | "controlSheet" | "toc" | "signature", list: readonly unknown[] | undefined, base: string) => {
    let p = 0;
    (list ?? []).forEach((x, i) => {
      const block = asBlock(x);
      if (!block) return;
      const counted = !UNCOUNTED.has(block.type);
      if (counted) p++;
      items.push({ block, pointer: `${base}/${i}`, address: pick(block, `F:${key}${counted ? `/${p}` : ""}`), zone: "front" });
    });
  };
  frontBody("cover", doc.front?.cover?.body, ptr("front", "cover", "body"));
  frontBody("controlSheet", doc.front?.controlSheet?.body, ptr("front", "controlSheet", "body"));
  if (doc.front?.toc?.sealBand) {
    const block = asBlock(doc.front.toc.sealBand);
    if (block) items.push({ block, pointer: ptr("front", "toc", "sealBand"), address: "F:toc", zone: "front" });
  }
  if (doc.front?.signature) {
    const block = asBlock(doc.front.signature);
    if (block) items.push({ block, pointer: ptr("front", "signature"), address: "F:signature", zone: "front" });
  }
  (doc.parts ?? []).forEach((part, pi) => {
    (part.body ?? []).forEach((x: FrontItem, i) => {
      const block = asBlock(x);
      if (block) items.push({ block, pointer: ptr("parts", pi, "body", i), address: pick(block, `P:${pi + 1}`), zone: "part" });
    });
  });

  const chapterWalk = (ch: Chapter, key: string, zone: "chapter" | "appendix", base: string) => {
    units.push({ zone, key, pointer: base, chapter: ch });
    const n = { table: 0, figure: 0, derivation: 0 };
    const flow = (list: readonly unknown[] | undefined, secNo: number, listBase: string) => {
      let p = 0;
      (list ?? []).forEach((x, i) => {
        const block = asBlock(x);
        if (!block) return;
        const counted = !UNCOUNTED.has(block.type);
        if (counted) p++;
        let artifactLabel: string | undefined;
        const hasCaption = block.caption !== undefined && block.caption !== null;
        if (isTableType(block.type) && hasCaption) artifactLabel = `Tabel ${key}.${++n.table}`;
        else if (isFigureType(block.type) && hasCaption) artifactLabel = `Gambar ${key}.${++n.figure}`;
        else if (block.type === "derivation") artifactLabel = `Turunan D-${key}.${++n.derivation}`;
        const bid = typeof block.blockId === "string" ? block.blockId : undefined;
        if (artifactLabel !== undefined && bid !== undefined && snapLabel.has(bid)) artifactLabel = snapLabel.get(bid);
        if (artifactLabel) artifacts.add(artifactLabel);
        items.push({
          block,
          pointer: `${listBase}/${i}`,
          address: counted ? pick(block, `${key}.${secNo}.${p}`) : undefined,
          zone,
          chap: key,
          artifactLabel,
        });
      });
    };
    flow(ch.intro, 0, `${base}/intro`);
    (ch.sections ?? []).forEach((s, si) => flow(s.blocks, si + 1, `${base}/sections/${si}/blocks`));
  };
  doc.chapters.forEach((ch, ci) => chapterWalk(ch, ch.key ?? String(ci + 1), "chapter", ptr("chapters", ci)));
  (doc.appendices ?? []).forEach((ch, ai) => chapterWalk(ch, ch.key ?? appendixKey(ai), "appendix", ptr("appendices", ai)));

  const addressByPointer = new Map<string, string>();
  for (const it of items) if (it.address) addressByPointer.set(it.pointer, it.address);
  return { items, units, artifacts, addressByPointer };
}

/** Alamat blok terdekat untuk pointer bertingkat (prefiks terpanjang). */
export function addressFor(w: DocWalk, pointer: string): string | undefined {
  let p = pointer;
  for (;;) {
    const a = w.addressByPointer.get(p);
    if (a) return a;
    const cut = p.lastIndexOf("/");
    if (cut <= 0) return undefined;
    p = p.slice(0, cut);
  }
}

// ── Teks polos ─────────────────────────────────────────────────────────────

/** Teks polos Inline; toleran terhadap snapshot rusak (bukan Inline -> ""). */
export function textOf(x: Inline | undefined | null): string {
  if (!x || typeof x !== "object") return "";
  const r = x as { text?: unknown; runs?: unknown };
  if (typeof r.text === "string") return r.text;
  if (Array.isArray(r.runs)) return inlineText({ runs: r.runs.filter((u) => u && typeof u === "object") });
  return "";
}

export function cellText(c: Cell): string {
  const parts: string[] = [];
  if (typeof c.text === "string") parts.push(c.text);
  if (c.runs) parts.push(textOf({ runs: c.runs }));
  for (const p of c.paragraphs ?? []) parts.push(textOf(p));
  if (c.nested) parts.push(tableText(c.nested));
  return parts.join("\n");
}

export function rowText(r: Row): string {
  return r.cells.map(cellText).join("\t");
}

export function tableText(t: TableBlock): string {
  const parts: string[] = [];
  if (t.caption) parts.push(textOf(t.caption.inline));
  for (const r of t.rows ?? []) parts.push(rowText(r));
  if (t.source) parts.push(textOf(t.source.inline));
  return parts.join("\n");
}

function railText(rail: unknown): string {
  if (!Array.isArray(rail)) return "";
  return (rail as RailLine[])
    .map((l) => [l.label, l.text, l.runs ? textOf({ runs: l.runs }) : ""].filter(Boolean).join(" "))
    .join("\n");
}

function inl(x: unknown): string {
  if (!x || typeof x !== "object") return "";
  if ("text" in x || "runs" in x) return textOf(x as Inline);
  return "";
}

/** Teks polos blok (isi yang dibaca pembaca; tanpa spec mesin). */
export function blockText(block: { type: string } & Record<string, unknown>): string {
  const b = block as Record<string, unknown>;
  const t = block.type;
  const parts: string[] = [];
  const figureCommon = () => {
    const cap = b.caption as { inline?: Inline } | undefined;
    if (cap?.inline) parts.push(textOf(cap.inline));
    parts.push(inl(b.keyRow));
    const src = b.source as { inline?: Inline } | undefined;
    if (src?.inline) parts.push(textOf(src.inline));
  };
  switch (t) {
    case "paragraph":
    case "assumptionInline":
      parts.push(inl(b), railText(b.rail));
      break;
    case "list":
      for (const it of (b.items as unknown[]) ?? []) parts.push(inl(it), railText((it as { rail?: unknown }).rail));
      break;
    case "aside":
      parts.push(inl(b.label));
      for (const p of (b.body as unknown[]) ?? []) parts.push(inl(p));
      break;
    case "monoBlock":
      parts.push(inl(b.label));
      for (const p of (b.lines as unknown[]) ?? []) parts.push(inl(p));
      break;
    case "derivation":
      parts.push(inl(b.title), inl(b.intro));
      for (const ln of (b.lines as Array<{ label?: unknown; value?: unknown }>) ?? []) {
        parts.push(inl(ln.label));
        if (ln.value && typeof ln.value === "object" && !("registerKey" in ln.value)) parts.push(inl(ln.value));
      }
      parts.push(inl((b.result as { label?: unknown } | undefined)?.label), inl((b.verdict as { label?: unknown } | undefined)?.label), inl(b.closing));
      break;
    case "chart":
    case "diagram":
    case "image":
    case "symbolSheet":
      figureCommon();
      break;
    case "controlBlock":
      for (const r of (b.rows as unknown[][]) ?? []) for (const c of r) parts.push(inl(c));
      break;
    case "colophon":
      parts.push(inl(b.left), inl(b.right));
      break;
    case "signatureBlock":
      for (const r of (b.roles as Array<Record<string, unknown>>) ?? []) parts.push(inl(r.role), inl(r.holder), inl(r.date));
      break;
    case "device":
      parts.push(inl(b.left), inl(b.right), inl(b.text));
      break;
    default:
      if (isTableType(t)) parts.push(tableText(block as unknown as TableBlock));
  }
  return parts.filter((s) => s !== "").join("\n");
}

/** Teks satu kalimat/caption untuk dokumen penuh (halaman depan + isi). */
export function docText(w: DocWalk): Array<{ item: WalkItem; text: string }> {
  return w.items.map((item) => ({ item, text: blockText(item.block) }));
}

export type { StudioDocV1 };
