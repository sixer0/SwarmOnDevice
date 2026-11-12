// Copy-before-act for an irreversible local action (U6, P-01b). Before the shell or a file tool runs something that no
// archive or Undo covers, it saves the current bytes of every target into `.swarm/checkpoint/<yyyymmdd-hhmmss>-<seq>/`
// inside the session's folder, and only then runs. When the folder is a Git repository and the action moves refs, each
// ref is recorded with its sha and kept alive under `refs/swarm-checkpoint/<id>/<n>`, so `gc` or `reflog expire` cannot
// prune the commits. A folder without Git gets file copies only.
//
// Named `ActionCheckpoint` so it is never confused with mission checkpoints in Studio. The permission service never calls
// this (it may not import tools); rows 37b/38a wire it into the shell, the file tools and the revert route.
//
// Integrity (SEC-07): every copy is hashed against its source, `manifest.json` is written to a temporary name, synced and
// renamed, and its sha256 goes into the audit line. A revert must be given that sha and refuses when the manifest no
// longer matches it. The checkpoint folders are 0700 and a copy of a secret file is 0600 (CK-13). Nothing is followed
// through a link: a `.swarm` or checkpoint folder that is a link is refused, and a link target is copied as the link.
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { Archive } from "./archive"
import { Secrets } from "./secrets"

export const CHECKPOINT_DIR = path.join(".swarm", "checkpoint")
/** Logical bytes one checkpoint may copy (RA-2). Above it the action is refused `checkpoint_failed` (I-X). */
export const CHECKPOINT_MAX_BYTES = 1024 * 1024 * 1024
/** Keep-alive ref namespace (RA-3): `refs/swarm-checkpoint/<id>/<n>`. */
export const KEEP_ALIVE_PREFIX = "refs/swarm-checkpoint"

const IGNORE = "*\n"
const MANIFEST = "manifest.json"
const OUTSIDE = "_outside"
const MAX_SEQ = 1000
const DIR_MODE = 0o700
const SECRET_MODE = 0o600
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const ID = /^\d{8}-\d{6}-\d{1,4}$/

/** Why no checkpoint was made. A closed list: the refusal text names one of these, never command text. */
export type Failure =
  /** The session's folder cannot be read. */
  | "folder"
  /** A target lands outside the folder and is not an existing file a file tool edits. */
  | "outside"
  /** A target is the checkpoint area itself, or holds it. */
  | "checkpoint"
  /** `.swarm`, the checkpoint folder or its `.gitignore` is a link or not what it should be. */
  | "checkpoint_link"
  /** A target could not be read. */
  | "unreadable"
  /** The copy would be larger than `CHECKPOINT_MAX_BYTES`. */
  | "too_large"
  /** Refs were asked for but Git is not there, or a ref name or sha is not acceptable. */
  | "git"
  /** A copy did not hash to its source. */
  | "mismatch"
  /** A folder, copy or the manifest could not be written. */
  | "failed"

export interface Entry {
  /** Root-relative POSIX path of the target, or the absolute path when `outside`. */
  readonly path: string
  readonly outside: boolean
  /** POSIX path of the copy inside the checkpoint folder. */
  readonly rel: string
  readonly existed: boolean
  readonly link?: boolean
  readonly sha256?: string
  readonly bytes: number
  /** Permission bits of the target, put back on revert. */
  readonly mode?: number
  readonly how: "copy" | "snapshot"
}

export interface Ref {
  readonly name: string
  readonly sha: string
  /** The keep-alive ref that holds `sha`. */
  readonly keep: string
}

export interface Manifest {
  readonly id: string
  readonly createdAt: string
  readonly sessionID: string
  readonly requestID: string
  /** The command, passed through `Secrets.scrubText`. */
  readonly command: string
  readonly mode: "copy" | "copy+snapshot"
  readonly snapshot?: string
  /** The targets as given at creation; a revert restores only entries that match one of these (SEC-07). */
  readonly targets: readonly string[]
  readonly entries: readonly Entry[]
  readonly refs?: readonly Ref[]
}

/** The audit outcome line, written after the manifest exists and before the action runs. */
export interface CheckpointedLine {
  readonly type: "outcome"
  readonly requestID: string
  readonly outcome: "checkpointed"
  readonly checkpoint: string
  readonly entries: number
  readonly bytes: number
  readonly refs: number
  readonly manifestSha256: string
}

