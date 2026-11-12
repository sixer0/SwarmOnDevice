// TH-04 / SEC-15 (1.2.6 row 93): the render-bridge probe (01c 4.4, 11.3 item 6), the same-endpoint revive through
// createDatumStudio (N-184, DP-1), the BRIDGE_NOT_STARTED text (01c 9) and the token grep over state and log (SEC-15).
// Red class B at e363918a69 (./bridge does not exist, createDatumStudio has no probeBridge / reviveBridge).
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { startRenderBridge, type RenderBridge, type RenderBridgeOptions } from "../datum-render"
import type { PageEngine } from "../datum-render/dispatch"
import { renderWebPreferences } from "../datum-render/pages"
import { createDatumStudio } from "../datum-studio-host/start"
import type { StudioHostHandle, StudioHostStartOptions } from "../datum-studio-host/lifecycle"
import { probeRenderBridge } from "./bridge"
import { toolHealthMessage } from "./regime"
import { createToolHealth } from "./startup"
import { toolHealthDir } from "./state"
import { createToolHealthRegistry } from "./registry"
import type { ResolvedToolHealthComponent } from "./types"

const dirs: string[] = []
const cleanups: Array<() => Promise<unknown>> = []
function temp(prefix: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c().catch(() => undefined)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const FONTS = resolve(import.meta.dir, "../../../datum/datum-house-style/assets/fonts")
const raster = renderWebPreferences("raster")
function engine(hold?: Promise<void>): PageEngine {
  return {
    async png() {
      await hold
      return Buffer.from([0x89, 0x50, 0x4e, 0x47])
    },
    async pdf() {
      return Buffer.from("%PDF")
    },
    async evaluate() {
      return {}
    },
    async pagePngs() {
      return { layout: "paged", media: "print", pageCount: 0, pageSizeMm: { widthMm: 210, heightMm: 297 }, pageSizeSource: "fallback", images: [] } as never
    },
    info: () => ({
      electron: "fake",
      chrome: "fake",
      partition: "datum-render",
      sandbox: raster.sandbox,
      contextIsolation: raster.contextIsolation,
      nodeIntegration: raster.nodeIntegration,
      javascriptContent: raster.javascript,
      network: "blocked",
    }),
  }
}

function fakeBridgeStarter(work: string, eng: PageEngine = engine()) {
  const calls: RenderBridgeOptions[] = []
  const start = (o: RenderBridgeOptions): Promise<RenderBridge> => {
    calls.push(o)
    return startRenderBridge({ ...o, fontsDir: FONTS, renderScriptPath: undefined, engine: eng, baseDir: work, policy: { roots: [work], deny: [], maxInputBytes: 1024 } })
  }
  return { calls, start }
}

function studio(work: string, startBridge: (o: RenderBridgeOptions) => Promise<RenderBridge>) {
  const hostOpts: StudioHostStartOptions[] = []
  const logs: Array<{ level: string; source: string; message: string; context?: unknown }> = []
  const s = createDatumStudio({
    isPackaged: false,
    appPath: work,
    stateHome: work,
    env: {},
    home: work,
    log: (level, source, message, context) => logs.push({ level, source, message, context }),
    fork: (() => {
      throw new Error("no fork in tests")
    }) as never,
    startBridge,
    startHost: async (o) => {
      hostOpts.push(o)
      return { url: "http://127.0.0.1:1", hostPid: 1, running: true, stop: async () => undefined } as unknown as StudioHostHandle
    },
  })
  cleanups.push(() => s.stop())
  return { s, hostOpts, logs }
}

function send(socketPath: string, line: unknown) {
  const { createConnection } = require("node:net") as typeof import("node:net")
  const sock = createConnection(socketPath)
  sock.on("error", () => undefined)
  sock.write(JSON.stringify(line) + "\n")
  return sock
}

describe("TH-04 render-bridge probe (01c 4.4 / 11.3 item 6)", () => {
  test("no bridge handle -> BRIDGE_NOT_STARTED", async () => {
    expect(await probeRenderBridge(undefined, 500)).toEqual({ healthy: false, reason: "BRIDGE_NOT_STARTED", detail: "no bridge in this launch" })
  })

  test("hello with the token -> healthy OK; removed socket -> BRIDGE_SOCKET_GONE; bad token -> BRIDGE_BAD_REPLY", async () => {
    const work = temp("th-bridge-")
    const b = await fakeBridgeStarter(work).start({ fontsDir: "", log: () => {} })
    cleanups.push(() => b.close())
    const ep = { socketPath: b.env.DATUM_RENDER_SOCKET, token: b.env.DATUM_RENDER_TOKEN }
    expect(await probeRenderBridge(ep, 2000)).toEqual({ healthy: true, reason: "OK", detail: "hello ok" })
    const bad = await probeRenderBridge({ ...ep, token: "f".repeat(64) }, 2000)
    expect(bad).toEqual({ healthy: false, reason: "BRIDGE_BAD_REPLY", detail: "UNAUTHORIZED" })
    rmSync(join(ep.socketPath, ".."), { recursive: true, force: true })
    const gone = await probeRenderBridge(ep, 2000)
    expect(gone.healthy).toBe(false)
    expect(gone.reason).toBe("BRIDGE_SOCKET_GONE")
    expect(gone.detail).not.toContain(ep.token)
  })

  test("connected but no reply in time -> healthy, detail busy (a running job is ahead of hello)", async () => {
    const work = temp("th-bridge-busy-")
    let release!: () => void
    const hold = new Promise<void>((r) => (release = r))
    const b = await fakeBridgeStarter(work, engine(hold)).start({ fontsDir: "", log: () => {} })
    cleanups.push(async () => {
      release()
      await b.close()
    })
    const ep = { socketPath: b.env.DATUM_RENDER_SOCKET, token: b.env.DATUM_RENDER_TOKEN }
    const svg = join(work, "a.svg")
    require("node:fs").writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')
    const job = send(ep.socketPath, { op: "png", token: ep.token, id: 9, src: svg, dst: join(work, "a.png"), width: 10 })
    cleanups.push(async () => void job.destroy())
    await new Promise((r) => setTimeout(r, 50))
    expect(await probeRenderBridge(ep, 300)).toEqual({ healthy: true, reason: "OK", detail: "busy" })
    release()
  })
})

describe("TH-04 same-endpoint revive through createDatumStudio (N-184, DP-1)", () => {
  test("probe waits for start; socket gone -> revive keeps socket path and token byte-identical; host renderEnv untouched", async () => {
    const work = temp("th-studio-")
    const starter = fakeBridgeStarter(work)
    const { s, hostOpts, logs } = studio(work, starter.start)
    void s.start()
    expect(await s.probeBridge(2000)).toEqual({ healthy: true, reason: "OK", detail: "hello ok" })
    const renderEnv = hostOpts[0]!.renderEnv!
    const before = Buffer.from(`${renderEnv.DATUM_RENDER_SOCKET}\n${renderEnv.DATUM_RENDER_TOKEN}`)
    const dir = join(renderEnv.DATUM_RENDER_SOCKET, "..")
    rmSync(dir, { recursive: true, force: true })
    expect((await s.probeBridge(2000)).reason).toBe("BRIDGE_SOCKET_GONE")

    await s.reviveBridge()
    expect(starter.calls).toHaveLength(2)
    expect(starter.calls[1]!.reuse).toEqual({ token: renderEnv.DATUM_RENDER_TOKEN, socketPath: renderEnv.DATUM_RENDER_SOCKET })
    expect(Buffer.from(`${hostOpts[0]!.renderEnv!.DATUM_RENDER_SOCKET}\n${hostOpts[0]!.renderEnv!.DATUM_RENDER_TOKEN}`).equals(before)).toBe(true)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(renderEnv.DATUM_RENDER_SOCKET).mode & 0o777).toBe(0o600)
    expect(await s.probeBridge(2000)).toEqual({ healthy: true, reason: "OK", detail: "hello ok" })
    expect(hostOpts).toHaveLength(1)
    expect(JSON.stringify(logs)).not.toContain(renderEnv.DATUM_RENDER_TOKEN)
    expect(logs.some((l) => l.message === "render bridge restarted on the same endpoint")).toBe(true)
  })

  test("two revives at once share one restart", async () => {
    const work = temp("th-studio-2-")
    const starter = fakeBridgeStarter(work)
    const { s } = studio(work, starter.start)
    await s.start()
    await Promise.all([s.reviveBridge(), s.reviveBridge()])
    expect(starter.calls).toHaveLength(2)
  })
})

