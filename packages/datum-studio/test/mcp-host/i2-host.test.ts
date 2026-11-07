// Integration pass I-2 (Swarm 1.2.0): host seams of start.ts and the figure preview route.
//   C66: start refuses a store opened at another root than the cached STUDIO_WORKSPACE_ROOT (realpaths compared).
//   C72: the templates log sink is pointed at <store>/logs/datum-studio-templates.jsonl while the host runs.
//   C74: the figure preview route draws an ID document's in-SVG key as KUNCI (row 124b diagramApparatusOptions).
// Real store in a temp folder, loopback port 0, no network, no model, no browser.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync } from "node:fs"
import path from "node:path"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const STUDIO = path.join(VENDOR, "src", "lib", "studio")
const TEMPLATES = path.join(PKG, "templates")
const BASE = process.env.I2_TEST_DIR ?? "/private/tmp/claude-501/i2/tests"
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "i2-host-")))
const STORE = path.join(WORK, "datum-studio")
const OTHER = path.join(WORK, "other-root")
const LINK = path.join(WORK, "store-link")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
for (const d of [HOME, RES, OTHER]) mkdirSync(d, { recursive: true })
const TOKEN = "d".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }
const TEMPLATES_LOG = path.join(STORE, "logs", "datum-studio-templates.jsonl")

type Mod = typeof import("../../src/mcp-host/index.ts")
let mod: Mod
let env: typeof import("../../vendor/src/lib/studio/contract/env")
let tlog: typeof import("../../vendor/src/lib/studio/services/templates/log")
let store: Awaited<ReturnType<Mod["openHostStore"]>>
const log = () => undefined

function useRoot(root: string) {
  process.env.STUDIO_WORKSPACE_ROOT = root
  env.resetStudioEnvCache()
}

async function resetProcessCaches() {
  const { resetBridgePdfReadiness } = await import("../../vendor/src/lib/studio/services/render")
  const { resetRenderRateLimiter } = await import("../../vendor/src/lib/studio/http/render-guard")
  env.resetStudioEnvCache()
  resetBridgePdfReadiness()
  resetRenderRateLimiter()
  delete process.env.DATUM_RENDER_SOCKET
  delete process.env.DATUM_RENDER_TOKEN
}

beforeAll(async () => {
  env = await import("../../vendor/src/lib/studio/contract/env")
  tlog = await import("../../vendor/src/lib/studio/services/templates/log")
  process.env.STUDIO_ASSETS_ROOT = path.join(STUDIO, "assets")
  process.env.STUDIO_VENDOR_ROOT = VENDOR
  await resetProcessCaches()
  useRoot(STORE)
  mod = await import("../../src/mcp-host/index.ts")
  store = await mod.openHostStore(STORE, { release: "1.2.0", logFile: path.join(STORE, "logs", "datum-studio-store.jsonl") })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.0" })
})

afterAll(async () => {
  mod?.configureTemplateSource(null)
  if (store) await mod.closeHostStore(store)
  tlog?.setTemplatesLogSink(null)
  await resetProcessCaches()
})

describe("I-2 C66: store root = cached STUDIO_WORKSPACE_ROOT", () => {
  test("a cached env root other than the store's root is refused with HostConfigError (CONFIG_INVALID)", async () => {
    useRoot(OTHER)
    expect(env.getStudioEnv().workspaceRoot).toBe(OTHER)
    try {
      const err = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts: FACTS }).then(
        () => null,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(mod.HostConfigError)
      expect((err as { code: string }).code).toBe("CONFIG_INVALID")
      expect(String((err as Error).message)).toContain("another root")
    } finally {
      useRoot(STORE)
    }
  })

  test("the same folder reached through a symlink is accepted (realpaths are compared)", async () => {
    if (!existsSync(LINK)) symlinkSync(STORE, LINK)
    useRoot(LINK)
    try {
      const host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts: FACTS })
      await host.close()
    } finally {
      useRoot(STORE)
    }
  })
})

describe("I-2 C72: templates log sink in the store's log folder", () => {
  test("while the host runs a templates log entry lands in <store>/logs/datum-studio-templates.jsonl; after close it does not", async () => {
    const host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts: FACTS })
    try {
      tlog.templatesLog({ level: "warn", message: "i2 probe while running", code: "I2_PROBE", correlationId: "i2-cid", context: { slug: "datum-gsp" } })
    } finally {
      await host.close()
    }
    tlog.templatesLog({ level: "info", message: "i2 probe after close", code: "I2_AFTER" })
    await new Promise((r) => setTimeout(r, 20))
    const lines = readFileSync(TEMPLATES_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
    const probe = lines.find((l) => l.message === "i2 probe while running")
    expect(probe).toMatchObject({ level: "warn", source: "studio.services.templates", correlationId: "i2-cid", context: { code: "I2_PROBE", slug: "datum-gsp" } })
    expect(typeof probe?.timestamp).toBe("string")
    expect(lines.some((l) => l.message === "i2 probe after close")).toBe(false)
  })
})

describe("I-2 C74: figure preview route key in the document language", () => {
  test("renderResolved with lang ID draws KUNCI (not KEY); EN draws KEY", async () => {
    const route = await import("../../src/mcp-host/local-api/routes/figure-preview-figure.ts")
    const compose = await import(path.join(STUDIO, "services", "compose", "blocks.ts"))
    const block = JSON.parse(readFileSync(path.join(PKG, "test", "engine-rev-a", "svg", "fixtures", "case05_diagram_block.json"), "utf8"))
    const spec = compose.diagramSpec(block.spec, block.caption.text, block.source.text, 128, { artifactLabel: "4.1", classification: "TERBATAS" })
    const tpl = { params: {} } as never
    const svgOf = (lang?: "ID" | "EN") =>
      route.renderResolved({ block: { type: "diagram", address: "1.1", content: {} } as never, type: "diagram", spec }, tpl, { inline: true, withSvg: true, ...(lang ? { lang } : {}) }).svg as string
    const id = svgOf("ID")
    expect(id).toContain("KUNCI  ")
    expect(id).not.toMatch(/>KEY  /)
    expect(id).toContain("PENUH = ")
    expect(svgOf("EN")).toContain("KEY  ")
  })
})
