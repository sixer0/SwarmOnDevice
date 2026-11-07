/**
 * Parameter tata kelola, tier, penamaan, bahasa, kanal, gerbang, lampiran (S04, 01_specs.md §5.1).
 * 115 ParamDef, `origin: "catalog"`: P1 4, P3 24, P11-14 44, P15 31, P16 8, PA-PD 4.
 * Sumber: research/01_manual_parameter_catalog.md §3.1, §3.2, §3.9-3.12. Nilai [REK] diganti dari
 * research/04_manual_docx_tables.md (D-09): Tabel 14.2/14.3 (T119, T120), Tabel 15.1 (T127),
 * Tabel 16.1 (T133). Konflik: K-09 (em dash) memakai 0 (D-22 KT-06); sisanya usulan katalog (KT-10).
 * P15 (workbook dan command brief) `inactive: true` (A5, D-05).
 */
import type { ParamDef } from "../contract/types/params";

type Extra = Partial<
  Pick<
    ParamDef,
    "range" | "enum" | "pattern" | "classNote" | "derive" | "tiers" | "rek" | "unreadable" | "conflictRef" | "gapRef" | "inactive"
  >
>;

type Maker = (
  id: string,
  key: string,
  label: string,
  type: ParamDef["type"],
  def: ParamDef["default"],
  cls: ParamDef["class"],
  ruleRef: string,
  source: string,
  extra?: Extra,
) => ParamDef;

function maker(group: ParamDef["group"], chapter: string, inactive = false): Maker {
  return (id, key, label, type, def, cls, ruleRef, source, extra = {}) => ({
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
    chapter,
    namespace: key.split(".")[0],
    ...(inactive ? { inactive: true } : {}),
    ...extra,
  });
}

// ── P1 Bab 1-2: tata kelola (4) ──────────────────────────────────────────

const p1 = maker("P1", "Bab 1-2");

const P1: ParamDef[] = [
  p1("P1-01", "governance.precedence", "Hierarki kewenangan", "list",
    ["regulasi-kontrak", "kepatuhan-DATUM", "bentuk-DATUM", "isi-pilihan", "edisi-terbaru"], "K", "Hierarki 2.5, SM-02", "L379-398",
    { classNote: "urutan tetap 5 butir" }),
  p1("P1-02", "governance.decisionOwners", "Pemilik keputusan", "map",
    {
      isi: "spesialis",
      "perlu-ada-gambar": "PRISMA",
      angka: "veritas",
      bentuk: "DATUM",
      kalimat: "Gaya Ahli",
      "hidup-berkas": ["ARSIP", "LOKUS", "KRONIK"],
    }, "K", "2.4", "L355-360", { classNote: "peran tetap" }),
  p1("P1-03", "governance.tokensOverrideProse", "Token mengalahkan prosa", "bool", true, "K", "DT-03", "L285-287, L490, TK2"),
  // R01 (F-023): tipe "list" + enum = multi-pilih (default berupa himpunan); sebelumnya "enum".
  p1("P1-04", "content.authorClaimMarks", "Tanda klaim penulis", "list", ["TERUKUR", "DITURUNKAN", "ASUMSI"], "K", "Konvensi 1.5", "L260-263",
    { enum: ["TERUKUR", "DITURUNKAN", "ASUMSI"], classNote: "himpunan tanda yang sah (3 nilai), bukan satu nilai" }),
];

// ── P3 Bab 3: tier, alur bangun, penamaan, penomoran (24) ────────────────

const p3 = maker("P3", "Bab 3");

