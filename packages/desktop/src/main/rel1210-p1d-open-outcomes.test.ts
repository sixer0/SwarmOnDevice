import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import * as External from "./external-url"
import {
  fakeObsidianHome,
  lsappinfoOutputs,
  registryMalformed,
  registryRegistered,
  registryUnregistered,
} from "./rel1210-obsidian-registry.fixture"

// 1.3.0 row 45 (AC-P1d, N10-163; 01a §3.5, §3.6; N10-020..N10-023, N10-028, N10-141; C12, C17, C29, C44, C75).
// "Open graph in Obsidian" checks Obsidian's vault list before it opens the hub note: after the launcher decision
// (protocol handler, or the verified staged app) and only when both registry deps are passed, the registry step runs;
// `in-vault` -> launch -> "opened", `registered` -> launch -> "registered", the two refusals -> no launch.
// Everything is fake: the home and Obsidian data folder come from the row 39 fixture (mkdtemp), the detection runner
// is a fixture runner, and the launch calls are stubs that only record. Nothing is launched, nothing on the machine is
// enumerated, and no real path is read (the AC-P1c c15-c17 pins scan this file too, F44-6).

const here = import.meta.dir
const source = (file: string) => readFileSync(join(here, file), "utf8")
const ext = External as Record<string, any>
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")

type Fixture = ReturnType<typeof fakeObsidianHome>
type Output = keyof typeof lsappinfoOutputs
type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>

const made: Fixture[] = []
afterEach(() => {
  while (made.length) made.pop()!.cleanup()
})
function keep<T extends Fixture>(fixture: T): T {
  made.push(fixture)
  return fixture
}

/** The vault list as parsed JSON (vault ids -> entries). */
function vaults(fixture: Fixture): Record<string, { path: string; ts: number }> {
  return JSON.parse(readFileSync(fixture.registryPath, "utf8")).vaults ?? {}
}
function fileHash(fixture: Fixture) {
  return sha(readFileSync(fixture.registryPath))
}

/** Install-tools staged Obsidian.app under the fake home (as rel128-obs-f), digest recorded in current.json. */
function stage(home: string) {
  const root = join(home, ".swarm", "tools", "obsidian")
  const version = "1.14.4"
  const macos = join(root, version, "Obsidian.app", "Contents", "MacOS")
  mkdirSync(macos, { recursive: true })
  const binary = Buffer.from("synthetic obsidian binary")
  writeFileSync(join(macos, "Obsidian"), binary)
  writeFileSync(
    join(root, "current.json"),
    JSON.stringify({ version, appBinarySha256: sha(binary), observedTeamIdentifier: "6JSW4SJWN9", installedAt: "2026-11-09T00:00:00.000Z" }),
  )
  return realpathSync(join(root, version, "Obsidian.app"))
}

type Options = {
  protocolApp?: string
  runner?: Output
  openFails?: boolean
  launchFails?: boolean
  signatureFails?: boolean
  staged?: boolean
  registry?: boolean
}