export interface CreateInput {
  /** The session's folder. The checkpoint lives under it. */
  readonly directory: string
  /** What relative targets are relative to. Defaults to the folder. */
  readonly cwd?: string
  /** Files (or folders) the action will change or remove. Folders are copied file by file. */
  readonly targets: readonly string[]
  /** Ref names the action can move or drop (`HEAD` or `refs/...`). Needs Git. */
  readonly refs?: readonly string[]
  /** Accept targets outside the folder: only for a file tool's `outside_edit` of an existing file. */
  readonly allowOutside?: boolean
  readonly sessionID?: string
  readonly requestID?: string
  readonly command?: string
  /** `Snapshot.track()` when `canUndo` holds; its hash is kept in the manifest. */
  readonly snapshot?: () => Promise<string | undefined>
  readonly record?: (line: CheckpointedLine) => Promise<void> | void
  readonly now?: Date
  /** Test seam: a lower cap than `CHECKPOINT_MAX_BYTES`. */
  readonly maxBytes?: number
}

export type CreateResult =
  | {
      readonly ok: true
      readonly id: string
      /** Absolute path of the checkpoint folder. */
      readonly dir: string
      readonly manifest: Manifest
      readonly manifestSha256: string
      readonly bytes: number
      /** False when the audit line could not be written. The checkpoint exists either way. */
      readonly recorded: boolean
    }
  | { readonly ok: false; readonly reason: Failure; readonly path?: string; readonly message: string }

export interface RevertInput {
  readonly directory: string
  readonly id: string
  /** The `manifestSha256` from the audit line written at creation. */
  readonly manifestSha256: string
  readonly sessionID?: string
  readonly requestID?: string
  readonly record?: (line: CheckpointedLine) => Promise<void> | void
  readonly now?: Date
}

export type RevertFailure = "not_found" | "tampered" | "invalid" | "pre_revert" | "failed" | "mismatch"

export type RevertResult =
  | {
      readonly ok: true
      readonly id: string
      readonly restored: readonly string[]
      /** The checkpoint of the bytes as they were just before this revert, so the revert can be undone. */
      readonly preRevert: string
      readonly verified: true
    }
  | { readonly ok: false; readonly reason: RevertFailure; readonly preRevert?: string; readonly message: string }

export interface Listed {
  readonly id: string
  readonly createdAt: string
  readonly entries: number
  readonly bytes: number
  readonly refs: number
  readonly mode: Manifest["mode"]
}

/** The line an agent reads after the action ran (SEC-24 names the folder; SEC-19 names the kept refs). */
export const savedText = (count: number, id: string, refs = 0) =>
  `Swarm saved checkpoint ${id} of ${count} file(s) in ${path.posix.join(".swarm", "checkpoint", id)} before this ran; the person can revert it.` +
  (refs > 0 ? ` Old commits stay under ${KEEP_ALIVE_PREFIX}/${id} until the person empties the checkpoint.` : "")

