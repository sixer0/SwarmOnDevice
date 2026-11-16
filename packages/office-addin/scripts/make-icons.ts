// Generates public/icons/icon-32.png and icon-64.png (register section 4 icon URLs).
// Artwork source: the Swarm mark in packages/ui/src/components/logo.tsx (`Mark`), read at
// run time so the icon cannot drift from the component. Single tone: white mark on a
// dark rounded square. No dependencies: a small supersampling rasteriser plus Bun's zlib.
// Run from packages/office-addin: bun scripts/make-icons.ts

import { deflateSync } from "node:zlib"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

type Point = readonly [number, number]

const root = join(import.meta.dir, "..")
const source = join(root, "..", "ui", "src", "components", "logo.tsx")
const SUPER = 4
const BG = [17, 17, 17] as const
const FG = [255, 255, 255] as const

const text = await Bun.file(source).text()
const start = text.indexOf("export const Mark")
const end = text.indexOf("export const", start + 1)
const body = text.slice(start, end)

const group = body.match(/translate\(([-\d.]+) ([-\d.]+)\) scale\(([\d.]+)\) translate\(([-\d.]+) ([-\d.]+)\)/)
if (!group) throw new Error("Mark group transform not found in logo.tsx")
const [, gx, gy, gs, ox, oy] = group.map(Number)

const cells = [...body.matchAll(/\sd="([^"]+)"\s+transform="([^"]+)"/g)]
if (cells.length === 0) throw new Error("no mark cells found in logo.tsx")

function flatten(d: string): Point[] {
  const nums = d.match(/[MLQZ]|-?[\d.]+/g) ?? []
  const pts: Point[] = []
  let i = 0
  let cur: Point = [0, 0]
  while (i < nums.length) {
    const cmd = nums[i++]
    if (cmd === "Z") continue
    if (cmd === "M" || cmd === "L") {
      cur = [Number(nums[i++]), Number(nums[i++])]
      pts.push(cur)
      continue
    }
    const c: Point = [Number(nums[i++]), Number(nums[i++])]
    const e: Point = [Number(nums[i++]), Number(nums[i++])]
    for (let t = 1; t <= 8; t++) {
      const u = t / 8
      pts.push([
        (1 - u) * (1 - u) * cur[0] + 2 * (1 - u) * u * c[0] + u * u * e[0],
        (1 - u) * (1 - u) * cur[1] + 2 * (1 - u) * u * c[1] + u * u * e[1],
      ])
    }
    cur = e
  }
  return pts
}

// Polygons in the 16x20 mark viewBox.
const polys = cells.map(([, d, tf]) => {
  const t = tf.match(/translate\(([-\d.]+) ([-\d.]+)\)(?: scale\(([\d.]+)\))?/)
  if (!t) throw new Error("bad cell transform " + tf)
  const [, tx, ty, ts] = t
  const s = ts ? Number(ts) : 1
  return flatten(d).map(([x, y]): Point => {
    const lx = x * s + Number(tx) + ox
    const ly = y * s + Number(ty) + oy
    return [lx * gs + gx, ly * gs + gy]
  })
})

function inside(poly: Point[], x: number, y: number) {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

function crc32(buf: Uint8Array) {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
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

function render(size: number) {
  const radius = size * 0.2
  // Mark (16x20 units) fits the square with 18% padding, centred.
  const scale = (size * 0.64) / 20
  const offX = size / 2 - 8 * scale
  const offY = size / 2 - 10 * scale
  const raw = new Uint8Array(size * (size * 4 + 1))
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0
    for (let px = 0; px < size; px++) {
      let bg = 0
      let fg = 0
      for (let sy = 0; sy < SUPER; sy++) {
        for (let sx = 0; sx < SUPER; sx++) {
          const x = px + (sx + 0.5) / SUPER
          const y = py + (sy + 0.5) / SUPER
          const cx = Math.min(Math.max(x, radius), size - radius)
          const cy = Math.min(Math.max(y, radius), size - radius)
          if ((x - cx) ** 2 + (y - cy) ** 2 > radius ** 2) continue
          bg++
          const mx = (x - offX) / scale
          const my = (y - offY) / scale
          if (polys.some((p) => inside(p, mx, my))) fg++
        }
      }
      const total = SUPER * SUPER
      const o = py * (size * 4 + 1) + 1 + px * 4
      const f = bg === 0 ? 0 : fg / bg
      for (let c = 0; c < 3; c++) raw[o + c] = Math.round(BG[c] + (FG[c] - BG[c]) * f)
      raw[o + 3] = Math.round((bg / total) * 255)
    }
  }
  const ihdr = new Uint8Array(13)
  const v = new DataView(ihdr.buffer)
  v.setUint32(0, size)
  v.setUint32(4, size)
  ihdr[8] = 8
  ihdr[9] = 6
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
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

const dir = join(root, "public", "icons")
mkdirSync(dir, { recursive: true })
for (const size of [32, 64]) {
  await Bun.write(join(dir, `icon-${size}.png`), render(size))
  console.log(`wrote icon-${size}.png (${cells.length} cells)`)
}
