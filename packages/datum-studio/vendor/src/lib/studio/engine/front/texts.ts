/**
 * FIX-2 (F-055 H1, D-46, D-116): teks bawaan halaman pembungkus, SATU sumber
 * untuk perakit DOCX (`docx/wrapper/pages.ts`, `docx/blocks/structure.ts`) dan
 * renderer HTML (`html/blocks/wrapper.ts`, `html/blocks/text.ts`).
 *
 * Teks di sini hanya dipakai bila konten tidak mengirim teksnya sendiri (mode
 * auto, D-139: teks bawaan milik templat + mesin). Nilainya sama persis dengan
 * keluaran DOCX sebelum FIX-2, sehingga DOCX tetap byte-identik; HTML kini
 * memakai fungsi yang sama dan tidak bisa menyimpang lagi
 * (uji `tests/unit/studio/renderers/fix2-wrapper-text-parity.test.ts`).
 *
 * Huruf kapital tampilan (mis. kicker berhuruf besar) adalah urusan format
 * peran (`caps` -> `w:caps` / `text-transform`), bukan teks sumber (D-46).
 */
import type { DocMeta, Inline, ParamMap, ProvenanceMark, Run } from "../../contract";
import { StudioEngineError } from "../../contract/errors";
import { PARAMS_BY_KEY } from "../../params";
import { dateParts, longDate, pNum, pStr, pStrList, ROMAN_MONTHS, roman } from "../docx/wrapper/formats";
// Row 123 (additive): contract table type for the shared control-sheet helpers used by HTML/PDF.
import type { TableBlock } from "../../contract";

export type WrapperLang = "ID" | "EN";

/**
 * S06 (research/33 B-05/B-06): cadangan teks = bawaan registri parameter itu sendiri
 * (`params/page.ts`), dibaca dari `PARAMS_BY_KEY` seperti `engine/symbols/primitives.ts`,
 * bukan literal kedua yang bisa menyimpang. Registri tanpa bawaan berbentuk benar = galat
 * pemrograman, gagal keras saat modul dimuat.
 */
function registryDefault<T>(key: string, ok: (v: unknown) => v is T, shape: string): T {
  const v = PARAMS_BY_KEY.get(key)?.default;
  if (!ok(v)) throw new StudioEngineError("SCHEMA_INVALID", `engine/front/texts: bawaan registri ${key} tidak ada atau bukan ${shape}`, { key, value: v });
  return v;
}

const isString = (v: unknown): v is string => typeof v === "string";
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Bawaan registri P4V-14 `wrapper.header` (pasangan kiri/kanan pita segel). */
const SEAL_BAND_DEFAULT: readonly string[] = registryDefault("wrapper.header", isStringList, "daftar string");
/** Bawaan registri P4V-14 `device.issueStamp.format`. */
const ISSUE_STAMP_FORMAT_DEFAULT: string = registryDefault("device.issueStamp.format", isString, "string");

/**
 * S13 (register research/31 §4.4): pasangan pita segel dan format cap terbit bawaan per bahasa.
 * Entri ID = bawaan registri (`params/page.ts`, tidak diubah karena masuk `paramsSha256`); entri EN
 * dipakai hanya bila bahasa EN DAN nilai parameter = bawaan registri (pola kicker bab O-1).
 */
const SEAL_BAND_TEXT: Readonly<Record<WrapperLang, readonly string[]>> = {
  ID: SEAL_BAND_DEFAULT,
  EN: ["CLASSIFICATION · {kelas}", "MASTER COPY · GSP INTERNAL USE"],
};
/**
 * Row 122 (C40 FIX CP-14, Manual Rev A ID p.1, p.37 Tabel 6.2, p.49 Tabel 8.1; EN p.38, p.56): the issue stamp
 * separator is U+2014 as printed in the manual (`// 20261102 ID T — TERBITAN 1`). The registry default
 * (`params/page.ts` P4S-26, still `--`, kept because it enters paramsSha256 and its pattern refuses U+2014 in
 * template values) only selects this per-language text; a format set by a template still wins as before.
 */
const ISSUE_STAMP_FORMAT_TEXT: Readonly<Record<WrapperLang, string>> = {
  ID: "// {YYYYMMDD} {BAHASA} {KELAS} — TERBITAN {n}",
  EN: "// {YYYYMMDD} {BAHASA} {KELAS} — ISSUE {n}",
};

/**
 * G-FIX1 (D-606) butir (g): penandaan klasifikasi di setiap tempat pembungkus (kepala halaman, sel register,
 * pita segel `{kelas}`, pasangan Klasifikasi blok kendali sampul; DOCX dan HTML) selalu kapital: spesimen manual
 * kapital ("TERBATAS"), EG-50 menjaga penandaan Indonesia apa adanya (aturan CR-1, RB-02). SATU helper; nilai
 * meta tersimpan dan validasinya tidak diubah. Masukan yang sudah kapital keluar byte-identik.
 */
export function classificationMarkText(classification: string): string {
  return classification.toUpperCase();
}

