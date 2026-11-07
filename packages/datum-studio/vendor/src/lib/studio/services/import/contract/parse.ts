/**
 * Pemindai sumber + pengurai nilai generator `md2contract/v1` (DC-24; register 05 §16).
 * Murni: hanya fungsi dari teks. Tidak ada tebakan: nilai yang tidak cocok alias/pola
 * dikembalikan `null` dan pemanggil mencatatnya (KD-42).
 */
import { CARD_ID_PATTERN, CONTRACT_ACTOR_PATTERN, CONTRACT_KEY_PATTERN, CONTRACT_REPORTED_AT_PATTERN } from "../../../contract/env";
import { atxHeading, splitTableRow } from "../lexer";
import { isCalendarDay } from "../../contracts/dates";

export const CARD_ID_RE = new RegExp(CARD_ID_PATTERN);
export const CONTRACT_KEY_RE = new RegExp(CONTRACT_KEY_PATTERN);
export const CONTRACT_ACTOR_RE = new RegExp(CONTRACT_ACTOR_PATTERN);
const REPORTED_AT_RE = new RegExp(CONTRACT_REPORTED_AT_PATTERN);
/** Id kartu di dalam teks (C34 tanpa jangkar; dibatasi batas kata). */
const CARD_ID_SCAN_RE = /(?<![A-Za-z0-9_])t_[0-9a-f]{8}(?![A-Za-z0-9_])/g;

/** Kepala = 40 baris pertama (§16.1; inventaris DC-01 `head_keys`). */
export const HEADER_SCAN_LINES = 40;

// ── Sumber ───────────────────────────────────────────────────────────────

/** CRLF/BOM dinormalkan sama dengan importer md/v1. */
export function normalizeSource(md: string): string {
  return (md.charCodeAt(0) === 0xfeff ? md.slice(1) : md).replace(/\r\n?/g, "\n");
}

const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/**
 * `true` untuk baris di dalam pagar kode (termasuk baris pembuka dan penutup), dengan aturan
 * pembuka/penutup yang sama dengan lexer md/v1 (`lexer.ts` FENCE_RE).
 */
export function fenceMask(lines: readonly string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    const f = FENCE_RE.exec(lines[i]);
    if (!f || (f[2][0] === "`" && f[3].includes("`"))) continue;
    const ch = f[2][0] === "`" ? "`" : "~";
    const closeRe = new RegExp(`^ {0,3}${ch}{${f[2].length},}[ \\t]*$`);
    mask[i] = true;
    let j = i + 1;
    while (j < lines.length && !closeRe.test(lines[j])) mask[j++] = true;
    if (j < lines.length) mask[j] = true;
    i = j;
  }
  return mask;
}

/** Indeks baris penutup frontmatter (`---` ... `---`), atau -1. */
export function frontMatterEnd(lines: readonly string[]): number {
  if (lines.length === 0 || lines[0].trim() !== "---") return -1;
  for (let j = 1; j < lines.length; j++) {
    const t = lines[j].trim();
    if (t === "---" || t === "...") return j;
  }
  return -1;
}

