/**
 * K-11 Sankey — pita yang tebalnya sama dengan volume (Tabel 8.3). TANPA-ACUAN (CC):
 * lint saja + snapshot regresi (research/06 §6.5: tingkat <= 3, simpul akhir <= 12, total
 * tiap tingkat sama).
 *
 * Tata letak deterministik (terdokumentasi):
 * 1. Validasi graf: id unik, ujung pita ada, tanpa simpul-ke-diri, nilai pita > 0, ASIKLIK
 *    (Kahn; simpul siap diambil menurut indeks data terkecil).
 * 2. Tingkat = jalur terpanjang dari sumber (sumber = tingkat 0). Jumlah tingkat >
 *    `maxLevels` (default 3) -> defect `chart.kind.K-11.maxLevels`; simpul akhir >
 *    `maxEndNodes` (default 12, "sekitar 12") -> REPORT.
 * 3. Kolom tingkat berjarak sama antara talang label kiri (tingkat 0) dan kanan.
 *    Urutan simpul dalam kolom = urutan data. Tinggi simpul = max(nilai simpul, total masuk,
 *    total keluar) x k, dengan k = min per kolom (tinggi tersedia - celah) / jumlah tinggi;
 *    tiap kolom ditengahkan tegak.
 * 4. Pita keluar ditumpuk dari atas simpul sumber menurut (tingkat, urutan) simpul tujuan;
 *    pita masuk ditumpuk dari atas simpul tujuan menurut (tingkat, urutan) simpul sumber;
 *    bentuk = dua kurva Bezier kubik dengan titik kendali di tengah mendatar.
 *
 * Nilai digambar APA ADANYA (D-58, K-11 benchmark: RAB tercetak 100, cabang berjumlah 96):
 * simpul bernilai lebih besar dari alirannya menyisakan ruang kosong di bawah pita; selisih
 * simpul/aliran dan total per tingkat dilaporkan REPORT `K-11.balance`, tidak dinormalisasi.
 *
 * Aksen: `accentLink` [dari, ke] (id atau label; kunci lokal, pola H-07) -> pita signal;
 * `accent.point` (id, label, atau indeks simpul) -> simpul signal. Warna: simpul tingkat 0
 * ink900, simpul lain ink700, pita ink200 (fill-opacity 0,55; bukan gradien, P7-15) —
 * panel Gambar 8.3. Label tingkat 0 di kiri (Plex Mono, nama lalu nilai); tingkat lain di
 * kanan simpul "<nama> <nilai>" (Plex Sans Condensed).
 */
import type { ChartRenderer } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { fmt } from "../../bind";
import { defect } from "../core/guards";
import { kindKey } from "../core/palette";
import { num, ptToMm, textWidthMm } from "../core/svg";
import {
  type K2Ctx,
  accentHint,
  assertAccentCount,
  beginChart,
  endChart,
  hintMiss,
  invalidParam,
  kindInt,
  kindParam,
  mid,
  pt,
  report,
  resolveTarget,
  sum,
} from "./common";

const EPS = 1e-9;
export const SANKEY_NODE_W_MM = 2.0;
export const SANKEY_NODE_GAP_MM = 0.8;
export const SANKEY_LINK_OPACITY = 0.55;

interface GNode {
  id: string;
  label: string;
  value?: number;
}
interface GLink {
  s: number;
  t: number;
  value: number;
}

