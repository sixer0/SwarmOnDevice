// The screen autonomous mode runs over a script before the script runs on its own (U11 rule 6). Code reads the file a
// command names, or the `-c`/`-e` text it carries, and looks for fixed patterns: the network, deleting, `sudo`, `eval`,
// decoding base64 and running another local file. A clean screen lets the table answer P `script`; a flag answers D
// `script_flagged`; a file that is too large, binary, outside the folder or unreadable answers D `script_unreadable`.
//
// This raises the cost of hiding something in a script; it does not prove a script safe. Indirection and obfuscation get
// past fixed patterns, and a script that passes still runs with the account's full rights (G1). The decider only ever sees
// `summary`, which carries counts, a hash prefix and flag names, never the script's text (ADV-P2). The full hash is kept so
// the shell can compare the file again right before it runs.
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export const SCRIPT_MAX_BYTES = 65_536
export const INLINE_MAX_BYTES = 4_096
/** How much of the hash the audit line and the decider see. */
export const SHA_PREFIX = 12
/** The programs whose `<program> <file>` form is screened; `./file` is screened as well. */
export const INTERPRETERS = ["bash", "sh", "zsh", "python", "python3", "node", "bun", "deno", "ruby", "perl"] as const

export type Flag = "network" | "delete" | "sudo" | "eval" | "base64" | "exec_local" | "outside_path"

// A command word: not part of a longer name or path before it, and followed by `after`.
const word = (source: string, after = String.raw`(?![\w-])`) =>
  new RegExp(String.raw`(?<![\w.\-/])(?:${source})${after}`, "m")
// A word in command position: at the start of a line or after a space, `;`, `&`, `|` or `(`.
const command = (source: string) => new RegExp(String.raw`(?<=^|[\s;&|(])(?:${source})`, "m")
const argument = String.raw`(?=\s|$|;)`

