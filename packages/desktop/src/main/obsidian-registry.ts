import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import path from "node:path"

// 1.2.10 P1 (01a_spec_obsidian_register.md §3.1; C12, C17, C29). Before "Open graph in Obsidian" launches, desktop main
// reads Obsidian's vault list and decides by real path whether a listed vault already contains the hub note. Only
// desktop main calls this module; `configDir` is always given by the caller (ipc.ts is the only place that knows the
// real folder). The module has no logger, returns only `{ result, reason? }` (never a path), never reads an error's
// text, and never throws to the handler.
//
// Row 42 (AC-P1a): S1 (lstat, odd file, size cap), S2 (one no-follow descriptor read with the inode check and
// cap + 1 bytes; S10-02(P1), S2 half), parse, S3 (N1 containment). Rows 43 and 44 add S4-S13 (refusal rules, the
// closed check, the atomic write) in this file under lock DK-obsidian-registry.

/** N10-134 */
const OBSIDIAN_REGISTRY_FILE = "obsidian.json"
/** N10-138: 1 MiB. A larger file is refused (`registry-too-large`). */
const OBSIDIAN_REGISTRY_MAX_BYTES = 1_048_576

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

async function runStep(input: ObsidianRegistryInput): Promise<ObsidianRegistryStep> {
  // S1: the handler already proved the hub note under <vault>/swarm-memory/; it is compared as a real path. The real
  // vault root (R) is first needed by the S4 rules (row 44).
  const hub = await realpath(input.hubPath)
  const snapshot = await readRegistry(path.join(input.configDir, OBSIDIAN_REGISTRY_FILE))
  if (snapshot.kind === "refused") return notRegistered(snapshot.reason)

  // S3, rule N1: a listed vault that contains the hub note opens it as it is (no closed check, no write; C17 D-3).
  const listed = snapshot.kind === "file" ? await listedVaultPaths(snapshot.parsed) : []
  if (listed.some((vault) => hub.startsWith(vault + "/"))) return { result: "in-vault" }

  // S4-S13 (rows 43 and 44): refusal rules N2-N5, the two-signal closed check, the atomic write. Until they land the
  // step consults the closed check once and writes nothing.
  await input.runLsappinfo().catch(() => undefined)
  return notRegistered("registry-write")
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
