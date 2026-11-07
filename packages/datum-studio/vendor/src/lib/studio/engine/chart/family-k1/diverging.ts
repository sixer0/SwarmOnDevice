/**
 * engine/chart/family-k1 — K-03 diverging bar dan K-04 population pyramid (S37).
 *
 * K-03 (acuan PC v21_diverging_bar PC:445-456, data SETUJU/TIDAK_SETUJU bertanda):
 * sisi tiap seri ditentukan tandanya:
 * - semua nilai >= 0 di seluruh data: tepat 2 seri; seri 0 ke kanan, seri 1 ke kiri
 *   (besaran), sesuai konvensi spec galeri (setuju kanan, tidak setuju kiri);
 * - selain itu: seri ber-nilai <= 0 ke kiri, >= 0 ke kanan, ditumpuk keluar dari titik
 *   tengah menurut urutan data; seri bertanda campur hanya sah bila satu-satunya seri
 *   (batang neto, digambar menurut tandanya).
 * Parameter `meaningfulMidpoint` (default true): garis titik tengah tegas (ink900); false
 * -> REPORT (Tabel 8.3 "hindari: tidak ada titik tengah bermakna") dan garis hairline.
 *
 * K-04 (acuan PC v23_pyramid PC:470-481): tepat `groups` seri (registri 2..2); seri 0 ke
 * kiri, seri 1 ke kanan; domain simetris; label tick nilai mutlak; nilai negatif -> CH-01.
 *
 * Gaya datum: warna PC (K-03 VERD kanan / ALERT kiri; K-04 INK900 kiri / INK400 kanan),
 * grid x, spine ink400, baris KUNCI menggantikan glif "■" PC. Gaya gallery (Gambar 8.3):
 * nama sisi di atas tiap belahan, aksen + ramp tinta, garis tengah ink900, sumbu x bertick.
 * Petunjuk galeri (IP-41c): K-03 `sideLabels` dan K-04 `groups` berbentuk daftar 2 nama
 * = label sisi [kiri, kanan] (gallery: di atas belahan; datum: label baris KUNCI per sisi).
 */
