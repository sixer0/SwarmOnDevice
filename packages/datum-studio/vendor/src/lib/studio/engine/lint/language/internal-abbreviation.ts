/**
 * C-37 (Swarm 1.3.3 row 103, KL-3; register 03 §7): singkatan internal di judul, keterangan, dan paragraf.
 *
 * Peringatan saja: setiap temuan berstatus REPORT, tidak pernah FAIL, jadi tidak pernah menahan render
 * atau rilis. Daftar istilah ada di SATU berkas konfigurasi, `internal-abbreviations.json` di folder ini
 * (`{"version": 1, "terms": [{"term", "say", "sayNext"?}]}`), dibaca hanya oleh pemeriksaan ini. Entri pertama
 * adalah singkatan internal pustaka dengan `say` = "pustaka pengetahuan teknis GSP" (penyebutan pertama) dan
 * `sayNext` = "pustaka teknis" (penyebutan berikutnya).
 *
 * Yang dipindai (urutan dokumen):
 *  - judul: judul dokumen (`cover.data.titleLines`, atau `meta.title` bila tidak ada sampul), judul bab, subbab,
 *    lampiran, bagian, judul lembar kendali, label kotak `aside`;
 *  - keterangan: `caption` dan baris `source` blok gambar, grafik, diagram, dan tabel;
 *  - paragraf: blok `paragraph` (peran apa pun), badan `aside`, pernyataan metode lembar kendali, dan entri
 *    daftar sumber (`sourceRegisterEntry.citation`).
 * Tidak dipindai: sel tabel, butir daftar, blok kode (`monoBlock`), isi spec gambar (spek KL-3 menyebut judul,
 * caption, dan paragraf).
 *
 * Cocok = istilah sebagai kata utuh, tanpa membedakan huruf besar-kecil, juga di dalam kurung atau kutip dan
 * sebelum tanda baca; `EKAS-nya` dan `non-EKAS` tetap kemunculan. Dikecualikan (dihitung di detail PASS):
 *  - rentang kode: backtick pada teks md-lite atau run `code: true`;
 *  - URL: token dengan `://` atau diawali `www.`;
 *  - path, nama berkas, dan nama folder: token dengan `/` atau `\`, garis bawah, titik di antara huruf
 *    (`EKAS.md`), atau kata majemuk bergaris hubung bergaya nama folder (`ekas-lapis-teks`: tiga bagian atau
 *    lebih, atau semua bagian huruf kecil dan bukan klitik). Ini juga yang membuat entri daftar sumber yang
 *    memuat lokasi berkas tetap diam (spek KL-3: nama folder lama boleh muncul sebagai lokasi berkas).
 *
 * Pemindai membaca snapshot (`ScanContext.snapshot`), karena judul dan keterangan tidak ada di lapisan prosa.
 */
import type { LintIssue, NormDocSnapshot } from "../../../contract";
import type { Scanner } from "./checks";
import rawConfig from "./internal-abbreviations.json";

export const INTERNAL_ABBREVIATION_ID = "C-37";

/** Plafon isu (satu isu per kemunculan); sisanya diringkas. */
const MAX_ISSUES = 200;
const EXCERPT_BEFORE = 32;
const EXCERPT_AFTER = 32;

export interface AbbreviationTerm {
  term: string;
  say: string;
  sayNext?: string;
}

