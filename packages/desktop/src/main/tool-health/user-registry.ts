// N-118: the user registry ~/.config/swarm/tool-health.json and its merge with the shipped registry
// (spec 01c section 5, TH-01, decisions U7, C5, C7 = DP-2 field lock, U21, C8).
//
// - The whole file is refused (USER_REGISTRY_UNSAFE) when it is larger than 64 KiB, not owned by the current uid,
//   group- or world-writable, or a symlink that leaves ~/.config/swarm. Unparseable JSON: USER_REGISTRY_INVALID.
// - Each entry is validated alone; a bad entry is dropped with its reason and the others still load.
// - A shipped id may change ONLY `startup`, `consent`, `reviveTimeoutMs` and `probe.timeoutMs`. Every other field of a
//   shipped id is ignored with SHIPPED_FIELD_LOCKED, so a write to ~/.config cannot swap a trusted id's revive.
// - A new id is a user component (`source: "user"`) with its own argv revive (U21: no approval; it runs at startup).
//
// Reading only: this module never writes the file (agent writes in autonomous mode are refused by SEC-04 elsewhere).

import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs"
import { isAbsolute, join, relative, sep } from "node:path"
import { TOOL_HEALTH_SHIPPED_IDS, createToolHealthRegistry } from "./registry"
import { SETUP_COMPONENT_IDS } from "../setup-runner"
import {
  PROBE_TIMEOUT_MAX_MS,
  REVIVE_TIMEOUT_MAX_MS,
  TOOL_HEALTH_ID_PATTERN,
  TOOL_HEALTH_LABEL_MAX,
  type ResolvedToolHealthComponent,
  type ToolHealthComponent,
  type ToolHealthContext,
  type ToolHealthProbe,
  type ToolHealthReason,
  type ToolHealthRevive,
  type ToolHealthWatch,
} from "./types"

export const USER_REGISTRY_DIR = [".config", "swarm"] as const
export const USER_REGISTRY_FILE_NAME = "tool-health.json"
export const USER_REGISTRY_MAX_BYTES = 64 * 1024

/** Keys a user entry may carry (N-117). Anything else drops the entry (ENTRY_INVALID). */
const ENTRY_KEYS = new Set([
  "label",
  "probe",
  "revive",
  "startup",
  "consent",
  "requires",
  "installedWhen",
  "reviveTimeoutMs",
  "platforms",
  "watch",
])
/** C7 / DP-2: the only fields a user file may change on a shipped id (`probe` only for its `timeoutMs`). */
const SHIPPED_OVERRIDABLE = new Set(["startup", "consent", "reviveTimeoutMs"])
const PLATFORMS = new Set(["aix", "android", "darwin", "freebsd", "haiku", "linux", "openbsd", "sunos", "win32", "cygwin", "netbsd"])
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"])

export type UserRegistryIssue = {
  code: Extract<
    ToolHealthReason,
    "USER_REGISTRY_UNSAFE" | "USER_REGISTRY_INVALID" | "PROBE_URL_NOT_LOOPBACK" | "REVIVE_BUILTIN_IN_USER_FILE" | "SHIPPED_FIELD_LOCKED" | "ENTRY_INVALID"
  >
  /** Entry id, when the issue concerns one entry. */
  id?: string
  /** Field path for SHIPPED_FIELD_LOCKED (`revive`, `probe.url`, ...). */
  field?: string
  /** Short reason, no file contents beyond the id. */
  why: string
}

export type UserRegistryFile = {
  file: string
  /** absent: no file; loaded: parsed (some entries may still be dropped); refused: whole file ignored. */
  state: "absent" | "loaded" | "refused"
  /** Accepted user components (new ids), validated. */
  components: ToolHealthComponent[]
  /** Accepted overrides of shipped ids: only the C7 fields. */
  overrides: Record<string, ShippedOverride>
  issues: UserRegistryIssue[]
}

export type ShippedOverride = {
  startup?: "probe" | "off"
  consent?: "auto" | "manual"
  reviveTimeoutMs?: number
  probeTimeoutMs?: number
}

export type LoadUserRegistryOptions = {
  home: string
  /** Defaults to process.getuid(); injected by tests. */
  getuid?: () => number
}

export function userRegistryPath(home: string) {
  return join(home, ...USER_REGISTRY_DIR, USER_REGISTRY_FILE_NAME)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function inside(parent: string, child: string) {
  const rel = relative(parent, child)
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes(".."))
}

