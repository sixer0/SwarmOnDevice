/**
 * Importer Markdown resmi `md/v1` -> `studio.chapter/v2` KONTEN-SAJA (FIX-H7, D-321/D-322;
 * laporan uji Hermes G3 "importer MD resmi ber-versi"; prinsip D-139).
 *
 * Pemetaan blok:
 *   `#`        -> `chapter.title` (nomor tampilan "3.", "BAB 3", "Chapter 6 -" dibuang);
 *                 `#` berikutnya diperlakukan sebagai `##` (peringatan).
 *   `##`       -> section (nomor "3.1" dibuang); blok sebelum `##` pertama -> `chapter.intro`.
 *   `###`..    -> paragraf `role: "subheading"` (kontrak tidak punya sub-section; >3 diperingatkan).
 *   paragraf   -> `paragraph`; penanda rel di awal (`[TERUKUR]`, `[PEMASOK: catatan]`,
 *                 `[SUMBER: ...]`, `[CATATAN: ...]`) -> `rail[]` (RailLineV2).
 *   `![caption](sha256:<hex> "sumber")` sendirian -> `image` (caption wajib; sumber dari judul
 *                 tautan atau baris `Sumber:` sesudahnya; `[TERUKUR]` dsb. -> provenance).
 *   daftar     -> `list` (`ordered` dari penanda); sarang diratakan (kontrak tanpa sarang).
 *   tabel GFM  -> `table` (baris kepala -> `kind: "header"`); baris `Tabel n.m. ...`
 *                 sesudah/sebelum -> caption; `Sumber: ...` -> source.
 *   kode       -> `monoBlock` (label dari info string); kutipan -> `aside` (`> [!DOCTRINE]` dsb.
 *                 memilih varian).
 * Dibuang + dilaporkan: nomor tampilan, perataan kolom, garis pemisah, front matter, HTML mentah
 * (tag dibuang, teks dipertahankan; style/script/komentar/tabel HTML dibuang seluruhnya),
 * placeholder `[FIGUR: ...]`, gambar tanpa caption/sumber/rujukan aset sah.
 *
 * Idempoten: keluaran hanya fungsi dari (markdown, opsi); CRLF/BOM dinormalkan.
 */
import {
  CHAPTER_KEY_LETTER_PATTERN,
  CHAPTER_KEY_NUMERIC_PATTERN,
  PARAGRAPH_ROLES_V2,
  PROVENANCE_MARKS,
  type AsideV2,
  type BlockV2,
  type CellV2,
  type ChapterV2,
  type ColumnV2,
  type InlineV2,
  type ParagraphRoleV2,
  type ProvenanceMark,
  type RailLineV2,
  type RowV2,
  type SectionV2,
  type SourceV2,
  type StudioChapterV2,
} from "../../contract";
import { StudioEngineError } from "../../contract/errors";
import { excerptOf, inlineOfRuns, inlineText, parseInline, parseInlineRuns, plainInline, type InlineSink } from "./inline";
import { lexMarkdown, type MdBlock } from "./lexer";
import {
  MD_IMPORTER_VERSION,
  type MarkdownImportOptions,
  type MarkdownImportResult,
  type MdConstruct,
  type MdDropKind,
  type MdImportReport,
} from "./types";
import { validateImported } from "./validate";

/**
 * Batas panjang Markdown (karakter) per bab; badan JSON route juga dibatasi transport
 * (`MD_IMPORT_MAX_BODY_BYTES`). FIX-HR1 (D-334 H-01): diturunkan dari 4.000.000 karena
 * konversi berjalan sinkron di event loop HQ; seluruh naskah nyata Hermes 10 bab = 216 KB,
 * dan masukan patologis terburuk pada batas ini < 0,5 s.
 */
export const MD_IMPORT_MAX_CHARS = 1_000_000;
/** Batas badan JSON route impor (UTF-8 hingga 3 byte per karakter + amplop). */
export const MD_IMPORT_MAX_BODY_BYTES = 4 * 1024 * 1024;
/**
 * Batas sumber daya importer (FIX-HR1, D-334 H-01). Satu bab nyata Hermes terbesar = 261 baris
 * dan < 300 blok; batas ini jauh di atasnya tetapi menjaga konversi sinkron tetap singkat
 * (uji performa: 100 ribu baris < 1 s). Melewati batas -> 413 `PAYLOAD_TOO_LARGE` dengan
 * `details.reason` (`MD_TOO_MANY_LINES`, `MD_TOO_MANY_BLOCKS`, `MD_TABLE_TOO_WIDE`, `MD_TOO_LONG`).
 */
export const MD_IMPORT_MAX_LINES = 200_000;
export const MD_IMPORT_MAX_BLOCKS = 50_000;
/** Kontrak membolehkan 1..20 kolom (peringatan `TABLE_TOO_WIDE`); di atas ini ditolak sebelum diproses. */
export const MD_IMPORT_MAX_TABLE_COLUMNS = 100;
/** Entri `warnings`/`dropped` per laporan; sisanya diringkas satu peringatan `REPORT_TRUNCATED`. */
export const MD_REPORT_MAX_ENTRIES = 1000;

