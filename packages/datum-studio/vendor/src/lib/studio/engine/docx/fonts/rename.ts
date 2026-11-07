/**
 * Penamaan ulang keluarga wajah berlabel saat runtime (FIX-6, F-059).
 *
 * Aturan sama dengan `relabel()` S99 (`render-env/semibold-bundle/build_bundle.py`):
 * nameID 1 = keluarga, 2 = gaya, 3 = `S99;<ps>;<keluarga>;<gaya>`, 4 = keluarga
 * (+ " " + gaya bila bukan Regular), di platform 3 (Windows, UTF-16BE) dan
 * platform 1 (Mac Roman); nameID 2 dan 6 (PostScript) dipertahankan dari
 * wajah sumber. Bobot/`fsSelection`/`macStyle` tidak disentuh: sumbernya
 * wajah berlabel S99 yang sudah membawa nilai slotnya.
 *
 * Hanya tabel `name` yang dibangun ulang; tabel lain disalin byte-identik
 * dengan urutan data asli, lalu checksum tabel dan `head.checkSumAdjustment`
 * dihitung ulang. Fungsi murni dan deterministik (masukan sama = byte sama).
 */
import { StudioEngineError } from "../../../contract/errors";

/** NameID yang ditulis ulang (keluarga, ID unik, nama lengkap). */
const REWRITTEN_IDS = new Set([1, 3, 4]);

interface TableRec {
  tag: string;
  checksum: number;
  offset: number;
  length: number;
}

interface NameRec {
  platformID: number;
  encodingID: number;
  languageID: number;
  nameID: number;
  bytes: Uint8Array;
}

function fail(why: string, label: string): never {
  throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `penamaan ulang fon gagal (${label}): ${why}`, { label });
}

function decodeName(r: NameRec): string {
  if (r.platformID === 3 || r.platformID === 0) {
    let s = "";
    for (let i = 0; i + 1 < r.bytes.length; i += 2) s += String.fromCharCode((r.bytes[i] << 8) | r.bytes[i + 1]);
    return s;
  }
  return String.fromCharCode(...r.bytes);
}

function encodeName(platformID: number, s: string, label: string): Uint8Array {
  if (platformID === 3 || platformID === 0) {
    const out = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      out[i * 2] = c >> 8;
      out[i * 2 + 1] = c & 0xff;
    }
    return out;
  }
  // Mac Roman: hanya ASCII yang aman dipetakan 1:1.
  if (!/^[\x20-\x7e]*$/.test(s)) fail(`nama non-ASCII untuk platform ${platformID}: ${s}`, label);
  return Uint8Array.from(s, (ch) => ch.charCodeAt(0));
}

function tableChecksum(buf: Uint8Array, offset: number, length: number): number {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let sum = 0;
  const end = offset + ((length + 3) & ~3);
  for (let p = offset; p < end; p += 4) sum = (sum + dv.getUint32(p)) >>> 0;
  return sum;
}

function readTables(data: Uint8Array, label: string): { numTables: number; tables: TableRec[] } {
  if (data.length < 12) fail("berkas terlalu pendek", label);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const version = dv.getUint32(0);
  if (version !== 0x00010000 && version !== 0x74727565) fail("bukan sfnt TrueType", label);
  const numTables = dv.getUint16(4);
  if (12 + numTables * 16 > data.length) fail("direktori tabel terpotong", label);
  const tables: TableRec[] = [];
  for (let i = 0; i < numTables; i++) {
    const p = 12 + i * 16;
    const tag = String.fromCharCode(data[p], data[p + 1], data[p + 2], data[p + 3]);
    const rec = { tag, checksum: dv.getUint32(p + 4), offset: dv.getUint32(p + 8), length: dv.getUint32(p + 12) };
    if (rec.offset + rec.length > data.length) fail(`tabel ${tag} di luar berkas`, label);
    tables.push(rec);
  }
  return { numTables, tables };
}

function parseNameTable(data: Uint8Array, t: TableRec, label: string): NameRec[] {
  const dv = new DataView(data.buffer, data.byteOffset + t.offset, t.length);
  if (dv.getUint16(0) !== 0) fail("tabel name bukan format 0", label);
  const count = dv.getUint16(2);
  const strOff = dv.getUint16(4);
  const out: NameRec[] = [];
  for (let i = 0; i < count; i++) {
    const p = 6 + i * 12;
    const len = dv.getUint16(p + 8);
    const off = strOff + dv.getUint16(p + 10);
    if (off + len > t.length) fail("string name di luar tabel", label);
    out.push({
      platformID: dv.getUint16(p),
      encodingID: dv.getUint16(p + 2),
      languageID: dv.getUint16(p + 4),
      nameID: dv.getUint16(p + 6),
      bytes: data.slice(t.offset + off, t.offset + off + len),
    });
  }
  return out;
}

