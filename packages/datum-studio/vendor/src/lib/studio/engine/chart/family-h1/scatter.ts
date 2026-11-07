/**
 * engine/chart/family-h1 — H-01 scatter, H-02 bubble, H-04 connected scatter (S35).
 *
 * Gaya `datum` = port pustakachart (kelas paritas CB1): v66_scatter (titik ink900
 * s=16 pt^2, label titik bernama 6,2 pt offset (5, 4) pt), v67_bubble (luas = size x 28
 * pt^2, isi ink100 tepi ink900 0,8 pt), v68_conn_scatter (garis + penanda ink900 1,0 pt /
 * 3,2 pt, label awal verd dan akhir alert seperti anotasi acuan). Gaya `gallery` = panel
 * Gambar 8.2: titik dan garis ink400, gelembung ink200 bertepi ink400, garis tren putus-
 * putus beraksen, label ujung ink900.
 *
 * Penyimpangan dari acuan (aturan rumah mendahului): label titik bernama ink700 (acuan
 * signal) kecuali titik beraksen; kisi hanya bila P7-16 = whenComparing; gelembung digambar
 * dari yang terbesar agar yang kecil tidak tertutup (Tabel 8.2 "hindari gelembung saling
 * tumpuk"); gelembung dan titik tidak pernah keluar bingkai (jarak tepi = jari-jari).
 *
 * Parameter: H-01 `xIsPresumedCause` (false -> REPORT), `trendLine` (garis kuadrat
 * terkecil; beraksen bila tidak ada titik beraksen, selain itu ink700); H-02
 * `areaProportional` (false -> jari-jari sebanding nilai + REPORT), `directLabels`;
 * global P7-25 `chart.limits.denseScatterStrategy` untuk H-01 > 1000 titik
 * (transparency = isi 35 %; hexbin/heatmap = digambar sebagai hexbin + REPORT).
 * Petunjuk galeri (IP-41c): H-01 `trendColour` (tokenRef warna garis tren), H-04
 * `labelEnds` ([awal, akhir]: hanya kedua ujung berlabel teks ini).
 */
