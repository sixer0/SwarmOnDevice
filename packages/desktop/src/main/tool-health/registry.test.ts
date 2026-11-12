// TH-01 (1.2.6 row 90): spec 01c 11.1. Red class B at e363918a69 (the module is new), with behaviour assertions
// through the public factory createToolHealthRegistry (N-186).
import { describe, expect, test } from "bun:test"
import {
  TOOL_HEALTH_COLIMA_PROFILE,
  TOOL_HEALTH_FIRECRAWL_PORT,
  TOOL_HEALTH_SEARXNG_PORT,
  TOOL_HEALTH_SHIPPED_IDS,
  createToolHealthRegistry,
} from "./registry"
import { SETUP_COMPONENT_IDS } from "../setup-runner"

const HOME = "/tmp/x"
const RES = "/tmp/res"
const ctx = { home: HOME, platform: "darwin", isPackaged: true, resourcesPath: RES, appPath: "/tmp/app" }

/** Every string value in a JSON tree that looks like a filesystem path. */
function paths(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string" && value.startsWith("/") && !value.startsWith("/_")) out.push(value)
  else if (Array.isArray(value)) for (const v of value) paths(v, out)
  else if (value && typeof value === "object") for (const v of Object.values(value)) paths(v, out)
  return out
}

describe("TH-01 shipped registry (01c 11.1)", () => {
  test("1: exactly the five shipped ids, flux3 absent", () => {
    const ids = createToolHealthRegistry(ctx).map((c) => c.id)
    expect(ids).toEqual(["runtime", "searxng", "firecrawl", "render-bridge", "layout-runtime"])
    expect([...TOOL_HEALTH_SHIPPED_IDS]).toEqual(ids)
    expect(ids).not.toContain("flux3")
  })

  test("2: every component has a probe; every revive is builtin; layout-runtime has none", () => {
    const reg = createToolHealthRegistry(ctx)
    for (const c of reg) {
      expect(c.probe).toBeDefined()
      if (c.revive) expect("builtin" in c.revive).toBe(true)
      expect(["probe", "off"]).toContain(c.startup)
      expect(["auto", "manual"]).toContain(c.consent)
    }
    const byId = Object.fromEntries(reg.map((c) => [c.id, c]))
    expect(byId["layout-runtime"]!.revive).toBeUndefined()
    expect(byId["layout-runtime"]!.probe.kind).toBe("file")
    expect(byId["render-bridge"]!.revive).toEqual({ builtin: "render-bridge-restart" })
    expect(byId["render-bridge"]!.probe).toEqual({ kind: "process", check: "render-bridge" })
    for (const id of ["runtime", "searxng", "firecrawl"]) {
      expect(byId[id]!.revive).toEqual({ builtin: "compose-start" })
      expect(byId[id]!.platforms).toEqual(["darwin"])
      expect(byId[id]!.installedWhen).toEqual({ setupComponent: id })
    }
    expect(byId.searxng!.requires).toEqual(["runtime"])
    expect(byId.firecrawl!.requires).toEqual(["runtime"])
    expect(byId.runtime!.reviveTimeoutMs).toBe(180000)
    expect(byId.searxng!.reviveTimeoutMs).toBe(60000)
    expect(byId.firecrawl!.reviveTimeoutMs).toBe(90000)
    expect(byId["render-bridge"]!.reviveTimeoutMs).toBe(15000)
    expect(byId["render-bridge"]!.platforms).toBeUndefined()
    expect(byId["layout-runtime"]!.platforms).toBeUndefined()
  })

  test("2b: probe values (01c section 4 table)", () => {
    const byId = Object.fromEntries(createToolHealthRegistry(ctx).map((c) => [c.id, c]))
    expect(byId.runtime!.probe).toEqual({
      kind: "http-unix",
      socketPath: `${HOME}/.colima/swarm/docker.sock`,
      path: "/_ping",
      expectStatus: 200,
    })
    const searx = byId.searxng!.probe
    if (searx.kind !== "http") throw new Error("searxng probe kind")
    expect(searx.url).toBe("http://127.0.0.1:9021/")
    const s = searx.expectStatus as number[]
    expect(s).toContain(200)
    expect(s).toContain(399)
    expect(s).not.toContain(401)
    expect(s).not.toContain(400)
    const fc = byId.firecrawl!.probe
    if (fc.kind !== "http") throw new Error("firecrawl probe kind")
    expect(fc.url).toBe("http://127.0.0.1:9022/")
    expect(fc.expectStatus as number[]).toEqual(expect.arrayContaining([200, 302, 399, 401, 403]))
    expect(fc.expectStatus as number[]).not.toContain(404)
    expect(byId["layout-runtime"]!.probe).toEqual({ kind: "file", path: `${RES}/datum-studio/third_party/elkjs/elk.bundled.js` })
  })

  test("3: serialised registry has no /Users/ or Default Project; every path is under home or resources", () => {
    const text = JSON.stringify(createToolHealthRegistry(ctx))
    expect(text).not.toContain("/Users/")
    expect(text).not.toContain("Default Project")
    const found = paths(JSON.parse(text))
    expect(found.length).toBeGreaterThan(0)
    for (const p of found) expect(p.startsWith(`${HOME}/`) || p.startsWith(`${RES}/`)).toBe(true)
  })

  test("3b: the module sources hold no machine path", async () => {
    for (const name of ["registry.ts", "types.ts", "user-registry.ts", "probe.ts"]) {
      const src = await Bun.file(new URL(`./${name}`, import.meta.url)).text()
      expect(src).not.toContain("/Users/")
      expect(src).not.toContain("Default Project")
      expect(src).not.toContain("gsp-budi")
    }
  })

  test("3c: a fresh array per call (no shared mutable state)", () => {
    const a = createToolHealthRegistry(ctx)
    a[0]!.startup = "off"
    expect(createToolHealthRegistry(ctx)[0]!.startup).toBe("probe")
  })

  test("4: port and profile drift against packages/setup", async () => {
    const shared = await import("../../../../setup/src/composefiles/shared")
    expect(TOOL_HEALTH_SEARXNG_PORT).toBe(9021)
    expect(TOOL_HEALTH_FIRECRAWL_PORT).toBe(9022)
    expect(TOOL_HEALTH_SEARXNG_PORT).toBe(shared.PC_PORTS.searxngPublished.host)
    expect(TOOL_HEALTH_FIRECRAWL_PORT).toBe(shared.PC_PORTS.firecrawlPublished.host)
    expect(`${shared.searxngBaseUrl()}/`).toBe("http://127.0.0.1:9021/")
    const constants = await import("../../../../setup/src/constants")
    expect(TOOL_HEALTH_COLIMA_PROFILE).toBe(constants.COLIMA_PROFILE)
  })

  test("5 (F9): setup component id lists unchanged, no tool-health-only id in them", async () => {
    const fixed = ["runtime", "node", "graft", "rtk", "obsidian", "searxng", "firecrawl"]
    expect([...SETUP_COMPONENT_IDS]).toEqual(fixed)
    const setup = await import("../../../../setup/src/constants")
    expect([...setup.COMPONENT_IDS]).toEqual(fixed)
    const line = (src: string, name: string) => {
      const m = src.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`))
      if (!m) throw new Error(`${name} not found`)
      return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1])
    }
    const opencode = await Bun.file(new URL("../../../../opencode/src/session/installed-tools.ts", import.meta.url)).text()
    const app = await Bun.file(new URL("../../../../app/src/context/setup-status.ts", import.meta.url)).text()
    expect(line(opencode, "COMPONENT_IDS")).toEqual(fixed)
    expect(line(app, "SETUP_COMPONENT_IDS")).toEqual(fixed)
    for (const list of [SETUP_COMPONENT_IDS as readonly string[], setup.COMPONENT_IDS as readonly string[]])
      for (const id of ["render-bridge", "layout-runtime", "flux3"]) expect(list).not.toContain(id)
  })

  test("layout-runtime path follows the studio layout (repo layout = dev elkjs)", () => {
    const reg = createToolHealthRegistry({ home: HOME, platform: "linux", isPackaged: false, appPath: "/tmp/nowhere/desktop" })
    const lr = reg.find((c) => c.id === "layout-runtime")!
    expect(lr.probe).toEqual({ kind: "file", path: "/tmp/nowhere/datum-studio/node_modules/elkjs/lib/elk.bundled.js" })
  })
})
