/**
 * Patch 1.3.3 row 100 (KL-2, owner decisions U19 and Q3): the host tool `studio_library_read` (register section 8).
 *
 * The Studio server cannot see an agent's own file reads, only calls of its tools (research/02, KL-2). This tool serves
 * one text file of the technical knowledge library and, when the call names a mission and a row, records the read on
 * that row through the store setter `markKnowledgeConsulted` (row 5). The done gate (row 102) reads the row's
 * `knowledge.domains[].consulted`.
 *
 * Root: `STUDIO_LIBRARY_ROOT` (read in start.ts only, C7 item 6; resolved there once by `libraryRootOf`, row 151) = the
 * bundled library folder. `path` is relative to the
 * indexed text layer `LIBRARY_INDEX_BASE` inside it (the paths of `indeks_pemicu.json` `read_order`), else to the
 * library folder itself (top-level guides). No root, or a root that is not a folder: the reply says "not available".
 *
 * Path rules: 1-512 characters; relative; `/` separators only; no NUL or control character, no backslash, no empty,
 * `.`, `..` or hidden (`.x`) segment, no drive letter, no `skill:` path. The resolved real path (symlinks followed)
 * must lie inside the real library root; a link that leaves it is refused PATH_OUTSIDE_ROOTS. Only regular files with
 * a text extension whose bytes are UTF-8 without NUL are served.
 *
 * Size: files up to LIBRARY_FILE_MAX_BYTES (4 MiB) are served, larger ones are refused PAYLOAD_TOO_LARGE with the
 * size. A reply carries at most LIBRARY_PAGE_BYTES (64 KiB); a longer file comes in pages cut at a line end (else a
 * character boundary), and `cursor` (the byte offset of the next page) continues it.
 *
 * Recording: mission and row go together. A read is stored only while the row is `running` and the file belongs to a
 * domain on the row (the store decides; this tool passes the domain the trigger index or the folder gives). A read that
 * cannot be stored is still served, and the reply says `not recorded (<reason>)`. The host does not know which row a
 * session is working on (it has no session binding), so nothing is recorded without both arguments.
 *
 * Built-in skills (C33, KL-4): `skill:<name>/<path>` is served from the on-disk root of a bundled skill, only for names
 * on BUILTIN_SKILL_ROOT_NAMES whose root the host was given (`STUDIO_SKILL_ROOTS`, read in start.ts), with the same
 * rules relative to that root. Such a read is recorded exactly like a library file (path stored verbatim). Images
 * (LIBRARY_IMAGE_EXT, e.g. the reference page JPGs) are not served as text: the reply gives the absolute path and the
 * size so the agent opens it with its own image reader; the read is recorded.
 *
 * Read only towards the library: the tool opens files for reading and never writes, moves or creates anything there.
 * Refusals follow `studio_witness_list` / `studio_asset_put`: `{ok:false, tool, code, error:{code, message, details,
 * correlationId}}`, `isError`, existing codes only (INVALID_ARGUMENT, PATH_INVALID, PATH_OUTSIDE_ROOTS,
 * FILE_UNREADABLE, PAYLOAD_TOO_LARGE, INTERNAL_ERROR). Every refusal and failure is one log line without file contents.
 */
import { Buffer, isUtf8 } from "node:buffer"
import { randomUUID } from "node:crypto"
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs"
import path from "node:path"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { appendJsonlDaily } from "../../vendor/src/lib/studio/http/jsonl"
import type { StoreTx } from "../store/index.ts"
import type { KnowledgeMark } from "../store/mission/index.ts"
import { sessionLogRef, type HostToolExtension, type HostToolSession } from "./tool-table.ts"
// 1.3.3 row 151 (S8): the one trigger-index loader and the one library-root resolution live in the matcher's module.
import { LIBRARY_INDEX_BASE, libraryRootOf, readTriggerIndexDoc, resolveTriggerIndexPath } from "./mission/knowledge-match.ts"

export { LIBRARY_INDEX_BASE, libraryRootOf }

type Rec = Record<string, unknown>
export type LibraryReadLog = (level: "info" | "warn" | "error", source: string, message: string, context?: Rec) => void

export const LIBRARY_READ_TOOL = "studio_library_read"
/**
 * Row 151 (S2): the name the agent calls the tool by. Swarm lists Studio host tools as `datum-studio_<tool>`
 * (opencode/src/mcp/datum-studio.ts); replies that steer a read print this name so that the call, made as written,
 * is the recorded one.
 */
