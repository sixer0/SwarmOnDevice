// Row 205 of docs/2026-11-09_swarm_1_2_3_patch (defect HB-1): on a Mac with a mouse attached (macOS "Show scroll bars:
// automatic"), Chromium reserved a classic 15 px scrollbar in the render bridge's hidden window, so the layout viewport
// was 779 px instead of the 794 px A4 sheet and every Studio flow document measured `.st-unit` 3.89 mm past the right
// edge (OVERLAP_CLIP FAIL, DATUM-37 FAIL, built-in template previews lint FAIL). The bridge now hides scrollbars
// (Emulation.setScrollbarsHidden, electron-renderer.ts inWindow). This test runs the REAL bridge in the repo's Electron 42
// (row 151 harness: fixture HOME/userData, mock keychain, dead proxy, offline render session) with classic scrollbars
// forced for that process (`-AppleShowScrollBars Always`, the HB-1 condition), and checks:
//   - the layout viewport the overlap script reports equals the sheet (no scrollbar width taken);
//   - the real Studio HTML (row 123 fixture) passes OVERLAP_CLIP with 0 findings, as PDF same-job HTML and as HTML;
//   - the three built-in template previews (datum-kanonik, datum-gsp, datum-nota; pdf + html; lint on) have DATUM-37 PASS
//     and release lint PASS (AC-1), and their HTML passes OVERLAP_CLIP;
//   - the datum-nota preview rendered at tier NOTA passes, and a one-page NOTA (parity fixture doc_nota_memo) is one
//     printed page and passes OVERLAP_CLIP as PDF same-job HTML and as HTML;
//   - a real overflow (a 260 mm block in the Studio flow document) still FAILs with OVERFLOW_RIGHT and the L-1 note.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const here = import.meta.dir
const electron = join(here, "../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
const runnable = existsSync(electron) && !electron.startsWith("/Applications/") && process.platform === "darwin"
const studioPkg = resolve(here, "../../../datum-studio")
const fontsDir = resolve(here, "../../datum/datum-house-style/assets/fonts")
const ownWork = !process.env.ROW205_WORK
const work = process.env.ROW205_WORK ?? mkdtempSync(join(tmpdir(), "row205-"))
const A4 = { pageWidthMm: 210, pageHeightMm: 297 }
const SLUGS = ["datum-kanonik", "datum-gsp", "datum-nota"] as const

type Overlap = typeof import("../../../datum-studio/src/mcp-host/verify/overlap-clip")
type Preview = typeof import("../../../datum-studio/vendor/src/lib/studio/services/templates/preview")
type OverlapRun = Awaited<ReturnType<Overlap["runOverlapClip"]>>
type PreviewRun = Awaited<ReturnType<Preview["previewTemplate"]>>
let oc: Overlap
let run: ReturnType<typeof Bun.spawn> | undefined
let kill: (() => void) | undefined
const checks: Record<string, OverlapRun> = {}
const previews: Record<string, PreviewRun> = {}
const previewHtml: Record<string, string> = {}

/** The Studio flow document with one block wider than the sheet (a real overflow, spec §9 B3 seam). */
function studioWithWideBlock(html: string): string {
  return html.replace(/<\/body>/i, `<div data-block="b-wide" data-address="9.9" style="width:260mm;font:10pt serif">lebar</div></body>`)
}

beforeAll(async () => {
  if (!runnable) return
  const home = join(work, "home")
  mkdirSync(home, { recursive: true })
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
  }
  const studioFile = join(work, "studio_terbit.html")
  const gen = Bun.spawnSync([process.execPath, "test/verify-overlap/make-studio-fixture.ts", studioFile], { cwd: studioPkg, env, stdout: "pipe", stderr: "pipe" })
  if (gen.exitCode !== 0) throw new Error(`studio fixture: ${gen.stderr.toString()}`)
  const studioHtml = readFileSync(studioFile, "utf8")
  const notaFile = join(work, "studio_nota.html")
  const genNota = Bun.spawnSync([process.execPath, "test/verify-overlap/make-nota-fixture.ts", notaFile], { cwd: studioPkg, env, stdout: "pipe", stderr: "pipe" })
  if (genNota.exitCode !== 0) throw new Error(`nota fixture: ${genNota.stderr.toString()}`)
  const notaHtml = readFileSync(notaFile, "utf8")

  const main = await Bun.build({ entrypoints: [join(here, "row151-harness-main.ts")], target: "node", format: "esm", external: ["electron"], outdir: join(work, "bundle"), naming: "main.mjs" })
  if (!main.success) throw new Error(main.logs.join("\n"))
  // --use-mock-keychain: never touch the macOS keychain from the fixture HOME (also appended in the harness).
  // `-AppleShowScrollBars Always` (macOS NSArgumentDomain, this process only; no system setting changes): Chromium draws
  // classic 15 px scrollbars as on the HB-1 Mac with a mouse attached, whatever pointer devices this Mac has now.
  run = Bun.spawn([electron, "--use-mock-keychain", join(work, "bundle", "main.mjs"), "-AppleShowScrollBars", "Always"], {
    env: { ...env, ROW151_WORK: work, ROW151_FONTS: fontsDir, ELECTRON_ENABLE_LOGGING: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const child = run
  kill = () => {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL")
  }
  process.on("exit", () => kill?.())
  const deadline = Date.now() + 60_000
  while (!existsSync(join(work, "bridge.json"))) {
    if (child.exitCode !== null) throw new Error(`harness exited early (${child.exitCode})`)
    if (Date.now() > deadline) throw new Error("bridge did not start in 60 s")
    await Bun.sleep(100)
  }
  const bridge = JSON.parse(readFileSync(join(work, "bridge.json"), "utf8")) as { DATUM_RENDER_SOCKET: string; DATUM_RENDER_TOKEN: string }
  process.env.DATUM_RENDER_SOCKET = bridge.DATUM_RENDER_SOCKET
  process.env.DATUM_RENDER_TOKEN = bridge.DATUM_RENDER_TOKEN
  process.env.STUDIO_ASSETS_ROOT ??= join(studioPkg, "vendor", "src", "lib", "studio", "assets")
  const ws = join(work, "ws")
  mkdirSync(ws, { recursive: true })
  process.env.STUDIO_WORKSPACE_ROOT = ws

  oc = await import("../../../datum-studio/src/mcp-host/verify/overlap-clip")
  checks.studio_pdf = await oc.runOverlapClip({ format: "PDF", html: studioHtml, ...A4 })
  checks.studio_html = await oc.runOverlapClip({ format: "HTML", html: studioHtml, ...A4 })
  checks.nota_pdf = await oc.runOverlapClip({ format: "PDF", html: notaHtml, ...A4 })
  checks.nota_html = await oc.runOverlapClip({ format: "HTML", html: notaHtml, ...A4 })
  checks.studio_wide = await oc.runOverlapClip({ format: "HTML", html: studioWithWideBlock(studioHtml), ...A4 })

  process.env.STUDIO_VENDOR_ROOT ??= join(studioPkg, "vendor")
  const host = await import("../../../datum-studio/src/mcp-host/index.ts")
  await host.openHostStore(ws, { release: "1.2.3", logFile: join(ws, "logs", "datum-studio-store.jsonl") })
  host.configureTemplateSource({ templatesDir: join(studioPkg, "templates"), assetRepoRoot: join(studioPkg, "vendor"), release: "1.2.3" })
  const pv: Preview = await import("../../../datum-studio/vendor/src/lib/studio/services/templates/preview")
  const tryPreview = async (key: string, input: Parameters<Preview["previewTemplate"]>[0]) => {
    const r = await pv.previewTemplate(input)
    previews[key] = r
    const htmlFile = r.files.find((f) => /\.html$/i.test(f.fileName))
    const abs = htmlFile ? join(ws, htmlFile.relPath) : null
    if (abs && existsSync(abs)) {
      previewHtml[key] = readFileSync(abs, "utf8")
      checks[`preview_${key}`] = await oc.runOverlapClip({ format: "PDF", html: previewHtml[key], ...A4 })
    }
  }
  for (const slug of SLUGS) await tryPreview(slug, { slug, formats: ["pdf", "html"], lint: true })
  await tryPreview("datum-nota_tier_NOTA", { slug: "datum-nota", tier: "NOTA", formats: ["pdf", "html"], lint: true })

  writeFileSync(
    join(work, "row205_results.json"),
    JSON.stringify(
      {
        checks: Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, { check: v.check, pageCount: v.layout && "metrics" in v.layout ? v.layout.metrics.pageCount : null, viewport: v.overlap ? { viewportPx: v.overlap.viewportPx, layoutWidthPx: v.overlap.layoutWidthPx, paged: v.overlap.paged } : null }])),
        previews: Object.fromEntries(Object.entries(previews).map(([k, v]) => [k, { files: v.files, failed: v.failed, errors: v.errors, lint: v.lint }])),
      },
      null,
      2,
    ),
  )
}, 300_000)

