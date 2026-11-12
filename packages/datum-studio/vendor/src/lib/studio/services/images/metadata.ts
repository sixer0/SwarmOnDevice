/**
 * Swarm patch (1.2.6 row 50a, W-13 SEC-10 / SR-10): deteksi metadata yang
 * ikut tertanam apa adanya di DOCX `word/media` dan data URI HTML (tanpa
 * strip, demi identitas sha256 01f §3.4): lokasi GPS, tag EXIF, kunci teks
 * PNG. Hanya MELAPORKAN; tidak menolak dan tidak mengubah byte.
 *
 * Masukan tak tepercaya: setiap pembacaan dibatasi panjang buffer, jumlah
 * chunk/segmen/entri IFD dibatasi, inflasi zTXt dibatasi 1 MiB, dan fungsi
 * tidak pernah melempar (metadata rusak = dilaporkan sejauh terbaca).
 * Dipanggil oleh `decodeImageDetailed` SETELAH batas piksel header (SEC-12).
 */
import { inflateSync } from "node:zlib";
import type { RasterMime } from "./sniff";

export interface ImageMetadata {
  /** true bila ada GPS IFD (EXIF tag 0x8825) atau properti GPS di XMP. */
  gps: boolean;
  /** Nama tag EXIF di IFD0 dan Exif sub-IFD (urutan kemunculan, unik); tag tak dikenal = `0xNNNN`. */
  exifTags: string[];
  /** Kata kunci chunk tEXt/zTXt/iTXt PNG (urutan kemunculan, unik). */
  pngTextKeys: string[];
}

const MAX_LIST = 64;
const MAX_IFD_ENTRIES = 512;
const MAX_PNG_CHUNKS = 1 << 16;
const MAX_JPEG_SEGMENTS = 4096;
const MAX_INFLATE_BYTES = 1024 * 1024;
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;

/** Tag yang paling sering membawa data pribadi atau jejak perangkat; sisanya ditulis heksadesimal. */
const TAG_NAMES: Readonly<Record<number, string>> = {
  0x010e: "ImageDescription",
  0x010f: "Make",
  0x0110: "Model",
  0x0112: "Orientation",
  0x011a: "XResolution",
  0x011b: "YResolution",
  0x0128: "ResolutionUnit",
  0x0131: "Software",
  0x0132: "DateTime",
  0x013b: "Artist",
  0x013c: "HostComputer",
  0x0213: "YCbCrPositioning",
  0x8298: "Copyright",
  [TAG_EXIF_IFD]: "ExifIFD",
  [TAG_GPS_IFD]: "GPSInfo",
  0x829a: "ExposureTime",
  0x829d: "FNumber",
  0x8827: "ISOSpeedRatings",
  0x9000: "ExifVersion",
  0x9003: "DateTimeOriginal",
  0x9004: "DateTimeDigitized",
  0x9010: "OffsetTime",
  0x920a: "FocalLength",
  0x927c: "MakerNote",
  0x9286: "UserComment",
  0xa001: "ColorSpace",
  0xa002: "PixelXDimension",
  0xa003: "PixelYDimension",
  0xa420: "ImageUniqueID",
  0xa430: "CameraOwnerName",
  0xa431: "BodySerialNumber",
  0xa433: "LensMake",
  0xa434: "LensModel",
  0xa435: "LensSerialNumber",
};

const XMP_JPEG_ID = "http://ns.adobe.com/xap/1.0/\0";
const XMP_GPS_RE = /GPS(?:Latitude|Longitude|Altitude)/;

