// Swarm 1.2.7 row 32 (U-8 desktop half, SR7-13, security ruling §3.1 U-8): the `check-directory-exists` (N7-037)
// and `recreate-directory` (N7-039) channels. ipc.ts registers them with the real ipcMain; this file imports only
// electron types, so bun tests it through a fake ipcMain and real temp folders (the mission-ipc.ts pattern).
//
// Rules (SR7-13 1-4; 5-7 are the app's, row 33):
//   1 recreate creates the leaf only: the parent must exist as a directory, the leaf must not exist, `mkdir` without
//     `recursive`; EEXIST or any error is `false`; afterwards realpath(path) must equal realpath(parent)/leaf
//   2 input as U-2 (string, absolute, no NUL/control character, no `..` segment; Windows: no UNC, `\\?\`, `\\.\`,
//     device name); refused when the path, or the path resolved through its nearest existing ancestor (a symlinked
//     parent), is a filesystem root or lies in a system folder, Swarm's config/data/state/cache/userData folders or
//     a home credential place (REVEAL_EXCLUDED_HOME_PLACES, pinned equal to BypassLists.PROTECTED_HOME)
//   3 no `stat` at all on UNC, `/net/...` or `/Network/...` paths (autofs / SMB would open a network connection)
//   4 recreate accepts only a path for which check returned `false` (missing) for the SAME sender in this run
// Nothing runs at registration or startup: only an explicit renderer call stats, and only recreate creates.

import { lstat as fsLstat, mkdir as fsMkdir, realpath as fsRealpath, stat as fsStat } from "node:fs/promises"
import { homedir } from "node:os"
import { posix, win32 } from "node:path"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { REVEAL_EXCLUDED_HOME_PLACES } from "./reveal-path"

export const CHECK_DIRECTORY_EXISTS = "check-directory-exists" // N7-037
export const RECREATE_DIRECTORY = "recreate-directory" // N7-039

type StatLike = { isDirectory(): boolean; isSymbolicLink?(): boolean }

export type MissingDirectoryDeps = {
  ipcMain: Pick<IpcMain, "handle">
  /** Swarm's own folders (config, data, state, cache, userData, sessionData); ipc.ts passes revealExcluded(). */
  excluded?: readonly string[]
  home?: string
  platform?: NodeJS.Platform
  /** Only the app's own renderer may ask; default accepts every sender (tests). */
  isTrustedSender?: (event: IpcMainInvokeEvent) => boolean
  fs?: {
    stat?: (path: string) => Promise<StatLike>
    lstat?: (path: string) => Promise<StatLike>
    mkdir?: (path: string) => Promise<unknown>
    realpath?: (path: string) => Promise<string>
  }
  /** Persistent log (ipc.ts: the Swarm log). The path itself is never logged. */
  log?: (level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>) => void
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const WIN_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$) *(\..*)?$/i
const POSIX_SYSTEM = [
  "/System", "/Library", "/usr", "/bin", "/sbin", "/private/etc", "/etc", "/cores", "/boot", "/proc", "/sys", "/dev",
  "/Applications", "/opt", "/Volumes",
]
const POSIX_VAR = ["/private/var", "/var"]
const POSIX_TEMP = ["/private/var/folders", "/var/folders"]

type Flavour = { path: typeof posix; win: boolean; fold: boolean }
const flavourOf = (platform: NodeJS.Platform): Flavour => ({
  path: platform === "win32" ? win32 : posix,
  win: platform === "win32",
  fold: platform === "win32" || platform === "darwin",
})

function inside(f: Flavour, child: string, root: string) {
  const c = f.fold ? child.toLowerCase() : child
  const r = f.fold ? root.toLowerCase() : root
  if (c === r) return true
  const rel = f.path.relative(r, c)
  return rel !== "" && !rel.startsWith("..") && !f.path.isAbsolute(rel)
}

