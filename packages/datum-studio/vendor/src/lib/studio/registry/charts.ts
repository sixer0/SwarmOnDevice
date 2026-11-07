/**
 * Registri chart Studio (01_specs.md §5.1 T06, §5.3; S09).
 *
 * - 58 jenis tergambar (P 15, H 9, K 12, W 10, S 8, G 4) + 18 jenis `drawn=false`
 *   (DF-01..DF-18, ditolak render dengan CHART_KIND_NOT_DRAWN + alternatif).
 * - 136 ParamDef khusus chart (`chart.kind.<KODE>.<nama>`, group "P7X"): 87 dari katalog
 *   manual + 12 parameter mesin (IP-25, D-87) = kunci lokal keluarga yang sudah dibaca
 *   renderer S38/S40/S41, kini terdaftar agar alias pendek dan templat memakai satu jalur,
 *   + 37 petunjuk tergambar panel galeri (31 IP-39/IP-41c, D-113: domain sumbu, label
 *   langsung, warna naik/turun, dst.; dulu `panelParamsMoved` index.json; + 3 domain sumbu
 *   P-13/P-14/S-01 IP-59/FIX-A, D-227; + 3 domain sumbu S-02/S-03/S-04 FIX-A2). Group P7X =
 *   cakupan `section:chart` (registry/slots.ts) dan lapis `advanced` (registry/essentials.ts).
 *
 * Sumber: research/01_manual_parameter_catalog.md §3.6.2 (kode, jenis, parameter),
 * research/04_manual_docx_tables.md T065-T069 (Tabel 8.1-8.5: fungsi, pakai, hindari),
 * research/06_chart_map_parity_matrix.md §5.1-5.2 (acuan Python `pyRef`, kelas paritas,
 * 18 jenis tak digambar). `dataShape` diselaraskan dengan bentuk data yang dibaca
 * adapter acuan `scripts/parity/reference/fig/pc_inject.py` (permintaan S65).
 */
import type { ChartCode, ChartCustomMark, ChartCustomOrientation, DrawnChartCode, UndrawnChartCode } from "../contract/enums";
import type { ChartDataShape } from "../contract/types/chart";
import type { ParamValue } from "../contract/types/common";
import type { ChartDef, ChartModule, ParamDef, ParamType } from "../contract/types/params";
import type { ChartCustomFormV2 } from "../contract/types/v2/contract";

export type { ChartDef };

// ── Pembangun entri chart ────────────────────────────────────────────────

type Group = ChartDef["group"];
type Purpose = ChartDef["purpose"];
type PyRef = ChartDef["pyRef"];
type Table = ChartDef["manualTable"];

const TABLE_BY_GROUP: Record<Group, Table> = { P: "8.1", H: "8.2", K: "8.3", W: "8.4", S: "8.5", G: "8.5" };
const PURPOSE_BY_GROUP: Record<Group, Purpose> = {
  P: "perbandingan",
  H: "hubungan",
  K: "komposisi",
  W: "waktu",
  S: "sebaran",
  G: "geospasial",
};

/** Acuan datumchart (Rev L, Garis B): keluarga `bar | column | threshold`. */
const dc = (ref: string, dataOrigin: string): PyRef => ({ kind: "datumchart", ref, form: "PENUH", dataOrigin });
/** Acuan pustakachart (Garis A): fungsi galeri; `form` PENUH atau PARSIAL (research/06 §5.1.2). */
const pc = (ref: string, form: "PENUH" | "PARSIAL", dataOrigin: string): PyRef => ({
  kind: "pustakachart",
  ref,
  form,
  dataOrigin,
});
const NO_REF: PyRef = { kind: "none" };

/** CA = datumchart; CB1 = pustakachart PENUH; CB2 = pustakachart PARSIAL; CC = tanpa acuan (research/06 §6.2). */
function parityOf(ref: PyRef): NonNullable<ChartDef["parityClass"]> {
  if (ref.kind === "datumchart") return "CA";
  if (ref.kind === "pustakachart") return ref.form === "PARSIAL" ? "CB2" : "CB1";
  return "CC";
}

/** Modul keluarga mesin chart (01_specs.md §5.3). */
const MODULE_BY_CODE: Record<DrawnChartCode, ChartModule> = {
  "P-01": "core",
  "P-02": "core",
  "P-11": "core",
  "W-02": "core",
  "P-03": "family-p1",
  "P-04": "family-p1",
  "P-05": "family-p1",
  "P-06": "family-p1",
  "P-07": "family-p1",
  "P-08": "family-p1",
  "P-09": "family-p2",
  "P-10": "family-p2",
  "P-12": "family-p2",
  "P-13": "family-p2",
  "P-14": "family-p2",
  "P-15": "family-p2",
  "H-01": "family-h1",
  "H-02": "family-h1",
  "H-03": "family-h1",
  "H-04": "family-h1",
  "H-05": "family-h1",
  "H-06": "family-h2",
  "H-07": "family-h2",
  "H-08": "family-h2",
  "H-09": "family-h2",
  "K-01": "family-k1",
  "K-02": "family-k1",
  "K-03": "family-k1",
  "K-04": "family-k1",
  "K-05": "family-k1",
  "K-06": "family-k1",
  "K-07": "family-k2",
  "K-08": "family-k2",
  "K-09": "family-k2",
  "K-10": "family-k2",
  "K-11": "family-k2",
  "K-12": "family-k2",
  "W-01": "family-w1",
  "W-03": "family-w1",
  "W-04": "family-w1",
  "W-05": "family-w1",
  "W-06": "family-w2",
  "W-07": "family-w2",
  "W-08": "family-w2",
  "W-09": "family-w2",
  "W-10": "family-w2",
  "S-01": "family-s1",
  "S-02": "family-s1",
  "S-03": "family-s1",
  "S-04": "family-s1",
  "S-05": "family-s2",
  "S-06": "family-s2",
  "S-07": "family-s2",
  "S-08": "family-s2",
  "G-01": "family-g",
  "G-02": "family-g",
  "G-03": "family-g",
  "G-04": "family-g",
};

/** Kunci parameter khusus per kode, diturunkan dari CHART_PARAMS (urutan deklarasi). */
function paramKeysOf(code: string): readonly string[] {
  const prefix = `chart.kind.${code}.`;
  return CHART_PARAM_LIST.filter((p) => p.key.startsWith(prefix)).map((p) => p.key);
}

interface DrawnRow {
  code: DrawnChartCode;
  name: string;
  fn: string;
  useWhen: string;
  avoidWhen: string;
  dataShape: ChartDataShape;
  pyRef: PyRef;
  purpose?: Purpose;
}

function drawn(r: DrawnRow): ChartDef {
  const group = r.code[0] as Group;
  const table = TABLE_BY_GROUP[group];
  return {
    code: r.code,
    name: r.name,
    group,
    purpose: r.purpose ?? PURPOSE_BY_GROUP[group],
    fn: r.fn,
    useWhen: r.useWhen,
    avoidWhen: r.avoidWhen,
    manualTable: table,
    drawn: true,
    dataShape: r.dataShape,
    paramKeys: paramKeysOf(r.code),
    pyRef: r.pyRef,
    parityClass: parityOf(r.pyRef),
    module: MODULE_BY_CODE[r.code],
    benchmarkFigure: table,
  };
}

interface UndrawnRow {
  code: UndrawnChartCode;
  name: string;
  group: Group;
  purpose: Purpose;
  table: Table;
  fn: string;
  useWhen: string;
  avoidWhen: string;
  alternatives: readonly ChartCode[];
  pyRef?: PyRef;
}

function undrawn(r: UndrawnRow): ChartDef {
  return {
    code: r.code,
    name: r.name,
    group: r.group,
    purpose: r.purpose,
    fn: r.fn,
    useWhen: r.useWhen,
    avoidWhen: r.avoidWhen,
    manualTable: r.table,
    drawn: false,
    paramKeys: [],
    pyRef: r.pyRef ?? NO_REF,
    alternatives: r.alternatives,
    renderErrorCode: "CHART_KIND_NOT_DRAWN",
  };
}

// ── 136 parameter khusus chart (87 katalog + 12 mesin + 37 petunjuk galeri) ──

type Extra = Pick<ParamDef, "range" | "enum" | "pattern" | "class" | "classNote" | "ruleRef"> & {
  /** Parameter mesin (bukan katalog manual): sumber = berkas pembaca di engine/chart. */
  engine: boolean;
  /** Petunjuk tergambar panel galeri (IP-39/IP-41c): sumber = panel Gambar 8.x + berkas pembaca. */
  hint: boolean;
};

/** [kode, nama, label, tipe, default, sumber, tambahan?]. Kelas B kecuali disebut. */
type P = [code: DrawnChartCode, name: string, label: string, type: ParamType, def: ParamValue, source: string, extra?: Partial<Extra>];

const SORT = ["valueDesc", "valueAsc", "byDifference", "natural"] as const;
/** Catatan kelas petunjuk domain sumbu (IP-39). */
const AXIS_NOTE = "[min, maks] tercetak; tidak diset = domain otomatis; nilai di luar memperluasnya + REPORT AXIS_DOMAIN";
/** Catatan kelas petunjuk berdefault gaya (null = perilaku bawaan gaya). */
const AUTO_STYLE = (what: string): string => `tidak diset = menurut gaya: ${what}`;

