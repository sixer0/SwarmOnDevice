// Pairing store of the office bridge (row 54, plan M4-01). Register rev 5 §5 "Pairing store file/schema", "Pairing idle
// expiry", "Invalid pairing store"; server-delta spec §11.3; security spec SC-12, SC-16, SC-18; decision C12 OQ-T5.
//
// `<dataDir>/pairings.json`, mode 0600 in a 0700 directory, written temp-then-rename so a crash between the two steps
// leaves the previous file intact. Only `sha256:<hex>` of a token is stored; the plaintext never touches disk or a log
// line (SC-19). One entry per host: pairing again replaces that host's entry (SC-16). Electron-free (TS-RC-2).
import { createHash, timingSafeEqual } from "node:crypto"
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { OFFICE_PAIR_IDLE_DAYS } from "@swarm/office-addin/constants"
import { OFFICE_HOSTS, type OfficeHost } from "./protocol"

export const PAIRING_STORE_VERSION = 1
export const PAIRING_STORE_FILE = "pairings.json"
export const PAIRING_IDLE_MS = OFFICE_PAIR_IDLE_DAYS * 24 * 60 * 60 * 1000

export type PairingEntry = {
  host: OfficeHost
  /** `sha256:` plus 64 lowercase hex characters of the full token. */
  hash: string
  createdAt: string
  lastUsedAt: string
}

/** Structured log sink. Fields never carry a token, a hash or file contents. */
export type PairingStoreLog = (event: string, fields: Record<string, string | number>) => void

export type PairingStoreOptions = {
  /** `<userData>/office-addin`. Created with mode 0700 when missing; an existing directory must not be group/other accessible. */
  dir: string
  log: PairingStoreLog
  /** Injected clock (tests); defaults to the wall clock. */
  now?: () => Date
}

/** Thrown by `load()` when the data directory is accessible to group or other (SC-12, register §7.6 DATA_DIR_UNSAFE). */
export class PairingStoreDirUnsafeError extends Error {
  readonly code = "DATA_DIR_UNSAFE"
  constructor(readonly mode: number) {
    super(`office-addin data directory mode ${mode.toString(8)} is not 0700`)
  }
}

export function pairingsPath(dir: string) {
  return join(dir, PAIRING_STORE_FILE)
}

