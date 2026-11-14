import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { prepareOnboardingTestRoot, registerRealDocuments } from "./onboarding-test-root"
import { createRenderEnvGate, createSidecarEnv, isRenderEnv, type RenderEnv } from "./sidecar-env"

// Row 33: the sidecar gets this launch's render bridge pair, never an inherited one, and never the Studio token.

const TOKEN = "ab".repeat(32)
const render: RenderEnv = { DATUM_RENDER_SOCKET: "/private/tmp/claude-501/row33/swarm-datum-x/render.sock", DATUM_RENDER_TOKEN: TOKEN }

// onboarding-test-root keeps the last registered Documents resolver for the whole bun process, so another file's
// resolver (r18c, r7) can leak in and add SWARM_DEFAULT_PROJECT_DIR. These cases expect no Default Project: register
// a resolver that yields none (a throw reads as undefined) and clear any test-root state, then restore afterwards.
beforeEach(() => {
  prepareOnboardingTestRoot({})
  registerRealDocuments(() => {
    throw new Error("no Documents folder in this test")
  })
})
afterEach(() => {
  registerRealDocuments(() => {
    throw new Error("no Documents folder")
  })
})

describe("createSidecarEnv", () => {
  test("keeps the parent env, drops DEBUG, adds this launch's render pair", () => {
    const env = createSidecarEnv({ PATH: "/usr/bin", XDG_STATE_HOME: "/state", DEBUG: "*", SKIP: undefined }, render, "darwin")
    expect(env).toEqual({
      PATH: "/usr/bin",
      XDG_STATE_HOME: "/state",
      DATUM_RENDER_SOCKET: render.DATUM_RENDER_SOCKET,
      DATUM_RENDER_TOKEN: TOKEN,
    })
  })

  test("an inherited pair (login shell) is dropped, with and without a bridge", () => {
    const stale = { DATUM_RENDER_SOCKET: "/elsewhere/render.sock", DATUM_RENDER_TOKEN: "cd".repeat(32), PATH: "/bin" }
    expect(createSidecarEnv(stale, undefined, "darwin")).toEqual({ PATH: "/bin" })
    expect(createSidecarEnv(stale, render, "darwin").DATUM_RENDER_SOCKET).toBe(render.DATUM_RENDER_SOCKET)
    expect(createSidecarEnv(stale, render, "darwin").DATUM_RENDER_TOKEN).toBe(TOKEN)
  })

  test("a malformed pair is not passed on", () => {
    for (const bad of [
      { DATUM_RENDER_SOCKET: "relative/render.sock", DATUM_RENDER_TOKEN: TOKEN },
      { DATUM_RENDER_SOCKET: "/a\nb", DATUM_RENDER_TOKEN: TOKEN },
      { DATUM_RENDER_SOCKET: render.DATUM_RENDER_SOCKET, DATUM_RENDER_TOKEN: "short" },
      { DATUM_RENDER_SOCKET: render.DATUM_RENDER_SOCKET, DATUM_RENDER_TOKEN: "AB".repeat(32) },
    ]) {
      expect(isRenderEnv(bad)).toBe(false)
      const env = createSidecarEnv({ PATH: "/bin" }, bad as RenderEnv, "darwin")
      expect(env.DATUM_RENDER_SOCKET).toBeUndefined()
      expect(env.DATUM_RENDER_TOKEN).toBeUndefined()
    }
  })

  test("LD_PRELOAD is dropped on linux only (unchanged behaviour)", () => {
    expect(createSidecarEnv({ LD_PRELOAD: "x" }, undefined, "linux")).toEqual({})
    expect(createSidecarEnv({ LD_PRELOAD: "x" }, undefined, "darwin")).toEqual({ LD_PRELOAD: "x" })
  })

  test("the parent env object is not changed", () => {
    const base = { DEBUG: "1", DATUM_RENDER_TOKEN: "cd".repeat(32) }
    createSidecarEnv(base, render, "darwin")
    expect(base).toEqual({ DEBUG: "1", DATUM_RENDER_TOKEN: "cd".repeat(32) })
  })
})

describe("createRenderEnvGate", () => {
  test("track passes the bridge through and publishes its pair", async () => {
    const gate = createRenderEnvGate()
    const bridge = { env: render, close: async () => {} }
    expect(await gate.track(Promise.resolve(bridge))).toBe(bridge)
    expect(await gate.wait(1000)).toEqual(render)
  })

  test("a bridge that fails publishes nothing and the error still reaches the caller", async () => {
    const gate = createRenderEnvGate()
    const failure = new Error("bridge failed")
    await expect(gate.track(Promise.reject(failure))).rejects.toBe(failure)
    expect(await gate.wait(1000)).toBeUndefined()
  })

  test("a bridge that never starts ends the wait at the timeout", async () => {
    const gate = createRenderEnvGate()
    void gate.track(new Promise<{ env: RenderEnv }>(() => {}))
    const started = Date.now()
    expect(await gate.wait(50)).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test("a wait started before the bridge is ready gets the pair when it comes", async () => {
    const gate = createRenderEnvGate()
    const waiting = gate.wait(1000)
    gate.publish(render)
    expect(await waiting).toEqual(render)
  })
})

describe("wiring in main", () => {
  test("server.ts forks the sidecar with createSidecarEnv(process.env, options.renderEnv)", async () => {
    const text = await Bun.file(join(import.meta.dir, "server.ts")).text()
    expect(text).toContain('import { createSidecarEnv, type RenderEnv } from "./sidecar-env"')
    expect(text).toContain("env: createSidecarEnv(process.env, options.renderEnv),")
    expect(text).not.toContain("function createSidecarEnv(")
  })

  test("index.ts feeds the Studio bridge into the gate and the gate into the sidecar spawn", async () => {
    const text = await Bun.file(join(import.meta.dir, "index.ts")).text()
    const gate = text.indexOf("const sidecarRenderEnv = createRenderEnvGate()")
    const create = text.indexOf("const datumStudio = createDatumStudio(")
    const wait = text.indexOf("sidecarRenderEnv.wait(SIDECAR_RENDER_ENV_WAIT_MS)")
    const spawn = text.indexOf("spawnLocalServer(hostname, port, password, {")
    expect(gate).toBeGreaterThan(0)
    expect(create).toBeGreaterThan(gate)
    expect(text).toContain("startBridge: (options) => sidecarRenderEnv.track(startRenderBridge(options)),")
    expect(wait).toBeGreaterThan(create)
    expect(spawn).toBeGreaterThan(wait)
    expect(text.slice(spawn, spawn + 200)).toContain("renderEnv,")
  })
})
