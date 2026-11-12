// TH-02 / SEC-05 (1.2.6 row 91): the re-check request file ~/.swarm/health/recheck.json (N-152).
//
// The file is the agent's (or a person's) way to ask desktop main for a pass. It is read only when it is a regular file
// (lstat, never followed), at most 4 KiB, owned by the current user, a JSON object whose `ids` (optional) are known and
// well-formed ids. Anything else is ignored with ENTRY_INVALID. Read or not, the file is removed, so one write is one
// request. A request from this file is an AGENT trigger: it probes any named id but revives only `consent: "auto"`
// components (the regime keeps `manual` ones `dead` `CONSENT_MANUAL`; only the "Re-check Tools" menu item, a person
// trigger, revives them).

import { closeSync, fstatSync, lstatSync, openSync, readFileSync, rmSync, watch, type FSWatcher } from "node:fs"
import { constants } from "node:fs"
import { toolHealthDir, toolHealthRecheckPath, TOOL_HEALTH_RECHECK_FILE } from "./state"
import { TOOL_HEALTH_ID_PATTERN } from "./types"

export const RECHECK_MAX_BYTES = 4096
export const RECHECK_MAX_IDS = 64

export type RecheckRequest = { ids?: string[] }

export type RecheckRead =
  | { kind: "absent" }
  | { kind: "request"; request: RecheckRequest }
  | { kind: "invalid"; reason: "ENTRY_INVALID"; why: string }

/**
 * Reads and removes recheck.json. `knownIds` = the ids of the registry the pass would run on. Never throws; never
 * follows a symlink (the link itself is removed).
 */
export function takeRecheckRequest(home: string, knownIds: ReadonlySet<string>, opts: { getuid?: () => number | undefined } = {}): RecheckRead {
  const file = toolHealthRecheckPath(home)
  let lst
  try {
    lst = lstatSync(file)
  } catch {
    return { kind: "absent" }
  }
  const invalid = (why: string): RecheckRead => {
    rmSync(file, { force: true })
    return { kind: "invalid", reason: "ENTRY_INVALID", why }
  }
  if (!lst.isFile()) return invalid(lst.isSymbolicLink() ? "recheck.json is a symbolic link" : "recheck.json is not a regular file")
  if (lst.size > RECHECK_MAX_BYTES) return invalid(`recheck.json is larger than ${RECHECK_MAX_BYTES} bytes`)
  const uid = (opts.getuid ?? (() => (typeof process.getuid === "function" ? process.getuid() : undefined)))()
  if (uid !== undefined && lst.uid !== uid) return invalid("recheck.json is not owned by the current user")
  let text: string
  try {
    // O_NOFOLLOW: a swap to a symlink between lstat and open is refused too.
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const st = fstatSync(fd)
      if (!st.isFile() || st.size > RECHECK_MAX_BYTES || (uid !== undefined && st.uid !== uid))
        return invalid("recheck.json changed while it was read")
      text = readFileSync(fd, "utf8")
    } finally {
      closeSync(fd)
    }
  } catch {
    return invalid("recheck.json could not be read")
  }
  rmSync(file, { force: true })
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: "invalid", reason: "ENTRY_INVALID", why: "recheck.json is not valid JSON" }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return { kind: "invalid", reason: "ENTRY_INVALID", why: "recheck.json must be a JSON object" }
  const p = parsed as Record<string, unknown>
  for (const key of Object.keys(p))
    if (key !== "ids" && key !== "requestedAt") return { kind: "invalid", reason: "ENTRY_INVALID", why: `unknown key "${key.slice(0, 40)}"` }
  if (p.ids === undefined) return { kind: "request", request: {} }
  if (!Array.isArray(p.ids) || p.ids.length === 0 || p.ids.length > RECHECK_MAX_IDS)
    return { kind: "invalid", reason: "ENTRY_INVALID", why: `ids must be a non-empty array of at most ${RECHECK_MAX_IDS}` }
  const ids: string[] = []
  for (const id of p.ids) {
    if (typeof id !== "string" || !TOOL_HEALTH_ID_PATTERN.test(id))
      return { kind: "invalid", reason: "ENTRY_INVALID", why: "ids holds a malformed id" }
    if (!knownIds.has(id)) return { kind: "invalid", reason: "ENTRY_INVALID", why: `unknown id "${id}"` }
    if (!ids.includes(id)) ids.push(id)
  }
  return { kind: "request", request: { ids } }
}

export type RecheckWatcher = { close(): void }
export type WatchFn = (dir: string, listener: (event: string, filename: string | null) => void) => Pick<FSWatcher, "close" | "on">

/** Watches ~/.swarm/health for recheck.json. Our own state.json writes are filtered out by name. */
export function watchRecheck(home: string, onRequest: () => void, opts: { watch?: WatchFn; onError?: (error: unknown) => void } = {}): RecheckWatcher {
  const doWatch: WatchFn = opts.watch ?? ((dir, listener) => watch(dir, { persistent: false }, listener))
  const watcher = doWatch(toolHealthDir(home), (_event, filename) => {
    if (filename !== null && filename !== TOOL_HEALTH_RECHECK_FILE) return
    onRequest()
  })
  watcher.on("error", (error) => opts.onError?.(error))
  return { close: () => watcher.close() }
}
