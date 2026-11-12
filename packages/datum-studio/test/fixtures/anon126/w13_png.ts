// Swarm 1.2.6 row 24, flow F6 (W-13), 01g section 5.2: generator of `w13_k1.png`, a tiny PNG of geometric
// shapes with no text and no metadata chunks (only IHDR, IDAT, IEND). 01g section 4.6: synthetic.
// Regenerate: `bun test/fixtures/anon126/w13_png.ts` from packages/datum-studio (writes w13_k1.png next to it).
import { deflateSync } from "node:zlib"

export const W13_WIDTH = 64
export const W13_HEIGHT = 48

/** Raw scanlines (filter byte 0 + RGB per pixel): paper background, a dark frame, a teal box, a rust disc. */
export function w13Scanlines(): Uint8Array {
  const W = W13_WIDTH
  const H = W13_HEIGHT
  const row = 1 + W * 3
  const out = new Uint8Array(row * H)
  const paper = [0xfc, 0xfc, 0xfb]
  const ink = [0x2b, 0x36, 0x40]
  const teal = [0x2f, 0x6f, 0x6b]
  const rust = [0xb4, 0x53, 0x09]
  for (let y = 0; y < H; y++) {
    out[y * row] = 0
    for (let x = 0; x < W; x++) {
      let c = paper
      if (x === 2 || y === 2 || x === W - 3 || y === H - 3) c = ink
      else if (x >= 8 && x < 28 && y >= 10 && y < 38) c = teal
      else if ((x - 44) ** 2 + (y - 24) ** 2 <= 100) c = rust
      out.set(c, y * row + 1 + x * 3)
    }
  }
  return out
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(b: Uint8Array): number {
  let c = 0xffffffff
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const v = new DataView(out.buffer)
  v.setUint32(0, data.length)
  out.set(new TextEncoder().encode(type), 4)
  out.set(data, 8)
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

export function w13Png(): Uint8Array {
  const ihdr = new Uint8Array(13)
  const v = new DataView(ihdr.buffer)
  v.setUint32(0, W13_WIDTH)
  v.setUint32(4, W13_HEIGHT)
  ihdr.set([8, 2, 0, 0, 0], 8) // 8-bit RGB, deflate, no filter method change, no interlace
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(w13Scanlines(), { level: 9 }))),
    chunk("IEND", new Uint8Array(0)),
  ]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

if (import.meta.main) {
  const { writeFileSync } = await import("node:fs")
  const path = await import("node:path")
  writeFileSync(path.join(import.meta.dir, "w13_k1.png"), w13Png())
}
