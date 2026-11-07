/**
 * Pemindai teks grup X (S44): port perilaku datum_lint.py (c03, c04, c16, c17,
 * c19, c31, c38, c39) dan datumcheck.py (check_heading, name_guard), HS
 * read-only. ID cek persis registri lint (DATUM-nn, N1).
 *
 * Setiap pemeriksa mengembalikan temuan (`Finding`); runner mengubahnya
 * menjadi LintIssue FAIL beralamat, atau satu PASS bila bersih.
 */
import type { ParamMap, ParamValue } from "../../../contract";
import { PARAMS_BY_KEY } from "../../../params";
import type { NameRef, TextSegment } from "./walk";

export interface Finding {
  checkId: string;
  detail: string;
  address?: string;
  pointer?: string;
}

// ── Parameter ─────────────────────────────────────────────────────────────

/** Nilai parameter templat, jatuh ke default registri bila absen. */
export function paramValue(params: ParamMap, key: string): ParamValue | undefined {
  const v = params[key];
  if (v !== undefined) return v;
  return PARAMS_BY_KEY.get(key)?.default;
}

export function paramNumber(params: ParamMap, key: string, fallback: number): number {
  const v = paramValue(params, key);
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function paramBool(params: ParamMap, key: string, fallback: boolean): boolean {
  const v = paramValue(params, key);
  return typeof v === "boolean" ? v : fallback;
}

/** P11-41 `prose.emDash` (D-32, KT-06): default kode `{maxPer1000Words: 0, inHeadings: 0}`. */
export function emDashLimits(params: ParamMap): { maxPer1000Words: number; inHeadings: number } {
  const v = paramValue(params, "prose.emDash");
  const o = typeof v === "object" && v !== null && !Array.isArray(v) ? v : {};
  const num = (x: ParamValue | undefined, d: number): number => (typeof x === "number" && Number.isFinite(x) ? x : d);
  return { maxPer1000Words: num(o.maxPer1000Words, 0), inHeadings: num(o.inHeadings, 0) };
}

// ── Teks gabungan dengan peta offset -> segmen ───────────────────────────

export interface Body {
  text: string;
  starts: number[];
  segments: readonly TextSegment[];
}

export function joinSegments(segments: readonly TextSegment[]): Body {
  const starts: number[] = [];
  let pos = 0;
  const parts: string[] = [];
  for (const s of segments) {
    starts.push(pos);
    parts.push(s.text);
    pos += s.text.length + 1;
  }
  return { text: parts.join("\n"), starts, segments };
}

function segAt(body: Body, index: number): TextSegment | undefined {
  let lo = 0;
  let hi = body.starts.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (body.starts[mid] <= index) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans >= 0 ? body.segments[ans] : undefined;
}

function at(body: Body, index: number): Pick<Finding, "address" | "pointer"> {
  const s = segAt(body, index);
  return s ? { address: s.address, pointer: s.pointer } : {};
}

/** Padanan Python `repr()` ringkas untuk detail. */
function q(s: string): string {
  return JSON.stringify(s);
}

// ── DATUM-03 em dash per 1.000 kata; nol di judul ─────────────────────────

const EM_DASH = "—";

export function countWords(text: string): number {
  return (text.match(/\S+/g) ?? []).length;
}

export function emDashRate(text: string): { count: number; words: number; per1000: number } {
  const count = text.split(EM_DASH).length - 1;
  const words = countWords(text);
  return { count, words, per1000: (count / Math.max(1, words)) * 1000 };
}

/**
 * Cap terbit DATUM `// YYYYMMDD BAHASA KELAS — TERBITAN n` (format aparatus
 * kolofon sampul): em dash di dalamnya bagian format mesin, bukan prosa,
 * di mana pun string itu muncul (kolofon atau tabel spesifikasi perangkat).
 */
const STAMP_DASH = /(\/\/[^\n/—]{1,60}?)—(\s*TERBITAN\b)/gu;

function stripStampDash(text: string): string {
  return text.includes(EM_DASH) ? text.replace(STAMP_DASH, "$1$2") : text;
}

/**
 * DATUM-03 (D-263): ambang tetap; yang dihitung hanya teks penulis. Segmen
 * aparatus mesin/templat (cap terbit, identitas, blok kendali sampul), sel
 * kolom "Salah" tabel contoh salah/benar (`TextSegment.role`) dan em dash di
 * dalam string cap terbit tidak dihitung.
 */
export function check03(body: Body, params: ParamMap): Finding[] {
  const lim = emDashLimits(params);
  const out: Finding[] = [];
  const authored = body.segments.filter((s) => !s.role).map((s) => ({ address: s.address, text: stripStampDash(s.text) }));
  const r = emDashRate(authored.map((s) => s.text).join("\n"));
  if (r.per1000 > lim.maxPer1000Words) {
    const excl = emDashRate(body.text).count - r.count;
    const where = [...new Set(authored.filter((s) => s.text.includes(EM_DASH)).map((s) => s.address))].slice(0, 5);
    out.push({
      checkId: "DATUM-03",
      detail: `${r.per1000.toFixed(2)} em dash per 1.000 kata (${r.count} dalam ${r.words} kata) > maks ${lim.maxPer1000Words} (prose.emDash)${where.length ? `; di ${where.join(", ")}` : ""}${excl > 0 ? `; ${excl} em dash aparatus/contoh salah tidak dihitung` : ""}`,
    });
  }
  const heads = body.segments.filter((s) => s.heading && s.text.includes(EM_DASH));
  if (heads.length > lim.inHeadings) {
    for (const h of heads) {
      out.push({
        checkId: "DATUM-03",
        detail: `em dash di judul ${q(h.text.slice(0, 60))} (${heads.length} judul > maks ${lim.inHeadings})`,
        address: h.address,
        pointer: h.pointer,
      });
    }
  }
  return out;
}

// ── DATUM-04 judul berbentuk pertanyaan ──────────────────────────────────

/**
 * RL datum_lint.py Rev K (E-27; references/06-lint.md:129): judul adalah
 * pertanyaan hanya bila berakhiran "?". Label berawalan kata tanya ("Siapa
 * memiliki keputusan apa") adalah label, bukan pertanyaan. D-263 merevisi D-55
 * (gabungan c04 HS + datumcheck check_heading tidak dipakai lagi).
 */
const Q_END = /\?\s*$/;

export function questionHeading(text: string): string | null {
  return Q_END.test(text.trim()) ? "berakhir tanda tanya" : null;
}

export function check04(segments: readonly TextSegment[]): Finding[] {
  const out: Finding[] = [];
  for (const s of segments) {
    if (!s.heading) continue;
    const why = questionHeading(s.text);
    if (why) out.push({ checkId: "DATUM-04", detail: `judul ${q(s.text.trim().slice(0, 60))}: ${why}; setiap judul adalah klaim`, address: s.address, pointer: s.pointer });
  }
  return out;
}

// ── DATUM-16 nilai dan satuan tanpa spasi ────────────────────────────────

const UNITS_16 = "mm|cm|km|kg|ton|kW|kVA|kWh|VA|dB|Hz|kHz|MHz|dpi|persen";
/** Persis datum_lint.py c16 (lookahead hanya pada alternatif terakhir, sama seperti Python). */
const RE_16 = new RegExp("\\d(?:%|" + UNITS_16 + "(?![A-Za-z0-9]))", "g");
/** TICKET-INS-B: bentang URL dikosongkan sebelum memindai. */
const URL_SPAN = /https?:\/\/[^\s]+/g;

export function find16(text: string): string[] {
  return text.replace(URL_SPAN, " ").match(RE_16) ?? [];
}

export function check16(segments: readonly TextSegment[]): Finding[] {
  const out: Finding[] = [];
  for (const s of segments) {
    for (const h of find16(s.text)) {
      if (out.length >= 20) return out; // Python: hits[:20]
      out.push({ checkId: "DATUM-16", detail: `${q(h)} nilai menempel satuan tanpa spasi`, address: s.address, pointer: s.pointer });
    }
  }
  return out;
}

// ── DATUM-17 ± tanpa arti ─────────────────────────────────────────────────

const MEANING_17 = /toleransi|tolerance|ketidakpastian|uncertainty|deviasi|rentang|range|artinya|menyatakan|maksimum|minimum/i;

/**
 * FIX-L (F-062): `±` dinilai bila dipakai sebagai operator besaran, yaitu
 * operan pada baris yang sama berupa angka (`± 0,1`, `±3 %`) atau simbol satu
 * huruf (`± U`, `±σ`). `±` yang disusul kata (`± tanpa arti`, `± berarti`) atau
 * akhir baris adalah penyebutan tanda itu sendiri (nama aturan, butir periksa),
 * bukan nilai yang maknanya ambigu (GUM; RL references/06-lint.md cek 17).
 * Jendela makna untuk `±` besaran tidak berubah.
 */
const PM_OPERAND_17 = /^[ \t\u00a0\u202f]*\(?(?:[+\-\u2212]?\d|\p{L}(?!\p{L}))/u;

export function isQuantityPlusMinus(text: string, index: number): boolean {
  return PM_OPERAND_17.test(text.slice(index + 1, index + 24));
}

export function check17(body: Body): Finding[] {
  const out: Finding[] = [];
  const t = body.text;
  for (let i = t.indexOf("±"); i >= 0; i = t.indexOf("±", i + 1)) {
    if (!isQuantityPlusMinus(t, i)) continue;
    const w = t.slice(Math.max(0, i - 120), i + 140);
    if (!MEANING_17.test(w)) {
      out.push({ checkId: "DATUM-17", detail: `± tanpa arti: ${q(w.slice(100, 160).replace(/\n/g, " "))}`, ...at(body, i) });
    }
  }
  return out;
}

// ── DATUM-19 PPN selain 11 % non-mewah 2026 ──────────────────────────────

const RE_19 = /(?:PPN|VAT|Pajak Pertambahan Nilai)[^.\n%]{0,25}?(\d{1,2})\s*(?:%|persen)/g;

/** Tarif sah: efektif (P6-26, 11) atau nominal (P6-24, 12) bersama DPP. */
export function check19(body: Body, params: ParamMap): Finding[] {
  const eff = paramNumber(params, "vat.effectiveRatePercent", 11);
  const nom = paramNumber(params, "vat.nominalRatePercent", 12);
  const out: Finding[] = [];
  const t = body.text;
  RE_19.lastIndex = 0;
  for (let m = RE_19.exec(t); m; m = RE_19.exec(t)) {
    const rate = parseInt(m[1], 10);
    const seg = t.slice(Math.max(0, m.index - 40), m.index + 60);
    if (rate === eff) continue;
    if (rate === nom && /DPP/.test(seg)) continue; // 12 % x DPP = efektif 11 %
    out.push({ checkId: "DATUM-19", detail: `tarif ${rate} % dekat PPN: ${q(seg.replace(/\n/g, " ").slice(0, 90))}`, ...at(body, m.index) });
  }
  return out;
}

// ── DATUM-31 sumber Mermaid dalam berkas terbit ──────────────────────────

const RE_31 = /^\s*(graph (?:TD|LR|BT|RL)|flowchart (?:TD|LR)|sequenceDiagram)\b/gm;

export function check31(body: Body): Finding[] {
  const out: Finding[] = [];
  const t = body.text;
  RE_31.lastIndex = 0;
  for (let m = RE_31.exec(t); m; m = RE_31.exec(t)) {
    const idx = m.index + m[0].length - m[1].length;
    out.push({ checkId: "DATUM-31", detail: `sumber Mermaid ${q(m[1])}`, ...at(body, idx) });
    if (m[0].length === 0) RE_31.lastIndex++;
  }
  return out;
}

// ── DATUM-39 residu rentang token tertelan ───────────────────────────────

const RE_39_RESIDU = /[a-z] through [A-Z]-[0-9]/;
const RE_39_LEMAH = /\b(?:list|capture) [A-Z]-[0-9]\b/;

export function find39(paragraph: string): string | null {
  let m = RE_39_RESIDU.exec(paragraph);
  if (m) return `residu rentang: ...${paragraph.slice(Math.max(0, m.index - 20), m.index + m[0].length + 10)}...`;
  m = RE_39_LEMAH.exec(paragraph);
  if (m) return `varian rentang: ...${paragraph.slice(Math.max(0, m.index - 20), m.index + m[0].length + 10)}...`;
  return null;
}

export function check39(segments: readonly TextSegment[]): Finding[] {
  const out: Finding[] = [];
  for (const s of segments) {
    for (const para of s.text.split("\n")) {
      const d = find39(para);
      if (d) out.push({ checkId: "DATUM-39", detail: d, address: s.address, pointer: s.pointer });
    }
  }
  return out;
}

// ── N1 / DATUM-38 garis bawah pada nama ──────────────────────────────────

/** `naming.underscore.allowed` (P3-09) true = pemeriksaan dilepas. */
export function checkNames(checkId: "N1" | "DATUM-38", names: readonly NameRef[], params: ParamMap): Finding[] {
  if (paramBool(params, "naming.underscore.allowed", false)) return [];
  const out: Finding[] = [];
  for (const n of names) {
    if (n.name.includes("_")) {
      out.push({
        checkId,
        detail: `nama ${n.kind} ${q(n.name)} memuat garis bawah; pakai spasi atau tanda hubung (DT-12)`,
        pointer: n.pointer,
      });
    }
  }
  return out;
}