export const LIBRARY_READ_CALL_NAME = `datum-studio_${LIBRARY_READ_TOOL}`
/** Bytes of file text in one reply. */
export const LIBRARY_PAGE_BYTES = 65_536
/** Larger files are refused (the bundled edition's largest text file is under 64 KiB, MANIFEST.csv aside). */
export const LIBRARY_FILE_MAX_BYTES = 4_194_304
export const LIBRARY_TEXT_EXT: ReadonlySet<string> = new Set([".md", ".markdown", ".txt", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml"])
/** Served as path and size, never as text. */
export const LIBRARY_IMAGE_EXT: ReadonlySet<string> = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"])
/** C33: the bundled on-disk skills whose files count as library reads (`skill:<name>/<path>`). */
export const BUILTIN_SKILL_ROOT_NAMES: readonly string[] = ["gsp-diagram-standard"]
const SKILL_PATH_RE = /^skill:([a-z0-9][a-z0-9-]{0,63})\/(.+)$/s
const SOURCE = "datum-studio-host.library-read"
const PATH_MAX = 512
const ID_MAX = 128
const KEYS: ReadonlySet<string> = new Set(["path", "mission", "row", "cursor"])
const DOMAIN_RE = /^[A-Z0-9][A-Z0-9-]{0,63}$/

export const LIBRARY_READ_DESCRIPTION =
  "Read a technical knowledge library file (path as in the trigger index). mission + row of a running row record the read."

const INPUT_SCHEMA: Rec = {
  type: "object",
  properties: {
    // limits are checked in validate(): the host tools/list has a byte pin (rel129-a13), so the schema stays bare
    path: { type: "string" },
    mission: { type: "string" },
    row: { type: "string" },
    cursor: { type: "integer" },
  },
  required: ["path"],
  additionalProperties: false,
}

/** The store calls the tool needs (SqliteStudioStore). */
export interface LibraryReadStore {
  readonly missions: { markKnowledgeConsulted(tx: StoreTx, mission: string, rowId: string, value: { path: string; domain?: string }): KnowledgeMark }
  transaction<T>(fn: (tx: StoreTx) => Promise<T>, opts?: { correlationId?: string }): Promise<T>
}

class LibraryReadRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Rec = {},
  ) {
    super(message)
  }
}

const bad = (code: string, message: string, details: Rec = {}) => new LibraryReadRefusal(code, message, details)

function refused(cid: string, code: string, message: string, details: Rec): CallToolResult {
  return {
    content: [{ type: "text", text: `galat ${code}: ${message}\ncorrelationId: ${cid}` }],
    structuredContent: { ok: false, tool: LIBRARY_READ_TOOL, code, error: { code, message, details, correlationId: cid }, correlationId: cid },
    isError: true,
  }
}

interface Args {
  path: string
  mission?: string
  row?: string
  cursor: number
}

function idArg(raw: unknown, field: string): string | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== "string" || raw === "" || raw.length > ID_MAX || /[\u0000-\u001f]/.test(raw)) throw bad("INVALID_ARGUMENT", `${field} must be a non-empty one-line string of at most ${ID_MAX} characters`, { field })
  return raw
}

function validate(raw: Rec): Args {
  const extra = Object.keys(raw).filter((k) => !KEYS.has(k))
  if (extra.length > 0) throw bad("INVALID_ARGUMENT", "unknown argument (allowed: path, mission, row, cursor)", { unknown: extra.slice(0, 10).map((k) => k.slice(0, 40)) })
  if (typeof raw.path !== "string" || raw.path === "" || raw.path.length > PATH_MAX) throw bad("INVALID_ARGUMENT", `path must be a non-empty string of at most ${PATH_MAX} characters`, { field: "path" })
  const mission = idArg(raw.mission, "mission")
  const row = idArg(raw.row, "row")
  if ((mission === undefined) !== (row === undefined)) throw bad("INVALID_ARGUMENT", "mission and row go together: give both to record the read, or neither", { field: mission === undefined ? "mission" : "row" })
  const c = raw.cursor
  if (c !== undefined && (typeof c !== "number" || !Number.isInteger(c) || c < 1)) throw bad("INVALID_ARGUMENT", "cursor must be the integer the previous page gave", { field: "cursor" })
  return { path: raw.path, ...(mission !== undefined ? { mission } : {}), ...(row !== undefined ? { row } : {}), cursor: typeof c === "number" ? c : 0 }
}

