/**
 * IMPL-W2 (D-522, D-527): jalur tulis minimal untuk DOKUMEN KLIEN (templat DATUM). Agen mengirim `meta` datar +
 * bagian (judul + blok); modul murni ini menyusun semua bentuk yang dipahami server: `DocMetaV2` (tanpa `docNumber`
 * server), payload slot `cover` (blok kendali dengan NOMOR TAMPILAN dari meta), `controlSheet`, `signature`, dan satu
 * `ChapterV2` per bagian (tabel/grafik selalu berketerangan + bersumber; kode grafik dipilih mesin). Penomoran bab,
 * tabel ("Tabel N.M"), dan gambar ("Gambar N.M") dihitung server dari kunci bab, jadi kunci bab = nomor bab di judul
 * (bila ada dan naik) atau urutan. Tanpa I/O.
 */
import type { InlineV2 } from "../../../src/lib/studio/contract";
import { STUDIO_TIERS } from "../../../src/lib/studio/contract/enums";
import { chapterLabelText, CONTROL_FIELD_LABELS, FRONT_PAYLOAD_LABELS, WRAPPER_TEXT, type WrapperLang } from "../../../src/lib/studio/engine/front/texts";
import { parseInline } from "../../../src/lib/studio/services/import/inline";
import { McpToolError } from "./safety";
import { tok, type ToolWarning } from "./tool-kit";
import { isRows, type Cell, type ChartInput, type Rows } from "./write-content";

type Rec = Record<string, unknown>;
const NOOP = { warn: () => undefined, drop: () => undefined };
const inl = (s: string): InlineV2 => parseInline(s.replace(/\s+/g, " ").trim(), NOOP);
const txt = (s: string): InlineV2 => ({ text: s.replace(/\s+/g, " ").trim() });

// ── meta ────────────────────────────────────────────────────────────────

export type MetaField =
  | "title" | "number" | "rev" | "date" | "author" | "checker" | "approver" | "classification" | "audience" | "custodian"
  | "subject" | "basis" | "language" | "tier" | "standfirst" | "method" | "distribution" | "source" | "revisionNote";

const META_ALIASES: Readonly<Record<string, MetaField>> = {
  title: "title", judul: "title",
  number: "number", nomor: "number", "nomor dokumen": "number", docnumber: "number", "doc number": "number", "document number": "number", no: "number",
  rev: "rev", revisi: "rev", revision: "rev",
  date: "date", tanggal: "date", issuedate: "date", "tanggal terbit": "date",
  author: "author", penyusun: "author", penulis: "author", "disusun oleh": "author",
  checker: "checker", pemeriksa: "checker", reviewer: "checker", "diperiksa oleh": "checker",
  approver: "approver", penyetuju: "approver", "disetujui oleh": "approver",
  classification: "classification", klasifikasi: "classification",
  audience: "audience", "ditujukan kepada": "audience", kepada: "audience",
  custodian: "custodian", kustodian: "custodian",
  subject: "subject", perihal: "subject", subjek: "subject",
  basis: "basis", dasar: "basis",
  language: "language", bahasa: "language",
  tier: "tier",
  standfirst: "standfirst", subtitle: "standfirst", abstrak: "standfirst",
  method: "method", metode: "method", "pernyataan metode": "method",
  distribution: "distribution", distribusi: "distribution",
  source: "source", sumber: "source",
  revisionnote: "revisionNote", "revision note": "revisionNote", "catatan revisi": "revisionNote", perubahan: "revisionNote",
};

export type ClientMeta = Partial<Record<MetaField, string>>;
const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Kunci meta agen -> medan kanonik (alias, camelCase, _ dan -); undefined = tidak dikenal. */
export function metaFieldOf(k: string): MetaField | undefined {
  const key = k.trim().replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  return META_ALIASES[k.trim().toLowerCase()] ?? META_ALIASES[key] ?? META_ALIASES[key.replace(/ /g, "")];
}

/** IMPL-W4 W4-I1: nomor meta = nomor TAMPILAN (sampul/lembar kendali), bukan nomor dokumen server (D-527). */
export const NUMBER_DISPLAY_ONLY: ToolWarning = { code: "NUMBER_DISPLAY_ONLY", message: "meta.number/docNumber = nomor tampilan di sampul dan lembar kendali; nomor dokumen server tidak berubah" };