const P3: ParamDef[] = [
  p3("P3-01", "artifact.tier", "Tier artefak", "enum", "NOTA", "B", "DT-02", "L417-428",
    { enum: ["NOTA", "TERBIT", "SERAH"], classNote: "B (naik wajib dibenarkan)" }),
  p3("P3-02", "artifact.tierJustification", "Pembenaran kenaikan tier", "string", "", "B", "DT-02", "L428",
    { tiers: ["TERBIT", "SERAH"], classNote: "wajib bila tier bukan NOTA" }),
  p3("P3-03", "artifact.audience.outsideDivision", "Pembaca di luar divisi", "bool", false, "B", "Uji satu kalimat", "L430-431"),
  p3("P3-04", "artifact.tierSuggested", "Tier yang disarankan", "enum", "NOTA", "T", "3.1", "L430-431",
    { derive: "tierSuggested", enum: ["NOTA", "TERBIT", "SERAH"], classNote: "dari P3-03: false menjadi NOTA" }),
  p3("P3-05", "artifact.format", "Format keluaran", "enum", "md", "B", "3.3", "L419-425, L469-488",
    { enum: ["md", "docx", "xlsx", "pptx", "svg", "png", "pdf", "html"], classNote: "B (dibatasi tier); md (NOTA), docx (TERBIT)" }),
  p3("P3-06", "artifact.pdf.enabled", "PDF diaktifkan", "bool", false, "T", "Tabel 3.1", "L419-425",
    { derive: "pdfEnabledByTier", classNote: "T (B hanya untuk TERBIT); NOTA false, TERBIT false kecuali diminta, SERAH true" }),
  p3("P3-07", "artifact.pageReconciliation.enabled", "Rekonsiliasi halaman", "bool", false, "T", "Tabel 3.1", "L419-425",
    { derive: "reconciliationByTier", classNote: "SERAH saja" }),
  p3("P3-08", "artifact.lint.enabled", "Lint diaktifkan", "bool", false, "T", "Tabel 3.1, DT-42", "L419-425",
    { derive: "lintByTier", classNote: "NOTA false, TERBIT dan SERAH true" }),
  p3("P3-09", "naming.underscore.allowed", "Garis bawah pada nama", "bool", false, "K", "DT-12, lint 38", "L506-512"),
  p3("P3-10", "naming.folder.pattern", "Pola nama folder", "string", "NN Judul Kapital", "B", "Tabel 3.3", "L521",
    { classNote: "urut dua digit, spasi, huruf awal kapital" }),
  p3("P3-11", "naming.file.pattern", "Pola nama berkas", "string", "{judul} {nomorBerkas}", "T", "Tabel 3.3", "L524",
    { derive: "fileName", classNote: "dari P3-18 dan judul" }),
  p3("P3-12", "naming.sheet.pattern", "Pola nama sheet", "string", "KAPITAL-TANDA-HUBUNG", "B", "Tabel 3.3", "L527",
    { classNote: "kapital, tanda hubung (contoh HITUNG-KABEL)" }),
  p3("P3-13", "naming.sheet.maxChars", "Panjang maksimum nama sheet", "int", 31, "K", "Tabel 3.3", "L527",
    { range: { min: 1, max: 31, step: 1 } }),
  p3("P3-14", "naming.artifactId.pattern", "Pola ID tabel dan gambar", "string", "{Jenis} {bab}.{urut}", "K", "Tabel 3.3", "L530, L132-133",
    { classNote: "kata, spasi, nomor (Tabel 4.1, Gambar 5.2)" }),
  p3("P3-15", "naming.engineeringId.separator", "Pemisah identifier rekayasa", "string", "-", "K", "Tabel 3.3", "L533",
    { classNote: "REQ-FO-05, K-01; hanya tanda hubung" }),
  p3("P3-16", "naming.figureFile.fromCaption", "Nama berkas gambar dari caption", "bool", true, "T", "3.5", "L536, L540",
    { derive: "figureFileFromCaption", classNote: "contoh Gambar 4.2 Arsitektur.svg" }),
  p3("P3-17", "numbering.scope", "Lingkup penomoran", "enum", "perChapter", "K", "1.6 catatan daftar isi", "L132-133",
    { enum: ["perChapter"] }),
  p3("P3-18", "doc.number", "Nomor dokumen", "string", "{urut}/GSP/{kodeJenis}/{bulanRomawi}/{tahun}", "K", "DT-04", "L1138-1141, L550",
    { conflictRef: "K-14", classNote: "dari Register Induk; kode klasifikasi di nomor belum diputus (K-14), kelas disimpan sebagai medan terpisah" }),
  p3("P3-19", "doc.number.fileForm", "Bentuk nomor pada nama berkas", "string", "garis miring diganti tanda hubung", "T", "6.3", "L1140-1142",
    { derive: "docNumberFileForm", classNote: "dari P3-18" }),
  // R01 (F-023): "list" + enum = multi-pilih (himpunan kode sah); sebelumnya "enum".
  p3("P3-20", "doc.typeCode", "Kode jenis dokumen", "list", ["KT", "PT", "RAB", "SPH", "SP", "BA", "DS", "STD"], "K", "6.3, E-21", "L1142-1145",
    {
      // S11 (D-590): NDA = kode jenis Manual DATUM Rev A Tabel 3.1; hanya enum, bawaan tidak berubah (paramsSha256 tetap).
      enum: ["KT", "PT", "RAB", "SPH", "SP", "BA", "DS", "DEK", "LAP", "MAT", "STD", "NOT", "MOD", "VER", "NDA"],
      conflictRef: "K-15",
      classNote:
        "daftar tertutup; default = himpunan DATUM + STD (D-63: nomor benchmark 000/GSP/STD/X/2026); ARSIP menambah DEK, LAP, MAT, STD, NOT, MOD, VER tanpa DS",
    }),
  p3("P3-21", "doc.monthRoman", "Bulan Romawi", "string", "I-XII", "T", "6.3", "L1139-1140",
    { derive: "monthRoman", classNote: "dari tanggal (Perkap 1/2023)" }),
  p3("P3-22", "doc.revision", "Huruf revisi", "string", "A", "K", "3.6", "L17, L548-551", { classNote: "huruf revisi ARSIP" }),
  p3("P3-23", "doc.language", "Bahasa", "enum", "ID", "B", "R-16", "L20, L4298-4300, L4488",
    { enum: ["ID", "EN"], classNote: "EN: usulan P-08 belum berlaku" }),
  p3("P3-24", "doc.changeLog.required", "Catatan perubahan wajib", "bool", true, "K", "3.6", "L550-551", { classNote: "apa, mengapa, dampak" }),
];

// ── P11-P14 Bab 11-14: gaya bahasa L0-L6 (44) ────────────────────────────

const pb = maker("P11", "Bab 11-14");
const pL = pb;

