// Swarm 1.2.7 row 47c (M1-03, M1-10; AC-U8 + AC-U2, SR7-13 U-8 ruling, decision C61).
// M1-03: `check-directory-exists` answered `false` both for a folder it refused to look at and for a missing folder,
// and it refused more than SR7-13 lists (/opt, /Applications, /Volumes/<disk>, home, Swarm's data folder where the
// session worktrees live). The app read every `false` as "missing", so those existing projects no longer opened.
// M1-10: reveal-path.ts and missing-directory.ts each carried their own copy of the path rules, and the copies drifted.
// Red at HEAD 5085f42a57: the check returns `false` (not "exists") for the existing folders below, and path-policy.ts
// does not exist. Green: tri-state exists | missing | refused, the SR7-13 list exactly, one shared rule module.
// Synthetic paths only: system-like folders come from an injected fs, home and data folders are temp folders.

import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CHECK_DIRECTORY_EXISTS, RECREATE_DIRECTORY, registerMissingDirectoryHandlers } from "./missing-directory"

const T = realpathSync(mkdtempSync(join(tmpdir(), "r127m1p-")))
afterAll(() => rmSync(T, { recursive: true, force: true }))

const home = join(T, "home")
const swarmConfig = join(home, ".config", "swarm")
const swarmData = join(home, ".local", "share", "swarm")
const worktree = join(swarmData, "worktree", "proj", "main")
mkdirSync(swarmConfig, { recursive: true })
mkdirSync(worktree, { recursive: true })
mkdirSync(join(home, ".ssh"), { recursive: true })

// Folders that exist on a real Mac but must not be needed on the test host: served by an injected fs.
const FAKE_DIRS = new Set(["/opt", "/opt/swarm-build-1.2.7", "/Volumes", "/Volumes/External", "/Volumes/External/proj", "/Applications", "/Applications/Proj"])
const enoent = (p: string) => Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" })

type Handler = (event: { sender: object }, ...args: unknown[]) => Promise<unknown>

function setup() {
  const handlers = new Map<string, Handler>()
  const stats: string[] = []
  const mkdirs: string[] = []
  const fsp = require("node:fs/promises") as typeof import("node:fs/promises")
  const fake = (p: string) => FAKE_DIRS.has(p) || p === "/"
  registerMissingDirectoryHandlers({
    ipcMain: { handle: ((channel: string, fn: Handler) => void handlers.set(channel, fn)) as never },
    home,
    platform: "darwin",
    excluded: [swarmConfig],
    recreateExcluded: [swarmData],
    fs: {
      stat: async (p) => {
        stats.push(p)
        if (fake(p)) return { isDirectory: () => true }
        if (p.startsWith("/opt/") || p.startsWith("/Volumes/") || p.startsWith("/Applications/")) throw enoent(p)
        return fsp.stat(p)
      },
      lstat: async (p) => {
        if (fake(p)) return { isDirectory: () => true, isSymbolicLink: () => false }
        if (p.startsWith("/opt/") || p.startsWith("/Volumes/") || p.startsWith("/Applications/")) throw enoent(p)
        return fsp.lstat(p)
      },
      realpath: async (p) => {
        if (fake(p)) return p
        if (p.startsWith("/opt/") || p.startsWith("/Volumes/") || p.startsWith("/Applications/")) throw enoent(p)
        return fsp.realpath(p)
      },
      mkdir: async (p) => {
        mkdirs.push(p)
        return fsp.mkdir(p)
      },
    },
  } as never)
  const call = (channel: string, sender: object, path: unknown) => handlers.get(channel)!({ sender }, path)
  return { call, stats, mkdirs }
}