function graph(ctx: K2Ctx): { nodes: GNode[]; links: GLink[] } {
  const d = ctx.spec.data;
  if (!d) throw new StudioEngineError("SCHEMA_INVALID", `${ctx.fid} — K-11: data wajib`, { code: ctx.code });
  if (d.shape !== "graph") {
    throw new StudioEngineError("SCHEMA_INVALID", `${ctx.fid} — K-11 membutuhkan data "graph", diterima "${d.shape}"`, { code: ctx.code, shape: d.shape });
  }
  if (!Array.isArray(d.nodes) || d.nodes.length === 0) throw defect("DC-G1", `${ctx.fid} — sankey tanpa simpul`, { code: ctx.code });
  const ids = new Map<string, number>();
  const nodes = d.nodes.map((n, i) => {
    if (typeof n?.id !== "string" || n.id === "" || ids.has(n.id)) {
      throw new StudioEngineError("SCHEMA_INVALID", `${ctx.fid} — simpul ${i}: id kosong atau ganda`, { code: ctx.code, index: i });
    }
    if (n.value !== undefined && !(typeof n.value === "number" && Number.isFinite(n.value) && n.value >= 0)) {
      throw defect("DC-G1", `${ctx.fid} — simpul ${n.id}: nilai bukan bilangan hingga >= 0`, { code: ctx.code, index: i });
    }
    ids.set(n.id, i);
    return { id: n.id, label: typeof n.label === "string" ? n.label : n.id, ...(n.value !== undefined ? { value: n.value } : {}) };
  });
  const links = (d.links ?? []).map((l, i) => {
    const s = ids.get(l?.from);
    const t = ids.get(l?.to);
    if (s === undefined || t === undefined) {
      throw new StudioEngineError("SCHEMA_INVALID", `${ctx.fid} — pita ${i}: ujung "${String(l?.from)}" -> "${String(l?.to)}" tidak ada di simpul`, { code: ctx.code, index: i });
    }
    if (s === t) throw defect("K-11", `${ctx.fid} — pita ${i}: simpul ke dirinya sendiri`, { code: ctx.code, index: i });
    if (!(typeof l.value === "number" && Number.isFinite(l.value) && l.value > 0)) {
      throw defect("DC-G1", `${ctx.fid} — pita ${i} (${l.from} -> ${l.to}) tanpa nilai > 0; tebal pita = volume`, { code: ctx.code, index: i });
    }
    return { s, t, value: l.value };
  });
  if (!links.length) throw defect("DC-G1", `${ctx.fid} — sankey tanpa pita aliran`, { code: ctx.code });
  return { nodes, links };
}

/** Tingkat jalur-terpanjang lewat urutan topologis Kahn (indeks terkecil dahulu); siklus -> defect. */
function levels(ctx: K2Ctx, n: number, links: readonly GLink[]): number[] {
  const indeg = new Array<number>(n).fill(0);
  links.forEach((l) => indeg[l.t]++);
  const done = new Array<boolean>(n).fill(false);
  const level = new Array<number>(n).fill(0);
  for (let k = 0; k < n; k++) {
    const i = indeg.findIndex((d, j) => d === 0 && !done[j]);
    if (i < 0) throw defect("K-11", `${ctx.fid} — graf sankey bersiklus; aliran harus searah`, { code: ctx.code });
    done[i] = true;
    for (const l of links) {
      if (l.s !== i) continue;
      level[l.t] = Math.max(level[l.t], level[i] + 1);
      indeg[l.t]--;
    }
  }
  return level;
}