/** Saves every target (and ref) into a new checkpoint, or saves nothing and says why. */
export async function create(input: CreateInput): Promise<CreateResult> {
  const root = await fs.realpath(input.directory).catch(() => undefined)
  if (!root) return refuse("folder")
  const base = input.cwd ? path.resolve(root, input.cwd) : root
  const cap = input.maxBytes ?? CHECKPOINT_MAX_BYTES

  // Work out every file first, so nothing is written when one target is refused or the total is over the cap.
  const plan: Planned[] = []
  const targets: string[] = []
  let total = 0
  for (const item of input.targets) {
    const place = await locate(root, path.resolve(base, item))
    if (!place) return refuse("unreadable", item)
    if (place.outside && !input.allowOutside) return refuse("outside", place.abs)
    if (!place.outside && holdsCheckpoint(place.rel)) return refuse("checkpoint", place.rel)
    targets.push(place.outside ? place.abs : posix(place.rel))
    const found = await expand(place)
    if (found === "unreadable") return refuse("unreadable", place.outside ? place.abs : place.rel)
    // Outside the folder only an existing single file is taken (a file tool's `outside_edit`), never a folder.
    if (place.outside && (found.length !== 1 || found[0].abs !== place.abs)) return refuse("outside", place.abs)
    if (found.length === 0) {
      plan.push({ ...place, existed: false, bytes: 0 })
      continue
    }
    for (const file of found) {
      if (plan.some((other) => other.abs === file.abs)) continue
      total += file.bytes
      if (total > cap) return refuse("too_large")
      plan.push(file)
    }
  }

  const git = input.refs && input.refs.length > 0 ? await isGit(root) : false
  if (input.refs && input.refs.length > 0 && !git) return refuse("git")
  const refs: { name: string; sha: string }[] = []
  for (const name of input.refs ?? []) {
    if (!(await refName(root, name))) return refuse("git", name)
    const sha = await gitOut(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", name])
    if (sha === undefined) continue // The ref is not there (no stash, say): nothing to keep.
    if (!SHA.test(sha)) return refuse("git", name)
    if (!refs.some((ref) => ref.name === name)) refs.push({ name, sha })
  }

  const ready = await prepare(root)
  if (ready) return refuse(ready)
  const area = path.join(root, CHECKPOINT_DIR)
  const entry = await claim(area, stamp(input.now ?? new Date()))
  if (!entry) return refuse("failed")
  if ((await fs.realpath(entry.dir).catch(() => undefined)) !== path.join(area, entry.id)) {
    await discard(entry.dir)
    return refuse("checkpoint_link")
  }

  const entries: Entry[] = []
  for (const item of plan) {
    const copied = await copyIn(root, entry.dir, item)
    if (typeof copied === "string") {
      await discard(entry.dir)
      return refuse(copied, item.outside ? item.abs : posix(item.rel))
    }
    entries.push(copied)
  }

  const kept: Ref[] = []
  for (const [n, ref] of refs.entries()) {
    const keep = `${KEEP_ALIVE_PREFIX}/${entry.id}/${n}`
    const made = await gitOut(root, ["update-ref", "--", keep, ref.sha])
    if (made === undefined) {
      await dropKept(root, kept)
      await discard(entry.dir)
      return refuse("git", ref.name)
    }
    kept.push({ ...ref, keep })
  }

  const snapshot = input.snapshot ? await input.snapshot().catch(() => undefined) : undefined
  const manifest: Manifest = {
    id: entry.id,
    createdAt: (input.now ?? new Date()).toISOString(),
    sessionID: input.sessionID ?? "",
    requestID: input.requestID ?? "",
    command: Secrets.scrubText(input.command ?? ""),
    mode: snapshot ? "copy+snapshot" : "copy",
    ...(snapshot ? { snapshot } : {}),
    targets,
    entries,
    ...(kept.length > 0 ? { refs: kept } : {}),
  }
  const manifestSha256 = await writeManifest(entry.dir, manifest)
  if (!manifestSha256) {
    await dropKept(root, kept)
    await discard(entry.dir)
    return refuse("failed")
  }

  const bytes = entries.reduce((sum, item) => sum + item.bytes, 0)
  const line: CheckpointedLine = {
    type: "outcome",
    requestID: input.requestID ?? "",
    outcome: "checkpointed",
    checkpoint: entry.id,
    entries: entries.length,
    bytes,
    refs: kept.length,
    manifestSha256,
  }
  const recorded = input.record
    ? await Promise.resolve()
        .then(() => input.record!(line))
        .then(
          () => true,
          () => false,
        )
    : true
  return { ok: true, id: entry.id, dir: entry.dir, manifest, manifestSha256, bytes, recorded }
}

/**
 * Puts a checkpoint back: first a new checkpoint of the current bytes of the same targets (so this can be undone), then
 * every entry and ref, then a sha check of every restored file. Person-only: the agent is never given a way to call it.
 */
export async function revert(input: RevertInput): Promise<RevertResult> {
  const root = await fs.realpath(input.directory).catch(() => undefined)
  if (!root || !ID.test(input.id)) return fail("not_found")
  const area = await folder(root)
  if (!area) return fail("not_found")
  const dir = path.join(area, input.id)
  const stat = await fs.lstat(dir).catch(() => undefined)
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return fail("not_found")
  if ((await fs.realpath(dir).catch(() => undefined)) !== dir) return fail("not_found")

  const raw = await readPlain(path.join(dir, MANIFEST))
  if (!raw) return fail("not_found")
  if (!SHA.test(input.manifestSha256) || sha256(raw) !== input.manifestSha256) return fail("tampered")
  const manifest = parse(raw)
  if (!manifest || manifest.id !== input.id) return fail("invalid")

  // Every entry must name a target recorded at creation and a copy that stays inside this checkpoint (SEC-07).
  const checked: { entry: Entry; target: string; copy: string }[] = []
  for (const entry of manifest.entries) {
    const target = await resolveTarget(root, manifest, entry)
    if (!target) return fail("invalid")
    const copy = path.resolve(dir, entry.rel)
    if (!copy.startsWith(dir + path.sep)) return fail("invalid")
    if (entry.existed) {
      const parent = await fs.realpath(path.dirname(copy)).catch(() => undefined)
      if (parent !== path.dirname(copy)) return fail("invalid")
      const held = await hashOf(copy)
      if (!held || held.sha256 !== entry.sha256 || held.link !== Boolean(entry.link)) return fail("mismatch")
    }
    checked.push({ entry, target, copy })
  }
  for (const ref of manifest.refs ?? []) {
    if (!SHA.test(ref.sha) || !(await refName(root, ref.name))) return fail("invalid")
  }

  const pre = await create({
    directory: root,
    targets: checked.map((item) => item.target),
    refs: (manifest.refs ?? []).map((ref) => ref.name),
    allowOutside: true,
    sessionID: input.sessionID ?? manifest.sessionID,
    requestID: input.requestID ?? "",
    command: `revert ${input.id}`,
    record: input.record,
    now: input.now,
  })
  if (!pre.ok) return fail("pre_revert")

  const restored: string[] = []
  for (const item of checked) {
    const done = item.entry.existed
      ? await putBack(item.copy, item.target, item.entry)
      : await setAside(root, item.target)
    if (!done) return fail("failed", pre.id)
    restored.push(item.entry.path)
  }
  for (const ref of manifest.refs ?? []) {
    const done = await gitOut(root, ["update-ref", "--", ref.name, ref.sha])
    if (done === undefined) return fail("failed", pre.id)
  }

  for (const item of checked) {
    if (!item.entry.existed) {
      if (
        await fs.lstat(item.target).then(
          () => true,
          () => false,
        )
      )
        return fail("mismatch", pre.id)
      continue
    }
    const now = await hashOf(item.target)
    if (!now || now.sha256 !== item.entry.sha256) return fail("mismatch", pre.id)
  }
  for (const ref of manifest.refs ?? []) {
    const now = await gitOut(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", ref.name])
    if (now !== ref.sha) return fail("mismatch", pre.id)
  }
  return { ok: true, id: input.id, restored, preRevert: pre.id, verified: true }
}

/** The checkpoints in the session's folder, oldest first. A folder without a readable manifest is skipped. */
export async function list(directory: string): Promise<Listed[]> {
  const area = await folder(directory)
  if (!area) return []
  const names = await fs.readdir(area).catch(() => [] as string[])
  const found: Listed[] = []
  for (const name of names.filter((item) => ID.test(item))) {
    const dir = path.join(area, name)
    const stat = await fs.lstat(dir).catch(() => undefined)
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) continue
    const raw = await readPlain(path.join(dir, MANIFEST))
    const manifest = raw ? parse(raw) : undefined
    if (!manifest || manifest.id !== name) continue
    found.push({
      id: name,
      createdAt: manifest.createdAt,
      entries: manifest.entries.length,
      bytes: manifest.entries.reduce((sum, item) => sum + item.bytes, 0),
      refs: manifest.refs?.length ?? 0,
      mode: manifest.mode,
    })
  }
  return found.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

/** The checkpoint folder when it is safe to read: real folders under the session's folder, never a link. */
export async function folder(directory: string) {
  const root = await fs.realpath(directory).catch(() => undefined)
  if (!root) return undefined
  const area = path.join(root, CHECKPOINT_DIR)
  for (const step of [path.join(root, ".swarm"), area]) {
    const stat = await fs.lstat(step).catch(() => undefined)
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return undefined
  }
  if ((await fs.realpath(area).catch(() => undefined)) !== area) return undefined
  return area
}

type Place = { abs: string; rel: string; outside: boolean }
type Planned = Place & { existed: boolean; bytes: number; link?: boolean; mode?: number }

// The path with its parents followed and its last name kept, so a link is the link and not where it points.
async function locate(root: string, file: string): Promise<Place | undefined> {
  const name = path.basename(file)
  const parent = await fs.realpath(path.dirname(file)).catch(() => undefined)
  if (!parent || !name) return undefined
  const abs = path.join(parent, name)
  const rel = path.relative(root, abs)
  const outside = rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)
  return { abs, rel, outside }
}

// The files a target stands for: itself, every file under it when it is a folder, or none when it is not there.
async function expand(place: Place): Promise<Planned[] | "unreadable"> {
  const stat = await fs.lstat(place.abs).catch((error: NodeJS.ErrnoException) => error)
  if (stat instanceof Error) return stat.code === "ENOENT" || stat.code === "ENOTDIR" ? [] : "unreadable"
  if (stat.isSymbolicLink()) return [{ ...place, existed: true, bytes: stat.size, link: true }]
  if (stat.isFile()) return [{ ...place, existed: true, bytes: stat.size, mode: stat.mode & 0o7777 }]
  if (!stat.isDirectory()) return "unreadable"
  const names = await fs.readdir(place.abs).catch(() => undefined)
  if (!names) return "unreadable"
  const out: Planned[] = []
  for (const name of names.toSorted()) {
    const child = await expand({
      abs: path.join(place.abs, name),
      rel: path.join(place.rel, name),
      outside: place.outside,
    })
    if (child === "unreadable") return child
    out.push(...child)
  }
  return out
}

async function copyIn(root: string, dir: string, item: Planned): Promise<Entry | Failure> {
  const rel = item.outside
    ? path.join(OUTSIDE, item.abs.replace(/^[\\/]+/, "").replace(/^[A-Za-z]:[\\/]*/, ""))
    : item.rel
  const target = item.outside ? item.abs : posix(item.rel)
  const entry = { path: target, outside: item.outside, rel: posix(rel) }
  if (!item.existed) return { ...entry, existed: false, bytes: 0, how: "copy" }
  const to = path.join(dir, rel)
  if (!to.startsWith(dir + path.sep)) return "failed"
  const made = await fs.mkdir(path.dirname(to), { recursive: true, mode: DIR_MODE }).then(
    () => true,
    () => false,
  )
  if (!made) return "failed"
  // The parents are checked again right before the copy, so a link put in since the first look is not crossed.
  const again = await locate(root, item.abs)
  if (!again || again.abs !== item.abs) return "unreadable"
  const before = await hashOf(item.abs)
  if (!before) return "unreadable"
  if (item.link) {
    const link = await fs.readlink(item.abs).catch(() => undefined)
    if (link === undefined) return "unreadable"
    const ok = await fs.symlink(link, to).then(
      () => true,
      () => false,
    )
    if (!ok) return "failed"
  } else {
    const ok = await fs
      .copyFile(item.abs, to, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE)
      .then(async () => {
        const stat = await fs.stat(item.abs)
        await fs.utimes(to, stat.atime, stat.mtime)
        await fs.chmod(to, Secrets.secretFile(target) ? SECRET_MODE : (item.mode ?? 0o644) & 0o777)
      })
      .then(
        () => true,
        () => false,
      )
    if (!ok) return "failed"
  }
  const after = await hashOf(to)
  if (!after || after.sha256 !== before.sha256) return "mismatch"
  return {
    ...entry,
    existed: true,
    ...(item.link ? { link: true } : {}),
    sha256: before.sha256,
    bytes: before.bytes,
    ...(item.mode !== undefined ? { mode: item.mode } : {}),
    how: "copy",
  }
}

// The target an entry restores, as an absolute path, only when it is one of the targets recorded at creation (or a file
// under one) and, for an inside entry, still inside the folder once its parents are followed.
async function resolveTarget(root: string, manifest: Manifest, entry: Entry) {
  if (typeof entry.path !== "string" || typeof entry.rel !== "string" || entry.path.includes("\0")) return undefined
  const covered = manifest.targets.some(
    (target) => entry.path === target || entry.path.startsWith(target.endsWith("/") ? target : target + "/"),
  )
  if (!covered) return undefined
  if (entry.outside) {
    if (!path.isAbsolute(entry.path)) return undefined
    const expected = path.join(OUTSIDE, entry.path.replace(/^[\\/]+/, "").replace(/^[A-Za-z]:[\\/]*/, ""))
    if (posix(expected) !== entry.rel) return undefined
    const place = await locate(root, entry.path)
    return place?.outside && place.abs === path.normalize(entry.path) ? place.abs : undefined
  }
  if (path.isAbsolute(entry.path) || entry.rel !== entry.path) return undefined
  const place = await locate(root, path.resolve(root, entry.path))
  if (!place || place.outside || holdsCheckpoint(place.rel)) return undefined
  return place.abs
}

// Writes the copy back through a temporary name beside the target, so the target is either the old or the new bytes.
async function putBack(copy: string, target: string, entry: Entry) {
  const temp = `${target}.swarm-revert-${process.pid}.tmp`
  await fs.mkdir(path.dirname(target), { recursive: true }).catch(() => undefined)
  const ok = await (async () => {
    if (entry.link) {
      const link = await fs.readlink(copy)
      await fs.symlink(link, temp)
    } else {
      await fs.copyFile(copy, temp, fs.constants.COPYFILE_EXCL)
      if (entry.mode !== undefined) await fs.chmod(temp, entry.mode & 0o7777)
    }
    await fs.rename(temp, target)
  })().then(
    () => true,
    () => false,
  )
  if (!ok) await fs.unlink(temp).catch(() => undefined)
  return ok
}

// A file made after the checkpoint is moved to the archive, never deleted.
async function setAside(root: string, target: string) {
  const there = await fs.lstat(target).then(
    () => true,
    () => false,
  )
  if (!there) return true
  const moved = await Archive.move({ directory: root, paths: [target] })
  return moved.ok
}

async function hashOf(file: string): Promise<{ sha256: string; bytes: number; link: boolean } | undefined> {
  const stat = await fs.lstat(file).catch(() => undefined)
  if (!stat) return undefined
  if (stat.isSymbolicLink()) {
    const link = await fs.readlink(file).catch(() => undefined)
    if (link === undefined) return undefined
    return { sha256: sha256(Buffer.from(link)), bytes: stat.size, link: true }
  }
  if (!stat.isFile()) return undefined
  const data = await fs.readFile(file).catch(() => undefined)
  if (!data) return undefined
  return { sha256: sha256(data), bytes: data.length, link: false }
}

const sha256 = (data: Buffer | Uint8Array | string) => createHash("sha256").update(data).digest("hex")

async function readPlain(file: string) {
  const stat = await fs.lstat(file).catch(() => undefined)
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) return undefined
  return fs.readFile(file).catch(() => undefined)
}