/** Lexical rules of a library path (before the disk is touched). Returns the segments. */
export function checkLibraryPath(rel: string): string[] {
  const invalid = (why: string) => bad("PATH_INVALID", `path ${why}; give a path inside the technical library as listed in the trigger index`, { reason: why })
  if (/[\u0000-\u001f]/.test(rel)) throw invalid("contains a NUL or control character")
  if (rel.includes("\\")) throw invalid("contains a backslash (use /)")
  if (path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.startsWith("~")) throw invalid("is absolute")
  const segs = rel.split("/")
  for (const s of segs) {
    if (s === "") throw invalid("has an empty segment")
    if (s === "." || s === "..") throw invalid("contains a . or .. segment")
    if (s.startsWith(".")) throw invalid("names a hidden file or folder")
  }
  return segs
}

function inside(child: string, parent: string): boolean {
  const r = path.relative(parent, child)
  return r === "" || (!r.startsWith("..") && !path.isAbsolute(r))
}

/**
 * The real file a library path names, inside the real root. Looks under LIBRARY_INDEX_BASE first, then the root.
 * Throws PATH_INVALID, PATH_OUTSIDE_ROOTS or FILE_UNREADABLE.
 */
export function resolveLibraryFile(rootReal: string, rel: string, bases = [path.join(rootReal, ...LIBRARY_INDEX_BASE.split("/")), rootReal]): string {
  const segs = checkLibraryPath(rel)
  for (const base of bases) {
    const candidate = path.join(base, ...segs)
    if (!inside(candidate, rootReal)) throw bad("PATH_OUTSIDE_ROOTS", "path leaves the technical library", {})
    if (!lstatSync(candidate, { throwIfNoEntry: false })) continue
    let real: string
    try {
      real = realpathSync(candidate)
    } catch {
      throw bad("FILE_UNREADABLE", "the file cannot be opened (a broken link)", {})
    }
    if (!inside(real, rootReal)) throw bad("PATH_OUTSIDE_ROOTS", "path leads out of the technical library (a link); only files inside the library are served", {})
    if (!statSync(real).isFile()) throw bad("FILE_UNREADABLE", "path is not a file of the technical library", {})
    return real
  }
  throw bad("FILE_UNREADABLE", "no such file in the technical library; take the path from the trigger index", {})
}

type TriggerIndex = { byPath: Map<string, string>; domains: Set<string>; bySkill: Map<string, string> }
/** The reader's view of one loaded document (the loader caches the document per file, size and mtime). */
const viewCache = new WeakMap<object, TriggerIndex>()

/**
 * The trigger index of the library (read_order path -> domain), or null. Row 151 (S8): the file is the one the matcher
 * loads (`resolveTriggerIndexPath` + `readTriggerIndexDoc` of knowledge-match.ts); a malformed first file is no index
 * here too (the folder rule then applies). Never throws.
 */
function triggerIndex(rootReal: string): TriggerIndex | null {
  const file = resolveTriggerIndexPath({ libraryRoot: rootReal })
  const doc = file ? readTriggerIndexDoc(file).value : undefined
  if (!doc) return null
  const cached = viewCache.get(doc)
  if (cached) return cached
  const byPath = new Map<string, string>()
  const domains = new Set<string>()
  const bySkill = new Map<string, string>()
  for (const [domain, d] of Object.entries(doc.domains as Record<string, { read_order?: unknown } | null>)) {
    if (!DOMAIN_RE.test(domain)) continue
    domains.add(domain)
    for (const p of Array.isArray(d?.read_order) ? d.read_order : []) {
      if (typeof p !== "string") continue
      if (!byPath.has(p)) byPath.set(p, domain)
      const skill = SKILL_PATH_RE.exec(p)?.[1]
      if (skill && !bySkill.has(skill)) bySkill.set(skill, domain)
    }
  }
  const index = { byPath, domains, bySkill }
  viewCache.set(doc, index)
  return index
}

/** The domain a library path belongs to: its read order in the trigger index, else its domain folder. */
export function libraryDomainOf(rootReal: string | null, rel: string): string | null {
  const index = rootReal ? triggerIndex(rootReal) : null
  const listed = index?.byPath.get(rel)
  if (listed) return listed
  // a skill file: the domain whose read order points into that skill (no index, no domain)
  const skill = SKILL_PATH_RE.exec(rel)?.[1]
  if (skill) return index?.bySkill.get(skill) ?? null
  const m = /^0[45]_[A-Z0-9-]+\/([A-Z0-9][A-Z0-9-]{0,63})\//.exec(rel)
  if (!m) return null
  return !index || index.domains.has(m[1]!) ? m[1]! : null
}

