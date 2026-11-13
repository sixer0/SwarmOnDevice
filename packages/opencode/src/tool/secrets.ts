// Secrets stay usable and stop being readable: a program the agent runs still gets the real value, and the model and
// the transcript get [hidden:NAME]. This replaces the prompt on reading .env, which people approved without thinking.
// It holds for every model, including an internal one, and is not a verdict on who runs the model: what it limits is
// what a poisoned page can make an agent repeat, and how many transcripts and logs end up holding a production key.
import fs from "node:fs"
import path from "node:path"
import { PathSpelling } from "../permission/path-spelling"

export const PLACEHOLDER = /\[hidden:[^\]\n]*\]/

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASS|PWD|CRED|AUTH|PRIVATE|SESSION|COOKIE|SALT)/i
const PUBLIC_NAME = /PUBLIC|PUBLISHABLE/i
const CREDENTIAL_URL = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i
const RANDOM_LOOKING = /^(?=.*[0-9])(?=.*[A-Za-z])[A-Za-z0-9+/_=.-]{20,}$/

const ENV_FILE = /^\.env([-_.]|$)|\.env$|\.env\.(bak|old|orig|backup|save|local|prod|production|dev|development|staging|test)$/
// Settings files where credentials sit beside everything an agent needs, so a yes shows them line by line, masked.
const SETTINGS_FILE = /^(application(-[\w-]+)?\.properties|appsettings(\.[\w-]+)?\.json|wp-config\.php|[\w.-]*\.tfvars)$/
const ENV_EXAMPLE = /\.(example|sample|template|dist|defaults)$/
const WHOLE_FILE = /(^|\/)(id_rsa|id_ed25519|id_ecdsa|id_dsa|\.netrc|\.pgpass|\.git-credentials|credentials|service-account.*\.json|(secrets?|credentials?)\.(ya?ml|json|toml|ini)|\.pypirc|\.dockercfg|\.docker\/config\.json|\.kube\/config|kubeconfig|\.htpasswd|token\.txt|\.secrets)$|\.(pem|key|p12|pfx|keystore|jks|tfstate)(\.backup)?$|(^|\/)\.envs\/|(^|\/)\.?secrets?\/[^/]+\.(txt|env|json|ya?ml|toml|ini|conf|cfg|properties)$/i

