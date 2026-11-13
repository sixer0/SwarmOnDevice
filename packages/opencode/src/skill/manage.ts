// 1.2.8 row 40c (F-SKILL SK-d, SK-f; 01b sections 4.3, 5 and 9): what the person-only skill routes share with the
// `skill_draft` tool (row 40d): the one validator (01b section 5.1), the scope roots and path checks, the drafts reader,
// the approval record and the memory-note text. No Effect services here: the routes and the tool call these with the
// instance's folders, so both sides apply the same rules.

import path from "path"
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import { ConfigMarkdown as ConfigMarkdownCore } from "@opencode-ai/core/config/markdown"
import { Global } from "@opencode-ai/core/global"
import { ProjectTrust } from "@opencode-ai/core/project/trust"
import { isRecord } from "@/util/record"
import {
  REQUIRED_SKILL_NAMES,
  RESERVED_SKILL_NAMES,
  SKILL_CONTENT_MAX_BYTES,
  SKILL_DESCRIPTION_MAX,
  SKILL_DRAFTS_DIR,
  SKILL_NAME_PATTERN,
  SKILL_TRIGGERS_INVALID,
  parseTriggers,
  type Info,
  type Scope,
  type Triggers,
} from "./index"

/** The two scopes Swarm writes skills into. */
export type WriteScope = "global" | "project"

/** The instance folders the scope roots are taken from. */
export type Place = { readonly directory: string; readonly worktree: string }

// 01b section 5.6: the codes a refusal carries. The HTTP status is the route's (groups/skill.ts).
export const SKILL_NAME_INVALID = "SKILL_NAME_INVALID"
export const SKILL_NAME_RESERVED = "SKILL_NAME_RESERVED"
export const SKILL_FRONTMATTER_INVALID = "SKILL_FRONTMATTER_INVALID"
export const SKILL_TOO_LARGE = "SKILL_TOO_LARGE"
export const SKILL_PATH_UNSAFE = "SKILL_PATH_UNSAFE"
export const SKILL_SHELL_UNTRUSTED = "SKILL_SHELL_UNTRUSTED"
export const SKILL_CHANGED = "SKILL_CHANGED"
export const SKILL_DRAFT_MISSING = "SKILL_DRAFT_MISSING"
export const SKILL_NOT_FOUND = "SKILL_NOT_FOUND"
export const SKILL_ARCHIVE_FAILED = "SKILL_ARCHIVE_FAILED"
export const SKILL_PERSON_ONLY = "SKILL_PERSON_ONLY"
export const SKILL_SHELL_UNCONFIRMED = "SKILL_SHELL_UNCONFIRMED"
export { SKILL_TRIGGERS_INVALID }

/** N8-406: the file next to a draft's SKILL.md. */
export const DRAFT_FILE = "draft.json"
/** N8-407: one line per save, approve and delete, under the data folder. */
export const APPROVALS_FILE = "skill-approvals.jsonl"

// 01b section 5.1 step 3: route segments, and the built-in names rows 47 and 58 add (N8-059..N8-062), are never taken
// by a saved skill, whether or not the built-in exists yet.
const ROUTE_SEGMENTS = new Set(["drafts", "source"])
const COMING_BUILT_INS = new Set(["skill-authoring", "obsidian-memory", "project-folders", "diagram-flow"])

export type Refusal = { readonly ok: false; readonly code: string; readonly message: string }
export type Checked = {
  readonly ok: true
  readonly description: string
  readonly triggers?: Triggers
  /** The content runs `` !`...` `` shell blocks (SR8-08). */
  readonly runsCommands: boolean
}

const refuse = (code: string, message: string): Refusal => ({ ok: false, code, message })

/** The folder a project skill is saved under: the worktree, or the folder itself without git (as `remember` uses). */
export function projectRoot(place: Place) {
  return place.worktree === "/" ? place.directory : place.worktree
}