describe("TH-04 BRIDGE_NOT_STARTED (01c 4.4 last case, section 9 text)", () => {
  test("bridge failed at start: probe NOT_STARTED, revive refused, message asks for an app restart, regime never revives", async () => {
    const work = temp("th-notstarted-")
    let starts = 0
    const { s } = studio(work, async () => {
      starts++
      throw new Error("fonts missing")
    })
    void s.start()
    const probed = await s.probeBridge(500)
    expect(probed).toMatchObject({ healthy: false, reason: "BRIDGE_NOT_STARTED" })
    await expect(s.reviveBridge()).rejects.toMatchObject({ code: "BRIDGE_NOT_STARTED" })
    expect(starts).toBe(1)

    const text = toolHealthMessage({ id: "render-bridge", label: "DATUM render bridge" }, "BRIDGE_NOT_STARTED", probed.detail)
    expect(text).toBe("The DATUM render bridge did not start with Swarm, so renders will fail. Quit and reopen Swarm.")

    const home = temp("th-notstarted-home-")
    const lines: string[] = []
    const shipped = createToolHealthRegistry({ home, platform: "darwin", isPackaged: false, appPath: work })
    const component = { ...shipped.find((c) => c.id === "render-bridge")!, source: "shipped" } as ResolvedToolHealthComponent
    const th = createToolHealth({
      home,
      platform: "darwin",
      isPackaged: false,
      appPath: work,
      datumStudio: s,
      log: (level, message, context) => lines.push(JSON.stringify({ level, message, context })),
      defer: async () => undefined,
      sleep: async () => undefined,
      watch: (() => ({ close: () => undefined, on: () => undefined })) as never,
      resolveRegistry: () => [component],
    })
    cleanups.push(async () => th.stop())
    await th.runStartup()
    const result = th.lastResults().find((r) => r.id === "render-bridge")!
    expect(result).toMatchObject({ status: "dead", reason: "BRIDGE_NOT_STARTED" })
    expect(result.message).toContain("Quit and reopen Swarm")
    expect(starts).toBe(1)
  })
})

