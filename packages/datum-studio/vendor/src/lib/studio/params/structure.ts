/**
 * Parameter kontrak refaktor struktur (SR-05): register SR-01
 * (`masterplan/03_structural_sections_specs.md` §13.1, R-38..R-52) ditambah kunci
 * research/09 §4.3 yang tidak punya padanan di register SR-01 (R-53..R-58; nomor
 * diajukan lewat `file_requests.md`). `origin: "contract"`, `group: "R"`, dihitung
 * terpisah dari katalog dan dari renderer R-01..R-37.
 *
 * Penyelarasan nama (KT-13, D-165/D-166; register SR-01 menang):
 * - research/09 N6 `type.baseSizePt` TIDAK dibuat: kenop "Ukuran huruf dasar" menulis
 *   `type.scale.body.size` (SR-01 PC-06).
 * - Ukuran halaman: nama kanonik tunggal SR-01 DV-01 `pageSizeFromPaper` (alias research/09 dicabut, D-172/D-211).
 * - Nilai enum mengikuti SR-01 E35/E38/E39/E43 (mis. `standard`, bukan `sedang`).
 *
 * Cakupan dan lapis setiap kunci di berkas ini ditetapkan `registry/slots.ts`
 * (PARAM_SCOPE) dan `registry/essentials.ts` (PARAM_SURFACE), bukan di sini.
 */
import { INLINE_FORMAT_POLICIES, MARGIN_DENSITIES, PAGE_ORIENTATIONS, PAPER_SIZES } from "../contract/enums";
import type { ParamDef } from "../contract/types/params";

// Nilai enum kontrak: E35 INLINE_FORMAT_POLICIES, E38 PAPER_SIZES, E39 PAGE_ORIENTATIONS, E43 MARGIN_DENSITIES (SR-04).

/** research/09 N14-N16: kelas lebar relatif figur/tabel. */
const WIDTH_CLASSES = ["text", "full"] as const;

const SR01 = "SR-01 §13.1";
const SR59 = "research/09 §4.3";

function s(
  n: number,
  key: string,
  label: string,
  type: ParamDef["type"],
  def: ParamDef["default"],
  source: string,
  extra: Partial<ParamDef> = {},
): ParamDef {
  return {
    id: `R-${String(n).padStart(2, "0")}`,
    key,
    label,
    type,
    default: def,
    class: "B",
    ruleRef: "-",
    source,
    origin: "contract",
    group: "R",
    chapter: "Struktur",
    namespace: key.split(".")[0],
    ...extra,
  };
}

