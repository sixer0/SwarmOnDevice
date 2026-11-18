// Swarm 1.3.3 row 100 (KL-2, C7 item 6): main passes the bundled technical library to the Studio host as
// STUDIO_LIBRARY_ROOT. Packaged: <Resources>/knowledge-library (electron-builder maps .library-stage there); dev: the
// staged copy packages/desktop/.library-stage (scripts/stage-library.ts). Absent, not a folder, or a symlink: not passed,
// and the host tool answers "not available".
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHostEnv, type StudioHostStartOptions } from "./lifecycle"
import { createDatumStudio, studioLibraryRoot, studioSkillRoots } from "./start"
import type { StudioLayout } from "./layout"

const RUN = realpathSync(mkdtempSync(join(process.env.ROW100_TEST_DIR ?? tmpdir(), "row100-env-")))
const LAYOUT: StudioLayout = { root: "/r", assetsRoot: "/r/a", templatesDir: "/r/t", vendorRoot: "/r", assetRepoRoot: "/r", kind: "packaged" }

describe("row 100: STUDIO_LIBRARY_ROOT", () => {
  test("createHostEnv passes the library root only when given", () => {
    const base = { baseEnv: { HOME: "/h", STUDIO_LIBRARY_ROOT: "/from/shell" }, layout: LAYOUT, storeRoot: "/s" }
    expect(createHostEnv({ ...base, libraryRoot: "/res/knowledge-library" }).STUDIO_LIBRARY_ROOT).toBe("/res/knowledge-library")
    // never inherited from the shell env
    expect(createHostEnv(base).STUDIO_LIBRARY_ROOT).toBeUndefined()
  })

  test("C33: STUDIO_SKILL_ROOTS is JSON of the bundled skill roots found on disk; never from the shell env", () => {
    const base = { baseEnv: { HOME: "/h", STUDIO_SKILL_ROOTS: '{"x":"/evil"}' }, layout: LAYOUT, storeRoot: "/s" }
    expect(JSON.parse(createHostEnv({ ...base, skillRoots: { "gsp-diagram-standard": "/res/gsp-diagram-standard" } }).STUDIO_SKILL_ROOTS!)).toEqual({ "gsp-diagram-standard": "/res/gsp-diagram-standard" })
    expect(createHostEnv(base).STUDIO_SKILL_ROOTS).toBeUndefined()
    expect(createHostEnv({ ...base, skillRoots: {} }).STUDIO_SKILL_ROOTS).toBeUndefined()
    const res = join(RUN, "ResSkills")
    const app = join(RUN, "desktopSkills")
    expect(studioSkillRoots({ isPackaged: true, resourcesPath: res, appPath: app })).toBeUndefined()
    mkdirSync(join(res, "gsp-diagram-standard"), { recursive: true })
    mkdirSync(join(res, "other-skill"), { recursive: true })
    expect(studioSkillRoots({ isPackaged: true, resourcesPath: res, appPath: app })).toEqual({ "gsp-diagram-standard": join(res, "gsp-diagram-standard") })
    mkdirSync(join(app, "datum", "gsp-diagram-standard"), { recursive: true })
    expect(studioSkillRoots({ isPackaged: false, appPath: app })).toEqual({ "gsp-diagram-standard": join(app, "datum", "gsp-diagram-standard") })
    const res4 = join(RUN, "ResSkills4")
    mkdirSync(res4)
    symlinkSync(join(res, "gsp-diagram-standard"), join(res4, "gsp-diagram-standard"))
    expect(studioSkillRoots({ isPackaged: true, resourcesPath: res4, appPath: app })).toBeUndefined()
  })

  test("packaged: <Resources>/knowledge-library; dev: <appPath>/.library-stage; missing, file or symlink: none", () => {
    const res = join(RUN, "Resources")
    const app = join(RUN, "desktop")
    expect(studioLibraryRoot({ isPackaged: true, resourcesPath: res, appPath: app })).toBeUndefined()
    mkdirSync(join(res, "knowledge-library"), { recursive: true })
    expect(studioLibraryRoot({ isPackaged: true, resourcesPath: res, appPath: app })).toBe(join(res, "knowledge-library"))
    expect(studioLibraryRoot({ isPackaged: true, appPath: app })).toBeUndefined()
    expect(studioLibraryRoot({ isPackaged: false, appPath: app })).toBeUndefined()
    mkdirSync(join(app, ".library-stage"), { recursive: true })
    expect(studioLibraryRoot({ isPackaged: false, resourcesPath: res, appPath: app })).toBe(join(app, ".library-stage"))
    const res2 = join(RUN, "Resources2")
    mkdirSync(res2)
    writeFileSync(join(res2, "knowledge-library"), "not a folder")
    expect(studioLibraryRoot({ isPackaged: true, resourcesPath: res2, appPath: app })).toBeUndefined()
    const res3 = join(RUN, "Resources3")
    mkdirSync(res3)
    symlinkSync(join(res, "knowledge-library"), join(res3, "knowledge-library"))
    expect(studioLibraryRoot({ isPackaged: true, resourcesPath: res3, appPath: app })).toBeUndefined()
  })

  test("createDatumStudio hands the resolved root to the host start", async () => {
    const res = join(RUN, "Resources")
    const seen: Array<string | undefined> = []
    const seenSkills: unknown[] = []
    const studio = createDatumStudio({
      isPackaged: true,
      resourcesPath: res,
      appPath: join(RUN, "desktop"),
      stateHome: join(RUN, "state"),
      env: { XDG_DATA_HOME: join(RUN, "data") },
      home: join(RUN, "home"),
      log: () => undefined,
      fork: (() => {
        throw new Error("not forked in this test")
      }) as never,
      startBridge: async () => {
        throw new Error("no bridge in this test")
      },
      startHost: async (opts: StudioHostStartOptions) => {
        seen.push(opts.libraryRoot)
        seenSkills.push(opts.skillRoots)
        throw Object.assign(new Error("stop here"), { code: "TEST_STOP" })
      },
    })
    // the packaged layout needs Res/datum-studio; the host start is reached only when it resolves
    mkdirSync(join(res, "datum-studio"), { recursive: true })
    await studio.start()
    expect(seen).toEqual([join(res, "knowledge-library")])
    expect(seenSkills).toEqual([undefined]) // no gsp-diagram-standard folder in this fixture's Resources
  })
})