/** The handler with stub deps. `registry: false` leaves out obsidianConfigDir (the BASE / non-darwin shape). */
function setup(fixture: Fixture, options: Options = {}) {
  const handlers = new Map<string, Handler>()
  const opened: string[] = []
  const launched: { file: string; args: string[] }[] = []
  const signed: string[][] = []
  const logs: { message: string; context: Record<string, unknown> }[] = []
  const counts = { configDir: 0, runner: 0 }
  let open = { fails: options.openFails ?? false }
  const frame = { url: "oc://renderer/index.html" }
  const sender = { mainFrame: frame }
  const win = { isDestroyed: () => false, webContents: sender }
  const deps: Record<string, unknown> = {
    ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) },
    windowOf: (s: unknown) => (s === sender ? win : null),
    isRendererUrl: (url: string | undefined) => url === frame.url,
    vaultRoot: () => fixture.vaultRoot,
    protocolApp: () => options.protocolApp ?? "Obsidian",
    openExternal: async (url: string) => {
      if (open.fails) throw new Error("fake launch refused")
      opened.push(url)
    },
    log: (message: string, context: Record<string, unknown>) => logs.push({ message, context }),
    runLsappinfo: () => {
      counts.runner++
      return lsappinfoOutputs[options.runner ?? "closed"]()
    },
  }
  if (options.registry !== false)
    deps.obsidianConfigDir = () => {
      counts.configDir++
      return fixture.configDir
    }
  if (options.staged) {
    deps.setupHome = () => fixture.home
    deps.execFile = async (file: string, args: string[]) => {
      if (file === "/usr/bin/codesign") {
        signed.push(args)
        if (options.signatureFails) throw new Error("fake codesign: invalid signature")
        return { stdout: "", stderr: args[0] === "-dvv" ? "Executable=x\nTeamIdentifier=6JSW4SJWN9\n" : "" }
      }
      launched.push({ file, args })
      if (options.launchFails) throw new Error("fake open failed")
      return { stdout: "", stderr: "" }
    }
  } else {
    // present but never to be called on the protocol-handler path (d3)
    deps.execFile = async (file: string, args: string[]) => void launched.push({ file, args })
  }
  ext.registerOpenObsidianNoteHandler(deps)
  const handler = handlers.get("open-obsidian-note")!
  const press = () => handler({ sender, senderFrame: frame }, fixture.hubPath)
  const url = "obsidian://open?path=" + encodeURIComponent(realpathSync(fixture.hubPath))
  return { press, opened, launched, signed, logs, counts, url, setOpenFails: (fails: boolean) => (open = { fails }) }
}