type MdLimitReason = "MD_TOO_LONG" | "MD_TOO_MANY_LINES" | "MD_TOO_MANY_BLOCKS" | "MD_TABLE_TOO_WIDE";

function tooLarge(reason: MdLimitReason, message: string, limit: number, actual: number, line?: number): StudioEngineError {
  return new StudioEngineError("PAYLOAD_TOO_LARGE", message, {
    pointer: "/markdown",
    reason,
    limit,
    actual,
    ...(line !== undefined ? { line } : {}),
  });
}

/** Jumlah baris (LF) tanpa membuat array. */
function countLines(src: string): number {
  let n = 1;
  for (let k = src.indexOf("\n"); k >= 0; k = src.indexOf("\n", k + 1)) n++;
  return n;
}

const NUMERIC_KEY = new RegExp(CHAPTER_KEY_NUMERIC_PATTERN);
const LETTER_KEY = new RegExp(CHAPTER_KEY_LETTER_PATTERN);
const ASSET_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Alias label bukti naskah Hermes -> tanda provenans kontrak. Hanya dua yang berbukti di
 * pemetaan Hermes sendiri (convert.py: baris [PUBLIC-SOURCE]/[VENDOR] -> TERUKUR/PEMASOK);
 * label lain ([ASSESSED], [EXECUTED-DOC], [GSP-STATEMENT]) TIDAK ditebak (peringatan).
 */
const MARK_ALIASES: Readonly<Record<string, ProvenanceMark>> = {
  "PUBLIC-SOURCE": "TERUKUR",
  VENDOR: "PEMASOK",
};
const PROVENANCE_SET: ReadonlySet<string> = new Set<string>(PROVENANCE_MARKS);
const RAIL_KIND_WORDS: Readonly<Record<string, "source" | "note">> = {
  SUMBER: "source",
  SOURCE: "source",
  CATATAN: "note",
  NOTE: "note",
};

const LEAD_TOKEN_RE = /^\[([A-Z][A-Z-]{2,})(?::\s*([^\]]*))?\][ \t]*/;
const PLACEHOLDER_RE = /^\[(?:FIGUR|FIGURE|FIG-[A-Za-z0-9]+)\b[^\]\n]*\]$/;
const IMAGE_RE = /^!\[([^\]]*)\]\(\s*<?([^\s)<>]+)>?(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?\s*\)$/;
const LABEL_EMPH_RE = /^(\*{1,2}|_{1,2})((?:Tabel|Table|Gambar|Figure|Fig\.|Sumber|Source)\b[^*_\n]*?[.:])\1[ \t]*/i;
const TABLE_CAP_RE = /^(?:Tabel|Table)(\s+[A-Z]?[0-9]+(?:[.-][0-9]+)*)?\s*[.:]\s+([\s\S]+)$/;
const FIG_CAP_RE = /^(?:Gambar|Figure|Fig\.)(\s+[A-Z]?[0-9]+(?:[.-][0-9]+)*)?\s*[.:]\s+([\s\S]+)$/;
const SOURCE_RE = /^(?:Sumber|Source)\s*:\s*([\s\S]+)$/i;
const SOURCE_MARK_RE = /\[(TERUKUR|DITURUNKAN|PEMASOK|ASUMSI|PUBLIC-SOURCE|VENDOR)\]/g;
const SECTION_NUM_RE = /^((?:[A-Z]|[0-9]+)(?:\.[0-9]+)+\.?)\s+([\s\S]+)$/;
const ALERT_RE = /^\[!([A-Za-z]+)\][ \t]*(.*)$/;
const ASIDE_VARIANTS: Readonly<Record<string, AsideV2["variant"]>> = {
  DOCTRINE: "doctrine",
  STORY: "story",
  QUICKCHECK: "quickCheck",
  IFINDOUBT: "ifInDoubt",
  GENERIC: "generic",
  NOTE: "generic",
  TIP: "generic",
  IMPORTANT: "generic",
  WARNING: "generic",
  CAUTION: "generic",
};
const NUMERAL_CELL_RE = /^[−+-]?(?:\d{1,3}(?:[.,]\d{3})+|\d+)(?:[.,]\d+)?\s*%?$/;

/**
 * Konvensi peran paragraf EKSPLISIT (FIX-HR1, D-332/D-333): komentar HTML sebaris sendiri
 * `<!-- role: closingAction -->` TEPAT sebelum paragraf memberi paragraf itu `role` (nilai
 * `PARAGRAPH_ROLES_V2`, peka huruf). Komentar tidak pernah tampil di penampil Markdown mana
 * pun dan importer lama membuangnya (`HTML_COMMENT`), jadi penanda tidak bocor sebagai teks.
 * Tanpa tebakan: nama tak dikenal -> `ROLE_UNKNOWN`; tidak diikuti paragraf biasa ->
 * `ROLE_MARKER_UNATTACHED`; di dalam paragraf -> `ROLE_MARKER_INLINE` (diabaikan).
 */
