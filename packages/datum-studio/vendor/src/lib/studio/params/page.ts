/**
 * Parameter halaman Bab 4 (01_specs.md §5.1 T03, S06): grid P4G 17, garis P4R 15,
 * enam perangkat tanda tangan P4S 27, sampul P4V 16, lembar kendali P4K 6,
 * anatomi halaman interior P4A 10 = 91 ParamDef, `origin: "catalog"`.
 * Sumber: research/01_manual_parameter_catalog.md §3.3.5-3.3.10; nilai [REK] diganti
 * research/04_manual_docx_tables.md (D-09).
 *
 * Putusan konflik/celah yang berlaku di berkas ini:
 * - K-06: `rules.hairMm` menyimpan nilai logis 0,20 mm; kuantisasi per format memakai tangga
 *   `rules.wordLadderSz` (P4R-11, docx sz5 = 0,22 mm) dan parameter renderer, bukan nilai ini.
 * - K-11 / KT-07: `layout.railMode` = auto | A | B, default auto (`derive: "railMode"`).
 * - G-02: judul sampul 24 pt (rentang manual 24-26 pt).
 * - G-03: margin atas/bawah dari Garis A datum_docx.py:453 (interior 26/26 mm; sampul
 *   26 atas, 24 bawah, :407).
 * - SR-05 (SR-01 PC-01..PC-03, research/09 §5.3, D-158/D-162): ukuran halaman, kolom teks,
 *   dan tinggi blok teks menjadi kelas T (turunan `page.size` + `page.orientation`); margin
 *   dalam/luar/atas = turunan beracuan `marginsFromDensity` (kelas B, acuan disematkan preset).
 *   P4G-12 berarti margin ATAS (D-33); margin bawah = `grid.marginBottomMm` (params/structure.ts).
 */
import type { DeriveFnId, ParamDef, ParamGroup } from "../contract/types/params";

type Extra = Partial<
  Pick<
    ParamDef,
    "range" | "enum" | "pattern" | "classNote" | "derive" | "rek" | "conflictRef" | "gapRef"
  >
> & { derive?: DeriveFnId };

/** Satu baris katalog Bab 4 menjadi ParamDef (grup, bab, namespace diturunkan dari ID dan kunci). */
function d(
  id: string,
  key: string,
  label: string,
  type: ParamDef["type"],
  def: ParamDef["default"],
  ruleRef: string,
  source: string,
  cls: ParamDef["class"],
  extra: Extra = {},
): ParamDef {
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
    group: id.slice(0, 3) as ParamGroup,
    chapter: "Bab 4",
    namespace: key.split(".")[0],
    ...extra,
  };
}

/** Lantai garis fotokopi P4R-09 (0,18 mm) sebagai batas bawah setiap tebal garis. */
const LINE_RANGE = { min: 0.18, step: 0.01 } as const;

// ── 3.3.5 Grid halaman (17) ──────────────────────────────────────────────

