/**
 * S-07 Beeswarm — titik rapat tanpa bertumpuk, satu kolom per grup (TANPA-ACUAN, lint saja).
 *
 * Penempatan deterministik (dicatat untuk S73/S79):
 * 1. Titik grup diurut nilai menaik (seri diputus indeks asal).
 * 2. Setiap titik diletakkan pada y = skala(nilai). Kandidat x: 0 (garis tengah kolom) dan,
 *    untuk setiap titik terpasang dengan |dy| < d (d = 2r + celah 0,1 mm), dua posisi
 *    singgung x_j +- sqrt(d^2 - dy^2).
 * 3. Kandidat sah = tidak beririsan dengan titik terpasang mana pun (jarak >= d). Dipilih
 *    |x| terkecil; seri |x| diputus bergantian: peringkat genap memilih sisi kanan, ganjil
 *    kiri (sebaran simetris).
 * 4. Bila sayap terlebar > 0,45 jarak kolom, r dikecilkan sebanding (maks 4 kali, r min
 *    0,3 mm); masih melebar -> REPORT `S-07.overflow` (titik tetap tidak bertumpuk).
 * Cek `S-07.noOverlap` dijalankan atas hasil akhir (by construction; temuan = galat mesin).
 *
 * Gaya gallery (Gambar 8.5 panel S-07): titik ink400, grup beraksen signal, sumbu y
 * bertick, label grup di bawah. Gaya datum: rangka v57_jitter (gridline y, tick mono,
 * satuan di atas sumbu), titik ink700.
 *
 * Parameter registri: `columnPerGroup` (default true; false -> semua grup dalam satu
 * kawanan di tengah, grup dibedakan warna aksen saja + REPORT), `medianMarker` (default
 * true; garis median ink900 per kolom).
 */
import {
  type Group,
  type S2Ctx,
  accentGroupIndex,
  columnFrame,
  columnLabel,
  kindBool,
  linearScale,
  median,
  ran,
  report,
  requireDistribution,
} from "./common";

const GAP_MM = 0.1;
const MIN_R_MM = 0.3;

interface Placed {
  x: number;
  y: number;
  /** Indeks grup asal dan indeks pengamatan. */
  gi: number;
  vi: number;
}

/** Kawanan satu kolom; y sudah dalam mm. Mengembalikan posisi relatif garis tengah. */
export function swarm(items: ReadonlyArray<{ y: number; gi: number; vi: number; v: number }>, r: number): Placed[] {
  const d = 2 * r + GAP_MM;
  const d2 = d * d;
  const order = items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => a.it.v - b.it.v || a.i - b.i)
    .map((x) => x.it);
  // `placed` tersusun menurut urutan nilai; y layar monoton (naik/turun) sehingga tetangga
  // yang perlu dicek adalah titik terpasang terakhir dengan |dy| < d.
  const placed: Placed[] = [];
  order.forEach((it, rank) => {
    const near: Placed[] = [];
    for (let j = placed.length - 1; j >= 0; j--) {
      if (Math.abs(placed[j].y - it.y) < d) near.push(placed[j]);
      else break;
    }
    const cands = [0];
    for (const p of near) {
      const dy = p.y - it.y;
      const w = Math.sqrt(Math.max(0, d2 - dy * dy));
      cands.push(p.x + w, p.x - w);
    }
    const ok = (x: number): boolean => near.every((p) => (x - p.x) * (x - p.x) + (it.y - p.y) * (it.y - p.y) >= d2 - 1e-9);
    const preferRight = rank % 2 === 0;
    let best: number | undefined;
    for (const c of cands) {
      if (!ok(c)) continue;
      if (best === undefined) {
        best = c;
        continue;
      }
      const dc = Math.abs(c) - Math.abs(best);
      if (dc < -1e-9 || (Math.abs(dc) <= 1e-9 && (preferRight ? c > best : c < best))) best = c;
    }
    placed.push({ x: best ?? 0, y: it.y, gi: it.gi, vi: it.vi });
  });
  return placed;
}

