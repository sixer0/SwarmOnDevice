/**
 * Kenali PNG/JPEG dari magic bytes dan baca dimensi + densitas dari header
 * saja (S53). Tanpa dependensi native, tanpa dekompresi: PNG hanya membaca
 * chunk IHDR/pHYs (berhenti di IDAT), JPEG hanya membaca segmen penanda
 * sampai SOS. Setiap pembacaan dibatasi panjang buffer; jumlah chunk/segmen
 * dibatasi agar masukan tak tepercaya tidak dapat memutar parser tanpa batas.
 */

export type RasterMime = "image/png" | "image/jpeg";

/** Jenis yang dikenali hanya untuk pesan tolak (bukan diterima). */
export type RejectedKind = "svg" | "gif" | "webp" | "bmp" | "tiff" | "pdf" | "ico" | "heic" | "avif" | "unknown";

export interface RasterHeader {
  mime: RasterMime;
  /** Lebar/tinggi piksel tersimpan (IHDR / SOFn), tanpa rotasi EXIF (paritas PIL `im.size`). */
  widthPx: number;
  heightPx: number;
  /** DPI dari pHYs (satuan meter) atau JFIF (satuan inci/cm); absen bila tidak dinyatakan. */
  dpiX?: number;
  dpiY?: number;
  /** Orientasi EXIF 1..8 (JPEG saja); absen bila tidak ada. 5..8 = tampil dengan lebar/tinggi tertukar. */
  orientation?: number;
  /** Rincian format (PNG: bitDepth/colorType/interlace; JPEG: sof/precision/components/progressive). */
  format: Record<string, number | boolean | string>;
}

export type SniffResult =
  | { ok: true; header: RasterHeader }
  | { ok: false; kind: RejectedKind | "png" | "jpeg"; reason: string };

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Batas langkah parser (bukan batas berkas): PNG wajar < 100 chunk sebelum IDAT. */
const MAX_PNG_CHUNKS = 4096;
const MAX_JPEG_SEGMENTS = 4096;
/** Dimensi sah PNG/JPEG: PNG 1..2^31-1, JPEG 1..65535. */
const PNG_MAX_DIM = 0x7fffffff;
const INCH_PER_METER = 0.0254;
const CM_PER_INCH = 2.54;

function u16be(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1];
}

function u32be(b: Uint8Array, o: number): number {
  return ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
}

function u16(b: Uint8Array, o: number, le: boolean): number {
  return le ? b[o] | (b[o + 1] << 8) : u16be(b, o);
}

function u32(b: Uint8Array, o: number, le: boolean): number {
  return le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + ((b[o + 3] << 24) >>> 0) : u32be(b, o);
}

function startsWith(b: Uint8Array, sig: readonly number[], at = 0): boolean {
  if (b.length < at + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[at + i] !== sig[i]) return false;
  return true;
}