function ascii(b: Uint8Array, o: number, n: number): string {
  let s = "";
  for (let i = o; i < o + n && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

function u16(b: Uint8Array, o: number, le: boolean): number {
  return le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1];
}

function u32(b: Uint8Array, o: number, le: boolean): number {
  return le
    ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + ((b[o + 3] << 24) >>> 0)
    : ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
}

class Collector {
  gps = false;
  readonly exif: string[] = [];
  readonly text: string[] = [];
  addExif(name: string): void {
    if (this.exif.length < MAX_LIST && !this.exif.includes(name)) this.exif.push(name);
  }
  addText(key: string): void {
    if (this.text.length < MAX_LIST && !this.text.includes(key)) this.text.push(key);
  }
  result(): ImageMetadata {
    return { gps: this.gps, exifTags: [...this.exif], pngTextKeys: [...this.text] };
  }
}

/** Baca satu IFD; kembalikan daftar tag (dibatasi). Tidak melempar. */
function ifdTags(t: Uint8Array, ifd: number, le: boolean): Array<{ tag: number; value: number }> {
  const out: Array<{ tag: number; value: number }> = [];
  if (ifd < 8 || ifd + 2 > t.length) return out;
  const count = u16(t, ifd, le);
  for (let i = 0; i < count && i < MAX_IFD_ENTRIES; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > t.length) break;
    out.push({ tag: u16(t, e, le), value: u32(t, e + 8, le) });
  }
  return out;
}

/** Struktur TIFF (isi blok EXIF tanpa prefiks "Exif\0\0"). */
function scanTiff(t: Uint8Array, c: Collector): void {
  if (t.length < 8) return;
  const order = ascii(t, 0, 2);
  if (order !== "II" && order !== "MM") return;
  const le = order === "II";
  if (u16(t, 2, le) !== 42) return;
  const ifd0 = ifdTags(t, u32(t, 4, le), le);
  let exifIfd = -1;
  for (const { tag, value } of ifd0) {
    c.addExif(TAG_NAMES[tag] ?? `0x${tag.toString(16).padStart(4, "0")}`);
    if (tag === TAG_GPS_IFD) c.gps = true;
    if (tag === TAG_EXIF_IFD) exifIfd = value;
  }
  if (exifIfd > 0) {
    for (const { tag } of ifdTags(t, exifIfd, le)) {
      c.addExif(TAG_NAMES[tag] ?? `0x${tag.toString(16).padStart(4, "0")}`);
      if (tag === TAG_GPS_IFD) c.gps = true;
    }
  }
}

/** Blok "Exif\0\0" + TIFF (JPEG APP1, isi raw profile PNG). */
function scanExifBlock(b: Uint8Array, c: Collector): void {
  if (b.length >= 6 && ascii(b, 0, 4) === "Exif" && b[4] === 0 && b[5] === 0) scanTiff(b.subarray(6), c);
}

function scanXmp(text: string, c: Collector): void {
  if (XMP_GPS_RE.test(text)) c.gps = true;
}

function scanJpeg(b: Uint8Array, c: Collector): void {
  let off = 2;
  for (let n = 0; n < MAX_JPEG_SEGMENTS; n++) {
    if (off >= b.length || b[off] !== 0xff) return;
    while (off < b.length && b[off] === 0xff) off++;
    if (off >= b.length) return;
    const m = b[off++];
    if (m === 0xd9 || m === 0xda) return; // EOI / SOS: metadata selesai
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01 || m === 0xd8) continue;
    if (off + 2 > b.length) return;
    const len = (b[off] << 8) | b[off + 1];
    if (len < 2 || off + len > b.length) return;
    const seg = b.subarray(off + 2, off + len);
    if (m === 0xe1) {
      scanExifBlock(seg, c);
      if (ascii(seg, 0, XMP_JPEG_ID.length) === XMP_JPEG_ID) scanXmp(ascii(seg, XMP_JPEG_ID.length, seg.length), c);
    }
    off += len;
  }
}