/** Bahasa pembungkus dari meta (EN atau ID; nilai lain = ID, sama dengan `WrapperBuilder.lang`). */
export function wrapperLangOf(meta: { readonly language?: DocMeta["language"] } | undefined): WrapperLang {
  return meta?.language === "EN" ? "EN" : "ID";
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** Tabel teks bawaan pembungkus per bahasa (dulu tabel `L` di `docx/wrapper/pages.ts`). */
export const WRAPPER_TEXT = {
  controlKicker: { ID: "Lembar Kendali", EN: "Control Sheet" },
  // C07 (CS-12, research/38 §3.1): subjudul di bawah judul lembar kendali, verbatim ID:25 / EN:25 (EN tanpa koma
  // serial); dicetak hanya bila opt-in `controlSheet.subtitle.enabled` (pembaca C08). Belum ada pemanggil.
  controlSubtitle: { ID: "Kendali dokumen, riwayat revisi, dan pernyataan verifikasi", EN: "Document control, revision history and verification statement" },
  revision: { ID: "Riwayat revisi", EN: "Revision history" },
  verification: { ID: "Rantai verifikasi", EN: "Verification chain" },
  method: { ID: "Pernyataan metode", EN: "Method statement" },
  distribution: { ID: "Distribusi terkendali", EN: "Controlled distribution" },
  tocKicker: { ID: "Daftar Isi", EN: "Contents" },
  chapter: { ID: "Bab", EN: "Chapter" },
  // G-FIX1 (D-606) LB-08: kata lampiran EN = "Annex" (manual EN:223-247, EN:4326, EN:4441); ID tetap.
  appendix: { ID: "Lampiran", EN: "Annex" },
  part: { ID: "Bagian", EN: "Part" },
  tocPlaceholder: { ID: "Perbarui medan untuk menyusun daftar isi.", EN: "Update fields to build the table of contents." },
} as const satisfies Readonly<Record<string, Readonly<Record<WrapperLang, string>>>>;

/** Blok lembar kendali mode auto, urutan tetap (BM p#12..p#21). */
export type ControlSheetBlockKind = "revision" | "verification" | "method" | "distribution";

export const CONTROL_SHEET_BLOCK_ORDER: readonly ControlSheetBlockKind[] = ["revision", "verification", "method", "distribution"];

/**
 * Judul blok lembar kendali: huruf berurutan HANYA untuk blok yang ada
 * (`index` = urutan di antara blok yang dirender), pemisah titik tengah.
 */
export function controlSheetBlockHeading(index: number, kind: ControlSheetBlockKind, lang: WrapperLang): string {
  return `${String.fromCharCode(65 + index)} · ${WRAPPER_TEXT[kind][lang]}`;
}

/** Blok lembar kendali bertabel (daftar bertipe compose v2). */
export type ControlSheetTableKind = Exclude<ControlSheetBlockKind, "method">;

/**
 * S06 (research/33 B-01): kepala kolom daftar bertipe lembar kendali (dulu `REVISION_HEAD`,
 * `VERIFICATION_HEAD`, `DISTRIBUTION_HEAD` di `services/compose/front.ts`). Entri ID wajib;
 * bahasa tanpa entri memakai ID (perilaku compose sekarang).
 */
export const CONTROL_SHEET_COLUMNS = {
  // S13: entri EN = register research/31 §4.2 (kosakata manual EN, bentuk data kode).
  revision: { ID: ["Rev", "Tanggal", "Uraian", "Oleh"], EN: ["Rev", "Date", "Change", "Prepared by"] },
  verification: { ID: ["Lapis", "Peran", "Nama", "Tanggal"], EN: ["Layer", "Role", "Name", "Date"] },
  distribution: { ID: ["Salinan", "Pemegang"], EN: ["Copy", "Holder"] },
} as const satisfies Readonly<Record<ControlSheetTableKind, Readonly<{ ID: readonly string[] } & Partial<Record<WrapperLang, readonly string[]>>>>>;

/** Kepala kolom tabel lembar kendali `kind` untuk bahasa `lang` (cadangan entri ID). */
export function controlSheetColumnHeads(kind: ControlSheetTableKind, lang: WrapperLang = "ID"): readonly string[] {
  const entry: Partial<Record<WrapperLang, readonly string[]>> & { ID: readonly string[] } = CONTROL_SHEET_COLUMNS[kind];
  return entry[lang] ?? entry.ID;
}

/**
 * C07 (CS-11, register research/38 §3.2; D-635): label kolom bentuk manual lembar kendali per pengenal kolom.
 * Pengenal = isi bawaan registri `controlSheet.revisionHistory.columns` (ID:29, EN:29),
 * `controlSheet.verificationChain.columns` (ID:39, EN:38) dan `controlSheet.distribution.columns` (ID:58, EN:62).
 * Dipakai hanya bila opt-in `controlSheet.columns.form` = "manual" (pembaca C10); bentuk mesin tetap
 * `CONTROL_SHEET_COLUMNS`. Huruf kapital tampilan = peran kepala tabel, bukan teks sumber (D-46). Belum ada pemanggil.
 */
export const CONTROL_SHEET_COLUMN_LABELS = {
  REV: { ID: "Rev", EN: "Rev" },
  TANGGAL: { ID: "Tanggal", EN: "Date" },
  PENYUSUN: { ID: "Penyusun", EN: "Prepared by" },
  PERUBAHAN: { ID: "Perubahan", EN: "Change" },
  STATUS: { ID: "Status", EN: "Status" },
  LAPIS: { ID: "Lapis", EN: "Layer" },
  METODE: { ID: "Metode", EN: "Method" },
  OBJEK: { ID: "Objek", EN: "Object" },
  HASIL: { ID: "Hasil", EN: "Result" },
  SALINAN: { ID: "Salinan", EN: "Copy" },
  PEMEGANG: { ID: "Pemegang", EN: "Holder" },
  MEDIA: { ID: "Media", EN: "Medium" },
  KEMBALI: { ID: "Kembali", EN: "Return" },
} as const satisfies Readonly<Record<string, Readonly<Record<WrapperLang, string>>>>;

/**
 * C07 (research/38 §3.2): nilai kolom STATUS turunan (bukan muatan): baris revisi terakhir = berlaku
 * (ID:31, EN:31); baris sebelumnya = diganti (hipotesis register: spesimen manual hanya satu baris).
 */
export const CONTROL_SHEET_STATUS_TEXT = {
  current: { ID: "Berlaku", EN: "In force" },
  superseded: { ID: "Diganti", EN: "Superseded" },
} as const satisfies Readonly<Record<string, Readonly<Record<WrapperLang, string>>>>;

/** Kicker bawaan halaman lembar kendali. */
export function controlSheetKickerText(lang: WrapperLang): string {
  return WRAPPER_TEXT.controlKicker[lang];
}

/**
 * S14 (research/33 B-02): kicker dan judul bawaan lembar kendali = label slot (DF-59). Label yang
 * sama dengan kicker bawaan ID diterjemahkan untuk dokumen EN; label lain (templat EN, agen) menang.
 */
export function controlSheetLabelText(slotLabel: string, lang: WrapperLang): string {
  return lang !== "ID" && slotLabel === WRAPPER_TEXT.controlKicker.ID ? controlSheetKickerText(lang) : slotLabel;
}

/** Kicker bawaan halaman daftar isi (tanpa judul bawaan; judul = kenop `render.toc.title`, RQ-8). */
export function tocKickerText(lang: WrapperLang): string {
  return WRAPPER_TEXT.tocKicker[lang];
}

/**
 * IMPL-W4 (D-547, penomoran sumber): kicker bab yang DIKIRIM sebagai teks kosong persis (`{ text: "" }`) berarti
 * "tanpa kicker/label bab": judul bab sudah memuat nomor sumbernya ("Chapter 6. ...", "FM.1 ..."). Pembuka bab,
 * daftar isi, daftar bab pembatas, dan kepala halaman lalu tidak mencetak "Bab n"/"Chapter n". Kicker absen tetap
 * memakai pola bawaan (dokumen lama byte-identik).
 */
export function kickerSuppressed(kicker: unknown): boolean {
  if (kicker === null || typeof kicker !== "object" || Array.isArray(kicker)) return false;
  const k = kicker as { text?: unknown; runs?: unknown };
  return k.text === "" && k.runs === undefined;
}

/** Label bab/lampiran bawaan di daftar isi dan daftar bab pembatas bagian: "Bab 1" / "Lampiran A". */
export function chapterLabelText(key: string, appendix: boolean, lang: WrapperLang): string {
  return `${(appendix ? WRAPPER_TEXT.appendix : WRAPPER_TEXT.chapter)[lang]} ${key}`;
}

/** Pola sah (string memuat `{n}`) atau undefined. */
function validPattern(v: unknown): string | undefined {
  return typeof v === "string" && v.includes("{n}") ? v : undefined;
}

/**
 * Kicker bawaan pembuka lampiran (blok `appendix`): pola `appendix.kicker.pattern`
 * bila diset templat (FIX-2 siklus 2, O-2), selain itu "Lampiran A" / "Annex A".
 */
export function appendixOpenerKickerText(key: string, lang: WrapperLang, appendixPattern?: unknown): string {
  const p = validPattern(appendixPattern);
  return p ? p.replace("{n}", key) : chapterLabelText(key, true, lang);
}

/** Pola bawaan registri P4A-04 `chapter.kicker.pattern`. */
export const CHAPTER_KICKER_PATTERN_DEFAULT = "BAB {n}";
/** Padanan EN pola bawaan (FIX-2 siklus 2, O-1). */
export const CHAPTER_KICKER_PATTERN_EN = "CHAPTER {n}";

/**
 * Kicker bawaan pembuka bab (blok `chapter`): pola P4A-04 `chapter.kicker.pattern`
 * (wajib memuat `{n}`, cadangan "BAB {n}"). Dokumen EN dengan pola bawaan (absen atau
 * sama dengan bawaan registri) = "CHAPTER {n}"; pola lain yang diset templat menang
 * (O-1). Catatan: templat yang sengaja mengeset "BAB {n}" tidak bisa dibedakan dari
 * bawaan registri yang sudah teresolusi. Bab di unit lampiran memakai
 * `appendix.kicker.pattern` atau kata lampiran (menurut bahasa) yang diturunkan dari
 * pola bab; deteksi huruf besar dipertahankan dari DOCX S16 (lihat uji FIX-2).
 */
export function chapterKickerText(chapterPattern: unknown, appendixPattern: unknown, key: string, appendix: boolean, lang: WrapperLang): string {
  const given = validPattern(chapterPattern) ?? CHAPTER_KICKER_PATTERN_DEFAULT;
  const base = lang === "EN" && given === CHAPTER_KICKER_PATTERN_DEFAULT ? CHAPTER_KICKER_PATTERN_EN : given;
  let p = base;
  if (appendix) {
    const ap = validPattern(appendixPattern);
    if (ap) p = ap;
    else {
      const word = WRAPPER_TEXT.appendix[lang];
      p = base.replace(/^[^\s{]+/, base === base.toUpperCase() ? word.toUpperCase() : word);
    }
  }
  return p.replace("{n}", key);
}

// ── Sampul mode auto: blok kendali dan kolofon (FIX-2 siklus 2, O-3) ─────

/**
 * S13 (research/33 B-08, register research/31 §4.3): label isi slot depan yang dibangkitkan klien MCP
 * (`scripts/studio/mcp/write-client.ts`) dan belum ada di tabel blok kendali di bawah: medan klasifikasi
 * blok kendali eksplisit, peran tanda tangan / lapis rantai verifikasi (EN = D-590 Prepared by / Reviewed by /
 * Approved by), dan catatan revisi bawaan. Entri ID = nilai klien sebelum S13 (byte-sama).
 * C07: dipindah ke atas `CONTROL_FIELD_LABELS` karena entri KLASIFIKASI di sana merujuknya (tanpa literal kedua).
 */
export const FRONT_PAYLOAD_LABELS = {
  classification: { ID: "Klasifikasi", EN: "Classification" },
  made: { ID: "Disusun", EN: "Prepared by" },
  checked: { ID: "Diperiksa", EN: "Reviewed by" },
  approved: { ID: "Disetujui", EN: "Approved by" },
  first: { ID: "Terbit pertama", EN: "First issue" },
} as const satisfies Readonly<Record<string, Readonly<Record<WrapperLang, string>>>>;

/**
 * C07 (CL-02 NOTA, register research/38 §3.7; D-635): pemisah baris klasifikasi di bawah nomor dokumen.
 * ID mengikuti manual "Klasifikasi : ..." dengan spasi sebelum titik dua (ID:612-613, spesimen ID:4109, gaya
 * Tata Naskah Dinas); EN "Classification: ..." (EN:647-649, spesimen EN:4184).
 */
export const CLASSIFICATION_LINE_SEPARATOR = { ID: " : ", EN: ": " } as const satisfies Readonly<Record<WrapperLang, string>>;

/**
 * C07: teks baris klasifikasi NOTA (opt-in `render.nota.classificationLine`, pembaca C16): label klasifikasi
 * bahasa `lang` + pemisah + penandaan kapital (`classificationMarkText`, ID:611). Belum ada pemanggil.
 */
export function classificationLineText(classification: string, lang: WrapperLang): string {
  return `${FRONT_PAYLOAD_LABELS.classification[lang]}${CLASSIFICATION_LINE_SEPARATOR[lang]}${classificationMarkText(classification)}`;
}

/** Label medan blok kendali P4V-12 per bahasa (dulu `CONTROL_FIELD_LABELS` di `docx/wrapper/pages.ts`). */
export const CONTROL_FIELD_LABELS: Readonly<Record<string, Readonly<Record<WrapperLang, string>>>> = {
  "NOMOR DOKUMEN": { ID: "Nomor dokumen", EN: "Document number" },
  REVISI: { ID: "Revisi", EN: "Revision" },
  PENYUSUN: { ID: "Penyusun", EN: "Prepared by" }, // S13: register research/31 §4.1, D-590
  KUSTODIAN: { ID: "Kustodian", EN: "Custodian" },
  "DITUJUKAN KEPADA": { ID: "Ditujukan kepada", EN: "Addressed to" },
  TIER: { ID: "Tier", EN: "Tier" },
  DASAR: { ID: "Dasar", EN: "Basis" },
  BAHASA: { ID: "Bahasa", EN: "Language" },
  // C07 (CL-02 T/S, research/38 §3.3): label medan opt-in KLASIFIKASI = rujukan label muatan (ID:1, ID:21; EN:1,
  // EN:21), bukan literal kedua. Nilainya ditambahkan C15; jalur absen memakai bawaan registri (C-6), bukan kunci tabel ini.
  KLASIFIKASI: FRONT_PAYLOAD_LABELS.classification,
  // Row 122 (C40 FIX CP-05): the three fields of the Rev A control block that had no engine value
  // (ID p.47 "halaman, datum geodetik, dan verifikasi"; EN p.49 "sheets, geodetic datum, and verification").
  HALAMAN: { ID: "Halaman", EN: "Sheets" },
  "DATUM GEODETIK": { ID: "Datum geodetik", EN: "Geodetic datum" },
  VERIFIKASI: { ID: "Verifikasi", EN: "Verification" },
};

/**
 * Row 122 (CP-05): value of HALAMAN when the renderer can count sheets itself. The DOCX renderer replaces a value
 * cell equal to this marker with a NUMPAGES field; a renderer that does not pass `sheets` never sees it.
 */
export const CONTROL_FIELD_SHEETS_FIELD = "\u0000NUMPAGES";

/** Row 122 (CP-05): values of the Rev A control fields that are not in `meta`; absent = field skipped as before. */
export interface ControlFieldExtras {
  /** HALAMAN: text, or `CONTROL_FIELD_SHEETS_FIELD` for a page-count field. */
  sheets?: string;
  /** DATUM GEODETIK: template data R-83 `cover.controlBlock.geodeticDatum`. */
  geodeticDatum?: string;
  /** VERIFIKASI: summary of the control-sheet verification chain (`verificationSummaryText`). */
  verification?: string;
}

/** Plain text of one table cell (text, runs, or paragraphs of runs). */
function cellPlainText(c: unknown): string {
  if (!c || typeof c !== "object") return "";
  const o = c as { text?: unknown; runs?: unknown; paragraphs?: unknown };
  const runsText = (rs: unknown): string => (Array.isArray(rs) ? rs.map((r) => (r && typeof r === "object" && typeof (r as { t?: unknown }).t === "string" ? (r as { t: string }).t : "")).join("") : "");
  if (typeof o.text === "string") return o.text;
  if (Array.isArray(o.runs)) return runsText(o.runs);
  if (Array.isArray(o.paragraphs)) return o.paragraphs.map((p) => (p && typeof p === "object" ? runsText((p as { runs?: unknown }).runs) : "")).join(" ");
  return "";
}

/**
 * Row 122 (CP-05): VERIFIKASI value = the last layer of the control-sheet verification chain and its result
 * (case 01 material wrote `V2 · lulus` by hand). Result column = HASIL/Result, else Nama/Name; no result = layer only.
 * undefined = no chain or no data row.
 */
export function verificationSummaryText(table: { rows?: ReadonlyArray<{ kind?: string; cells: readonly unknown[] }> } | undefined): string | undefined {
  const rows = table?.rows ?? [];
  const head = rows.find((r) => r.kind === "header");
  const data = rows.filter((r) => r.kind !== "header" && r.kind !== "group");
  const last = data[data.length - 1];
  if (!last) return undefined;
  const heads = (head?.cells ?? []).map((c) => cellPlainText(c).trim().toLowerCase());
  let col = heads.findIndex((h) => h === "hasil" || h === "result");
  if (col < 0) col = heads.findIndex((h) => h === "nama" || h === "name");
  const layer = cellPlainText(last.cells[0]).trim();
  const result = col > 0 ? cellPlainText(last.cells[col]).trim() : "";
  if (layer === "") return undefined;
  return result !== "" ? `${layer} · ${result}` : layer;
}

/**
 * C-6 (research/35 §5, research/38 §2): daftar medan blok kendali bila parameter absen = bawaan registri P4V-12
 * (`params/page.ts`), bukan kunci tabel label di atas, agar label opt-in (KLASIFIKASI) tidak masuk jalur absen.
 */
const CONTROL_FIELDS_DEFAULT: readonly string[] = registryDefault("cover.controlBlock.fields", isStringList, "daftar string");

/**
 * Nilai medan BAHASA blok kendali sampul: bahasa dokumen ditulis dalam bahasa pembungkus `lang`.
 * G-FIX1 (D-606) LB-07: dokumen EN berbahasa pembungkus EN = "English (UK)" (manual EN:18, EN:883);
 * nilai lain tetap seperti sebelumnya (dokumen ID byte-identik).
 */
const LANGUAGE_VALUE_TEXT: Readonly<Record<WrapperLang, Readonly<Record<WrapperLang, string>>>> = {
  ID: { ID: "Indonesia", EN: "Indonesian" },
  EN: { ID: "Inggris", EN: "English (UK)" },
};

function languageValueText(docLanguage: DocMeta["language"], lang: WrapperLang): string {
  return LANGUAGE_VALUE_TEXT[docLanguage === "EN" ? "EN" : "ID"][lang];
}

/**
 * C27 (CV-15, research/38 §3.5; D-627 Q2): unit penyusun tetap dari data templat R-79 `cover.controlBlock.preparerUnit`
 * (string tak kosong) atau undefined (absen, null, kosong = `meta.author`, keluaran sekarang).
 */
export function coverPreparerUnit(params: ParamMap): string | undefined {
  const v = pStr(params, "cover.controlBlock.preparerUnit");
  return v !== undefined && v.trim() !== "" ? v : undefined;
}

/** Row 122 (CP-05): DATUM GEODETIK from template data R-83 `cover.controlBlock.geodeticDatum` (empty = skipped). */
export function coverGeodeticDatum(params: ParamMap): string | undefined {
  const v = pStr(params, "cover.controlBlock.geodeticDatum");
  return v !== undefined && v.trim() !== "" ? v : undefined;
}

/**
 * Row 122 (CP-15): label of the document-number field in a cover control block, all languages (the table label
 * `CONTROL_FIELD_LABELS["NOMOR DOKUMEN"]` plus the short forms the footer already recognises, header-footer.ts
 * DISPLAY_NUMBER_LABEL).
 */
const NUMBER_FIELD_LABEL = /^(?:nomor(?:\s+dokumen)?|no\.?(?:\s+dokumen)?|document\s+(?:number|no\.?)|doc(?:ument)?\.?\s*no\.?)$/i;
const CLASSIFICATION_FIELD_LABELS: ReadonlySet<string> = new Set(Object.values(FRONT_PAYLOAD_LABELS.classification).map((s) => s.toLowerCase()));

const inlineText = (i: Inline | undefined): string => (!i ? "" : "text" in i ? i.text : i.runs.map((r) => ("t" in r ? r.t : "")).join(""));

/**
 * Row 122 (C40 FIX CP-15, DT-28c ID p.14 "Tulis klasifikasi kapital di baris tersendiri di bawah nomor", EN p.14):
 * the cover control block gets the line `Klasifikasi : TERBATAS` / `Classification: RESTRICTED` on its own line
 * directly under the document number, inside the number's value cell, so the 4 x 2 block keeps its eight fields
 * (ID p.47). Label in the value run, level bold seal (DT-28d, `color.wrapper.seal`). Unchanged when the block has
 * no number field, already carries a classification field, or the document has no classification.
 * Contract `Inline` cells, so DOCX and HTML (row 123) call the same helper.
 */
export function controlRowsWithClassificationLine(rows: ReadonlyArray<readonly [Inline, Inline, Inline, Inline]>, meta: DocMeta, params: ParamMap, lang: WrapperLang = wrapperLangOf(meta)): Array<[Inline, Inline, Inline, Inline]> {
  const out = rows.map((r) => [...r] as [Inline, Inline, Inline, Inline]);
  const level = meta.classification?.trim() ?? "";
  if (level === "") return out;
  const isClass = (c: Inline | undefined) => CLASSIFICATION_FIELD_LABELS.has(inlineText(c).trim().toLowerCase());
  const isNumber = (c: Inline | undefined) => NUMBER_FIELD_LABEL.test(inlineText(c).trim());
  if (out.some((r) => isClass(r[0]) || isClass(r[2]))) return out;
  const value = classificationMarkText(level);
  const full = classificationLineText(level, lang);
  const label = full.slice(0, full.length - value.length);
  const seal = pStr(params, "color.wrapper.seal") ?? "6E1420";
  for (const r of out) {
    for (const i of [0, 2] as const) {
      if (!isNumber(r[i])) continue;
      const cell = r[i + 1];
      if (!cell) continue;
      const base: Run[] = "text" in cell ? [{ t: cell.text }] : cell.runs;
      r[i + 1] = { runs: [...base, { br: "line" }, { t: label }, { t: value, b: true, color: seal }] };
      return out;
    }
  }
  return out;
}

/**
 * Row 122 (C40 FIX CP-30, DT-24 ID p.40): label of a derivation block = `<Turunan|Derivation> <id> · <title>`, the
 * label word printed once. A title that already starts with a label (`Turunan D-5.1 · Beban puncak`, case 01/05
 * material) loses that prefix instead of printing `Turunan D-5.1 · Turunan D-5.1 · ...`. The engine's numbering is
 * authoritative: a leading label with another number (case 05 writes `Turunan D-4.2 ·` where the numbering gives
 * D-4.1) is dropped too; a title word that is not followed by an id (`Turunan tegangan jatuh`) stays.
 */
export function derivationLabelText(id: string, title: string | undefined, lang: WrapperLang, separator = " · "): string {
  const word = APPARATUS_TEXT.derivation[lang];
  const head = `${word} ${id}`;
  if (!title) return head;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const words = [...new Set(Object.values(APPARATUS_TEXT.derivation))].map(esc).join("|");
  const lead = new RegExp(`^\\s*(?:(?:${words})\\s+[A-Z]{0,2}-?\\d+(?:\\.\\d+)*[a-z]?|${esc(id)})(?![\\w.])\\s*(?:·|:|—|–|-)?\\s*`, "i");
  const rest = lead.test(title) ? title.replace(lead, "") : title;
  return rest.trim() === "" ? head : head + separator + rest;
}

/**
 * Row 122 (C40 FIX CP-06/CP-09, ID p.48 "rantai verifikasi tiga lapis, pernyataan metode, distribusi terkendali, dan
 * tiga kolom tanda tangan"): template data for a TERBIT/SERAH control sheet whose document payload lacks a part.
 * - layers: P4K-02 `controlSheet.verificationChain.layers` (id + method), to complete the chain to three layers;
 * - method: R-81 `controlSheet.methodStatement.text`;
 * - distribution: R-82 `controlSheet.distribution.defaults` `{rows}` (rows of up to four cells: copy, holder, medium, return);
 * - signatures: P4K-05 `controlSheet.signatures.roles` with P4K-06 `controlSheet.signatures.holders`.
 * Values are template data only; nothing here invents a verification result.
 */
export interface ControlSheetTemplateData {
  layers: Array<{ id: string; method: string }>;
  method?: string;
  distribution: string[][];
  signatures: Array<{ role: string; holder: string }>;
}

export function controlSheetTemplateData(params: ParamMap): ControlSheetTemplateData {
  const vc = params["controlSheet.verificationChain"] as { layers?: unknown } | undefined;
  const layers = Array.isArray(vc?.layers)
    ? vc.layers.flatMap((l) => (l && typeof l === "object" && typeof (l as { id?: unknown }).id === "string" ? [{ id: (l as { id: string }).id, method: typeof (l as { method?: unknown }).method === "string" ? (l as { method: string }).method : "" }] : []))
    : [];
  const m = pStr(params, "controlSheet.methodStatement.text");
  const rawDist = (params["controlSheet.distribution.defaults"] as { rows?: unknown } | undefined)?.rows;
  const distribution = Array.isArray(rawDist) ? rawDist.filter((r): r is string[] => Array.isArray(r) && r.every((c) => typeof c === "string") && r.length > 0).map((r) => r.slice(0, 4)) : [];
  const roles = pStrList(params, "controlSheet.signatures.roles", []);
  const holders = pStrList(params, "controlSheet.signatures.holders", []);
  return {
    layers,
    ...(m !== undefined && m.trim() !== "" ? { method: m } : {}),
    distribution,
    signatures: roles.map((role, i) => ({ role, holder: holders[i] ?? "" })),
  };
}

/** Nilai PENYUSUN sampul: unit templat (C27) bila diisi, selain itu `meta.author`. Tanda tangan dan riwayat revisi tetap `meta.author`. */
function coverPreparerText(meta: DocMeta, params: ParamMap): string {
  return coverPreparerUnit(params) ?? meta.author;
}

/**
 * Baris blok kendali sampul auto (meta + P4V-12 `cover.controlBlock.fields`): pasangan
 * label/nilai berurutan, dua pasangan per baris, medan kosong dilewati, baris terakhir
 * dipadatkan dengan sel kosong. undefined = tidak ada medan berisi.
 */
export function controlBlockRowsText(meta: DocMeta, params: ParamMap, lang: WrapperLang, extras: ControlFieldExtras = {}): Array<[string, string, string, string]> | undefined {
  const values: Record<string, string | undefined> = {
    // Row 122 (CP-05): absent extras = undefined = skipped (callers that pass nothing print what they printed before).
    HALAMAN: extras.sheets,
    "DATUM GEODETIK": extras.geodeticDatum ?? coverGeodeticDatum(params),
    VERIFIKASI: extras.verification,
    "NOMOR DOKUMEN": meta.docNumber,
    REVISI: `${meta.rev} · ${longDate(meta.issueDate, lang)}`,
    PENYUSUN: coverPreparerText(meta, params),
    KUSTODIAN: meta.custodian,
    "DITUJUKAN KEPADA": meta.audience,
    TIER: meta.tier,
    DASAR: meta.basis,
    BAHASA: languageValueText(meta.language, lang),
    // C15 (CL-02 T/S, research/38 §3.3): hanya tercetak bila templat mendaftar KLASIFIKASI (bukan bawaan, C-6).
    KLASIFIKASI: meta.classification ? classificationMarkText(meta.classification) : undefined,
  };
  const pairs: Array<[string, string]> = [];
  for (const f of pStrList(params, "cover.controlBlock.fields", CONTROL_FIELDS_DEFAULT)) {
    const v = values[f];
    const label = CONTROL_FIELD_LABELS[f];
    if (!label || !v || v.trim() === "") continue;
    pairs.push([label[lang], v]);
  }
  if (pairs.length === 0) return undefined;
  const rows: Array<[string, string, string, string]> = [];
  for (let i = 0; i < pairs.length; i += 2) {
    const right = pairs[i + 1] ?? ["", ""];
    rows.push([pairs[i][0], pairs[i][1], right[0], right[1]]);
  }
  return rows;
}

/** Nama entitas bawaan kolofon bila `org.entityName` absen. */
export const ORG_ENTITY_DEFAULT = "PT GEMILANG SATRIA PERKASA";

/**
 * String punggung bawaan P4S-24 (`device.spine.fields`: jenis, subjek, bahasa, revisi, bulan, tahun),
 * dipisah " · ". FIX-F lanjutan (D-314): satu sumber DOCX (`docx/wrapper/render.ts` `spineText`) dan HTML
 * (`html/blocks/device.ts` `spineText`); bulan = angka Romawi seperti DOCX sebelumnya (DOCX byte-identik),
 * bukan nama bulan. Huruf kapital tampilan = format peran (`caps`), bukan teks sumber (D-46).
 */
export function spineTextOf(meta: DocMeta, params: ParamMap): string {
  const d = dateParts(meta.issueDate);
  const values: Record<string, string | undefined> = {
    jenis: meta.typeCode,
    subjek: meta.subject,
    bahasa: meta.language,
    revisi: `REV ${meta.rev}`,
    bulan: d ? ROMAN_MONTHS[d.m - 1] : undefined,
    tahun: d ? String(d.y) : undefined,
  };
  return pStrList(params, "device.spine.fields", ["jenis", "subjek", "bahasa", "revisi", "bulan", "tahun"])
    .map((f) => values[f])
    .filter((v): v is string => !!v && v.trim() !== "")
    .join(" · ");
}

/**
 * Cap terbit P4V-14 `device.issueStamp.format` (dulu isi `issueStampText` DOCX `wrapper/render.ts`).
 * S13: format absen atau = bawaan registri memakai entri bahasa `lang` (bawaan: bahasa meta).
 */
export function issueStampTextOf(meta: DocMeta, params: ParamMap, lang: WrapperLang = wrapperLangOf(meta)): string {
  const given = pStr(params, "device.issueStamp.format") ?? ISSUE_STAMP_FORMAT_DEFAULT;
  const fmt = given === ISSUE_STAMP_FORMAT_DEFAULT ? ISSUE_STAMP_FORMAT_TEXT[lang] : given;
  const d = dateParts(meta.issueDate);
  const ymd = d ? `${d.y}${String(d.m).padStart(2, "0")}${String(d.d).padStart(2, "0")}` : meta.issueDate.replace(/-/g, "");
  const n = meta.issueNumber ?? pNum(params, "device.issueStamp.issueNumber") ?? 1;
  return fmt
    .replace(/\{YYYYMMDD\}/g, ymd)
    .replace(/\{BAHASA\}/g, meta.language)
    .replace(/\{KELAS\}/g, classificationMarkText(meta.classification.trim().charAt(0)))
    .replace(/\{n\}/g, String(n));
}

/** Row 122: an issue stamp as written by hand (`// YYYYMMDD LL X <sep> TERBITAN|ISSUE n`), any separator form. */
const ISSUE_STAMP_SHAPE = /^\s*\/\/\s*\d{8}\s+(?:ID|EN)\s+\S+\s+(?:·|—|–|--|-)\s+(?:TERBITAN|ISSUE)\s+(\d+)\s*$/;

/**
 * Row 122 (C40 FIX CP-14): a colophon text that IS an issue stamp is a derived device, not prose. Every part of it
 * comes from the document (date = register date, language, letter = first letter of the classification, ID p.37
 * Tabel 6.2 and p.49), so a stamp supplied with the wrong separator or letter (case 01 material
 * `// 20261106 ID A · TERBITAN 1`) is re-derived from `meta`; only the issue number n of the given text is kept.
 * Any other text is returned unchanged (undefined = not a stamp).
 */
export function normalizedIssueStampText(text: string, meta: DocMeta, params: ParamMap, lang: WrapperLang = wrapperLangOf(meta)): string | undefined {
  const m = ISSUE_STAMP_SHAPE.exec(text);
  if (!m) return undefined;
  return issueStampTextOf({ ...meta, issueNumber: Number(m[1]) }, params, lang);
}

/**
 * Teks pita segel bawaan P4V-14 `wrapper.header` (dulu isi `sealBandTexts` DOCX `wrapper/render.ts`):
 * `{kelas}` = klasifikasi; kanan = `meta.copyControl` bila ada. Cadangan = bawaan registri (S06 B-05).
 * S13: pasangan absen atau = bawaan registri memakai entri bahasa `lang` (bawaan: bahasa meta);
 * pasangan lain yang diset templat menang di bahasa apa pun.
 */
export function sealBandTextsOf(meta: DocMeta, params: ParamMap, lang: WrapperLang = wrapperLangOf(meta)): [string, string] {
  const given = pStrList(params, "wrapper.header", SEAL_BAND_DEFAULT);
  const pair = sameList(given, SEAL_BAND_DEFAULT) ? SEAL_BAND_TEXT[lang] : given;
  // I39-1: fungsi pengganti = nilai disisipkan literal ("$&", "$$" dll. tidak diperluas).
  const kelas = classificationMarkText(meta.classification);
  const fill = (s: string | undefined) => (s ?? "").replace(/\{kelas\}/g, () => kelas);
  return [fill(pair[0]), meta.copyControl ?? fill(pair[1])];
}

/**
 * S06 (research/33 B-11): kata label Indonesia pada pola sel blok register yang dilokalkan per
 * bahasa (dulu `REGISTER_WORDS_EN` tersalin di DOCX `package/header-footer.ts` dan HTML
 * `html/base/markup.ts`). ID tanpa entri = tanpa terjemahan.
 */
export const REGISTER_WORDS: Readonly<Partial<Record<WrapperLang, Readonly<Record<string, string>>>>> = {
  EN: { LEMBAR: "SHEET", DARI: "OF" },
};

/** Teks literal pola sel register dengan kata label berhuruf besar dilokalkan ke `lang`. */
export function registerWordsText(text: string, lang: WrapperLang): string {
  const words = REGISTER_WORDS[lang];
  return words ? text.replace(/\b[A-Z]+\b/g, (w) => words[w] ?? w) : text;
}

/** Kolofon sampul auto P4V-13: kiri = entitas + "NIB …" (dipisah " · "), kanan = cap terbit. */
export function colophonTexts(meta: DocMeta, params: ParamMap): { left: string; right: string } {
  const fields = pStrList(params, "cover.colophon.fields", ["entitas", "NIB", "cap terbit", "klasifikasi"]);
  const left: string[] = [];
  if (fields.includes("entitas")) left.push(pStr(params, "org.entityName") ?? ORG_ENTITY_DEFAULT);
  if (fields.includes("NIB")) {
    const nib = pStr(params, "org.nib");
    if (nib) left.push(`NIB ${nib}`);
  }
  return { left: left.join(" · "), right: fields.includes("cap terbit") ? issueStampTextOf(meta, params) : "" };
}

/** Label bagian bawaan dari id bagian (angka di id, cadangan 1): "Bagian I" / "Part I". */
export function defaultPartLabelText(partId: string, lang: WrapperLang): string {
  return `${WRAPPER_TEXT.part[lang]} ${roman(Number(String(partId).replace(/\D/g, "")) || 1)}`;
}

// ── Label aparatus tabel/figur/turunan (S13 + D-597 D-2/D-3, D-598 F-2) ──

/**
 * Label aparatus per bahasa, SATU sumber untuk DOCX (`docx/figures/*`, `docx/tables/render.ts`) dan
 * HTML (`html/tables/style.ts` `labels`). Bentuk sumber = huruf campur seperti HTML; DOCX mencetak
 * SUMBER/PROVENANS/KUNCI kapital literal (BM K-33/K-34), jadi memakai `.toUpperCase()` entri yang
 * sama ("Sumber" -> "SUMBER", byte-identik dengan literal lama). `table`/`figure`/`derivation` =
 * kata depan label artefak; alamat API (`contract/address.ts`) tetap berkata ID, terjemahan hanya
 * tampilan (D-3). Vonis = tag bawaan pembangun turunan (`bind/derivation.ts`).
 */
export const APPARATUS_TEXT = {
  source: { ID: "Sumber", EN: "Source" },
  provenance: { ID: "Provenans", EN: "Provenance" },
  key: { ID: "Kunci", EN: "Key" },
  derivation: { ID: "Turunan", EN: "Derivation" },
  table: { ID: "Tabel", EN: "Table" },
  figure: { ID: "Gambar", EN: "Figure" },
  figureMissing: { ID: "Gambar tidak tersedia", EN: "Figure not available" },
  verdictPass: { ID: "MEMENUHI", EN: "COMPLIES" },
  verdictFail: { ID: "TIDAK MEMENUHI", EN: "DOES NOT COMPLY" },
} as const satisfies Readonly<Record<string, Readonly<Record<WrapperLang, string>>>>;

export type ApparatusTextKey = keyof typeof APPARATUS_TEXT;

/**
 * C07 (ST-01, register research/38 §3.6, research/37 R3-R6; D-635): label indeks aturan STD (opt-in
 * `render.ruleIndex.fromMarkers`, pembaca C17/C22). Judul huruf kalimat seperti tercetak (ID:4517, EN:4441);
 * kolom ID:4530 / EN:4456 tanpa kolom UJI SINGKAT, EN "Ch" tanpa titik agar kepala kapital = "CH" (EN:4456).
 * `source` = teks sesudah label run `APPARATUS_TEXT.source` (rumusan register, bukan teks manual); `empty` =
 * teks slot wajib tanpa kode aturan (rumusan register). Belum ada pemanggil.
 */
export const RULE_INDEX_TEXT = {
  title: { ID: "Indeks aturan", EN: "Rule index" },
  columns: { ID: ["Kode", "Ringkas", "Tingkat", "Bab"], EN: ["Code", "Summary", "Level", "Ch"] },
  source: { ID: "Blok aturan dokumen ini", EN: "Rule blocks of this document" },
  empty: { ID: "Dokumen ini tidak memuat kode aturan.", EN: "This document states no rule codes." },
} as const satisfies Readonly<Record<string, Readonly<Record<WrapperLang, string | readonly string[]>>>>;

/** Semua label aparatus untuk bahasa `lang`. */
export function apparatusText(lang: WrapperLang): Record<ApparatusTextKey, string> {
  const out = {} as Record<ApparatusTextKey, string>;
  for (const k of Object.keys(APPARATUS_TEXT) as ApparatusTextKey[]) out[k] = APPARATUS_TEXT[k][lang];
  return out;
}

const ARTIFACT_WORDS: ReadonlyArray<"table" | "figure" | "derivation"> = ["table", "figure", "derivation"];

/**
 * Label artefak tampilan (D-3): kata depan alamat ID ("Tabel", "Gambar", "Turunan") diganti kata
 * bahasa `lang`; label lain dan dokumen ID apa adanya. Alamat/penomoran tidak diubah.
 */
export function artifactLabelText(label: string, lang: WrapperLang): string {
  if (lang === "ID") return label;
  for (const w of ARTIFACT_WORDS) {
    const id = APPARATUS_TEXT[w].ID;
    if (label === id || label.startsWith(`${id} `)) return APPARATUS_TEXT[w][lang] + label.slice(id.length);
  }
  return label;
}

/** Tag vonis tampilan: tag bawaan ID (MEMENUHI / TIDAK MEMENUHI) diterjemahkan; tag kiriman apa adanya. */
export function verdictTagText(tag: string, lang: WrapperLang): string {
  if (lang === "ID") return tag;
  if (tag === APPARATUS_TEXT.verdictPass.ID) return APPARATUS_TEXT.verdictPass[lang];
  if (tag === APPARATUS_TEXT.verdictFail.ID) return APPARATUS_TEXT.verdictFail[lang];
  return tag;
}

/**
 * EN-PROV (DATUM Rev A Tabel 7.1, EN manual_en.txt:2114-2124, ID manual_id.txt:2040-2051): label tampilan
 * tanda provenans per bahasa, SATU sumber bagi rel, assumptionInline, baris SUMBER/PROVENANS tabel/figur, dan
 * turunan (DOCX dan HTML). Kunci = kode tanda kontrak (`PROVENANCE_MARKS`), yang tersimpan di konten dan API
 * dan tidak diterjemahkan; entri ID = kode itu sendiri, jadi keluaran ID byte-identik.
 */
export const PROVENANCE_MARK_TEXT = {
  TERUKUR: { ID: "TERUKUR", EN: "MEASURED" },
  DITURUNKAN: { ID: "DITURUNKAN", EN: "DERIVED" },
  PEMASOK: { ID: "PEMASOK", EN: "VENDOR" },
  ASUMSI: { ID: "ASUMSI", EN: "ASSUMED" },
} as const satisfies Readonly<Record<ProvenanceMark, Readonly<Record<WrapperLang, string>>>>;

/** Label tanda provenans `mark` untuk bahasa `lang`; kode di luar enum keluar apa adanya. */
export function provenanceMarkLabelText(mark: string, lang: WrapperLang): string {
  return Object.hasOwn(PROVENANCE_MARK_TEXT, mark) ? PROVENANCE_MARK_TEXT[mark as ProvenanceMark][lang] : mark;
}

/** Kata label aparatus kapital untuk `keys` dalam bahasa `lang`: satu sumber bagi pengenal run label (L4). */
export function apparatusLabelWords(keys: readonly ApparatusTextKey[], lang: WrapperLang = "ID"): string[] {
  return keys.map((k) => APPARATUS_TEXT[k][lang].toUpperCase());
}

const RUN_LABEL_KEYS: ReadonlyArray<"source" | "provenance" | "key"> = ["source", "provenance", "key"];
const RUN_LABEL_RE = new RegExp(`^(\\s*)(${apparatusLabelWords(RUN_LABEL_KEYS).join("|")})(\\s*:?\\s*)$`);

/**
 * Run label aparatus berbentuk `runs` (compose menyisipkan "SUMBER  " / "KUNCI  " sebagai penanda
 * struktural, `services/compose/inline.ts`): kata ID kapital diganti kata `lang` kapital saat
 * tampil, spasi pengapit tetap. Teks lain, dan semua teks dokumen ID, apa adanya.
 */
export function apparatusLabelRunText(text: string, lang: WrapperLang): string {
  if (lang === "ID") return text;
  const m = RUN_LABEL_RE.exec(text);
  if (!m) return text;
  const k = RUN_LABEL_KEYS.find((x) => APPARATUS_TEXT[x].ID.toUpperCase() === m[2]);
  return k ? m[1] + APPARATUS_TEXT[k][lang].toUpperCase() + m[3] : text;
}

// ── Row 123 (Swarm 1.2.0, C40/C56): shared Rev A helpers for the HTML/PDF path (additive) ──────────────

/** Row 123 (CP-06/CP-09, ID p.10 DT-02, p.48): only TERBIT and SERAH carry the full wrapper (NOTA none). */
export function isFullWrapperTier(meta: Pick<DocMeta, "tier"> | undefined): boolean {
  return meta?.tier === "TERBIT" || meta?.tier === "SERAH";
}

const tableCellText = (c: unknown): string => cellPlainText(c);

/**
 * Row 123 (C40 FIX CP-06, ID p.48 "rantai verifikasi tiga lapis"): the verification chain completed to the template
 * layers (P4K-02, `controlSheetTemplateData(params).layers`). A layer missing from the document table is added in
 * layer order with its id and, when the table has a METODE/Method column, its method; every other cell stays empty,
 * so no verification result is invented. Document rows are kept as they are. Same rule as the DOCX renderer
 * (`docx/wrapper/pages.ts` `completedVerificationChain`, row 122), here on the contract type for HTML.
 */
export function completedVerificationChainTable(table: TableBlock, layers: ReadonlyArray<{ id: string; method: string }>): TableBlock {
  if (layers.length === 0 || !Array.isArray(table.rows)) return table;
  const head = table.rows.filter((r) => r.kind === "header");
  const data = table.rows.filter((r) => r.kind !== "header");
  const n = Math.max(1, table.columns?.length ?? head[0]?.cells.length ?? data[0]?.cells.length ?? 1);
  const heads = (head[head.length - 1]?.cells ?? []).map((c) => tableCellText(c).trim().toLowerCase());
  const methodCol = heads.findIndex((h) => h === "metode" || h === "method");
  const byId = new Map(data.map((r) => [tableCellText(r.cells[0]).trim(), r]));
  if (layers.every((l) => byId.has(l.id))) return table;
  const ordered: TableBlock["rows"] = [];
  for (const l of layers) {
    const have = byId.get(l.id);
    if (have) {
      ordered.push(have);
      byId.delete(l.id);
      continue;
    }
    ordered.push({ cells: Array.from({ length: n }, (_, i) => ({ text: i === 0 ? l.id : i === methodCol ? l.method : "" })) });
  }
  const rest = data.filter((r) => byId.has(tableCellText(r.cells[0]).trim()));
  return { ...table, rows: [...head, ...ordered, ...rest] };
}

/** Row 123: a plain text table for control-sheet template data (first column = code), as the DOCX renderer builds it. */
export function controlSheetTextTable(heads: readonly string[], rows: readonly string[][]): TableBlock {
  return {
    type: "registerTable",
    columns: heads.map((_, i) => ({ role: i === 0 ? "id" : "text" })),
    rows: [{ kind: "header", cells: heads.map((t) => ({ text: t })) }, ...rows.map((r) => ({ cells: heads.map((_, i) => ({ text: r[i] ?? "" })) }))],
  } as TableBlock;
}

/** Row 123: distribution column heads (manual form when `controlSheet.columns.form` = "manual", as DOCX row 122). */
export function controlSheetDistributionHeads(params: ParamMap, lang: WrapperLang): string[] {
  return params["controlSheet.columns.form"] === "manual"
    ? (["SALINAN", "PEMEGANG", "MEDIA", "KEMBALI"] as const).map((k) => CONTROL_SHEET_COLUMN_LABELS[k][lang])
    : [...controlSheetColumnHeads("distribution", lang)];
}

/**
 * Row 123 (C40 FIX CP-04, ID p.47 butir 6 "Kicker jenis dokumen 7,4 pt Cond 600 seal, +0,20 em"; Tabel A.2 p.89-90):
 * the cover kicker form. Seal comes from `color.wrapper.seal`.
 */
export const COVER_KICKER_REV_A = { sizePt: 7.4, trackEm: 0.2, weight: 600 } as const;

/** Row 123 (C40 FIX CP-07, ID p.49 Tabel 8.1, p.89 A.1 "Teks pita segel #F4F5F6"): seal band text colour. */
export const SEAL_BAND_TEXT_HEX = "F4F5F6";

/**
 * Row 123 (C40 FIX CP-23, ID p.53 DT-13f "Di PDF, segmen depan Datum Rule tumbuh mengikuti nomor halaman"; DATUM
 * tokens.json `datum_rule_progress_gauge`: fill = pageNumber / totalPages): lead segment length in mm. `page` and
 * `total` are 1-based sheet positions; out-of-range input is clamped to [1, total].
 */
export function datumRuleLeadMm(widthMm: number, page: number, total: number): number {
  if (!(widthMm > 0) || !(total >= 1)) return 0;
  const p = Math.min(Math.max(1, page), total);
  return Math.round(((widthMm * p) / total) * 1000) / 1000;
}

/**
 * Row 123 (C40 FIX CP-35, ID p.13 and p.67 Tabel 10.4): words of a figure key line for an Indonesian document. The
 * key label is "KUNCI" (APPARATUS_TEXT.key), and the DATUM edge kinds that open a legend row (`DATA = ...`,
 * `CONTROL = ...`) are named by their line pattern as printed in the ID manual (Tabel 10.4 POLA: data penuh,
 * control putus-putus, sync titik-titik, accent penuh tebal, alert putus panjang, verify titik-garis). Other text
 * (the author's meanings after "=") is kept as written. EN documents and non-ID text: unchanged.
 */
export const KEY_EDGE_KIND_TEXT_ID: Readonly<Record<string, string>> = {
  DATA: "PENUH",
  CONTROL: "PUTUS-PUTUS",
  SYNC: "TITIK-TITIK",
  ACCENT: "PENUH TEBAL",
  ALERT: "PUTUS PANJANG",
  VERIFY: "TITIK-GARIS",
};

export function keyLineText(text: string, lang: WrapperLang): string {
  if (lang !== "ID") return text;
  const kinds = Object.keys(KEY_EDGE_KIND_TEXT_ID).join("|");
  let out = text.replace(/^(\s*)KEY(\s+)/i, (_m, a: string, b: string) => `${a}${APPARATUS_TEXT.key.ID.toUpperCase()}${b}`);
  // A legend row opens the line (after the label) or follows the row separator "·".
  out = out.replace(new RegExp(`(^|·|^\\s*${APPARATUS_TEXT.key.ID.toUpperCase()}\\s+)(\\s*)(${kinds})(\\s*=)`, "gi"), (_m, lead: string, sp: string, kind: string, eq: string) => `${lead}${sp}${KEY_EDGE_KIND_TEXT_ID[kind.toUpperCase()]}${eq}`);
  return out;
}
