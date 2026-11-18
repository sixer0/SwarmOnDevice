// Spike-only placeholder icons: a solid square PNG (8-bit RGBA, no filter).
// No image dependency; zlib from node:zlib, CRC-32 computed here.
import { deflateSync } from "node:zlib"

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Uint8Array) {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(new TextEncoder().encode(type), 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

export function solidPng(size: number, rgba: [number, number, number, number]) {
  const header = new Uint8Array(13)
  const hv = new DataView(header.buffer)
  hv.setUint32(0, size)
  hv.setUint32(4, size)
  header.set([8, 6, 0, 0, 0], 8) // bit depth 8, colour type RGBA, deflate, filter 0, no interlace
  const row = 1 + size * 4
  const raw = new Uint8Array(row * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) raw.set(rgba, y * row + 1 + x * 4)
  }
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const png = new Uint8Array(total)
  parts.reduce((offset, p) => {
    png.set(p, offset)
    return offset + p.length
  }, 0)
  return png
}
