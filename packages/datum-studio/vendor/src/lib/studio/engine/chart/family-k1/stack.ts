/**
 * engine/chart/family-k1 — K-01 stacked bar dan K-02 100 % stacked bar (S37).
 *
 * Data "series": kategori = batang (atas ke bawah sesuai urutan data, PC `invert_yaxis`),
 * seri = segmen (kiri ke kanan). Acuan PC `_stack_rows(labels, parts, total100, ...)`
 * (PC:406-424; K-02 lewat v19_stacked_bar PC:426-429).
 *
 * Parameter registri: K-02 `maxSegments` (2..4, default 4; lebih -> BY_CONSTRUCTION
 * `chart.kind.K-02.maxSegments`), `keySegmentLeft` (default true: seri beraksen dipindah
 * ke segmen paling kiri). K-01 tidak punya parameter khusus.
 *
 * Gaya datum (port PC, CB1): warna `CAT_SERIES[si % 5]`; label segmen bila nilai
 * terplot > 9 (PC:414) DAN muat di segmen; K-02 "52%" (PC `"%d%%" % round(v)`, round =
 * half-even); K-01 TANPA "%" (deviasi: PC menempelkan "%" pada nilai mentah); domain
 * K-01 = 0..total maksimum (PC set_xlim), K-02 = 0..100; grid x; baris KUNCI di atas.
 * Gaya gallery (Gambar 8.3): aksen + ramp tinta; K-01 total di ujung batang dan sumbu y;
 * K-02 label persen di dalam segmen; sumbu x hairline bertick.
 * Petunjuk galeri (IP-41c; tidak diset = perilaku gaya di atas, diset = kedua gaya):
 * K-01 `totalLabels` (total di ujung batang), `totalsFromLabel` (teks total dari angka
 * tercetak per kategori; selisih dari jumlah segmen -> REPORT K-01.total); K-02
 * `segmentValueLabels` (label nilai di dalam segmen yang muat).
 */
