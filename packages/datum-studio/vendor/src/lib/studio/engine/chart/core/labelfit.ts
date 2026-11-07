/**
 * engine/chart/core — pembantu label sadar-fit (FIG-02a, audit research/18 §6 P1-4..P1-8).
 *
 * Semua pembantu di sini BERPAGAR DUA: (1) hanya bekerja bila `fitActive()` (render ulang
 * setelah lint geometri menemukan cacat; lihat `./fit`), dan (2) hanya mengubah label yang
 * memang tidak muat menurut `textfit`. Di luar itu pembantu mengembalikan `null`/rencana
 * "fit" dan pemanggil memakai jalur gambar lamanya persis (byte-identik).
 *
 * - `gutterPlan`: talang kiri terukur + bungkus 2-3 baris + elipsis (P1-5);
 * - `categoryAxisPlan` / `drawCategoryLabel`: label sumbu kategori bertingkat
 *   muat -> bungkus 2-3 baris -> rotasi -45 derajat -> tipiskan (P1-4);
 * - `legendRows`: baris KUNCI multi-baris (P1-7);
 * - `placePointLabels`: penempatan rakus 8 posisi + penunjuk + `LABEL_DROPPED` (P1-8);
 *   FIG-02c: posisi pilihan per titik (`prefer`) dan rintangan segmen (jalur garis);
 * - `placeValueLabels`: label nilai kolom bertetangga, kandidat berurutan dari pemanggil,
 *   penipisan dengan `LABEL_DROPPED` (FIG-02c);
 */
import { fitActive, fitHidden, fitNote, fitState } from "./fit";
import type { SvgDoc, TextOpts } from "./svg";
import { type FitFont, LINE_HEIGHT_EM, ellipsize, lineHeightMm, measureFont, wrap, wrapEllipsize } from "./textfit";

const MM_PER_PT = 25.4 / 72;

// ── Talang kiri (P1-5) ──────────────────────────────────────────────────────

export interface GutterPlan {
  /** Lebar talang label (mm, dari tepi kiri sampai titik anchor label + celah). */
  gutterMm: number;
  /** Lebar teks maksimum per baris (mm). */
  textMaxMm: number;
  lines: string[][];
  /** Teks lengkap untuk label yang dipotong (atau undefined). */
  titles: (string | undefined)[];
  lineMm: number;
}

/**
 * Rencana talang kiri untuk label kategori baris. `currentMm` = lebar talang jalur lama
 * (teks maksimum = currentMm - padMm). Mengembalikan `null` bila fit tidak aktif atau
 * semua label sudah muat (jalur lama dipakai apa adanya).
 */
/** IMPL-W5 D1: ruang kosong minimum di kiri label kategori terlebar (mm). */
export const LABEL_EDGE_MM = 0.4;

export function gutterPlan(
  labels: readonly string[],
  font: FitFont,
  o: { currentMm: number; capMm: number; padMm: number; pitchMm: number; maxLines?: number },
): GutterPlan | null {
  if (!fitActive() || labels.length === 0) return null;
  const avail = o.currentMm - o.padMm;
  const widths = labels.map((l) => measureFont(l, font));
  const widest = Math.max(0, ...widths);
  if (widest <= avail + 1e-9) return null;
  const lineMm = lineHeightMm(font);
  // IMPL-W10 (review 17 #4): ruang tepi masuk anggaran cap (teks maks = cap - pad - ruang tepi), agar talang <= capMm.
  const textMax = Math.max(avail, Math.min(widest, o.capMm - o.padMm - LABEL_EDGE_MM));
  const maxLines = Math.max(1, Math.min(o.maxLines ?? 3, Math.floor((o.pitchMm + 0.15 * lineMm) / lineMm)));
  const lines: string[][] = [];
  const titles: (string | undefined)[] = [];
  let truncated = 0;
  labels.forEach((l, i) => {
    if (widths[i] <= textMax + 1e-9) {
      lines.push([l]);
      titles.push(undefined);
      return;
    }
    const w = wrapEllipsize(l, textMax, maxLines, font);
    lines.push(w.lines);
    titles.push(w.truncated ? l : undefined);
    if (w.truncated) truncated++;
  });
  // IMPL-W5 D1: talang = label terlebar + jarak ke plot + ruang tepi kiri, agar glif pertama label terlebar tidak
  // menempel/terpotong di tepi gambar saat dirasterisasi (sebelumnya tepi kiri label = tepat 0 mm).
  // IMPL-W10: tidak pernah melampaui capMm, kecuali talang lama (avail) sendiri sudah lebih lebar dari cap.
  const used = Math.max(0, ...lines.flat().map((s) => measureFont(s, font))) + LABEL_EDGE_MM;
  const gutterMm = Math.min(used + o.padMm, Math.max(o.capMm, textMax + o.padMm));
  fitNote("LABEL_GUTTER", `talang label kiri diukur: ${gutterMm.toFixed(1)} mm${truncated ? `, ${truncated} label dipotong (teks lengkap di <title>)` : ""}`);
  return { gutterMm, textMaxMm: textMax, lines, titles, lineMm };
}

