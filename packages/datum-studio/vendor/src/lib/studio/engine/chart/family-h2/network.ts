/**
 * engine/chart/family-h2 — H-07 network (S36). Acuan: pustakachart `v79_network`
 * (PC:1105-1119: posisi simpul dari data, tautan ink400, satu tautan utama beraksen signal);
 * gaya galeri: panel H-07 Gambar 8.2 (titik simpul ink700, simpul penghubung beraksen dan
 * berlabel, tautan tebal ink400 / tipis ink200 menurut nilai).
 *
 * Posisi simpul (tanpa simulasi gaya, tanpa acak):
 * - `params.positions` = `{ <id>: [x, y] }` dalam 0..1, y ke ATAS (konvensi sumbu acuan PC
 *   `ax.set_ylim`; terverifikasi pada panel galeri: n01 y=0,95 tercetak di puncak). Bila ada
 *   koordinat di luar 0..1, kotak pembatas dinormalkan ulang ke 0..1 (REPORT H-07-POSITIONS);
 *   bila ada simpul tanpa posisi sah, seluruh graf memakai tata letak bawaan (REPORT).
 * - Tata letak bawaan "BFS bertingkat" (CHART_DATA_CONSTRAINTS H-07): komponen terhubung
 *   menurut urutan simpul; akar = derajat tertinggi (seri: indeks terkecil); tetangga dikunjungi
 *   menurut indeks; tingkat = kedalaman BFS (akar di atas); simpul setingkat berjarak sama
 *   menurut urutan kunjungan; komponen berjajar kiri ke kanan, lebar sebanding simpul
 *   terbanyak per tingkatnya.
 *
 * Parameter registri (kunci `chart.kind.H-07.*` atau alias pendek): `nodeSize`
 * ("degree" | "uniform"; degree: r = r0 x (0,8 + 0,6 x sqrt(derajat / derajat maks))),
 * `highlightBridges` (bawaan true: tanpa aksen eksplisit, simpul dengan betweenness
 * centrality tertinggi (Brandes, tak berbobot) diberi aksen; seri: indeks terkecil).
 * Kunci pendek lain: `accentLink` [from, to] (tautan beraksen, didahulukan dari sorotan
 * penghubung), `labels` ("all" | "accent" | "none"; bawaan datum "all", galeri "accent").
 * Aksen simpul eksplisit: medan `accent` / `params.accentPoint` (id, label, atau indeks) atau
 * `group: "aksen"` (konvensi S94). Aksen > `chart.accent.maxSubjects` -> DATUM-26.
 *
 * Peran warna gaya `datum` (S79 E3, PC:1108-1116): simpul isian ink100 bergaris ink400, simpul
 * inti (`group` "core"/"inti", padanan nama "Core*" acuan) isian ink900; semua tautan non-aksen
 * ink400 (peran contextMain). Gaya `gallery`: simpul ink700, tautan tebal ink400 / tipis ink200.
 */
import type { ChartCanvas, LintIssue, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { ptToMm, textWidthMm } from "../core/svg";
import {
  type GraphData,
  accentLinkIndex,
  assertAccentCount,
  closeDoc,
  degrees,
  finite,
  h2Bool,
  h2Enum,
  linkWidthFor,
  matchNode,
  openDoc,
  prepareH2,
  requireGraph,
} from "./shared";
import { fitActive } from "../core/fit";
import { placePointLabels } from "../core/labelfit";

const NODE_SIZE = ["degree", "uniform"] as const;
const LABELS = ["all", "accent", "none"] as const;
/** Garis tepi simpul gaya datum: 0,6 pt ink400 (PC:1114). */
const NODE_RIM_MM = ptToMm(0.6);
/** Simpul inti gaya datum (padanan `nm.startswith("Core")` PC:1112): `group` "core"/"inti". */
const isCore = (group: string | undefined): boolean => group !== undefined && /^(core|inti)$/i.test(group.trim());

type XY = [number, number];

/** Daftar tetangga unik, terurut indeks (tautan paralel digabung). */
function adjacency(g: GraphData): number[][] {
  const adj = g.nodes.map(() => new Set<number>());
  for (const l of g.links) {
    adj[l.from].add(l.to);
    adj[l.to].add(l.from);
  }
  return adj.map((s) => [...s].sort((a, b) => a - b));
}

/** Betweenness centrality Brandes (graf tak berarah, tak berbobot). */
export function betweenness(adj: readonly number[][]): number[] {
  const n = adj.length;
  const cb = new Array<number>(n).fill(0);
  for (let s = 0; s < n; s++) {
    const stack: number[] = [];
    const pred: number[][] = Array.from({ length: n }, () => []);
    const sigma = new Array<number>(n).fill(0);
    const dist = new Array<number>(n).fill(-1);
    sigma[s] = 1;
    dist[s] = 0;
    const queue = [s];
    for (let qi = 0; qi < queue.length; qi++) {
      const v = queue[qi];
      stack.push(v);
      for (const w of adj[v]) {
        if (dist[w] < 0) {
          dist[w] = dist[v] + 1;
          queue.push(w);
        }
        if (dist[w] === dist[v] + 1) {
          sigma[w] += sigma[v];
          pred[w].push(v);
        }
      }
    }
    const delta = new Array<number>(n).fill(0);
    while (stack.length) {
      const w = stack.pop() as number;
      for (const v of pred[w]) delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w]);
      if (w !== s) cb[w] += delta[w];
    }
  }
  return cb.map((x) => x / 2);
}