/** Normalisasi judul `##` = inventaris DC-01 `norm_h` (inv §2.1; dicocokkan persis ke alias GA). */
export function normalizeHeading(s: string): string {
  let t = s.trim().replace(/#+$/, "").trim().toLowerCase();
  t = t.replace(/^[([]?[a-z0-9]{1,3}[.)\]]\s+/, "");
  t = t.replace(/\d+/g, "N");
  t = t.replace(/\s+/g, " ");
  return t.slice(0, 70);
}

/** Judul ATX level n di luar pagar; `null` bila bukan. */
export function headingAt(line: string, level: number): string | null {
  const h = atxHeading(line);
  return h && h.level === level ? h.text : null;
}

/**
 * Baris `Kunci: nilai` / `**Kunci:** nilai` / `- **Kunci:** nilai` (regex `KV` inventaris DC-01,
 * ditambah tangkapan nilai). Kunci dikembalikan huruf kecil.
 */
const KV_RE = /^\s*(?:[-*>]\s*)*\*{0,2}([A-Za-zÀ-ÿ_][A-Za-zÀ-ÿ_ /-]{1,28}?)\*{0,2}\s*:\*{0,2}\s+(\S.*)$/;

export function keyValueOf(line: string): { key: string; value: string } | null {
  const m = KV_RE.exec(line);
  if (!m) return null;
  const key = m[1].trim().toLowerCase();
  if (key.includes("http") || key.length < 2) return null;
  return { key, value: m[2].trim() };
}

/** Kunci frontmatter YAML sederhana `kunci: nilai`. */
export function frontMatterKeyValue(line: string): { key: string; value: string } | null {
  const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
  if (!m) return null;
  return { key: m[1].toLowerCase(), value: m[2].trim() };
}

// ── Tabel GFM ────────────────────────────────────────────────────────────

const DELIM_ROW_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

export interface SourceTable {
  /** Baris kepala 1-based. */
  line: number;
  header: string[];
  rows: Array<{ line: number; cells: string[] }>;
}

/** Tabel pipa di luar pagar: kepala + baris pemisah + baris data. */
export function findTables(lines: readonly string[], mask: readonly boolean[]): SourceTable[] {
  const out: SourceTable[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (mask[i] || mask[i + 1] || !lines[i].includes("|") || !DELIM_ROW_RE.test(lines[i + 1]) || !lines[i + 1].includes("-")) continue;
    const header = splitTableRow(lines[i]);
    const rows: SourceTable["rows"] = [];
    let j = i + 2;
    while (j < lines.length && !mask[j] && lines[j].trim() !== "" && lines[j].includes("|")) {
      rows.push({ line: j + 1, cells: splitTableRow(lines[j]) });
      j++;
    }
    out.push({ line: i + 1, header, rows });
    i = j - 1;
  }
  return out;
}

// ── Nilai ────────────────────────────────────────────────────────────────

/**
 * Buang deret backtick di kedua tepi tanpa regex (R3-F #8): `/^`+|`+$/g` mencoba `` `+$ `` dari setiap
 * posisi deret backtick di tengah nilai -> waktu kuadratik (40.000 backtick = 769 ms). Loop indeks linear.
 */
export function trimBackticks(t: string): string {
  let a = 0;
  let b = t.length;
  while (a < b && t.charCodeAt(a) === 0x60) a++;
  while (b > a && t.charCodeAt(b - 1) === 0x60) b--;
  return a === 0 && b === t.length ? t : t.slice(a, b);
}

/** Buang pembungkus tampilan (`**`, `_`, backtick, kutip) di tepi nilai. */
export function cleanValue(v: string): string {
  let t = v.trim();
  for (let k = 0; k < 3; k++) {
    const before = t;
    t = t.replace(/^\*{1,2}|\*{1,2}$/g, "").trim();
    t = trimBackticks(t).trim();
    t = t.replace(/^["']|["']$/g, "").trim();
    if (t === before) break;
  }
  return t;
}

/**
 * Pemisah alternatif/majemuk sesudah spasi: `/`, `,`, `&`, atau kata `atau`/`or`/`vs`/`versus` (DC35-F1)
 * dan `dan`/`and`/`serta` (R3-F #7, KD-42: `complete dan blocked`, `R3-01 dan R3-02` tidak dipotong ke token
 * pertama, sama seperti `/`).
 */
const ALT_AFTER_SPACE_RE = /^(?:[/,&]|(?:atau|or|vs\.?|versus|dan|and|serta)(?=\s|$))/i;
/** Pemisah lain sesudah spasi yang masih bisa mengawali kandidat alias kedua (`complete | blocked`). */
const SEP_AFTER_SPACE_RE = /^[|;+]\s*[*`]*/;
const LEAD_TOKEN_RE = /^[A-Za-z0-9_.-]+/;

export type AliasToken = { token: string; compound: false } | { token: null; compound: true };

/**
 * Token alias status/vonis (§16.5, KD-42, DC35-F1). Token awal hanya diterima bila diikuti akhir
 * nilai, spasi, atau `(` (keterangan penulis, mis. `FAIL (satu FAIL ...)`, D-377 butir 2); penanda
 * tampilan `*`/backtick sesudah token diabaikan. Nilai majemuk -> `compound` (tidak ditebak):
 *   - token diikuti langsung pemisah apa pun (`PASS/FAIL`, `todo,blocked`, `complete|blocked`);
 *   - sesudah spasi ada pemisah alternatif `/`, `,`, `&`, `atau`, `or`, `vs`, `dan`, `and`, `serta`
 *     (`PASS / FAIL`, `PASS atau FAIL`, `complete dan blocked`; R3-F #7);
 *   - sesudah spasi ada `|`, `;`, `+` yang diikuti token beralias lain (`complete | blocked`);
 *     `complete | Giliran: ...` tetap `complete` (pemisah medan, bukan alternatif; token yang diikuti
 *     `:` adalah label medan berikutnya, bukan kandidat).
 * `isAlias` memeriksa token di tabel alias pemanggil (dengan aturan huruf tabel itu).
 */
export function aliasTokenOf(v: string, isAlias: (token: string) => boolean): AliasToken {
  const t = cleanValue(v);
  const m = LEAD_TOKEN_RE.exec(t);
  if (!m) return { token: "", compound: false };
  const rest = t.slice(m[0].length).replace(/^[*`]+/, "");
  if (rest === "" || rest[0] === "(") return { token: m[0], compound: false };
  if (!/^\s/.test(rest)) return { token: null, compound: true };
  const after = rest.trimStart();
  if (ALT_AFTER_SPACE_RE.test(after)) return { token: null, compound: true };
  const sep = SEP_AFTER_SPACE_RE.exec(after);
  if (sep) {
    const tail = after.slice(sep[0].length);
    const next = LEAD_TOKEN_RE.exec(tail);
    if (next && tail[next[0].length] !== ":" && isAlias(next[0])) return { token: null, compound: true };
  }
  return { token: m[0], compound: false };
}

export type PatternValue = { value: string; reason?: undefined } | { value: null; reason: "compound" | "pattern" };

/**
 * Medan berpola (owner C36, taskRef C35; D-405). Aturan token sama dengan `aliasTokenOf`: nilai
 * majemuk (`DC-03/DC-04`, `coder, verifier`) TIDAK dipotong ke token pertama -> `compound`; token yang
 * tidak cocok pola -> `pattern`. `dan`/`and`/`serta`/`&` = majemuk (R3-F #7). Kandidat kedua sesudah `| ; +` dihitung hanya bila mirip kunci
 * (cocok pola dan memuat angka), agar prosa sesudah pemisah medan tidak dianggap nilai kedua.
 */
function patternValueOf(v: string, re: RegExp, lower: boolean): PatternValue {
  const norm = (x: string) => (lower ? x.toLowerCase() : x);
  const tok = aliasTokenOf(v, (x) => /\d/.test(x) && re.test(norm(x)));
  if (tok.compound) return { value: null, reason: "compound" };
  const t = norm(tok.token);
  return re.test(t) ? { value: t } : { value: null, reason: "pattern" };
}

/** owner (C36; huruf kecil). */
export function actorValueOf(v: string): PatternValue {
  return patternValueOf(v, CONTRACT_ACTOR_RE, true);
}

/** taskRef (C35). */
export function taskRefValueOf(v: string): PatternValue {
  return patternValueOf(v, CONTRACT_KEY_RE, false);
}

// ── Baris fase GL-12 ─────────────────────────────────────────────────────

const PHASE_PREFIX = "[FASE]";
const PHASE_TIME_TAIL_RE = /^\s*\d{1,2}:\d{2}\s*$/;
const WS_CHAR_RE = /\s/;
/** Karakter yang tidak dicocokkan `.` tanpa bendera `s`. */
const isLineTerminator = (c: number) => c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029;

export interface PhaseLine {
  mission: string;
  from: string;
  to: string;
}

/**
 * GL-12 `[FASE] <misi> | <dari> -> <ke> | HH:MM`. Pemindai linear yang hasilnya identik dengan
 * regex lama `/^\[FASE\]\s*(.+?)\s*\|\s*(.+?)\s*->\s*(.+?)\s*\|\s*\d{1,2}:\d{2}\s*$/` untuk SEMUA
 * masukan (urutan prioritas backtracking yang sama: grup malas sependek mungkin dari kiri, `\s*`
 * rakus), tanpa waktu kubik regex itu (L-3, CWE-1333). Kunci kesetaraan:
 *   - `|` ekor = `|` terakhir baris (sesudahnya hanya spasi/jam), sisa ekor diperiksa sekali;
 *   - keberhasilan dari sebuah `->` (grup 3) dan dari sebuah `|` (grup 2 + 3) hanya bergantung pada
 *     posisi tanda itu, jadi dihitung sekali per posisi lalu "tanda baik berikutnya" dicari mundur;
 *   - kandidat akhir grup naik monoton dengan posisi tanda, sehingga tanda baik pertama = hasil regex.
 * Dibuktikan uji diferensial acak terhadap regex lama (`fiximp-import-contract.test.ts`).
 */
export function parsePhaseLine(t: string): PhaseLine | null {
  if (!t.startsWith(PHASE_PREFIX)) return null;
  const n = t.length;
  const tailPipe = t.lastIndexOf("|");
  if (tailPipe < PHASE_PREFIX.length || !PHASE_TIME_TAIL_RE.test(t.slice(tailPipe + 1))) return null;

  const ws = new Uint8Array(n);
  for (let i = 0; i < n; i++) ws[i] = WS_CHAR_RE.test(t[i]) ? 1 : 0;
  // wsStart[i]: j terkecil dengan t[j..i) seluruhnya spasi; wsEnd[i]: j terbesar dengan t[i..j) spasi.
  const wsStart = new Int32Array(n + 1);
  for (let i = 1; i <= n; i++) wsStart[i] = ws[i - 1] ? wsStart[i - 1] : i;
  const wsEnd = new Int32Array(n + 2);
  wsEnd[n] = n;
  wsEnd[n + 1] = n + 1;
  for (let i = n - 1; i >= 0; i--) wsEnd[i] = ws[i] ? wsEnd[i + 1] : i;
  // nextTerm[i]: pemutus baris pertama di/sesudah i (n bila tidak ada); grup `.+?` tidak melewatinya.
  const nextTerm = new Int32Array(n + 2);
  nextTerm[n] = n;
  nextTerm[n + 1] = n;
  for (let i = n - 1; i >= 0; i--) nextTerm[i] = isLineTerminator(t.charCodeAt(i)) ? i : nextTerm[i + 1];

  // Grup 3 mulai a3: akhir terpendek e3 dengan t[e3..tailPipe) seluruhnya spasi.
  const tailWs = wsStart[tailPipe];
  const g3At = (a3: number): number => {
    if (a3 >= tailPipe) return -1;
    const e3 = Math.max(a3 + 1, tailWs);
    return nextTerm[a3] >= e3 ? e3 : -1;
  };

  // Per `->` di b: mulai grup 3 pertama yang berhasil (`\s*` rakus -> dari spasi terjauh, mundur).
  const arrowA3 = new Int32Array(n + 2).fill(-1);
  const arrowE3 = new Int32Array(n + 2).fill(-1);
  const nextArrow = new Int32Array(n + 2).fill(-1);
  for (let b = n - 2; b >= 0; b--) {
    nextArrow[b] = nextArrow[b + 1];
    if (t.charCodeAt(b) !== 0x2d || t.charCodeAt(b + 1) !== 0x3e) continue;
    for (let a3 = wsEnd[b + 2]; a3 >= b + 2; a3--) {
      const e3 = g3At(a3);
      if (e3 >= 0) {
        arrowA3[b] = a3;
        arrowE3[b] = e3;
        nextArrow[b] = b;
        break;
      }
    }
  }
  // Grup 2 mulai a2: `->` baik pertama sesudahnya; akhir e2 = awal spasi yang mendahului `->`.
  const g2At = (a2: number): { e2: number; b: number } | null => {
    if (a2 + 1 > n) return null;
    const b = nextArrow[a2 + 1];
    if (b < 0) return null;
    const e2 = Math.max(a2 + 1, wsStart[b]);
    return e2 <= nextTerm[a2] ? { e2, b } : null;
  };

  // Per `|` di p: mulai grup 2 pertama yang berhasil.
  const pipeA2 = new Int32Array(n + 2).fill(-1);
  const nextPipe = new Int32Array(n + 2).fill(-1);
  for (let p = n - 1; p >= 0; p--) {
    nextPipe[p] = nextPipe[p + 1];
    if (t.charCodeAt(p) !== 0x7c) continue;
    for (let a2 = wsEnd[p + 1]; a2 >= p + 1; a2--) {
      if (g2At(a2)) {
        pipeA2[p] = a2;
        nextPipe[p] = p;
        break;
      }
    }
  }

  // Grup 1 mulai a0: `|` baik pertama sesudahnya; akhir e1 = awal spasi yang mendahului `|`.
  for (let a0 = wsEnd[PHASE_PREFIX.length]; a0 >= PHASE_PREFIX.length; a0--) {
    const p = nextPipe[a0 + 1];
    if (p < 0) continue;
    const e1 = Math.max(a0 + 1, wsStart[p]);
    if (e1 > nextTerm[a0]) continue;
    const a2 = pipeA2[p];
    const g2 = g2At(a2)!;
    return { mission: t.slice(a0, e1), from: t.slice(a2, g2.e2), to: t.slice(arrowA3[g2.b], arrowE3[g2.b]) };
  }
  return null;
}

/** Semua id kartu C34 dalam teks, unik, urut kemunculan. */
export function cardIdsIn(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(CARD_ID_SCAN_RE)) seen.add(m[0]);
  return [...seen];
}

export function contractKeyOf(v: string): string | null {
  const t = cleanValue(v);
  return CONTRACT_KEY_RE.test(t) ? t : null;
}

const DATE_LEAD_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?)?(?:\s*(Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d|WIB)(?![A-Za-z0-9]))?/;