/** Gambar label baris dari `gutterPlan`, tegak-tengah pada `baseline` satu baris lama. */
export function drawGutterLabel(doc: SvgDoc, plan: GutterPlan, i: number, x: number, baseline: number, o: TextOpts): void {
  const ls = plan.lines[i];
  const y = baseline - ((ls.length - 1) * plan.lineMm) / 2;
  doc.textLines(x, y, ls, o, plan.lineMm, plan.titles[i]);
}

// ── Label sumbu kategori bertingkat (P1-4) ──────────────────────────────────

export interface CategoryAxisPlan {
  mode: "wrap" | "rotate";
  /** Baris per label (mode wrap); label satu baris untuk rotate. */
  lines: string[][];
  titles: (string | undefined)[];
  lineMm: number;
  /** Tinggi pita label di bawah garis dasar baris pertama lama (mm), tambahan dari pita lama. */
  extraBandMm: number;
  /** Tampilkan label ke-i bila `i % every === 0` (penipisan). */
  every: number;
  font: FitFont;
}

/**
 * Rencana label sumbu kategori di bawah plot. `slotMm` = jarak antar pusat slot; `bandMm` =
 * tinggi pita label lama (satu baris). Urutan: semua muat satu baris -> `null` (jalur lama);
 * bungkus <= `maxLines` baris di lebar slot; rotasi -45 derajat (pita = proyeksi vertikal label
 * terpanjang, dijepit `maxRotateBandMm`, label dipotong bila perlu); bila slot < tinggi huruf,
 * tipiskan (tiap k).
 */
export function categoryAxisPlan(
  labels: readonly string[],
  slotMm: number,
  font: FitFont,
  o: { maxLines?: number; maxRotateBandMm: number; gapMm?: number },
): CategoryAxisPlan | null {
  if (!fitActive() || labels.length === 0) return null;
  const gap = o.gapMm ?? 0.8;
  const avail = slotMm - gap;
  const widths = labels.map((l) => measureFont(l, font));
  if (Math.max(...widths) <= avail + 1e-9) return null;
  const lineMm = lineHeightMm(font);
  const maxLines = o.maxLines ?? 3;
  // Tingkat 2: bungkus dalam slot.
  const wrapped = labels.map((l) => wrap(l, avail, maxLines, font));
  if (avail > 0 && wrapped.every((w) => w.fits)) {
    const n = Math.max(...wrapped.map((w) => w.lines.length));
    fitNote("AXIS_LABEL_WRAP", `label sumbu kategori dibungkus ${n} baris`);
    return { mode: "wrap", lines: wrapped.map((w) => w.lines), titles: labels.map(() => undefined), lineMm, extraBandMm: (n - 1) * lineMm, every: 1, font };
  }
  // Tingkat 3-4: rotasi -45 derajat; tipiskan bila slot terlalu rapat untuk tinggi huruf.
  const capH = font.pt * MM_PER_PT;
  const every = Math.max(1, Math.ceil((capH * 1.25 * Math.SQRT2) / Math.max(1e-6, slotMm)));
  const maxLen = o.maxRotateBandMm * Math.SQRT2;
  const lines: string[][] = [];
  const titles: (string | undefined)[] = [];
  let cut = 0;
  for (const l of labels) {
    const e = ellipsize(l, maxLen, font);
    lines.push([e.text]);
    titles.push(e.truncated ? l : undefined);
    if (e.truncated) cut++;
  }
  const longest = Math.max(...lines.map((ls) => measureFont(ls[0], font)));
  const band = Math.min(o.maxRotateBandMm, longest / Math.SQRT2) + capH * 0.7;
  fitNote(
    "AXIS_LABEL_ROTATE",
    `label sumbu kategori diputar -45 derajat${every > 1 ? `, ditampilkan tiap ${every}` : ""}${cut ? `, ${cut} dipotong (teks lengkap di <title>)` : ""}`,
  );
  return { mode: "rotate", lines, titles, lineMm, extraBandMm: Math.max(0, band - capH), every, font };
}