afterAll(async () => {
  if (runnable) {
    writeFileSync(join(work, "stop"), "")
    const deadline = Date.now() + 15_000
    while (run && run.exitCode === null && Date.now() < deadline) await Bun.sleep(100)
    kill?.()
  }
  if (ownWork && !process.env.ROW205_KEEP) rmSync(work, { recursive: true, force: true })
  else console.log(`row205 work dir: ${work}`)
})

const brief = (r: OverlapRun) => `${r.check.status} ${r.check.reason ?? ""} ${r.check.findings.map((f) => `${f.code}:${f.label}:${f.amount}`).join(",")}`

describe.skipIf(!runnable)("row 205: OVERLAP_CLIP on the sheet the PDF uses, in real Electron 42 (HB-1)", () => {
  test("the bridge window lays a flow document out at the full sheet width (no scrollbar width taken)", () => {
    const o = checks.studio_pdf.overlap!
    expect(o.paged).toBe(false)
    expect(o.viewportPx).toBe(Math.ceil(210 * (96 / 25.4)))
    expect(o.layoutWidthPx).toBe(o.viewportPx)
  })

  test("the real Studio HTML passes OVERLAP_CLIP with 0 findings, as a PDF's same-job HTML and as HTML", () => {
    expect(brief(checks.studio_pdf)).toBe("PASS  ")
    expect(brief(checks.studio_html)).toBe("PASS  ")
  })

  test("a real overflow still FAILs with OVERFLOW_RIGHT, its address and the L-1 page note", () => {
    const r = checks.studio_wide.check
    expect(r.status).toBe("FAIL")
    const f = r.findings.find((x) => x.code === "OVERFLOW_RIGHT" && x.address === "9.9")
    expect(f).toBeDefined()
    expect(f!.page).toBeNull()
    expect(f!.detail).toContain("limit L-1")
    expect(f!.amount!).toBeGreaterThan(45)
  })

  test("a one-page NOTA (parity fixture doc_nota_memo) is one printed page and passes OVERLAP_CLIP as PDF and HTML", () => {
    const l = checks.nota_pdf.layout
    expect(l && "metrics" in l ? l.metrics.pageCount : null).toBe(1)
    expect(brief(checks.nota_pdf)).toBe("PASS  ")
    expect(brief(checks.nota_html)).toBe("PASS  ")
  })

  for (const key of [...SLUGS, "datum-nota_tier_NOTA"]) {
    test(`built-in template preview ${key}: rendered, DATUM-37 PASS, release lint PASS, HTML passes OVERLAP_CLIP`, () => {
      const p = previews[key]
      expect(p).toBeDefined()
      expect(p.failed).toEqual([])
      expect(p.lint).not.toBeNull()
      const d37 = p.lint!.checks.filter((c) => c.id === "DATUM-37")
      expect(d37.length).toBeGreaterThan(0)
      expect(d37.map((c) => c.status)).toEqual(d37.map(() => "PASS"))
      const failing = p.lint!.checks.filter((c) => c.status === "FAIL").map((c) => `${c.id}: ${c.detail ?? ""}`)
      expect(failing).toEqual([])
      expect(p.lint!.releaseStatus).toBe("PASS")
      expect(checks[`preview_${key}`]).toBeDefined()
      expect(brief(checks[`preview_${key}`])).toBe("PASS  ")
    })
  }
})
