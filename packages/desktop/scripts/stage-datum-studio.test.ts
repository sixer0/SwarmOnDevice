// Row 36 (Swarm 1.2.0, C79): the DATUM Studio stage and its verify, and a built-in template render from the STAGED
// folder with STUDIO_ASSETS_ROOT / assetRepoRoot exactly as layout.ts computes them for a packaged app (fake Resources).
// Real files only: the repo's launcher, bridge, CLAUDE_SETUP.md, templates and vendor assets; a real temp store and the
// vendored renderSnapshot. The only stand-in is the render bridge transport (as in datum-studio test/templates-logo),
// which a DOCX/HTML render does not need for its files.
import { $ } from "bun"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { resolveStudioLayout, STUDIO_ASSETS_REL } from "../src/main/datum-studio-host/layout"
import {
  BRIDGE,
  ELK_BUNDLE,
  ELK_BUNDLE_SHA256,
  ELK_DIR,
  ELK_LICENSE,
  ELK_LICENSE_SHA256,
  ELK_NOTICE,
  ELK_PACKAGE_JSON,
  LAUNCHER,
  sha256,
  stageDatumStudio,
  SZ3_LIMIT_KB,
  verifyStudioStage,
  type StudioManifest,
} from "./stage-datum-studio"

const SCRIPT = path.join(import.meta.dir, "stage-datum-studio.ts")
const PKG = path.resolve(import.meta.dir, "..", "..", "datum-studio")
const SCRATCH = process.env.ROW36_TEST_DIR ?? "/private/tmp/claude-501/row36"
mkdirSync(SCRATCH, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(SCRATCH, "stage-test-")))
// A fake app: <WORK>/Fake.app/Contents/Resources/datum-studio is what electron-builder copies the stage to (row 45).
const RES = path.join(WORK, "Fake.app", "Contents", "Resources")
const STAGED = path.join(RES, "datum-studio")
const STORE = path.join(WORK, "store", "datum-studio")
const TPL_LOG = path.join(WORK, "logs", "templates.jsonl")

const SEAL = "a43657da7dd8e5c06e3474a15b349036a0066011d8272597840f5b3bb8dfe95d"
const TINTA = "69636059ddc4155c66430007d9c8bf280ce44090f408b5ab557f5efd0962111e"
const CLAUDE_SETUP_SHA = "e74825fd1a7a9c3eb6e16044e67f7c97c9c65a92b9f27e96bdc9467ff1145ecb"

let manifest: StudioManifest

/** A copy of the staged folder for one tamper case. */
async function copyStage(name: string) {
  const dir = path.join(WORK, "tamper", name)
  await fs.mkdir(path.dirname(dir), { recursive: true })
  await fs.cp(STAGED, dir, { recursive: true, preserveTimestamps: true })
  return dir
}

beforeAll(async () => {
  const r = await stageDatumStudio({ out: STAGED })
  manifest = r.manifest
}, 120_000)