/**
 * Gambar label kategori ke-i menurut rencana. `y` = garis dasar baris pertama jalur lama,
 * `o.anchor` diabaikan (wrap: tengah; rotate: ujung kanan di pusat slot).
 */
export function drawCategoryLabel(doc: SvgDoc, plan: CategoryAxisPlan, i: number, cx: number, y: number, o: TextOpts): void {
  if (i % plan.every !== 0) return;
  if (plan.mode === "wrap") {
    // Slot pertama/terakhir: blok dijaga di dalam kanvas (P1-6).
    const half = Math.max(0, ...plan.lines[i].map((l) => measureFont(l, plan.font))) / 2;
    const W = fitState()?.widthMm ?? doc.widthMm;
    const x = half * 2 < W - 0.8 ? Math.min(Math.max(cx, half + 0.4), W - 0.4 - half) : cx;
    doc.textLines(x, y, plan.lines[i], { ...o, anchor: "middle" }, plan.lineMm, plan.titles[i]);
    return;
  }
  const capH = o.sizePt * MM_PER_PT;
  const yr = y - capH * 0.35;
  const attrs = `${o.attrs ?? ""} transform="rotate(-45 ${fmt(cx)} ${fmt(yr)})"`;
  // Label miring menggantung ke kiri bawah: panjangnya tidak boleh melewati tepi kiri kanvas.
  let text = plan.lines[i][0];
  let title = plan.titles[i];
  const room = (cx - 0.6) * Math.SQRT2 - capH;
  if (measureFont(text, plan.font) > room) {
    text = ellipsize(title ?? text, Math.max(room, 0), plan.font).text;
    title = title ?? plan.lines[i][0];
  }
  doc.textLines(cx + capH * 0.3, yr + capH * 0.35, [text], { ...o, anchor: "end", attrs }, plan.lineMm, title);
}

function fmt(v: number): string {
  const r = Number(v.toFixed(4));
  return Object.is(r, -0) || r === 0 ? "0" : String(r);
}

// ── Legenda multi-baris (P1-7) ──────────────────────────────────────────────

export interface LegendItemPos {
  /** Indeks item. */
  i: number;
  row: number;
  /** x awal item (petak warna) relatif ke x kiri baris. */
  dx: number;
  /** Teks item (mungkin dipotong). */
  label: string;
  title?: string;
}

/**
 * Bagi item legenda ke beberapa baris selebar <= `maxW` (mm). `lead` = lebar awalan baris
 * pertama (mis. "KUNCI"); `itemW(label)` = lebar item (petak + celah + teks + jarak). Item yang
 * lebih lebar dari baris dipotong elipsis. `null` bila fit tidak aktif atau semua muat satu baris.
 */
export function legendRows(
  labels: readonly string[],
  maxW: number,
  font: FitFont,
  o: { lead: number; swatch: number; gap: number; after: number },
): { rows: number; items: LegendItemPos[] } | null {
  if (!fitActive() || labels.length === 0) return null;
  const itemW = (l: string): number => o.swatch + o.gap + measureFont(l, font) + o.after;
  const total = o.lead + labels.reduce((a, l) => a + itemW(l), 0) - o.after;
  if (total <= maxW + 1e-9) return null;
  const items: LegendItemPos[] = [];
  let row = 0;
  let x = o.lead;
  labels.forEach((l0, i) => {
    let label = l0;
    let title: string | undefined;
    const room = maxW - o.lead - o.swatch - o.gap;
    if (measureFont(label, font) > room) {
      const e = ellipsize(label, room, font);
      label = e.text;
      title = l0;
    }
    const w = itemW(label);
    if (x > o.lead + 1e-9 && x + w - o.after > maxW + 1e-9) {
      row++;
      x = o.lead;
    }
    items.push({ i, row, dx: x, label, title });
    x += w;
  });
  fitNote("LEGEND_WRAP", `baris KUNCI dibungkus menjadi ${row + 1} baris`);
  return { rows: row + 1, items };
}

// ── Label titik tanpa tabrakan (P1-8) ───────────────────────────────────────

export interface PointLabelIn {
  x: number;
  y: number;
  /** Jari-jari tanda titik (mm). */
  r: number;
  text: string;
  /** FIG-02c: posisi pilihan (mis. offset anotasi acuan) yang dicoba sebelum 8 posisi. */
  prefer?: { x: number; y: number; anchor: "start" | "middle" | "end" };
}

export interface PointLabelOut {
  /** null = label disembunyikan (LABEL_DROPPED). */
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
  /** Garis penunjuk dari tepi titik ke label (posisi jauh). */
  leader?: { x1: number; y1: number; x2: number; y2: number };
}

