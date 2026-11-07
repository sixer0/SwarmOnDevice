/**
 * Registri section 52 (01_specs.md §5.2), ditulis LENGKAP oleh S03.
 * Unsur, parameter, aturan, sumber disalin dari research/01 §4.1-4.3
 * (01_manual_parameter_catalog.md:839-890); tier aktif dari research/01 §5
 * (:896-916). DOCUMENT 30 + PAGE_DEVICE 7 + CHANNEL 15 = 52.
 * Delta DC-06 (register 05 §6.1, AM-10): `contractRecord` S30 (DOCUMENT).
 * CHANNEL renderable=false (D-05: XLSX/PPTX di luar v2.1; `letter` belum punya renderer).
 * Seed S70 menyalin isi ini ke tabel StudioSectionType.
 */
import type { StudioTier } from "../contract/enums";
import type { SectionTypeDef } from "../contract/types/params";

export type { SectionTypeDef };

/** Versi registri yang ditulis ke kolom `StudioSectionType.registryVersion`. */
export const SECTION_REGISTRY_VERSION = "2026-10-22.1";

const ALL = ["NOTA", "TERBIT", "SERAH"] as const;
const WRAP = ["TERBIT", "SERAH"] as const;
const NONE = [] as const;

const SRC = "research/01_manual_parameter_catalog.md";

