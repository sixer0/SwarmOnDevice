/**
 * engine/chart/family-g — G-04 flowchart ISO 5807 (S43). Acuan: pustakachart `v81_flow`
 * (PC:1123-1152, PARSIAL); paritas utama lewat keluarga diagram `flow` Garis A.
 *
 * `data: { shape: "steps", spec: StudioDiagramV1 }`. Alur:
 * 1. spec diagram divalidasi `validateSpec` mesin diagram (S26, release=false); FAIL
 *    pertama = `DiagramDefect` (BY_CONSTRUCTION_FAILED, sama dengan build S30); label
 *    konektor boleh kosong kecuali keluaran keputusan (ISO 5807, deviasi DATUM-24);
 *    keluarga selain `flow` dipaksa `flow` + REPORT;
 * 2. tata letak `layoutFlow` (S27, `per_row` dihormati) lewat `placeDiagram` (kunci kisi
 *    DATUM-37) dan rute ortogonal `routePlaced` (S30) pada lembar `width_mm` spec;
 *    berkas build/place dan build/route diimpor langsung (bukan indeks build) agar modul
 *    keluarga tidak menarik dispatcher D01 (01_specs.md §8.3);
 * 3. geometri dipetakan ke kanvas chart (skala x/y terpisah, rasio dibatasi 1:2,5 dan
 *    1,5:1, berpusat) dan digambar ulang dengan SvgDoc chart: huruf tetap pt FISIK
 *    (lantai P7-36), bukan ikut terskala, sehingga panel galeri kecil tetap terbaca.
 *
 * Parameter registri: `maxSteps` (simpul > maks -> BY_CONSTRUCTION_FAILED, seperti
 * W-02 maxPeriods), `standardShapes` ("ISO 5807": bentuk di luar terminator, proses,
 * keputusan, data, persiapan, penyambung, data tersimpan dilaporkan), dan
 * `singleReadingDirection` (konektor yang mundur terhadap urutan baca baris-dulu
 * dilaporkan). Aksen: `class.accent` simpul, konektor `kind: "accent"`, atau
 * `accent.point`/`accent.group` = id/label simpul; total subjek <= maks (DATUM-26).
 */
import type {
  ChartCanvas,
  DiagramFamily,
  DiagramShape,
  LayoutFn,
  ResolvedTemplate,
  RoutedEdge,
  StudioChartV1,
  StudioDiagramV1,
  SvgResult,
} from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { DASH_PATTERNS, DiagramDefect, EDGE_KINDS, Sheet, type SheetNode, nodeStrokeToken, resolveDiagramGrid, validateSpec } from "../../diagram/core";
import { placeDiagram } from "../../diagram/build/place";
import { routePlaced } from "../../diagram/build/route";
import { layoutFlow } from "../../diagram/layout-a";
import { defect, figureGrid } from "../core/guards";
import { kindKey } from "../core/palette";
import { escAttr, num, ptToMm, textWidthMm } from "../core/svg";
import { fitActive } from "../core/fit";
import { wrap } from "../core/textfit";
import { type GCtx, TYPE_PT, accentHint, assertAccentCount, beginChart, endChart, hintMiss, kindBool, kindInt, kindStr, ran, report, tokenHex } from "./common";

/** Bentuk diagram yang termasuk simbol ISO 5807. */
const ISO_5807_SHAPES: readonly DiagramShape[] = ["box", "stadium", "diamond", "parallelogram", "hexagon", "circle", "cylinder"];

/**
 * Hanya keluarga `flow` yang dipakai (spec dipaksa `flow` sebelum penempatan); peta
 * lengkap tidak diperlukan dan dispatcher D01 sengaja tidak dibaca.
 */
const FLOW_ONLY = { flow: layoutFlow } as unknown as Readonly<Record<DiagramFamily, LayoutFn>>;

type Pt = { x: number; y: number };