const GRID: ParamDef[] = [
  d("P4G-01", "page.sizeMm", "Ukuran halaman (mm)", "pair", [210, 297], "DT-10", "L721, L740-741, TK80", "T", {
    derive: "pageSizeFromPaper",
    classNote: "T (SR-01 PC-01): = page.customSizeMm ?? PAPER_SIZE_MM[page.size], ditukar bila page.orientation landscape",
  }),
  d("P4G-02", "grid.innerMarginMm", "Margin dalam (mm)", "mm", 24, "DT-10", "L721, TK81", "B", {
    range: { min: 0, step: 0.5 },
    derive: "marginsFromDensity",
    classNote: "turunan beracuan (SR-01 PC-03): acuan x faktor grid.marginDensity; acuan hanya disematkan preset",
  }),
  d("P4G-03", "grid.textColumnMm", "Kolom teks (mm)", "mm", 128, "DT-10", "L721, TK82", "T", {
    derive: "textColumnFromPage",
    classNote: "T (SR-01 PC-02): moda A = lebar - dalam - talang - rel - luar; moda B = lebar - dalam - luar",
  }),
  d("P4G-04", "grid.gutterMm", "Talang (mm)", "mm", 6, "DT-10", "L722, TK83", "B", { range: { min: 0, step: 0.5 } }),
  d("P4G-05", "grid.evidenceRailMm", "Lebar kolom catatan bukti (mm)", "mm", 32, "DT-10", "L722, TK84, SK38-44", "B", {
    range: { min: 0, step: 0.5 },
    classNote: "angka atau 0 (moda B)",
  }),
  d("P4G-06", "grid.outerMarginMm", "Margin luar (mm)", "mm", 20, "DT-10", "L722, TK85", "B", {
    range: { min: 0, step: 0.5 },
    derive: "marginsFromDensity",
    classNote: "turunan beracuan (SR-01 PC-03): acuan x faktor grid.marginDensity; acuan hanya disematkan preset",
  }),
  d("P4G-07", "grid.fullSpanMm", "Bentang penuh (mm)", "mm", 166, "D-4.1", "L734-735, TK86", "T", {
    derive: "fullSpan",
    classNote: "= textColumn + gutter + rail",
  }),
  d("P4G-08", "grid.subcolumns", "Jumlah subkolom", "int", 12, "D-4.1", "L736, TK89", "B", {
    range: { min: 1, step: 1 },
  }),
  d("P4G-09", "grid.latticeXMm", "Satuan kisi X (mm)", "mm", 10.6667, "D-4.1", "L736, TK87, DD100", "T", {
    derive: "latticeX",
    classNote: "= textColumn / subcolumns",
  }),
  d("P4G-10", "grid.latticeYMm", "Satuan kisi Y (mm)", "mm", 4.7625, "D-4.1", "L737, TK88, DD102", "T", {
    derive: "latticeY",
    classNote: "= baselinePt x 25,4 / 72",
  }),
  d("P4G-11", "grid.textBlockHeightMm", "Tinggi blok teks (mm)", "mm", 247, "lint 33", "L4009, DD113", "T", {
    derive: "textBlockFromPage",
    classNote: "T (research/09 U2, D-162): = tinggi halaman - margin atas - margin bawah; gambar lebih tinggi ditolak",
  }),
  d("P4G-12", "grid.topBottomMarginMm", "Margin atas (mm)", "mm", 26, "-", "L4009 (tersirat); datum_docx.py:453", "B", {
    range: { min: 0, step: 0.5 },
    gapRef: "G-03",
    derive: "marginsFromDensity",
    classNote:
      "B, turunan beracuan (SR-01 PC-03). Dipakai sebagai margin ATAS (D-33, research/09 U5); margin bawah = grid.marginBottomMm. " +
      "Celah G-03: Garis A interior 26 atas / 26 bawah (datum_docx.py:453); sampul 26 atas / 24 bawah (datum_docx.py:407); Manual 000 terukur 26,00 / 24,01 (research/07:641-642)",
  }),
  d("P4G-13", "grid.allowedFigureWidthsMm", "Lebar gambar sah (mm)", "list", [128, 166], "DT-36", "L739-740, L2122, DD104", "T", {
    derive: "allowedFigureWidths",
    classNote: "T (keanggotaan: K); = [textColumn, fullSpan]",
  }),
  d(
    "P4G-14",
    "grid.verticalRhythm.multipleOfBaseline",
    "Irama vertikal kelipatan garis dasar",
    "bool",
    true,
    "DT-10",
    "L722-724, L739",
    "K",
    { classNote: "judul, baris tabel, tinggi gambar, blok caption" },
  ),
  d("P4G-15", "grid.pageWidthCheck", "Cek lebar halaman (mm)", "mm", 210, "D-4.1", "L733-734", "T", {
    derive: "pageWidthCheck",
    classNote: "210 = 24 + 128 + 6 + 32 + 20; harus sama dengan lebar halaman",
  }),
  d("P4G-16", "layout.railMode", "Kolom catatan bukti", "enum", "auto", "RAIL-BUKTI-DUA-MODA", "SK36-49", "B", {
    enum: ["auto", "A", "B"],
    derive: "railMode",
    conflictRef: "K-11",
    classNote:
      "T pada katalog; KT-07 menjadikannya pilihan. auto: A (rel 32 mm) bila ada sitasi per paragraf, B (margin 20 mm, teks 166 mm) bila nol; A/B eksplisit = override",
  }),
  d("P4G-17", "grid.rederiveForNonA4", "Turunkan ulang grid bila bukan A4", "bool", true, "D-4.1", "L740-741", "T", {
    derive: "rederiveNonA4",
    classNote: "bila halaman bukan A4, semua turunan dihitung ulang; lapis internal, perilakunya tercakup textColumnFromPage (SR-01 PC-04)",
  }),
];

