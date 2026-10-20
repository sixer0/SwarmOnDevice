// Redacting setup.log writer (register PC-PATH-05 = ~/.swarm/setup/setup.log, mode
// 0600 in the 0700 setup dir). This is row 84's single home for the P-8 promise
// ("secrets ... never echoed, redacted in setup.log", 01c §12 / 03e:185): every line
// that reaches this file passes one redactor, so a step author cannot leak a token by
// forgetting to scrub it themselves. It is a LIBRARY/service (like fetch/verify/provenance),
// not a scanned step — steps call kit.log(), which calls writeSetupLog() here.
//
// Three independent redaction layers, applied in order (defence in depth, P-8):
//   1. STRUCTURAL — any object key whose normalised name looks like a secret
//      (SEARXNG_SECRET, *_PASSWORD, *_TOKEN, BULL_AUTH_KEY, FIRECRAWL_API_KEY, ...) has
//      its value replaced before the record is ever serialised. This is what makes the
//      register's secret inventory (PC-ENV-V01..V06) safe even if a step passes the whole
//      env object into `context`.
//   2. REGISTERED LITERALS — a step that GENERATES a secret (openssl rand) calls
//      registerSecretValue(v) once; every later line scrubs that exact value wherever it
//      appears, including inside a free-text message or a command echo.
//   3. SHAPES — bearer/token/basic/digest credential headers, a bare `Authorization:`
//      value, and the non-interactive term-token shape `<component_id>@<lock_sha256_12>`
//      (01d §6.1) are redacted by pattern even when unregistered. The term token is public
//      text (consent.ts decision 6), but P-8 says "never echoed", so it is scrubbed here too.
//
// Durability: each line is appended with O_APPEND and fsync'd before returning, so the log
// survives a crash the same way consent.log does (row 83 decision 5). Unlike state.json it
// is NOT a commit point — a lost last line is a missing audit entry, never a corrupt machine.
// Size cap + rotation keeps the file bounded (row-84 design choice; the register fixes no
// cap, only mode 0600). Every rotated file is created 0600.

import { existsSync, openSync, writeSync, fsyncSync, closeSync, statSync, renameSync, rmSync } from "node:fs"
import { MODES } from "./constants.ts"
import { setupLog, ensureParent } from "./paths.ts"

export type LogLevel = "info" | "warn" | "error"

export interface LogRecord {
  readonly level: LogLevel
  /** Module + function, e.g. "swarm-setup.node.install". */
  readonly source: string
  readonly message: string
  readonly component?: string
  /** Free-form structured context. Secret-named keys are redacted structurally (layer 1). */
  readonly context?: Record<string, unknown>
  /** Per-run trace id so a line can be tied to a run across the log (global-rules field). */
  readonly correlationId?: string
  /** ISO-8601 timestamp; defaults to now. Injectable for deterministic tests. */
  readonly ts?: string
}

export interface SetupLogOptions {
  /** Destination path; defaults to PC-PATH-05 via paths.setupLog(). Tests point this at a temp file. */
  readonly path?: string
  /** Rotate once the file would exceed this many bytes. Default 1 MiB. */
  readonly maxBytes?: number
  /** How many rotated generations to keep (setup.log.1 .. .maxRotations). Default 3. */
  readonly maxRotations?: number
  /** --dry-run posture (PC-FLAG-03): compute + return the redacted line, write NOTHING. */
  readonly dryRun?: boolean
}

const REDACTED = "[REDACTED]"
const DEFAULT_MAX_BYTES = 1024 * 1024 // 1 MiB
const DEFAULT_MAX_ROTATIONS = 3

/** Register secret inventory (PC-ENV-V01..V06 + D-04/D-22 optional secrets), normalised. */
const EXPLICIT_SECRET_KEYS: ReadonlySet<string> = new Set([
  "SEARXNG_SECRET",
  "POSTGRES_PASSWORD",
  "BULL_AUTH_KEY",
  "FIRECRAWL_API_KEY",
  "PROXY_TOKEN",
  "FIRECRAWL_PROXY_TOKEN",
  "REDIS_AUTH",
  "VALKEY_AUTH",
  "RABBITMQ_PASSWORD",
])