export function renderFlowchart(spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate): SvgResult {
  const ctx = beginChart("G-04", spec, canvas, tpl, 'data-diagram-family="flow"');
  const { pal, style } = ctx;
  const d = spec.data;
  if (!d) throw new StudioEngineError("SCHEMA_INVALID", `${ctx.fid} — G-04: data wajib`, { code: "G-04" });
  if (d.shape !== "steps" || !d.spec || typeof d.spec !== "object") {
    throw new StudioEngineError("SCHEMA_INVALID", `${ctx.fid} — G-04 membutuhkan data "steps" berisi spec diagram, diterima "${d.shape}"`, {
      code: "G-04",
      shape: d.shape,
    });
  }
  let s: StudioDiagramV1 = d.spec;
  if (s.family !== "flow") {
    report(ctx, "G-04.family", `keluarga diagram "${String(s.family)}" diganti "flow" (flowchart memakai tata letak flow)`);
    s = { ...s, family: "flow" };
  }
  if (!Array.isArray(s.nodes) || s.nodes.length === 0) throw defect("DC-G1", `${ctx.fid} — flowchart tanpa langkah`, { code: "G-04" });

  const maxSteps = kindInt(ctx, "maxSteps", 10);
  ran(ctx, kindKey("G-04", "maxSteps"));
  if (s.nodes.length > maxSteps) {
    throw defect(kindKey("G-04", "maxSteps"), `${ctx.fid} — ${s.nodes.length} langkah > ${maxSteps}; pecah flowchart atau pakai diagram (Bab 9)`, {
      code: "G-04",
      steps: s.nodes.length,
    });
  }

  // Garis A (DATUM-24) mewajibkan label pada setiap konektor; flowchart ISO 5807 hanya
  // mewajibkan label pada keluaran keputusan (P3-diamond-exits tetap ditegakkan).
  // Label kosong konektor berurutan diisi penanda hanya untuk validasi, tidak digambar.
  const decisions = new Set(s.nodes.filter((n) => n.shape === "diamond").map((n) => n.id));
  const forCheck: StudioDiagramV1 = {
    ...s,
    edges: (s.edges ?? []).map((e) => (e && e.label === "" && !decisions.has(e.from) ? { ...e, label: "-" } : e)),
  };
  // D-245/D-252: lembar diagram selebar chart (lebar figur turunan kertas), grid dari templat.
  const grid = figureGrid(tpl.params);
  const vIssues = validateSpec(forCheck, { release: false, grid });
  const fail = vIssues.find((i) => i.status === "FAIL");
  if (fail) throw new DiagramDefect(fail.detail ?? fail.checkId, { checkId: fail.checkId, pointer: fail.pointer });
  ran(ctx, "G-04.diagramSpec");

  const sheet = new Sheet(Number(s.width_mm), undefined, resolveDiagramGrid(grid).latticeXMm);
  placeDiagram(s, sheet, FLOW_ONLY);
  const routes = routePlaced(s, sheet);
  const nodes = [...sheet.nodes.values()];

  // Parameter pemeriksa (REPORT, tidak menolak).
  const standard = kindStr(ctx, "standardShapes") ?? "ISO 5807";
  const shapesKey = kindKey("G-04", "standardShapes");
  if (standard === "ISO 5807") {
    ran(ctx, shapesKey);
    const bad = nodes.filter((n) => !ISO_5807_SHAPES.includes(n.spec.shape ?? "box"));
    if (bad.length) report(ctx, shapesKey, `bentuk di luar ISO 5807: ${bad.map((n) => `${n.id} (${n.spec.shape})`).join(", ")}`);
  } else {
    report(ctx, shapesKey, `standar bentuk "${standard}" tidak dikenal mesin; cek bentuk dilewati`);
  }
  if (kindBool(ctx, "singleReadingDirection", true)) {
    const key = kindKey("G-04", "singleReadingDirection");
    ran(ctx, key);
    const rank = new Map(
      nodes
        .map((n, i) => ({ n, i }))
        .sort((a, b) => a.n.y - b.n.y || a.n.x - b.n.x || a.i - b.i)
        .map((x, r) => [x.n.id, r]),
    );
    const back = routes.filter((e) => (rank.get(e.to) ?? 0) < (rank.get(e.from) ?? 0));
    if (back.length) report(ctx, key, `konektor melawan arah baca: ${back.map((e) => `${e.from}->${e.to}`).join(", ")}`);
  }
  if (nodes.some((n) => n.spec.sub || n.spec.mark || n.spec.tag)) {
    report(ctx, "G-04.nodeExtras", "sub/mark/tag simpul tidak digambar pada flowchart chart (pakai blok diagram untuk notasi lengkap)");
  }

  // Aksen.
  const accentIds = new Set(nodes.filter((n) => n.spec.class?.accent).map((n) => n.id));
  const hint = accentHint(spec);
  if (hint) {
    const t = hint.point ?? hint.group;
    const hit = typeof t === "number" ? nodes[t] : nodes.find((n) => n.id === t) ?? nodes.find((n) => n.spec.label === t);
    if (hit) accentIds.add(hit.id);
    else hintMiss(ctx, JSON.stringify(t));
  }
  const accentEdges = routes.flatMap((e, i) => (e.kind === "accent" ? [`konektor ${i}`] : []));
  assertAccentCount(ctx, [...accentIds, ...accentEdges]);

  // Pemetaan lembar diagram -> kanvas chart.
  const xs = [...nodes.flatMap((n) => [n.x, n.x + n.w]), ...routes.flatMap((e) => e.points.map((p) => p[0]))];
  const ys = [...nodes.flatMap((n) => [n.y, n.y + n.h]), ...routes.flatMap((e) => e.points.map((p) => p[1]))];
  const bx = Math.min(...xs);
  const by = Math.min(...ys);
  const bw = Math.max(Math.max(...xs) - bx, 1e-6);
  const bh = Math.max(Math.max(...ys) - by, 1e-6);
  const area = { x: 1.0, y: 1.6, w: ctx.W - 2.0, h: ctx.bottom - 3.2 };
  let sx = area.w / bw;
  let sy = area.h / bh;
  if (sx > sy * 2.5) sx = sy * 2.5;
  if (sy > sx * 1.5) sy = sx * 1.5;
  const ox = area.x + (area.w - bw * sx) / 2;
  const oy = area.y + (area.h - bh * sy) / 2;
  const map = (x: number, y: number): Pt => ({ x: ox + (x - bx) * sx, y: oy + (y - by) * sy });

  const T = TYPE_PT[style];
  const edgeW = style === "gallery" ? 0.3 : 0.35;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  routes.forEach((e, i) => {
    const pts = simplify(e.points);
    clipToDiamond(pts, byId.get(e.from), 0);
    clipToDiamond(pts, byId.get(e.to), pts.length - 1);
    drawEdge(ctx, { ...e, points: pts }, i, map, edgeW, T.edge);
  });

  const nodeW = style === "gallery" ? 0.45 : 0.35;
  let overflow = 0;
  nodes.forEach((n, i) => {
    const p = map(n.x, n.y);
    const box = { x: p.x, y: p.y, w: n.w * sx, h: n.h * sy };
    let token = accentIds.has(n.id) ? "signal" : nodeStrokeToken(n);
    if (style === "gallery" && token === "ink700") token = "ink900";
    if (!drawNode(ctx, n, box, i, tokenHex(pal, token), nodeW, T.node)) overflow++;
  });
  if (overflow) report(ctx, "G-04.labelFit", `${overflow} label simpul melebihi bentuknya pada lantai ${ctx.minFontPt} pt`);
  return endChart(ctx);
}

