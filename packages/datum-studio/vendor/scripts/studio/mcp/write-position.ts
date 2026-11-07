/**
 * IMPL-W3 butir 14c: alamat posisi untuk perbaikan gerbang naturalisasi (tanda baca salah tempat). Paragraf dialamatkan
 * lewat pid (dari `studio_document_get view=paragraphs`) + offset karakter pada teks POLOS paragraf; `expect` (opsional)
 * menjaga bahwa teks di posisi itu masih sama, selain itu POSITION_MISMATCH (hasil normal, 0 tulis). Murni: tanpa I/O.
 */
import { McpToolError } from "./safety";
import { isRecord } from "./tool-kit";

type Rec = Record<string, unknown>;

export interface PositionEdit {
  pid: string;
  at: number;
  length?: number;
  replace: string;
  expect?: string;
}

export interface ParagraphRef {
  pid: string;
  chapter: string;
  /** judul bab (intro) atau section tempat paragraf berada. */
  section: string;
  text: string;
  block: Rec;
}

/** Teks InlineV2 ({text} | {runs:[{t}]}). */
export const inlinePlain = (h: unknown): string =>
  !isRecord(h) ? "" : typeof h.text === "string" ? h.text : Array.isArray(h.runs) ? (h.runs as Rec[]).map((r) => (typeof r.t === "string" ? r.t : "")).join("") : "";

/** Semua paragraf ber-pid di proyeksi R20 (bab: intro + section), urut dokumen. */
export function paragraphsOf(content: unknown): ParagraphRef[] {
  const out: ParagraphRef[] = [];
  const sections = isRecord(content) && isRecord(content.sections) ? content.sections : {};
  const chapters = isRecord(sections.content) && Array.isArray(sections.content.chapters) ? (sections.content.chapters as unknown[]).filter(isRecord) : [];
  for (const ch of chapters) {
    const key = String(ch.key);
    const visit = (list: unknown, section: string) => {
      for (const b of Array.isArray(list) ? list.filter(isRecord) : []) {
        if (b.type === "paragraph" && typeof b.id === "string") out.push({ pid: b.id, chapter: key, section, text: inlinePlain(b), block: b });
      }
    };
    visit(ch.intro, inlinePlain(ch.title));
    for (const s of Array.isArray(ch.sections) ? ch.sections.filter(isRecord) : []) visit(s.blocks, inlinePlain(s.title));
  }
  return out;
}

export const isPositionEdit = (e: unknown): e is PositionEdit => isRecord(e) && typeof e.pid === "string" && typeof e.at === "number";

/** Paragraf + teks baru untuk satu suntingan posisi (cek pid, batas, dan `expect`). */
export function resolvePosition(e: PositionEdit, paras: readonly ParagraphRef[], label: string): { para: ParagraphRef; next: string; start: number; end: number } {
  const para = paras.find((p) => p.pid === e.pid);
  if (para === undefined) {
    throw new McpToolError("TEXT_NOT_FOUND", `${label}: pid tidak ada di revisi terkini dokumen ini; ambil pid dari studio_document_get { documentId, view: "paragraphs" }. Tidak ada yang ditulis`, { details: { edit: label, pid: e.pid } });
  }
  const len = e.length ?? (e.expect !== undefined ? e.expect.length : 0);
  if (e.at < 0 || e.at + len > para.text.length) {
    throw new McpToolError("POSITION_MISMATCH", `${label}: posisi ${e.at}+${len} di luar teks paragraf (panjang ${para.text.length}); baca ulang paragraf lalu ulangi. Tidak ada yang ditulis`, {
      untrusted: true,
      details: { edit: label, pid: e.pid, length: para.text.length },
    });
  }
  // W3-L2: offset dalam unit UTF-16; batas yang jatuh di antara surrogate tinggi dan rendah memecah satu karakter.
  const splits = (i: number) => i > 0 && i < para.text.length && /[\ud800-\udbff]/.test(para.text[i - 1]) && /[\udc00-\udfff]/.test(para.text[i]);
  if (splits(e.at) || splits(e.at + len)) {
    throw new McpToolError("POSITION_INVALID", `${label}: at/length memotong satu karakter (pasangan surrogate UTF-16, mis. emoji); geser offset ke batas karakter. Tidak ada yang ditulis`, {
      details: { edit: label, pid: e.pid, at: e.at, length: len },
    });
  }
  const actual = para.text.slice(e.at, e.at + len);
  if (e.expect !== undefined && actual !== e.expect) {
    throw new McpToolError("POSITION_MISMATCH", `${label}: teks di posisi itu tidak sama dengan expect (paragraf sudah berubah?); tidak ada yang ditulis. Teks sebenarnya ada di blok rincian`, {
      untrusted: true,
      details: { edit: label, pid: e.pid, at: e.at, expect: e.expect, actual, around: para.text.slice(Math.max(0, e.at - 30), e.at + len + 30) },
    });
  }
  return { para, next: para.text.slice(0, e.at) + e.replace + para.text.slice(e.at + len), start: e.at, end: e.at + len };
}

/**
 * Laporan kerja (sunting lewat teks Markdown): suntingan posisi -> cari-ganti jendela kata utuh di sekitar posisi
 * (>= 3 kata bila ada), dibatasi bab paragraf itu. Jendela diambil dari teks polos paragraf.
 */
export function positionToFind(e: PositionEdit, paras: readonly ParagraphRef[], label: string): { find: string; replace: string; section: string; target: { plain: string; nth: number } } | null {
  const { para, next, start, end } = resolvePosition(e, paras, label);
  if (next === para.text) return null;
  // W3-L1: sasaran = paragraf ber-pid itu, bukan kecocokan teks di bab: urutan paragraf ber-teks-polos sama di bab ini.
  const same = (t: string) => t.replace(/\s+/g, " ").trim();
  const nth = paras.filter((p) => p.chapter === para.chapter && same(p.text) === same(para.text)).findIndex((p) => p.pid === para.pid);
  const t = para.text;
  const toks = [...t.matchAll(/\S+/g)].map((m) => [m.index as number, (m.index as number) + m[0].length] as [number, number]);
  let lo = toks.findIndex((k) => k[1] >= start);
  let hi = toks.length - 1 - [...toks].reverse().findIndex((k) => k[0] <= end);
  if (lo < 0) lo = Math.max(0, toks.length - 1);
  if (hi < lo || hi >= toks.length) hi = lo;
  while (hi - lo + 1 < 3 && (lo > 0 || hi < toks.length - 1)) {
    if (lo > 0) lo--;
    if (hi - lo + 1 < 3 && hi < toks.length - 1) hi++;
  }
  const a = toks.length > 0 ? Math.min(toks[lo][0], start) : 0;
  const b = toks.length > 0 ? Math.max(toks[hi][1], end) : t.length;
  return { find: t.slice(a, b), replace: next.slice(a, b + (next.length - t.length)), section: `bab ${para.chapter}`, target: { plain: para.text, nth } };
}