function parse(raw: Buffer): Manifest | undefined {
  const value = (() => {
    try {
      return JSON.parse(raw.toString("utf8")) as Manifest
    } catch {
      return undefined
    }
  })()
  if (!value || typeof value.id !== "string" || !Array.isArray(value.entries) || !Array.isArray(value.targets))
    return undefined
  if (value.refs !== undefined && !Array.isArray(value.refs)) return undefined
  return value
}

// The manifest goes to a new temporary name, is synced, then renamed; the sha is of exactly the bytes on disk.
async function writeManifest(dir: string, manifest: Manifest) {
  const text = JSON.stringify(manifest, null, 2) + "\n"
  const temp = path.join(dir, `${MANIFEST}.${process.pid}.tmp`)
  const ok = await (async () => {
    const handle = await fs.open(temp, "wx", SECRET_MODE)
    try {
      await handle.writeFile(text)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temp, path.join(dir, MANIFEST))
  })().then(
    () => true,
    () => false,
  )
  if (!ok) {
    await fs.unlink(temp).catch(() => undefined)
    return undefined
  }
  return sha256(text)
}

// `.swarm` and the checkpoint folder as real 0700 folders, and the checkpoint folder's own `.gitignore` of `*`.
async function prepare(root: string): Promise<Failure | undefined> {
  const area = path.join(root, CHECKPOINT_DIR)
  for (const step of [path.join(root, ".swarm"), area]) {
    await fs.mkdir(step, { mode: DIR_MODE }).catch(() => undefined)
    const stat = await fs.lstat(step).catch(() => undefined)
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return "checkpoint_link"
  }
  if ((await fs.realpath(area).catch(() => undefined)) !== area) return "checkpoint_link"
  await fs.chmod(area, DIR_MODE).catch(() => undefined)
  const ignore = path.join(area, ".gitignore")
  const stat = await fs.lstat(ignore).catch(() => undefined)
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) return "checkpoint_link"
  if (stat && (await fs.readFile(ignore, "utf8").catch(() => undefined)) === IGNORE) return undefined
  const temp = `${ignore}.${process.pid}.tmp`
  const written = await fs
    .writeFile(temp, IGNORE, { flag: "wx" })
    .then(() => fs.rename(temp, ignore))
    .then(
      () => true,
      () => false,
    )
  if (!written) await fs.unlink(temp).catch(() => undefined)
  return written ? undefined : "failed"
}