const P11: ParamDef[] = [
  pL("P11-01", "doc.channel", "Kanal keluaran", "enum", "dokumen", "B", "16.5, Lampiran C.2", "L4104-4140, L4982-4983",
    { enum: ["chat", "surat", "dokumen", "dek", "notifikasi", "workbook"], classNote: "kanal K2 = panjang" }),
  pL("P11-02", "doc.openingOrder", "Urutan pembuka", "enum", "answerFirst", "B", "SG-L0-05", "L2877-2883",
    { enum: ["answerFirst", "legalBasisFirst"], classNote: "answerFirst (kanal keputusan); legalBasisFirst (naskah dinas)" }),
  pL("P11-03", "doc.readerKnowledgeMap", "Peta pengetahuan pembaca", "object", { dijelaskan: [], dianggapDiketahui: [] }, "B", "SG-L0-05", "L2877-2881",
    { classNote: "dua kolom: dijelaskan vs dianggap diketahui" }),
  pL("P11-04", "doc.identityStatement.required", "Pernyataan identitas wajib", "bool", true, "K", "SG-L0-01, SG-L0-02", "L2854-2863, L2914-2915",
    { classNote: "jenis, penyusun, kebutuhan, satu jangkar terukur" }),
  pL("P11-05", "doc.closing.actionAndRecipient.required", "Penutup aksi dan penerima wajib", "bool", true, "K", "SG-L0-03", "L2865-2869"),
  pL("P11-06", "doc.authorityUmbrellaFirst", "Payung otoritas lebih dulu", "bool", true, "B", "SG-L1-01", "L2930-2934",
    { classNote: "true pada dokumen yang bentuknya mengikat urutan" }),
  pL("P11-07", "doc.sequenceMap.required", "Peta urutan wajib", "bool", true, "B", "SG-L1-03", "L2942-2945",
    { classNote: "cakupan per bagian dan yang tidak dicakup" }),
  pL("P11-08", "prose.maxInlineNameValuePairs", "Maks. pasangan nama-nilai sebaris", "int", 3, "K", "SG-L1-04", "L2947-2951, L3019-3020",
    { range: { min: 0, max: 3, step: 1 }, classNote: "lebih dari 3 pindah ke tabel" }),
  pL("P11-09", "doc.pivotMoment.required", "Momen pembalik wajib", "bool", true, "K", "SG-L1-10, C-24", "L2986-2990",
    { classNote: "true untuk dokumen bersistem bab dan proposal tebal" }),
  pL("P11-10", "doc.pivotMoment.window", "Jendela momen pembalik (fraksi dokumen)", "range", [0.25, 0.75], "B", "SG-L1-10", "L2986-2989",
    { range: { min: 0.25, max: 0.75, step: 0.05 }, classNote: "setelah 25 % awal, sebelum 25 % akhir" }),
  pL("P11-11", "paragraph.maxWords", "Maks. kata per paragraf", "int", 150, "K", "SG-L2-09", "L3082-3084, L3135",
    { range: { max: 150, step: 1 }, classNote: "plafon bantu" }),
  pL("P11-12", "list.numberedWhenItemsGreaterThan", "Daftar bernomor bila butir lebih dari", "int", 3, "B", "SG-L2-04", "L3054-3058"),
  pL("P11-13", "letter.salutation.address", "Sapaan surat", "string", "Yth. Bapak/Ibu/Saudara + jabatan", "K", "SG-L5-08", "L3471",
    { classNote: "bukan \"Kepada Yth.\"; tetap" }),
  pL("P11-14", "letter.salutation.opening", "Pembuka surat", "string", "Dengan hormat,", "K", "SG-L5-08", "L3473",
    { classNote: "bukan Halo, Hai; tetap" }),
  pL("P11-15", "letter.selfReference", "Rujukan diri surat", "string", "kami", "K", "SG-L5-08", "L3473-3475",
    { classNote: "bukan saya atas nama lembaga, bukan kita; tetap" }),
  pL("P11-16", "letter.readerReference", "Rujukan pembaca surat", "string", "Bapak, Ibu, Saudara", "K", "SG-L5-08, R-17", "L3477, L4302-4304",
    { classNote: "Anda di manual internal; bukan kamu; tetap" }),
  pL("P11-17", "letter.requestToPeer", "Permintaan kepada setara", "string", "mohon", "K", "SG-L5-08", "L3479",
    { classNote: "bukan tolong; tetap" }),
  pL("P11-18", "letter.requestToSuperior", "Permintaan kepada atasan", "string", "berkenan, perkenan", "K", "SG-L5-08", "L3481",
    { classNote: "bukan mohon segera; tetap" }),
  pL("P11-19", "letter.closing", "Penutup surat", "string", "Atas perhatian Saudara, kami ucapkan terima kasih.", "K", "SG-L5-08", "L3483-3484",
    { classNote: "tetap" }),
  pL("P11-20", "doc.readerPronoun", "Kata ganti pembaca", "enum", "Anda", "B", "R-17", "L4302-4304",
    { enum: ["Anda", "Bapak/Ibu/Saudara"], classNote: "Anda (manual internal); Bapak/Ibu/Saudara (kanal resmi)" }),
  pL("P11-21", "lexicon.controlledGlossary", "Glosarium kendali", "map",
    {
      "nama produk, model, merek, nomor standar": "pertahankan apa adanya, ejaan konsisten",
      "protokol atau antarmuka berbentuk token teknis": "pertahankan dengan label manusia saat muncul pertama",
      "istilah umum berpadanan baku": "wajib padanan, bentuk asli di kurung sekali",
      "padanan belum mapan di bidang": "pertahankan, definisikan sekali, tanpa miring setengah hati",
      "idiom korespondensi Inggris": "konsistensi rumah dengan satu penutup kanonis",
      "pasangan sementara": "belum wajib; jangan diajarkan sebagai aturan",
    }, "K", "SG-L4-10", "L4940-4962; research/04 T148",
    { gapRef: "G-10", classNote: "Lampiran C.1: 6 kelas istilah dan perlakuannya; glosarium lengkap di standar induk (admin)" }),
  pL("P11-22", "lexicon.forbiddenClasses", "Kelas kata terlarang", "list",
    [
      "nama proses atau alat internal",
      "kode mentah dan sidik jari",
      "status mesin kapital",
      "jejak alamat berkas dan markup",
      "riwayat edisi di badan",
      "stempel korporat keliru",
      "kata peremeh dan kasar-metaforis",
    ], "K", "16.6", "L4144-4158", { gapRef: "G-11", classNote: "7 kelompok; daftar kata dari standar induk (admin)" }),
  pL("P11-23", "lexicon.blacklistA4.wordBoundary", "Daftar hitam A4 memakai batas kata", "bool", true, "K", "SG-L6-05", "L3570-3573",
    { classNote: "setiap pola baru membawa dua fixture regresi" }),
  pL("P11-24", "threshold.clausesPerSentenceAvg.max", "Plafon rata-rata klausa per kalimat", "number", 2.2, "K", "SG-L6-01, C-26", "L3670; research/04 T119",
    { classNote: "DIAGNOSIS; doc, etalase" }),
  pL("P11-25", "threshold.chainedSentencesPercent.max", "Plafon kalimat berantai (4 koma atau lebih)", "percent", 20, "K", "C-26", "L3673; research/04 T119",
    { classNote: "DIAGNOSIS; kalimat dengan >= 4 koma" }),
  pL("P11-26", "threshold.semicolonsPer1000Words.max", "Plafon titik-koma per 1.000 kata", "number", 5.4, "K", "C-26, SG-L3-09", "L3676, L3102; research/04 T119",
    { classNote: "DIAGNOSIS" }),
  pL("P11-27", "threshold.wordsPerSentenceAvg", "Koridor rata-rata kata per kalimat", "range", [18, 32], "K", "SG-L6-02, C-27", "L3680, L3549-3552; research/04 T119",
    { range: { min: 18, max: 32, step: 1 }, classNote: "DIAGNOSIS; kanal K2 panjang" }),
  pL("P11-28", "threshold.distinctOpenerRatio.min", "Lantai rasio pembuka kalimat berbeda", "number", 0.2, "K", "SG-L6-09", "L3684-3685; research/04 T119",
    { classNote: "DIAGNOSIS; dokumen > 2.000 kalimat, INFO" }),
  pL("P11-29", "threshold.decisionVerbArtifactSubject.max", "Plafon verba keputusan berpelaku artefak (per 1.000 kata)", "number", 2, "K", "SG-L6-10, C-28", "L3687-3688, L3606-3607; research/04 T119",
    { classNote: "DIAGNOSIS; laporan, proposal" }),
  pL("P11-30", "threshold.metaProcessToObjectRatio.max", "Plafon rasio meta-proses terhadap objek konkret", "number", 8, "K", "SG-L6-11, C-29", "L3690-3692; research/04 T119",
    { classNote: "DIAGNOSIS; seksi teknis, tanpa objek bidang" }),
  pL("P11-31", "threshold.schemaIdentifiersInProse.max", "Plafon identifier skema di prosa", "int", 0, "K", "SG-L6-12, C-30", "L3694; research/04 T119",
    { classNote: "DIAGNOSIS; doc, etalase" }),
  pL("P11-32", "threshold.inlineProvenanceMarks.max", "Plafon penanda provenans sebaris (per kata)", "ratio", 0.05, "K", "SG-L6-13, C-31", "L3696-3698; research/04 T119",
    { classNote: "DIAGNOSIS; 1 per 20 kata" }),
  pL("P11-33", "threshold.spellingVariantsPerValueClass.max", "Plafon varian ejaan per kelas nilai", "int", 1, "K", "SG-L6-14, C-33", "L3700; research/04 T119",
    { classNote: "DIAGNOSIS; 1 per berkas" }),
  pL("P11-34", "threshold.redundantCopiesNarrative", "Salinan berlebih lapisan narasi", "object",
    { layer: "narasi", whitelist: ["blok tanda tangan", "kepala turunan", "baris notasi"], check: "C-14" }, "K", "SG-L6-04, C-14", "L3703, L3565-3568; research/04 T119",
    { classNote: "DIAGNOSIS; lapisan narasi, boilerplate dikecualikan (daftar putih C-14)" }),
  pL("P11-35", "jury.dimensions", "Dimensi juri", "list", ["kejelasan", "kedalaman", "kematangan susunan", "penjaga pola"], "K", "SG-L6-16", "L3717-3724",
    { classNote: "skala 1-5; tetap" }),
  pL("P11-36", "jury.threshold.saring", "Ambang SARING", "object",
    { meanDimensions1to3Min: 4, noDimension1to3AtOrBelow: 2, dimension4Min: 3 }, "K", "14.4", "L3730-3731; research/04 T120",
    { rek: true, conflictRef: "K-26", classNote: "rata-rata dimensi 1-3 >= 4; tidak ada dimensi 1-3 <= 2; dimensi 4 >= 3" }),
  pL("P11-37", "jury.threshold.lepas", "Ambang LEPAS", "object",
    { dimension1Min: 4, dimension2Min: 4, dimension3Min: 4, dimension4Min: 3, adjudicators: 2 }, "K", "14.4", "L3706-3707, L3733-3734; research/04 T120",
    { rek: true, conflictRef: "K-26", classNote: "dimensi 1, 2, 3 masing-masing >= 4 dan dimensi 4 >= 3, adjudikasi dua juri; satu-satunya pintu rilis" }),
  pL("P11-38", "jury.minJudges", "Jumlah juri minimum", "int", 2, "K", "14.5-14.6", "L3756-3762, L3781-3782",
    { range: { min: 2, step: 1 }, classNote: "2 independen, bukan penulis" }),
  pL("P11-39", "jury.adjudicationDiffPoints", "Selisih poin naik adjudikasi", "int", 2, "K", "14.4-14.5", "L3739, L3760-3761",
    { classNote: "selisih >= 2 naik ke adjudikator ketiga" }),
  pL("P11-40", "jury.snippetWords", "Panjang cuplikan juri (kata)", "range", [150, 600], "K", "14.6", "L3781-3782",
    { range: { min: 150, max: 600, step: 10 }, classNote: "tanpa alamat, nama, angka alat" }),
  pL("P11-41", "prose.emDash", "Batas tanda pisah panjang", "object", { maxPer1000Words: 0, inHeadings: 0 }, "K", "DT-38, SG-L3-09, lint 03", "L2830-2831, L3942-3944",
    { conflictRef: "K-09", classNote: "K (konflik K-09): D-22 KT-06 = 0 per 1.000 kata dan 0 di judul (kode Garis A); manual 3 per 1.000 kata; hanya memengaruhi status rilis" }),
  pL("P11-42", "sentence.sehinggaMaxPerSentence", "Maks. 'sehingga' per kalimat", "int", 1, "K", "SG-L3-09", "L3210-3213",
    { classNote: "konsekuensi berikutnya kalimat baru" }),
  pL("P11-43", "prose.capsEmphasis.policy", "Kebijakan penekanan kapital", "enum", "rare", "B", "SG-L4-02", "L3279-3283",
    { enum: ["rare"], classNote: "hanya negasi, kekekalan, larangan berisiko" }),
  pL("P11-44", "prose.englishTerms.decorativeItalic", "Miring dekoratif istilah Inggris", "bool", false, "K", "SG-L4-04", "L3293-3300",
    { classNote: "padanan lazim jadi kepala, asli dalam kurung sekali" }),
];

