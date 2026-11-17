/**
 * Swarm 1.3.3 row 147 (senior review S9, security review M1): the ONE deliverable path rule.
 *
 * Before this module the rule lived in three places with three strictnesses (the copier `mcp-host/verify/project-copy.ts`,
 * the gate `deliverable-gate.ts`, the panel `mcp-host/mission/deliverables.ts`); the gate passed a hand-made symbolic
 * link at `deliverables/` or `deliverables/<mission>/`. The store may not import mcp-host, so the rule sits here and
 * mcp-host imports it.
 *
 * - Folder: `<project>/deliverables/<mission id>/` (register section 5).
 * - File name: `<doc number with / as -> Rev<letter> rev<N>.<ext>` (register section 5). The copier also checks the name
 *   against the vendored DATUM name rule and refuses a document number for which the two would differ.
 * - Row `deliverables` JSON: one parser.
 * - Containment: a stored path is `deliverables/<mission id>/<name...>` of plain segments, and every segment below the
 *   project folder is looked at with lstat: a symbolic link at any of them, or a parent that is not a folder, is refused.
 *   The project folder itself may be reached through a link (row 68 resolves it).
 * - M1: a mission's project folder is the calling session's folder or a folder inside it, judged on real paths (the
 *   deepest existing ancestor is resolved, so a link inside the session folder pointing out is outside).
 *
 * Reads only; synchronous; never throws for a file problem.
 */
import { lstatSync, realpathSync, type Stats } from "node:fs"
import path from "node:path"
import type { RowDeliverable } from "./types.ts"

/** Register section 5: one folder per project for all missions. */
export const PROJECT_DELIVERABLES_DIR = "deliverables"

/** Register section 5: `<doc number> Rev<letter> rev<N>.<ext>` from stored document metadata (`/` in the number -> `-`). */
export function deliverableFileName(docNumber: string, docRev: string, revisionNo: number, format: string): string {
  return `${docNumber.trim().replace(/\//g, "-")} Rev${docRev} rev${revisionNo}.${format.toLowerCase()}`
}

/** The project-relative path a copy is stored under: `deliverables/<mission id>/<name>`. */
export function deliverableRelPath(mission: string, name: string): string {
  return `${PROJECT_DELIVERABLES_DIR}/${mission}/${name}`
}

/** A row's stored `deliverables` JSON as items (anything unreadable, or an item without a path, is left out). */
export function parseRowDeliverables(raw: string | null | undefined): RowDeliverable[] {
  if (typeof raw !== "string") return []
  try {
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is RowDeliverable => !!x && typeof x === "object" && typeof (x as RowDeliverable).path === "string") : []
  } catch {
    return []
  }
}

/**
 * Where a stored deliverable path is on disk.
 * - `ok: true, present: true`: a regular file, reached through real folders only.
 * - `ok: true, present: false`: inside the folder but not there (or a segment could not be read).
 * - `ok: false`: `outside` (not a plain `deliverables/<mission>/...` path), `link` (a symbolic link at `at`, a
 *   project-relative path) or `not-file` (a parent that is not a folder, or a final entry that is not a regular file;
 *   still inside the folder, so `abs` is given).
 */
export type DeliverablePath = { ok: true; abs: string; present: boolean } | { ok: false; reason: "outside" | "link"; at?: string } | { ok: false; reason: "not-file"; at: string; abs: string }

export function deliverablePath(projectDir: string, mission: string, rel: string): DeliverablePath {
  const parts = rel.split("/")
  if (!path.isAbsolute(projectDir) || rel.includes("\\") || rel.includes("\u0000") || parts.length < 3) return { ok: false, reason: "outside" }
  if (parts[0] !== PROJECT_DELIVERABLES_DIR || parts[1] !== mission || parts.some((p) => p === "" || p === "." || p === "..")) return { ok: false, reason: "outside" }
  const abs = path.join(projectDir, ...parts)
  for (const i of parts.keys()) {
    const st = lstatOf(path.join(projectDir, ...parts.slice(0, i + 1)))
    if (st === "error" || st === undefined) return { ok: true, abs, present: false }
    const at = parts.slice(0, i + 1).join("/")
    if (st.isSymbolicLink()) return { ok: false, reason: "link", at }
    if (i < parts.length - 1 ? !st.isDirectory() : !st.isFile()) return { ok: false, reason: "not-file", at, abs }
  }
  return { ok: true, abs, present: true }
}

/**
 * M1: null when `projectDir` is `root` or a folder inside it, on real paths; otherwise why not. A folder that does not
 * exist yet is judged by its deepest existing ancestor (resolved), so a link that leaves `root` is caught before the
 * folder is made. Both must be absolute disk paths.
 */
export function projectDirOutsideRoot(projectDir: string, root: string): string | null {
  if (typeof root !== "string" || !path.isAbsolute(root)) return "the calling session has no folder to hold a project folder"
  if (typeof projectDir !== "string" || !path.isAbsolute(projectDir) || projectDir.includes("\u0000")) return "the project folder is not an absolute path"
  const realRoot = realOf(path.resolve(root))
  const realProject = realOf(path.resolve(projectDir))
  if (realProject === realRoot || realProject.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep)) return null
  return `${projectDir} is not the session folder ${root} or a folder inside it`
}

/** The real path of `p`: its deepest existing ancestor resolved, the rest appended as written. */
function realOf(p: string): string {
  const rest: string[] = []
  for (let cur = p; ; cur = path.dirname(cur)) {
    try {
      return path.join(realpathSync(cur), ...rest.reverse())
    } catch {
      if (path.dirname(cur) === cur) return p
      rest.push(path.basename(cur))
    }
  }
}

function lstatOf(p: string): Stats | undefined | "error" {
  try {
    return lstatSync(p, { throwIfNoEntry: false })
  } catch {
    return "error"
  }
}
