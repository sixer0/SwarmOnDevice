// Swarm 1.2.7 row 47c (M1-10): the one desktop copy of the path rules shared by `reveal-path` (U-2, SR7-11, row 25)
// and `check-directory-exists` / `recreate-directory` (U-8, SR7-13, row 32). Before this file each caller carried its
// own copy and the copies drifted (M1-03). Each caller now picks its rule set from these pieces:
//   input     acceptedInput: string, absolute, no NUL/control character, no `..` segment; Windows: no UNC, `\\?\`,
//             `\\.\`, device name or stream; macOS/Linux: nothing under `/net` or `/Network` (autofs network mounts)
//   system    isSystemPlace: the U-2 (a) list of the security ruling, as the path or an ancestor of it. `/Volumes` is
//             a system place only as the path itself; `/private/var` except the user temp folders under it
//   home      PROTECTED_HOME_PLACES (N7-148, pinned equal to opencode BypassLists.PROTECTED_HOME) and isAboveHome
//   excluded  insideAny over caller-given roots (Swarm's config, state, data, cache, userData, sessionData folders)
// This file imports nothing from electron and touches the filesystem only through `bothForms` (a given realpath).

import { posix, win32 } from "node:path"

/** N7-148: desktop copy of opencode `BypassLists.PROTECTED_HOME` (permission/bypass-lists.ts), pinned equal by N7-084. */
export const PROTECTED_HOME_PLACES: readonly string[] = [
  ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".netrc", ".git-credentials", ".password-store", ".pgpass",
  ".swarm-patch-key", ".config/gh", ".config/gcloud", ".config/op", ".local/share/keyrings", "Library/Keychains",
  "Library/Cookies",
]

// U-2 (a) system folders (macOS and Linux), refused as the path or as an ancestor of it. `/etc` and `/var` also catch
// the macOS short spellings of `/private/etc` and `/private/var`.
const POSIX_SYSTEM = [
  "/System", "/Library", "/usr", "/bin", "/sbin", "/private/etc", "/etc", "/cores", "/boot", "/proc", "/sys", "/dev",
]
// U-2 (a): only `/Volumes` itself; a disk under it (`/Volumes/External/...`) is an ordinary place.
const POSIX_SYSTEM_EXACT = ["/Volumes"]
const POSIX_VAR = ["/private/var", "/var"]
const POSIX_TEMP = ["/private/var/folders", "/var/folders"]
const WIN_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$) *(\..*)?$/i
export const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const MAX_INPUT = 4096

export type Flavour = { path: typeof posix; win: boolean; fold: boolean }

export const flavourOf = (platform: NodeJS.Platform): Flavour => ({
  path: platform === "win32" ? win32 : posix,
  win: platform === "win32",
  // macOS and Windows folders compare case-insensitively (default APFS / NTFS), so `~/.SSH` is still `.ssh`.
  fold: platform === "win32" || platform === "darwin",
})

/** `child` is `root` or lies below it. */
export function inside(f: Flavour, child: string, root: string) {
  const c = f.fold ? child.toLowerCase() : child
  const r = f.fold ? root.toLowerCase() : root
  if (c === r) return true
  const rel = f.path.relative(r, c)
  return rel !== "" && !rel.startsWith("..") && !f.path.isAbsolute(rel)
}

export const insideAny = (f: Flavour, child: string, roots: readonly string[]) => roots.some((r) => inside(f, child, r))

/** The input rule shared by U-2 and U-8; the normalised path or null. Never touches the filesystem. */
export function acceptedInput(f: Flavour, input: unknown): string | null {
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_INPUT || CONTROL.test(input)) return null
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
    // autofs network mounts, any case (a case-sensitive Linux disk still must not reach a network share by `stat`)
    const n = normal.toLowerCase()
    if (n === "/net" || n.startsWith("/net/") || n === "/network" || n.startsWith("/network/")) return null
  }
  return normal
}

/** The path is a filesystem or drive root. */
export const isFilesystemRoot = (f: Flavour, normal: string) =>
  f.path.normalize(normal).replace(/[\\/]+$/, "") === f.path.parse(normal).root.replace(/[\\/]+$/, "")

/** U-2 (a) system places, as the path or as an ancestor of it (`/Volumes` only as the path itself). */
export function isSystemPlace(f: Flavour, normal: string): boolean {
  if (f.win) {
    const env = process.env
    const system = [env.WINDIR, env.SystemRoot, env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432, env.ProgramData]
      .filter((p): p is string => !!p)
      .concat(["C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)", "C:\\ProgramData"])
    if (insideAny(f, normal, system)) return true
    return /^[a-zA-Z]:\\program files/i.test(normal)
  }
  const trimmed = normal.replace(/\/+$/, "") || "/"
  if (POSIX_SYSTEM_EXACT.some((s) => (f.fold ? s.toLowerCase() === trimmed.toLowerCase() : s === trimmed))) return true
  if (insideAny(f, normal, POSIX_SYSTEM)) return true
  return insideAny(f, normal, POSIX_VAR) && !POSIX_TEMP.some((t) => inside(f, normal, t) && normal !== t)
}

/** The path is the home folder's ancestor (not home itself). */
export const isAboveHome = (f: Flavour, normal: string, home: string) =>
  inside(f, home, normal) && !inside(f, normal, home)

/** The home credential places as absolute folders. */
export const protectedHomeRoots = (f: Flavour, home: string) => PROTECTED_HOME_PLACES.map((place) => f.path.join(home, place))

/** Absolute, normalised roots only (callers pass env-derived lists). */
export const absoluteRoots = (f: Flavour, roots: readonly unknown[]) =>
  roots.filter((dir): dir is string => typeof dir === "string" && f.path.isAbsolute(dir)).map((dir) => f.path.normalize(dir))

/** Both spellings of a folder: as given (normalised) and resolved, when it resolves. */
export function bothForms(f: Flavour, dir: string, realpath: (p: string) => string): string[] {
  const normal = f.path.normalize(dir)
  try {
    const real = realpath(dir)
    return real === normal ? [normal] : [normal, real]
  } catch {
    return [normal]
  }
}
