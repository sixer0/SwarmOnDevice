/**
 * engine/chart/family-h2 — H-08 arc diagram (S36). TANPA-ACUAN Python (research/06:101, kelas
 * CC: hanya lint + cek khusus "simpul segaris; jumlah busur = jumlah relasi", research/06:341).
 * Bentuk galeri: panel H-08 Gambar 8.2 (titik ink900 segaris di dasar, label di bawah, busur
 * setengah lingkaran ink400 di atas garis, satu busur beraksen signal).
 *
 * Geometri (deterministik): simpul berjarak sama pada satu garis dasar; setiap tautan = SATU
 * `<path>` busur elips `A rx ry` dari simpul kiri ke kanan (sweep 1 = di atas garis), rx =
 * separuh jarak simpul; bila busur terlebar tidak muat tinggi plot, SEMUA busur dipipihkan
 * dengan faktor ry/rx yang sama (bentuk relatif terjaga). Tebal busur menurut nilai tautan.
 *
 * Params (kunci pendek): `accentLink` [from, to] (busur beraksen); `order` ("data" bawaan |
 * "degree": derajat menurun, seri menurut urutan data); `labels` ("all" bawaan | "none").
 * Aksen simpul eksplisit lewat medan `accent` / `params.accentPoint` (id, label, indeks).
 */
import type { ChartCanvas, LintIssue, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { num, ptToMm, textWidthMm } from "../core/svg";
import { accentLinkIndex, assertAccentCount, closeDoc, degrees, h2Enum, linkWidthFor, matchNode, openDoc, prepareH2, requireGraph } from "./shared";
import { categoryAxisPlan, drawCategoryLabel } from "../core/labelfit";

const ORDER = ["data", "degree"] as const;
const LABELS = ["all", "none"] as const;

export function renderArc(spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate): SvgResult {
  const prep = prepareH2(spec, tpl, "H-08");
  const { pal, look } = prep;
  const g = requireGraph(spec, prep);
  const issues: LintIssue[] = [];
  const order = h2Enum(spec, tpl, "H-08", "order", ORDER, "data");
  const labels = h2Enum(spec, tpl, "H-08", "labels", LABELS, "all");
  const deg = degrees(g);

  const accLink = accentLinkIndex(spec, g);
  const accNodes = new Set<number>();
  for (const ref of prep.accentRefs) {
    const i = matchNode(g, ref);
    if (i !== undefined) accNodes.add(i);
  }
  assertAccentCount(prep, accNodes.size + (accLink === undefined ? 0 : 1), "simpul/busur");

  const seq = g.nodes.map((_, i) => i);
  if (order === "degree") seq.sort((a, b) => deg[b] - deg[a] || a - b);
  const slot = new Array<number>(g.nodes.length);
  seq.forEach((v, k) => {
    slot[v] = k;
  });

  const W = canvas.widthMm;
  const H = canvas.heightMm;
  const doc = openDoc(spec, prep, W, H);
  const n = g.nodes.length;
  const r = Math.min(1.0, Math.max(0.55, Math.min(W, H) * 0.02));
  const lh = ptToMm(look.labelPt);
  const half = (i: number): number => (labels === "all" ? textWidthMm(g.nodes[i].label, look.labelPt) / 2 : 0);
  const x0 = Math.max(r, half(seq[0])) + 1.0;
  const x1 = W - Math.max(r, half(seq[n - 1])) - 1.0;
  const step = n > 1 ? (x1 - x0) / (n - 1) : 0;
  // FIG-02a P1-4: label simpul tidak muat di jarak simpul -> bungkus/rotasi (hanya saat fit).
  const lp = labels === "all" && n > 1 ? categoryAxisPlan(seq.map((v) => g.nodes[v].label), step, { pt: look.labelPt }, { maxRotateBandMm: Math.max(10, (H - prep.footMm) * 0.4) }) : null;
  const base = H - prep.footMm - (labels === "all" ? lh + 2.0 : r + 1.0) - (lp?.extraBandMm ?? 0);
  const top = 1.2;
  const xOf = (i: number): number => (n > 1 ? x0 + slot[i] * step : W / 2);

  const spans = g.links.map((l) => Math.abs(xOf(l.to) - xOf(l.from)) / 2);
  const maxRx = Math.max(0, ...spans);
  const flat = maxRx > 0 ? Math.min(1, (base - top) / maxRx) : 1;
  const vals = g.links.map((l) => l.value);
  const lo = vals.length ? Math.min(...vals) : 0;
  const hi = vals.length ? Math.max(...vals) : 0;
  const drawOrder = g.links.map((_, j) => j).filter((j) => j !== accLink);
  if (accLink !== undefined) drawOrder.push(accLink);
  for (const j of drawOrder) {
    const l = g.links[j];
    const xa = Math.min(xOf(l.from), xOf(l.to));
    const xb = Math.max(xOf(l.from), xOf(l.to));
    const rx = (xb - xa) / 2;
    const accent = j === accLink;
    doc.path(`M${num(xa)} ${num(base)}A${num(rx)} ${num(rx * flat)} 0 0 1 ${num(xb)} ${num(base)}`, "none", {
      stroke: accent ? pal.role.accent : pal.role.contextMain,
      strokeWidthMm: accent ? look.accentMm : linkWidthFor(l.value, lo, hi, look.markMm),
      mark: { mark: "link", series: "link", index: j },
    });
  }
  g.nodes.forEach((nd, i) => {
    doc.circle(xOf(i), base, r, accNodes.has(i) ? pal.role.accent : pal.ink900, { mark: { mark: "node", series: nd.group ?? "simpul", index: i } });
    if (labels === "all" && lp) drawCategoryLabel(doc, lp, slot[i], xOf(i), base + r + 0.9 + lh * 0.75, { sizePt: look.labelPt, fill: pal.ink700, anchor: "middle" });
    else if (labels === "all") doc.text(xOf(i), base + r + 0.9 + lh * 0.75, nd.label, { sizePt: look.labelPt, fill: pal.ink700, anchor: "middle" });
  });
  if (flat < 1) issues.push({ checkId: "H-08-FLATTEN", status: "REPORT", detail: `busur dipipihkan ry/rx = ${flat.toFixed(2)} agar muat tinggi plot` });
  return closeDoc(doc, spec, prep, issues);
}
