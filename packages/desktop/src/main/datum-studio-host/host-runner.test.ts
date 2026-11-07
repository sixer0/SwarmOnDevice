import { describe, expect, test } from "bun:test"
import { runStudioHost, type ParentPortLike } from "./host-runner"
import type { HostMessage, HostStartCommand, StudioHostModule } from "./protocol"

const START: HostStartCommand = {
  type: "start",
  token: "a".repeat(64),
  hostname: "127.0.0.1",
  storeRoot: "/fixture/store",
  storeLogFile: "/fixture/store/logs/datum-studio-store.jsonl",
  templatesDir: "/fixture/Res/datum-studio/templates",
  assetRepoRoot: "/fixture/Res/datum-studio",
  release: "1.2.0",
}

function harness(over: Partial<StudioHostModule> = {}) {
  const calls: string[] = []
  const posted: HostMessage[] = []
  let listener: ((event: { data: unknown }) => void) | undefined
  const port: ParentPortLike = {
    postMessage: (m) => void posted.push(m),
    on: (_e, l) => void (listener = l),
  }
  const store = { close: async () => {} }
  const mod: StudioHostModule = {
    openHostStore: async (root, opts) => {
      calls.push(`open:${root}:${opts.release}:${opts.logFile}`)
      return store
    },
    closeHostStore: async (s) => void calls.push(`close:${s === store}`),
    configureTemplateSource: (c) => void calls.push(c ? `templates:${c.templatesDir}:${c.assetRepoRoot}` : "templates:null"),
    startStudioHostServer: async (o) => {
      calls.push(`server:${o.store === store}:${o.port}:${o.hostname}`)
      return { url: "http://127.0.0.1:1/mcp", close: async () => void calls.push("server-close") }
    },
    ...over,
  }
  let stopped = 0
  runStudioHost(port, async () => mod, { onStopped: () => stopped++ })
  const send = (data: unknown) => listener!({ data })
  const settle = () => new Promise((r) => setTimeout(r, 10))
  return { calls, posted, send, settle, stopped: () => stopped }
}

describe("datum-studio-host runner (row 111)", () => {
  test("start order: store (lock) -> templates -> server; ready carries url, pid and the real cwd", async () => {
    const h = harness()
    h.send(START)
    await h.settle()
    expect(h.calls).toEqual([
      "open:/fixture/store:1.2.0:/fixture/store/logs/datum-studio-store.jsonl",
      "templates:/fixture/Res/datum-studio/templates:/fixture/Res/datum-studio",
      "server:true:0:127.0.0.1",
    ])
    expect(h.posted).toEqual([{ type: "ready", url: "http://127.0.0.1:1/mcp", pid: process.pid, cwd: process.cwd() }])
  })

  test("stop closes the server, clears the template source, then closes the store (lock release) and reports stopped", async () => {
    const h = harness()
    h.send(START)
    await h.settle()
    h.send({ type: "stop" })
    await h.settle()
    expect(h.calls.slice(3)).toEqual(["server-close", "templates:null", "close:true"])
    expect(h.posted.at(-1)).toEqual({ type: "stopped" })
    expect(h.stopped()).toBe(1)
  })

  test("STORE_LOCKED from openHostStore is posted with its code and details; nothing else starts", async () => {
    const locked = Object.assign(new Error("store in use by PID 77"), { code: "STORE_LOCKED", details: { pid: 77, startedAt: 1 } })
    const h = harness({ openHostStore: async () => Promise.reject(locked) })
    h.send(START)
    await h.settle()
    expect(h.calls).toEqual(["templates:null"])
    expect(h.posted).toHaveLength(1)
    expect(h.posted[0]).toMatchObject({ type: "error", error: { code: "STORE_LOCKED", message: "store in use by PID 77", details: { pid: 77 } } })
  })

  test("a server failure after the store opened closes the store again, so the lock is released", async () => {
    const h = harness({ startStudioHostServer: async () => Promise.reject(new Error("listen failed")) })
    h.send(START)
    await h.settle()
    expect(h.calls).toEqual([
      "open:/fixture/store:1.2.0:/fixture/store/logs/datum-studio-store.jsonl",
      "templates:/fixture/Res/datum-studio/templates:/fixture/Res/datum-studio",
      "templates:null",
      "close:true",
    ])
    expect(h.posted[0]).toMatchObject({ type: "error", error: { code: "HOST_START_FAILED", message: "listen failed" } })
  })

  test("a stop that arrives during start waits for it and then releases everything", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const h = harness({
      startStudioHostServer: async () => {
        await gate
        return { url: "http://127.0.0.1:1/mcp", close: async () => {} }
      },
    })
    h.send(START)
    await h.settle()
    h.send({ type: "stop" })
    release()
    await h.settle()
    expect(h.calls.at(-1)).toBe("close:true")
    expect(h.posted.map((m) => m.type)).toEqual(["ready", "stopped"])
  })

  test("refuses malformed commands and a second start", async () => {
    const h = harness()
    h.send({ type: "start", hostname: "0.0.0.0", token: "x" })
    h.send(START)
    await h.settle()
    h.send(START)
    await h.settle()
    expect(h.posted.map((m) => (m.type === "error" ? m.error.code : m.type))).toEqual(["HOST_BAD_COMMAND", "ready", "HOST_ALREADY_STARTED"])
  })
})