export interface ParsedReportedAt {
  value: string;
  /** Jam ada tetapi zona tidak: hanya tanggal yang dipakai (zona tidak ditebak). */
  timeDropped: boolean;
}

/**
 * Tanggal/waktu lapor (C37). Jam tanpa zona -> hanya tanggal (`timeDropped`); `WIB` -> `+07:00`;
 * `+0700` -> `+07:00`. Tanggal di luar kalender -> `null`. `whole`: seluruh string harus terpakai.
 */
export function parseReportedAt(v: string, whole = false): ParsedReportedAt | null {
  const t = cleanValue(v);
  const m = DATE_LEAD_RE.exec(t);
  if (!m) return null;
  if (whole && m[0].length !== t.length) return null;
  const [, y, mo, d, hh, mm, ss, zone] = m;
  if (!isCalendarDay(Number(y), Number(mo), Number(d))) return null;
  const date = `${y}-${mo}-${d}`;
  let value = date;
  let timeDropped = false;
  if (hh !== undefined) {
    if (zone === undefined) timeDropped = true;
    else {
      const z = zone === "WIB" ? "+07:00" : zone === "Z" ? "Z" : zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone;
      value = `${date}T${hh}:${mm}${ss !== undefined ? `:${ss}` : ""}${z}`;
    }
  }
  return REPORTED_AT_RE.test(value) ? { value, timeDropped } : null;
}