function currentUid(opts: LoadUserRegistryOptions): number | undefined {
  if (opts.getuid) return opts.getuid()
  return typeof process.getuid === "function" ? process.getuid() : undefined
}

/** Reads the file under the 5.1 safety rules. Returns its text, or a whole-file refusal. */
function readSafely(
  file: string,
  opts: LoadUserRegistryOptions,
): { kind: "absent" } | { kind: "text"; text: string } | { kind: "refused"; issue: UserRegistryIssue } {
  const unsafe = (why: string) => ({ kind: "refused" as const, issue: { code: "USER_REGISTRY_UNSAFE" as const, why } })
  let link
  try {
    link = lstatSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" }
    return unsafe("it cannot be read")
  }
  let target = file
  if (link.isSymbolicLink()) {
    try {
      target = realpathSync(file)
    } catch {
      return unsafe("it is a broken symlink")
    }
    let dir: string
    try {
      dir = realpathSync(join(opts.home, ...USER_REGISTRY_DIR))
    } catch {
      return unsafe("its folder cannot be resolved")
    }
    if (!inside(dir, target)) return unsafe("it is a symlink to a path outside ~/.config/swarm")
  }
  let fd: number
  try {
    fd = openSync(target, "r")
  } catch {
    return unsafe("it cannot be opened")
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) return unsafe("it is not a regular file")
    if (st.size > USER_REGISTRY_MAX_BYTES) return unsafe(`it is larger than ${USER_REGISTRY_MAX_BYTES} bytes`)
    const uid = currentUid(opts)
    if (uid !== undefined && st.uid !== uid) return unsafe("it is owned by another user")
    if ((st.mode & 0o022) !== 0) return unsafe("it is writable by group or others")
    const buf = Buffer.alloc(st.size)
    let off = 0
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off)
      if (n <= 0) break
      off += n
    }
    return { kind: "text", text: buf.subarray(0, off).toString("utf8") }
  } finally {
    closeSync(fd)
  }
}

class EntryError extends Error {
  constructor(
    readonly code: UserRegistryIssue["code"],
    readonly why: string,
  ) {
    super(why)
  }
}

const invalid = (why: string) => new EntryError("ENTRY_INVALID", why)

function timeout(value: unknown, max: number, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max)
    throw invalid(`${what} must be an integer between 1 and ${max}`)
  return value
}

function status(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 100 || value > 599)
    throw invalid("expectStatus must hold HTTP status codes (100-599)")
  return value
}

function absolutePath(value: unknown, what: string): string {
  if (typeof value !== "string" || !value || value.includes("\0") || !isAbsolute(value))
    throw invalid(`${what} must be an absolute path`)
  if (value.split(/[\\/]/).includes("..")) throw invalid(`${what} must not contain ".."`)
  return value
}

function onlyKeys(obj: Record<string, unknown>, keys: string[], what: string) {
  for (const key of Object.keys(obj)) if (!keys.includes(key)) throw invalid(`unknown key "${key}" in ${what}`)
}

/** A probe from the user file. `process` is internal to Swarm and refused here. */
export function validateUserProbe(value: unknown): ToolHealthProbe {
  if (!isPlainObject(value)) throw invalid("probe must be an object")
  const timeoutMs = value.timeoutMs === undefined ? undefined : timeout(value.timeoutMs, PROBE_TIMEOUT_MAX_MS, "probe.timeoutMs")
  const withTimeout = <T extends object>(probe: T) => (timeoutMs === undefined ? probe : { ...probe, timeoutMs })
  if (value.kind === "http") {
    onlyKeys(value, ["kind", "url", "expectStatus", "expectJson", "timeoutMs"], "probe")
    if (typeof value.url !== "string") throw invalid("probe.url must be a string")
    let url: URL
    try {
      url = new URL(value.url)
    } catch {
      throw invalid("probe.url is not a URL")
    }
    if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password)
      throw new EntryError("PROBE_URL_NOT_LOOPBACK", "probe.url must be http on 127.0.0.1, localhost or [::1]")
    const expectStatus = Array.isArray(value.expectStatus)
      ? value.expectStatus.map(status)
      : status(value.expectStatus)
    if (Array.isArray(expectStatus) && expectStatus.length === 0) throw invalid("expectStatus must not be empty")
    let expectJson: Record<string, string | number | boolean> | undefined
    if (value.expectJson !== undefined) {
      if (!isPlainObject(value.expectJson)) throw invalid("expectJson must be an object")
      expectJson = {}
      for (const [k, v] of Object.entries(value.expectJson)) {
        if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean")
          throw invalid("expectJson values must be strings, numbers or booleans")
        expectJson[k] = v
      }
    }
    return withTimeout({ kind: "http" as const, url: value.url, expectStatus, ...(expectJson ? { expectJson } : {}) })
  }
  if (value.kind === "http-unix") {
    onlyKeys(value, ["kind", "socketPath", "path", "expectStatus", "timeoutMs"], "probe")
    const socketPath = absolutePath(value.socketPath, "probe.socketPath")
    if (typeof value.path !== "string" || !value.path.startsWith("/")) throw invalid('probe.path must start with "/"')
    return withTimeout({ kind: "http-unix" as const, socketPath, path: value.path, expectStatus: status(value.expectStatus) })
  }
  if (value.kind === "file") {
    onlyKeys(value, ["kind", "path", "timeoutMs"], "probe")
    return withTimeout({ kind: "file" as const, path: absolutePath(value.path, "probe.path") })
  }
  throw invalid('probe.kind must be "http", "http-unix" or "file"')
}