// ── P15 Bab 15: workbook dan command brief (31, nonaktif A5/D-05) ────────

const p15 = maker("P15", "Bab 15", true);

const P15: ParamDef[] = [
  p15("P15-01", "workbook.sheetClasses", "Kelas sheet workbook", "list",
    [
      { sheet: "COVER", kelas: "Tampilan", fungsi: "Identitas dan angka kunci, semuanya lewat rujukan" },
      { sheet: "PETUNJUK", kelas: "Kendali", fungsi: "Kunci warna, peta sheet, batas model BTS-nn" },
      { sheet: "KENDALI", kelas: "Kendali", fungsi: "Pemeriksaan silang dan bendera induk" },
      { sheet: "RINGKASAN EKSEKUTIF", kelas: "Tampilan", fungsi: "Angka kunci dengan satuan dan provenans" },
      { sheet: "REKAPITULASI", kelas: "Tampilan", fungsi: "Nilai per bab, PPN, total, terbilang" },
      { sheet: "RAB", kelas: "Tampilan", fungsi: "Daftar kuantitas dan harga" },
      { sheet: "AHS", kelas: "Dasar harga", fungsi: "Analisa harga satuan, Permen PUPR 8/2023" },
      { sheet: "HITUNG-nama", kelas: "Hitung", fungsi: "Satu domain per sheet; satu-satunya rumah konstanta" },
    ], "K", "DT-40", "L3830-3847; research/04 T127",
    { rek: true, conflictRef: "K-33", gapRef: "G-06", classNote: "8 kelas; pasangan sheet-fungsi dikonfirmasi Tabel 15.1" }),
  p15("P15-02", "workbook.numeralColour.constant", "Warna numeral konstanta", "tokenRef", "signal", "K", "DT-40", "L3854",
    { classNote: "konstanta diketik tangan" }),
  p15("P15-03", "workbook.numeralColour.crossSheetRef", "Warna numeral rujukan lintas sheet", "tokenRef", "verd", "K", "DT-40", "L3856"),
  p15("P15-04", "workbook.numeralColour.formula", "Warna numeral rumus", "tokenRef", "ink900", "K", "DT-40", "L3858"),
  p15("P15-05", "workbook.numeralColour.externalLink", "Warna numeral tautan eksternal", "tokenRef", "alert", "K", "DT-40", "L3860"),
  p15("P15-06", "workbook.petunjuk.sections", "Bagian wajib sheet PETUNJUK", "list",
    ["kunci warna dengan contoh", "struktur workbook", "daftar bernomor batas dan kelemahan model"], "K", "DT-40", "L3864-3865",
    { classNote: "3 wajib" }),
  p15("P15-07", "workbook.kendali.minChecks", "Jumlah minimum pemeriksaan KENDALI", "int", 5, "K", "DT-40", "L3866-3867",
    { range: { min: 5, step: 1 } }),
  p15("P15-08", "workbook.kendali.checks", "Pemeriksaan KENDALI", "list",
    ["jumlah silang", "PPN", "total", "AHS ke RAB", "uji nol"], "K", "DT-40", "L3866-3868",
    { classNote: "masing-masing selisih, vonis, dasar" }),
  p15("P15-09", "workbook.kendali.passTolerance", "Toleransi lulus KENDALI", "number", 0.5, "K", "15.1", "L3879",
    { classNote: "ABS(Cn) < 0,5 menjadi LULUS" }),
  p15("P15-10", "workbook.masterFlag.text", "Teks bendera induk", "pair", ["SELURUH UJI LULUS", "ADA UJI YANG GAGAL, JANGAN TERBITKAN"], "K", "15.1", "L3867-3869, L3875-3877",
    { classNote: "di panel beku" }),
  p15("P15-11", "workbook.mergedCellsInComputationZone", "Sel gabungan di zona komputasi", "bool", false, "K", "lint 20", "L3869, L3978"),
  p15("P15-12", "workbook.print", "Pengaturan cetak workbook", "object",
    { paper: "A4", fitToWidth: true, repeatHeaderRows: true, gridlines: false, registerBlockFooter: true }, "K", "15.1", "L3869-3871",
    { classNote: "A4, muat lebar, baris kepala berulang, gridline mati, kaki blok register" }),
  p15("P15-13", "workbook.unitPerNumericColumn", "Satuan per kolom numerik", "bool", true, "K", "Gaya Ahli kanal workbook", "L3884-3886"),
  p15("P15-14", "workbook.emptyCellNeedsNote", "Sel kosong wajib catatan", "bool", true, "K", "Gaya Ahli kanal workbook", "L3885-3886"),
  p15("P15-15", "workbook.derivedByFormula", "Angka turunan lewat rumus", "bool", true, "K", "Gaya Ahli kanal workbook", "L3886"),
  p15("P15-16", "workbook.fontShipping", "Pengiriman fon workbook", "object",
    { folder: "assets/fonts", notice: "PASANG-DULU.txt", embeddable: false }, "K", "DT-09", "L474, L675-676",
    { classNote: "fon tidak bisa ditanam" }),
  p15("P15-17", "workbook.modelLimit.id.pattern", "Pola ID batas model", "string", "BTS-{nn}", "K", "Tabel 15.1", "L3833"),
  p15("P15-18", "workbook.constants.onlyInHitungSheets", "Konstanta hanya di sheet HITUNG", "bool", true, "K", "Tabel 15.1", "L3839"),
  p15("P15-19", "brief.slideSizeMm", "Ukuran slide brief (mm)", "pair", [338.7, 190.5], "K", "DT-41", "L3892", { classNote: "16:9" }),
  p15("P15-20", "brief.master", "Master brief", "enum", "light", "B", "DT-41, DT-05", "L3892-3893, L4399",
    { enum: ["light", "dark"], classNote: "dark hanya bila diminta" }),
  p15("P15-21", "brief.headline.isClaim", "Headline adalah klaim", "bool", true, "K", "DT-41", "L3894-3895, L3900-3910",
    { classNote: "klaim, bukan topik" }),
  p15("P15-22", "brief.ideasPerSlide", "Gagasan per slide", "int", 1, "K", "DT-41", "L3895"),
  p15("P15-23", "brief.bodyWordsMax", "Maks. kata badan per slide", "int", 55, "B", "DT-41", "L3895-3896",
    { range: { max: 55, step: 1 }, classNote: "kira-kira 55" }),
  p15("P15-24", "brief.sourceLineOnNumberSlides", "Baris sumber pada slide berangka", "bool", true, "K", "DT-41", "L3896-3897"),
  p15("P15-25", "brief.closing", "Penutup dek", "object", { requestedDecision: true, keyNumbers: 4, neverThankYou: true }, "K", "DT-41", "L3897-3898",
    { classNote: "keputusan yang diminta + empat angka; tidak pernah \"Terima kasih\"" }),
  p15("P15-26", "brief.forbidden", "Larangan brief", "list",
    ["animasi masuk", "transisi", "logo tiap slide", "foto stok", "set ikon", "gradien", "bayangan", "sudut membulat", "aksen kedua"], "K", "DT-41", "L3912-3914"),
  p15("P15-27", "brief.bullets.max", "Maks. butir poin", "int", 5, "K", "DT-41", "L3913", { range: { max: 5, step: 1 } }),
  // R01 (F-023): "list" + enum = multi-pilih; sebelumnya "enum".
  p15("P15-28", "brief.slidePatterns", "Pola slide", "list",
    ["claimNumberBlock", "chartOneAccent", "specTable3Col", "assumption", "request"], "B", "DT-41", "L3914-3916",
    { enum: ["claimNumberBlock", "chartOneAccent", "specTable3Col", "assumption", "request"], classNote: "himpunan 5 pola; default = semuanya" }),
  p15("P15-29", "brief.speakerNotes.evidenceWithMarks", "Catatan pembicara memuat bukti bertanda", "bool", true, "K", "DT-41", "L3916-3917"),
  p15("P15-30", "brief.speakerNotes.oneSentencePerChart", "Satu kalimat per chart di catatan", "bool", true, "K", "SG-L2-06", "L3917-3918"),
  p15("P15-31", "brief.marginMm", "Margin brief (mm)", "mm", null, "B", "E-22", "L4388",
    { unreadable: true, gapRef: "G-04", conflictRef: "K-16", classNote: "B (celah G-04): [TAK TERBACA]; token lama 9 mm, referensi 18 mm (E-22); tokens.json v2.0.0 tidak memuat margin brief" }),
];