const PARAM_ROWS: readonly P[] = [
  // P perbandingan (26)
  ["P-01", "sort", "Urutan batang", "enum", "valueDesc", "L1602-1604, L1884-1885", { enum: SORT }],
  ["P-01", "accent", "Aksen batang", "enum", "topBarOnly", "L1602-1604, L1884-1885", { enum: ["topBarOnly", "none"] }],
  ["P-01", "valueLabel", "Letak label nilai", "enum", "barEnd", "L1602-1604, L1884-1885", { enum: ["barEnd", "inside", "none"] }],
  ["P-03", "maxSeries", "Seri maksimum", "int", 3, "L1609-1610, L1887-1888", { range: { min: 1, max: 3, step: 1 } }],
  ["P-03", "targetColour", "Warna seri target", "tokenRef", "ink200", "L1609-1610, L1887-1888"],
  ["P-04", "stemWeight", "Tebal tangkai", "enum", "thin", "L1612-1613, L1890-1891", { enum: ["thin", "regular"] }],
  ["P-04", "zeroBaseline", "Garis dasar nol", "bool", true, "L1612-1613, L1890-1891"],
  ["P-04", "sort", "Urutan kategori", "enum", "valueDesc", "L1612-1613, L1890-1891", { enum: SORT }],
  ["P-05", "gridlines", "Gridline wajib", "bool", true, "L1615-1616"],
  ["P-06", "startColour", "Warna titik awal", "tokenRef", "ink400", "L1618-1619, L1893-1894"],
  ["P-06", "endColour", "Warna titik akhir", "tokenRef", "signal", "L1618-1619, L1893-1894"],
  ["P-06", "sort", "Urutan kategori", "enum", "byDifference", "L1618-1619, L1893-1894", { enum: SORT }],
  ["P-08", "labelsBothSides", "Label di kedua sisi", "bool", true, "L1624-1625, L1902-1903"],
  ["P-08", "upColour", "Warna garis naik", "tokenRef", "verd", "L1624-1625, L1902-1903"],
  ["P-08", "downColour", "Warna garis turun", "tokenRef", "alert", "L1624-1625, L1902-1903"],
  ["P-09", "bandLevels", "Tingkat pita kinerja", "int", 3, "L1627-1628, L1896-1897", { range: { min: 1, max: 5, step: 1 } }],
  ["P-09", "actualBar", "Batang realisasi", "bool", true, "L1627-1628, L1896-1897"],
  ["P-09", "targetLine", "Garis target", "bool", true, "L1627-1628, L1896-1897"],
  ["P-10", "endsGroundedAtZero", "Awal dan akhir dari nol", "bool", true, "L1630-1631, L1899-1900"],
  ["P-10", "signedDeltaLabels", "Label selisih bertanda", "bool", true, "L1630-1631, L1899-1900"],
  [
    "P-11",
    "limitLine.labelled",
    "Garis batas berlabel",
    "bool",
    true,
    "L1633-1634, L1442-1449",
    { class: "K", ruleRef: "CH-12" },
  ],
  [
    "P-11",
    "overLimitColour",
    "Warna batang melewati batas",
    "tokenRef",
    "alert",
    "L1633-1634, L1442-1449",
    { class: "K", ruleRef: "CH-12" },
  ],
  ["P-12", "sharedScale", "Skala bersama", "bool", true, "L1636-1637, L1289"],
  [
    "P-13",
    "dividerJustification",
    "Alasan garis pembagi (wajib)",
    "string",
    null,
    "L1639-1640, L1943-1944",
    { classNote: "wajib diisi bila garis pembagi kuadran dipakai" },
  ],
  ["P-13", "quadrantNames", "Nama kuadran", "list", [], "L1639-1640, L1943-1944"],
  ["P-15", "colourRuleLegend", "Keterangan aturan warna wajib", "bool", true, "L1645-1646"],
  // H hubungan (9)
  ["H-01", "xIsPresumedCause", "X sebagai dugaan sebab", "bool", true, "L1668-1669, L1905-1906"],
  ["H-01", "trendLine", "Garis tren (opsional)", "bool", false, "L1668-1669, L1905-1906"],
  ["H-02", "areaProportional", "Luas proporsional", "bool", true, "L1671-1672, L1913-1914"],
  ["H-02", "directLabels", "Label langsung", "bool", true, "L1671-1672, L1913-1914"],
  [
    "H-03",
    "ramp",
    "Ramp warna tunggal",
    "pair",
    ["white", "signal"],
    "L1674-1675, L1916-1917",
    { classNote: "putih ke signal (KT-08, P7-27)" },
  ],
  ["H-03", "scaleShown", "Skala warna tampil", "bool", true, "L1674-1675, L1916-1917"],
  ["H-07", "nodeSize", "Ukuran simpul", "enum", "degree", "L1686-1687, L1956-1957", { enum: ["degree", "uniform"] }],
  ["H-07", "highlightBridges", "Sorot penghubung utama", "bool", true, "L1686-1687, L1956-1957"],
  ["H-09", "maxSets", "Himpunan maksimum", "int", 3, "L1697-1698", { range: { min: 2, max: 3, step: 1 } }],
  // K komposisi (16)
  ["K-02", "maxSegments", "Segmen maksimum", "int", 4, "L1720-1721, L1919-1920", { range: { min: 2, max: 4, step: 1 } }],
  ["K-02", "keySegmentLeft", "Segmen kunci di kiri", "bool", true, "L1720-1721, L1919-1920"],
  ["K-03", "meaningfulMidpoint", "Titik tengah bermakna wajib", "bool", true, "L1723-1725"],
  [
    "K-04",
    "groups",
    "Jumlah kelompok",
    "int",
    2,
    "L1727-1728",
    { range: { min: 2, max: 2, step: 1 }, classNote: "bilangan 2 atau daftar 2 nama kelompok [kiri, kanan] (panel galeri, IP-41c)" },
  ],
  ["K-05", "maxSlices", "Iris maksimum", "int", 5, "L1730-1732, L1922-1923", { range: { min: 2, max: 5, step: 1 } }],
  [
    "K-05",
    "startAngle",
    "Sudut mulai",
    "deg",
    0,
    "L1730-1732, L1922-1923",
    { range: { min: 0, max: 359, step: 1 }, classNote: "0 = jam 12" },
  ],
  ["K-05", "clockwise", "Searah jarum jam", "bool", true, "L1730-1732, L1922-1923"],
  ["K-06", "maxSlices", "Iris maksimum", "int", 5, "L1734-1735", { range: { min: 2, max: 5, step: 1 } }],
  ["K-06", "oneDominant", "Satu iris dominan wajib", "bool", true, "L1734-1735"],
  ["K-07", "grid", "Ukuran grid", "string", "10x10", "L1737-1738", { pattern: "^[0-9]+x[0-9]+$" }],
  ["K-09", "labelsInside", "Label di dalam kotak", "bool", true, "L1742-1743, L1925-1926"],
  ["K-09", "limitSmallBoxes", "Batasi kotak kecil", "bool", true, "L1742-1743, L1925-1926"],
  ["K-10", "stageValues", "Nilai per tahap", "bool", true, "L1745, L1940-1941"],
  ["K-10", "conversionPercent", "Persen konversi", "bool", true, "L1745, L1940-1941"],
  ["K-11", "maxLevels", "Tingkat maksimum", "int", 3, "L1747-1748, L1953-1954", { range: { min: 2, max: 3, step: 1 } }],
  ["K-11", "maxEndNodes", "Simpul akhir maksimum", "int", 12, "L1747-1748, L1953-1954", { classNote: "sekitar 12" }],
  // W waktu (16)
  ["W-01", "maxLines", "Garis maksimum", "int", 3, "L1774-1776, L1928", { range: { min: 1, max: 3, step: 1 } }],
  ["W-01", "labelAtLineEnd", "Label di ujung garis", "bool", true, "L1774-1776, L1928"],
  ["W-02", "maxPeriods", "Periode maksimum", "int", 12, "L1778", { range: { min: 1, max: 12, step: 1 } }],
  [
    "W-04",
    "zeroBaseline",
    "Garis dasar nol",
    "bool",
    true,
    "L1783-1784, L4659",
    { class: "K" },
  ],
  ["W-05", "largestAtBottom", "Lapisan terbesar di bawah", "bool", true, "L1790-1792, L1931-1932"],
  ["W-05", "maxLayers", "Lapisan maksimum", "int", 4, "L1790-1792, L1931-1932", { range: { min: 2, max: 4, step: 1 } }],
  ["W-07", "rowPerTask", "Satu baris per tugas", "bool", true, "L1795-1797, L1949-1951"],
  ["W-07", "milestones", "Milestone", "list", ["BAST", "UAT"], "L1795-1797, L1949-1951"],
  ["W-07", "todayLine", "Garis hari ini", "bool", true, "L1795-1797, L1949-1951"],
  ["W-07", "rowsInProposal", "Jumlah baris dalam proposal", "range", [8, 15], "L1795-1797, L1949-1951"],
  ["W-08", "rowPerEventType", "Satu baris per jenis kejadian", "bool", true, "L1799-1800, L1965-1967"],
  ["W-08", "riskyTypeColour", "Warna jenis berisiko", "tokenRef", "alert", "L1799-1800, L1965-1967"],
  ["W-09", "subtractBaseline", "Kurangi garis dasar", "bool", true, "L1801-1803, L1962-1963"],
  ["W-09", "bands", "Jumlah pita", "range", [2, 3], "L1801-1803, L1962-1963"],
  ["W-09", "fold", "Lipat area", "bool", true, "L1801-1803, L1962-1963"],
  ["W-09", "bandLegend", "Legenda pita wajib", "bool", true, "L1801-1803, L1962-1963"],
  // S sebaran (14)
  ["S-01", "bins", "Jumlah bin", "range", [10, 20], "L1826-1827, L1934-1935"],
  ["S-01", "medianMarker", "Penanda median", "bool", true, "L1826-1827, L1934-1935"],
  ["S-02", "median", "Tampilkan median", "bool", true, "L1829-1830, L1937-1938"],
  ["S-02", "box50", "Kotak 50 persen tengah", "bool", true, "L1829-1830, L1937-1938"],
  ["S-02", "outlierPoints", "Titik pencilan", "bool", true, "L1829-1830, L1937-1938"],
  ["S-05", "periodOrder", "Urutan periode", "bool", true, "L1842-1843, L1975-1976"],
  ["S-05", "slightOverlap", "Tumpang tindih tipis", "bool", true, "L1842-1843, L1975-1976"],
  ["S-05", "sharedAxis", "Sumbu bersama", "bool", true, "L1842-1843, L1975-1976"],
  ["S-05", "maxGroups", "Kelompok maksimum", "int", 12, "L1842-1843, L1975-1976", { range: { min: 1, max: 12, step: 1 } }],
  ["S-07", "columnPerGroup", "Satu kolom per kelompok", "bool", true, "L1848, L1972-1973"],
  ["S-07", "medianMarker", "Penanda median", "bool", true, "L1848, L1972-1973"],
  ["S-08", "northUp", "Utara di atas", "bool", true, "L1850-1851, L1969-1970"],
  ["S-08", "clockwise", "Searah jarum jam", "bool", true, "L1850-1851, L1969-1970"],
  ["S-08", "uniformSectors", "Sektor seragam", "bool", true, "L1850-1851, L1969-1970"],
  // G geospasial dan proses (6)
  ["G-01", "standardAbbrev", "Singkatan baku", "bool", true, "L1853-1854, L1959-1960"],
  ["G-01", "singleRamp", "Satu ramp warna", "bool", true, "L1853-1854, L1959-1960"],
  ["G-01", "valueInTile", "Nilai di dalam petak", "bool", true, "L1853-1854, L1959-1960"],
  ["G-04", "singleReadingDirection", "Satu arah baca", "bool", true, "L1862-1864, L1983-1984"],
  ["G-04", "standardShapes", "Bentuk baku", "string", "ISO 5807", "L1862-1864, L1983-1984"],
  ["G-04", "maxSteps", "Langkah maksimum", "int", 10, "L1862-1864, L1983-1984", { classNote: "sekitar 10" }],
  // Parameter mesin (12; IP-25, D-87): tipe/default = perilaku keluarga saat ini. Default null
  // = tidak diset (keluarga memakai aturan bawaannya). Bentuk alternatif yang juga dibaca
  // lewat kunci penuh tercatat di classNote dan CHART_PARAM_ALT_FORMS (engine/chart/core/params.ts).
  [
    "S-02",
    "whisker",
    "Panjang kumis (x IQR)",
    "number",
    1.5,
    "family-s1/box.ts (matplotlib whis)",
    { engine: true, range: { min: 0.01 }, classNote: "angka > 0; berlaku bila outlierPoints = true" },
  ],
  [
    "S-03",
    "bandwidth",
    "Lebar pita KDE",
    "number",
    null,
    "family-s1/density.ts",
    { engine: true, range: { min: 0 }, classNote: "angka > 0 atau silverman | scott; tidak diset = silverman" },
  ],
  [
    "S-04",
    "bandwidth",
    "Lebar pita KDE",
    "number",
    null,
    "family-s1/violin.ts",
    { engine: true, range: { min: 0 }, classNote: "angka > 0 atau silverman | scott; tidak diset = scott" },
  ],
  [
    "K-08",
    "grid",
    "Kisi ikon [baris, kolom]",
    "pair",
    null,
    "family-k2/icon-array.ts",
    { engine: true, classNote: "[baris, kolom] atau RxC, 1..40; tidak diset = 10 ikon per baris" },
  ],
  [
    "K-08",
    "icon",
    "Bentuk ikon",
    "enum",
    "person",
    "family-k2/icon-array.ts",
    { engine: true, enum: ["person", "circle", "square", "orang", "lingkaran", "kotak"] },
  ],
  [
    "K-08",
    "caption",
    "Keterangan bawah kisi",
    "string",
    null,
    "family-k2/icon-array.ts",
    { engine: true, classNote: "tidak diset = <nilai aksen> dari <total>" },
  ],
  ["K-11", "accentLink", "Pita beraksen [dari, ke]", "pair", null, "family-k2/sankey.ts", { engine: true, classNote: "id atau label simpul" }],
  [
    "K-12",
    "widths",
    "Lebar relatif kolom",
    "list",
    null,
    "family-k2/marimekko.ts",
    { engine: true, classNote: "satu bilangan > 0 per kategori; tidak diset = rata" },
  ],
  [
    "W-07",
    "todayAt",
    "Posisi garis hari ini",
    "number",
    null,
    "family-w2/gantt.ts",
    { engine: true, classNote: "angka sumbu atau tanggal ISO (jenis sama dengan sumbu waktu)" },
  ],
  ["W-07", "todayLabel", "Label garis hari ini", "string", "hari ini", "family-w2/gantt.ts", { engine: true }],
  [
    "W-08",
    "riskyTypes",
    "Jenis kejadian berisiko",
    "list",
    [],
    "family-w2/barcode.ts",
    { engine: true, classNote: "nama grup; diwarnai riskyTypeColour" },
  ],
  [
    "W-08",
    "highlightWindow",
    "Jendela sorot [awal, akhir]",
    "range",
    null,
    "family-w2/barcode.ts",
    { engine: true, classNote: "rona aksen 22 % (dekorasi)" },
  ],
  // Petunjuk tergambar panel galeri (31; IP-39/IP-41c, D-113): dulu index.json
  // `panelParamsMoved`. Default null = tidak diset (perilaku bawaan gaya, byte-identik);
  // `axis` = domain tercetak [min, maks] (core/scale.ts axisDomain: nilai di luar petunjuk
  // memperluasnya + REPORT AXIS_DOMAIN). K-04 `groups` (nama kelompok) memakai ParamDef
  // katalog yang ada + bentuk alternatif daftar (CHART_PARAM_ALT_FORMS).
  ["P-02", "valueLabel", "Label nilai di atas kolom", "bool", true, "Gambar 8.1 P-02; core/gallery.ts, core/datum.ts", { hint: true }],
  [
    "P-03",
    "seriesLabelsInPlot",
    "Label seri langsung di plot",
    "bool",
    null,
    "Gambar 8.1 P-03; family-p1/grouped-column.ts",
    { hint: true, classNote: AUTO_STYLE("gallery true (di atas kelompok pertama), datum false (baris KUNCI)") },
  ],
  ["P-04", "axis", "Domain sumbu nilai [min, maks]", "range", null, "Gambar 8.1 P-04; family-p1/lollipop.ts", { hint: true, classNote: AXIS_NOTE }],
  ["P-05", "axis", "Domain sumbu nilai [min, maks]", "range", null, "Gambar 8.1 P-05; family-p1/dot-plot.ts", { hint: true, classNote: AXIS_NOTE }],
  [
    "P-05",
    "pointRoles",
    "Nama peran nilai per grup",
    "list",
    null,
    "Gambar 8.1 P-05; family-p1/dot-plot.ts",
    { hint: true, classNote: "satu nama per nilai grup (mis. [sebelum, sesudah]); peran terakhir ink900, sebelumnya ink200 lalu ink400; atribut data-role" },
  ],
  ["P-06", "axis", "Domain sumbu nilai [min, maks]", "range", null, "Gambar 8.1 P-06; family-p1/dumbbell.ts", { hint: true, classNote: AXIS_NOTE }],
  ["P-11", "axis", "Domain sumbu nilai [min, maks]", "range", null, "Gambar 8.1 P-11 (40..62); core/gallery.ts, core/datum.ts", { hint: true, classNote: AXIS_NOTE }],
  [
    "H-01",
    "trendColour",
    "Warna garis tren",
    "tokenRef",
    null,
    "Gambar 8.2 H-01; family-h1/scatter.ts",
    { hint: true, classNote: "tidak diset = aksen bila tidak ada titik beraksen, selain itu ink700" },
  ],
  [
    "H-03",
    "colTicks",
    "Label kolom yang ditampilkan",
    "list",
    null,
    "Gambar 8.2 H-03; family-h1/heatmap.ts",
    { hint: true, classNote: "nama kolom data.cols; tidak diset = penjarangan otomatis; nama tak dikenal -> REPORT" },
  ],
  [
    "H-04",
    "labelEnds",
    "Label titik awal dan akhir",
    "pair",
    null,
    "Gambar 8.2 H-04; family-h1/scatter.ts",
    { hint: true, classNote: "[awal, akhir]: hanya kedua ujung berlabel teks ini; tidak diset = label data pada ujung + titik beraksen" },
  ],
  [
    "H-05",
    "axis",
    "Domain sumbu {x, y}",
    "range",
    null,
    "Gambar 8.2 H-05; family-h1/hexbin.ts",
    { hint: true, classNote: "objek {x: [min, maks], y: [min, maks]} atau [min, maks] untuk keduanya; tidak diset = rentang sel + margin" },
  ],
  ["H-05", "axesUnlabelled", "Sumbu tanpa angka tick", "bool", null, "Gambar 8.2 H-05; family-h1/hexbin.ts", { hint: true, classNote: AUTO_STYLE("gallery true, datum false") }],
  ["K-01", "totalLabels", "Label total di ujung batang", "bool", null, "Gambar 8.3 K-01; family-k1/stack.ts", { hint: true, classNote: AUTO_STYLE("gallery true, datum false") }],
  [
    "K-01",
    "totalsFromLabel",
    "Total tercetak per kategori",
    "object",
    null,
    "Gambar 8.3 K-01; family-k1/stack.ts",
    { hint: true, classNote: "objek {kategori: angka}; teks total memakai angka ini, selisih dari jumlah segmen -> REPORT K-01.total" },
  ],
  [
    "K-02",
    "segmentValueLabels",
    "Label nilai di dalam segmen",
    "bool",
    null,
    "Gambar 8.3 K-02; family-k1/stack.ts",
    { hint: true, classNote: AUTO_STYLE("gallery segmen yang muat, datum segmen > 9 yang muat") },
  ],
  ["K-03", "sideLabels", "Label sisi [kiri, kanan]", "pair", null, "Gambar 8.3 K-03; family-k1/diverging.ts", { hint: true, classNote: "tidak diset = nama seri per sisi" }],
  [
    "K-05",
    "centerLabel",
    "Teks tengah donut",
    "string",
    null,
    "Gambar 8.3 K-05; family-k1/pie.ts",
    { hint: true, classNote: "<angka> <label> dipecah: angka besar, label kecil di bawahnya; tidak diset = persen + label iris kunci" },
  ],
  ["K-06", "sliceLabel", "Label di dalam iris kunci", "string", null, "Gambar 8.3 K-06; family-k1/pie.ts", { hint: true, classNote: "tidak diset = persen iris kunci (gallery)" }],
  ["K-07", "valueLabel", "Label nilai besar di samping kisi", "string", null, "Gambar 8.3 K-07; family-k2/waffle.ts", { hint: true, classNote: "tidak diset = nilai bagian beraksen (gallery)" }],
  ["W-01", "axis", "Domain sumbu y [min, maks]", "range", null, "Gambar 8.4 W-01; family-w1/frame.ts", { hint: true, classNote: AXIS_NOTE }],
  ["W-02", "valueLabel", "Label nilai di atas kolom", "bool", true, "Gambar 8.4 W-02; core/gallery.ts, core/datum.ts", { hint: true }],
  [
    "W-03",
    "step",
    "Arah anak tangga",
    "enum",
    "post",
    "Gambar 8.4 W-03; family-w1/render.ts",
    { hint: true, enum: ["post", "pre", "mid"], classNote: "post = nilai bertahan sampai titik berikut (matplotlib where)" },
  ],
  ["W-03", "axis", "Domain sumbu y [min, maks]", "range", null, "Gambar 8.4 W-03; family-w1/frame.ts", { hint: true, classNote: AXIS_NOTE }],
  ["W-06", "rankAxisInverted", "Peringkat 1 di atas", "bool", true, "Gambar 8.4 W-06; family-w2/bump.ts", { hint: true, classNote: "false = peringkat 1 di bawah" }],
  ["W-08", "axis", "Domain sumbu waktu [min, maks]", "range", null, "Gambar 8.4 W-08; family-w2/barcode.ts", { hint: true, classNote: AXIS_NOTE }],
  [
    "W-10",
    "upColour",
    "Warna batang naik",
    "tokenRef",
    null,
    "Gambar 8.4 W-10; family-w2/candlestick.ts",
    { hint: true, classNote: AUTO_STYLE("gallery ink700, datum ink900 berongga") },
  ],
  [
    "W-10",
    "downColour",
    "Warna batang turun",
    "tokenRef",
    null,
    "Gambar 8.4 W-10; family-w2/candlestick.ts",
    { hint: true, classNote: AUTO_STYLE("gallery limitExceeded, datum ink900 penuh") },
  ],
  ["W-10", "axis", "Domain sumbu harga [min, maks]", "range", null, "Gambar 8.4 W-10; family-w2/candlestick.ts", { hint: true, classNote: AXIS_NOTE }],
  [
    "G-02",
    "schematic",
    "Mode peta skematis",
    "enum",
    "KT-12 grid tile",
    "Gambar 8.5 G-02; family-g/dot-flow.ts",
    { hint: true, enum: ["KT-12 grid tile"], classNote: "satu-satunya mode (D-22 KT-12); nilai dicatat di REPORT KT-12" },
  ],
  [
    "G-02",
    "regionFrame",
    "Bingkai wilayah",
    "enum",
    null,
    "Gambar 8.5 G-02; family-g/dot-flow.ts",
    { hint: true, enum: ["dashed", "solid", "none"], classNote: AUTO_STYLE("gallery dashed, datum petak berisi ink100") },
  ],
  [
    "G-03",
    "schematic",
    "Mode peta skematis",
    "enum",
    "KT-12 grid tile",
    "Gambar 8.5 G-03; family-g/dot-flow.ts",
    { hint: true, enum: ["KT-12 grid tile"], classNote: "satu-satunya mode (D-22 KT-12); nilai dicatat di REPORT KT-12" },
  ],
  // Domain sumbu panel yang dulu hanya petunjuk data `params.axis` (3 + 3; IP-59/FIX-A D-227, FIX-A2 N3):
  // konten v2 tidak membawa `axis` (DISPLAY_FIELD DF-63..65), jadi domain = parameter templat
  // dan compose meneruskannya ke spec mesin. Default null = domain otomatis mesin v1.
  [
    "P-13",
    "axis",
    "Domain sumbu {x, y}",
    "range",
    null,
    "Gambar 8.1 P-13; family-p2/quadrant.ts",
    { hint: true, classNote: "objek {x?: [min, maks], y?: [min, maks]}: sumbu yang diset tercetak tepat [min, maks]; tidak diset = domain rapi data" },
  ],
  [
    "P-14",
    "axis",
    "Domain sumbu nilai [min, maks]",
    "range",
    null,
    "Gambar 8.1 P-14; family-p2/arrow.ts",
    { hint: true, classNote: "[min, maks] tercetak tepat; tidak diset = domain rapi pasangan nilai" },
  ],
  [
    "S-01",
    "axis",
    "Domain sumbu nilai [min, maks]",
    "range",
    null,
    "Gambar 8.5 S-01; family-s1/common.ts valueDomain",
    { hint: true, classNote: "[min, maks]; data di luar memperluasnya + REPORT AXIS_HINT; tidak diset = domain rapi data" },
  ],
  // Saudara keluarga S1 (3; FIX-A2 N3, pola D-268): pembaca yang sama (`family-s1/common.ts`
  // hintAxis/valueDomain) membaca domain sumbu nilai; tanpa ParamDef domain ini tidak dapat
  // diatur di v2 (konten `axis` = DISPLAY_FIELD). Default null = domain otomatis mesin v1.
  [
    "S-02",
    "axis",
    "Domain sumbu nilai [min, maks]",
    "range",
    null,
    "Gambar 8.5 S-02; family-s1/box.ts valueDomain",
    { hint: true, classNote: "[min, maks]; data di luar memperluasnya + REPORT AXIS_HINT; tidak diset = domain rapi data" },
  ],
  [
    "S-03",
    "axis",
    "Domain sumbu nilai [min, maks]",
    "range",
    null,
    "Gambar 8.5 S-03; family-s1/density.ts",
    {
      hint: true,
      classNote: "[min, maks]; kurva density dipotong ke rentang ini, data di luar memperluas sumbu + REPORT AXIS_HINT; tidak diset = domain rapi data",
    },
  ],
  [
    "S-04",
    "axis",
    "Domain sumbu nilai [min, maks]",
    "range",
    null,
    "Gambar 8.5 S-04; family-s1/violin.ts valueDomain",
    { hint: true, classNote: "[min, maks]; data di luar memperluasnya + REPORT AXIS_HINT; tidak diset = domain rapi data" },
  ],
];

