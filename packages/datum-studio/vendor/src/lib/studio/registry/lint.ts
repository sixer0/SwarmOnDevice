/**
 * Registri lint Studio (01_specs.md §5.1 T07, §5.4; S10).
 *
 * 103 LintDef = 87 otomatis (A 39 DATUM + B 4 guard + C 19 pemindai bahasa +
 * D 25 struktur: D01-D21 + LD-01..LD-04 lint rilis struktur v2) + 16
 * pemeriksaan manusia (H01-H16).
 * Sumber isi: research/01_manual_parameter_catalog.md §5 (tier), §6.1-§6.3
 * (butir, batas, tahap, mode HQ). Acuan perilaku (read-only): datum_lint.py
 * (CHECKS DATUM-01..39) dan datumcheck.py (GUARD-G1/G2/G3/N1).
 *
 * Konvensi:
 *  - hqMode S = dijamin skema saat menyusun, R = dihitung setelah render,
 *    X = pemindaian teks, M = butuh mata (§6.1).
 *  - module menunjuk modul mesin pemilik: X -> scan (S44), R -> render (S45),
 *    S dan D -> structure (S46), C -> language (S47), H -> human.
 *  - Entri dengan `notRunReason` = alat/algoritma tidak tersedia di HQ (KT-13,
 *    G-07): pelari wajib melapor NOT_RUN dengan alasan itu, bukan PASS.
 *    `isLintImplemented(def)` = tidak ada `notRunReason`; grup H selalu
 *    manusia (tidak dijalankan mesin) sehingga tidak diberi `notRunReason`.
 *  - blocksIngest (A10): true untuk grup B dan butir A yang mode HQ-nya
 *    memuat S (by-construction), ditambah DATUM-04, DATUM-31, DATUM-38 (X).
 *    DATUM-03 (em dash, pengecualian benchmark) dan DATUM-36 (lapor saja)
 *    false.
 *  - tiers: lint wajib TERBIT dan SERAH, dilepas di NOTA (Tabel 3.1 P3-08;
 *    Tabel 16.2 langkah 2-5, 7). Audit angka D01-D03, D07 dan H08/H09 hanya
 *    SERAH (langkah 6, 8, 9; P5-46, P5-47).
 */
import type { LintGroup } from "../contract/enums";
import type { LintDef } from "../contract/types/params";

export type { LintDef };

type Tier = LintDef["tiers"][number];
type Stage = LintDef["stage"];
type HqMode = LintDef["hqMode"][number];
type Module = LintDef["module"];

const TERBIT_SERAH: readonly Tier[] = ["TERBIT", "SERAH"];
const SERAH_ONLY: readonly Tier[] = ["SERAH"];

/**
 * Alasan NOT_RUN grup C (KT-13). Alat induk bernama pada Tabel 16.2 langkah 4
 * (research/04 T134): lint_mutu.py dan scan_ai_footprint.py; algoritmanya
 * tidak dikirim bersama skill DATUM (research/01 G-07, L3797).
 */
const NOT_RUN_LANGUAGE =
  "G-07/KT-13: algoritma pemindai tidak tersedia di HQ (alat induk lint_mutu.py, scan_ai_footprint.py; Tabel 16.2 langkah 4). ";

// ── A. Lint DATUM 01-39 (research/01 §6.1; datum_lint.py CHECKS) ──────────

type RowA = readonly [
  no: number,
  title: string,
  limit: string,
  stage: Stage,
  hqMode: readonly HqMode[],
  ruleRef: string,
  module: Module,
  blocksIngest: boolean,
  partial?: boolean,
  paramRef?: string,
];