const ROLE_MARKER_RE = /^<!--[ \t]*role[ \t]*:[ \t]*([A-Za-z][A-Za-z0-9_-]{0,39})[ \t]*-->$/;
const ROLE_MARKER_INLINE_RE = /<!--[ \t]*role[ \t]*:/;
const ROLE_SET: ReadonlySet<string> = new Set<string>(PARAGRAPH_ROLES_V2);

interface RoleMarker {
  role: ParagraphRoleV2;
  line: number;
}

/** Konteks pelaporan berbaris. */
class Reporter {
  readonly report: MdImportReport = { importer: MD_IMPORTER_VERSION, warnings: [], dropped: [], mapping: [] };
  line = 0;
  private omittedWarnings = 0;
  private omittedDropped = 0;

  warn(code: string, message: string, line = this.line): void {
    if (this.report.warnings.length >= MD_REPORT_MAX_ENTRIES) this.omittedWarnings++;
    else this.report.warnings.push({ code, line, message });
  }

  drop(code: string, kind: MdDropKind, excerpt: string, line = this.line): void {
    if (this.report.dropped.length >= MD_REPORT_MAX_ENTRIES) this.omittedDropped++;
    else this.report.dropped.push({ code, line, kind, excerpt: excerptOf(excerpt) });
  }

  /** Ringkas entri yang tidak dimuat (laporan berbatas: masukan patologis tidak memperbesar respons). */
  finish(): void {
    if (this.omittedWarnings === 0 && this.omittedDropped === 0) return;
    this.report.warnings.push({
      code: "REPORT_TRUNCATED",
      line: 0,
      message: `report capped at ${MD_REPORT_MAX_ENTRIES} entries per list: ${this.omittedWarnings} more warning(s) and ${this.omittedDropped} more dropped entr(ies) omitted`,
    });
  }

  map(md: MdConstruct, pointer: string, line = this.line): void {
    this.report.mapping.push({ line, md, pointer });
  }

  sink(): InlineSink {
    return { warn: (c, m) => this.warn(c, m), drop: (c, k, e) => this.drop(c, k, e) };
  }
}

function normalizeSource(md: string): string {
  return md.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

/** Lepas penekanan yang membungkus label (`**Tabel 3.1.** x` -> `Tabel 3.1. x`) atau seluruh baris. */
function unwrapLabel(text: string): string {
  const t = text.trim();
  const whole = /^(\*{1,2}|_{1,2})([^*_][\s\S]*?)\1$/.exec(t);
  const base = whole ? whole[2].trim() : t;
  return base.replace(LABEL_EMPH_RE, "$2 ");
}

function chapterTitleOf(raw: string, key: string, rep: Reporter): string {
  const t = raw.trim();
  const prefixed = /^(?:bab|chapter|lampiran|appendix)\s+([0-9]+|[A-Za-z])\b\s*(?:[.:\-–—]\s*)?([\s\S]*)$/i.exec(t);
  let num: string | null = null;
  let title = t;
  if (prefixed && prefixed[2].trim()) {
    num = prefixed[1];
    title = prefixed[2].trim();
  } else {
    // Angka selalu nomor tampilan; huruf tunggal hanya bila sama dengan kunci lampiran.
    const m = /^([0-9]+|[A-Z])(?:\.|\s*[:\-–—])\s+([\s\S]+)$/.exec(t);
    const numbered = m && (/^[0-9]/.test(m[1]) || m[1] === key) ? m : null;
    if (numbered) {
      num = numbered[1];
      title = numbered[2].trim();
    }
  }
  if (num !== null) {
    rep.drop("NUMBERING", "display", t.slice(0, t.length - title.length).trim() || num);
    if (num.toUpperCase() !== key.toUpperCase()) rep.warn("CHAPTER_NUMBER_MISMATCH", `heading number "${num}" differs from chapterKey "${key}"; chapterKey wins (labels are engine-generated)`);
  }
  return title;
}

function sectionTitleOf(raw: string, rep: Reporter): string {
  const t = raw.trim();
  const m = SECTION_NUM_RE.exec(t);
  if (!m) return t;
  rep.drop("NUMBERING", "display", m[1]);
  return m[2].trim();
}

/** Penanda rel di awal paragraf/butir -> RailLineV2[] + sisa teks. */
function extractRail(text: string, rep: Reporter): { rail: RailLineV2[]; rest: string } {
  const rail: RailLineV2[] = [];
  const seen = new Set<string>();
  let rest = text;
  for (;;) {
    const m = LEAD_TOKEN_RE.exec(rest);
    if (!m) break;
    const word = m[1];
    const note = (m[2] ?? "").trim();
    let line: RailLineV2 | null = null;
    if (PROVENANCE_SET.has(word) || MARK_ALIASES[word]) {
      const mark = (MARK_ALIASES[word] ?? word) as ProvenanceMark;
      line = note ? { kind: "mark", mark, text: note } : { kind: "mark", mark };
      if (MARK_ALIASES[word]) rep.warn("MARK_ALIAS", `rail marker [${word}] mapped to provenance ${mark}`);
    } else if (RAIL_KIND_WORDS[word] && note) {
      line = { kind: RAIL_KIND_WORDS[word], text: note };
    } else {
      rep.warn("UNMAPPED_MARKER", `leading marker [${word}] has no contract provenance mapping; kept as text`);
      break;
    }
    const k = JSON.stringify(line);
    if (!seen.has(k)) {
      seen.add(k);
      rail.push(line);
    }
    rest = rest.slice(m[0].length);
  }
  return { rail, rest };
}

function sourceOf(raw: string, rep: Reporter): SourceV2 | null {
  const marks: ProvenanceMark[] = [];
  const text = raw
    .replace(SOURCE_MARK_RE, (_m, w: string) => {
      const mark = (MARK_ALIASES[w] ?? w) as ProvenanceMark;
      if (!marks.includes(mark)) marks.push(mark);
      return " ";
    })
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!text) return null;
  const inline = parseInline(text, rep.sink());
  return marks.length > 0 ? { ...inline, provenance: marks } : { ...inline };
}