// ── Simpul ────────────────────────────────────────────────────────────────

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Lebar/tinggi isi teks yang aman per bentuk (fraksi kotak). */
function textRoom(shape: DiagramShape, b: Box): { w: number; h: number } {
  switch (shape) {
    case "diamond":
      return { w: b.w * 0.62, h: b.h * 0.6 };
    case "stadium":
      return { w: Math.max(b.w - b.h * 0.5, b.w * 0.6), h: b.h * 0.86 };
    case "parallelogram":
      return { w: b.w * 0.76, h: b.h * 0.86 };
    case "hexagon":
      return { w: b.w * 0.64, h: b.h * 0.86 };
    case "circle":
      return { w: Math.min(b.w, b.h) * 0.72, h: Math.min(b.w, b.h) * 0.72 };
    case "cylinder":
      return { w: b.w * 0.88, h: b.h * 0.62 };
    default:
      return { w: b.w * 0.88, h: b.h * 0.86 };
  }
}

/** Label satu atau dua baris pada ukuran terbesar yang muat (>= lantai). */
export function fitLines(ctx: Pick<GCtx, "minFontPt">, label: string, room: { w: number; h: number }, basePt: number): { lines: string[]; size: number; fits: boolean } {
  const words = label.trim().split(/\s+/);
  const splits: string[][] = [[label.trim()]];
  for (let k = 1; k < words.length; k++) splits.push([words.slice(0, k).join(" "), words.slice(k).join(" ")]);
  const widest = (ls: readonly string[], size: number) => Math.max(...ls.map((l) => textWidthMm(l, size)));
  const height = (n: number, size: number) => ptToMm(size) * (n === 1 ? 1 : 2.2);
  const start = Math.max(basePt, ctx.minFontPt);
  for (let size = start; size >= ctx.minFontPt - 1e-9; size = Math.round((size - 0.2) * 10) / 10) {
    for (const ls of splits) {
      if (widest(ls, size) <= room.w && height(ls.length, size) <= room.h) return { lines: ls, size, fits: true };
    }
  }
  if (fitActive()) {
    // FIG-02b2 G-04: saat fit grafik aktif, bungkus 3..6 baris (konsisten dengan simpul diagram).
    const tall = (n: number, size: number) => ptToMm(size) * (1 + 1.2 * (n - 1));
    for (let size = start; size >= ctx.minFontPt - 1e-9; size = Math.round((size - 0.2) * 10) / 10) {
      for (let n = 3; n <= 6; n++) {
        const r = wrap(label.trim(), room.w, n, { pt: size });
        if (r.fits && tall(r.lines.length, size) <= room.h) return { lines: r.lines, size, fits: true };
      }
    }
    const r = wrap(label.trim(), room.w, 6, { pt: ctx.minFontPt });
    if (r.lines.join(" ") === words.join(" ")) return { lines: r.lines, size: ctx.minFontPt, fits: false };
  }
  const best = splits.reduce((a, b) => (widest(b, ctx.minFontPt) < widest(a, ctx.minFontPt) ? b : a));
  return { lines: best, size: ctx.minFontPt, fits: false };
}

