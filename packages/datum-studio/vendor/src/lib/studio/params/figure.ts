/**
 * Parameter figur global (S08, 01_specs.md §5.1 T05): chart global P7 (36), peta
 * rekomendasi P8 (2), diagram P9 (55), simbol P10 (42) = 135 ParamDef,
 * `origin: "catalog"`. Sumber: research/01_manual_parameter_catalog.md §3.6.1,
 * §3.6.3, §3.7, §3.8; nilai asli Tabel 7.5, 8.7, 8.8, 9.4, 10.1-10.7 dari
 * research/04_manual_docx_tables.md (D-09). 87 parameter khusus jenis chart
 * (grup P7X) tinggal di registry/charts.ts (S09), bukan di sini.
 *
 * Putusan konflik yang diterapkan:
 * - K-04: biru tautan (`interior.link`) hanya untuk hyperlink dokumen; peran warna
 *   chart dan diagram menolaknya lewat `pattern` (TOKEN_NOT_LINK).
 * - K-13 / KT-08: ramp heatmap = satu gradasi putih (kertas) ke signal.
 * - K-17: aparatus diagram default `page`.
 * - K-32: ramp tinta dihitung sebagai satu keluarga untuk plafon 5 warna.
 */
import type { ParamDef, ParamGroup } from "../contract/types/params";

/** Token peran warna chart/diagram: tolak biru tautan (K-04). */
const TOKEN_NOT_LINK = "^(?!(?:interior\\.)?link$)[A-Za-z][A-Za-z0-9.]*$";

const CHAPTER: Record<"P7" | "P8" | "P9" | "P10", string> = {
  P7: "Bab 7-8",
  P8: "Bab 7-8",
  P9: "Bab 9",
  P10: "Bab 10",
};

/** Pembangun ParamDef katalog; grup, bab, dan namespace diturunkan dari id dan key. */
function d(
  id: string,
  key: string,
  label: string,
  type: ParamDef["type"],
  def: ParamDef["default"],
  cls: ParamDef["class"],
  ruleRef: string,
  source: string,
  extra: Partial<ParamDef> = {},
): ParamDef {
  const group = id.split("-")[0] as "P7" | "P8" | "P9" | "P10";
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
    group: group as ParamGroup,
    chapter: CHAPTER[group],
    namespace: key.split(".")[0],
    ...extra,
  };
}

// ── P7: parameter global chart (36), research/01 §3.6.1 ─────────────────────

