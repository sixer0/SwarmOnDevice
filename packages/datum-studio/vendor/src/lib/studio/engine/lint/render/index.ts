/**
 * engine/lint/render (I35, 01_specs.md §8.2) — diisi S45.
 *
 * Lint pasca-render grup R (registri `module: "render"`): DATUM-14, 15, 25,
 * 28, 32, 33, 37. Sumber geometri:
 *  - `metrics` = keluaran `measureLayout` S25 (elemen `page`/`document`,
 *    `overflow`, `text`, `figure`, `svgText`, `image`; medan tambahan dibaca
 *    defensif karena kontrak `LayoutMetrics` hanya menjamin medan dasar);
 *  - `svgs` = SVG mesin chart/diagram, diurai statis (svg.ts);
 *  - `html` = cadangan: SVG inline diurai statis bila `svgs` kosong dan
 *    metrik tidak memuat figur.
 *
 * Acuan perilaku (read-only): RL datum_render.py `check_page` (DATUM-37,
 * pelanggar terburuk per kunci, maks 12) dan HS datum_lint.py `c14`/`c25`/
 * `c28` (hanya warna kromatik dihitung; huruf < 5,5 pt). K-32: ramp tinta
 * dihitung satu keluarga (colour.ts).
 *
 * Fungsi murni: tanpa I/O dan tanpa melempar. Cacat instrumen per cek
 * dilaporkan sebagai NOT_RUN berdetail (pola `run()` HS: "cacat instrumen
 * dilaporkan, bukan disembunyikan"); pencatatan tahan lama milik pemanggil
 * (layanan render S51, job log).
 */
import type { LayoutMetrics, LintIssue, ParamMap, SvgResult } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { PARAMS_BY_KEY } from "../../../params";
import { countColourValues, countFigureColourValues, DEFAULT_INK_RAMPS, type InkRamp } from "./colour";
import { findCrossings } from "./geometry";
import { analyseSvg, extractInlineSvgs, type SvgAnalysis } from "./svg";

export { countColourValues, countFigureColourValues, DEFAULT_INK_RAMPS, FIGURE_GROUNDS, isChromatic, normaliseColour, rampOf } from "./colour";
export type { ColourCount, InkRamp } from "./colour";
export { analyseSvg, extractInlineSvgs } from "./svg";
export type { SvgAnalysis } from "./svg";
export { findCrossings } from "./geometry";

/** Cek milik modul ini (registri lint: module "render"). */
export const RENDER_CHECK_IDS = ["DATUM-14", "DATUM-15", "DATUM-25", "DATUM-28", "DATUM-32", "DATUM-33", "DATUM-37"] as const;
export type RenderCheckId = (typeof RENDER_CHECK_IDS)[number];

export interface RenderLintLimits {
  /** DATUM-14, `color.maxValuesPerPage` (P4C-21). */
  maxColoursPerPage: number;
  /** DATUM-25, `chart.maxColors` (P7-17) / `diagram.maxColors` (P9-42). */
  maxColoursPerFigure: number;
  /** DATUM-15, `type.body.measureChars` (P4T-X13). */
  measureChars: readonly [number, number];
  /** DATUM-28, `diagram.minFontPt` (P9-44) / `chart.minFontPt` (P7-36). */
  minFigureTypePt: number;
  /** DATUM-33, `diagram.maxHeightMm` (P9-45) / `grid.textBlockHeightMm` (P4G-11). */
  maxFigureHeightMm: number;
  /** K-32: ramp tinta yang dihitung satu keluarga. */
  inkRamps: readonly InkRamp[];
  /** DATUM-32: inset tepi simpul, jarak cuplikan, jarak maks ujung ke simpul terkait (mm). */
  connectorInsetMm: number;
  connectorStepMm: number;
  connectorEndpointMm: number;
  /** Pelanggar per cek yang dilaporkan (RL check_page: 12). */
  maxIssuesPerCheck: number;
}

/**
 * Bawaan registri (profil kanonik) kunci angka positif, pola mesin chart/simbol mandiri
 * (FIX-FIG keputusan 3): tanpa literal A4; registri tanpa nilai sah = BY_CONSTRUCTION_FAILED.
 */
function registryNumber(key: string): number {
  const v = PARAMS_BY_KEY.get(key)?.default;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `Bawaan registri ${key} tidak terbaca`, { key });
}