describe("AC-P1d open-obsidian-note with the registry step (N10-163)", () => {
  test("d1 protocol handler + registryUnregistered + closed runner -> registered, one new entry, one launch with the BASE URL", async () => {
    const fixture = keep(registryUnregistered())
    const before = vaults(fixture)
    const s = setup(fixture)
    expect(await s.press()).toBe("registered")
    const after = vaults(fixture)
    const added = Object.keys(after).filter((id) => !(id in before))
    expect(added.length).toBe(1)
    expect(after[added[0]!]!.path).toBe(fixture.vaultRoot)
    for (const id of Object.keys(before)) expect(after[id]).toEqual(before[id]!)
    expect(s.opened).toEqual([s.url])
    expect(s.launched.length).toBe(0)
    expect(s.logs.length).toBe(0)
  })

  test("H1 the real closed output ('\\n', exit 0) -> registered and one launch; a second press -> opened (C127)", async () => {
    const fixture = keep(registryUnregistered())
    const s = setup(fixture, { runner: "closedNewline" })
    expect(await s.press()).toBe("registered")
    expect(s.counts.runner).toBe(2)
    expect(s.logs).toEqual([])
    expect(await s.press()).toBe("opened")
    expect(s.opened).toEqual([s.url, s.url])
  })

  test("d2 registryRegistered -> opened, no detection call, the list unchanged", async () => {
    const fixture = keep(registryRegistered())
    const hash = fileHash(fixture)
    const s = setup(fixture)
    expect(await s.press()).toBe("opened")
    expect(s.counts.runner).toBe(0)
    expect(fileHash(fixture)).toBe(hash)
    expect(s.opened).toEqual([s.url])
  })

  test("d3 Obsidian running -> close-obsidian, nothing launched, list unchanged, reason only in the log", async () => {
    const fixture = keep(registryUnregistered())
    const hash = fileHash(fixture)
    const s = setup(fixture, { runner: "running" })
    expect(await s.press()).toBe("close-obsidian")
    expect(s.opened.length).toBe(0)
    expect(s.launched.length).toBe(0)
    expect(fileHash(fixture)).toBe(hash)
    expect(s.logs.map((l) => l.context)).toEqual([{ reason: "obsidian-running" }])
  })

  test("d3b detection unsure -> close-obsidian / obsidian-unsure, nothing launched", async () => {
    const fixture = keep(registryUnregistered())
    const hash = fileHash(fixture)
    const s = setup(fixture, { runner: "garbage" })
    expect(await s.press()).toBe("close-obsidian")
    expect(s.opened.length + s.launched.length).toBe(0)
    expect(fileHash(fixture)).toBe(hash)
    expect(s.logs.map((l) => l.context)).toEqual([{ reason: "obsidian-unsure" }])
  })

  test("d4 malformed list -> not-registered, nothing launched, reason registry-malformed", async () => {
    const fixture = keep(registryMalformed("json"))
    const hash = fileHash(fixture)
    const s = setup(fixture)
    expect(await s.press()).toBe("not-registered")
    expect(s.opened.length + s.launched.length).toBe(0)
    expect(fileHash(fixture)).toBe(hash)
    expect(s.logs.map((l) => l.context)).toEqual([{ reason: "registry-malformed" }])
  })

  test("d5 no protocol handler and no setup home -> no-app; the registry is never consulted", async () => {
    const fixture = keep(registryUnregistered())
    const hash = fileHash(fixture)
    const s = setup(fixture, { protocolApp: "" })
    expect(await s.press()).toBe("no-app")
    expect(s.counts.configDir).toBe(0)
    expect(s.counts.runner).toBe(0)
    expect(fileHash(fixture)).toBe(hash)
  })

  test("d6 staged app with a failing signature -> failed; the registry is never consulted", async () => {
    const fixture = keep(registryUnregistered())
    stage(fixture.home)
    const hash = fileHash(fixture)
    const s = setup(fixture, { protocolApp: "", staged: true, signatureFails: true })
    expect(await s.press()).toBe("failed")
    expect(s.counts.configDir).toBe(0)
    expect(s.counts.runner).toBe(0)
    expect(s.launched.length).toBe(0)
    expect(fileHash(fixture)).toBe(hash)
    expect(s.logs.map((l) => l.context)).toEqual([{ reason: "staged-signature" }])
  })

  test("d7 verified staged app + registryUnregistered + closed -> registered, /usr/bin/open -a <app> <url> once", async () => {
    const fixture = keep(registryUnregistered())
    const app = stage(fixture.home)
    const before = Object.keys(vaults(fixture)).length
    const s = setup(fixture, { protocolApp: "", staged: true })
    expect(await s.press()).toBe("registered")
    expect(Object.keys(vaults(fixture)).length).toBe(before + 1)
    expect(s.launched).toEqual([{ file: "/usr/bin/open", args: ["-a", app, s.url] }])
    expect(s.opened.length).toBe(0)
    expect(s.signed.length).toBe(2)
  })

  test("d7b verified staged app + registryRegistered -> opened (launch once); launch failure after a write -> failed, entry kept", async () => {
    const fixture = keep(registryRegistered())
    stage(fixture.home)
    const s = setup(fixture, { protocolApp: "", staged: true })
    expect(await s.press()).toBe("opened")
    expect(s.launched.length).toBe(1)

    const fresh = keep(registryUnregistered())
    stage(fresh.home)
    const before = Object.keys(vaults(fresh)).length
    const f = setup(fresh, { protocolApp: "", staged: true, launchFails: true })
    expect(await f.press()).toBe("failed")
    expect(Object.keys(vaults(fresh)).length).toBe(before + 1)
    expect(f.logs.map((l) => l.context)).toEqual([{ reason: "staged-launch" }])
  })

  test("d8 the launch fails after the write -> failed, the entry stays; the next press -> opened", async () => {
    const fixture = keep(registryUnregistered())
    const before = Object.keys(vaults(fixture)).length
    const s = setup(fixture, { openFails: true })
    expect(await s.press()).toBe("failed")
    expect(Object.keys(vaults(fixture)).length).toBe(before + 1)
    const hash = fileHash(fixture)
    s.setOpenFails(false)
    expect(await s.press()).toBe("opened")
    expect(fileHash(fixture)).toBe(hash)
    expect(s.opened).toEqual([s.url])
  })

  test("d9 every refusal logs { reason } only: a known reason, no path, no slash", async () => {
    const all: { message: string; context: Record<string, unknown> }[] = []
    const run = async (fixture: Fixture, options: Options) => {
      const s = setup(keep(fixture), options)
      await s.press()
      all.push(...s.logs)
    }
    await run(registryUnregistered(), { runner: "running" })
    await run(registryUnregistered(), { runner: "garbage" })
    await run(registryUnregistered(), { runner: "rejects" })
    await run(registryMalformed("json"), {})
    await run(registryUnregistered(), { protocolApp: "" })
    const signed = registryUnregistered()
    stage(signed.home)
    await run(signed, { protocolApp: "", staged: true, signatureFails: true })
    await run(registryUnregistered(), { openFails: true })
    const known = new Set([
      // N10-026 (11 shipped)
      "obsidian-running",
      "obsidian-unsure",
      "registry-malformed",
      "registry-too-large",
      "registry-odd-file",
      "nested-child",
      "alias-case",
      "unsafe-root",
      "registry-changed",
      "registry-verify",
      "registry-write",
      // BASE reasons
      "sender",
      "missing",
      "outside",
      "no-app",
      "failed",
      "staged-invalid",
      "staged-escape",
      "staged-digest",
      "staged-signature",
      "staged-launch",
    ])
    expect(all.length).toBe(7)
    for (const entry of all) {
      expect(entry.message).toBe("obsidian note refused")
      expect(Object.keys(entry.context)).toEqual(["reason"])
      expect(known.has(String(entry.context.reason))).toBe(true)
      expect(JSON.stringify(entry).includes("/")).toBe(false)
    }
  })

  test("d10 deps without obsidianConfigDir -> BASE behaviour: opened, nothing read, nothing written", async () => {
    const fixture = keep(registryUnregistered())
    const listing = readdirSync(fixture.configDir).sort()
    const hash = fileHash(fixture)
    const s = setup(fixture, { registry: false })
    expect(await s.press()).toBe("opened")
    expect(s.counts.runner).toBe(0)
    expect(readdirSync(fixture.configDir).sort()).toEqual(listing)
    expect(fileHash(fixture)).toBe(hash)
    expect(s.opened).toEqual([s.url])
  })

  test("d11 two presses at once -> registered and opened, exactly one new entry", async () => {
    const fixture = keep(registryUnregistered())
    const before = Object.keys(vaults(fixture)).length
    const s = setup(fixture)
    const results = await Promise.all([s.press(), s.press()])
    expect([...results].sort()).toEqual(["opened", "registered"])
    const after = vaults(fixture)
    expect(Object.keys(after).length).toBe(before + 1)
    expect(Object.values(after).filter((entry) => entry.path === fixture.vaultRoot).length).toBe(1)
    expect(s.opened.length).toBe(2)
  })
})

