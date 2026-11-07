/**
 * engine/chart/family-h2 — H-09 Venn / Euler (S36). TANPA-ACUAN Python (research/06:102, kelas
 * CC: lint + cek khusus "jumlah himpunan <= maxSets", research/06:342). Bentuk galeri: panel
 * H-09 Gambar 8.2 (lingkaran garis tanpa isian ink700, satu himpunan beraksen signal, nama +
 * angka wilayah eksklusif di dalam lingkaran, angka irisan di tengah lensa).
 *
 * Luas proporsional SEDERHANA (terdokumentasi, deterministik):
 * - luas lingkaran = ukuran himpunan (r = sqrt(size / pi)), dalam satuan bersama lalu diskalakan
 *   seragam agar muat plot;
 * - jarak pusat tiap PASANGAN diselesaikan eksak dengan bisection (80 iterasi) sehingga luas
 *   lensa = ukuran irisan pasangan; irisan 0 -> lingkaran terpisah (Euler, celah 6 % jari-jari
 *   terkecil); irisan = himpunan terkecil -> bersinggungan di dalam (himpunan bagian);
 * - tiga himpunan: A di kiri atas, B di kanan atas sejarak d(AB), C di bawah pada perpotongan
 *   lingkaran jari-jari d(AC) dari A dan d(BC) dari B. Bila ketiga jarak melanggar ketaksamaan
 *   segitiga, C diletakkan segaris (REPORT H-09-AREA). Luas irisan TIGA himpunan tidak
 *   dikendalikan (selalu REPORT H-09-AREA untuk tiga himpunan), angkanya tetap dicetak.
 *
 * Penempatan label: dua himpunan = titik tengah wilayah pada garis pusat; tiga himpunan = pusat
 * + 0,45 r menjauhi titik berat pusat; label irisan pasangan pada tengah lensa di garis pusat,
 * digeser menjauhi himpunan ketiga; label irisan tiga pada titik berat pusat.
 *
 * Parameter registri `chart.kind.H-09.maxSets` (alias `maxSets`, 2..3, bawaan 3): himpunan lebih
 * banyak -> cacat by-construction. Kunci pendek: `accentSet` (nama himpunan beraksen; juga lewat
 * medan `accent.group|point|series` dan alias params), `regionLabels` ("eksklusif" bawaan: angka
 * wilayah eksklusif | "total": ukuran himpunan dan irisan apa adanya).
 */
