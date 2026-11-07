import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { assertStoreRootAllowed, resolveStudioLayout, STUDIO_ASSETS_REL, studioStoreLogFile, studioStoreRoot } from "./layout"

const SCRATCH = "/private/tmp/claude-501/row111"
mkdirSync(SCRATCH, { recursive: true })
const BASE = mkdtempSync(join(SCRATCH, "layout-"))

describe("datum-studio layout (row 111)", () => {
  test("packaged: everything under Res/datum-studio", () => {
    expect(resolveStudioLayout({ isPackaged: true, resourcesPath: "/A/Swarm.app/Contents/Resources", appPath: "/ignored" })).toEqual({
      root: "/A/Swarm.app/Contents/Resources/datum-studio",
      assetsRoot: "/A/Swarm.app/Contents/Resources/datum-studio/src/lib/studio/assets",
      templatesDir: "/A/Swarm.app/Contents/Resources/datum-studio/templates",
      vendorRoot: "/A/Swarm.app/Contents/Resources/datum-studio",
      assetRepoRoot: "/A/Swarm.app/Contents/Resources/datum-studio",
      kind: "packaged",
    })
  })

  test("dev: the staged copy when its manifest exists, else the repo copy", () => {
    const app = join(BASE, "packages", "desktop")
    mkdirSync(app, { recursive: true })
    const repo = resolveStudioLayout({ isPackaged: false, appPath: app })
    const vendor = resolve(app, "..", "datum-studio", "vendor")
    expect(repo).toEqual({
      root: vendor,
      assetsRoot: join(vendor, "src", "lib", "studio", "assets"),
      templatesDir: resolve(app, "..", "datum-studio", "templates"),
      vendorRoot: vendor,
      assetRepoRoot: vendor,
      kind: "repo",
    })
    mkdirSync(join(app, ".datum-studio-stage"), { recursive: true })
    writeFileSync(join(app, ".datum-studio-stage", "studio-manifest.json"), "{}")
    expect(resolveStudioLayout({ isPackaged: false, appPath: app })).toMatchObject({ root: join(app, ".datum-studio-stage"), kind: "staged" })
  })

  test("C79: STUDIO_ASSETS_ROOT is exactly <assetRepoRoot>/src/lib/studio/assets in every layout", () => {
    const app = join(BASE, "c79", "packages", "desktop")
    mkdirSync(app, { recursive: true })
    const layouts = [
      resolveStudioLayout({ isPackaged: true, resourcesPath: "/A/Swarm.app/Contents/Resources", appPath: "/ignored" }),
      resolveStudioLayout({ isPackaged: false, appPath: app }),
    ]
    mkdirSync(join(app, ".datum-studio-stage"), { recursive: true })
    writeFileSync(join(app, ".datum-studio-stage", "studio-manifest.json"), "{}")
    layouts.push(resolveStudioLayout({ isPackaged: false, appPath: app }))
    expect(layouts.map((l) => l.kind)).toEqual(["packaged", "repo", "staged"])
    expect(STUDIO_ASSETS_REL).toBe("src/lib/studio/assets")
    for (const l of layouts) expect(l.assetsRoot, l.kind).toBe(join(l.assetRepoRoot, "src", "lib", "studio", "assets"))
  })

  test("the repo layout points at real folders of this checkout", () => {
    const layout = resolveStudioLayout({ isPackaged: false, appPath: resolve(import.meta.dir, "..", "..", "..") })
    expect(layout.kind === "repo" || layout.kind === "staged").toBe(true)
    // Repo and (C79) staged layouts are the same vendor shape, so both are checked.
    expect(Bun.file(join(layout.assetsRoot, "manifest.json")).size).toBeGreaterThan(0)
    expect(Bun.file(join(layout.vendorRoot, "docs", "STUDIO-AGENT-GUIDE.md")).size).toBeGreaterThan(0)
  })

  test("store root from an absolute XDG_DATA_HOME, else ~/.local/share", () => {
    expect(studioStoreRoot({ XDG_DATA_HOME: "/x/data" }, "/h")).toBe("/x/data/swarm/datum-studio")
    expect(studioStoreRoot({ XDG_DATA_HOME: "rel" }, "/h")).toBe("/h/.local/share/swarm/datum-studio")
    expect(studioStoreRoot({}, "/h")).toBe("/h/.local/share/swarm/datum-studio")
    expect(studioStoreLogFile("/s")).toBe("/s/logs/datum-studio-store.jsonl")
  })

  test("refused roots, including through a symlink into the home folder", () => {
    const home = join(BASE, "home")
    mkdirSync(home, { recursive: true })
    symlinkSync(home, join(BASE, "home-link"))
    const res = "/A/Swarm.app/Contents/Resources"
    const refused = ["/", home, join(BASE, "home-link"), "rel", `${res}/x`, "/A/Swarm.app/Contents/MacOS/x"]
    for (const root of refused) expect(() => assertStoreRootAllowed(root, { home, resourcesPath: res }), root).toThrow(/store root refused/)
    expect(() => assertStoreRootAllowed(join(home, ".local", "share", "swarm", "datum-studio"), { home, resourcesPath: res })).not.toThrow()
  })
})
