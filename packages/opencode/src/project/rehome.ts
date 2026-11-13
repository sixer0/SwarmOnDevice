export * as Rehome from "./rehome"

// Re-home primitive (1.2.8 F-PROJ, 01d §6, N8-132): moves one mission folder `docs/<missionId>` from the Default
// Project root R into a one-level group folder G (or back, as a compensation), moves the mission's memory notes to the
// store of G (Memory.storeKey), and re-points the mission's sessions. Every step is written to a journal before it
// runs; a failure undoes the done steps in reverse, and every undo re-checks that it overwrites nothing and follows no
// symlink (SR8-18 c). The HTTP route, the desktop nonce and PERSON_ONLY_ROUTES are row 44b; this module trusts nothing
// from its caller beyond the values in `Input`.

import { randomBytes } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"
import { Project } from "@opencode-ai/schema/project"
import { ProjectMemory } from "@opencode-ai/schema/project-memory"
import { Memory } from "@/memory/memory"

/** One folder level, at most 60 characters, no leading dot, no slash (N8-150); see `groupNameOk` for the rest. */
export const GROUP_NAME_PATTERN = /^[^./\\][^/\\]{0,59}$/
/** Child folders of R that are never a group (N8-445), compared case-insensitively (APFS default). */
export const RESERVED_GROUP_NAMES = ["docs"] as const

/** `project.rehomed` (N8-131, R20-C28), published after a completed move (row 44b; the app follows it in row 44c). */
export const Event = { Rehomed: Project.Event.Rehomed }

export type GroupKind = "product" | "institution" | "theme"
const KINDS: readonly string[] = ["product", "institution", "theme"]

export type Code =
  | "REHOME_SOURCE_MISSING"
  | "REHOME_TARGET_EXISTS"
  | "REHOME_OUTSIDE_ROOT"
  | "REHOME_SYMLINK"
  | "REHOME_APPROVAL_MISSING"
  | "REHOME_BUSY"
  | "REHOME_ROLLED_BACK"
  | "REHOME_SESSION_ACTIVE"
  | "REHOME_ROLLBACK_FAILED"

export type StepName = "backup" | "group" | "marker" | "docs" | "folder" | "memory" | "sessions"

export interface Input {
  missionId: string
  from: string
  to: string
  sessions: readonly string[]
  approvalRef: string
  dryRun?: boolean
  compensates?: string
  groupKind?: GroupKind
}

export type Moved = { folder: boolean; notes: number; sessions: number }
export type Planned = { folder: boolean; notes: number; sessions: number; createsGroup: boolean }
export type Refused = { refused: Code; detail?: string; step?: StepName; journal?: string }
export type Result = { journalId: string; moved: Moved; replayed?: boolean } | { planned: Planned } | Refused

export type JournalState = "running" | "complete" | "rolled_back" | "rollback_failed"
export type JournalStep = { name: StepName; status: "planned" | "done" | "undone"; data: Record<string, unknown> }
export interface Journal {
  version: 1
  journalId: string
  missionId: string
  from: string
  to: string
  approvalRef: string
  compensates?: string
  state: JournalState
  steps: JournalStep[]
  /** Resolved at the start so recovery after a crash needs no server state. */
  root: string
  stores: { from: string; to: string }
  sessions: string[]
  moved?: Moved
  failedStep?: StepName
  warnings?: string[]
}

/** What the primitive needs from the running server; the route (row 44b) supplies the real ones, tests fake them. */
export interface Ports {
  /** `SWARM_DEFAULT_PROJECT_DIR` (N8-443); absent -> every call refuses REHOME_OUTSIDE_ROOT. */
  root: string | undefined
  /** `Global.Path.data` unless given: journals go to `<data>/rehome`, stores are `<data>/memory/<key>.json`. */
  dataDir?: string
  session(id: string): Promise<{ directory: string; projectID: string; busy: boolean } | undefined>
  /** `Project.resolve(directory).id`: decides the memory store key and the MoveSession precondition. */
  projectId(directory: string): Promise<string>
  moveSession(id: string, directory: string): Promise<void>
  /**
   * Start folders of open terminals (OP20-8: the server records a pty's spawn cwd, `Pty.Info.cwd`, not where its shell
   * moved to later), so the terminal check covers terminals opened inside the mission folder only.
   */
  terminals?(): Promise<readonly string[]>
  /** `project.rehomed` (N8-131) with `{ missionId, from, to, sessions, journalId }`. */
  publish?(event: { missionId: string; from: string; to: string; sessions: string[]; journalId: string }): Promise<void>
  /** Vault mirror refresh of one store (OBS-b); derived data, a failure is a journal warning only. */
  refreshMirror?(storeKey: string): Promise<void>
}

