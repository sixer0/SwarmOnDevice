/**
 * engine/chart/core — tata letak otomatis berpagar cacat (FIG-02a, audit research/18 §6).
 *
 * Dipanggil `renderChart` HANYA bila lint geometri render pertama menemukan cacat (render
 * bersih dikembalikan apa adanya, byte-identik). Kandidat, urutan "perubahan terkecil dulu":
 *
 * 1. render ulang dengan fit aktif pada tinggi bawaan (pembantu sadar-fit: caption
 *    berbungkus, label sumbu bertingkat, talang terukur, legenda multi-baris, penghindar
 *    tabrakan label);
 * 2. tangga tinggi kanvas (P0-3): tinggi bawaan x 1,25 .. 5, dijepit blok teks templat;
 *    tinggi lebih besar dipilih hanya bila skor cacat turun >= 50 % (atau menjadi 0);
 *    di atas 3 x hanya bila semua cacat hilang; faktor maksimum 1,25 / 2 / 5 untuk
 *    1-2 / 3-9 / >= 10 cacat (gambar tidak membengkak demi cacat kecil);
 * 3. orientasi horizontal otomatis (P1-4) untuk kolom kategoris P-02/W-02 -> tata letak
 *    batang P-01 (urutan data agen dipertahankan, `sort = natural`), REPORT `AUTO_ORIENT`.
 *
 * Kandidat terbaik = skor terkecil (seri: kandidat lebih awal); skor = cacat lint + penalti per
 * label yang disembunyikan (1) atau dipotong elipsis (0,5), lihat `candidateScore` (ENG-FIX #4). Kandidat yang tidak
 * lebih baik dari render pertama tidak pernah dipakai. Sisa cacat dilaporkan sebagai REPORT
 * `GEOM_*` dengan `suggest`. Tidak pernah FAIL.
 */
import type { LintIssue, StudioChartV1, SvgResult } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { type FitNote, type FitState, withFit } from "./fit";
import { CHART_LINT_OPTIONS, type GeometryLint, geometryIssues, hintCtxFromSpec, lintChartGeometry } from "./geometry";
import { measure } from "./textfit";

/** Faktor tangga tinggi (x tinggi bawaan fit). */
const HEIGHT_LADDER = [1.25, 1.5, 2, 2.5, 3, 4, 5] as const;
/** Di atas faktor ini kanvas lebih tinggi hanya dipakai bila semua cacat hilang. */
const HEIGHT_SOFT_CAP = 3;

/**
 * Faktor tinggi maksimum menurut jumlah cacat render fit pada tinggi bawaan: cacat sedikit
 * (1-2, mis. satu label menyentuh tanda) tidak boleh menggandakan tinggi gambar; kepadatan
 * baris (>= 10 cacat) boleh memakai seluruh tangga.
 */
function maxHeightFactor(score: number): number {
  if (score >= 10) return 5;
  if (score >= 3) return 2;
  return 1.25;
}
/** Kanvas lebih tinggi dipakai hanya bila skor cacat turun ke <= 50 % (atau 0). */
const HEIGHT_GAIN = 0.5;
/** Kode kolom kategoris yang boleh dialihkan ke batang horizontal P-01. */
const AUTO_ORIENT_CODES: ReadonlySet<string> = new Set(["P-02", "W-02"]);

export interface AutoFitRender {
  /** Render satu spec preset; `heightMm` menimpa taksiran tinggi bila diisi. */
  render(spec: StudioChartV1, heightMm?: number): { res: SvgResult; heightMm: number };
  /** Taksiran tinggi bawaan (dipanggil di dalam status fit). */
  estimate(spec: StudioChartV1): number;
  maxHeightMm: number;
  /** FIG-03a: maksud `orientation: "vertical"` (agen) -> AUTO_ORIENT tidak dicoba. */
  noAutoOrient?: boolean;
}

interface Candidate {
  res: SvgResult;
  spec: StudioChartV1;
  geo: GeometryLint;
  notes: FitNote[];
  label: string;
  /** Skor pemilihan = cacat lint + penalti label tersembunyi/terpotong (`candidateScore`). */
  score: number;
  /** Label data yang disembunyikan (`fitHidden`). */
  hidden: number;
}

