// Where a deletion goes in autonomous mode instead (U11 rule 4). The paths are renamed into
// `.swarm/archive/<yyyymmdd-hhmmss>-<seq>/<relative path>` inside the session's folder, and only the person deletes them
// for good, once they are back. Nothing here follows a link: a link is moved as the link, and an archive folder that is a
// link, or a path whose parents lead out of the folder, is refused rather than moved.
//
// The archive folder holds its own `.gitignore` of `*`, so the project's `.gitignore` never changes and `git add -A` or
// a test runner does not pick the archive up. Callers decide whether a command is a plain deletion; this only moves.
import fs from "node:fs/promises"
import path from "node:path"

export const ARCHIVE_DIR = path.join(".swarm", "archive")
const IGNORE = "*\n"
// More than this many archives within one second means something is looping, not deleting.
const MAX_SEQ = 1000
// The size is for the person to see; a tree larger than this is shown as at least this many entries' worth.
const MAX_SIZE_ENTRIES = 100_000

export type Refusal =
  /** The session's folder cannot be read. */
  | "folder"
  /** The path lands outside the folder once its parents are followed, or is the folder itself. */
  | "outside"
  /** The path is the archive, inside it, or holds it, such as `.swarm` or `.`. */
  | "archive"
  /** `.swarm`, the archive or its `.gitignore` is a link or not what it should be. */
  | "archive_link"
  /** The path is on another disk than the folder, so a rename cannot move it. */
  | "cross_device"
  /** A rename or a folder could not be made; what had moved was put back. */
  | "failed"

export interface Moved {
  /** Relative to the session's folder. */
  readonly from: string
  /** Relative to the session's folder, under `.swarm/archive/<id>`. */
  readonly to: string
}

export type Result =
  | {
      readonly ok: true
      readonly id: string
      readonly moved: readonly Moved[]
      /** Paths that were not there. `rm -f` would not mind; whether that is an error is the caller's. */
      readonly missing: readonly string[]
      readonly bytes: number
      /** False when the audit line could not be written. The paths are moved either way. */
      readonly recorded: boolean
    }
  | {
      readonly ok: false
      readonly reason: Refusal
      /** The path that was refused, relative to the folder when it is inside. */
      readonly path?: string
      readonly message: string
    }

/** The audit line for a move. Paths are relative to the folder, so the home folder never reaches the file. */
export interface ArchivedLine {
  readonly type: "outcome"
  readonly requestID: string
  readonly outcome: "archived"
  readonly archive: string
  readonly moved: readonly Moved[]
  readonly bytes: number
}

export interface Input {
  /** The session's folder. The archive lives under it. */
  readonly directory: string
  /** What relative paths are relative to. Defaults to the folder. */
  readonly cwd?: string
  readonly paths: readonly string[]
  /** The request the move answers, for the audit line. */
  readonly requestID?: string
  readonly record?: (line: ArchivedLine) => Promise<void> | void
  readonly now?: Date
}

/** The register text an agent reads after a move (U11). */
export const movedText = (count: number, id: string) =>
  `Swarm moved ${count} path(s) to ${path.posix.join(".swarm", "archive", id)} instead of deleting them. The person empties the archive when they return.`

/** Moves the paths into a new archive entry, or moves none of them. */
export async function move(input: Input): Promise<Result> {
  const root = await fs.realpath(input.directory).catch(() => undefined)
  if (!root) return refuse("folder")
  const base = input.cwd ? path.resolve(root, input.cwd) : root
  const archive = path.join(root, ARCHIVE_DIR)

  const found: { abs: string; rel: string }[] = []
  const missing: string[] = []
  for (const item of input.paths) {
    const place = await locate(root, path.resolve(base, item))
    if (!place.ok) return refuse(place.reason, place.rel ?? item)
    if (holdsArchive(place.rel)) return refuse("archive", place.rel)
    const stat = await fs.lstat(place.abs).catch((error: NodeJS.ErrnoException) => error)
    if (stat instanceof Error) {
      if (stat.code === "ENOENT" || stat.code === "ENOTDIR") missing.push(posix(place.rel))
      else return refuse("failed", place.rel)
      continue
    }
    found.push(place)
  }

  // `rm -r a a/b` deletes a/b as part of a; moving it twice would fail on the second.
  const sorted = found.toSorted((a, b) => a.rel.localeCompare(b.rel))
  const kept = sorted.filter(
    (item, index) => !sorted.slice(0, index).some((other) => item.rel === other.rel || under(item.rel, other.rel)),
  )

  if (kept.length === 0) return { ok: true, id: "", moved: [], missing, bytes: 0, recorded: true }

  const ready = await prepare(root)
  if (ready) return refuse(ready)
  const entry = await claim(archive, stamp(input.now ?? new Date()))
  if (!entry) return refuse("failed")
  // The folder was made just now; if it does not resolve to where it was asked for, a link was swapped in on the way.
  if ((await fs.realpath(entry.dir).catch(() => undefined)) !== path.join(archive, entry.id)) return refuse("archive_link")

  const moved: Moved[] = []
  const done: { from: string; to: string }[] = []
  for (const item of kept) {
    const to = path.join(entry.dir, item.rel)
    const failure = await fs
      .mkdir(path.dirname(to), { recursive: true })
      .then(async () => {
        // The parents are checked again right before the rename, so a link put in since the first look is not crossed.
        const again = await locate(root, item.abs)
        if (!again.ok || again.abs !== item.abs) return "outside" as const
        await fs.rename(item.abs, to)
        return undefined
      })
      .catch((error: NodeJS.ErrnoException) => (error.code === "EXDEV" ? ("cross_device" as const) : ("failed" as const)))
    if (failure) {
      const back = await putBack(done)
      if (back) await prune(entry.dir)
      return refuse(failure, item.rel)
    }
    done.push({ from: item.abs, to })
    moved.push({ from: posix(item.rel), to: posix(path.relative(root, to)) })
  }

  const bytes = await size(entry.dir)
  const line: ArchivedLine = {
    type: "outcome",
    requestID: input.requestID ?? "",
    outcome: "archived",
    archive: entry.id,
    moved,
    bytes,
  }
  const recorded = input.record
    ? await Promise.resolve()
        .then(() => input.record!(line))
        .then(
          () => true,
          () => false,
        )
    : true
  return { ok: true, id: entry.id, moved, missing, bytes, recorded }
}