/** Test layer only (01d §6.3): never an environment variable or a request field. */
export interface Options {
  faultAt?: StepName
}

const APPROVAL_REF = /^D-[0-9]{1,4}$/
const MISSION_ID = new RegExp(Memory.MISSION_ID_PATTERN)

class Refusal extends Error {
  constructor(
    readonly code: Code,
    readonly detail?: string,
  ) {
    super(`${code}${detail ? `: ${detail}` : ""}`)
  }
}

const dataDir = (ports: Ports) => ports.dataDir ?? Global.Path.data
const journalDir = (ports: Ports) => path.join(dataDir(ports), "rehome")
const storeFile = (ports: Ports, key: string) => path.join(dataDir(ports), "memory", `${key}.json`)

// ---------------------------------------------------------------------------------------------------------------
// Group recognition (01d §2.1, SR8-17, R20-C35)

/** §2.1 rule 3 plus SR8-17: no format, line or paragraph separator characters, no edge white space, no trailing dot. */
export function groupNameOk(name: string) {
  if (!GROUP_NAME_PATTERN.test(name)) return false
  if (name.normalize("NFC") !== name) return false
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) return false
  if (name.trim() !== name || name.endsWith(".")) return false
  return !RESERVED_GROUP_NAMES.some((reserved) => reserved === name.toLowerCase())
}

async function lstatOrUndefined(target: string) {
  return fs.lstat(target).catch(() => undefined)
}