export interface AbbreviationConfig {
  version: 1;
  terms: AbbreviationTerm[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** Validasi berkas konfigurasi; melempar dengan alasan (lintLanguage menjadikannya NOT_RUN, tidak pernah PASS palsu). */
export function parseAbbreviationConfig(raw: unknown): AbbreviationConfig {
  if (!isRecord(raw)) throw new Error("internal-abbreviations.json: bukan objek");
  if (raw.version !== 1) throw new Error(`internal-abbreviations.json: version ${String(raw.version)} tidak dikenal (harus 1)`);
  if (!Array.isArray(raw.terms) || raw.terms.length === 0) throw new Error("internal-abbreviations.json: terms kosong");
  const terms = raw.terms.map((t, i) => {
    if (!isRecord(t) || !nonEmpty(t.term)) throw new Error(`internal-abbreviations.json: terms[${i}].term kosong`);
    if (!nonEmpty(t.say)) throw new Error(`internal-abbreviations.json: terms[${i}].say kosong`);
    if (t.sayNext !== undefined && !nonEmpty(t.sayNext)) throw new Error(`internal-abbreviations.json: terms[${i}].sayNext kosong`);
    return { term: t.term.trim(), say: t.say.trim(), ...(nonEmpty(t.sayNext) ? { sayNext: t.sayNext.trim() } : {}) };
  });
  return { version: 1, terms };
}

/** Isi berkas konfigurasi (divalidasi saat modul dimuat ulang oleh pemindai; lihat `configOrThrow`). */
export const INTERNAL_ABBREVIATION_CONFIG: AbbreviationConfig = (() => {
  try {
    return parseAbbreviationConfig(rawConfig);
  } catch {
    return { version: 1, terms: [] };
  }
})();

function configOrThrow(): AbbreviationConfig {
  return parseAbbreviationConfig(rawConfig);
}

// ── Teks per tempat ────────────────────────────────────────────────────────

export interface Segment {
  text: string;
  code: boolean;
}

export type Place = "judul" | "keterangan" | "paragraf";

export interface TextPlace {
  place: Place;
  /** Jenis sumber teks, untuk detail (mis. "judul bab", "baris sumber"). */
  what: string;
  blockId?: string;
  address?: string;
  segments: Segment[];
}

/** md-lite: segmen ber-backtick = kode; `*` penanda tebal/miring dibuang dari teks biasa. */
function mdLiteSegments(text: string): Segment[] {
  return text
    .split("`")
    .map((part, i) => ({ text: i % 2 === 1 ? part : part.replace(/\*/gu, ""), code: i % 2 === 1 }))
    .filter((s) => s.text.length > 0);
}

/** Inline v1/v2 dalam bentuk apa pun yang tersimpan: string, `{text}`, `{runs}`, `{inline: ...}`. */
export function inlineSegments(v: unknown, depth = 0): Segment[] {
  if (depth > 4) return [];
  if (typeof v === "string") return mdLiteSegments(v);
  if (!isRecord(v)) return [];
  if ("inline" in v) return inlineSegments(v.inline, depth + 1);
  if (typeof v.text === "string") return mdLiteSegments(v.text);
  if (Array.isArray(v.runs)) {
    return v.runs.flatMap((r): Segment[] => {
      if (!isRecord(r)) return [];
      if (typeof r.t === "string") return [{ text: r.t, code: r.code === true }];
      if (r.tab === true || typeof r.br === "string") return [{ text: " ", code: false }];
      return [];
    });
  }
  return [];
}

const HEADING_TYPES: ReadonlySet<string> = new Set(["chapter", "section", "subsection", "appendix", "part", "heading"]);
const HEADING_WHAT: Readonly<Record<string, string>> = {
  chapter: "judul bab",
  section: "judul subbab",
  subsection: "judul subbab",
  appendix: "judul lampiran",
  part: "judul bagian",
  heading: "judul",
};

/** Semua teks judul, keterangan, dan paragraf snapshot, urut dokumen. Tidak pernah melempar. */
export function textPlacesOf(s: NormDocSnapshot): TextPlace[] {
  const out: TextPlace[] = [];
  const blocks = Array.isArray(s?.blocks) ? s.blocks : [];
  let coverTitle = false;
  for (const b of blocks) {
    if (!isRecord(b)) continue;
    const c = b.content;
    if (!isRecord(c)) continue;
    const at = {
      ...(typeof b.blockId === "string" ? { blockId: b.blockId } : {}),
      ...(typeof b.address === "string" && b.address ? { address: b.address } : {}),
    };
    const push = (place: Place, what: string, v: unknown) => {
      const segments = inlineSegments(v);
      if (segments.length > 0) out.push({ place, what, ...at, segments });
    };
    const data = isRecord(c.data) ? c.data : undefined;
    switch (b.type) {
      case "cover":
        if (data && Array.isArray(data.titleLines)) {
          for (const line of data.titleLines) push("judul", "judul dokumen", line);
          coverTitle = data.titleLines.length > 0;
        }
        continue;
      case "controlSheet":
        if (data) {
          push("judul", "judul lembar kendali", data.title);
          push("paragraf", "pernyataan metode lembar kendali", data.methodStatement);
        }
        continue;
      case "paragraph":
        push("paragraf", "paragraf", c);
        continue;
      case "aside":
        push("judul", "label kotak", c.label);
        if (Array.isArray(c.body)) for (const p of c.body) push("paragraf", "paragraf kotak", p);
        continue;
      case "sourceRegisterEntry":
        push("paragraf", "entri daftar sumber", c.citation);
        continue;
    }
    if (HEADING_TYPES.has(b.type)) {
      push("judul", HEADING_WHAT[b.type] ?? "judul", c.title);
      continue;
    }
    if ("caption" in c) push("keterangan", "keterangan", c.caption);
    if ("source" in c) push("keterangan", "baris sumber", c.source);
  }
  const title = isRecord(s?.doc) && isRecord(s.doc.meta) ? s.doc.meta.title : undefined;
  if (!coverTitle && typeof title === "string") {
    const segments = mdLiteSegments(title);
    if (segments.length > 0) out.unshift({ place: "judul", what: "judul dokumen", address: "meta.title", segments });
  }
  return out;
}

// ── Pencocokan ─────────────────────────────────────────────────────────────

export type ExemptReason = "kode" | "url" | "path";

export interface AbbreviationHit {
  term: AbbreviationTerm;
  /** Teks persis seperti tertulis. */
  written: string;
  index: number;
  exempt?: ExemptReason;
  excerpt: string;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const OPENERS = /^[(\[{"'“‘«]+/u;
const CLOSERS = /[)\]}"'”’».,;:!?…]+$/u;
const CLITICS: ReadonlySet<string> = new Set(["nya", "ku", "mu", "lah", "kah", "pun", "tah"]);

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/\s+/gu, "\\s+");

/** Token (rangkaian tanpa spasi) yang memuat [start, end), tanpa kurung, kutip, dan tanda baca di tepinya. */
function tokenAround(text: string, start: number, end: number): string {
  let a = start;
  while (a > 0 && !/\s/u.test(text[a - 1])) a--;
  let z = end;
  while (z < text.length && !/\s/u.test(text[z])) z++;
  return text.slice(a, z).replace(OPENERS, "").replace(CLOSERS, "");
}

function pathLike(token: string, written: string): ExemptReason | undefined {
  if (token.includes("://") || /^www\./iu.test(token)) return "url";
  if (/[/\\]/u.test(token) || token.includes("_")) return "path";
  if (/[\p{L}\p{N}]\.[\p{L}\p{N}]/u.test(token)) return "path";
  if (token.includes("-")) {
    const parts = token.split("-").filter((p) => p.length > 0);
    if (parts.length >= 3) return "path";
    const others = parts.filter((p) => p.toLowerCase() !== written.toLowerCase());
    if (others.length > 0 && others.every((p) => CLITICS.has(p.toLowerCase()))) return undefined;
    if (parts.length >= 2 && parts.every((p) => /^[\p{Ll}\p{N}]+$/u.test(p))) return "path";
  }
  return undefined;
}

function excerptOf(text: string, start: number, end: number): string {
  const a = Math.max(0, start - EXCERPT_BEFORE);
  const z = Math.min(text.length, end + EXCERPT_AFTER);
  return `${a > 0 ? "…" : ""}${text.slice(a, z).replace(/\s+/gu, " ").trim()}${z < text.length ? "…" : ""}`;
}

/** Kemunculan istilah konfigurasi dalam satu teks bersegmen, urut posisi (yang dikecualikan diberi `exempt`). */
export function findInternalAbbreviations(
  segments: ReadonlyArray<Segment>,
  terms: ReadonlyArray<AbbreviationTerm> = INTERNAL_ABBREVIATION_CONFIG.terms,
): AbbreviationHit[] {
  if (!Array.isArray(segments)) return [];
  let text = "";
  const code: Array<[number, number]> = [];
  for (const s of segments) {
    if (!s || typeof s.text !== "string") continue;
    if (s.code) code.push([text.length, text.length + s.text.length]);
    text += s.text;
  }
  const hits: AbbreviationHit[] = [];
  for (const term of terms) {
    const re = new RegExp(escapeRe(term.term), "giu");
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (start > 0 && WORD_CHAR.test(text[start - 1])) continue;
      if (end < text.length && WORD_CHAR.test(text[end])) continue;
      const inCode = code.some(([a, z]) => start >= a && end <= z);
      const exempt: ExemptReason | undefined = inCode ? "kode" : pathLike(tokenAround(text, start, end), m[0]);
      hits.push({ term, written: m[0], index: start, ...(exempt ? { exempt } : {}), excerpt: excerptOf(text, start, end) });
    }
  }
  return hits.sort((x, y) => x.index - y.index);
}

// ── Pemindai ───────────────────────────────────────────────────────────────

export const internalAbbreviation: Scanner = (ctx) => {
  const id = INTERNAL_ABBREVIATION_ID;
  const s = ctx?.snapshot;
  if (!isRecord(s)) {
    return [{ checkId: id, status: "NOT_RUN", detail: "snapshot dokumen tidak diteruskan ke pemindai bahasa; judul dan keterangan tidak ada di lapisan prosa" }];
  }
  const config = configOrThrow();
  const places = textPlacesOf(s as unknown as NormDocSnapshot);
  const mentioned = new Set<string>();
  const out: LintIssue[] = [];
  let found = 0;
  let exempt = 0;
  for (const p of places) {
    for (const h of findInternalAbbreviations(p.segments, config.terms)) {
      if (h.exempt) {
        exempt++;
        continue;
      }
      found++;
      const key = h.term.term.toLowerCase();
      const first = !mentioned.has(key);
      mentioned.add(key);
      if (out.length >= MAX_ISSUES) continue;
      const say = first || !h.term.sayNext
        ? `"${h.term.say}"${h.term.sayNext ? ` (penyebutan pertama; sesudahnya "${h.term.sayNext}")` : ""}`
        : `"${h.term.sayNext}"`;
      const written = h.written === h.term.term ? "" : ` (tertulis "${h.written}")`;
      out.push({
        checkId: id,
        status: "REPORT",
        detail: `${p.place} ${p.address ?? `blok ${p.blockId ?? "?"}`} (${p.what}): singkatan internal "${h.term.term}"${written}; tulis ${say}: «${h.excerpt}»`,
        ...(p.address ? { address: p.address } : {}),
      });
    }
  }
  if (found > MAX_ISSUES) {
    out.push({ checkId: id, status: "REPORT", detail: `dan ${found - MAX_ISSUES} kemunculan singkatan internal lain tidak dirinci (peringatan)` });
  }
  if (found === 0) {
    const ex = exempt > 0 ? `; ${exempt} kemunculan di path, nama berkas, URL, atau kode dikecualikan` : "";
    return [{ checkId: id, status: "PASS", detail: `${places.length} judul, keterangan, dan paragraf tanpa singkatan internal${ex}` }];
  }
  return out;
};