/** Rule 2 + 3 input check; the normalised path or null. Never touches the filesystem. */
function acceptedInput(f: Flavour, input: unknown): string | null {
  if (typeof input !== "string" || input.length === 0 || input.length > 4096 || CONTROL.test(input)) return null
  if (f.win) {
    if (/^[\\/]{2}/.test(input)) return null
    if (!/^[a-zA-Z]:[\\/]/.test(input)) return null
    const parts = input.split(/[\\/]/)
    if (parts.some((p) => p === "..")) return null
    if (parts.some((p) => WIN_DEVICE.test(p.replace(/[ .]+$/, "")))) return null
    if (parts.slice(1).some((p) => p.includes(":"))) return null
  } else {
    if (!input.startsWith("/")) return null
    if (input.split("/").some((p) => p === "..")) return null
  }
  const normal = f.path.normalize(input).replace(/[\\/]+$/, "") || f.path.parse(input).root
  if (!f.win) {
    const n = normal.toLowerCase()
    if (n === "/net" || n.startsWith("/net/") || n === "/network" || n.startsWith("/network/")) return null
  }
  return normal
}

/** Rule 2 place check on one spelling of the path (no filesystem access). */
function placeAllowed(f: Flavour, normal: string, home: string, excluded: readonly string[]): boolean {
  if (normal === f.path.parse(normal).root) return false
  // home itself and its ancestors are never "a project folder to recreate"
  if (inside(f, home, normal)) return false
  if (excluded.some((dir) => inside(f, normal, dir))) return false
  if (f.win) {
    const env = process.env
    const system = [env.WINDIR, env.SystemRoot, env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432, env.ProgramData]
      .filter((p): p is string => !!p)
      .concat(["C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)", "C:\\ProgramData"])
    if (system.some((s) => inside(f, normal, s))) return false
    if (/^[a-zA-Z]:\\program files/i.test(normal)) return false
    return true
  }
  if (POSIX_SYSTEM.some((s) => inside(f, normal, s))) return false
  if (POSIX_VAR.some((s) => inside(f, normal, s)) && !POSIX_TEMP.some((t) => inside(f, normal, t) && normal !== t))
    return false
  return true
}

const errorCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : ""