const P7: readonly ParamDef[] = [
  d("P7-01", "chart.question", "Pertanyaan yang dijawab chart", "string", "", "K", "CH-07", "L1302, L2062", {
    classNote: "K (wajib ada); satu kalimat",
  }),
  d("P7-02", "chart.purposeGroup", "Kelompok tujuan chart", "enum", null, "B", "CH-08, Tabel 7.2", "L1304-1326", {
    enum: ["perbandingan", "waktu", "komposisi", "sebaran", "hubungan", "geospasial", "aliranProses", "kinerja"],
    classNote: "tanpa default; dipilih per chart",
  }),
  d("P7-03", "chart.audience", "Audiens chart", "enum", "pejabat", "B", "Langkah 4", "L1358-1372", {
    enum: ["pejabat", "teknis", "publik", "realtime"],
  }),
  d("P7-04", "chart.zeroBaseline", "Garis dasar nol", "bool", true, "K", "CH-01", "L1383, L4659", {
    classNote: "true untuk bar, column, area",
  }),
  d("P7-05", "chart.sortOrder", "Urutan kategori", "enum", "valueDesc", "B", "CH-02", "L1385-1386", {
    enum: ["valueDesc", "natural"],
    classNote: "natural untuk waktu, tingkat, arah mata angin",
  }),
  d("P7-06", "chart.accent.maxSubjects", "Subjek beraksen maksimum", "int", 1, "K", "CH-03, lint 26", "L1388-1389, L3995", {
    range: { min: 0, max: 1, step: 1 },
  }),
  d("P7-07", "chart.colorRole.accent", "Token peran aksen tunggal", "tokenRef", "signal", "B", "Tabel 7.5", "L1420-1421, research/04 T061", {
    pattern: TOKEN_NOT_LINK,
    rek: true,
    conflictRef: "K-04",
    classNote: "signal #B45309; satu subjek yang tidak boleh terlewat",
  }),
  d("P7-08", "chart.colorRole.contextMain", "Token peran konteks utama", "tokenRef", "ink400", "B", "Tabel 7.5", "L1421-1423, research/04 T061", {
    pattern: TOKEN_NOT_LINK,
    rek: true,
    conflictRef: "K-04",
    classNote: "ink400 #6B7783; seri pembanding yang tetap perlu dibaca",
  }),
  d("P7-09", "chart.colorRole.contextBackground", "Token peran konteks latar", "tokenRef", "ink200", "B", "Tabel 7.5", "L1422-1425, research/04 T061", {
    pattern: TOKEN_NOT_LINK,
    rek: true,
    conflictRef: "K-04",
    classNote: "ink200 #C3CBD1; target, periode lalu, sisa kategori",
  }),
  d("P7-10", "chart.colorRole.limitExceeded", "Token peran batas terlampaui", "tokenRef", "alert", "K", "CH-11", "L1423-1428, research/04 T061", {
    pattern: TOKEN_NOT_LINK,
    conflictRef: "K-04",
    classNote: "K (makna); alert #9B1C1C; melewati batas, penurunan, memburuk",
  }),
  d("P7-11", "chart.colorRole.improving", "Token peran membaik", "tokenRef", "verd", "K", "CH-11", "L1425-1430, research/04 T061", {
    pattern: TOKEN_NOT_LINK,
    conflictRef: "K-04",
    classNote: "K (makna); verd #2F6F6B; kenaikan pada waterfall atau slope",
  }),
  d("P7-12", "chart.colorRole.textAxis", "Token peran teks, sumbu, garis batas", "tokenRef", "ink900", "B", "Tabel 7.5", "L1437, research/04 T061", {
    pattern: TOKEN_NOT_LINK,
    conflictRef: "K-04",
    classNote: "ink900 #101418; garis dasar, label nilai mono, garis batas threshold",
  }),
  d("P7-13", "chart.legend.mode", "Mode legenda", "enum", "direct", "K", "CH-04, R-03", "L1391-1392, L4244-4246", {
    enum: ["direct", "keyRow"],
    classNote: "label langsung; legenda hanya baris KUNCI di bawah gambar, tanpa kotak",
  }),
  d("P7-14", "chart.inPlotTitle", "Judul di dalam area plot", "bool", false, "K", "CH-05, R-01", "L1394-1395, L4236"),
  d(
    "P7-15",
    "chart.forbiddenEffects",
    "Efek terlarang pada chart",
    "list",
    ["3D", "dua sumbu Y", "bayangan", "gradien", "ujung bar membulat", "bingkai", "label berkotak"],
    "K",
    "CH-06",
    "L1397-1398",
  ),
  d("P7-16", "chart.gridlines", "Garis kisi", "enum", "none", "B", "7.7", "L1514-1515", {
    enum: ["none", "whenComparing"],
    classNote: "kisi hanya bila nilai harus dibandingkan",
  }),
  d("P7-17", "chart.maxColors", "Warna maksimum per chart", "int", 5, "K", "lint 25", "L1440, L3993", {
    range: { min: 1, max: 5, step: 1 },
    conflictRef: "K-32",
    classNote: "ramp tinta dihitung satu keluarga (K-32)",
  }),
  d("P7-18", "chart.output.vectorRealText", "Keluaran vektor berteks nyata", "bool", true, "K", "DT-36", "L1525", {
    classNote: "SVG berteks nyata",
  }),
  d("P7-19", "chart.output.rasterDpiForWord", "DPI raster untuk Word", "int", 300, "K", "DT-36", "L1525-1526", {
    range: { min: 300, max: 300, step: 1 },
  }),
  d("P7-20", "chart.output.widthMm", "Lebar keluaran chart", "mm", 128, "T", "DT-36", "L1526", {
    derive: "figureWidthFromClass",
    classNote: "T (research/09 U3): kolom teks atau bentang penuh menurut chart.widthClass (A4 = 128/166); enum literal dibuang",
  }),
  d("P7-21", "chart.limits.pieMaxSlices", "Irisan pie maksimum", "int", 5, "B", "Tabel 7.3", "L1344, L1312", {
    range: { min: 1, max: 5, step: 1 },
  }),
  d("P7-22", "chart.limits.barCategoryRange", "Rentang kategori bar", "range", { min: 6, max: 30 }, "B", "Tabel 7.3", "L1346", {
    range: { min: 6, max: 30, step: 1 },
    classNote: "bar urut atau lollipop",
  }),
  d("P7-23", "chart.limits.topNOverflow", "Rentang N teratas bila kategori melebihi 30", "range", { min: 10, max: 15 }, "B", "Tabel 7.3", "L1348", {
    range: { min: 10, max: 15, step: 1 },
    classNote: "10-15 teratas ditambah Lainnya bila > 30",
  }),
  d("P7-24", "chart.limits.lineMaxSeries", "Seri line maksimum", "int", 3, "B", "Tabel 7.3", "L1350", {
    range: { min: 1, max: 3, step: 1 },
    classNote: "lebih dari itu: sorot satu, pudarkan, atau small multiples",
  }),
  d("P7-25", "chart.limits.denseScatterStrategy", "Strategi scatter padat", "enum", "transparency", "B", "Tabel 7.3", "L1352", {
    enum: ["transparency", "hexbin", "heatmap"],
  }),
  d("P7-26", "chart.limits.logScaleNoteRequired", "Catatan wajib skala log", "bool", true, "K", "Tabel 7.3", "L1354", {
    classNote: "wajib bila nilai berbeda ribuan kali",
  }),
  d("P7-27", "chart.heatmap.ramp", "Ramp warna heatmap", "list", ["paper", "signal"], "B", "Tabel 7.7, 8.6 no. 10", "L1554, L1916", {
    conflictRef: "K-13",
    classNote: "KT-08: satu gradasi putih (kertas) ke signal; ramp paper-ink200-ink400-ink900 kode skill tidak dipakai",
  }),
  d("P7-28", "chart.dashboardTiles.allowedInDocument", "Ubin dan meteran dasbor dalam dokumen", "bool", false, "K", "CH-13, lint 01, R-04", "L1531-1533, L4248-4250", {
    classNote: "tile dan gauge hanya di layar hidup",
  }),
  d("P7-29", "chart.specialOnlyIfDefaultFails", "Chart khusus hanya bila default gagal", "bool", true, "K", "CH-14", "L1249-1251", {
    classNote: "K (manusia); radar, sunburst, sankey, stream",
  }),
  d("P7-30", "chart.engine", "Mesin chart", "enum", "pustakachart", "T", "8.5, C-01", "L2050-2054", {
    enum: ["datumchart", "pustakachart"],
    derive: "chartEngine",
    classNote: "datumchart untuk bar, column, threshold; pustakachart untuk 55 jenis lain",
  }),
  d("P7-31", "chart.eyeCheck.required", "Pemeriksaan mata wajib (nomor lint)", "list", [12, 13, 25, 27, 28], "T", "8.5", "L2055-2056", {
    derive: "eyeCheckList",
    classNote: "berlaku bila mesin bukan datumchart",
  }),
  d("P7-32", "chart.threshold.limitLineLabelled", "Garis batas threshold berlabel", "bool", true, "K", "CH-12", "L1444-1449", {
    classNote: "batang yang melewati batas memakai alert",
  }),
  d("P7-33", "chart.source.dataDateAndMark", "Baris SUMBER memuat tanggal data dan tanda provenans", "bool", true, "K", "DT-15, Tabel 8.9 no. 11", "L1522-1523, L2072"),
  d("P7-34", "chart.numbersBoundToRegister", "Angka terikat ke register", "bool", true, "K", "DT-23, Tabel 8.9 no. 10", "L2071"),
  d("P7-35", "chart.illustrativeDataLabel", "Label data ilustratif", "string", "CONTOH DATA SINTETIS", "B", "1.5", "L270-271, PC68", {
    classNote: "untuk galeri",
  }),
  d("P7-36", "chart.minFontPt", "Ukuran huruf minimum chart", "pt", 5.5, "K", "lint 28", "L3999, SK80", {
    range: { min: 5.5, step: 0.5 },
    classNote: "pustakachart mengukur minimum 5,8",
  }),
];