export const RENDER_LINT_DEFAULTS: Readonly<RenderLintLimits> = Object.freeze({
  maxColoursPerPage: 5,
  maxColoursPerFigure: 5,
  measureChars: [66, 80] as const,
  minFigureTypePt: 5.5,
  // D-245 H1: blok teks profil kanonik (A4 potret 247 mm); templat menimpa lewat RENDER_LINT_PARAM_KEYS.
  maxFigureHeightMm: registryNumber("grid.textBlockHeightMm"),
  inkRamps: DEFAULT_INK_RAMPS,
  connectorInsetMm: 0.4,
  connectorStepMm: 0.25,
  connectorEndpointMm: 6,
  maxIssuesPerCheck: 12,
});

/** Kunci parameter templat yang memetakan batas (dibaca `renderLintLimitsFromParams`). */
export const RENDER_LINT_PARAM_KEYS = {
  maxColoursPerPage: ["color.maxValuesPerPage"],
  maxColoursPerFigure: ["chart.maxColors", "diagram.maxColors"],
  measureChars: ["type.body.measureChars"],
  minFigureTypePt: ["chart.minFontPt", "diagram.minFontPt"],
  maxFigureHeightMm: ["diagram.maxHeightMm", "grid.textBlockHeightMm"],
} as const;

const NUMERIC_TEXT = /^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Nilai numerik sah (> 0, finit) dari angka atau teks angka desimal; selain itu `undefined`. */
function positiveNumber(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && NUMERIC_TEXT.test(v.trim()) ? Number(v.trim()) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function numParam(p: ParamMap, key: string): number | undefined {
  return positiveNumber(p[key]);
}

/**
 * Batas dari parameter templat ter-resolve. Bila dua kunci berlaku, yang
 * lebih ketat dipakai (warna/tinggi: minimum; ukuran huruf: maksimum).
 * Parameter tidak ada / bukan angka sah -> nilai `base` (default katalog);
 * hasil selalu finit (IP-32: `reduce(Math.min)` dulu meneruskan indeks dan
 * larik sebagai argumen tambahan sehingga menghasilkan NaN).
 */
export function renderLintLimitsFromParams(p: ParamMap, base: RenderLintLimits = RENDER_LINT_DEFAULTS): RenderLintLimits {
  type Num = "maxColoursPerPage" | "maxColoursPerFigure" | "minFigureTypePt" | "maxFigureHeightMm";
  const pick = (k: Num, stricter: (a: number, b: number) => number): number => {
    const keys: readonly string[] = RENDER_LINT_PARAM_KEYS[k];
    const vals = keys.map((key) => numParam(p, key)).filter((v): v is number => v !== undefined);
    const picked = vals.length > 0 ? vals.reduce((a, b) => stricter(a, b)) : undefined;
    if (picked !== undefined && Number.isFinite(picked)) return picked;
    return positiveNumber(base[k]) ?? RENDER_LINT_DEFAULTS[k];
  };
  const min = (a: number, b: number): number => Math.min(a, b);
  const max = (a: number, b: number): number => Math.max(a, b);
  const range = p["type.body.measureChars"];
  const lo = Array.isArray(range) && range.length === 2 ? positiveNumber(range[0]) : undefined;
  const hi = Array.isArray(range) && range.length === 2 ? positiveNumber(range[1]) : undefined;
  const measure: readonly [number, number] = lo !== undefined && hi !== undefined && hi >= lo ? [lo, hi] : base.measureChars;
  return {
    ...base,
    maxColoursPerPage: pick("maxColoursPerPage", min),
    maxColoursPerFigure: pick("maxColoursPerFigure", min),
    measureChars: measure,
    minFigureTypePt: pick("minFigureTypePt", max),
    maxFigureHeightMm: pick("maxFigureHeightMm", min),
  };
}

// ── masukan ──────────────────────────────────────────────────────────────

type BaseEl = LayoutMetrics["elements"][number];

/** Elemen metrik + medan tambahan S25 (semua opsional, dibaca defensif). */
interface El extends BaseEl {
  tag?: string;
  label?: string;
  axis?: string;
  overflowMm?: number;
  colors?: string[];
  measureMm?: number;
  lineCount?: number;
  charCount?: number;
  charsPerLine?: number;
  /** Swarm row 165K: `data-unit` kind of the enclosing Studio unit (measure.ts). */
  unit?: string;
  /** Swarm row 206: flow `document` element: layout width and viewport (px CSS), sheet width (mm) (measure.ts). */
  layoutWidthPx?: number;
  viewportPx?: number;
  sheetWidthMm?: number;
}

interface Input {
  html?: string;
  svgs: readonly SvgResult[];
  metrics: LayoutMetrics;
}

interface Ctx {
  i: Input;
  lim: RenderLintLimits;
  els: El[];
  truncated: boolean;
  /** Analisis SVG statis (lazy): sumber `svgs`, atau SVG inline HTML bila `svgs` kosong. */
  svgList: () => Array<{ pointer: string; a?: SvgAnalysis; error?: string }>;
  hasMetrics: boolean;
}

const TOL_MM = 0.05;

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function f1(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1);
}