/** Meta datar agen -> medan kanonik; kunci tak dikenal = peringatan. title + author wajib (tidak dikarang). */
export function normalizeMeta(raw: Record<string, string>, title: string | null, today: string, warn: (w: ToolWarning) => void): ClientMeta {
  const m: ClientMeta = {};
  const unknown: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    // IMPL-W3 butir 3: kunci dinormalkan (camelCase, _ dan - menjadi spasi) sebelum alias dicari.
    const key = k.trim().replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
    const f = META_ALIASES[k.trim().toLowerCase()] ?? META_ALIASES[key] ?? META_ALIASES[key.replace(/ /g, "")];
    const val = String(v).replace(/\s+/g, " ").trim();
    if (f === undefined) unknown.push(k);
    else if (val !== "") m[f] = val;
  }
  if (title !== null && title.trim() !== "") m.title = title.replace(/\s+/g, " ").trim();
  if (Object.keys(raw).some((k) => metaFieldOf(k) === "number")) warn(NUMBER_DISPLAY_ONLY);
  if (unknown.length > 0) warn({ code: "META_IGNORED", message: `meta tidak dikenal: ${unknown.slice(0, 8).join(", ")} (dikenal: title, number, rev, date, author, checker, approver, classification, audience, custodian, subject, basis, language, tier, standfirst, method, distribution, source)` });
  const missing = (["title", "author"] as const).filter((f) => m[f] === undefined);
  if (missing.length > 0) {
    throw new McpToolError("META_MISSING", `meta wajib untuk dokumen klien: ${missing.join(", ")} (judul dan penyusun dicetak di sampul, lembar kendali, dan tanda tangan; tidak dikarang). Contoh: "meta": { "title": "...", "author": "...", "number": "..." }. Tidak ada yang dikirim`, { details: { missing } });
  }
  if (m.date !== undefined && !ISO_DATE.test(m.date)) {
    warn({ code: "DATE_DEFAULTED", message: `meta.date "${m.date}" bukan YYYY-MM-DD; dipakai ${today}` });
    m.date = today;
  }
  m.date ??= today;
  if (m.language !== undefined) {
    const l = m.language.toUpperCase();
    m.language = l === "EN" || l === "ENGLISH" || l === "INGGRIS" ? "EN" : "ID";
  }
  // S12: meta.tier = medan DocMetaV2 yang ada (tier dokumen; menang atas `doc.defaultTier` templat di server).
  if (m.tier !== undefined) {
    const t = m.tier.toUpperCase();
    if ((STUDIO_TIERS as readonly string[]).includes(t)) m.tier = t;
    else {
      warn({ code: "TIER_IGNORED", message: `meta.tier "${tok(m.tier, "(bukan token aman)")}" bukan ${STUDIO_TIERS.join("/")}; tier bawaan templat dipakai` });
      delete m.tier;
    }
  }
  return m;
}

/** DocMetaV2 untuk R04/R14: TANPA docNumber (nomor unik server; D-527: nomor meta = nomor tampilan). */
export function docMetaOf(m: ClientMeta, warn: (w: ToolWarning) => void): Rec {
  const out: Rec = { title: m.title };
  if (m.rev !== undefined) {
    if (/^[A-Z]{1,2}$/.test(m.rev.toUpperCase())) out.rev = m.rev.toUpperCase();
    else warn({ code: "REV_DISPLAY_ONLY", message: `meta.rev "${m.rev}" bukan huruf revisi (A, B, ...); hanya dicetak di sampul/lembar kendali` });
  }
  for (const f of ["classification", "author", "custodian", "audience", "basis", "subject"] as const) if (m[f] !== undefined) out[f] = m[f];
  if (m.language !== undefined) out.language = m.language;
  if (m.tier !== undefined) out.tier = m.tier;
  if (m.date !== undefined) out.issueDate = m.date;
  return out;
}

/**
 * S12 (research/33 B-08, register research/31 §4.3): label slot depan klien. Label yang sama dengan blok kendali sampul
 * auto dan kicker lembar kendali diambil dari tabel teks bersama (`engine/front/texts.ts`), jadi tidak bisa menyimpang.
 * Label isi slot depan lainnya (`classification`, `made`, `checked`, `approved`, `first`) = `FRONT_PAYLOAD_LABELS` di
 * tabel yang sama (S13).
 */

/** Label medan blok kendali dari tabel bersama; kunci yang hilang = galat pemrograman, gagal keras saat modul dimuat. */
function controlFieldLabel(field: string): Readonly<Record<WrapperLang, string>> {
  const l = CONTROL_FIELD_LABELS[field] as Readonly<Record<WrapperLang, string>> | undefined;
  if (l === undefined) throw new Error(`write-client: label ${field} tidak ada di CONTROL_FIELD_LABELS (engine/front/texts.ts)`);
  return l;
}

const CLIENT_LABELS = {
  number: controlFieldLabel("NOMOR DOKUMEN"),
  rev: controlFieldLabel("REVISI"),
  author: controlFieldLabel("PENYUSUN"),
  audience: controlFieldLabel("DITUJUKAN KEPADA"),
  custodian: controlFieldLabel("KUSTODIAN"),
  basis: controlFieldLabel("DASAR"),
  sheet: WRAPPER_TEXT.controlKicker,
  ...FRONT_PAYLOAD_LABELS,
} as const;

export type ClientLabelKey = keyof typeof CLIENT_LABELS;
export type ClientLabels = Readonly<Record<ClientLabelKey, string>>;

function labelSet(lang: WrapperLang): ClientLabels {
  const out = {} as Record<ClientLabelKey, string>;
  for (const k of Object.keys(CLIENT_LABELS) as ClientLabelKey[]) out[k] = CLIENT_LABELS[k][lang];
  return out;
}
const LABELS: Readonly<Record<WrapperLang, ClientLabels>> = { ID: labelSet("ID"), EN: labelSet("EN") };

/**
 * D-6 (research/33 R-3): label EN sebelum register S12. Hanya untuk MEMBACA dokumen EN lama (`write-meta.ts`); entri baru
 * selalu memakai `LABELS`. Label lain tidak berubah, jadi sama dengan `LABELS.EN`.
 */
export const LEGACY_EN_LABELS: ClientLabels = { ...LABELS.EN, author: "Author", made: "Prepared", checked: "Checked", approved: "Approved" };

/** Bahasa label: `language` = bahasa dokumen (meta agen, atau templat/dokumen bila agen tidak mengirimnya; F-1). */
export const labelLangOf = (language: string | undefined): WrapperLang => (language === "EN" ? "EN" : "ID");
export const labelsOf = (m: Pick<ClientMeta, "language">): ClientLabels => LABELS[labelLangOf(m.language)];

// ── slot dari meta ──────────────────────────────────────────────────────

/**
 * Slot depan dari meta. Sampul: blok kendali eksplisit HANYA bila meta.number ada (agar sampul mencetak nomor
 * tampilan, bukan nomor unik server); tanpa nomor, blok kendali otomatis mesin dipakai.
 */
