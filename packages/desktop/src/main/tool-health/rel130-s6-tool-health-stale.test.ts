// 1.3.0 row 132b (AC-S6c tool-health part, folded F2 / S13-01): a staged swarm-web-proxy whose CONTENT differs from
// the copy the app bundle ships is unhealthy in tool-health, with the existing NOT_INSTALLED reason and message (the
// "Install tools" command). Same rule as the launch refresh: content decides, never metadata; a different size is
// flagged without reading the target (so a target above PROXY_MAX_BYTES is never read); an equal size is hashed.
// Synthetic bytes in temp folders only; the real ~/.swarm and the installed app are never touched.
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createToolHealth, type ToolHealthDeps } from "./startup"
import { readToolHealthState } from "./state"
import { toolHealthMessage } from "./regime"
import { TOOL_HEALTH_REASONS } from "./types"

const ID = "swarm-web"
const BUNDLE = Buffer.from("#!/bin/sh\n# synthetic swarm-web-proxy, bundle copy\n" + "b".repeat(4096))

const dirs: string[] = []
function temp(prefix: string) {
  const dir = fs.mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** A temp HOME and a temp resources folder holding swarm-setup/swarm-web-proxy. */
function world(opts: { bundle?: boolean } = {}) {
  const home = temp("th-proxy-home-")
  const resources = temp("th-proxy-res-")
  const source = join(resources, "swarm-setup", "swarm-web-proxy")
  if (opts.bundle !== false) {
    fs.mkdirSync(join(resources, "swarm-setup"), { recursive: true })
    fs.writeFileSync(source, BUNDLE, { mode: 0o755 })
  }
  const bin = join(home, ".swarm", "setup", "bin")
  const target = join(bin, "swarm-web-proxy")
  return { home, resources, source, bin, target }
}

function stage(w: ReturnType<typeof world>, bytes: Uint8Array) {
  fs.mkdirSync(w.bin, { recursive: true, mode: 0o700 })
  fs.writeFileSync(w.target, bytes, { mode: 0o755 })
}

type Logged = { level: string; message: string; context?: Record<string, unknown> }

function deps(w: ReturnType<typeof world>, over: Partial<ToolHealthDeps> = {}): ToolHealthDeps & { logged: Logged[] } {
  const logged: Logged[] = []
  return {
    home: w.home,
    platform: "darwin",
    isPackaged: true,
    resourcesPath: w.resources,
    appPath: join(w.resources, "app.asar"),
    log: (level, message, context) => void logged.push({ level, message, context }),
    defer: async () => undefined,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 1))),
    watch: () => ({ close: () => undefined, on: () => undefined as never }),
    resolveRegistry: () => [],
    ...over,
    logged,
  }
}

async function run(d: ToolHealthDeps) {
  const th = createToolHealth(d)
  await th.runStartup()
  th.stop()
  return { th, record: readToolHealthState(d.home).state.components[ID], result: th.lastResults().find((r) => r.id === ID) }
}

const notInstalledMessage = toolHealthMessage({ id: ID, label: ID }, "NOT_INSTALLED", "")