function drawNode(ctx: GCtx, n: SheetNode, b: Box, index: number, stroke: string, strokeW: number, basePt: number): boolean {
  const { doc, pal } = ctx;
  const shape: DiagramShape = n.spec.shape ?? "box";
  const mark = { mark: "node" as const, series: "langkah", index };
  const o = { mark, stroke, strokeWidthMm: strokeW, attrs: ` data-node="${escAttr(n.id)}"` };
  const { x, y, w, h } = b;
  const poly = (pts: ReadonlyArray<readonly [number, number]>) =>
    doc.path(`M${pts.map(([px, py]) => `${num(px)} ${num(py)}`).join("L")}Z`, pal.paper, o);
  switch (shape) {
    case "stadium": {
      const r = Math.min(h / 2, w / 2);
      doc.rect(x, y, w, h, pal.paper, { ...o, attrs: `${o.attrs} rx="${num(r)}" ry="${num(r)}"` });
      break;
    }
    case "diamond":
      poly([
        [x + w / 2, y],
        [x + w, y + h / 2],
        [x + w / 2, y + h],
        [x, y + h / 2],
      ]);
      break;
    case "parallelogram": {
      const k = w * 0.18;
      poly([
        [x + k, y],
        [x + w, y],
        [x + w - k, y + h],
        [x, y + h],
      ]);
      break;
    }
    case "hexagon": {
      const k = w * 0.22;
      poly([
        [x + k, y],
        [x + w - k, y],
        [x + w, y + h / 2],
        [x + w - k, y + h],
        [x + k, y + h],
        [x, y + h / 2],
      ]);
      break;
    }
    case "cylinder": {
      const ry = h * 0.16;
      doc.path(
        `M${num(x)} ${num(y + ry)}a${num(w / 2)} ${num(ry)} 0 0 0 ${num(w)} 0L${num(x + w)} ${num(y + h - ry)}a${num(w / 2)} ${num(ry)} 0 0 1 ${num(-w)} 0Z`,
        pal.paper,
        o,
      );
      break;
    }
    case "circle":
      doc.circle(x + w / 2, y + h / 2, Math.min(w, h) / 2, pal.paper, o);
      break;
    case "bus":
      doc.line(x, y + h / 2, x + w, y + h / 2, stroke, strokeW * 3, { mark });
      return true;
    default:
      doc.rect(x, y, w, h, pal.paper, o);
  }
  const fit = fitLines(ctx, n.spec.label ?? n.id, textRoom(shape, b), basePt);
  const lh = ptToMm(fit.size) * 1.2;
  const y0 = y + h / 2 - ((fit.lines.length - 1) * lh) / 2 + ptToMm(fit.size) * 0.35;
  fit.lines.forEach((l, k) => doc.text(x + w / 2, y0 + k * lh, l, { sizePt: fit.size, fill: pal.ink900, anchor: "middle" }));
  return fit.fits;
}

// ── Konektor ──────────────────────────────────────────────────────────────

type XY = readonly [number, number];
const same = (a: XY, b: XY): boolean => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;

/**
 * Ujung konektor pada kotak batas simpul keputusan dipindah ke garis tepi belah ketupat
 * sepanjang segmen ujung (sumbu-sejajar), agar panah menyentuh bentuknya.
 */
