/**
 * Parameter aparatus bukti P5 (68, Bab 5) dan kepatuhan/satuan/reproduksi P6
 * (43, Bab 6) = 111 ParamDef, `origin: "catalog"` (01_specs.md §5.1, T04, S07).
 * Sumber: research/01_manual_parameter_catalog.md §3.4-3.5; nilai asli dari
 * research/04_manual_docx_tables.md (D-09): Tabel 5.1 (T038), Tabel 5.3 (T042),
 * Tabel 5.4 (T045), Tabel 5.5 (T046), Tabel 6.1 (T048), 6.2 (T049), 6.3 (T051), 6.6 (T052).
 *
 * Keputusan baris:
 * - Tanda provenans (P5-30..37, T042): glif ■ ◈ ◇ △ dirender dengan fon DejaVu Sans
 *   yang ditanam (K-18, R-14); warna per tanda ink900, signal, ink400, alert (K-19).
 *   Warna P5-31/33/35/37 `rek: true` (nilai [REK] sudah diganti T042).
 * - K-14: kode kelas SR/R/T/B disimpan sebagai medan terpisah (P6-04), bukan
 *   unsur pertama nomor dokumen, sampai .docx memutus pola nomor.
 */
import type { ParamDef, ParamGroup } from "../contract/types/params";

type Extra = Partial<ParamDef>;

function make(
  id: string,
  key: string,
  label: string,
  type: ParamDef["type"],
  def: ParamDef["default"],
  cls: ParamDef["class"],
  ruleRef: string,
  source: string,
  extra: Extra = {},
): ParamDef {
  const group = id.slice(0, 2) as ParamGroup;
  return {
    id,
    key,
    label,
    type,
    default: def,
    class: cls,
    ruleRef,
    source,
    origin: "catalog",
    group,
    chapter: group === "P5" ? "Bab 5" : "Bab 6",
    namespace: key.split(".")[0],
    ...extra,
  };
}