describe("SEC-15: the render token never reaches state.json, the tool-health log or the skill output", () => {
  test("a bridge revive through the regime: grep of state.json, every file under ~/.swarm/health and the log finds no token", async () => {
    const work = temp("th-sec15-")
    const home = temp("th-sec15-home-")
    const starter = fakeBridgeStarter(work)
    const { s, logs: studioLogs } = studio(work, starter.start)
    await s.start()
    const shipped = createToolHealthRegistry({ home, platform: "darwin", isPackaged: false, appPath: work })
    const component = { ...shipped.find((c) => c.id === "render-bridge")!, source: "shipped" } as ResolvedToolHealthComponent
    const lines: string[] = []
    const th = createToolHealth({
      home,
      platform: "darwin",
      isPackaged: false,
      appPath: work,
      datumStudio: s,
      log: (level, message, context) => lines.push(JSON.stringify({ level, message, context })),
      defer: async () => undefined,
      // Real sleep (unref'd): the revive races its 15 s budget, so a shortened sleep would time it out.
      watch: (() => ({ close: () => undefined, on: () => undefined })) as never,
      resolveRegistry: () => [component],
    })
    cleanups.push(async () => th.stop())
    await th.runStartup()
    expect(th.lastResults()[0]).toMatchObject({ id: "render-bridge", status: "healthy" })

    const sock = readdirSync(work).filter((n) => n.startsWith("swarm-datum-"))
    expect(sock).toHaveLength(1)
    const socketDir = join(work, sock[0]!)
    rmSync(socketDir, { recursive: true, force: true })

    await th.recheck(["render-bridge"])
    const revived = th.lastResults()[0]!
    expect(revived).toMatchObject({ id: "render-bridge", status: "revived", reason: "REVIVED" })
    expect(existsSync(join(socketDir, "render.sock"))).toBe(true)
    expect(starter.calls).toHaveLength(2)
    // The token the bridge runs with (handed back to the restart as `reuse`); the skill reads only state.json.
    const secret = starter.calls[1]!.reuse!.token
    expect(secret).toMatch(/^[0-9a-f]{64}$/)

    const health = toolHealthDir(home)
    const files = readdirSync(health).map((n) => readFileSync(join(health, n), "utf8"))
    expect(files.length).toBeGreaterThan(0)
    const haystack = [...files, ...lines, JSON.stringify(studioLogs), JSON.stringify(th.lastResults())].join("\n")
    expect(haystack).toContain("render-bridge")
    expect(haystack).not.toContain(secret)
    expect(haystack).not.toContain(secret.slice(0, 16))
  })
})
