/**
 * Parameter renderer kontrak R-01..R-25 (01_specs.md §5.7), ditulis LENGKAP
 * oleh S03; R-26..R-34 = delta kontrak S03-d1 (aditif; default = perilaku
 * renderer saat ini, sehingga profil kanonik tidak berubah makna); R-35 = delta
 * S03-d2 (`lint.enforcementOverride`, kelas K, dibaca engine/lint/structure S46). `origin: "contract"`, `group: "R"`, dihitung TERPISAH dari 685
 * parameter katalog (D-24 butir 1). Kelas B kecuali ditulis (R-13 T, R-25 K, R-35 K).
 * Nilai profil Manual 000 diukur S95 dan disimpan sebagai override templat,
 * bukan di sini. R-38..R-58 (refaktor struktur) ada di params/structure.ts.
 * R-59..R-64 = delta RQ-8 (judul/catatan daftar isi DF-58; kelas lebar gambar dan
 * lembar simbol RK-10), nomor lanjut setelah R-58 karena structure.ts bukan berkas baris ini.
 * R-65 = delta FIX-FIG (D-257): resolusi gambar raster untuk aturan ukuran asli K-2 (D-242).
 * R-66 = delta FIX-TL (D-351/D-352): kedalaman daftar isi turunan `toc.levels` (registri S03 paramRefs).
 * R-67..R-80 = delta ronde cakupan DATUM Rev A (C06; D-631, D-635; register research/38 §1): opt-in
 * kelas B lapis lanjutan, bawaan = keluaran sekarang.
 *
 * SR-05 (KC-7, SR-01 PC-05/KD-25, D-158): R-09/R-10 tidak lagi membawa ukuran
 * halaman A4 tertanam; `pageSizeTw` adalah sub-medan turunan dari `page.sizeMm`
 * (`sectionSetupFromGrid`, research/09 §5.4, engine/tokens SR-60). Satu sumber
 * ukuran halaman: `page.size` + `page.orientation`.
 */
import type { ParamDef } from "../contract/types/params";

function r(
  n: number,
  key: string,
  label: string,
  type: ParamDef["type"],
  def: ParamDef["default"],
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
    source: "S01 §5.7",
    origin: "contract",
    group: "R",
    chapter: "Renderer",
    namespace: "render",
    ...extra,
  };
}