// d12: the two URL functions as they stand at BASE a3e3c4c93a (external-url.ts :9-14 and :55-74), held here verbatim.
const BASE_RESOLVE_EXTERNAL_URL = String.raw`export function resolveExternalURL(value: string) {
  if (!URL.canParse(value)) return undefined
  const url = new URL(value)
  if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") return url.href
  return undefined
}`

const BASE_RESOLVE_OBSIDIAN_NOTE_URL = String.raw`export async function resolveObsidianNoteURL(
  hubPath: unknown,
  vaultRoot: string,
): Promise<{ url: string } | { reason: "missing" | "outside" }> {
  if (typeof hubPath !== "string" || !isAbsolute(hubPath) || !hubPath.endsWith(".md")) return { reason: "outside" }
  const root = await realpath(vaultRoot).catch(() => undefined)
  const info = await lstat(hubPath).catch((error: NodeJS.ErrnoException) => error)
  if (info instanceof Error) {
    // "missing" only for an absent note inside the mirror folder (as written, or under the root's real path).
    const absent = info.code === "ENOENT" || info.code === "ENOTDIR"
    const inside = [vaultRoot, root].some((r) => r && normalize(hubPath).startsWith(join(r, VAULT_MIRROR_DIR) + sep))
    return { reason: absent && inside ? "missing" : "outside" }
  }
  if (info.isSymbolicLink() || !info.isFile()) return { reason: "outside" }
  if (!root) return { reason: "outside" }
  const real = await realpath(hubPath).catch(() => undefined)
  const mirror = join(root, VAULT_MIRROR_DIR) + sep
  if (!real || !real.startsWith(mirror) || !real.endsWith(".md")) return { reason: "outside" }
  return { url: "obsidian://open?path=" + encodeURIComponent(real) }
}`

