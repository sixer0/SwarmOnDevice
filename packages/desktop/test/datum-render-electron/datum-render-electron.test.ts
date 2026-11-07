// Row 24a of docs/2026-11-06_swarm_1_2_0_datum_installer (F55-1, decision C118): the render bridge's PageEngine `pdf`
// op in real Electron 42. Earlier rows only drove a fake PageEngine, so the CDP Page.printToPDF that the built app
// lacks was never run. This test bundles harness-main.ts, runs it on the repo's own Electron binary with a fixture
// HOME/userData and the mock keychain, and parses the PDFs it wrote: %PDF header, page count, MediaBox.
// ROW24A_HARNESS_MAIN may point at another harness entry (used once to show the old CDP path failing this test).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { countPdfPages } from "../../../app/src/pages/session/file-preview-policy"

const here = import.meta.dir
const electron = join(here, "../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
const runnable = existsSync(electron) && !electron.startsWith("/Applications/") && process.platform === "darwin"
const ownWork = !process.env.ROW24A_WORK
const work = process.env.ROW24A_WORK ?? mkdtempSync(join(tmpdir(), "row24a-render-"))
const entry = process.env.ROW24A_HARNESS_MAIN ?? join(here, "harness-main.ts")

/** Tiny PDF reader: page objects, the page tree /Count, and every MediaBox. Chromium (Skia) writes these uncompressed. */
function readPdf(bytes: Uint8Array) {
  const s = Buffer.from(bytes).toString("latin1")
  const pageObjects = (s.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length
  const mediaBoxes = [...s.matchAll(/\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/g)].map((m) => [
    Number(m[3]) - Number(m[1]),
    Number(m[4]) - Number(m[2]),
  ])
  return { head: s.slice(0, 5), eof: /%%EOF\s*$/.test(s), pageObjects, treeCount: countPdfPages(bytes), mediaBoxes }
}

let result: any
let electronPid: number | undefined
let kill: (() => void) | undefined
beforeAll(async () => {
  if (!runnable) return
  const home = process.env.ROW24A_HOME ?? join(work, "home")
  mkdirSync(home, { recursive: true })
  const main = await Bun.build({
    entrypoints: [entry],
    target: "node",
    format: "esm",
    external: ["electron"],
    outdir: join(work, "bundle"),
    naming: "main.mjs",
  })
  if (!main.success) throw new Error(main.logs.join("\n"))
  // --use-mock-keychain: never touch the macOS keychain from the fixture HOME (also appended in harness-main.ts).
  const run = Bun.spawn([electron, "--use-mock-keychain", join(work, "bundle", "main.mjs")], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      ROW24A_WORK: work,
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
  const timer = setTimeout(kill, 100_000)
  try {
    const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
    writeFileSync(join(work, "electron.log"), `pid ${run.pid} exit ${code}\n--- stdout\n${out}\n--- stderr\n${err}`)
    result = JSON.parse(readFileSync(join(work, "result.json"), "utf8"))
    result.exit = code
  } finally {
    clearTimeout(timer)
    kill()
  }
}, 120_000)

afterAll(() => {
  kill?.()
  if (runnable) console.log(`row24a harness work dir: ${work} (electron pid ${electronPid})`)
  // Best effort: remove the folder only when this file created it (the env var was unset).
  if (ownWork) rmSync(work, { recursive: true, force: true })
})

const pdfOf = (name: string) => {
  const rec = result.pdfs[name]
  if (!rec.ok) throw new Error(`${name}: ${rec.error}`)
  return { entry: rec, pdf: readPdf(readFileSync(rec.file)) }
}
const near = (actual: number[], expected: number[]) => {
  expect(Math.abs(actual[0] - expected[0])).toBeLessThan(1.5)
  expect(Math.abs(actual[1] - expected[1])).toBeLessThan(1.5)
}
const A4_PT = [595.28, 841.89]
const A5_PT = [419.53, 595.28]

describe.skipIf(!runnable)("render bridge PageEngine in real Electron 42", () => {
  test("the harness ran to the end on Electron 42 with a fixture userData", () => {
    expect(result.error).toBeUndefined()
    expect(result.exit).toBe(0)
    expect(result.electron).toBe("42.3.3")
    expect(result.userData.startsWith(work)).toBe(true)
    expect(result.info).toMatchObject({ partition: "datum-render", sandbox: true, javascriptContent: false, network: "blocked" })
  })

  test("pdf: a one-page A4 HTML prints to a 1-page PDF with an A4 MediaBox", () => {
    const { entry, pdf } = pdfOf("a4_one")
    expect(entry.isBuffer).toBe(true)
    expect(pdf.head).toBe("%PDF-")
    expect(pdf.eof).toBe(true)
    expect(pdf.pageObjects).toBe(1)
    expect(pdf.treeCount).toBe(1)
    expect(pdf.mediaBoxes.length).toBe(1)
    near(pdf.mediaBoxes[0], A4_PT)
  })

  test("pdf: an HTML with CSS page breaks prints to 3 A4 pages", () => {
    const { pdf } = pdfOf("three_pages")
    expect(pdf.head).toBe("%PDF-")
    expect(pdf.pageObjects).toBe(3)
    expect(pdf.treeCount).toBe(3)
    expect(pdf.mediaBoxes.length).toBe(3)
    for (const box of pdf.mediaBoxes) near(box, A4_PT)
  })

  test("pdf: preferCSSPageSize true lets the CSS @page size (A5) win over the requested A4 paper", () => {
    const { pdf } = pdfOf("css_a5_prefer")
    expect(pdf.head).toBe("%PDF-")
    expect(pdf.pageObjects).toBe(1)
    near(pdf.mediaBoxes[0], A5_PT)
  })

  test("pdf: preferCSSPageSize false keeps the requested A4 paper for the same HTML", () => {
    const { pdf } = pdfOf("css_a5_paper")
    expect(pdf.head).toBe("%PDF-")
    for (const box of pdf.mediaBoxes) near(box, A4_PT)
  })

  test("png: the unchanged captureScreenshot op still makes a PNG, and every job window is gone", () => {
    expect(result.png.ok).toBe(true)
    expect(result.png.head).toBe("89504e470d0a1a0a")
    expect(result.windowsAfter).toBe(0)
  })
})