export const renderSankey: ChartRenderer = (spec, canvas, tpl) => {
  const ctx = beginChart("K-11", spec, canvas, tpl);
  const { doc, pal, dec, x0, x1, y0, y1 } = ctx;
  const T = { label: pt(ctx, ctx.style === "gallery" ? 6.4 : 6.5) };
  const { nodes, links } = graph(ctx);
  const n = nodes.length;
  const level = levels(ctx, n, links);
  const L = Math.max(...level) + 1;
  const maxLevels = kindInt(ctx, "maxLevels", 3);
  if (L > maxLevels) {
    throw defect(kindKey("K-11", "maxLevels"), `${ctx.fid} — ${L} tingkat > ${maxLevels}; terlalu banyak simpul, sederhanakan alirannya`, { code: ctx.code, levels: L });
  }
  const inSum = nodes.map((_, i) => sum(links.filter((l) => l.t === i).map((l) => l.value)));
  const outSum = nodes.map((_, i) => sum(links.filter((l) => l.s === i).map((l) => l.value)));
  const ends = nodes.filter((_, i) => level[i] > 0 && outSum[i] === 0).length;
  const maxEnds = kindInt(ctx, "maxEndNodes", 12);
  if (ends > maxEnds) report(ctx, "K-11.maxEndNodes", `${ends} simpul akhir > ${maxEnds}`);
  const isolated = nodes.filter((_, i) => inSum[i] === 0 && outSum[i] === 0).map((nd) => nd.label);
  if (isolated.length) report(ctx, "K-11", `simpul tanpa aliran: ${isolated.join(", ")}`);

  const size = nodes.map((nd, i) => Math.max(nd.value ?? 0, inSum[i], outSum[i]));
  const shown = nodes.map((nd, i) => nd.value ?? Math.max(inSum[i], outSum[i]));

  // Neraca: dilaporkan, tidak dinormalisasi.
  const bal: string[] = [];
  nodes.forEach((nd, i) => {
    const f = (v: number): string => fmt(v, dec);
    if (nd.value !== undefined) {
      if (outSum[i] > 0 && Math.abs(nd.value - outSum[i]) > EPS) bal.push(`simpul ${nd.label}: nilai ${f(nd.value)}, aliran keluar ${f(outSum[i])} (selisih ${f(nd.value - outSum[i])})`);
      if (inSum[i] > 0 && Math.abs(nd.value - inSum[i]) > EPS) bal.push(`simpul ${nd.label}: nilai ${f(nd.value)}, aliran masuk ${f(inSum[i])} (selisih ${f(nd.value - inSum[i])})`);
    } else if (inSum[i] > 0 && outSum[i] > 0 && Math.abs(inSum[i] - outSum[i]) > EPS) {
      bal.push(`simpul ${nd.label}: masuk ${f(inSum[i])}, keluar ${f(outSum[i])}`);
    }
  });
  // Total tingkat = simpul di tingkat itu + pita yang melompatinya (dari < l < ke).
  const levelTotals = Array.from(
    { length: L },
    (_, l) => sum(shown.filter((_v, i) => level[i] === l)) + sum(links.filter((lk) => level[lk.s] < l && l < level[lk.t]).map((lk) => lk.value)),
  );
  if (levelTotals.some((t) => Math.abs(t - levelTotals[0]) > EPS)) {
    bal.push(`total per tingkat ${levelTotals.map((t, l) => `T${l} ${fmt(t, dec)}`).join(", ")}`);
  }
  if (bal.length) report(ctx, "K-11.balance", `${bal.join("; ")} — digambar apa adanya, tidak dinormalisasi`);

  // Aksen.
  const accentNodes = new Set<number>();
  const accentLinks = new Set<number>();
  const byRef = (ref: unknown): number => (typeof ref === "string" ? nodes.findIndex((nd) => nd.id === ref || nd.label === ref) : -1);
  const al = kindParam(ctx, "accentLink");
  if (al !== undefined) {
    if (!Array.isArray(al) || al.length !== 2) throw invalidParam(ctx, "accentLink", al, "[dari, ke]");
    const s = byRef(al[0]);
    const t = byRef(al[1]);
    const li = links.findIndex((l) => l.s === s && l.t === t);
    if (li < 0) hintMiss(ctx, `pita ${JSON.stringify(al)}`);
    else accentLinks.add(li);
  }
  const hint = accentHint(spec);
  if (hint?.point !== undefined) {
    const i = typeof hint.point === "number" ? resolveTarget(hint.point, nodes.map((nd) => nd.id)) : byRef(hint.point);
    if (i < 0) hintMiss(ctx, `simpul ${JSON.stringify(hint.point)}`);
    else accentNodes.add(i);
  } else if (hint) {
    hintMiss(ctx, "grup/seri (K-11 hanya menerima accent.point atau accentLink)");
  }
  assertAccentCount(ctx, new Set([...[...accentNodes].map((i) => `simpul ${nodes[i].id}`), ...[...accentLinks].map((li) => `pita ${li}`)]));

  // Kolom dan skala tegak.
  const cols = Array.from({ length: L }, (_, l) => nodes.flatMap((_n, i) => (level[i] === l ? [i] : [])));
  const pos = new Array<number>(n).fill(0);
  cols.forEach((c) => c.forEach((i, k) => (pos[i] = k)));
  const vals = shown.map((v) => fmt(v, dec));
  const lineH = ptToMm(T.label) * 1.15;
  const leftW = Math.max(0, ...cols[0].map((i) => Math.max(textWidthMm(nodes[i].label, T.label, "data"), textWidthMm(vals[i], T.label, "data"))));
  const rightW = Math.max(0, ...nodes.flatMap((nd, i) => (level[i] > 0 ? [textWidthMm(`${nd.label} ${vals[i]}`, T.label)] : [])));
  const nw = SANKEY_NODE_W_MM;
  const xFirst = x0 + leftW + 1.2;
  const xLast = Math.max(xFirst + nw, x1 - rightW - 1.2 - nw);
  const xOf = (l: number): number => xFirst + (L > 1 ? (l * (xLast - xFirst)) / (L - 1) : 0);
  const availH = y1 - y0;
  const gap = SANKEY_NODE_GAP_MM;
  const k = Math.min(...cols.map((c) => (availH - (c.length - 1) * gap) / Math.max(EPS, sum(c.map((i) => size[i])))));
  const top = new Array<number>(n).fill(0);
  cols.forEach((c) => {
    const block = sum(c.map((i) => size[i])) * k + (c.length - 1) * gap;
    let y = y0 + (availH - block) / 2;
    c.forEach((i) => {
      top[i] = y;
      y += size[i] * k + gap;
    });
  });

  // Pita (di belakang simpul).
  const order = (a: number, b: number): number => level[a] - level[b] || pos[a] - pos[b];
  const outCur = [...top];
  const inCur = [...top];
  const outOrder = links.map((_, li) => li).sort((a, b) => order(links[a].t, links[b].t) || a - b);
  const inOrder = links.map((_, li) => li).sort((a, b) => order(links[a].s, links[b].s) || a - b);
  const sy = new Array<number>(links.length).fill(0);
  const ty = new Array<number>(links.length).fill(0);
  for (const li of outOrder) {
    sy[li] = outCur[links[li].s];
    outCur[links[li].s] += links[li].value * k;
  }
  for (const li of inOrder) {
    ty[li] = inCur[links[li].t];
    inCur[links[li].t] += links[li].value * k;
  }
  links.forEach((l, li) => {
    const xa = xOf(level[l.s]) + nw;
    const xb = xOf(level[l.t]);
    const xm = (xa + xb) / 2;
    const h = l.value * k;
    const d =
      `M${num(xa)} ${num(sy[li])}C${num(xm)} ${num(sy[li])} ${num(xm)} ${num(ty[li])} ${num(xb)} ${num(ty[li])}` +
      `L${num(xb)} ${num(ty[li] + h)}C${num(xm)} ${num(ty[li] + h)} ${num(xm)} ${num(sy[li] + h)} ${num(xa)} ${num(sy[li] + h)}Z`;
    doc.path(d, accentLinks.has(li) ? pal.role.accent : pal.ink200, {
      mark: { mark: "link", series: `${nodes[l.s].id}→${nodes[l.t].id}`, index: li },
      attrs: ` fill-opacity="${SANKEY_LINK_OPACITY}"`,
    });
  });

  // Simpul dan label.
  nodes.forEach((nd, i) => {
    const x = xOf(level[i]);
    const h = size[i] * k;
    const fill = accentNodes.has(i) ? pal.role.accent : level[i] === 0 ? pal.ink900 : pal.ink700;
    doc.rect(x, top[i], nw, h, fill, { mark: { mark: "node", series: nd.label, index: i } });
    const yc = top[i] + h / 2;
    if (level[i] === 0) {
      const b = mid(yc - lineH / 2, T.label);
      doc.text(x - 1.0, b, nd.label, { face: "data", sizePt: T.label, fill: pal.ink900, anchor: "end" });
      doc.text(x - 1.0, b + lineH, vals[i], { face: "data", sizePt: T.label, fill: pal.ink900, anchor: "end", attrs: ' data-label="value"' });
    } else {
      doc.text(x + nw + 1.0, mid(yc, T.label), `${nd.label} ${vals[i]}`, { sizePt: T.label, fill: pal.ink900, attrs: ' data-label="value"' });
    }
  });
  return endChart(ctx);
};