import type { ChartCanvas, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { figureFootMm, apparatusMarker, figureApparatus, keyRow, keyRowExtraMm, noteLine } from "../core/apparatus";
import { defect, figureLabel } from "../core/guards";
import { chartPalette, kindKey, paramBool } from "../core/palette";
import { invalidParam, kindStrPair, kindValue } from "../core/read";
import { chartFloors } from "../core/prepare";
import { type NiceDomain, decimalsFor, linearScale, niceDomain } from "../core/scale";
import { SvgDoc, textWidthMm } from "../core/svg";
import {
  K1Report,
  type SeriesData,
  drawGridX,
  drawXAxis,
  footBandMm,
  galleryColors,
  hFrame,
  k1Key,
  mid,
  paramInt,
  requireSeries,
  rootAttrs,
  styleOf,
  SERIES_ACCENT_ATTR,
} from "./common";

type DivCode = "K-03" | "K-04";
type Side = "left" | "right" | "signed";

/** Sisi tiap seri (lihat kepala berkas). */
function sidesOf(spec: StudioChartV1, code: DivCode, data: SeriesData): Side[] {
  const fid = figureLabel(spec);
  const vals = (i: number): number[] => data.series[i].values.filter((v): v is number => v !== null);
  if (code === "K-04") return data.series.map((_, i) => (i === 0 ? "left" : "right"));
  const anyNegative = data.series.some((_, i) => vals(i).some((v) => v < 0));
  if (!anyNegative) {
    if (data.series.length !== 2) {
      throw new StudioEngineError(
        "SCHEMA_INVALID",
        `${fid} — K-03 dengan nilai tak bertanda membutuhkan tepat 2 seri (kanan, kiri); diterima ${data.series.length}. Beri tanda negatif pada seri sisi kiri`,
        { code, series: data.series.length },
      );
    }
    return ["right", "left"];
  }
  return data.series.map((s, i) => {
    const v = vals(i);
    const neg = v.some((x) => x < 0);
    const pos = v.some((x) => x > 0);
    if (neg && pos) {
      if (data.series.length === 1) return "signed";
      throw new StudioEngineError("SCHEMA_INVALID", `${fid} — K-03 seri "${s.name}" bertanda campur; satu seri satu sisi`, { code, series: i });
    }
    return neg ? "left" : "right";
  });
}

export function renderDiverging(code: DivCode, spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate): SvgResult {
  const rep = new K1Report();
  const style = styleOf(spec);
  const floors = chartFloors(spec, tpl);
  const pal = chartPalette(spec, tpl);
  const data = requireSeries(spec, code, floors.maxAccent, rep);
  const fid = figureLabel(spec);

  // Label sisi [kiri, kanan] (petunjuk galeri, IP-41c): K-03 `sideLabels`; K-04 `groups`
  // berbentuk daftar nama (bentuk alternatif ParamDef jumlah kelompok).
  let sideNames: [string, string] | undefined;
  const groupsRaw = code === "K-04" ? kindValue({ spec, tpl, code }, "groups") : undefined;
  if (Array.isArray(groupsRaw)) {
    if (groupsRaw.length !== 2 || !groupsRaw.every((g) => typeof g === "string" && g.length > 0)) {
      throw invalidParam(spec, kindKey("K-04", "groups"), groupsRaw, "bilangan 2 atau daftar 2 nama kelompok", code);
    }
    sideNames = [groupsRaw[0] as string, groupsRaw[1] as string];
  }
  if (code === "K-03") sideNames = kindStrPair({ spec, tpl, code }, "sideLabels");

  if (code === "K-04") {
    const groups = sideNames ? 2 : paramInt(spec, tpl, k1Key("K-04", "groups"), 2);
    if (data.series.length !== groups) {
      throw defect(k1Key("K-04", "groups"), `${fid} — piramida membutuhkan tepat ${groups} kelompok, diterima ${data.series.length}`, {
        code,
        series: data.series.length,
      });
    }
    rep.pass(k1Key("K-04", "groups"));
    for (const s of data.series) {
      const i = s.values.findIndex((v) => v !== null && v < 0);
      if (i >= 0) throw defect("CH-01", `${fid} — K-04 nilai negatif pada kelompok "${s.name}" kategori ${i}; besaran piramida selalu positif`, { code, index: i });
    }
  }
  const sides = sidesOf(spec, code, data);

  let midpointStrong = true;
  if (code === "K-03") {
    midpointStrong = paramBool(spec, tpl, k1Key("K-03", "meaningfulMidpoint"), true);
    rep.add(
      k1Key("K-03", "meaningfulMidpoint"),
      midpointStrong ? "PASS" : "REPORT",
      "titik tengah tidak dinyatakan bermakna; diverging bar tidak tepat (Tabel 8.3), pertimbangkan bar (P-01)",
    );
  }

  // Warna per seri.
  let colors: string[];
  if (style === "datum") {
    if (code === "K-04") colors = [pal.ink900, pal.ink400];
    else {
      const right = [pal.verd, pal.ink400, pal.ink200];
      const left = [pal.alert, pal.ink700, pal.ink100];
      let r = 0;
      let l = 0;
      colors = sides.map((s) => (s === "left" ? left[l++ % left.length] : right[r++ % right.length]));
    }
    if (data.series.some((s) => s.accent)) {
      rep.add("ACCENT_HINT", "REPORT", "gaya datum memakai warna acuan PC; aksen seri tidak diterapkan (pakai style gallery)");
    }
  } else {
    colors = galleryColors(
      data.series.map((s) => s.accent),
      pal,
      spec,
      code,
    );
  }

  // Segmen: [x awal, x akhir] dalam nilai data, ditumpuk keluar dari 0.
  const segs = data.categories.map((_, ci) => {
    let l = 0;
    let r = 0;
    return data.series.map((s, si) => {
      const v = s.values[ci];
      if (v === null) return null;
      const m = Math.abs(v);
      if (sides[si] === "signed") return v < 0 ? ([v, 0] as const) : ([0, v] as const);
      if (sides[si] === "left") {
        const seg = [-(l + m), -l] as const;
        l += m;
        return seg;
      }
      const seg = [r, r + m] as const;
      r += m;
      return seg;
    });
  });
  const ends = segs.flatMap((row) => row.flatMap((s) => (s ? [s[0], s[1]] : [])));
  let dom: NiceDomain;
  if (code === "K-04") {
    // Setengah domain dicerminkan: sasaran 2-3 interval per sisi (Gambar 8.3: 10 5 0 5 10).
    const nd = niceDomain([0, ...ends.map((v) => Math.abs(v))], { zero: true, target: 2 });
    const neg = nd.ticks.filter((t) => t > 0).map((t) => -t).reverse();
    dom = { min: -nd.max, max: nd.max, step: nd.step, ticks: [...neg, ...nd.ticks] };
  } else {
    dom = niceDomain([0, ...ends], { zero: true });
  }

  const W = canvas.widthMm;
  const H = canvas.heightMm;
  const doc = new SvgDoc(W, H, rootAttrs(code, style), chartFloors(spec, tpl).minFontPt);
  if ((spec.apparatus ?? "page") === "page") apparatusMarker(doc, spec);
  doc.paper(pal.paper);
  const foot = footBandMm(spec);
  const tdec = decimalsFor(dom.step);
  const absolute = code === "K-04";
  const mark = "bar" as const;

  const drawBars = (fr: ReturnType<typeof hFrame>, sx: (v: number) => number, labelPt: number): void => {
    segs.forEach((row, ci) => {
      const yc = fr.yc(ci);
      doc.text(fr.x0 - (style === "gallery" ? 1.2 : 1.6), mid(yc, labelPt), data.categories[ci], {
        sizePt: labelPt,
        fill: pal.ink400,
        anchor: "end",
      });
      row.forEach((s, si) => {
        if (!s) return;
        const xa = sx(s[0]);
        const xb = sx(s[1]);
        // Batang neto gaya datum: warna menurut tanda (PC: setuju VERD, tidak setuju ALERT).
        const fill = sides[si] === "signed" && style === "datum" ? (s[0] < 0 ? pal.alert : pal.verd) : colors[si];
        // Seri berwarna aksen = SATU subjek lint 26 (konvensi `data-accent="series"`, IP-25).
        const attrs = fill === pal.role.accent ? SERIES_ACCENT_ATTR : "";
        doc.rect(xa, yc - fr.barH / 2, xb - xa, fr.barH, fill, { mark: { mark, series: data.series[si].name, index: ci }, attrs });
      });
    });
  };

  if (style === "datum") {
    const keyBand = 6.0;
    const title = spec.unit ?? "";
    const axisY = H - foot - (title ? 7.8 : 4.6);
    const keyLabels = data.series.map((s, si) => (sideNames && data.series.length === 2 ? sideNames[sides[si] === "left" ? 0 : 1] : s.name));
    const frameAt = (top: number) =>
      hFrame({
        categories: data.categories,
        labelPt: 6.5,
        widthMm: W,
        top,
        base: axisY,
        rightGutter: 3,
        barRatio: code === "K-04" ? 0.6 : 0.55,
      });
    const fr0 = frameAt(keyBand + 0.8);
    // FIG-02a P1-7: KUNCI multi-baris (hanya saat fit) menurunkan tepi atas plot.
    const keyExtra = sides[0] !== "signed" ? keyRowExtraMm(fr0.x0, keyLabels) : 0;
    const fr = keyExtra > 0 ? frameAt(keyBand + keyExtra + 0.8) : fr0;
    const sx = linearScale(dom.min, dom.max, fr.x0, fr.x1);
    drawGridX(doc, dom.ticks, sx, fr.top, axisY, pal);
    if (sides[0] !== "signed") {
      keyRow(
        doc,
        fr.x0,
        4.0,
        data.series.map((s, si) => ({ label: sideNames && data.series.length === 2 ? sideNames[sides[si] === "left" ? 0 : 1] : s.name, color: colors[si] })),
        pal,
      );
    }
    drawBars(fr, sx, 6.5);
    doc.open('data-axis="y"');
    doc.line(fr.x0, fr.top, fr.x0, axisY, pal.ink400, 0.21);
    doc.close();
    if (code === "K-03") {
      doc.line(sx(0), fr.top, sx(0), axisY, midpointStrong ? pal.ink900 : pal.ink400, midpointStrong ? 0.28 : 0.18, { attrs: ' data-midpoint="0"' });
    }
    drawXAxis(doc, { y: axisY, x0: fr.x0, x1: fr.x1, dom, sx, style, pal, dec: tdec, absolute });
    if (title) doc.text((fr.x0 + fr.x1) / 2, axisY + 6.6, title, { sizePt: 6.8, fill: pal.ink700, anchor: "middle" });
  } else {
    const sideBand = sides[0] === "signed" ? 0.8 : 4.6;
    const axisY = H - foot - 5.0;
    const tickHalf = textWidthMm(`−${String(dom.max)}`, 6.0) / 2;
    const fr = hFrame({
      categories: data.categories,
      labelPt: 6.4,
      widthMm: W,
      top: sideBand,
      base: axisY - 0.4,
      rightGutter: Math.max(1.6, tickHalf),
      barRatio: 0.6,
    });
    const sx = linearScale(dom.min, dom.max, fr.x0, fr.x1);
    const x0v = sx(0);
    if (sides[0] !== "signed") {
      const leftNames = sideNames ? [sideNames[0]] : data.series.filter((_, i) => sides[i] === "left").map((s) => s.name);
      const rightNames = sideNames ? [sideNames[1]] : data.series.filter((_, i) => sides[i] === "right").map((s) => s.name);
      doc.open('data-side="labels"');
      if (leftNames.length) doc.text((fr.x0 + x0v) / 2, 2.9, leftNames.join(", "), { sizePt: 6.4, fill: pal.ink700, anchor: "middle" });
      if (rightNames.length) doc.text((x0v + fr.x1) / 2, 2.9, rightNames.join(", "), { sizePt: 6.4, fill: pal.ink700, anchor: "middle" });
      doc.close();
    }
    drawBars(fr, sx, 6.4);
    doc.line(x0v, fr.top - 0.6, x0v, axisY, midpointStrong ? pal.role.textAxis : pal.ink400, midpointStrong ? 0.3 : 0.18, {
      attrs: ' data-midpoint="0"',
    });
    drawXAxis(doc, { y: axisY, x0: fr.x0, x1: fr.x1, dom, sx, style, pal, dec: tdec, absolute });
  }

  if (spec.note) noteLine(doc, spec.note, W, H - figureFootMm(spec) - 1.4, pal);
  if (spec.apparatus === "figure") figureApparatus(doc, spec, pal, H);
  return { svg: doc.toString(), widthMm: W, heightMm: H, report: rep.toJSON() };
}