function buildParam([code, name, label, type, def, source, extra]: P): ParamDef {
  const def_: ParamDef = {
    id: `P7X-${code}-${name.replace(/\./g, "")}`,
    key: `chart.kind.${code}.${name}`,
    label: `${code} ${label}`,
    type,
    default: def,
    class: extra?.class ?? "B",
    ruleRef: extra?.ruleRef ?? "-",
    source: extra?.hint
      ? `petunjuk galeri ${code}: ${source} (bukan katalog manual; IP-39/IP-41c, D-113)`
      : extra?.engine
        ? `mesin ${code}: ${source} (bukan katalog manual; IP-25, D-87)`
        : `research/01 §3.6.2 ${code}: ${source}`,
    // Kontrak hanya mengenal origin "catalog" | "contract" ("contract" = parameter renderer grup R);
    // parameter mesin tetap grup P7X sehingga dicatat "catalog", asal sebenarnya di `source`.
    origin: "catalog",
    group: "P7X",
    chapter: "Bab 7-8",
    namespace: "chart",
  };
  if (extra?.range) def_.range = extra.range;
  if (extra?.enum) def_.enum = extra.enum;
  if (extra?.pattern) def_.pattern = extra.pattern;
  if (extra?.classNote) def_.classNote = extra.classNote;
  return def_;
}