/** Pasangan bertumpuk (jarak pusat < 2r); 0 = sah. */
function overlaps(pts: readonly Placed[], r: number): number {
  const d2 = 4 * r * r - 1e-6;
  let n = 0;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[i].x - pts[j].x;
      const dy = pts[i].y - pts[j].y;
      if (dx * dx + dy * dy < d2) n++;
    }
  }
  return n;
}

export function renderBeeswarm(ctx: S2Ctx): void {
  const { pal, doc, style } = ctx;
  const gal = style === "gallery";
  const groups: Group[] = requireDistribution(ctx);
  const accent = accentGroupIndex(
    ctx,
    groups.map((g) => g.name),
  );
  const perGroup = kindBool(ctx, "columnPerGroup", true);
  const medianMarker = kindBool(ctx, "medianMarker", true);
  if (!perGroup) report(ctx, "S-07.columnPerGroup", "columnPerGroup=false: semua grup dalam satu kawanan; grup hanya dibedakan aksen");
  const columns = perGroup ? groups.length : 1;

  const colNames = perGroup ? groups.map((g) => g.name) : [groups.map((g) => g.name).join(" / ")];
  const f = columnFrame(ctx, groups, columns, (dom, top, base) => linearScale(dom.min, dom.max, base, top), colNames);
  const half = f.step * 0.45;
  let r = gal ? 0.55 : 1.4 * (25.4 / 72);

  const cols = perGroup
    ? groups.map((g, gi) => g.values.map((v, vi) => ({ v, gi, vi, y: f.sy(v) })))
    : [groups.flatMap((g, gi) => g.values.map((v, vi) => ({ v, gi, vi, y: f.sy(v) })))];
  let placed = cols.map((c) => swarm(c, r));
  for (let k = 0; k < 4; k++) {
    const wing = Math.max(...placed.flatMap((p) => p.map((q) => Math.abs(q.x)))) + r;
    if (wing <= half || r <= MIN_R_MM) break;
    r = Math.max(MIN_R_MM, r * (half / wing));
    placed = cols.map((c) => swarm(c, r));
  }
  const wing = Math.max(...placed.flatMap((p) => p.map((q) => Math.abs(q.x)))) + r;
  if (wing > half + 1e-9) report(ctx, "S-07.overflow", `kawanan selebar ${(2 * wing).toFixed(1)} mm melampaui kolom ${(2 * half).toFixed(1)} mm; kurangi titik atau perlebar gambar`);
  const bad = placed.reduce((s, p) => s + overlaps(p, r), 0);
  if (bad > 0) report(ctx, "S-07.noOverlap", `${bad} pasang titik bertumpuk`);
  else ran(ctx, "S-07.noOverlap");

  placed.forEach((col, ci) => {
    const gx = f.centre(ci);
    doc.open(`data-column="${ci}"`);
    for (const p of col) {
      const g = groups[p.gi];
      const fill = p.gi === accent ? pal.role.accent : gal ? pal.ink400 : pal.ink700;
      doc.circle(gx + p.x, p.y, r, fill, { mark: { mark: "point", series: g.name, index: p.gi }, attrs: ` data-obs="${p.vi}"` });
    }
    if (medianMarker && perGroup) {
      const g = groups[ci];
      const w = Math.min(half, Math.max(...col.map((q) => Math.abs(q.x))) + r + 0.8);
      const ym = f.sy(median(g.values));
      doc.line(gx - w, ym, gx + w, ym, pal.ink900, gal ? 0.4 : 1.2 * (25.4 / 72), {
        mark: { mark: "segment", series: g.name, index: ci },
        attrs: ' data-stat="median"',
      });
    }
    doc.close();
    columnLabel(ctx, f, gx, colNames[ci], ci);
  });
  if (medianMarker && !perGroup) report(ctx, "S-07.medianMarker", "medianMarker tidak digambar pada satu kawanan gabungan");
}