describe("M1-03 check-directory-exists is tri-state and refuses only the SR7-13 places", () => {
  test("existing folders under /opt, /Volumes/<disk>, /Applications are 'exists' (were 'missing' at HEAD)", async () => {
    const { call, stats } = setup()
    for (const p of ["/opt/swarm-build-1.2.7", "/Volumes/External/proj", "/Applications/Proj"]) {
      expect(await call(CHECK_DIRECTORY_EXISTS, {}, p)).toBe("exists")
    }
    expect(stats).toEqual(["/opt/swarm-build-1.2.7", "/Volumes/External/proj", "/Applications/Proj"])
  })

  test("the home folder and a Swarm worktree in the data folder are 'exists'", async () => {
    const { call } = setup()
    expect(await call(CHECK_DIRECTORY_EXISTS, {}, home)).toBe("exists")
    expect(await call(CHECK_DIRECTORY_EXISTS, {}, worktree)).toBe("exists")
  })

  test("a gone folder on an external disk is 'missing' and can be recreated (leaf only)", async () => {
    const { call } = setup()
    expect(await call(CHECK_DIRECTORY_EXISTS, {}, "/Volumes/External/gone")).toBe("missing")
    expect(await call(CHECK_DIRECTORY_EXISTS, {}, join(home, "Gone Project"))).toBe("missing")
  })

  test("refused places answer 'refused' without any stat: system folders, /Volumes itself, Swarm config, credentials, network", async () => {
    const { call, stats } = setup()
    const refused = [
      "/",
      "/System/Gone",
      "/Library/Gone",
      "/usr/local/gone",
      "/private/etc/gone",
      "/private/var/db/gone",
      "/Volumes",
      join(swarmConfig, "gone"),
      join(home, ".ssh", "gone"),
      join(home, "Library", "Keychains", "gone"),
      "/net/host/share/proj",
      "/Network/Servers/host/proj",
      "relative/path",
      42,
    ]
    for (const p of refused) expect(await call(CHECK_DIRECTORY_EXISTS, {}, p)).toBe("refused")
    expect(stats).toEqual([])
  })

  test("Recreate stays limited: never home, never Swarm's data folder, even when the check saw the path missing", async () => {
    const { call, mkdirs } = setup()
    const sender = {}
    const goneWorktree = join(swarmData, "worktree", "proj", "gone")
    expect(await call(CHECK_DIRECTORY_EXISTS, sender, goneWorktree)).toBe("missing")
    expect(await call(RECREATE_DIRECTORY, sender, goneWorktree)).toBe(false)
    expect(await call(RECREATE_DIRECTORY, sender, home)).toBe(false)
    expect(mkdirs).toEqual([])
    const ok = join(home, "Recreate Me")
    expect(await call(CHECK_DIRECTORY_EXISTS, sender, ok)).toBe("missing")
    expect(await call(RECREATE_DIRECTORY, sender, ok)).toBe(true)
    expect(mkdirs).toEqual([ok])
  })
})

describe("M1-10 one shared desktop module holds the path rules", () => {
  const src = (p: string) => readFileSync(join(import.meta.dir, p), "utf8")

  test("reveal-path.ts and missing-directory.ts import the rules from path-policy.ts and keep no copy", async () => {
    const policy = await import("./path-policy")
    expect(typeof policy.acceptedInput).toBe("function")
    expect(typeof policy.isSystemPlace).toBe("function")
    for (const file of ["reveal-path.ts", "missing-directory.ts"]) {
      const text = src(file)
      expect(text).toContain(`from "./path-policy"`)
      for (const copy of ["const CONTROL", "const WIN_DEVICE", "const POSIX_SYSTEM", "const POSIX_VAR", "const POSIX_TEMP", "function inside(", "function acceptedInput(", "const flavourOf"]) {
        expect(text).not.toContain(copy)
      }
    }
    const reveal = await import("./reveal-path")
    expect(reveal.REVEAL_EXCLUDED_HOME_PLACES).toBe(policy.PROTECTED_HOME_PLACES)
  })

  test("the system list is the SR7-13 / U-2 (a) list: /opt, /Applications and /Volumes/<disk> are not system places", async () => {
    const { flavourOf, isSystemPlace } = await import("./path-policy")
    const f = flavourOf("darwin")
    for (const p of ["/System/x", "/Library/x", "/usr/x", "/bin/x", "/sbin/x", "/private/etc/x", "/private/var/db", "/cores/x", "/Volumes", "/etc/x", "/boot/x", "/proc/x", "/sys/x", "/dev/x"])
      expect(isSystemPlace(f, p)).toBe(true)
    for (const p of ["/opt/x", "/Applications/x", "/Volumes/External", "/private/var/folders/ab/T/x", "/Users/someone/proj"])
      expect(isSystemPlace(f, p)).toBe(false)
  })
})
