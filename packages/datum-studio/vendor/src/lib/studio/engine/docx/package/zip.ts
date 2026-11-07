/**
 * ZIP deterministik untuk paket DOCX (S14, I03): fflate `zipSync`, cap waktu
 * tetap dari `fixedDate`, urutan entri tetap, tingkat kompresi tetap, atribut
 * dan OS asal tetap. Dua panggilan dengan masukan sama menghasilkan byte sama.
 */
import { zipSync, type Zippable } from "fflate";

import { StudioEngineError } from "../../../contract/errors";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Cap waktu entri ZIP. fflate menulis waktu DOS dari getter LOKAL
 * (`getFullYear`, `getHours`, ...), jadi Date dibangun dengan konstruktor
 * lokal agar komponen yang ditulis selalu = fixedDate 12:00:00 apa pun zona
 * waktu server. Pukul 12:00 (bukan 00:00) menghindari jam yang hilang saat
 * transisi DST tengah malam di sebagian zona.
 */
export function zipMtime(fixedDate: string): Date {
  const m = DATE_RE.exec(fixedDate);
  if (!m) {
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `fixedDate harus YYYY-MM-DD, diterima "${fixedDate}"`);
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d, 12, 0, 0, 0);
  if (y < 1980 || y > 2099 || dt.getMonth() !== mo - 1 || dt.getDate() !== d) {
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `fixedDate di luar rentang DOS 1980-2099 atau tidak sah: "${fixedDate}"`);
  }
  return dt;
}

/** Ekstensi yang sudah terkompresi: disimpan tanpa deflate (level 0). */
const STORED_EXT = new Set(["png", "jpg", "jpeg", "gif", "odttf"]);

export interface ZipEntry {
  path: string;
  data: Uint8Array;
}

/**
 * Prioritas entri bagian inti; sisanya diurutkan alami (header2 < header10)
 * dengan pembanding tanpa locale agar deterministik.
 */
const CORE_ORDER = [
  "[Content_Types].xml",
  "_rels/.rels",
  "docProps/core.xml",
  "docProps/app.xml",
  "word/document.xml",
  "word/_rels/document.xml.rels",
  "word/styles.xml",
  "word/settings.xml",
  "word/webSettings.xml",
  "word/fontTable.xml",
  "word/_rels/fontTable.xml.rels",
  "word/numbering.xml",
  "word/theme/theme1.xml",
];

function groupRank(p: string): number {
  const core = CORE_ORDER.indexOf(p);
  if (core >= 0) return core;
  if (/^word\/header\d*\.xml$/.test(p)) return 100;
  if (/^word\/footer\d*\.xml$/.test(p)) return 101;
  if (p.startsWith("word/_rels/")) return 102;
  if (p.startsWith("word/media/")) return 103;
  if (p.startsWith("word/fonts/")) return 104;
  if (p.startsWith("word/")) return 105;
  if (p.startsWith("customXml/")) return 106;
  return 107;
}

/** Pembanding alami tanpa locale: segmen angka dibandingkan numerik. */
export function naturalCompare(a: string, b: string): number {
  const ta = a.match(/\d+|\D+/g) ?? [];
  const tb = b.match(/\d+|\D+/g) ?? [];
  const n = Math.min(ta.length, tb.length);
  for (let i = 0; i < n; i++) {
    const x = ta[i];
    const y = tb[i];
    if (x === y) continue;
    const xd = /^\d/.test(x);
    const yd = /^\d/.test(y);
    if (xd && yd) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
      return x.length - y.length;
    }
    return x < y ? -1 : 1;
  }
  return ta.length - tb.length;
}

export function orderEntries(paths: readonly string[]): string[] {
  return [...paths].sort((a, b) => groupRank(a) - groupRank(b) || naturalCompare(a, b));
}

export function zipDeterministic(entries: readonly ZipEntry[], fixedDate: string): Uint8Array {
  const mtime = zipMtime(fixedDate);
  const byPath = new Map<string, Uint8Array>();
  for (const e of entries) {
    if (byPath.has(e.path)) {
      throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `Entri paket ganda: ${e.path}`);
    }
    byPath.set(e.path, e.data);
  }
  const files: Zippable = {};
  for (const p of orderEntries([...byPath.keys()])) {
    const ext = p.slice(p.lastIndexOf(".") + 1).toLowerCase();
    files[p] = [byPath.get(p) as Uint8Array, { level: STORED_EXT.has(ext) ? 0 : 6, mtime, os: 0, attrs: 0 }];
  }
  return zipSync(files, { level: 6, mtime, os: 0, attrs: 0 });
}
