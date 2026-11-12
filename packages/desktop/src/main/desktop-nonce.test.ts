import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createDesktopNonce, isDesktopNonce, registerDesktopNonceHandler } from "./desktop-nonce"
import { buildStartMessage, listenWithNonce, parseSidecarCommand } from "./sidecar-start"
import { DESKTOP_NONCE_IPC } from "../preload/desktop-nonce-channel"

// 1.2.6 row 38b (SEC-06, desktop side of row 38a): the per-launch nonce is made once in Electron main, reaches the
// sidecar only in its `start` message, is set on the server (DesktopNonce.set) before Server.listen, is handed to the
// renderer over one IPC channel, and is never written to env, disk or a log. index.ts and sidecar.ts cannot be imported
// in a test (top-level app start / parent port), so their wiring is checked by reading their source.

const here = import.meta.dir
const source = (file: string) => readFileSync(join(here, file), "utf8")

describe("createDesktopNonce", () => {
  test("is 32 random bytes as base64url (43 characters) in the server's accepted form", () => {
    const sizes: number[] = []
    const nonce = createDesktopNonce((size) => {
      sizes.push(size)
      return Buffer.alloc(size, 0xfb)
    })
    expect(sizes).toEqual([32])
    expect(nonce).toBe(Buffer.alloc(32, 0xfb).toString("base64url"))
    expect(nonce).toHaveLength(43)
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{32,128}$/)
  })

  test("two launches get different nonces", () => {
    const a = createDesktopNonce()
    const b = createDesktopNonce()
    expect(isDesktopNonce(a)).toBe(true)
    expect(isDesktopNonce(b)).toBe(true)
    expect(a).not.toBe(b)
  })

  test("isDesktopNonce refuses values the server would refuse", () => {
    for (const bad of [undefined, null, 1, "", "short", "a".repeat(31), "a".repeat(129), `${"a".repeat(40)} `, `${"a".repeat(40)}=`, `${"a".repeat(40)}\n`])
      expect(isDesktopNonce(bad)).toBe(false)
    expect(isDesktopNonce("a".repeat(32))).toBe(true)
    expect(isDesktopNonce("A-_9".repeat(32))).toBe(true)
  })
})

describe("sidecar start message", () => {
  const nonce = createDesktopNonce()
  const base = { hostname: "127.0.0.1", port: 4096, password: "pw", userDataPath: "/u" }

  test("the start message carries the nonce and parses back with it", () => {
    const message = buildStartMessage({ ...base, desktopNonce: nonce })
    expect(message).toEqual({ type: "start", ...base, desktopNonce: nonce })
    expect(parseSidecarCommand(message)).toEqual({ type: "start", ...base, desktopNonce: nonce })
  })

  test("a start message without a nonce stays valid (no nonce held); a non-string nonce is refused", () => {
    expect(parseSidecarCommand(buildStartMessage(base))).toEqual({ type: "start", ...base, desktopNonce: undefined })
    expect(parseSidecarCommand({ type: "start", ...base, desktopNonce: 5 })).toBeUndefined()
    expect(parseSidecarCommand({ type: "stop" })).toEqual({ type: "stop" })
    expect(parseSidecarCommand({ type: "start", ...base, port: "1" })).toBeUndefined()
  })

  test("DesktopNonce.set runs before RunLease.host and Server.listen, with the message's nonce", async () => {
    const calls: string[] = []
    const set: unknown[] = []
    const envBefore = JSON.stringify(process.env)
    const listener = { stop() {} }
    const result = await listenWithNonce(parseSidecarCommand(buildStartMessage({ ...base, desktopNonce: nonce }))!, {
      DesktopNonce: {
        set: (value) => {
          calls.push("set")
          set.push(value)
        },
      },
      RunLease: { host: () => void calls.push("host") },
      Server: {
        listen: async (options) => {
          calls.push("listen")
          expect(options).toEqual({
            port: 4096,
            hostname: "127.0.0.1",
            username: "opencode",
            password: "pw",
            cors: ["oc://renderer"],
          })
          return listener
        },
      },
    })
    expect(result).toBe(listener)
    expect(calls).toEqual(["set", "host", "listen"])
    expect(set).toEqual([nonce])
    // Never through the environment.
    expect(JSON.stringify(process.env)).toBe(envBefore)
    expect(Object.values(process.env)).not.toContain(nonce)
  })

  test("a nonce the server refuses stops the start before listen", async () => {
    const calls: string[] = []
    await expect(
      listenWithNonce(
        { type: "start", ...base, desktopNonce: "bad" },
        {
          DesktopNonce: {
            set: () => {
              calls.push("set")
              throw new Error("The desktop nonce is not in the expected form")
            },
          },
          RunLease: { host: () => void calls.push("host") },
          Server: { listen: async () => (calls.push("listen"), { stop() {} }) },
        },
      ),
    ).rejects.toThrow("expected form")
    expect(calls).toEqual(["set"])
  })
})

