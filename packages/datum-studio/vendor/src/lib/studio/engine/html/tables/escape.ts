/**
 * Escape teks dan atribut HTML untuk modul engine/html/tables (S23).
 *
 * `escapeHtml` dan `attr` diambil dari `../blocks/escape` (S22, D-46) — berkas
 * itu sengaja dipisah dari indeks blok agar tidak terjadi siklus impor
 * blocks <-> tables. Pembantu khusus tabel/figur ditambahkan di sini.
 */
import { attr as blocksAttr, escapeHtml } from "../blocks/escape";

/** Escape teks untuk isi elemen dan nilai atribut berkutip ganda. */
export function escText(s: string): string {
  return escapeHtml(s);
}

/** Atribut `name="value"`; nilai undefined/kosong dilewati. */
export const attr = blocksAttr;

const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** Nilai string CSS di dalam kutip tunggal (nama keluarga fon). */
export function cssString(s: string): string {
  return `'${String(s).replace(CONTROL_RE, "").replace(/[\r\n]/g, " ").replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/[<>]/g, "")}'`;
}

/** Penanda id aman untuk prefiks id SVG (huruf, angka, `-`, `_`). */
export function safeIdent(s: string): string {
  const out = String(s).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return out.length > 0 ? out.slice(0, 64) : "x";
}