import type { ChartCanvas, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { figureFootMm, apparatusMarker, figureApparatus, noteLine } from "../core/apparatus";
import { kindKey, paramEnum, resolveChartColor } from "../core/palette";
import { kindStrPair } from "../core/read";
import { MM_PER_PT, SvgDoc, num, ptToMm, textWidthMm } from "../core/svg";
import { type XyLayout, drawAxes, drawGrid, layoutXy, mplDomain } from "./axes";
import { type H1Prep, type XyPoint, finishH1, kindBool, requireXy, seriesOf } from "./common";
import { renderHexbin } from "./hexbin";
import { fitActive } from "../core/fit";
import { type Segment, placePointLabels } from "../core/labelfit";


/** Ambang "ribuan titik bertumpuk" (Tabel 8.2 H-01). */
export const DENSE_SCATTER_N = 1000;
const LABEL_PT = 6.2;

function frameDoc(spec: StudioChartV1, W: number, H: number, prep: H1Prep): SvgDoc {
  const doc = new SvgDoc(W, H, `data-chart="${prep.code}" data-style="${prep.style}"`, prep.minFontPt);
  if ((spec.apparatus ?? "page") === "page") apparatusMarker(doc, spec);
  doc.paper(prep.pal.paper);
  return doc;
}

function closeDoc(doc: SvgDoc, spec: StudioChartV1, prep: H1Prep, W: number, H: number): SvgResult {
  if (spec.note) noteLine(doc, spec.note, W, H - figureFootMm(spec) - 1.4, prep.pal);
  if (spec.apparatus === "figure") figureApparatus(doc, spec, prep.pal, H);
  return finishH1({ svg: doc.toString(), widthMm: W, heightMm: H }, prep);
}

function gridOn(spec: StudioChartV1, tpl: ResolvedTemplate): boolean {
  return paramEnum(spec, tpl, "chart.gridlines", ["none", "whenComparing"] as const, "none") === "whenComparing";
}

/** Label teks di samping titik; dibalik ke kiri bila melewati tepi kanan kanvas. */
function pointLabel(doc: SvgDoc, x: number, y: number, dx: number, dy: number, s: string, fill: string, W: number): void {
  const w = textWidthMm(s, LABEL_PT);
  const right = x + dx + w <= W - 0.3;
  doc.text(right ? x + dx : x - dx, y + dy, s, { sizePt: LABEL_PT, fill, anchor: right ? "start" : "end", attrs: ' data-label="point"' });
}

/**
 * FIG-02a P1-8: label titik tanpa tabrakan (hanya saat fit). Mengembalikan `false` di luar
 * fit agar pemanggil memakai `pointLabel` lama (byte-identik).
 */
function fitPointLabels(
  doc: SvgDoc,
  L: XyLayout,
  items: ReadonlyArray<{ x: number; y: number; r: number; label: string; fill: string }>,
  dots: ReadonlyArray<{ x: number; y: number; r: number }>,
  W: number,
  ink: string,
): boolean {
  if (!fitActive()) return false;
  const font = { pt: LABEL_PT };
  const f = L.frame;
  const bounds: [number, number, number, number] = [Math.max(0.3, f.x0), Math.max(0.3, f.y0 - 2), Math.min(W - 0.3, f.x1 + 1), f.y1];
  const obstacles = dots.map((d) => [d.x - d.r, d.y - d.r, d.x + d.r, d.y + d.r] as [number, number, number, number]);
  const placed = placePointLabels(
    items.map((it) => ({ x: it.x, y: it.y, r: it.r, text: it.label })),
    font,
    bounds,
    obstacles,
  );
  placed.forEach((pl, i) => {
    if (!pl) return;
    if (pl.leader) doc.line(pl.leader.x1, pl.leader.y1, pl.leader.x2, pl.leader.y2, ink, 0.18, { attrs: ' data-leader="point"' });
    doc.text(pl.x, pl.y, items[i].label, { sizePt: LABEL_PT, fill: items[i].fill, anchor: pl.anchor, attrs: ' data-label="point"' });
  });
  return true;
}

// ── H-01 scatter ──────────────────────────────────────────────────────────

export function renderScatter(spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate, prep: H1Prep): SvgResult {
  const W = canvas.widthMm;
  const H = canvas.heightMm;
  const { pal, style } = prep;
  const pts = requireXy(spec, prep);
  let opacity = "";
  if (pts.length > DENSE_SCATTER_N) {
    const strat = paramEnum(spec, tpl, "chart.limits.denseScatterStrategy", ["transparency", "hexbin", "heatmap"] as const, "transparency");
    if (strat !== "transparency") {
      prep.issues.push({
        checkId: "chart.limits.denseScatterStrategy",
        status: "REPORT",
        detail: `${pts.length} titik > ${DENSE_SCATTER_N}: scatter digambar sebagai hexbin (strategi ${strat})`,
      });
      return renderHexbin(spec, canvas, tpl, prep);
    }
    opacity = ' fill-opacity="0.35"';
  }
  if (!kindBool(spec, tpl, "H-01", "xIsPresumedCause", true)) {
    prep.issues.push({
      checkId: kindKey("H-01", "xIsPresumedCause"),
      status: "REPORT",
      detail: "sumbu X bukan dugaan sebab; pembaca membaca X sebagai sebab (Tabel 8.2)",
    });
  }
  const r = style === "gallery" ? 0.6 : (Math.sqrt(16) / 2) * MM_PER_PT;
  const rAcc = r * 1.3;
  const L = layoutXy(spec, W, H, prep, mplDomain(pts.map((p) => p.x)), mplDomain(pts.map((p) => p.y)), { insetMm: rAcc });
  const doc = frameDoc(spec, W, H, prep);
  if (gridOn(spec, tpl)) drawGrid(doc, L, pal);
  drawAxes(doc, L, pal, spec);

  if (kindBool(spec, tpl, "H-01", "trendLine", false)) drawTrend(doc, L, pts, prep, spec, tpl);

  const base = style === "gallery" ? pal.ink400 : pal.ink900;
  for (const p of pts.filter((q) => !q.accent)) {
    doc.circle(L.sx(p.x), L.sy(p.y), r, base, { mark: { mark: "point", series: seriesOf(p), index: p.index }, attrs: opacity });
  }
  for (const p of pts.filter((q) => q.accent)) {
    doc.circle(L.sx(p.x), L.sy(p.y), rAcc, pal.role.accent, { mark: { mark: "point", series: seriesOf(p), index: p.index } });
  }
  const labelled = pts.filter((p) => p.label);
  const allDots = pts.map((p) => ({ x: L.sx(p.x), y: L.sy(p.y), r: p.accent ? rAcc : r }));
  const fitItems = labelled.map((p) => ({ x: L.sx(p.x), y: L.sy(p.y), r: p.accent ? rAcc : r, label: p.label as string, fill: p.accent ? pal.role.accent : pal.ink700 }));
  if (!fitPointLabels(doc, L, fitItems, allDots, W, pal.ink400)) {
    for (const p of pts) {
      if (p.label) pointLabel(doc, L.sx(p.x), L.sy(p.y), ptToMm(5), -ptToMm(4), p.label, p.accent ? pal.role.accent : pal.ink700, W);
    }
  }
  return closeDoc(doc, spec, prep, W, H);
}

function drawTrend(doc: SvgDoc, L: XyLayout, pts: readonly XyPoint[], prep: H1Prep, spec: StudioChartV1, tpl: ResolvedTemplate): void {
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n;
  const my = pts.reduce((s, p) => s + p.y, 0) / n;
  const sxx = pts.reduce((s, p) => s + (p.x - mx) ** 2, 0);
  if (n < 2 || !(sxx > 0)) {
    prep.issues.push({ checkId: kindKey("H-01", "trendLine"), status: "REPORT", detail: "garis tren dilewati: x tanpa sebaran" });
    return;
  }
  const b = pts.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / sxx;
  const a = my - b * mx;
  const x0 = Math.min(...pts.map((p) => p.x));
  const x1 = Math.max(...pts.map((p) => p.x));
  const color = resolveChartColor(spec, tpl, kindKey("H-01", "trendColour"), pts.some((p) => p.accent) ? prep.pal.ink700 : prep.pal.role.accent);
  doc.line(L.sx(x0), L.sy(a + b * x0), L.sx(x1), L.sy(a + b * x1), color, 0.35, {
    dashMm: [1.2, 0.8],
    mark: { mark: "line", series: "tren", index: 0 },
  });
}

// ── H-02 bubble ───────────────────────────────────────────────────────────

export function renderBubble(spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate, prep: H1Prep): SvgResult {
  const W = canvas.widthMm;
  const H = canvas.heightMm;
  const { pal, style } = prep;
  const pts = requireXy(spec, prep);
  const area = kindBool(spec, tpl, "H-02", "areaProportional", true);
  if (!area) {
    prep.issues.push({
      checkId: kindKey("H-02", "areaProportional"),
      status: "REPORT",
      detail: "jari-jari sebanding nilai: luas gelembung melebih-lebihkan selisih",
    });
  }
  const sizes = pts.map((p) => p.size ?? 1);
  const smax = Math.max(...sizes);
  const avail = H - prep.footBand;
  // Jari-jari: datum = acuan (luas size x 28 pt^2) dibatasi; gallery = relatif terhadap tinggi panel.
  const pcR = (s: number): number => (Math.sqrt(s * 28) / 2) * MM_PER_PT;
  const rMax = style === "gallery" ? Math.min(6, Math.max(1.2, avail * 0.052)) : Math.min(pcR(smax), 6, avail * 0.12);
  const radius = (s: number): number => {
    if (!(smax > 0)) return 0.5;
    const f = area ? Math.sqrt(s / smax) : s / smax;
    return Math.max(0.35, rMax * f);
  };
  const L = layoutXy(spec, W, H, prep, mplDomain(pts.map((p) => p.x)), mplDomain(pts.map((p) => p.y)), { insetMm: rMax });
  const doc = frameDoc(spec, W, H, prep);
  if (gridOn(spec, tpl)) drawGrid(doc, L, pal);
  drawAxes(doc, L, pal, spec);

  const fill = style === "gallery" ? pal.ink200 : pal.ink100;
  const edge = style === "gallery" ? pal.ink400 : pal.ink900;
  const edgeW = style === "gallery" ? 0.2 : 0.8 * MM_PER_PT;
  const order = pts.map((p, i) => ({ p, s: sizes[i] })).sort((a, b) => b.s - a.s || a.p.index - b.p.index);
  for (const { p, s } of order) {
    const acc = p.accent;
    doc.circle(L.sx(p.x), L.sy(p.y), radius(s), acc ? pal.role.accent : fill, {
      mark: { mark: "point", series: seriesOf(p), index: p.index },
      stroke: acc ? (style === "gallery" ? pal.role.accent : edge) : edge,
      strokeWidthMm: edgeW,
      attrs: ` data-size="${num(s)}"`,
    });
  }
  if (kindBool(spec, tpl, "H-02", "directLabels", true)) {
    const allDots = pts.map((p, i) => ({ x: L.sx(p.x), y: L.sy(p.y), r: radius(sizes[i]) }));
    const fitItems = pts.flatMap((p, i) => (p.label ? [{ x: L.sx(p.x), y: L.sy(p.y), r: radius(sizes[i]), label: p.label, fill: p.accent ? pal.role.accent : pal.ink700 }] : []));
    if (!fitPointLabels(doc, L, fitItems, allDots, W, pal.ink400)) {
      pts.forEach((p, i) => {
        if (!p.label) return;
        const r = radius(sizes[i]);
        pointLabel(doc, L.sx(p.x), L.sy(p.y), r + 0.8, ptToMm(LABEL_PT) * 0.35, p.label, p.accent ? pal.role.accent : pal.ink700, W);
      });
    }
  }
  return closeDoc(doc, spec, prep, W, H);
}

// ── H-04 connected scatter ────────────────────────────────────────────────

export function renderConnected(spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate, prep: H1Prep): SvgResult {
  const W = canvas.widthMm;
  const H = canvas.heightMm;
  const { pal, style } = prep;
  const pts = requireXy(spec, prep, 2);
  const r = style === "gallery" ? 0.55 : (3.2 / 2) * MM_PER_PT;
  const rAcc = r * 1.35;
  const L = layoutXy(spec, W, H, prep, mplDomain(pts.map((p) => p.x)), mplDomain(pts.map((p) => p.y)), { insetMm: rAcc });
  const doc = frameDoc(spec, W, H, prep);
  if (gridOn(spec, tpl)) drawGrid(doc, L, pal);
  drawAxes(doc, L, pal, spec);

  const ink = style === "gallery" ? pal.ink400 : pal.ink900;
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${num(L.sx(p.x))} ${num(L.sy(p.y))}`).join(" ");
  doc.path(d, "none", {
    stroke: ink,
    strokeWidthMm: style === "gallery" ? 0.35 : 1.0 * MM_PER_PT,
    mark: { mark: "line", series: "jalur", index: 0 },
    attrs: ' stroke-linejoin="round"',
  });
  for (const p of pts) {
    doc.circle(L.sx(p.x), L.sy(p.y), p.accent ? rAcc : r, p.accent ? pal.role.accent : ink, {
      mark: { mark: "point", series: "jalur", index: p.index },
    });
  }
  const last = pts.length - 1;
  const ends = kindStrPair({ spec, tpl, code: "H-04" }, "labelEnds");
  // FIG-02c (hanya saat fit): label ujung/aksen menghindari segmen jalur, titik, dan label lain;
  // offset anotasi acuan dicoba lebih dulu. Di luar fit jalur lama di bawah dipakai apa adanya.
  if (fitActive()) {
    const items: Array<{ x: number; y: number; r: number; text: string; fill: string; prefer: { x: number; y: number; anchor: "start" | "middle" | "end" } }> = [];
    pts.forEach((q, i) => {
      const p = ends ? (i === 0 ? { ...q, label: ends[0] } : i === last ? { ...q, label: ends[1] } : { ...q, label: undefined }) : q;
      if (!p.label || !(i === 0 || i === last || p.accent)) return;
      const x = L.sx(p.x);
      const y = L.sy(p.y);
      const rr = p.accent ? rAcc : r;
      if (style === "datum") {
        const color = p.accent ? pal.role.accent : i === 0 ? pal.role.improving : pal.role.limitExceeded;
        const dy = i === 0 && !p.accent ? -ptToMm(6) : i === last ? ptToMm(10) : -ptToMm(4);
        const dx = i === 0 && !p.accent ? -ptToMm(2) : i === last ? -ptToMm(6) : ptToMm(5);
        items.push({ x, y, r: rr, text: p.label, fill: color, prefer: { x: x + dx, y: y + dy, anchor: "start" } });
      } else {
        const dx = rr + 0.6;
        const right = x + dx + textWidthMm(p.label, LABEL_PT) <= W - 0.3;
        items.push({ x, y, r: rr, text: p.label, fill: pal.ink900, prefer: { x: right ? x + dx : x - dx, y: y - 1.2, anchor: right ? "start" : "end" } });
      }
    });
    const f = L.frame;
    const segs: Segment[] = [];
    for (let i = 0; i + 1 < pts.length; i++) segs.push([L.sx(pts[i].x), L.sy(pts[i].y), L.sx(pts[i + 1].x), L.sy(pts[i + 1].y)]);
    const dots = pts.map((p) => {
      const rr = p.accent ? rAcc : r;
      return [L.sx(p.x) - rr, L.sy(p.y) - rr, L.sx(p.x) + rr, L.sy(p.y) + rr] as [number, number, number, number];
    });
    const placed = placePointLabels(items, { pt: LABEL_PT }, [0.3, Math.max(0.3, f.y0 - 2), W - 0.3, f.y1], dots, segs);
    placed.forEach((pl, k) => {
      if (!pl) return;
      if (pl.leader) doc.line(pl.leader.x1, pl.leader.y1, pl.leader.x2, pl.leader.y2, ink, 0.18, { attrs: ' data-leader="point"' });
      doc.text(pl.x, pl.y, items[k].text, { sizePt: LABEL_PT, fill: items[k].fill, anchor: pl.anchor, attrs: ' data-label="point"' });
    });
    return closeDoc(doc, spec, prep, W, H);
  }
  pts.forEach((q, i) => {
    // `labelEnds`: hanya titik awal dan akhir, dengan teks petunjuk.
    const p = ends ? (i === 0 ? { ...q, label: ends[0] } : i === last ? { ...q, label: ends[1] } : { ...q, label: undefined }) : q;
    if (!p.label || !(i === 0 || i === last || p.accent)) return;
    const x = L.sx(p.x);
    const y = L.sy(p.y);
    if (style === "datum") {
      // Offset anotasi acuan: awal (-2, 6) pt di atas, akhir (-6, -10) pt di bawah.
      const color = p.accent ? pal.role.accent : i === 0 ? pal.role.improving : pal.role.limitExceeded;
      const dy = i === 0 && !p.accent ? -ptToMm(6) : i === last ? ptToMm(10) : -ptToMm(4);
      const dx = i === 0 && !p.accent ? -ptToMm(2) : i === last ? -ptToMm(6) : ptToMm(5);
      doc.text(x + dx, y + dy, p.label, { sizePt: LABEL_PT, fill: color, attrs: ' data-label="point"' });
    } else {
      pointLabel(doc, x, y, (p.accent ? rAcc : r) + 0.6, -1.2, p.label, pal.ink900, W);
    }
  });
  return closeDoc(doc, spec, prep, W, H);
}
