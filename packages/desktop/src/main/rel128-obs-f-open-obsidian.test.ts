import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as External from "./external-url"

// 1.2.8 row 42c (AC-OBSf, OBS-f-1, N8-361; 01c §7.2, D-O2, SR8-15): the dedicated IPC builds the obsidian:// URL in
// main from a path inside <vault>/swarm-memory/, refuses everything else, refuses foreign senders, says "no-app"
// without opening anything when no app handles obsidian://, and logs the reason only. The general URL gate is
// unchanged. Synthetic temp vault only; ipc.ts and preload cannot be imported in a test, so their wiring is read.

const here = import.meta.dir
const source = (file: string) => readFileSync(join(here, file), "utf8")
const ext = External as Record<string, any>

let base = ""
let vault = ""
let hub = ""
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "obsf-"))
  vault = join(base, "My Vault")
  const folder = join(vault, "swarm-memory", "default-project-3fa9c1")
  mkdirSync(folder, { recursive: true })
  mkdirSync(join(vault, "inbox"), { recursive: true })
  hub = join(folder, "index.md")
  writeFileSync(hub, "# hub\n")
  writeFileSync(join(folder, "notes.txt"), "x")
  writeFileSync(join(vault, "inbox", "note.md"), "x")
  symlinkSync(join(vault, "inbox", "note.md"), join(folder, "link.md"))
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

describe("resolveObsidianNoteURL (N8-436)", () => {
  test("a hub note in swarm-memory -> obsidian://open?path=<encoded real path>", async () => {
    const result = await ext.resolveObsidianNoteURL(hub, vault)
    const real = realpathSync(hub)
    expect(result.url).toBe("obsidian://open?path=" + encodeURIComponent(real))
    expect(result.url.startsWith("obsidian://open?path=%2F")).toBe(true)
    expect(result.url.endsWith("%2Fswarm-memory%2Fdefault-project-3fa9c1%2Findex.md")).toBe(true)
    expect(result.url.includes("My%20Vault")).toBe(true)
  })

  test("outside: inbox, .txt, relative, symlink into the folder, non-string", async () => {
    const cases: unknown[] = [
      join(vault, "inbox", "note.md"),
      join(vault, "swarm-memory", "default-project-3fa9c1", "notes.txt"),
      "swarm-memory/default-project-3fa9c1/index.md",
      join(vault, "swarm-memory", "default-project-3fa9c1", "link.md"),
      join(vault, "swarm-memory", "..", "inbox", "note.md"),
      42,
      undefined,
      { path: hub },
    ]
    const reasons = await Promise.all(cases.map((value) => ext.resolveObsidianNoteURL(value, vault)))
    expect(reasons.map((r) => r.reason)).toEqual(cases.map(() => "outside"))
    expect(reasons.filter((r) => "url" in r).length).toBe(0)
  })

  test("missing: an absent note inside swarm-memory", async () => {
    const result = await ext.resolveObsidianNoteURL(join(vault, "swarm-memory", "other-000000", "index.md"), vault)
    expect(result.reason).toBe("missing")
  })

  test("vault root: SWARM_VAULT_DIR when non-blank, else <home>/.swarm/vault", () => {
    expect(ext.obsidianVaultRoot({ SWARM_VAULT_DIR: " /v " }, "/h")).toBe("/v")
    expect(ext.obsidianVaultRoot({ SWARM_VAULT_DIR: "  " }, "/h")).toBe(join("/h", ".swarm/vault"))
    expect(ext.obsidianVaultRoot({}, "/h")).toBe(join("/h", ".swarm/vault"))
  })
})