/**
 * IMPL-W3 butir 5/11: kode revisi pendek (<= 16 karakter, batas `revisionHistory.rev`) dari teks revisi agen. "Rev 0,
 * terbitan pertama" -> "Rev 0"; teks penuh disimpan di catatan revisi (`what`), jadi tidak ada yang hilang.
 */
export function shortRev(full: string): string {
  const t = full.replace(/\s+/g, " ").trim();
  if (t.length <= 16 && !/[,;:(]/.test(t)) return t;
  const m = /^(?:rev(?:isi|ision)?\.?\s*)?[A-Za-z0-9]{1,4}(?:\.[0-9]{1,3})?/i.exec(t);
  const head = m !== null ? m[0].trim() : t.split(/[\s,;:]+/)[0];
  return (head !== "" ? head : t).slice(0, 16);
}

const fit = (s: string, max: number, what: string, warn: (w: ToolWarning) => void): string => {
  if (s.length <= max) return s;
  warn({ code: "FIELD_SHORTENED", message: `${what} lebih dari ${max} karakter (batas lembar kendali); dipotong` });
  return s.slice(0, max);
};

/** `lang` = bahasa label (bawaan: meta.language; F-1: pemanggil memberi bahasa dokumen dari templat bila meta tanpa language). */
export function frontSlots(m: ClientMeta, warn: (w: ToolWarning) => void, lang: WrapperLang = labelLangOf(m.language)): { cover: Rec; controlSheet: Rec; signature: Rec } {
  const L = LABELS[lang];
  const revShown = m.rev !== undefined ? shortRev(m.rev) : "A";
  if (m.rev === undefined) warn({ code: "REV_DEFAULTED", message: "meta.rev tidak diisi; revisi A dipakai di lembar kendali" });
  const revFull = m.rev !== undefined && revShown !== m.rev.replace(/\s+/g, " ").trim() ? m.rev.replace(/\s+/g, " ").trim() : null;
  if (revFull !== null) warn({ code: "REV_SPLIT", message: `meta.rev panjang: kode "${revShown}" di kolom revisi, teks penuh di catatan revisi` });
  const revWhat = [revFull, m.revisionNote].filter((x): x is string => typeof x === "string" && x.trim() !== "").join("; ") || L.first;
  const cover: Rec = { type: "cover" };
  if (m.number !== undefined) {
    const pairs: Array<[string, string]> = [[L.number, m.number], [L.rev, `${revShown} · ${m.date}`], [L.author, m.author as string]];
    for (const f of ["classification", "audience", "custodian", "basis"] as const) if (m[f] !== undefined) pairs.push([L[f], m[f] as string]);
    const rows: InlineV2[][] = [];
    for (let i = 0; i < pairs.length; i += 2) {
      const r = pairs[i + 1] ?? ["", ""];
      rows.push([txt(pairs[i][0]), txt(pairs[i][1]), txt(r[0]), txt(r[1])]);
    }
    cover.control = rows;
  }
  if (m.standfirst !== undefined) cover.standfirst = inl(m.standfirst);
  // IMPL-W3 butir 5: medan lembar kendali disesuaikan batas skema (rev 16, nama/peran 200, catatan 2000).
  const name = (s: string, what: string) => fit(s, 200, what, warn);
  const chain = [
    { layer: "1", role: L.author, name: name(m.author as string, "penyusun") },
    ...(m.checker !== undefined ? [{ layer: "2", role: L.checked, name: name(m.checker, "pemeriksa") }] : []),
    ...(m.approver !== undefined ? [{ layer: m.checker !== undefined ? "3" : "2", role: L.approved, name: name(m.approver, "penyetuju") }] : []),
  ];
  const controlSheet: Rec = {
    type: "controlSheet",
    ...(m.number !== undefined ? { title: txt(`${L.sheet} ${m.number}`) } : {}),
    revisionHistory: [{ rev: revShown, date: m.date, what: fit(revWhat, 2000, "catatan revisi", warn), by: name(m.author as string, "penyusun") }],
    verificationChain: chain,
    ...(m.method !== undefined ? { methodStatement: inl(m.method) } : {}),
    ...(m.distribution !== undefined ? { distribution: m.distribution.split(/[;,]/).map((h) => h.trim()).filter((h) => h !== "").map((holder, i) => ({ copy: String(i + 1), holder: name(holder, "pemegang salinan") })) } : {}),
  };
  const signature: Rec = {
    type: "signatureBlock",
    roles: [
      { role: txt(L.made), holder: txt(m.author as string), date: txt(m.date as string) },
      ...(m.checker !== undefined ? [{ role: txt(L.checked), holder: txt(m.checker) }] : []),
      ...(m.approver !== undefined ? [{ role: txt(L.approved), holder: txt(m.approver) }] : []),
    ],
  };
  return { cover, controlSheet, signature };
}

// ── grafik ──────────────────────────────────────────────────────────────

export type ClientChart = ChartInput & { stacked?: boolean };
const CODE_RE = /^[A-Z]{1,2}-\d{2}$/;
const FRIENDLY: Readonly<Record<string, string>> = { bar: "P-01", column: "P-02", grouped: "P-03", "grouped column": "P-03", stacked: "K-01", "stacked bar": "K-01", line: "W-01", area: "W-04", "stacked area": "W-05", lollipop: "P-04", dumbbell: "P-06", slope: "P-08", "small multiples": "P-12" };

/**
 * Kode grafik dari bentuk data (D-527: agen tidak perlu kode). 1 seri: label panjang (> 14) atau > 8 kategori -> P-01
 * (bar urut), selain itu P-02 (kolom); >= 2 seri: `stacked` -> K-01, 2..3 seri -> P-03 (kolom berkelompok), 4..6 seri ->
 * P-12 (small multiples), > 6 seri tanpa `stacked` -> ditolak. `type` (kode atau nama: bar, column, line, stacked, ...) menang.
 */
export function chartCodeOf(c: ClientChart, warn: (w: ToolWarning) => void, where: string): string {
  const t = c.type?.trim();
  if (t !== undefined && t !== "") {
    if (CODE_RE.test(t.toUpperCase())) return t.toUpperCase();
    const f = FRIENDLY[t.toLowerCase()];
    if (f !== undefined) return f === "P-02" && c.series.length > 1 ? "P-03" : f === "W-04" && c.series.length > 1 ? "W-05" : f;
    warn({ code: "CHART_TYPE_UNKNOWN", message: `${where}: type "${tok(t, "(bukan token aman)")}" tidak dikenal; kode dipilih mesin dari bentuk data` });
  }
  const n = c.series.length;
  if (n === 1) return c.categories.length > 8 || c.categories.some((x) => String(x).length > 14) ? "P-01" : "P-02";
  if (c.stacked === true) return "K-01";
  if (n <= 3) return "P-03";
  if (n <= 6) return "P-12";
  throw new McpToolError("CHART_TOO_MANY_SERIES", `${where}: ${n} seri tanpa stacked: true terlalu banyak untuk satu grafik (maks 6); pecah menjadi beberapa grafik atau set stacked: true. Tidak ada yang dikirim`);
}

// ── isu yang tidak dapat diperbaiki mesin (IMPL-W3 butir 5: dikumpulkan, satu jawaban) ──

export interface Issue {
  where: string;
  code: string;
  message: string;
}
export type IssueSink = (i: Issue) => void;
/** Tanpa pengumpul (mis. suntingan grafik): isu pertama langsung menjadi galat dengan kodenya sendiri. */
const THROW: IssueSink = (i) => {
  throw new McpToolError(i.code, `${i.where}: ${i.message}. Tidak ada yang dikirim`);
};

/** IMPL-W3 butir 9: prefiks nomor di caption ("Gambar 6.1", "Tabel 2.1:", "Figure 3 -") dibuang; mesin menomori sendiri. */
const CAPTION_PREFIX = /^\s*(?:gambar|tabel|grafik|diagram|figure|fig\.?|table|chart)\s+[A-Z]?\d+(?:[.\-–]\d+)*\s*[:.\-–—]?\s+/i;
export function stripCaptionPrefix(cap: string, warn: (w: ToolWarning) => void, where: string): string {
  const rest = cap.replace(CAPTION_PREFIX, "");
  if (rest === cap || rest.trim() === "") return cap;
  warn({ code: "CAPTION_PREFIX_STRIPPED", message: `${where}: nomor di awal caption dibuang (mesin mencetak "Tabel N.M"/"Gambar N.M" sendiri)` });
  return rest.trim();
}

/**
 * IMPL-W3 butir 10: sumber TIDAK pernah dikarang. Sumber = milik blok, atau `meta.source` yang diberi agen (peringatan);
 * tanpa keduanya -> isu SOURCE_MISSING (gerbang DATUM-10 server menolak tabel/gambar bercaption tanpa sumber).
 */
function sourceOf(given: string | undefined, metaSource: string | null, warn: (w: ToolWarning) => void, issue: IssueSink, where: string, what: string): string | null {
  if (given?.trim()) return given.trim();
  if (metaSource !== null) {
    warn({ code: "SOURCE_FROM_META", message: `${where}: ${what} tanpa source; dipakai meta.source yang Anda beri` });
    return metaSource;
  }
  issue({ where, code: "SOURCE_MISSING", message: `${what} bercaption tanpa source (gerbang DATUM-10); tambahkan source pada blok itu atau meta.source. Sumber tidak dikarang mesin` });
  return null;
}

/** Data grafik: kode berbentuk categorical (P-01/P-02/P-04/W-02/W-04 ...) -> points; selain itu series. */
const CATEGORICAL = new Set(["P-01", "P-02", "P-04", "P-09", "P-10", "P-11", "K-05", "K-06", "K-07", "K-08", "K-09", "K-10", "W-02", "W-04"]);
export function chartBlock(c: ClientChart, metaSource: string | null, warn: (w: ToolWarning) => void, where: string, chapterTitle: string, issue: IssueSink = THROW): Rec {
  const len = c.categories.length;
  if (c.series.some((s) => s.values.length !== len)) {
    issue({ where, code: "CHART_DATA_INVALID", message: `setiap seri harus punya ${len} nilai (sama dengan jumlah categories)` });
    return {};
  }
  let code: string;
  try {
    code = chartCodeOf(c, warn, where);
  } catch (e) {
    if (e instanceof McpToolError && issue !== THROW) {
      issue({ where, code: e.code, message: e.message.replace(`${where}: `, "").replace(/\. Tidak ada yang dikirim$/, "") });
      return {};
    }
    throw e;
  }
  const cats = c.categories.map((x) => String(x));
  let data: Rec;
  if (CATEGORICAL.has(code)) {
    const s = c.series[0];
    const points = cats.map((label, i) => ({ label, value: s.values[i] })).filter((p): p is { label: string; value: number } => typeof p.value === "number");
    if (points.length < len) warn({ code: "CHART_NULL_DROPPED", message: `${where}: ${len - points.length} nilai kosong dibuang dari grafik satu seri` });
    data = { shape: "categorical", points };
  } else data = { shape: "series", categories: cats, series: c.series.map((s) => ({ name: s.name, values: s.values })) };
  const caption = c.caption?.trim() ? stripCaptionPrefix(c.caption.trim(), warn, where) : `${c.series.map((s) => s.name).join(", ")} per ${chapterTitle}`;
  if (!c.caption?.trim()) warn({ code: "CAPTION_GENERATED", message: `${where}: grafik tanpa caption; keterangan dibangkitkan dari nama seri` });
  const source = sourceOf(c.source, metaSource, warn, issue, where, "grafik");
  return { type: "chart", code, data, ...(c.unit ? { unit: c.unit } : {}), caption: inl(caption), ...(source !== null ? { source: inl(source) } : {}) };
}

// ── tabel ───────────────────────────────────────────────────────────────

const NUMERAL = /^[−+-]?(?:\d{1,3}(?:[.,]\d{3})+|\d+)(?:[.,]\d+)?\s*%?$/;
export const cellOf = (c: Cell): Rec => {
  const s = String(c ?? "").replace(/\s+/g, " ").trim();
  if (s === "") return {};
  const i = inl(s);
  return "text" in i ? { text: i.text } : { runs: i.runs };
};

/** Satuan yang ditulis agen di caption: "(MW)", "dalam MW", "satuan: MW", "unit: MW" (maks 12/40 karakter). */
function unitInCaption(cap: string): string | null {
  const m = /\(([^()]{1,12})\)\s*$/.exec(cap) ?? /\b(?:satuan|unit)\s*[:=]\s*([^,;()]{1,40})/i.exec(cap) ?? /\bdalam\s+([A-Za-z%°$€£¥][^\s,;()]{0,15})\s*$/i.exec(cap);
  const u = m?.[1]?.trim();
  return u !== undefined && u !== "" && !/^\d+$/.test(u) ? u : null;
}

/**
 * Tabel selalu berketerangan (penomoran "Tabel N.M" butuh caption). IMPL-W3: sumber tidak dikarang (butir 10); satuan
 * hanya dari agen (butir 12): judul kolom, `unit` blok, atau caption -> metadata `unit` kolom angka (struktur tabel
 * sumber tetap verbatim, tidak ada kolom baru). Tanpa satuan sama sekali -> isu TABLE_UNIT_MISSING (gerbang DATUM-09).
 */
export function tableBlock(rows: Rows, caption: string | undefined, source: string | undefined, metaSource: string | null, warn: (w: ToolWarning) => void, where: string, chapterTitle: string, issue: IssueSink = THROW, unit?: string): Rec {
  const width = Math.max(1, ...rows.map((r) => r.length));
  if (width > 20) {
    issue({ where, code: "TABLE_TOO_WIDE", message: `tabel ${width} kolom; maks 20 (pecah menjadi beberapa tabel)` });
    return {};
  }
  const norm = rows.map((r) => (r.length === width ? r : [...r, ...Array.from({ length: width - r.length }, () => "")]));
  if (norm.some((r, i) => r !== rows[i])) warn({ code: "TABLE_ROW_PADDED", message: `${where}: baris tabel disamakan lebarnya (${width} kolom)` });
  const body = norm.slice(1);
  const columns: Rec[] = Array.from({ length: width }, (_, c) => {
    const vals = body.map((r) => String(r[c] ?? "").trim()).filter((v) => v !== "");
    return vals.length > 0 && vals.every((v) => NUMERAL.test(v)) ? { role: "numeral" } : { role: "text" };
  });
  const cells = body.flat().map((v) => String(v ?? "").trim()).filter((v) => v !== "");
  const head = norm[0].map((h) => String(h)).join(" ");
  const cap = caption?.trim() ? stripCaptionPrefix(caption.trim(), warn, where) : `${chapterTitle}: ${norm[0].map((h) => String(h).trim()).filter((h) => h !== "").join(", ")}`;
  if (cells.length > 0 && cells.filter((v) => NUMERAL.test(v)).length / cells.length >= 0.5 && !/\b(satuan|unit)\b|\(([^)]{1,12})\)/i.test(head)) {
    // DATUM-09 (DT-17): satuan tidak ditebak; hanya yang ditulis agen (unit blok atau caption) dipakai.
    const u = unit?.trim() || (caption?.trim() ? unitInCaption(cap) : null);
    const numeric = columns.map((c, i) => (c.role === "numeral" ? i : -1)).filter((i) => i >= 0);
    if (typeof u === "string" && u !== "" && numeric.length > 0) {
      for (const i of numeric) columns[i] = { role: "numeral", unit: u.slice(0, 40) };
      warn({ code: unit?.trim() ? "UNIT_FROM_BLOCK" : "UNIT_FROM_CAPTION", message: `${where}: satuan "${u.slice(0, 40)}" dari ${unit?.trim() ? "unit blok" : "caption"} dipasang sebagai metadata kolom angka (tanpa kolom baru)` });
    } else issue({ where, code: "TABLE_UNIT_MISSING", message: "tabel angka tanpa satuan (gerbang DATUM-09); tulis satuan di judul kolom, mis. \"Daya (MW)\", di caption \"(MW)\", atau unit pada blok. Satuan tidak dikarang mesin" });
  }
  if (!caption?.trim()) warn({ code: "CAPTION_GENERATED", message: `${where}: tabel tanpa caption; keterangan dibangkitkan dari judul bab + judul kolom (pakai { table, caption } untuk teks sendiri)` });
  const src = sourceOf(source, metaSource, warn, issue, where, "tabel");
  return {
    type: "table",
    caption: inl(cap),
    columns,
    rows: [{ kind: "header", cells: norm[0].map(cellOf) }, ...body.map((r) => ({ kind: "body", cells: r.map(cellOf) }))],
    ...(src !== null ? { source: inl(src) } : {}),
  };
}