describe("row 36: stage and verify", () => {
  test("the stage verifies: every file listed with sha256, SZ-3, SZ-3a/b/c, MACHO-1, A.4 Plex pairs", async () => {
    const v = await verifyStudioStage(STAGED)
    console.log(`row36: files=${v.files} bytes=${v.bytes} du_kb=${v.duKb} limit=${SZ3_LIMIT_KB} ttf=${v.ttf} renamed=${v.renamed} ts=${v.ts} macho=${v.macho} plex=${v.plexPairs}`)
    expect(v.problems).toEqual([])
    expect(v.duKb).toBeLessThanOrEqual(SZ3_LIMIT_KB)
    expect([v.ttf, v.renamed, v.ts, v.macho, v.plexPairs]).toEqual([19, 0, 0, 0, 16])
    expect(manifest.files.length).toBe(v.files)
    expect(manifest.counts.templates).toBe(16)
    expect(manifest.provenanceCommit.startsWith("b0ae7a729d")).toBe(true)
  })

  test("contents: launcher 0755, bridge 0644 built for bun, CLAUDE_SETUP verbatim, C79 asset folder, no renamed/c40_fixes", async () => {
    const byPath = new Map(manifest.files.map((f) => [f.path, f]))
    expect((await fs.stat(path.join(STAGED, LAUNCHER))).mode & 0o777).toBe(0o755)
    expect(byPath.get(LAUNCHER)!.sha256).toBe(sha256(readFileSync(path.join(import.meta.dir, "datum-studio-launcher.sh"))))
    expect((await fs.stat(path.join(STAGED, BRIDGE))).mode & 0o777).toBe(0o644)
    expect(readFileSync(path.join(STAGED, BRIDGE), "utf8").startsWith("// @bun")).toBe(true)
    expect(byPath.get("CLAUDE_SETUP.md")!.sha256).toBe(CLAUDE_SETUP_SHA)
    expect(byPath.get(`${STUDIO_ASSETS_REL}/logo/gsp-seal.png`)!.sha256).toBe(SEAL)
    expect(byPath.get(`${STUDIO_ASSETS_REL}/logo/gsp-tinta.png`)!.sha256).toBe(TINTA)
    expect(manifest.files.filter((f) => f.path.startsWith(`${STUDIO_ASSETS_REL}/logo/`)).length).toBe(6)
    expect(manifest.files.some((f) => f.path.startsWith("assets/"))).toBe(false)
    expect(manifest.files.some((f) => /renamed|c40_fixes|bunfig|\.env/.test(f.path))).toBe(false)
    expect(manifest.files.filter((f) => f.path.startsWith("server/")).map((f) => f.path)).toEqual([BRIDGE])
    const catalog = JSON.parse(readFileSync(path.join(STAGED, "templates", "catalog.json"), "utf8")) as { templates: Array<{ file: string; sha256: string }> }
    for (const t of catalog.templates) expect(byPath.get(`templates/${t.file}`)!.sha256).toBe(t.sha256)
    expect(manifest.files.filter((f) => f.path.startsWith("templates/")).length).toBe(catalog.templates.length + 1)
    // Staging twice gives the same manifest (no timestamps; the bridge bundle is reproducible).
    const again = await stageDatumStudio({ out: path.join(WORK, "again", "datum-studio") })
    expect(JSON.stringify(again.manifest)).toBe(JSON.stringify(manifest))
  }, 120_000)

  test("a tampered byte, an unlisted file, a launcher without x, a renamed font, a symlink each fail verify", async () => {
    const logo = `${STUDIO_ASSETS_REL}/logo/gsp-seal.png`
    const flip = await copyStage("byte")
    const file = path.join(flip, logo)
    const bytes = readFileSync(file)
    bytes[100] ^= 0x01
    await fs.writeFile(file, bytes)
    const v = await verifyStudioStage(flip)
    console.log(`row36: tampered byte -> ${JSON.stringify(v.problems)}`)
    expect(v.problems).toEqual([`sha256 ${logo}`])
    const cli = await $`${process.execPath} ${SCRIPT} --verify --out ${flip}`.nothrow().quiet()
    console.log(`row36: CLI verify on tampered copy exit=${cli.exitCode} ${cli.stderr.toString().trim()}`)
    expect(cli.exitCode).toBe(1)
    expect(cli.stderr.toString()).toContain(`DATUM_STUDIO_STAGE_FAIL sha256 ${logo}`)
    expect(cli.stdout.toString()).not.toContain("DATUM_STUDIO_STAGE_OK")

    const extra = await copyStage("extra")
    await fs.writeFile(path.join(extra, "server", "bunfig.toml"), "")
    expect((await verifyStudioStage(extra)).problems).toEqual(expect.arrayContaining(["unlisted file server/bunfig.toml"]))

    const mode = await copyStage("mode")
    await fs.chmod(path.join(mode, LAUNCHER), 0o644)
    expect((await verifyStudioStage(mode)).problems).toEqual([`mode ${LAUNCHER} 644 != 755`])

    const renamed = await copyStage("renamed")
    await fs.mkdir(path.join(renamed, STUDIO_ASSETS_REL, "fonts", "renamed"))
    await fs.writeFile(path.join(renamed, STUDIO_ASSETS_REL, "fonts", "renamed", "IBMPlexSans-Bold.ttf"), "x")
    expect((await verifyStudioStage(renamed)).problems).toEqual(expect.arrayContaining([expect.stringContaining("SZ-3a")]))

    const link = await copyStage("symlink")
    await fs.rm(path.join(link, "CLAUDE_SETUP.md"))
    await fs.symlink(path.join(PKG, "CLAUDE_SETUP.md"), path.join(link, "CLAUDE_SETUP.md"))
    expect((await verifyStudioStage(link)).problems).toEqual(["not a regular file CLAUDE_SETUP.md"])

    const real = await $`${process.execPath} ${SCRIPT} --verify --out ${STAGED}`.nothrow().quiet()
    expect(real.exitCode).toBe(0)
    expect(real.stdout.toString()).toContain(`DATUM_STUDIO_STAGE_OK ${STAGED}`)
  }, 120_000)
})