export const PARAMS_RENDER: readonly ParamDef[] = [
  r(1, "render.docx.compatibilityMode", "Mode kompatibilitas DOCX", "int", 15, {
    range: { min: 11, max: 15, step: 1 },
    classNote: "profil Manual 000: 14 (research/07:926)",
  }),
  r(2, "render.docx.defaultTabStopTw", "Tab stop bawaan (twip)", "int", 720, { range: { min: 0, max: 2880, step: 1 } }),
  r(3, "render.docx.updateFieldsOnOpen", "Perbarui medan saat dibuka", "bool", true, {
    source: "S01 §5.7; Garis A A5",
    classNote: "profil Manual 000: false (research/07:921)",
  }),
  r(4, "render.docx.embedTrueTypeFonts", "Tanam fon TrueType", "bool", true),
  r(5, "render.docx.saveSubsetFonts", "Simpan subset fon", "bool", false),
  r(
    6,
    "render.docx.docDefaults",
    "docDefaults DOCX",
    "object",
    { szHalfPt: 19, spacingAfterTw: 0, lineTw: 270, lineRule: "exact", lang: "id-ID" },
    { source: "S01 §5.7; research/07:896" },
  ),
  r(
    7,
    "render.docx.normalStyle",
    "Gaya Normal",
    "object",
    { faceRole: "serif", szHalfPt: 19, color: "2B3640", spacingAfterTw: 0, lineTw: 270, lineRule: "exact", lang: "id-ID" },
    { source: "S01 §5.7; research/07:897" },
  ),
  r(
    8,
    "render.docx.embedFonts",
    "Fon tertanam",
    "list",
    [
      { family: "IBM Plex Serif", slots: ["regular", "bold", "italic", "boldItalic"] },
      // FIX-6 (F-059): = type.face.condensed kanonik (P4T-02); profil Manual 000 menimpa R-08 dengan "IBM Plex Sans Cond".
      { family: "IBM Plex Sans Condensed", slots: ["regular", "bold", "italic", "boldItalic"] },
      { family: "IBM Plex Mono", slots: ["regular", "bold", "italic", "boldItalic"] },
      { family: "DejaVu Sans", slots: ["regular"] },
    ],
    {
      source: "S01 §5.7; research/07:953-976",
      classNote:
        "profil Manual 000: 18 berkas; slot Bold = wajah SemiBold. Entri = EmbedFontFamilyEntry (contract/engine.ts): " +
        "{ family | role, slots, boldFace?, files?, forceEmbed? }; forceEmbed true = tanam walau tidak dipakai run (S95-C15, delta S03-d1)",
    },
  ),
  r(
    9,
    "render.section.wrapper",
    "Seksi pembungkus (SectionSetup)",
    "object",
    { header: { mode: "empty" }, footer: { mode: "empty" } },
    {
      source: "S01 §5.7; research/07:638-654, 744, 758; SR-01 PC-05",
      classNote:
        "margin diturunkan dari grid (P4G) bila tidak diisi; pageSizeTw = turunan page.sizeMm (mmToTw), " +
        "nilai tersimpan diabaikan mesin dan dimigrasi ke page.customSizeMm bila berbeda (PC-05)",
    },
  ),
  r(
    10,
    "render.section.interior",
    "Seksi interior (SectionSetup)",
    "object",
    { header: { mode: "runningHead" }, footer: { mode: "registerBlock" } },
    {
      source: "S01 §5.7; research/07:751, 765; SR-01 PC-05",
      classNote:
        "margin diturunkan dari grid (P4G) bila tidak diisi; pageSizeTw = turunan page.sizeMm (mmToTw), " +
        "nilai tersimpan diabaikan mesin dan dimigrasi ke page.customSizeMm bila berbeda (PC-05)",
    },
  ),
  r(11, "render.section.breakPerUnit", "Satu seksi per unit", "bool", true, { source: "S01 §5.7; KS-06" }),
  r(12, "render.rail.renderer", "Perender kolom catatan bukti", "enum", "framePr", {
    enum: ["framePr", "table3col"],
    source: "S01 §5.7; Garis A",
    classNote: "profil Manual 000: table3col (T013 dkk.)",
  }),
  r(13, "render.rail.colsTw", "Lebar kolom rel (twip)", "list", null, {
    class: "T",
    derive: "railColsTw",
    classNote: "profil Manual 000: [7257, 340, 1814]",
  }),
  r(14, "render.derivation.renderer", "Perender turunan", "enum", "monoLines", {
    enum: ["monoLines", "nestedTable"],
    classNote: "profil Manual 000: nestedTable (N01, N02)",
  }),
  r(15, "render.caption.separator", "Pemisah label caption", "string", " ", { classNote: "diukur S95" }),
  r(16, "render.table.sourcePlacement", "Penempatan SUMBER tabel", "enum", "lastRowMerged", {
    enum: ["lastRowMerged", "paragraphBelow"],
    source: "S01 §5.7; KT-26",
  }),
  r(
    17,
    "render.table.layout",
    "Tata letak tabel bawaan",
    "object",
    // borders "none" = tanpa garis tepi tabel bawaan (TP-01).
    { fixed: true, indentTw: 0, cellMarginTw: { left: 0, right: 0 }, borders: "none" },
    { source: "S01 §5.7; research/07:269 TP-01" },
  ),
  r(18, "render.spacer.autoMode", "Spacer otomatis", "enum", "template", {
    enum: ["none", "template"],
    classNote: "profil Manual 000: none (S93 menulis spacer eksplisit)",
  }),
  r(
    19,
    "render.spacer.defaults",
    "Spacer bawaan per jenis blok",
    "map",
    { table: { lineTw: 135, lineRule: "exact" }, list: { lineTw: 68, lineRule: "exact" } },
  ),
  r(20, "render.list.bulletMarker", "Penanda butir", "object", { t: "–" }, { source: "S01 §5.7; RS21" }),
  r(
    21,
    "render.list.numberMarker",
    "Gaya nomor butir",
    "object",
    { faceRole: "mono", color: "B45309", b: true },
    { source: "S01 §5.7; RS25 (research/07:74)" },
  ),
  r(22, "render.toc.mode", "Bentuk daftar isi di Word", "enum", "field", {
    enum: ["field", "static"],
    classNote: "profil Manual 000: static (T010)",
  }),
  r(23, "render.cover.mode", "Mode sampul", "enum", "auto", {
    enum: ["auto", "explicit"],
    classNote: "profil Manual 000: explicit",
  }),
  r(24, "render.html.paged", "Halaman web dibagi per halaman cetak", "bool", true),
  r(25, "render.png.dpi", "Resolusi PNG (dpi)", "int", 300, { class: "K", range: { min: 150, max: 600, step: 1 } }),
  // ── Delta S03-d1 (aditif) ──────────────────────────────────────────────
  r(26, "runningHead.docLabel", "Label dokumen di kepala halaman", "string", "", {
    source: "S03-d1; S14 (D-39)",
    namespace: "runningHead",
    classNote: "kosong = meta.subject, lalu meta.title (cadangan engine/docx/package)",
  }),
  r(27, "org.shortName", "Nama pendek organisasi (blok register)", "string", "GSP", {
    source: "S03-d1; S14 (D-39)",
    namespace: "org",
    classNote: "sel pertama blok register footer: '<nama pendek> · <nomor dokumen>'",
  }),
  r(28, "render.derivation.nestedColsTw", "Lebar kolom tabel bersarang turunan (twip)", "list", null, {
    source: "S03-d1; S95-C08",
    classNote: "null = diturunkan renderer (kolom teks - 4 mm; kolom nilai = rel bukti); profil Manual 000: [5216, 1814] (TP-03)",
  }),
  r(
    29,
    "render.section.registerBlockLayout",
    "Tata letak blok register footer",
    "object",
    {},
    {
      source: "S03-d1; G-08 S93, S95-C09",
      classNote:
        "{ colsTw?, cellFormats?: CellFormat[], trailingFormat?: ParaFormat }; {} = bawaan renderer; " +
        "HeaderFooterSpec registerBlock di dokumen menang; profil Manual 000: kolom [2948, 2381, 2381, 1701]",
    },
  ),
  r(
    30,
    "render.docx.headerFooterStyles",
    "Gaya paragraf Header/Footer (styles.xml)",
    "object",
    {
      Header: { basedOn: "Normal", tabs: [{ posTw: 4680, val: "center" }, { posTw: 9360, val: "right" }], spacingAfterTw: 0, lineTw: 240, lineRule: "auto" },
      Footer: { basedOn: "Normal", tabs: [{ posTw: 4680, val: "center" }, { posTw: 9360, val: "right" }], spacingAfterTw: 0, lineTw: 240, lineRule: "auto" },
    },
    { source: "S03-d1; G-07 S93, S95-C10 (= nilai yang kini ditulis engine/docx/package)" },
  ),
  r(31, "render.docx.settingsExtras", "Pengaturan settings.xml tambahan", "map", {}, {
    source: "S03-d1; S95-C11",
    classNote:
      "{} = tidak ada; profil Manual 000: compatSettings (overrideTableStyleFontSizeAndJustification, enableOpenTypeFeatures, " +
      "doNotFlipMirrorIndents = 1), useFELayout, characterSpacingControl doNotCompress, zoom bestFit, themeFontLang, " +
      "decimalSymbol, listSeparator, defaultImageDpi 300",
  }),
  r(32, "render.runningHead.runProps", "Format run kepala halaman (kiri/kanan)", "object", {}, {
    source: "S03-d1; S95-C05",
    classNote:
      "{ left?: RunProps, right?: RunProps } ditimpakan ke run hasil peran; {} = dari peran; profil Manual 000: spacingTw 12 (0,6 pt) " +
      "kiri dan kanan, kanan b true color 101418",
  }),
  r(33, "render.section.numberSeparator", "Pemisah nomor-judul seksi", "string", "   ", {
    source: "S03-d1; G-01 S93, S95-C14",
    classNote: "ditulis di run nomor bila judul berupa teks; Section.numberSeparator di dokumen menang; BM 3 spasi",
  }),
  r(34, "render.specTable.conditionIndentMm", "Jorokan kolom kondisi uji tabel spesifikasi (mm)", "mm", 0, {
    range: { min: 0, max: 50 },
    source: "S03-d1; D-51 (S17), P5-27",
    classNote: "katalog P5-27 menyatakan 'menjorok' tanpa besar; BM T039 tidak menjorok (terukur 0); 0 = celah, tanpa jorokan",
  }),
  // ── Delta S03-d2 (aditif; IP-07, D-70) ─────────────────────────────────
  r(35, "lint.enforcementOverride", "Override penegakan lint per cek (profil templat)", "map", {}, {
    class: "K",
    source: "S03-d2; S46 engine/lint/structure/enforcement.ts (D-34, D-70)",
    ruleRef: "D-34",
    chapter: "Bab 16",
    namespace: "lint",
    classNote:
      "{ \"<checkId registri lint>\": \"block\" | \"release\" | \"report\" | \"off\" }; {} = default registri " +
      "(blocksIngest -> block, batas 'lapor' -> report, lain release). Profil templat (kelas K, ADMINISTRATOR) boleh semua mode; " +
      "dokumen `x.lintEnforcement` hanya boleh menurunkan block -> release. checkId/mode tak sah tidak menolak simpan, " +
      "tetapi dilaporkan lint sebagai REPORT STRUCT-ENFORCEMENT. Profil benchmark Manual 000: { \"DATUM-09\": \"release\" } (S46)",
  }),
  // ── Delta RT-01 (aditif; D-119 dokumen konten-saja) ────────────────────
  r(36, "render.run.strong", "Format run tebal semantik di prosa", "object", {}, {
    source: "RT-01; D-119",
    classNote:
      "RunProps yang ditimpakan ke run ber-`b: true` (penekanan semantik dokumen konten-saja) bila run dasar peran tidak tebal; " +
      "properti run itu sendiri tetap menang. {} = tanpa tambahan (perilaku lama); profil Manual 000: { color: \"101418\" } (tebal = ink900)",
  }),
  r(37, "render.run.symbolGlyphByRole", "Format run glif simbol per peran inang", "map", {}, {
    source: "RT-01; D-119",
    classNote:
      "{ \"<RoleKey>\": RunProps } untuk run `faceRole: symbolGlyph` (glif provenans, ≥, ≤, σ, →, ...) yang berbagi paragraf " +
      "dengan teks lain; wajah tetap `type.face.symbolGlyph`. {} = ukuran run inang (perilaku lama); profil Manual 000: glif " +
      "1 pt di bawah inang (sel teks 14, sel mono/SUMBER 12, prosa 17)",
  }),
  // ── Delta RQ-8 (aditif; SR-32 sisa D-216) ───────────────────────────────
  // Judul/catatan daftar isi = kenop templat (register 03 DF-58; TocPayloadV2 konten-saja, D-139).
  r(59, "render.toc.title", "Judul daftar isi", "string", null, {
    source: "RQ-8; register 03 DF-58; D-216",
    classNote:
      "dibaca compose `tocSpec` (TocSpec.title); null = tanpa judul (teks bawaan templat: hanya kicker 'Daftar Isi' " +
      "dari mesin); profil Manual 000: \"Peta Isi Manual\" (doc.verbatim.json)",
  }),
  r(60, "render.toc.note", "Catatan daftar isi", "string", null, {
    source: "RQ-8; register 03 DF-58; D-216",
    classNote: "dibaca compose `tocSpec` (TocSpec.note, paragraf peran toc.note di bawah tabel entri); null = tanpa catatan",
  }),
  // Kelas lebar figur gambar dan lembar simbol (RK-10), pola R-55..R-57: kelas B -> mm T `figureWidthFromClass`.
  r(61, "image.widthClass", "Lebar gambar", "enum", "text", {
    enum: ["text", "full"],
    source: "RQ-8; SR-32 RK-10; pola R-55..R-57 (research/09 N14-N16)",
    namespace: "image",
    classNote: "text = kolom teks, full = bentang penuh; mm diturunkan (figureWidthFromClass -> image.widthMm); profil Manual 000: full",
  }),
  r(62, "symbolSheet.widthClass", "Lebar lembar simbol", "enum", "text", {
    enum: ["text", "full"],
    source: "RQ-8; SR-32 RK-10; pola R-55..R-57 (research/09 N14-N16)",
    namespace: "symbolSheet",
    classNote:
      "text = kolom teks, full = bentang penuh; mm diturunkan (figureWidthFromClass -> symbolSheet.widthMm); profil Manual 000: full",
  }),
  r(63, "image.widthMm", "Lebar keluaran gambar", "mm", null, {
    class: "T",
    derive: "figureWidthFromClass",
    source: "RQ-8; SR-32 RK-10",
    namespace: "image",
    classNote:
      "T: kolom teks atau bentang penuh menurut image.widthClass (A4 = 128/166); dibaca compose `figureWidthMm` untuk blok image v2; " +
      "null = cadangan grid.textColumnMm",
  }),
  r(64, "symbolSheet.widthMm", "Lebar keluaran lembar simbol", "mm", null, {
    class: "T",
    derive: "figureWidthFromClass",
    source: "RQ-8; SR-32 RK-10",
    namespace: "symbolSheet",
    classNote:
      "T: kolom teks atau bentang penuh menurut symbolSheet.widthClass (A4 = 128/166); dibaca compose `figureWidthMm` untuk blok " +
      "symbolSheet v2; null = cadangan grid.textColumnMm",
  }),
  // ── Delta FIX-FIG (D-257; aturan ukuran asli K-2 D-242) ────────────────
  r(65, "image.rasterDpi", "Resolusi gambar raster (dpi)", "int", 150, {
    // Lantai 150 = ambang mutu DATUM-39 (FIX-A2 N2): di bawahnya K-2 menempatkan gambar pada
    // lebar asli beresolusi rendah lalu DATUM-39 memperingatkan gambar yang sama.
    range: { min: 150, max: 600, step: 1 },
    source: "FIX-FIG; D-242 K-2, D-257; rentang 150-600 FIX-A2 (D-281)",
    namespace: "image",
    classNote:
      "Gambar foto/raster tidak diperbesar melewati ukuran aslinya pada resolusi ini: lebar asli = piksel / dpi; " +
      "lebar kelas gambar (image.widthClass) menjadi batas atas. Bawaan 150 = lantai mutu raster DATUM-39 (nilai minimum). " +
      "Angka lebih besar membuat gambar beresolusi rendah tampil lebih kecil (lebih tajam); berlaku untuk dokumen konten v2",
  }),
  // ── Delta FIX-TL (D-351/D-352; TOC turunan per section FIX-T2) ─────────
  // Lapis lanjutan + cakupan section:toc = pola kenop daftar isi RQ-8 (R-59/R-60): keputusan gaya rumah
  // milik ADMIN templat, bukan kenop awam (kenop esensial toc tetap 2: mode nomor halaman + pita segel).
  r(66, "toc.levels", "Kedalaman daftar isi", "int", 2, {
    range: { min: 1, max: 3, step: 1 },
    source: "FIX-TL; registri S03 paramRefs toc.levels; FIX-T2 (D-351)",
    namespace: "toc",
    classNote:
      "Tingkat entri daftar isi TURUNAN (entri konten kosong): 1 = bagian, bab, lampiran; 2 = tambah section " +
      "(nomor + judul, peran toc.section*); 3 = cadangan tingkat berikut (kontrak belum punya unit struktur tingkat 3, " +
      "entri turunan sama dengan 2, kerangka medan Word TOC \\o 1-3). Bawaan 2 = medan TOC \\o 1-2 mesin. " +
      "Entri eksplisit konten (Manual 000) tidak terpengaruh",
  }),
  // ── Delta ronde cakupan DATUM Rev A (C06; D-631, D-635; register research/38 §1) ──
  // Semua kelas B, lapis lanjutan, bawaan = keluaran sekarang (absen = bawaan = hari ini, syarat
  // C-1..C-12 research/35 §5); nilai opt-in hanya di lapis spesifikasi 10 templat Rev A (C23).
  // Pembaca menyusul di baris C08-C27; namespace eksplisit = segmen pertama kunci.
  r(67, "controlSheet.subtitle.enabled", "Subjudul lembar kendali", "bool", false, {
    source: "C05 research/38; ID:25, EN:25",
    namespace: "controlSheet",
    classNote: "true = subjudul dari tabel teks di bawah judul lembar kendali (ID:25, EN:25); false = tanpa subjudul",
  }),
  r(68, "controlSheet.signatures.fillRoles", "Selalu tiga kolom tanda tangan", "bool", false, {
    source: "C05 research/38; ID:2501, EN:2570",
    namespace: "controlSheet",
    classNote: "true = tiga kolom tanda tangan selalu, peran yang tidak dikirim diisi label peran bawaan dengan pemegang kosong",
  }),
  r(69, "controlSheet.columns.form", "Bentuk kolom tabel lembar kendali", "enum", "mesin", {
    enum: ["mesin", "manual"],
    source: "C05 research/38; ID:29, ID:39, ID:58; EN:29, EN:38, EN:62",
    namespace: "controlSheet",
    classNote: "mesin = kolom sekarang; manual = kolom manual (ID:29, 39, 58; EN:29, 38, 62)",
  }),
  r(70, "cover.title.maxWidthMm", "Lebar maksimum judul sampul (mm)", "mm", null, {
    range: { min: 50, max: 166, step: 1 },
    source: "C05 research/38; ID:2480, EN:2552",
    namespace: "cover",
    classNote: "null = tanpa jorokan kanan; nilai = jorokan kanan judul = bentang penuh - nilai (150 -> 16 mm = 907 tw)",
  }),
  r(71, "render.docx.pageBackground", "Latar halaman DOCX dari warna kertas badan", "bool", false, {
    ruleRef: "DT-05",
    source: "C05 research/38; DT-05 ID:2528-2533, EN:2591-2597; research/36",
    classNote: "true = w:background dari color.interior.paper + w:displayBackgroundShape; satu warna per dokumen (research/36)",
  }),
  r(72, "runningHead.ruleColour", "Warna garis kepala halaman", "hex", "C3CBD1", {
    ruleRef: "DT-13d",
    source: "C05 research/38; Tabel 8.1 ID:2576, EN:2646; DT-13d ID:2588-2594, EN:2660-2666",
    namespace: "runningHead",
    classNote: "garis bawah kepala halaman; bawaan = INK200 sekarang",
  }),
  r(73, "device.registerBlock.topRuleColour", "Warna garis atas blok register", "hex", "101418", {
    ruleRef: "DT-13d",
    source: "C05 research/38; Tabel 8.1 ID:2577, EN:2647; DT-13d ID:2588-2594, EN:2660-2666",
    namespace: "device",
    classNote: "garis atas sel blok register; bawaan = ink900 sekarang",
  }),
  r(74, "render.rhythm.snapToBaseline", "Kunci tinggi unsur ke garis dasar 13,5 pt", "bool", false, {
    ruleRef: "DT-10b",
    source: "C05 research/38; DT-10b ID:2680-2685, EN:2748-2753",
    classNote: "true = jarak judul, tinggi baris tabel dan gambar dibulatkan ke kelipatan 13,5 pt",
  }),
  r(75, "render.rail.reserveColumn", "Cadangkan kolom rel bukti di setiap halaman interior", "bool", false, {
    ruleRef: "DT-13e",
    source: "C05 research/38; EN:2764; ID:2705-2711",
    classNote: "true = kolom rel 32 mm dicadangkan di setiap halaman interior (badan 128 mm) tanpa mengubah margin seksi",
  }),
  r(76, "render.nota.classificationLine", "Baris klasifikasi di bawah nomor", "bool", false, {
    ruleRef: "DT-28c",
    source: "C05 research/38; DT-28c ID:609-617, EN:645-652",
    classNote: "true = baris 'Klasifikasi : <K>' / 'Classification: <K>' di bawah nomor dokumen",
  }),
  r(77, "render.ruleIndex.fromMarkers", "Indeks aturan dari penanda kode di isi", "bool", false, {
    source: "C05 research/38; ID:235, ID:4515-4522; EN:240, EN:4439-4445; research/37",
    classNote: "true = indeks aturan dibangun dari penanda kode+tingkat di isi (research/37)",
  }),
  r(78, "naming.file.form", "Bentuk nama berkas", "enum", "judulNomorRevisi", {
    enum: ["judulNomorRevisi", "judulTanggalIso"],
    source: "C05 research/38; Tabel 2.3 ID:487-493, EN:518-523",
    namespace: "naming",
    classNote: "judulTanggalIso = '<judul> <YYYY-MM-DD>.<ext>' (Tabel 2.3)",
  }),
  r(79, "cover.controlBlock.preparerUnit", "Unit penyusun di blok kendali sampul", "string", "", {
    // C35 L-01 (CWE-20): maks 120 karakter, tanpa kontrol C0/DEL; bawaan "" tetap sah.
    pattern: "^[^\\u0000-\\u001F\\u007F]{0,120}$",
    source: "C05 research/38; ID:16, ID:2487; EN:16, EN:2558",
    namespace: "cover",
    classNote: "kosong = meta.author; nilai = unit penyusun tetap (D-627)",
  }),
  r(80, "device.registerBlock.sheetNumbering", "Mulai penomoran lembar", "enum", "dokumen", {
    enum: ["dokumen", "bab1"],
    source: "C05 research/38; ID:2510-2511",
    namespace: "device",
    classNote: "bab1 = nomor lembar mulai 1 di halaman pertama Bab 1 (ID:2510-2511)",
  }),
  // ── Row 122 (Swarm 1.2.0, C40 FIX CP-05/CP-06): template data for the Rev A control block and control sheet.
  // Defaults are empty, so a template that does not set them prints what it printed before.
  r(81, "controlSheet.methodStatement.text", "Pernyataan metode bawaan lembar kendali", "string", "", {
    pattern: "^[^\\u0000-\\u0008\\u000B-\\u001F\\u007F]{0,2000}$",
    source: "Row 122; Manual Rev A ID p.48, EN p.49-50",
    namespace: "controlSheet",
    classNote: "kosong = tanpa pernyataan bawaan; dipakai bila muatan dokumen TERBIT/SERAH tidak mengirim pernyataan metode",
  }),
  r(82, "controlSheet.distribution.defaults", "Distribusi terkendali bawaan", "object", { rows: [] }, {
    source: "Row 122; Manual Rev A ID p.48 (DT-13b), EN p.49-50",
    namespace: "controlSheet",
    classNote: "{rows: [[salinan, pemegang, media, kembali], ...]}; dipakai bila muatan dokumen TERBIT/SERAH tidak mengirim distribusi",
  }),
  r(83, "cover.controlBlock.geodeticDatum", "Datum geodetik di blok kendali sampul", "string", "", {
    pattern: "^[^\\u0000-\\u001F\\u007F]{0,120}$",
    source: "Row 122; Manual Rev A ID p.47 butir 10, EN p.49",
    namespace: "cover",
    classNote: "kosong = medan DATUM GEODETIK dilewati",
  }),
];

export const PARAMS_RENDER_COUNT = 62;
