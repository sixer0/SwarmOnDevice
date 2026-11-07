/**
 * C17 / ST-01 (research/37 R2-R6, register research/38 §1.2 R-77 + §3.6, D-594 U3, D-631): indeks
 * aturan STD yang DITURUNKAN dari isi dokumen, tanpa medan kiriman baru. Satu pembangun murni
 * (isi -> entri) dipakai perakit DOCX (`docx/assemble/units.ts`) dan HTML (`html/assemble/slots.ts`).
 *
 * Penanda rumah (R2): kode aturan + kata tingkat di AWAL judul section (M1, boleh diawali nomor
 * section), teks paragraf atau butir daftar (M2), atau baris rail `kind: "note"` paragraf/butir (M3).
 * Kode tanpa tingkat = kutipan (diabaikan). Tabel, aside, monoBlock, derivation, caption, SOURCE,
 * judul bab, halaman depan dan `x` tidak dipindai. Hanya bab dan lampiran `snapshot.doc` yang dibaca
 * (struktur dokumen utuh, juga pada render lingkup slot yang sudah menyaring blok).
 *
 * Entri (R3): kode apa adanya, ringkas = kalimat pertama maks 12 kata ("…" hanya bila terpotong),
 * tingkat apa adanya (+ " (PK)"), bab = kunci bab / label outline penomoran sumber / "Lampiran A".
 * Urutan menurut kode (R4: keluarga urutan manual, angka per bagian, akhiran huruf sesudah angka
 * polos); satu entri per kode, kemunculan pertama menang, tambahan dilaporkan.
 *
 * Kosong (R5): pemanggil mempertahankan perilaku D-299 (seksi slot opsional dihilangkan); baris
 * kosong hanya bila unit memang tetap dirender. Tanpa caption, tanpa nomor halaman (R3, risiko DT-15).
 */
import type { NormBlock, RenderLogEntry, TableBlock } from "../../contract";
import { RULE_INDEX_TEXT, chapterLabelText, wrapperLangOf, type WrapperLang } from "./texts";

/** R-77: indeks aturan dari penanda kode di isi (bawaan false = penanda saja + D-299). */
export const PARAM_RULE_INDEX_FROM_MARKERS = "render.ruleIndex.fromMarkers";

export interface RuleIndexEntry {
  code: string;
  summary: string;
  /** Kata tingkat apa adanya, + " (PK)" bila tertangkap. */
  level: string;
  /** Kolom bab: kunci bab, label outline (penomoran sumber), atau "Lampiran A" / "Annex A". */
  chapter: string;
  /** Alamat rumah: `C.S` (judul section) atau `C.S.P` (blok). */
  address: string;
}

export interface RuleIndexDuplicate {
  code: string;
  address: string;
  level: string;
  firstAddress: string;
  firstLevel: string;
}

export interface RuleIndexResult {
  entries: RuleIndexEntry[];
  duplicates: RuleIndexDuplicate[];
}

/** Bentuk minimal snapshot yang dibaca pembangun (studio.norm/v2). */
export interface RuleIndexSource {
  doc: {
    meta?: { language?: string };
    chapters?: readonly unknown[];
    appendices?: readonly unknown[];
  };
  source?: { sections?: Readonly<Record<string, unknown>> };
  skeleton?: { slots?: ReadonlyArray<{ slotKey: string; sectionType: string }> };
}

// ── Tata bahasa penanda (R2) ─────────────────────────────────────────────

const CODE_SRC = String.raw`DT-\d{2}[a-z]?|(?:PK|TB|GA|KD|CH|SM|IL|BP|EG)-\d{2}|SG-L\d-\d{2}|EN-L\d-\d{2}|EN-C-\d{2}`;
const LEVEL_SRC = "WAJIB|BAKU|ANJURAN|MANDATORY|DEFAULT|ADVISORY";
const MD = "[*_`]*";
const SEP_PUNCT = "[·•|:,—–(]";
/**
 * C35 H-01 (CWE-1333): pemisah kode-tingkat ditulis tanpa dua kuantor bersebelahan atas karakter
 * yang sama. Bahasanya sama persis dengan bentuk lama `MD \s* (punct \s*)? MD`:
 * md-lite, lalu (spasi, punct opsional, md-lite) | (punct, spasi, md-lite) | kosong.
 */
