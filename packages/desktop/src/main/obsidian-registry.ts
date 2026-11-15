import { createHash, randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises"
import path from "node:path"

// 1.2.10 P1 (01a_spec_obsidian_register.md §3.1; C12, C17, C29). Before "Open graph in Obsidian" launches, desktop main
// reads Obsidian's vault list and decides by real path whether a listed vault already contains the hub note. Only
// desktop main calls this module; `configDir` is always given by the caller (ipc.ts is the only place that knows the
// real folder). The module has no logger, returns only `{ result, reason? }` (never a path), never reads an error's
// text, and never throws to the handler.
//
// Row 42 (AC-P1a): S1 (lstat, odd file, size cap), S2 (one no-follow descriptor read with the inode check and
// cap + 1 bytes; S10-02(P1), S2 half), parse, S3 (N1 containment).
// Row 43 (AC-P1b, AC-P1e): S5 (data folder), S7 (own-property build, S10-13), S8 (tmp file, fchmod, S10-05), S9 (the
// unchanged-file re-check, S10-02(P1) S9 half), S10 (one-time backup), S11 (rename), S12 (re-read confirm).
// Row 44 adds S4 (rules N2-N5), the two-signal closed check (S6 and its S9 repeat), the deadline and the tmp re-read
// in this file under lock DK-obsidian-registry.

/** N10-134 */
const OBSIDIAN_REGISTRY_FILE = "obsidian.json"
/** N10-135: one copy of the list as it was before Swarm's first write, beside it; flag `wx`, never overwritten. */
const OBSIDIAN_REGISTRY_BACKUP = "obsidian.json.swarm-backup"
/** N10-138: 1 MiB. A larger file is refused (`registry-too-large`). */
const OBSIDIAN_REGISTRY_MAX_BYTES = 1_048_576
/** N10-139: mode of a list Swarm creates, and of the Obsidian data folder it creates (only with an app present). */
const REGISTRY_FILE_MODE = 0o600
const REGISTRY_DIR_MODE = 0o700
/** N10-140: a vault id as Obsidian makes it. */
const VAULT_ID_PATTERN = /^[0-9a-f]{16}$/
/** Attempts to draw an id that is well formed and not already a key of `vaults` (N10-140 "regenerated"). */
const VAULT_ID_ATTEMPTS = 32
/** `wx` without following a link at the name: O_CREAT | O_EXCL already refuses an existing link (EEXIST). */
const CREATE_NEW = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW

/** N10-026: the 11 shipped literals (`nested-parent` is reserved and not shipped, 01a RN-1). */
type ObsidianRegistryReason =
  | "obsidian-running"
  | "obsidian-unsure"
  | "registry-malformed"
  | "registry-too-large"
  | "registry-odd-file"
  | "nested-child"
  | "alias-case"
  | "unsafe-root"
  | "registry-changed"
  | "registry-verify"
  | "registry-write"

/** N10-025 */
type ObsidianRegistryStep = {
  result: "in-vault" | "registered" | "close-obsidian" | "not-registered"
  reason?: ObsidianRegistryReason
}

type LsappinfoResult = { code: number; stdout: string }

/** N10-029. `configDir` is required and has no default anywhere in this module. */
type ObsidianRegistryInput = {
  configDir: string
  vaultRoot: string
  hubPath: string
  appPresent: boolean
  runLsappinfo: () => Promise<LsappinfoResult>
  now?: () => number
  randomId?: () => string
  beforeRename?: () => Promise<void>
}

/** What S1 and S2 saw; the S9 re-check (row 43) compares the file against it before the rename. */
type RegistrySnapshot =
  | { kind: "refused"; reason: ObsidianRegistryReason }
  | { kind: "missing" }
  | {
      kind: "file"
      dev: number
      ino: number
      mode: number
      mtimeMs: number
      size: number
      sha256: string
      bytes: Buffer
      parsed: Record<string, unknown>
    }

const notRegistered = (reason: ObsidianRegistryReason): ObsidianRegistryStep => ({ result: "not-registered", reason })

/** Only the `code` field of an error is ever read (S10-10: never its message, path or string form). */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !Object.hasOwn(error, "code")) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const UTF8_BOM = [0xef, 0xbb, 0xbf]