// ── bab ─────────────────────────────────────────────────────────────────

export type ClientBlock = string | Rows | { table: Rows; caption?: string; source?: string; unit?: string } | { chart: ClientChart } | { list: string[]; ordered?: boolean } | { subheading: string };
export interface ClientSection {
  heading: string;
  blocks: ClientBlock[];
}

const HEADING_NUM = /^\s*(?:bab|chapter|bagian)?\s*(\d{1,3})\s*[.:)\-–]?\s+(.+)$/i;
/** IMPL-W3 butir 8: nomor sumber bertingkat di awal sub-judul ("1.1 ", "4.2.3. "); mesin menomori section sendiri. */
const SUB_NUM = /^\s*\d{1,3}(?:\.\d{1,3})+\.?\s+(?=\S)/;

export interface ChapterPlan {
  key: string;
  title: string;
  section: ClientSection;
  /** IMPL-W4 butir 1: label penomoran sumber (hanya mode sumber): "6", "FM", "IV". */
  label?: string;
}

// ── IMPL-W4 butir 1: penomoran sumber ──────────────────────────────────
// Judul yang membawa nomornya sendiri ("Chapter 1. Introduction", "1.1 Product concept", "FM.1 Document control
// block") dicetak PERSIS: tanpa menomori ulang, tanpa menyarangkan, tanpa nomor ganda. Label Tabel/Gambar = nomor bab
// sumber ("Tabel 6.1"); bagian depan FM.x tetap bagian sendiri (label "FM": "Tabel FM.1").
const SRC_WORD = /^\s*(?:bab|chapter|bagian|part)\s+(\d{1,3}|[A-Z]{1,2}|[IVXLC]{1,6})(?=[\s.:)\-–]|$)/i;
const SRC_ALPHA = /^\s*([A-Z]{1,4})\.\d{1,3}(?:\.\d{1,3})*\.?\s+(?=\S)/;
const SRC_NUM = /^\s*(\d{1,3})(?:\.\d{1,3})*[.)]?\s+(?=\S)/;
const SUB_SRC = /^\s*(\d{1,3}|[A-Z]{1,4})\.\d{1,3}(?:\.\d{1,3})*\.?\s+(?=\S)/;