const CHART_PARAM_LIST: readonly ParamDef[] = PARAM_ROWS.map(buildParam);

// ── 58 jenis tergambar ───────────────────────────────────────────────────

const DRAWN_CHARTS: readonly ChartDef[] = [
  // Tabel 8.1 perbandingan
  drawn({
    code: "P-01",
    name: "Bar urut",
    fn: "Panjang batang sama dengan nilai per kategori",
    useWhen: "Label kategori panjang; nilai sebesaran",
    avoidWhen: "Lebih dari 30 batang, ganti treemap",
    dataShape: "categorical",
    pyRef: dc("bar", "spec; bantu PCD:PERANGKAT, HARGA (v01_bar_ranking)"),
  }),
  drawn({
    code: "P-02",
    name: "Column",
    fn: "Bar yang diputar 90°",
    useWhen: "Label pendek; urutan alami; sedikit periode",
    avoidWhen: "Label panjang, ganti bar",
    dataShape: "categorical",
    pyRef: dc("column", "spec; bantu PCD:TAHUN, VOLUME_PROYEK (v02_column_time)"),
  }),
  drawn({
    code: "P-03",
    name: "Grouped column",
    fn: "Beberapa batang per kategori",
    useWhen: "Dua sampai tiga seri, misalnya target dan realisasi",
    avoidWhen: "Banyak seri, ganti small multiples",
    dataShape: "series",
    pyRef: pc("v04_grouped_column", "PENUH", "PCD:PERANGKAT, HARGA, HARGA_B"),
  }),
  drawn({
    code: "P-04",
    name: "Lollipop",
    fn: "Garis tipis dengan titik di ujung",
    useWhen: "Banyak kategori, ruang terbatas",
    avoidWhen: "Nilai sangat berdekatan, ganti bar",
    dataShape: "categorical",
    pyRef: pc("v05_lollipop", "PENUH", "PCD:PERANGKAT, HARGA"),
  }),
  drawn({
    code: "P-05",
    name: "Dot plot",
    fn: "Satu atau beberapa titik per kategori",
    useWhen: "Sumbu tidak perlu mulai nol",
    avoidWhen: "Tanpa gridline, titik kehilangan acuan",
    dataShape: "distribution",
    pyRef: pc("v06_dotplot", "PARSIAL", "PCD:MTBF, SITE (+ jitter RNG internal)"),
  }),
  drawn({
    code: "P-06",
    name: "Dumbbell",
    fn: "Dua titik dihubungkan garis",
    useWhen: "Selisih dua kondisi, sebelum dan sesudah",
    avoidWhen: "Data tidak berpasangan",
    dataShape: "series",
    pyRef: pc("v07_dumbbell", "PENUH", "PCD:AUDIT_OBJEK, AUDIT_H1, AUDIT_H2"),
  }),
  drawn({
    code: "P-07",
    name: "Range plot",
    fn: "Batang rentang minimum sampai maksimum",
    useWhen: "Fokus pada lebar celah",
    avoidWhen: "Fokus satu nilai, ganti bar",
    dataShape: "distribution",
    pyRef: pc("v09_range", "PENUH", "LITERAL (PC:284-287: grup literal + RNG SEED+9)"),
  }),
  drawn({
    code: "P-08",
    name: "Slope",
    fn: "Dua sumbu tegak dihubungkan garis",
    useWhen: "Tepat dua titik waktu",
    avoidWhen: "Lebih dari dua titik, ganti line",
    dataShape: "series",
    pyRef: pc("v11_slope", "PENUH", "PCD:AUDIT_OBJEK, AUDIT_H1, AUDIT_H2"),
  }),
  drawn({
    code: "P-09",
    name: "Bullet",
    fn: "Realisasi, target, dan pita kinerja dalam satu baris",
    useWhen: "KPI terhadap target",
    avoidWhen: "Tidak ada target",
    dataShape: "categorical",
    pyRef: pc("v95_bullet", "PARSIAL", "PCD:BULLET (satu baris)"),
  }),
  drawn({
    code: "P-10",
    name: "Waterfall",
    fn: "Batang mengambang dari awal ke akhir",
    useWhen: "Perubahan bersih: kas, laba, stok",
    avoidWhen: "Nilai absolut tiap komponen",
    dataShape: "categorical",
    pyRef: pc("v91_waterfall", "PENUH", "PCD:WATERFALL"),
  }),
  drawn({
    code: "P-11",
    name: "Threshold",
    fn: "Batang terhadap garis batas berlabel",
    useWhen: "Nilai rekayasa terhadap batas",
    avoidWhen: "Tidak ada batas yang dinyatakan",
    dataShape: "categorical",
    pyRef: dc("threshold", "spec; cek G5 DC:119-121; bantu legacy_threshold opsional (PC:1435)"),
  }),
  drawn({
    code: "P-12",
    name: "Small multiples",
    fn: "Chart sama diulang per kelompok",
    useWhen: "Memecah chart terlalu padat",
    avoidWhen: "Satu chart sudah cukup",
    dataShape: "series",
    pyRef: pc("v13_small_multiples", "PENUH", "PCD:SM_MULT (maks 6 panel, kisi 2x3 tetap)"),
  }),
  drawn({
    code: "P-13",
    name: "Quadrant",
    fn: "Scatter dibagi empat kuadran",
    useWhen: "Prioritas dua kriteria",
    avoidWhen: "Garis pembagi tanpa alasan",
    dataShape: "xy",
    pyRef: pc("v72_quadrant", "PENUH", "PCD:SCAT_X, SCAT_Y, SCAT_ANNOT (nama kuadran LITERAL PC:1076-1081)"),
  }),
  drawn({
    code: "P-14",
    name: "Arrow chart",
    fn: "Dumbbell berpanah",
    useWhen: "Arah perubahan sama penting dengan besarnya",
    avoidWhen: "Hanya satu kondisi",
    dataShape: "series",
    pyRef: NO_REF,
  }),
  drawn({
    code: "P-15",
    name: "Table chart",
    fn: "Tabel dengan pewarnaan bersyarat",
    useWhen: "Pembaca butuh angka persis",
    avoidWhen: "Aturan warna tanpa keterangan",
    dataShape: "matrix",
    pyRef: pc("v15_table", "PENUH", "PCD:TABLE_ROWS, TABLE_HEAD (aturan warna LITERAL PC:364-371)"),
  }),
  // Tabel 8.2 hubungan
  drawn({
    code: "H-01",
    name: "Scatter",
    fn: "Titik pada sumbu X dan Y",
    useWhen: "Korelasi, klaster, pencilan",
    avoidWhen: "Ribuan titik bertumpuk, ganti hexbin",
    dataShape: "xy",
    pyRef: pc("v66_scatter", "PENUH", "PCD:SCAT_X, SCAT_Y, SCAT_ANNOT (trendLine=false)"),
  }),
  drawn({
    code: "H-02",
    name: "Bubble",
    fn: "Scatter dengan ukuran sebagai variabel ketiga",
    useWhen: "Tiga variabel numerik",
    avoidWhen: "Gelembung saling tumpuk",
    dataShape: "xy",
    pyRef: pc("v67_bubble", "PENUH", "PCD:SCAT_X, SCAT_Y, SCAT_SIZE, SCAT_ANNOT"),
  }),
  drawn({
    code: "H-03",
    name: "Heatmap",
    fn: "Nilai sebagai intensitas warna dalam grid",
    useWhen: "Pola hari × jam, matriks korelasi",
    avoidWhen: "Butuh selisih presisi",
    dataShape: "matrix",
    pyRef: pc("v73_heatmap", "PARSIAL", "PCD:SKOR_M, FAKTOR, NAMA_SITE6 (ramp acuan abu-abu; KT-08 putih ke signal)"),
  }),
  drawn({
    code: "H-04",
    name: "Connected scatter",
    fn: "Scatter dihubungkan menurut waktu",
    useWhen: "Dua variabel bergerak bersama",
    avoidWhen: "Pembaca awam tanpa anotasi",
    dataShape: "xy",
    pyRef: pc("v68_conn_scatter", "PENUH", "PCD:CS_X, CS_Y (anotasi LITERAL)"),
  }),
  drawn({
    code: "H-05",
    name: "Hexbin",
    fn: "Heatmap kepadatan sarang lebah",
    useWhen: "Ribuan titik",
    avoidWhen: "Sampel kecil",
    dataShape: "xy",
    pyRef: pc("v70_hexbin", "PENUH", "PCD:SCAT_X, SCAT_Y"),
  }),
  drawn({
    code: "H-06",
    name: "Contour",
    fn: "Garis nilai sama",
    useWhen: "Permukaan kontinu: elevasi, sinyal",
    avoidWhen: "Data jarang",
    dataShape: "matrix",
    pyRef: pc("v71_contour", "PENUH", "PCD:medan_sinyal (fungsi, PCD:179-182); grid LITERAL"),
  }),
  drawn({
    code: "H-07",
    name: "Network",
    fn: "Simpul dan garis penghubung",
    useWhen: "Analisis relasi OSINT, topologi",
    avoidWhen: "Ratusan simpul tanpa filter",
    dataShape: "graph",
    pyRef: pc("v79_network", "PENUH", "PCD:NET_NODES, NET_EDGES, NET_LINK_UTAMA"),
  }),
  drawn({
    code: "H-08",
    name: "Arc diagram",
    fn: "Simpul di satu garis, dihubungkan busur",
    useWhen: "Relasi sedikit sampai sedang",
    avoidWhen: "Banyak koneksi",
    dataShape: "graph",
    pyRef: NO_REF,
  }),
  drawn({
    code: "H-09",
    name: "Venn atau Euler",
    fn: "Lingkaran bertumpuk untuk irisan himpunan",
    useWhen: "Dua sampai tiga himpunan",
    avoidWhen: "Lebih dari tiga himpunan",
    dataShape: "sets",
    pyRef: NO_REF,
  }),
  // Tabel 8.3 komposisi dan aliran
  drawn({
    code: "K-01",
    name: "Stacked bar",
    fn: "Batang dibelah menjadi segmen",
    useWhen: "Total dan kontribusi; sedikit segmen",
    avoidWhen: "Membandingkan segmen atas",
    dataShape: "series",
    pyRef: pc("_stack_rows", "PENUH", "PARAM (labels, parts, total100=False, lebar, tinggi); bantu v20_stacked_column"),
  }),
  drawn({
    code: "K-02",
    name: "100 % stacked bar",
    fn: "Batang sama panjang, segmen persen",
    useWhen: "Porsi lebih penting dari total",
    avoidWhen: "Butuh total absolut",
    dataShape: "series",
    pyRef: pc("v19_stacked_bar", "PENUH", "LITERAL di v19 (PC:427-428); disuntik lewat panggilan langsung _stack_rows (PARAM)"),
  }),
  drawn({
    code: "K-03",
    name: "Diverging bar",
    fn: "Batang ke kiri dan kanan dari nol",
    useWhen: "Positif dan negatif, skala Likert",
    avoidWhen: "Tidak ada titik tengah bermakna",
    dataShape: "series",
    pyRef: pc("v21_diverging_bar", "PENUH", "PCD:SURVEI_ASP, SETUJU, TIDAK_SETUJU"),
  }),
  drawn({
    code: "K-04",
    name: "Population pyramid",
    fn: "Diverging bar usia × dua kelompok",
    useWhen: "Struktur demografi",
    avoidWhen: "Lebih dari dua kelompok",
    dataShape: "series",
    pyRef: pc("v23_pyramid", "PENUH", "PCD:JENJANG, FRONT_END, BACK_END"),
  }),
  drawn({
    code: "K-05",
    name: "Donut",
    fn: "Pie berlubang, angka kunci di tengah",
    useWhen: "Sedikit bagian, ada total yang ditonjolkan",
    avoidWhen: "Perbandingan presisi",
    dataShape: "categorical",
    pyRef: NO_REF,
  }),
  drawn({
    code: "K-06",
    name: "Pie",
    fn: "Lingkaran dibagi irisan",
    useWhen: "Maks. lima kategori, satu dominan",
    avoidWhen: "Selisih kecil",
    dataShape: "categorical",
    pyRef: NO_REF,
  }),
  drawn({
    code: "K-07",
    name: "Waffle",
    fn: "Grid 10 × 10, satu kotak 1 %",
    useWhen: "Progres untuk pembaca awam",
    avoidWhen: "Angka tidak bulat",
    dataShape: "categorical",
    pyRef: pc("v24_waffle", "PENUH", "PCD:WAFFLE_PARTS"),
  }),
  drawn({
    code: "K-08",
    name: "Icon array",
    fn: "Satu ikon satu unit",
    useWhen: "Rasio mudah dihitung",
    avoidWhen: "Jumlah besar",
    dataShape: "categorical",
    pyRef: pc("v26_icon_circles", "PARSIAL", "PCD:KAMERA_SITE; bantu v25_square_area"),
  }),
  drawn({
    code: "K-09",
    name: "Treemap",
    fn: "Persegi bersarang, luas sama dengan nilai",
    useWhen: "Banyak kategori hierarkis",
    avoidWhen: "Banyak kotak kecil",
    dataShape: "categorical",
    pyRef: pc("v32_treemap", "PENUH", "PCD:TREEMAP (grup dari points[].sub)"),
  }),
  drawn({
    code: "K-10",
    name: "Funnel",
    fn: "Batang menyempit per tahap",
    useWhen: "Tahapan berurutan",
    avoidWhen: "Butuh presisi antar tahap",
    dataShape: "categorical",
    pyRef: pc("v37_funnel", "PENUH", "PCD:FUNNEL"),
  }),
  drawn({
    code: "K-11",
    name: "Sankey",
    fn: "Pita yang tebalnya sama dengan volume",
    useWhen: "Aliran RAB, energi, anggaran",
    avoidWhen: "Terlalu banyak simpul",
    dataShape: "graph",
    pyRef: NO_REF,
    purpose: "aliranProses",
  }),
  drawn({
    code: "K-12",
    name: "Marimekko",
    fn: "Stacked bar dengan lebar bervariasi",
    useWhen: "Dua proporsi bertingkat",
    avoidWhen: "Banyak segmen kecil",
    dataShape: "series",
    pyRef: pc("v31_marimekko", "PENUH", "PCD:MARIMEKKO (lebar kolom dari params.widths)"),
  }),
  // Tabel 8.4 waktu
  drawn({
    code: "W-01",
    name: "Line",
    fn: "Titik dihubungkan garis sepanjang waktu",
    useWhen: "Tren data rapat; sumbu tidak wajib nol",
    avoidWhen: "Lebih dari tiga garis tanpa sorotan",
    dataShape: "series",
    pyRef: pc("v41_line", "PENUH", "PCD:BITRATE_A, BITRATE_B (2 seri tetap, 12 titik)"),
  }),
  drawn({
    code: "W-02",
    name: "Column waktu",
    fn: "Batang per periode",
    useWhen: "Maks. 12 periode",
    avoidWhen: "Banyak periode, ganti line",
    dataShape: "categorical",
    pyRef: dc("column", "spec; bantu v02_column_time (PC:205)"),
  }),
  drawn({
    code: "W-03",
    name: "Step line",
    fn: "Garis berbentuk tangga",
    useWhen: "Perubahan pada saat tertentu: harga, restok",
    avoidWhen: "Berubah di setiap titik",
    dataShape: "series",
    pyRef: pc("v48_step", "PENUH", "LITERAL (PC:771 tarif) + PCD:BULAN"),
  }),
  drawn({
    code: "W-04",
    name: "Area",
    fn: "Line dengan area terisi",
    useWhen: "Akumulasi yang mulai dari nol",
    avoidWhen: "Data tidak mulai dari nol",
    dataShape: "categorical",
    pyRef: pc("v42_area", "PENUH", "PCD:BULAN, BEBAN_KW"),
  }),
  drawn({
    code: "W-05",
    name: "Stacked area",
    fn: "Area seri ditumpuk",
    useWhen: "Tren total dan kontribusi",
    avoidWhen: "Membandingkan seri satu sama lain",
    dataShape: "series",
    pyRef: pc("v43_stacked_area", "PENUH", "PCD:BITRATE_A, BITRATE_B, BITRATE_C (3 lapis tetap, 12 titik)"),
  }),
  drawn({
    code: "W-06",
    name: "Bump",
    fn: "Peringkat dari waktu ke waktu",
    useWhen: "Siapa naik dan turun",
    avoidWhen: "Butuh nilai sebenarnya",
    dataShape: "series",
    pyRef: pc("v45_bump", "PENUH", "PCD:BUMP_SERI, BUMP_KV (4 periode tetap PC:734)"),
  }),
  drawn({
    code: "W-07",
    name: "Gantt",
    fn: "Batang durasi pada garis waktu",
    useWhen: "Jadwal proyek, milestone BAST",
    avoidWhen: "Ratusan tugas; pecah per fase",
    dataShape: "intervals",
    pyRef: pc("v94_gantt", "PENUH", "PCD:GANTT, GANTT_MILESTONE (satu milestone, tanpa garis hari ini)"),
  }),
  drawn({
    code: "W-08",
    name: "Barcode",
    fn: "Garis tegak di setiap kejadian",
    useWhen: "Linimasa forensik, deret alarm",
    avoidWhen: "Pengganti tabel log",
    dataShape: "distribution",
    pyRef: pc("v60_barcode", "PARSIAL", "PCD:PING_MS"),
  }),
  drawn({
    code: "W-09",
    name: "Horizon",
    fn: "Area dilipat menjadi pita",
    useWhen: "Puluhan sensor dalam satu layar",
    avoidWhen: "Tanpa legenda pita",
    dataShape: "series",
    pyRef: NO_REF,
  }),
  drawn({
    code: "W-10",
    name: "Candlestick",
    fn: "Buka, tutup, tertinggi, terendah",
    useWhen: "Audiens keuangan",
    avoidWhen: "Audiens umum",
    dataShape: "ohlc",
    pyRef: NO_REF,
  }),
  // Tabel 8.5 sebaran, geospasial, proses
  drawn({
    code: "S-01",
    name: "Histogram",
    fn: "Data dikelompokkan ke rentang",
    useWhen: "Bentuk sebaran satu variabel",
    avoidWhen: "Bin terlalu banyak atau sedikit",
    dataShape: "distribution",
    pyRef: pc("v52_hist", "PARSIAL", "PCD:LATENSI (bins=24 LITERAL PC:846)"),
  }),
  drawn({
    code: "S-02",
    name: "Box plot",
    fn: "Median, kuartil, pencilan",
    useWhen: "Sebaran beberapa kelompok",
    avoidWhen: "Audiens awam tanpa keterangan",
    dataShape: "distribution",
    pyRef: pc("v54_box", "PENUH", "PCD:MTBF, SITE"),
  }),
  drawn({
    code: "S-03",
    name: "Density",
    fn: "Histogram versi kurva halus",
    useWhen: "Data kontinu tanpa efek bin",
    avoidWhen: "Sampel kecil",
    dataShape: "distribution",
    pyRef: pc("v53_density", "PENUH", "PCD:LATENSI"),
  }),
  drawn({
    code: "S-04",
    name: "Violin",
    fn: "Box plot dengan bentuk kepadatan",
    useWhen: "Bentuk dan sebaran kelompok",
    avoidWhen: "Audiens awam",
    dataShape: "distribution",
    pyRef: pc("v55_violin", "PENUH", "PCD:MTBF, SITE (3 grup tetap PC:893)"),
  }),
  drawn({
    code: "S-05",
    name: "Ridgeline",
    fn: "Kurva kepadatan ditumpuk",
    useWhen: "Pergeseran sebaran per bulan",
    avoidWhen: "Lebih dari 12 kelompok",
    dataShape: "distribution",
    pyRef: pc("v59_ridge", "PENUH", "PCD:MTBF, SITE"),
  }),
  drawn({
    code: "S-06",
    name: "Strip atau jitter",
    fn: "Setiap pengamatan sebagai titik",
    useWhen: "Sampel kecil sampai sedang",
    avoidWhen: "Ribuan titik",
    dataShape: "distribution",
    pyRef: pc("v57_jitter", "PENUH", "PCD:MTBF, SITE (+ jitter RNG internal seeded); bantu v56_strip"),
  }),
  drawn({
    code: "S-07",
    name: "Beeswarm",
    fn: "Titik rapat tanpa bertumpuk",
    useWhen: "Semua kasus terlihat",
    avoidWhen: "Data sangat banyak",
    dataShape: "distribution",
    pyRef: NO_REF,
  }),
  drawn({
    code: "S-08",
    name: "Radial histogram",
    fn: "Histogram melingkar",
    useWhen: "Data arah atau jam dalam sehari",
    avoidWhen: "Data bukan arah",
    dataShape: "distribution",
    pyRef: NO_REF,
  }),
  drawn({
    code: "G-01",
    name: "Tile map",
    fn: "Satu kotak sama besar per wilayah",
    useWhen: "Membandingkan 38 provinsi secara adil",
    avoidWhen: "Butuh bentuk geografis",
    dataShape: "tiles",
    pyRef: pc("v84_tilemap", "PARSIAL", "PCD:TILE_ROWS, TILE_COLS, TILE_SCORE, TILE_LABEL"),
  }),
  drawn({
    code: "G-02",
    name: "Dot map",
    fn: "Satu titik satu lokasi",
    useWhen: "Sebaran lokasi kantor atau insiden",
    avoidWhen: "Ribuan titik bertumpuk",
    dataShape: "tiles",
    pyRef: NO_REF,
  }),
  drawn({
    code: "G-03",
    name: "Flow map",
    fn: "Panah antar lokasi, tebal sama dengan volume",
    useWhen: "Rute logistik, jaringan kantor",
    avoidWhen: "Terlalu banyak garis",
    dataShape: "tiles",
    pyRef: NO_REF,
  }),
  drawn({
    code: "G-04",
    name: "Flowchart",
    fn: "Kotak dan panah ISO 5807",
    useWhen: "SOP, rantai kustodi",
    avoidWhen: "Data angka; gambar dibangun mesin diagram (Bab 9)",
    dataShape: "steps",
    pyRef: pc("v81_flow", "PARSIAL", "PCD:FLOW (posisi 6 langkah LITERAL PC:1125-1126); paritas utama lewat diagram flow (S43)"),
    purpose: "aliranProses",
  }),
];