/** S2 parse: empty, BOM, invalid UTF-8, invalid JSON, a non-object root or a non-object `vaults` are malformed. */
function parseRegistry(bytes: Buffer): Record<string, unknown> | undefined {
  if (bytes.length === 0) return undefined
  if (UTF8_BOM.every((b, i) => bytes[i] === b)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    return undefined
  }
  if (!isPlainObject(parsed)) return undefined
  if (Object.hasOwn(parsed, "vaults") && !isPlainObject(parsed.vaults)) return undefined
  return parsed
}

/**
 * S1 + S2. `lstat` (never `stat`), then one descriptor opened with O_RDONLY | O_NOFOLLOW | O_NONBLOCK whose `fstat`
 * must show a regular file with the same `dev` and `ino` and a size within the cap; at most cap + 1 bytes are read
 * (S10-02(P1), S2 half). A missing file is `{ kind: "missing" }` (S5 creates it).
 */
async function readRegistry(file: string): Promise<RegistrySnapshot> {
  let before: Awaited<ReturnType<typeof lstat>>
  try {
    before = await lstat(file)
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "missing" }
    return { kind: "refused", reason: "registry-odd-file" }
  }
  if (!before.isFile()) return { kind: "refused", reason: "registry-odd-file" }
  if (before.size > OBSIDIAN_REGISTRY_MAX_BYTES) return { kind: "refused", reason: "registry-too-large" }

  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    // ELOOP (a link swapped in after the lstat), ENOENT (removed in between) or any other open error.
    return { kind: "refused", reason: "registry-odd-file" }
  }
  try {
    const seen = await handle.stat()
    if (!seen.isFile() || seen.dev !== before.dev || seen.ino !== before.ino) {
      return { kind: "refused", reason: "registry-odd-file" }
    }
    if (seen.size > OBSIDIAN_REGISTRY_MAX_BYTES) return { kind: "refused", reason: "registry-too-large" }
    const buffer = Buffer.alloc(OBSIDIAN_REGISTRY_MAX_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > OBSIDIAN_REGISTRY_MAX_BYTES) return { kind: "refused", reason: "registry-too-large" }
    const bytes = Buffer.from(buffer.subarray(0, length))
    const parsed = parseRegistry(bytes)
    if (!parsed) return { kind: "refused", reason: "registry-malformed" }
    return {
      kind: "file",
      dev: seen.dev,
      ino: seen.ino,
      mode: seen.mode,
      mtimeMs: seen.mtimeMs,
      size: length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes,
      parsed,
    }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/**
 * The real path of each listed vault. Only entries whose `path` is an absolute string count (S10-13). An entry is
 * resolved with `realpath` (on-disk case, links followed, trailing `/` dropped) unless its lexical form is under
 * `/Volumes/` (S10-03(P1): a removable or network volume is never touched), or when `realpath` fails; then it is the
 * lexical form.
 */
async function listedVaultPaths(parsed: Record<string, unknown>): Promise<string[]> {
  const vaults = Object.hasOwn(parsed, "vaults") ? parsed.vaults : undefined
  if (!isPlainObject(vaults)) return []
  const out: string[] = []
  for (const key of Object.keys(vaults)) {
    const entry = vaults[key]
    if (!isPlainObject(entry) || !Object.hasOwn(entry, "path")) continue
    const stored = entry.path
    if (typeof stored !== "string" || !path.isAbsolute(stored)) continue
    const lexical = path.resolve(stored)
    if (lexical === "/Volumes" || lexical.startsWith("/Volumes/")) {
      out.push(lexical)
      continue
    }
    out.push(await realpath(stored).catch(() => lexical))
  }
  return out
}

/** Parsed-equal for JSON values: own keys only (a parsed `"__proto__"` key is an own key), order ignored. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => sameJson(item, b[i]))
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
}

/** An own, enumerable data property: never a setter call, so a parsed `"__proto__"` key stays a plain key (S10-13). */
function putOwn(target: Record<string, unknown>, key: string, value: unknown) {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true })
}

/** S7 id: well formed (N10-140) and not an existing key (`Object.hasOwn`, S10-13); undefined if none is found. */
function freshVaultId(vaults: Record<string, unknown>, randomId: () => string): string | undefined {
  for (let attempt = 0; attempt < VAULT_ID_ATTEMPTS; attempt++) {
    const id = randomId()
    if (typeof id === "string" && VAULT_ID_PATTERN.test(id) && !Object.hasOwn(vaults, id)) return id
  }
  return undefined
}