export function registerMissingDirectoryHandlers(deps: MissingDirectoryDeps) {
  const f = flavourOf(deps.platform ?? process.platform)
  const stat = deps.fs?.stat ?? ((p: string) => fsStat(p))
  const lstat = deps.fs?.lstat ?? ((p: string) => fsLstat(p))
  const mkdir = deps.fs?.mkdir ?? ((p: string) => fsMkdir(p))
  const realpath = deps.fs?.realpath ?? ((p: string) => fsRealpath(p))
  const home = f.path.normalize(deps.home ?? homedir())
  const log = deps.log ?? (() => {})
  // Rule 4: per sender, the paths check found missing in this run. A WeakMap, so a closed window frees its set.
  const missing = new WeakMap<object, Set<string>>()
  const key = (p: string) => (f.fold ? p.toLowerCase() : p)

  /** Both literal and resolved spellings of every excluded root (symlinked config folders included). */
  async function excludedRoots() {
    const list = [...(deps.excluded ?? []), ...REVEAL_EXCLUDED_HOME_PLACES.map((place) => f.path.join(home, place))]
      .filter((dir) => typeof dir === "string" && f.path.isAbsolute(dir))
      .map((dir) => f.path.normalize(dir))
    const real = await Promise.all(list.map((dir) => realpath(dir).catch(() => dir)))
    return [...new Set([...list, ...real])]
  }

  /**
   * The path as the filesystem would resolve it: realpath of the nearest existing ancestor + the missing tail.
   * A symlinked parent therefore shows where a recreate would really land (rule 2, `lstat(parent)` clause).
   */
  async function resolvedThroughAncestor(normal: string): Promise<string | null> {
    const tail: string[] = []
    let cur = normal
    for (let i = 0; i < 256; i++) {
      try {
        const real = await realpath(cur)
        return tail.length ? f.path.join(real, ...tail.reverse()) : real
      } catch {
        const parent = f.path.dirname(cur)
        if (parent === cur) return null
        tail.push(f.path.basename(cur))
        cur = parent
      }
    }
    return null
  }

  /** Rules 2 + 3: the normalised path when every spelling is allowed, else null. */
  async function checkedPath(input: unknown): Promise<string | null> {
    const normal = acceptedInput(f, input)
    if (!normal) return null
    const excluded = await excludedRoots()
    if (!placeAllowed(f, normal, home, excluded)) return null
    const resolved = await resolvedThroughAncestor(normal)
    if (resolved === null) return null
    if (resolved !== normal) {
      const again = acceptedInput(f, resolved)
      if (!again || !placeAllowed(f, again, home, excluded)) return null
    }
    return normal
  }

  const trusted = (event: IpcMainInvokeEvent) => (deps.isTrustedSender ? deps.isTrustedSender(event) : true)

  // N7-037: `stat` + `isDirectory`. `false` for a refused path (never stat'ed), a file, or a missing folder.
  deps.ipcMain.handle(CHECK_DIRECTORY_EXISTS, async (event: IpcMainInvokeEvent, input: unknown) => {
    try {
      if (!trusted(event)) return false
      const normal = await checkedPath(input)
      if (normal === null) {
        log("warn", "check-directory-exists refused a path", { source: "missing-directory.check" })
        return false
      }
      try {
        return (await stat(normal)).isDirectory()
      } catch (error) {
        const code = errorCode(error)
        if (code === "ENOENT" || code === "ENOTDIR") {
          const set = missing.get(event.sender) ?? new Set<string>()
          set.add(key(normal))
          missing.set(event.sender, set)
          log("info", "check-directory-exists: project folder missing", { source: "missing-directory.check", code })
        } else {
          log("warn", "check-directory-exists stat failed", { source: "missing-directory.check", code })
        }
        return false
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      log("error", "check-directory-exists failed", { source: "missing-directory.check", message: err.message, stack_trace: err.stack })
      return false
    }
  })

  // N7-039: create the one missing leaf folder, after the user's Recreate click (the app calls it only then).
  deps.ipcMain.handle(RECREATE_DIRECTORY, async (event: IpcMainInvokeEvent, input: unknown) => {
    try {
      if (!trusted(event)) return false
      const normal = await checkedPath(input)
      const set = missing.get(event.sender)
      if (normal === null || !set?.has(key(normal))) {
        log("warn", "recreate-directory refused a path this window did not find missing", {
          source: "missing-directory.recreate",
        })
        return false
      }
      const parent = f.path.dirname(normal)
      const leaf = f.path.basename(normal)
      // Rule 1: the parent exists as a directory (a symlinked parent was already resolved and placed by checkedPath),
      // and nothing, not even a dangling symlink, is at the leaf.
      const parentStat = await stat(parent).catch(() => null)
      if (!parentStat || !parentStat.isDirectory()) return false
      const parentReal = await realpath(parent)
      if (await lstat(normal).then(() => true, () => false)) return false
      try {
        await mkdir(normal)
      } catch (error) {
        log("warn", "recreate-directory mkdir failed", { source: "missing-directory.recreate", code: errorCode(error) })
        return false
      }
      const real = await realpath(normal).catch(() => null)
      if (real === null || key(real) !== key(f.path.join(parentReal, leaf))) {
        log("error", "recreate-directory: created folder resolves elsewhere", { source: "missing-directory.recreate" })
        return false
      }
      set.delete(key(normal))
      log("info", "recreate-directory created the missing project folder", { source: "missing-directory.recreate" })
      return true
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      log("error", "recreate-directory failed", { source: "missing-directory.recreate", message: err.message, stack_trace: err.stack })
      return false
    }
  })
}