import type { ChartCanvas, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { fmt, pyRound } from "../../bind";
import { apparatusMarker, figureApparatus, keyRow, keyRowExtraMm, noteLine, figureFootMm } from "../core/apparatus";
import { defect, figureLabel } from "../core/guards";
import { chartPalette, paramBool } from "../core/palette";
import { kindBool, kindNumMap } from "../core/read";
import { chartFloors } from "../core/prepare";
import { decimalsFor, linearScale, niceDomain } from "../core/scale";
import { SvgDoc, textWidthMm } from "../core/svg";
import {
  K1Report,
  type SeriesRow,
  assertSeriesNonNegative,
  drawGridX,
  drawXAxis,
  footBandMm,
  galleryColors,
  hFrame,
  inkOn,
  k1Key,
  mid,
  paramInt,
  pcCatSeries,
  requireSeries,
  rootAttrs,
  styleOf,
  SERIES_ACCENT_ATTR,
} from "./common";

type StackCode = "K-01" | "K-02";

export function renderStack(code: StackCode, spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate): SvgResult {
  const rep = new K1Report();
  const style = styleOf(spec);
  const floors = chartFloors(spec, tpl);
  const pal = chartPalette(spec, tpl);
  const data = requireSeries(spec, code, floors.maxAccent, rep);
  assertSeriesNonNegative(spec, code, data);
  const total100 = code === "K-02";
  const dec = spec.dec ?? 0;

  let order: SeriesRow[] = data.series;
  if (code === "K-02") {
    const maxSeg = paramInt(spec, tpl, k1Key("K-02", "maxSegments"), 4);
    if (order.length > maxSeg) {
      throw defect(k1Key("K-02", "maxSegments"), `${figureLabel(spec)} — ${order.length} segmen > ${maxSeg}; gabungkan segmen kecil`, {
        code,
        segments: order.length,
      });
    }
    rep.pass(k1Key("K-02", "maxSegments"));
    if (paramBool(spec, tpl, k1Key("K-02", "keySegmentLeft"), true)) {
      // Urut stabil: seri beraksen ke kiri, sisanya mempertahankan urutan masukan.
      order = [...order.filter((s) => s.accent), ...order.filter((s) => !s.accent)];
    }
  }

  // Nilai terplot per baris (K-02: persen baris; nilai null = segmen tidak digambar).
  const rows = data.categories.map((_, ci) => {
    const raw = order.map((s) => s.values[ci]);
    const sum = raw.reduce<number>((a, v) => a + (v ?? 0), 0);
    if (total100 && !(sum > 0)) {
      throw defect("DC-G1", `${figureLabel(spec)} — K-02 kategori "${data.categories[ci]}" tanpa total positif; persen tidak terdefinisi`, {
        code,
        index: ci,
      });
    }
    return { raw, sum, plotted: raw.map((v) => (v === null ? null : total100 ? (v / sum) * 100 : v)) };
  });

  const colors =
    style === "datum"
      ? order.map((_, si) => pcCatSeries(pal)[si % 5])
      : galleryColors(
          order.map((s) => s.accent),
          pal,
          spec,
          code,
        );
  if (style === "datum" && order.some((s) => s.accent)) {
    rep.add("ACCENT_HINT", "REPORT", "gaya datum memakai palet acuan PC CAT_SERIES per indeks segmen; aksen seri tidak diterapkan (pakai style gallery)");
  }

  const W = canvas.widthMm;
  const H = canvas.heightMm;
  const doc = new SvgDoc(W, H, rootAttrs(code, style), chartFloors(spec, tpl).minFontPt);
  if ((spec.apparatus ?? "page") === "page") apparatusMarker(doc, spec);
  doc.paper(pal.paper);
  const foot = footBandMm(spec);
  const maxSum = Math.max(...rows.map((r) => r.plotted.reduce<number>((a, v) => a + (v ?? 0), 0)));
  const own = { spec, tpl, code };
  const showTotals = code === "K-01" && kindBool(own, "totalLabels", style === "gallery");
  const segLabels = code === "K-02" ? kindBool(own, "segmentValueLabels", true) : style === "datum";
  const printed = code === "K-01" ? kindNumMap(own, "totalsFromLabel") : undefined;
  const totals = rows.map((r, ci) => {
    const p = printed?.[data.categories[ci]];
    if (p === undefined) return fmt(r.sum, dec);
    if (Math.abs(p - r.sum) > 1e-9) rep.add("K-01.total", "REPORT", `total tercetak ${data.categories[ci]} ${fmt(p, dec)} != jumlah segmen ${fmt(r.sum, dec)} (dipakai apa adanya)`);
    return fmt(p, dec);
  });
  if (printed) {
    const miss = Object.keys(printed).filter((k) => !data.categories.includes(k));
    if (miss.length) rep.add("K-01.total", "REPORT", `kategori totalsFromLabel tak dikenal diabaikan: ${miss.join(", ")}`);
  }
  const totalW = showTotals ? Math.max(...totals.map((t) => textWidthMm(t, 6.4, "data"))) + 1.8 : 0;

  if (style === "datum") {
    const keyBand = 6.0;
    const title = code === "K-02" ? "Komposisi (%)" : (spec.unit ?? "");
    const axisY = H - foot - (title ? 7.8 : 4.6);
    const frameAt = (top: number) => hFrame({ categories: data.categories, labelPt: 6.5, widthMm: W, top, base: axisY, rightGutter: Math.max(3, totalW), barRatio: 0.55 });
    const fr0 = frameAt(keyBand + 0.8);
    // FIG-02a P1-7: KUNCI multi-baris (hanya saat fit) menurunkan tepi atas plot.
    const keyExtra = keyRowExtraMm(fr0.x0, order.map((s) => s.name));
    const fr = keyExtra > 0 ? frameAt(keyBand + keyExtra + 0.8) : fr0;
    const domMax = total100 ? 100 : maxSum > 0 ? maxSum : 1;
    const nd = niceDomain([0, domMax], { zero: true });
    const dom = { ...nd, ticks: nd.ticks.filter((t) => t <= domMax + 1e-9) };
    const sx = linearScale(0, domMax, fr.x0, fr.x1);
    drawGridX(doc, dom.ticks, sx, fr.top, axisY, pal);
    keyRow(
      doc,
      fr.x0,
      4.0,
      order.map((s, si) => ({ label: s.name, color: colors[si] })),
      pal,
    );
    const pcDark = [pal.ink900, pal.signal, pal.verd, pal.alert];
    rows.forEach((r, ci) => {
      const yc = fr.yc(ci);
      doc.text(fr.x0 - 1.6, mid(yc, 6.5), data.categories[ci], { sizePt: 6.5, fill: pal.ink400, anchor: "end" });
      let left = 0;
      r.plotted.forEach((v, si) => {
        if (v === null) return;
        const xa = sx(left);
        const xb = sx(left + v);
        doc.rect(xa, yc - fr.barH / 2, xb - xa, fr.barH, colors[si], {
          mark: { mark: "segment", series: order[si].name, index: ci },
          // Seri berwarna aksen = SATU subjek lint 26 (konvensi `data-accent="series"`, IP-25).
          attrs: colors[si] === pal.role.accent ? SERIES_ACCENT_ATTR : "",
        });
        const s = total100 ? `${fmt(pyRound(v), 0)}%` : fmt(pyRound(v, dec), dec);
        if (segLabels && v > 9 && xb - xa >= textWidthMm(s, 6.0, "data") + 0.6) {
          doc.text((xa + xb) / 2, mid(yc, 6.0), s, {
            face: "data",
            sizePt: 6.0,
            fill: pcDark.includes(colors[si]) ? pal.paper : pal.ink700,
            anchor: "middle",
            attrs: ' data-label="value"',
          });
        }
        left += v;
      });
      if (showTotals) {
        doc.text(sx(left) + 1.0, mid(yc, 6.5), totals[ci], { face: "data", sizePt: 6.5, fill: pal.ink900, anchor: "start", attrs: ' data-label="total"' });
      }
    });
    doc.open('data-axis="y"');
    doc.line(fr.x0, fr.top, fr.x0, axisY, pal.ink400, 0.21);
    doc.close();
    drawXAxis(doc, { y: axisY, x0: fr.x0, x1: fr.x1, dom, sx, style, pal, dec: decimalsFor(dom.step) });
    if (title) doc.text((fr.x0 + fr.x1) / 2, axisY + 6.6, title, { sizePt: 6.8, fill: pal.ink700, anchor: "middle" });
  } else {
    const axisY = H - foot - 5.0;
    const fr = hFrame({ categories: data.categories, labelPt: 6.4, widthMm: W, top: 0.8, base: axisY - 0.4, rightGutter: Math.max(totalW, 1.6), barRatio: 0.6 });
    const dom = niceDomain([0, total100 ? 100 : maxSum > 0 ? maxSum : 1], { zero: true });
    const sx = linearScale(dom.min, dom.max, fr.x0, fr.x1);
    rows.forEach((r, ci) => {
      const yc = fr.yc(ci);
      doc.text(fr.x0 - 1.2, mid(yc, 6.4), data.categories[ci], { sizePt: 6.4, fill: pal.ink400, anchor: "end" });
      let left = 0;
      r.plotted.forEach((v, si) => {
        if (v === null) return;
        const xa = sx(left);
        const xb = sx(left + v);
        doc.rect(xa, yc - fr.barH / 2, xb - xa, fr.barH, colors[si], {
          mark: { mark: "segment", series: order[si].name, index: ci },
          // Seri berwarna aksen = SATU subjek lint 26 (konvensi `data-accent="series"`, IP-25).
          attrs: colors[si] === pal.role.accent ? SERIES_ACCENT_ATTR : "",
        });
        if (code === "K-02" && segLabels) {
          const s = fmt(v, dec);
          if (xb - xa >= textWidthMm(s, 6.4, "data") + 1.2) {
            doc.text((xa + xb) / 2, mid(yc, 6.4), s, {
              face: "data",
              sizePt: 6.4,
              fill: inkOn(colors[si], pal),
              anchor: "middle",
              attrs: ' data-label="value"',
            });
          }
        }
        left += v;
      });
      if (showTotals) {
        doc.text(sx(left) + 1.0, mid(yc, 6.4), totals[ci], {
          face: "data",
          sizePt: 6.4,
          fill: pal.ink900,
          anchor: "start",
          attrs: ' data-label="total"',
        });
      }
    });
    if (code === "K-01") {
      doc.open('data-axis="y"');
      doc.line(fr.x0, fr.top, fr.x0, axisY, pal.role.textAxis, 0.25);
      doc.close();
    }
    drawXAxis(doc, { y: axisY, x0: fr.x0, x1: fr.x1, dom, sx, style, pal, dec: decimalsFor(dom.step) });
  }

  if (spec.note) noteLine(doc, spec.note, W, H - figureFootMm(spec) - 1.4, pal);
  if (spec.apparatus === "figure") figureApparatus(doc, spec, pal, H);
  return { svg: doc.toString(), widthMm: W, heightMm: H, report: rep.toJSON() };
}
