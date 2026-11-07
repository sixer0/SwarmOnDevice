/**
 * P-15 Table chart — tabel dengan pewarnaan bersyarat (Tabel 8.1).
 *
 * Acuan: pustakachart `v15_table` (PC:354-376, PENUH): tabel bergaris ink200 0,5 pt,
 * kepala tebal ink400, sel kertas, angka mono, aturan warna mewarnai TEKS sel (alert /
 * signal / ink900, LITERAL PC:364-371).
 * - Data: `matrix` (baris x kolom angka; label baris = kolom pertama) atau
 *   `params.tableRows` (baris campuran string/angka, kolom pertama = label) +
 *   `params.tableHead` (CHART_DATA_CONSTRAINTS P-15).
 * - `params.colourRule`: daftar aturan `{min?, max?, fill?, text?, cols?}` (inklusif; aturan
 *   pertama yang cocok menang; `cols` = indeks kolom data 0-based). Hanya sel angka.
 * - `colourRuleLegend` (default benar): baris KUNCI aturan warna di bawah tabel. Aturan
 *   tanpa keterangan dilaporkan REPORT (Hindari bila: aturan warna tanpa keterangan).
 * - Gaya `gallery` (Gambar 8.1): aturan mewarnai ISIAN sel (teks kontras otomatis), kolom
 *   data sama lebar, label baris dan kepala ink400. Gaya `datum` (PC): aturan mewarnai teks.
 * Sel data = `data-mark="cell"` (`data-series` = label baris, `data-index` = kolom data);
 * sel yang terkena aturan membawa `data-rule="<k>"`.
 */