/** Bab 5: tabel dan aparatus bukti (68). */
const P5: readonly ParamDef[] = [
  make("P5-01", "table.verticalRules.allowed", "Garis tegak tabel diizinkan", "bool", false, "K", "DT-16, lint 07", "L881, L3952; research/04 T038"),
  make("P5-02", "table.headerFill.allowed", "Isian pada baris kepala tabel diizinkan", "bool", false, "K", "DT-16, lint 08", "L881-882, L3954; research/04 T038"),
  make("P5-03", "table.header.verticalAlign", "Rata vertikal kepala tabel", "enum", "bottom", "B", "5.1", "L869; research/04 T038", {
    // S95-C13 (delta S03-d1): "top" = tanpa w:vAlign (BM KT-23, KT-27).
    enum: ["bottom", "top"],
  }),
  make("P5-04", "table.numeral.align", "Rata numeral tabel", "enum", "decimal", "K", "DT-17", "L873; research/04 T038", {
    enum: ["right", "decimal"],
    classNote: "rata kanan dan rata desimal; tidak pernah di tengah",
  }),
  make("P5-05", "table.unitColumn.required", "Kolom satuan sendiri wajib (tabel data)", "bool", true, "K", "DT-17, lint 09", "L875, L3956; research/04 T038"),
  make("P5-06", "table.unitInHeader.singleUnitException", "Pengecualian satuan di kepala (satuan tunggal)", "bool", false, "B", "R-07", "L4260-4263", {
    classNote: "true hanya untuk tabel ringkas bersatuan tunggal",
  }),
  make("P5-07", "table.zebra.minRows", "Jumlah baris minimum sebelum zebra", "int", 12, "K", "DT-18", "L877, L3887; research/04 T038", {
    range: { min: 12, step: 1 },
    classNote: "zebra hanya bila lebih dari 12 baris",
  }),
  make("P5-08", "table.zebra.colour", "Warna zebra tabel", "tokenRef", "zebra15", "B", "DT-18", "L877; research/04 T038; D-31", {
    conflictRef: "K-07",
    classNote:
      "B (konflik K-07: manual menulis ink100 = rona 5,3 %, di bawah lantai fotokopi 15 %; KT-09 dan D-31: default token zebra15 rona 15 %, diturunkan mesin token S11 kelas T; ink100 tetap untuk pita workbook)",
  }),
  make("P5-09", "table.zebra.onPrintedBoq", "Zebra pada BoQ cetak", "bool", false, "K", "DT-18, R-06", "L877, L4256-4258; research/04 T038"),
  make("P5-10", "table.totalRow.ruleAbove", "Garis di atas baris total", "tokenRef", "rules.primary", "T", "5.1", "L745, L879; research/04 T038", {
    derive: "totalRowRule",
  }),
  make("P5-11", "table.totalRow.fill", "Isian baris total", "enum", "none", "K", "5.1", "L879; research/04 T038", { enum: ["none"] }),
  make("P5-12", "table.header.repeatEachPage", "Kepala tabel berulang tiap halaman", "bool", true, "K", "5.1", "L884; research/04 T038"),
  make("P5-13", "table.row.splitAcrossPages", "Baris tabel boleh dipecah antar halaman", "bool", false, "K", "5.1", "L884; research/04 T038"),
  make("P5-14", "table.columnWidthSumMm", "Jumlah lebar kolom tabel (mm)", "mm", 128, "T", "datumcheck G2", "L4029", {
    derive: "figureWidthFromClass",
    classNote:
      "T (research/09 U3, D-162): anggota grid.allowedFigureWidthsMm menurut table.widthClass (text = kolom teks, full = bentang penuh); A4 = 128/166",
  }),
  make("P5-15", "table.rowCellCount.equalsHeader", "Jumlah sel baris sama dengan kepala", "bool", true, "K", "datumcheck G1", "L4028"),
  make("P5-16", "table.cellText.fitsColumn", "Teks sel muat dalam kolom", "bool", true, "K", "datumcheck G3", "L4029-4030"),
  make("P5-17", "caption.required", "Keterangan tabel wajib, di atas tabel", "bool", true, "K", "DT-15, lint 30", "L888-889, L4003"),
  make("P5-18", "caption.identifier.style", "Gaya pengenal caption", "tokenRef", "condensedCaps", "T", "DT-15", "L889-890, L859", {
    derive: "captionIdentifierStyle",
    classNote: 'condensed kapital berspasi, mis. "T A B E L 5 . 1"; diturunkan dari peran caption (P4T-S08)',
  }),
  make("P5-19", "caption.sentenceCount", "Jumlah kalimat caption", "int", 1, "K", "DT-15", "L890", { range: { min: 1, max: 1, step: 1 } }),
  make("P5-20", "caption.effectiveDateInTitle", "Tanggal berlaku dalam judul caption", "bool", true, "K", "5.2", "L890-892", {
    classNote: "true bila isi tabel bertanggal berlaku",
  }),
  make("P5-21", "caption.chart.isConclusion", "Caption chart berupa kesimpulan", "bool", true, "K", "CH-05", "L892, L1394-1405"),
  make("P5-22", "source.required", "Baris sumber wajib, di bawah", "bool", true, "K", "DT-15, lint 10/29", "L888-889, L3958, L4001"),
  make("P5-23", "source.provenanceField.required", "Medan provenans pada baris sumber wajib", "bool", true, "K", "DT-15", "L842, L199; research/04 T039", {
    classNote: 'bentuk "SUMBER ... PROVENANS ..."',
  }),
  make("P5-24", "source.glyphKey.include", "Sertakan kunci glif pada baris sumber", "bool", true, "B", "Tabel 4.7 no. 12", "L842", {
    classNote: "true bila glif dipakai",
  }),
  make("P5-25", "artifact.mustBeCalledInProse", "Artefak wajib dipanggil dalam prosa", "bool", true, "K", "SG-L2-06, DT-15", "L894-896", {
    classNote: "artefak yatim dipanggil atau dihapus",
  }),
  make("P5-26", "specTable.columns", "Kolom tabel spesifikasi", "list", ["PARAMETER", "KONDISI UJI", "NILAI", "SATUAN"], "K", "DT-19", "L900-906; research/04 T039"),
  make("P5-27", "specTable.condition.style", "Gaya kolom kondisi uji", "object", { indented: true, ruled: false }, "B", "DT-19", "L900-902; research/04 T039", {
    classNote: "menjorok, tidak bergaris",
  }),
  make("P5-28", "aside.ruleBottom", "Garis bawah aside", "tokenRef", "rules.hair", "B", "DT-20", "L929; research/04 T040"),
  make("P5-29", "aside.fill", "Isian aside", "enum", "none", "K", "DT-20, lint 02, R-12", "L927-932, L4285; research/04 T040", {
    enum: ["none"],
    classNote: "kotak krem berbatang gagal lint 02",
  }),
  make("P5-30", "marks.terukur.glyph", "Glif tanda TERUKUR", "char", "■", "K", "DT-21", "TK104; research/04 T042", {
    conflictRef: "K-18",
    classNote: "U+25A0, dirender fon DejaVu Sans yang ditanam (K-18, R-14); glif terbaca dari .docx (K-27)",
  }),
  make("P5-31", "marks.terukur.colour", "Warna tanda TERUKUR", "tokenRef", "ink900", "K", "Tabel 5.3", "L944-945; research/04 T042", { rek: true }),
  make("P5-32", "marks.diturunkan.glyph", "Glif tanda DITURUNKAN", "char", "◈", "K", "DT-21", "TK105; research/04 T042", {
    conflictRef: "K-18",
    classNote: "U+25C8, dirender fon DejaVu Sans yang ditanam (K-18, R-14)",
  }),
  make("P5-33", "marks.diturunkan.colour", "Warna tanda DITURUNKAN", "tokenRef", "signal", "K", "Tabel 5.3", "L945-947, TK103; research/04 T042", { rek: true }),
  make("P5-34", "marks.pemasok.glyph", "Glif tanda PEMASOK", "char", "◇", "K", "DT-21", "TK106; research/04 T042", {
    conflictRef: "K-18",
    classNote: "U+25C7, dirender fon DejaVu Sans yang ditanam (K-18, R-14)",
  }),
  make("P5-35", "marks.pemasok.colour", "Warna tanda PEMASOK", "tokenRef", "ink400", "K", "Tabel 5.3", "L946-949; research/04 T042", { rek: true }),
  make("P5-36", "marks.asumsi.glyph", "Glif tanda ASUMSI", "char", "△", "K", "DT-21", "TK107; research/04 T042", {
    conflictRef: "K-18",
    classNote: "U+25B3, dirender fon DejaVu Sans yang ditanam (K-18, R-14)",
  }),
  make("P5-37", "marks.asumsi.colour", "Warna tanda ASUMSI", "tokenRef", "alert", "K", "Tabel 5.3", "L947-951, TK103; research/04 T042", {
    rek: true,
    conflictRef: "K-19",
    classNote: "K (konflik K-19: warna per tanda menurut Tabel 5.3, bukan satu warna amber)",
  }),
  make("P5-38", "marks.requiredOnDecisionNumbers", "Tanda wajib pada angka beban keputusan", "bool", true, "K", "DT-21, lint 11", "L953, L3960; research/04 T043"),
  make("P5-39", "marks.prose.maxPerWords", "Kerapatan tanda dalam prosa (kata per tanda)", "int", 20, "K", "SG-L6-13, C-31", "L957-958, L3696-3698; research/04 T043", {
    range: { min: 20, max: 20, step: 1 },
    classNote: "paling banyak 1 tanda per 20 kata",
  }),
  make("P5-40", "marks.oncePerClause", "Tanda sekali per klausa", "bool", true, "K", "DT-22, SG-L3-05", "L956-957; research/04 T043", {
    classNote: "tidak diulang pada penyebutan ulang",
  }),
  make("P5-41", "marks.overflowTarget", "Tujuan tanda berlebih", "enum", "rail", "B", "R-05", "L958-960, L4252-4254; research/04 T043", {
    enum: ["rail", "tableRow"],
    classNote: "rail atau tableRow; tanda tidak dihapus",
  }),
  make("P5-42", "marks.asumsi.requiresIdAndImpact", "Tanda ASUMSI membawa ID dan dampak", "bool", true, "K", "Tabel 5.3", "L951; research/04 T042"),
  make("P5-43", "numbers.bindToRegister", "Angka beban keputusan terikat register", "bool", true, "K", "DT-23", "L964-968; research/04 T044", {
    classNote: "angka beban keputusan adalah rujukan bernama ke register kuantitas",
  }),
  make("P5-44", "register.rejectUnmarkedEntries", "Register menolak entri tanpa tanda", "bool", true, "K", "DT-23", "L968"),
  make("P5-45", "register.maxDecimals", "Desimal maksimum register", "int", 3, "T", "-", "TK115, L4365", {
    derive: "registerMaxDecimals",
    range: { min: 0, max: 3, step: 1 },
    classNote: "batas mesin (E-12)",
  }),
  make("P5-46", "audit.untrackedNumbers.enabled", "Audit angka tak terlacak (audit_docx)", "bool", true, "T", "DT-23", "L987-988, L4064", {
    derive: "auditByTier",
    tiers: ["SERAH"],
    classNote: "T (per tier): aktif pada SERAH",
  }),
  make("P5-47", "audit.retiredValues.enabled", "Audit nilai terpensiun (audit_retired)", "bool", true, "T", "DT-23", "L988-989, L4064", {
    derive: "auditByTier",
    tiers: ["SERAH"],
    classNote: "T (per tier): aktif pada SERAH",
  }),
  // R01 (F-023): `pattern` memvalidasi NILAI parameter (templat berplaceholder), bukan ID hasil.
  make("P5-48", "derivation.id.pattern", "Pola ID blok turunan", "string", "D-{bab}.{urut}", "K", "DT-24", "L996, L976", {
    pattern: "^D-(\\{bab\\}|[0-9]+)\\.(\\{urut\\}|[0-9]+)[a-z]?$",
    classNote: "contoh D-6.1, D-7.2a; ID hasil cocok ^D-[0-9]+\\.[0-9]+[a-z]?$ (regex diturunkan dari kedua contoh)",
  }),
  make("P5-49", "derivation.markPerInputLine", "Tanda pada tiap baris masukan turunan", "bool", true, "K", "DT-24, E-15", "L994-995, L4370"),
  make("P5-50", "derivation.closingSentence.required", "Kalimat penutup blok turunan wajib", "bool", true, "K", "DT-24", "L995, L980; research/04 T050", {
    classNote: "akibat bila asumsi gagal",
  }),
  make("P5-51", "derivation.recomputeAgainstRegister", "Hitung ulang terhadap register", "bool", true, "K", "DT-24", "L996-998", {
    classNote: "bangun ditolak bila tidak sama",
  }),
  make("P5-52", "derivation.toleranceMode", "Mode toleransi turunan", "enum", "absolute", "B", "E-14", "L4369", {
    enum: ["absolute", "relative"],
    classNote: "toleransi absolut 0,51; temuan E-14 mengusulkan relatif",
  }),
  make("P5-53", "derivation.verdictDirection", "Arah vonis turunan", "enum", "lessOrEqual", "B", "E-13", "L4367", {
    enum: ["lessOrEqual", "greaterOrEqual"],
    classNote: "E-13 mengusulkan arah sebagai argumen",
  }),
  make("P5-54", "admiralty.reliability", "Skala keandalan sumber Admiralty", "list", ["A", "B", "C", "D", "E", "F"], "K", "DT-25", "L1003-1024; research/04 T045", {
    enum: ["A", "B", "C", "D", "E", "F"],
    classNote: "skala tetap A-F; katalog bertipe enum, disimpan sebagai daftar skala",
  }),
  make("P5-55", "admiralty.credibility", "Skala kredibilitas informasi Admiralty", "list", ["1", "2", "3", "4", "5", "6"], "K", "DT-25", "L1003-1024; research/04 T045", {
    enum: ["1", "2", "3", "4", "5", "6"],
    classNote: "skala tetap 1-6; katalog bertipe enum, disimpan sebagai daftar skala",
  }),
  make("P5-56", "admiralty.requiredOnExternalClaims", "Admiralty wajib pada klaim eksternal", "bool", true, "K", "DT-25, lint 22", "L1003, L3982"),
  make("P5-57", "admiralty.excludedFromProposal", "Kode Admiralty dikecualikan dari proposal", "list", ["F6"], "K", "5.8", "L1007-1008"),
  make("P5-58", "admiralty.scaleTablePrintedOnceInAppendix", "Tabel skala Admiralty dicetak sekali di lampiran", "bool", true, "T", "5.8", "L1026-1027; research/04 T045", {
    derive: "admiraltyOnce",
    classNote: "true bila skala dipakai",
  }),
  make(
    "P5-59",
    "icd203.bands",
    "Pita kemungkinan ICD 203",
    "list",
    [
      { label: "hampir tidak mungkin", fromPercent: 1, toPercent: 5 },
      { label: "sangat kecil kemungkinannya", fromPercent: 5, toPercent: 20 },
      { label: "kecil kemungkinannya", fromPercent: 20, toPercent: 45 },
      { label: "kira-kira berimbang", fromPercent: 45, toPercent: 55 },
      { label: "kemungkinan besar", fromPercent: 55, toPercent: 80 },
      { label: "sangat mungkin", fromPercent: 80, toPercent: 95 },
      { label: "hampir pasti", fromPercent: 95, toPercent: 99 },
    ],
    "K",
    "DT-26",
    "L1029-1033",
    { classNote: "7 pita tetap" },
  ),
  make("P5-60", "icd203.mixLikelihoodWithConfidence", "Campur kemungkinan dengan keyakinan", "bool", false, "K", "DT-26", "L1033-1034"),
  make("P5-61", "confidence.label", "Label keyakinan", "enum", "konservatif", "B", "SG-L4-07", "L1034-1036", {
    enum: ["konservatif", "indikatif"],
    classNote: "daftar terbuka; fakta terverifikasi tanpa pagar",
  }),
  make("P5-62", "assumptionRegister.columns", "Kolom register asumsi", "list", ["ID", "ASUMSI", "DAMPAK BILA SALAH", "VERIFIKASI"], "K", "DT-27", "L1040-1052; research/04 T046"),
  // R01 (F-023): `pattern` memvalidasi NILAI parameter (templat berplaceholder), bukan ID hasil.
  make("P5-63", "assumption.id.pattern", "Pola ID asumsi", "string", "ASM-{domain}-{nn}", "K", "DT-27", "L1041-1042; research/04 T046", {
    pattern: "^ASM-(\\{domain\\}|[A-Z][A-Z0-9]*)-(\\{nn\\}|[0-9]{2})$",
    classNote: "contoh ASM-PWR-01; ID hasil cocok ^ASM-[A-Z][A-Z0-9]*-[0-9]{2}$ (regex diturunkan dari contoh)",
  }),
  make("P5-64", "assumption.impact.required", "Dampak asumsi wajib", "bool", true, "K", "DT-27", "L1042; research/04 T046", {
    classNote: "asumsi tanpa dampak adalah tebakan",
  }),
  // R01 (F-023): `pattern` memvalidasi NILAI parameter (templat berplaceholder), bukan ID hasil.
  make("P5-65", "requirement.id.pattern", "Pola ID kebutuhan", "string", "REQ-{subsistem}-{nn}", "K", "DT-27", "L1043", {
    pattern: "^REQ-(\\{subsistem\\}|[A-Z][A-Z0-9]*)-(\\{nn\\}|[0-9]{2})$",
    classNote: "ID hasil cocok ^REQ-[A-Z][A-Z0-9]*-[0-9]{2}$ (regex diturunkan dari pola katalog)",
  }),
  make("P5-66", "requirement.id.immutableAcrossPackage", "ID kebutuhan tetap sepanjang paket", "bool", true, "K", "DT-27", "L1043-1045", {
    classNote: "kajian, proposal, BoQ, jadwal, uji terima",
  }),
  make("P5-67", "serah.secondIndependentRoute.required", "Rute turunan kedua independen wajib (SERAH)", "bool", true, "T", "3.2", "L449-451", {
    derive: "serahByTier",
    tiers: ["SERAH"],
    classNote: "T (per tier): wajib untuk setiap kuantitas rekapitulasi",
  }),
  make("P5-68", "serah.reconciliationTable.required", "Tabel rekonsiliasi dua rute wajib (SERAH)", "bool", true, "T", "3.2", "L450-451", {
    derive: "serahByTier",
    tiers: ["SERAH"],
    classNote: "T (per tier): memuat kedua rute dan selisih",
  }),
];

