import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { STUDIO_BRIDGE_SCRIPTS } from "../../../../datum-studio/vendor/src/lib/studio/engine/browser/runtime"
import type { RenderBridge, RenderBridgeOptions } from "../datum-render"
import { StudioHostError, type StudioHostHandle, type StudioHostStartOptions } from "./lifecycle"
import { createDatumStudio, STUDIO_BRIDGE_EXTRA_SCRIPTS } from "./start"

function deps(startHost: (o: StudioHostStartOptions) => Promise<StudioHostHandle>) {
  const events: string[] = []
  const bridgeOpts: RenderBridgeOptions[] = []
  const logs: { level: string; message: string; context?: Record<string, unknown> }[] = []
  const bridge: RenderBridge = {
    env: { DATUM_RENDER_SOCKET: "/s/render.sock", DATUM_RENDER_TOKEN: "t".repeat(64) },
    scripts: [],
    close: async () => void events.push("bridge-close"),
  }
  const studio = createDatumStudio({
    isPackaged: true,
    resourcesPath: "/A/Swarm.app/Contents/Resources",
    appPath: "/A/Swarm.app/Contents/Resources/app.asar",
    stateHome: "/state",
    env: { XDG_DATA_HOME: "/data" },
    home: "/h",
    mainPid: 4321,
    log: (level, _source, message, context) => logs.push({ level, message, context }),
    fork: () => {
      throw new Error("not used")
    },
    entryPath: "/out/main/datum-studio-host.js",
    startBridge: async (o) => {
      bridgeOpts.push(o)
      return bridge
    },
    startHost,
  })
  return { studio, events, bridgeOpts, logs }
}

const handle = (events: string[]): StudioHostHandle => ({
  url: "http://127.0.0.1:9999/mcp",
  hostPid: 99,
  running: true,
  stop: async () => void events.push("host-stop"),
})

describe("DATUM Studio main wiring (row 111)", () => {
  test("the bridge allow-list is exactly Studio's STUDIO_BRIDGE_SCRIPTS (row108 line)", () => {
    expect(Object.entries(STUDIO_BRIDGE_EXTRA_SCRIPTS)).toEqual(STUDIO_BRIDGE_SCRIPTS.map((s) => [s.name, s.text]))
  })

  test("starts the bridge with the packaged skill paths, then the host with the bridge env, store root and descriptor", async () => {
    let seen: StudioHostStartOptions | undefined
    const d = deps(async (o) => {
      seen = o
      return handle(d.events)
    })
    await d.studio.start()
    expect(d.bridgeOpts[0]).toMatchObject({
      fontsDir: "/A/Swarm.app/Contents/Resources/datum-house-style/assets/fonts",
      renderScriptPath: "/A/Swarm.app/Contents/Resources/datum-house-style/scripts/datum_render.py",
      extraScripts: STUDIO_BRIDGE_EXTRA_SCRIPTS,
    })
    expect(seen).toMatchObject({
      entryPath: "/out/main/datum-studio-host.js",
      storeRoot: "/data/swarm/datum-studio",
      descriptorPath: join("/state", "swarm", "datum-studio.env"),
      mainPid: 4321,
      renderEnv: { DATUM_RENDER_SOCKET: "/s/render.sock", DATUM_RENDER_TOKEN: "t".repeat(64) },
      layout: { root: "/A/Swarm.app/Contents/Resources/datum-studio", kind: "packaged" },
    })
    expect(d.studio.state).toEqual({ status: "running", url: "http://127.0.0.1:9999/mcp", hostPid: 99 })
  })

  test("STORE_LOCKED leaves Studio unavailable with the store-in-use message, persisted as an error log", async () => {
    const d = deps(async () => Promise.reject(new StudioHostError("STORE_LOCKED", "store in use by PID 77", { pid: 77 })))
    await d.studio.start()
    expect(d.studio.state).toEqual({ status: "unavailable", code: "STORE_LOCKED", message: "DATUM Studio unavailable: store in use by PID 77" })
    expect(d.logs.at(-1)).toMatchObject({ level: "error", message: "DATUM Studio unavailable: store in use by PID 77", context: { code: "STORE_LOCKED" } })
  })

  test("a bridge failure is logged and the host still starts without DATUM_RENDER_*", async () => {
    let seen: StudioHostStartOptions | undefined
    const events: string[] = []
    const studio = createDatumStudio({
      isPackaged: false,
      appPath: "/repo/packages/desktop",
      stateHome: "/state",
      env: {},
      home: "/h",
      log: () => {},
      fork: () => {
        throw new Error("not used")
      },
      startBridge: async () => Promise.reject(new Error("fonts missing")),
      startHost: async (o) => {
        seen = o
        return handle(events)
      },
    })
    await studio.start()
    expect(seen?.renderEnv).toBeUndefined()
    expect(studio.state.status).toBe("running")
  })

  test("holdQuit holds the first quit until host and bridge stopped, then quits again; later quits pass", async () => {
    const d = deps(async () => handle(d.events))
    await d.studio.start()
    let prevented = 0
    let quits = 0
    const event = { preventDefault: () => void prevented++ }
    await new Promise<void>((resolve) => {
      d.studio.holdQuit(event, () => {
        quits++
        resolve()
      })
    })
    expect(d.events).toEqual(["host-stop", "bridge-close"])
    d.studio.holdQuit(event, () => quits++)
    expect([prevented, quits]).toEqual([1, 1])
    expect(d.studio.state.status).toBe("stopped")
  })

  test("a quit during start aborts the host start (signal) and does not report an error", async () => {
    let signal: AbortSignal | undefined
    const d = deps(
      (o) =>
        new Promise((_, reject) => {
          signal = o.signal
          o.signal?.addEventListener("abort", () => reject(new StudioHostError("HOST_START_ABORTED", "aborted")))
        }),
    )
    void d.studio.start()
    await new Promise((r) => setTimeout(r, 5))
    await d.studio.stop()
    expect(signal?.aborted).toBe(true)
    expect(d.studio.state.status).toBe("stopped")
    expect(d.logs.filter((l) => l.level === "error")).toEqual([])
  })

  test("index.ts creates it after app.whenReady and holds before-quit through it", async () => {
    const text = await Bun.file(join(import.meta.dir, "..", "index.ts")).text()
    const ready = text.indexOf("yield* Effect.promise(() => app.whenReady())")
    const create = text.indexOf("const datumStudio = createDatumStudio(")
    expect(ready).toBeGreaterThan(0)
    expect(create).toBeGreaterThan(ready)
    expect(text).toContain("void datumStudio.start()")
    expect(text).toContain('app.on("before-quit", (event) => datumStudio.holdQuit(event, () => app.quit()))')
  })
})