/** One page of a UTF-8 buffer from `from`: at most `size` bytes, cut after the last line end, else on a character. */
export function pageOf(buf: Buffer, from: number, size: number): { from: number; to: number } {
  const total = buf.length
  if (from === 0 && total === 0) return { from: 0, to: 0 }
  if (from < 0 || from >= total || (buf[from]! & 0xc0) === 0x80) throw bad("INVALID_ARGUMENT", "cursor is not a page start of this file; use the cursor the previous page gave", { field: "cursor", total })
  let to = Math.min(total, from + size)
  if (to < total) {
    const nl = buf.lastIndexOf(0x0a, to - 1)
    if (nl >= from) to = nl + 1
    else while (to > from + 1 && (buf[to]! & 0xc0) === 0x80) to--
  }
  return { from, to }
}

/**
 * C33: the real file `skill:<name>/<path>` names, inside the real root of an allow-listed built-in skill the host was
 * given. Throws PATH_INVALID (unknown skill, bad path), PATH_OUTSIDE_ROOTS, FILE_UNREADABLE.
 */
export function skillFile(rel: string, roots: Readonly<Record<string, string>> | null | undefined): string {
  const m = SKILL_PATH_RE.exec(rel)
  const name = m?.[1]
  const root = name && BUILTIN_SKILL_ROOT_NAMES.includes(name) && roots && Object.hasOwn(roots, name) ? libraryRootOf(roots[name]) : null
  if (!m || !root) throw bad("PATH_INVALID", `path names no built-in skill this tool serves (${BUILTIN_SKILL_ROOT_NAMES.map((n) => `skill:${n}/...`).join(", ")})`, { reason: "unknown skill" })
  return resolveLibraryFile(root, m[2]!, [root])
}

export interface LibraryReadOptions {
  /** STUDIO_LIBRARY_ROOT; null/absent = the tool answers "not available". */
  root?: string | null
  /** The host's log channel; without it the tool writes its own daily JSONL under the store. */
  log?: LibraryReadLog
  /** C33: STUDIO_SKILL_ROOTS, skill name -> on-disk root; only BUILTIN_SKILL_ROOT_NAMES are used. */
  skillRoots?: Readonly<Record<string, string>> | null
  /** Tests only: page and file caps. */
  pageBytes?: number
  maxBytes?: number
}

type Recording = { recorded: true; domains: string[] } | { recorded: false; reason: string }