// ── 18 jenis drawn=false ─────────────────────────────────────────────────

const UNDRAWN_NOTE = {
  fn: "Profil, banyak dimensi, atau hiasan",
  useWhen: "Hanya untuk tim analis, atau tidak dipakai",
  avoidWhen: "Butuh presisi, ganti bar (P-01)",
} as const;

const UNDRAWN_CHARTS: readonly ChartDef[] = [
  // Tabel 8.1
  undrawn({ code: "DF-01", name: "Radar", group: "P", purpose: "perbandingan", table: "8.1", ...UNDRAWN_NOTE, alternatives: ["P-01"] }),
  undrawn({ code: "DF-02", name: "Parallel coordinates", group: "P", purpose: "perbandingan", table: "8.1", ...UNDRAWN_NOTE, alternatives: ["P-01"] }),
  undrawn({ code: "DF-03", name: "Nightingale", group: "P", purpose: "perbandingan", table: "8.1", ...UNDRAWN_NOTE, alternatives: ["P-01"] }),
  undrawn({ code: "DF-04", name: "Radial bar", group: "P", purpose: "perbandingan", table: "8.1", ...UNDRAWN_NOTE, alternatives: ["P-01"] }),
  undrawn({ code: "DF-05", name: "Word cloud", group: "P", purpose: "perbandingan", table: "8.1", ...UNDRAWN_NOTE, alternatives: ["P-01"] }),
  // Tabel 8.2
  undrawn({
    code: "DF-06",
    name: "Chord diagram",
    group: "H",
    purpose: "hubungan",
    table: "8.2",
    fn: "Busur dan pita antar kategori",
    useWhen: "Pertukaran data antar sedikit instansi",
    avoidWhen: "Banyak kategori, ganti heatmap (H-03)",
    alternatives: ["H-03"],
  }),
  // Tabel 8.3
  ...(
    [
      ["DF-07", "Sunburst"],
      ["DF-08", "Circle packing"],
      ["DF-09", "Dendrogram"],
      ["DF-10", "Gauge"],
      ["DF-11", "Semicircle donut"],
    ] as const
  ).map(([code, name]) =>
    undrawn({
      code,
      name,
      group: "K",
      purpose: "komposisi",
      table: "8.3",
      fn: "Hierarki melingkar atau satu KPI",
      useWhen: "Hierarki 2 sampai 3 level; satu indikator",
      avoidWhen: "Presisi penting, ganti treemap (K-09) atau bullet (P-09)",
      alternatives: ["K-09", "P-09"],
      // DF-09 dan DF-12 punya fungsi galeri; tidak dirender (research/06 §5.2).
      pyRef: code === "DF-09" ? { kind: "pustakachart", ref: "v36_dendro", dataOrigin: "PCD:DENDRO_LEAF, DENDRO_TREE" } : undefined,
    }),
  ),
  // Tabel 8.4
  ...(
    [
      ["DF-12", "Spline"],
      ["DF-13", "Stream graph"],
      ["DF-14", "Spiral"],
      ["DF-15", "OHLC"],
    ] as const
  ).map(([code, name]) =>
    undrawn({
      code,
      name,
      group: "W",
      purpose: "waktu",
      table: "8.4",
      fn: "Varian halus, artistik, atau siklus",
      useWhen: "Kasus khusus",
      avoidWhen: "Hampir selalu ganti line (W-01)",
      alternatives: ["W-01"],
      pyRef:
        code === "DF-12"
          ? { kind: "pustakachart", ref: "v47_spline", dataOrigin: "sebenarnya moving average (PC:767)" }
          : undefined,
    }),
  ),
  // Tabel 8.5
  undrawn({
    code: "DF-16",
    name: "Choropleth",
    group: "G",
    purpose: "geospasial",
    table: "8.5",
    fn: "Peta berwarna",
    useWhen: "Rasio per wilayah",
    avoidWhen: "Angka absolut pada choropleth; ganti tile map (G-01)",
    alternatives: ["G-01"],
  }),
  undrawn({
    code: "DF-17",
    name: "Bubble map",
    group: "G",
    purpose: "geospasial",
    table: "8.5",
    fn: "Peta bergelembung",
    useWhen: "Angka absolut",
    avoidWhen: "Gelembung bertumpuk; ganti dot map (G-02)",
    alternatives: ["G-02"],
  }),
  undrawn({
    code: "DF-18",
    name: "Heat map geospasial",
    group: "G",
    purpose: "geospasial",
    table: "8.5",
    fn: "Peta berwarna menurut intensitas",
    useWhen: "Rasio per wilayah",
    avoidWhen: "Butuh bentuk geografis presisi; ganti tile map (G-01)",
    alternatives: ["G-01"],
  }),
];