/** `~/.config/swarm` for global, `<project root>/.swarm` for project (01b section 5.1 step 8). */
export function scopeRoot(scope: WriteScope, place: Place) {
  return scope === "global" ? Global.Path.config : path.join(projectRoot(place), ".swarm")
}

/** What `Archive.move` takes as its folder: the project root, or the global config folder. */
export function archiveBase(scope: WriteScope, place: Place) {
  return scope === "global" ? Global.Path.config : projectRoot(place)
}

/** N8-044: `<data>/skill-drafts` for global, `<project root>/.swarm/skill-drafts` for project. */
export function draftsRoot(scope: WriteScope, place: Place) {
  return scope === "global"
    ? path.join(Global.Path.data, SKILL_DRAFTS_DIR)
    : path.join(projectRoot(place), ".swarm", SKILL_DRAFTS_DIR)
}

const inside = (parent: string, child: string) => {
  const rel = path.relative(parent, child)
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

/** A SKILL.md Swarm saved in this scope: under `<scope root>/skill/` or `<scope root>/skills/`, in a folder of its own. */
export function savedIn(location: string, root: string) {
  return ["skill", "skills"].some(
    (dir) => inside(path.join(root, dir), path.dirname(location)) && path.basename(location) === "SKILL.md",
  )
}

/** N8-039 (01b section 4.3): builtin, global (the config folder), project (a `.swarm` folder in the project), other. */
export function scopeOf(location: string, place: Place): Scope {
  if (location === "<built-in>") return "builtin"
  const configs = [Global.Path.config, process.env.OPENCODE_CONFIG_DIR].filter((dir): dir is string => !!dir)
  if (configs.some((dir) => inside(dir, location))) return "global"
  const root = projectRoot(place)
  if (path.dirname(root) !== root && inside(root, location)) {
    const segments = path.relative(root, location).split(path.sep)
    const at = segments.indexOf(".swarm")
    const swarm = at >= 0 ? path.join(root, ...segments.slice(0, at + 1)) : undefined
    if (swarm && swarm !== path.join(Global.Path.home, ".swarm")) return "project"
  }
  return "other"
}

/** sha256 hex of a SKILL.md's bytes (N8-399). */
export function hashOf(content: string | Uint8Array) {
  return createHash("sha256").update(content).digest("hex")
}

/** `GET /skill`: each skill with its scope and, for a file on disk, the hash `PUT /skill` takes as `baseHash`. */
export async function listed(list: readonly Info[], place: Place): Promise<Info[]> {
  return Promise.all(
    list.map(async (info) => {
      const scope = scopeOf(info.location, place)
      if (scope === "builtin") return { ...info, scope }
      const bytes = await fs.readFile(info.location).catch(() => undefined)
      return bytes ? { ...info, scope, hash: hashOf(bytes) } : { ...info, scope }
    }),
  )
}

/**
 * 01b section 5.1 steps 2 to 7, first failure wins. Used by `PUT /skill`, by approve and by the draft tool. The name is
 * checked on its decoded value before any path is built from it.
 */
export function validate(input: {
  scope: WriteScope
  name: string
  content: string
  trusted: boolean
}): Checked | Refusal {
  const { name, content } = input
  if (!SKILL_NAME_PATTERN.test(name))
    return refuse(SKILL_NAME_INVALID, "Use lowercase letters, digits and hyphens, at most 64 characters.")
  if (
    RESERVED_SKILL_NAMES.has(name) ||
    REQUIRED_SKILL_NAMES.has(name) ||
    COMING_BUILT_INS.has(name) ||
    ROUTE_SEGMENTS.has(name)
  )
    return refuse(SKILL_NAME_RESERVED, `The name ${name} is reserved.`)
  if (Buffer.byteLength(content, "utf8") > SKILL_CONTENT_MAX_BYTES)
    return refuse(SKILL_TOO_LARGE, `The skill is larger than ${SKILL_CONTENT_MAX_BYTES} bytes.`)
  const md = (() => {
    try {
      return /^---\r?\n/.test(content) ? ConfigMarkdownCore.parse(content) : undefined
    } catch {
      return undefined
    }
  })()
  const data: unknown = md?.data
  if (!md || !isRecord(data)) return refuse(SKILL_FRONTMATTER_INVALID, "The skill has no frontmatter.")
  if (data.name !== name) return refuse(SKILL_FRONTMATTER_INVALID, "The frontmatter name differs from the skill name.")
  const description = data.description
  if (
    typeof description !== "string" ||
    description.trim() === "" ||
    /[\r\n]/.test(description) ||
    Array.from(description).length > SKILL_DESCRIPTION_MAX
  )
    return refuse(
      SKILL_FRONTMATTER_INVALID,
      `The description must be one non-empty line of at most ${SKILL_DESCRIPTION_MAX} characters.`,
    )
  const parsed = parseTriggers(data.triggers)
  if (parsed && "reason" in parsed) return refuse(SKILL_TRIGGERS_INVALID, parsed.reason)
  const runsCommands = !ProjectTrust.isTextSkill(content)
  if (input.scope === "project" && !input.trusted && runsCommands)
    return refuse(
      SKILL_SHELL_UNTRUSTED,
      "This project is not trusted, so a skill that runs shell commands cannot be saved here.",
    )
  return {
    ok: true,
    description: description.trim(),
    ...(parsed && "triggers" in parsed ? { triggers: parsed.triggers } : {}),
    runsCommands,
  }
}

/**
 * 01b section 5.1 step 8: no level from the scope root down to the target is a link, and the deepest folder that
 * exists resolves inside the scope root. Missing levels are allowed (they are made by the write).
 */
export async function pathSafe(root: string, target: string) {
  if (!inside(root, target)) return false
  const levels = [root]
  for (const part of path.relative(root, target).split(path.sep)) levels.push(path.join(levels.at(-1)!, part))
  let deepest = root
  for (const level of levels) {
    const stat = await fs.lstat(level).catch((error: NodeJS.ErrnoException) => error)
    if (stat instanceof Error) {
      if (stat.code === "ENOENT") break
      return false
    }
    if (stat.isSymbolicLink()) return false
    if (level !== target && !stat.isDirectory()) return false
    if (stat.isDirectory()) deepest = level
  }
  const realRoot = await fs.realpath(root).catch(() => undefined)
  const realDeepest = await fs.realpath(deepest).catch(() => undefined)
  if (!realRoot || !realDeepest) return false
  return realDeepest === realRoot || inside(realRoot, realDeepest)
}

/** Writes the file whole or not at all: a new temp file in the same folder, fsync, rename. */
export async function writeAtomic(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  )
  const handle = await fs.open(temp, "wx")
  try {
    await handle.writeFile(content, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(temp, file).catch(async (error) => {
    await fs.unlink(temp).catch(() => undefined)
    throw error
  })
}

/** N8-407 (01b section 5.5): one line, no home path (paths relative to the scope root), no content. */
export async function recordApproval(line: {
  action: "save" | "approve" | "delete"
  scope: WriteScope
  name: string
  hash?: string
  path: string
  draftSessionID?: string
  untrusted?: boolean
}) {
  await fs.mkdir(Global.Path.data, { recursive: true })
  const entry = { time: Date.now(), ...line, by: "person" as const }
  await fs.appendFile(path.join(Global.Path.data, APPROVALS_FILE), JSON.stringify(entry) + "\n", "utf8")
}

export type Draft = {
  name: string
  scope: WriteScope
  content: string
  time: number
  sessionID?: string
  untrusted: boolean
  runsCommands: boolean
}

/** One draft, or nothing when its folder or SKILL.md is missing, a link, or not what it should be. */
export async function readDraft(scope: WriteScope, name: string, place: Place): Promise<Draft | undefined> {
  if (!SKILL_NAME_PATTERN.test(name)) return undefined
  const root = draftsRoot(scope, place)
  const folder = path.join(root, name)
  const file = path.join(folder, "SKILL.md")
  for (const level of [root, folder]) {
    const stat = await fs.lstat(level).catch(() => undefined)
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return undefined
  }
  const stat = await fs.lstat(file).catch(() => undefined)
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.size > SKILL_CONTENT_MAX_BYTES) return undefined
  const content = await fs.readFile(file, "utf8").catch(() => undefined)
  if (content === undefined) return undefined
  // draft.json is written by the draft tool only. A missing or broken one counts as untrusted, never as trusted.
  const meta: unknown = await fs
    .readFile(path.join(folder, DRAFT_FILE), "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => undefined)
  const record = isRecord(meta) ? meta : {}
  return {
    name,
    scope,
    content,
    time: typeof record.time === "number" ? record.time : stat.mtimeMs,
    ...(typeof record.sessionID === "string" ? { sessionID: record.sessionID } : {}),
    untrusted: record.untrusted !== false,
    runsCommands: !ProjectTrust.isTextSkill(content),
  }
}

/** Every draft waiting in both scopes, newest first. */
export async function readDrafts(place: Place): Promise<Draft[]> {
  const found: Draft[] = []
  for (const scope of ["global", "project"] as const) {
    const names = await fs.readdir(draftsRoot(scope, place)).catch(() => [] as string[])
    for (const name of names.toSorted()) {
      const draft = await readDraft(scope, name, place)
      if (draft) found.push(draft)
    }
  }
  return found.toSorted((a, b) => b.time - a.time)
}

/** Removes a draft's folder. A link in its place is removed as a link, never followed. */
export async function removeDraft(scope: WriteScope, name: string, place: Place) {
  if (!SKILL_NAME_PATTERN.test(name)) return
  await fs.rm(path.join(draftsRoot(scope, place), name), { recursive: true, force: true })
}

/** N8-046: `Skill <name> (<scope>): <description>. Triggers: <keywords or "by name only">.` */
export function noteText(input: { name: string; scope: WriteScope; description: string; triggers?: Triggers }) {
  const keywords = input.triggers?.keywords ?? []
  return `Skill ${input.name} (${input.scope}): ${input.description}. Triggers: ${keywords.length ? keywords.join(", ") : "by name only"}.`
}

/**
 * The path a note shows: relative to the project root inside it, `~/...` under the home folder, else as it is. A long
 * absolute path reads as a token to the memory's secret check (mixed case and digits), which would refuse the note.
 */
export function shownPath(location: string, place: Place) {
  const root = projectRoot(place)
  if (path.dirname(root) !== root && inside(root, location))
    return path.relative(root, location).split(path.sep).join("/")
  if (inside(Global.Path.home, location))
    return "~/" + path.relative(Global.Path.home, location).split(path.sep).join("/")
  return location
}

/** 01b section 9.2: `Path:` then one line per non-empty trigger list. */
export function noteBody(location: string, triggers?: Triggers) {
  return [
    `Path: ${location}`,
    ...(triggers?.keywords.length ? [`Keywords: ${triggers.keywords.join(", ")}`] : []),
    ...(triggers?.files.length ? [`Files: ${triggers.files.join(", ")}`] : []),
    ...(triggers?.missionTypes.length ? [`Mission types: ${triggers.missionTypes.join(", ")}`] : []),
  ].join("\n")
}

/** The note of a skill: its text names the skill and one ref is its SKILL.md (relative refs start at the project root). */
export function isNoteOf(
  item: { text: string; refs?: readonly { path?: string }[] },
  input: { name: string; location: string; place: Place },
) {
  if (!item.text.startsWith(`Skill ${input.name} (`)) return false
  const root = projectRoot(input.place)
  return (item.refs ?? []).some(
    (ref) => typeof ref.path === "string" && path.resolve(root, ref.path) === path.resolve(input.location),
  )
}

export * as SkillManage from "./manage"
