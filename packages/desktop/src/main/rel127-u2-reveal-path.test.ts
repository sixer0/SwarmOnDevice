// N7-084 (Swarm 1.2.7 row 25, AC-U2 desktop half, SR7-11): the `reveal-path` rule and handler.
// Red at 04067a9d02: reveal-path.ts does not exist and ipc.ts `reveal-path` only runs `stat`, so a path outside the
// roots is revealed. Green: isRevealablePath (N7-026) follows the security ruling §3.1 U-2 table, the handler calls
// shell.showItemInFolder(<checked realpath>) only, and REVEAL_EXCLUDED_HOME_PLACES (N7-148) equals
// BypassLists.PROTECTED_HOME. Synthetic temp folders only; no module mocks (reveal-path.ts imports electron types only).

import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isRevealablePath, REVEAL_EXCLUDED_HOME_PLACES, revealInFolder } from "./reveal-path"

const T = realpathSync(mkdtempSync(join(tmpdir(), "r127u2-")))
afterAll(() => rmSync(T, { recursive: true, force: true }))

const home = join(T, "home")
const proj = join(T, "proj")
const deliver = join(proj, "docs", "m1", "11_deliverables")
const other = join(T, "other")
mkdirSync(deliver, { recursive: true })
mkdirSync(join(home, ".ssh"), { recursive: true })
mkdirSync(join(home, "Library", "Keychains"), { recursive: true })
mkdirSync(join(home, ".config", "swarm"), { recursive: true })
mkdirSync(join(home, "Notes"), { recursive: true })
mkdirSync(other, { recursive: true })
writeFileSync(join(deliver, "Laporan.pdf"), "%PDF-1.7\n")
writeFileSync(join(deliver, "Tandatangani.command"), "#!/bin/sh\ntouch \"$HOME/r127u2-sentinel\"\n")
chmodSync(join(deliver, "Tandatangani.command"), 0o755)
mkdirSync(join(deliver, "Tool.app", "Contents"), { recursive: true })
writeFileSync(join(home, ".ssh", "id_test"), "synthetic")
writeFileSync(join(home, "Library", "Keychains", "k.db"), "synthetic")
writeFileSync(join(home, ".config", "swarm", "swarm.json"), "{}")
writeFileSync(join(home, "Notes", "attachment.txt"), "synthetic")
writeFileSync(join(other, "secret.txt"), "synthetic")
symlinkSync(join(other, "secret.txt"), join(deliver, "leak.pdf"))
symlinkSync(join(home, ".ssh", "id_test"), join(deliver, "key.pdf"))

const roots = [proj, home]
const excluded = [join(home, ".config", "swarm")]

type Calls = { show: string[]; openPath: string[]; openExternal: string[] }
let calls: Calls
let realpathCalls: string[]
beforeEach(() => {
  calls = { show: [], openPath: [], openExternal: [] }
  realpathCalls = []
})
// A full fake shell: openPath/openExternal are spies that must stay untouched (no fallback).
const shell = () => ({
  showItemInFolder: (p: string) => void calls.show.push(p),
  openPath: async (p: string) => (calls.openPath.push(p), ""),
  openExternal: async (u: string) => void calls.openExternal.push(u),
})
const reveal = (path: unknown, extra: Partial<Parameters<typeof revealInFolder>[2]> = {}) =>
  revealInFolder(path, roots, { shell: shell(), home, excluded, platform: "darwin", ...extra })
const noLaunch = () => {
  expect(calls.openPath).toEqual([])
  expect(calls.openExternal).toEqual([])
}
// Identity realpath for synthetic paths that do not exist on this machine; records each call.
const identity = (p: string) => (realpathCalls.push(p), p)

describe("N7-084 reveal inside the roots: showItemInFolder only", () => {
  test("a .command inside a Mission Control root is revealed, never opened or launched", () => {
    expect(reveal(join(deliver, "Tandatangani.command"))).toBe(true)
    expect(calls.show).toEqual([join(deliver, "Tandatangani.command")])
    noLaunch()
    expect(() => statSync(join(home, "r127u2-sentinel"))).toThrow()
  })
  test("an .app bundle (folder) inside a root is revealed, never opened", () => {
    expect(reveal(join(deliver, "Tool.app"))).toBe(true)
    expect(calls.show).toEqual([join(deliver, "Tool.app")])
    noLaunch()
  })
  test("a PDF deliverable and a home attachment (root b) are revealed", () => {
    expect(reveal(join(deliver, "Laporan.pdf"))).toBe(true)
    expect(reveal(join(home, "Notes", "attachment.txt"))).toBe(true)
    expect(calls.show).toEqual([join(deliver, "Laporan.pdf"), join(home, "Notes", "attachment.txt")])
    noLaunch()
  })
  test("the revealed path is the checked realpath, not the input spelling", () => {
    expect(reveal(`${deliver}/./Laporan.pdf`)).toBe(true)
    expect(calls.show).toEqual([join(deliver, "Laporan.pdf")])
  })
  test("a showItemInFolder failure returns false with no openPath/openExternal fallback", () => {
    const failing = { ...shell(), showItemInFolder: () => { throw new Error("no file manager") } }
    const logs: string[] = []
    expect(revealInFolder(join(deliver, "Laporan.pdf"), roots, { shell: failing, home, excluded, platform: "darwin", log: (_l, m) => void logs.push(m) })).toBe(false)
    noLaunch()
    expect(logs.length).toBe(1)
  })
})