// ── Ekspor ───────────────────────────────────────────────────────────────

export const CHART_REGISTRY: readonly ChartDef[] = [...DRAWN_CHARTS, ...UNDRAWN_CHARTS];
export const CHART_PARAMS: readonly ParamDef[] = CHART_PARAM_LIST;

export const CHART_REGISTRY_COUNT = 76;
/** 87 katalog manual + 12 parameter mesin (IP-25) + 37 petunjuk tergambar galeri (31 IP-41c + 3 axis FIX-A + 3 axis FIX-A2). */
export const CHART_PARAMS_COUNT = 136;
export const CHART_CATALOG_PARAMS_COUNT = 87;
export const CHART_ENGINE_PARAMS_COUNT = 12;
export const CHART_HINT_PARAMS_COUNT = 37;

/** Indeks kode -> ChartDef. */
export const CHART_BY_CODE: ReadonlyMap<ChartCode, ChartDef> = new Map(CHART_REGISTRY.map((c) => [c.code, c]));

/**
 * Batas bentuk data yang dibaca acuan Python (adapter `pc_inject.py`, permintaan S65).
 * `ChartDef.dataShape` menunjuk bentuk `ChartData`; batas di bawah mempersempitnya
 * untuk uji paritas port (research/06 §6.3). Mesin Node tidak wajib mengikuti
 * batas ini kecuali di jalur uji paritas.
 */
