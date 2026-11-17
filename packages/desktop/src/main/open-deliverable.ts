// Swarm 1.3.3 row 72 (MC-8 item 5, owner decision U16): the rule behind the `open-deliverable` IPC channel, the
// "Open" action of a Mission Control deliverable (the system's default app). ipc.ts registers the channel with the
// real `shell`; this file imports only electron types, so bun tests it with spies (the reveal-path.ts pattern).
//
// The generic `open-path` channel checks nothing and stays as it is for "Open in <app>" on a project folder; a
// deliverable never goes through it.
//
// Rule:
//   input    as `reveal-path` (N7-026): string, absolute, no NUL/control character, no `..` segment, no UNC/device
//   roots    only the folders this window listed in Mission Control (a mission's project folder is the folder it is
//            listed from); NOT the home folder. A root that is a filesystem root, a system folder or above home is
//            refused, and Swarm's own folders and the home credential places are excluded (reveal-path.ts).
//   shape    the REALPATH is exactly `<root>/deliverables/<mission>/<name>`: two plain segments, none hidden; the
//            name ends in a document type (OPEN_DELIVERABLE_EXTENSIONS). A symlink that leaves that folder, a deeper
//            path, a script or an app bundle is refused.
//   file     a regular file (a folder named `x.pdf` is refused)
//   action   shell.openPath(<checked realpath>): the path is one argument, never a shell string; no fallback.

import { realpathSync, statSync } from "node:fs"
import type { Shell } from "electron"
import { flavourOf } from "./path-policy"
import { isRevealablePath, type RevealPathDeps } from "./reveal-path"

/** Register section 5: `<project>/deliverables/<mission id>/`. */
export const PROJECT_DELIVERABLES_DIR = "deliverables"

/** Document types only (the app's FOLDER_OPEN list, mission-deliverables-model.ts): nothing that runs. */
export const OPEN_DELIVERABLE_EXTENSIONS: readonly string[] = ["pdf", "html", "docx", "xlsx", "pptx", "md", "txt"]

export type OpenDeliverableDeps = RevealPathDeps & {
  /** Default: fs.statSync(path).isFile(); false when it throws. */
  isFile?: (path: string) => boolean
}

function regularFile(path: string) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** The checked realpath to open, or null. */
export function checkedDeliverablePath(input: unknown, roots: readonly string[], deps: OpenDeliverableDeps = {}): string | null {
  const f = flavourOf(deps.platform ?? process.platform)
  const realpath = deps.realpath ?? realpathSync.native
  const fold = (value: string) => (f.fold ? value.toLowerCase() : value)
  let real: string
  try {
    if (typeof input !== "string") return null
    real = realpath(input)
  } catch {
    return null
  }
  for (const root of roots) {
    if (typeof root !== "string") continue
    // Input rule, root rule, excluded places, normalised path and realpath both inside this root.
    if (!isRevealablePath(input, [root], deps)) continue
    let realRoot: string
    try {
      realRoot = realpath(root)
    } catch {
      continue
    }
    const parts = f.path.relative(fold(realRoot), fold(real)).split(f.path.sep)
    if (parts.length !== 3 || parts[0] !== PROJECT_DELIVERABLES_DIR) continue
    if (parts.some((part) => part === "" || part === "." || part === ".." || part.startsWith("."))) continue
    const dot = parts[2].lastIndexOf(".")
    if (dot <= 0 || !OPEN_DELIVERABLE_EXTENSIONS.includes(parts[2].slice(dot + 1))) continue
    if (!(deps.isFile ?? regularFile)(real)) continue
    return real
  }
  return null
}

/**
 * The `open-deliverable` handler body: `false` unless the path passes the rule, then `shell.openPath(<realpath>)`.
 * The log never carries the path, its name or a hash (as reveal-path, AC-R18f).
 */
export async function openDeliverable(
  path: unknown,
  roots: readonly string[],
  deps: OpenDeliverableDeps & { shell: Pick<Shell, "openPath"> },
): Promise<boolean> {
  const real = checkedDeliverablePath(path, roots, deps)
  if (real === null) {
    deps.log?.("warn", "open-deliverable refused a path that is not a mission deliverable of this window", {
      source: "open-deliverable",
      roots: roots.length,
    })
    return false
  }
  const scrub = (text: string) =>
    [real, ...(typeof path === "string" && path.length > 0 ? [path] : [])]
      .sort((a, b) => b.length - a.length)
      .reduce((out, spelling) => out.split(spelling).join("<path>"), text)
  try {
    // Electron resolves with "" on success, else with the reason.
    const failure = await deps.shell.openPath(real)
    if (failure) {
      deps.log?.("error", "open-deliverable openPath failed", { source: "open-deliverable", message: scrub(failure) })
      return false
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    deps.log?.("error", "open-deliverable openPath failed", {
      source: "open-deliverable",
      message: scrub(err.message),
      stack_trace: err.stack === undefined ? undefined : scrub(err.stack),
    })
    return false
  }
  deps.log?.("info", "opened a deliverable in the default app", { source: "open-deliverable" })
  return true
}