/** `studio_library_read` as a host extension (toolset `missions`: it records against mission rows). */
export function libraryReadExtension(store: LibraryReadStore, opts: LibraryReadOptions = {}): HostToolExtension {
  const pageBytes = opts.pageBytes ?? LIBRARY_PAGE_BYTES
  const maxBytes = opts.maxBytes ?? LIBRARY_FILE_MAX_BYTES
  const log = (level: "info" | "warn" | "error", message: string, context: Rec) => {
    try {
      if (opts.log) {
        opts.log(level, SOURCE, message, context)
        return
      }
    } catch {
      // a failing host log falls through to the tool's own file
    }
    const entry: { timestamp: string } & Rec = { timestamp: new Date().toISOString(), level, source: SOURCE, message, context }
    void appendJsonlDaily("mcp-host", "datum-studio-library-read", entry).catch(() => undefined)
  }

  async function record(cid: string, a: Args, domain: string | null, ctx: Rec): Promise<Recording> {
    if (a.mission === undefined || a.row === undefined) return { recorded: false, reason: "no mission and row given" }
    try {
      const mark = await store.transaction(async (tx) => store.missions.markKnowledgeConsulted(tx, a.mission!, a.row!, { path: a.path, ...(domain ? { domain } : {}) }), { correlationId: cid })
      if (mark.marked) {
        log("info", "library read recorded", { ...ctx, domains: mark.domains })
        return { recorded: true, domains: mark.domains }
      }
      return { recorded: false, reason: mark.reason ?? "not marked" }
    } catch (e) {
      const code = e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test((e as { code: string }).code) ? (e as { code: string }).code : "INTERNAL_ERROR"
      const err = e instanceof Error ? e : new Error(String(e))
      log(code === "INTERNAL_ERROR" ? "error" : "warn", "library read not recorded", { ...ctx, code, message: err.message.slice(0, 300), ...(code === "INTERNAL_ERROR" ? { stack_trace: err.stack } : {}) })
      return { recorded: false, reason: code }
    }
  }

  return {
    name: LIBRARY_READ_TOOL,
    title: "Read library",
    description: LIBRARY_READ_DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    toolsets: ["missions"] as const,
    async call(raw: Record<string, unknown>, session: HostToolSession): Promise<CallToolResult> {
      const cid = randomUUID()
      const a0 = (raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Rec
      const ctx: Rec = {
        correlationId: cid,
        tool: LIBRARY_READ_TOOL,
        agentId: session.agentId,
        ...sessionLogRef(session),
        ...(typeof a0.path === "string" ? { path: a0.path.slice(0, PATH_MAX).replace(/[\u0000-\u001f]/g, "?") } : {}),
        ...(typeof a0.mission === "string" ? { mission: a0.mission.slice(0, ID_MAX) } : {}),
        ...(typeof a0.row === "string" ? { row: a0.row.slice(0, ID_MAX) } : {}),
      }
      try {
        const a = validate(a0)
        const rootReal = libraryRootOf(opts.root)
        const skill = a.path.startsWith("skill:") ? skillFile(a.path, opts.skillRoots) : null
        if (!rootReal && !skill) {
          log("warn", "library not available", { ...ctx, root: opts.root ? "unusable" : "unset" })
          return {
            content: [{ type: "text", text: `${LIBRARY_READ_TOOL}: not available. The technical library is not installed with this Studio host; nothing was read or recorded.` }],
            structuredContent: { ok: false, tool: LIBRARY_READ_TOOL, available: false },
          }
        }
        const file = skill ?? resolveLibraryFile(rootReal!, a.path)
        const ext = path.extname(file).toLowerCase()
        const image = LIBRARY_IMAGE_EXT.has(ext)
        if (!LIBRARY_TEXT_EXT.has(ext) && !image) throw bad("PATH_INVALID", `only text files and images are served (${[...LIBRARY_TEXT_EXT, ...LIBRARY_IMAGE_EXT].join(", ")})`, { reason: "not a text file" })
        const size = statSync(file).size
        if (size > maxBytes) throw bad("PAYLOAD_TOO_LARGE", `file is ${size} B, over the ${maxBytes} B the tool serves`, { bytes: size, maxBytes })
        if (image) {
          // never read into the reply: the agent opens the file with its own image reader
          const domain = libraryDomainOf(rootReal, a.path)
          const rec = await record(cid, a, domain, ctx)
          return {
            content: [{ type: "text", text: [`library ${a.path}${domain ? ` (domain ${domain})` : ""}: image, ${size} B, not served as text; open it with your image reader:`, file, rec.recorded ? `recorded: mission ${a.mission} row ${a.row} (${rec.domains.join(", ")})` : `not recorded (${rec.reason})`].join("\n") }],
            structuredContent: { ok: true, tool: LIBRARY_READ_TOOL, path: a.path, domain, image: true, file, bytes: { total: size }, ...(a.mission !== undefined ? { mission: a.mission, row: a.row } : {}), recorded: rec.recorded, ...(rec.recorded ? { recordedDomains: rec.domains } : { notRecorded: rec.reason }) },
          }
        }
        const buf = readFileSync(file)
        if (buf.includes(0) || !isUtf8(buf)) throw bad("PATH_INVALID", "not a text file (binary or not UTF-8)", { reason: "not a text file" })
        const page = pageOf(buf, a.cursor, pageBytes)
        const domain = libraryDomainOf(rootReal, a.path)
        const rec = await record(cid, a, domain, ctx)
        const more = page.to < buf.length
        const head = [
          `library ${a.path}${domain ? ` (domain ${domain})` : ""}: bytes ${page.from}-${page.to} of ${buf.length}`,
          rec.recorded ? `recorded: mission ${a.mission} row ${a.row} (${rec.domains.join(", ")})` : `not recorded (${rec.reason})`,
          ...(more ? [`more: call ${LIBRARY_READ_TOOL} again with the same path and cursor: ${page.to}`] : []),
        ]
        return {
          content: [{ type: "text", text: `${head.join("\n")}\n---\n${buf.subarray(page.from, page.to).toString("utf8")}` }],
          structuredContent: {
            ok: true,
            tool: LIBRARY_READ_TOOL,
            path: a.path,
            domain,
            bytes: { from: page.from, to: page.to, total: buf.length },
            ...(more ? { cursor: page.to } : {}),
            ...(a.mission !== undefined ? { mission: a.mission, row: a.row } : {}),
            recorded: rec.recorded,
            ...(rec.recorded ? { recordedDomains: rec.domains } : { notRecorded: rec.reason }),
          },
        }
      } catch (e) {
        if (e instanceof LibraryReadRefusal) {
          log("warn", "library read refused", { ...ctx, ok: false, code: e.code })
          return refused(cid, e.code, e.message, e.details)
        }
        const err = e instanceof Error ? e : new Error(String(e))
        log("error", "library read failed", { ...ctx, ok: false, code: "INTERNAL_ERROR", message: err.message.slice(0, 300), stack_trace: err.stack })
        return refused(cid, "INTERNAL_ERROR", "internal error; details are in the host log", {})
      }
    },
  }
}