export const CHART_DATA_CONSTRAINTS: Readonly<Partial<Record<DrawnChartCode, string>>> = {
  "P-03": "series: >= 2 seri; acuan membaca dua seri pertama",
  "P-05": "distribution: >= 3 grup (acuan membaca tiga grup)",
  "P-06": "series: >= 2 seri (H1, H2)",
  "P-07": "distribution: data literal acuan (PC:284-287), tidak disuntik",
  "P-08": "series: >= 2 seri (H1, H2)",
  "P-09": "categorical: satu baris; target dari params.target atau limit; params.max opsional (default 100)",
  "P-12": "series: 1..6 seri (kisi 2x3 tetap)",
  "P-15": "matrix (baris x kolom angka) atau params.tableRows + params.tableHead",
  "H-03": "matrix: tepat 6 baris x 8 kolom",
  "H-04": "xy: anotasi 08:00/23:00 literal acuan",
  "H-06": "matrix: diresampel bilinear ke grid literal 40x60 acuan",
  "H-07": "graph: params.positions {id:[x,y]} (0..1) opsional, bila tidak ada tata letak BFS bertingkat; params.accentLink [from,to]",
  "K-01": "series: kategori = batang, seri = segmen",
  "K-02": "series: kategori = batang, seri = segmen (disuntik lewat _stack_rows)",
  "K-03": "series: >= 2 seri (setuju, tidak setuju)",
  "K-04": "series: >= 2 seri (dua kelompok)",
  "K-07": "categorical: bagian > 3 hanya 3 pertama diwarnai oleh acuan",
  "K-09": "categorical: grup dibaca dari points[].sub",
  "K-12": "series: kategori = kolom, seri = bagian; lebar kolom dari params.widths (panjang = jumlah kategori), bila tidak ada dibagi rata",
  "W-01": "series: >= 2 seri, tepat 12 nilai per seri",
  "W-03": "series: data tarif literal acuan (PC:771), tidak disuntik",
  "W-05": "series: >= 3 seri, tepat 12 nilai per seri",
  "W-06": "series: tepat 4 kategori (periode)",
  "W-07": "intervals: start/end numerik (minggu); tepat satu item milestone",
  "W-08": "distribution: satu deret dibaca (grup pertama)",
  "S-01": "distribution: satu deret dibaca (grup pertama)",
  "S-03": "distribution: satu deret dibaca (grup pertama)",
  "S-04": "distribution: tepat 3 grup",
  "G-01": "tiles: petak kosong diisi 0; kisi dari row/col maksimum",
  "G-04": "steps: 1..6 langkah (posisi literal acuan)",
};