function buildNameTable(recs: readonly NameRec[]): Uint8Array {
  const strOff = 6 + recs.length * 12;
  const total = strOff + recs.reduce((n, r) => n + r.bytes.length, 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 0);
  dv.setUint16(2, recs.length);
  dv.setUint16(4, strOff);
  let cursor = 0;
  recs.forEach((r, i) => {
    const p = 6 + i * 12;
    dv.setUint16(p, r.platformID);
    dv.setUint16(p + 2, r.encodingID);
    dv.setUint16(p + 4, r.languageID);
    dv.setUint16(p + 6, r.nameID);
    dv.setUint16(p + 8, r.bytes.length);
    dv.setUint16(p + 10, cursor);
    out.set(r.bytes, strOff + cursor);
    cursor += r.bytes.length;
  });
  return out;
}

/**
 * Tulis ulang nama keluarga wajah berlabel S99 menjadi `family` (aturan nameID
 * 1/3/4 di atas). Galat BY_CONSTRUCTION_FAILED bila berkas bukan sfnt
 * TrueType sah atau tidak membawa nameID 2/6 (bukan wajah berlabel S99).
 */
export function renameFontFamily(data: Uint8Array, family: string, label = "fon"): Uint8Array {
  if (!family.trim()) fail("keluarga kosong", label);
  const { numTables, tables } = readTables(data, label);
  const nameT = tables.find((t) => t.tag === "name");
  const headT = tables.find((t) => t.tag === "head");
  if (!nameT || !headT) fail("tabel name/head tidak ada", label);

  const recs = parseNameTable(data, nameT, label);
  const winOrMac = (r: NameRec, id: number) => r.nameID === id && (r.platformID === 3 || r.platformID === 1);
  const styleRec = recs.find((r) => winOrMac(r, 2) && r.platformID === 3) ?? recs.find((r) => winOrMac(r, 2));
  const psRec = recs.find((r) => r.nameID === 6 && r.platformID === 3) ?? recs.find((r) => r.nameID === 6);
  if (!styleRec || !psRec) fail("nameID 2/6 tidak ada", label);
  const style = decodeName(styleRec);
  const ps = decodeName(psRec);
  const value: Record<number, string> = {
    1: family,
    3: `S99;${ps};${family};${style}`,
    4: style === "Regular" ? family : `${family} ${style}`,
  };
  const next = recs.map((r) =>
    REWRITTEN_IDS.has(r.nameID) && (r.platformID === 3 || r.platformID === 1)
      ? { ...r, bytes: encodeName(r.platformID, value[r.nameID], label) }
      : r,
  );
  const nameBytes = buildNameTable(next);

  // Tata letak ulang: direktori tetap (urut tag asli), data menurut urutan offset asli, rata 4 byte.
  const byOffset = [...tables].sort((a, b) => a.offset - b.offset || (a.tag < b.tag ? -1 : 1));
  const headerLen = 12 + numTables * 16;
  const bodyOf = (t: TableRec) => (t.tag === "name" ? nameBytes : data.subarray(t.offset, t.offset + t.length));
  let size = headerLen;
  for (const t of byOffset) size += (bodyOf(t).length + 3) & ~3;
  const out = new Uint8Array(size);
  out.set(data.subarray(0, 12), 0);
  const placed = new Map<string, { offset: number; length: number }>();
  let cursor = headerLen;
  for (const t of byOffset) {
    const body = bodyOf(t);
    out.set(body, cursor);
    placed.set(t.tag, { offset: cursor, length: body.length });
    cursor += (body.length + 3) & ~3;
  }
  const dv = new DataView(out.buffer);
  const headPos = placed.get("head");
  if (!headPos || headPos.length < 12) fail("tabel head terlalu pendek", label);
  dv.setUint32(headPos.offset + 8, 0);
  tables.forEach((t, i) => {
    const p = 12 + i * 16;
    const pos = placed.get(t.tag);
    if (!pos) fail(`tabel ${t.tag} hilang`, label);
    for (let k = 0; k < 4; k++) out[p + k] = t.tag.charCodeAt(k);
    dv.setUint32(p + 4, tableChecksum(out, pos.offset, pos.length));
    dv.setUint32(p + 8, pos.offset);
    dv.setUint32(p + 12, pos.length);
  });
  const whole = tableChecksum(out, 0, out.length);
  dv.setUint32(headPos.offset + 8, (0xb1b0afba - whole) >>> 0);
  return out;
}