const ROWS_A: readonly RowA[] = [
  [1, "Deret KPI tile, strip statistik", "0", "file", ["S"], "DT-38, CH-13", "structure", true],
  [2, "Kotak callout berisi warna", "0", "file", ["S"], "DT-20", "structure", true],
  [
    3,
    "Tanda pisah panjang per 1.000 kata; nol di judul",
    "0 per 1.000 kata, 0 di judul (KT-06; manual: maks. 3)",
    "file",
    ["X"],
    "DT-38",
    "scan",
    false,
    false,
    "prose.emDash",
  ],
  [4, "Judul berbentuk pertanyaan", "0", "file", ["X"], "DT-38", "scan", true],
  [5, "Fon bawaan Office", "0", "file", ["S"], "DT-08", "structure", true],
  [6, "Sampul di tengah", "0", "file", ["S"], "DT-14", "structure", true],
  [7, "Garis tegak di tabel", "0", "file", ["S"], "DT-16", "structure", true],
  [8, "Baris kepala tabel berisi warna", "0", "eye", ["S", "M"], "DT-16", "structure", true],
  [9, "Tabel data tanpa kolom satuan", "0", "file", ["S"], "DT-17", "structure", true],
  [10, "Tabel atau gambar tanpa SUMBER", "0", "file", ["S"], "DT-15", "structure", true],
  [11, "Angka beban keputusan tanpa tanda", "0", "file", ["S", "X"], "DT-21", "structure", true],
  [12, "Warna dekoratif", "0", "eye", ["S", "M"], "DT-06", "structure", true, true],
  [13, "Chart dirasterisasi", "0", "eye", ["S", "M"], "DT-36", "structure", true],
  [14, "Nilai warna terlihat pada satu halaman", "maks. 5", "file", ["R"], "DT-06", "render", false, false, "color.maxValuesPerPage"],
  [15, "Ukuran baris badan", "66-80 karakter", "eye", ["R", "M"], "DT-10", "render", false],
  [16, "Nilai dan satuan tanpa spasi", "0", "file", ["X"], "DT-30", "scan", false],
  [17, "± tanpa arti", "0", "file", ["X"], "DT-30", "scan", false],
  [18, "Klasifikasi salah untuk penerima", "0", "file", ["S"], "DT-28", "structure", true],
  [19, "PPN selain 11 % non-mewah 2026", "0", "file", ["S", "X"], "DT-31", "scan", true],
  [20, "Sel gabungan di zona komputasi", "0", "file", ["S"], "DT-40", "structure", true],
  [21, "Garis < 0,18 mm atau rona < 15 %", "0", "file", ["S"], "DT-11", "structure", true],
  [22, "Klaim eksternal tanpa Admiralty", "0", "file", ["S"], "DT-25", "structure", true],
  [23, "Sudut membulat di luar terminator", "0", "file", ["S"], "DT-37", "structure", true],
  [24, "Penghubung tanpa label", "0", "build", ["S"], "DT-37", "structure", true],
  [25, "Nilai warna pada satu gambar", "maks. 5", "file", ["S", "R"], "DT-06", "render", true],
  [26, "Subjek beraksen pada satu gambar", "maks. 1", "build", ["S"], "DT-37", "structure", true],
  [27, "Garis diagram < 0,18 mm", "0", "file", ["S"], "DT-11", "structure", true],
  [28, "Huruf diagram < 5,5 pt", "0", "file", ["R"], "Tabel 10.7", "render", false],
  [29, "Gambar tanpa SUMBER", "0", "file", ["S"], "DT-15", "structure", true],
  [30, "Gambar tanpa nomor atau caption", "0", "file", ["S"], "DT-15", "structure", true],
  [31, "Sumber Mermaid dalam berkas terbit", "0", "file", ["X"], "DT-35", "scan", true],
  [32, "Penghubung melewati kotak tak terkait", "0", "build", ["R"], "9.3", "render", false],
  [33, "Gambar lebih tinggi dari blok 247 mm", "0", "build", ["R"], "9.4", "render", false],
  [34, "Tanda rumah tanpa legenda", "0", "build", ["S"], "SM-03", "structure", true],
  [35, "Lebih dari satu dialek per gambar", "0", "build", ["S"], "SM-04", "structure", true],
  [36, "Aparatus didelegasikan ke halaman", "lapor", "file", ["S"], "9.4", "structure", false],
  [37, "Lembar melewati halaman A4", "0", "build", ["R"], "9.4", "render", false],
  [
    38,
    "Garis bawah di nama berkas, folder, sheet",
    "0",
    "file",
    ["X"],
    "DT-12",
    "scan",
    true,
    false,
    "naming.underscore.allowed",
  ],
  [39, "Residu rentang token tertelan (kode saja)", "0", "file", ["X"], "SK140, SK321-342, LT74", "scan", false],
];

