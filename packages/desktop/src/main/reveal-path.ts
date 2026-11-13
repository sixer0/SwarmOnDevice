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
import type { Shell } from "electron"
import {
  absoluteRoots,
  acceptedInput,
  bothForms,
  CONTROL,
  flavourOf,
  inside,
  isAboveHome,
  isFilesystemRoot,
  isSystemPlace,
  PROTECTED_HOME_PLACES,
  protectedHomeRoots,
  type Flavour,
} from "./path-policy"

/** N7-148: the home credential places; since row 47c (M1-10) the one list in path-policy.ts, re-exported here. */
export const REVEAL_EXCLUDED_HOME_PLACES: readonly string[] = PROTECTED_HOME_PLACES

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

/** U-2 rule set for a root (a): refused when a filesystem/drive root, a system folder (or inside one), or above home. */
function acceptedRoot(f: Flavour, root: string, home: string): boolean {
  const normal = acceptedInput(f, root)
  if (!normal) return false
  if (isFilesystemRoot(f, normal)) return false
  if (isAboveHome(f, normal, home)) return false
  return !isSystemPlace(f, normal)
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
  const excluded = absoluteRoots(f, [...(deps.excluded ?? []), ...protectedHomeRoots(f, home)]).flatMap((dir) =>
    bothForms(f, dir, realpath),
  )
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