export function hashToken(token: string) {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`
}

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/
const ENTRY_KEYS = ["createdAt", "hash", "host", "lastUsedAt"].join()

const isIsoDate = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value

const isEntry = (value: unknown): value is PairingEntry => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    Object.keys(record).sort().join() === ENTRY_KEYS &&
    OFFICE_HOSTS.includes(record.host as OfficeHost) &&
    typeof record.hash === "string" &&
    HASH_PATTERN.test(record.hash) &&
    isIsoDate(record.createdAt) &&
    isIsoDate(record.lastUsedAt)
  )
}

/** Parses the file body. Anything but a well-formed v1 store (one entry per host) returns undefined. */
function parseStore(text: string) {
  const data = (() => {
    try {
      return JSON.parse(text) as unknown
    } catch {
      return undefined
    }
  })()
  if (typeof data !== "object" || data === null || Array.isArray(data)) return
  const record = data as Record<string, unknown>
  if (Object.keys(record).sort().join() !== "pairings,version") return
  if (record.version !== PAIRING_STORE_VERSION) return
  if (!Array.isArray(record.pairings)) return
  const entries = record.pairings.filter(isEntry)
  if (entries.length !== record.pairings.length) return
  if (new Set(entries.map((entry) => entry.host)).size !== entries.length) return
  return entries
}

export function createPairingStore(options: PairingStoreOptions) {
  const now = options.now ?? (() => new Date())
  const path = pairingsPath(options.dir)
  const entries = new Map<OfficeHost, PairingEntry>()
  // Writes run one after another so a later state never lands before an earlier one.
  const queue = { tail: Promise.resolve() }
  // Bumped by clear(): a load() that started earlier discards what it read, so a clear issued during a load wins (F-1).
  const generation = { value: 0 }

  const idle = (entry: PairingEntry) => now().getTime() - Date.parse(entry.lastUsedAt) > PAIRING_IDLE_MS

  const persist = () => {
    const body = `${JSON.stringify({ version: PAIRING_STORE_VERSION, pairings: [...entries.values()] }, null, 2)}\n`
    const run = queue.tail.then(async () => {
      await mkdir(options.dir, { recursive: true, mode: 0o700 })
      const temp = `${path}.${process.pid}.tmp`
      await writeFile(temp, body, { mode: 0o600 })
      await chmod(temp, 0o600)
      await rename(temp, path)
    })
    // Keep the queue alive after a failed write; the caller still sees the rejection.
    queue.tail = run.catch(() => undefined)
    return run
  }

  const dropIdle = () => {
    const expired = [...entries.values()].filter(idle)
    expired.forEach((entry) => {
      entries.delete(entry.host)
      options.log("pairing-expired", { host: entry.host, lastUsedAt: entry.lastUsedAt })
    })
    return expired.length
  }

  // Compares against every non-idle entry in constant time per entry, with no early exit. Pure: reads memory only.
  const match = (token: string) => {
    const candidate = Buffer.from(hashToken(token), "utf8")
    return [...entries.values()].reduce<PairingEntry | undefined>((found, entry) => {
      const stored = Buffer.from(entry.hash, "utf8")
      const equal = stored.length === candidate.length && timingSafeEqual(stored, candidate)
      return equal && !idle(entry) ? entry : found
    }, undefined)
  }

  const quarantine = async (reason: string) => {
    const target = `${path}.invalid-${now().toISOString()}`
    await rename(path, target)
    options.log("pairing-store-invalid", { reason, renamedTo: target })
  }

  return {
    path,

    /** Reads the file: missing gives empty; corrupt or unknown version is renamed aside and gives empty (C12 OQ-T5); idle entries are dropped (SC-18). */
    async load() {
      const started = generation.value
      entries.clear()
      const dirStat = await stat(options.dir).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (dirStat && (dirStat.mode & 0o077) !== 0) throw new PairingStoreDirUnsafeError(dirStat.mode & 0o777)
      if (!dirStat) await mkdir(options.dir, { recursive: true, mode: 0o700 })
      const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      // A clear() ran while this load was reading: the cleared state stands (F-1).
      if (text === undefined || generation.value !== started) return
      const parsed = parseStore(text)
      if (!parsed) {
        await quarantine("corrupt-or-unknown-version")
        return
      }
      parsed.forEach((entry) => entries.set(entry.host, entry))
      if (dropIdle() > 0) await persist()
    },

    list() {
      return [...entries.values()].map((entry) => ({ ...entry }))
    },

    /** Stores the hash of a freshly issued token for `host`, replacing that host's entry (SC-16). */
    async put(host: OfficeHost, token: string) {
      const at = now().toISOString()
      entries.set(host, { host, hash: hashToken(token), createdAt: at, lastUsedAt: at })
      await persist()
    },

    /**
     * Read-only token check for every `/swarm/*` request (C35). Same constant-time compare as `verify`; an idle entry
     * (SC-18) never matches. Never writes: no `lastUsedAt` update, no file I/O, the in-memory set is not changed.
     */
    lookup(token: string) {
      return match(token)?.host
    },

    /**
     * Token check for `GET /pair/verify` ONLY (spec §11.3: the only writer of `lastUsedAt`). Same compare as `lookup`;
     * idle entries are dropped and persisted first, and a match updates `lastUsedAt` and rewrites the file. Do not use
     * it for `/swarm/*` requests, which would rewrite `pairings.json` per request; use `lookup` there.
     */
    async verify(token: string) {
      if (dropIdle() > 0) await persist()
      const found = match(token)
      if (!found) return
      const at = now().toISOString()
      entries.set(found.host, { ...found, lastUsedAt: at })
      await persist()
      return found.host
    },

    /** Removes the entry holding this token's hash, if any (pairing request expired unread, spec §11.2 step 4). */
    async revoke(token: string) {
      const hash = hashToken(token)
      const entry = [...entries.values()].find((item) => item.hash === hash)
      if (!entry) return false
      entries.delete(entry.host)
      await persist()
      return true
    },

    /** Disconnect (`pairings-cleared`, SC-16): empties the set and writes an empty store. */
    async clear() {
      generation.value += 1
      entries.clear()
      await persist()
      options.log("pairings-cleared", {})
    },
  }
}

export type PairingStore = ReturnType<typeof createPairingStore>