const SEP = String.raw`${MD}(?:\s+(?:${SEP_PUNCT}\s*)?${MD}|${SEP_PUNCT}\s*${MD})?`;
const MARKER_RE = new RegExp(
  String.raw`^${MD}(${CODE_SRC})(?![A-Za-z0-9-])${SEP}(${LEVEL_SRC})${MD}\)?(\s*\(PK\))?(?=$|[\s.:;,·•|—–)])`,
);
/** C35 H-01: penanda selalu di awal teks; pemindaian dibatasi ke awal ini. */
const MARKER_SCAN_MAX = 256;
const SECTION_NUMBER_RE = /^\d{1,3}(?:\.\d{1,3})*\.?\s+/;
const LEAD_PUNCT_RE = /^[\s.:;,·•|—–\-)*_`]+/;
const SENTENCE_END_RE = /[.!?](?=\s|$)/;
const SUMMARY_MAX_WORDS = 12;

interface Marker {
  code: string;
  level: string;
  rest: string;
}

function plainOf(v: unknown): string {
  if (!v || typeof v !== "object") return "";
  const o = v as { text?: unknown; runs?: unknown };
  const raw = typeof o.text === "string" ? o.text : Array.isArray(o.runs) ? o.runs.map((r) => (r && typeof (r as { t?: unknown }).t === "string" ? (r as { t: string }).t : "")).join("") : "";
  return raw.replace(/\u00a0/g, " ");
}

function matchMarker(text: string, allowSectionNumber = false): Marker | undefined {
  let s = text.trimStart();
  if (allowSectionNumber) s = s.replace(SECTION_NUMBER_RE, "");
  const head = s.length > MARKER_SCAN_MAX ? s.slice(0, MARKER_SCAN_MAX) : s;
  const m = MARKER_RE.exec(head);
  // Kecocokan yang menyentuh ujung potongan bisa memakai `$` palsu; penanda sah jauh lebih pendek.
  if (!m || (head.length < s.length && m[0].length === head.length)) return undefined;
  return { code: m[1], level: m[3] ? `${m[2]} (PK)` : m[2], rest: s.slice(m[0].length).replace(LEAD_PUNCT_RE, "") };
}

/** Kalimat pertama (tanpa tanda akhir), maks 12 kata; "…" hanya bila dipotong jumlah kata. */
function summaryOf(text: string): string {
  const s = text.replace(/\u00a0/g, " ").trim();
  const end = SENTENCE_END_RE.exec(s);
  const sentence = end ? s.slice(0, end.index) : s;
  const words = sentence.split(/\s+/).filter(Boolean);
  return words.length > SUMMARY_MAX_WORDS ? `${words.slice(0, SUMMARY_MAX_WORDS).join(" ")}…` : words.join(" ");
}

// ── Urutan kode (R4) ─────────────────────────────────────────────────────

const FAMILY_ORDER = ["DT", "PK", "TB", "EG", "GA", "SG", "EN-L", "KD", "CH", "SM", "IL", "BP", "EN-C"] as const;

function codeKey(code: string): { family: number; nums: number[]; suffix: string } {
  let m = /^DT-(\d{2})([a-z]?)$/.exec(code);
  if (m) return { family: 0, nums: [Number(m[1])], suffix: m[2] };
  m = /^(SG|EN)-L(\d)-(\d{2})$/.exec(code);
  if (m) return { family: FAMILY_ORDER.indexOf(m[1] === "SG" ? "SG" : "EN-L"), nums: [Number(m[2]), Number(m[3])], suffix: "" };
  m = /^EN-C-(\d{2})$/.exec(code);
  if (m) return { family: FAMILY_ORDER.indexOf("EN-C"), nums: [Number(m[1])], suffix: "" };
  m = /^([A-Z]{2})-(\d{2})$/.exec(code);
  const family = m ? FAMILY_ORDER.indexOf(m[1] as (typeof FAMILY_ORDER)[number]) : -1;
  return { family: family < 0 ? FAMILY_ORDER.length : family, nums: m ? [Number(m[2])] : [], suffix: "" };
}

/** Pembanding kode aturan menurut urutan indeks manual (ID:4530-4950, EN:4456-4719). */
export function compareRuleCodes(a: string, b: string): number {
  const ka = codeKey(a);
  const kb = codeKey(b);
  if (ka.family !== kb.family) return ka.family - kb.family;
  for (let i = 0; i < Math.max(ka.nums.length, kb.nums.length); i += 1) {
    const d = (ka.nums[i] ?? -1) - (kb.nums[i] ?? -1);
    if (d !== 0) return d;
  }
  if (ka.suffix !== kb.suffix) return ka.suffix < kb.suffix ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// ── Pembangun (R1-R4) ────────────────────────────────────────────────────

interface Hit extends Marker {
  address: string;
  chapter: string;
  summary: string;
}

function record(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Label outline penomoran sumber per kunci bab (hanya slot bab; lampiran mengabaikannya, compose F10). */
function outlineLabels(src: RuleIndexSource): Map<string, string> {
  const out = new Map<string, string>();
  const typeOf = new Map((src.skeleton?.slots ?? []).map((s) => [s.slotKey, s.sectionType] as const));
  for (const [slotKey, raw] of Object.entries(src.source?.sections ?? {})) {
    const payload = record(raw);
    if ((typeOf.get(slotKey) ?? payload?.type) !== "chapter") continue;
    const outline = Array.isArray(payload?.outline) ? payload.outline : [];
    for (const o of outline) {
      const e = record(o);
      if (e && typeof e.key === "string" && typeof e.label === "string" && e.label !== "") out.set(e.key, e.label);
    }
  }
  return out;
}

/** Penanda pada satu blok alir (paragraf / daftar) beserta rail `note`-nya, urut dokumen. */
function blockHits(b: unknown, address: string, chapter: string, push: (h: Hit) => void): void {
  const block = record(b);
  if (!block) return;
  const hosts: unknown[] = block.type === "paragraph" ? [block] : block.type === "list" && Array.isArray(block.items) ? block.items : [];
  for (const host of hosts) {
    const text = plainOf(host);
    const m = matchMarker(text);
    if (m) push({ ...m, address, chapter, summary: summaryOf(m.rest) });
    const rail = record(host)?.rail;
    if (!Array.isArray(rail)) continue;
    for (const line of rail) {
      if (record(line)?.kind !== "note") continue;
      const rm = matchMarker(plainOf(line));
      if (rm) push({ ...rm, address, chapter, summary: summaryOf(text) });
    }
  }
}

function firstParagraphText(blocks: readonly unknown[]): string {
  const first = blocks.find((b) => record(b)?.type === "paragraph");
  return first ? plainOf(first) : "";
}

/** Bangun entri indeks aturan dari isi bab dan lampiran snapshot. Murni dan deterministik. */
export function buildRuleIndex(src: RuleIndexSource): RuleIndexResult {
  const lang = wrapperLangOf(src.doc.meta as { language?: "ID" | "EN" } | undefined);
  const labels = outlineLabels(src);
  const hits: Hit[] = [];
  const push = (h: Hit) => hits.push(h);

  const scan = (raw: unknown, i: number, appendix: boolean): void => {
    const c = record(raw);
    if (!c) return;
    const key = typeof c.key === "string" && c.key !== "" ? c.key : appendix ? String.fromCharCode(65 + i) : String(i + 1);
    const chapter = appendix ? chapterLabelText(key, true, lang) : (labels.get(key) ?? key);
    const intro = Array.isArray(c.intro) ? c.intro : [];
    intro.forEach((b, k) => blockHits(b, `${key}.0.${k + 1}`, chapter, push));
    const sections = Array.isArray(c.sections) ? c.sections : [];
    sections.forEach((rawSec, j) => {
      const s = record(rawSec);
      if (!s) return;
      const blocks = Array.isArray(s.blocks) ? s.blocks : [];
      const m = matchMarker(plainOf(s.title), true);
      if (m) push({ ...m, address: `${key}.${j + 1}`, chapter, summary: summaryOf(m.rest !== "" ? m.rest : firstParagraphText(blocks)) });
      blocks.forEach((b, k) => blockHits(b, `${key}.${j + 1}.${k + 1}`, chapter, push));
    });
  };
  (src.doc.chapters ?? []).forEach((c, i) => scan(c, i, false));
  (src.doc.appendices ?? []).forEach((c, i) => scan(c, i, true));

  const first = new Map<string, RuleIndexEntry>();
  const duplicates: RuleIndexDuplicate[] = [];
  for (const h of hits) {
    const seen = first.get(h.code);
    if (seen) {
      duplicates.push({ code: h.code, address: h.address, level: h.level, firstAddress: seen.address, firstLevel: seen.level });
      continue;
    }
    first.set(h.code, { code: h.code, summary: h.summary, level: h.level, chapter: h.chapter, address: h.address });
  }
  const entries = [...first.values()].sort((a, b) => compareRuleCodes(a.code, b.code));
  return { entries, duplicates };
}

// ── Konten keluaran bersama (R6) ─────────────────────────────────────────

/** Tabel DATUM `ruleIndex` (kolom 1 peran `id`); tanpa caption, SOURCE dari tabel teks. */
export function ruleIndexTable(entries: readonly RuleIndexEntry[], lang: WrapperLang): TableBlock {
  return {
    type: "ruleIndex",
    columns: [{ role: "id" }, { role: "text" }, { role: "text" }, { role: "text" }],
    rows: [
      { kind: "header", cells: RULE_INDEX_TEXT.columns[lang].map((text) => ({ text })) },
      ...entries.map((e) => ({ cells: [{ text: e.code }, { text: e.summary }, { text: e.level }, { text: e.chapter }] })),
    ],
    source: { inline: { text: RULE_INDEX_TEXT.source[lang] } },
  };
}

/** Isi blok `section` judul seksi indeks (tanpa nomor). */
export function ruleIndexHeading(lang: WrapperLang): { title: { text: string }; number: string } {
  return { title: { text: RULE_INDEX_TEXT.title[lang] }, number: "" };
}

/** Isi blok paragraf baris kosong (hanya bila unit tetap dirender). */
export function ruleIndexEmptyParagraph(lang: WrapperLang): { type: "paragraph"; text: string } {
  return { type: "paragraph", text: RULE_INDEX_TEXT.empty[lang] };
}

// ── Penggantian penanda AUTO (dipakai DOCX dan HTML) ─────────────────────

/** Blok `ruleIndex` v2 penanda otomatis (`mode: "auto"`) tanpa entri (compose SR-08, D-299). */
export function isRuleIndexAutoMarker(b: NormBlock): boolean {
  if (b.type !== "ruleIndex") return false;
  const c = b.content as { mode?: unknown; entries?: unknown } | null;
  return !!c && typeof c === "object" && c.mode === "auto" && !(Array.isArray(c.entries) && c.entries.length > 0);
}

/**
 * D-299 (satu aturan untuk DOCX `units.ts` dan HTML `slots.ts`): unit slot opsional yang isinya hanya
 * penanda AUTO tanpa entri (atau tanpa blok) tidak dirender sebagai seksi. Tetap dirender: slot wajib,
 * render lingkup slot itu sendiri, unit berisi blok lain, dan slot `signatureBlock` (keberadaannya
 * diatur penempatan R-42 `slot.placement`, bukan aturan ini). Unit placeholder diputuskan pemanggil.
 */
export function emptyOptionalUnitOmitted(
  slot: { required: boolean; sectionType: string },
  unitBlocks: readonly NormBlock[],
  opts: { scoped: boolean },
): boolean {
  return !slot.required && slot.sectionType !== "signatureBlock" && !opts.scoped && unitBlocks.every(isRuleIndexAutoMarker);
}

export interface RuleIndexExpansion {
  /** Blok pengganti penanda; absen = 0 entri dan unit tidak dipaksa (pemanggil menerapkan D-299). */
  blocks?: NormBlock[];
  log: RenderLogEntry[];
  entries: number;
}

/**
 * Ganti penanda AUTO dengan judul + tabel indeks (>= 1 entri), atau baris kosong bila `forced`
 * (unit tetap dirender: slot wajib, render lingkup slot itu, atau unit berisi blok lain).
 * Judul memakai ordinal penanda, tabel ordinal + 0,5 agar urutan di dalam unit tetap.
 */
export function expandRuleIndexMarker(marker: NormBlock, src: RuleIndexSource, opts: { forced: boolean }): RuleIndexExpansion {
  const lang = wrapperLangOf(src.doc.meta as { language?: "ID" | "EN" } | undefined);
  const built = buildRuleIndex(src);
  const log: RenderLogEntry[] = built.duplicates.map((d) => ({
    level: "warn",
    code: "RULE_INDEX_DUPLICATE_CODE",
    address: d.address,
    message: `Kode aturan ${d.code} ganda: ${d.address} (${d.level}) diabaikan, indeks memakai ${d.firstAddress} (${d.firstLevel})`,
  }));
  if (built.entries.length > 0) {
    const heading = ruleIndexHeading(lang);
    const blocks: NormBlock[] = [
      { ...marker, blockId: `${marker.blockId}:title`, address: null, type: "section", content: heading, textPlain: heading.title.text, contentSha256: "" },
      { ...marker, ordinal: marker.ordinal + 0.5, content: ruleIndexTable(built.entries, lang), textPlain: "", contentSha256: "" },
    ];
    return { blocks, log, entries: built.entries.length };
  }
  if (!opts.forced) return { log, entries: 0 };
  const empty = ruleIndexEmptyParagraph(lang);
  log.push({
    level: "info",
    code: "RULE_INDEX_EMPTY",
    address: marker.address ?? undefined,
    message: `Indeks aturan ${marker.address ?? marker.blockId}: isi tidak memuat penanda kode + tingkat; baris kosong dirender`,
  });
  return { blocks: [{ ...marker, type: "paragraph", content: empty, textPlain: empty.text, contentSha256: "" }], log, entries: 0 };
}
