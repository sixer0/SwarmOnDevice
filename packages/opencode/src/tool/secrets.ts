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

const ENV_FILE = /^\.env(\.|$)|\.env$/
const ENV_EXAMPLE = /\.(example|sample|template|dist|defaults)$/
const WHOLE_FILE = /(^|\/)(id_rsa|id_ed25519|id_ecdsa|id_dsa|\.netrc|\.pgpass|\.git-credentials|credentials|credentials\.json|service-account.*\.json)$|\.(pem|key|p12|pfx|keystore|jks)$/i

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
  const base = path.basename(file)
  if (WHOLE_FILE.test(file)) return "whole" as const
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
const SKIP = new Set(["node_modules", ".git", "dist", "build", "out", "target", "vendor", ".next", ".turbo"])

type Known = { at: number; values: [string, string][] }
const cache = new Map<string, Known>()
const learned = new Map<string, string>()

function envFiles(root: string, depth: number, out: string[]) {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (depth > 0 && !SKIP.has(entry.name) && !entry.name.startsWith(".")) envFiles(path.join(root, entry.name), depth - 1, out)
      continue
    }
    if (entry.isFile() && fileKind(entry.name) === "env") out.push(path.join(root, entry.name))
  }
  return out
}

function known(root: string): [string, string][] {
  const hit = cache.get(root)
  if (hit && Date.now() - hit.at < FRESH_MS && hit.values.length >= learned.size) return hit.values
  const found = new Map<string, string>(learned)
  for (const [name, value] of Object.entries(process.env)) {
    // A path is not a secret just because its variable is called SSH_AUTH_SOCK.
    if (value && value.length >= 8 && !value.startsWith("/") && secretPair(name, value))
      found.set(urlPassword(value) ?? value, name)
  }
  for (const file of envFiles(root, 2, [])) {
    try {
      for (const [name, value] of pairs(fs.readFileSync(file, "utf8"))) if (value.length >= MIN_KNOWN) found.set(value, name)
    } catch {
      continue
    }
  }
  // Longest first, so a value inside a longer one does not leave the rest of it showing.
  const values = [...found.entries()].sort((a, b) => b[0].length - a[0].length)
  cache.set(root, { at: Date.now(), values })
  return values
}

/** Remembers the values of a secret file outside the usual places, so they are hidden everywhere from now on. */
export function learn(text: string) {
  for (const [name, value] of pairs(text)) if (value.length >= MIN_KNOWN) learned.set(value, name)
}

export function scrub(text: string, root: string) {
  let out = text
  for (const [value, name] of known(root)) if (out.includes(value)) out = out.replaceAll(value, `[hidden:${name}]`)
  for (const [shape, mask] of SHAPES) out = out.replace(shape, mask)
  return out
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