/**
 * S7. The parsed object itself gets the new entry (it is never copied, S10-13): `vaults` is added if absent, then
 * one fresh `{ path, ts }` object (exactly these keys, N10-030) under a new id, both as own-property writes.
 */
function addEntry(parsed: Record<string, unknown>, id: string, entry: { path: string; ts: number }) {
  if (!Object.hasOwn(parsed, "vaults")) putOwn(parsed, "vaults", {})
  putOwn(parsed.vaults as Record<string, unknown>, id, { path: entry.path, ts: entry.ts })
  return parsed
}

/** Writes all bytes through an open descriptor. */
async function writeAll(handle: Awaited<ReturnType<typeof open>>, bytes: Buffer) {
  let offset = 0
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset)
    offset += bytesWritten
  }
}

/**
 * Creates `file` (flag `wx`, no link followed), sets its mode with `fchmod` so the umask cannot change it
 * (S10-05(P1)), writes `bytes` and `fsync`s it. On a failure after the create the half-written file is removed.
 */
async function writeNewFile(file: string, bytes: Buffer, mode: number) {
  const handle = await open(file, CREATE_NEW, mode)
  try {
    await handle.chmod(mode)
    await writeAll(handle, bytes)
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => undefined)
    await unlink(file).catch(() => undefined)
    throw error
  }
  await handle.close()
}

/**
 * S9, unchanged-file half (S10-02(P1), S9 half): the S1 checks are repeated in full through the same reader (regular
 * file, not a link, size cap, one no-follow descriptor with the same `dev` and `ino`), then `mtimeMs`, `size` and
 * `sha256` are compared with S1/S2. A missing file must still be missing.
 */
async function unchangedSince(file: string, snapshot: Exclude<RegistrySnapshot, { kind: "refused" }>) {
  if (snapshot.kind === "missing") {
    try {
      await lstat(file)
      return false
    } catch (error) {
      return errorCode(error) === "ENOENT"
    }
  }
  const now = await readRegistry(file)
  return (
    now.kind === "file" &&
    now.dev === snapshot.dev &&
    now.ino === snapshot.ino &&
    now.mtimeMs === snapshot.mtimeMs &&
    now.size === snapshot.size &&
    now.sha256 === snapshot.sha256
  )
}

/** S5: the data folder exists, or is created (0700, non-recursive: its parent must exist) only with an app present. */
async function ensureConfigDir(configDir: string, appPresent: boolean): Promise<boolean> {
  try {
    const seen = await lstat(configDir)
    return seen.isDirectory()
  } catch (error) {
    if (errorCode(error) !== "ENOENT" || !appPresent) return false
  }
  try {
    await mkdir(configDir, { mode: REGISTRY_DIR_MODE })
    await chmod(configDir, REGISTRY_DIR_MODE)
    return true
  } catch {
    return false
  }
}

/**
 * S6 stand-in until row 44 adds the two-signal closed check (lsappinfo + SingletonLock, its time bound and the
 * `close-obsidian` reasons): only "exit 0, empty output" may write. Anything else writes nothing (RN-3 stub).
 */
async function closedStandIn(input: ObsidianRegistryInput): Promise<boolean> {
  const seen = await input.runLsappinfo().catch(() => undefined)
  return seen !== undefined && seen.code === 0 && seen.stdout === ""
}