/**
 * argv[0] must be absolute (nothing is expanded or templated, 01c 3.3). When it exists it must be a regular file that
 * is not group- or world-writable; a missing program is kept here and fails at revive time (REVIVE_EXIT), so an entry
 * whose install is gone still reaches `installedWhen` and is reported `skipped_not_installed`.
 */
export function validateArgv(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) throw invalid(`${what} must be a non-empty array`)
  const argv = value.map((part) => {
    if (typeof part !== "string" || part.includes("\0") || part.length > 4096) throw invalid(`${what} holds a bad argument`)
    return part
  })
  const program = absolutePath(argv[0], `${what}[0]`)
  let st
  try {
    st = statSync(program)
  } catch {
    return argv
  }
  if (!st.isFile()) throw invalid(`${what}[0] is not a regular file`)
  if ((st.mode & 0o022) !== 0) throw invalid(`${what}[0] is writable by group or others`)
  return argv
}

function validateRevive(value: unknown): ToolHealthRevive {
  if (!isPlainObject(value)) throw invalid("revive must be an object")
  if ("builtin" in value)
    throw new EntryError("REVIVE_BUILTIN_IN_USER_FILE", "builtin revives belong to shipped components only")
  onlyKeys(value, ["argv", "fallbackArgv"], "revive")
  const argv = validateArgv(value.argv, "revive.argv")
  if (value.fallbackArgv === undefined) return { argv }
  return { argv, fallbackArgv: validateArgv(value.fallbackArgv, "revive.fallbackArgv") }
}

function validateWatch(value: unknown): ToolHealthWatch[] {
  if (!Array.isArray(value) || value.length > 16) throw invalid("watch must be an array (at most 16)")
  return value.map((item) => {
    if (!isPlainObject(item)) throw invalid("watch entries must be objects")
    onlyKeys(item, ["path", "sha256"], "watch")
    if (typeof item.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(item.sha256)) throw invalid("watch.sha256 must be 64 hex")
    return { path: absolutePath(item.path, "watch.path"), sha256: item.sha256 }
  })
}

