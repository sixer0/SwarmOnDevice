// Row 50a (1.2.6, W-13 SEC-10 / SR-10): decodeImageDetailed reports embedded metadata
// { gps, exifTags, pngTextKeys } without changing the bytes (the sha identity of 01f §3.4 holds).
// Fixture gps-1x1.jpg is synthetic (make-gps-jpeg.py: 1x1 grey, made-up GPS 1 N 2 E), not a photo.
import { useStudioEnv } from "../ported/_env";
useStudioEnv(); // log sink writes into a temp workspace, restored afterAll
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { decodeImageDetailed } from "../../vendor/src/lib/studio/services/images";

const FIX = path.join(import.meta.dir, "..", "fixtures", "row50a");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const latin1 = (s: string) => new Uint8Array([...s].map((ch) => ch.charCodeAt(0)));

/** 1x1 RGBA PNG; `extra` chunks go after IDAT (text chunks are legal there). */
function png(extra: Uint8Array[] = [], beforeIdat: Uint8Array[] = []): Uint8Array {
  const h = new Uint8Array(13);
  new DataView(h.buffer).setUint32(0, 1);
  new DataView(h.buffer).setUint32(4, 1);
  h[8] = 8;
  h[9] = 6;
  const idat = new Uint8Array(deflateSync(new Uint8Array([0, 10, 20, 30, 255])));
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", h),
    ...beforeIdat,
    chunk("IDAT", idat),
    ...extra,
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** Big-endian TIFF with IFD0 = { Software, GPSInfo -> GPS IFD { GPSLatitudeRef "N" } }. */
function tiffWithGps(): Uint8Array {
  const b = new Uint8Array(8 + 2 + 2 * 12 + 4 + 2 + 12 + 4);
  const dv = new DataView(b.buffer);
  b.set(latin1("MM"), 0);
  dv.setUint16(2, 42);
  dv.setUint32(4, 8);
  dv.setUint16(8, 2);
  dv.setUint16(10, 0x0131); // Software, ASCII count 1 -> inline
  dv.setUint16(12, 2);
  dv.setUint32(14, 1);
  dv.setUint16(22, 0x8825); // GPSInfo, LONG
  dv.setUint16(24, 4);
  dv.setUint32(26, 1);
  const gpsIfd = 8 + 2 + 24 + 4;
  dv.setUint32(30, gpsIfd);
  dv.setUint16(gpsIfd, 1);
  dv.setUint16(gpsIfd + 2, 0x0001); // GPSLatitudeRef
  dv.setUint16(gpsIfd + 4, 2);
  dv.setUint32(gpsIfd + 6, 2);
  b[gpsIfd + 10] = 0x4e; // "N"
  return b;
}

describe("SEC-10: embedded metadata detection", () => {
  test("synthetic GPS JPEG fixture gives metadata.gps true and names the EXIF tags; bytes unchanged", () => {
    const bytes = new Uint8Array(readFileSync(path.join(FIX, "gps-1x1.jpg")));
    const out = decodeImageDetailed({ bytes });
    expect(out.mime).toBe("image/jpeg");
    expect(out.metadata.gps).toBe(true);
    expect(out.metadata.exifTags).toContain("GPSInfo");
    expect(out.metadata.exifTags).toContain("Software");
    expect(out.metadata.pngTextKeys).toEqual([]);
    expect(out.sha256).toBe(sha(bytes));
    expect(out.sha256).toBe("68519c2f05e056fec9cd8b28a3331c02e6d3599b730e8b93fd2cdaa869bccde6");
  });

  test("the same GPS JPEG through base64 gives the same metadata", () => {
    const b64 = readFileSync(path.join(FIX, "gps-1x1.jpg")).toString("base64");
    expect(decodeImageDetailed({ base64: b64 }).metadata.gps).toBe(true);
  });

  test("a clean PNG gives no metadata", () => {
    const out = decodeImageDetailed({ bytes: png() });
    expect(out.metadata).toEqual({ gps: false, exifTags: [], pngTextKeys: [] });
  });

  test("PNG tEXt / iTXt / zTXt keywords are listed (after IDAT too)", () => {
    const zt = concat([latin1("Comment\0\0"), new Uint8Array(deflateSync(latin1("hello")))]);
    const out = decodeImageDetailed({
      bytes: png([chunk("tEXt", latin1("Author\0Someone")), chunk("iTXt", latin1("Title\0\0\0\0\0x")), chunk("zTXt", zt)]),
    });
    expect(out.metadata.pngTextKeys).toEqual(["Author", "Title", "Comment"]);
    expect(out.metadata.gps).toBe(false);
  });

  test("PNG eXIf chunk with a GPS IFD gives gps true", () => {
    const out = decodeImageDetailed({ bytes: png([], [chunk("eXIf", tiffWithGps())]) });
    expect(out.metadata.gps).toBe(true);
    expect(out.metadata.exifTags).toEqual(["Software", "GPSInfo"]);
  });

  test("PNG XMP iTXt with GPSLatitude gives gps true", () => {
    const xmp = latin1('XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta><rdf:Description exif:GPSLatitude="1,0N"/></x:xmpmeta>');
    const out = decodeImageDetailed({ bytes: png([chunk("iTXt", xmp)]) });
    expect(out.metadata.gps).toBe(true);
    expect(out.metadata.pngTextKeys).toEqual(["XML:com.adobe.xmp"]);
  });

  test("ImageMagick raw EXIF profile in zTXt gives gps true", () => {
    const exif = concat([latin1("Exif\0\0"), tiffWithGps()]);
    const hex = Buffer.from(exif).toString("hex");
    const body = `\nexif\n${String(exif.length).padStart(8)}\n${hex}\n`;
    const zt = concat([latin1("Raw profile type exif\0\0"), new Uint8Array(deflateSync(latin1(body)))]);
    const out = decodeImageDetailed({ bytes: png([chunk("zTXt", zt)]) });
    expect(out.metadata.gps).toBe(true);
    expect(out.metadata.pngTextKeys).toEqual(["Raw profile type exif"]);
  });

  test("a corrupt EXIF block never throws: the upload decodes and reports what it could read", () => {
    const bad = latin1("MM\0*\xff\xff\xff\xff"); // IFD offset out of range
    const out = decodeImageDetailed({ bytes: png([], [chunk("eXIf", bad)]) });
    expect(out.metadata.gps).toBe(false);
    expect(out.widthPx).toBe(1);
  });
});