function defA(row: RowA): LintDef {
  const [no, title, limit, stage, hqMode, ruleRef, module, blocksIngest, partial, paramRef] = row;
  return {
    id: `DATUM-${String(no).padStart(2, "0")}`,
    group: "A",
    title,
    limit,
    stage,
    hqMode,
    partial: partial === true,
    ruleRef,
    tiers: TERBIT_SERAH,
    blocksIngest,
    module,
    ...(paramRef ? { paramRef } : {}),
  };
}

// ── B. Penjaga titik panggil datumcheck (research/01 §6.2; datumcheck.py) ──

const GROUP_B: readonly LintDef[] = [
  {
    id: "G1",
    group: "B",
    title: "Setiap baris tabel sama cacah selnya dengan kepala (GUARD-G1)",
    limit: "0",
    stage: "guard",
    hqMode: ["S"],
    partial: false,
    ruleRef: "16.2 L4025-4031; datumcheck.py table_guards",
    tiers: TERBIT_SERAH,
    blocksIngest: true,
    module: "scan",
  },
  {
    id: "G2",
    group: "B",
    title: "Jumlah lebar kolom 128 mm atau 166 mm (GUARD-G2)",
    limit: "128 atau 166 mm, toleransi 0,05 mm",
    stage: "guard",
    hqMode: ["S"],
    partial: false,
    ruleRef: "16.2 L4025-4031; datumcheck.py table_guards (G-DQ-06)",
    tiers: TERBIT_SERAH,
    blocksIngest: true,
    module: "scan",
  },
  {
    id: "G3",
    group: "B",
    title: "Teks sel muat lebar kolomnya (GUARD-G3; sub-cek G4 lantai lebar kolom numerik)",
    limit: "0 sel meluap; G4: lebar kolom numerik >= lantai",
    stage: "guard",
    hqMode: ["X"],
    partial: false,
    ruleRef: "16.2 L4025-4031; datumcheck.py table_guards; research/03:164 (G4)",
    tiers: TERBIT_SERAH,
    blocksIngest: true,
    module: "scan",
  },
  {
    id: "N1",
    group: "B",
    title: "Garis bawah pada nama berkas, folder, atau sheet (GUARD-N1)",
    limit: "0",
    stage: "guard",
    hqMode: ["X"],
    partial: false,
    ruleRef: "16.2 L4025-4031; DT-12; datumcheck.py name_guard",
    tiers: TERBIT_SERAH,
    blocksIngest: true,
    module: "scan",
    paramRef: "naming.underscore.allowed",
  },
];

// ── C. Pemindai bahasa (research/01 §6.2 grup C, §3.9; KT-13, G-07) ───────

type RowC = readonly [
  id: string,
  title: string,
  limit: string,
  ruleRef: string,
  paramRef: string | undefined,
  notRunDetail: string | undefined,
];