// ── 3.3.6 Tebal garis (15) ───────────────────────────────────────────────

const RULES: ParamDef[] = [
  d("P4R-01", "rules.primaryMm", "Garis utama (mm)", "mm", 0.45, "DT-16", "L745, L863, TK93", "B", {
    range: LINE_RANGE,
    classNote: "B (>= 0,18: K); di atas kepala tabel, di atas total, datum bab",
  }),
  d("P4R-02", "rules.primary.colour", "Warna garis utama", "tokenRef", "ink900", "-", "L744-745, L863", "B"),
  d("P4R-03", "rules.belowHeaderMm", "Garis di bawah kepala tabel (mm)", "mm", 0.25, "DT-16", "L746, L865, TK94", "B", {
    range: LINE_RANGE,
  }),
  d("P4R-04", "rules.belowHeader.colour", "Warna garis di bawah kepala tabel", "tokenRef", "ink400", "-", "L746, L865", "B"),
  d("P4R-05", "rules.hairMm", "Garis rambut (mm)", "mm", 0.2, "DT-16", "L747, L757, TK95, TK100", "B", {
    range: LINE_RANGE,
    conflictRef: "K-06",
    classNote:
      "B (konflik K-06): nilai logis 0,20; manual memasang 0,22 di docx (E-05); kuantisasi per format lewat rules.wordLadderSz dan parameter renderer. Pemisah baris, garis kepala halaman, garis sumber",
  }),
  d("P4R-06", "rules.hair.colour", "Warna garis rambut", "tokenRef", "ink200", "-", "L747, L867", "B"),
  d("P4R-07", "rules.revisionBarMm", "Batang revisi (mm)", "mm", 0.5, "-", "L748, TK96", "B", {
    range: LINE_RANGE,
    classNote: "batang revisi di rel bukti",
  }),
  d("P4R-08", "rules.revisionBar.colour", "Warna batang revisi", "tokenRef", "ink900", "-", "L748; research/04 T035 (D-09, V-03)", "B", {
    rek: true,
  }),
  d("P4R-09", "rules.photocopyFloorMm", "Lantai fotokopi (mm)", "mm", 0.18, "DT-11, lint 21/27", "L755, L1215, TK97", "K", {
    classNote: "0,18 mm = 0,51 pt; lantai garis apa pun",
  }),
  d("P4R-10", "rules.tintsPercent", "Rona sah (persen)", "list", [15, 30], "DT-11, lint 21", "L757, L1216, TK99", "K", {
    classNote: "hanya dua rona",
  }),
  d("P4R-11", "rules.wordLadderSz", "Tangga tebal garis Word (sz, per 1/8 pt)", "list", [5, 6, 8, 10, 11], "-", "TK98, TK100", "T", {
    derive: "wordLadder",
    classNote: "T (renderer docx): kuantisasi Word; sz5 = 0,22 mm",
  }),
  d("P4R-12", "rules.asideTopMm", "Garis atas aside (mm)", "mm", 0.35, "DT-20", "L929, TK100 (sz8)", "B", {
    range: LINE_RANGE,
  }),
  d("P4R-13", "rules.derivationLeftMm", "Garis kiri blok turunan (mm)", "mm", 0.45, "DT-24", "L994", "B", {
    range: LINE_RANGE,
  }),
  d("P4R-14", "rules.derivationLeft.colour", "Warna garis kiri blok turunan", "tokenRef", "signal", "-", "L844, L994", "B", {
    classNote: "signal = amber",
  }),
  d("P4R-15", "rules.diagramFillHatchDeg", "Sudut arsir isian diagram (derajat)", "list", [45, 135], "DT-11", "L1217-1218, DD1216-1220", "K", {
    classNote: "tidak pernah rona abu-abu",
  }),
];

// ── 3.3.7 Enam perangkat tanda tangan (27) ───────────────────────────────