describe("open-obsidian-note handler (N8-115, SR8-15)", () => {
  type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>
  function setup(options: { protocolApp?: string; openFails?: boolean } = {}) {
    const handlers = new Map<string, Handler>()
    const opened: string[] = []
    const logs: { message: string; context: Record<string, unknown> }[] = []
    const frame = { url: "oc://renderer/index.html" }
    const sender = { mainFrame: frame }
    const win = { isDestroyed: () => false, webContents: sender }
    ext.registerOpenObsidianNoteHandler({
      ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) },
      windowOf: (s: unknown) => (s === sender ? win : null),
      isRendererUrl: (url: string | undefined) => url === frame.url,
      vaultRoot: () => vault,
      protocolApp: () => options.protocolApp ?? "Obsidian",
      openExternal: async (url: string) => {
        if (options.openFails) throw new Error("no")
        opened.push(url)
      },
      log: (message: string, context: Record<string, unknown>) => logs.push({ message, context }),
    })
    const handler = handlers.get("open-obsidian-note")!
    const own = { sender, senderFrame: frame }
    return { handlers, handler, opened, logs, own, sender }
  }

  test("the app's window opens the hub: one openExternal call with the built URL", async () => {
    const s = setup()
    expect(s.handlers.size).toBe(1)
    expect(await s.handler(s.own, hub)).toBe("opened")
    expect(s.opened).toEqual(["obsidian://open?path=" + encodeURIComponent(realpathSync(hub))])
    expect(s.logs.length).toBe(0)
  })

  test("a foreign sender is refused and nothing opens", async () => {
    const s = setup()
    const other = { mainFrame: { url: "https://evil.invalid/" } }
    expect(await s.handler({ sender: other, senderFrame: other.mainFrame }, hub)).toBe("outside")
    const subframe = { url: "oc://renderer/index.html" }
    expect(await s.handler({ sender: s.sender, senderFrame: subframe }, hub)).toBe("outside")
    expect(s.opened.length).toBe(0)
    expect(s.logs.map((l) => l.context.reason)).toEqual(["sender", "sender"])
  })

  test("protocol name '' -> no-app and shell.openExternal not called", async () => {
    const s = setup({ protocolApp: "" })
    expect(await s.handler(s.own, hub)).toBe("no-app")
    expect(s.opened.length).toBe(0)
  })

  test("openExternal rejecting -> failed; outside and missing pass through", async () => {
    const s = setup({ openFails: true })
    expect(await s.handler(s.own, hub)).toBe("failed")
    expect(await s.handler(s.own, join(vault, "inbox", "note.md"))).toBe("outside")
    expect(await s.handler(s.own, join(vault, "swarm-memory", "x-000000", "index.md"))).toBe("missing")
  })

  test("refusals log the reason only, never the path (as C55)", async () => {
    const s = setup({ protocolApp: "" })
    await s.handler(s.own, hub)
    await s.handler(s.own, join(vault, "inbox", "note.md"))
    await s.handler({ sender: {}, senderFrame: {} }, hub)
    expect(s.logs.length).toBe(3)
    const text = JSON.stringify(s.logs)
    expect(text.includes(base)).toBe(false)
    expect(text.includes("swarm-memory")).toBe(false)
    expect(s.logs.every((l) => Object.keys(l.context).join() === "reason")).toBe(true)
  })
})

describe("CHAR-URL and wiring", () => {
  test("the general URL gate still refuses obsidian:", () => {
    expect(External.resolveExternalURL("obsidian://open?path=x")).toBeUndefined()
    expect(External.resolveExternalURL("obsidian://open?vault=a&file=b")).toBeUndefined()
  })

  test("ipc.ts registers the handler with shell.openExternal and the protocol check; preload exposes the channel", () => {
    const ipc = source("ipc.ts")
    expect(ipc.includes("registerOpenObsidianNoteHandler({")).toBe(true)
    expect(ipc.includes("app.getApplicationNameForProtocol(url)")).toBe(true)
    expect(ipc.includes("shell.openExternal(url)")).toBe(true)
    const preload = readFileSync(join(here, "../preload/index.ts"), "utf8")
    expect(preload.includes('openObsidianNote: (hubPath) => ipcRenderer.invoke("open-obsidian-note", hubPath)')).toBe(true)
    // The renderer never sends a URL: only this one channel carries a path in.
    expect(preload.match(/open-obsidian-note/g)?.length).toBe(1)
  })
})