const ROWS_C: readonly RowC[] = [
  [
    "C-14",
    "Salinan narasi berlebih",
    "lapisan narasi; boilerplate dikecualikan (daftar putih C-14)",
    "SG-L6-04, SG-L1-09",
    "threshold.redundantCopiesNarrative",
    "daftar putih boilerplate dan definisi salinan berlebih tidak tercantum di manual.",
  ],
  [
    "C-20",
    "Sapaan institusional",
    "sapaan surat memakai bentuk baku P11-13..P11-19 (bukan Halo, Hai, Kepada Yth.)",
    "SG-L5-08, SG-L6-06",
    "letter.salutation.address",
    undefined,
  ],
  [
    "C-21",
    "Artefak yatim",
    "0",
    "SG-L2-06",
    undefined,
    "definisi artefak yatim tidak tercantum di manual.",
  ],
  [
    "C-24",
    "Momen pembalik",
    "ada dalam jendela 0,25-0,75 dokumen (dokumen bersistem bab, proposal tebal)",
    "SG-L1-10, SG-L6-07",
    "doc.pivotMoment.window",
    "kriteria deteksi momen pembalik tidak tercantum (hanya jendela posisi).",
  ],
  [
    "C-26a",
    "Klausa per kalimat",
    "rata-rata maks. 2,2 (doc, etalase)",
    "SG-L6-01, SG-L3-09",
    "threshold.clausesPerSentenceAvg.max",
    "definisi klausa tidak tercantum di manual.",
  ],
  [
    "C-26b",
    "Kalimat berantai",
    "maks. 20 % kalimat dengan >= 4 koma",
    "SG-L6-01, SG-L3-09",
    "threshold.chainedSentencesPercent.max",
    undefined,
  ],
  [
    "C-26c",
    "Titik-koma",
    "maks. 5,4 per 1.000 kata",
    "SG-L6-01, SG-L3-09",
    "threshold.semicolonsPer1000Words.max",
    undefined,
  ],
  [
    "C-27",
    "Kata per kalimat",
    "rata-rata 18-32 (kanal K2 panjang)",
    "SG-L6-02",
    "threshold.wordsPerSentenceAvg",
    undefined,
  ],
  [
    "C-28",
    "Subjek keputusan",
    "maks. 2 per 1.000 kata (laporan, proposal)",
    "SG-L6-10, SG-L4-01",
    "threshold.decisionVerbArtifactSubject.max",
    "daftar kata kerja keputusan dan pola subjek-artefak tidak tercantum di manual.",
  ],
  [
    "C-29",
    "Objek bidang",
    "rasio meta-proses terhadap objek maks. 8 (seksi teknis)",
    "SG-L6-11, SG-L2-01",
    "threshold.metaProcessToObjectRatio.max",
    "kosakata meta-proses dan objek bidang tidak tercantum di manual.",
  ],
  [
    "C-30",
    "Identifier skema dalam prosa",
    "0 (doc, etalase)",
    "SG-L6-12, SG-L4-03",
    "threshold.schemaIdentifiersInProse.max",
    "pola identifier skema tidak tercantum di manual.",
  ],
  [
    "C-31",
    "Densitas tanda provenans",
    "maks. 1 per 20 kata",
    "SG-L6-13, SG-L1-04, SG-L3-05",
    "threshold.inlineProvenanceMarks.max",
    undefined,
  ],
  [
    "C-33",
    "Konvensi numerik",
    "maks. 1 varian per kelas nilai per berkas (tanggal, ribuan, Rp, persen)",
    "SG-L6-14, SG-L4-06",
    "threshold.spellingVariantsPerValueClass.max",
    "definisi varian ejaan per kelas nilai tidak tercantum di manual.",
  ],
  [
    "C-34",
    "Kamu dan Yth.",
    "tanpa kamu; sapaan Yth. Bapak/Ibu/Saudara + jabatan",
    "SG-L5-08, SG-L6-06, R-17",
    "letter.readerReference",
    undefined,
  ],
  [
    "C-INFO-OPENER",
    "Rasio pembuka kalimat berbeda (INFO)",
    "min. 0,20 pada dokumen > 2.000 kalimat; dilaporkan INFO",
    "SG-L6-09",
    "threshold.distinctOpenerRatio.min",
    undefined,
  ],
  [
    "C-A4",
    "Daftar hitam batas kata A4",
    "0 pada batas kata; tiap pola baru membawa dua fixture regresi",
    "SG-L6-05, SG-L4-09",
    "lexicon.blacklistA4.wordBoundary",
    "isi daftar hitam A4 tidak tercantum di manual.",
  ],
  [
    "C-16.6",
    "Tujuh kelas kata terlarang",
    "0",
    "16.6 L4144-4158",
    "lexicon.forbiddenClasses",
    "daftar kata per kelas terlarang tidak tercantum di manual.",
  ],
  [
    "C-SG-L2-09",
    "Cacah kata per paragraf",
    "maks. 150 kata (plafon bantu)",
    "SG-L2-09",
    "paragraph.maxWords",
    undefined,
  ],
  [
    "C-SG-L2-04",
    "Butir bernomor bila lebih dari 3",
    "daftar > 3 butir wajib bernomor",
    "SG-L2-04",
    "list.numberedWhenItemsGreaterThan",
    undefined,
  ],
];

function defC(row: RowC): LintDef {
  const [id, title, limit, ruleRef, paramRef, notRunDetail] = row;
  return {
    id,
    group: "C",
    title,
    limit,
    stage: "file",
    hqMode: ["X"],
    partial: false,
    ruleRef,
    tiers: TERBIT_SERAH,
    blocksIngest: false,
    module: "language",
    ...(paramRef ? { paramRef } : {}),
    ...(notRunDetail ? { notRunReason: NOT_RUN_LANGUAGE + notRunDetail } : {}),
  };
}