/** One new-id entry from the user file. `requires` is resolved later against the whole set. */
export function validateUserEntry(id: string, value: unknown): ToolHealthComponent {
  if (!TOOL_HEALTH_ID_PATTERN.test(id)) throw invalid("bad id (lowercase letters, digits and -, 2-40 chars)")
  if (!isPlainObject(value)) throw invalid("entry must be an object")
  for (const key of Object.keys(value)) if (!ENTRY_KEYS.has(key)) throw invalid(`unknown key "${key}"`)
  if (typeof value.label !== "string" || !value.label.trim() || value.label.length > TOOL_HEALTH_LABEL_MAX)
    throw invalid(`label must be a non-empty string of at most ${TOOL_HEALTH_LABEL_MAX} chars`)
  const component: ToolHealthComponent = {
    id,
    label: value.label,
    probe: validateUserProbe(value.probe),
    startup: "probe",
    consent: "auto",
  }
  if (value.revive !== undefined) component.revive = validateRevive(value.revive)
  if (value.startup !== undefined) {
    if (value.startup !== "probe" && value.startup !== "off") throw invalid('startup must be "probe" or "off"')
    component.startup = value.startup
  }
  if (value.consent !== undefined) {
    if (value.consent !== "auto" && value.consent !== "manual") throw invalid('consent must be "auto" or "manual"')
    component.consent = value.consent
  }
  if (value.requires !== undefined) {
    if (!Array.isArray(value.requires) || value.requires.some((r) => typeof r !== "string"))
      throw invalid("requires must be an array of ids")
    component.requires = [...new Set(value.requires as string[])]
  }
  if (value.installedWhen !== undefined) {
    const when = value.installedWhen
    if (!isPlainObject(when)) throw invalid("installedWhen must be an object")
    if ("setupComponent" in when) {
      onlyKeys(when, ["setupComponent"], "installedWhen")
      if (typeof when.setupComponent !== "string" || !(SETUP_COMPONENT_IDS as readonly string[]).includes(when.setupComponent))
        throw invalid("installedWhen.setupComponent must be a swarm-setup component id")
      component.installedWhen = { setupComponent: when.setupComponent }
    } else {
      onlyKeys(when, ["path"], "installedWhen")
      component.installedWhen = { path: absolutePath(when.path, "installedWhen.path") }
    }
  }
  if (value.reviveTimeoutMs !== undefined)
    component.reviveTimeoutMs = timeout(value.reviveTimeoutMs, REVIVE_TIMEOUT_MAX_MS, "reviveTimeoutMs")
  if (value.platforms !== undefined) {
    if (!Array.isArray(value.platforms) || value.platforms.some((p) => typeof p !== "string" || !PLATFORMS.has(p)))
      throw invalid("platforms must list Node platform names")
    component.platforms = [...(value.platforms as string[])]
  }
  if (value.watch !== undefined) component.watch = validateWatch(value.watch)
  return component
}

/** C7 / DP-2: keep only the four overridable fields of a shipped id; report every other field as locked. */
export function validateShippedOverride(value: unknown): { override: ShippedOverride; locked: string[] } {
  if (!isPlainObject(value)) throw invalid("entry must be an object")
  for (const key of Object.keys(value)) if (!ENTRY_KEYS.has(key)) throw invalid(`unknown key "${key}"`)
  const override: ShippedOverride = {}
  const locked: string[] = []
  for (const [key, field] of Object.entries(value)) {
    if (key === "probe") {
      if (!isPlainObject(field)) throw invalid("probe must be an object")
      for (const probeKey of Object.keys(field)) {
        if (probeKey === "timeoutMs") override.probeTimeoutMs = timeout(field.timeoutMs, PROBE_TIMEOUT_MAX_MS, "probe.timeoutMs")
        else locked.push(`probe.${probeKey}`)
      }
      continue
    }
    if (!SHIPPED_OVERRIDABLE.has(key)) {
      locked.push(key)
      continue
    }
    if (key === "startup") {
      if (field !== "probe" && field !== "off") throw invalid('startup must be "probe" or "off"')
      override.startup = field
    } else if (key === "consent") {
      if (field !== "auto" && field !== "manual") throw invalid('consent must be "auto" or "manual"')
      override.consent = field
    } else if (key === "reviveTimeoutMs") {
      override.reviveTimeoutMs = timeout(field, REVIVE_TIMEOUT_MAX_MS, "reviveTimeoutMs")
    }
  }
  return { override, locked }
}

/** Drops user entries whose `requires` names an unknown id or sits on a cycle; repeats until stable. */
function resolveRequires(
  entries: Map<string, ToolHealthComponent>,
  shipped: ReadonlySet<string>,
  issues: UserRegistryIssue[],
) {
  let changed = true
  while (changed) {
    changed = false
    for (const [id, entry] of entries) {
      const unknown = (entry.requires ?? []).find((r) => r === id || (!shipped.has(r) && !entries.has(r)))
      if (unknown === undefined) continue
      entries.delete(id)
      issues.push({
        code: "ENTRY_INVALID",
        id,
        why: unknown === id ? "requires names itself" : `requires names unknown id "${unknown}"`,
      })
      changed = true
    }
  }
  // Cycles among user entries (shipped components never require user ones).
  const state = new Map<string, "visiting" | "done">()
  const onCycle = new Set<string>()
  const visit = (id: string, stack: string[]) => {
    if (state.get(id) === "done") return
    if (state.get(id) === "visiting") {
      for (const member of stack.slice(stack.indexOf(id))) onCycle.add(member)
      return
    }
    state.set(id, "visiting")
    for (const dep of entries.get(id)?.requires ?? []) if (entries.has(dep)) visit(dep, [...stack, dep])
    state.set(id, "done")
  }
  for (const id of entries.keys()) visit(id, [id])
  for (const id of onCycle) {
    entries.delete(id)
    issues.push({ code: "ENTRY_INVALID", id, why: "requires forms a cycle" })
  }
  // An entry that required a cycle member now names an unknown id.
  if (onCycle.size) resolveRequires(entries, shipped, issues)
}

