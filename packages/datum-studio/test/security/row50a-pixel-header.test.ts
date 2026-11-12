// Row 50a (1.2.6, W-13 SEC-12 / SR-12): the pixel limit is checked from the declared header
// dimensions BEFORE the full structural parse (sniffRaster) and the metadata scan, so a
// decompression-bomb header is refused ASSET_TOO_LARGE without walking or allocating the body.
import { useStudioEnv } from "../ported/_env";
useStudioEnv(); // log sink writes into a temp workspace, restored afterAll
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { decodeImageDetailed } from "../../vendor/src/lib/studio/services/images/decode";
import * as Sniff from "../../vendor/src/lib/studio/services/images/sniff";

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

const SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function ihdr(w: number, h: number): Uint8Array {
  const d = new Uint8Array(13);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  d[8] = 8; // bit depth
  d[9] = 6; // RGBA
  return chunk("IHDR", d);
}

/** Signature + IHDR only: the header declares the size, no body follows. */
const headerOnlyPng = (w: number, h: number) => concat([SIG, ihdr(w, h)]);

/** JPEG SOI + SOF0 declaring w x h, nothing after it. */
function headerOnlyJpeg(w: number, h: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
}

function codeOf(fn: () => unknown): { code?: string; details?: Record<string, unknown> } {
  try {
    fn();
  } catch (e) {
    return e as { code?: string; details?: Record<string, unknown> };
  }
  return {};
}

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
});

describe("SEC-12: header-first pixel limit", () => {
  test("PNG header declaring 1 x 80,000,001 px is refused ASSET_TOO_LARGE before the full parse", () => {
    const full = spyOn(Sniff, "sniffRaster");
    spies.push(full);
    const err = codeOf(() => decodeImageDetailed({ bytes: headerOnlyPng(1, 80_000_001) }));
    expect(err.code).toBe("ASSET_TOO_LARGE");
    expect(err.details?.reason).toBe("pixel_limit");
    expect(full).toHaveBeenCalledTimes(0);
  });

  test("PNG header declaring 20,001 x 1 px is refused ASSET_TOO_LARGE before the full parse", () => {
    const full = spyOn(Sniff, "sniffRaster");
    spies.push(full);
    expect(codeOf(() => decodeImageDetailed({ bytes: headerOnlyPng(20_001, 1) })).code).toBe("ASSET_TOO_LARGE");
    expect(full).toHaveBeenCalledTimes(0);
  });

  test("PNG header declaring 10,000 x 8,001 px (side ok, > 80 MP) is refused before the full parse", () => {
    const full = spyOn(Sniff, "sniffRaster");
    spies.push(full);
    expect(codeOf(() => decodeImageDetailed({ bytes: headerOnlyPng(10_000, 8_001) })).code).toBe("ASSET_TOO_LARGE");
    expect(full).toHaveBeenCalledTimes(0);
  });

  test("JPEG SOF declaring 65,535 x 65,535 px is refused ASSET_TOO_LARGE before the full parse", () => {
    const full = spyOn(Sniff, "sniffRaster");
    spies.push(full);
    expect(codeOf(() => decodeImageDetailed({ bytes: headerOnlyJpeg(65_535, 65_535) })).code).toBe("ASSET_TOO_LARGE");
    expect(full).toHaveBeenCalledTimes(0);
  });

  test("a normal 2 x 2 PNG still passes and runs the full parse once", () => {
    const full = spyOn(Sniff, "sniffRaster");
    spies.push(full);
    const raw = new Uint8Array(2 * (1 + 2 * 4)); // filter byte + 2 RGBA pixels per row
    const png = concat([SIG, ihdr(2, 2), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array(0))]);
    const out = decodeImageDetailed({ bytes: png });
    expect([out.mime, out.widthPx, out.heightPx]).toEqual(["image/png", 2, 2]);
    expect(full).toHaveBeenCalledTimes(1);
  });
});