/** Tata letak BFS bertingkat deterministik, koordinat 0..1 (y ke atas). */
export function layeredLayout(adj: readonly number[][], deg: readonly number[]): XY[] {
  const n = adj.length;
  const comp = new Array<number>(n).fill(-1);
  const comps: number[][] = [];
  for (let i = 0; i < n; i++) {
    if (comp[i] >= 0) continue;
    const members = [i];
    comp[i] = comps.length;
    for (let k = 0; k < members.length; k++) {
      for (const w of adj[members[k]]) {
        if (comp[w] < 0) {
          comp[w] = comps.length;
          members.push(w);
        }
      }
    }
    comps.push(members.sort((a, b) => a - b));
  }
  const layers = comps.map((members) => {
    const root = members.reduce((best, v) => (deg[v] > deg[best] ? v : best), members[0]);
    const depth = new Map<number, number>([[root, 0]]);
    const order = [root];
    for (let k = 0; k < order.length; k++) {
      for (const w of adj[order[k]]) {
        if (!depth.has(w)) {
          depth.set(w, (depth.get(order[k]) as number) + 1);
          order.push(w);
        }
      }
    }
    const rows: number[][] = [];
    for (const v of order) (rows[depth.get(v) as number] ??= []).push(v);
    return rows;
  });
  const unitsOf = (rows: number[][]): number => Math.max(...rows.map((r) => r.length));
  const total = layers.reduce((s, rows) => s + unitsOf(rows), 0);
  const maxDepth = Math.max(...layers.map((rows) => rows.length));
  const pos: XY[] = new Array(n);
  let offset = 0;
  for (const rows of layers) {
    const units = unitsOf(rows);
    rows.forEach((row, d) => {
      row.forEach((v, i) => {
        const x = (offset + ((i + 0.5) * units) / row.length) / total;
        const y = maxDepth <= 1 ? 0.5 : 1 - d / (maxDepth - 1);
        pos[v] = [x, y];
      });
    });
    offset += units;
  }
  return pos;
}

/** Posisi dari `params.positions`; `undefined` bila tidak lengkap. */
function givenPositions(spec: StudioChartV1, g: GraphData, issues: LintIssue[]): XY[] | undefined {
  const p = spec.params?.positions;
  if (p === undefined || p === null) return undefined;
  const map = typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
  const pos: XY[] = [];
  const missing: string[] = [];
  for (const nd of g.nodes) {
    const v = map[nd.id];
    if (Array.isArray(v) && v.length === 2 && finite(v[0]) && finite(v[1])) pos.push([v[0], v[1]]);
    else missing.push(nd.id);
  }
  if (missing.length) {
    issues.push({ checkId: "H-07-POSITIONS", status: "REPORT", detail: `params.positions tidak lengkap/sah untuk ${missing.slice(0, 5).join(", ")}; tata letak BFS bertingkat dipakai` });
    return undefined;
  }
  const xs = pos.map((q) => q[0]);
  const ys = pos.map((q) => q[1]);
  const out = [...xs, ...ys].some((v) => v < 0 || v > 1);
  if (!out) return pos;
  issues.push({ checkId: "H-07-POSITIONS", status: "REPORT", detail: "params.positions di luar 0..1; dinormalkan ke kotak pembatas" });
  const nx = (v: number, lo: number, hi: number): number => (hi > lo ? (v - lo) / (hi - lo) : 0.5);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return pos.map(([x, y]) => [nx(x, x0, x1), nx(y, y0, y1)]);
}