describe("renderer IPC", () => {
  type Handler = (event: unknown) => unknown
  const nonce = createDesktopNonce()
  const setup = (held: string | undefined) => {
    const handlers = new Map<string, Handler>()
    const mainFrame = { url: "oc://renderer/index.html" }
    const sender = { mainFrame }
    const win = { isDestroyed: () => false, webContents: sender }
    registerDesktopNonceHandler({
      ipcMain: { handle: (channel: string, fn: Handler) => void handlers.set(channel, fn) } as never,
      windowOf: (s) => (s === sender ? (win as never) : null),
      isRendererUrl: (url) => !!url?.startsWith("oc://renderer"),
      nonce: () => held,
    })
    return { handlers, sender, mainFrame, win }
  }

  test("one channel; the app's main frame gets this launch's nonce", async () => {
    const { handlers, sender, mainFrame } = setup(nonce)
    expect([...handlers.keys()]).toEqual([DESKTOP_NONCE_IPC])
    expect(await handlers.get(DESKTOP_NONCE_IPC)!({ sender, senderFrame: mainFrame })).toBe(nonce)
  })

  test("another origin, a subframe, an unknown window or no nonce gets null", async () => {
    const { handlers, sender, mainFrame } = setup(nonce)
    const handle = handlers.get(DESKTOP_NONCE_IPC)!
    expect(await handle({ sender, senderFrame: { url: "https://example.com/" } })).toBeNull()
    expect(await handle({ sender, senderFrame: { url: "oc://renderer/x" } })).toBeNull() // not the main frame
    expect(await handle({ sender: { mainFrame }, senderFrame: mainFrame })).toBeNull()
    expect(await handle({ sender, senderFrame: null })).toBeNull()
    const none = setup(undefined)
    expect(await none.handlers.get(DESKTOP_NONCE_IPC)!({ sender: none.sender, senderFrame: none.mainFrame })).toBeNull()
  })

  test("preload exposes it through contextBridge on that channel; ipc.ts registers it", () => {
    const preload = source("../preload/index.ts")
    expect(preload).toContain("desktopNonce: () => ipcRenderer.invoke(DESKTOP_NONCE_IPC)")
    expect(preload).toContain('contextBridge.exposeInMainWorld("api", api)')
    expect(source("../preload/types.ts")).toContain("desktopNonce: () => Promise<string | null>")
    expect(source("ipc.ts")).toContain("registerDesktopNonceHandler(")
  })
})

describe("wiring (source)", () => {
  test("index.ts makes the nonce once per launch and gives the same value to the sidecar and the IPC", () => {
    const index = source("index.ts")
    expect(index.match(/createDesktopNonce\(/g)).toHaveLength(1)
    expect(index).toContain("const desktopNonce = createDesktopNonce()")
    expect(index).toMatch(/spawnLocalServer\(hostname, port, password, \{[^}]*desktopNonce: localDesktopNonce/s)
    expect(index).toContain("localDesktopNonce = desktopNonce")
    expect(index).toContain("desktopNonce: () => localDesktopNonce")
  })

  test("server.ts puts it in the start message only; sidecar.ts sets it before listen", () => {
    const server = source("server.ts")
    expect(server).toContain("desktopNonce: options.desktopNonce")
    expect(server).toContain("child.postMessage(\n      buildStartMessage(")
    const sidecar = source("sidecar.ts")
    expect(sidecar).toContain("parseSidecarCommand(event.data)")
    expect(sidecar).toContain('listenWithNonce(command, await import("virtual:opencode-server"))')
    expect(source("env.d.ts")).toMatch(/export namespace DesktopNonce \{\s*export const set: typeof import\([^)]*\)\.DesktopNonce\.set/)
  })

  test("grep: no nonce in env, on disk or in a log line", () => {
    const sink = /process\.env|createSidecarEnv|prepareSidecarEnv|writeFile|appendFile|writeAppServerFile|getStore|writeLog|logger\.|console\.|getLogger|log\(/
    for (const file of ["index.ts", "server.ts", "sidecar.ts", "sidecar-start.ts", "desktop-nonce.ts", "ipc.ts", "env.d.ts", "../preload/index.ts"]) {
      const offending = source(file)
        .split("\n")
        .filter((line) => /nonce/i.test(line) && !/^\s*(\/\/|\*|\/\*\*)/.test(line) && sink.test(line))
      expect({ file, offending }).toEqual({ file, offending: [] })
    }
    // The sidecar env function takes no nonce.
    expect(source("sidecar.ts")).toMatch(/function prepareSidecarEnv\(password: string, userDataPath: string\)/)
  })
})