describe("row 132b: tool-health flags a stale staged proxy (F2)", () => {
  test("same size, different bytes, bundle mtime copied -> unhealthy NOT_INSTALLED (content differs)", async () => {
    const w = world()
    const other = Buffer.from(BUNDLE)
    other[other.length - 1] = 0x61
    stage(w, other)
    const st = fs.statSync(w.source)
    fs.utimesSync(w.target, st.atime, st.mtime)
    expect(fs.statSync(w.target).size).toBe(st.size)
    const d = deps(w)
    // Positive control for the spies below: an equal size IS hashed, so the spy sees the target opened.
    const asyncOpen = spyOn(fsp, "open")
    const { record, result } = await run(d)
    const targetOpens = asyncOpen.mock.calls.filter((c) => String(c[0]) === w.target).length
    asyncOpen.mockRestore()
    expect(targetOpens).toBe(1)
    expect(record?.lastStatus).toBe("dead")
    expect(record?.reason).toBe("NOT_INSTALLED")
    expect(record?.detail).toContain("content differs")
    expect(record?.detail).not.toContain(w.home)
    expect(result?.message).toBe(notInstalledMessage)
    expect(d.logged.some((l) => l.level === "warn" && l.message === notInstalledMessage)).toBe(true)
  })

  test("a sparse target larger than PROXY_MAX_BYTES is flagged without being opened or read (spy)", async () => {
    const w = world()
    fs.mkdirSync(w.bin, { recursive: true, mode: 0o700 })
    const fd = fs.openSync(w.target, "w", 0o755)
    fs.ftruncateSync(fd, 256 * 1024 * 1024 + 1)
    fs.closeSync(fd)
    const asyncOpen = spyOn(fsp, "open")
    const syncOpen = spyOn(fs, "openSync")
    const readFile = spyOn(fs, "readFileSync")
    try {
      const { record } = await run(deps(w))
      expect(record?.lastStatus).toBe("dead")
      expect(record?.reason).toBe("NOT_INSTALLED")
      expect(record?.detail).toContain("size differs")
      expect(asyncOpen.mock.calls.filter((c) => String(c[0]) === w.target)).toEqual([])
      expect(syncOpen.mock.calls.filter((c) => String(c[0]) === w.target)).toEqual([])
      expect(readFile.mock.calls.filter((c) => String(c[0]) === w.target)).toEqual([])
    } finally {
      asyncOpen.mockRestore()
      syncOpen.mockRestore()
      readFile.mockRestore()
    }
  })

  test("a smaller target is flagged on size alone, without opening it", async () => {
    const w = world()
    stage(w, BUNDLE.subarray(0, 100))
    const asyncOpen = spyOn(fsp, "open")
    try {
      const { record } = await run(deps(w))
      expect(record?.lastStatus).toBe("dead")
      expect(record?.detail).toContain("size differs")
      expect(asyncOpen.mock.calls.filter((c) => String(c[0]) === w.target)).toEqual([])
    } finally {
      asyncOpen.mockRestore()
    }
  })

  test("a symlink to a byte-equal copy is flagged and never followed", async () => {
    const w = world()
    fs.mkdirSync(w.bin, { recursive: true, mode: 0o700 })
    fs.symlinkSync(w.source, w.target)
    const asyncOpen = spyOn(fsp, "open")
    try {
      const { record } = await run(deps(w))
      expect(record?.lastStatus).toBe("dead")
      expect(record?.reason).toBe("NOT_INSTALLED")
      expect(record?.detail).toContain("not a regular file")
      expect(asyncOpen.mock.calls.filter((c) => String(c[0]) === w.target)).toEqual([])
    } finally {
      asyncOpen.mockRestore()
    }
  })

  test("a dangling symlink is flagged, not skipped as not installed", async () => {
    const w = world()
    fs.mkdirSync(w.bin, { recursive: true, mode: 0o700 })
    fs.symlinkSync(join(w.bin, "nowhere"), w.target)
    const { record } = await run(deps(w))
    expect(record?.lastStatus).toBe("dead")
    expect(record?.detail).toContain("not a regular file")
  })

  test("a user entry with the same id does not replace or silence the check", async () => {
    const w = world()
    stage(w, BUNDLE.subarray(0, 10))
    const user = {
      id: ID,
      label: "mine",
      probe: { kind: "http" as const, url: "http://127.0.0.1:1/", expectStatus: 200 },
      startup: "off" as const,
      consent: "auto" as const,
      source: "user" as const,
    }
    const { record } = await run(deps(w, { resolveRegistry: () => [user] }))
    expect(record?.lastStatus).toBe("dead")
    expect(record?.source).toBe("shipped")
  })
})

describe("row 132b: no false flag", () => {
  test("byte-equal copy -> healthy, and a re-check after a fix clears the flag", async () => {
    const w = world()
    stage(w, BUNDLE.subarray(0, 10))
    const d = deps(w)
    const th = createToolHealth(d)
    await th.runStartup()
    expect(readToolHealthState(w.home).state.components[ID]?.lastStatus).toBe("dead")
    stage(w, BUNDLE)
    await th.recheck()
    th.stop()
    const record = readToolHealthState(w.home).state.components[ID]
    expect(record?.lastStatus).toBe("healthy")
    expect(record?.reason).toBe("OK")
  })

  test("absent staged proxy -> skipped_not_installed, never dead, nothing created", async () => {
    const w = world()
    const { record } = await run(deps(w))
    expect(record?.lastStatus).toBe("skipped_not_installed")
    expect(fs.existsSync(join(w.home, ".swarm", "setup"))).toBe(false)
  })

  test("dev run (not packaged) and a build without the bundle copy add no check", async () => {
    const dev = world()
    stage(dev, BUNDLE.subarray(0, 10))
    expect((await run(deps(dev, { isPackaged: false }))).record).toBeUndefined()
    const bare = world({ bundle: false })
    stage(bare, BUNDLE.subarray(0, 10))
    expect((await run(deps(bare))).record).toBeUndefined()
  })
})

describe("row 132b: no new reason, message or UI; constants mirror setup", () => {
  test("the closed reason set is unchanged and the message is the existing Install tools text", () => {
    expect(TOOL_HEALTH_REASONS.length).toBe(30)
    expect(notInstalledMessage).toContain('"Install tools" command')
  })

  test("staged path and size cap equal setup's PROXY_BINARY_PATH and PROXY_MAX_BYTES", async () => {
    // Module-local constants (no production reader elsewhere), so the mirror is read from the source text.
    const src = fs.readFileSync(join(import.meta.dir, "startup.ts"), "utf8")
    const { PROXY_MAX_BYTES } = await import("../../../../setup/src/wiring/proxy_stage")
    const { PROXY_BINARY_PATH } = await import("../../../../setup/src/mcpproxy/register")
    expect(src).toContain(`const STAGED_PROXY_MAX_BYTES = 256 * 1024 * 1024\n`)
    expect(256 * 1024 * 1024).toBe(PROXY_MAX_BYTES)
    expect(src).toContain(`const STAGED_PROXY_NAME = "swarm-web-proxy"\n`)
    expect(src).toContain(`const STAGED_PROXY_REL = [".swarm", "setup", "bin", STAGED_PROXY_NAME] as const\n`)
    expect(PROXY_BINARY_PATH).toBe("~/.swarm/setup/bin/swarm-web-proxy")
  })
})