// ── P8: peta rekomendasi (2), research/01 §3.6.3; isi dari research/04 T071, T072 ──

const P8: readonly ParamDef[] = [
  d(
    "P8-01",
    "chart.recommendedByDocType",
    "Chart yang disarankan dan dihindari per jenis dokumen",
    "map",
    {
      proposalTeknisKajian: {
        dokumen: "Proposal teknis, kajian",
        disarankan: ["Gantt", "flowchart", "bar untuk perbandingan opsi", "bullet", "threshold"],
        dihindari: ["Radar untuk membandingkan vendor"],
      },
      rabBoqPenawaran: {
        dokumen: "RAB, BoQ, penawaran",
        disarankan: ["Sankey atau treemap untuk komposisi biaya", "waterfall", "100 % stacked bar untuk TKDN"],
        dihindari: ["Pie dengan banyak irisan"],
      },
      paparanPejabat: {
        dokumen: "Paparan ke pejabat",
        disarankan: ["Bar urut", "line", "bullet", "tile map", "satu pesan per slide"],
        dihindari: ["Box plot", "horizon", "network tanpa penjelasan"],
      },
      layarPusatKomando: {
        dokumen: "Layar pusat komando",
        disarankan: ["Horizon", "line", "heatmap hari x jam", "bullet", "dot map"],
        dihindari: ["3D", "animasi berlebihan", "stream graph"],
      },
      laporanOsint: {
        dokumen: "Laporan OSINT",
        disarankan: ["Network", "barcode", "heatmap aktivitas", "bar frekuensi"],
        dihindari: ["Word cloud sebagai satu-satunya bukti"],
      },
      laporanForensikDigital: {
        dokumen: "Laporan forensik digital",
        disarankan: ["Barcode", "flowchart rantai kustodi", "table chart"],
        dihindari: ["Chart yang menyembunyikan waktu kejadian persis"],
      },
      laporanKinerjaInternal: {
        dokumen: "Laporan kinerja internal",
        disarankan: ["Bullet", "dumbbell", "arrow", "beeswarm", "ridgeline"],
        dihindari: ["Deretan gauge"],
      },
    },
    "B",
    "Tabel 8.8",
    "L2022-2043, research/04 T072",
    { classNote: "7 jenis dokumen; KT-12: dot map skematis di atas grid tile map" },
  ),
  d(
    "P8-02",
    "chart.gspRelevance",
    "Relevansi chart tambahan untuk pekerjaan GSP",
    "map",
    {
      gantt: { chart: "Gantt", code: "W-07", relevance: "Tinggi", useCase: "Jadwal pelaksanaan di proposal teknis, kajian, dan rencana kerja" },
      sankey: { chart: "Sankey", code: "K-11", relevance: "Tinggi", useCase: "Aliran RAB dari total ke kelompok biaya ke item; aliran data antar tier" },
      network: { chart: "Network", code: "H-07", relevance: "Tinggi", useCase: "Analisis relasi OSINT; topologi; peta pemangku kepentingan" },
      tileMap: { chart: "Tile map", code: "G-01", relevance: "Tinggi", useCase: "Sebaran nasional per provinsi, Polda, atau Kodam tanpa bias luas" },
      horizon: { chart: "Horizon", code: "W-09", relevance: "Tinggi", useCase: "Dashboard pusat komando: puluhan sensor perimeter, radar, kamera" },
      barcode: { chart: "Barcode", code: "W-08", relevance: "Tinggi", useCase: "Linimasa forensik digital: login, akses berkas, USB, ekspor" },
      radialHistogram: { chart: "Radial histogram", code: "S-08", relevance: "Tinggi", useCase: "Arah deteksi radar dan perimeter, hasil direction finding" },
      flowchart: { chart: "Flowchart", code: "G-04", relevance: "Tinggi", useCase: "SOP, rantai kustodi barang bukti, alur keputusan" },
      beeswarmStrip: { chart: "Beeswarm, strip", code: "S-07", relevance: "Sedang", useCase: "Sebaran waktu respons per satuan; skor evaluasi vendor" },
      ridgeline: { chart: "Ridgeline", code: "S-05", relevance: "Sedang", useCase: "Pergeseran sebaran waktu penyelesaian tiket" },
      radialBarNightingaleWordCloud: {
        chart: "Radial bar, nightingale, word cloud",
        code: null,
        relevance: "Rendah",
        useCase: "Hiasan; presisinya rendah untuk pejabat dan panitia tender",
      },
    },
    "B",
    "Tabel 8.7",
    "L1990-2020, research/04 T071",
    { classNote: "PROVENANS ASUMSI: matriks adalah penilaian penyusun panduan chart, bukan isi sumber" },
  ),
];