function ascii(b: Uint8Array, o: number, n: number): string {
  let s = "";
  for (let i = o; i < o + n && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

// ── CRC32 (PNG) ──────────────────────────────────────────────────────────

let crcTable: Uint32Array | null = null;

function crc32(b: Uint8Array, start: number, end: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── PNG ──────────────────────────────────────────────────────────────────

/** Kombinasi colorType -> bitDepth sah (PNG spec §11.2.2). */
const PNG_DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

function sniffPng(b: Uint8Array): SniffResult {
  const fail = (reason: string): SniffResult => ({ ok: false, kind: "png", reason });
  let off = 8;
  let header: RasterHeader | null = null;
  let sawPlte = false;
  for (let n = 0; n < MAX_PNG_CHUNKS; n++) {
    if (off + 12 > b.length) return fail("truncated chunk header");
    const len = u32be(b, off);
    const type = ascii(b, off + 4, 4);
    if (len > 0x7fffffff) return fail("chunk length out of range");
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > b.length) return fail(`truncated ${type} chunk`);
    if (!/^[A-Za-z]{4}$/.test(type)) return fail("invalid chunk type");

    if (n === 0) {
      if (type !== "IHDR" || len !== 13) return fail("first chunk is not IHDR");
      if (crc32(b, off + 4, dataEnd) !== u32be(b, dataEnd)) return fail("IHDR CRC mismatch");
      const w = u32be(b, dataStart);
      const h = u32be(b, dataStart + 4);
      const bitDepth = b[dataStart + 8];
      const colorType = b[dataStart + 9];
      const compression = b[dataStart + 10];
      const filter = b[dataStart + 11];
      const interlace = b[dataStart + 12];
      if (w < 1 || h < 1 || w > PNG_MAX_DIM || h > PNG_MAX_DIM) return fail("invalid dimensions");
      if (!PNG_DEPTHS[colorType]?.includes(bitDepth)) return fail("invalid bit depth / color type");
      if (compression !== 0 || filter !== 0 || interlace > 1) return fail("invalid IHDR method fields");
      header = { mime: "image/png", widthPx: w, heightPx: h, format: { bitDepth, colorType, interlace: interlace === 1 } };
    } else if (type === "IHDR") {
      return fail("duplicate IHDR");
    } else if (type === "pHYs" && header) {
      // pHYs sah hanya sebelum IDAT; satuan 1 = piksel per meter.
      if (len === 9 && crc32(b, off + 4, dataEnd) === u32be(b, dataEnd) && b[dataStart + 8] === 1) {
        const ppmX = u32be(b, dataStart);
        const ppmY = u32be(b, dataStart + 4);
        if (ppmX > 0 && ppmY > 0) {
          header.dpiX = ppmX * INCH_PER_METER;
          header.dpiY = ppmY * INCH_PER_METER;
        }
      }
    } else if (type === "PLTE") {
      sawPlte = true;
    } else if (type === "acTL") {
      if (header) header.format.animated = true;
    } else if (type === "IDAT") {
      if (!header) return fail("IDAT before IHDR");
      if (header.format.colorType === 3 && !sawPlte) return fail("palette image without PLTE");
      return { ok: true, header };
    } else if (type === "IEND") {
      return fail("no IDAT chunk");
    }
    off = dataEnd + 4;
  }
  return fail("too many chunks before IDAT");
}

// ── JPEG ─────────────────────────────────────────────────────────────────

/** SOFn yang membawa dimensi bingkai (C4 DHT, C8 JPG, CC DAC bukan SOF). */
function isSof(m: number): boolean {
  return m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
}

/** Orientasi EXIF tag 0x0112 di IFD0; null bila tidak ada/rusak (tidak pernah melempar). */
function exifOrientation(b: Uint8Array, start: number, end: number): number | null {
  // "Exif\0\0" + header TIFF.
  if (end - start < 14 || ascii(b, start, 4) !== "Exif" || b[start + 4] !== 0 || b[start + 5] !== 0) return null;
  const t = start + 6;
  const order = ascii(b, t, 2);
  if (order !== "II" && order !== "MM") return null;
  const le = order === "II";
  if (u16(b, t + 2, le) !== 42) return null;
  const ifd = t + u32(b, t + 4, le);
  if (ifd + 2 > end || ifd < t + 8) return null;
  const count = u16(b, ifd, le);
  for (let i = 0; i < count && i < 512; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > end) return null;
    if (u16(b, e, le) === 0x0112) {
      const type = u16(b, e + 2, le);
      if (type !== 3) return null; // SHORT
      const v = u16(b, e + 8, le);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

function sniffJpeg(b: Uint8Array): SniffResult {
  const fail = (reason: string): SniffResult => ({ ok: false, kind: "jpeg", reason });
  let off = 2;
  let dpiX: number | undefined;
  let dpiY: number | undefined;
  let orientation: number | undefined;
  for (let n = 0; n < MAX_JPEG_SEGMENTS; n++) {
    if (off >= b.length) return fail("truncated before SOF");
    if (b[off] !== 0xff) return fail("marker expected");
    // Byte isi 0xFF boleh mendahului penanda.
    while (off < b.length && b[off] === 0xff) off++;
    if (off >= b.length) return fail("truncated marker");
    const m = b[off++];
    if (m === 0xd8 || m === 0x00) return fail("unexpected marker");
    if (m === 0xd9) return fail("EOI before SOF");
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) continue; // tanpa panjang
    if (m === 0xda) return fail("SOS before SOF");
    if (off + 2 > b.length) return fail("truncated segment length");
    const len = u16be(b, off);
    if (len < 2 || off + len > b.length) return fail("segment length out of range");
    const segStart = off + 2;
    const segEnd = off + len;

    if (isSof(m)) {
      if (len < 8) return fail("SOF segment too short");
      const precision = b[segStart];
      const h = u16be(b, segStart + 1);
      const w = u16be(b, segStart + 3);
      const components = b[segStart + 5];
      if (w < 1 || h < 1) return fail("invalid dimensions (DNL height not supported)");
      if (components < 1 || components > 4 || len < 8 + components * 3) return fail("invalid component count");
      const header: RasterHeader = {
        mime: "image/jpeg",
        widthPx: w,
        heightPx: h,
        format: { sof: `C${m.toString(16).toUpperCase().slice(1)}`, precision, components, progressive: m === 0xc2 || m === 0xc6 || m === 0xca || m === 0xce },
      };
      if (dpiX !== undefined && dpiY !== undefined) {
        header.dpiX = dpiX;
        header.dpiY = dpiY;
      }
      if (orientation !== undefined) header.orientation = orientation;
      return { ok: true, header };
    }
    if (m === 0xe0 && dpiX === undefined && len >= 16 && ascii(b, segStart, 5) === "JFIF\0") {
      // JFIF: versi(2) unit(1) Xdensity(2) Ydensity(2); unit 1 = dpi, 2 = dpcm, 0 = rasio saja.
      const units = b[segStart + 7];
      const xd = u16be(b, segStart + 8);
      const yd = u16be(b, segStart + 10);
      if (xd > 0 && yd > 0 && (units === 1 || units === 2)) {
        dpiX = units === 1 ? xd : xd * CM_PER_INCH;
        dpiY = units === 1 ? yd : yd * CM_PER_INCH;
      }
    } else if (m === 0xe1 && orientation === undefined) {
      const o = exifOrientation(b, segStart, segEnd);
      if (o !== null) orientation = o;
    }
    off = segEnd;
  }
  return fail("too many segments before SOF");
}

// ── Pengenal jenis tertolak ──────────────────────────────────────────────

function looksLikeSvg(b: Uint8Array): boolean {
  // Lewati BOM UTF-8 dan spasi; teks awal ("<svg", "<?xml", "<!DOCTYPE svg", komentar) = vektor mentah.
  let i = startsWith(b, [0xef, 0xbb, 0xbf]) ? 3 : 0;
  while (i < b.length && i < 4096 && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0d)) i++;
  if (b[i] !== 0x3c) return false; // "<"
  const head = ascii(b, i, 1024).toLowerCase();
  return head.startsWith("<svg") || head.startsWith("<?xml") || head.startsWith("<!doctype svg") || head.startsWith("<!--") || head.includes("<svg");
}

function rejectedKind(b: Uint8Array): RejectedKind {
  if (startsWith(b, [0x47, 0x49, 0x46, 0x38])) return "gif";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "webp";
  if (ascii(b, 0, 2) === "BM") return "bmp";
  if (startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a])) return "tiff";
  if (ascii(b, 0, 5) === "%PDF-") return "pdf";
  if (startsWith(b, [0x00, 0x00, 0x01, 0x00])) return "ico";
  if (ascii(b, 4, 4) === "ftyp") {
    const brand = ascii(b, 8, 4);
    if (brand.startsWith("avi")) return "avif";
    if (brand.startsWith("hei") || brand.startsWith("mif")) return "heic";
  }
  if (looksLikeSvg(b)) return "svg";
  return "unknown";
}

/**
 * Sniff + parse header. `ok: false` dengan `kind` "png"/"jpeg" = magic cocok
 * tetapi struktur rusak; jenis lain = format tidak didukung.
 */
export function sniffRaster(b: Uint8Array): SniffResult {
  if (startsWith(b, PNG_SIG)) return sniffPng(b);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return sniffJpeg(b);
  const kind = rejectedKind(b);
  return { ok: false, kind, reason: kind === "unknown" ? "not a PNG or JPEG" : `${kind} is not supported (PNG/JPEG only)` };
}