import type { ChartCanvas, LintIssue, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { fmt, withUnit } from "../../bind";
import { defect } from "../core/guards";
import { kindKey } from "../core/palette";
import { num, ptToMm } from "../core/svg";
import { type H2Prep, assertAccentCount, closeDoc, finite, h2Enum, h2Int, openDoc, prepareH2, schemaError } from "./shared";
import { fitActive, fitNote } from "../core/fit";
import { measure, wrapEllipsize } from "../core/textfit";

const REGION_LABELS = ["eksklusif", "total"] as const;

type XY = [number, number];

interface SetsData {
  names: string[];
  sizes: number[];
  /** Irisan pasangan [i][j] (simetris). */
  pair: number[][];
  /** Irisan tiga (0 bila < 3 himpunan atau tidak diberikan). */
  triple: number;
}

/** Luas lensa dua lingkaran berjari-jari r1, r2 berjarak d. */
export function lensArea(r1: number, r2: number, d: number): number {
  if (d >= r1 + r2) return 0;
  if (d <= Math.abs(r1 - r2)) return Math.PI * Math.min(r1, r2) ** 2;
  const a = r1 * r1 * Math.acos(Math.min(1, Math.max(-1, (d * d + r1 * r1 - r2 * r2) / (2 * d * r1))));
  const b = r2 * r2 * Math.acos(Math.min(1, Math.max(-1, (d * d + r2 * r2 - r1 * r1) / (2 * d * r2))));
  const k = 0.5 * Math.sqrt(Math.max(0, (-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2)));
  return a + b - k;
}

/** Jarak pusat agar luas lensa = `ov` (bisection, deterministik). */
export function distanceFor(r1: number, r2: number, ov: number): number {
  const lo0 = Math.abs(r1 - r2);
  const hi0 = r1 + r2;
  if (ov <= 0) return hi0 + 0.06 * Math.min(r1, r2);
  if (ov >= Math.PI * Math.min(r1, r2) ** 2 - 1e-12) return lo0;
  let lo = lo0;
  let hi = hi0;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (lensArea(r1, r2, mid) > ov) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function requireSets(spec: StudioChartV1, prep: H2Prep, maxSets: number): SetsData {
  const d = spec.data;
  if (!d) throw schemaError(prep, "data wajib");
  if (d.shape !== "sets") throw schemaError(prep, `membutuhkan data "sets", diterima "${d.shape}"`, { shape: d.shape });
  const sets = Array.isArray(d.sets) ? d.sets : [];
  if (sets.length === 0) throw defect("DC-G1", `${prep.fid} — grafik tanpa data`, { code: prep.code });
  if (sets.length > maxSets) {
    throw defect(kindKey("H-09", "maxSets"), `${prep.fid} — ${sets.length} himpunan > ${maxSets}; pakai matriks irisan (UpSet) atau pecah gambarnya`, {
      code: prep.code,
      sets: sets.length,
    });
  }
  if (sets.length < 2) throw schemaError(prep, `Venn/Euler membutuhkan 2..${maxSets} himpunan, diterima ${sets.length}`);
  const names: string[] = [];
  const sizes: number[] = [];
  sets.forEach((s, i) => {
    if (typeof s?.name !== "string" || s.name === "") throw schemaError(prep, `himpunan ${i} tanpa nama`, { index: i });
    if (names.includes(s.name)) throw schemaError(prep, `nama himpunan "${s.name}" ganda`, { index: i });
    if (!finite(s.size) || s.size <= 0) throw schemaError(prep, `ukuran himpunan "${s.name}" harus bilangan hingga > 0`, { index: i });
    names.push(s.name);
    sizes.push(s.size);
  });
  const n = names.length;
  const pair = names.map(() => names.map(() => 0));
  let triple = 0;
  const seen = new Set<string>();
  (Array.isArray(d.overlaps) ? d.overlaps : []).forEach((o, j) => {
    const idx = Array.isArray(o?.sets) ? o.sets.map((s) => names.indexOf(s)) : [];
    if (idx.length < 2 || idx.some((i) => i < 0) || new Set(idx).size !== idx.length) {
      throw schemaError(prep, `irisan ${j} harus menyebut 2..${n} nama himpunan yang ada tanpa ganda`, { index: j });
    }
    if (!finite(o.size) || o.size < 0) throw schemaError(prep, `ukuran irisan ${j} harus bilangan hingga >= 0`, { index: j });
    const key = [...idx].sort((a, b) => a - b).join(",");
    if (seen.has(key)) throw schemaError(prep, `irisan ${j} (${o.sets.join(" & ")}) didefinisikan ganda`, { index: j });
    seen.add(key);
    if (o.size > Math.min(...idx.map((i) => sizes[i])) + 1e-9) throw schemaError(prep, `irisan ${o.sets.join(" & ")} = ${o.size} melebihi himpunan terkecilnya`, { index: j });
    if (idx.length === 2) {
      pair[idx[0]][idx[1]] = o.size;
      pair[idx[1]][idx[0]] = o.size;
    } else {
      triple = o.size;
    }
  });
  if (n === 3) {
    for (const [a, b] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      if (pair[a][b] + 1e-9 < triple) throw schemaError(prep, `irisan ${names[a]} & ${names[b]} lebih kecil dari irisan tiga himpunan`);
    }
  }
  return { names, sizes, pair, triple };
}

export function renderVenn(spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate): SvgResult {
  const prep = prepareH2(spec, tpl, "H-09", ["accentSet"]);
  const { pal, look } = prep;
  const maxSets = h2Int(spec, tpl, "H-09", "maxSets", 3, 2, 3);
  const data = requireSets(spec, prep, maxSets);
  const regionMode = h2Enum(spec, tpl, "H-09", "regionLabels", REGION_LABELS, "eksklusif");
  const issues: LintIssue[] = [];
  const n = data.names.length;

  const acc = new Set<number>();
  for (const ref of prep.accentRefs) {
    const i = typeof ref === "number" ? (Number.isInteger(ref) && ref >= 0 && ref < n ? ref : -1) : data.names.indexOf(ref);
    if (i >= 0) acc.add(i);
  }
  assertAccentCount(prep, acc.size, "himpunan");

  // Tata letak dalam satuan luas = ukuran.
  const r = data.sizes.map((s) => Math.sqrt(s / Math.PI));
  const dist = (a: number, b: number): number => distanceFor(r[a], r[b], data.pair[a][b]);
  const c: XY[] = [];
  const dAB = dist(0, 1);
  c.push([0, 0], [dAB, 0]);
  if (n === 3) {
    const dAC = dist(0, 2);
    const dBC = dist(1, 2);
    let x = dAB > 1e-12 ? (dAC * dAC - dBC * dBC + dAB * dAB) / (2 * dAB) : dAC;
    let y2 = dAC * dAC - x * x;
    if (y2 < -1e-9) {
      issues.push({ checkId: "H-09-AREA", status: "REPORT", detail: "jarak pasangan melanggar ketaksamaan segitiga; himpunan ketiga diletakkan segaris (luas irisan pendekatan)" });
      x = Math.min(Math.max(x, -dAC), dAB + dBC);
      y2 = 0;
    }
    c.push([x, Math.sqrt(Math.max(0, y2))]);
    issues.push({ checkId: "H-09-AREA", status: "REPORT", detail: "tiga himpunan: luas lingkaran dan irisan pasangan proporsional; luas irisan tiga himpunan tidak dikendalikan" });
  }

  // Muat ke plot (skala seragam, di tengah).
  const W = canvas.widthMm;
  const H = canvas.heightMm;
  const doc = openDoc(spec, prep, W, H);
  const pad = 1.4;
  const box = { x0: pad, y0: pad, x1: W - pad, y1: H - prep.footMm - pad };
  const bx0 = Math.min(...c.map((p, i) => p[0] - r[i]));
  const bx1 = Math.max(...c.map((p, i) => p[0] + r[i]));
  const by0 = Math.min(...c.map((p, i) => p[1] - r[i]));
  const by1 = Math.max(...c.map((p, i) => p[1] + r[i]));
  const s = Math.min((box.x1 - box.x0) / (bx1 - bx0), (box.y1 - box.y0) / (by1 - by0));
  if (!(s > 0) || !Number.isFinite(s)) throw defect("DATUM-33", `${prep.fid} — kanvas ${W} x ${H} mm terlalu kecil untuk Venn`, { code: prep.code });
  const ox = (box.x0 + box.x1) / 2 - ((bx0 + bx1) / 2) * s;
  const oy = (box.y0 + box.y1) / 2 - ((by0 + by1) / 2) * s;
  const P = (p: XY): XY => [ox + p[0] * s, oy + p[1] * s];
  const R = r.map((x) => x * s);
  const C = c.map(P);

  // Angka wilayah.
  const pairOnly = (a: number, b: number): number => data.pair[a][b] - (n === 3 ? data.triple : 0);
  const exclusive = (i: number): number => {
    let v = data.sizes[i];
    for (let j = 0; j < n; j++) if (j !== i) v -= data.pair[i][j];
    return n === 3 ? v + data.triple : v;
  };
  const values = data.names.map((_, i) => (regionMode === "total" ? data.sizes[i] : exclusive(i)));
  if (values.some((v) => v < -1e-9) || (n === 3 && [pairOnly(0, 1), pairOnly(0, 2), pairOnly(1, 2)].some((v) => v < -1e-9))) {
    throw schemaError(prep, "ukuran irisan tidak konsisten dengan ukuran himpunan (wilayah eksklusif negatif)");
  }
  const label = (v: number): string => withUnit(fmt(v, prep.dec), prep.unit);

  data.names.forEach((name, i) => {
    const [cx, cy] = C[i];
    const rr = R[i];
    doc.path(`M${num(cx - rr)} ${num(cy)}a${num(rr)} ${num(rr)} 0 1 0 ${num(2 * rr)} 0a${num(rr)} ${num(rr)} 0 1 0 ${num(-2 * rr)} 0Z`, "none", {
      stroke: acc.has(i) ? pal.role.accent : pal.ink700,
      strokeWidthMm: look.accentMm,
      mark: { mark: "area", series: name, index: i },
    });
  });

  const lh = ptToMm(look.labelPt);
  const vh = ptToMm(look.valuePt);
  const centroid: XY = [C.reduce((a, p) => a + p[0], 0) / n, C.reduce((a, p) => a + p[1], 0) / n];

  // Posisi angka wilayah irisan (dihitung lebih dulu; digambar setelah label himpunan seperti semula).
  const regionPt = Math.max(look.valuePt, 7.4);
  const regions: Array<{ at: XY; v: number }> = [];
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      if (!(data.pair[a][b] > 0)) continue;
      const dx = C[b][0] - C[a][0];
      const dy = C[b][1] - C[a][1];
      const d = Math.hypot(dx, dy);
      const u: XY = d > 1e-9 ? [dx / d, dy / d] : [1, 0];
      const t = (d - R[b] + R[a]) / 2;
      let at: XY = [C[a][0] + u[0] * t, C[a][1] + u[1] * t];
      if (n === 3) {
        const k = 3 - a - b;
        const vx = at[0] - C[k][0];
        const vy = at[1] - C[k][1];
        const vd = Math.hypot(vx, vy);
        const push = Math.max(0, R[a] + R[b] - d) * 0.25;
        if (vd > 1e-9) at = [at[0] + (vx / vd) * push, at[1] + (vy / vd) * push];
      }
      regions.push({ at, v: regionMode === "total" ? data.pair[a][b] : pairOnly(a, b) });
    }
  }
  if (n === 3 && data.triple > 0) regions.push({ at: centroid, v: data.triple });

  // FIG-02c (hanya saat fit): nama himpunan dibungkus (<= 3 baris, lalu elipsis dengan <title>)
  // dan blok nama+angka digeser menjauh dari irisan sampai tidak menutup angka wilayah.
  const fit = fitActive();
  type BoxT = [number, number, number, number];
  const hitB = (p: BoxT, q: BoxT): boolean => p[0] < q[2] && q[0] < p[2] && p[1] < q[3] && q[1] < p[3];
  const regionBoxes: BoxT[] = regions.map((rg) => {
    const w = measure(label(rg.v), regionPt, "data");
    const y = rg.at[1] + ptToMm(regionPt) * 0.35;
    return [rg.at[0] - w / 2 - 0.3, y - ptToMm(regionPt) * 0.9 - 0.2, rg.at[0] + w / 2 + 0.3, y + ptToMm(regionPt) * 0.15 + 0.2];
  });
  const blocks: BoxT[] = [];
  const nameFit: Array<{ lines: string[]; title?: string; at: XY } | undefined> = [];
  const blockH = (nLines: number): number => lh + (nLines - 1) * lh * 1.2 + 0.8 + vh;
  let wrapped = 0;
  data.names.forEach((name, i) => {
    if (!fit) return;
    const nameFont = { pt: look.labelPt };
    const valueW = measure(label(values[i]), look.valuePt, "data");
    const fitsWhole = measure(name, look.labelPt) <= R[i] * 1.6;
    if (fitsWhole) return;
    let dirv: XY;
    if (n === 2) {
      const j = 1 - i;
      const dx = C[i][0] - C[j][0];
      const dy = C[i][1] - C[j][1];
      const d = Math.hypot(dx, dy);
      dirv = d > 1e-9 ? [dx / d, dy / d] : [0, -1];
    } else {
      const dx = C[i][0] - centroid[0];
      const dy = C[i][1] - centroid[1];
      const d = Math.hypot(dx, dy);
      dirv = d > 1e-9 ? [dx / d, dy / d] : [0, -1];
    }
    let best: { lines: string[]; title?: string; at: XY } | null = null;
    for (const wf of [1.3, 1.0, 0.8, 0.6]) {
      const wr = wrapEllipsize(name, R[i] * wf, 3, nameFont);
      const bw = Math.max(valueW, ...wr.lines.map((l) => measure(l, look.labelPt)));
      const bh = blockH(wr.lines.length);
      for (const tf of [0, 0.15, 0.3, 0.45, 0.6]) {
        const base = n === 2 ? (() => {
          const j = 1 - i;
          const d = Math.hypot(C[i][0] - C[j][0], C[i][1] - C[j][1]);
          return Math.min(R[i] * 0.8, Math.max(-R[i] * 0.8, (R[i] - (d - R[j])) / 2));
        })() : R[i] * 0.45;
        const t = Math.min(base + tf * R[i], R[i] * 0.85);
        const at: XY = [C[i][0] + dirv[0] * t, C[i][1] + dirv[1] * t];
        const box: BoxT = [at[0] - bw / 2 - 0.2, at[1] - bh / 2 - 0.2, at[0] + bw / 2 + 0.2, at[1] + bh / 2 + 0.2];
        if (box[0] < 0.3 || box[2] > W - 0.3 || box[1] < 0.3 || box[3] > H - prep.footMm) continue;
        if (regionBoxes.some((q) => hitB(q, box)) || blocks.some((q) => hitB(q, box))) continue;
        best = { lines: wr.lines, title: wr.truncated ? name : undefined, at };
        blocks.push(box);
        break;
      }
      if (best) break;
    }
    if (!best) return;
    wrapped++;
    nameFit[i] = best;
  });
  if (wrapped) fitNote("VENN_LABEL_WRAP", `${wrapped} nama himpunan dibungkus/digeser agar tidak menutup angka irisan`);

  data.names.forEach((name, i) => {
    const nf = nameFit[i];
    if (nf) {
      const top0 = nf.at[1] - blockH(nf.lines.length) / 2;
      const extra = (nf.lines.length - 1) * lh * 1.2;
      doc.textLines(nf.at[0], top0 + lh * 0.8, nf.lines, { sizePt: look.labelPt, fill: pal.ink700, anchor: "middle" }, lh * 1.2, nf.title);
      doc.text(nf.at[0], top0 + lh + extra + 0.8 + vh * 0.8, label(values[i]), { face: "data", sizePt: look.valuePt, fill: pal.ink900, anchor: "middle", attrs: ' data-label="value"' });

      return;
    }
    let at: XY;
    if (n === 2) {
      const j = 1 - i;
      const dx = C[i][0] - C[j][0];
      const dy = C[i][1] - C[j][1];
      const d = Math.hypot(dx, dy);
      const u: XY = d > 1e-9 ? [dx / d, dy / d] : [0, -1];
      const t = Math.min(R[i] * 0.8, Math.max(-R[i] * 0.8, (R[i] - (d - R[j])) / 2));
      at = [C[i][0] + u[0] * t, C[i][1] + u[1] * t];
    } else {
      const dx = C[i][0] - centroid[0];
      const dy = C[i][1] - centroid[1];
      const d = Math.hypot(dx, dy);
      const u: XY = d > 1e-9 ? [dx / d, dy / d] : [0, -1];
      at = [C[i][0] + u[0] * R[i] * 0.45, C[i][1] + u[1] * R[i] * 0.45];
    }
    const blockTop = at[1] - (lh + 0.8 + vh) / 2;
    doc.text(at[0], blockTop + lh * 0.8, name, { sizePt: look.labelPt, fill: pal.ink700, anchor: "middle" });
    doc.text(at[0], blockTop + lh + 0.8 + vh * 0.8, label(values[i]), { face: "data", sizePt: look.valuePt, fill: pal.ink900, anchor: "middle", attrs: ' data-label="value"' });
  });

  for (const rg of regions) {
    doc.text(rg.at[0], rg.at[1] + ptToMm(regionPt) * 0.35, label(rg.v), { face: "data", sizePt: regionPt, fill: pal.ink900, anchor: "middle", attrs: ' data-label="value"' });
  }


  return closeDoc(doc, spec, prep, dedupe(issues));
}

function dedupe(issues: LintIssue[]): LintIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.checkId}|${i.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
