// Row 151c of docs/2026-11-06_swarm_1_2_0_datum_installer (decision C161): the installed layout in REAL Electron 42.
// I1: the render bridge started as the app starts it (row151c-harness-main.ts: start.ts's options, default policy from
// the fixture HOME and the host's store root `~/.local/share/swarm/datum-studio`) images the stored HTML into
// `<store>/verify/<outputId>/` and runs OVERLAP_CLIP on it, while every other store file and the rest of the protected
// `~/.local/share/swarm` stay refused. L1/L2: row 135b's markup probe (verification/19 L1, L2) now fails the overlap
// instead of passing it. Fixture HOME/userData, mock keychain, dead proxy; the caller's shell trap kills the PID.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { studioStoreRoot } from "../../src/main/datum-studio-host/layout"

const here = import.meta.dir
const electron = join(here, "../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
const runnable = existsSync(electron) && !electron.startsWith("/Applications/") && process.platform === "darwin"
const studioPkg = resolve(here, "../../../datum-studio")
const fontsDir = resolve(here, "../../datum/datum-house-style/assets/fonts")
// A unix socket path is limited to about 104 bytes: when the temp folder is deep (macOS /var/folders/...), use /tmp.
const tmpBase = realpathSync(tmpdir()).length <= 40 ? realpathSync(tmpdir()) : realpathSync("/tmp")
const ownWork = !process.env.ROW151C_WORK
const work = realpathSync(process.env.ROW151C_WORK ?? mkdtempSync(join(tmpBase, "row151c-")))
const home = join(work, "home")
const store = studioStoreRoot({}, home)
const OUT_ID = "c151cstoreoutput0000000001"

type OC = typeof import("../../../datum-studio/src/mcp-host/verify/overlap-clip")
type RT = typeof import("../../../datum-studio/vendor/src/lib/studio/engine/browser/runtime")
let oc: OC
let rt: RT
let run: ReturnType<typeof Bun.spawn> | undefined
let kill: (() => void) | undefined
let bridgeInfo: { DATUM_RENDER_SOCKET: string; scripts: string[]; pid: number; storeRoot: string }
const htmlPath = join(store, "docs", "2026-11-08_row151c", "studio", "001-GSP-NOT", "rev-1", "Kajian row151c.html")
const r: Record<string, unknown> = {}

// Row 135b probe cases (probe/row135b-clobber.test.ts), unchanged markup.
const doc = (css: string, body: string) => `<!doctype html><html lang="id"><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`
const CSS = "@page{size:A4;margin:0}html,body{margin:0;background:#fff}.page{width:210mm;height:297mm;padding:20mm;box-sizing:border-box;position:relative}p{font:10pt/1.45 serif;margin:0 0 3mm}"
const para = (a: string, style = "") => `<p data-block="b-${a}" data-address="${a}"${style ? ` style="${style}"` : ""}>${Array.from({ length: 40 }, (_, i) => `kata${i}`).join(" ")}</p>`
const svg = (inner: string, rootExtra = "") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"${rootExtra} width="100mm" height="30mm" role="img" aria-label="x">${inner}<rect width="10" height="10"/></svg>`
const OVER = (extra: string) => doc(CSS, `<div class="page">${para("1.1")}${para("1.2")}</div><div class="page">${para("2.1")}${para("2.2", "margin-top:-12mm")}${extra}</div>`)
const FIG = (rootExtra: string) => doc(CSS, `<div class="page">${para("1.1")}<figure data-block-id="f1" data-address="1.2" style="margin:-15mm 0 0 0">${svg("", rootExtra)}</figure>${para("1.3")}</div>`)
const PROBE: Record<string, string> = {
  overlap_plain: OVER(""),
  overlap_clobber_body: OVER(`<figure data-block-id="f9" data-address="2.9">${svg('<img name="body"/>')}</figure>`),
  overlap_clobber_qsa: OVER(`<figure data-block-id="f9" data-address="2.9">${svg('<img name="querySelectorAll"/>')}</figure>`),
  overlap_clobber_createRange: OVER(`<figure data-block-id="f9" data-address="2.9">${svg('<img name="createRange"/>')}</figure>`),
  overlap_clobber_form: OVER(`<figure data-block-id="f9" data-address="2.9">${svg('<form name="f"><input name="closest"><input name="tagName"></form>')}</figure>`),
  figure_over_text: FIG(""),
  figure_over_text_aria_hidden: FIG(' aria-hidden="true"'),
  figure_over_text_class_reg: FIG(' class="reg"'),
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return "OK"
  } catch (e) {
    const m = /\(([A-Z_]+)\)/.exec(e instanceof Error ? e.message : String(e))
    return m ? m[1] : "ERROR"
  }
}