// 1.2.8 row 42d (U3, C150): no registered obsidian:// handler -> the Install-tools staged app at
// <home>/.swarm/tools/obsidian/<version>/Obsidian.app, launched with execFile("/usr/bin/open", ["-a", app, url]) only
// after its Contents/MacOS/Obsidian hashes to current.json's appBinarySha256. mkdtemp HOME; execFile is a stub, so
// nothing is launched and the real ~/.swarm is never read.
describe("staged Obsidian fallback (row 42d)", () => {
  type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>
  const binaryBytes = "#!/bin/sh\n# synthetic staged obsidian\n"
  const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")

  function stage(options: { digest?: string; version?: string; symlinkApp?: boolean } = {}) {
    const home = mkdtempSync(join(tmpdir(), "obsd-"))
    const root = join(home, ".swarm", "tools", "obsidian")
    const version = options.version ?? "v1.14.4"
    if (options.symlinkApp) {
      const elsewhere = join(home, "elsewhere", "Obsidian.app", "Contents", "MacOS")
      mkdirSync(elsewhere, { recursive: true })
      writeFileSync(join(elsewhere, "Obsidian"), binaryBytes)
      mkdirSync(join(root, version), { recursive: true })
      symlinkSync(join(home, "elsewhere", "Obsidian.app"), join(root, version, "Obsidian.app"))
    } else {
      const macos = join(root, version, "Obsidian.app", "Contents", "MacOS")
      mkdirSync(macos, { recursive: true })
      writeFileSync(join(macos, "Obsidian"), binaryBytes)
    }
    mkdirSync(root, { recursive: true })
    writeFileSync(
      join(root, "current.json"),
      JSON.stringify({
        version,
        appBinarySha256: options.digest ?? sha(binaryBytes),
        observedTeamIdentifier: "TEAMID0000",
        installedAt: "2026-11-09T00:00:00.000Z",
      }),
    )
    return { home, app: join(root, version, "Obsidian.app") }
  }

  function setup(home: string, options: { launchFails?: boolean } = {}) {
    const handlers = new Map<string, Handler>()
    const opened: string[] = []
    const launched: { file: string; args: string[] }[] = []
    const logs: { message: string; context: Record<string, unknown> }[] = []
    const frame = { url: "oc://renderer/index.html" }
    const sender = { mainFrame: frame }
    const win = { isDestroyed: () => false, webContents: sender }
    ext.registerOpenObsidianNoteHandler({
      ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) },
      windowOf: (s: unknown) => (s === sender ? win : null),
      isRendererUrl: (url: string | undefined) => url === frame.url,
      vaultRoot: () => vault,
      protocolApp: () => "",
      openExternal: async (url: string) => void opened.push(url),
      log: (message: string, context: Record<string, unknown>) => logs.push({ message, context }),
      setupHome: () => home,
      execFile: async (file: string, args: string[]) => {
        launched.push({ file, args })
        if (options.launchFails) throw new Error("open failed")
      },
    })
    return { handler: handlers.get("open-obsidian-note")!, own: { sender, senderFrame: frame }, opened, launched, logs }
  }

  const homes: string[] = []
  afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })))

  test("no handler + verified staged app -> opened via /usr/bin/open -a <app> <url>, no openExternal", async () => {
    const st = stage()
    homes.push(st.home)
    const s = setup(st.home)
    expect(await s.handler(s.own, hub)).toBe("opened")
    expect(s.launched).toEqual([
      {
        file: "/usr/bin/open",
        args: ["-a", realpathSync(st.app), "obsidian://open?path=" + encodeURIComponent(realpathSync(hub))],
      },
    ])
    expect(s.opened.length).toBe(0)
    expect(s.logs.length).toBe(0)
  })

  test("digest mismatch -> failed, nothing launched, reason only in the log", async () => {
    const st = stage({ digest: "0".repeat(64) })
    homes.push(st.home)
    const s = setup(st.home)
    expect(await s.handler(s.own, hub)).toBe("failed")
    expect(s.launched.length).toBe(0)
    expect(s.opened.length).toBe(0)
    expect(s.logs.map((l) => l.context.reason)).toEqual(["staged-digest"])
    expect(JSON.stringify(s.logs).includes(st.home)).toBe(false)
  })

  test("neither a handler nor a staged app -> no-app, nothing launched", async () => {
    const home = mkdtempSync(join(tmpdir(), "obsd-"))
    homes.push(home)
    const s = setup(home)
    expect(await s.handler(s.own, hub)).toBe("no-app")
    expect(s.launched.length).toBe(0)
    expect(s.opened.length).toBe(0)
    expect(s.logs.map((l) => l.context.reason)).toEqual(["no-app"])
  })

  test("symlinked app, unsafe version, failed launch -> failed; nothing escapes the tool root", async () => {
    const link = stage({ symlinkApp: true })
    const unsafe = stage({ version: "../escape" })
    homes.push(link.home, unsafe.home)
    const a = setup(link.home)
    expect(await a.handler(a.own, hub)).toBe("failed")
    expect(a.launched.length).toBe(0)
    expect(a.logs.map((l) => l.context.reason)).toEqual(["staged-escape"])
    const b = setup(unsafe.home)
    expect(await b.handler(b.own, hub)).toBe("failed")
    expect(b.launched.length).toBe(0)
    expect(b.logs.map((l) => l.context.reason)).toEqual(["staged-invalid"])
    const ok = stage()
    homes.push(ok.home)
    const c = setup(ok.home, { launchFails: true })
    expect(await c.handler(c.own, hub)).toBe("failed")
    expect(c.logs.map((l) => l.context.reason)).toEqual(["staged-launch"])
  })

  test("ipc.ts wires the setup home and execFile without a shell", () => {
    const ipc = source("ipc.ts")
    expect(ipc.includes("setupHome: () => resolveSetupHome(process.env, userInfo().homedir)")).toBe(true)
    expect(ipc.includes("execFile(file, args, (err) => (err ? reject(err) : resolve()))")).toBe(true)
    const handlerSrc = source("external-url.ts")
    expect(handlerSrc.includes('deps.execFile("/usr/bin/open", ["-a", staged.app, resolved.url])')).toBe(true)
    expect(/shell:\s*true/.test(ipc + handlerSrc)).toBe(false)
  })
})