/** Rujukan aset gambar -> nilai `ImageV2.asset`, atau null bila tidak didukung. */
function assetOf(ref: string, rep: Reporter): string | null {
  const r = ref.trim();
  if (/^sha256:[0-9a-fA-F]{64}$/.test(r)) return `sha256:${r.slice(7).toLowerCase()}`;
  if (/^[0-9a-fA-F]{64}$/.test(r)) return `sha256:${r.toLowerCase()}`;
  if (ASSET_KEY.test(r)) {
    rep.warn("ASSET_KEY_NEEDS_ASSETS_MAP", `image asset key "${r}" must be supplied in the submission "assets" map`);
    return r;
  }
  return null;
}

interface Attach {
  caption?: { text: string; line: number; num?: string };
  source?: { text: string; line: number };
}

function paragraphText(b: MdBlock | undefined): string | null {
  return b && b.kind === "paragraph" ? unwrapLabel(b.text) : null;
}

/** Pasangkan baris caption/sumber dengan tabel dan gambar di dekatnya (konsumsi paragrafnya). */
function attachFigures(blocks: MdBlock[]): { attach: Map<number, Attach>; consumed: Set<number> } {
  const attach = new Map<number, Attach>();
  const consumed = new Set<number>();
  blocks.forEach((b, t) => {
    const isImage = b.kind === "paragraph" && IMAGE_RE.test(b.text.trim());
    if (b.kind !== "table" && !isImage) return;
    const capRe = b.kind === "table" ? TABLE_CAP_RE : FIG_CAP_RE;
    const a: Attach = {};
    for (let k = t + 1; k <= t + 2 && k < blocks.length; k++) {
      const pt = paragraphText(blocks[k]);
      if (pt === null || consumed.has(k)) break;
      const cm = capRe.exec(pt);
      const sm = SOURCE_RE.exec(pt);
      if (cm && !a.caption) a.caption = { text: cm[2], line: blocks[k].line, ...(cm[1] ? { num: cm[1].trim() } : {}) };
      else if (sm && !a.source) a.source = { text: sm[1], line: blocks[k].line };
      else break;
      consumed.add(k);
    }
    if (!a.caption && b.kind === "table" && t > 0 && !consumed.has(t - 1)) {
      const pt = paragraphText(blocks[t - 1]);
      const cm = pt !== null ? TABLE_CAP_RE.exec(pt) : null;
      if (cm) {
        a.caption = { text: cm[2], line: blocks[t - 1].line, ...(cm[1] ? { num: cm[1].trim() } : {}) };
        consumed.add(t - 1);
      }
    }
    attach.set(t, a);
  });
  return { attach, consumed };
}

/**
 * Komentar HTML dibuang. FIX-HR1 (D-334 H-01): regex hanya diterapkan sampai `-->` terakhir;
 * sesudahnya tidak ada penutup sehingga regex lama tidak cocok di sana, tetapi tiap `<!--`
 * tanpa penutup memindai sampai akhir blok (O(n^2) untuk `<!--` beruntun). Hasil identik.
 */
function stripHtmlComments(raw: string): string {
  const last = raw.lastIndexOf("-->");
  if (last < 0) return raw;
  const cut = last + 3;
  return raw.slice(0, cut).replace(/<!--[\s\S]*?-->/g, " ") + raw.slice(cut);
}

function htmlText(raw: string): string {
  return stripHtmlComments(raw)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?[A-Za-z][^<>]*>/g, " ")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l) => l !== "")
    .join("\n");
}

/** Pengonversi berkeadaan: satu panggilan = satu bab. */
class Converter {
  readonly rep = new Reporter();
  title: InlineV2 | null = null;
  titleLine = 0;
  readonly intro: BlockV2[] = [];
  readonly sections: SectionV2[] = [];