import type { ChartCanvas, ParamValue, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { fmt } from "../../bind";
import { type KeyItem, keyRow } from "../core/apparatus";
import { defect, figureLabel } from "../core/guards";
import { kindKey } from "../core/palette";
import { textWidthMm } from "../core/svg";
import { GRID_MM, beginP2, finishP2, hint, kindBool, luminance, mid, reportIssue, textOn, tokenHex } from "./common";
import { fitActive } from "../core/fit";
import { ellipsize, lineHeightMm, measure, wrapEllipsize } from "../core/textfit";

const CODE = "P-15" as const;

type Cell = string | number;

interface Rule {
  min?: number;
  max?: number;
  fill?: string;
  text?: string;
  cols?: number[];
}

interface Table {
  head: string[];
  /** Kolom pertama = label baris. */
  body: Cell[][];
}

function tableOf(spec: StudioChartV1): Table {
  const fid = figureLabel(spec);
  const d = spec.data;
  if (d && d.shape === "matrix") {
    if (!Array.isArray(d.rows) || !Array.isArray(d.cols) || !Array.isArray(d.values) || d.rows.length === 0 || d.cols.length === 0) {
      throw defect("DC-G1", `${fid} — tabel tanpa data`, { code: CODE });
    }
    if (d.values.length !== d.rows.length) {
      throw new StudioEngineError("SCHEMA_INVALID", `${fid} — matrix ${d.values.length} baris nilai untuk ${d.rows.length} label baris`, { code: CODE });
    }
    const body = d.rows.map((r, i) => {
      const vs = d.values[i];
      if (!Array.isArray(vs) || vs.length !== d.cols.length) {
        throw new StudioEngineError("SCHEMA_INVALID", `${fid} — baris "${r}" memuat ${Array.isArray(vs) ? vs.length : 0} nilai untuk ${d.cols.length} kolom`, {
          code: CODE,
          index: i,
        });
      }
      vs.forEach((v, j) => {
        if (typeof v !== "number" || !Number.isFinite(v)) {
          throw defect("DC-G1", `${fid} — sel (${i}, ${j}) bukan bilangan hingga`, { code: CODE, index: i });
        }
      });
      return [String(r), ...vs];
    });
    return { head: ["", ...d.cols.map(String)], body };
  }
  const rows = hint(spec, "tableRows");
  if (rows === undefined) {
    throw new StudioEngineError(
      "SCHEMA_INVALID",
      `${fid} — P-15 membutuhkan data "matrix" atau params.tableRows + params.tableHead${d ? `, diterima "${d.shape}"` : ""}`,
      { code: CODE },
    );
  }
  const head = hint(spec, "tableHead");
  if (!Array.isArray(rows) || rows.length === 0 || !Array.isArray(head) || head.length === 0 || !head.every((h) => typeof h === "string")) {
    throw new StudioEngineError("SCHEMA_INVALID", `${fid} — params.tableRows (daftar baris) dan params.tableHead (daftar string) wajib`, { code: CODE });
  }
  const body = rows.map((r, i) => {
    if (!Array.isArray(r) || r.length !== head.length || !r.every((c) => typeof c === "string" || (typeof c === "number" && Number.isFinite(c)))) {
      throw new StudioEngineError("SCHEMA_INVALID", `${fid} — tableRows[${i}] harus ${head.length} sel string/angka`, { code: CODE, index: i });
    }
    return r as Cell[];
  });
  return { head: head as string[], body };
}

function rulesOf(spec: StudioChartV1, raw: ParamValue | undefined, ncols: number): Rule[] {
  if (raw === undefined) return [];
  const bad = (i: number, why: string): never => {
    throw new StudioEngineError("SCHEMA_INVALID", `${figureLabel(spec)} — params.colourRule[${i}] ${why}`, { key: "colourRule" });
  };
  if (!Array.isArray(raw)) return bad(0, "harus daftar aturan");
  return raw.map((r, i) => {
    if (!r || typeof r !== "object" || Array.isArray(r)) return bad(i, "bukan objek");
    const o = r as Record<string, ParamValue>;
    const out: Rule = {};
    for (const k of ["min", "max"] as const) {
      const v = o[k];
      if (v === undefined || v === null) continue;
      if (typeof v !== "number" || !Number.isFinite(v)) bad(i, `${k} bukan bilangan`);
      out[k] = v as number;
    }
    for (const k of ["fill", "text"] as const) {
      const v = o[k];
      if (v === undefined || v === null) continue;
      if (typeof v !== "string") bad(i, `${k} bukan tokenRef`);
      out[k] = v as string;
    }
    if (out.fill === undefined && out.text === undefined) bad(i, "tanpa fill maupun text");
    if (o.cols !== undefined && o.cols !== null) {
      const cs = o.cols;
      if (!Array.isArray(cs) || !cs.every((c) => typeof c === "number" && Number.isInteger(c) && c >= 0 && c < ncols)) bad(i, "cols bukan indeks kolom data");
      out.cols = cs as number[];
    }
    return out;
  });
}

function ruleLabel(r: Rule, dec: number): string {
  if (r.min !== undefined && r.max !== undefined) return `${fmt(r.min, dec)}–${fmt(r.max, dec)}`;
  if (r.min !== undefined) return `≥ ${fmt(r.min, dec)}`;
  if (r.max !== undefined) return `≤ ${fmt(r.max, dec)}`;
  return "semua";
}

/** Desimal terbanyak di data (maks 3) bila `spec.dec` tidak diisi. */
function autoDec(body: Cell[][]): number {
  let d = 0;
  for (const row of body) {
    for (const c of row.slice(1)) {
      if (typeof c !== "number") continue;
      const s = String(c);
      const k = s.includes(".") && !s.includes("e") ? s.split(".")[1].length : 0;
      d = Math.max(d, Math.min(3, k));
    }
  }
  return d;
}

/** Angka berformat (PC `_is_number`): wajah mono. */
function looksNumeric(s: string): boolean {
  const t = s.replace(/[,.%\s]/g, "");
  return t.length > 0 && /^[-+]?\d+$/.test(t);
}

export function renderTable(spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate): SvgResult {
  const ctx = beginP2(spec, canvas, tpl, CODE);
  const { pal, doc, style, W, H } = ctx;
  const t = tableOf(spec);
  const nData = t.head.length - 1;
  const rules = rulesOf(spec, hint(spec, "colourRule"), nData);
  const legend = kindBool(spec, tpl, CODE, "colourRuleLegend", true);
  const dec = spec.dec ?? autoDec(t.body);
  if (rules.length && !legend) {
    reportIssue(ctx, kindKey(CODE, "colourRuleLegend"), `${figureLabel(spec)} — aturan warna tanpa keterangan (colourRuleLegend=false)`);
  }
  const ruleHex = rules.map((r, k) => ({
    fill: r.fill !== undefined ? tokenHex(ctx, r.fill, `colourRule[${k}].fill`) : undefined,
    text: r.text !== undefined ? tokenHex(ctx, r.text, `colourRule[${k}].text`) : undefined,
  }));
  const matchRule = (v: Cell, col: number): number => {
    if (typeof v !== "number") return -1;
    return rules.findIndex((r) => (r.min === undefined || v >= r.min) && (r.max === undefined || v <= r.max) && (!r.cols || r.cols.includes(col)));
  };
  const show = (c: Cell): string => (typeof c === "number" ? fmt(c, dec) : c);

  const FS = ctx.pt(style === "gallery" ? 6.4 : 6.8);
  const KEY_PT = ctx.pt(6.2);
  const keyBand = rules.length && legend ? 5.2 : 0;
  const headH = style === "gallery" ? 4.4 : 4.6;
  const top = 0.4;
  const avail = H - ctx.footBand - keyBand - top - headH - 0.4;
  const rowH = Math.min(avail / t.body.length, style === "gallery" ? 9 : 5.4);
  const colTextW = (j: number): number =>
    Math.max(textWidthMm(t.head[j], FS), ...t.body.map((r) => textWidthMm(show(r[j]), FS, j === 0 ? "struct" : "data")));
  // Lebar kolom: label = isi + talang; data galeri sama lebar, datum sebanding isi (PC auto).
  const tableW = W - (style === "gallery" ? 0.4 : 1.0);
  // FIG-02a P1-5: saat fit, kolom label dijepit 40 % lebar tabel; label dibungkus/dipotong.
  const labelPad = style === "gallery" ? 1.6 : 2.4;
  const labelW0 = colTextW(0) + labelPad;
  const labelW = fitActive() ? Math.min(labelW0, tableW * 0.4) : labelW0;
  const labelLh = lineHeightMm({ pt: FS });
  const labelLines = (s0: string): { lines: string[]; title?: string } => {
    if (!fitActive() || measure(s0, FS) <= labelW - labelPad + 1e-9) return { lines: [s0] };
    const r = wrapEllipsize(s0, labelW - labelPad, rowH >= 2 * labelLh ? 2 : 1, { pt: FS });
    return { lines: r.lines, title: r.truncated ? s0 : undefined };
  };
  const x0 = style === "gallery" ? 0.2 : (W - tableW) / 2;
  const dataW = tableW - labelW;
  const natural = Array.from({ length: nData }, (_, j) => colTextW(j + 1) + 2.0);
  const natSum = natural.reduce((a, b) => a + b, 0);
  const widths = style === "gallery" ? natural.map(() => dataW / nData) : natural.map((w) => (w / natSum) * dataW);
  const xs: number[] = [];
  widths.reduce((acc, w) => {
    xs.push(acc);
    return acc + w;
  }, x0 + labelW);
  const gap = style === "gallery" ? 0.5 : 0;

  // Kepala.
  const hy = top + headH;
  doc.open('data-table="head"');
  if (style === "datum") {
    doc.rect(x0, top, tableW, headH, pal.paper, { stroke: pal.ink200, strokeWidthMm: GRID_MM });
    if (t.head[0]) doc.text(x0 + 1.2, mid(top + headH / 2, FS), t.head[0], { sizePt: FS, fill: pal.ink400, bold: true });
  }
  t.head.slice(1).forEach((h, j) => {
    const cx = xs[j] + widths[j] / 2;
    if (style === "datum") doc.rect(xs[j], top, widths[j], headH, pal.paper, { stroke: pal.ink200, strokeWidthMm: GRID_MM });
    const hb = { sizePt: FS, fill: pal.ink400, anchor: "middle" as const, bold: style === "datum" };
    const hyy = style === "gallery" ? hy - 1.2 : mid(top + headH / 2, FS);
    const he = fitActive() ? ellipsize(h, widths[j] - 0.6, { pt: FS, bold: style === "datum" }) : { text: h, truncated: false };
    if (he.truncated) doc.textLines(cx, hyy, [he.text], hb, 0, h);
    else doc.text(cx, hyy, h, hb);
  });
  doc.close();

  // Badan.
  t.body.forEach((row, i) => {
    const y = hy + i * rowH;
    const yc = y + rowH / 2;
    const series = String(row[0]);
    doc.open(`data-table-row="${i}"`);
    if (style === "datum") doc.rect(x0, y, labelW, rowH, pal.paper, { stroke: pal.ink200, strokeWidthMm: GRID_MM });
    const ll = labelLines(series);
    if (ll.lines.length > 1 || ll.title !== undefined) {
      doc.textLines(style === "gallery" ? x0 + labelW - 1.2 : x0 + 1.2, mid(yc, FS) - ((ll.lines.length - 1) * labelLh) / 2, ll.lines, {
        sizePt: FS,
        fill: style === "gallery" ? pal.ink400 : pal.ink700,
        anchor: style === "gallery" ? "end" : "start",
      }, labelLh, ll.title);
    } else {
      doc.text(style === "gallery" ? x0 + labelW - 1.2 : x0 + 1.2, mid(yc, FS), series, {
        sizePt: FS,
        fill: style === "gallery" ? pal.ink400 : pal.ink700,
        anchor: style === "gallery" ? "end" : "start",
      });
    }
    row.slice(1).forEach((c, j) => {
      const k = matchRule(c, j);
      const rh = k >= 0 ? ruleHex[k] : undefined;
      const fill = style === "gallery" && rh?.fill ? rh.fill : pal.paper;
      const ruleAttr = k >= 0 ? ` data-rule="${k}"` : "";
      doc.rect(xs[j] + gap / 2, y + gap / 2, widths[j] - gap, rowH - gap, fill, {
        mark: { mark: "cell", series, index: j },
        ...(fill === pal.paper ? { stroke: pal.ink200, strokeWidthMm: style === "gallery" ? 0.2 : GRID_MM } : {}),
        attrs: ruleAttr,
      });
      const s = show(c);
      // Datum (PC): warna aturan mewarnai teks; isian terang (mis. paper) tidak terbaca sebagai teks -> ink700.
      const ruleText = rh?.text ?? (rh?.fill && luminance(rh.fill) < 0.5 ? rh.fill : undefined);
      const txt = style === "gallery" ? (rh?.text ?? textOn(fill, pal)) : (ruleText ?? pal.ink700);
      const numeric = typeof c === "number" || looksNumeric(s);
      doc.text(xs[j] + widths[j] / 2, mid(yc, FS), s, { face: numeric ? "data" : "struct", sizePt: FS, fill: txt, anchor: "middle", attrs: ' data-label="value"' });
    });
    doc.close();
  });

  if (rules.length && legend) {
    const items: KeyItem[] = rules.map((r, k) => ({ label: ruleLabel(r, dec), color: ruleHex[k].fill ?? ruleHex[k].text ?? pal.ink900 }));
    keyRow(doc, x0, hy + t.body.length * rowH + 4.2, items, pal, KEY_PT);
  }
  return finishP2(ctx);
}