/** Reads and validates ~/.config/swarm/tool-health.json. Never throws; never writes. */
export function loadUserRegistry(opts: LoadUserRegistryOptions): UserRegistryFile {
  const file = userRegistryPath(opts.home)
  const result: UserRegistryFile = { file, state: "absent", components: [], overrides: {}, issues: [] }
  const read = readSafely(file, opts)
  if (read.kind === "absent") return result
  if (read.kind === "refused") return { ...result, state: "refused", issues: [read.issue] }
  let parsed: unknown
  try {
    parsed = JSON.parse(read.text)
  } catch (error) {
    const where = error instanceof SyntaxError ? error.message.slice(0, 120) : "parse error"
    return { ...result, state: "refused", issues: [{ code: "USER_REGISTRY_INVALID", why: where }] }
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.components))
    return { ...result, state: "refused", issues: [{ code: "USER_REGISTRY_INVALID", why: 'top level must be { "components": { ... } }' }] }

  const shipped = new Set<string>(TOOL_HEALTH_SHIPPED_IDS)
  const entries = new Map<string, ToolHealthComponent>()
  for (const [id, value] of Object.entries(parsed.components)) {
    try {
      if (shipped.has(id)) {
        const { override, locked } = validateShippedOverride(value)
        for (const field of locked)
          result.issues.push({ code: "SHIPPED_FIELD_LOCKED", id, field, why: `${field} of a shipped component cannot be changed` })
        if (Object.keys(override).length) result.overrides[id] = override
      } else {
        entries.set(id, validateUserEntry(id, value))
      }
    } catch (error) {
      if (error instanceof EntryError) result.issues.push({ code: error.code, id, why: error.why })
      else result.issues.push({ code: "ENTRY_INVALID", id, why: "entry could not be read" })
    }
  }
  resolveRequires(entries, shipped, result.issues)
  result.components = [...entries.values()]
  result.state = "loaded"
  return result
}

/** Shipped registry with the user's C7 overrides applied, followed by the user's own components. */
export function mergeToolHealthRegistry(
  shipped: ToolHealthComponent[],
  user: Pick<UserRegistryFile, "components" | "overrides">,
): ResolvedToolHealthComponent[] {
  const merged: ResolvedToolHealthComponent[] = shipped.map((base) => {
    const o = user.overrides[base.id]
    const component: ResolvedToolHealthComponent = { ...structuredClone(base), source: "shipped" }
    if (!o) return component
    if (o.startup) component.startup = o.startup
    if (o.consent) component.consent = o.consent
    if (o.reviveTimeoutMs !== undefined) component.reviveTimeoutMs = o.reviveTimeoutMs
    if (o.probeTimeoutMs !== undefined) component.probe = { ...component.probe, timeoutMs: o.probeTimeoutMs }
    return component
  })
  const taken = new Set(merged.map((c) => c.id))
  for (const c of user.components) if (!taken.has(c.id)) merged.push({ ...structuredClone(c), source: "user" })
  return merged
}

/** One pass's registry: shipped + user file. Issues go to the caller's log (01c section 9 messages). */
export function resolveToolHealthRegistry(
  ctx: ToolHealthContext,
  opts: { getuid?: () => number } = {},
): { components: ResolvedToolHealthComponent[]; user: UserRegistryFile } {
  const user = loadUserRegistry({ home: ctx.home, getuid: opts.getuid })
  return { components: mergeToolHealthRegistry(createToolHealthRegistry(ctx), user), user }
}

/** 01c section 9 log text for a user-registry issue. */
export function userRegistryIssueMessage(issue: UserRegistryIssue): string {
  if (issue.code === "USER_REGISTRY_UNSAFE")
    return `~/.config/swarm/tool-health.json was ignored: ${issue.why} (must be your own file, not writable by others, at most 64 KiB).`
  if (issue.code === "USER_REGISTRY_INVALID") return `~/.config/swarm/tool-health.json was ignored: it is not valid JSON (${issue.why}).`
  return `tool-health.json entry "${issue.id ?? "?"}" ignored: ${issue.code}: ${issue.why}.`
}