// ── D. Struktur dan aparatus (research/01 §6.2 grup D) ────────────────────

type RowD = readonly [
  id: string,
  title: string,
  limit: string,
  ruleRef: string,
  tiers: readonly Tier[],
  partial: boolean,
  paramRef?: string,
];

const ROWS_D: readonly RowD[] = [
  ["D01", "Angka tak terlacak (audit_docx)", "0 angka tak terlacak", "DT-23, P5-46", SERAH_ONLY, false, "audit.untrackedNumbers.enabled"],
  ["D02", "Nilai pensiun (audit_retired)", "0 nilai pensiun", "DT-23, P5-47", SERAH_ONLY, false, "audit.retiredValues.enabled"],
  ["D03", "Turunan dihitung ulang terhadap register", "selisih di dalam toleransi", "DT-24, P5-48..53", SERAH_ONLY, false],
  ["D04", "Kalimat penutup turunan ada", "0 turunan tanpa kalimat penutup", "DT-24, S19", TERBIT_SERAH, false],
  ["D05", "Terbilang cocok dengan angka", "0 selisih", "SG-L4-05", TERBIT_SERAH, false],
  ["D06", "Logo tepat sekali", "1 per dokumen", "DT-14, 16.4, P4V-04", TERBIT_SERAH, false, "cover.logo.maxOccurrencesPerDocument"],
  ["D07", "REQ, kuantitas, dan total cocok di seluruh paket", "0 selisih", "research/01 §6.2 D07", SERAH_ONLY, false],
  ["D08", "Klasifikasi di setiap halaman produk operasional", "0 halaman tanpa klasifikasi", "DT-28", TERBIT_SERAH, false],
  ["D09", "labels_verified true untuk diagram terbit", "0 diagram terbit tanpa labels_verified", "DT-39", TERBIT_SERAH, false],
  ["D10", "KENDALI >= 5 uji + bendera induk", "maks. 5 uji, bendera induk ada", "research/01 §6.2 D10", TERBIT_SERAH, false],
  ["D11", "Caption satu kalimat dan tanggal berlaku", "1 kalimat; tanggal berlaku ada", "DT-15, research/01 §6.2 D11", TERBIT_SERAH, true],
  ["D12", "Jenis chart cocok kelompok tujuan", "0 jenis tak cocok (Tabel 7.2)", "Tabel 7.2", TERBIT_SERAH, false],
  ["D13", "Jumlah kategori dan seri dalam batas", "0 pelanggaran batas (Tabel 7.3)", "Tabel 7.3", TERBIT_SERAH, false],
  ["D14", "Bar, column, area mulai dari nol", "0 sumbu tidak nol", "CH-01 (tidak ada di lint)", TERBIT_SERAH, false],
  ["D15", "Tidak ada judul dalam plot", "0", "CH-05", TERBIT_SERAH, false],
  [
    "D16",
    "Section wajib per tier ada (mis. tabel rekonsiliasi SERAH)",
    "0 section wajib hilang",
    "Tabel 3.2, P5-67..68",
    TERBIT_SERAH,
    false,
    "serah.reconciliationTable.required",
  ],
  ["D17", "Blok identitas halaman pertama ada", "ada (jenis, penyusun, kebutuhan, satu jangkar terukur)", "SG-L0-01", TERBIT_SERAH, false, "doc.identityStatement.required"],
  ["D18", "Paragraf penutup memuat aksi dan penerima", "ada (kehadiran)", "SG-L0-03", TERBIT_SERAH, false, "doc.closing.actionAndRecipient.required"],
  ["D19", "Zona waktu pada setiap waktu", "0 waktu tanpa zona", "SG-L4-05", TERBIT_SERAH, false],
  ["D20", "Skala Admiralty dicetak sekali di lampiran bila dipakai", "1 kali", "DT-25", TERBIT_SERAH, false],
  ["D21", "Istilah ICD 203 dalam kosakata pita dan tidak dicampur keyakinan", "0 istilah di luar kosakata pita", "research/01 §6.2 D21", TERBIT_SERAH, true],
];