describe("N7-084 refused: outside the roots, excluded places, symlinks leaving", () => {
  const refused = (path: unknown, extra: Partial<Parameters<typeof revealInFolder>[2]> = {}) => {
    expect(reveal(path, extra)).toBe(false)
    expect(calls.show).toEqual([])
    noLaunch()
  }
  test("a path outside every root gives false and showItemInFolder is not called", () => refused(join(other, "secret.txt")))
  test("a missing file inside a root gives false (realpath fails)", () => refused(join(deliver, "missing.pdf")))
  test("home credential places (N7-148) are refused", () => {
    refused(join(home, ".ssh", "id_test"))
    refused(join(home, ".ssh"))
    refused(join(home, "Library", "Keychains", "k.db"))
  })
  test("Swarm's own folders passed as excluded are refused", () => refused(join(home, ".config", "swarm", "swarm.json")))
  test("a symlink in the project whose realpath leaves the roots is refused", () => refused(join(deliver, "leak.pdf")))
  test("a symlink in the project whose realpath lands in .ssh is refused", () => refused(join(deliver, "key.pdf")))
  test("case-folded credential place on macOS (.SSH) is refused", () => {
    expect(isRevealablePath("/Users/u/.SSH/id", ["/Users/u"], { home: "/Users/u", platform: "darwin", realpath: identity })).toBe(false)
    expect(isRevealablePath("/Users/u/Library/keychains/x", ["/Users/u"], { home: "/Users/u", platform: "darwin", realpath: identity })).toBe(false)
    expect(isRevealablePath("/Users/u/Documents/x.pdf", ["/Users/u"], { home: "/Users/u", platform: "darwin", realpath: identity })).toBe(true)
  })
})

describe("N7-084 SR7-11 input rules (refused before any realpath)", () => {
  const inputRefused = (path: unknown, platform: NodeJS.Platform = "darwin") => {
    expect(reveal(path, { platform, realpath: identity })).toBe(false)
    expect(realpathCalls.filter((p) => p === path)).toEqual([])
    expect(calls.show).toEqual([])
    noLaunch()
  }
  test("non-strings and empty", () => {
    for (const bad of [undefined, null, 42, {}, [join(deliver, "Laporan.pdf")], ""]) inputRefused(bad)
  })
  test("relative paths", () => {
    inputRefused("docs/m1/11_deliverables/Laporan.pdf")
    inputRefused("./Laporan.pdf")
    inputRefused("~/Laporan.pdf")
  })
  test("a `..` segment, even one that normalises back inside a root", () => {
    inputRefused(`${deliver}/../../../../other/secret.txt`)
    inputRefused(`${deliver}/../11_deliverables/Laporan.pdf`)
    inputRefused(`${deliver}/..`)
  })
  test("NUL and control characters (C0, DEL, C1)", () => {
    inputRefused(`${deliver}/Laporan.pdf\u0000.command`)
    inputRefused(`${deliver}/Lap\noran.pdf`)
    inputRefused(`${deliver}/Lap\u007foran.pdf`)
    inputRefused(`${deliver}/Lap\u0085oran.pdf`)
    inputRefused(`${deliver}/Lap\u009boran.pdf`)
  })
  test("macOS/Linux autofs network paths /net and /Network", () => {
    inputRefused("/net/host/share/x.pdf")
    inputRefused("/net")
    inputRefused("/Network/Servers/host/x.pdf")
    inputRefused("/NET/host/x.pdf")
    inputRefused("/net/host/x.pdf", "linux")
  })
  test("Windows UNC, \\\\?\\, \\\\.\\, device names and drive-relative paths", () => {
    for (const bad of [
      "\\\\host\\share\\x.pdf",
      "//host/share/x.pdf",
      "\\\\?\\C:\\Users\\u\\proj\\x.pdf",
      "\\\\.\\PhysicalDrive0",
      "\\\\?\\UNC\\host\\share\\x.pdf",
      "C:\\Users\\u\\proj\\CON",
      "C:\\Users\\u\\proj\\nul.txt",
      "C:\\Users\\u\\proj\\com1 .pdf",
      "C:\\Users\\u\\proj\\LPT9",
      "C:\\Users\\u\\proj\\..\\x.pdf",
      "C:Users\\u\\x.pdf",
      "\\Users\\u\\x.pdf",
      "C:\\Users\\u\\proj\\x.pdf:stream",
    ])
      inputRefused(bad, "win32")
  })
  test("a well-formed Windows path inside a root is accepted (the rule is not deny-all)", () => {
    const win = { home: "C:\\Users\\u", platform: "win32" as const, realpath: identity }
    expect(isRevealablePath("C:\\Users\\u\\proj\\docs\\m\\11_deliverables\\x.pdf", ["D:\\work\\proj", "C:\\Users\\u"], win)).toBe(true)
    expect(isRevealablePath("D:\\work\\proj\\x.command", ["D:\\work\\proj", "C:\\Users\\u"], win)).toBe(true)
    expect(isRevealablePath("C:\\Users\\u\\.ssh\\id", ["C:\\Users\\u"], win)).toBe(false)
    expect(isRevealablePath("C:\\Windows\\System32\\x.dll", ["C:\\Windows", "C:\\Users\\u"], win)).toBe(false)
    expect(isRevealablePath("C:\\Program Files\\App\\x.exe", ["C:\\Program Files\\App"], win)).toBe(false)
    expect(isRevealablePath("E:\\x.pdf", ["E:\\"], win)).toBe(false)
  })
})