function clipToDiamond(pts: XY[], n: SheetNode | undefined, at: number): void {
  if (!n || n.spec.shape !== "diamond" || pts.length < 2) return;
  const nb = pts[at === 0 ? 1 : at - 1];
  const [x, y] = pts[at];
  const cx = n.x + n.w / 2;
  const cy = n.y + n.h / 2;
  if (Math.abs(nb[1] - y) < 1e-6) {
    const k = 1 - Math.min(1, Math.abs(y - cy) / (n.h / 2));
    pts[at] = [cx + Math.sign(x - cx || nb[0] - cx) * (n.w / 2) * k, y];
  } else if (Math.abs(nb[0] - x) < 1e-6) {
    const k = 1 - Math.min(1, Math.abs(x - cx) / (n.w / 2));
    pts[at] = [x, cy + Math.sign(y - cy || nb[1] - cy) * (n.h / 2) * k];
  }
}

/**
 * Rapikan polyline rute Garis A untuk skala chart: buang titik kembar, taji bolak-balik
 * (A -> B -> A, stub jangkar dikipas) dan titik segaris. Titik ujung tidak berubah.
 */
export function simplify(points: ReadonlyArray<XY>): XY[] {
  let out: XY[] = [];
  for (const p of points) if (!out.length || !same(out[out.length - 1], p)) out.push(p);
  let changed = true;
  while (changed && out.length > 2) {
    changed = false;
    for (let i = 1; i + 1 < out.length; i++) {
      if (same(out[i - 1], out[i + 1])) {
        out = [...out.slice(0, i), ...out.slice(i + 2)];
        changed = true;
        break;
      }
    }
  }
  return out.filter((p, i) => {
    if (i === 0 || i === out.length - 1) return true;
    const a = out[i - 1];
    const b = out[i + 1];
    const cross = (p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0]);
    const dot = (p[0] - a[0]) * (b[0] - p[0]) + (p[1] - a[1]) * (b[1] - p[1]);
    return !(Math.abs(cross) < 1e-6 && dot >= 0);
  });
}

function drawEdge(ctx: GCtx, e: RoutedEdge, index: number, map: (x: number, y: number) => Pt, w: number, labelPt: number): void {
  const { doc, pal } = ctx;
  const kind = EDGE_KINDS[e.kind] ?? EDGE_KINDS.data;
  const colour = tokenHex(pal, kind.colour);
  const pts = e.points.map(([x, y]) => map(x, y));
  if (pts.length < 2) return;
  const mark = { mark: "link" as const, series: "konektor", index };
  const a = pts[pts.length - 2];
  const tip = pts[pts.length - 1];
  const segL = Math.hypot(tip.x - a.x, tip.y - a.y) || 1;
  const ux = (tip.x - a.x) / segL;
  const uy = (tip.y - a.y) / segL;
  const headL = Math.min(1.4, segL * 0.6);
  const headW = headL * 0.45;
  const base = { x: tip.x - ux * headL, y: tip.y - uy * headL };
  const line = kind.head === "solid" ? [...pts.slice(0, -1), base] : pts;
  const dashRaw = DASH_PATTERNS[kind.pattern];
  const dashMm = dashRaw ? dashRaw.split(",").map(Number) : undefined;
  doc.path(`M${line.map((p) => `${num(p.x)} ${num(p.y)}`).join("L")}`, "none", { mark, stroke: colour, strokeWidthMm: w, dashMm });
  const px = -uy * headW;
  const py = ux * headW;
  if (kind.head === "solid") {
    doc.path(`M${num(tip.x)} ${num(tip.y)}L${num(base.x + px)} ${num(base.y + py)}L${num(base.x - px)} ${num(base.y - py)}Z`, colour, { mark });
  } else {
    doc.path(`M${num(base.x + px)} ${num(base.y + py)}L${num(tip.x)} ${num(tip.y)}L${num(base.x - px)} ${num(base.y - py)}`, "none", {
      mark,
      stroke: colour,
      strokeWidthMm: w,
    });
  }
  if (!e.label) return;
  // Titik tengah segmen terpanjang (HS `_mid_label`), digeser keluar dari garis.
  let best = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    if (Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y) > Math.hypot(pts[best + 1].x - pts[best].x, pts[best + 1].y - pts[best].y)) best = i;
  }
  const p0 = pts[best];
  const p1 = pts[best + 1];
  const mx = (p0.x + p1.x) / 2;
  const my = (p0.y + p1.y) / 2;
  const size = Math.max(ctx.minFontPt, labelPt);
  const ink = e.kind === "data" || e.kind === "control" || e.kind === "sync" ? pal.ink900 : colour;
  if (Math.abs(p1.y - p0.y) < Math.abs(p1.x - p0.x)) {
    doc.text(mx, my - 0.8, e.label, { sizePt: size, fill: ink, anchor: "middle" });
  } else {
    doc.text(mx + 0.8, my + ptToMm(size) * 0.35, e.label, { sizePt: size, fill: ink, anchor: "start" });
  }
}