/** Label penomoran dari nomor sumber di judul bab; null = judul tanpa nomor. */
export function sourceLabelOf(heading: string): string | null {
  const w = SRC_WORD.exec(heading);
  if (w) return w[1].toUpperCase();
  const a = SRC_ALPHA.exec(heading);
  if (a) return a[1];
  const n = SRC_NUM.exec(heading);
  return n ? n[1] : null;
}

const subheadingOf = (b: ClientBlock): string | null =>
  typeof b === "object" && b !== null && !Array.isArray(b) && typeof (b as Rec).subheading === "string" ? ((b as Rec).subheading as string) : null;

/** Mode sumber: ada judul bab atau sub-judul yang membawa nomornya sendiri. */
export function usesSourceNumbering(sections: readonly ClientSection[]): boolean {
  return sections.some((s) => sourceLabelOf(s.heading) !== null || s.blocks.some((b) => SUB_SRC.test(subheadingOf(b) ?? "")));
}

/**
 * Rencana mode sumber: kunci internal berurutan 1..n (urutan agen), judul apa adanya, label = nomor sumber judul bab,
 * atau komponen pertama nomor sub-judul pertama, atau label bab sebelumnya/berikutnya (penghitung Tabel/Gambar
 * bersama). Tidak ada penyarangan dan tidak ada penomoran ulang.
 */