/** Modul pemilik grup D (S46): audit angka/struktur di `structure`. */
function defD(row: RowD): LintDef {
  const [id, title, limit, ruleRef, tiers, partial, paramRef] = row;
  return {
    id,
    group: "D",
    title,
    limit,
    stage: "file",
    hqMode: ["S"],
    partial,
    ruleRef,
    tiers,
    blocksIngest: false,
    module: "structure",
    ...(paramRef ? { paramRef } : {}),
  };
}

// ── D (lanjutan). Lint rilis struktur v2 (register 03 §11.4 LD-01..LD-04) ──
//
// SR-18 (KC-9, D-166). Kelompok D, tidak menahan berkas (A10) dan tidak
// menolak ingest. Tier "semua": status per tier ditetapkan cek itu sendiri
// (CONTENT_CHAPTER_GAP = FAIL TERBIT/SERAH, REPORT NOTA). SLOT_CONTENT_MISSING
// sengaja berlaku juga di NOTA: slot wajib kosong tidak pernah rilis-PASS.

const ALL_TIERS: readonly Tier[] = ["NOTA", "TERBIT", "SERAH"];

const GROUP_D_STRUCTURE_V2: readonly LintDef[] = [
  {
    id: "SLOT_CONTENT_MISSING",
    group: "D",
    title: "Slot wajib kerangka berisi (tidak EMPTY atau PARTIAL)",
    limit: "0 slot wajib EMPTY/PARTIAL pada revisi yang dirilis",
    stage: "build",
    hqMode: ["S"],
    partial: false,
    ruleRef: "D-131",
    tiers: ALL_TIERS,
    blocksIngest: false,
    module: "structure",
  },
  {
    id: "CONTENT_CHAPTER_GAP",
    group: "D",
    title: "Bab yang diharapkan ada di setiap slot berulang (outline atau kontigu)",
    limit: "0 kunci bab hilang (FAIL TERBIT/SERAH, REPORT NOTA)",
    stage: "build",
    hqMode: ["S"],
    partial: false,
    ruleRef: "D-131",
    tiers: ALL_TIERS,
    blocksIngest: false,
    module: "structure",
  },
  {
    id: "SCHEMA_V1_ADAPTED",
    group: "D",
    title: "Kiriman studio.doc/v1 diadaptasi ke v2 (laporan adaptor)",
    limit: "lapor",
    stage: "build",
    hqMode: ["S"],
    partial: false,
    ruleRef: "D-138",
    tiers: ALL_TIERS,
    blocksIngest: false,
    module: "structure",
  },
  {
    id: "INLINE_FORMAT_STRIPPED",
    group: "D",
    title: "Medan tampilan v1 dibuang (ingest.inlineFormat = strip)",
    limit: "lapor; hitungan per nama medan",
    stage: "build",
    hqMode: ["S"],
    partial: false,
    ruleRef: "D-138",
    tiers: ALL_TIERS,
    blocksIngest: false,
    module: "scan",
  },
];

// ── H. Pemeriksaan manusia (research/01 §6.3, Tabel 16.2 langkah 7-9) ─────

type RowH = readonly [
  no: number,
  title: string,
  limit: string,
  ruleRef: string,
  tiers: readonly Tier[],
  paramRef?: string,
];