/** Kata kunci PNG: 1-79 byte Latin-1 sebelum NUL; karakter tak tercetak diganti "?". */
function pngKeyword(data: Uint8Array): { key: string; rest: number } | null {
  const nul = data.indexOf(0);
  if (nul < 1 || nul > 79) return null;
  let key = "";
  for (let i = 0; i < nul; i++) {
    const ch = data[i];
    key += (ch >= 0x20 && ch <= 0x7e) || ch >= 0xa1 ? String.fromCharCode(ch) : "?";
  }
  return { key, rest: nul + 1 };
}

function inflateCapped(data: Uint8Array): Uint8Array | null {
  try {
    return new Uint8Array(inflateSync(data, { maxOutputLength: MAX_INFLATE_BYTES }));
  } catch {
    return null;
  }
}

/** ImageMagick/exiftool "Raw profile type exif|app1": "\n<nama>\n <panjang>\n<hex...>". */
function scanRawProfile(text: string, c: Collector): void {
  const m = /^\s*\S+\s+(\d+)\s+([0-9a-fA-F\s]+)$/.exec(text);
  if (!m) return;
  const hex = m[2].replace(/\s+/g, "");
  const n = Math.min(Number(m[1]), Math.floor(hex.length / 2), MAX_INFLATE_BYTES);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  if (ascii(out, 0, 4) === "Exif") scanExifBlock(out, c);
  else scanTiff(out, c);
}

function scanPngText(type: string, data: Uint8Array, c: Collector): void {
  const kw = pngKeyword(data);
  if (!kw) return;
  c.addText(kw.key);
  const lower = kw.key.toLowerCase();
  const wantsBody = lower === "xml:com.adobe.xmp" || lower.startsWith("raw profile type exif") || lower.startsWith("raw profile type app1");
  if (!wantsBody) return;
  let body: Uint8Array | null = null;
  if (type === "tEXt") body = data.subarray(kw.rest);
  else if (type === "zTXt") body = data[kw.rest] === 0 ? inflateCapped(data.subarray(kw.rest + 1)) : null;
  else {
    // iTXt: flag(1) method(1) lang\0 translated\0 text
    const flag = data[kw.rest];
    let p = kw.rest + 2;
    for (let k = 0; k < 2 && p >= 0; k++) {
      const z = data.indexOf(0, p);
      p = z < 0 ? -1 : z + 1;
    }
    if (p > 0) body = flag === 1 ? inflateCapped(data.subarray(p)) : data.subarray(p);
  }
  if (!body) return;
  const text = ascii(body, 0, Math.min(body.length, MAX_INFLATE_BYTES));
  if (lower === "xml:com.adobe.xmp") scanXmp(text, c);
  else scanRawProfile(text, c);
}

function scanPng(b: Uint8Array, c: Collector): void {
  let off = 8;
  for (let n = 0; n < MAX_PNG_CHUNKS; n++) {
    if (off + 12 > b.length) return;
    const len = u32(b, off, false);
    const type = ascii(b, off + 4, 4);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (len > 0x7fffffff || dataEnd + 4 > b.length) return;
    const data = b.subarray(dataStart, dataEnd);
    if (type === "tEXt" || type === "zTXt" || type === "iTXt") scanPngText(type, data, c);
    else if (type === "eXIf") {
      scanTiff(data, c);
      if (c.exif.length === 0) scanExifBlock(data, c); // sebagian penulis menyertakan prefiks "Exif\0\0"
    } else if (type === "IEND") return;
    off = dataEnd + 4;
  }
}

/**
 * SEC-10: metadata pribadi/perangkat dalam aset PNG/JPEG yang sudah lolos
 * sniff. Tidak pernah melempar; tipe lain memberi hasil kosong.
 */
export function readImageMetadata(bytes: Uint8Array, mime: RasterMime): ImageMetadata {
  const c = new Collector();
  try {
    if (mime === "image/jpeg") scanJpeg(bytes, c);
    else if (mime === "image/png") scanPng(bytes, c);
  } catch {
    // Metadata rusak tidak menggagalkan unggahan; laporkan yang sudah terbaca.
  }
  return c.result();
}
