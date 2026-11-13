// Row 151b of docs/2026-11-06_swarm_1_2_0_datum_installer (decision C130 GAP-1): the render bridge's `pagePng` op in
// real Electron 42. Bundles row151b-harness-main.ts, runs it on the repo's own Electron binary with a fixture HOME and
// userData and the mock keychain, and checks the page PNGs it wrote: count, pixel size (A4 / A5 aspect at 150 dpi),
// print-media colours, flow pagination at CSS breaks, page selection, and the path/allow-list refusals.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pngSize } from "../../src/main/datum-render/page-images"

const here = import.meta.dir
const electron = join(here, "../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
const runnable = existsSync(electron) && !electron.startsWith("/Applications/") && process.platform === "darwin"
const ownWork = !process.env.ROW151B_WORK
// realpath: on macOS tmpdir() is under /var, a symlink to /private/var; the harness reports resolved paths.
const work = process.env.ROW151B_WORK ?? mkdtempSync(join(realpathSync(tmpdir()), "row151b-pagepng-"))
const fonts = join(here, "../../datum/datum-house-style/assets/fonts")

let result: any
let electronPid: number | undefined
let kill: (() => void) | undefined
beforeAll(async () => {
  if (!runnable) return
  const home = process.env.ROW151B_HOME ?? join(work, "home")
  mkdirSync(home, { recursive: true })
  const main = await Bun.build({
    entrypoints: [join(here, "row151b-harness-main.ts")],
    target: "node",
    format: "esm",
    external: ["electron"],
    outdir: join(work, "bundle"),
    naming: "main.mjs",
  })
  if (!main.success) throw new Error(main.logs.join("\n"))
  // --use-mock-keychain: never touch the macOS keychain from the fixture HOME (also appended in the harness).
  const run = Bun.spawn([electron, "--use-mock-keychain", join(work, "bundle", "main.mjs")], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      ROW151B_WORK: work,
      ROW151B_FONTS: fonts,
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      ALL_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost",
      ELECTRON_ENABLE_LOGGING: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  electronPid = run.pid
  writeFileSync(join(work, "electron.pid"), String(run.pid))
  kill = () => {
    if (run.exitCode === null && !run.killed) run.kill("SIGKILL")
  }
  const timer = setTimeout(kill, 170_000)
  try {
    const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
    writeFileSync(join(work, "electron.log"), `pid ${run.pid} exit ${code}\n--- stdout\n${out}\n--- stderr\n${err}`)
    result = JSON.parse(readFileSync(join(work, "result.json"), "utf8"))
    result.exit = code
  } finally {
    clearTimeout(timer)
    kill()
  }
}, 190_000)

afterAll(() => {
  kill?.()
  if (runnable) console.log(`row151b harness work dir: ${work} (electron pid ${electronPid})`)
  // Best effort: remove the folder only when this file created it (the env var was unset).
  if (ownWork) rmSync(work, { recursive: true, force: true })
})

const A4_ASPECT = 210 / 297
const A5_ASPECT = 148 / 210
const runOf = (name: string) => {
  const r = result.runs[name]
  if (!r.ok) throw new Error(`${name}: ${r.code} ${r.message}`)
  return r
}
/** Every file on disk is a PNG of the size the bridge reported. */
const filesMatch = (r: any) => {
  for (const p of r.pages) {
    const bytes = readFileSync(p.dst)
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
    expect(pngSize(bytes)).toEqual({ width: p.width, height: p.height })
  }
}
const aspect = (p: { width: number; height: number }) => p.width / p.height
/** Chromium truncates the fractional CSS clip, then scales by dpi/96 (A4 at 150 dpi: 793.7 -> 793 css px -> 1239 px). */
const px = (mm: number, dpi: number) => Math.floor(Math.trunc((mm * 96) / 25.4) * (dpi / 96))
/**
 * Page colours are compared by channel, not by exact value: the capture is colour-managed to the display profile
 * (sRGB #ff0000 comes back as #ea3323 on this Mac). High >= 0xc0, low <= 0x80.
 */
const colour = (rgb: string) => {
  const ch = [1, 3, 5].map((i) => parseInt(rgb.slice(i, i + 2), 16))
  if (ch.some((v) => v > 0x80 && v < 0xc0)) return `mixed ${rgb}`
  const [r, g, b] = ch.map((v) => v >= 0xc0)
  const names: Record<string, string> = { "100": "red", "010": "green", "001": "blue", "101": "magenta", "011": "cyan", "110": "yellow", "111": "white", "000": "black" }
  return names[`${+r}${+g}${+b}`]
}

describe.skipIf(!runnable)("render bridge pagePng in real Electron 42", () => {
  test("the harness ran to the end on Electron 42 with a fixture HOME and userData", () => {
    expect(result.error).toBeUndefined()
    expect(result.exit).toBe(0)
    expect(result.electron).toBe("42.3.3")
    expect(result.userData.startsWith(work)).toBe(true)
    expect(result.home.startsWith("/Users/")).toBe(false)
  })

  test("paged: a 3-page A4 HTML gives 3 PNGs witness-p001..p003 at 150 dpi with the A4 aspect ratio", () => {
    const r = runOf("paged3")
    expect(r).toMatchObject({ layout: "paged", media: "print", pageCount: 3, dpi: 150, pageSizeSource: "css" })
    expect(r.pageSizeMm).toEqual({ wMm: 210, hMm: 297 })
    expect(r.pages.map((p: any) => p.n)).toEqual([1, 2, 3])
    expect(r.pages.map((p: any) => p.dst)).toEqual([1, 2, 3].map((n) => join(work, "out", `witness-p00${n}.png`)))
    for (const p of r.pages) {
      expect(p.width).toBe(px(210, 150))
      expect(p.height).toBe(px(297, 150))
      expect([p.width, p.height]).toEqual([1239, 1753])
      expect(Math.abs(aspect(p) - A4_ASPECT)).toBeLessThan(0.002)
    }
    filesMatch(r)
  })

  test("paged: print media is emulated and each clip is its own page (red, green, blue centres; never screen magenta)", () => {
    const pix = result.pixels.paged3.map((p: any) => colour(p.samples[0].rgb))
    expect(pix).toEqual(["red", "green", "blue"])
  })

  test("flow: an HTML without page elements is cut at the @page height and honours CSS breaks (3 pages)", () => {
    const r = runOf("flow3")
    expect(r).toMatchObject({ layout: "flow", pageCount: 3, pageSizeSource: "css" })
    expect(r.pages.length).toBe(3)
    for (const p of r.pages) expect(Math.abs(aspect(p) - A4_ASPECT)).toBeLessThan(0.002)
    // The coloured band of sheet n is at the top of page n; the page middle is white paper.
    expect(result.pixels.flow3.map((p: any) => colour(p.samples[0].rgb))).toEqual(["red", "green", "blue"])
    expect(result.pixels.flow3.map((p: any) => colour(p.samples[1].rgb))).toEqual(["white", "white", "white"])
    filesMatch(r)
  })

  test("CSS @page A5 (mm lengths) wins over the A4 fallback: one 873 x 1239 px page", () => {
    const r = runOf("css_a5")
    expect(r).toMatchObject({ pageCount: 1, pageSizeSource: "css" })
    expect(r.pageSizeMm).toEqual({ wMm: 148, hMm: 210 })
    const p = r.pages[0]
    expect([p.width, p.height]).toEqual([px(148, 150), px(210, 150)])
    expect(Math.abs(aspect(p) - A5_ASPECT)).toBeLessThan(0.002)
    expect(colour(result.pixels.css_a5[0].samples[0].rgb)).toBe("yellow")
    filesMatch(r)
  })

  test("CSS @page `A5 portrait` keyword with page sections: 2 A5 pages", () => {
    const r = runOf("keyword_a5")
    expect(r).toMatchObject({ layout: "paged", pageCount: 2, pageSizeSource: "css" })
    expect(r.pageSizeMm).toEqual({ wMm: 148, hMm: 210 })
    for (const p of r.pages) {
      expect([p.width, p.height]).toEqual([px(148, 150), px(210, 150)])
      expect(Math.abs(aspect(p) - A5_ASPECT)).toBeLessThan(0.002)
    }
    expect(result.pixels.keyword_a5.map((p: any) => colour(p.samples[0].rgb))).toEqual(["cyan", "cyan"])
  })

  test("page selection and dpi: pages [2] at 96 dpi gives only witness-p002.png, 793 x 1122 px, green", () => {
    const r = runOf("dpi96_p2")
    expect(r).toMatchObject({ pageCount: 3, dpi: 96 })
    expect(r.pages.length).toBe(1)
    expect(r.pages[0].n).toBe(2)
    expect(r.pages[0].dst).toBe(join(work, "out", "dpi96", "witness-p002.png"))
    expect([r.pages[0].width, r.pages[0].height]).toEqual([px(210, 96), px(297, 96)])
    expect(colour(result.pixels.dpi96_p2[0].samples[0].rgb)).toBe("green")
  })

  test("refusals: protected, relative, outside-root, non-normalised, missing and symlinked outputs; SVG/protected inputs; limits", () => {
    const f = result.refused
    expect(f.protectedDst).toMatchObject({ ok: false, code: "PATH_REFUSED" })
    expect(f.protectedDst.message).toContain("protected")
    expect(f.relativeDst).toMatchObject({ ok: false, code: "PATH_REFUSED" })
    expect(f.outsideRoots).toMatchObject({ ok: false, code: "PATH_REFUSED" })
    expect(f.dotdotDst).toMatchObject({ ok: false, code: "PATH_REFUSED" })
    expect(f.missingDst).toMatchObject({ ok: false, code: "PATH_REFUSED" })
    expect(f.symlinkDst).toMatchObject({ ok: false, code: "PATH_REFUSED" })
    expect(f.svgSrc).toMatchObject({ ok: false, code: "BAD_REQUEST" })
    expect(f.protectedSrc).toMatchObject({ ok: false, code: "PATH_REFUSED" })
    expect(f.tooManyPages).toMatchObject({ ok: false, code: "BAD_REQUEST" })
    expect(f.badDpi).toMatchObject({ ok: false, code: "BAD_REQUEST" })
    expect(f.extraField).toMatchObject({ ok: false, code: "BAD_REQUEST" })
    // The symlink target was never written.
    expect(existsSync(join(work, "out", "elsewhere.png"))).toBe(false)
  })

  test("every job window is gone and no network request was let through", () => {
    expect(result.windowsAfter).toBe(0)
    expect(result.log.filter((l: any) => l.source === "datum-render.network")).toEqual([])
  })
})