function planSource(sections: readonly ClientSection[]): ChapterPlan[] {
  const own = sections.map((s) => {
    const l = sourceLabelOf(s.heading);
    if (l !== null) return l;
    for (const b of s.blocks) {
      const m = SUB_SRC.exec(subheadingOf(b) ?? "");
      if (m) return m[1];
    }
    return null;
  });
  const firstKnown = own.find((l): l is string => l !== null) ?? "1";
  let last: string | null = null;
  return sections.map((s, i) => {
    const label = own[i] ?? last ?? firstKnown;
    last = label;
    const title = s.heading.replace(/\s+/g, " ").trim();
    return { key: String(i + 1), title: title === "" ? label : title, section: { heading: s.heading, blocks: [...s.blocks] }, label };
  });
}

/**
 * IMPL-W3 butir 8: kunci bab. Nomor eksplisit di judul ("4. Konsep", "Bab 4 Konsep") SELALU dihormati bila naik dan
 * unik. Bagian tanpa nomor memakai nomor bebas berikutnya bila ada di bawah nomor eksplisit berikutnya; bila tidak ada
 * nomor bebas (mis. "Ringkasan" sebelum "1. Pendahuluan"), bagian itu menjadi sub-bagian bab bernomor di sebelahnya
 * (bab sebelumnya; bila di depan, bab berikutnya sesudah pembukanya) dengan peringatan SECTION_NESTED. Hanya nomor
 * eksplisit yang tidak naik/ganda yang diberi nomor lain (CHAPTER_RENUMBERED).
 * IMPL-W4 butir 1: bila ada judul/sub-judul bernomor sumber, rencana mode sumber (`planSource`) yang dipakai: judul
 * dicetak persis, tanpa penyarangan dan penomoran ulang (D-544/D-547, UD-2).
 */