/**
 * Kandidat "tuntas": tanpa cacat lint dan tanpa label data disembunyikan. Elipsis (teks lengkap
 * di `<title>`) tidak menghalangi tuntas, karena kanvas lebih tinggi tidak memperlebar talang.
 */
function settled(c: Candidate): boolean {
  return c.geo.score === 0 && c.hidden === 0;
}

/**
 * ENG-FIX #4 (review ronde 4 #4, D-482 butir 1: data yang seharusnya dilihat klien tidak boleh
 * hilang diam-diam). Bobot penalti per label dalam skor kandidat:
 * - label data yang disembunyikan (`LABEL_DROPPED`, `fitHidden`) = 1, setara satu cacat: kandidat
 *   yang menyembunyikan label tidak menang atas kandidat dengan satu tumpuk kecil hanya karena
 *   jumlah cacat mentahnya lebih kecil (seri -> kandidat lebih awal / render pertama);
 * - label yang dipotong elipsis (`<g data-fit="ellipsis">`, teks lengkap tetap di `<title>`) = 0,5:
 *   lebih ringan dari cacat, karena teks yang keluar kanvas/tertimpa juga hilang tanpa `<title>`;
 * - teks keluar kanvas (`textOutside`) = 2 (1 cacat + 1 tambahan): bagian yang keluar terpotong
 *   tanpa jejak, jadi lebih buruk dari satu label yang disembunyikan dengan REPORT `LABEL_DROPPED`
 *   (urutan review ronde 4 #4: keluar kanvas > tumpuk > label hilang).
 */
export const HIDDEN_LABEL_PENALTY = 1;
export const ELLIPSIS_LABEL_PENALTY = 0.5;
export const OUTSIDE_EXTRA_PENALTY = 1;

/** Skor pemilihan kandidat: jumlah cacat lint + penalti label disembunyikan/dipotong/keluar kanvas. */
export function candidateScore(geo: Pick<GeometryLint, "score"> & { counts?: Partial<GeometryLint["counts"]> }, svg: string, hidden = 0): number {
  const ellipsized = svg.split('<g data-fit="ellipsis">').length - 1;
  const outside = geo.counts?.textOutside ?? 0;
  return geo.score + OUTSIDE_EXTRA_PENALTY * outside + HIDDEN_LABEL_PENALTY * hidden + ELLIPSIS_LABEL_PENALTY * ellipsized;
}

/**
 * Label kategori kolom tidak muat di slotnya (syarat AUTO_ORIENT): label terlebar (6,4 pt
 * kapital, ukuran label kolom inti) > lebar slot kolom. Cacat lain (caption, satuan) tidak
 * pernah memutar orientasi.
 */
function columnLabelsTooWide(spec: StudioChartV1): boolean {
  if (spec.data?.shape !== "categorical" || spec.data.points.length === 0) return false;
  const slot = (spec.widthMm - 8) / spec.data.points.length;
  return Math.max(...spec.data.points.map((p) => measure(p.label, 6.4, "struct", { caps: true }))) > slot - 0.8;
}

/** Spec P-02/W-02 -> P-01 (urutan data agen, kunci params kode lama dibuang). */
function orientedSpec(spec: StudioChartV1): StudioChartV1 {
  const oldPrefix = `chart.kind.${spec.kind}.`;
  const params = Object.fromEntries(Object.entries(spec.params ?? {}).filter(([k]) => !k.startsWith(oldPrefix)));
  params["chart.kind.P-01.sort"] = "natural";
  return { ...spec, kind: "P-01", params };
}

function attempt(r: AutoFitRender, spec: StudioChartV1, height: number | "auto", label: string): Candidate | null {
  const notes: FitNote[] = [];
  try {
    const state: FitState = { widthMm: spec.widthMm, notes };
    return withFit(state, () => {
      const h = height === "auto" ? r.estimate(spec) : height;
      if (h > r.maxHeightMm + 1e-9) return null;
      const out = r.render(spec, h);
      const geo = lintChartGeometry(out.res.svg, CHART_LINT_OPTIONS);
      return { res: out.res, spec, geo, notes, label, score: candidateScore(geo, out.res.svg, state.hidden), hidden: state.hidden ?? 0 };
    });
  } catch (e) {
    // Kandidat yang ditolak mesin (StudioEngineError, mis. DATUM-33) tidak dipakai; render
    // pertama tetap sah. Galat lain (TypeError/RangeError dari pembantu sadar-fit) adalah
    // regresi kode dan dilempar ulang, bukan diam-diam jatuh ke render pertama (ENG-FIX #2).
    if (e instanceof StudioEngineError) return null;
    throw e;
  }
}