const ROWS_H: readonly RowH[] = [
  [1, "Uji lima detik oleh orang yang tidak ikut membuat chart", "lulus uji lima detik", "CH-10, Tabel 8.9 no. 12 (L1258, L2073, L4098)", TERBIT_SERAH],
  [
    2,
    "Uji fotokopi fisik: cetak 100 %, fotokopi dua kali, baca 40 cm",
    "terbaca dari 40 cm (wajib SERAH, anjuran TERBIT; K-29)",
    "DT-11, DT-34 (L1219-1220, L4083)",
    TERBIT_SERAH,
    "photocopy.acceptanceTest",
  ],
  [3, "Setiap kotak diagram komponen nyata, setiap garis antarmuka nyata", "0 kotak atau garis fiktif", "9.1 (L2087-2092, L4095-4096)", TERBIT_SERAH],
  [4, "Kejujuran rel bukti (tidak diisi agar terlihat sibuk)", "rel hanya berisi bukti nyata", "DT-43 (L784-785, L4087)", TERBIT_SERAH],
  [5, "Kecukupan kalimat akibat pada turunan", "kalimat akibat cukup", "DT-24 (L4088)", TERBIT_SERAH],
  [6, "Keberlakuan regulasi dan edisi standar (tinjau tahunan, veritas)", "regulasi dan edisi berlaku", "DT-29, SM-05 (L1127, L4089-4091)", TERBIT_SERAH],
  [7, "Penetapan labels_verified oleh PRISMA setelah veritas", "labels_verified ditetapkan setelah veritas", "DT-39 (L2128-2132)", TERBIT_SERAH],
  [8, "Rubrik juri buta 4 dimensi, minimal 2 juri bukan penulis", "ambang LEPAS pada lembar skor ber-ID", "SG-L6-16, 14.4 (L3652-3658, L3715-3743)", SERAH_ONLY, "jury.minJudges"],
  [9, "Pemeriksa independen (bukan penulis, bukan juri)", "jejak langkah 2-8 tersimpan; terbaca dari 40 cm", "14.5, Tabel 16.2 langkah 9 (L3761-3762, L4073-4074)", SERAH_ONLY],
  [10, "Makna warna dekoratif (sisa lint 12)", "0 warna dekoratif", "DT-06 (L3962, L4067)", TERBIT_SERAH],
  [11, "Chart khusus hanya bila default gagal", "default gagal terdokumentasi", "CH-14 (L1249-1251)", TERBIT_SERAH],
  [12, "Kerucut pandang dari lensa nyata", "kerucut pandang dari lensa nyata", "SM-09 (L2489-2490)", TERBIT_SERAH],
  [13, "Simbol dicocokkan ke basis data standar sebelum terbit konstruksi", "simbol tercocokkan", "SM-11 (L2433)", TERBIT_SERAH],
  [14, "27 aturan SG kelas J (3.9.2)", "27 aturan dinilai juri atau manusia", "SG (L2850-3661)", TERBIT_SERAH],
  [15, "Klasifikasi minimum untuk data tapak militer (penilaian isi)", "klasifikasi sesuai isi", "6.1 (L1098-1101)", TERBIT_SERAH],
  [16, "Mutu kalimat kesimpulan pada caption chart", "kalimat kesimpulan bermutu", "CH-05 (L1402-1405)", TERBIT_SERAH],
];

function defH(row: RowH): LintDef {
  const [no, title, limit, ruleRef, tiers, paramRef] = row;
  return {
    id: `H${String(no).padStart(2, "0")}`,
    group: "H",
    title,
    limit,
    stage: "human",
    hqMode: ["M"],
    partial: false,
    ruleRef,
    tiers,
    blocksIngest: false,
    module: "human",
    ...(paramRef ? { paramRef } : {}),
  };
}

// ── Registri ──────────────────────────────────────────────────────────────

export const LINT_REGISTRY: readonly LintDef[] = [
  ...ROWS_A.map(defA),
  ...GROUP_B,
  ...ROWS_C.map(defC),
  ...ROWS_D.map(defD),
  ...GROUP_D_STRUCTURE_V2,
  ...ROWS_H.map(defH),
];

export const LINT_REGISTRY_COUNT = LINT_REGISTRY.length;
export const LINT_AUTOMATIC_COUNT = LINT_REGISTRY.filter((d) => d.group !== "H").length;
export const LINT_HUMAN_COUNT = LINT_REGISTRY.filter((d) => d.group === "H").length;

/** Jumlah per grup (A 39, B 4, C 19, D 25, H 16). */
export const LINT_GROUP_COUNTS: Readonly<Record<LintGroup, number>> = {
  A: LINT_REGISTRY.filter((d) => d.group === "A").length,
  B: LINT_REGISTRY.filter((d) => d.group === "B").length,
  C: LINT_REGISTRY.filter((d) => d.group === "C").length,
  D: LINT_REGISTRY.filter((d) => d.group === "D").length,
  H: LINT_REGISTRY.filter((d) => d.group === "H").length,
};

export function getLintDef(id: string): LintDef | undefined {
  return LINT_REGISTRY.find((d) => d.id === id);
}

/** false = pelari wajib melapor NOT_RUN dengan `notRunReason` (KT-13). */
export function isLintImplemented(def: LintDef): boolean {
  return def.notRunReason === undefined;
}