const SIGNATURE: ParamDef[] = [
  d("P4S-01", "device.datumRule.enabled", "Garis penanda di atas judul", "bool", true, "DT-13", "L765", "B"),
  d("P4S-02", "device.datumRule.weightMm", "Tebal garis penanda (mm)", "mm", 0.2, "DT-13", "L765", "T", {
    derive: "ruleWeightFromHair",
    classNote: "= rules.hairMm",
  }),
  d("P4S-03", "device.datumRule.ticks", "Jumlah tik garis penanda", "int", 12, "DT-13", "L765, L821", "T", {
    derive: "ticksFromSubcolumns",
    classNote: "12 batas kolom = grid.subcolumns",
  }),
  d("P4S-04", "device.datumRule.frontSegmentMm", "Segmen depan garis penanda (mm)", "mm", 9, "Tabel 4.7 no. 4", "L821", "B", {
    range: { min: 0, step: 0.5 },
    classNote: "pejal",
  }),
  d("P4S-05", "device.datumRule.pdfProgressMeter", "Pengukur kemajuan baca di PDF", "bool", true, "DT-13", "L765-766", "B"),
  d(
    "P4S-06",
    "device.datumRule.placements",
    "Penempatan garis penanda",
    "list",
    ["atas judul bab", "sampul", "pembatas"],
    "Tabel 4.6-4.7",
    "L765-766, L821",
    "B",
    {
      enum: ["atas judul bab", "sampul", "pembatas"],
      classNote: "subset; di interior hanya atas judul bab",
    },
  ),
  d("P4S-07", "device.evidenceRail.enabled", "Kolom catatan bukti aktif", "bool", true, "DT-13", "L768", "B", {
    conflictRef: "K-11",
    classNote: "B (konflik K-11); moda rel diatur layout.railMode (P4G-16)",
  }),
  d(
    "P4S-08",
    "device.evidenceRail.contents",
    "Isi kolom catatan bukti",
    "list",
    ["tanda", "digraf Admiralty", "sumber", "REQ", "batang revisi"],
    "Tabel 4.6",
    "L768-769, L834",
    "B",
    { enum: ["tanda", "digraf Admiralty", "sumber", "REQ", "batang revisi"], classNote: "subset" },
  ),
  d("P4S-09", "device.evidenceRail.emptyAllowed", "Kolom catatan bukti boleh kosong", "bool", true, "DT-43", "L784-785, L4649", "K", {
    conflictRef: "K-11",
    classNote: "K (konflik K-11); DT-43 berlaku hanya di dalam moda A per halaman",
  }),
  d("P4S-10", "device.registerBlock.enabled", "Blok register aktif", "bool", true, "DT-13", "L769, L846", "B", {
    classNote: "setiap halaman interior",
  }),
  d(
    "P4S-11",
    "device.registerBlock.cells",
    "Sel blok register",
    "list",
    ["GSP · {nomor}", "REV · {tanggal}", "LEMBAR {n} DARI {N}", "{kelas}"],
    "Tabel 4.6",
    "L771-772, L212; research/04 T036",
    "B",
    { classNote: "4 sel mono" },
  ),
  d("P4S-12", "device.registerBlock.separator", "Pemisah blok register", "string", "\u00A0", "4.7", "L786-788", "K", {
    classNote: "spasi tak-putus (NBSP, U+00A0)",
  }),
  d(
    "P4S-13",
    "device.registerBlock.boldFields",
    "Medan tebal blok register",
    "list",
    ["nomor dokumen", "nomor lembar"],
    "4.7",
    "L787",
    "B",
    {
      enum: ["nomor dokumen", "revisi", "tanggal", "nomor lembar", "jumlah lembar", "klasifikasi", "organisasi"],
      classNote: "subset; enum diperluas agar nilai BM dapat dinyatakan (D-151, D-165 KT-6): BM = nomor dokumen, revisi, nomor lembar, jumlah lembar, klasifikasi",
    },
  ),
  d(
    "P4S-14",
    "device.registerBlock.sheetFromPageField",
    "Nomor lembar dari medan halaman",
    "bool",
    true,
    "Tabel 4.7 no. 14",
    "L846, L4348",
    "K",
    { classNote: "medan NUMPAGES (E-06)" },
  ),
  d("P4S-15", "device.sealBand.enabled", "Tampilkan pita segel", "bool", true, "DT-13", "L774", "B", {
    classNote: "halaman pembungkus saja",
  }),
  d("P4S-16", "device.sealBand.heightMm", "Tinggi pita segel (mm)", "mm", 5, "Tabel 4.6", "L774", "B", {
    range: { min: 0, step: 0.5 },
  }),
  d("P4S-17", "device.sealBand.colour", "Warna pita segel", "tokenRef", "seal", "Tabel 4.6", "L774, L620", "B"),
  d("P4S-18", "device.sealBand.leftContent", "Isi kiri pita segel", "enum", "klasifikasi", "Tabel 4.6", "L774", "K", {
    enum: ["klasifikasi"],
    classNote: "tetap",
  }),
  d("P4S-19", "device.sealBand.rightContent", "Isi kanan pita segel", "enum", "kendali salinan bernomor", "Tabel 4.6, 6.1", "L774, L1095-1097", "K", {
    enum: ["kendali salinan bernomor"],
    classNote: "tetap",
  }),
  d("P4S-20", "device.spine.enabled", "Tampilkan teks tepi sampul", "bool", true, "DT-13", "L777", "B"),
  d("P4S-21", "device.spine.face", "Jenis huruf teks tepi sampul", "tokenRef", "mono", "Tabel 4.6", "L777", "B"),
  d("P4S-22", "device.spine.sizePt", "Ukuran teks tepi sampul (pt)", "pt", 6, "Tabel 4.6", "L777", "B", {
    range: { min: 1, step: 0.5 },
  }),
  d("P4S-23", "device.spine.rotationDeg", "Putaran teks tepi sampul (derajat)", "deg", 90, "Tabel 4.6", "L777, L4525-4526", "B", {
    range: { min: 0, max: 90, step: 90 },
    classNote: "0 atau 90; python-docx mencetak mendatar",
  }),
  d(
    "P4S-24",
    "device.spine.fields",
    "Isi teks tepi sampul",
    "list",
    ["jenis", "subjek", "bahasa", "revisi", "bulan", "tahun"],
    "Tabel 4.6",
    "L777-778, L23",
    "B",
    { enum: ["jenis", "subjek", "bahasa", "revisi", "bulan", "tahun"], classNote: "subset urut" },
  ),
  d(
    "P4S-25",
    "device.spine.placements",
    "Penempatan teks tepi sampul",
    "list",
    ["margin luar sampul", "pembatas"],
    "Tabel 4.6",
    "L777",
    "B",
    // C06 (D-635; research/38 §2): "sampul belakang" hanya di enum (opt-in CV-19); bawaan tetap dua tempat.
    { enum: ["margin luar sampul", "pembatas", "sampul belakang"], classNote: "subset" },
  ),
  d(
    "P4S-26",
    "device.issueStamp.format",
    "Format cap terbit",
    "string",
    "// {YYYYMMDD} {BAHASA} {KELAS} -- TERBITAN {n}",
    "Tabel 4.6",
    "L780, L22, SK106-109",
    "B",
    { pattern: "^[^\\u2014]*$", classNote: "pola tanpa U+2014 (KT-06: tanda pisah panjang 0)" },
  ),
  d("P4S-27", "device.issueStamp.issueNumber", "Nomor terbitan", "int", 1, "Tabel 4.6", "L22, L780", "T", {
    derive: "issueNumber",
    range: { min: 1, step: 1 },
    classNote: "T (dari ARSIP)",
  }),
];

