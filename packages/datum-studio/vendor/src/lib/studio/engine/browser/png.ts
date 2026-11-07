/**
 * Utilitas PNG kecil untuk layanan browser (S25): baca ukuran IHDR dan tanam
 * chunk pHYs agar penerima (Word, LibreOffice) membaca resolusi 300 dpi dan
 * ukuran fisik mm yang benar. Murni, deterministik, tanpa dependensi.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array, start: number, end: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function readU32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function writeU32(b: Uint8Array, o: number, v: number): void {
  b[o] = (v >>> 24) & 0xff;
  b[o + 1] = (v >>> 16) & 0xff;
  b[o + 2] = (v >>> 8) & 0xff;
  b[o + 3] = v & 0xff;
}

export function isPng(b: Uint8Array): boolean {
  if (b.length < 33) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) if (b[i] !== PNG_SIGNATURE[i]) return false;
  // Chunk pertama wajib IHDR.
  return b[12] === 0x49 && b[13] === 0x48 && b[14] === 0x44 && b[15] === 0x52;
}

/** Ukuran piksel dari IHDR; null bila bukan PNG. */
export function readPngSize(b: Uint8Array): { widthPx: number; heightPx: number } | null {
  if (!isPng(b)) return null;
  return { widthPx: readU32(b, 16), heightPx: readU32(b, 20) };
}

/**
 * Kembalikan salinan PNG dengan satu chunk pHYs (satuan meter) tepat setelah
 * IHDR; pHYs lama dibuang. 300 dpi = 11811 piksel per meter.
 */
export function withPngDpi(png: Uint8Array, dpi: number): Uint8Array {
  if (!isPng(png)) throw new Error("withPngDpi: input is not a PNG");
  const ppm = Math.round(dpi / 0.0254);
  const ihdrEnd = 8 + 8 + readU32(png, 8) + 4;

  // Kumpulkan rentang chunk selain pHYs setelah IHDR.
  const keep: Array<[number, number]> = [];
  let o = ihdrEnd;
  while (o + 12 <= png.length) {
    const len = readU32(png, o);
    const end = o + 12 + len;
    if (end > png.length) throw new Error("withPngDpi: truncated PNG chunk");
    const isPhys = png[o + 4] === 0x70 && png[o + 5] === 0x48 && png[o + 6] === 0x59 && png[o + 7] === 0x73;
    if (!isPhys) keep.push([o, end]);
    o = end;
  }

  const phys = new Uint8Array(21);
  writeU32(phys, 0, 9);
  phys.set([0x70, 0x48, 0x59, 0x73], 4);
  writeU32(phys, 8, ppm);
  writeU32(phys, 12, ppm);
  phys[16] = 1; // unit: meter
  writeU32(phys, 17, crc32(phys, 4, 17));

  const restLen = keep.reduce((n, [s, e]) => n + (e - s), 0);
  const out = new Uint8Array(ihdrEnd + phys.length + restLen);
  out.set(png.subarray(0, ihdrEnd), 0);
  out.set(phys, ihdrEnd);
  let w = ihdrEnd + phys.length;
  for (const [s, e] of keep) {
    out.set(png.subarray(s, e), w);
    w += e - s;
  }
  return out;
}
