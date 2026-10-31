// Secrets stay usable and stop being readable: a program the agent runs still gets the real value, and the model and
// the transcript get [hidden:NAME]. This replaces the prompt on reading .env, which people approved without thinking.
// It holds for every model, including an internal one, and is not a verdict on who runs the model: what it limits is
// what a poisoned page can make an agent repeat, and how many transcripts and logs end up holding a production key.
import fs from "node:fs"
import path from "node:path"

export const PLACEHOLDER = /\[hidden:[^\]\n]*\]/

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASS|PWD|CRED|AUTH|PRIVATE|SESSION|COOKIE|SALT)/i
const PUBLIC_NAME = /PUBLIC|PUBLISHABLE/i
const CREDENTIAL_URL = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i
const RANDOM_LOOKING = /^(?=.*[0-9])(?=.*[A-Za-z])[A-Za-z0-9+/_=.-]{20,}$/

const ENV_FILE = /^\.env([-_.]|$)|\.env$/
const ENV_EXAMPLE = /\.(example|sample|template|dist|defaults)$/
const WHOLE_FILE = /(^|\/)(id_rsa|id_ed25519|id_ecdsa|id_dsa|\.netrc|\.pgpass|\.git-credentials|credentials|service-account.*\.json|(secrets?|credentials?)\.(ya?ml|json|toml|ini))$|\.(pem|key|p12|pfx|keystore|jks)$|(^|\/)\.envs\//i

// Values that are recognisable wherever they turn up, including in a log line nobody expected them in.
const SHAPES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[hidden:private-key]"],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, "[hidden:api-key]"],
  [/\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}/g, "[hidden:api-key]"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, "[hidden:github-token]"],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/g, "[hidden:github-token]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[hidden:slack-token]"],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "[hidden:aws-key]"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "[hidden:api-key]"],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^/\s@]+(@)/gi, "$1[hidden:password]$2"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[hidden:token]"],
  [/\b(bearer\s+)[A-Za-z0-9._~+/-]{12,}/gi, "$1[hidden:token]"],
]

// SESSION_TTL=3600 or AUTH_URL=https://... under a secret-sounding name. The agent needs these to do its job.
const PLAIN = /^(\d+|true|false|https?:\/\/[^@\s]*)$/i

export function secretPair(name: string, value: string) {
  if (!value) return false
  if (CREDENTIAL_URL.test(value)) return true
  if (PUBLIC_NAME.test(name) || PLAIN.test(value)) return false
  return SECRET_NAME.test(name) || RANDOM_LOOKING.test(value)
}

const fileKind = (file: string) => {
  // Case-insensitive disks: `.ENV` opens `.env`.
  const name = file.replaceAll("\\", "/").normalize("NFC").toLowerCase()
  const base = path.basename(name)
  if (WHOLE_FILE.test(name)) return "whole" as const
  if (ENV_EXAMPLE.test(base)) return undefined
  if (ENV_FILE.test(base) || base === ".npmrc" || base === ".envrc") return "env" as const
  return undefined
}

export const secretFile = (file: string) => fileKind(file) !== undefined
export const wholeSecretFile = (file: string) => fileKind(file) === "whole"

const PAIR = /^(\s*(?:export\s+)?)([A-Za-z_./:@-][A-Za-z0-9_./:@-]*)(\s*=\s*)(.*)$/