async function readMarker(folder: string): Promise<GroupKind | undefined> {
  const file = path.join(folder, ".swarm", "group.json")
  const dotSwarm = await lstatOrUndefined(path.join(folder, ".swarm"))
  if (!dotSwarm?.isDirectory()) return undefined
  const stat = await lstatOrUndefined(file)
  if (!stat?.isFile()) return undefined
  const parsed = await fs
    .readFile(file, "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => undefined)
  if (!parsed || typeof parsed !== "object") return undefined
  const marker = parsed as Record<string, unknown>
  if (marker.version !== 1 || marker.name !== path.basename(folder) || typeof marker.created !== "number") return undefined
  return typeof marker.kind === "string" && KINDS.includes(marker.kind) ? (marker.kind as GroupKind) : undefined
}

/** A marked one-level group of `realRoot` (§2.1 rules 1-4). */
async function isGroup(realRoot: string, folder: string) {
  const stat = await lstatOrUndefined(folder)
  if (!stat?.isDirectory()) return undefined
  if (!groupNameOk(path.basename(folder))) return undefined
  const real = await fs.realpath(folder).catch(() => undefined)
  if (!real || path.dirname(real) !== realRoot) return undefined
  return readMarker(folder)
}

// ---------------------------------------------------------------------------------------------------------------
// Journal (N8-133): temp file + fsync + rename, 0600 in a 0700 folder, written before and after every step.

async function writeJournal(ports: Ports, journal: Journal) {
  const dir = journalDir(ports)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const target = path.join(dir, `${journal.journalId}.json`)
  const temporary = `${target}.${process.pid}.tmp`
  const handle = await fs.open(temporary, "w", 0o600)
  try {
    await handle.writeFile(JSON.stringify(journal, null, 2) + "\n")
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(temporary, target)
}

async function readJournals(ports: Ports): Promise<{ file: string; journal: Journal }[]> {
  const dir = journalDir(ports)
  const names = await fs.readdir(dir).catch(() => [] as string[])
  const out: { file: string; journal: Journal }[] = []
  for (const name of names.filter((n) => /^rh-\d+-[0-9a-f]{8}\.json$/.test(n)).toSorted()) {
    const file = path.join(dir, name)
    const journal = await fs
      .readFile(file, "utf8")
      .then((text) => JSON.parse(text) as Journal)
      .catch(() => undefined)
    if (journal && journal.version === 1 && typeof journal.journalId === "string") out.push({ file, journal })
  }
  return out
}

const journalPath = (ports: Ports, journalId: string) => path.join(journalDir(ports), `${journalId}.json`)

// ---------------------------------------------------------------------------------------------------------------
// Memory stores, read and written as raw JSON so every note keeps its exact fields (ids, refs, flags).

type RawStore = { version?: number; enabled?: boolean; items: Record<string, unknown>[]; [key: string]: unknown }

async function readRaw(file: string): Promise<RawStore | undefined> {
  const text = await fs.readFile(file, "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  const parsed = JSON.parse(text) as RawStore
  if (!parsed || !Array.isArray(parsed.items)) throw new Error(`memory store unreadable: ${path.basename(file)}`)
  return parsed
}

async function writeRaw(file: string, store: RawStore) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.rehome.tmp`
  await fs.writeFile(temporary, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 })
  await fs.rename(temporary, file)
}

const isInside = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep)

/** Selection of §6.3 step 6: a note of the mission's sessions, its index entry, or one that refers into its folder. */
function selected(item: Record<string, unknown>, input: { missionId: string; sessions: Set<string>; from: string }) {
  if (typeof item.sessionID === "string" && input.sessions.has(item.sessionID)) return true
  if (item.kind === "index" && item.missionId === input.missionId) return true
  const refs = Array.isArray(item.refs) ? (item.refs as Record<string, unknown>[]) : []
  return refs.some((ref) => typeof ref.path === "string" && refInFolder(ref.path, input.from, input.missionId))
}

function refInFolder(ref: string, from: string, missionId: string) {
  const folder = path.join("docs", missionId)
  if (path.isAbsolute(ref)) return isInside(path.normalize(ref), path.join(from, folder))
  return isInside(path.normalize(ref), folder)
}

/** Refs inside the moved folder keep their relative path; other relative refs become absolute under `from` (F4). */
function rewriteRefs(item: Record<string, unknown>, from: string, missionId: string) {
  if (!Array.isArray(item.refs)) return item
  const refs = (item.refs as Record<string, unknown>[]).map((ref) => {
    if (typeof ref.path !== "string" || path.isAbsolute(ref.path) || refInFolder(ref.path, from, missionId)) return ref
    return { ...ref, path: path.join(from, ref.path) }
  })
  return { ...item, refs }
}

const liveIndex = (item: Record<string, unknown>) =>
  item.rolledInto === undefined && (item.kind === "index" || item.kind === "index_rollup")

// ---------------------------------------------------------------------------------------------------------------
// Preflight (§6.2, SR8-18 a)

type Plan = {
  root: string
  from: string
  to: string
  source: string
  target: string
  folder: boolean
  createsGroup: boolean
  needsMarker: boolean
  needsDocs: boolean
  groupKind?: GroupKind
  stores: { from: string; to: string }
  sessions: string[]
  notes: number
}

async function realRoot(ports: Ports) {
  const value = ports.root
  if (!value || !path.isAbsolute(value)) throw new Refusal("REHOME_OUTSIDE_ROOT", "no Default Project root")
  const real = await fs.realpath(value).catch(() => undefined)
  const stat = real ? await lstatOrUndefined(real) : undefined
  if (!real || !stat?.isDirectory()) throw new Refusal("REHOME_OUTSIDE_ROOT", "no Default Project root")
  return { real, given: path.resolve(value) }
}

/** One child level of R, lexically and after realpath of the parent; `to === R` and `R/docs` never. */
async function childOfRoot(target: string, root: { real: string; given: string }) {
  if (!path.isAbsolute(target) || path.normalize(target) !== target || target.endsWith(path.sep))
    throw new Refusal("REHOME_OUTSIDE_ROOT", "not a normalised absolute path")
  if (target.split(path.sep).some((part) => part === ".." || part === "."))
    throw new Refusal("REHOME_OUTSIDE_ROOT", "dot segment")
  const parent = path.dirname(target)
  if (parent !== root.real && parent !== root.given) throw new Refusal("REHOME_OUTSIDE_ROOT", "not one level below R")
  if ((await fs.realpath(parent).catch(() => undefined)) !== root.real)
    throw new Refusal("REHOME_OUTSIDE_ROOT", "parent is not R")
  if (!groupNameOk(path.basename(target))) throw new Refusal("REHOME_OUTSIDE_ROOT", "group name")
}

/** No symlink anywhere inside the mission folder that points outside it (links inside are moved as links). */
async function linksStayInside(folder: string): Promise<boolean> {
  const real = await fs.realpath(folder)
  const walk = async (dir: string): Promise<boolean> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        const link = await fs.readlink(full)
        const resolved = path.resolve(path.dirname(full), link)
        if (!isInside(resolved, folder)) return false
        const pointed = await fs.realpath(full).catch(() => resolved)
        if (!isInside(pointed, real) && !isInside(pointed, folder)) return false
        continue
      }
      if (entry.isDirectory() && !(await walk(full))) return false
    }
    return true
  }
  return walk(folder)
}

async function preflight(ports: Ports, input: Input): Promise<Plan> {
  const root = await realRoot(ports)
  const compensating = input.compensates !== undefined

  // Direction: root -> group, or (compensation, §7.4) the group -> root reverse of a completed move.
  if (!path.isAbsolute(input.from)) throw new Refusal("REHOME_OUTSIDE_ROOT", "from")
  const fromReal = await fs.realpath(input.from).catch(() => undefined)
  if (!fromReal) throw new Refusal("REHOME_SOURCE_MISSING", "from")
  if (compensating) {
    await childOfRoot(input.from, root)
    if (!(await isGroup(root.real, input.from))) throw new Refusal("REHOME_OUTSIDE_ROOT", "from is not a group")
    if (input.to !== root.real && input.to !== root.given) throw new Refusal("REHOME_OUTSIDE_ROOT", "to is not R")
    const original = (await readJournals(ports)).find((j) => j.journal.journalId === input.compensates)?.journal
    if (!original || original.state !== "complete" || original.to !== input.from || original.from !== input.to)
      throw new Refusal("REHOME_APPROVAL_MISSING", "compensates")
  } else {
    if (fromReal !== root.real) throw new Refusal("REHOME_OUTSIDE_ROOT", "from is not R")
    await childOfRoot(input.to, root)
  }

  const from = input.from
  const to = input.to
  const toStat = await lstatOrUndefined(to)
  if (toStat?.isSymbolicLink() || (toStat && !toStat.isDirectory())) throw new Refusal("REHOME_SYMLINK", "to")
  let createsGroup = false
  let needsMarker = false
  if (!compensating) {
    if (toStat) {
      // SR8-18(a): `join` names a marked group; an existing unmarked folder is never adopted (R20-C29).
      if (!(await isGroup(root.real, to))) throw new Refusal("REHOME_TARGET_EXISTS", "unmarked folder")
    } else {
      if (!input.groupKind || !KINDS.includes(input.groupKind))
        throw new Refusal("REHOME_APPROVAL_MISSING", "groupKind")
      createsGroup = true
      needsMarker = true
    }
  }

  const fromDocs = path.join(from, "docs")
  const source = path.join(fromDocs, input.missionId)
  const toDocs = path.join(to, "docs")
  const target = path.join(toDocs, input.missionId)
  const fromDocsStat = await lstatOrUndefined(fromDocs)
  if (fromDocsStat?.isSymbolicLink()) throw new Refusal("REHOME_SYMLINK", "from/docs")
  const sourceStat = await lstatOrUndefined(source)
  if (sourceStat?.isSymbolicLink() || (sourceStat && !sourceStat.isDirectory()))
    throw new Refusal("REHOME_SYMLINK", "mission folder")
  if (sourceStat && !(await linksStayInside(source))) throw new Refusal("REHOME_SYMLINK", "link out of the mission folder")
  const toDocsStat = toStat ? await lstatOrUndefined(toDocs) : undefined
  if (toDocsStat?.isSymbolicLink() || (toDocsStat && !toDocsStat.isDirectory()))
    throw new Refusal("REHOME_SYMLINK", "to/docs")
  if (toStat && (await lstatOrUndefined(target))) throw new Refusal("REHOME_TARGET_EXISTS", "to/docs/<missionId>")
  if (sourceStat) {
    const device = (await fs.stat(fromDocs)).dev
    const targetDevice = (await fs.stat(toStat ? to : root.real)).dev
    if (device !== targetDevice) throw new Refusal("REHOME_OUTSIDE_ROOT", "other volume")
  }

  // Sessions: present, at `from`, idle; no terminal started inside the mission folder; same project as `to` (F8).
  const toProject = await ports.projectId(toStat ? to : root.real)
  for (const id of input.sessions) {
    const session = await ports.session(id)
    if (!session) throw new Refusal("REHOME_SESSION_ACTIVE", `session ${id} not found`)
    if (path.resolve(session.directory) !== path.resolve(from)) throw new Refusal("REHOME_SESSION_ACTIVE", `session ${id}`)
    if (session.busy) throw new Refusal("REHOME_SESSION_ACTIVE", `session ${id} busy`)
    if (session.projectID !== toProject) throw new Refusal("REHOME_OUTSIDE_ROOT", "project boundary")
  }
  if (sourceStat && ports.terminals) {
    const realSource = await fs.realpath(source)
    for (const cwd of await ports.terminals()) {
      const resolved = await fs.realpath(cwd).catch(() => path.resolve(cwd))
      if (isInside(resolved, realSource) || isInside(path.resolve(cwd), source))
        throw new Refusal("REHOME_SESSION_ACTIVE", "terminal inside the mission folder")
    }
  }

  // Store keys. For a new group the folder does not exist yet: its project is R's (one level, same volume, no git).
  const fromProject = await ports.projectId(from)
  const stores = { from: Memory.storeKey(fromProject, from), to: Memory.storeKey(toProject, to) }
  const sessionSet = new Set(input.sessions)
  const sourceStore = await readRaw(storeFile(ports, stores.from)).catch(() => undefined)
  const notes =
    stores.from === stores.to
      ? 0
      : (sourceStore?.items ?? []).filter((item) => selected(item, { missionId: input.missionId, sessions: sessionSet, from }))
          .length

  return {
    root: root.real,
    from,
    to,
    source,
    target,
    folder: !!sourceStat,
    createsGroup,
    needsMarker,
    needsDocs: !toDocsStat,
    groupKind: input.groupKind,
    stores,
    sessions: [...input.sessions],
    notes,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Steps and their undo (§6.3). Every undo is idempotent and re-checks no-overwrite and no-symlink (SR8-18 c).

class UndoRefused extends Error {}

/**
 * What a step will create, recorded in the journal BEFORE it runs: a crash between the action and the next journal
 * write still leaves the undo knowing the path. Only paths preflight saw absent are recorded, so they are ours.
 */
function prepare(step: JournalStep, plan: Plan) {
  if (step.name === "group") step.data.created = plan.to
  if (step.name === "marker")
    step.data.created = [path.join(plan.to, ".swarm"), path.join(plan.to, ".swarm", "group.json")]
  if (step.name === "docs") step.data.created = path.join(plan.to, "docs")
}

async function doStep(ports: Ports, journal: Journal, step: JournalStep, plan: Plan) {
  const data = step.data
  switch (step.name) {
    case "backup": {
      for (const side of ["from", "to"] as const) {
        const key = journal.stores[side]
        if (side === "to" && key === journal.stores.from) continue
        const file = storeFile(ports, key)
        const backup = `${file}.rehome-${journal.journalId}`
        const exists = await lstatOrUndefined(file)
        if (!exists) {
          data[side] = "absent"
          continue
        }
        await fs.copyFile(file, backup, fsConstants.COPYFILE_EXCL)
        await fs.chmod(backup, 0o600)
        data[side] = backup
      }
      return
    }
    case "group": {
      await fs.mkdir(plan.to, { mode: 0o755 })
      return
    }
    case "marker": {
      const dotSwarm = path.join(plan.to, ".swarm")
      await fs.mkdir(dotSwarm, { mode: 0o755 })
      const body = { version: 1, name: path.basename(plan.to), kind: plan.groupKind, created: Date.now() }
      await fs.writeFile(path.join(dotSwarm, "group.json"), JSON.stringify(body, null, 2) + "\n", { flag: "wx", mode: 0o644 })
      return
    }
    case "docs": {
      await fs.mkdir(path.join(plan.to, "docs"), { mode: 0o755 })
      return
    }
    case "folder": {
      if (await lstatOrUndefined(plan.target)) throw new Error("target appeared")
      await fs.rename(plan.source, plan.target)
      data.renamed = true
      // SR8-18(b): the moved folder must really sit at realpath(to)/docs/<missionId>.
      const real = await fs.realpath(plan.target).catch(() => undefined)
      const expected = path.join(await fs.realpath(plan.to), "docs", journal.missionId)
      if (real !== expected) throw new Error("moved folder is not where it should be")
      return
    }
    case "memory": {
      if (journal.stores.from === journal.stores.to) return
      const keys = [journal.stores.from, journal.stores.to].toSorted()
      await Flock.withLock(`memory:${keys[0]}.json`, () =>
        Flock.withLock(`memory:${keys[1]}.json`, async () => {
          const sourceFile = storeFile(ports, journal.stores.from)
          const targetFile = storeFile(ports, journal.stores.to)
          const source = await readRaw(sourceFile)
          if (!source) {
            data.notes = 0
            return
          }
          const sessions = new Set(journal.sessions)
          const pick = source.items.filter((item) =>
            selected(item, { missionId: journal.missionId, sessions, from: plan.from }),
          )
          if (!pick.length) {
            data.notes = 0
            return
          }
          const target = (await readRaw(targetFile)) ?? { version: 2, enabled: true, items: [] }
          const used = new Set(target.items.map((item) => String(item.id)))
          let items = [...target.items]
          for (const item of pick) {
            if (used.has(String(item.id))) continue
            // A full index rolls up first, exactly as a new entry written by the store would (MEM-b, N8-003).
            if (item.kind === "index" && items.filter(liveIndex).length >= ProjectMemory.INDEX_LIMITS.entries) {
              const rolled = Memory.rollUp(items as unknown as Memory.Item[], {
                date: String(item.text ?? "").slice(0, 10),
                time: Date.now(),
                id: () => {
                  const fresh = (): string => {
                    const id = randomBytes(3).toString("hex")
                    if (used.has(id)) return fresh()
                    used.add(id)
                    return id
                  }
                  return fresh()
                },
              })
              if ("refused" in rolled) throw new Error("target index full")
              items = rolled.items as unknown as Record<string, unknown>[]
            }
            items.push(rewriteRefs(item, plan.from, journal.missionId))
            used.add(String(item.id))
          }
          await writeRaw(targetFile, { ...target, items })
          if (options(journal).faultAt === "memory") throw new Error("fault injected at memory")
          const moved = new Set(pick.map((item) => item.id))
          await writeRaw(sourceFile, { ...source, items: source.items.filter((item) => !moved.has(item.id)) })
          data.notes = pick.length
        }),
      )
      return
    }
    case "sessions": {
      const moved: string[] = []
      data.moved = moved
      for (const id of journal.sessions) {
        await ports.moveSession(id, plan.to)
        moved.push(id)
      }
      return
    }
  }
}

async function undoStep(ports: Ports, journal: Journal, step: JournalStep) {
  const data = step.data
  switch (step.name) {
    case "backup":
      return // backups are kept (OP-16-5)
    case "group": {
      const created = typeof data.created === "string" ? data.created : undefined
      if (!created) return
      const stat = await lstatOrUndefined(created)
      if (!stat) return
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new UndoRefused("group folder changed")
      // Only empty: whatever the later steps created was undone before; anything else is not ours to delete.
      if ((await fs.readdir(created)).length) throw new UndoRefused("group folder is not empty")
      await fs.rmdir(created)
      return
    }
    case "marker": {
      const created = Array.isArray(data.created) ? (data.created as string[]) : []
      for (const item of created.toReversed()) {
        const stat = await lstatOrUndefined(item)
        if (!stat) continue
        if (stat.isSymbolicLink()) throw new UndoRefused("marker path is a link")
        if (stat.isDirectory()) {
          if ((await fs.readdir(item)).length) throw new UndoRefused(".swarm is not empty")
          await fs.rmdir(item)
        } else await fs.unlink(item)
      }
      return
    }
    case "docs": {
      const created = typeof data.created === "string" ? data.created : undefined
      if (!created) return
      const stat = await lstatOrUndefined(created)
      if (!stat) return
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new UndoRefused("docs changed")
      if ((await fs.readdir(created)).length) throw new UndoRefused("docs is not empty")
      await fs.rmdir(created)
      return
    }
    case "folder": {
      const source = path.join(journal.from, "docs", journal.missionId)
      const target = path.join(journal.to, "docs", journal.missionId)
      const at = await lstatOrUndefined(target)
      const back = await lstatOrUndefined(source)
      if (!at && back?.isDirectory() && !back.isSymbolicLink()) return // never moved, or already back
      if (!at) throw new UndoRefused("moved folder is gone")
      if (at.isSymbolicLink() || !at.isDirectory()) throw new UndoRefused("moved folder is not a real folder")
      if (back) throw new UndoRefused("something sits at the source again")
      for (const parent of [journal.from, path.join(journal.from, "docs")]) {
        const stat = await lstatOrUndefined(parent)
        if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw new UndoRefused("source parent changed")
      }
      await fs.rename(target, source)
      return
    }
    case "memory": {
      if (journal.stores.from === journal.stores.to) return
      const backupStep = journal.steps.find((s) => s.name === "backup")
      // The memory step starts only after the backup step is recorded done: before that no store was touched.
      if (backupStep?.status !== "done") return
      const backup = backupStep.data
      const keys = [journal.stores.from, journal.stores.to].toSorted()
      await Flock.withLock(`memory:${keys[0]}.json`, () =>
        Flock.withLock(`memory:${keys[1]}.json`, async () => {
          for (const side of ["to", "from"] as const) {
            const file = storeFile(ports, journal.stores[side])
            const saved = backup[side]
            const stat = await lstatOrUndefined(file)
            if (stat?.isSymbolicLink()) throw new UndoRefused("store is a link")
            if (saved === "absent") {
              if (stat) await fs.unlink(file)
              continue
            }
            if (typeof saved !== "string") throw new UndoRefused("no backup recorded")
            const savedStat = await lstatOrUndefined(saved)
            if (!savedStat?.isFile()) throw new UndoRefused("backup missing")
            const temporary = `${file}.${process.pid}.rehome.tmp`
            await fs.copyFile(saved, temporary)
            await fs.chmod(temporary, 0o600)
            await fs.rename(temporary, file)
          }
        }),
      )
      return
    }
    case "sessions": {
      const moved = Array.isArray(data.moved) ? (data.moved as string[]) : journal.sessions
      for (const id of moved.toReversed()) {
        const session = await ports.session(id)
        if (!session) throw new UndoRefused(`session ${id} is gone`)
        if (path.resolve(session.directory) === path.resolve(journal.from)) continue
        await ports.moveSession(id, journal.from)
      }
      return
    }
  }
}

const faults = new WeakMap<Journal, Options>()
const options = (journal: Journal) => faults.get(journal) ?? {}

/** Reverse undo of every step that ran or may have run; the journal ends `rolled_back` or `rollback_failed`. */
async function rollback(ports: Ports, journal: Journal) {
  for (const step of journal.steps.toReversed()) {
    if (step.status === "undone") continue
    try {
      await undoStep(ports, journal, step)
      step.status = "undone"
      await writeJournal(ports, journal)
    } catch (error) {
      journal.state = "rollback_failed"
      journal.warnings = [...(journal.warnings ?? []), `undo ${step.name}: ${String((error as Error)?.message ?? error)}`]
      await writeJournal(ports, journal)
      return false
    }
  }
  journal.state = "rolled_back"
  await writeJournal(ports, journal)
  return true
}

// ---------------------------------------------------------------------------------------------------------------
// Entry points

export interface Rehome {
  run(input: Input): Promise<Result>
  recover(): Promise<{ journalId: string; state: JournalState }[]>
}

/** Builds the primitive over the server's ports. `options.faultAt` exists for the test layer only. */
export function make(ports: Ports, opts: Options = {}): Rehome {
  return {
    run: (input) => run(ports, input, opts),
    recover: () => recover(ports),
  }
}

async function run(ports: Ports, input: Input, opts: Options): Promise<Result> {
  if (!APPROVAL_REF.test(input.approvalRef) || !MISSION_ID.test(input.missionId))
    return { refused: "REHOME_APPROVAL_MISSING" }
  if (!Array.isArray(input.sessions) || input.sessions.some((id) => typeof id !== "string"))
    return { refused: "REHOME_APPROVAL_MISSING", detail: "sessions" }

  const journals = await readJournals(ports)
  const blocked = journals.find((j) => j.journal.missionId === input.missionId && j.journal.state === "rollback_failed")
  if (blocked) return { refused: "REHOME_ROLLBACK_FAILED", journal: blocked.file }

  if (input.dryRun) {
    try {
      const plan = await preflight(ports, input)
      return {
        planned: { folder: plan.folder, notes: plan.notes, sessions: plan.sessions.length, createsGroup: plan.createsGroup },
      }
    } catch (error) {
      if (error instanceof Refusal) return { refused: error.code, detail: error.detail }
      throw error
    }
  }

  const lease = await Flock.acquire("rehome", { timeoutMs: 0 }).catch(() => undefined)
  if (!lease) return { refused: "REHOME_BUSY" }
  try {
    // Idempotency (§6.2): the same completed call returns its result and changes nothing.
    const done = journals.find(
      (j) =>
        j.journal.state === "complete" &&
        j.journal.missionId === input.missionId &&
        j.journal.from === input.from &&
        j.journal.to === input.to &&
        j.journal.approvalRef === input.approvalRef,
    )
    if (done) return { journalId: done.journal.journalId, moved: done.journal.moved ?? emptyMoved, replayed: true }

    let plan: Plan
    try {
      plan = await preflight(ports, input)
    } catch (error) {
      if (error instanceof Refusal) return { refused: error.code, detail: error.detail }
      throw error
    }

    const journal: Journal = {
      version: 1,
      journalId: `rh-${Date.now()}-${randomBytes(4).toString("hex")}`,
      missionId: input.missionId,
      from: input.from,
      to: input.to,
      approvalRef: input.approvalRef,
      ...(input.compensates ? { compensates: input.compensates } : {}),
      state: "running",
      root: plan.root,
      stores: plan.stores,
      sessions: plan.sessions,
      steps: [],
    }
    faults.set(journal, opts)
    const names: StepName[] = [
      "backup",
      ...(plan.createsGroup ? (["group"] as const) : []),
      ...(plan.needsMarker ? (["marker"] as const) : []),
      ...(plan.needsDocs ? (["docs"] as const) : []),
      ...(plan.folder ? (["folder"] as const) : []),
      "memory",
      ...(plan.sessions.length ? (["sessions"] as const) : []),
    ]
    journal.steps = names.map((name) => ({ name, status: "planned", data: {} }))
    await writeJournal(ports, journal)

    for (const step of journal.steps) {
      try {
        prepare(step, plan)
        await writeJournal(ports, journal)
        await doStep(ports, journal, step, plan)
        if (opts.faultAt === step.name && step.name !== "memory") throw new Error(`fault injected at ${step.name}`)
        step.status = "done"
        await writeJournal(ports, journal)
      } catch (error) {
        journal.failedStep = step.name
        journal.warnings = [...(journal.warnings ?? []), `${step.name}: ${String((error as Error)?.message ?? error)}`]
        // The failing step may have half run: its undo is idempotent, so it is undone with the done ones.
        const steps = journal.steps.filter((s) => s.status === "done" || s === step)
        const pending = journal.steps.filter((s) => !steps.includes(s))
        for (const s of pending) s.status = "undone"
        const ok = await rollback(ports, journal)
        const file = journalPath(ports, journal.journalId)
        return ok
          ? { refused: "REHOME_ROLLED_BACK", step: step.name, journal: file }
          : { refused: "REHOME_ROLLBACK_FAILED", step: step.name, journal: file }
      }
    }

    const memoryStep = journal.steps.find((s) => s.name === "memory")
    journal.moved = {
      folder: plan.folder,
      notes: typeof memoryStep?.data.notes === "number" ? memoryStep.data.notes : 0,
      sessions: plan.sessions.length,
    }
    journal.state = "complete"
    await writeJournal(ports, journal)

    // Steps 8-9 never undo the move: the event and the mirror are derived; a failure is a journal warning.
    const warn = async (what: string, work: () => Promise<void> | undefined) => {
      try {
        await work()
      } catch (error) {
        journal.warnings = [...(journal.warnings ?? []), `${what}: ${String((error as Error)?.message ?? error)}`]
        await writeJournal(ports, journal)
      }
    }
    await warn("publish", () =>
      ports.publish?.({
        missionId: journal.missionId,
        from: journal.from,
        to: journal.to,
        sessions: journal.sessions,
        journalId: journal.journalId,
      }),
    )
    for (const key of new Set([journal.stores.from, journal.stores.to]))
      await warn(`mirror ${key}`, () => ports.refreshMirror?.(key))

    return { journalId: journal.journalId, moved: journal.moved }
  } finally {
    await lease.release()
  }
}

const emptyMoved: Moved = { folder: false, notes: 0, sessions: 0 }

/** Server start (§6.3): a journal still `running` never completed, so it is rolled back with every re-check. */
async function recover(ports: Ports) {
  const out: { journalId: string; state: JournalState }[] = []
  for (const { journal } of await readJournals(ports)) {
    if (journal.state !== "running") continue
    await rollback(ports, journal)
    out.push({ journalId: journal.journalId, state: journal.state })
  }
  return out
}
