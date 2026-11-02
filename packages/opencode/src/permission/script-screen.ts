// The screen autonomous mode runs over a script before the script runs on its own (U11 rule 6). Code reads the file a
// command names, or the `-c`/`-e` text it carries, and looks for fixed patterns: the network, deleting, `sudo`, `eval`,
// decoding base64 and running another local file. A clean screen lets the table answer P `script`; a flag answers D
// `script_flagged`; a file that is too large, binary, outside the folder or unreadable answers D `script_unreadable`.
//
// This raises the cost of hiding something in a script; it does not prove a script safe. Indirection and obfuscation get
// past fixed patterns, and a script that passes still runs with the account's full rights (G1). The decider only ever sees
// `summary`, which carries counts, a hash prefix and flag names, never the script's text (ADV-P2). The full hash is kept so
// the shell can compare the file again right before it runs.
import fs from "node:fs/promises"
import path from "node:path"

export const SCRIPT_MAX_BYTES = 65_536
export const INLINE_MAX_BYTES = 4_096
/** How much of the hash the audit line and the decider see. */
export const SHA_PREFIX = 12
/** The programs whose `<program> <file>` form is screened; `./file` is screened as well. */
export const INTERPRETERS = ["bash", "sh", "zsh", "python", "python3", "node", "bun", "deno", "ruby", "perl"] as const

export type Flag = "network" | "delete" | "sudo" | "eval" | "base64" | "exec_local"

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
}

const FLAGS = Object.keys(PATTERNS) as Flag[]

/** The flags a text raises, in a fixed order. The matched text itself is never returned. */
export function flags(text: string): Flag[] {
  return FLAGS.filter((flag) => PATTERNS[flag].some((pattern) => pattern.test(text)))
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

/** Screens the `-c` or `-e` text of a command. */
export function inline(code: string): Screen {
  const bytes = new TextEncoder().encode(code)
  if (bytes.byteLength > INLINE_MAX_BYTES) return { ok: false, kind: "inline", reason: "too_large" }
  return { ok: true, kind: "inline", ...measure(bytes, code) }
}

/**
 * Screens the file a command names. `file` is absolute or relative to `cwd`, which defaults to `directory`. The file must
 * be a plain, readable text file inside `directory` once links are followed.
 */
export async function file(input: { directory: string; file: string; cwd?: string }): Promise<Screen> {
  const root = await fs.realpath(input.directory).catch(() => undefined)
  if (!root) return { ok: false, kind: "file", reason: "outside" }
  const real = await fs.realpath(path.resolve(input.cwd ?? input.directory, input.file)).catch(() => undefined)
  if (!real) return { ok: false, kind: "file", reason: "missing" }
  const rel = path.relative(root, real)
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return { ok: false, kind: "file", reason: "outside" }
  const shown = rel.split(path.sep).join("/")
  const stat = await fs.stat(real).catch(() => undefined)
  if (!stat) return { ok: false, kind: "file", reason: "missing", path: shown }
  if (!stat.isFile()) return { ok: false, kind: "file", reason: "not_file", path: shown }
  if (stat.size > SCRIPT_MAX_BYTES) return { ok: false, kind: "file", reason: "too_large", path: shown }
  const bytes = await fs.readFile(real).catch(() => undefined)
  if (!bytes) return { ok: false, kind: "file", reason: "missing", path: shown }
  // The file can grow between the stat and the read.
  if (bytes.byteLength > SCRIPT_MAX_BYTES) return { ok: false, kind: "file", reason: "too_large", path: shown }
  if (bytes.includes(0)) return { ok: false, kind: "file", reason: "binary", path: shown }
  const text = (() => {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch {
      return undefined
    }
  })()
  if (text === undefined) return { ok: false, kind: "file", reason: "binary", path: shown }
  return { ok: true, kind: "file", path: shown, ...measure(bytes, text) }
}

/** The hash of a file's bytes as they are now, for the comparison right before the shell runs it. */
export async function hash(file: string) {
  const bytes = await fs.readFile(file).catch(() => undefined)
  return bytes && new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
}

function measure(bytes: Uint8Array, text: string) {
  return {
    bytes: bytes.byteLength,
    lines: text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0,
    sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    flags: flags(text),
  }
}

export * as ScriptScreen from "./script-screen"
