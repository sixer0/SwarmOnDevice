/**
 * Validasi ringan bersama route Studio (IP-08): penjaga tipe, isu berpointer
 * (`ValidationIssue`), JSON Pointer RFC 6901, bilangan bulat positif.
 */
import type { ValidationIssue } from "@/lib/studio/contract/types/api";

/** Objek literal biasa (prototipe Object atau null); array/kelas ditolak. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Objek apa pun selain array/null (hasil JSON.parse selalu memenuhi isPlainObject juga). */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function issue(pointer: string, keyword: string, message: string, checkId?: string): ValidationIssue {
  return checkId ? { pointer, keyword, message, checkId } : { pointer, keyword, message };
}

/** JSON Pointer dari segmen (RFC 6901). */
export function ptr(...segments: Array<string | number>): string {
  return segments.map((s) => "/" + String(s).replace(/~/g, "~0").replace(/\//g, "~1")).join("");
}

/** Bilangan bulat positif dari query (`null` bila absen/kosong, `NaN` bila tidak sah). */
export function positiveIntParam(v: string | null): number | null {
  if (v === null || v === "") return null;
  return /^[1-9][0-9]{0,8}$/.test(v) ? Number(v) : Number.NaN;
}

/** Bilangan bulat positif (number aman atau string desimal); selain itu null. */
export function parsePosInt(v: unknown): number | null {
  if (typeof v === "number") return Number.isSafeInteger(v) && v > 0 ? v : null;
  if (typeof v === "string" && /^[1-9][0-9]{0,8}$/.test(v)) return Number(v);
  return null;
}

/** Id baris (cuid) — bentuk lain tidak mungkin ada di DB. */
export function isPlausibleId(id: unknown, max = 64): id is string {
  return typeof id === "string" && id.length >= 1 && id.length <= max && /^[A-Za-z0-9_-]+$/.test(id);
}