/** Name fragments that mark a key as carrying a secret (matched on word boundaries). */
const SECRET_KEY_TOKENS = [
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "TOKEN",
  "API_KEY",
  "AUTH_KEY",
  "ACCESS_KEY",
  "PRIVATE_KEY",
  "SIGNING_KEY",
  "CLIENT_SECRET",
  "CREDENTIAL",
] as const

function normaliseKey(key: string): string {
  return key.toUpperCase().replace(/[^A-Z0-9]/g, "_")
}

/** True when a key name denotes a secret value (structural layer). */
export function keyIsSecret(key: string): boolean {
  const k = normaliseKey(key)
  if (EXPLICIT_SECRET_KEYS.has(k)) return true
  return SECRET_KEY_TOKENS.some((t) => k === t || k.endsWith(`_${t}`) || k.startsWith(`${t}_`) || k.includes(`_${t}_`))
}

// --- layer 2 registry ---------------------------------------------------------------

const registeredSecrets: string[] = []

/** Register a freshly-generated secret value so every later line scrubs it verbatim.
 *  Values shorter than 4 chars are ignored (they would redact ordinary words). */
export function registerSecretValue(value: string): void {
  if (typeof value === "string" && value.length >= 4 && !registeredSecrets.includes(value)) {
    registeredSecrets.push(value)
  }
}

/** Drop all registered literals. Used by tests for isolation; not called by shipped code. */
export function clearRegisteredSecrets(): void {
  registeredSecrets.length = 0
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// --- layer 3 shapes -----------------------------------------------------------------

// bearer / token / basic / digest credential (with or without a leading Authorization:).
const CRED_SCHEME_RE = /(\b(?:authorization\s*[=:]\s*)?\b(?:bearer|token|basic|digest)\s+)([A-Za-z0-9._~+/=-]+)/gi
// a bare `Authorization: <opaque>` with no recognised scheme.
const AUTH_BARE_RE = /(\bauthorization\s*[=:]\s*)(?!bearer|token|basic|digest)([^\s"',}]+)/gi
// non-interactive term-token shape: <lowercase-id>@<12 hex> (01d §6.1).
const TERM_TOKEN_RE = /\b[a-z][a-z0-9]*@[0-9a-f]{12}\b/gi
// inline env-style secret assignment inside free text: NAME=... or NAME: ... where NAME ends in a secret suffix.
const INLINE_SECRET_RE =
  /\b([A-Z][A-Z0-9_]*_(?:SECRET|PASSWORD|PASSWD|TOKEN|API_KEY|AUTH_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)|SEARXNG_SECRET|BULL_AUTH_KEY)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;}\]"']+)/g
// M5 (senior review 107): the two OPTIONAL auth secrets REDIS_AUTH / VALKEY_AUTH are in the
// structural EXPLICIT set but were not matched in free text (the catch-all above has _AUTH_KEY,
// not a bare _AUTH). We deliberately do NOT widen the catch-all with `_AUTH`, because that would
// also redact legitimate *path* references such as `REDIS_AUTH=/run/secrets/redis_auth`. Instead we
// match the env/file NAME only when it is followed by a HEX-ONLY VALUE — the §4.6 generation
// alphabet (`openssl rand -hex`), so the secret is scrubbed while mount paths and artifact digests
// (sha256:<hex>, which is never preceded by an auth name) survive. This is the "pattern on VALUES,
// not just keys" half of the fix; it complements registerSecret(), which the future secret-generating
// owner (rows 86-90) must call so a bare value is caught even without its name nearby.
const HEX_AUTH_VALUE_RE = /\b(REDIS_AUTH|VALKEY_AUTH)(\s*[=:]\s*)("?)([0-9a-f]{16,})\3/gi

function redactShapes(s: string): string {
  let out = s
  for (const lit of registeredSecrets) {
    out = out.replace(new RegExp(escapeForRegex(lit), "g"), REDACTED)
  }
  out = out.replace(
    INLINE_SECRET_RE,
    (_m, key: string, sep: string, val: string) =>
      `${key}${sep}${val[0] === '"' || val[0] === "'" ? `${val[0]}${REDACTED}${val[0]}` : REDACTED}`,
  )
  // REDIS_AUTH / VALKEY_AUTH hex values (M5). Key-anchored + hex-shaped so path refs survive.
  out = out.replace(
    HEX_AUTH_VALUE_RE,
    (_m, name: string, sep: string, quote: string) => `${name}${sep}${quote}${REDACTED}${quote}`,
  )
  // Term-token BEFORE the credential-scheme rule: otherwise a sentence like "token
  // node@deadbeefcafe" is half-eaten by the scheme matcher (which stops at the '@'),
  // leaving an "@deadbeefcafe" residue the term-token rule could no longer match whole.
  out = out.replace(TERM_TOKEN_RE, REDACTED)
  out = out.replace(CRED_SCHEME_RE, (_m, prefix: string) => `${prefix}${REDACTED}`)
  out = out.replace(AUTH_BARE_RE, (_m, prefix: string) => `${prefix}${REDACTED}`)
  return out
}

// --- layer 1 structural -------------------------------------------------------------

function redactStructure(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactStructure)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = keyIsSecret(k) ? REDACTED : redactStructure(v)
    }
    return out
  }
  return value
}

