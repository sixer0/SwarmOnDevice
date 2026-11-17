/**
 * C-35 (Swarm 1.3.3 row 84, ST-12; register 03 §7): huruf kecil setelah titik akhir kalimat.
 *
 * Peringatan saja: setiap temuan berstatus REPORT, tidak pernah FAIL, jadi tidak pernah
 * menahan render atau rilis. Berlaku untuk teks Indonesia dan Inggris.
 *
 * Yang dipindai: lapisan `prose` (paragraf berperan prosa dan badan `aside`; lihat `prose.ts`).
 * Sel tabel, keterangan gambar, judul, butir daftar dan blok kode tidak ada di lapisan itu.
 *
 * Kandidat: titik yang langsung disusul spasi lalu huruf kecil. `splitSentences` (aturan c)
 * sengaja TIDAK memecah kalimat di titik seperti itu, jadi pemindai ini membaca teks paragraf
 * sendiri. Titik yang disusul kutip atau kurung tutup bukan kandidat: kutipan langsung yang
 * dilanjutkan (`"Kami siap." kata komandan`) dan kalimat dalam kurung tetap diam.
 *
 * Kandidat BUKAN temuan bila:
 *  - titik bagian elipsis (`...`, `. . .`);
 *  - kata sebelum titik singkatan: `ABBREVIATIONS` (tokenize.ts), singkatan yang lazim
 *    dilanjutkan (`CONTINUING_ABBREVIATIONS`: dll, dsb, dst, Tbk, etc, ...), atau inisialisme
 *    bertitik (`a.n.`, `e.g.`, `U.S.`, `S.Kom.`);
 *  - kata sebelum titik satu huruf yang bukan satuan sesudah angka (inisial nama, penanda
 *    butir `a.`), penanda butir bernomor (`1.`, `ii.`; juga `2.`, `3.` di tengah paragraf
 *    yang dibuka `1.`), nomor bagian di awal paragraf
 *    (`1.2.`), atau label keterangan di awal paragraf (`Gambar 3.`, `Table 2.`);
 *  - kata sesudah titik memang berhuruf kecil menurut aturan: URL, alamat surel, nama berkas,
 *    path, pengenal berangka atau bergaris bawah, satuan dan simbol (`kW`, `mm`, `pH`, `η`,
 *    `h = 48`);
 *  - paragraf berisi baris tabel bergaris tegak (`a | b | c`);
 *  - teks berada dalam rentang kode (backtick). Catatan: `prose.ts` membuang backtick sebelum
 *    pemindai menerima `text`; rentang kode hanya dikenali bila unit membawa `raw` (teks
 *    md-lite asli). Tanpa `raw`, rentang kode dilindungi oleh aturan bentuk kata di atas saja.
 */
import type { LintIssue } from "../../../contract";
import type { Scanner } from "./checks";
import type { TextUnit } from "./prose";
import { ABBREVIATIONS } from "./tokenize";

export const LOWERCASE_AFTER_STOP_ID = "C-35";

/** Plafon isu (satu isu per paragraf); sisanya diringkas. */
const MAX_PARAGRAPH_ISSUES = 50;
/** Cuplikan per isu. */
const MAX_EXCERPTS = 2;
const EXCERPT_BEFORE = 28;
const EXCERPT_AFTER = 26;

/**
 * Singkatan yang boleh menutup kalimat tetapi juga lazim dilanjutkan huruf kecil
 * (`dll. dan`, `Tbk. serta`, `etc. and`). Huruf kecil, tanpa titik akhir. Melengkapi
 * `ABBREVIATIONS`, yang hanya memuat singkatan yang tidak pernah mengakhiri kalimat.
 */
export const CONTINUING_ABBREVIATIONS: ReadonlySet<string> = new Set([
  // Indonesia
  "dll", "dsb", "dst", "dkk", "tbk", "sbb", "tsb", "ybs", "maks", "min", "kol", "bag", "gbr", "tab", "lih", "bdk",
  "ket", "jml", "thn", "th", "bln", "cet", "jil", "terj", "peny", "red", "an", "ub", "up",
  // Inggris
  "etc", "al", "ltd", "inc", "co", "corp", "fig", "figs", "eq", "eqs", "sec", "ch", "pp", "approx", "ca", "max",
  "mr", "mrs", "ms", "jr", "sr", "st", "viz", "resp", "est", "dept", "no", "nos",
  // bulan
  "jan", "feb", "mar", "apr", "jun", "jul", "agu", "agt", "ags", "aug", "sep", "sept", "okt", "oct", "nov", "des", "dec",
]);