async function claim(area: string, prefix: string) {
  for (let seq = 1; seq <= MAX_SEQ; seq++) {
    const id = `${prefix}-${seq}`
    const dir = path.join(area, id)
    const made = await fs.mkdir(dir, { mode: DIR_MODE }).then(
      () => true,
      (error: NodeJS.ErrnoException) => (error.code === "EEXIST" ? false : undefined),
    )
    if (made === undefined) return undefined
    if (made) {
      // mkdir's mode is masked by the umask; the folder must be 0700 whatever the umask is.
      await fs.chmod(dir, DIR_MODE).catch(() => undefined)
      return { id, dir }
    }
  }
  return undefined
}

// Only a checkpoint folder this call made and never finished is removed; a finished one is the person's to empty.
async function discard(dir: string) {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
}

async function dropKept(root: string, kept: readonly Ref[]) {
  for (const ref of kept) await gitOut(root, ["update-ref", "-d", "--", ref.keep])
}

function holdsCheckpoint(rel: string) {
  const area = CHECKPOINT_DIR
  return rel === area || rel.startsWith(area + path.sep) || area.startsWith(rel + path.sep) || rel === "."
}

// `HEAD`, or a `refs/...` name that `git check-ref-format` accepts. A name that starts with `-` never reaches git.
async function refName(root: string, name: string) {
  if (typeof name !== "string" || name.length === 0 || name.length > 255) return false
  if (name === "HEAD") return true
  if (!name.startsWith("refs/") || name.startsWith(KEEP_ALIVE_PREFIX + "/")) return false
  return (await gitOut(root, ["check-ref-format", name])) !== undefined
}