export function planChapters(sections: readonly ClientSection[], warn: (w: ToolWarning) => void, lang: WrapperLang = "ID"): ChapterPlan[] {
  if (usesSourceNumbering(sections)) return planSource(sections);
  const parsed = sections.map((s) => {
    const m = HEADING_NUM.exec(s.heading);
    return { s, num: m ? Number(m[1]) : null, title: (m ? m[2] : s.heading).replace(/\s+/g, " ").trim() };
  });
  // Nomor eksplisit yang dipakai: naik ketat (yang tidak naik = konflik, diberi nomor bebas).
  let lastExplicit = 0;
  const kept = parsed.map((p) => {
    if (p.num !== null && p.num > lastExplicit && p.num <= 999) {
      lastExplicit = p.num;
      return p.num;
    }
    return null;
  });
  const used = new Set(kept.filter((n): n is number => n !== null));
  const out: ChapterPlan[] = [];
  const renumbered: string[] = [];
  const nested: string[] = [];
  const pendingLead: ClientSection[] = [];
  let prev = 0;
  parsed.forEach((p, i) => {
    const sec: ClientSection = { heading: p.s.heading, blocks: [...p.s.blocks] };
    if (kept[i] !== null) {
      const key = kept[i] as number;
      prev = key;
      // Bagian tanpa nomor di depan bab bernomor pertama: sub-bagian sesudah pembuka bab ini.
      if (pendingLead.length > 0) {
        const firstSub = sec.blocks.findIndex((b) => typeof b === "object" && b !== null && !Array.isArray(b) && typeof (b as Rec).subheading === "string");
        const at = firstSub < 0 ? sec.blocks.length : firstSub;
        sec.blocks.splice(at, 0, ...pendingLead.flatMap((l) => [{ subheading: l.heading } as ClientBlock, ...l.blocks]));
        pendingLead.length = 0;
      }
      out.push({ key: String(key), title: p.title === "" ? chapterLabelText(String(key), false, lang) : p.title, section: sec });
      return;
    }
    const nextExplicit = kept.slice(i + 1).find((n): n is number => n !== null) ?? Infinity;
    let cand = prev + 1;
    while (used.has(cand)) cand++;
    if (cand < nextExplicit && cand <= 999) {
      used.add(cand);
      prev = cand;
      if (p.num !== null) renumbered.push(`bagian ${i + 1} "${p.num}" -> ${cand}`);
      out.push({ key: String(cand), title: p.title === "" ? chapterLabelText(String(cand), false, lang) : p.title, section: sec });
      return;
    }
    nested.push(p.s.heading.replace(/\s+/g, " ").trim());
    const title = p.num !== null ? p.title : p.s.heading.replace(/\s+/g, " ").trim();
    if (out.length > 0) out[out.length - 1].section.blocks.push({ subheading: title }, ...sec.blocks);
    else pendingLead.push({ heading: title, blocks: sec.blocks });
  });
  // Hanya bagian tanpa nomor (tidak ada bab bernomor sesudahnya): urutan biasa.
  for (const l of pendingLead) {
    prev += 1;
    out.push({ key: String(prev), title: l.heading, section: l });
  }
  if (renumbered.length > 0) warn({ code: "CHAPTER_RENUMBERED", message: `nomor bab ganda/tidak naik diberi nomor bebas: ${renumbered.join("; ")}` });
  if (nested.length > 0) warn({ code: "SECTION_NESTED", message: `bagian tanpa nomor tanpa nomor bebas di antara bab bernomor menjadi sub-bagian bab di sebelahnya: ${nested.slice(0, 5).join("; ")}. Beri nomor (mis. "3. Judul") agar menjadi bab sendiri` });
  return out;
}

/** Kompatibel IMPL-W2: kunci + judul per bab hasil rencana. */
export function chapterKeys(sections: readonly ClientSection[], warn: (w: ToolWarning) => void, lang: WrapperLang = "ID"): Array<{ key: string; title: string }> {
  return planChapters(sections, warn, lang).map((p) => ({ key: p.key, title: p.title }));
}

/**
 * Satu bagian -> ChapterV2 (blok sebelum subheading pertama = intro; setiap subheading = section). null = tanpa isi
 * (dilewati dengan peringatan; IMPL-W3 butir 6).
 */
export function chapterOf(sec: ClientSection, key: string, title: string, metaSource: string | null, warn: (w: ToolWarning) => void, where: string, issue: IssueSink = THROW, keepNumbers = false): Rec | null {
  const intro: Rec[] = [];
  const sections: Array<{ title: InlineV2; blocks: Rec[] }> = [];
  const push = (b: Rec) => {
    if (Object.keys(b).length > 0) (sections.length > 0 ? sections[sections.length - 1].blocks : intro).push(b);
  };
  let stripped = 0;
  sec.blocks.forEach((b, k) => {
    const w = `${where} blok ${k + 1}`;
    if (typeof b === "string") {
      // Butir 13: baris kosong = paragraf baru; baris tunggal (wrap keras) digabung spasi oleh inl().
      for (const p of b.split(/\n\s*\n/)) if (p.trim() !== "") push({ type: "paragraph", ...inl(p) });
      return;
    }
    if (isRows(b)) {
      if (b.length > 0) push(tableBlock(b, undefined, undefined, metaSource, warn, w, title, issue));
      return;
    }
    const o = b as unknown as Rec;
    if (typeof o.subheading === "string") {
      // IMPL-W4 butir 1: mode sumber = sub-judul apa adanya (nomor sumber dicetak; mesin tidak menomori section).
      const t = keepNumbers ? o.subheading.replace(/\s+/g, " ").trim() : o.subheading.replace(SUB_NUM, "");
      if (t !== o.subheading) stripped++;
      sections.push({ title: inl(t), blocks: [] });
    } else if (isRows(o.table)) push(tableBlock(o.table, o.caption as string | undefined, o.source as string | undefined, metaSource, warn, w, title, issue, o.unit as string | undefined));
    else if (o.chart !== null && typeof o.chart === "object") push(chartBlock(o.chart as ClientChart, metaSource, warn, w, title, issue));
    else if (Array.isArray(o.list)) {
      const items = (o.list as unknown[]).map((x) => String(x).trim()).filter((x) => x !== "").map((x) => inl(x));
      if (items.length > 0) push({ type: "list", ...(o.ordered === true ? { ordered: true } : {}), items });
    } else issue({ where: w, code: "INVALID_ARGUMENT", message: "blok tidak dikenal (string, larik baris, {table}, {chart}, {list}, {subheading})" });
  });
  if (stripped > 0) warn({ code: "SUBHEADING_NUMBER_STRIPPED", message: `${where}: ${stripped} nomor sumber di awal sub-judul dibuang; mesin menomori sub-bagian mengikuti nomor bab (${key}.1, ${key}.2, ...)` });
  if (intro.length === 0 && sections.every((s) => s.blocks.length === 0)) return null;
  return { key, title: inl(title), ...(intro.length > 0 ? { intro } : {}), sections };
}