/** Bab 6: kepatuhan, satuan, reproduksi (43). */
const P6: readonly ParamDef[] = [
  make("P6-01", "classification.recipientScheme", "Skema klasifikasi menurut penerima", "enum", "anri", "K", "DT-28, lint 18", "L1075-1086; research/04 T048", {
    enum: ["kemhanTni", "polri", "anri"],
    classNote: "kemhanTni = Permenhan 26/2017 Ps 3; polri = Perkap 1/2023 Ps 79; anri = ANRI 5/2021 Ps 104-109 (internal GSP)",
  }),
  make("P6-02", "classification.level", "Klasifikasi bawaan", "enum", "Terbatas", "K", "DT-28", "L1079-1086, L4294-4296; research/04 T048", {
    enum: ["Biasa", "Terbatas", "Rahasia", "Sangat Rahasia"],
    classNote: "skema kemhanTni tanpa Terbatas; polri dan anri memuat keempatnya",
  }),
  make(
    "P6-03",
    "classification.schemeLevels",
    "Tingkat per skema klasifikasi (Tabel 6.1)",
    "map",
    {
      kemhanTni: { instrument: "Permenhan No. 26 Tahun 2017, Pasal 3", levels: ["Biasa", "Rahasia", "Sangat Rahasia"] },
      polri: { instrument: "Perkap Polri No. 1 Tahun 2023, Pasal 79", levels: ["Biasa", "Terbatas", "Rahasia", "Sangat Rahasia"] },
      anri: { instrument: "Peraturan ANRI No. 5 Tahun 2021, Pasal 104 sampai 109", levels: ["Biasa", "Terbatas", "Rahasia", "Sangat Rahasia"] },
    },
    "K",
    "DT-28",
    "L1079-1086; research/04 T048",
    { classNote: "skema pertahanan tidak punya tingkat Terbatas" },
  ),
  make("P6-04", "classification.codeInDocNumber", "Kode kelas klasifikasi", "enum", "T", "K", "6.1", "L1088", {
    enum: ["SR", "R", "T", "B"],
    conflictRef: "K-14",
    classNote:
      "K (konflik K-14): SR, R, T, B disimpan sebagai medan terpisah, bukan unsur pertama nomor dokumen, sampai pola nomor dicek ke .docx; default T = Terbatas",
  }),
  make("P6-05", "classification.everyPage", "Klasifikasi pada setiap halaman", "bool", true, "K", "6.1", "L1092-1094", {
    classNote: "produk operasional: kepala halaman dan blok register",
  }),
  make("P6-06", "classification.doubleEnvelope", "Amplop ganda", "bool", true, "K", "6.1", "L1095-1097", {
    classNote: "berlaku untuk level Sangat Rahasia dan Rahasia",
  }),
  make("P6-07", "classification.numberedCopyControl", "Kendali salinan bernomor", "bool", true, "K", "6.1", "L1095-1097", {
    classNote: "berlaku untuk Sangat Rahasia dan Rahasia; dicatat di sel kanan pita segel",
  }),
  make("P6-08", "classification.minLevelForSiteData", "Level minimum untuk data tapak", "enum", "Rahasia", "K", "6.1", "L1098-1101", {
    enum: ["Rahasia", "Sangat Rahasia"],
    classNote: "tata letak, koordinat, perimeter instalasi militer: paling rendah Rahasia (UU 14/2008 Ps 17)",
  }),
  make("P6-09", "doc.urgency", "Tingkat urgensi dokumen", "enum", "biasa", "K", "6.1", "L1102-1103", {
    enum: ["kilat", "sangat segera", "segera", "biasa"],
    classNote: "K (sumbu terpisah dari klasifikasi)",
  }),
  make(
    "P6-10",
    "compliance.regulations.live",
    "Regulasi berlaku yang wajib dikutip",
    "list",
    [
      "Perpres 46/2025",
      "Perlem LKPP 12/2021 jo 4/2024",
      "ANRI 5/2021",
      "Perkap 1/2023",
      "Permenhan 30/2019",
      "Permen PUPR 8/2023",
      "PMK 131/2024",
      "UU 10/2020",
    ],
    "K",
    "DT-29",
    "L1109-1125; research/04 T049",
    { classNote: "disunting admin" },
  ),
  make(
    "P6-11",
    "compliance.regulations.dead",
    "Regulasi mati (daftar blokir)",
    "list",
    [
      "Perpres 16/2018 jo 12/2021",
      "Permenpan RB 22/2008",
      "Permenpan RB 80/2012",
      "Perkap 7/2017",
      "Permenhan 60/2014",
      "Permenhan 25/2015",
      "Permen PUPR 28/2016",
      "Permen PUPR 1/2022",
      "PPN 10 % atau 12 % rata",
      "meterai Rp 6.000",
    ],
    "K",
    "DT-29",
    "L1109-1125; research/04 T049",
  ),
  make("P6-12", "compliance.regulations.reviewIntervalMonths", "Interval periksa ulang regulasi (bulan)", "int", 12, "K", "DT-29", "L1127; research/04 T049", {
    range: { min: 12, max: 12, step: 1 },
    classNote: "periksa ulang setiap tahun",
  }),
  make("P6-13", "normativeQuote.literalWithArticle", "Kutipan normatif harfiah dengan nomor pasal", "bool", true, "K", "SG-L3-01", "L1132-1134", {
    classNote: "verba pelapor dan nomor pasal",
  }),
  make("P6-14", "letter.secretariatException.enabled", "Pengecualian surat sekretariat", "bool", false, "K", "DT-32", "L1147-1151", {
    classNote: "true untuk surat ke sekretariat Polri atau ANRI",
  }),
  make("P6-15", "letter.font", "Fon surat sekretariat", "string", "Arial", "K", "DT-32", "L1149"),
  make("P6-16", "letter.sizePt", "Ukuran fon surat sekretariat (pt)", "pt", 12, "K", "DT-32", "L1149"),
  make("P6-17", "letter.marginLeftCm", "Margin kiri surat sekretariat (cm)", "cm", 3, "K", "DT-32", "L1149-1150", {
    classNote: "margin penerima",
  }),
  make("P6-18", "letter.marginRightCm", "Margin kanan surat sekretariat (cm)", "cm", 2, "K", "DT-32", "L1150", {
    classNote: "margin penerima",
  }),
  make(
    "P6-19",
    "ahs.rows",
    "Baris lembar AHS",
    "list",
    [
      { row: "A", label: "tenaga kerja" },
      { row: "B", label: "bahan" },
      { row: "C", label: "peralatan" },
      { row: "D", label: "jumlah", formula: "A + B + C" },
      { row: "E", label: "biaya umum dan keuntungan" },
      { row: "F", label: "harga satuan", formula: "D + E" },
    ],
    "K",
    "DT-33",
    "L1155-1158; research/04 T050",
    { classNote: "Permen PUPR No. 8 Tahun 2023" },
  ),
  make("P6-20", "ahs.laborCodes", "Kode tenaga kerja AHS", "object", { codes: ["L.01", "L.02", "L.03", "L.04"], unit: "OH" }, "K", "DT-33", "L1156; research/04 T050", {
    classNote: "L.01 sampai L.04, satuan OH",
  }),
  make("P6-21", "ahs.overheadProfitPercent", "Biaya umum dan keuntungan AHS (%)", "percent", 10, "K", "DT-33", "L1157-1158; research/04 T050", {
    range: { min: 10, max: 15, step: 1 },
    classNote:
      "K (pita), B (nilai): pita 10-15 % dari D; nilai wajib disebut; default 10 = batas bawah pita, dipilih pelaksana karena manual tidak menyebut nilai tunggal",
  }),
  make("P6-22", "ahs.coefficientDecimals", "Desimal koefisien AHS", "int", 3, "K", "DT-33", "L1159", {
    range: { min: 3, max: 3, step: 1 },
    classNote: "3 desimal bukan nol",
  }),
  make("P6-23", "vat.inUnitPrice", "PPN termasuk dalam harga satuan", "bool", false, "K", "DT-31", "L1159-1160; research/04 T050", {
    classNote: "dihitung sekali di rekapitulasi",
  }),
  make("P6-24", "vat.nominalRatePercent", "Tarif nominal PPN (%)", "percent", 12, "K", "DT-31, lint 19", "L1165-1166; research/04 T049", {
    classNote: "ditetapkan regulasi",
  }),
  make("P6-25", "vat.dppFactor", "Faktor DPP nilai lain PPN", "ratio", "11/12", "K", "DT-31", "L1165, L1170; research/04 T050", {
    classNote: "pecahan 11/12 (PMK 131/2024); disimpan sebagai pecahan agar tarif efektif tepat 11",
  }),
  make("P6-26", "vat.effectiveRatePercent", "Tarif efektif PPN (%)", "percent", 11, "T", "DT-31, lint 19", "L1168-1170, L3976; research/04 T049", {
    derive: "vatEffective",
    classNote: "= tarif nominal x faktor DPP",
  }),
  make("P6-27", "stampDuty.amountRp", "Bea meterai (Rp)", "rp", 10000, "K", "DT-29", "L1125; research/04 T049", {
    classNote: "ditetapkan regulasi (UU 10/2020)",
  }),
  make("P6-28", "terbilang.generatedByCode", "Terbilang dihasilkan kode", "bool", true, "K", "DT-31, SG-L4-05", "L1173-1176", {
    classNote: "tidak diketik",
  }),
  make("P6-29", "hps.roundDown", "HPS dibulatkan ke bawah", "bool", true, "K", "DT-31", "L1174"),
  make("P6-30", "boq.columns", "Kolom BoQ", "list", ["No", "uraian", "volume", "satuan", "harga satuan", "jumlah"], "B", "6.4", "L1177-1178", {
    classNote: "konvensi, bukan regulasi",
  }),
  make("P6-31", "numerals.thousandsSeparator", "Pemisah ribuan", "char", ".", "K", "DT-30", "L257-258, TK112; research/04 T051"),
  make("P6-32", "numerals.decimalSeparator", "Pemisah desimal", "char", ",", "K", "DT-30", "L257-258, TK113; research/04 T051"),
  make("P6-33", "units.spaceBetweenValueAndUnit", "Spasi antara nilai dan satuan", "bool", true, "K", "DT-30, lint 16", "L1186, L3970, TK114; research/04 T051"),
  make("P6-34", "units.planeAngleNoSpace", "Sudut bidang tanpa spasi", "bool", true, "K", "Tabel 6.3", "L1188; research/04 T051", {
    classNote: "contoh 30° 22′ 8″",
  }),
  make("P6-35", "units.toleranceParentheses", "Toleransi dalam kurung", "bool", true, "K", "Tabel 6.3", "L1195; research/04 T051", {
    classNote: "contoh (63,2 ± 0,1) m",
  }),
  make("P6-36", "units.plusMinusMeaning.required", "Arti ± wajib dinyatakan", "bool", true, "K", "DT-30, lint 17", "L1198, L3972; research/04 T051", {
    classNote: "toleransi rancangan, 1 σ, k = 2",
  }),
  make("P6-37", "uncertainty.maxSignificantDigits", "Angka penting maksimum ketidakpastian", "int", 2, "K", "Tabel 6.3", "L1200; research/04 T051", {
    range: { min: 1, max: 2, step: 1 },
    classNote: "ketidakpastian menentukan presisi",
  }),
  make("P6-38", "units.dimensionsRepeatUnit", "Dimensi mengulang satuan", "bool", true, "K", "Tabel 6.3", "L1204; research/04 T051", {
    classNote: "contoh 51 mm × 51 mm × 25 mm",
  }),
  make("P6-39", "currency.prefixBeforeValue", "Awalan mata uang mendahului nilai", "list", ["Rp", "USD", "EUR", "SGD"], "K", "DT-30", "TK114"),
  make("P6-40", "conventions.oneVariantPerFile", "Satu varian konvensi per berkas", "bool", true, "K", "SG-L4-06, C-33", "L1208-1209", {
    classNote: "tanggal, ribuan, Rp, persen",
  }),
  make("P6-41", "time.zoneRequired", "Zona waktu wajib", "bool", true, "K", "SG-L4-05", "L1209-1210", {
    classNote: "contoh 14.00 WIB, UTC+7",
  }),
  make("P6-42", "color.distinctionRedundancy.required", "Pembedaan warna diulang lewat bentuk", "bool", true, "K", "DT-34", "L1218, L1413-1415; research/04 T052", {
    classNote: "bentuk, label, pola garis, atau posisi",
  }),
  make(
    "P6-43",
    "photocopy.acceptanceTest",
    "Uji terima fotokopi",
    "object",
    { printScalePercent: 100, photocopyPasses: 2, photocopySettings: "bawaan", readingDistanceCm: 40, failIfAnythingLost: true },
    "K",
    "DT-11, 16.4",
    "L1219-1220, L4083; research/04 T052",
    {
      conflictRef: "K-29",
      tiers: ["TERBIT", "SERAH"],
      classNote: "K (penilaian manusia): cetak 100 %, fotokopi dua kali setelan bawaan, baca dari 40 cm; K-29: wajib SERAH, anjuran TERBIT",
    },
  ),
];

export const PARAMS_APPARATUS: readonly ParamDef[] = [...P5, ...P6];

/** Hitungan target katalog; isi larik wajib sama dengan angka ini. */
export const PARAMS_APPARATUS_COUNT = 111;