async function isGit(root: string) {
  const inside = await gitOut(root, ["rev-parse", "--is-inside-work-tree"])
  return inside === "true"
}

/** Runs git without a shell; the trimmed stdout, or undefined when it failed or git is missing. */
function gitOut(cwd: string, args: string[]) {
  return new Promise<string | undefined>((resolve) => {
    execFile("git", args, { cwd, timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) =>
      resolve(error ? undefined : String(stdout).trim()),
    )
  })
}

function stamp(now: Date) {
  const two = (value: number) => String(value).padStart(2, "0")
  return (
    `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-` +
    `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`
  )
}

const posix = (rel: string) => rel.split(path.sep).join(path.posix.sep)

const MESSAGES: Record<Failure, string> = {
  folder: "Swarm could not read the session's folder to save a checkpoint in.",
  outside: "A target is outside the project folder, so Swarm cannot save a checkpoint of it.",
  checkpoint: "The checkpoint folder is the person's to empty, not the agent's.",
  checkpoint_link: "The checkpoint folder (.swarm/checkpoint) is a link or not a folder, so nothing was saved in it.",
  unreadable: "A target could not be read, so Swarm could not save a checkpoint of it.",
  too_large: "The files are too large to save as a checkpoint.",
  git: "Swarm could not record the Git refs this changes.",
  mismatch: "A saved copy did not match the file it was copied from.",
  failed: "Swarm could not write the checkpoint.",
}

const REVERT_MESSAGES: Record<RevertFailure, string> = {
  not_found: "There is no such checkpoint in this folder.",
  tampered: "The checkpoint's manifest changed since it was made, so nothing was restored.",
  invalid: "The checkpoint names a path or ref it may not restore, so nothing was restored.",
  pre_revert: "Swarm could not save the current files first, so nothing was restored.",
  failed: "Restoring stopped part way. The files as they were just before are in the pre-revert checkpoint.",
  mismatch:
    "A restored file does not match the checkpoint. The files as they were just before are in the pre-revert checkpoint.",
}

function refuse(reason: Failure, at?: string): CreateResult {
  return { ok: false, reason, ...(at ? { path: at } : {}), message: MESSAGES[reason] }
}

function fail(reason: RevertFailure, preRevert?: string): RevertResult {
  return {
    ok: false,
    reason,
    ...(preRevert ? { preRevert } : {}),
    message: preRevert ? `${REVERT_MESSAGES[reason]} (${preRevert})` : REVERT_MESSAGES[reason],
  }
}

export * as ActionCheckpoint from "./checkpoint"