export const SECTION_REGISTRY: readonly SectionTypeDef[] = [
  // ── Section dokumen (30) ── research/01 §4.1 + register 05 §6.1
  {
    key: "cover",
    catalogId: "S01",
    group: "DOCUMENT",
    register: "WRAPPER",
    name: "Sampul",
    elements: [
      "pita segel",
      "logo (sekali)",
      "baris alamat",
      "Datum Rule 166 mm",
      "kicker",
      "judul",
      "standfirst",
      "baris cakupan",
      "blok kendali",
      "kolofon",
      "string punggung",
    ],
    paramRefs: ["P4V-01..16", "P4S-15..27"],
    ruleRefs: ["DT-13", "DT-14"],
    activeTiers: WRAP,
    renderable: true,
    sourceRef: `${SRC} §4.1 S01; L792-796, L1-23`,
  },
  {
    key: "controlSheet",
    catalogId: "S02",
    group: "DOCUMENT",
    register: "WRAPPER",
    name: "Lembar Kendali",
    elements: [
      "riwayat revisi",
      "rantai verifikasi 3 lapis",
      "pernyataan metode",
      "distribusi terkendali",
      "3 tanda tangan",
    ],
    paramRefs: ["P4K-01..06"],
    ruleRefs: ["4.8"],
    activeTiers: WRAP,
    renderable: true,
    sourceRef: `${SRC} §4.1 S02; L26-73, L797-798`,
  },
  {
    key: "toc",
    catalogId: "S03",
    group: "DOCUMENT",
    register: "WRAPPER",
    name: "Daftar Isi",
    elements: ["bagian", "bab", "lampiran", "nomor halaman", "catatan paginasi"],
    paramRefs: ["toc.levels"],
    ruleRefs: ["1.3"],
    activeTiers: WRAP,
    renderable: true,
    sourceRef: `${SRC} §4.1 S03; L76-133`,
  },
  {
    key: "partDivider",
    catalogId: "S04",
    group: "DOCUMENT",
    register: "WRAPPER",
    name: "Pembatas Bagian",
    elements: ["label BAGIAN n", "judul", "standfirst", "daftar bab"],
    paramRefs: ["Datum Rule", "string punggung"],
    ruleRefs: ["Tabel 4.1"],
    activeTiers: WRAP,
    renderable: true,
    sourceRef: `${SRC} §4.1 S04; L136-146, L559-569, L586`,
  },
  {
    key: "signatureBlock",
    catalogId: "S05",
    group: "DOCUMENT",
    register: "WRAPPER",
    name: "Blok Tanda Tangan",
    elements: ["peran", "nama/unit", "tanggal"],
    paramRefs: ["P4K-05..06"],
    ruleRefs: ["Tabel 4.1", "SG-L5-02"],
    activeTiers: WRAP,
    renderable: true,
    sourceRef: `${SRC} §4.1 S05; L71-73, L586-588, L3404-3407`,
  },
  {
    key: "chapter",
    catalogId: "S06",
    group: "DOCUMENT",
    register: "INTERIOR",
    name: "Bab",
    elements: ["kicker BAB n (signal)", "Datum Rule", "judul label (bukan pertanyaan)", "rel status opsional"],
    paramRefs: ["P4T-S01", "P4T-S02", "P4A-04..05"],
    ruleRefs: ["DT-38", "SG-L1-02", "SG-L1-08"],
    activeTiers: ALL,
    renderable: true,
    sourceRef: `${SRC} §4.1 S06; L149-151, L819-823`,
  },
  {
    key: "section",
    catalogId: "S07",
    group: "DOCUMENT",
    register: "INTERIOR",
    name: "Seksi",
    elements: [
      "nomor mono ink400",
      "judul condensed 600",
      "badge provenans di rel opsional (TERUKUR + sumber)",
    ],
    paramRefs: ["P4T-S03", "P4T-X10..X11"],
    ruleRefs: ["Tabel 4.7 no. 6"],
    activeTiers: ALL,
    renderable: true,
    sourceRef: `${SRC} §4.1 S07; L153-154, L830`,
  },
  {
    key: "appendix",
    catalogId: "S08",
    group: "DOCUMENT",
    register: "INTERIOR",
    name: "Lampiran",
    elements: ["kicker LAMPIRAN huruf", "judul", "penomoran artefak berhuruf"],
    paramRefs: ["P4T-S01", "P4T-S02", "P4A-04..05"],
    ruleRefs: ["1.3"],
    activeTiers: ALL,
    renderable: true,
    sourceRef: `${SRC} §4.1 S08; L4547-4555, L4879-4881`,
  },
  {
    key: "paragraph",
    catalogId: "S09",
    group: "DOCUMENT",
    register: "INTERIOR",
    name: "Paragraf",
    elements: ["teks badan", "peran (role: identity, anchor, body, pivot, closingAction)", "chip rel"],
    paramRefs: ["P4T-S04", "P11-11", "P5-39..41"],
    ruleRefs: ["SG-L0-01..03", "SG-L1-10", "SG-L2-01..09"],
    activeTiers: ALL,
    renderable: true,
    sourceRef: `${SRC} §4.1 S09; L832, L2850-3135`,
  },
  {
    key: "list",
    catalogId: "S10",
    group: "DOCUMENT",
    register: "INTERIOR",
    name: "Daftar",
    elements: ["butir bertanda atau bernomor"],
    paramRefs: ["P11-12"],
    ruleRefs: ["SG-L2-04"],
    activeTiers: ALL,
    renderable: true,
    sourceRef: `${SRC} §4.1 S10; L253-271, L379-398`,
  },
  {
    key: "aside",
    catalogId: "S11",
    group: "DOCUMENT",
    register: "INTERIOR",
    name: "Kotak Samping",
    elements: [
      "label condensed kapital",
      "garis atas 0,35",
      "garis rambut bawah",
      "tanpa isian",
      "varian: generic, doctrine (DIKTUM), story (KEMASAN BUKAN KEPEDULIAN), quickCheck (TIGA CEK TERCEPAT), ifInDoubt (BILA RAGU)",
    ],
    paramRefs: ["P4R-12", "P5-28..29", "P4T-X08..X09"],
    ruleRefs: ["DT-20", "R-12"],
    activeTiers: ALL,
    renderable: true,
    sourceRef: `${SRC} §4.1 S11; L336-339, L437-442, L925-937, L2379-2382, L2912-2917`,
  },
  {
    key: "monoBlock",
    catalogId: "S12",
    group: "DOCUMENT",
    register: "INTERIOR",
    name: "Blok Mono",
    elements: ["label kapital", "listing mono (pola kode, rumus, perintah alat, kepala lembar skor juri)"],
    paramRefs: ["face mono"],
    ruleRefs: ["5.6", "14.4", "14.6", "15.1"],
    activeTiers: ALL,
    renderable: true,
    sourceRef: `${SRC} §4.1 S12; L970-982, L3745-3752, L3790-3795, L3873-3879`,
  },
  {
    key: "assumptionInline",
    catalogId: "S13",
    group: "DOCUMENT",
    register: "INTERIOR",
    name: "Asumsi Sebaris",
    elements: ["tanda ASUMSI", "ID ASM", "dampak bila salah di rel"],
    paramRefs: ["P5-42", "P5-63..64"],
    ruleRefs: ["DT-27", "1.5"],
    activeTiers: ALL,
    renderable: true,
    sourceRef: `${SRC} §4.1 S13; L276-283`,
  },
  {
    key: "table",
    catalogId: "S14",
    group: "DOCUMENT",
    register: "INTERIOR",
    name: "Tabel",
    elements: [
      "caption atas",
      "kepala",
      "baris",
      "pita kelompok opsional",
      "total opsional",
      "SUMBER + PROVENANS bawah",
    ],
    paramRefs: ["P5-01..25"],
    ruleRefs: ["DT-15..18"],
    activeTiers: ALL,
    renderable: true,
    sourceRef: `${SRC} §4.1 S14; L857-896`,
  },
  {
    key: "specTable",
    catalogId: "S15",
    group: "DOCUMENT",
    register: "INTERIOR",
    name: "Tabel Spesifikasi",
    elements: ["PARAMETER", "KONDISI UJI (menjorok)", "NILAI", "SATUAN"],
    paramRefs: ["P5-26..27"],
    ruleRefs: ["DT-19"],
    activeTiers: ALL,
    renderable: true,
    sourceRef: `${SRC} §4.1 S15; L898-923`,
  },
  {
    key: "registerTable",
    catalogId: "S16",
    group: "DOCUMENT",
    register: "INTERIOR",
    name: "Tabel Register",
    elements: [
      "preset: asumsi (ASM)",
      "rekonsiliasi (R-nn)",
      "temuan (E-nn/C-nn)",
      "regulasi hidup/mati",
      "edisi standar",
      "peningkatan (P-nn)",
      "riwayat revisi",
      "distribusi",
    ],
    paramRefs: ["P5-62..66", "P6-10..11"],
    ruleRefs: ["DT-27", "DT-29"],
    // Preset rekonsiliasi wajib di SERAH (D16) lewat SectionPlan.requiredPresets.
    activeTiers: ALL,
    renderable: true,
    sourceRef: `${SRC} §4.1 S16; L1050-1060, L1107-1127, L4232-4316, L4325-4430, L4462-4502`,
  },
  {
    key: "exampleWrongRight",
    catalogId: "S17",
    group: "DOCUMENT",
    register: "INTERIOR",
    name: "Contoh Salah-Benar",
    elements: [
      "ATURAN",
      "SALAH (salinan nyata)",
      "BENAR (salinan nyata)",
      "catatan elipsis dan ejaan sumber dipertahankan",
    ],
    paramRefs: ["kolom 3 atau 4"],
    ruleRefs: ["11.3"],
    activeTiers: ALL,
    renderable: true,
    sourceRef: `${SRC} §4.1 S17; L517-538, L1184-1206, L2888-2910, L3900-3910`,
  },
  {
    key: "ruleTable",
    catalogId: "S18",
    group: "DOCUMENT",
    register: "INTERIOR",
    name: "Tabel Aturan",
    elements: ["NOMOR", "JUDUL DAN PERNYATAAN (verbatim)", "CARA PAKAI", "PENEGAK"],
    paramRefs: ["verbatim terkunci"],
    ruleRefs: ["11.3"],
    activeTiers: ALL,
    renderable: true,
    sourceRef: `${SRC} §4.1 S18; L2850-2886, L3539-3661`,
  },
  {
    key: "derivation",
    catalogId: "S19",
    group: "DOCUMENT",
    register: "INTERIOR",
    name: "Turunan",
    elements: [
      "kepala TURUNAN D-n.m · judul",
      "baris aritmetika mono dengan tanda",
      "hasil + vonis toleransi",
      "kalimat penutup",
    ],
    paramRefs: ["P5-48..53", "P4R-13..14", "P4T-S13"],
    ruleRefs: ["DT-24"],
    // Wajib di SERAH per angka beban keputusan (research/01:907).
    activeTiers: ALL,
    renderable: true,
    sourceRef: `${SRC} §4.1 S19; L727-741, L991-999, L1162-1171`,
  },
  {
    key: "chart",
    catalogId: "S20",
    group: "DOCUMENT",
    register: "INTERIOR",
    name: "Chart",
    elements: [
      "caption kesimpulan",
      "plot",
      "label langsung",
      "baris KUNCI opsional",
      "SUMBER + tanggal + PROVENANS",
    ],
    paramRefs: ["P7-01..36", "registri 3.6.2"],
    ruleRefs: ["CH-01..14"],
    activeTiers: ALL,
    renderable: true,
    sourceRef: `${SRC} §4.1 S20; L1374-1405, L1591-1593`,
  },
  {
    key: "diagram",
    catalogId: "S21",
    group: "DOCUMENT",
    register: "INTERIOR",
    name: "Diagram",
    elements: ["spec JSON (Tabel 9.1)", "caption", "SUMBER", "KUNCI", "PROVENANS"],
    paramRefs: ["P9-01..55"],
    ruleRefs: ["DT-35..37", "DT-39", "DT-44"],
    activeTiers: ALL,
    renderable: true,
    sourceRef: `${SRC} §4.1 S21; L2094-2132, L362-365, L501-504`,
  },
  {
    key: "image",
    catalogId: "S22",
    group: "DOCUMENT",
    register: "INTERIOR",
    name: "Gambar Raster",
    elements: ["gambar raster (spesimen halaman, foto)", "dpi", "lebar", "caption", "SUMBER", "PROVENANS"],
    paramRefs: ["lebar {128, 166}", "dpi (200 pada Gambar 4.1, 300 untuk chart)"],
    ruleRefs: ["DT-15", "DT-36"],
    activeTiers: ALL,
    renderable: true,
    sourceRef: `${SRC} §4.1 S22; L806-809`,
  },
  {
    key: "symbolSheet",
    catalogId: "S23",
    group: "DOCUMENT",
    register: "INTERIOR",
    name: "Lembar Simbol",
    elements: ["lembar simbol per dialek", "paginasi blok 247 mm", "legenda"],
    paramRefs: ["P10-01..06"],
    ruleRefs: ["SM-03", "E-18"],
    activeTiers: ALL,
    renderable: true,
    sourceRef: `${SRC} §4.1 S23; L2403-2405, L2475-2477, SK81`,
  },
  {
    key: "checklist",
    catalogId: "S24",
    group: "DOCUMENT",
    register: "INTERIOR",
    name: "Daftar Periksa",
    elements: ["NO/CEK", "BUTIR", "ATURAN", "bendera tier", "kotak centang U+25A1"],
    paramRefs: ["PB-01"],
    ruleRefs: ["8.6", "Lampiran B"],
    activeTiers: ALL,
    renderable: true,
    sourceRef: `${SRC} §4.1 S24; L2060-2075, L4083-4098, L4887-4931, SK115-116`,
  },
  {
    key: "glossary",
    catalogId: "S25",
    group: "DOCUMENT",
    register: "INTERIOR",
    name: "Glosarium",
    elements: ["KELAS ISTILAH, PERLAKUAN, CONTOH", "atau ISTILAH, ARTI, RUMAH"],
    paramRefs: ["PC-01"],
    ruleRefs: ["SG-L4-10"],
    activeTiers: ALL,
    renderable: true,
    sourceRef: `${SRC} §4.1 S25; L4940-5001`,
  },
  {
    key: "sourceRegister",
    catalogId: "S26",
    group: "DOCUMENT",
    register: "INTERIOR",
    name: "Register Sumber",
    elements: ["dokumen sumber", "sumber eksternal"],
    paramRefs: ["PD-01"],
    ruleRefs: ["1.4", "Lampiran D"],
    activeTiers: ALL,
    renderable: true,
    sourceRef: `${SRC} §4.1 S26; L5008-5055`,
  },
  {
    key: "ruleIndex",
    catalogId: "S27",
    group: "DOCUMENT",
    register: "INTERIOR",
    name: "Indeks Aturan",
    elements: ["NOMOR", "ATURAN", "RUMAH per awalan"],
    paramRefs: ["PA-01"],
    ruleRefs: ["Lampiran A"],
    activeTiers: ALL,
    renderable: true,
    sourceRef: `${SRC} §4.1 S27; L4545-4874`,
  },
  {
    key: "referenceScale",
    catalogId: "S28",
    group: "DOCUMENT",
    register: "INTERIOR",
    name: "Skala Rujukan",
    elements: ["skala tetap Admiralty (A-F, 1-6)", "pita ICD 203", "dicetak sekali di lampiran"],
    paramRefs: ["P5-54..60"],
    ruleRefs: ["DT-25", "DT-26"],
    activeTiers: ALL,
    renderable: true,
    sourceRef: `${SRC} §4.1 S28; L1010-1036`,
  },
  {
    key: "financialTable",
    catalogId: "S29",
    group: "DOCUMENT",
    register: "INTERIOR",
    name: "Tabel Keuangan",
    elements: ["preset BoQ (6 kolom)", "AHS (baris A-F)", "rekapitulasi (PPN sekali, total, terbilang)"],
    paramRefs: ["P6-19..30"],
    ruleRefs: ["DT-31", "DT-33"],
    activeTiers: ALL,
    renderable: true,
    sourceRef: `${SRC} §4.1 S29; L1153-1178`,
  },
  // Delta DC-06 (register 05 §6.1): slot catatan kontrak; isi dipetakan compose (DC-10).
  // DEVIASI register (needs-review DC-06): `activeTiers` kosong, bukan semua tier. Rencana
  // kanonik (`canonicalSectionPlan`, templates/profile.ts) menurunkan opsional/terlarang dari
  // `activeTiers`; dengan semua tier, setiap templat baru non-kontrak mendapat slot implisit
  // `record` (melanggar CH-06) dan R04/R08/R09 jatuh BY_CONSTRUCTION_FAILED. Slot ini hanya
  // hadir lewat kerangka eksplisit templat ber-contractKind (SL-08, tiers = semua).
  {
    key: "contractRecord",
    catalogId: "S30",
    group: "DOCUMENT",
    register: "INTERIOR",
    name: "Catatan Kontrak",
    elements: ["status", "penanggung jawab", "rujukan tugas", "waktu lapor", "kartu", "butir", "bukti", "rujukan dokumen"],
    paramRefs: [],
    ruleRefs: ["D-139", "D-344"],
    activeTiers: NONE,
    renderable: true,
    sourceRef: "register 05 §6.1",
  },

  // ── Perangkat halaman (7) ── research/01 §4.2
  {
    key: "runningHead",
    catalogId: "F1",
    group: "PAGE_DEVICE",
    register: "NONE",
    name: "Kepala Berjalan",
    elements: ["kepala berjalan"],
    paramRefs: ["P4A-01..03", "P4T-S11"],
    ruleRefs: [],
    activeTiers: WRAP,
    renderable: true,
    sourceRef: `${SRC} §4.2 F1; L147, L815-817`,
  },
  {
    key: "registerBlock",
    catalogId: "F2",
    group: "PAGE_DEVICE",
    register: "NONE",
    name: "Blok Register",
    elements: ["blok register kaki halaman", "LEMBAR n DARI N"],
    paramRefs: ["P4S-10..14", "P4T-S12"],
    ruleRefs: [],
    activeTiers: WRAP,
    renderable: true,
    sourceRef: `${SRC} §4.2 F2; L769-772, L786-788`,
  },
  {
    key: "sealBand",
    catalogId: "F3",
    group: "PAGE_DEVICE",
    register: "NONE",
    name: "Pita Segel",
    elements: ["pita segel"],
    paramRefs: ["P4S-15..19"],
    ruleRefs: [],
    activeTiers: WRAP,
    renderable: true,
    sourceRef: `${SRC} §4.2 F3; L774`,
  },
  {
    key: "spineString",
    catalogId: "F4",
    group: "PAGE_DEVICE",
    register: "NONE",
    name: "String Punggung",
    elements: ["string punggung"],
    paramRefs: ["P4S-20..25"],
    ruleRefs: [],
    activeTiers: WRAP,
    renderable: true,
    sourceRef: `${SRC} §4.2 F4; L777-778`,
  },
  {
    key: "evidenceRail",
    catalogId: "F5",
    group: "PAGE_DEVICE",
    register: "NONE",
    name: "Rel Bukti",
    elements: ["rel bukti"],
    paramRefs: ["P4S-07..09", "P4G-05", "P4G-16", "P4T-S10"],
    ruleRefs: [],
    // TERBIT opsional, SERAH wajib (research/01:908; konflik moda rel K-11).
    activeTiers: WRAP,
    renderable: true,
    sourceRef: `${SRC} §4.2 F5; L768, L784-785, SK36-49`,
  },
  {
    key: "datumRule",
    catalogId: "F6",
    group: "PAGE_DEVICE",
    register: "NONE",
    name: "Datum Rule",
    elements: ["Datum Rule"],
    paramRefs: ["P4S-01..06"],
    ruleRefs: [],
    activeTiers: WRAP,
    renderable: true,
    sourceRef: `${SRC} §4.2 F6; L765-766, L821`,
  },
  {
    key: "issueStampColophon",
    catalogId: "F7",
    group: "PAGE_DEVICE",
    register: "NONE",
    name: "Cap Terbit dan Kolofon",
    elements: ["cap terbit", "kolofon"],
    paramRefs: ["P4S-26..27", "P4V-13"],
    ruleRefs: [],
    activeTiers: WRAP,
    renderable: true,
    sourceRef: `${SRC} §4.2 F7; L22, L780`,
  },

  // ── Kanal lain (15) ── research/01 §4.3; tidak dirender di v2.1 (D-05)
  {
    key: "letter",
    catalogId: "C01",
    group: "CHANNEL",
    register: "NONE",
    name: "Surat Pengantar dan Surat Dinas",
    elements: ["sapaan", "inti satu kalimat", "satu usul ya/tidak", "penutup", "pengecualian Arial 12"],
    paramRefs: [],
    ruleRefs: ["SG-L1-07", "SG-L5-08", "DT-32"],
    activeTiers: NONE,
    renderable: false,
    sourceRef: `${SRC} §4.3 C01; L1147-1151, L2970-2974, L3467-3486`,
  },
  ...(
    [
      ["slide.claimNumberBlock", "C02", "Slide Klaim Angka"],
      ["slide.chartOneAccent", "C03", "Slide Chart Satu Aksen"],
      ["slide.specTable3Col", "C04", "Slide Tabel Spesifikasi 3 Kolom"],
      ["slide.assumption", "C05", "Slide Asumsi"],
      ["slide.request", "C06", "Slide Permintaan"],
    ] as const
  ).map(
    ([key, catalogId, name]): SectionTypeDef => ({
      key,
      catalogId,
      group: "CHANNEL",
      register: "NONE",
      name,
      elements: ["headline klaim", "baris sumber", "catatan pembicara"],
      paramRefs: [],
      ruleRefs: [],
      activeTiers: NONE,
      renderable: false,
      sourceRef: `${SRC} §4.3 C02-C06; L3914-3918`,
    }),
  ),
  ...(
    [
      ["sheet.cover", "C07", "Lembar Kerja Sampul"],
      ["sheet.petunjuk", "C08", "Lembar Kerja Petunjuk"],
      ["sheet.kendali", "C09", "Lembar Kerja Kendali"],
      ["sheet.ringkasanEksekutif", "C10", "Lembar Kerja Ringkasan Eksekutif"],
      ["sheet.rekapitulasi", "C11", "Lembar Kerja Rekapitulasi"],
      ["sheet.rab", "C12", "Lembar Kerja RAB"],
      ["sheet.ahs", "C13", "Lembar Kerja AHS"],
      ["sheet.hitung", "C14", "Lembar Kerja Hitung"],
    ] as const
  ).map(
    ([key, catalogId, name]): SectionTypeDef => ({
      key,
      catalogId,
      group: "CHANNEL",
      register: "NONE",
      name,
      elements: ["struktur lembar kerja menurut P15-01"],
      paramRefs: ["P15-01"],
      ruleRefs: [],
      activeTiers: NONE,
      renderable: false,
      sourceRef: `${SRC} §4.3 C07-C14; L3830-3847`,
    }),
  ),
  {
    key: "drawingSheet",
    catalogId: "C15",
    group: "CHANNEL",
    register: "NONE",
    name: "Lembar Gambar Teknik",
    elements: [
      "blok judul",
      "legenda",
      "satu dialek",
      "label garis",
      "penandaan",
      "sumber",
      "revisi",
      "usulan blok ISO 7200 A3 (P-05)",
    ],
    paramRefs: [],
    ruleRefs: [],
    activeTiers: NONE,
    renderable: false,
    sourceRef: `${SRC} §4.3 C15; L2635-2657, L4476`,
  },
];