// ── P9: diagram dan mesin gambar (55), research/01 §3.7 ─────────────────────

const EDGE_KINDS = [
  { kind: "data", label: "data", pattern: "solid", colour: "ink900", head: "solid", iso: "01.1" },
  { kind: "control", label: "kendali", pattern: "dashed", colour: "ink700", head: "open", iso: "02.1" },
  { kind: "sync", label: "sinkron", pattern: "dotted", colour: "ink400", head: "open", iso: "-" },
  { kind: "accent", label: "aksen", pattern: "solid", colour: "signal", head: "solid", iso: "01.1" },
  { kind: "alert", label: "alert", pattern: "longdash", colour: "alert", head: "open", iso: "-" },
  { kind: "verify", label: "verifikasi", pattern: "dashdot", colour: "verd", head: "open", iso: "04.1" },
] as const;

const EDGE_ATTRS = ["pattern", "colour", "head"] as const;

/** P9-09..P9-26: 6 jenis penghubung x 3 atribut (Tabel 9.4). */
const P9_EDGE_KINDS: readonly ParamDef[] = EDGE_KINDS.flatMap((k, ki) =>
  EDGE_ATTRS.map((attr, ai) => {
    const id = `P9-${String(9 + ki * 3 + ai).padStart(2, "0")}`;
    const key = `diagram.edgeKind.${k.kind}.${attr}`;
    const common = { source: "L2193-2210, DD152-165, research/04 T078" };
    if (attr === "pattern") {
      return d(id, key, `Pola garis penghubung ${k.label}`, "enum", k.pattern, "B", "Tabel 9.4", common.source, {
        enum: ["solid", "dashed", "dotted", "longdash", "dashdot"],
        classNote: `B (pola-makna: K); ISO 128-2: ${k.iso}`,
      });
    }
    if (attr === "colour") {
      return d(id, key, `Warna penghubung ${k.label}`, "tokenRef", k.colour, "B", "Tabel 9.4", common.source, {
        pattern: TOKEN_NOT_LINK,
        conflictRef: "K-04",
        classNote: k.kind === "accent" ? "B (pola-makna: K); garis tebal" : "B (pola-makna: K)",
      });
    }
    return d(id, key, `Kepala panah penghubung ${k.label}`, "enum", k.head, "B", "Tabel 9.4", common.source, {
      enum: ["solid", "open"],
      classNote: "B (pola-makna: K)",
    });
  }),
);

const DASH_PATTERNS = [
  { name: "dashed", label: "putus-putus", value: "3.2/1.6" },
  { name: "dotted", label: "titik-titik", value: "0.2/1.1" },
  { name: "longdash", label: "putus panjang", value: "7.1/1.6" },
  { name: "dashdot", label: "titik-garis", value: "7.1/1.6/0.2/1.6" },
  { name: "solid", label: "penuh", value: "none" },
] as const;

/** P9-27..P9-31: geometri pola putus dalam mm (dash/gap, urutan berulang). */
const P9_DASH_PATTERNS: readonly ParamDef[] = DASH_PATTERNS.map((p, i) =>
  d(`P9-${27 + i}`, `diagram.dashPatternMm.${p.name}`, `Geometri pola garis ${p.label} (mm)`, "string", p.value, "B", "-", "DD167-170 (tidak di manual)", {
    classNote: "format panjang/jarak dalam mm, dipisah garis miring; none = tanpa putus",
  }),
);