/** Kandidat terbaik untuk satu spec: fit pada tinggi bawaan, lalu tangga tinggi. */
function bestForSpec(r: AutoFitRender, spec: StudioChartV1, labelPrefix: string): Candidate | null {
  const base = attempt(r, spec, "auto", labelPrefix);
  if (!base) return null;
  let best = base;
  if (settled(best)) return best;
  const h0 = base.res.heightMm;
  const tried = new Set<number>([Math.round(h0 * 10)]);
  const fMax = maxHeightFactor(base.geo.score);
  for (const f of HEIGHT_LADDER) {
    if (f > fMax) break;
    const h = Math.min(Math.round(h0 * f * 10) / 10, r.maxHeightMm);
    const key = Math.round(h * 10);
    if (tried.has(key)) continue;
    tried.add(key);
    const c = attempt(r, spec, h, `${labelPrefix}tinggi ${h0.toFixed(1)} -> ${h.toFixed(1)} mm`);
    // Skor pilihan harus turun tegas; syarat "turun >= 50 %" boleh dipenuhi oleh skor pilihan
    // ATAU oleh jumlah cacat mentah (penalti elipsis yang sama di kedua kandidat tidak boleh
    // menghalangi kanvas lebih tinggi yang memang menghapus separuh cacat).
    const halved = c !== null && (c.score <= best.score * HEIGHT_GAIN || c.geo.score <= best.geo.score * HEIGHT_GAIN);
    const gain = c !== null && c.score < best.score && (settled(c) || (f <= HEIGHT_SOFT_CAP && halved));
    if (c && gain) best = c;
    if (settled(best) || h >= r.maxHeightMm) break;
  }
  return best;
}

/**
 * Pilih kandidat tata letak otomatis untuk render bercacat `first`. Mengembalikan hasil
 * (render pertama bila tidak ada kandidat yang lebih baik) dengan isu REPORT tambahan.
 */
export function autoFitChart(spec: StudioChartV1, first: SvgResult, firstGeo: GeometryLint, r: AutoFitRender): { res: SvgResult; spec: StudioChartV1; extra: LintIssue[] } {
  const cands: Candidate[] = [];
  const own = bestForSpec(r, spec, "");
  if (own) cands.push(own);
  if (!r.noAutoOrient && AUTO_ORIENT_CODES.has(spec.kind) && columnLabelsTooWide(spec) && (!own || !settled(own))) {
    const o = bestForSpec(r, orientedSpec(spec), "");
    if (o) {
      o.notes.unshift({ checkId: "AUTO_ORIENT", detail: `${spec.kind} -> tata letak batang horizontal P-01 (label kategori tidak muat sebagai kolom; urutan data dipertahankan)` });
      cands.push(o);
    }
  }
  let best: Candidate | null = null;
  for (const c of cands) if (!best || c.score < best.score) best = c;
  const ctx = hintCtxFromSpec(spec);
  // Render pertama dinilai dengan aturan yang sama (penalti elipsis yang sudah ada di jalur non-fit).
  const firstScore = candidateScore(firstGeo, first.svg);
  if (!best || best.score >= firstScore) {
    return { res: first, spec, extra: geometryIssues(firstGeo, ctx) };
  }
  const extra: LintIssue[] = [
    {
      checkId: "AUTO_FIT",
      status: "REPORT",
      detail: `cacat geometri terdeteksi (${firstGeo.score}); tata letak otomatis${best.label ? `: ${best.label}` : ""} -> sisa ${best.geo.score}${best.score !== best.geo.score ? ` (skor pilihan ${best.score} termasuk penalti label disembunyikan/dipotong)` : ""}`,
    },
    ...best.notes.map((n) => ({ checkId: n.checkId, status: "REPORT" as const, detail: n.detail })),
    ...geometryIssues(best.geo, ctx),
  ];
  return { res: best.res, spec: best.spec, extra };
}