function f2(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function issue(checkId: RenderCheckId, status: LintIssue["status"], detail: string, where?: { address?: string; pointer?: string }): LintIssue {
  const out: LintIssue = { checkId, status, detail };
  if (where?.address) out.address = where.address;
  if (where?.pointer) out.pointer = where.pointer;
  return out;
}

/** Pelanggar terurut (terburuk dulu) dipotong ke batas; sisa dicatat pada butir terakhir. */
function capped(list: LintIssue[], max: number): LintIssue[] {
  if (list.length <= max) return list;
  const kept = list.slice(0, Math.max(1, max));
  const last = kept[kept.length - 1];
  kept[kept.length - 1] = { ...last, detail: `${last.detail ?? ""} (+${list.length - kept.length} pelanggaran lain)` };
  return kept;
}

function where(e: El): { address?: string; pointer?: string } {
  return e.address ? { address: e.address } : {};
}

function figLabel(e: El): string {
  return e.label ? `'${e.label}'` : e.kind;
}

const TRUNC_NOTE = "metrik terpotong pada batas elemen S25; hasil tidak lengkap";

// ── DATUM-14 nilai warna per halaman ─────────────────────────────────────

function check14(c: Ctx): LintIssue[] {
  const id = "DATUM-14";
  const limit = c.lim.maxColoursPerPage;
  const pages = c.els.filter((e) => e.kind === "page");
  const docs = c.els.filter((e) => e.kind === "document");
  if (pages.length > 0) {
    const fails: Array<{ n: number; is: LintIssue }> = [];
    let worst = 0;
    let unmeasured = 0;
    for (const p of pages) {
      if (!Array.isArray(p.colors)) {
        unmeasured++;
        continue;
      }
      const cc = countColourValues(p.colors, c.lim.inkRamps);
      worst = Math.max(worst, cc.count);
      if (cc.count > limit) {
        fails.push({
          n: cc.count,
          is: issue(id, "FAIL", `halaman ${p.page ?? "?"}: ${cc.count} nilai warna > maks ${limit} (${cc.values.join(", ")})`, where(p)),
        });
      }
    }
    if (fails.length) return capped(fails.sort((a, b) => b.n - a.n).map((f) => f.is), c.lim.maxIssuesPerCheck);
    if (unmeasured === pages.length) return [issue(id, "NOT_RUN", "metrik halaman tanpa daftar warna (medan colors S25)")];
    if (c.truncated) return [issue(id, "NOT_RUN", `${TRUNC_NOTE}; maks ${worst} nilai warna per halaman yang terukur`)];
    const note = unmeasured ? `; ${unmeasured} halaman tanpa daftar warna` : "";
    return [issue(id, "PASS", `${pages.length} halaman; maks ${worst} nilai warna per halaman (batas ${limit}; ramp tinta = 1 keluarga, K-32)${note}`)];
  }
  const doc = docs.find((d) => Array.isArray(d.colors));
  if (doc && doc.colors) {
    const cc = countColourValues(doc.colors, c.lim.inkRamps);
    const pc = c.i.metrics.pageCount > 0 ? `${c.i.metrics.pageCount} halaman cetak` : "halaman cetak tak terhitung";
    if (cc.count <= limit && !c.truncated) {
      return [issue(id, "PASS", `dokumen alir (${pc}): ${cc.count} nilai warna di seluruh dokumen <= ${limit}, batas atas per halaman (ramp tinta = 1 keluarga, K-32)`)];
    }
    return [
      issue(
        id,
        "NOT_RUN",
        `dokumen alir (${pc}): ${cc.count} nilai warna di seluruh dokumen (${cc.values.join(", ")}); atribusi per halaman cetak tidak terukur untuk unit alir tanpa .page (D-45)${c.truncated ? `; ${TRUNC_NOTE}` : ""}`,
      ),
    ];
  }
  return [issue(id, "NOT_RUN", noMetricsReason(c))];
}

function noMetricsReason(c: Ctx): string {
  if (c.hasMetrics) return "metrik tata letak tanpa elemen halaman/dokumen";
  return c.i.html ? "HTML diberikan tanpa metrik tata letak (measureLayout S25 tidak dijalankan)" : "tidak ada HTML terukur (artefak SVG saja)";
}

// ── DATUM-15 ukuran baris badan ──────────────────────────────────────────

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Swarm row 165K (C199 ruling 2): front-matter units (cover, control sheet, contents) are not running body text. */
const DATUM15_FRONT_UNITS: ReadonlySet<string> = new Set(["cover", "controlSheet", "toc"]);

function check15(c: Ctx): LintIssue[] {
  const id = "DATUM-15";
  const [lo, hi] = c.lim.measureChars;
  const texts = c.els.filter(
    (e) =>
      e.kind === "text" &&
      !(e.unit !== undefined && DATUM15_FRONT_UNITS.has(e.unit)) &&
      isNum(e.charsPerLine) && isNum(e.lineCount) && e.lineCount >= 2 && isNum(e.measureMm) && e.measureMm > 0,
  );
  if (!texts.length && !c.els.some((e) => e.kind === "page" || e.kind === "document")) return [issue(id, "NOT_RUN", noMetricsReason(c))];
  const bodyLabelled = texts.filter((e) => e.label === "st-p");
  let cand = bodyLabelled.length ? bodyLabelled : texts.filter((e) => e.tag === "p");
  // Ukuran fon badan = modus berbobot baris; paragraf berfon lain (catatan, sel) disisihkan.
  const weight = new Map<string, number>();
  for (const e of cand) if (isNum(e.fontSizePt)) weight.set(e.fontSizePt.toFixed(1), (weight.get(e.fontSizePt.toFixed(1)) ?? 0) + (e.lineCount ?? 0));
  const mode = [...weight.entries()].sort((a, b) => b[1] - a[1] || parseFloat(a[0]) - parseFloat(b[0]))[0];
  const bodyPt = mode ? parseFloat(mode[0]) : undefined;
  if (bodyPt !== undefined) cand = cand.filter((e) => !isNum(e.fontSizePt) || Math.abs(e.fontSizePt - bodyPt) <= 0.6);
  // Kolom sempit (sel tabel, rel) disisihkan terhadap lebar ukur median.
  const med = cand.length ? median(cand.map((e) => e.measureMm as number)) : 0;
  cand = cand.filter((e) => (e.measureMm as number) >= 0.6 * med);
  // Swarm row 165O (C203 F165N-2): the layout WAS measured (page/document elements present) but the document has no
  // multi-line interior body paragraph. The check does not apply: REPORT "tidak berlaku" (the lint's existing
  // not-applicable form, cf. C-INFO-OPENER language/checks.ts:227), not NOT_RUN, so the gate's LINT_PARTIAL
  // (static-checks.ts, NOT_RUN only) is not raised by an absence. NOT_RUN stays for a failed or truncated measure.
  if (!cand.length) {
    const why = "tidak ada paragraf badan multi-baris terukur (kelas st-p atau tag p; sampul, lembar kendali dan daftar isi tidak dihitung)";
    return [c.truncated ? issue(id, "NOT_RUN", `${TRUNC_NOTE}; ${why}`) : issue(id, "REPORT", `tidak berlaku: ${why}`)];
  }
  let sum = 0;
  let lines = 0;
  for (const e of cand) {
    const full = (e.lineCount as number) - 1;
    sum += (e.charsPerLine as number) * full;
    lines += full;
  }
  const avg = sum / lines;
  const cpls = cand.map((e) => e.charsPerLine as number);
  const meta = `${cand.length} paragraf badan, ${lines} baris penuh; lebar ukur median ${f1(median(cand.map((e) => e.measureMm as number)))} mm${bodyPt !== undefined ? `, fon ${f1(bodyPt)} pt` : ""}; per paragraf ${f1(Math.min(...cpls))}-${f1(Math.max(...cpls))}`;
  if (avg >= lo && avg <= hi) {
    if (c.truncated) return [issue(id, "NOT_RUN", `${TRUNC_NOTE}; rata-rata ${f1(avg)} karakter per baris (${meta})`)];
    return [issue(id, "PASS", `rata-rata ${f1(avg)} karakter per baris dalam ${lo}-${hi} (${meta})`)];
  }
  const out = cand
    .filter((e) => (e.charsPerLine as number) < lo || (e.charsPerLine as number) > hi)
    .sort((a, b) => Math.abs((b.charsPerLine as number) - (lo + hi) / 2) - Math.abs((a.charsPerLine as number) - (lo + hi) / 2))
    .map((e) => e.address)
    .filter((a): a is string => !!a);
  const addrs = [...new Set(out)].slice(0, 5);
  return [issue(id, "FAIL", `rata-rata ${f1(avg)} karakter per baris di luar ${lo}-${hi} (${meta})${addrs.length ? `; contoh alamat ${addrs.join(", ")}` : ""}`)];
}

// ── DATUM-25 nilai warna per gambar ──────────────────────────────────────

function check25(c: Ctx): LintIssue[] {
  const id = "DATUM-25";
  const limit = c.lim.maxColoursPerFigure;
  const fails: Array<{ n: number; is: LintIssue }> = [];
  const errs: LintIssue[] = [];
  let figures = 0;
  let worst = 0;
  for (const s of c.svgList()) {
    if (!s.a) {
      errs.push(issue(id, "NOT_RUN", `SVG tidak terurai: ${s.error ?? "?"}`, { pointer: s.pointer }));
      continue;
    }
    figures++;
    const cc = countFigureColourValues(s.a.colours); // row 124 (C23/C29): every hex value, no K-32 folding
    worst = Math.max(worst, cc.count);
    if (cc.count > limit) fails.push({ n: cc.count, is: issue(id, "FAIL", `gambar SVG: ${cc.count} nilai warna > maks ${limit} (${cc.values.join(", ")})`, { pointer: s.pointer }) });
  }
  for (const e of c.els) {
    if (e.kind !== "figure" || !Array.isArray(e.colors)) continue;
    figures++;
    const cc = countFigureColourValues(e.colors); // row 124 (C23/C29)
    worst = Math.max(worst, cc.count);
    if (cc.count > limit) {
      fails.push({ n: cc.count, is: issue(id, "FAIL", `gambar ${figLabel(e)} halaman ${e.page ?? "-"}: ${cc.count} nilai warna > maks ${limit} (${cc.values.join(", ")})`, where(e)) });
    }
  }
  if (fails.length) return [...capped(fails.sort((a, b) => b.n - a.n).map((f) => f.is), c.lim.maxIssuesPerCheck), ...errs];
  if (!figures) return errs.length ? errs : [issue(id, "PASS", "tidak ada gambar")];
  return [issue(id, "PASS", `${figures} gambar; maks ${worst} nilai warna per gambar (batas ${limit}; setiap nilai hex di luar latar dihitung, Rev A DT-06)`), ...errs];
}

// ── DATUM-28 huruf gambar < 5,5 pt ───────────────────────────────────────

function check28(c: Ctx): LintIssue[] {
  const id = "DATUM-28";
  const min = c.lim.minFigureTypePt;
  const fails: Array<{ n: number; is: LintIssue }> = [];
  const errs: LintIssue[] = [];
  let resolved = 0;
  let unresolved = 0;
  let smallest = Infinity;
  for (const s of c.svgList()) {
    if (!s.a) {
      errs.push(issue(id, "NOT_RUN", `SVG tidak terurai: ${s.error ?? "?"}`, { pointer: s.pointer }));
      continue;
    }
    const texts = s.a.texts.filter((t) => t.text.trim());
    resolved += texts.length;
    unresolved += s.a.unresolvedTexts;
    const small = texts.filter((t) => t.sizePt < min - 0.005).sort((a, b) => a.sizePt - b.sizePt);
    for (const t of texts) smallest = Math.min(smallest, t.sizePt);
    if (small.length) {
      fails.push({
        n: small[0].sizePt,
        is: issue(id, "FAIL", `gambar SVG: ${small.length} teks < ${f1(min)} pt (terkecil ${f2(small[0].sizePt)} pt: '${small[0].text.trim()}')`, { pointer: s.pointer }),
      });
    }
  }
  const byFig = new Map<string, El[]>();
  for (const e of c.els) {
    if (e.kind !== "svgText" || !isNum(e.fontSizePt)) continue;
    resolved++;
    smallest = Math.min(smallest, e.fontSizePt);
    if (e.fontSizePt < min - 0.005) {
      const k = `${e.page ?? ""}|${e.label ?? ""}|${e.address ?? ""}`;
      byFig.set(k, [...(byFig.get(k) ?? []), e]);
    }
  }
  for (const list of byFig.values()) {
    const s = [...list].sort((a, b) => (a.fontSizePt as number) - (b.fontSizePt as number));
    const e = s[0];
    fails.push({
      n: e.fontSizePt as number,
      is: issue(id, "FAIL", `gambar ${figLabel(e)} halaman ${e.page ?? "-"}: ${s.length} teks < ${f1(min)} pt setelah skala (terkecil ${f2(e.fontSizePt as number)} pt)`, where(e)),
    });
  }
  if (fails.length) return [...capped(fails.sort((a, b) => a.n - b.n).map((f) => f.is), c.lim.maxIssuesPerCheck), ...errs];
  if (!resolved) {
    if (unresolved) return [issue(id, "NOT_RUN", `${unresolved} teks gambar tanpa ukuran huruf terbaca (gaya kelas CSS tidak dipetakan)`), ...errs];
    return errs.length ? errs : [issue(id, "PASS", "tidak ada teks gambar")];
  }
  const note = unresolved ? `; ${unresolved} teks tanpa ukuran terbaca` : "";
  return [issue(id, "PASS", `${resolved} teks gambar; terkecil ${f2(smallest)} pt (batas ${f1(min)} pt)${note}`), ...errs];
}

// ── DATUM-32 konektor melewati kotak tak terkait ─────────────────────────

function check32(c: Ctx): LintIssue[] {
  const id = "DATUM-32";
  const fails: Array<{ n: number; is: LintIssue }> = [];
  const errs: LintIssue[] = [];
  let drawings = 0;
  let links = 0;
  for (const s of c.svgList()) {
    if (!s.a) {
      errs.push(issue(id, "NOT_RUN", `SVG tidak terurai: ${s.error ?? "?"}`, { pointer: s.pointer }));
      continue;
    }
    if (!s.a.links.length || !s.a.nodes.length) continue;
    drawings++;
    links += s.a.links.length;
    const k = s.a.mmPerUu > 0 ? s.a.mmPerUu : 25.4 / 96;
    const found = findCrossings(s.a.nodes, s.a.links, {
      stepUu: c.lim.connectorStepMm / k,
      insetUu: c.lim.connectorInsetMm / k,
      endpointUu: c.lim.connectorEndpointMm / k,
    });
    for (const f of found) {
      const mm = f.insideUu * k;
      fails.push({ n: mm, is: issue(id, "FAIL", `konektor #${f.link} melewati simpul tak terkait '${f.node}' sepanjang ${f1(mm)} mm`, { pointer: s.pointer }) });
    }
  }
  if (fails.length) return [...capped(fails.sort((a, b) => b.n - a.n).map((f) => f.is), c.lim.maxIssuesPerCheck), ...errs];
  if (!drawings) return errs.length ? errs : [issue(id, "PASS", "tidak ada konektor bertanda (data-mark=\"link\") pada gambar bersimpul")];
  return [issue(id, "PASS", `${drawings} gambar, ${links} konektor; tidak ada yang melewati simpul tak terkait (inset ${f1(c.lim.connectorInsetMm)} mm)`), ...errs];
}

// ── DATUM-33 gambar lebih tinggi dari blok teks ──────────────────────────

function check33(c: Ctx): LintIssue[] {
  const id = "DATUM-33";
  const max = c.lim.maxFigureHeightMm;
  const fails: Array<{ n: number; is: LintIssue }> = [];
  let figures = 0;
  let tallest = 0;
  c.i.svgs.forEach((s, k) => {
    if (!isNum(s?.heightMm)) return;
    figures++;
    tallest = Math.max(tallest, s.heightMm);
    if (s.heightMm > max + TOL_MM) fails.push({ n: s.heightMm, is: issue(id, "FAIL", `gambar SVG setinggi ${f1(s.heightMm)} mm > blok teks ${f1(max)} mm`, { pointer: `/svgs/${k}` }) });
  });
  for (const e of c.els) {
    if ((e.kind !== "figure" && e.kind !== "image") || !isNum(e.heightMm)) continue;
    figures++;
    tallest = Math.max(tallest, e.heightMm);
    if (e.heightMm > max + TOL_MM) {
      fails.push({ n: e.heightMm, is: issue(id, "FAIL", `gambar ${figLabel(e)} halaman ${e.page ?? "-"} tampil setinggi ${f1(e.heightMm)} mm > blok teks ${f1(max)} mm`, where(e)) });
    }
  }
  if (!c.i.svgs.length && !c.els.some((e) => e.kind === "figure")) {
    for (const s of c.svgList()) {
      if (!s.a) continue;
      figures++;
      tallest = Math.max(tallest, s.a.heightMm);
      if (s.a.heightMm > max + TOL_MM) fails.push({ n: s.a.heightMm, is: issue(id, "FAIL", `gambar SVG inline setinggi ${f1(s.a.heightMm)} mm > blok teks ${f1(max)} mm`, { pointer: s.pointer }) });
    }
  }
  if (fails.length) return capped(fails.sort((a, b) => b.n - a.n).map((f) => f.is), c.lim.maxIssuesPerCheck);
  if (!figures) return [issue(id, "PASS", "tidak ada gambar")];
  return [issue(id, "PASS", `${figures} gambar; tertinggi ${f1(tallest)} mm (batas ${f1(max)} mm)`)];
}

// ── DATUM-37 lembar melewati A4 ──────────────────────────────────────────

/** px CSS per mm (96 dpi), as measure.ts and the host overlap check. */
const PX_PER_MM = 96 / 25.4;

/**
 * Swarm row 206 (1.2.3, P3): px of sheet width a flow layout did not get (a classic scrollbar, or a viewport that is
 * not the sheet). Same rule as the host's `flowWidthShortfallPx` (mcp-host/verify/overlap-clip.ts): the larger of
 * sheet - layout and |viewport - sheet|, counted only above 1 px. 0 = measurable, or no width fields (older measure).
 */
export function flowLayoutShortfallPx(doc: { layoutWidthPx?: number; viewportPx?: number; sheetWidthMm?: number } | undefined): number {
  if (!doc || !isNum(doc.layoutWidthPx) || !isNum(doc.sheetWidthMm) || doc.layoutWidthPx <= 0 || doc.sheetWidthMm <= 0) return 0;
  const sheet = Math.ceil(doc.sheetWidthMm * PX_PER_MM);
  const view = isNum(doc.viewportPx) && doc.viewportPx > 0 ? Math.abs(doc.viewportPx - sheet) : 0;
  const short = Math.max(sheet - doc.layoutWidthPx, view);
  return short > 1 ? short : 0;
}

/** The DATUM-37 NOT_RUN reason of a narrowed flow layout; the host maps it to UNKNOWN FLOW_LAYOUT_UNMEASURABLE. */
export const FLOW_LAYOUT_UNMEASURABLE_NOTE = "FLOW_LAYOUT_UNMEASURABLE";

function check37(c: Ctx): LintIssue[] {
  const id = "DATUM-37";
  const pages = c.els.filter((e) => e.kind === "page");
  const docs = c.els.filter((e) => e.kind === "document");
  let over = c.els.filter((e) => e.kind === "overflow" && isNum(e.overflowMm) && e.overflowMm > 0);
  if (!pages.length && !docs.length && !over.length) return [issue(id, "NOT_RUN", noMetricsReason(c))];
  // Swarm row 206: a flow page laid out narrower than the sheet. Right-edge overflows the missing width explains are
  // not judged (the host's `explainedByNarrowLayout`: flow, right axis, <= shortfall + 0.5 mm); larger ones still FAIL;
  // with none left the check is NOT_RUN, never PASS.
  const shortfall = pages.length ? 0 : flowLayoutShortfallPx(docs[0]);
  if (shortfall > 0) {
    over = over.filter((e) => !(e.page === undefined && e.axis !== "bottom" && (e.overflowMm as number) <= shortfall / PX_PER_MM + 0.5));
  }
  const fails = over
    .sort((a, b) => (b.overflowMm as number) - (a.overflowMm as number))
    .map((e) => {
      const axis = e.axis === "bottom" ? "bawah" : "kanan";
      const sheet = e.page !== undefined ? `lembar ${e.page}` : "dokumen alir";
      return issue(id, "FAIL", `${sheet}: '${e.label ?? e.tag ?? "?"}' melewati batas ${axis} sebesar ${f1(e.overflowMm as number)} mm`, where(e));
    });
  if (!fails.length && !shortfall && docs.some((d) => d.overflow === true)) {
    fails.push(issue(id, "FAIL", "dokumen alir lebih lebar dari lembar (luapan horizontal)"));
  }
  if (fails.length) return capped(fails, c.lim.maxIssuesPerCheck);
  if (shortfall > 0) {
    const d = docs[0] as El;
    return [
      issue(
        id,
        "NOT_RUN",
        `${FLOW_LAYOUT_UNMEASURABLE_NOTE}: dokumen alir ditata ${f1((d.layoutWidthPx as number) / PX_PER_MM)} mm, lebih sempit dari lembar ${f1(d.sheetWidthMm as number)} mm (selisih ${f1(shortfall / PX_PER_MM)} mm, mis. bilah gulir); luapan kanan dalam selisih itu tidak dapat dinilai`,
      ),
    ];
  }
  if (c.truncated) return [issue(id, "NOT_RUN", `${TRUNC_NOTE}; tidak ada luapan pada elemen terukur`)];
  if (pages.length) return [issue(id, "PASS", `${pages.length} lembar; tidak ada isi yang melewati batas lembar (RL check_page)`)];
  return [issue(id, "PASS", "dokumen alir: tidak ada luapan horizontal; luapan bawah tidak berlaku (pemenggalan CSS, D-45)")];
}

// ── pelari ───────────────────────────────────────────────────────────────

const CHECKS: ReadonlyArray<readonly [RenderCheckId, (c: Ctx) => LintIssue[]]> = [
  ["DATUM-14", check14],
  ["DATUM-15", check15],
  ["DATUM-25", check25],
  ["DATUM-28", check28],
  ["DATUM-32", check32],
  ["DATUM-33", check33],
  ["DATUM-37", check37],
];

function buildCtx(i: Input, lim: RenderLintLimits): Ctx {
  const metrics: LayoutMetrics = i.metrics && Array.isArray(i.metrics.elements) ? i.metrics : { pageCount: 0, elements: [] };
  const els = metrics.elements.filter((e): e is El => !!e && typeof e === "object" && typeof e.kind === "string");
  const truncated = (metrics as { truncated?: unknown }).truncated === true;
  const svgs = Array.isArray(i.svgs) ? i.svgs : [];
  let memo: Array<{ pointer: string; a?: SvgAnalysis; error?: string }> | undefined;
  const svgList = () => {
    if (memo) return memo;
    const list: Array<{ pointer: string; src: string; size?: { widthMm: number; heightMm: number } }> = [];
    svgs.forEach((s, k) => {
      if (s && typeof s.svg === "string") {
        const size = isNum(s.widthMm) && isNum(s.heightMm) && s.widthMm > 0 && s.heightMm > 0 ? { widthMm: s.widthMm, heightMm: s.heightMm } : undefined;
        list.push({ pointer: `/svgs/${k}`, src: s.svg, size });
      }
    });
    // Cadangan: SVG inline HTML hanya bila tidak ada SVG mesin dan metrik tanpa figur (hindari hitung ganda).
    if (!list.length && typeof i.html === "string" && !els.some((e) => e.kind === "figure")) {
      extractInlineSvgs(i.html).forEach((src, k) => list.push({ pointer: `html/svg[${k}]`, src }));
    }
    memo = list.map((s) => {
      try {
        return { pointer: s.pointer, a: analyseSvg(s.src, s.size) };
      } catch (e) {
        return { pointer: s.pointer, error: msg(e) };
      }
    });
    return memo;
  };
  return { i: { ...i, svgs, metrics }, lim, els, truncated, svgList, hasMetrics: els.length > 0 };
}

/**
 * Lint R dengan batas eksplisit (mis. dari `renderLintLimitsFromParams(tpl.params)`).
 * Setiap cek R menghasilkan minimal satu butir (PASS / FAIL / NOT_RUN); tidak melempar.
 */
export function lintRenderedWith(i: { html?: string; svgs: readonly SvgResult[]; metrics: LayoutMetrics }, limits: RenderLintLimits): LintIssue[] {
  let ctx: Ctx;
  try {
    ctx = buildCtx(i ?? { svgs: [], metrics: { pageCount: 0, elements: [] } }, limits);
  } catch (e) {
    return RENDER_CHECK_IDS.map((id) => issue(id, "NOT_RUN", `galat instrumen: ${msg(e)}`));
  }
  const out: LintIssue[] = [];
  for (const [id, fn] of CHECKS) {
    try {
      const r = fn(ctx);
      out.push(...(r.length ? r : [issue(id, "NOT_RUN", "cek tidak menghasilkan butir")]));
    } catch (e) {
      out.push(issue(id, "NOT_RUN", `galat instrumen: ${msg(e)}`));
    }
  }
  return out;
}

/** Cek 14, 15, 25, 28, 32, 33, 37 dengan batas bawaan katalog (tanda tangan kontrak I35). */
export function lintRendered(i: { html?: string; svgs: readonly SvgResult[]; metrics: LayoutMetrics }): LintIssue[] {
  return lintRenderedWith(i, RENDER_LINT_DEFAULTS);
}