const P9: readonly ParamDef[] = [
  d("P9-01", "diagram.family", "Keluarga diagram", "enum", null, "K", "DT-35", "L2106, L2138-2163, DD125-135", {
    enum: ["layered", "topology", "stack", "flow", "swimlane", "sequence", "sld", "rack", "graph"],
    classNote: "K (pemilik); dipilih PRISMA, tidak pernah DATUM; tanpa default",
  }),
  // R01 (F-023): kosong = belum diberi nomor (default ""), selain itu <bab>.<urut>.
  d("P9-02", "diagram.id", "Nomor diagram", "string", "", "K", "Tabel 9.1", "L2108", {
    pattern: "^([0-9]+\\.[0-9]+)?$",
    classNote: "nomor berawalan bab; kosong = belum dinomori",
  }),
  d("P9-03", "diagram.title", "Judul diagram", "string", "", "K", "Tabel 9.1", "L2108", {
    classNote: "satu kalimat diakhiri titik",
  }),
  d("P9-04", "diagram.classification", "Klasifikasi diagram", "string", "inherit", "T", "Tabel 9.1", "L2110", {
    classNote: "diwarisi dokumen induk (= P6-02)",
    derive: "diagramClassification",
  }),
  d("P9-05", "diagram.nodes[]", "Daftar simpul diagram", "list", [], "K", "Tabel 9.1", "L2112", {
    classNote: "K (skema); simpul {id, label, class, sub, mark, tag}",
  }),
  d("P9-06", "diagram.node.shape", "Bentuk simpul", "enum", "box", "B", "Tabel 9.3", "L2167-2189, DD138-149, research/04 T077", {
    enum: ["box", "stadium", "diamond", "parallelogram", "cylinder", "hexagon", "doubled", "shadowed", "circle", "bus"],
  }),
  d("P9-07", "diagram.node.class", "Kelas posisi simpul", "object", { tier: null, lane: null, col: null, row: null }, "B", "Tabel 9.1", "L2112", {
    classNote: "{tier, lane, col, row} menurut keluarga diagram",
  }),
  d("P9-08", "diagram.edges[]", "Daftar penghubung diagram", "list", [], "K", "DT-37, lint 24", "L2114, L3986", {
    classNote: "from, to, kind, label: keempatnya wajib",
  }),
  ...P9_EDGE_KINDS,
  ...P9_DASH_PATTERNS,
  d("P9-32", "diagram.legend[]", "Baris kunci legenda diagram", "list", [], "K", "Tabel 9.1", "L2116", {
    classNote: "K (wajib bila tanda rumah dipakai, lint 34)",
  }),
  d("P9-33", "diagram.notes[]", "Catatan diagram", "list", [], "B", "Tabel 9.1", "L2116", {
    classNote: "batas lingkup dan konvensi",
  }),
  d("P9-34", "diagram.sources[]", "Sumber diagram", "list", [], "K", "Tabel 9.1", "L2118", {
    classNote: "minimal 1 dokumen dan pasal",
  }),
  d("P9-35", "diagram.labelsVerified", "Label diagram terverifikasi", "bool", false, "K", "DT-39", "L2120, L2128-2132", {
    classNote: "false = draf; true hanya setelah veritas",
  }),
  d("P9-36", "diagram.widthMm", "Lebar diagram", "mm", 128, "T", "DT-36", "L2122", {
    derive: "figureWidthFromClass",
    classNote: "T (research/09 U3): kolom teks atau bentang penuh menurut diagram.widthClass (A4 = 128/166); enum literal dibuang",
  }),
  d("P9-37", "diagram.apparatus", "Aparatus diagram", "enum", "page", "B", "Tabel 9.1, lint 36", "L2124, L2226-2229", {
    enum: ["page", "figure"],
    conflictRef: "K-17",
    classNote: "page untuk gambar di dokumen (K-17); figure untuk SVG mandiri",
  }),
  d("P9-38", "diagram.latticeSnap", "Kisi tangkap diagram (mm)", "object", { xMm: 10.6667, yMm: 4.7625 }, "T", "9.3", "L2219", {
    classNote: "= P4G-09 x P4G-10",
    derive: "diagramLatticeSnap",
  }),
  d("P9-39", "diagram.widthPerTier.single", "Satu lebar per tier", "bool", true, "K", "9.3", "L2219-2220"),
  d(
    "P9-40",
    "diagram.trustZone.style",
    "Gaya zona kepercayaan",
    "object",
    { edge: "dashed", labelTab: true, fill: "none" },
    "K",
    "DT-44",
    "L2220-2221",
    { classNote: "garis tepi putus-putus, tab label, tanpa isian" },
  ),
  d("P9-41", "diagram.accent.max", "Aksen maksimum per diagram", "int", 1, "K", "DT-37, lint 26", "L2221, L3995", {
    range: { min: 0, max: 1, step: 1 },
  }),
  d("P9-42", "diagram.maxColors", "Warna maksimum per diagram", "int", 5, "K", "lint 25", "L2221, DD114", {
    range: { min: 1, max: 5, step: 1 },
    conflictRef: "K-32",
    classNote: "ramp tinta dihitung satu keluarga (K-32)",
  }),
  d("P9-43", "diagram.legend.style", "Gaya legenda diagram", "enum", "keyRow", "K", "9.3", "L2222", {
    enum: ["keyRow"],
    classNote: "baris kunci, bukan kotak",
  }),
  d("P9-44", "diagram.minFontPt", "Ukuran huruf minimum diagram", "pt", 5.5, "K", "lint 28", "L3999, DD112", {
    range: { min: 5.5, step: 0.5 },
  }),
  d("P9-45", "diagram.maxHeightMm", "Tinggi maksimum diagram", "mm", 247, "T", "lint 33", "L4009, DD113", {
    derive: "figureMaxHeightFromBlock",
    classNote: "T (research/09 U2, D-162): = grid.textBlockHeightMm (A4 potret 247)",
  }),
  d("P9-46", "diagram.minStrokeMm", "Tebal goresan minimum", "mm", 0.18, "K", "lint 27", "L3997, DD105", {
    range: { min: 0.18 },
  }),
  d("P9-47", "diagram.hopRadiusMm", "Radius lompatan persilangan garis", "mm", 0.9, "B", "-", "DD116 (tidak di manual)", {
    classNote: "geometri",
  }),
  d("P9-48", "diagram.anchorFanning", "Jangkar dikipas", "bool", true, "B", "9.3", "L2212-2214"),
  d("P9-49", "diagram.routing.avoidUnrelatedBoxes", "Rute penghubung menghindari kotak tak terkait", "bool", true, "K", "lint 32", "L2218, L4007"),
  d("P9-50", "diagram.render.pngDpi", "DPI PNG diagram", "int", 300, "K", "DT-36", "L478, L2230", {
    range: { min: 300, max: 300, step: 1 },
  }),
  d("P9-51", "diagram.docxPlacement.exactLineSpacingPt", "Spasi baris persis penempatan diagram di DOCX", "pt", 13.5, "T", "9.4", "L2230-2232", {
    classNote: "= baseline (P4T-17), dilepas lewat helper",
    derive: "diagramLineSpacing",
  }),
  d("P9-52", "diagram.mermaidInDeliverable", "Diagram Mermaid dalam berkas hasil", "bool", false, "K", "DT-35, lint 31", "L2237-2239", {
    classNote: "Mermaid untuk draf saja",
  }),
  d("P9-53", "diagram.figmaCopy.reviewOnly", "Salinan Figma hanya untuk tinjauan", "bool", true, "K", "9.5", "L2241-2245", {
    classNote: "teks jadi kontur, tidak dimasukkan kembali",
  }),
  d("P9-54", "diagram.roundedCorners.onlyTerminator", "Sudut bulat hanya untuk terminator", "bool", true, "K", "lint 23", "L2171, L3984", {
    classNote: "stadium satu-satunya bentuk bersudut bulat",
  }),
  d("P9-55", "diagram.notationsPerFigure", "Notasi per gambar", "int", 1, "K", "DT-44, SM-04", "L2252, L4651", {
    range: { min: 1, max: 1, step: 1 },
  }),
];