// ── P16 Bab 16: gerbang rilis (8) ────────────────────────────────────────

const p16 = maker("P16", "Bab 16");

const P16: ParamDef[] = [
  p16("P16-01", "gate.lintFailureBlocksRelease", "Kegagalan lint menahan rilis", "bool", true, "K", "DT-42", "L3931, L4647"),
  p16("P16-02", "gate.lintRegistry", "Registri lint", "list",
    Array.from({ length: 39 }, (_, i) => `DATUM-${String(i + 1).padStart(2, "0")}`), "K", "16.1", "L3936-4021, LT36-74; research/04 T133",
    { rek: true, conflictRef: "K-10", classNote: "39 pemeriksaan (kode; manual menulis 38) dengan batas dan tahap; definisi di registry/lint.ts" }),
  p16("P16-03", "gate.stepsByTier", "Langkah gerbang per tier", "list",
    [
      { no: 1, check: "sisir sendiri", tool: "Penulis", tiers: ["NOTA", "TERBIT", "SERAH"] },
      { no: 2, check: "penjaga titik panggil saat bangun", tool: "datumcheck.py", tiers: ["TERBIT", "SERAH"] },
      { no: 3, check: "lint gambar saat bangun", tool: "datum_diagram.py, datum_render.py", tiers: ["TERBIT", "SERAH"] },
      { no: 4, check: "pemeriksaan mekanik naskah dan jejak mesin per kanal", tool: "lint_mutu.py, scan_ai_footprint.py", tiers: ["TERBIT", "SERAH"] },
      { no: 5, check: "lint berkas DATUM", tool: "datum_lint.py", tiers: ["TERBIT", "SERAH"] },
      { no: 6, check: "audit pengikatan angka", tool: "datumbind audit_docx, audit_retired", tiers: ["SERAH"] },
      { no: 7, check: "pemeriksaan mata", tool: "Pemeriksa", tiers: ["TERBIT", "SERAH"] },
      { no: 8, check: "penilaian juri buta", tool: "Dua juri bukan penulis", tiers: ["SERAH"] },
      { no: 9, check: "pemeriksaan independen dan uji fotokopi", tool: "Pemeriksa bukan penulis dan bukan juri", tiers: ["SERAH"] },
      { no: 10, check: "serah dan rekam", tool: "ARSIP, LOKUS, KRONIK", tiers: ["NOTA", "TERBIT", "SERAH"] },
    ], "K", "Tabel 16.2", "L4040-4079; research/04 T134",
    { conflictRef: "K-29", classNote: "10 langkah; uji fotokopi: wajib SERAH, anjuran TERBIT (K-29)" }),
  p16("P16-04", "gate.callSiteGuards", "Penjaga titik panggil", "list", ["G1", "G2", "G3", "N1", "03", "04", "09", "10", "16"], "K", "16.2", "L4025-4031",
    { classNote: "[G1, G2, G3, N1] + ulang pemeriksaan 03, 04, 09, 10, 16" }),
  p16("P16-05", "gate.manualChecklist", "Daftar pemeriksaan manual 16.4", "list",
    [
      "Cetak 100 %, fotokopi dua kali, baca dari 40 cm.",
      "Setiap headline brief adalah klaim, dan tidak ada judul laporan berbentuk pertanyaan.",
      "Rel bukti jujur: kosong bila memang tidak ada yang perlu dikatakan.",
      "Setiap turunan ditutup dengan akibat bila asumsinya gagal.",
      "Setiap regulasi yang dikutip adalah yang berlaku, dan setiap edisi standar adalah edisi pada Tabel 10.1.",
      "Terbilang cocok dengan angka di atasnya.",
      "Logo muncul tepat di satu halaman.",
      "ID persyaratan, kuantitas, dan total cocok di seluruh paket.",
      "Di setiap diagram, setiap kotak adalah komponen nyata dan setiap garis antarmuka nyata.",
      "Setiap chart lolos uji lima detik oleh orang yang tidak ikut membuatnya.",
    ], "K", "16.4", "L4081-4098", { classNote: "10 butir" }),
  p16("P16-06", "gate.channelRoutes", "Rute gerbang per kanal", "map",
    {
      chat: { gate: "pemindai kanal chat", passWhen: "jawaban di baris pertama; nol pelanggaran absolut" },
      suratDinas: { gate: "langkah 1, 4, 7", passWhen: "sapaan benar; satu usul yang bisa dijawab" },
      dokumenProposal: { gate: "langkah 1 sampai 10 sesuai tier", passWhen: "lint 27 dari 27; LEPAS untuk SERAH" },
      dek: { gate: "langkah 1, 3, 5, 7", passWhen: "setiap slide satu klaim; lint dek bersih" },
      notifikasi: { gate: "pemindai kanal notifikasi", passWhen: "pembaca tahu langkah berikutnya tanpa membuka kanal lain" },
      workbook: { gate: "langkah 2, 5, 7", passWhen: "bendera induk SELURUH UJI LULUS" },
      chart: { gate: "langkah 3, 7", passWhen: "dua belas butir 8.6 tercentang" },
      gambarTeknik: { gate: "langkah 3, 7", passWhen: "lint bangun bersih; legenda ada" },
    }, "K", "16.5", "L4102-4140; research/04 T135",
    { conflictRef: "K-30", classNote: "8 kanal (Tabel 16.3), bukan 7" }),
  p16("P16-07", "gate.colophon.honestStatement", "Pernyataan jujur di kolofon", "bool", true, "K", "14.6, 16.6", "L3787-3788, L4157",
    { classNote: "satu kalimat berbahasa pembaca; hasil periksa disimpan sebagai register, bukan ditempel" }),
  p16("P16-08", "gate.pdf.checkPageBeforeRelease", "Periksa halaman PDF sebelum rilis", "bool", true, "K", "3.3", "L488", { classNote: "--check-page" }),
];