// ── chart.custom (05 §12; DC-26) ─────────────────────────────────────────

/** Bentuk data yang diterima `chart.custom` (05 §12: hanya `categorical`, `series`, `xy`). */
export const CHART_CUSTOM_DATA_SHAPES = ["categorical", "series", "xy"] as const satisfies readonly ChartDataShape[];
export type ChartCustomDataShape = (typeof CHART_CUSTOM_DATA_SHAPES)[number];

export type ChartCustomFormId = `CU-0${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

/** Satu baris tabel CU: kombinasi `form` x bentuk data -> kode keluarga tergambar yang sudah ada. */
export interface ChartCustomFormDef {
  id: ChartCustomFormId;
  mark: ChartCustomMark;
  orientation: ChartCustomOrientation;
  stacked: boolean;
  dataShape: ChartCustomDataShape;
  code: DrawnChartCode;
}

/**
 * C59 — CU-01..CU-09 (05 §12, KD-47). Setiap `code` adalah kode `drawn` dengan `dataShape`
 * sama di CHART_REGISTRY; bentuk kustom bukan kode chart, jadi CHART_REGISTRY_COUNT tetap 76.
 * Orientasi diverifikasi terhadap perender (CA-4): P-01 keluarga inti `bar` = batang mendatar
 * (`core/datum.ts`, `core/gallery.ts`), mengurutkan nilai menurun secara bawaan
 * (`chart.kind.P-01.sort` = `valueDesc`, `natural` mempertahankan urutan data; `core/prepare.ts`);
 * K-01 batang mendatar bertumpuk (`family-k1/stack.ts` hFrame); P-02/P-03 kolom tegak;
 * W-01/W-04/W-05 garis/area sumbu waktu mendatar; H-01/H-04 bidang x-y.
 */
export const CHART_CUSTOM_FORMS: readonly ChartCustomFormDef[] = [
  { id: "CU-01", mark: "bar", orientation: "horizontal", stacked: false, dataShape: "categorical", code: "P-01" },
  { id: "CU-02", mark: "bar", orientation: "vertical", stacked: false, dataShape: "categorical", code: "P-02" },
  { id: "CU-03", mark: "bar", orientation: "vertical", stacked: false, dataShape: "series", code: "P-03" },
  { id: "CU-04", mark: "bar", orientation: "horizontal", stacked: true, dataShape: "series", code: "K-01" },
  { id: "CU-05", mark: "line", orientation: "vertical", stacked: false, dataShape: "series", code: "W-01" },
  { id: "CU-06", mark: "area", orientation: "vertical", stacked: false, dataShape: "categorical", code: "W-04" },
  { id: "CU-07", mark: "area", orientation: "vertical", stacked: true, dataShape: "series", code: "W-05" },
  { id: "CU-08", mark: "point", orientation: "vertical", stacked: false, dataShape: "xy", code: "H-01" },
  { id: "CU-09", mark: "line", orientation: "vertical", stacked: false, dataShape: "xy", code: "H-04" },
];

/** C60 — pin hitungan CHART_CUSTOM_FORMS (uji dc26 menjaga = panjang array). */
export const CHART_CUSTOM_FORM_COUNT = 9;

/** Daftar `supported` untuk `details` 422 EC28 (05 §13.1). */
export const CHART_CUSTOM_FORM_IDS: readonly ChartCustomFormId[] = CHART_CUSTOM_FORMS.map((f) => f.id);

/**
 * I68 — kode tergambar untuk `form` x bentuk data, atau `null` bila kombinasi di luar
 * CU-01..CU-09 (pemanggil memetakan ke 422 EC28). Bawaan T2-66: `orientation` `vertical`,
 * `stacked` `false`. Masukan rusak (bukan objek, nilai di luar enum) juga -> `null`.
 */
export function resolveChartCustom(form: ChartCustomFormV2, dataShape: ChartDataShape): DrawnChartCode | null {
  if (typeof form !== "object" || form === null) return null;
  const orientation = form.orientation ?? "vertical";
  const stacked = form.stacked ?? false;
  if (typeof stacked !== "boolean") return null;
  const hit = CHART_CUSTOM_FORMS.find(
    (f) => f.mark === form.mark && f.orientation === orientation && f.stacked === stacked && f.dataShape === dataShape,
  );
  return hit?.code ?? null;
}