// ---- Row 162c (C126, C153): elkjs shipped as its own unmodified file with LICENSE.md and a notice ----

describe("row 162c: third_party/elkjs in the stage", () => {
  const ELK_NPM = path.join(PKG, "node_modules", "elkjs")

  test("elk.bundled.js and LICENSE.md byte-identical to the npm 0.12.0 files and the pins; notice text; CommonJS marker", async () => {
    const byPath = new Map(manifest.files.map((f) => [f.path, f]))
    const third = manifest.files.filter((f) => f.path.startsWith("third_party/")).map((f) => f.path)
    expect(third).toEqual([ELK_LICENSE, ELK_NOTICE, ELK_BUNDLE, ELK_PACKAGE_JSON])
    expect(byPath.get(ELK_BUNDLE)!.sha256).toBe(ELK_BUNDLE_SHA256)
    expect(byPath.get(ELK_BUNDLE)!.sha256).toBe(sha256(readFileSync(path.join(ELK_NPM, "lib", "elk.bundled.js"))))
    expect(byPath.get(ELK_LICENSE)!.sha256).toBe(ELK_LICENSE_SHA256)
    expect(byPath.get(ELK_LICENSE)!.sha256).toBe(sha256(readFileSync(path.join(ELK_NPM, "LICENSE.md"))))
    expect(readFileSync(path.join(STAGED, ELK_BUNDLE), "utf8").startsWith("(function(f){if(typeof exports===\"object\"")).toBe(true)
    const notice = readFileSync(path.join(STAGED, ELK_NOTICE), "utf8")
    expect(notice).toContain(
      "elkjs 0.12.0, EPL-2.0 OR GPL-3.0-or-later (distributed under EPL-2.0), Source Code: https://github.com/kieler/elkjs.git",
    )
    expect(JSON.parse(readFileSync(path.join(STAGED, ELK_PACKAGE_JSON), "utf8"))).toEqual({ type: "commonjs" })
    for (const p of third) expect(byPath.get(p)!.mode).toBe("644")
  })

  test("ELK-1: a changed bundle (manifest updated to match), an extra third_party file each fail verify", async () => {
    const changed = await copyStage("elk-changed")
    const file = path.join(changed, ELK_BUNDLE)
    await fs.appendFile(file, "\n// patched\n")
    const m = JSON.parse(readFileSync(path.join(changed, "studio-manifest.json"), "utf8")) as StudioManifest
    const entry = m.files.find((f) => f.path === ELK_BUNDLE)!
    entry.sha256 = sha256(readFileSync(file))
    entry.size = (await fs.stat(file)).size
    await fs.writeFile(path.join(changed, "studio-manifest.json"), `${JSON.stringify(m, null, 1)}\n`)
    const v = await verifyStudioStage(changed)
    console.log(`row162c: changed bundle -> ${JSON.stringify(v.problems)}`)
    expect(v.problems).toEqual([`ELK-1: ${ELK_BUNDLE} sha256 ${entry.sha256} is not the pinned ${ELK_BUNDLE_SHA256}`])

    const extra = await copyStage("elk-extra")
    const extraRel = `${ELK_DIR}/elk-worker.min.js`
    await fs.writeFile(path.join(extra, extraRel), "x")
    const m2 = JSON.parse(readFileSync(path.join(extra, "studio-manifest.json"), "utf8")) as StudioManifest
    m2.files.push({ path: extraRel, size: 1, sha256: sha256("x"), mode: "644" })
    await fs.writeFile(path.join(extra, "studio-manifest.json"), `${JSON.stringify(m2, null, 1)}\n`)
    expect((await verifyStudioStage(extra)).problems).toEqual([`ELK-1: unexpected third_party file(s): ${extraRel}`])

    const gone = await copyStage("elk-gone")
    await fs.rm(path.join(gone, ELK_NOTICE))
    expect((await verifyStudioStage(gone)).problems).toEqual([`missing ${ELK_NOTICE}`])
  }, 120_000)

  test("the host-side loader (elk-runtime.ts) picks the staged copy under the packaged layout and gets the ELK constructor", async () => {
    const rt = await import("../src/main/datum-studio-host/elk-runtime")
    expect(layout.vendorRoot).toBe(STAGED)
    expect(rt.resolveElkBundle({ STUDIO_VENDOR_ROOT: layout.vendorRoot })).toEqual({ file: path.join(STAGED, ELK_BUNDLE) })
    expect(typeof rt.loadElkConstructor({ STUDIO_VENDOR_ROOT: layout.vendorRoot })).toBe("function")
  })
})