// ── 3.3.8 Sampul (16) ────────────────────────────────────────────────────

const COVER_ORDER = [
  "pita segel",
  "logo",
  "baris alamat di atas garis rambut",
  "ruang putih",
  "Datum Rule 166 mm",
  "kicker jenis dokumen",
  "judul",
  "standfirst",
  "baris cakupan",
  "blok kendali",
  "kolofon",
  "string punggung",
];
const COVER_CONTROL_FIELDS = [
  "NOMOR DOKUMEN",
  "REVISI",
  "PENYUSUN",
  "KUSTODIAN",
  "DITUJUKAN KEPADA",
  "TIER",
  "DASAR",
  "BAHASA",
];
/**
 * C06 (C-6 research/35 §5; research/38 §2): enum medan blok kendali = bawaan + "KLASIFIKASI" (opt-in CL-02).
 * Konstanta terpisah agar tambahan enum tidak mengubah bawaan (bawaan masuk paramsSha256 dan keluaran sekarang).
 */
const COVER_CONTROL_FIELD_ENUM = [...COVER_CONTROL_FIELDS, "KLASIFIKASI", "HALAMAN", "DATUM GEODETIK", "VERIFIKASI"];
const COVER_COLOPHON_FIELDS = ["entitas", "NIB", "cap terbit", "klasifikasi"];