beforeAll(async () => {
  if (!runnable) return
  // 1. The installed store layout under the fixture HOME, plus files the bridge must never reach.
  for (const d of [join(htmlPath, ".."), join(store, "verify"), join(store, "tmp"), join(store, "assets"), join(home, ".local/share/swarm/opencode")]) mkdirSync(d, { recursive: true })
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: process.env.TMPDIR ?? tmpdir(), HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost" }
  const gen = Bun.spawnSync([process.execPath, "test/verify-overlap/make-studio-fixture.ts", htmlPath], { cwd: studioPkg, env, stdout: "pipe", stderr: "pipe" })
  if (gen.exitCode !== 0) throw new Error(`studio fixture: ${gen.stderr.toString()}`)
  writeFileSync(join(store, "datum-studio.sqlite"), "SQLite format 3\0 fixture")
  writeFileSync(join(store, "assets", "a.html"), "<p>asset</p>")
  writeFileSync(join(store, "tmp", "t.html"), "<p>tmp</p>")
  writeFileSync(join(home, ".local/share/swarm/opencode/auth.json"), '{"token":"fixture"}')
  writeFileSync(join(home, ".local/share/swarm/opencode/auth.html"), "<p>auth</p>")
  symlinkSync(join(store, "datum-studio.sqlite"), join(htmlPath, "..", "db.html"))

  // 2. The harness: the app's bridge options on the repo's Electron binary.
  const main = await Bun.build({ entrypoints: [join(here, "row151c-harness-main.ts")], target: "node", format: "esm", external: ["electron"], outdir: join(work, "bundle"), naming: "main.mjs" })
  if (!main.success) throw new Error(main.logs.join("\n"))
  run = Bun.spawn([electron, "--use-mock-keychain", join(work, "bundle", "main.mjs")], {
    env: { ...env, ROW151C_WORK: work, ROW151C_FONTS: fontsDir, ELECTRON_ENABLE_LOGGING: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  writeFileSync(join(work, "electron.pid"), String(run.pid))
  const child = run
  kill = () => {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL")
  }
  process.on("exit", () => kill?.())
  const deadline = Date.now() + 60_000
  while (!existsSync(join(work, "bridge.json"))) {
    if (child.exitCode !== null) throw new Error(`harness exited early (${child.exitCode}): ${existsSync(join(work, "result.json")) ? readFileSync(join(work, "result.json"), "utf8") : ""}`)
    if (Date.now() > deadline) throw new Error("bridge did not start in 60 s")
    await Bun.sleep(100)
  }
  bridgeInfo = JSON.parse(readFileSync(join(work, "bridge.json"), "utf8"))
  process.env.DATUM_RENDER_SOCKET = bridgeInfo.DATUM_RENDER_SOCKET
  process.env.DATUM_RENDER_TOKEN = (bridgeInfo as unknown as { DATUM_RENDER_TOKEN: string }).DATUM_RENDER_TOKEN
  process.env.STUDIO_ASSETS_ROOT ??= join(studioPkg, "vendor", "src", "lib", "studio", "assets")
  if (!process.env.STUDIO_WORKSPACE_ROOT) {
    mkdirSync(join(work, "ws"), { recursive: true })
    process.env.STUDIO_WORKSPACE_ROOT = join(work, "ws")
  }
  oc = await import("../../../datum-studio/src/mcp-host/verify/overlap-clip")
  rt = await import("../../../datum-studio/vendor/src/lib/studio/engine/browser/runtime")

  // 3. I1: page images of the stored HTML into the store's verify folder, and OVERLAP_CLIP on the stored HTML.
  const dstDir = join(store, "verify", OUT_ID)
  mkdirSync(dstDir, { recursive: true })
  try {
    r.pages = await rt.rasterizeHtmlPages({ src: htmlPath, dstDir, pages: [1, 2] })
  } catch (e) {
    r.pages = { error: e instanceof Error ? e.message : String(e) }
  }
  const html = readFileSync(htmlPath, "utf8")
  r.overlapStored = await oc.runOverlapClip({ format: "HTML", html, pageWidthMm: 210, pageHeightMm: 297 })
  // Refused: other store files, the rest of ~/.local/share/swarm, writes outside verify/<id>/.
  const refused: Record<string, string> = {}
  const src = (p: string) => rt.rasterizeHtmlPages({ src: p, dstDir, pages: [1] })
  refused.src_sqlite = await codeOf(src(join(store, "datum-studio.sqlite")))
  refused.src_link_to_sqlite = await codeOf(src(join(htmlPath, "..", "db.html")))
  refused.src_assets_html = await codeOf(src(join(store, "assets", "a.html")))
  refused.src_tmp_html = await codeOf(src(join(store, "tmp", "t.html")))
  refused.src_auth_json = await codeOf(src(join(home, ".local/share/swarm/opencode/auth.json")))
  refused.src_auth_html = await codeOf(src(join(home, ".local/share/swarm/opencode/auth.html")))
  const dst = (d: string) => rt.rasterizeHtmlPages({ src: htmlPath, dstDir: d, pages: [1] })
  refused.dst_store_root = await codeOf(dst(store))
  refused.dst_store_tmp = await codeOf(dst(join(store, "tmp")))
  refused.dst_docs = await codeOf(dst(join(htmlPath, "..")))
  refused.dst_verify_itself = await codeOf(dst(join(store, "verify")))
  refused.dst_opencode = await codeOf(dst(join(home, ".local/share/swarm/opencode")))
  r.refused = refused

  // 4. L1/L2: row 135b's probe, through the same real bridge (raw markup, and the vendored sanitizer's output).
  const { sanitizeSvg } = await import("../../../datum-studio/vendor/src/lib/studio/engine/html/tables/svg")
  const probe: Record<string, unknown> = {}
  for (const [name, h] of Object.entries(PROBE)) {
    const x = await oc.runOverlapClip({ format: "HTML", html: h, pageWidthMm: 210, pageHeightMm: 297 })
    probe[name] = { status: x.check.status, reason: x.check.reason, findings: x.check.findings.map((f) => `${f.code} p${f.page ?? "-"} ${f.address ?? "-"}`), boxes: x.overlap?.boxes ?? null }
  }
  const sanitized = sanitizeSvg(svg('<img name="body"/>', ' aria-hidden="true"'), { idPrefix: "f9", widthMm: 100, heightMm: 30 })
  probe.sanitized_svg = sanitized.svg
  const y = await oc.runOverlapClip({ format: "HTML", html: OVER(`<figure data-block-id="f9" data-address="2.9">${sanitized.svg}</figure>`), pageWidthMm: 210, pageHeightMm: 297 })
  probe.overlap_sanitized = { status: y.check.status, boxes: y.overlap?.boxes ?? null }
  r.probe = probe
  writeFileSync(join(work, "results.json"), JSON.stringify(r, (k, v) => (k === "elements" ? `[${(v as unknown[]).length}]` : v), 2))
}, 240_000)

afterAll(async () => {
  if (!runnable || !run) return
  writeFileSync(join(work, "stop"), "")
  const t = setTimeout(() => kill?.(), 10_000)
  const [out, err, code] = await Promise.all([new Response(run.stdout as ReadableStream).text(), new Response(run.stderr as ReadableStream).text(), run.exited])
  clearTimeout(t)
  kill?.()
  writeFileSync(join(work, "electron.log"), `pid ${run.pid} exit ${code}\n--- stdout\n${out}\n--- stderr\n${err}`)
  console.log(`row151c work dir: ${work} (electron pid ${run.pid}, exit ${code})`)
  // Best effort: remove the folder only when this file created it (the env var was unset).
  if (ownWork) rmSync(work, { recursive: true, force: true })
}, 30_000)

describe.skipIf(!runnable)("row 151c: the installed store layout in real Electron (C161 I1)", () => {
  test("the bridge runs with the app's allow-list and the host's store root under the protected ~/.local/share/swarm", () => {
    expect(bridgeInfo.storeRoot).toBe(join(home, ".local", "share", "swarm", "datum-studio"))
    expect(bridgeInfo.scripts).toContain("studio.measure")
    expect(bridgeInfo.scripts).toContain("swarm.verify.overlap")
  })

  test("pagePng reads the stored HTML and writes page images into <store>/verify/<outputId>/", () => {
    const p = r.pages as { pages?: Array<{ n: number; png: string }>; error?: string }
    console.log("[row151c] pages", JSON.stringify(p).slice(0, 400))
    expect(p.error).toBeUndefined()
    expect(p.pages!.map((x) => x.n)).toEqual([1, 2])
    for (const x of p.pages!) {
      expect(x.png.startsWith(join(store, "verify", OUT_ID) + "/")).toBe(true)
      expect(readFileSync(x.png).subarray(0, 4).toString("hex")).toBe("89504e47")
    }
  })

  test("OVERLAP_CLIP runs on the stored HTML (real measurement, not BRIDGE_UNAVAILABLE)", () => {
    const x = r.overlapStored as Awaited<ReturnType<OC["runOverlapClip"]>>
    console.log("[row151c] overlap on stored html", JSON.stringify({ status: x.check.status, reason: x.check.reason, boxes: x.overlap?.boxes, scanned: x.overlap?.scanned }))
    expect(x.check.status).toBe("PASS")
    expect(x.overlap!.boxes).toBeGreaterThan(0)
  })

  test("every other store file and the rest of ~/.local/share/swarm stay refused (PATH_REFUSED; non-HTML src BAD_REQUEST)", () => {
    console.log("[row151c] refused", JSON.stringify(r.refused))
    // Non-HTML sources never reach the policy: the protocol refuses them first (BAD_REQUEST, protocol.ts pagePng src
    // must end .html). The link db.html -> sqlite reaches it and is refused by its real path.
    const nonHtml = new Set(["src_sqlite", "src_auth_json"])
    for (const [k, v] of Object.entries(r.refused as Record<string, string>)) expect([k, v]).toEqual([k, nonHtml.has(k) ? "BAD_REQUEST" : "PATH_REFUSED"])
    expect(existsSync(join(store, "witness-p001.png"))).toBe(false)
    expect(existsSync(join(store, "tmp", "witness-p001.png"))).toBe(false)
  })
})

describe.skipIf(!runnable)("row 151c: row 135b's markup probe now fails the overlap (C161 L1/L2)", () => {
  const P = () => r.probe as Record<string, { status: string; reason: string | null; findings: string[]; boxes: number | null }>
  test("baseline: a real overlap is FAIL", () => {
    console.log("[row151c] probe", JSON.stringify(r.probe))
    expect(P().overlap_plain.status).toBe("FAIL")
  })
  test("L1: named elements cannot hide the boxes (<img name=body|querySelectorAll|createRange>, form members): FAIL with the same overlap", () => {
    for (const k of ["overlap_clobber_body", "overlap_clobber_qsa", "overlap_clobber_createRange", "overlap_clobber_form"]) {
      expect([k, P()[k].status]).toEqual([k, "FAIL"])
      expect(P()[k].findings).toContain("OVERLAP p2 2.1")
      expect(P()[k].boxes!).toBeGreaterThan(0)
    }
  })
  test("L2: aria-hidden or a furniture class on a figure root no longer hides the figure's overlap", () => {
    expect(P().figure_over_text.status).toBe("FAIL")
    expect(P().figure_over_text_aria_hidden.status).toBe("FAIL")
    expect(P().figure_over_text_class_reg.status).toBe("FAIL")
  })
  test("the sanitizer drops the breakout <img> and the root aria-hidden; the overlap is still found", () => {
    const s = (r.probe as Record<string, unknown>).sanitized_svg as string
    expect(s).not.toContain("<img")
    expect(s).not.toContain("aria-hidden")
    expect(((r.probe as Record<string, { status: string }>).overlap_sanitized).status).toBe("FAIL")
  })
})