// ---- C79: render from the staged folder with the packaged layout ----

type Templates = typeof import("../../datum-studio/vendor/src/lib/studio/services/templates")
let templates: Templates
let sampleMod: typeof import("../../datum-studio/vendor/src/lib/studio/services/templates/sample-render")
let runtime: typeof import("../../datum-studio/vendor/src/lib/studio/engine/browser/runtime")
let env: typeof import("../../datum-studio/vendor/src/lib/studio/contract/env")
let store: { close?: unknown }
let bridgeMod: typeof import("../../datum-studio/src/store-bridge/index.ts")
let fflate: typeof import("fflate")
const layout = resolveStudioLayout({ isPackaged: true, resourcesPath: RES, appPath: "/ignored" })

describe("row 36 / C79: built-in render against the staged Res/datum-studio", () => {
  beforeAll(async () => {
    process.env.STUDIO_WORKSPACE_ROOT = STORE
    process.env.STUDIO_ASSETS_ROOT = layout.assetsRoot
    mkdirSync(path.dirname(TPL_LOG), { recursive: true })
    fflate = await import(Bun.resolveSync("fflate", PKG))
    bridgeMod = await import("../../datum-studio/src/store-bridge/index.ts")
    store = await bridgeMod.openHostStore(STORE, { release: "1.2.0", logFile: path.join(WORK, "logs", "store.jsonl") })
    templates = await import("../../datum-studio/vendor/src/lib/studio/services/templates")
    templates.configureTemplateSource({ templatesDir: layout.templatesDir, assetRepoRoot: layout.assetRepoRoot, release: "1.2.0" })
    templates.setTemplatesLogSink((e) => appendFileSync(TPL_LOG, `${JSON.stringify(e)}\n`))
    sampleMod = await import("../../datum-studio/vendor/src/lib/studio/services/templates/sample-render")
    runtime = await import("../../datum-studio/vendor/src/lib/studio/engine/browser/runtime")
    env = await import("../../datum-studio/vendor/src/lib/studio/contract/env")
    runtime.setRenderBridgeTransport(async (req) => {
      if (req.op === "hello") return { ok: true, electron: "42.3.3", chrome: "142.0.0.0", partition: "datum-render", sandbox: true, contextIsolation: true, nodeIntegration: false, javascriptContent: false, network: "blocked", fonts: 20, scripts: ["studio.measure"] }
      if (req.op === "checkPage") return { ok: true, electron: "42.3.3", script: "studio.measure", result: { paged: true, pageCount: 6, truncated: false, elements: [] } }
      return { ok: false, code: "UNKNOWN_OP", message: String(req.op) }
    })
    await templates.ensureBuiltinTemplates()
  }, 120_000)

  afterAll(async () => {
    runtime?.setRenderBridgeTransport(null)
    templates?.configureTemplateSource(null as never)
    templates?.setTemplatesLogSink(null)
    if (store) await bridgeMod.closeHostStore(store as never)
  })

  test("layout: packaged paths point into the staged folder; assetsRoot == <assetRepoRoot>/src/lib/studio/assets", () => {
    expect(layout).toEqual({
      root: STAGED,
      assetsRoot: path.join(STAGED, "src", "lib", "studio", "assets"),
      templatesDir: path.join(STAGED, "templates"),
      vendorRoot: STAGED,
      assetRepoRoot: STAGED,
      kind: "packaged",
    })
  })

  test("the pre-C79 shape (STUDIO_ASSETS_ROOT = <root>/assets) is refused PATH_OUTSIDE_ROOT; the C79 shape resolves", () => {
    const rel = "src/lib/studio/assets/logo/gsp-seal.png"
    const abs = templates.resolveRepoAssetPath(rel, layout.assetRepoRoot)
    expect(abs).toBe(path.join(layout.assetsRoot, "logo", "gsp-seal.png"))
    expect(env.assertStudioAssetPath(abs)).toBe(abs)
    process.env.STUDIO_ASSETS_ROOT = path.join(STAGED, "assets")
    try {
      let code = ""
      try {
        env.assertStudioAssetPath(abs)
      } catch (error) {
        code = (error as { code?: string }).code ?? String(error)
      }
      console.log(`row36: pre-C79 shape -> ${code}`)
      expect(code).toBe("PATH_OUTSIDE_ROOT")
    } finally {
      process.env.STUDIO_ASSETS_ROOT = layout.assetsRoot
    }
  })

  async function renderBuiltin(slug: string, language: "ID" | "EN") {
    const d = await templates.getTemplate(slug)
    const side = await sampleMod.sideFromVersion(d.version.id)
    const doc = sampleMod.swarmSampleDocument({ slug, tier: "TERBIT", slots: side.skeleton.skeleton.slots, language })
    const out = await sampleMod.renderSample(side, doc, { tier: "TERBIT", formats: ["DOCX", "HTML"], timeoutMs: 60_000, correlationId: `row36-${slug}`, measureLayout: false })
    expect(out.ingest.valid).toBe(true)
    expect(out.render!.status).toBe("SUCCEEDED")
    const docx = out.render!.files.find((f) => f.format === "DOCX" && f.role === "PRIMARY")!
    const html = out.render!.files.find((f) => f.format === "HTML" && f.role === "PRIMARY")!
    return { docx: docx.data as Uint8Array, html: typeof html.data === "string" ? html.data : fflate.strFromU8(html.data as Uint8Array) }
  }

  const docxLogoParts = (docx: Uint8Array, want: string) => {
    const z = fflate.unzipSync(docx)
    return Object.keys(z).filter((k) => k.startsWith("word/media/") && sha256(z[k]) === want)
  }
  const htmlCoverLogo = (html: string, want: string) => {
    const hits = [...html.matchAll(/<img\b[^>]*>/g)]
      .map((m) => m[0])
      .filter((tag) => {
        const src = /src="data:image\/png;base64,([^"]+)"/.exec(tag)
        return src !== null && sha256(Buffer.from(src[1], "base64")) === want
      })
    const at = hits.length ? html.indexOf(hits[0]) : -1
    const cover = html.indexOf('data-wrapper="cover"')
    const next = html.indexOf("data-wrapper=", cover + 1)
    return { hits: hits.length, onCover: cover >= 0 && at > cover && (next < 0 || at < next), style: hits[0] ? (/style="([^"]+)"/.exec(hits[0])?.[1] ?? "") : "" }
  }

  test("every builtin resolves its logo inside the staged STUDIO_ASSETS_ROOT", async () => {
    const catalog = JSON.parse(readFileSync(path.join(layout.templatesDir, "catalog.json"), "utf8")) as { templates: Array<{ slug: string; language: string }> }
    for (const e of catalog.templates) {
      const t = await templates.resolveTemplate(e.slug)
      expect(t.assets.logo.absPath).toBe(path.join(layout.assetsRoot, "logo", e.language === "EN" ? "gsp-tinta.png" : "gsp-seal.png"))
    }
  })

  test("ID datum-gsp and EN datum-laporan-en: DOCX + HTML render from the staged layout with the cover logo", async () => {
    for (const [slug, lang, want] of [
      ["datum-gsp", "ID", SEAL],
      ["datum-laporan-en", "EN", TINTA],
    ] as const) {
      const r = await renderBuiltin(slug, lang)
      const parts = docxLogoParts(r.docx, want)
      const h = htmlCoverLogo(r.html, want)
      console.log(`row36: ${slug} DOCX bytes=${r.docx.length} logoParts=${parts.join(",")} HTML bytes=${r.html.length} logoImgs=${h.hits} onCover=${h.onCover} style=${h.style}`)
      expect(parts.length).toBe(1)
      expect(h.hits).toBe(1)
      expect(h.onCover).toBe(true)
      expect(h.style).toContain("width:44mm")
    }
    const log = await fs.readFile(TPL_LOG, "utf8").catch(() => "")
    expect(log.includes("PATH_OUTSIDE_ROOT")).toBe(false)
  }, 120_000)
})
