/**
 * engine/chart/family-w2 — sumbu waktu berformat Indonesia (S40).
 *
 * Nilai waktu: angka (minggu/hari/jam proyek, ditulis dengan `fmt` DATUM: ribuan "."
 * dan desimal ",") atau string ISO `YYYY-MM-DD` / `YYYY-MM`. Tanggal dihitung sebagai
 * nomor hari UTC (tanpa zona waktu, tanpa `Date.now`), sehingga keluaran deterministik.
 * Label bulan memakai singkatan Indonesia (Jan, Feb, Mar, Apr, Mei, Jun, Jul, Agu, Sep,
 * Okt, Nov, Des); tanggal "5 Jan", bulan "Mar" (tahun ditambahkan pada label pertama
 * dan pada Januari: "Jan 2026").
 */
import { StudioEngineError } from "../../../contract/errors";
import { fmt } from "../../bind";
import { decimalsFor, niceStep } from "../core/scale";

export const MONTHS_ID_SHORT = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"] as const;

const MS_PER_DAY = 86_400_000;
const ISO_RE = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/;
const NUM_RE = /^\s*[-+]?(?:\d+\.?\d*|\.\d+)\s*$/;

export type TimeKind = "num" | "date";

interface Ymd {
  y: number;
  m: number;
  d: number;
}

function ymdOf(day: number): Ymd {
  const dt = new Date(day * MS_PER_DAY);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function dayOf(y: number, m: number, d: number): number {
  return Math.round(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

/** Nomor hari UTC dari ISO `YYYY-MM-DD` / `YYYY-MM` (hari 1); `undefined` bila bukan ISO sah. */
export function parseIsoDay(s: string): { day: number; precision: "day" | "month" } | undefined {
  const m = ISO_RE.exec(s.trim());
  if (!m) return undefined;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = m[3] === undefined ? 1 : Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  const day = dayOf(y, mo, d);
  const back = ymdOf(day);
  if (back.y !== y || back.m !== mo || back.d !== d) return undefined;
  return { day, precision: m[3] === undefined ? "month" : "day" };
}

/** Nilai waktu satu titik: angka apa adanya, string angka, atau ISO -> nomor hari. */
export function parseTimeValue(v: unknown, where: string): { kind: TimeKind; value: number } {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new StudioEngineError("SCHEMA_INVALID", `${where}: waktu bukan bilangan hingga`);
    return { kind: "num", value: v };
  }
  if (typeof v === "string") {
    const iso = parseIsoDay(v);
    if (iso) return { kind: "date", value: iso.day };
    if (NUM_RE.test(v)) return { kind: "num", value: Number(v) };
  }
  throw new StudioEngineError("SCHEMA_INVALID", `${where}: waktu ${JSON.stringify(v)} bukan angka maupun tanggal ISO YYYY-MM-DD / YYYY-MM`);
}

/** "5 Jan" atau "5 Jan 2026". */
export function dayLabel(day: number, withYear = false): string {
  const t = ymdOf(day);
  return `${t.d} ${MONTHS_ID_SHORT[t.m - 1]}${withYear ? ` ${t.y}` : ""}`;
}

/** "Mar" atau "Mar 2026". */
export function monthLabel(day: number, withYear = false): string {
  const t = ymdOf(day);
  return `${MONTHS_ID_SHORT[t.m - 1]}${withYear ? ` ${t.y}` : ""}`;
}

/** Label nilai waktu tunggal (rentang tugas, garis hari ini). */
export function timeValueLabel(kind: TimeKind, v: number): string {
  if (kind === "date") return dayLabel(v);
  return fmt(v, decimalsOf(v));
}

function decimalsOf(v: number): number {
  for (let d = 0; d <= 3; d++) {
    if (Math.abs(Number(v.toFixed(d)) - v) < 1e-9) return d;
  }
  return 3;
}

/**
 * Label kategori (bump, candlestick): ISO hari -> "5 Jan", ISO bulan -> "Mar"
 * (tahun pada label pertama dan Januari), selain itu teks apa adanya.
 */
export function categoryLabels(cats: readonly string[]): string[] {
  let first = true;
  return cats.map((c) => {
    const iso = parseIsoDay(c);
    if (!iso) return c;
    const isFirst = first;
    first = false;
    return iso.precision === "month" ? monthLabel(iso.day, isFirst || ymdOf(iso.day).m === 1) : dayLabel(iso.day, isFirst);
  });
}

export interface TimeAxis {
  min: number;
  max: number;
  ticks: number[];
  labels: string[];
}

/**
 * Sumbu waktu. Angka: domain rapi (kelipatan langkah 1/2/2,5/5 x 10^k) yang memuat
 * semua nilai; nol dimuat bila semua nilai >= 0 dan nilai terkecil <= separuh rentang.
 * Tanggal: domain = rentang data, tick hari/minggu (Senin)/bulan/tahun menurut rentang.
 */
export function timeAxis(kind: TimeKind, values: readonly number[], target = 5): TimeAxis {
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (kind === "num") {
    if (lo >= 0 && lo <= (hi - lo) / 2) lo = 0;
    if (lo === hi) hi = lo + 1;
    const step = niceStep(hi - lo, target);
    const i0 = Math.floor(lo / step + 1e-9);
    const i1 = Math.ceil(hi / step - 1e-9);
    const dec = decimalsFor(step);
    const ticks: number[] = [];
    for (let i = i0; i <= i1; i++) ticks.push(Number((i * step).toFixed(dec)));
    return { min: ticks[0], max: ticks[ticks.length - 1], ticks, labels: ticks.map((t) => fmt(t, dec)) };
  }
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const span = hi - lo;
  const ticks: number[] = [];
  const labels: string[] = [];
  if (span <= 120) {
    const step = [1, 2, 7, 14].find((s) => span / s <= target + 1) ?? 14;
    // Langkah mingguan berlabuh pada Senin (1970-01-01 = Kamis -> hari 4 = Senin).
    const anchor = step >= 7 ? 4 : 0;
    let t = Math.ceil((lo - anchor) / step) * step + anchor;
    for (; t <= hi; t += step) ticks.push(t);
    ticks.forEach((t, i) => labels.push(dayLabel(t, i === 0)));
  } else if (span <= 1100) {
    const months = span / 30.44;
    const step = [1, 2, 3, 6].find((s) => months / s <= target + 1) ?? 6;
    const a = ymdOf(lo);
    let y = a.y;
    let m = a.m;
    if (dayOf(y, m, 1) < lo) m += 1;
    for (;;) {
      if (m > 12) {
        y += Math.floor((m - 1) / 12);
        m = ((m - 1) % 12) + 1;
      }
      const t = dayOf(y, m, 1);
      if (t > hi) break;
      if ((m - 1) % step === 0) ticks.push(t);
      m += 1;
    }
    ticks.forEach((t, i) => labels.push(monthLabel(t, i === 0 || ymdOf(t).m === 1)));
  } else {
    const years = span / 365.25;
    const step = [1, 2, 5, 10, 20, 50].find((s) => years / s <= target + 1) ?? 50;
    let y = Math.ceil(ymdOf(lo).y / step) * step;
    for (; dayOf(y, 1, 1) <= hi; y += step) {
      const t = dayOf(y, 1, 1);
      if (t >= lo) ticks.push(t);
    }
    ticks.forEach((t) => labels.push(String(ymdOf(t).y)));
  }
  return { min: lo, max: hi, ticks, labels };
}
