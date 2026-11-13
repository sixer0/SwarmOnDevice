// Swarm 1.2.7 row 25 (U-2, SR7-11, security ruling §3.1 U-2): the rule behind the `reveal-path` IPC channel.
// ipc.ts registers the channel with the real `shell`; this file imports only electron types, so bun tests it with
// spies and without module mocks (the mission-ipc.ts / setup-tools-ipc.ts pattern).
//
// Rule (N7-026 isRevealablePath):
//   input    string, absolute, no NUL/control character, no `..` segment before normalising; Windows: no UNC, `\\?\`,
//            `\\.\` or device name; macOS/Linux: nothing under `/net` or `/Network` (autofs network mounts)
//   check    the normalised path AND its realpath lie inside an allowed root and outside every excluded root; a
//            realpath that fails (missing file) is `false`
//   roots    (a) folders this window listed in Mission Control, refused when a filesystem/drive root, a system folder
//            or a folder above the home folder; (b) the home folder
//   excluded Swarm's config/data/state/cache folders, Electron userData/sessionData (given by ipc.ts) and the home
//            credential places REVEAL_EXCLUDED_HOME_PLACES (N7-148, pinned equal to BypassLists.PROTECTED_HOME)
//   action   shell.showItemInFolder(<checked realpath>) only; never openPath/openExternal, no fallback (U3, C10):
//            a `.command` or `.app` is shown in Finder / File Explorer, never launched

import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { posix, win32 } from "node:path"
import type { Shell } from "electron"

/** N7-148: desktop copy of opencode `BypassLists.PROTECTED_HOME` (permission/bypass-lists.ts), pinned equal by N7-084. */
export const REVEAL_EXCLUDED_HOME_PLACES: readonly string[] = [
  ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".netrc", ".git-credentials", ".password-store", ".pgpass",
  ".swarm-patch-key", ".config/gh", ".config/gcloud", ".config/op", ".local/share/keyrings", "Library/Keychains",
  "Library/Cookies",
]

export type RevealPathDeps = {
  /** Further excluded roots: Swarm's own config, data, state and cache folders, userData, sessionData. */
  excluded?: readonly string[]
  home?: string
  platform?: NodeJS.Platform
  /** Resolves symlinks; throws for a missing path. Default: fs.realpathSync.native. */
  realpath?: (path: string) => string
  /** Persistent log (ipc.ts: the Swarm log). The path itself is never logged. */
  log?: (level: "warn" | "error", message: string, context?: Record<string, unknown>) => void
}

// System folders a Mission Control root (a) may not be or lie in. `/private/var` is refused except the user temp
// folders under `/private/var/folders` (macOS), checked separately below.
const POSIX_SYSTEM = [
  "/System", "/Library", "/usr", "/bin", "/sbin", "/private/etc", "/etc", "/cores", "/boot", "/proc", "/sys", "/dev",
]
const POSIX_VAR = ["/private/var", "/var"]
const POSIX_TEMP = ["/private/var/folders", "/var/folders"]
const WIN_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$) *(\..*)?$/i
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

type Flavour = { path: typeof posix; win: boolean; fold: boolean }

const flavourOf = (platform: NodeJS.Platform): Flavour => ({
  path: platform === "win32" ? win32 : posix,
  win: platform === "win32",
  // macOS and Windows folders compare case-insensitively (default APFS / NTFS), so `~/.SSH` is still `.ssh`.
  fold: platform === "win32" || platform === "darwin",
})

function inside(f: Flavour, child: string, root: string) {
  const c = f.fold ? child.toLowerCase() : child
  const r = f.fold ? root.toLowerCase() : root
  if (c === r) return true
  const rel = f.path.relative(r, c)
  return rel !== "" && !rel.startsWith("..") && !f.path.isAbsolute(rel)
}