// Values that are recognisable wherever they turn up, including in a log line nobody expected them in. These run over every
// tool result, on one line as long as anyone likes, so no pattern may look arbitrarily far ahead from a place it can start
// many times: that is quadratic, and 256 KB took a minute. So each scan ahead from a repeatable start has a ceiling.
const SHAPES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[hidden:private-key]"],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, "[hidden:api-key]"],
  [/\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}/g, "[hidden:api-key]"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, "[hidden:github-token]"],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/g, "[hidden:github-token]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[hidden:slack-token]"],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "[hidden:aws-key]"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "[hidden:api-key]"],
  [/\b([a-z][a-z0-9+.-]{0,31}:\/\/[^/\s:@]+:)[^/\s@]+(@)/gi, "$1[hidden:password]$2"],
  [/\beyJ[A-Za-z0-9_-]{10,1024}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[hidden:token]"],
  [/\b(bearer\s+)[A-Za-z0-9._~+/-]{12,}/gi, "$1[hidden:token]"],
  // `password=hunter2`, in any file. Only a value that looks made up: `password = req.body.password` is code. Whatever comes
  // before the word stays as it was, so nothing needs to match it.
  [
    /((?:password|passwd)\s*[=:]\s*["']?)(?![A-Za-z_$][\w$]{0,256}(?:\.[A-Za-z_$][\w$]{0,256})+)(?=[^\s"'`,;()]{0,256}\d)[^\s"'`,;()\[\]]{6,}/gi,
    "$1[hidden:password]",
  ],
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
  if (ENV_FILE.test(base) || SETTINGS_FILE.test(base) || base === ".npmrc" || base === ".envrc") return "env" as const
  return undefined
}

export const secretFile = (file: string) => fileKind(file) !== undefined
export const wholeSecretFile = (file: string) => fileKind(file) === "whole"

// Row 36b (SEC-03): a shell's history keeps `export KEY=...` lines. It is masked line by line like a .env file, for what
// is shown only: `secretFile` (and so `Reach.secret` and every verdict built on it) does not change.
const HISTORY_FILE = /^(\.[\w-]*_?history|fish_history)$/
// 1.2.7 N-1 (SR7-07): Swarm's own settings file holds provider `apiKey`s, `headers` and MCP `environment` tokens as JSON
// values. A read of it now runs (OP-2), so it is masked line by line like a .env file, for what is shown only, as above.
const SETTINGS_JSON = /^(swarm|opencode)\.jsonc?$/

const caseFolds = process.platform === "darwin" || process.platform === "win32"
const fold = (file: string) => {
  const name = path.normalize(file.replaceAll("\\", "/")).normalize("NFC")
  return caseFolds ? name.toLowerCase() : name
}

/** Where a path really lands: its own real path, or its folder's plus its name when it does not exist. Plain node only. */
function landing(file: string) {
  try {
    return fs.realpathSync.native(file)
  } catch {
    try {
      return path.join(fs.realpathSync.native(path.dirname(file)), path.basename(file))
    } catch {
      return undefined
    }
  }
}

/** Whether a path, by its name or by where it lands, is one of these places or inside one. */
const placeRoots = new Map<string, { at: number; roots: string[] }>()
function rootsOf(places: readonly string[]) {
  const key = places.join("\0")
  const hit = placeRoots.get(key)
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.roots
  const roots = [...new Set(places.flatMap((place) => [place, landing(place) ?? place]).map(fold))]
  if (placeRoots.size > 16) placeRoots.clear()
  placeRoots.set(key, { at: Date.now(), roots })
  return roots
}

export function underPlaces(file: string, places: readonly string[]) {
  if (places.length === 0 || !path.isAbsolute(file)) return false
  const roots = rootsOf(places)
  const names = [file, landing(file)].filter((name): name is string => name !== undefined).map(fold)
  return names.some((name) => roots.some((root) => name === root || name.startsWith(root.endsWith("/") ? root : root + "/")))
}

/**
 * Row 36b (SEC-01, SEC-03): how a file's contents may be shown to the model, judged by its name and by where it lands.
 * "whole": nothing of it is shown (a whole secret file, or anything in a protected place: `places` is the caller's list of
 * protected home folders and Swarm's own credential files, which reads now open without asking, U12). "lines": shown with
 * secret values masked (a .env-style file or a shell history). For output only; no verdict reads this.
 */
export function outputKind(file: string, places: readonly string[] = []): "whole" | "lines" | undefined {
  const names = [file, landing(file)].filter((name): name is string => name !== undefined)
  if (names.some((name) => fileKind(name) === "whole") || underPlaces(file, places)) return "whole"
  if (names.some((name) => fileKind(name) !== undefined || HISTORY_FILE.test(path.basename(name)) || SETTINGS_JSON.test(path.basename(name).toLowerCase())))
    return "lines"
  return undefined
}

/** 1.2.7 M1-02: whether a file's name alone makes what a reader prints of it masked or withheld (no disk access). */
export function maskedByName(file: string) {
  const base = path.basename(file.replaceAll("\\", "/")).normalize("NFC").toLowerCase()
  return fileKind(file) !== undefined || HISTORY_FILE.test(base) || SETTINGS_JSON.test(base)
}

// 1.2.7 M1-02 (U16, SR7-07): the masking scan resolves the files a shell command reads the way the permission table's
// app-state reader does: `~`, `$HOME` and `${HOME}` under every home Swarm knows, set environment variables expanded, and
// relative names under every folder a `cd` may lead to. 47f (C68): with the table's own resolver (`PathSpelling`, the
// object `AutonomyTable.spelling`), not a copy of its rules.
const CHANGES_FOLDER = new Set(["cd", "chdir", "pushd"])

/** A word as the shell would expand it. `certain` is false when some part of it could not be expanded here. */
export const expandSpelling = PathSpelling.expand

/**
 * Every folder a command's words may be read from: the call's folder and each `cd`, `chdir` or `pushd` target, each
 * resolved under every folder reached before it (an over-read on purpose, as the table's). `certain` is false when a change
 * of folder could not be followed: `cd -`, `popd`, a stack entry, a CDPATH lookup, an expansion that did not resolve.
 */
export function workingFolders(
  commands: readonly (readonly string[])[],
  cwd: string,
  homes: readonly string[],
): { folders: string[]; certain: boolean } {
  let folders = [cwd]
  let certain = true
  const add = (more: string[]) => {
    const next = PathSpelling.widen(folders, more)
    if (next.capped) certain = false
    folders = next.folders
  }
  for (const command of commands) {
    const words = command[0] === "builtin" || command[0] === "command" ? command.slice(1) : command
    const program = words[0]
    if (program === "popd") certain = false
    if (!program || !CHANGES_FOLDER.has(program)) continue
    const args = words.slice(1).filter((word) => !/^-[LPe@]+$/.test(word))
    if (args.length === 0) {
      add([...homes])
      continue
    }
    const target = args[0]!
    if (args.length > 1 || /^[-+]/.test(target)) {
      certain = false
      continue
    }
    if (process.env.CDPATH && !/^(\/|~|\$|\.{1,2}(\/|$))/.test(target)) certain = false
    const spelled = expandSpelling(target, homes)
    if (!spelled.certain) certain = false
    add(spelled.names.flatMap((name) => folders.map((folder) => path.resolve(folder, name))))
  }
  return { folders, certain }
}

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
    // A JSON value ends with the comma before the next key (SR7-07): `"apiKey": "…",`.
    const value = yaml ? unquoted(yaml[2].replace(/,\s*$/, "")) : ""
    if (yaml && secretPair(yaml[1], value)) out.push([yaml[1], urlPassword(value) ?? value])
    for (const match of line.matchAll(/\b(password|passwd|account)\s+(\S+)/gi)) out.push([match[1], match[2]])
    const fields = line.split(":")
    if (base === ".pgpass" && fields.length === 5) out.push(["pgpass", fields[4].trim()])
  }
  // Row 36b: `: 1699999999:0;export FOO_TOKEN=...` in a history file, which `pairs` does not read as a line of its own.
  if (HISTORY_FILE.test(base)) out.push(...assignedValues(text))
  return out
}

/** One line of a .env-style file, with a secret value replaced. */
export function maskLine(line: string) {
  return maskPair(line)
}

/** Row 36b (SEC-03): one line of a secret file or a history as shown: `maskLine`, then the written-assignment rules. */
export function maskOutputLine(line: string) {
  return scrubAssigned(maskPair(line))
}

function maskPair(line: string) {
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

/** 1.2.7 M1-02: a file that is there to be printed but whose values `learnFile` cannot read (too large, unreadable). */
export function unlearnable(file: string) {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return false
    if (stat.size > MAX_SECRET_FILE) return true
    fs.accessSync(file, fs.constants.R_OK)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EACCES" || (error as NodeJS.ErrnoException).code === "EPERM"
  }
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
  return scrubAssigned(SHAPES.reduce((out, [shape, mask]) => out.replace(shape, mask), known))
}

/** A value written out under a secret-sounding name, as `scrubText` judges it. */
const writtenSecret = (name: string, value: string, inner: string) =>
  secretPair(name, inner) &&
  !PLACEHOLDER.test(inner) &&
  (value !== inner || name === name.toUpperCase() || tokenLike(inner) || PLAIN_SECRET_NAME.test(name))

/**
 * The `ASSIGNED`, `SPOKEN` and `LONG_TOKEN` rules of `scrubText` on their own. Row 36b (SEC-03, SEC-20): also applied to
 * what a protected read prints (a secret file, a history, `env`/`printenv`), where a value need not be known to be hidden.
 */
export function scrubAssigned(text: string) {
  return text
    .replace(ASSIGNED, (whole, start: string, exported: string, name: string, equals: string, value: string) =>
      writtenSecret(name, value, unquoted(value)) ? `${start}${exported}${name}${equals}[hidden:${name}]` : whole,
    )
    .replace(SPOKEN, (whole, name: string, between: string, _quote: string, value: string) =>
      tokenLike(value) && !PLACEHOLDER.test(value) ? `${name}${between}[hidden:${name}]` : whole,
    )
    .replace(LONG_TOKEN, (token) => (mixedCase(token) && /\d/.test(token) ? "[hidden:token]" : token))
}

/** The written-out secret assignments in a text, so a history file's values can be recognised elsewhere. */
function assignedValues(text: string) {
  const out: [string, string][] = []
  for (const match of text.matchAll(ASSIGNED)) {
    const inner = unquoted(match[5]!)
    if (writtenSecret(match[3]!, match[5]!, inner)) out.push([match[3]!, urlPassword(inner) ?? inner])
  }
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