const COVER: ParamDef[] = [
  d("P4V-01", "cover.align", "Perataan sampul", "enum", "left", "DT-14, lint 06", "L792, L3950", "K", {
    enum: ["left"],
    classNote: "rata kiri, tidak pernah di tengah",
  }),
  d("P4V-02", "cover.leftMarginMm", "Margin kiri sampul (mm)", "mm", 24, "DT-14", "L792", "T", {
    derive: "coverLeftMargin",
    classNote: "= grid.innerMarginMm",
  }),
  d("P4V-03", "cover.elementOrder", "Urutan unsur sampul", "list", COVER_ORDER, "4.8", "L792-796", "B", {
    enum: COVER_ORDER,
    classNote: "permutasi",
  }),
  d("P4V-04", "cover.logo.maxOccurrencesPerDocument", "Kemunculan logo per dokumen (maks.)", "int", 1, "DT-14, 16.4", "L793, L4093", "K", {
    range: { min: 1, max: 1, step: 1 },
  }),
  d(
    "P4V-05",
    "cover.addressLine",
    "Baris alamat sampul",
    "string",
    "Divisi Engineering & Technical Intelligence · Jl. Bangka Raya No. 27, Pela Mampang, Jakarta Selatan 12720 · Tel. (021) 22715320",
    "4.8",
    "L3, L793; research/04 T001",
    "B",
  ),
  d("P4V-06", "cover.title.sizePt", "Ukuran judul sampul (pt)", "pt", 24, "4.8", "L795", "B", {
    range: { min: 24, max: 26, step: 0.5 },
    gapRef: "G-02",
    classNote: "manual: rentang 24-26 pt; G-02: nilai pilihan 24",
  }),
  d("P4V-07", "cover.kicker.colour", "Warna teks jenis dokumen", "tokenRef", "seal", "4.8", "L794-795", "B", {
    classNote: "seal = marun",
  }),
  d("P4V-08", "cover.kicker.text", "Teks jenis dokumen", "string", "", "4.8", "L5, L794; research/04 T004", "B", {
    classNote:
      "diisi per dokumen dari jenis dokumen; contoh Manual 000: STANDAR · MANUAL KOMPREHENSIF · PANDUAN SKILL DATUM GSP",
  }),
  d("P4V-09", "cover.standfirst.italic", "Paragraf pengantar miring", "bool", true, "4.8", "L795", "B"),
  d("P4V-10", "cover.scopeLine", "Baris cakupan sumber", "string", "", "4.8", "L14-15, L796; research/04 T002", "B", {
    classNote: "diisi per dokumen; contoh Manual 000: Menyatukan DATUM House Style Explained Rev A · Panduan Jenis Chart v1.1 · ...",
  }),
  d("P4V-11", "cover.datumRule.widthMm", "Lebar garis penanda sampul (mm)", "mm", 166, "4.8", "L794", "T", {
    derive: "coverRuleWidth",
    classNote: "= grid.fullSpanMm",
  }),
  d("P4V-12", "cover.controlBlock.fields", "Medan blok kendali sampul", "list", COVER_CONTROL_FIELDS, "4.8", "L17-20, L796; research/04 T002", "B", {
    enum: COVER_CONTROL_FIELD_ENUM,
    classNote: "subset urut",
  }),
  d("P4V-13", "cover.colophon.fields", "Medan kolofon sampul", "list", COVER_COLOPHON_FIELDS, "4.8", "L22, L796; research/04 T003", "B", {
    enum: COVER_COLOPHON_FIELDS,
    classNote: "subset",
  }),
  d(
    "P4V-14",
    "wrapper.header",
    "Kepala halaman pembungkus (kiri, kanan)",
    "pair",
    ["KLASIFIKASI · {kelas}", "SALINAN INDUK · PENGGUNAAN INTERNAL GSP"],
    "4.1",
    "L1, L24; research/04 T001",
    "B",
  ),
  d("P4V-15", "org.entityName", "Nama entitas", "string", "PT GEMILANG SATRIA PERKASA", "-", "L22; research/04 T003", "B"),
  d("P4V-16", "org.nib", "NIB", "string", "9120208940517", "-", "L22; research/04 T003", "B"),
];

// ── 3.3.9 Lembar kendali (6) ─────────────────────────────────────────────