  constructor(private readonly opts: MarkdownImportOptions) {}

  private target(): { blocks: BlockV2[]; base: string } {
    const s = this.sections.length;
    return s === 0 ? { blocks: this.intro, base: "/chapter/intro" } : { blocks: this.sections[s - 1].blocks, base: `/chapter/sections/${s - 1}/blocks` };
  }

  private emit(block: BlockV2, md: MdConstruct): void {
    const t = this.target();
    t.blocks.push(block);
    this.rep.map(md, `${t.base}/${t.blocks.length - 1}`);
  }

  private inline(text: string): InlineV2 {
    return parseInline(text, this.rep.sink());
  }

  private openSection(rawTitle: string, md: MdConstruct): void {
    const title = sectionTitleOf(rawTitle, this.rep);
    if (!title) this.rep.warn("SECTION_TITLE_EMPTY", "section heading has no text");
    this.sections.push({ title: this.inline(title), blocks: [] });
    this.rep.map(md, `/chapter/sections/${this.sections.length - 1}`);
  }

  heading(b: Extract<MdBlock, { kind: "heading" }>): void {
    if (b.level === 1) {
      if (this.title === null && this.sections.length === 0) {
        this.title = this.inline(chapterTitleOf(b.text, this.opts.chapterKey, this.rep));
        this.titleLine = b.line;
        this.rep.map("heading1", "/chapter/title");
        return;
      }
      this.rep.warn("EXTRA_H1_AS_SECTION", "only one # chapter title per file; this # heading became a section");
      this.openSection(b.text, "heading1");
      return;
    }
    if (b.level === 2) {
      this.openSection(b.text, "heading2");
      return;
    }
    if (b.level > 3) this.rep.warn("HEADING_LEVEL_FLATTENED", `h${b.level} mapped to a subheading paragraph (the contract has no deeper section level)`);
    if (!b.text) {
      this.rep.drop("EMPTY_HEADING", "content", "#".repeat(b.level));
      return;
    }
    this.emit({ type: "paragraph", role: "subheading", ...this.inline(b.text) }, "heading3");
  }

  /** `true` bila paragraf biasa dikeluarkan (penanda peran hanya berlaku untuknya). */
  paragraph(b: Extract<MdBlock, { kind: "paragraph" }>, attach: Attach | undefined, role?: ParagraphRoleV2): boolean {
    const trimmed = b.text.trim();
    const img = IMAGE_RE.exec(trimmed);
    if (img) {
      this.image(img, attach);
      return false;
    }
    if (PLACEHOLDER_RE.test(trimmed)) {
      this.rep.drop("FIGURE_PLACEHOLDER", "content", trimmed);
      this.rep.warn("FIGURE_PLACEHOLDER", "figure placeholder dropped: upload the asset and use ![caption](sha256:...) with a Sumber: line, or submit a chart/diagram block");
      return false;
    }
    if (SOURCE_RE.test(unwrapLabel(trimmed))) this.rep.warn("SOURCE_ORPHAN", "Sumber:/Source: line is not adjacent to a table or image; kept as a paragraph");
    if (ROLE_MARKER_INLINE_RE.test(b.text)) {
      this.rep.warn("ROLE_MARKER_INLINE", `role marker inside a paragraph is ignored: put "<!-- role: <name> -->" on its own line directly before the paragraph`);
    }
    const { rail, rest } = extractRail(b.text, this.rep);
    const runs = parseInlineRuns(rest, this.rep.sink());
    if (runs.length === 0 && rail.length === 0) return false;
    const inline = runs.length === 0 ? { text: "" } : inlineOfRuns(runs);
    this.emit({ type: "paragraph", ...(role ? { role } : {}), ...inline, ...(rail.length > 0 ? { rail } : {}) }, "paragraph");
    return true;
  }

  /** Penanda peran yang tidak diikuti paragraf biasa: tidak diterapkan ke blok lain (tanpa tebakan). */
  private roleUnattached(m: RoleMarker): void {
    this.rep.warn("ROLE_MARKER_UNATTACHED", `role marker "${m.role}" is not directly followed by a paragraph; ignored`, m.line);
  }

