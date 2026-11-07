/**
 * engine/chart/family-w1 — renderer W-01 line, W-03 step line, W-04 area, W-05 stacked
 * area (S39; port pustakachart v41_line PC:697, v48_step PC:769, v42_area PC:711,
 * v43_stacked_area PC:720; gaya galeri = panel Gambar 8.4). W-02 milik inti (S32).
 *
 * Tanda data (spesifikasi §3.5 N2): satu `<path data-mark="line">` per seri (celah pada
 * nilai null = subpath baru), satu `<path data-mark="area">` per lapisan/area, titik
 * beraksen `<circle data-mark="point">`; `data-series` = nama seri, `data-index` = indeks
 * seri (garis/area) atau indeks kategori (titik). Label langsung dan label nilai adalah
 * teks tanpa `data-mark` (`data-label="series|value"`).
 *
 * Aksen (maks `chart.accent.maxSubjects`, default 1): `series[].accent`, medan `accent`
 * {series, group, point} atau alias params `accentSeries|accentGroup|accentPoint`.
 * Petunjuk yang tidak cocok dengan data diabaikan dan dilaporkan REPORT `ACCENT_IGNORED`.
 */
import type { ChartCanvas, ChartRenderer, LintIssue, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { fmt } from "../../bind";
import { KEY_ROW_HEIGHT_MM, keyRow } from "../core/apparatus";
import { defect, figureLabel, requireCategorical } from "../core/guards";
import { type ChartPalette, chartPalette, kindKey, paramBool } from "../core/palette";
import { chartFloors } from "../core/prepare";
import { num, ptToMm, textWidthMm } from "../core/svg";
import { type Frame, type W1Style, drawAxes, drawFoot, drawGrid, layoutFrame, spreadLabels, styleMetrics } from "./frame";
import { type AccentRequest, type W1Code, accentRequest, w1Bool, w1Int } from "./params";
import { categoryIndex } from "./timeaxis";
import { kindAxis, kindEnum } from "../core/read";

type StepMode = "post" | "pre" | "mid";

/** Batas garis W-03 (tanpa ParamDef; selaras W-01 maxLines dan maks warna P7-17). */
const W03_MAX_LINES = 3;

interface SeriesIn {
  name: string;
  values: Array<number | null>;
  accent: boolean;
}

function styleOf(spec: StudioChartV1): W1Style {
  return (spec.style ?? "datum") === "gallery" ? "gallery" : "datum";
}

function requireSeries(spec: StudioChartV1, code: W1Code): { cats: string[]; series: SeriesIn[] } {
  const fid = figureLabel(spec);
  const d = spec.data;
  if (!d) throw new StudioEngineError("SCHEMA_INVALID", `${fid} — ${code}: data wajib`, { code });
  if (d.shape !== "series") {
    throw new StudioEngineError("SCHEMA_INVALID", `${fid} — ${code} membutuhkan data "series", diterima "${d.shape}"`, { code, shape: d.shape });
  }
  if (!Array.isArray(d.categories) || d.categories.length === 0 || !Array.isArray(d.series) || d.series.length === 0) {
    throw defect("DC-G1", `${fid} — grafik tanpa data`, { code });
  }
  if (d.categories.some((c) => typeof c !== "string")) {
    throw new StudioEngineError("SCHEMA_INVALID", `${fid} — ${code}: categories harus string`, { code });
  }
  const n = d.categories.length;
  const names = new Set<string>();
  const series = d.series.map((s, i) => {
    if (typeof s?.name !== "string" || s.name.length === 0) {
      throw new StudioEngineError("SCHEMA_INVALID", `${fid} — ${code}: seri ${i} tanpa nama`, { code, index: i });
    }
    if (names.has(s.name)) throw new StudioEngineError("SCHEMA_INVALID", `${fid} — ${code}: nama seri "${s.name}" ganda`, { code });
    names.add(s.name);
    if (!Array.isArray(s.values) || s.values.length !== n) {
      throw new StudioEngineError("SCHEMA_INVALID", `${fid} — ${code}: seri "${s.name}" memuat ${s.values?.length ?? 0} nilai, kategori ${n}`, {
        code,
        series: s.name,
      });
    }
    s.values.forEach((v, j) => {
      if (v !== null && (typeof v !== "number" || !Number.isFinite(v))) {
        throw defect("DC-G1", `${fid} — seri "${s.name}" nilai ${j} bukan bilangan hingga atau null`, { code, series: s.name, index: j });
      }
    });
    return { name: s.name, values: [...s.values], accent: s.accent === true };
  });
  if (!series.some((s) => s.values.some((v) => v !== null))) throw defect("DC-G1", `${fid} — semua nilai null`, { code });
  return { cats: [...d.categories], series };
}

function report(issues: LintIssue[]): SvgResult["report"] {
  return { checksRun: [...new Set(issues.map((i) => i.checkId))], issues };
}

function ignoredAccent(detail: string): LintIssue {
  return { checkId: "ACCENT_IGNORED", status: "REPORT", detail };
}

interface SeriesAccent {
  /** Indeks seri beraksen, -1 bila tidak ada. */
  series: number;
  point?: { si: number; ci: number };
}

/** Aksen seri dan titik pada data series; melempar DATUM-26 bila subjek > maks. */
function resolveSeriesAccent(
  spec: StudioChartV1,
  code: W1Code,
  series: readonly SeriesIn[],
  cats: readonly string[],
  f: Frame,
  req: AccentRequest,
  maxAccent: number,
  issues: LintIssue[],
  allowPoint: boolean,
): SeriesAccent {
  const fid = figureLabel(spec);
  const set = new Set<number>(series.flatMap((s, i) => (s.accent ? [i] : [])));
  for (const name of [req.series, req.group]) {
    if (name === undefined) continue;
    const i = series.findIndex((s) => s.name === name);
    if (i >= 0) set.add(i);
    else issues.push(ignoredAccent(`seri beraksen "${name}" tidak ada di data`));
  }
  const sIdx = set.size ? Math.min(...set) : -1;
  let point: SeriesAccent["point"];
  if (req.point) {
    if (!allowPoint) {
      issues.push(ignoredAccent(`aksen titik tidak berlaku untuk ${code}`));
    } else {
      const ci = categoryIndex(req.point.at, cats, f.x);
      const si = req.point.series !== undefined ? series.findIndex((s) => s.name === req.point?.series) : sIdx >= 0 ? sIdx : 0;
      if (ci < 0 || si < 0 || series[si].values[ci] === null) {
        issues.push(ignoredAccent(`titik beraksen ${JSON.stringify(req.point.at)} tidak ditemukan`));
      } else {
        point = { si, ci };
      }
    }
  }
  const subjects = set.size + (point && point.si !== sIdx ? 1 : 0);
  if (subjects > maxAccent) {
    throw defect("DATUM-26", `${fid} — ${subjects} subjek beraksen; maks ${maxAccent} aksen per gambar (§03 §2)`, { code, accents: subjects });
  }
  return { series: sIdx, ...(point ? { point } : {}) };
}

// ── W-01 line, W-03 step line ────────────────────────────────────────────

interface LineLook {
  stroke: string;
  widthMm: number;
  dash?: number[];
  label: string;
}

function lineLooks(style: W1Style, pal: ChartPalette, n: number, accent: number): LineLook[] {
  const out: LineLook[] = [];
  let ctx = 0;
  for (let i = 0; i < n; i++) {
    if (style === "datum") {
      const wMain = ptToMm(1.4);
      const wCtx = ptToMm(1.2);
      const dashes = [undefined, [4, 3].map((v) => v * wCtx), [1, 2].map((v) => v * wCtx)];
      if (i === accent) out.push({ stroke: pal.role.accent, widthMm: wMain, label: pal.role.accent });
      else if (accent < 0 && i === 0) out.push({ stroke: pal.ink900, widthMm: wMain, label: pal.ink900 });
      else {
        const k = accent < 0 ? i : ctx;
        const dash = dashes[k % dashes.length];
        out.push({ stroke: pal.ink400, widthMm: wCtx, ...(dash ? { dash } : {}), label: pal.ink400 });
        ctx++;
      }
    } else {
      const dashes = [undefined, [1.2, 0.8], [0.4, 0.6]];
      if (i === accent) out.push({ stroke: pal.role.accent, widthMm: 0.45, label: pal.role.accent });
      else if (accent < 0 && i === 0) out.push({ stroke: pal.ink900, widthMm: 0.45, label: pal.ink900 });
      else {
        const k = accent < 0 ? i - 1 : ctx;
        const dash = dashes[k % dashes.length];
        out.push({ stroke: pal.role.contextBackground, widthMm: 0.3, ...(dash ? { dash } : {}), label: pal.ink400 });
        ctx++;
      }
    }
  }
  return out;
}

/**
 * Path garis (atau tangga matplotlib `where`: "post" PC:772 = nilai bertahan sampai titik
 * berikut, "pre" = naik dulu, "mid" = berpindah di tengah); null memutus garis.
 */
function linePath(xs: readonly number[], ys: ReadonlyArray<number | null>, step: StepMode | false): { d: string; isolated: number[] } {
  const parts: string[] = [];
  const isolated: number[] = [];
  let seg: number[] = [];
  const flush = (): void => {
    if (seg.length === 1) isolated.push(seg[0]);
    else if (seg.length > 1) {
      let d = `M${num(xs[seg[0]])} ${num(ys[seg[0]] as number)}`;
      for (let k = 1; k < seg.length; k++) {
        const j = seg[k];
        const y = ys[j] as number;
        if (step === "post") d += ` H${num(xs[j])} V${num(y)}`;
        else if (step === "pre") d += ` V${num(y)} H${num(xs[j])}`;
        else if (step === "mid") d += ` H${num((xs[seg[k - 1]] + xs[j]) / 2)} V${num(y)} H${num(xs[j])}`;
        else d += ` L${num(xs[j])} ${num(y)}`;
      }
      parts.push(d);
    }
    seg = [];
  };
  ys.forEach((y, j) => {
    if (y === null) flush();
    else seg.push(j);
  });
  flush();
  return { d: parts.join(" "), isolated };
}

function lastIndex(values: ReadonlyArray<number | null>): number {
  for (let j = values.length - 1; j >= 0; j--) if (values[j] !== null) return j;
  return -1;
}

function drawPointAccent(f: Frame, spec: StudioChartV1, seriesName: string, ci: number, v: number, marker: boolean): void {
  const x = f.sx(f.x.pos[ci]);
  const y = f.sy(v);
  const r = f.style === "gallery" ? 0.75 : 0.9;
  if (marker) f.doc.circle(x, y, r, f.pal.role.accent, { mark: { mark: "point", series: seriesName, index: ci } });
  f.doc.text(x, y - r - 0.9, fmt(v, spec.dec ?? 0), {
    face: "data",
    sizePt: f.m.valuePt,
    fill: f.pal.role.accent,
    anchor: "middle",
    attrs: ' data-label="value"',
  });
}

function renderLine(code: "W-01" | "W-03", spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate): SvgResult {
  const fid = figureLabel(spec);
  const style = styleOf(spec);
  const floors = chartFloors(spec, tpl);
  const pal = chartPalette(spec, tpl);
  const issues: LintIssue[] = [];
  const { cats, series } = requireSeries(spec, code);

  const maxLines = code === "W-01" ? w1Int(spec, tpl, "W-01", "maxLines", 3) : W03_MAX_LINES;
  if (series.length > maxLines) {
    throw defect(code === "W-01" ? kindKey("W-01", "maxLines") : "DATUM-25", `${fid} — ${series.length} garis > ${maxLines}; sorot satu garis atau pecah gambarnya`, {
      code,
      lines: series.length,
    });
  }
  const labelEnd = code === "W-01" ? w1Bool(spec, tpl, "W-01", "labelAtLineEnd", true) : series.length >= 2;
  const useKey = !labelEnd && series.length >= 2;
  const m = styleMetrics(style, floors.minFontPt);
  const rightGutterMm = labelEnd ? Math.max(...series.map((s) => textWidthMm(s.name, m.labelPt))) + 1.8 : style === "gallery" ? 0.6 : 1.0;
  const f = layoutFrame({
    spec,
    canvas,
    pal,
    style,
    code,
    minFontPt: floors.minFontPt,
    categories: cats,
    yValues: series.flatMap((s) => s.values.filter((v): v is number => v !== null)),
    yMode: style === "gallery" ? "nice" : "pad",
    padX: code === "W-01" ? 0 : style === "gallery" ? 0.03 : 0.05,
    rightGutterMm,
    topExtraMm: useKey ? KEY_ROW_HEIGHT_MM + 1.2 : 0,
    grid: true,
    // Petunjuk galeri (IP-41c): domain y tercetak.
    yAxis: kindAxis({ spec, tpl, code }),
  });
  if (f.yAxisWidened) issues.push({ checkId: "AXIS_DOMAIN", status: "REPORT", detail: f.yAxisWidened });
  const stepMode: StepMode | false = code === "W-03" ? kindEnum({ spec, tpl, code }, "step", ["post", "pre", "mid"] as const, "post") : false;
  const acc = resolveSeriesAccent(spec, code, series, cats, f, accentRequest(spec), floors.maxAccent, issues, true);
  const looks = lineLooks(style, pal, series.length, acc.series);

  drawGrid(f, true);
  const xs = f.x.pos.map((p) => f.sx(p));
  // Konteks dulu, aksen terakhir (di atas).
  const order = series.map((_, i) => i).sort((a, b) => Number(a === acc.series) - Number(b === acc.series) || a - b);
  for (const i of order) {
    const s = series[i];
    const look = looks[i];
    const ys = s.values.map((v) => (v === null ? null : f.sy(v)));
    const { d, isolated } = linePath(xs, ys, stepMode);
    if (d) {
      f.doc.path(d, "none", {
        mark: { mark: "line", series: s.name, index: i },
        stroke: look.stroke,
        strokeWidthMm: look.widthMm,
        ...(look.dash ? { dashMm: look.dash } : {}),
        attrs: ' stroke-linejoin="round" stroke-linecap="butt"',
      });
    }
    for (const j of isolated) {
      f.doc.circle(xs[j], ys[j] as number, Math.max(look.widthMm, 0.5), look.stroke, { mark: { mark: "point", series: s.name, index: j } });
    }
  }
  if (acc.point) {
    const s = series[acc.point.si];
    drawPointAccent(f, spec, s.name, acc.point.ci, s.values[acc.point.ci] as number, acc.point.si !== acc.series);
  }

  if (labelEnd) {
    const ends = series.map((s) => lastIndex(s.values));
    const raw = series.map((s, i) => f.sy(s.values[ends[i]] as number));
    const ys = spreadLabels(raw, ptToMm(m.labelPt) * 1.15, f.y0, f.y1);
    series.forEach((s, i) => {
      f.doc.text(xs[ends[i]] + 1.2, ys[i] + ptToMm(m.labelPt) * 0.35, s.name, {
        sizePt: m.labelPt,
        fill: looks[i].label,
        attrs: ' data-label="series"',
      });
    });
  } else if (useKey) {
    const keyPt = Math.max(6.2, floors.minFontPt);
    keyRow(
      f.doc,
      f.x0,
      (style === "gallery" ? 2.2 : 2.4) + ptToMm(keyPt) * 0.9,
      series.map((s, i) => ({ label: s.name, color: looks[i].stroke })),
      pal,
      keyPt,
    );
  }

  drawAxes(f, spec.unit ?? "");
  drawFoot(f, spec);
  return { svg: f.doc.toString(), widthMm: f.W, heightMm: f.H, report: report(issues) };
}

// ── W-04 area ────────────────────────────────────────────────────────────

function renderArea(spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate): SvgResult {
  const code = "W-04" as const;
  const fid = figureLabel(spec);
  const style = styleOf(spec);
  const floors = chartFloors(spec, tpl);
  const pal = chartPalette(spec, tpl);
  const issues: LintIssue[] = [];
  const pts = requireCategorical(spec, code, floors.maxAccent);
  const cats = pts.map((p) => p.label);
  const values = pts.map((p) => p.value);
  const zero = w1Bool(spec, tpl, code, "zeroBaseline", paramBool(spec, tpl, "chart.zeroBaseline", true));

  const f = layoutFrame({
    spec,
    canvas,
    pal,
    style,
    code,
    minFontPt: floors.minFontPt,
    categories: cats,
    yValues: zero ? [...values, 0] : values,
    yMode: zero ? "zeroTop" : style === "gallery" ? "nice" : "pad",
    padX: style === "gallery" ? 0.03 : 0.05,
    rightGutterMm: style === "gallery" ? 0.6 : 1.0,
    topExtraMm: 0,
    grid: true,
  });
  if (!zero) {
    issues.push({ checkId: "CH-01", status: "REPORT", detail: `domain area ${fmt(f.yMin, f.yDec)}..${fmt(f.yMax, f.yDec)} tidak bermula nol (zeroBaseline=false)` });
  }

  const req = accentRequest(spec);
  const set = new Set<number>(pts.flatMap((p, i) => (p.accent ? [i] : [])));
  if (req.series !== undefined) issues.push(ignoredAccent(`aksen seri tidak berlaku untuk ${code} (satu deret)`));
  for (const at of [req.point?.at, req.group]) {
    if (at === undefined) continue;
    const ci = categoryIndex(at, cats, f.x);
    if (ci >= 0) set.add(ci);
    else issues.push(ignoredAccent(`titik beraksen ${JSON.stringify(at)} tidak ditemukan`));
  }
  if (set.size > floors.maxAccent) {
    throw defect("DATUM-26", `${fid} — ${set.size} titik beraksen; maks ${floors.maxAccent} aksen per gambar (§03 §2)`, { code, accents: set.size });
  }

  drawGrid(f, true);
  const name = spec.unit || "nilai";
  const xs = f.x.pos.map((p) => f.sx(p));
  const ys = values.map((v) => f.sy(v));
  const yb = zero ? f.sy(0) : f.y1;
  const top = xs.map((x, j) => `L${num(x)} ${num(ys[j])}`).join(" ");
  f.doc.path(`M${num(xs[0])} ${num(yb)} ${top} L${num(xs[xs.length - 1])} ${num(yb)} Z`, pal.role.contextBackground, {
    mark: { mark: "area", series: name, index: 0 },
  });
  const line = linePath(xs, ys, false);
  if (line.d) {
    f.doc.path(line.d, "none", {
      mark: { mark: "line", series: name, index: 0 },
      stroke: style === "gallery" ? pal.role.textAxis : pal.ink900,
      strokeWidthMm: style === "gallery" ? 0.3 : ptToMm(1.2),
      attrs: ' stroke-linejoin="round"',
    });
  }
  for (const ci of [...set].sort((a, b) => a - b)) drawPointAccent(f, spec, name, ci, values[ci], true);

  drawAxes(f, spec.unit ?? "");
  drawFoot(f, spec);
  return { svg: f.doc.toString(), widthMm: f.W, heightMm: f.H, report: report(issues) };
}

// ── W-05 stacked area ────────────────────────────────────────────────────

function renderStacked(spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate): SvgResult {
  const code = "W-05" as const;
  const fid = figureLabel(spec);
  const style = styleOf(spec);
  const floors = chartFloors(spec, tpl);
  const pal = chartPalette(spec, tpl);
  const issues: LintIssue[] = [];
  const { cats, series } = requireSeries(spec, code);

  const maxLayers = w1Int(spec, tpl, code, "maxLayers", 4);
  if (series.length > maxLayers) {
    throw defect(kindKey(code, "maxLayers"), `${fid} — ${series.length} lapisan > ${maxLayers}; gabungkan lapisan kecil`, { code, layers: series.length });
  }
  let nulls = 0;
  const vals = series.map((s) =>
    s.values.map((v, j) => {
      if (v === null) {
        nulls++;
        return 0;
      }
      if (v < 0) {
        throw defect("CH-01", `${fid} — ${code}: nilai negatif pada seri "${s.name}" titik ${j}; lapisan bertumpuk bertumpu pada nol`, { code, series: s.name, index: j });
      }
      return v;
    }),
  );
  if (nulls) issues.push({ checkId: "W-05-NULL", status: "REPORT", detail: `${nulls} nilai null dibaca 0 pada tumpukan` });

  const largestAtBottom = w1Bool(spec, tpl, code, "largestAtBottom", true);
  const sums = vals.map((v) => v.reduce((a, b) => a + b, 0));
  const order = series.map((_, i) => i);
  if (largestAtBottom) order.sort((a, b) => sums[b] - sums[a] || a - b);
  const totals = cats.map((_, j) => vals.reduce((a, v) => a + v[j], 0));

  const m = styleMetrics(style, floors.minFontPt);
  const labelled = style === "datum" || canvas.widthMm >= 100;
  const rightGutterMm = labelled ? Math.max(...series.map((s) => textWidthMm(s.name, m.labelPt))) + 1.8 : style === "gallery" ? 0.6 : 1.0;
  const f = layoutFrame({
    spec,
    canvas,
    pal,
    style,
    code,
    minFontPt: floors.minFontPt,
    categories: cats,
    yValues: [...totals, 0],
    yMode: "zeroTop",
    padX: style === "gallery" ? 0.03 : 0,
    rightGutterMm,
    topExtraMm: 0,
    grid: false,
  });
  const acc = resolveSeriesAccent(spec, code, series, cats, f, accentRequest(spec), floors.maxAccent, issues, false);

  const ramp =
    style === "gallery"
      ? [pal.role.contextMain, pal.role.contextBackground, pal.ink700, pal.ink900]
      : [pal.ink900, pal.ink400, pal.ink200, pal.ink700];
  const fills = new Array<string>(series.length);
  let k = 0;
  for (const i of order) fills[i] = i === acc.series ? pal.role.accent : ramp[k++ % ramp.length];

  const xs = f.x.pos.map((p) => f.sx(p));
  const base = cats.map(() => 0);
  const mids: number[] = [];
  const last = cats.length - 1;
  for (const i of order) {
    const topV = base.map((b, j) => b + vals[i][j]);
    const fwd = xs.map((x, j) => `${j === 0 ? "M" : "L"}${num(x)} ${num(f.sy(topV[j]))}`).join(" ");
    const back = xs
      .map((x, j) => `L${num(x)} ${num(f.sy(base[j]))}`)
      .reverse()
      .join(" ");
    f.doc.path(`${fwd} ${back} Z`, fills[i], { mark: { mark: "area", series: series[i].name, index: i } });
    mids[i] = f.sy((base[last] + topV[last]) / 2);
    topV.forEach((v, j) => (base[j] = v));
  }

  if (labelled) {
    const ys = spreadLabels(mids, ptToMm(m.labelPt) * 1.15, f.y0, f.y1);
    const dark = new Set([pal.ink900, pal.ink700, pal.ink400, pal.role.contextMain, pal.role.accent]);
    series.forEach((s, i) => {
      f.doc.text(xs[last] + 1.2, ys[i] + ptToMm(m.labelPt) * 0.35, s.name, {
        sizePt: m.labelPt,
        fill: dark.has(fills[i]) ? fills[i] : pal.ink400,
        attrs: ' data-label="series"',
      });
    });
  }

  drawAxes(f, spec.unit ?? "");
  drawFoot(f, spec);
  return { svg: f.doc.toString(), widthMm: f.W, heightMm: f.H, report: report(issues) };
}

// ── Peta renderer ────────────────────────────────────────────────────────

/** Kunci params (alias / abaian) sudah diselesaikan resolver tunggal chart/core (D-87). */
export const W1_RENDERERS: Readonly<Record<W1Code, ChartRenderer>> = {
  "W-01": (s, c, t) => renderLine("W-01", s, c, t),
  "W-03": (s, c, t) => renderLine("W-03", s, c, t),
  "W-04": renderArea,
  "W-05": renderStacked,
};