function unquoted(value: string) {
  const text = value.trim()
  const quote = text[0]
  if ((quote === '"' || quote === "'") && text.endsWith(quote) && text.length >= 2) return text.slice(1, -1)
  return text.replace(/\s+#.*$/, "")
}

// In a connection string only the password is secret. The host and database are what an agent debugging it needs.
const urlPassword = (value: string) => (CREDENTIAL_URL.test(value) ? value.match(/:\/\/[^/\s:@]+:([^/\s@]+)@/)?.[1] : undefined)

function pairs(text: string) {
  const out: [string, string][] = []
  for (const line of text.split("\n")) {
    const match = line.match(PAIR)
    if (!match || line.trimStart().startsWith("#")) continue
    const value = unquoted(match[4])
    if (secretPair(match[2], value)) out.push([match[2], urlPassword(value) ?? value])
  }
  return out
}

// Credential files that are not `NAME=value`: `.netrc`, `.pgpass`, YAML. Only values that are known can be hidden.
function fileValues(file: string, text: string) {
  const base = path.basename(file).toLowerCase()
  const out = pairs(text)
  for (const line of text.split("\n")) {
    const yaml = line.match(/^\s*(?:-\s*)?["']?([A-Za-z_][\w.-]*)["']?\s*:\s*(\S.*)$/)
    const value = yaml ? unquoted(yaml[2]) : ""
    if (yaml && secretPair(yaml[1], value)) out.push([yaml[1], urlPassword(value) ?? value])
    for (const match of line.matchAll(/\b(password|passwd|account)\s+(\S+)/gi)) out.push([match[1], match[2]])
    const fields = line.split(":")
    if (base === ".pgpass" && fields.length === 5) out.push(["pgpass", fields[4].trim()])
  }
  return out
}

/** One line of a .env-style file, with a secret value replaced. */
export function maskLine(line: string) {
  const match = line.match(PAIR)
  if (!match || line.trimStart().startsWith("#")) return line
  const value = unquoted(match[4])
  if (!secretPair(match[2], value)) return line
  if (urlPassword(value)) return line.replace(urlPassword(value)!, "[hidden:password]")
  return `${match[1]}${match[2]}${match[3]}[hidden:${match[2]}]`
}

// Short values would replace ordinary words everywhere. A short password is still hidden in its own file by maskLine.
const MIN_KNOWN = 6
const FRESH_MS = 3000
// A secret file deep in a repository is found by walking it, so that walk is rationed. Near the root is checked every time.
const NEAR = 2
const DEEP = 8
const DEEP_FRESH_MS = 30_000
const MAX_ENTRIES = 20_000
const MAX_SECRET_FILE = 1024 * 1024
const SKIP = new Set(["node_modules", ".git", "dist", "build", "out", "target", "vendor", ".next", ".turbo"])

type Known = { at: number; version: number; values: [string, string][] }
const cache = new Map<string, Known>()
const learned = new Map<string, string>()
let learnedVersion = 0
const deepFiles = new Map<string, { at: number; files: string[] }>()

function walkSecretFiles(root: string, depth: number, out: string[], budget: { left: number }) {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  budget.left -= entries.length
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (depth > 0 && budget.left > 0 && !SKIP.has(entry.name) && !entry.name.startsWith("."))
        walkSecretFiles(path.join(root, entry.name), depth - 1, out, budget)
      continue
    }
    if (entry.isFile() && fileKind(entry.name) !== undefined) out.push(path.join(root, entry.name))
  }
  return out
}

function secretFiles(root: string) {
  const near = walkSecretFiles(root, NEAR, [], { left: MAX_ENTRIES })
  // A project at the disk's root has no depth worth walking.
  if (root === path.parse(root).root) return near
  const hit = deepFiles.get(root)
  if (hit && Date.now() - hit.at < DEEP_FRESH_MS) return [...new Set([...near, ...hit.files])]
  const files = walkSecretFiles(root, DEEP, [], { left: MAX_ENTRIES })
  deepFiles.set(root, { at: Date.now(), files })
  return [...new Set([...near, ...files])]
}

function readSecretFile(file: string) {
  try {
    return fs.statSync(file).size > MAX_SECRET_FILE ? undefined : fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

function known(root: string): [string, string][] {
  const hit = cache.get(root)
  if (hit && Date.now() - hit.at < FRESH_MS && hit.version === learnedVersion) return hit.values
  const found = new Map<string, string>(learned)
  for (const [name, value] of Object.entries(process.env)) {
    // A path is not a secret just because its variable is called SSH_AUTH_SOCK.
    if (value && value.length >= 8 && !value.startsWith("/") && secretPair(name, value))
      found.set(urlPassword(value) ?? value, name)
  }
  for (const file of secretFiles(root)) {
    const text = readSecretFile(file)
    if (text === undefined) continue
    for (const [name, value] of fileValues(file, text)) if (value.length >= MIN_KNOWN) found.set(value, name)
  }
  // Longest first, so a value inside a longer one does not leave the rest of it showing.
  const values = [...found.entries()].sort((a, b) => b[0].length - a[0].length)
  cache.set(root, { at: Date.now(), version: learnedVersion, values })
  return values
}

/** Remembers the values of a secret file outside the usual places, so they are hidden everywhere from now on. */
export function learn(text: string, file = ".env") {
  for (const [name, value] of fileValues(file, text)) if (value.length >= MIN_KNOWN) learned.set(value, name)
  learnedVersion++
}

/** A command named this file, which may be anywhere, so what it prints can be recognised. */
export function learnFile(file: string) {
  const text = readSecretFile(file)
  if (text !== undefined) learn(text, file)
}

export function scrub(text: string, root: string) {
  let out = text
  for (const [value, name] of known(root)) if (out.includes(value)) out = out.replaceAll(value, `[hidden:${name}]`)
  for (const [shape, mask] of SHAPES) out = out.replace(shape, mask)
  return out
}

// `API_KEY=abc`, with a value written out rather than read from anywhere. `key = item.id` in code is not one.
const ASSIGNED = /(^|[\s;&|("'`])((?:export\s+)?)([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*)("[^"\n]*"|'[^'\n]*'|[^\s"'`;&|)]+)/g
const PLAIN_SECRET_NAME = /^(password|passwd|pwd|secret|token)$/i
// `the token abc123`. A word on its own is left alone: "the token parser" and "password reset" are ordinary sentences.
const SPOKEN =
  /\b((?:pass(?:word|wd|phrase)?|pwd|secret|token|api[ _-]?key|access[ _-]?key|private[ _-]?key|credential)s?)\b((?:\s+(?:value|is|was|=|:))*\s*[:=]?\s*)(["']?)([^\s"'`,;]{4,})/gi
const LONG_TOKEN = /[A-Za-z0-9+_-]{32,}/g
const mixedCase = (text: string) => /[a-z]/.test(text) && /[A-Z]/.test(text)
const tokenLike = (text: string) => /\d/.test(text) || (text.length >= 8 && mixedCase(text))

/**
 * For text with no project to look values up in: a prompt, a typed command, a note. Works on what a value looks like and
 * what it is called, so it catches a secret that is written out, not a plain word somebody uses as a password.
 */
export function scrubText(text: string) {
  const known = [...learned.entries()].reduce((out, [value, name]) => out.replaceAll(value, `[hidden:${name}]`), text)
  return SHAPES.reduce((out, [shape, mask]) => out.replace(shape, mask), known)
    .replace(ASSIGNED, (whole, start: string, exported: string, name: string, equals: string, value: string) => {
      const inner = unquoted(value)
      if (!secretPair(name, inner) || PLACEHOLDER.test(inner)) return whole
      const written = value !== inner || name === name.toUpperCase() || tokenLike(inner) || PLAIN_SECRET_NAME.test(name)
      return written ? `${start}${exported}${name}${equals}[hidden:${name}]` : whole
    })
    .replace(SPOKEN, (whole, name: string, between: string, _quote: string, value: string) =>
      tokenLike(value) && !PLACEHOLDER.test(value) ? `${name}${between}[hidden:${name}]` : whole,
    )
    .replace(LONG_TOKEN, (token) => (mixedCase(token) && /\d/.test(token) ? "[hidden:token]" : token))
}

function scrubValue<T>(value: T, root: string, depth: number): T {
  if (typeof value === "string") return scrub(value, root) as T
  if (depth === 0 || value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, root, depth - 1)) as T
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubValue(item, root, depth - 1)])) as T
}

/** Everything a tool hands back: the model reads `output`, the transcript and the database keep `metadata`. */
export function scrubResult<T extends { output: string; metadata: object }>(result: T, root: string): T {
  return { ...result, output: scrub(result.output, root), metadata: scrubValue(result.metadata, root, 6) }
}

/** The agent only ever saw a placeholder, so writing one back would replace the real secret with the word "hidden". */
export function assertNoPlaceholder(next: string, previous: string, file: string) {
  const match = next.match(PLACEHOLDER)
  if (!match || previous.includes(match[0])) return
  throw new Error(
    `Not written: ${file} would contain the placeholder ${match[0]}, not a real value. Values shown as [hidden:NAME] are kept from you on purpose. Change only the other lines, and leave the secret where it is.`,
  )
}

export * as Secrets from "./secrets"