export const PARAMS_STRUCTURE: readonly ParamDef[] = [
  // ── Register SR-01 R-38..R-52 ──────────────────────────────────────────
  s(38, "ingest.inlineFormat", "Kebijakan tampilan inline kiriman v1", "enum", "strip", `${SR01} R-38; D-138; KD-26`, {
    class: "K",
    enum: INLINE_FORMAT_POLICIES,
    classNote: "strip = buang + REPORT; reject = 422; allow = hanya ADMIN/harness tepercaya",
  }),
  s(39, "render.draft.marker", "Penanda render draf", "object", { text: "DRAF", placement: "header" }, `${SR01} R-39`, {
    classNote: "{ text: string; placement: \"header\" | \"footer\" } untuk berkas draf (StudioOutputFile.draft = true)",
  }),
  s(40, "render.run.symbolGlyphs", "Karakter yang dipecah ke wajah simbol", "list", ["■", "◈", "◇", "△"], `${SR01} R-40; blueprint :38`, {
    classNote: "satu karakter per butir; wajib memuat glif tanda provenans marks.*.glyph (P5-30/32/34/36, research/09 U11)",
  }),
  s(41, "slot.setup", "Pengaturan seksi slot", "object", {}, `${SR01} R-41; D-165 KT-10`, {
    classNote:
      "SectionSetup parsial tanpa pageSizeTw (pageSizeTw = 400 PARAM_CLASS_T_READONLY, pointer /pageSizeTw); " +
      "medan startOnNewPage dan runningHead (KT-10; hanya dua medan ini dibuka kenop esensial Konten EK-chapter-06/07, ESSENTIAL_FIELD_PATHS; kunci tetap advanced)",
  }),
  s(42, "slot.placement", "Penempatan tanda tangan", "enum", "inControlSheet", `${SR01} R-42; AS-2`, {
    enum: ["standalone", "inControlSheet"],
    classNote: "berlaku hanya untuk sectionType signatureBlock",
  }),
  s(43, "slot.placeholderText", "Teks pengganti slot kosong pada draf", "string", "[{label} belum diisi]", `${SR01} R-43`, {
    classNote: "{label} diganti label slot",
  }),
  s(44, "page.size", "Ukuran kertas", "enum", "A4", `${SR01} R-44; D-158; KC-11`, {
    enum: PAPER_SIZES,
    classNote: "A4 210x297, A3 297x420, A5 148x210, Letter 215,9x279,4, Legal 215,9x355,6, F4 215x330 mm (hipotesis KC-11)",
  }),
  s(45, "page.orientation", "Orientasi", "enum", "portrait", `${SR01} R-45; D-158`, {
    enum: PAGE_ORIENTATIONS,
    classNote: "boleh ditimpa per slot (cakupan slot); landscape menukar lebar dan tinggi",
  }),
  s(46, "page.customSizeMm", "Ukuran kertas kustom (mm)", "pair", null, `${SR01} R-46; D-158`, {
    classNote: "[lebar, tinggi] mm; bila diisi menimpa page.size",
  }),
  s(47, "grid.marginDensity", "Kerapatan margin", "enum", "standard", `${SR01} R-47; D-165 KT-1`, {
    enum: MARGIN_DENSITIES,
    classNote: "compact x0,75, standard = acuan, wide x1,25 (dibulatkan 0,5 mm; fungsi marginsFromDensity)",
  }),
  s(48, "doc.defaultTypeCode", "Kode jenis dokumen bawaan", "string", "KT", `${SR01} R-48`, {
    classNote: "anggota doc.typeCode (P3-20)",
  }),
  s(49, "doc.defaultTier", "Tier dokumen bawaan", "enum", "TERBIT", `${SR01} R-49`, {
    enum: ["NOTA", "TERBIT", "SERAH"],
  }),
  s(50, "chart.composite.columns", "Kolom panel chart komposit", "int", 3, `${SR01} R-50; KD-17`, {
    range: { min: 1, max: 3, step: 1 },
  }),
  s(51, "chart.composite.gapMm", "Celah panel chart komposit (mm)", "mm", 4, `${SR01} R-51; KD-17`, {
    range: { min: 0, step: 0.1 },
    classNote: "= COMPOSITE_DEFAULT_GAP_MM (engine/chart/core/composite.ts); preset Manual 000 menyematkan 4,3",
  }),
  s(52, "render.table.columnProfiles", "Profil lebar kolom tabel per preset tabel", "map", {}, `${SR01} R-52; D-166 KC-6`, {
    classNote: "presetName -> { colsTw: number[] }; tanpa profil = lebar otomatis dari peran kolom",
  }),
  // ── research/09 §4.3 tanpa padanan register SR-01 (R-53..R-58) ─────────
  s(53, "grid.marginBottomMm", "Margin bawah (mm)", "mm", 24, `${SR59} N5; D-162; D-33`, {
    range: { min: 0, step: 0.5 },
    derive: "marginsFromDensity",
    classNote: "turunan beracuan (kelas B): acuan disematkan preset; promosi kunci bayangan engine/tokens/grid.ts",
  }),
  s(54, "symbol.sheet.fit", "Lembar simbol isi-pas", "bool", false, `${SR59} N13; D-147; D-156`, {
    classNote: "true = tata letak isi-pas per dialek (RL datum_symbols.py --sheet); preset GSP DATUM dan Manual 000 = true",
  }),
  s(55, "table.widthClass", "Lebar tabel", "enum", "text", `${SR59} N14; research/08 A26`, {
    enum: WIDTH_CLASSES,
    classNote: "text = kolom teks, full = bentang penuh; mm diturunkan (figureWidthFromClass -> P5-14)",
  }),
  s(56, "chart.widthClass", "Lebar grafik", "enum", "text", `${SR59} N15; research/08 A26`, {
    enum: WIDTH_CLASSES,
    classNote: "text = kolom teks, full = bentang penuh; mm diturunkan (figureWidthFromClass -> P7-20)",
  }),
  s(57, "diagram.widthClass", "Lebar diagram", "enum", "text", `${SR59} N16; research/08 A26`, {
    enum: WIDTH_CLASSES,
    classNote: "text = kolom teks, full = bentang penuh; mm diturunkan (figureWidthFromClass -> P9-36)",
  }),
  s(58, "appendix.kicker.pattern", "Label nomor lampiran", "string", null, `${SR59} N17; engine/docx/blocks/structure.ts`, {
    pattern: "\\{n\\}",
    classNote: "wajib memuat {n}; null = turunan kata LAMPIRAN dari pola bab (perilaku sekarang)",
  }),
];

/** 15 kunci register SR-01 + 6 kunci research/09 tanpa padanan. */
export const PARAMS_STRUCTURE_COUNT = 21;