  private image(m: RegExpExecArray, attach: Attach | undefined): void {
    const raw = m[0];
    const alt = m[1].trim();
    const titleAttr = (m[3] ?? m[4] ?? m[5] ?? "").trim();
    let caption = alt;
    const fig = FIG_CAP_RE.exec(alt);
    if (fig) {
      caption = fig[2].trim();
      if (fig[1]) this.rep.drop("NUMBERING", "display", fig[1].trim());
    }
    if (attach?.caption) {
      if (caption) this.rep.drop("CAPTION_DUPLICATE", "content", attach.caption.text, attach.caption.line);
      else {
        caption = attach.caption.text.trim();
        if (attach.caption.num) this.rep.drop("NUMBERING", "display", attach.caption.num, attach.caption.line);
      }
    }
    let sourceRaw = attach?.source?.text ?? "";
    if (!sourceRaw && titleAttr) sourceRaw = titleAttr.replace(/^(?:Sumber|Source)\s*:\s*/i, "");
    else if (sourceRaw && titleAttr) this.rep.drop("IMAGE_TITLE_IGNORED", "content", titleAttr);
    const asset = assetOf(m[2], this.rep);
    if (!caption) {
      this.rep.drop("IMAGE_CAPTION_MISSING", "content", raw);
      this.rep.warn("IMAGE_CAPTION_MISSING", "image dropped: caption is mandatory (alt text or a Gambar n.m. line)");
      return;
    }
    if (asset === null) {
      this.rep.drop("IMAGE_REF_UNSUPPORTED", "content", raw);
      this.rep.warn("IMAGE_REF_UNSUPPORTED", "image dropped: reference must be sha256:<64 hex>, a bare 64-hex sha, or an assets-map key (upload via POST /api/studio/assets first)");
      return;
    }
    const source = sourceRaw ? sourceOf(sourceRaw, this.rep) : null;
    if (source === null) {
      this.rep.drop("IMAGE_SOURCE_MISSING", "content", raw);
      this.rep.warn("IMAGE_SOURCE_MISSING", 'image dropped: source is mandatory (a "Sumber: ..." line after the image or the link title)');
      return;
    }
    this.emit({ type: "image", asset, caption: this.inline(caption), source }, "image");
  }

  list(b: Extract<MdBlock, { kind: "list" }>): void {
    const items: Array<InlineV2 & { rail?: RailLineV2[] }> = [];
    const maxDepth = b.items.reduce((d, it) => Math.max(d, it.depth), 0);
    for (const it of b.items) {
      this.rep.line = it.line;
      const { rail, rest } = extractRail(it.text.replace(/\n\n/g, "\n"), this.rep);
      const runs = parseInlineRuns(rest, this.rep.sink());
      if (runs.length === 0 && rail.length === 0) continue;
      const inline = runs.length === 0 ? { text: "" } : inlineOfRuns(runs);
      items.push(rail.length > 0 ? { ...inline, rail } : inline);
    }
    this.rep.line = b.line;
    if (maxDepth > 0) {
      const nested = b.items.filter((it) => it.depth > 0).length;
      this.rep.drop("LIST_NESTING", "structure", `${nested} nested item(s), depth ${maxDepth} flattened into one list (contract lists are flat)`);
    }
    if (items.length === 0) {
      this.rep.drop("EMPTY_LIST", "content", "list without text");
      return;
    }
    this.emit({ type: "list", ...(b.ordered ? { ordered: true } : {}), items }, "list");
  }

  table(b: Extract<MdBlock, { kind: "table" }>, attach: Attach | undefined): void {
    const ncol = b.header.length;
    if (ncol > MD_IMPORT_MAX_TABLE_COLUMNS) {
      // Sebelum pengisian sel kosong: lebar x baris dapat jauh melampaui ukuran masukan.
      throw tooLarge("MD_TABLE_TOO_WIDE", `table at line ${b.line} has ${ncol} columns; the importer accepts at most ${MD_IMPORT_MAX_TABLE_COLUMNS} (the contract allows 1..20)`, MD_IMPORT_MAX_TABLE_COLUMNS, ncol, b.line);
    }
    if (b.aligned) this.rep.drop("TABLE_ALIGNMENT", "display", "column alignment markers (:---:)");
    const cellOf = (text: string): CellV2 => {
      if (!text) return {};
      const inline = this.inline(text);
      return "text" in inline ? { text: inline.text } : { runs: inline.runs };
    };
    const rows: RowV2[] = [{ kind: "header", cells: b.header.map(cellOf) }];
    const bodyTexts: string[][] = [];
    for (const r of b.rows) {
      this.rep.line = r.line;
      let cells = r.cells;
      if (cells.length > ncol) {
        this.rep.drop("TABLE_CELL_OVERFLOW", "content", cells.slice(ncol).join(" | "));
        this.rep.warn("TABLE_CELL_OVERFLOW", `row has ${cells.length} cells but the header has ${ncol}; extra cells dropped`);
        cells = cells.slice(0, ncol);
      }
      if (cells.length < ncol) cells = [...cells, ...new Array<string>(ncol - cells.length).fill("")];
      bodyTexts.push(cells);
      rows.push({ kind: "body", cells: cells.map(cellOf) });
    }
    this.rep.line = b.line;
    if (ncol > 20) this.rep.warn("TABLE_TOO_WIDE", `table has ${ncol} columns; the contract allows 1..20`);
    const columns: ColumnV2[] = Array.from({ length: ncol }, (_, c) => {
      const vals = bodyTexts.map((row) => row[c]).filter((v) => v !== "");
      return vals.length > 0 && vals.every((v) => NUMERAL_CELL_RE.test(v)) ? { role: "numeral" } : { role: "text" };
    });
    let caption: InlineV2 | undefined;
    if (attach?.caption) {
      caption = this.inline(attach.caption.text.trim());
      if (attach.caption.num) this.rep.drop("NUMBERING", "display", attach.caption.num, attach.caption.line);
    }
    const source = attach?.source ? sourceOf(attach.source.text, this.rep) : null;
    if (caption && !source) this.rep.warn("TABLE_SOURCE_MISSING", 'captioned table without a "Sumber: ..." line; the DATUM-10 gate rejects it on submit');
    this.emit({ type: "table", ...(caption ? { caption } : {}), columns, rows, ...(source ? { source } : {}) }, "table");
  }

