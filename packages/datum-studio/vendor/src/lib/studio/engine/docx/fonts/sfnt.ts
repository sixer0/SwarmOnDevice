/**
 * Pembaca sfnt minimal (TrueType/OpenType): tabel `name`, `OS/2`, `head`.
 * Hanya untuk mengenali keluarga, bobot, dan gaya berkas fon aset, sehingga
 * pemetaan slot tidak bergantung pada konvensi nama berkas.
 */
import { StudioEngineError } from "../../../contract/errors";

export interface SfntFaceInfo {
  /** nameID 1 (keluarga lama, mis. "IBM Plex Serif SemiBold"). */
  family: string;
  /** nameID 2 (subkeluarga lama). */
  subfamily: string;
  /** nameID 16 (keluarga tipografis) bila ada. */
  typoFamily?: string;
  /** nameID 17 (subkeluarga tipografis) bila ada. */
  typoSubfamily?: string;
  /** nameID 6. */
  postscriptName?: string;
  /** OS/2 usWeightClass (400 bila tabel tidak ada). */
  weightClass: number;
  italic: boolean;
}

const SFNT_VERSIONS = new Set([0x00010000, 0x74727565 /* 'true' */, 0x4f54544f /* 'OTTO' */]);

function fail(why: string, label: string): never {
  throw new StudioEngineError("ASSET_TYPE_UNSUPPORTED", `Berkas fon tidak terbaca (${why}): ${label}`);
}

function decodeUtf16Be(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  return s;
}

function decodeLatin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

interface TableRef {
  offset: number;
  length: number;
}

/** Baca info wajah dari byte TTF/OTF (bukan odttf). `label` hanya untuk pesan galat. */
export function readSfntFaceInfo(data: Uint8Array, label = "fon"): SfntFaceInfo {
  if (data.length < 12) fail("header terlalu pendek", label);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (!SFNT_VERSIONS.has(dv.getUint32(0))) fail("bukan sfnt", label);
  const numTables = dv.getUint16(4);
  if (12 + numTables * 16 > data.length) fail("direktori tabel terpotong", label);

  const tables = new Map<string, TableRef>();
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = decodeLatin1(data.subarray(rec, rec + 4));
    const offset = dv.getUint32(rec + 8);
    const length = dv.getUint32(rec + 12);
    if (offset + length > data.length) fail(`tabel ${tag} di luar berkas`, label);
    tables.set(tag, { offset, length });
  }

  const names = readNames(data, dv, tables.get("name"), label);
  let weightClass = 400;
  let italic = false;
  const os2 = tables.get("OS/2");
  if (os2 && os2.length >= 64) {
    weightClass = dv.getUint16(os2.offset + 4) || 400;
    italic = (dv.getUint16(os2.offset + 62) & 0x01) !== 0;
  } else {
    const head = tables.get("head");
    if (head && head.length >= 46) {
      const macStyle = dv.getUint16(head.offset + 44);
      if (macStyle & 0x01) weightClass = 700;
      italic = (macStyle & 0x02) !== 0;
    }
  }
  const sub = `${names.get(2) ?? ""} ${names.get(17) ?? ""}`;
  if (/italic|oblique/i.test(sub)) italic = true;

  return {
    family: names.get(1) ?? "",
    subfamily: names.get(2) ?? "",
    typoFamily: names.get(16),
    typoSubfamily: names.get(17),
    postscriptName: names.get(6),
    weightClass,
    italic,
  };
}

/** nameID -> string; prioritas: Windows Unicode en-US > Windows Unicode lain > Unicode > Mac Roman. */
function readNames(data: Uint8Array, dv: DataView, t: TableRef | undefined, label: string): Map<number, string> {
  const out = new Map<number, string>();
  if (!t) return out;
  if (t.length < 6) fail("tabel name terpotong", label);
  const count = dv.getUint16(t.offset + 2);
  const strBase = t.offset + dv.getUint16(t.offset + 4);
  if (6 + count * 12 > t.length) fail("rekaman name terpotong", label);
  const rank = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const r = t.offset + 6 + i * 12;
    const platform = dv.getUint16(r);
    const encoding = dv.getUint16(r + 2);
    const language = dv.getUint16(r + 4);
    const nameId = dv.getUint16(r + 6);
    const len = dv.getUint16(r + 8);
    const off = strBase + dv.getUint16(r + 10);
    if (![1, 2, 6, 16, 17].includes(nameId) || off + len > data.length) continue;
    let score: number;
    let text: string;
    if (platform === 3 && (encoding === 1 || encoding === 10)) {
      score = language === 0x0409 ? 4 : 3;
      text = decodeUtf16Be(data.subarray(off, off + len));
    } else if (platform === 0) {
      score = 2;
      text = decodeUtf16Be(data.subarray(off, off + len));
    } else if (platform === 1 && encoding === 0) {
      score = 1;
      text = decodeLatin1(data.subarray(off, off + len));
    } else {
      continue;
    }
    if ((rank.get(nameId) ?? 0) < score) {
      rank.set(nameId, score);
      out.set(nameId, text.trim());
    }
  }
  return out;
}