export const SECTION_REGISTRY_COUNT = 52;

/** Hitungan per grup: DOCUMENT 30, PAGE_DEVICE 7, CHANNEL 15 (AM-10). */
export const SECTION_REGISTRY_GROUP_COUNTS = { DOCUMENT: 30, PAGE_DEVICE: 7, CHANNEL: 15 } as const;

export function getSectionType(key: string): SectionTypeDef | undefined {
  return SECTION_REGISTRY.find((s) => s.key === key);
}

// ── Delta S03-d2 (aditif; IP-23, D-76) ──────────────────────────────────
// Modul ini hanya mengimpor tipe, sehingga aman diimpor komponen klien
// (S59 section-composer tidak perlu lagi menyalin daftar wajib).

/**
 * Section wajib per tier profil DATUM-kanonik (research/01 §5, L417-460;
 * identik seed S70): semua tier `chapter`; TERBIT/SERAH + sampul, lembar
 * kendali, daftar isi, perangkat halaman aktif; SERAH + turunan (S19), rel
 * bukti (F5), tabel register berpreset rekonsiliasi (D16). Sumber tunggal;
 * `services/templates/profile.ts` mengekspor ulang.
 */
export const CANONICAL_REQUIRED_BY_TIER: Readonly<Record<StudioTier, readonly string[]>> = {
  NOTA: ["chapter"],
  TERBIT: ["cover", "controlSheet", "toc", "chapter", "runningHead", "registerBlock", "sealBand", "spineString", "datumRule", "issueStampColophon"],
  SERAH: [
    "cover",
    "controlSheet",
    "toc",
    "chapter",
    "registerTable",
    "derivation",
    "runningHead",
    "registerBlock",
    "sealBand",
    "spineString",
    "evidenceRail",
    "datumRule",
    "issueStampColophon",
  ],
};

/**
 * Urutan tampil section satu tier `SectionPlan` (medan opsional `order`):
 * kunci `order` yang ada di daftar tier lebih dulu, lalu kunci daftar lain
 * dalam urutan registri. Murni; tidak memvalidasi (lihat `validateSectionPlan`).
 */
export function orderedPlanSections(entry: {
  required: readonly string[];
  optional: readonly string[];
  forbidden: readonly string[];
  order?: readonly string[];
}): string[] {
  const listed = new Set([...entry.required, ...entry.optional, ...entry.forbidden]);
  const out: string[] = [];
  const done = new Set<string>();
  for (const key of entry.order ?? []) {
    if (listed.has(key) && !done.has(key)) {
      out.push(key);
      done.add(key);
    }
  }
  for (const s of SECTION_REGISTRY) {
    if (listed.has(s.key) && !done.has(s.key)) {
      out.push(s.key);
      done.add(s.key);
    }
  }
  return out;
}