const CONTROL: ParamDef[] = [
  d(
    "P4K-01",
    "controlSheet.revisionHistory.columns",
    "Kolom riwayat revisi",
    "list",
    ["REV", "TANGGAL", "PENYUSUN", "PERUBAHAN", "STATUS"],
    "4.8",
    "L32-38, L797; research/04 T005",
    "B",
  ),
  d(
    "P4K-02",
    "controlSheet.verificationChain",
    "Rantai verifikasi",
    "object",
    {
      columns: ["LAPIS", "METODE", "OBJEK", "HASIL"],
      layers: [
        { id: "V1", method: "Baca baris per baris" },
        { id: "V2", method: "Eksekusi" },
        { id: "V3", method: "Render dan periksa" },
      ],
    },
    "4.8",
    "L40-51, L797; research/04 T006",
    "B",
    { classNote: "B (jumlah lapis 3: K)" },
  ),
  d("P4K-03", "controlSheet.methodStatement.required", "Pernyataan metode wajib", "bool", true, "4.8", "L53-59, L797", "K"),
  d(
    "P4K-04",
    "controlSheet.distribution.columns",
    "Kolom distribusi terkendali",
    "list",
    ["SALINAN", "PEMEGANG", "MEDIA", "KEMBALI"],
    "4.8",
    "L61-69; research/04 T007",
    "B",
  ),
  d(
    "P4K-05",
    "controlSheet.signatures.roles",
    "Peran tanda tangan",
    "list",
    ["DISUSUN", "DIPERIKSA", "DISAHKAN"],
    "4.8",
    "L71-73, L798; research/04 T008",
    "B",
    { classNote: "B (tiga kolom: K)" },
  ),
  d(
    "P4K-06",
    "controlSheet.signatures.holders",
    "Pemegang tanda tangan",
    "list",
    ["Divisi Engineering", "Kendali Mutu", "Direktur Utama"],
    "-",
    "L73; research/04 T008",
    "B",
  ),
];

// ── 3.3.10 Anatomi halaman interior, Tabel 4.7 (10) ──────────────────────

const ANATOMY: ParamDef[] = [
  d(
    "P4A-01",
    "runningHead.fields",
    "Medan kepala halaman",
    "list",
    ["entitas", "jenis dokumen", "BAB {n}", "judul bab"],
    "Tabel 4.7 no. 1",
    "L147, L815",
    "B",
  ),
  d("P4A-02", "runningHead.classification.position", "Posisi klasifikasi di kepala halaman", "enum", "right", "Tabel 4.7 no. 2", "L817", "K", {
    enum: ["right"],
  }),
  d("P4A-03", "runningHead.ruleBelow", "Garis di bawah kepala halaman", "tokenRef", "rules.hair", "Tabel 4.5, 4.7", "L747, L815", "T", {
    derive: "runningHeadRule",
    classNote: "= rules.hair",
  }),
  d("P4A-04", "chapter.kicker.pattern", "Label nomor bab", "string", "BAB {n}", "Tabel 4.7 no. 3", "L819", "B", {
    classNote: "kapital amber renggang",
  }),
  d("P4A-05", "chapter.datumRule.onlyAboveChapterTitle", "Garis penanda hanya di atas judul bab", "bool", true, "Tabel 4.7 no. 4", "L821", "K"),
  d("P4A-06", "caption.position", "Posisi caption tabel", "enum", "above", "DT-15", "L836, L888", "K", {
    enum: ["above"],
  }),
  d("P4A-07", "source.position", "Posisi baris sumber", "enum", "below", "DT-15", "L842, L888-889", "K", {
    enum: ["below"],
    classNote: "di bawah garis rambut",
  }),
  d(
    "P4A-08",
    "table.totalRow.style",
    "Gaya baris total tabel",
    "object",
    { ruleAbove: "rules.primary", fill: "none", face: "condensed", weight: 600 },
    "Tabel 4.7 no. 11, 5.1",
    "L840, L879",
    "K",
    { classNote: "garis tebal (primary) di atas, tanpa isian, condensed 600" },
  ),
  d("P4A-09", "table.groupBand.fill", "Isian pita kelompok tabel", "enum", "none", "Tabel 4.7 no. 10", "L838, L871", "K", {
    enum: ["none"],
  }),
  d("P4A-10", "registerBlock.position", "Posisi blok register", "enum", "footer", "Tabel 4.6", "L769", "K", {
    enum: ["footer"],
    classNote: "footer setiap halaman interior",
  }),
];

export const PARAMS_PAGE: readonly ParamDef[] = [...GRID, ...RULES, ...SIGNATURE, ...COVER, ...CONTROL, ...ANATOMY];

/** Hitungan target katalog; isi larik wajib sama dengan angka ini setelah S06. */
export const PARAMS_PAGE_COUNT = 91;