const PATTERNS: Record<Flag, readonly RegExp[]> = {
  network: [
    word("curl|wget|ncat|netcat|nc|telnet|ssh|scp|sftp|ftp|rsync|socat|aria2c"),
    /\/dev\/(?:tcp|udp)\//,
    /\b(?:urllib|requests\.(?:get|post|put|patch|delete|request|Session)|http\.client|httplib|socket\.|aiohttp|httpx|Net::HTTP|LWP::|IO::Socket|open-uri)/,
    /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(|\bnew\s+(?:WebSocket|XMLHttpRequest|EventSource)\b/,
    /\b(?:require|import)\s*\(?\s*["'](?:node:)?(?:https?|net|dgram|tls|http2)["']/,
    /\bfrom\s+["'](?:node:)?(?:https?|net|dgram|tls|http2)["']/,
    /\bgit\s+(?:push|fetch|pull|clone|remote\s+add)\b/,
    /\b(?:npm|bun|pnpm|yarn)\s+publish\b/,
    /\bInvoke-(?:WebRequest|RestMethod)\b/,
  ],
  delete: [
    word("rm|rmdir|unlink|shred|srm|wipe|truncate", argument),
    /\s-delete\b|-exec\s+rm\b/,
    /\bgit\s+(?:rm|clean)\b/,
    /\b(?:os\.(?:remove|unlink|rmdir|removedirs)|shutil\.rmtree)\b|\.(?:unlink|rmdir|delete)\(\)/,
    /\b(?:rm|rmdir|unlink|rmSync|rmdirSync|unlinkSync)\s*\(|\brimraf\b|\bRemove-Item\b/,
    /\bFile(?:Utils)?\.(?:delete|rm|rm_rf|rm_r|unlink)\b|\bDir\.(?:delete|rmdir|unlink)\b/,
  ],
  sudo: [word("sudo|doas|pkexec|su", argument)],
  eval: [
    word("eval"),
    /(?<![\w.])(?:exec|Function)\s*\(|\bnew\s+Function\b|\bvm\.(?:runIn\w+|Script|compileFunction)\b/,
    /\b(?:instance|class|module)_eval\b/,
    /\bsource\s+<\(|(?<=^|[\s;&|])\.\s+<\(/,
  ],
  base64: [
    /\bbase64\s+(?:-\w*[dD]\w*|--decode)\b/,
    /\b(?:b64decode|urlsafe_b64decode|decodebytes|a2b_base64|decode_base64|decode64|strict_decode64|atob|fromBase64)\b/,
    /\bBuffer\.from\([^)]*["']base64["']|\bunpack\s*\(?\s*["']m/,
    /\bopenssl\s+(?:base64|enc)\b[^\n]*\s-d\b/,
  ],
  exec_local: [
    command(String.raw`\.{1,2}/[\w./-]+`),
    word(String.raw`(?:${INTERPRETERS.join("|")})\s+(?:-\S+\s+)*[\w./-]+\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl)`, ""),
    command(String.raw`(?:source|\.)\s+[\w./~$"'-]`),
    /\b(?:subprocess|child_process|os\.(?:system|popen|exec\w*|spawn\w*)|Bun\.(?:spawn|spawnSync|\$)|execSync|execFile|spawnSync|Deno\.(?:run|Command)|Kernel\.system|IO\.popen)\b/,
    /\b(?:spawn|execFileSync|system)\s*\(/,
  ],
  // U11 rule 1: outside the folder the agent only reads, so a script must not be able to name a place out there. What a
  // fixed pattern can see of a path it cannot resolve: the home folder, the environment, and a path put together at run
  // time. Absolute paths and `..` are judged against the folder in `escapes`. Nothing here proves a path is only read, so
  // every one of them is a person's call, a read included.
  outside_path: [
    // `~`, `~user`, `$HOME`, `${HOME}`, `%USERPROFILE%`.
    /(?<![\w~-])~[\w.-]*(?=[/"'`\s;)|,]|$)/m,
    /\$\{?HOME\b|%[A-Za-z_]\w*%/,
    // A variable on either side of a `/`, `cd $X`, and the environment read from code.
    /\$\{?\w+\}?(?=\/)|\/\$\{?\w/,
    /(?<![\w-])(?:cd|pushd)\s+["']?\$/,
    /\b(?:os\.environ|getenv|process\.env|Deno\.env|Bun\.env|expanduser|expandvars|homedir|Path\.home|gettempdir|tmpdir|chdir)\b|\bENV\[|\$ENV\{/,
    // Built from pieces: a lone "/" (`"/".join`, `+ "/"`), a join or a separator, a character code, an escaped slash, an
    // interpolation beside a `/`.
    /["'`]\/["'`]|\b(?:os\.path\.join|path\.join|path\.resolve|os\.sep|path\.sep|File\.join|File\.expand_path|fromCharCode|chr)\b|["']path["']\)\.(?:join|resolve)\b/,
    /\\x2[fF]|\\u002[fF]|\\057/,
    /\{[^{}\n]*\}\/|\/\{[^{}\n]*\}|\/\$\{/,
  ],
}

// The only places beyond the folder a script may name: nothing is kept in them.
const DEVICES = /^\/dev\/(?:null|stdin|stdout|stderr|fd\/\d+)$/
const ABSOLUTE = /(?<![\w.:/\\$}~-])\/[\w.@%+=~-]+(?:\/[\w.@%+=~-]*)*/g
const UPWARD = /(?<![\w./~-])(?:\.{1,2}\/)*\.\.(?:\/[\w.@%+=~-]*)*(?![\w.-])/g

/**
 * `const re = /x/g` in JavaScript: an expression position before it and a closing `/` with only flags after. A shell
 * assignment (`x=/etc/`) has no space after its `=`, so it is still a path.
 */
function regexLiteral(text: string, match: RegExpMatchArray) {
  const before = text.slice(0, match.index)
  if (!/(?:[(,[!&|?{:]\s*|=\s+)$/.test(before)) return false
  return /\/[gimsuyd]*$/.test(match[0])
}

/** Where the text's relative paths start from, and the folder they must stay in. */
export type Place = { readonly roots: readonly string[]; readonly cwd: string }

/**
 * Whether the text names an absolute path, or a `..` path from `place.cwd`, that is not inside the folder. Without a place
 * every absolute path and every `..` counts. A `#!` line is how the file is run, not a path it uses.
 */
function escapes(text: string, place?: Place) {
  const body = text.replace(/^#![^\n]*/, "")
  const out = (file: string) =>
    !place || !place.roots.some((root) => {
      const relative = path.relative(root, file)
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
    })
  const absolute = [...body.matchAll(ABSOLUTE)].filter((match) => !regexLiteral(body, match))
  if (absolute.some(([found]) => !DEVICES.test(found) && out(path.resolve(found)))) return true
  return [...body.matchAll(UPWARD)].some(([found]) => out(path.resolve(place?.cwd ?? "/", found)))
}

const FLAGS = Object.keys(PATTERNS) as Flag[]

/** The flags a text raises, in a fixed order. The matched text itself is never returned. */
export function flags(text: string, place?: Place): Flag[] {
  return FLAGS.filter(
    (flag) => PATTERNS[flag].some((pattern) => pattern.test(text)) || (flag === "outside_path" && escapes(text, place)),
  )
}

export type Unreadable =
  /** The file is outside the session's folder once links are followed. */
  | "outside"
  /** The file is not there or cannot be opened. */
  | "missing"
  /** A folder, device, socket or anything else that is not a plain file. */
  | "not_file"
  /** Larger than `SCRIPT_MAX_BYTES`, or `INLINE_MAX_BYTES` for `-c`/`-e` text. */
  | "too_large"
  /** Holds a NUL byte or is not UTF-8 text. */
  | "binary"

export type Screen =
  | {
      readonly ok: true
      readonly kind: "file" | "inline"
      /** Relative to the session's folder, with `/`; absent for inline text. */
      readonly path?: string
      readonly bytes: number
      readonly lines: number
      /** The whole hash, for the shell to compare right before it runs the file. */
      readonly sha256: string
      readonly flags: readonly Flag[]
    }
  | {
      readonly ok: false
      readonly kind: "file" | "inline"
      readonly reason: Unreadable
      readonly path?: string
    }

/** What the decider and the audit line get: counts, a hash prefix and flag names. Never the script's text. */
export interface Summary {
  readonly bytes: number
  readonly lines: number
  readonly sha: string
  readonly flags: readonly Flag[]
}

export type Category = "script" | "script_flagged" | "script_unreadable"

export function category(screen: Screen): Category {
  if (!screen.ok) return "script_unreadable"
  return screen.flags.length ? "script_flagged" : "script"
}

export function summary(screen: Extract<Screen, { ok: true }>): Summary {
  return { bytes: screen.bytes, lines: screen.lines, sha: screen.sha256.slice(0, SHA_PREFIX), flags: [...screen.flags] }
}

/** Screens the `-c` or `-e` text of a command, run in `place.cwd`. Without a place, any absolute path or `..` is outside. */
export function inline(code: string, place?: Place): Screen {
  const bytes = new TextEncoder().encode(code)
  if (bytes.byteLength > INLINE_MAX_BYTES) return { ok: false, kind: "inline", reason: "too_large" }
  return { ok: true, kind: "inline", ...measure(bytes, code, place) }
}

/**
 * Screens the file a command names. `file` is absolute or relative to `cwd`, which defaults to `directory`. The file must
 * be a plain, readable text file inside `directory` once links are followed. Synchronous, because the table that judges
 * the command is: it reads one file of at most `SCRIPT_MAX_BYTES`.
 */
export function file(input: { directory: string; file: string; cwd?: string }): Screen {
  const root = attempt(() => fs.realpathSync(input.directory))
  if (!root) return { ok: false, kind: "file", reason: "outside" }
  const real = attempt(() => fs.realpathSync(path.resolve(input.cwd ?? input.directory, input.file)))
  if (!real) return { ok: false, kind: "file", reason: "missing" }
  const rel = path.relative(root, real)
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return { ok: false, kind: "file", reason: "outside" }
  const shown = rel.split(path.sep).join("/")
  const stat = attempt(() => fs.statSync(real))
  if (!stat) return { ok: false, kind: "file", reason: "missing", path: shown }
  if (!stat.isFile()) return { ok: false, kind: "file", reason: "not_file", path: shown }
  if (stat.size > SCRIPT_MAX_BYTES) return { ok: false, kind: "file", reason: "too_large", path: shown }
  const bytes = attempt(() => fs.readFileSync(real))
  if (!bytes) return { ok: false, kind: "file", reason: "missing", path: shown }
  // The file can grow between the stat and the read.
  if (bytes.byteLength > SCRIPT_MAX_BYTES) return { ok: false, kind: "file", reason: "too_large", path: shown }
  if (bytes.includes(0)) return { ok: false, kind: "file", reason: "binary", path: shown }
  const text = attempt(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  if (text === undefined) return { ok: false, kind: "file", reason: "binary", path: shown }
  // Relative paths in a script start where the command runs, which is `cwd`.
  const place = { roots: [...new Set([input.directory, root])], cwd: path.resolve(input.cwd ?? input.directory) }
  return { ok: true, kind: "file", path: shown, ...measure(bytes, text, place) }
}

/** The hash of a file's bytes as they are now, for the comparison right before the shell runs it. */
export async function hash(file: string) {
  const bytes = await fs.promises.readFile(file).catch(() => undefined)
  return bytes && sha256(bytes)
}

// `node:crypto`, not `Bun.CryptoHasher`: the table imports this module, and the packaged app's server runs on Node (C71).
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

function attempt<T>(read: () => T) {
  try {
    return read()
  } catch {
    return undefined
  }
}

function measure(bytes: Uint8Array, text: string, place?: Place) {
  return {
    bytes: bytes.byteLength,
    lines: text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0,
    sha256: sha256(bytes),
    flags: flags(text, place),
  }
}

export * as ScriptScreen from "./script-screen"