/** The archive folder when it is safe to read or empty: a real folder under the session's folder, never a link. */
export async function folder(directory: string) {
  const root = await fs.realpath(directory).catch(() => undefined)
  if (!root) return undefined
  const archive = path.join(root, ARCHIVE_DIR)
  for (const step of [path.join(root, ".swarm"), archive]) {
    const stat = await fs.lstat(step).catch(() => undefined)
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return undefined
  }
  if ((await fs.realpath(archive).catch(() => undefined)) !== archive) return undefined
  return archive
}

/** The total size of what is in the archive, links counted as links. */
export async function size(dir: string) {
  let bytes = 0
  let entries = 0
  const walk = async (file: string): Promise<void> => {
    if (entries++ > MAX_SIZE_ENTRIES) return
    const stat = await fs.lstat(file).catch(() => undefined)
    if (!stat) return
    if (!stat.isDirectory()) {
      bytes += stat.size
      return
    }
    const names = await fs.readdir(file).catch(() => [] as string[])
    for (const name of names) await walk(path.join(file, name))
  }
  await walk(dir)
  return bytes
}

type Place = { ok: true; abs: string; rel: string } | { ok: false; reason: Refusal; rel?: string }

// The path with its parents followed and its last name kept, so a link is the link and not where it points.
async function locate(root: string, file: string): Promise<Place> {
  const name = path.basename(file)
  const parent = await fs.realpath(path.dirname(file)).catch(() => undefined)
  if (!parent || !name) return { ok: false, reason: "outside" }
  const abs = path.join(parent, name)
  const rel = path.relative(root, abs)
  if (rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel))
    return { ok: false, reason: "outside", rel: rel || "." }
  return { ok: true, abs, rel }
}

function holdsArchive(rel: string) {
  return rel === ARCHIVE_DIR || under(rel, ARCHIVE_DIR) || under(ARCHIVE_DIR, rel)
}

function under(child: string, parent: string) {
  return child.startsWith(parent + path.sep)
}

// `.swarm` and the archive as real folders, and the archive's own `.gitignore`. undefined when all is in place.
async function prepare(root: string): Promise<Refusal | undefined> {
  for (const step of [path.join(root, ".swarm"), path.join(root, ARCHIVE_DIR)]) {
    await fs.mkdir(step).catch(() => undefined)
    const stat = await fs.lstat(step).catch(() => undefined)
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return "archive_link"
  }
  const ignore = path.join(root, ARCHIVE_DIR, ".gitignore")
  const stat = await fs.lstat(ignore).catch(() => undefined)
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) return "archive_link"
  if (stat && (await fs.readFile(ignore, "utf8").catch(() => undefined)) === IGNORE) return undefined
  // Written as a new file in place of whatever was there, so an existing name cannot redirect the write.
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

// A new, empty entry folder. A name already taken goes to the next number, so two moves never share one.
async function claim(archive: string, prefix: string) {
  for (let seq = 1; seq <= MAX_SEQ; seq++) {
    const id = `${prefix}-${seq}`
    const dir = path.join(archive, id)
    const made = await fs.mkdir(dir).then(
      () => true,
      (error: NodeJS.ErrnoException) => (error.code === "EEXIST" ? false : undefined),
    )
    if (made === undefined) return undefined
    if (made) return { id, dir }
  }
  return undefined
}

async function putBack(done: readonly { from: string; to: string }[]) {
  let whole = true
  for (const item of done.toReversed()) {
    const back = await fs.rename(item.to, item.from).then(
      () => true,
      () => false,
    )
    whole &&= back
  }
  return whole
}

// Only empty folders go, deepest first: an entry everything was put back from leaves nothing behind.
async function prune(dir: string): Promise<void> {
  const names = await fs.readdir(dir).catch(() => undefined)
  if (!names) return
  for (const name of names) {
    const child = path.join(dir, name)
    const stat = await fs.lstat(child).catch(() => undefined)
    if (stat?.isDirectory() && !stat.isSymbolicLink()) await prune(child)
  }
  await fs.rmdir(dir).catch(() => undefined)
}

function stamp(now: Date) {
  const two = (value: number) => String(value).padStart(2, "0")
  return (
    `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-` +
    `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`
  )
}

const posix = (rel: string) => rel.split(path.sep).join(path.posix.sep)

const MESSAGES: Record<Refusal, string> = {
  folder: "This call did not run. Swarm could not read the session's folder to archive into.",
  outside: "This call did not run. Autonomous mode only archives paths inside the project folder.",
  archive: "This call did not run. The archive is emptied by the person, not by the agent.",
  archive_link:
    "This call did not run. The archive folder (.swarm/archive) is a link or not a folder, so nothing was moved into it.",
  cross_device: "This call did not run. The path is on another disk than the project folder, so it cannot be archived.",
  failed: "This call did not run. Swarm could not move the paths to the archive; nothing was deleted.",
}

function refuse(reason: Refusal, rel?: string): Result {
  return { ok: false, reason, path: rel && posix(rel), message: MESSAGES[reason] }
}

export * as Archive from "./archive"
