// Row 163: one fixture per Vega-family chart type (studio.chart-vega/v1), as an agent would send them.
// Deterministic data (no Math.random): same fixture -> same SVG.

const common = (kind: string, n: string, title: string) => ({
  $schema: "studio.chart-vega/v1",
  kind,
  id: `GAMBAR 4.${n}`,
  title,
  source: "Data uji Swarm, diolah.",
  widthMm: 128,
  apparatus: "figure",
});

/** Small deterministic pseudo-random sequence (LCG). */
export function seq(seed: number, n: number, lo: number, hi: number): number[] {
  let x = seed >>> 0;
  return Array.from({ length: n }, () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return Math.round((lo + ((hi - lo) * x) / 0xffffffff) * 10) / 10;
  });
}

const year = (): Array<{ date: string; value: number }> => {
  const vals = seq(7, 365, 0, 40);
  const t0 = Date.UTC(2026, 0, 1);
  return vals.map((v, i) => ({ date: new Date(t0 + i * 86_400_000).toISOString().slice(0, 10), value: v }));
};

export const FIXTURES: Record<string, Record<string, unknown>> = {
  "V-01": {
    ...common("V-01", "1", "Insiden harian sepanjang 2026."),
    unit: "insiden",
    data: { shape: "days", days: year() },
    accent: { point: "2026-08-17" },
  },
  "V-02": {
    ...common("V-02", "2", "Volume laporan per kanal, Januari sampai Desember."),
    data: {
      shape: "series",
      categories: ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"],
      series: [
        { name: "Telepon", values: seq(1, 12, 20, 60) },
        { name: "Surel", values: seq(2, 12, 10, 40) },
        { name: "Aplikasi", values: seq(3, 12, 30, 90) },
        { name: "Loket", values: seq(4, 12, 5, 25) },
      ],
    },
    accent: { series: "Aplikasi" },
  },
  "V-03": {
    ...common("V-03", "3", "Profil enam wilayah pada lima indikator layanan."),
    dec: 1,
    data: {
      shape: "matrix",
      rows: ["Wilayah A", "Wilayah B", "Wilayah C", "Wilayah D", "Wilayah E", "Wilayah F"],
      cols: ["Respons", "Tuntas", "Biaya", "Kepuasan", "Petugas"],
      values: [0, 1, 2, 3, 4, 5].map((i) => seq(101 + 7919 * i, 5, 10, 90)),
    },
    accent: { point: "Wilayah C" },
  },
  "V-04": {
    ...common("V-04", "4", "Sebaran waktu tanggap dua unit."),
    unit: "menit",
    data: {
      shape: "distribution",
      groups: [
        { name: "Unit utara", values: seq(21, 80, 2, 45) },
        { name: "Unit selatan", values: seq(22, 60, 5, 60) },
      ],
    },
    accent: { group: "Unit selatan" },
  },
  "V-05": {
    ...common("V-05", "5", "Laporan per jenis kejadian."),
    data: {
      shape: "categorical",
      points: [
        { label: "Banjir", value: 42 },
        { label: "Kebakaran", value: 18 },
        { label: "Longsor", value: 25 },
        { label: "Angin", value: 9 },
        { label: "Gempa", value: 6 },
        { label: "Kekeringan", value: 30 },
      ],
    },
    accent: { point: "Banjir" },
  },
  "V-06": {
    ...common("V-06", "6", "Profil kemampuan dua tim terhadap enam kriteria."),
    data: {
      shape: "series",
      categories: ["Analisis", "Respons", "Koordinasi", "Logistik", "Pelaporan", "Pelatihan"],
      series: [
        { name: "Tim A", values: [80, 65, 70, 55, 90, 60] },
        { name: "Tim B", values: [60, 85, 50, 75, 65, 80] },
      ],
    },
    accent: { series: "Tim B" },
    options: { max: 100 },
  },
  "V-07": {
    ...common("V-07", "7", "Komposisi anggaran per program dan kegiatan."),
    data: {
      shape: "hierarchy",
      nodes: [
        { id: "root", label: "Anggaran" },
        { id: "a", parent: "root", label: "Operasi" },
        { id: "b", parent: "root", label: "Pembinaan" },
        { id: "c", parent: "root", label: "Dukungan" },
        { id: "a1", parent: "a", label: "Patroli", value: 40 },
        { id: "a2", parent: "a", label: "Siaga", value: 25 },
        { id: "b1", parent: "b", label: "Latihan", value: 20 },
        { id: "b2", parent: "b", label: "Kajian", value: 10 },
        { id: "c1", parent: "c", label: "Logistik", value: 18 },
        { id: "c2", parent: "c", label: "TI", value: 12 },
      ],
    },
    accent: { point: "a1" },
  },
  "V-08": {
    ...common("V-08", "8", "Struktur organisasi satuan tugas."),
    data: {
      shape: "hierarchy",
      nodes: [
        { id: "k", label: "Komandan" },
        { id: "o", parent: "k", label: "Operasi" },
        { id: "i", parent: "k", label: "Intelijen" },
        { id: "l", parent: "k", label: "Logistik" },
        { id: "o1", parent: "o", label: "Regu 1" },
        { id: "o2", parent: "o", label: "Regu 2" },
        { id: "o3", parent: "o", label: "Regu 3" },
        { id: "i1", parent: "i", label: "Analis" },
        { id: "i2", parent: "i", label: "Pengumpul" },
        { id: "l1", parent: "l", label: "Gudang" },
        { id: "l2", parent: "l", label: "Angkutan" },
      ],
    },
    accent: { point: "i" },
  },
};

/** Second forms (V-07 icicle, V-08 dendrogram) rendered in the same tests. */
export const VARIANTS: Record<string, Record<string, unknown>> = {
  "V-07 icicle": { ...FIXTURES["V-07"], options: { form: "icicle" } },
  "V-08 dendrogram": { ...FIXTURES["V-08"], options: { form: "dendrogram" } },
};