/**
 * Redact a raw string with every layer that applies to free text (registered literals,
 * inline secret assignments, credential headers, term-token shape). Exported so the row-84
 * proof can show a before/after pair directly. Structural key redaction lives in
 * writeSetupLog (it needs the object), but any secret already flattened into a string is
 * caught here too via the inline + shape rules.
 */
export function redact(input: string): string {
  return redactShapes(input)
}

/** Serialise a record to one redacted JSON line (no trailing newline). Pure: writes nothing. */
export function formatLine(rec: LogRecord): string {
  const safeContext = rec.context ? (redactStructure(rec.context) as Record<string, unknown>) : undefined
  const record: Record<string, unknown> = {
    ts: rec.ts ?? new Date().toISOString(),
    level: rec.level,
    source: rec.source,
    ...(rec.component ? { component: rec.component } : {}),
    message: rec.message,
    ...(safeContext ? { context: safeContext } : {}),
    ...(rec.correlationId ? { correlationId: rec.correlationId } : {}),
  }
  // Layer 1 handled secret-named context keys; layers 2-3 scrub anything left in the
  // serialised text (free-text messages, stray dumps, generated values).
  return redactShapes(JSON.stringify(record))
}

function currentSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** Shift setup.log -> .1 -> .2 ... dropping the oldest generation past maxRotations. */
function rotate(path: string, maxRotations: number): void {
  rmSync(`${path}.${maxRotations}`, { force: true })
  for (let n = maxRotations - 1; n >= 1; n--) {
    const from = `${path}.${n}`
    if (existsSync(from)) renameSync(from, `${path}.${n + 1}`)
  }
  if (existsSync(path)) renameSync(path, `${path}.1`)
}

function appendDurable(path: string, data: string): void {
  ensureParent(path)
  const fd = openSync(path, "a", MODES.FILE_0600)
  try {
    writeSync(fd, new TextEncoder().encode(data))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * Append one structured, redacted line to setup.log (PC-PATH-05). Returns the exact line
 * written (or the line that WOULD be written under dryRun) so callers/tests can inspect it.
 * Under dryRun nothing touches the filesystem. Rotation is checked against the incoming
 * line length so a single oversized line still triggers a roll rather than blowing the cap.
 */
export function writeSetupLog(rec: LogRecord, opts: SetupLogOptions = {}): string {
  const line = formatLine(rec)
  if (opts.dryRun) return line

  const path = opts.path ?? setupLog()
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const maxRotations = opts.maxRotations ?? DEFAULT_MAX_ROTATIONS
  if (currentSize(path) + line.length + 1 > maxBytes) rotate(path, maxRotations)
  appendDurable(path, `${line}\n`)
  return line
}

/** Convenience for the common info/warn/error calls used across steps. */
export function logInfo(source: string, message: string, extra: Partial<LogRecord> = {}): string {
  return writeSetupLog({ level: "info", source, message, ...extra })
}
export function logWarn(source: string, message: string, extra: Partial<LogRecord> = {}): string {
  return writeSetupLog({ level: "warn", source, message, ...extra })
}
export function logError(source: string, message: string, extra: Partial<LogRecord> = {}): string {
  return writeSetupLog({ level: "error", source, message, ...extra })
}
