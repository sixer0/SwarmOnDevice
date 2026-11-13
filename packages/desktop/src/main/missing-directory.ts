// Swarm 1.2.7 row 32 (U-8 desktop half, SR7-13, security ruling §3.1 U-8): the `check-directory-exists` (N7-037)
// and `recreate-directory` (N7-039) channels. ipc.ts registers them with the real ipcMain; this file imports only
// electron types, so bun tests it through a fake ipcMain and real temp folders (the mission-ipc.ts pattern).
// Row 47c (M1-03, M1-10): the check answers a tri-state, and the place rules come from the shared path-policy.ts.
//
// Rules (SR7-13 1-4; 5-7 are the app's, rows 33 / 47c):
//   1 recreate creates the leaf only: the parent must exist as a directory, the leaf must not exist, `mkdir` without
//     `recursive`; EEXIST or any error is `false`; afterwards realpath(path) must equal realpath(parent)/leaf
//   2 input as U-2 (path-policy acceptedInput). The check refuses to look (answer "refused", no `stat`) when the path,
//     or the path resolved through its nearest existing ancestor (a symlinked parent), is a filesystem root, a U-2 (a)
//     system place (`/Volumes` only as the path itself), inside Swarm's config/state/userData/sessionData folders
//     (`excluded`) or a home credential place (PROTECTED_HOME_PLACES). Everything else is looked at: /opt,
//     /Applications, /Volumes/<disk>, the home folder and Swarm's data folder (session worktrees) open as in 1.2.6.
//     Recreate refuses all of that and, in addition, the home folder and its ancestors and `recreateExcluded`
//     (Swarm's data and cache folders)
//   3 no `stat` at all on UNC, `/net/...` or `/Network/...` paths (autofs / SMB would open a network connection)
//   4 recreate accepts only a path for which check answered "missing" for the SAME sender in this run
// Answers of the check: "exists" (a directory), "missing" (ENOENT / ENOTDIR, or a non-directory at the path),
// "refused" (the check was not allowed to look, or the look failed for another reason such as EACCES). The app shows
// the missing-folder notice for "missing" only and opens "exists" and "refused" exactly as 1.2.6 did.
// Nothing runs at registration or startup: only an explicit renderer call stats, and only recreate creates.

import { lstat as fsLstat, mkdir as fsMkdir, realpath as fsRealpath, stat as fsStat } from "node:fs/promises"
import { homedir } from "node:os"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import {
  absoluteRoots,
  acceptedInput,
  flavourOf,
  inside,
  insideAny,
  isFilesystemRoot,
  isSystemPlace,
  protectedHomeRoots,
  type Flavour,
} from "./path-policy"

export const CHECK_DIRECTORY_EXISTS = "check-directory-exists" // N7-037
export const RECREATE_DIRECTORY = "recreate-directory" // N7-039

/** Row 47c (M1-03): the answer of `check-directory-exists`. */
export type DirectoryCheck = "exists" | "missing" | "refused"

type StatLike = { isDirectory(): boolean; isSymbolicLink?(): boolean }

export type MissingDirectoryDeps = {
  ipcMain: Pick<IpcMain, "handle">
  /** Refused for check and recreate: Swarm's config, state, userData and sessionData folders. */
  excluded?: readonly string[]
  /** Refused for recreate only: Swarm's data and cache folders (the session worktrees live in data). */
  recreateExcluded?: readonly string[]
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

/** The SR7-13 check rule set on one spelling of the path (no filesystem access). */
function checkAllowed(f: Flavour, normal: string, excluded: readonly string[]): boolean {
  if (isFilesystemRoot(f, normal)) return false
  if (isSystemPlace(f, normal)) return false
  return !insideAny(f, normal, excluded)
}

/** The recreate rule set: the check set plus home and its ancestors and the recreate-only roots. */
function recreateAllowed(f: Flavour, normal: string, home: string, excluded: readonly string[], recreateOnly: readonly string[]) {
  if (!checkAllowed(f, normal, excluded)) return false
  // home itself and its ancestors are never "a project folder to recreate"
  if (inside(f, home, normal)) return false
  return !insideAny(f, normal, recreateOnly)
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

  /** Both literal and resolved spellings of each root list (symlinked config folders included). */
  async function spellings(roots: readonly string[]) {
    const list = absoluteRoots(f, roots)
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

  /**
   * Rules 2 + 3 for one rule set: the normalised path when the path and its resolved spelling are both allowed, else
   * null. Only `realpath` on the path's existing ancestors runs here, never on a refused-by-input (network) path.
   */
  async function checkedPath(input: unknown, forRecreate: boolean): Promise<string | null> {
    const accepted = acceptedInput(f, input)
    if (!accepted) return null
    const normal = accepted.replace(/[\\/]+$/, "") || f.path.parse(accepted).root
    const excluded = await spellings([...(deps.excluded ?? []), ...protectedHomeRoots(f, home)])
    const recreateOnly = forRecreate ? await spellings(deps.recreateExcluded ?? []) : []
    const allowed = (p: string) =>
      forRecreate ? recreateAllowed(f, p, home, excluded, recreateOnly) : checkAllowed(f, p, excluded)
    if (!allowed(normal)) return null
    const resolved = await resolvedThroughAncestor(normal)
    if (resolved === null) return null
    if (resolved !== normal) {
      const again = acceptedInput(f, resolved)
      if (!again || !allowed(again)) return null
    }
    return normal
  }

  const trusted = (event: IpcMainInvokeEvent) => (deps.isTrustedSender ? deps.isTrustedSender(event) : true)

  // N7-037: `stat` + `isDirectory`, answered as a DirectoryCheck (row 47c, M1-03). "refused" is never stat'ed.
  deps.ipcMain.handle(CHECK_DIRECTORY_EXISTS, async (event: IpcMainInvokeEvent, input: unknown): Promise<DirectoryCheck> => {
    try {
      if (!trusted(event)) return "refused"
      const normal = await checkedPath(input, false)
      if (normal === null) {
        log("info", "check-directory-exists did not look at a refused place", { source: "missing-directory.check" })
        return "refused"
      }
      try {
        // a non-directory at the path is not the project folder: missing, but never recorded for Recreate (rule 1
        // would refuse it anyway, since something is at the leaf)
        return (await stat(normal)).isDirectory() ? "exists" : "missing"
      } catch (error) {
        const code = errorCode(error)
        if (code === "ENOENT" || code === "ENOTDIR") {
          const set = missing.get(event.sender) ?? new Set<string>()
          set.add(key(normal))
          missing.set(event.sender, set)
          log("info", "check-directory-exists: project folder missing", { source: "missing-directory.check", code })
          return "missing"
        }
        // EACCES, EPERM, ELOOP, ...: the check could not look, so the app opens the folder as 1.2.6 did
        log("warn", "check-directory-exists stat failed", { source: "missing-directory.check", code })
        return "refused"
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      log("error", "check-directory-exists failed", { source: "missing-directory.check", message: err.message, stack_trace: err.stack })
      return "refused"
    }
  })

  // N7-039: create the one missing leaf folder, after the user's Recreate click (the app calls it only then).
  deps.ipcMain.handle(RECREATE_DIRECTORY, async (event: IpcMainInvokeEvent, input: unknown) => {
    try {
      if (!trusted(event)) return false
      const normal = await checkedPath(input, true)
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