/** Satuan yang seluruhnya huruf kecil (satuan bercampur kapital, mis. kW, ditangani aturan bentuk). */
const LOWERCASE_UNITS: ReadonlySet<string> = new Set([
  "mm", "cm", "dm", "km", "nm", "µm", "μm", "mg", "kg", "ml", "ms", "ns", "µs", "μs", "kbps", "mbps", "gbps", "bps",
  "kb/s", "mb/s", "gb/s", "b/s", "m/s", "km/jam", "km/h", "ppm", "rpm", "lux", "dpi", "px", "pt",
]);

/** Label keterangan atau judul bernomor di awal paragraf: titiknya bagian label. */
const LABEL_AT_START =
  /^(?:gambar|tabel|bagan|grafik|diagram|lampiran|rumus|persamaan|bab|bagian|pasal|ayat|langkah|tahap|butir|figure|fig|table|chart|appendix|equation|chapter|section|step|part)\s+[\p{L}\p{N}][\p{L}\p{N}.\-]{0,7}$/iu;

const ROMAN_MARKER = /^(?:i{1,3}|iv|v|vi{1,3}|ix|x|xi{1,3}|xiv|xv)$/iu;
const DOTTED_INITIALISM = /^(?:\p{L}{1,2}\.)+\p{L}{1,4}$/u;
const SECTION_NUMBER = /^\d+(?:\.\d+)+$/u;
/** Sebelum penanda butir: awal teks, atau tanda yang menutup butir/kalimat sebelumnya. */
const MARKER_POSITION = /(?:^|[.:;,!?…(])\s*$/u;
/** Paragraf yang dibuka penanda butir bernomor: angka pendek berikutnya juga penanda butir. */
const ENUMERATION_START = /^\(?\d{1,2}[.)]\s/u;
const OPERATOR_AHEAD = /^\s*[=≥≤<>≈×÷+−^]/u;
const GREEK_LOWER = /^[α-ωµ]/u;
const CODE_PLACEHOLDER = "￼";

export interface LowercaseAfterStopHit {
  /** Indeks titik pada teks yang sudah dinormalkan. */
  index: number;
  /** Kata pertama sesudah titik. */
  word: string;
  excerpt: string;
}

/** Rentang kode diganti penanda netral, penanda tebal/miring md-lite dibuang, spasi dirapatkan. */
function normalize(text: string): string {
  return text
    .replace(/`[^`\n]*`/gu, CODE_PLACEHOLDER)
    .replace(/[*`]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Baris tabel bergaris tegak yang masuk sebagai paragraf: sel tabel tidak dipindai. */
function looksLikeTableRow(text: string): boolean {
  return (text.match(/\s\|\s/gu) ?? []).length >= 2;
}

/** Kata berikutnya memang berhuruf kecil menurut aturan (bukan awal kalimat yang keliru). */
function lowercaseByRule(token: string, rest: string): boolean {
  const core = token.replace(/[.,;:!?)\]"'”’]+$/u, "");
  if (core === "") return true;
  if (GREEK_LOWER.test(core)) return true; // simbol Yunani (η, λ, µ)
  if (LOWERCASE_UNITS.has(core)) return true;
  if (/^\p{Ll}[\p{L}\p{N}]*\p{Lu}/u.test(core)) return true; // kW, kVA, mAh, pH, dBm, iOS
  if (core.includes("@") || core.includes("://") || core.includes("_") || core.includes("\\")) return true; // surel, URL, pengenal
  if (/\p{N}/u.test(core)) return true; // pengenal berangka (m12, v1.3.3, h2)
  if (/^www\./u.test(core)) return true;
  if (/^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+$/u.test(core)) return true; // nama berkas atau domain (spek.md, gsp.co.id)
  if (/^[~./]/u.test(core)) return true; // path
  const slashes = (core.match(/\//gu) ?? []).length;
  if (slashes >= 2 || (slashes === 1 && core.includes("."))) return true; // path (src/lib/x, docs/spek.md)
  if (/^\p{L}$/u.test(core) && OPERATOR_AHEAD.test(rest.slice(token.length))) return true; // simbol: h = 48
  if (/^\p{L}[=≥≤<>≈]/u.test(core)) return true; // simbol tanpa spasi: h=48
  return false;
}

/** Titik sebelum kandidat bukan akhir kalimat (singkatan, inisial, penanda butir, label). */
function stopIsNotSentenceEnd(text: string, dot: number): boolean {
  const before = text.slice(0, dot);
  const prevChar = before.slice(-1);
  if (prevChar === "" || prevChar === "." || prevChar === "…" || /\s/u.test(prevChar)) return true; // elipsis, titik lepas
  if (prevChar === CODE_PLACEHOLDER) return false;
  const m = /([\p{L}\p{N}.]+)$/u.exec(before);
  if (!m) return false;
  const raw = m[1].replace(/^\.+/u, "");
  const token = raw.toLowerCase();
  const lead = before.slice(0, before.length - m[1].length);
  if (ABBREVIATIONS.has(token) || CONTINUING_ABBREVIATIONS.has(token)) return true;
  if (DOTTED_INITIALISM.test(raw)) return true;
  if (/^\p{L}$/u.test(raw)) return !/\p{N}\s?$/u.test(lead); // inisial atau penanda butir; satuan sesudah angka = akhir kalimat
  if ((/^\d{1,3}$/u.test(raw) || ROMAN_MARKER.test(raw)) && MARKER_POSITION.test(lead)) return true; // 1.  ii.
  if (/^\d{1,2}$/u.test(raw) && ENUMERATION_START.test(text)) return true; // enumerasi sebaris: 1. ... 2. ... 3. ...
  if (SECTION_NUMBER.test(raw) && lead.trim() === "") return true; // 1.2. di awal paragraf
  if (LABEL_AT_START.test(before.trim())) return true; // Gambar 3.  Table 2.
  return false;
}

function excerptAt(text: string, dot: number, afterWs: number): string {
  let from = Math.max(0, dot - EXCERPT_BEFORE);
  if (from > 0) {
    const sp = text.indexOf(" ", from);
    if (sp !== -1 && sp < dot - 4) from = sp + 1;
  }
  let to = Math.min(text.length, afterWs + EXCERPT_AFTER);
  if (to < text.length) {
    const sp = text.lastIndexOf(" ", to);
    if (sp > afterWs + 4) to = sp;
  }
  return `${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`;
}

/**
 * Temuan pada satu paragraf. `text` boleh md-lite (backtick dan `*` dikenali) atau teks polos.
 */
export function findLowercaseAfterStop(text: string): LowercaseAfterStopHit[] {
  const t = normalize(text);
  if (t === "" || looksLikeTableRow(t)) return [];
  const hits: LowercaseAfterStopHit[] = [];
  const re = /\.( +)(?=\p{Ll})/gu;
  for (let m = re.exec(t); m !== null; m = re.exec(t)) {
    const dot = m.index;
    const afterWs = dot + m[0].length;
    if (stopIsNotSentenceEnd(t, dot)) continue;
    const rest = t.slice(afterWs);
    const token = /^\S+/u.exec(rest)?.[0] ?? "";
    if (lowercaseByRule(token, rest)) continue;
    hits.push({ index: dot, word: token.replace(/[.,;:!?)\]"'”’]+$/u, ""), excerpt: excerptAt(t, dot, afterWs) });
  }
  return hits;
}

/** Teks sumber unit: md-lite asli bila tersedia (`raw`), selain itu teks lapisan prosa. */
function sourceText(u: TextUnit): string {
  const raw = (u as TextUnit & { raw?: unknown }).raw;
  return typeof raw === "string" ? raw : u.text;
}

/** Pemindai C-35: satu isu REPORT per paragraf yang memuat temuan; PASS bila bersih. */
export const lowercaseAfterStop: Scanner = (ctx) => {
  const id = LOWERCASE_AFTER_STOP_ID;
  const found = ctx.layers.prose
    .map((unit) => ({ unit, hits: findLowercaseAfterStop(sourceText(unit)) }))
    .filter((x) => x.hits.length > 0);
  if (found.length === 0) {
    return [{ checkId: id, status: "PASS", detail: `${ctx.layers.prose.length} paragraf prosa tanpa huruf kecil setelah titik akhir kalimat` }];
  }
  const out: LintIssue[] = found.slice(0, MAX_PARAGRAPH_ISSUES).map(({ unit, hits }) => {
    const shown = hits.slice(0, MAX_EXCERPTS).map((h) => `"${h.excerpt}"`).join("; ");
    const more = hits.length > MAX_EXCERPTS ? `; dan ${hits.length - MAX_EXCERPTS} lagi di paragraf ini` : "";
    return {
      checkId: id,
      status: "REPORT",
      detail: `${unit.address ?? `blok ${unit.blockId}`}: ${hits.length} kalimat diawali huruf kecil setelah titik: ${shown}${more}; awali kalimat dengan huruf kapital atau ganti titik dengan koma/titik koma (peringatan)`,
      ...(unit.address ? { address: unit.address } : {}),
    };
  });
  if (found.length > MAX_PARAGRAPH_ISSUES) {
    const restHits = found.slice(MAX_PARAGRAPH_ISSUES).reduce((a, x) => a + x.hits.length, 0);
    out.push({
      checkId: id,
      status: "REPORT",
      detail: `dan ${restHits} temuan di ${found.length - MAX_PARAGRAPH_ISSUES} paragraf lain tidak dirinci (peringatan)`,
    });
  }
  return out;
};