async function runStep(input: ObsidianRegistryInput): Promise<ObsidianRegistryStep> {
  // S1: the handler already proved the hub note under <vault>/swarm-memory/; both are compared as real paths
  // (native realpath: on-disk case, links resolved; the written `path`, N10-030).
  const root = await realpath(input.vaultRoot)
  const hub = await realpath(input.hubPath)
  const registryFile = path.join(input.configDir, OBSIDIAN_REGISTRY_FILE)
  const snapshot = await readRegistry(registryFile)
  if (snapshot.kind === "refused") return notRegistered(snapshot.reason)

  // S3, rule N1: a listed vault that contains the hub note opens it as it is (no closed check, no write; C17 D-3).
  const listed = snapshot.kind === "file" ? await listedVaultPaths(snapshot.parsed) : []
  if (listed.some((vault) => hub.startsWith(vault + "/"))) return { result: "in-vault" }

  // S4 (row 44): rules N5, N4, N2.

  // S5: the Obsidian data folder (C17 D-5).
  if (!(await ensureConfigDir(input.configDir, input.appPresent))) return notRegistered("registry-write")

  // S6: closed check 1.
  if (!(await closedStandIn(input))) return notRegistered("registry-write")

  // S7: the new list. A missing file becomes `{"vaults":{"<id>":{"path":R,"ts":<ms>}}}` (C17 Q1-3).
  const target = snapshot.kind === "file" ? snapshot.parsed : {}
  const existing = Object.hasOwn(target, "vaults") ? (target.vaults as Record<string, unknown>) : {}
  const id = freshVaultId(existing, input.randomId ?? (() => randomBytes(8).toString("hex")))
  if (id === undefined) return notRegistered("registry-write")
  const ts = (input.now ?? Date.now)()
  if (typeof ts !== "number" || !Number.isFinite(ts)) return notRegistered("registry-write")
  const bytes = Buffer.from(JSON.stringify(addEntry(target, id, { path: root, ts })), "utf8")
  if (bytes.length > OBSIDIAN_REGISTRY_MAX_BYTES) return notRegistered("registry-write")
  const mode = snapshot.kind === "file" ? snapshot.mode & 0o777 : REGISTRY_FILE_MODE

  // S8: tmp file beside the list (N10-136), flag `wx`, fchmod, fsync. From here on every path that does not rename
  // removes the tmp file (finally below).
  const tmp = path.join(input.configDir, `${OBSIDIAN_REGISTRY_FILE}.swarm-${process.pid}-${randomBytes(8).toString("hex")}.tmp`)
  let tmpExists = false
  try {
    try {
      await writeNewFile(tmp, bytes, mode)
      tmpExists = true
    } catch {
      return notRegistered("registry-write")
    }

    // S9: the test seam, then the unchanged-file check (row 44 adds closed check 2 and the tmp re-read here).
    await input.beforeRename?.()
    if (!(await unchangedSince(registryFile, snapshot))) return notRegistered("registry-changed")

    // S10: the one-time backup of the bytes read in S2, with the original's mode. A backup (or anything else, a
    // link included) already at that name is kept as it is (EEXIST); it is never overwritten or followed.
    if (snapshot.kind === "file") {
      try {
        await writeNewFile(path.join(input.configDir, OBSIDIAN_REGISTRY_BACKUP), snapshot.bytes, mode)
      } catch (error) {
        if (errorCode(error) !== "EEXIST") return notRegistered("registry-write")
      }
    }

    // S11: the atomic replace. After it nothing is written, unlinked, chmod-ed or renamed again (S10-15(P1)).
    try {
      await rename(tmp, registryFile)
      tmpExists = false
    } catch {
      return notRegistered("registry-write")
    }
  } finally {
    if (tmpExists) await unlink(tmp).catch(() => undefined)
  }

  // S12: re-read through the S1/S2 reader and confirm: the new entry is exactly `{ path: R, ts }` under the new id and
  // every other key and entry is parsed-equal to what S2 read.
  const after = await readRegistry(registryFile)
  if (after.kind !== "file") return notRegistered("registry-verify")
  const expected = addEntry(snapshot.kind === "file" ? (parseRegistry(snapshot.bytes) ?? {}) : {}, id, { path: root, ts })
  if (!sameJson(after.parsed, expected)) return notRegistered("registry-verify")

  // S13
  return { result: "registered" }
}

// One press at a time across windows: every call waits for the previous one. The chain never rejects (S10-10).
let queue: Promise<unknown> = Promise.resolve()

/**
 * N10-024: the registry step of "Open graph in Obsidian". Returns `in-vault` when a listed vault already contains
 * the hub note; otherwise the later steps decide. Any unexpected error is `not-registered` / `registry-write`.
 * Production reader: `external-url.ts` (row 45). Until that row lands only the P1 tests read it, so the export guard
 * reads it through the marker below; the marker stops counting once the production reader exists.
 * @internal test seam
 */
export function ensureObsidianVault(input: ObsidianRegistryInput): Promise<ObsidianRegistryStep> {
  const step = queue.then(() => runStep(input)).catch((): ObsidianRegistryStep => notRegistered("registry-write"))
  queue = step.catch(() => undefined)
  return step
}