// ── P10: simbol engineering dan dialek (42), research/01 §3.8; Tabel 10.1-10.7 ─

const P10: readonly ParamDef[] = [
  d("P10-01", "symbol.dialect", "Dialek simbol", "enum", null, "B", "10.4", "L2389, SK81, L4450-4451", {
    enum: ["iec", "isa", "sec", "mil", "bpmn", "net", "fire"],
    classNote: "pustaka iec 16, isa 12, sec 7, mil 6 simbol; bpmn, net, fire usulan; tanpa default",
  }),
  d("P10-02", "symbol.dialectsPerDrawing", "Dialek per gambar", "int", 1, "K", "SM-04, lint 35", "L2372-2373, L4013", {
    range: { min: 1, max: 1, step: 1 },
  }),
  d(
    "P10-03",
    "symbol.standardByDrawingType",
    "Standar simbol per jenis gambar",
    "map",
    {
      sldCatuDaya: {
        drawingType: "Diagram satu garis catu daya",
        usedIn: "Pos perimeter, ruang server, NOC",
        standard: "IEC 60617 dan penandaan IEC 81346-1; instalasi PUIL 2020 (SNI 0225:2020)",
        editions: [
          { ref: "IEC 60617:2026 DB", status: "T" },
          { ref: "IEC 81346-1:2022", status: "D" },
        ],
        library: "iec:",
      },
      skematikKendali: {
        drawingType: "Skematik kendali",
        usedIn: "Panel sensor, kotak antarmuka",
        standard: "IEC 60617; IEEE 315 hanya bila klien memakai standar AS",
        editions: [{ ref: "IEEE 315", status: null, note: "belum terverifikasi" }],
        library: "sebagian",
      },
      pid: {
        drawingType: "P&ID, instrumentasi",
        usedIn: "Tambang, migas, pelabuhan, utilitas",
        standard: "ANSI/ISA-5.1",
        editions: [{ ref: "ANSI/ISA-5.1-2024", status: "T", note: "menggantikan 2022" }],
        library: "isa: (label 2022)",
      },
      denahKeamanan: {
        drawingType: "Denah keamanan",
        usedIn: "CCTV, akses, intrusi, perimeter",
        standard: "Legenda rumah GSP, atau SIA AG-01 v3.0 bila klien memakai standar AS",
        editions: [{ ref: "SIA AG-01 v3.0", status: "T" }],
        library: "sec:",
      },
      denahAlarmKebakaran: {
        drawingType: "Denah alarm kebakaran",
        usedIn: "Gedung, ruang server",
        standard: "NFPA 170; rujukan Indonesia SNI 03-3985-2000",
        editions: [{ ref: "NFPA 170:2024", status: "S" }],
        library: "tidak ada",
      },
      topologiJaringan: {
        drawingType: "Topologi jaringan",
        usedIn: "Hampir semua proyek",
        standard: "Tidak ada standar formal; ikon vendor tanpa diubah, atau legenda generik GSP",
        editions: [],
        library: "usulan net:",
      },
      elevasiRak: {
        drawingType: "Elevasi rak",
        usedIn: "Ruang server, NOC",
        standard: "EIA-310, rak 19 inci",
        editions: [{ ref: "EIA-310", status: "S", note: "1U = 44,45 mm" }],
        library: "rack",
      },
      labelKabel: {
        drawingType: "Label kabel",
        usedIn: "Ruang server, gedung",
        standard: "ANSI/TIA-606-D",
        editions: [{ ref: "ANSI/TIA-606-D", status: "S" }],
        library: "tidak ada",
      },
      diagramAlir: {
        drawingType: "Diagram alir, SOP",
        usedIn: "Kajian teknis, SOP",
        standard: "ISO 5807",
        editions: [{ ref: "ISO 5807:1985", status: "T", note: "dikonfirmasi 2019" }],
        library: "bentuk simpul",
      },
      prosesBisnis: {
        drawingType: "Proses bisnis",
        usedIn: "SPBE, alur kerja",
        standard: "BPMN 2.0.2 (ISO/IEC 19510)",
        editions: [{ ref: "BPMN 2.0.2", status: "K" }],
        library: "usulan bpmn:",
      },
      arsitekturPerangkatLunak: {
        drawingType: "Arsitektur perangkat lunak",
        usedIn: "DEMS, OSINT, platform",
        standard: "UML 2.5.1; model C4",
        editions: [{ ref: "UML 2.5.1; model C4", status: "K" }],
        library: "sebagian",
      },
      arsitekturEnterprise: {
        drawingType: "Arsitektur enterprise",
        usedIn: "SPBE, transformasi digital",
        standard: "ArchiMate",
        editions: [{ ref: "ArchiMate 4, April 2026", status: "T" }],
        library: "tidak ada",
      },
      diagramAliranData: {
        drawingType: "Diagram aliran data",
        usedIn: "Analisis sistem",
        standard: "Gane-Sarson, konvensi de facto",
        editions: [],
        library: "shadowed",
      },
      gambarOperasiCop: {
        drawingType: "Gambar operasi, COP",
        usedIn: "TNI, pusat komando",
        standard: "MIL-STD-2525; NATO APP-6",
        editions: [
          { ref: "MIL-STD-2525E", status: "D" },
          { ref: "APP-6E 2025", status: "S" },
        ],
        library: "mil:",
      },
      rambuKeselamatan: {
        drawingType: "Rambu keselamatan",
        usedIn: "Jalur evakuasi, APAR",
        standard: "ISO 7010",
        editions: [{ ref: "ISO 7010:2019 + Amd 9:2025", status: "T" }],
        library: "tidak ada",
      },
      jenisTebalGaris: {
        drawingType: "Jenis dan tebal garis",
        usedIn: "Semua gambar teknik",
        standard: "ISO 128-2",
        editions: [{ ref: "ISO 128-2:2022", status: "D" }],
        library: "ya",
      },
    },
    "K",
    "SM-05",
    "L2298-2357, research/04 T080",
    {
      rek: true,
      conflictRef: "K-28",
      classNote: "K (admin); 16 jenis gambar, edisi per 7 Oktober 2026",
    },
  ),
  d("P10-04", "symbol.editionStatus", "Status edisi standar", "enum", null, "K", "Tabel 10.1", "L2356-2357, research/04 T080", {
    enum: ["T", "S", "D", "K"],
    rek: true,
    conflictRef: "K-28",
    classNote: "T situs penerbit, S sekunder, D tabel DATUM, K pengetahuan umum; tanpa default",
  }),
  d("P10-05", "symbol.houseLegend.required", "Legenda rumah wajib", "bool", true, "K", "SM-03, lint 34", "L2483-2484, L4011", {
    classNote: "wajib bila sec: atau tanda rumah dipakai",
  }),
  d("P10-06", "symbol.houseLegend.disclaimer", "Pernyataan legenda rumah", "string", "bukan simbol standar", "K", "SM-03", "L2368-2370, L2483-2484"),
  d("P10-07", "symbol.kakOverride", "KAK dan kontrak didahulukan", "bool", true, "K", "SM-02", "L2364-2366"),
  d("P10-08", "symbol.vendorIcon.modifiable", "Ikon vendor boleh diubah", "bool", false, "K", "SM-06", "L2586-2587, L2674"),
  d("P10-09", "symbol.genericIconsForBrandNeutral", "Ikon generik untuk gambar netral merek", "bool", true, "B", "SM-06", "L2587-2588", {
    classNote: "true kecuali merek ditetapkan",
  }),
  d(
    "P10-10",
    "designation.iec81346.prefixes",
    "Awalan penandaan IEC 81346",
    "map",
    { "=": "fungsi", "+": "lokasi", "-": "produk", ":": "terminal" },
    "K",
    "SM-07",
    "L2613-2617",
  ),
  d("P10-11", "designation.sameAcrossDrawingBoqAcceptance", "Penandaan sama di gambar, BoQ, uji terima", "bool", true, "K", "SM-07", "L2425-2426, L2649"),
  d(
    "P10-12",
    "sheet.titleBlock.fields",
    "Isi blok judul lembar gambar",
    "list",
    ["judul satu kalimat", "nomor gambar", "revisi", "tanggal", "skala atau tanpa skala", "pembuat", "pemeriksa", "klasifikasi"],
    "K",
    "SM-08",
    "L2639-2640",
  ),
  d("P10-13", "sheet.legend.style", "Gaya legenda lembar gambar", "enum", "keyRow", "K", "Tabel 10.7", "L2642-2643", {
    enum: ["keyRow"],
    classNote: "baris keterangan, bukan kotak hiasan",
  }),
  d("P10-14", "sheet.lineLabel.required", "Label garis wajib", "bool", true, "K", "SM-08", "L2375-2377, L2647", {
    classNote: "isi aliran dan kapasitas",
  }),
  d("P10-15", "sheet.colour.reinforcementOnly", "Warna hanya penegas", "bool", true, "K", "Tabel 10.7", "L2653", {
    classNote: "gambar tetap terbaca hitam-putih",
  }),
  d("P10-16", "sheet.revisionOnChange", "Revisi naik setiap perubahan", "bool", true, "K", "Tabel 10.7", "L2655"),
  d("P10-17", "symbol.viewCone.fromLens", "Kerucut pandang dari lensa", "bool", true, "K", "SM-09", "L2489-2490", {
    classNote: "turunan focal length dan ukuran sensor kamera",
  }),
  d(
    "P10-18",
    "mil.identityByShape",
    "Identitas militer menurut bentuk",
    "map",
    { kawan: "persegi panjang", lawan: "belah ketupat", netral: "bujur sangkar", takDikenal: "quatrefoil" },
    "K",
    "SM-10",
    "L2520-2521",
  ),
  d("P10-19", "mil.frameRatioLocked", "Rasio bingkai terkunci", "bool", true, "K", "SM-10", "L2523-2524", {
    classNote: "kawan dan netral hanya beda rasio",
  }),
  d("P10-20", "mil.echelonMarks", "Tanda eselon militer", "map", { "|": "kompi", "||": "batalyon", X: "brigade", XX: "divisi" }, "K", "Tabel 10.5", "L2526-2527", {
    classNote: "ditulis di atas bingkai",
  }),
  d("P10-21", "mil.sidcRequiredForC2", "SIDC wajib untuk sistem C2", "bool", true, "K", "Tabel 10.5", "L2529-2530"),
  d(
    "P10-22",
    "isa.locationLines",
    "Garis lokasi ISA",
    "map",
    { lapangan: "tanpa garis", ruangKendaliUtama: "satu garis", lokasiBantu: "dua garis", takTerjangkauOperator: "garis putus" },
    "K",
    "Tabel 10.3",
    "L2454-2455, research/04 T083",
  ),
  d(
    "P10-23",
    "isa.shapeByFunction",
    "Bentuk ISA menurut fungsi",
    "map",
    {
      instrumenTunggal: "lingkaran",
      tampilanAtauKendaliBersama: "lingkaran dalam persegi",
      fungsiKomputer: "segi enam",
      plc: "belah ketupat dalam persegi",
    },
    "K",
    "Tabel 10.3",
    "L2451-2452, research/04 T083",
  ),
  d(
    "P10-24",
    "iec.switchFamilyMarks",
    "Tanda keluarga sakelar IEC",
    "map",
    {
      pemutusDaya: "tanda silang pada kontak; memutus arus gangguan",
      pemisah: "garis pendek pada kontak; hanya mengisolasi",
      kontaktor: "busur pada kontak; ditahan kumparan",
    },
    "K",
    "Tabel 10.2",
    "L2414-2417, research/04 T082",
    { classNote: "semua berbentuk kontak berbilah terbuka; hanya tanda pada kontak yang membedakan" },
  ),
  d("P10-25", "iec.atsAsChangeoverContact", "ATS sebagai kontak pindah", "bool", true, "K", "Tabel 10.2", "L2419-2420", {
    classNote: "tanpa kotak ATS karangan",
  }),
  d("P10-26", "iso5807.maxSteps", "Langkah maksimum per gambar alir", "int", 10, "B", "Tabel 10.6", "L2554-2555", {
    range: { min: 1, step: 1 },
    classNote: "perkiraan; lebih dari itu pecah menjadi sub-proses",
  }),
  d("P10-27", "iso5807.terminatorOnlyRounded", "Terminator satu-satunya bentuk bersudut bulat", "bool", true, "K", "Tabel 10.6", "L2553"),
  d(
    "P10-28",
    "bpmn.gatewaySymbols",
    "Simbol gerbang BPMN",
    "map",
    { eksklusif: "silang", paralel: "plus", inklusif: "lingkaran" },
    "K",
    "Tabel 10.6",
    "L2557-2558, research/04 T086",
    { classNote: "glif sebelumnya [TAK TERBACA] sebagian; dipulihkan dari tabel .docx" },
  ),
  d("P10-29", "c4.levels", "Tingkat model C4", "list", ["Konteks", "Kontainer", "Komponen", "Kode"], "B", "Tabel 10.6", "L2564-2565", {
    classNote: "proposal cukup dua tingkat pertama",
  }),
  d("P10-30", "archimate.versionOnDrawing", "Versi ArchiMate ditulis di gambar", "bool", true, "K", "Tabel 10.6", "L2567-2569", {
    classNote: "versi 3.2 dan 4 berbeda",
  }),
  d("P10-31", "topology.layerOrder", "Urutan lapis topologi", "list", ["WAN", "inti", "agregasi", "lapangan"], "B", "10.4", "L2589"),
  d("P10-32", "topology.linkLabel.capacityOrProtocol", "Label tautan memuat kapasitas atau protokol", "bool", true, "K", "10.4", "L2588-2589", {
    classNote: "mis. 10G, 1G PoE, VPN IPsec",
  }),
  d("P10-33", "lineWeight.seriesR10Mm", "Deret tebal garis R10 (mm)", "list", [0.13, 0.18, 0.25, 0.35, 0.5, 0.7, 1], "K", "ISO 128-2", "L2591"),
  // R01 (F-023): bentuk rasio sah a/b (tipis/tebal); katalog menulis "1:2".
  d("P10-34", "lineWeight.thinThickRatio", "Rasio garis tipis dan tebal", "ratio", "1/2", "K", "ISO 128-2", "L2591-2592", {
    classNote: "tipis:tebal = 1:2 (katalog L2591); ditulis a/b agar lolos validasi rasio",
  }),
  d("P10-35", "lineType.code0501.meaning", "Arti jenis garis ISO 05.1", "string", "pekerjaan di luar kontrak", "K", "10.4", "L2592-2594", {
    classNote: "nama ISO 05.1; titik dalam kunci dihindari agar jalur kunci tidak bercabang",
  }),
  d("P10-36", "rack.unitMm", "Tinggi satu unit rak (mm)", "mm", 44.45, "K", "EIA-310", "L2596", {
    classNote: "1U",
  }),
  d("P10-37", "rack.numberFromBottom", "Nomor unit rak dari bawah", "bool", true, "K", "EIA-310", "L2596, L2265"),
  d("P10-38", "labels.standard", "Standar label kabel", "string", "ANSI/TIA-606-D", "K", "10.4", "L2597-2598"),
  d(
    "P10-39",
    "iso7010.prefixes",
    "Awalan rambu ISO 7010",
    "map",
    { E: "evakuasi", F: "kebakaran", M: "kewajiban", P: "larangan", W: "peringatan" },
    "K",
    "10.4",
    "L2600-2602",
  ),
  d(
    "P10-40",
    "fire.minLegend",
    "Legenda minimum denah kebakaran",
    "list",
    [
      "detektor asap",
      "detektor panas",
      "titik panggil manual",
      "alarm bunyi dan visual",
      "panel MCFA",
      "APAR atau hidran",
      "jalur evakuasi",
    ],
    "K",
    "10.4",
    "L2604-2606",
  ),
  d("P10-41", "symbol.verifyBeforeConstruction", "Verifikasi simbol sebelum terbit konstruksi", "bool", true, "K", "SM-11", "L2433, L4718", {
    classNote: "K (manusia); cocokkan ke basis data IEC 60617",
  }),
  d("P10-42", "symbol.paidStandardsNotCopied", "Standar berbayar tidak disalin", "bool", true, "K", "SM-12", "L2682, L4720"),
];

/** 135 parameter figur global: P7 36, P8 2, P9 55, P10 42. */
export const PARAMS_FIGURE: readonly ParamDef[] = [...P7, ...P8, ...P9, ...P10];

/** Hitungan target katalog; isi larik wajib sama dengan angka ini. */
export const PARAMS_FIGURE_COUNT = 135;