describe("N7-084 roots (a) refused when a filesystem root, a system folder or above home", () => {
  const opts = { home: "/Users/u", platform: "darwin" as const, realpath: identity }
  test("filesystem root /", () => expect(isRevealablePath("/opt/p/x.pdf", ["/"], opts)).toBe(false))
  test("system folders and folders inside them", () => {
    for (const [path, root] of [
      ["/System/Library/x", "/System"],
      ["/Library/Preferences/x.plist", "/Library"],
      ["/usr/local/bin/x", "/usr/local"],
      ["/bin/sh", "/bin"],
      ["/sbin/x", "/sbin"],
      ["/private/etc/hosts", "/private/etc"],
      ["/private/var/db/x", "/private/var/db"],
      ["/cores/x", "/cores"],
      ["/etc/passwd", "/etc"],
      ["/proc/1/x", "/proc"],
      ["/dev/x", "/dev"],
    ])
      expect(isRevealablePath(path, [root], opts)).toBe(false)
  })
  test("/Volumes itself is refused, a volume folder is a root", () => {
    expect(isRevealablePath("/Volumes/Disk/x.pdf", ["/Volumes"], opts)).toBe(false)
    expect(isRevealablePath("/Volumes/Disk/proj/x.pdf", ["/Volumes/Disk/proj"], opts)).toBe(true)
  })
  test("/private/var is refused except the user temp folders", () => {
    expect(isRevealablePath("/private/var/folders/ab/xy/T/p/x.pdf", ["/private/var/folders/ab/xy/T/p"], opts)).toBe(true)
    expect(isRevealablePath("/private/var/folders/x.pdf", ["/private/var/folders"], opts)).toBe(false)
  })
  test("a folder above home (/Users) does not open other users' homes", () =>
    expect(isRevealablePath("/Users/other/x.pdf", ["/Users"], opts)).toBe(false))
})

describe("N7-148 REVEAL_EXCLUDED_HOME_PLACES equals BypassLists.PROTECTED_HOME", () => {
  test("same entries, same order", () => {
    const source = readFileSync(join(import.meta.dir, "../../../opencode/src/permission/bypass-lists.ts"), "utf8")
    const body = source.match(/export const PROTECTED_HOME: readonly string\[\] = \[([\s\S]*?)\]/)?.[1]
    expect(body).toBeDefined()
    const opencode = [...body!.matchAll(/"([^"]+)"/g)].map((m) => m[1])
    expect(opencode.length).toBeGreaterThan(10)
    expect([...REVEAL_EXCLUDED_HOME_PLACES]).toEqual(opencode)
  })
})

describe("N7-084 ipc.ts wiring: reveal-path goes through revealInFolder, no fallback", () => {
  const ipc = readFileSync(join(import.meta.dir, "ipc.ts"), "utf8")
  const start = ipc.indexOf('ipcMain.handle("reveal-path"')
  const block = ipc.slice(start, ipc.indexOf("ipcMain.handle(", start + 10))
  test("the handler uses revealInFolder with this window's revealRoots (N7-126)", () => {
    expect(start).toBeGreaterThan(-1)
    expect(block).toContain("revealInFolder(")
    expect(block).toContain("revealRoots(event.sender)")
    expect(ipc).toContain("revealRoots?: (sender: WebContents) => string[]")
  })
  test("the handler never calls openPath, openExternal or showItemInFolder directly", () => {
    expect(block).not.toMatch(/openPath|openExternal|openLocalFile|showItemInFolder\(/)
  })
})