// ── rakit ───────────────────────────────────────────────────────────────

export interface BuiltClient {
  meta: ClientMeta;
  /** S12 (F-1): bahasa label slot depan dan judul bab cadangan = meta.language, selain itu `language` masukan, selain itu ID. */
  language: WrapperLang;
  docMeta: Rec;
  slots: { cover: Rec; controlSheet: Rec; signature: Rec };
  chapters: Rec[];
  warnings: ToolWarning[];
  /** IMPL-W3 butir 6: judul bagian tanpa isi yang dilewati (tidak dikirim). */
  emptySections: string[];
  /** IMPL-W4 butir 1: outline penomoran sumber ({ key, title, label }); null = penomoran mesin. */
  outline: Array<{ key: string; title: InlineV2; label: string }> | null;
}

/**
 * Masukan -> semua bentuk server. IMPL-W3 butir 5: isu yang tidak dapat diperbaiki mesin (sumber/satuan tidak ada,
 * tabel terlalu lebar, data grafik tak sah) dikumpulkan dan dilempar SEKALI sebagai CONTENT_INVALID (0 jaringan).
 */
/**
 * `language` (S12, F-1) = bahasa dokumen dari templat (R02 `doc.language`) atau dokumen yang ada, dipakai untuk label
 * HANYA bila meta agen tidak membawa `language`; tidak ditambahkan ke DocMetaV2 (server memakai bahasa templat sendiri).
 */
export function buildClient(input: { meta: Record<string, string>; title: string | null; sections: ClientSection[]; today: string; language?: WrapperLang }): BuiltClient {
  const warnings: ToolWarning[] = [];
  const warn = (w: ToolWarning) => warnings.push(w);
  const issues: Issue[] = [];
  const issue: IssueSink = (i) => issues.push(i);
  const meta = normalizeMeta(input.meta, input.title, input.today, warn);
  const docMeta = docMetaOf(meta, warn);
  const language = meta.language !== undefined ? labelLangOf(meta.language) : (input.language ?? "ID");
  const slots = frontSlots(meta, warn, language);
  const metaSource = meta.source ?? null;
  const plan = planChapters(input.sections, warn, language);
  const emptySections: string[] = [];
  const chapters: Rec[] = [];
  const source = plan.some((p) => p.label !== undefined);
  const outline: Array<{ key: string; title: InlineV2; label: string }> = [];
  plan.forEach((p, i) => {
    const ch = chapterOf(p.section, p.key, p.title, metaSource, warn, `bagian ${i + 1}`, issue, source);
    if (ch === null) emptySections.push(p.title);
    else {
      chapters.push(ch);
      if (p.label !== undefined) outline.push({ key: p.key, title: ch.title as InlineV2, label: p.label });
    }
  });
  if (emptySections.length > 0) warn({ code: "SECTION_EMPTY_SKIPPED", message: `bagian tanpa isi tidak dikirim: ${emptySections.slice(0, 5).join("; ")}` });
  if (chapters.length === 0 && issues.length === 0) issue({ where: "sections", code: "SECTION_MISSING", message: "tidak ada bagian berisi; tambahkan paragraf/tabel/grafik" });
  if (issues.length > 0) {
    throw new McpToolError("CONTENT_INVALID", `${issues.length} isu yang tidak dapat diperbaiki mesin (semua di blok rincian, sekali jawab): ${[...new Set(issues.map((x) => x.code))].join(", ")}. Isi lainnya sudah disesuaikan otomatis; perbaiki isu itu lalu studio_write sekali lagi. Tidak ada yang dikirim`, {
      untrusted: true,
      details: { issues: issues.slice(0, 50) },
    });
  }
  // Peringatan sejenis digabung agar hasil tetap ringkas.
  const merged = new Map<string, ToolWarning[]>();
  for (const w of warnings) merged.set(w.code, [...(merged.get(w.code) ?? []), w]);
  const compact = [...merged.values()].map((ws) => (ws.length === 1 ? ws[0] : { code: ws[0].code, message: `${ws.length}x: ${ws.slice(0, 3).map((w) => w.message).join(" | ")}${ws.length > 3 ? " | ..." : ""}` }));
  return { meta, language, docMeta, slots, chapters, warnings: compact, emptySections, outline: source ? outline : null };
}
