/**
 * Tanggal kontrak (register 05 §5.3 C37 / `isoDate`, CH-03; DC-07).
 * Murni. Pola tidak cukup untuk kalender (mis. `2026-02-30` lolos pola, NV-05),
 * sehingga tanggal diperiksa ulang di sini. Penguraian manual (bukan `Date.parse`)
 * agar normalisasi UTC deterministik lintas runtime.
 */
import { CONTRACT_REPORTED_AT_PATTERN } from "../../contract/env";

/** Pola `due` / `items[].due` (`isoDate` common v2). */
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const REPORTED_AT_RE = new RegExp(CONTRACT_REPORTED_AT_PATTERN);
/** Pecahan C37: tanggal, jam, menit, detik?, milidetik?, zona?. Dipakai hanya setelah REPORTED_AT_RE lulus. */
const REPORTED_AT_PARTS_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2})))?$/;

/**
 * Satu-satunya validator hari kalender Gregorius Studio (CH-03 CONTRACT_DATE; FIX-R40-3):
 * dipakai juga impor kontrak (`import/contract/parse.ts`), filter R21 (`query/filters.ts`),
 * dan nama final I60 (`render/final-name.ts`). Tabel hari per bulan (bukan `Date.UTC`, yang
 * memetakan tahun 0-99 ke 1900-1999), jadi berlaku untuk tahun 0000-9999.
 */
export function isCalendarDay(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return d <= days;
}

/** `YYYY-MM-DD` yang ada di kalender Gregorius. */
export function isContractDate(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = ISO_DATE_RE.exec(v);
  return m !== null && isCalendarDay(Number(m[1]), Number(m[2]), Number(m[3]));
}

/** `reportedAt` sah: pola C37 dan tanggalnya ada di kalender. */
export function isContractReportedAt(v: unknown): v is string {
  if (typeof v !== "string" || !REPORTED_AT_RE.test(v)) return false;
  const m = REPORTED_AT_PARTS_RE.exec(v);
  return m !== null && isCalendarDay(Number(m[1]), Number(m[2]), Number(m[3]));
}

/**
 * `reportedAt` -> instan UTC. Tanpa zona (tanggal saja) = tengah malam UTC.
 * Melempar bila nilai tidak sah (pemanggil wajib menjalankan I54 lebih dulu).
 */
export function reportedAtToUtc(v: string): Date {
  const m = isContractReportedAt(v) ? REPORTED_AT_PARTS_RE.exec(v) : null;
  if (!m) throw new Error(`reportedAt tidak sah: ${JSON.stringify(v)}`);
  const [, y, mo, d, hh = "0", mi = "0", ss = "0", ms = "0", zone, sign, oh = "0", om = "0"] = m;
  const msNorm = Number(ms.padEnd(3, "0"));
  const local = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi), Number(ss), msNorm);
  const offsetMin = zone && zone !== "Z" ? (sign === "-" ? -1 : 1) * (Number(oh) * 60 + Number(om)) : 0;
  return new Date(local - offsetMin * 60_000);
}

/** `YYYY-MM-DD` -> Date tengah malam UTC (kolom `@db.Date`). Melempar bila tidak sah. */
export function contractDateToUtc(v: string): Date {
  if (!isContractDate(v)) throw new Error(`tanggal tidak sah: ${JSON.stringify(v)}`);
  const [y, m, d] = v.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