// ── Bukti (GL-03) ────────────────────────────────────────────────────────

const PATH_RE = /(?:^|[\s(`'"])((?:[A-Za-z]:)?[A-Za-z0-9_.~\\/-]*[A-Za-z0-9_~-]\.[A-Za-z0-9]{1,8})(?=$|[\s)`'",:;])/;
const BYTES_RE = /(?<![\d.])(\d{1,3}(?:\.\d{3})+|\d+)\s?B\b/;
const SHA_RE = /sha[0-9a-z[\]:]*\s*[=: ]\s*`?([0-9a-f]{8,64})\b/i;

export interface EvidenceSegment {
  ref: string;
  bytes?: number;
  sha256?: string;
}

/**
 * GL-03: setiap segmen dipisah `;` yang memuat path berekstensi -> bukti `file`;
 * `NN B`/`NN.NNN B` -> `bytes` (titik ribuan dibuang); heksa >= 8 sesudah `sha` -> `sha256`.
 * Segmen tanpa path hanya teks (tidak dikembalikan).
 */
export function evidenceSegments(text: string): EvidenceSegment[] {
  const out: EvidenceSegment[] = [];
  for (const seg of text.split(";")) {
    const p = PATH_RE.exec(seg);
    if (!p) continue;
    const ref = p[1].replace(/[.]+$/, "");
    if (!/\.[A-Za-z0-9]{1,8}$/.test(ref) || /^\d+(\.\d+)*$/.test(ref) || ref.length > 500) continue;
    const e: EvidenceSegment = { ref };
    const b = BYTES_RE.exec(seg);
    if (b) e.bytes = Number(b[1].replace(/\./g, ""));
    const s = SHA_RE.exec(seg);
    if (s) e.sha256 = s[1].toLowerCase();
    out.push(e);
  }
  return out;
}