export function renderNetwork(spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate): SvgResult {
  const prep = prepareH2(spec, tpl, "H-07");
  const { pal, look } = prep;
  const g = requireGraph(spec, prep);
  const issues: LintIssue[] = [];
  const adj = adjacency(g);
  const deg = degrees(g);
  const nodeSize = h2Enum(spec, tpl, "H-07", "nodeSize", NODE_SIZE, "degree");
  const bridges = h2Bool(spec, tpl, "H-07", "highlightBridges", true);
  const labelMode = h2Enum(spec, tpl, "H-07", "labels", LABELS, prep.style === "gallery" ? "accent" : "all");

  // Aksen: tautan (accentLink) didahulukan; lalu simpul eksplisit; lalu sorotan penghubung.
  const accLink = accentLinkIndex(spec, g);
  const explicit = new Set<number>();
  for (const ref of prep.accentRefs) {
    const i = matchNode(g, ref);
    if (i !== undefined) explicit.add(i);
  }
  g.nodes.forEach((nd, i) => {
    if (nd.group === "aksen") explicit.add(i);
  });
  let accNodes = [...explicit].sort((a, b) => a - b);
  if (!accNodes.length && accLink === undefined && bridges && g.nodes.length > 2) {
    const cb = betweenness(adj);
    const top = cb.reduce((best, v, i) => (v > cb[best] + 1e-12 ? i : best), 0);
    if (cb[top] > 0) accNodes = [top];
  }
  assertAccentCount(prep, accNodes.length + (accLink === undefined ? 0 : 1), "simpul/tautan");
  const isAcc = new Set(accNodes);

  const pos = givenPositions(spec, g, issues) ?? layeredLayout(adj, deg);

  const W = canvas.widthMm;
  const H = canvas.heightMm;
  const doc = openDoc(spec, prep, W, H);
  const maxDeg = Math.max(1, ...deg);
  const r0 = Math.min(1.6, Math.max(0.6, Math.min(W, H) * 0.022));
  const radius = (i: number): number => (nodeSize === "uniform" ? r0 : r0 * (0.8 + 0.6 * Math.sqrt(deg[i] / maxDeg)));
  const rMax = r0 * 1.4;
  const showLabel = (i: number): boolean => labelMode === "all" || (labelMode === "accent" && isAcc.has(i));
  const labelBelow = prep.style === "gallery";
  const datum = prep.style !== "gallery";
  const lh = ptToMm(look.labelPt);
  const anyBelow = labelBelow && g.nodes.some((_, i) => showLabel(i));
  const x0 = rMax + 1.0;
  const x1 = W - rMax - 1.0;
  const y0 = rMax + 1.0 + (!labelBelow && labelMode !== "none" ? lh * 0.4 : 0);
  const y1 = H - prep.footMm - rMax - 1.0 - (anyBelow ? lh + 1.2 : 0);
  const at = (i: number): XY => [x0 + pos[i][0] * (x1 - x0), y1 - pos[i][1] * (y1 - y0)];

  const vals = g.links.map((l) => l.value);
  const lo = vals.length ? Math.min(...vals) : 0;
  const hi = vals.length ? Math.max(...vals) : 0;
  g.links.forEach((l, j) => {
    const [ax, ay] = at(l.from);
    const [bx, by] = at(l.to);
    const accent = j === accLink;
    const heavy = !(hi > lo) || l.value > lo;
    const ctxColour = heavy || datum ? pal.role.contextMain : pal.role.contextBackground;
    doc.line(ax, ay, bx, by, accent ? pal.role.accent : ctxColour, accent ? look.accentMm : linkWidthFor(l.value, lo, hi, look.markMm), {
      mark: { mark: "link", series: "link", index: j },
      attrs: ` stroke-linecap="round"`,
    });
  });
  g.nodes.forEach((nd, i) => {
    const [cx, cy] = at(i);
    const mark = { mark: "node" as const, series: nd.group ?? "simpul", index: i };
    if (isAcc.has(i)) doc.circle(cx, cy, radius(i), pal.role.accent, { mark });
    else if (!datum) doc.circle(cx, cy, radius(i), pal.ink700, { mark });
    else if (isCore(nd.group)) doc.circle(cx, cy, radius(i), pal.ink900, { mark });
    else doc.circle(cx, cy, radius(i), pal.ink100, { mark, stroke: pal.ink400, strokeWidthMm: NODE_RIM_MM });
  });
  // FIG-02a P1-8: saat fit, label simpul ditempatkan tanpa tabrakan (8 posisi + penunjuk).
  if (fitActive()) {
    const idx = g.nodes.map((_, i) => i).filter((i) => showLabel(i));
    const dots = g.nodes.map((_, i) => {
      const [cx, cy] = at(i);
      const r = radius(i);
      return [cx - r, cy - r, cx + r, cy + r] as [number, number, number, number];
    });
    const placed = placePointLabels(
      idx.map((i) => ({ x: at(i)[0], y: at(i)[1], r: radius(i), text: g.nodes[i].label })),
      { pt: look.labelPt },
      [0.3, 0.3, W - 0.3, H - prep.footMm],
      dots,
    );
    placed.forEach((pl, k) => {
      if (!pl) return;
      if (pl.leader) doc.line(pl.leader.x1, pl.leader.y1, pl.leader.x2, pl.leader.y2, pal.ink400, 0.18, { attrs: ' data-leader="point"' });
      doc.text(pl.x, pl.y, g.nodes[idx[k]].label, { sizePt: look.labelPt, fill: pal.ink700, anchor: pl.anchor });
    });
    return closeDoc(doc, spec, prep, issues);
  }
  g.nodes.forEach((nd, i) => {
    if (!showLabel(i)) return;
    const [cx, cy] = at(i);
    const r = radius(i);
    if (labelBelow) {
      doc.text(cx, cy + r + 0.9 + lh * 0.75, nd.label, { sizePt: look.labelPt, fill: pal.ink900, anchor: "middle" });
      return;
    }
    const right = cx + r + 0.8 + textWidthMm(nd.label, look.labelPt) <= W - 0.5;
    doc.text(right ? cx + r + 0.8 : cx - r - 0.8, cy + lh * 0.35, nd.label, { sizePt: look.labelPt, fill: pal.ink700, anchor: right ? "start" : "end" });
  });
  return closeDoc(doc, spec, prep, issues);
}