/** From `start` to the first line that is exactly `}` (a top-level function's end). */
function topLevelFunction(text: string, start: string) {
  const from = text.indexOf(start)
  if (from < 0) return ""
  const end = text.indexOf("\n}\n", from)
  return end < 0 ? "" : text.slice(from, end + 2)
}

/** The `registerOpenObsidianNoteHandler({` call in ipc.ts up to its closing `  })` line. */
function ipcHandlerBlock(ipc: string) {
  const from = ipc.indexOf("registerOpenObsidianNoteHandler({")
  if (from < 0) return ""
  const end = ipc.indexOf("\n  })\n", from)
  return end < 0 ? "" : ipc.slice(from, end + 6)
}

describe("AC-P1d source pins (N10-163 d12, d13)", () => {
  test("d12 resolveExternalURL and resolveObsidianNoteURL are byte-identical to BASE; obsidian: still refused", () => {
    const text = source("external-url.ts")
    expect(topLevelFunction(text, "export function resolveExternalURL(")).toBe(BASE_RESOLVE_EXTERNAL_URL)
    expect(topLevelFunction(text, "export async function resolveObsidianNoteURL(")).toBe(BASE_RESOLVE_OBSIDIAN_NOTE_URL)
    expect(sha(BASE_RESOLVE_EXTERNAL_URL).length).toBe(64)
    expect(ext.resolveExternalURL("obsidian://open?path=x")).toBeUndefined()
  })

  test("d13 ipc.ts passes obsidianConfigDir and runLsappinfo only on darwin, from the home folder and the keyed runner", () => {
    const ipc = source("ipc.ts")
    const block = ipcHandlerBlock(ipc)
    expect(block.length).toBeGreaterThan(0)
    const gate = block.indexOf('process.platform === "darwin"')
    expect(gate).toBeGreaterThan(0)
    for (const name of ["obsidianConfigDir", "runLsappinfo"]) {
      expect(block.split(name).length - 1).toBe(1)
      expect(block.indexOf(name)).toBeGreaterThan(gate)
    }
    const home = "app." + "get" + "Path" + '("home")'
    expect(block.includes(`obsidianConfigDir: () => join(${home}, ...OBSIDIAN_DATA_DIR_SEGMENTS)`)).toBe(true)
    expect(block.includes("runLsappinfo: makeLsappinfoRunner(execFile)")).toBe(true)
    expect(block.includes("get" + "Path" + '("appData")')).toBe(false)
    expect(ipc.includes('const OBSIDIAN_DATA_DIR_SEGMENTS = ["Library", "Application Support", "obsidian"] as const')).toBe(true)
    expect(ipc.split("OBSIDIAN_DATA_DIR_SEGMENTS").length - 1).toBe(2)
    expect(source("external-url.ts").includes("OBSIDIAN_DATA_DIR_SEGMENTS")).toBe(false)
    expect(source("obsidian-registry.ts").includes("OBSIDIAN_DATA_DIR_SEGMENTS")).toBe(false)
    // the production readers of the two module exports (C44)
    expect(/import \{[^}]*\bmakeLsappinfoRunner\b[^}]*\} from "\.\/obsidian-registry"/.test(ipc)).toBe(true)
    expect(/import \{[^}]*\bensureObsidianVault\b[^}]*\} from "\.\/obsidian-registry"/.test(source("external-url.ts"))).toBe(true)
  })

  // Union copy 2 (preload/types.ts) is not pinned here: the renderer hands window.api.openObsidianNote to the app's
  // Platform type (copy 3), so copy 2 can only widen together with copy 3 (row 46; finding F45-1). The four-copy
  // equality is N10-165's (row 46).
  test("union copy 1 carries the 8 members of N10-023 and stays unexported", () => {
    const members = ["opened", "missing", "outside", "no-app", "failed", "registered", "close-obsidian", "not-registered"]
    const union = members.map((m) => `"${m}"`).join(" | ")
    const text = source("external-url.ts")
    expect(text.includes(`\ntype ObsidianNoteResult = ${union}\n`)).toBe(true)
    expect(text.includes("export type ObsidianNoteResult")).toBe(false)
  })
})