// ── PA-PD Lampiran A-D (4) ───────────────────────────────────────────────

const pA = maker("PA", "Lampiran");
const pB = maker("PB", "Lampiran");
const pC = maker("PC", "Lampiran");
const pD = maker("PD", "Lampiran");

const PAPD: ParamDef[] = [
  pA("PA-01", "rules.index", "Indeks aturan", "list", ["DT-01..DT-44", "CH-01..CH-14", "SM-01..SM-12", "SG-L0..L6 (68)"], "K", "-", "L4545-4874",
    { classNote: "dengan kolom rumah" }),
  pB("PB-01", "checklist.preSerah.items", "Daftar periksa pra-serah", "list",
    [
      { item: "Tier ditetapkan dengan uji satu kalimat; nomor diambil dari Register Induk", rules: "DT-02, DT-04" },
      { item: "Kanal dan audiens ditetapkan; urutan pembuka sesuai kanal", rules: "SG-L0-05" },
      { item: "Halaman pertama: jenis dokumen, penyusun, kebutuhan, satu jangkar terukur", rules: "SG-L0-01, L0-02" },
      { item: "Klasifikasi sesuai skema penerima; regulasi yang dikutip hidup", rules: "DT-28, DT-29" },
      { item: "Angka beban terikat ke register dan bertanda; tanda maks. sekali per klausa", rules: "DT-21 sampai DT-23" },
      { item: "Setiap tabel dan gambar: caption, SUMBER, dipanggil di prosa", rules: "DT-15" },
      { item: "Tabel: garis mendatar, kolom satuan, numeral mono, tanpa isian", rules: "DT-16, DT-17" },
      { item: "Chart: pertanyaan satu kalimat, satu aksen, caption kesimpulan, mulai nol", rules: "CH-01 sampai CH-07" },
      { item: "Gambar teknik dari spec; labels_verified true; satu dialek; legenda", rules: "DT-35, DT-39, SM-04" },
      { item: "Satuan berspasi, ± berarti, numeral Indonesia, satu varian per berkas", rules: "DT-30, SG-L4-06" },
      { item: "Kalimat berpredikat; titik-koma maks. 5,4 per 1.000 kata; ritme berselang", rules: "SG-L3-08, L3-09" },
      { item: "Pelaku keputusan manusia; tanpa identifier skema di prosa", rules: "SG-L4-01, L4-03" },
      { item: "Sapaan institusional di kanal resmi; tanpa kamu", rules: "SG-L5-08" },
      { item: "Momen pembalik di badan dokumen tebal", rules: "SG-L1-10" },
      { item: "Penutup menyebut aksi dan penerima", rules: "SG-L0-03" },
      { item: "datumcheck bersih; lint berkas 27 dari 27; lint bangun bersih", rules: "DT-42" },
      { item: "SERAH: audit angka, dua juri buta mencapai LEPAS, pemeriksa independen", rules: "14.6, 16.3" },
      { item: "Uji fotokopi: cetak 100 %, fotokopi dua kali, baca 40 cm", rules: "DT-11, DT-34" },
      { item: "Nama berkas sama dengan judul, tanpa garis bawah; catatan perubahan ditulis", rules: "DT-12" },
      { item: "Kolofon: pernyataan jujur berbahasa pembaca", rules: "16.6" },
    ], "K", "Lampiran B", "L4879-4931; research/04 T147",
    { classNote: "20 butir dengan pemetaan aturan dan bendera SERAH (5.2)" }),
  pC("PC-01", "glossary.termClasses", "Kelas istilah glosarium", "list",
    [
      "nama produk, model, merek, nomor standar",
      "protokol atau antarmuka berbentuk token teknis",
      "istilah umum berpadanan baku",
      "padanan belum mapan di bidang",
      "idiom korespondensi Inggris",
      "pasangan sementara",
    ], "K", "-", "L4940-4962", { classNote: "6 kelas" }),
  pD("PD-01", "sourceRegister.columns", "Kolom daftar sumber", "list",
    ["DOKUMEN", "VERSI/TANGGAL", "BAHASA/HALAMAN", "KLASIFIKASI", "DIPAKAI DI"], "B", "-", "L5008-5030; research/04 T150"),
];

export const PARAMS_GOVERNANCE_LANGUAGE: readonly ParamDef[] = [...P1, ...P3, ...P11, ...P15, ...P16, ...PAPD];

/** Hitungan target katalog; isi larik wajib sama dengan angka ini setelah S04. */
export const PARAMS_GOVERNANCE_LANGUAGE_COUNT = 115;