type Box = [number, number, number, number];

/** Segmen garis (x1, y1, x2, y2) sebagai rintangan label (FIG-02c). */
export type Segment = readonly [number, number, number, number];

function hit(a: Box, b: Box): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

/** Segmen memotong kotak (kliping Liang-Barsky); `pad` memperlebar kotak. */
export function segmentHitsBox(s: Segment, b: readonly [number, number, number, number], pad = 0): boolean {
  const [x1, y1, x2, y2] = s;
  const dx = x2 - x1;
  const dy = y2 - y1;
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [
    [-dx, x1 - (b[0] - pad)],
    [dx, b[2] + pad - x1],
    [-dy, y1 - (b[1] - pad)],
    [dy, b[3] + pad - y1],
  ];
  for (const [p, q] of edges) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
  }
  return t0 <= t1;
}

/**
 * Penempatan rakus label titik: 8 posisi di sekitar titik (kanan, kiri, atas, bawah, lalu
 * diagonal), kemudian cincin kedua berjarak 2,5 x dengan garis penunjuk. Posisi tidak boleh
 * menabrak label lain, titik mana pun, `obstacles`, segmen `segments`, atau keluar `bounds`.
 * Label tanpa posisi bebas disembunyikan dan dihitung untuk REPORT `LABEL_DROPPED`. Urutan
 * masukan = prioritas. `prefer` (FIG-02c, bila ada) dicoba lebih dulu.
 */
export function placePointLabels(
  pts: readonly PointLabelIn[],
  font: FitFont,
  bounds: Box,
  obstacles: readonly Box[] = [],
  segments: readonly Segment[] = [],
): (PointLabelOut | null)[] {
  const capH = font.pt * MM_PER_PT;
  const placed: Box[] = [];
  const dots: Box[] = pts.map((p) => [p.x - p.r, p.y - p.r, p.x + p.r, p.y + p.r]);
  const out: (PointLabelOut | null)[] = [];
  let dropped = 0;
  for (const p of pts) {
    const w = measureFont(p.text, font);
    const h = capH * LINE_HEIGHT_EM * 0.85;
    const boxAt = (lx: number, ly: number, anchor: "start" | "middle" | "end"): Box => {
      const x0 = anchor === "start" ? lx : anchor === "end" ? lx - w : lx - w / 2;
      return [x0 - 0.2, ly - capH * 0.9, x0 + w + 0.2, ly - capH * 0.9 + h];
    };
    const free = (b: Box): boolean =>
      !(b[0] < bounds[0] || b[1] < bounds[1] || b[2] > bounds[2] || b[3] > bounds[3]) &&
      !placed.some((q) => hit(q, b)) &&
      !dots.some((q) => hit(q, b)) &&
      !obstacles.some((q) => hit(q, b)) &&
      !segments.some((sg) => segmentHitsBox(sg, b));
    let done: PointLabelOut | null = null;
    if (p.prefer) {
      const b = boxAt(p.prefer.x, p.prefer.y, p.prefer.anchor);
      if (free(b)) {
        placed.push(b);
        done = { x: p.prefer.x, y: p.prefer.y, anchor: p.prefer.anchor };
      }
    }
    for (const ring of [1, 2.5]) {
      if (done) break;
      const d = (p.r + 0.8) * ring;
      const cands: [number, number, "start" | "middle" | "end"][] = [
        [p.x + d, p.y + capH * 0.35, "start"],
        [p.x - d, p.y + capH * 0.35, "end"],
        [p.x, p.y - d - capH * 0.15, "middle"],
        [p.x, p.y + d + capH * 0.85, "middle"],
        [p.x + d * 0.75, p.y - d * 0.75, "start"],
        [p.x - d * 0.75, p.y - d * 0.75, "end"],
        [p.x + d * 0.75, p.y + d * 0.75 + capH * 0.7, "start"],
        [p.x - d * 0.75, p.y + d * 0.75 + capH * 0.7, "end"],
      ];
      for (const [lx, ly, anchor] of cands) {
        const b = boxAt(lx, ly, anchor);
        if (!free(b)) continue;
        placed.push(b);
        done = { x: lx, y: ly, anchor };
        if (ring > 1) {
          const cx = (b[0] + b[2]) / 2;
          const cy = (b[1] + b[3]) / 2;
          const L = Math.hypot(cx - p.x, cy - p.y) || 1;
          done.leader = { x1: p.x + ((cx - p.x) / L) * p.r, y1: p.y + ((cy - p.y) / L) * p.r, x2: p.x + ((cx - p.x) / L) * (d - 0.6), y2: p.y + ((cy - p.y) / L) * (d - 0.6) };
        }
        break;
      }
    }
    if (!done) dropped++;
    out.push(done);
  }
  fitHidden(dropped);
  if (dropped) fitNote("LABEL_DROPPED", `${dropped} label titik disembunyikan karena tidak ada posisi bebas (persingkat label atau kurangi jumlah titik berlabel)`);
  return out;
}

