/**
 * engine/chart/family-w1 — sumbu x waktu (S39).
 *
 * Kategori `ChartData` adalah string. Jenis sumbu dideteksi dari SEMUA kategori:
 * - `YYYY-MM-DD` (tanggal ISO sah, naik ketat) -> "date-day": posisi = hari sejak epoch
 *   (interval tak seragam digambar proporsional), label "15 Jan", baris tahun;
 * - `YYYY-MM` (naik ketat) -> "date-month": posisi = indeks bulan, label "Jan", baris tahun;
 * - angka ("0", "12", "2,5"; naik ketat) -> "numeric": posisi = nilai, tick rapi
 *   1-2-2,5-5 x 10^k berformat DATUM;
 * - selain itu -> "ordinal": posisi = indeks, label apa adanya ("Jan", "Q1").
 * Nama bulan Indonesia singkat: Jan Feb Mar Apr Mei Jun Jul Agu Sep Okt Nov Des.
 * Tahun dicetak pada baris kedua di tick pertama dan setiap pergantian tahun.
 * Pemilihan tick: deterministik (setiap k kategori, + kategori terakhir bila berjarak
 * >= k/2), tanpa waktu sistem.
 */
import { fmt } from "../../bind";
import { decimalsFor, niceStep } from "../core/scale";
import { textWidthMm } from "../core/svg";

export const MONTHS_ID_SHORT = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"] as const;

export type XKind = "date-day" | "date-month" | "numeric" | "ordinal";

export interface XTick {
  pos: number;
  label: string;
  /** Baris tahun (hanya sumbu tanggal). */
  year?: string;
}

export interface XAxisModel {
  kind: XKind;
  /** Posisi domain per kategori (urutan data). */
  pos: number[];
  /** Label terformat per kategori (dipakai untuk pencocokan aksen dan tick). */
  labels: string[];
  ticks: XTick[];
}

interface YMD {
  y: number;
  m: number;
  d?: number;
}

function parseDay(s: string): YMD | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return undefined;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? { y, m: mo, d } : undefined;
}

function parseMonth(s: string): YMD | undefined {
  const m = /^(\d{4})-(\d{2})$/.exec(s.trim());
  if (!m) return undefined;
  const mo = Number(m[2]);
  return mo >= 1 && mo <= 12 ? { y: Number(m[1]), m: mo } : undefined;
}

function parseNumber(s: string): number | undefined {
  const t = s.trim();
  if (!/^-?\d+([.,]\d+)?$/.test(t)) return undefined;
  const v = Number(t.replace(",", "."));
  return Number.isFinite(v) ? v : undefined;
}

function strictlyIncreasing(v: readonly number[]): boolean {
  for (let i = 1; i < v.length; i++) if (!(v[i] > v[i - 1])) return false;
  return true;
}

/** Tanggal ISO singkat Indonesia: "2026-01-15" -> "15 Jan 2026", "2026-08" -> "Agu 2026"; lainnya apa adanya. */
export function formatTanggalSingkat(iso: string): string {
  const d = parseDay(iso);
  if (d) return `${d.d} ${MONTHS_ID_SHORT[d.m - 1]} ${d.y}`;
  const m = parseMonth(iso);
  if (m) return `${MONTHS_ID_SHORT[m.m - 1]} ${m.y}`;
  return iso;
}

function classify(cats: readonly string[]): { kind: XKind; pos: number[]; labels: string[]; years?: number[] } {
  const days = cats.map(parseDay);
  if (days.every((d) => d !== undefined)) {
    const ds = days as YMD[];
    const pos = ds.map((d) => Date.UTC(d.y, d.m - 1, d.d ?? 1) / 86_400_000);
    if (strictlyIncreasing(pos)) {
      return { kind: "date-day", pos, labels: ds.map((d) => `${d.d} ${MONTHS_ID_SHORT[d.m - 1]}`), years: ds.map((d) => d.y) };
    }
  }
  const months = cats.map(parseMonth);
  if (months.every((d) => d !== undefined)) {
    const ms = months as YMD[];
    const pos = ms.map((d) => d.y * 12 + (d.m - 1));
    if (strictlyIncreasing(pos)) {
      return { kind: "date-month", pos, labels: ms.map((d) => MONTHS_ID_SHORT[d.m - 1]), years: ms.map((d) => d.y) };
    }
  }
  const nums = cats.map(parseNumber);
  if (nums.every((v) => v !== undefined) && strictlyIncreasing(nums as number[])) {
    return { kind: "numeric", pos: nums as number[], labels: [...cats] };
  }
  return { kind: "ordinal", pos: cats.map((_, i) => i), labels: [...cats] };
}

/**
 * Model sumbu x untuk lebar plot `plotWmm` dan ukuran huruf tick `tickPt`.
 * `face` = wajah label tick (lebar taksiran).
 */
export function buildXAxis(cats: readonly string[], plotWmm: number, tickPt: number, face: "struct" | "data"): XAxisModel {
  const c = classify(cats);
  const n = cats.length;
  const ticks: XTick[] = [];
  if (c.kind === "numeric") {
    const lo = c.pos[0];
    const hi = c.pos[n - 1];
    const sample = [fmt(lo, 0), fmt(hi, 0)];
    const need = Math.max(...sample.map((s) => textWidthMm(s, tickPt, face))) + 4;
    const target = Math.max(2, Math.min(8, Math.floor(plotWmm / need)));
    const step = niceStep(hi - lo, target);
    const dec = decimalsFor(step);
    const i0 = Math.ceil(lo / step - 1e-9);
    const i1 = Math.floor(hi / step + 1e-9);
    for (let i = i0; i <= i1; i++) {
      const t = Number((i * step).toFixed(dec));
      ticks.push({ pos: t, label: fmt(t, dec) });
    }
    if (n === 1 && ticks.length === 0) ticks.push({ pos: lo, label: cats[0] });
    return { kind: c.kind, pos: c.pos, labels: c.labels, ticks };
  }
  const maxW = Math.max(...c.labels.map((s) => textWidthMm(s, tickPt, face)));
  const spacing = n > 1 ? plotWmm / (n - 1) : plotWmm;
  const k = Math.max(1, Math.ceil((maxW * 2 + 2) / Math.max(spacing, 1e-6)));
  const idx: number[] = [];
  for (let i = 0; i < n; i += k) idx.push(i);
  const last = idx[idx.length - 1];
  // Kategori terakhir ikut bila tidak bertabrakan dengan tick sebelumnya (jarak >= lebar label + 1,5 mm).
  if (last !== n - 1 && (n - 1 - last) * spacing >= maxW + 1.5) idx.push(n - 1);
  let prevYear: number | undefined;
  for (const i of idx) {
    const t: XTick = { pos: c.pos[i], label: c.labels[i] };
    if (c.years) {
      const y = c.years[i];
      if (y !== prevYear) t.year = String(y);
      prevYear = y;
    }
    ticks.push(t);
  }
  return { kind: c.kind, pos: c.pos, labels: c.labels, ticks };
}

/** Indeks kategori dari petunjuk aksen titik (indeks, label mentah, atau label terformat). */
export function categoryIndex(at: string | number, cats: readonly string[], x: XAxisModel): number {
  if (typeof at === "number") return at < cats.length ? at : -1;
  const raw = cats.indexOf(at);
  return raw >= 0 ? raw : x.labels.indexOf(at);
}
