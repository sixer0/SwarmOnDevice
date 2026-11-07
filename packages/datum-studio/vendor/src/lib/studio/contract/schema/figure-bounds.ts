/**
 * SEC-FIX / SEC-FIX2 (D-501, D-506): batas kapasitas figur, SATU sumber untuk skema kontrak (`maxItems` /
 * `maxLength` chart/diagram v1, blok figur dokumen v1, blok figur v2) dan cek kapasitas pra-render
 * (`services/render/figure-limits.ts`). Mesin chart/diagram berjalan sinkron di event loop HQ dengan biaya
 * super-linear, jadi setiap larik yang masuk mesin wajib berbatas. Nilai dipilih dari biaya mesin terukur dan butir
 * terbesar di fixture nyata (laporan `delegation_progress/coder_execution_secfix.md` dan `coder_execution_secfix2.md`);
 * dikunci uji `secfix2-schema-walk` (tidak ada larik figur tanpa `maxItems`) dan `secfix2-figure-bounds`.
 */
export const FIGURE_BOUNDS = {
  /** Butir berlabel per larik: kategori, butir interval, titik OHLC, petak, baris/kolom matriks, nilai per seri. */
  items: 200,
  /** Seri per grafik seri. */
  series: 24,
  /** Titik xy (sebar/hexbin/gelembung). */
  xyPoints: 2000,
  /** Sel matriks (dihitung dari isi `values` DAN `rows` x `cols`). */
  matrixCells: 5000,
  /** Simpul / tautan grafik jaringan (bentuk data `graph`). */
  graphNodes: 200,
  graphLinks: 400,
  /** Grup distribusi, nilai per grup, total nilai semua grup, tepi bin. */
  distributionGroups: 50,
  distributionValues: 5000,
  distributionTotal: 20000,
  binEdges: 201,
  /** Aliran dan titik pada peta petak. */
  tileFlows: 400,
  tileDots: 1000,
  /** Himpunan dan irisan Venn (anggota satu irisan <= jumlah himpunan). */
  sets: 16,
  setOverlaps: 256,
  /** Panel komposit dan total butir berlabel semua panel. */
  panels: 24,
  panelItemsTotal: 600,
  /** Simpul / tepi diagram (juga bentuk `steps`). */
  diagramNodes: 24,
  diagramEdges: 48,
  /** Zona diagram, anggota per zona, total anggota semua zona. */
  diagramZones: 24,
  zoneMembers: 24,
  zoneMembersTotal: 96,
  /** Butir legenda / catatan / sumber diagram. */
  diagramLegend: 24,
  diagramNotes: 24,
  diagramSources: 12,
  /**
   * Panjang teks diagram yang masuk loop tata letak mesin (karakter): judul, label simpul/sub/tepi/zona, sumber,
   * butir legenda/catatan. Sama dengan `maxLength` skema diagram v1; cek kapasitas memakainya juga untuk spec
   * terkomposisi dari blok v2 (judul = caption) dan spec tersimpan. `sourcesTotal` = jumlah karakter semua butir
   * `sources` (cek kapasitas saja; biaya graph naik kira-kira kubik: total 600 = 30 ms, 1200 = 0,4-0,7 s,
   * 2400 = 3-6 s, 3600 = 10-20 s).
   */
  diagramText: { title: 300, label: 300, source: 1000, item: 1000, sourcesTotal: 1000 },
  /**
   * Karakter per string di `data` chart (label kategori/seri/simpul/petak, dst.; = `maxLength` skema 200). Cek kapasitas
   * juga menerapkannya pada spec tersimpan: pada 200 karakter setiap fixture paritas chart <= 29 ms, pada 2000
   * karakter hingga 10,9 s (W-06), 1,7 s (P-10, W-02).
   */
  chartDataChars: 200,
  /** Run teks per caption / sumber / baris kunci figur; tab per format paragraf figur. */
  figureRuns: 64,
  figureTabs: 20,
  /** `params` chart v1 (bebas bentuk): kunci per objek, butir per larik, karakter per string. */
  paramProperties: 256,
  paramItems: 256,
  /** Karakter per string mana pun di spec figur selain metadata `x` (cek kapasitas; skema per medan lebih ketat). */
  stringChars: 2000,
  /** Fallback per larik yang tidak dikenal cek kapasitas (= larik sah terbesar, nilai distribusi). */
  anyArray: 5000,
  /** Total elemen semua larik dalam satu spec figur (distribusi penuh 20000 + tepi bin + sisa; komposit xy). */
  totalElements: 30000,
  /** Ukuran serial JSON (UTF-8) satu spec / satu blok figur. */
  figureBytes: 1024 * 1024,
} as const;