  code(b: Extract<MdBlock, { kind: "code" }>): void {
    if (b.unclosed) this.rep.warn("CODE_FENCE_UNCLOSED", "code fence is not closed; it runs to the end of the file");
    const words = b.info.split(/\s+/).filter(Boolean);
    let label = words.length > 1 ? words.slice(1).join(" ") : (words[0] ?? "");
    if (!label) {
      label = this.opts.language === "EN" ? "Code" : "Kode";
      this.rep.warn("MONOBLOCK_LABEL_DEFAULTED", `code block without an info string; label "${label}" used`);
    }
    const lines = [...b.lines];
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    if (lines.length === 0) {
      this.rep.drop("EMPTY_CODE_BLOCK", "content", b.info || "```");
      return;
    }
    this.emit({ type: "monoBlock", label: plainInline(label), lines: lines.map((l) => plainInline(l)) }, "code");
  }

  quote(b: Extract<MdBlock, { kind: "quote" }>): void {
    const lines = [...b.lines];
    let variant: AsideV2["variant"] = "generic";
    let label: InlineV2 | undefined;
    const am = lines.length > 0 ? ALERT_RE.exec(lines[0].trim()) : null;
    if (am) {
      const v = ASIDE_VARIANTS[am[1].toUpperCase()];
      if (v) {
        variant = v;
        if (am[2].trim()) label = this.inline(am[2].trim());
        lines.shift();
      } else this.rep.warn("ASIDE_VARIANT_UNKNOWN", `blockquote alert [!${am[1]}] is not an aside variant; kept as text`);
    }
    const paras: string[] = [];
    let cur: string[] = [];
    for (const l of lines) {
      if (l.trim() === "") {
        if (cur.length) paras.push(cur.join("\n"));
        cur = [];
      } else cur.push(l.replace(/^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/, "").replace(/^ {0,3}#{1,6}[ \t]+/, ""));
    }
    if (cur.length) paras.push(cur.join("\n"));
    const body = paras.map((p) => this.inline(p)).filter((i) => inlineText(i).trim() !== "");
    if (body.length === 0) {
      this.rep.drop("EMPTY_BLOCKQUOTE", "content", ">");
      return;
    }
    this.emit({ type: "aside", variant, ...(label ? { label } : {}), body }, "blockquote");
  }

  /** Penanda peran menunggu paragraf berikutnya (FIX-HR1, konvensi `<!-- role: X -->`). */
  private pendingRole: RoleMarker | null = null;

  html(b: Extract<MdBlock, { kind: "html" }>): void {
    const tag = b.tag;
    if (tag === "!--") {
      const rm = ROLE_MARKER_RE.exec(b.raw.trim());
      if (rm) {
        const name = rm[1];
        if (ROLE_SET.has(name)) {
          this.pendingRole = { role: name as ParagraphRoleV2, line: b.line };
          return;
        }
        this.rep.warn("ROLE_UNKNOWN", `role marker "${name}" is not a paragraph role (${PARAGRAPH_ROLES_V2.join(", ")}); ignored`);
      }
      this.rep.drop("HTML_COMMENT", "html", b.raw);
      return;
    }
    if (tag === "style" || tag === "script" || tag === "textarea") {
      this.rep.drop("HTML_RAW_BLOCK", "html", b.raw);
      return;
    }
    if (tag === "table" || tag === "img" || tag === "iframe" || /<(table|img|iframe)\b/i.test(b.raw)) {
      this.rep.drop("HTML_UNSUPPORTED_CONTENT", "content", b.raw);
      this.rep.warn("HTML_UNSUPPORTED_CONTENT", `raw HTML <${tag}> dropped with its content: write it as a GFM table or ![caption](sha256:...) image`);
      return;
    }
    this.rep.drop("HTML_BLOCK", "html", b.raw);
    const text = htmlText(b.raw);
    if (!text) return;
    this.emit({ type: "paragraph", ...this.inline(text.replace(/\n/g, "  \n")) }, "html");
  }

  run(blocks: MdBlock[]): void {
    const { attach, consumed } = attachFigures(blocks);
    blocks.forEach((b, idx) => {
      this.rep.line = b.line;
      // Penanda peran hanya berlaku untuk blok TEPAT sesudahnya, dan hanya bila itu paragraf biasa.
      const role = this.pendingRole;
      this.pendingRole = null;
      if (role && (consumed.has(idx) || b.kind !== "paragraph")) this.roleUnattached(role);
      if (consumed.has(idx)) return;
      switch (b.kind) {
        case "frontMatter":
          this.rep.drop("FRONT_MATTER", "structure", b.raw);
          return;
        case "heading":
          this.heading(b);
          return;
        case "paragraph":
          if (!this.paragraph(b, attach.get(idx), role?.role) && role) this.roleUnattached(role);
          return;
        case "list":
          this.list(b);
          return;
        case "table":
          this.table(b, attach.get(idx));
          return;
        case "code":
          this.code(b);
          return;
        case "quote":
          this.quote(b);
          return;
        case "html":
          this.html(b);
          return;
        case "hr":
          this.rep.drop("THEMATIC_BREAK", "display", b.raw);
          return;
      }
    });
    if (this.pendingRole) this.roleUnattached(this.pendingRole);
    this.pendingRole = null;
  }
}

function assertOptions(markdown: unknown, opts: MarkdownImportOptions): asserts markdown is string {
  if (typeof markdown !== "string" || markdown.trim() === "") {
    throw new StudioEngineError("SCHEMA_INVALID", "markdown must be a non-empty string", [{ pointer: "/markdown", keyword: "minLength", message: "must be a non-empty string" }]);
  }
  if (markdown.length > MD_IMPORT_MAX_CHARS) {
    throw tooLarge("MD_TOO_LONG", `markdown exceeds ${MD_IMPORT_MAX_CHARS} characters`, MD_IMPORT_MAX_CHARS, markdown.length);
  }
  if (typeof opts.chapterKey !== "string" || !(NUMERIC_KEY.test(opts.chapterKey) || LETTER_KEY.test(opts.chapterKey))) {
    throw new StudioEngineError("CHAPTER_KEY_INVALID", `chapterKey must match ${CHAPTER_KEY_NUMERIC_PATTERN} (chapter) or ${CHAPTER_KEY_LETTER_PATTERN} (appendix)`, {
      pointer: "/chapterKey",
    });
  }
}

/**
 * Markdown satu bab -> `{ chapter, submission?, report, validation }`. Melempar
 * `StudioEngineError` hanya untuk masukan yang tidak dapat diubah (markdown kosong, kunci bab
 * tidak sah, tanpa judul); isi yang tidak dapat dipetakan dilaporkan, bukan dilempar.
 */
export function importMarkdownChapter(markdown: string, opts: MarkdownImportOptions): MarkdownImportResult {
  assertOptions(markdown, opts);
  const src = normalizeSource(markdown);
  const lineCount = countLines(src);
  if (lineCount > MD_IMPORT_MAX_LINES) {
    throw tooLarge("MD_TOO_MANY_LINES", `markdown has ${lineCount} lines; the importer accepts at most ${MD_IMPORT_MAX_LINES} per chapter`, MD_IMPORT_MAX_LINES, lineCount);
  }
  const blocks = lexMarkdown(src);
  if (blocks.length > MD_IMPORT_MAX_BLOCKS) {
    throw tooLarge("MD_TOO_MANY_BLOCKS", `markdown has ${blocks.length} blocks; the importer accepts at most ${MD_IMPORT_MAX_BLOCKS} per chapter`, MD_IMPORT_MAX_BLOCKS, blocks.length);
  }
  const conv = new Converter(opts);
  conv.run(blocks);
  const rep = conv.rep;

  let title = conv.title;
  if (typeof opts.title === "string" && opts.title.trim() !== "") {
    const given = plainInline(opts.title.trim());
    if (title !== null && inlineText(title) !== inlineText(given)) rep.warn("TITLE_OVERRIDDEN", "title option replaces the # heading", conv.titleLine);
    title = given;
  }
  if (title === null || inlineText(title).trim() === "") {
    throw new StudioEngineError("SCHEMA_INVALID", "chapter title missing: add a # heading or pass title", [{ pointer: "/title", keyword: "required", message: "chapter title is required" }]);
  }
  if (conv.sections.length === 0) rep.warn("NO_SECTIONS", "no ## heading: all content is in chapter.intro", 0);
  rep.finish();

  const chapter: ChapterV2 = {
    key: opts.chapterKey,
    title,
    ...(conv.intro.length > 0 ? { intro: conv.intro } : {}),
    sections: conv.sections,
  };
  const env = opts.envelope;
  const submission: StudioChapterV2 | undefined = env
    ? {
        $schema: "studio.chapter/v2",
        ...(opts.agentId ? { agentId: opts.agentId } : {}),
        target: env.target,
        ...(env.template ? { template: env.template } : {}),
        ...(env.meta ? { meta: env.meta } : {}),
        ...(env.slot ? { slot: env.slot } : {}),
        chapter,
      }
    : undefined;
  const validation = validateImported(chapter, submission);
  return { chapter, ...(submission ? { submission } : {}), report: rep.report, validation };
}
