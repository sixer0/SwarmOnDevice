/**
 * `studio.chart/v1` (01_specs.md §3.5). Pemetaan bentuk data per kode ada di
 * `ChartDef.dataShape` (registri S09). Lantai: font min 5,5 pt fisik, maks 5
 * warna, maks 1 aksen, tinggi maks 247 mm, teks nyata di SVG.
 *
 * Atribut peran SVG (N2): setiap tanda data membawa `data-mark` (lihat
 * `CHART_DATA_MARKS`), `data-series`, `data-index`; sumbu `data-axis="x|y"`;
 * panel komposit `<g data-panel="<code>">`. Dekorasi tidak membawa `data-mark`.
 */
import type { ChartCode, ChartIntentOrientation, ChartIntentSort } from "../enums";
import type { ParamValue } from "./common";
import type { StudioDiagramV1 } from "./diagram";

export interface StudioChartV1 {
  $schema: "studio.chart/v1";
  /** Kode drawn=false -> 422 CHART_KIND_NOT_DRAWN + alternatives. */
  kind: ChartCode | "composite";
  /** "Gambar 8.1" (P3-14). */
  id?: string;
  /** Satu kalimat, diakhiri titik. */
  title: string;
  source: string;
  /**
   * Lebar figur (mm) = anggota himpunan lebar turunan kertas `grid.allowedFigureWidthsMm`
   * (D-158, D-245 H1; A4 128/166). Keanggotaan ditegakkan mesin chart (`figureLimits`, G2).
   */
  widthMm: number;
  heightMm?: number;
  unit?: string;
  dec?: 0 | 1 | 2 | 3;
  apparatus?: "page" | "figure";
  inDocument?: boolean;
  note?: string;
  /** Wajib bila kind != composite. */
  data?: ChartData;
  /** Kunci khusus registri chart (87) + global P7 kelas B. */
  params?: Record<string, ParamValue>;
  /** gallery = gaya panel Gambar 8.1-8.5 (research/06:219). */
  style?: "datum" | "gallery";
  /** P-11 threshold. */
  limit?: number;
  limitLabel?: string;
  composite?: ChartComposite;
  /**
   * Aksen tunggal pada tingkat spec (delta S03-d1, D-58): titik (label/indeks),
   * grup, atau seri. Alias lama di `params` tetap diterima (CHART_ACCENT_PARAM_ALIASES);
   * bila keduanya ada, `accent` menang. Medan `accent: true` per titik tetap sah.
   */
  accent?: ChartAccent;
  /**
   * Metadata bebas yang TIDAK digambar (delta IP-41d, D-113): asal transkripsi,
   * catatan, `seriesNames: ASUMSI`. Berlaku juga pada ChartPanelSpec (via Omit).
   * Renderer dan registri mengabaikannya.
   */
  x?: Record<string, unknown>;
  /**
   * Delta FIG-03a (D-482 butir 2): maksud analitis opsional (konten, bukan tampilan). Diisi
   * perakit dari medan blok chart v2 (`orientation`, `sort`, `topN`, `otherLabel`,
   * `labelShort`); absen = perilaku mesin sebelum FIG-03a (SVG byte-identik). Hanya pada spec
   * tingkat atas (panel komposit tidak membawanya).
   */
  intent?: ChartIntent;
}

/** FIG-03a — maksud analitis chart (E58, E59, C61; register agen §17 bagian grafik). */
export interface ChartIntent {
  /** Arah baca kategori; `auto` = perilaku mesin (termasuk AUTO_ORIENT). */
  orientation?: ChartIntentOrientation;
  /** Urutan kategori; `none` = urutan agen. */
  sort?: ChartIntentSort;
  /** Pertahankan N kategori terbesar (3..30), sisanya digabung menjadi satu kategori "Lainnya (k)". */
  topN?: number;
  /** Label kategori gabungan `topN` (maks 40 karakter; bawaan "Lainnya"). */
  otherLabel?: string;
  /** Label sumbu singkat per kategori; label lengkap tetap di data dan `<title>` SVG. */
  labelShort?: ChartLabelShort[];
}

/** FIG-03a — pasangan label kategori lengkap -> label sumbu singkat. */
export interface ChartLabelShort {
  /** Label kategori yang ada (titik kategoris atau `categories` seri), persis sama. */
  label: string;
  /** Teks sumbu/tick pengganti (maks 32 karakter). */
  short: string;
}

export interface ChartAccent {
  point?: string | number;
  group?: string;
  series?: string;
}

/** Alias `params` untuk ChartAccent (dipakai S94 sebelum delta S03-d1). */
export const CHART_ACCENT_PARAM_ALIASES = { point: "accentPoint", group: "accentGroup", series: "accentSeries" } as const;

export type ChartData =
  | { shape: "categorical"; points: Array<{ label: string; value: number; accent?: boolean; sub?: string }> }
  | { shape: "series"; categories: string[]; series: Array<{ name: string; values: Array<number | null>; accent?: boolean }> }
  | { shape: "xy"; points: Array<{ x: number; y: number; size?: number; label?: string; group?: string; accent?: boolean }> }
  | { shape: "matrix"; rows: string[]; cols: string[]; values: number[][] }
  | {
      shape: "intervals";
      items: Array<{ label: string; start: number | string; end: number | string; group?: string; milestone?: boolean }>;
    }
  | {
      shape: "graph";
      nodes: Array<{ id: string; label: string; value?: number; group?: string }>;
      links: Array<{ from: string; to: string; value?: number }>;
    }
  | { shape: "distribution"; groups: Array<{ name: string; values: number[] }> }
  | {
      shape: "tiles";
      tiles: Array<{ code: string; row: number; col: number; value?: number; label?: string }>;
      flows?: Array<{ from: string; to: string; value: number }>;
      dots?: Array<{ tile: string; dx?: number; dy?: number; label?: string }>;
    }
  | { shape: "ohlc"; points: Array<{ t: string; o: number; h: number; l: number; c: number }> }
  | { shape: "sets"; sets: Array<{ name: string; size: number }>; overlaps: Array<{ sets: string[]; size: number }> }
  /** G-04 lewat mesin diagram flow (S43). */
  | { shape: "steps"; spec: StudioDiagramV1 };

export type ChartDataShape = ChartData["shape"];

export const CHART_DATA_SHAPES = [
  "categorical",
  "series",
  "xy",
  "matrix",
  "intervals",
  "graph",
  "distribution",
  "tiles",
  "ohlc",
  "sets",
  "steps",
] as const satisfies readonly ChartDataShape[];

export type ChartPanelSpec = Omit<StudioChartV1, "$schema" | "composite" | "widthMm" | "source" | "title" | "intent"> & { kind: ChartCode };

/** Komposit galeri: panel bernama berisi kode chart (permintaan S02). */
export interface ChartComposite {
  columns: 1 | 2 | 3;
  gapMm?: number;
  panels: Array<{
    /** "Bar urut". */
    name: string;
    code: ChartCode;
    caption?: string;
    /** "x ... / y ...". */
    axisNote?: string;
    spec: ChartPanelSpec;
  }>;
}

/** Jenis tertutup atribut `data-mark` pada tanda data SVG (N2). */
export const CHART_DATA_MARKS = [
  "bar",
  "column",
  "point",
  "line",
  "area",
  "segment",
  "slice",
  "cell",
  "node",
  "link",
  "tile",
  "interval",
  "box",
  "whisker",
  "label-value",
] as const;
export type ChartDataMark = (typeof CHART_DATA_MARKS)[number];