/** SR7-11 input rule; returns the normalised path or null. */
function acceptedInput(f: Flavour, input: unknown): string | null {
  if (typeof input !== "string" || input.length === 0 || CONTROL.test(input)) return null
  if (f.win) {
    if (/^[\\/]{2}/.test(input)) return null // UNC `\\host\share`, `\\?\`, `\\.\`, `//host`
    if (!/^[a-zA-Z]:[\\/]/.test(input)) return null
    const parts = input.split(/[\\/]/)
    if (parts.some((p) => p === "..")) return null
    if (parts.some((p) => WIN_DEVICE.test(p.replace(/[ .]+$/, "")))) return null
    if (parts.slice(1).some((p) => p.includes(":"))) return null // alternate data streams
  } else {
    if (!input.startsWith("/")) return null
    if (input.split("/").some((p) => p === "..")) return null
  }
  const normal = f.path.normalize(input)
  if (!f.win) {
    const n = f.fold ? normal.toLowerCase() : normal
    if (n === "/net" || n.startsWith("/net/") || n === "/network" || n.startsWith("/network/")) return null
    if (normal === "/Network" || normal.startsWith("/Network/")) return null
  }
  return normal
}

/** A root (a) is refused when it is a filesystem/drive root, a system folder (or inside one), or above home. */
function acceptedRoot(f: Flavour, root: string, home: string): boolean {
  const normal = acceptedInput(f, root)
  if (!normal) return false
  if (normal === f.path.parse(normal).root) return false
  if (inside(f, home, normal) && !inside(f, normal, home)) return false
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
  if (normal === "/Volumes" || normal === "/volumes") return false
  if (POSIX_VAR.some((s) => inside(f, normal, s)) && !POSIX_TEMP.some((t) => inside(f, normal, t) && normal !== t))
    return false
  return true
}

/** Both spellings of a folder: as given (normalised) and resolved, when it resolves. */
function bothForms(f: Flavour, dir: string, realpath: (p: string) => string): string[] {
  const normal = f.path.normalize(dir)
  try {
    const real = realpath(dir)
    return real === normal ? [normal] : [normal, real]
  } catch {
    return [normal]
  }
}

/** The checked realpath to reveal, or null (N7-026 rule). */
function checkedRealpath(input: unknown, roots: readonly string[], deps: RevealPathDeps): string | null {
  const f = flavourOf(deps.platform ?? process.platform)
  const realpath = deps.realpath ?? realpathSync.native
  const home = f.path.normalize(deps.home ?? homedir())
  const normal = acceptedInput(f, input)
  if (!normal) return null
  let real: string
  try {
    real = realpath(normal)
  } catch {
    return null
  }
  if (!f.path.isAbsolute(real) || CONTROL.test(real)) return null
  const allowed = roots
    .filter((root) => typeof root === "string" && acceptedRoot(f, root, home))
    .flatMap((root) => bothForms(f, root, realpath))
  const excluded = [...(deps.excluded ?? []), ...REVEAL_EXCLUDED_HOME_PLACES.map((place) => f.path.join(home, place))]
    .filter((dir) => typeof dir === "string" && f.path.isAbsolute(dir))
    .flatMap((dir) => bothForms(f, dir, realpath))
  for (const candidate of [normal, real]) {
    if (!allowed.some((root) => inside(f, candidate, root))) return null
    if (excluded.some((dir) => inside(f, candidate, dir))) return null
  }
  return real
}

/** N7-026: may this path be shown in Finder / File Explorer for a window with these roots (a) + (b)? */
export function isRevealablePath(path: unknown, roots: readonly string[], deps: RevealPathDeps = {}): boolean {
  return checkedRealpath(path, roots, deps) !== null
}

/**
 * The `reveal-path` handler body: `false` unless the path passes N7-026, then `shell.showItemInFolder(<realpath>)`.
 * Nothing is opened or launched, and a failure never falls back to `openPath` / `openExternal`.
 */
export function revealInFolder(
  path: unknown,
  roots: readonly string[],
  deps: RevealPathDeps & { shell: Pick<Shell, "showItemInFolder"> },
): boolean {
  const real = checkedRealpath(path, roots, deps)
  if (real === null) {
    deps.log?.("warn", "reveal-path refused a path outside the allowed roots", { source: "reveal-path", roots: roots.length })
    return false
  }
  try {
    deps.shell.showItemInFolder(real)
    return true
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    deps.log?.("error", "reveal-path showItemInFolder failed", { source: "reveal-path", message: err.message, stack_trace: err.stack })
    return false
  }
}