// ── Label nilai bertetangga (FIG-02c) ───────────────────────────────────────

export interface ValueLabelPos {
  x: number;
  /** Garis dasar. */
  y: number;
  anchor: "start" | "middle" | "end";
}

export interface ValueLabelIn {
  text: string;
  /** Kandidat berurutan; `cands[0]` = posisi jalur lama. */
  cands: readonly ValueLabelPos[];
  /** Prioritas penempatan (besar dulu; seri: indeks). Bawaan 0. */
  priority?: number;
}

/** Kotak tinta satu baris label (anchor + garis dasar), selaras kotak lint geometri. */
function inkBox(x: number, y: number, anchor: "start" | "middle" | "end", w: number, capH: number, pad: number): Box {
  const x0 = anchor === "start" ? x : anchor === "end" ? x - w : x - w / 2;
  return [x0 - pad, y - capH * 0.9, x0 + w + pad, y + capH * 0.15];
}

/**
 * Label nilai bertetangga tanpa tumpuk (P-05 "maks", P-07 rentang, P-10 delta waterfall).
 *
 * Berpagar dua seperti pembantu lain: `null` bila fit tidak aktif, atau bila semua label pada
 * posisi lamanya (`cands[0]`) sudah bebas dari label lain, rintangan, dan batas — pemanggil
 * lalu memakai jalur lamanya apa adanya. Selain itu label ditempatkan rakus menurut prioritas:
 * kandidat pertama yang bebas dipakai; label tanpa kandidat bebas disembunyikan (`null`) dan
 * dilaporkan `LABEL_DROPPED` (nilainya tetap ada di data spec / teks alternatif).
 * Deterministik: urutan = prioritas lalu indeks.
 */
export function placeValueLabels(
  items: readonly ValueLabelIn[],
  font: FitFont,
  bounds: Box,
  obstacles: readonly Box[] = [],
  what = "label nilai",
): (ValueLabelPos | null)[] | null {
  if (!fitActive() || items.length === 0) return null;
  const capH = font.pt * MM_PER_PT;
  const PAD = 0.15;
  const widths = items.map((it) => measureFont(it.text, font));
  const inBounds = (b: Box): boolean => b[0] >= bounds[0] - 1e-9 && b[1] >= bounds[1] - 1e-9 && b[2] <= bounds[2] + 1e-9 && b[3] <= bounds[3] + 1e-9;
  const boxOf = (i: number, c: ValueLabelPos): Box => inkBox(c.x, c.y, c.anchor, widths[i], capH, PAD);
  // Pagar lokal: semua posisi lama bebas -> jalur lama.
  const first = items.map((it, i) => (it.cands.length ? boxOf(i, it.cands[0]) : null));
  const clean = first.every(
    (b, i) => b !== null && inBounds(b) && !obstacles.some((o) => hit(o, b)) && !first.some((q, j) => j !== i && q !== null && hit(q, b)),
  );
  if (clean) return null;
  const order = items.map((it, i) => ({ i, p: it.priority ?? 0 })).sort((a, b) => b.p - a.p || a.i - b.i);
  const placed: Box[] = [];
  const out: (ValueLabelPos | null)[] = items.map(() => null);
  let dropped = 0;
  let moved = 0;
  for (const { i } of order) {
    let done = false;
    for (let k = 0; k < items[i].cands.length; k++) {
      const c = items[i].cands[k];
      const b = boxOf(i, c);
      if (!inBounds(b) || obstacles.some((o) => hit(o, b)) || placed.some((q) => hit(q, b))) continue;
      placed.push(b);
      out[i] = c;
      if (k > 0) moved++;
      done = true;
      break;
    }
    if (!done) dropped++;
  }


  if (moved) fitNote("VALUE_LABEL_MOVED", `${moved} ${what} dipindah ke posisi bebas tabrakan`);
  fitHidden(dropped);
  if (dropped) {
    fitNote("LABEL_DROPPED", `${dropped} ${what} disembunyikan karena tidak ada posisi bebas (nilai tetap ada di data/teks alternatif; persingkat satuan atau kurangi kategori)`);
  }
  return out;
}
