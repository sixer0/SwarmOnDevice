import { Effect, Fiber, Option, Stream } from "effect"
import os from "os"
import { createWriteStream, readdirSync } from "node:fs"
import fsp from "node:fs/promises"
import * as Tool from "./tool"
import path from "path"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"

import { FSUtil } from "@opencode-ai/core/fs-util"
import { fileURLToPath } from "url"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Shell } from "@opencode-ai/core/shell"
import { ShellID } from "./shell/id"
import { ShellOrphans } from "./shell/orphans"

import * as Truncate from "./truncate"
import { condense } from "./condense"
import { Plugin } from "@/plugin"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ShellPrompt, type Parameters } from "./shell/prompt"
import { Risk } from "./risk"
import { Reach } from "./reach"
import { withholdsAlways } from "./external-directory"
import { Secrets } from "./secrets"
import { withoutServerCredentials } from "@/util/server-credentials"
import { Autonomy } from "@/permission/autonomy"
import { Session } from "@/session/session"
import { Archive } from "./archive"
import { DELETE_COMPOUND_TEXT, SCRIPT_CHANGED_TEXT, checkpointFailedText } from "@/permission/autonomy-texts"
import { AutonomyTable } from "@/permission/autonomy-table"
import { ActionCheckpoint } from "./checkpoint"
import { execFile } from "node:child_process"
import { ScriptScreen } from "@/permission/script-screen"
import { DeletionWords, type Deletion } from "./deletion"
import { BypassLists } from "@/permission/bypass-lists"
import { Global } from "@opencode-ai/core/global"

export { Parameters } from "./shell/prompt"
export { SCRIPT_CHANGED_TEXT } from "@/permission/autonomy-texts"
export type { Deletion } from "./deletion"

const MAX_METADATA_LENGTH = 30_000
// Shown from the start of an output that gets cut. Setup failures print there, and the rest of the budget goes to the end.
const HEAD_BYTES = 4 * 1024
const SHELL_MAX_BYTES = 24 * 1024
const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const CMD_FILES = new Set([
  "copy",
  "del",
  "dir",
  "erase",
  "md",
  "mkdir",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "type",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  risk?: Risk.Risk
  /** Secret files the command names, so what it prints from them can be recognised. */
  secretFiles: Set<string>
  /**
   * The whole output shown in place of what it prints, when it shows a secret file in a form a search for the value would
   * not find (row 36b, SEC-01), or prints any of a whole secret file or a protected place (SEC-01, SEC-03).
   */
  withheld?: string
  /** Row 36b (SEC-03, SEC-20): a protected read (a secret file, `env`, `printenv`): the written-assignment rules apply. */
  masked?: boolean
}

type Chunk = {
  text: string
  size: number
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "number" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function pathArgs(list: Part[], ps: boolean, cmd = false) {
  if (!ps) {
    return list
      .slice(1)
      .filter(
        (item) =>
          !item.text.startsWith("-") &&
          !(cmd && item.text.startsWith("/")) &&
          !(list[0]?.text === "chmod" && item.text.startsWith("+")),
      )
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

// Unless `tool_output` says otherwise. Commands are the largest thing that enters a run, and whatever enters is paid for
// again on every later step. The full output is always saved, and the agent can search it for what it needs.
function shellLimits(limits: { maxLines: number; maxBytes: number }) {
  return { ...limits, maxBytes: limits.maxBytes === Truncate.MAX_BYTES ? SHELL_MAX_BYTES : limits.maxBytes }
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

function tail(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      cut: false,
    }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return {
    text: out.join("\n"),
    cut: true,
  }
}

const parse = Effect.fn("ShellTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree
})

// What a command is made of for its label to be taken at face value. Everything else, such as a group, a subshell, a loop,
// an expansion or a heredoc, means the arguments the parser sees may not be what the shell will use, so it gets no label.
const UNDERSTOOD = new Set([
  "program",
  "comment",
  "command",
  "command_name",
  "word",
  "number",
  "string",
  "string_content",
  "raw_string",
  "concatenation",
  "list",
  "pipeline",
  "redirected_statement",
  "file_redirect",
  "file_descriptor",
])

function understood(node: Node): boolean {
  if (!UNDERSTOOD.has(node.type) || node.isError || node.isMissing) return false
  return node.namedChildren.every((child) => child !== null && understood(child))
}

// Nothing in these can be rewritten by any POSIX shell or by zsh before the command sees it.
const PLAIN_WORD = /^[\w./@%+:,-][\w./@%+:,=-]*$/

function literal(part: { type: string; text: string }) {
  if (part.type === "raw_string") return true
  if (part.type === "string") return !/[$`\\!]/.test(part.text)
  if (part.type === "number") return true
  return part.type === "word" && PLAIN_WORD.test(part.text)
}

// U11 rule 4: in autonomous mode these do not run. A plain one has its paths moved to the archive instead. The sets and
// the reading of the words are `tool/deletion.ts`, which the autonomy table reads with.
const { WRAPPERS } = DeletionWords

const base = (word: string) => path.posix.basename(unquote(word))

const deletes = (tokens: string[]) => DeletionWords.deletes(tokens.map(unquote), base)

/** The parts of the text when it is one command of literal words and nothing else: no redirect, no second command. */
function plainCommand(root: Node) {
  const list = commands(root)
  if (list.length !== 1 || !understood(root)) return undefined
  const node = list[0]!
  const redirects = redirectsIn(root)
  if (node.text.trim() !== root.text.trim() || redirects.writes.length || redirects.reads.length || redirects.loose.length)
    return undefined
  const command = parts(node)
  if (!command.every((item) => literal(item.type === "command_name" ? { ...item, type: "word" } : item))) return undefined
  return command
}

/**
 * Whether the text deletes, and if so whether it is one plain deletion of literal paths and nothing else. Only that
 * shape is moved; any other text that deletes is refused in autonomous mode, so a deletion never rides along unseen.
 */
function deletion(root: Node): Deletion | "compound" | undefined {
  if (!commands(root).some((node) => deletes(parts(node).map((item) => item.text)))) return undefined
  const command = plainCommand(root)
  if (!command) return "compound"
  const words = command.map((item) => unquote(item.text))
  const name =
    words[0] === "git" && words[1] === "rm"
      ? ("git rm" as const)
      : words[0] === "rm" || words[0] === "rmdir" || words[0] === "unlink"
        ? words[0]
        : undefined
  if (!name) return "compound"
  const found = DeletionWords.deletionFlags(name, words.slice(name === "git rm" ? 2 : 1))
  if (!found) return "compound"
  return { name, ...found }
}

/**
 * How the shell reads a text as a deletion, for `test/permission/u11-single-source.test.ts`, which holds it beside the
 * autonomy table's reading of the same text. Parsed as bash, the way a POSIX shell's command is.
 */
export async function readDeletion(text: string) {
  const tree = (await parser()).bash.parse(text)
  if (!tree) return undefined
  const found = deletion(tree.rootNode)
  tree.delete()
  return found
}

/**
 * C97 F2: one plain `cp` or `mv` of literal words and nothing else, read as the autonomy table reads it (`Risk.copyMove`),
 * so the file it would replace is the one the table judged. Anything else is undefined and runs as it always has.
 */
function copyMove(root: Node) {
  const command = plainCommand(root)
  if (!command) return undefined
  // The program's own name as written: a quoted or pathed `cp` is not the one read here.
  if (command[0]?.text !== "cp" && command[0]?.text !== "mv") return undefined
  return Risk.copyMove(command.map((item) => unquote(item.text)))
}

/** 1.2.6 P-02: a plain copy or move as the gate saw it: the targets the program would write, and those to be archived. */
type CopyAtGate = { targets: string[] | undefined; archived: readonly string[] }

/**
 * The files a copy or a move would replace now, folders left out: the program refuses those and replaces nothing. None for
 * `-n` (1.2.6 P-02, `Risk.replacing`).
 */
async function replacedBy(item: Risk.CopyMove, cwd: string) {
  const replacing = Risk.replacing(item, cwd)
  if (!replacing) return []
  const found = await Promise.all(
    replacing.map(async (file) => ((await fsp.stat(file).catch(() => undefined))?.isDirectory() ? [] : [file])),
  )
  return found.flat()
}

/** What the program itself would refuse, so a move never removes more than the command would have. */
async function refusedBy(item: Deletion, cwd: string) {
  for (const file of item.paths) {
    const stat = await fsp.lstat(path.resolve(cwd, file)).catch(() => undefined)
    if (!stat?.isDirectory()) continue
    if (item.name === "unlink") return `${item.name}: ${file}: is a directory`
    if (item.recursive) continue
    const empty = (await fsp.readdir(path.resolve(cwd, file)).catch(() => ["?"])).length === 0
    if (item.dirs && empty) continue
    if (item.dirs) return `${item.name}: ${file}: Directory not empty`
    return item.name === "git rm"
      ? `fatal: not removing '${file}' recursively without -r`
      : `${item.name}: ${file}: is a directory`
  }
  return undefined
}

// U11 rule 6: a script the gate let run is compared again right before it runs, so what runs is what was judged.
const SCRIPT_PROGRAMS = new Set<string>(ScriptScreen.INTERPRETERS)

/**
 * The files a command could run as a script: the words after a program in `ScriptScreen.INTERPRETERS` that are not
 * options, and a command name with a `/` in it (`./run.sh`, `scripts/x`). Leading wrappers and `VAR=value` are skipped.
 * Wider than any form the table judges on purpose: a file named here that did not change costs one read, while a file the
 * table judged and this missed would run unchecked. The table answers P `script` only for a file listed with the same
 * hash in the request's `metadata.scripts`, so a form this misses is held rather than run.
 */
function scriptFiles(root: Node) {
  return commands(root).flatMap((node) => {
    const words = parts(node).map((item) => unquote(item.text))
    const start = words.findIndex(
      (word) => !WRAPPERS.has(base(word)) && !word.startsWith("-") && !word.includes("=") && !/^\d+[smhd]?$/.test(word),
    )
    const name = words[start]
    if (!name) return []
    if (SCRIPT_PROGRAMS.has(base(name))) return words.slice(start + 1).filter((word) => word && !word.startsWith("-"))
    // C97 F4: `source` and `.` run a file in this shell, which the table screens as a script.
    if (name === "source" || name === ".") return words.slice(start + 1, start + 2)
    return name.includes("/") ? [name] : []
  })
}

/**
 * The hash of each file as it is now, keyed by its absolute path. Undefined for a file that is not there, not a plain file
 * or larger than the screen reads, since none of those is ever judged `script`. Only files inside the project are read.
 */
async function scriptHashes(files: string[], cwd: string, instance: InstanceContext) {
  const inside = [...new Set(files.map((file) => path.resolve(cwd, home(file))))].filter((file) =>
    containsPath(file, instance),
  )
  return new Map(
    await Promise.all(
      inside.map(async (file) => {
        const stat = await fsp.stat(file).catch(() => undefined)
        const bytes =
          stat?.isFile() && stat.size <= ScriptScreen.SCRIPT_MAX_BYTES
            ? await fsp.readFile(file).catch(() => undefined)
            : undefined
        return [file, bytes && ScriptScreen.sha256(bytes)] as const
      }),
    ),
  )
}

/**
 * Row 274: the commands a text runs, as the autonomy table judges them one by one (`metadata.steps`). Each step is a
 * program's literal argv and every folder it could run in; `writes` are the files its redirects write. Only what is
 * understood in full is read: lists (`&&`, `||`, `;`, new lines), pipelines, `( )` and `{ }`, `if`, `for` over literal
 * words, `while`, `[ ]`, redirects to literal names, a quoted heredoc fed to an interpreter, `cd` to a literal folder, and
 * `NAME=literal` used later as `$NAME`. Anything else (a function, `case`, an unknown variable, a glob, a program name
 * that is not a plain word, `VAR=x cmd` for any name or value outside `BypassLists.SAFE_ASSIGNMENT`, `eval`-like text the
 * grammar does not show as a command) returns undefined, and the table judges the whole text as before. A `cd` that may
 * fail leaves both folders possible for what follows it.
 *
 * A step's `argv` may start with `NAME=value` words (1.1.1 F40, P56 item 7): only names and values of
 * `BypassLists.SAFE_ASSIGNMENT`, only before the program, never before `cd`, `set`, `export` or a heredoc. So `argv[0]` is
 * not always the program: a reader that needs the program skips those words first (`DeletionWords.program`).
 * `assigned` (1.1.1 F41, G17-2): every `NAME=value` the text sets for its later steps (an assignment statement, an
 * `export`, a `for` over a name that may be in the environment), which the consented screen checks against
 * `BypassLists.harmlessAssignment`. Absent when empty.
 */
export type ShellStep = { argv: string[]; cwds: string[]; code?: string }
/**
 * 1.1.1 F20 (P34): a name as the text wrote it (`to`) and the folder it is taken from (`from`), kept where tidying it
 * would lose what the system does with it. `upward`: a redirect target with a `..`, which the system resolves one name at
 * a time, so through a link it can land elsewhere than its tidied path says. `chdirs`: every `cd`, whose folder the shell
 * takes logically, unless that folder does not exist as written (bash then falls back to the physical path) or the shell
 * is set to resolve links. Neither field is present when it would be empty.
 */
export type ShellPlace = { from: string; to: string }
export type ShellReading = {
  v: 1
  steps: ShellStep[]
  writes: string[]
  upward?: ShellPlace[]
  chdirs?: ShellPlace[]
  assigned?: string[]
}

const MAX_STEPS = 400
const MAX_LOOP = 64
// Variables a command may set for the rest of the text without changing what any program does (one list with the
// consented screen's, 1.1.1 F41 CR17-3).
const HARMLESS_EXPORTS = BypassLists.HARMLESS_EXPORTS
// 1.1.1 F40 (P56 item 7), F41 (CR17-3): the names a `NAME=value` word before a program may set, and their value rule,
// from the one source the consented screen reads them through by. Exported for the test that pins them as one object.
export const READ_THROUGH = BypassLists.SAFE_ASSIGNMENT

class Unread extends Error {}

export function decompose(root: Node, cwd: string): ShellReading | undefined {
  const steps: ShellStep[] = []
  const writes = new Set<string>()
  // 1.1.1 F22 (CR10-1): each place once, keyed by where it is taken from and how it is written. A `cd` or a redirect the
  // text repeats asks the same question again, so a repeat adds nothing to judge, and the lists stay as long as the
  // distinct places, not the text.
  const upward = new Map<string, ShellPlace>()
  const chdirs = new Map<string, ShellPlace>()
  const place = (into: Map<string, ShellPlace>, from: string, to: string) => {
    const key = `${from}\0${to}`
    if (!into.has(key)) into.set(key, { from, to })
  }
  const vars = new Map<string, string>()
  // 1.1.1 F41 (G17-2): what the text sets for its later steps, and whether the home folder is among it.
  const assigned: string[] = []
  const homeSet = () => vars.has("HOME") || assigned.some((word) => word.startsWith("HOME="))
  // Bare words with `~` or `^` read since the last command started (see `value`).
  let revisionWords = 0
  const fail = (): never => {
    throw new Unread()
  }
  const step = (argv: string[], cwds: Set<string>, code?: string) => {
    if (steps.length >= MAX_STEPS) fail()
    steps.push({ argv, cwds: [...cwds], ...(code === undefined ? {} : { code }) })
  }
  type Where = { ok: Set<string>; any: Set<string> }
  const same = (cwds: Set<string>): Where => ({ ok: cwds, any: cwds })
  const union = (...sets: Iterable<string>[]) => new Set(sets.flatMap((set) => [...set]))
  const named = (node: Node) => node.namedChildren.filter((child): child is Node => child !== null && child.type !== "comment")

  // What lies between the children of `node` in its text, in order. The grammar drops some words (`python3 -` before a
  // heredoc), so a reader that only walked the children could judge less than what runs.
  const gaps = (node: Node, children: readonly Node[]) => {
    const text = node.text
    const found: string[] = []
    let at = 0
    for (const child of children) {
      const start = text.indexOf(child.text, at)
      if (start < 0) fail()
      found.push(text.slice(at, start))
      at = start + child.text.length
    }
    found.push(text.slice(at))
    return found
  }

  // The literal value of one word as the shell will pass it, or a failure.
  const value = (node: Node): string => {
    switch (node.type) {
      case "word":
      case "number": {
        const text = node.text
        if (text === "~" || text.startsWith("~/")) {
          // 1.1.1 F41 (G17-2): once the text sets HOME, `~` is no longer the server's home.
          if (homeSet() || !PLAIN_WORD.test(text.slice(1) || "a")) fail()
          return home(text)
        }
        // `~` and `^` inside a word are only letters to bash (`HEAD~3`, `HEAD^`), but zsh with EXTENDED_GLOB reads
        // `.env~x` as a pattern that matches `.env`. `command` lets them through for git's revisions alone.
        // Row 276: `--include=*.ts` unquoted. A pattern after `--name=` could only match a file whose name starts with
        // `--name=`, so whatever the shell does with it the program gets the same option.
        if (/^--[a-z][a-z0-9-]*=[\w.*?-]*$/.test(text)) return text
        if (!/^[\w./@%+:,-][\w./@%+:,=~^-]*$/.test(text)) fail()
        if (/[~^]/.test(text)) revisionWords++
        return text
      }
      case "raw_string":
        return node.text.slice(1, -1)
      case "string": {
        if (node.text === '""') return ""
        const parts = named(node)
        // Everything inside the quotes must be one of the parts read here, and nothing but the quotes around them.
        const between = gaps(node, parts)
        if (between[0] !== '"' || between.at(-1) !== '"' || between.slice(1, -1).some((gap) => gap !== "")) fail()
        return parts
          .map((part) => {
            if (part.type !== "string_content") return expansion(part)
            // Row 276: in double quotes the shell removes `\` before `$`, a backquote, `"` or `\`, and a `\` with a line
            // break goes away with it; any other `\` stays. That is what the program gets, so it is what is judged.
            return part.text.replace(/\\([$`"\\\n])/g, (_, next: string) => (next === "\n" ? "" : next))
          })
          .join("")
      }
      case "simple_expansion":
      case "expansion":
        return expansion(node)
      case "concatenation": {
        const parts = named(node)
        if (gaps(node, parts).some((gap) => gap !== "")) fail()
        return parts.map(value).join("")
      }
      default:
        return fail()
    }
  }
  const expansion = (node: Node): string => {
    const parts = named(node)
    const name = parts[0]
    if ((node.type !== "simple_expansion" && node.type !== "expansion") || parts.length !== 1 || name?.type !== "variable_name")
      return fail()
    if (node.text !== `$${name.text}` && node.text !== `\${${name.text}}`) return fail()
    if (name.text === "HOME") return homeSet() ? fail() : os.homedir()
    const known = vars.get(name.text)
    return known === undefined ? fail() : known
  }

  // 1.1.1 F40 (P56 item 7): `NAME=value` before the program, kept as a word of its own in front of it, only for a name of
  // `READ_THROUGH` and a value that passes its rule (bare, or in quotes with nothing to expand; F41 G17-3: no path for
  // the locale, time-zone and terminal names). The consented screen reads such words through; the 1.1.0 table judges the
  // step's words as written.
  const assignment = (node: Node) => {
    const [name, right, ...more] = named(node)
    if (name?.type !== "variable_name" || more.length > 0 || !READ_THROUGH.names.has(name.text)) return fail()
    const raw = right?.text ?? ""
    const quoted = /^(['"]?)([^'"]*)\1$/.exec(raw)
    if (node.text !== `${name.text}=${raw}` || !quoted || !READ_THROUGH.value(name.text, quoted[2]!)) return fail()
    return `${name.text}=${quoted[2]!}`
  }
  // One command: its literal words, the folders it may run in, and what `cd`, `export` or `set` do to what follows.
  const command = (node: Node, cwds: Set<string>, stdin?: string): Where => {
    const children = named(node)
    const words: string[] = []
    let assigned = 0
    revisionWords = 0
    for (const child of children) {
      if (child.type === "variable_assignment") {
        if (words.length !== assigned) fail()
        words.push(assignment(child))
        assigned++
        continue
      }
      // Any other `VAR=x cmd` changes what the program does; a redirect is read where it is attached, never inside a command.
      if (child.type.endsWith("redirect")) fail()
      if (child.type === "command_name") {
        const name = child.namedChildren[0]
        if (child.namedChildCount !== 1 || name?.type !== "word" || !PLAIN_WORD.test(name.text)) fail()
        words.push(name!.text)
        continue
      }
      words.push(value(child))
    }
    const between = gaps(node, children)
    if (between[0]!.trim() !== "" || between.at(-1)!.trim() !== "") fail()
    for (const [index, gap] of between.slice(1, -1).entries()) {
      if (gap !== "" && gap.trim() === "") continue
      // The one word the grammar drops: `-` for "read the program from standard input", before a heredoc.
      if (stdin !== undefined && gap.trim() === "-" && /^\s+-\s+$/.test(gap)) {
        words.splice(index + 1 + words.length - children.length, 0, "-")
        continue
      }
      fail()
    }
    if (words.length === assigned) fail()
    const [name, ...args] = words.slice(assigned)
    if (assigned > 0 && (name === "cd" || name === "set" || name === "export" || stdin !== undefined)) fail()
    if (revisionWords > 0 && name !== "git") fail()
    if (name === "cd") {
      // `-`, `-1` and `+1` are zsh's directory stack. A bare name may be found through CDPATH, anywhere on the disk.
      if (args.length !== 1 || /^[-+]/.test(args[0]!) || stdin !== undefined) fail()
      if (process.env.CDPATH && !/^(\/|\.{1,2}(\/|$))/.test(args[0]!)) fail()
      const targets = new Set([...cwds].map((dir) => path.resolve(dir, args[0]!)))
      cwds.forEach((dir) => place(chdirs, dir, args[0]!))
      return { ok: targets, any: union(cwds, targets) }
    }
    if (name === "set") {
      if (!args.every((arg) => /^[-+][euxo]+$|^pipefail$/.test(arg))) fail()
      return same(cwds)
    }
    // Code fed to an interpreter is screened as code; anything else just reads the text.
    step(words, cwds, stdin !== undefined && INLINE_CODE.has(path.posix.basename(name!)) ? stdin : undefined)
    return same(cwds)
  }

  // `top`: a direct statement of the text, the only place a variable is set for sure before what follows reads it.
  const statement = (node: Node, cwds: Set<string>, top = false): Where => {
    const kids = named(node)
    switch (node.type) {
      case "command": {
        const words = kids.map((kid) => kid.text)
        if (words[0] === "export") {
          if (!top) return fail()
          for (const arg of words.slice(1)) {
            const match = /^([A-Za-z_][A-Za-z0-9_]*)=([\w./@%+:,=-]*)$/.exec(arg)
            if (!match || !HARMLESS_EXPORTS.has(match[1]!)) fail()
            vars.set(match![1]!, match![2]!)
            assigned.push(arg)
          }
          return same(cwds)
        }
        return command(node, cwds)
      }
      case "variable_assignment": {
        const [name, right] = kids
        if (!top || name?.type !== "variable_name" || kids.length > 2) return fail()
        const given = right ? value(right) : ""
        vars.set(name.text, given)
        assigned.push(`${name.text}=${given}`)
        return same(cwds)
      }
      case "list": {
        const operator = node.children.find((child) => child?.type === "&&" || child?.type === "||")?.type
        const [left, right] = kids
        if (!left || !right || kids.length !== 2 || !operator) return fail()
        const first = statement(left, cwds)
        const second = statement(right, operator === "&&" ? first.ok : first.any)
        return { ok: union(second.ok, operator === "||" ? first.ok : []), any: union(first.any, second.any) }
      }
      case "pipeline":
        for (const kid of kids) statement(kid, cwds)
        return same(cwds)
      case "subshell":
        sequence(kids, cwds)
        return same(cwds)
      case "compound_statement":
      case "do_group":
        return sequence(kids, cwds)
      case "negated_command":
        if (kids.length !== 1) return fail()
        return statement(kids[0]!, cwds)
      case "test_command": {
        // `[ ... ]` only: `[[` is bash's own grammar, with patterns this does not read.
        if (!node.text.startsWith("[ ") || !node.text.endsWith(" ]")) return fail()
        const leaves: string[] = []
        const walk = (item: Node) => {
          if (item.type === "unary_expression" || item.type === "binary_expression" || item.type === "parenthesized_expression") {
            for (const child of item.children) {
              if (!child) continue
              if (child.isNamed && child.type !== "test_operator") walk(child)
              else leaves.push(child.text)
            }
            return
          }
          leaves.push(value(item))
        }
        kids.forEach(walk)
        step(["test", ...leaves], cwds)
        return same(cwds)
      }
      case "if_statement":
      case "elif_clause":
      case "else_clause": {
        const clauses = kids.filter((kid) => kid.type === "elif_clause" || kid.type === "else_clause")
        const main = sequence(kids.filter((kid) => !clauses.includes(kid)), cwds)
        const branches = clauses.map((clause) => statement(clause, main.any))
        return {
          ok: union(cwds, main.ok, ...branches.map((branch) => branch.ok)),
          any: union(main.any, ...branches.map((branch) => branch.any)),
        }
      }
      case "for_statement": {
        const variable = node.childForFieldName("variable")
        const body = node.childForFieldName("body")
        const values = node.childrenForFieldName("value").filter((child): child is Node => child !== null)
        if (!variable || !body || values.length === 0 || values.length > MAX_LOOP || vars.has(variable.text)) return fail()
        let possible = new Set(cwds)
        // 1.1.1 F41 (G17-2): a loop over a name that may be in the environment (inherited, so exported) sets it for every
        // program in the body. A lower-case name nobody exported stays local.
        const exported = /[A-Z]/.test(variable.text) || /_proxy$/.test(variable.text) || process.env[variable.text] !== undefined
        for (const item of values) {
          vars.set(variable!.text, value(item))
          if (exported) assigned.push(`${variable!.text}=${vars.get(variable!.text)}`)
          possible = union(possible, statement(body!, cwds).any)
        }
        vars.delete(variable!.text)
        return same(possible)
      }
      case "while_statement": {
        const condition = node.childrenForFieldName("condition").filter((child): child is Node => child !== null)
        const body = node.childForFieldName("body")
        if (condition.length === 0 || !body) return fail()
        const done = sequence(condition, cwds)
        const after = statement(body!, done.ok)
        return same(union(done.any, after.any))
      }
      case "redirected_statement": {
        const body = node.childForFieldName("body")
        const redirects = node.childrenForFieldName("redirect").filter((child): child is Node => child !== null)
        if (!body || redirects.length === 0) return fail()
        // The grammar hangs a trailing redirect on a whole list (`cd /etc && echo x > passwd`), where the shell gives it to
        // the last command, after the `cd`. So a redirect on anything but one command names a file in every folder the
        // body could have been in, before or after it ran: a single folder outside the project is enough to refuse it.
        const result = body.type === "command" ? undefined : statement(body, cwds)
        const where = result ? union(cwds, result.any) : cwds
        let stdin: string | undefined
        for (const redirect of redirects) {
          if (redirect.type === "heredoc_redirect") {
            const parts = named(redirect)
            const start = parts.find((part) => part.type === "heredoc_start")
            const content = parts.find((part) => part.type === "heredoc_body")
            // Only a quoted delimiter keeps the body as written; an unquoted one expands `$` and backquotes in it.
            if (!start || !/^(['"]).+\1$/.test(start.text) || parts.some((part) => !part.type.startsWith("heredoc_"))) return fail()
            if (stdin !== undefined) return fail()
            stdin = content?.text ?? ""
            continue
          }
          if (redirect.type !== "file_redirect") return fail()
          const destinations = redirect.childrenForFieldName("destination").filter((child) => child !== null)
          const destination = destinations[0]
          if (destinations.length !== 1 || !destination) return fail()
          const operator = redirect.text.slice(0, redirect.text.lastIndexOf(destination.text)).trim()
          // `2>&1` and `>&-` move a stream and name no file.
          if (/^\d*[<>]&$/.test(operator) && /^(\d+|-)$/.test(destination.text)) continue
          const target = value(destination)
          if (target === "/dev/null" && /^\d*>>?$|^&>>?$/.test(operator)) continue
          // bash opens `/dev/tcp/host/port` and `/dev/udp/...` as a network connection in a redirect, never as a file.
          if (target.startsWith("/dev/")) return fail()
          if (/^\d*>>?$|^&>>?$|^\d*>\|$/.test(operator))
            [...where].forEach((dir) => {
              writes.add(path.resolve(dir, target))
              if (Reach.upward(target)) place(upward, dir, target)
            })
          else if (/^\d*<$/.test(operator)) step(["cat", target], where)
          else return fail()
        }
        if (result) {
          if (stdin !== undefined) return fail()
          return result
        }
        return command(body, cwds, stdin)
      }
      default:
        return fail()
    }
  }

  const sequence = (nodes: Node[], cwds: Set<string>, top = false): Where => {
    let here = new Set(cwds)
    let ok = new Set(cwds)
    for (const item of nodes) {
      const done = statement(item, here, top)
      ok = done.ok
      // After `;` or a new line the next statement runs whether this one worked or not.
      here = done.any
    }
    return { ok, any: here }
  }

  try {
    if (root.type !== "program" || root.hasError) return undefined
    sequence(named(root), new Set([cwd]), true)
    if (steps.length === 0 && writes.size === 0) return undefined
    return {
      v: 1,
      steps,
      writes: [...writes],
      ...(upward.size > 0 ? { upward: [...upward.values()] } : {}),
      ...(chdirs.size > 0 ? { chdirs: [...chdirs.values()] } : {}),
      ...(assigned.length > 0 ? { assigned } : {}),
    }
  } catch (error) {
    if (error instanceof Unread) return undefined
    throw error
  }
}

/** `decompose` over a text parsed as bash, for the tests and the inventory replay (`research/20_shell_command_inventory.md`). */
export async function readSteps(text: string, cwd: string) {
  const tree = (await parser()).bash.parse(text)
  if (!tree) return undefined
  const found = decompose(tree.rootNode, cwd)
  tree.delete()
  return found
}

/** Every redirect in the command, wherever it sits, and whether each is one this file can vouch for. */
function redirectsIn(root: Node) {
  const writes: string[] = []
  const reads: string[] = []
  const loose: string[] = []
  let unproven = false
  for (const redirect of root.descendantsOfType("file_redirect")) {
    if (!redirect) continue
    const destinations = redirect.childrenForFieldName("destination").filter((node) => node !== null)
    const destination = destinations[0]
    // `echo x > a b` passes `b` to echo, and the grammar files it under the redirect.
    if (destinations.length !== 1 || !destination) {
      unproven = true
      continue
    }
    const operator = redirect.text.slice(0, destination.startIndex - redirect.startIndex).trim()
    const owner = redirect.parent
    const plain =
      owner?.type === "command" ||
      (owner?.type === "redirected_statement" && owner.childForFieldName("body")?.type === "command")
    if (!plain) loose.push((owner ?? redirect).text.trim())
    // `2>&1` and `>&-` move a stream and name no file.
    if (/[<>]&$/.test(operator) && /^(\d+|-)$/.test(destination.text)) continue
    if (!literal({ type: destination.type, text: destination.text })) {
      unproven = true
      continue
    }
    const target = unquote(destination.text)
    if (target === "/dev/null") continue
    if (operator.includes(">")) writes.push(target)
    else reads.push(target)
  }
  return { writes, reads, loose, unproven }
}

// These change the shape of what they read, so no search for the value would find it in their output.
const RESHAPES = new Set([
  "cut", "jq", "yq", "sed", "awk", "gawk", "tr", "rev", "base64", "base32", "xxd", "od", "hexdump", "strings", "fold",
  "openssl", "iconv", "gzip", "zip", "tar",
])
const INLINE_CODE = new Set(["python", "python3", "node", "bun", "deno", "ruby", "perl", "php", "sh", "bash", "zsh"])

function reshapes(tokens: string[]) {
  const name = tokens[0]
  if (!name) return false
  const args = tokens.slice(1)
  if (RESHAPES.has(name)) return true
  if (name === "grep" || name === "rg") return args.some((arg) => /^(-[a-zA-Z]*o|--only-matching)/.test(arg))
  if (name === "head" || name === "tail") return args.some((arg) => /^(-c|--bytes)/.test(arg))
  return INLINE_CODE.has(name) && args.some((arg) => /^-[a-zA-Z]*[ce]/.test(arg))
}

const WORD_BREAK = /[\s'"|;&<>()=,:]+/

/**
 * Row 36b (SEC-01): programs whose output is the bytes of the file as they are, line by line, so the scrubber finds every
 * value it knows in it. Anything else that reads a secret file has its output withheld, because a value cut into pieces,
 * reversed or re-encoded can no longer be recognised. Masking is an accidental-exposure control: a counting oracle such as
 * `grep -c '^KEY=a' .env` cannot be masked (SR-01 item 5).
 */
const METADATA_VIEWERS = new Set([
  "ls", "stat", "wc", "file", "du", "cksum", "md5", "md5sum", "shasum", "sha1sum", "sha224sum", "sha256sum", "sha384sum",
  "sha512sum", "b2sum", "test", "[", "true", "false", "pwd", "cd",
])
const VERBATIM_VIEWERS = new Set([...METADATA_VIEWERS, "cat", "head", "tail", "grep", "egrep", "fgrep", "rg", "diff", "cmp", "nl", "sort", "uniq", "echo"])
const programOf = (tokens: string[]) => (tokens[0] ? path.basename(tokens[0]) : "")

function verbatim(tokens: string[]) {
  const name = programOf(tokens)
  const args = tokens.slice(1)
  if (!VERBATIM_VIEWERS.has(name)) return false
  const has = (pattern: RegExp) => args.some((arg) => pattern.test(arg))
  if (name === "head" || name === "tail") return !has(/^(-[a-zA-Z0-9]*c|--bytes)/)
  if (name === "grep" || name === "egrep" || name === "fgrep" || name === "rg") {
    if (has(/^(-[a-zA-Z]*o|--only-matching|--replace|--colou?r(=(always|auto))?$)/)) return false
    return !(name === "rg" && has(/^-[a-zA-Z]*r/))
  }
  if (name === "diff") return !has(/^(-[a-zA-Z]*[yW]|--side-by-side|--width)/)
  if (name === "cmp") return !has(/^(-[a-zA-Z]*[lb]|--verbose|--print-bytes)/)
  return true
}

/** The load of a file into the shell (`source .env`, `--env-file .env`): it runs things with the values, it shows nothing. */
const LOADERS = new Set(["source", "."])

/** A word with a glob in its last part, as the files it names in one folder (bounded), so `rev .en?` names `.env`. */
function globbed(file: string) {
  const base = path.basename(file)
  if (!/[*?[]/.test(base) || /[*?[]/.test(path.dirname(file))) return []
  try {
    // `[...]` stays a class; a malformed one throws, and then nothing is named by it.
    const pattern = new RegExp("^" + base.replace(/[.+^${}()|\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".") + "$")
    return readdirSync(path.dirname(file))
      .slice(0, 2000)
      .filter((name) => pattern.test(name))
      .map((name) => path.join(path.dirname(file), name))
  } catch {
    return []
  }
}

const WITHHELD_TRANSFORMED = (name: string) =>
  `[hidden:${name} (transformed output of a credential file)]\nthe command ran; its output is withheld because it would show a credential in another form. Shell output withheld: programs you run can still read the file. Do not try to get the same values another way.`
const WITHHELD_WHOLE = (name: string) =>
  `[hidden:${name}]\nThis file holds credentials, so its contents are kept from you. Programs you run can still use it.`

/** Git's output in `cwd`, or undefined when it fails. No shell; the words are git's own. */
function gitIn(cwd: string, args: string[]) {
  return new Promise<string | undefined>((resolve) =>
    execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (error, stdout) =>
      resolve(error ? undefined : stdout),
    ),
  )
}

/**
 * 1.2.6 row 37b (P-01b): `git clean` with the session's `.swarm` folder left out, when it lies under where the command
 * cleans, so a clean never removes the checkpoint made for it (or the archive). Only for a `git clean` the autonomy table
 * read word by word (`checkpointPlan`), whose words are plain. Undefined: nothing to leave out.
 */
function cleanSparing(words: readonly string[], cwd: string, directory: string) {
  const swarm = path.join(directory, ".swarm")
  const rel = path.relative(cwd, swarm)
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined
  const separator = words.indexOf("--")
  const flags = separator < 0 ? words.filter((word) => word.startsWith("-")) : words.slice(0, separator)
  const named = separator < 0 ? words.filter((word) => !word.startsWith("-")) : words.slice(separator + 1)
  return [...flags, "--", ...(named.length > 0 ? named : ["."]), `:(exclude)${rel.split(path.sep).join("/")}`]
}

/**
 * 1.2.6 row 37b: what an I-G checkpoint holds besides the ref names the table read, worked out right before the command
 * runs: the tracked files a hard reset discards, the files a `git clean` removes (its own dry run, with the same words),
 * the branch HEAD names and every local branch and tag of a history rewrite. Undefined when git could not say.
 */
async function gitCheckpoint(plan: Extract<AutonomyTable.CheckpointPlan, { kind: "git" }>, cwd: string, directory: string) {
  const targets: string[] = [...plan.targets]
  const refs: string[] = [...plan.refs]
  if (plan.changed) {
    const out = await gitIn(cwd, ["diff", "--name-only", "--relative", "-z", "HEAD"])
    if (out === undefined) return undefined
    targets.push(...out.split("\0").filter(Boolean).map((file) => path.resolve(cwd, file)))
  }
  if (plan.clean) {
    const words = cleanSparing(plan.clean, cwd, directory) ?? [...plan.clean]
    const out = await gitIn(cwd, ["clean", "-n", ...words])
    if (out === undefined) return undefined
    for (const line of out.split("\n")) {
      const found = /^Would remove (.+)$/.exec(line)
      if (found) targets.push(path.resolve(cwd, found[1]!.replace(/\/$/, "")))
    }
  }
  if (plan.branch) {
    const head = (await gitIn(cwd, ["symbolic-ref", "-q", "HEAD"]))?.trim()
    if (head) refs.push(head)
  }
  if (plan.all) {
    const out = await gitIn(cwd, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags"])
    if (out === undefined) return undefined
    refs.push(...out.split("\n").filter(Boolean))
  }
  return { targets: [...new Set(targets)], refs: [...new Set(refs)] }
}

/**
 * 1.2.6 row 37b: where the shell makes its checkpoints. A test seam (CK-9 cap, CK-12 and T-INV-4 failure); production
 * always calls `ActionCheckpoint.create`. A create that throws counts as a checkpoint that could not be made.
 */
export const checkpointSeam: { create: typeof ActionCheckpoint.create } = { create: (input) => ActionCheckpoint.create(input) }

// Every call asks, unless a rule a person wrote says otherwise. How the text parses never lowers that: the parse only names
// the patterns, labels the prompt and withholds "Allow always", which is offered for one plain command and answers only that.
const ask = Effect.fn("ShellTool.ask")(function* (
  ctx: Tool.Context,
  scan: Scan,
  input: {
    command: string
    cwd: string
    scripts?: Map<string, string | undefined>
    archive?: boolean
    archiveTargets?: string[]
    checkpointTargets?: readonly string[]
    steps?: ShellReading
  },
  always: string | undefined,
) {
  // A bare `cd x` or a text the parser found no command in still asks, as itself.
  const patterns = scan.patterns.size > 0 ? Array.from(scan.patterns) : [input.command]
  // Resolved, so leaving out `workdir` is the same call as naming the folder. The timeout changes nothing it does.
  const call = { tool: ShellID.ToolID, args: { command: input.command, workdir: input.cwd } }
  if (scan.dirs.size > 0) {
    const directories = Array.from(scan.dirs)
    const globs = directories.map((dir) => {
      if (process.platform === "win32") return FSUtil.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: scan.risk || directories.some((dir) => withholdsAlways(dir, "directory")) ? [] : globs,
      metadata: {
        command: input.command,
        workdir: input.cwd,
        directories,
        patterns: globs,
        ...(scan.risk ? { risk: scan.risk } : {}),
      },
      // One command, so one decision: this prompt already shows it.
      follows: [{ permission: ShellID.ToolID, patterns }],
      call,
    })
  }

  const rule = scan.risk || scan.dirs.size > 0 ? undefined : always
  const scripts = [...(input.scripts ?? [])].flatMap(([file, sha256]) => (sha256 ? [{ file, sha256 }] : []))
  yield* ctx.ask({
    permission: ShellID.ToolID,
    patterns,
    always: rule ? [rule] : [],
    metadata: {
      command: input.command,
      // The folder the command runs in, since its relative paths mean nothing without it.
      workdir: input.cwd,
      ...(scan.risk ? { risk: scan.risk } : {}),
      // U11 rule 6, set in autonomous mode only: the hash of each file it may run, as the shell will compare it right
      // before it runs. The table judges a file `script` only when it is listed here with the hash it screened itself.
      ...(scripts.length > 0 ? { scripts } : {}),
      // U11 rule 4, set in autonomous mode only: this shell moves the paths to the archive instead of running the command.
      // The table lets a plain deletion through as `archived` only with this, so no deletion it lets through is for good.
      ...(input.archive ? { archive: true } : {}),
      // C97 F2, set in autonomous mode only: the files a plain `cp` or `mv` would replace, which this shell moves to the
      // archive right before it runs. The table lets a replacing copy or move through as `archived` only with them listed.
      ...(input.archiveTargets && input.archiveTargets.length > 0 ? { archiveTargets: input.archiveTargets } : {}),
      // 1.2.6 row 37b (N-143), set in autonomous mode only: what this shell saves in a checkpoint right before the command
      // runs (`checkpointPlan`). The table lets an action nothing could undo through as `checkpointed` only with them listed.
      ...(input.checkpointTargets ? { checkpointTargets: [...input.checkpointTargets] } : {}),
      // Row 274, set in autonomous mode only: the commands this text runs, read from its parse (`decompose`). The table
      // judges them one by one only where the whole text would otherwise be held as not routine.
      ...(input.steps ? { steps: input.steps } : {}),
    },
    noAlways: rule === undefined,
    call,
  })
})

function cmd(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && Shell.ps(shell)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}
const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

export const ShellTool = Tool.define(
  ShellID.ToolID,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* FSUtil.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const flags = yield* RuntimeFlags.Service
    // Optional, as in `tool.ts`: a shell built on its own, as most of its tests do, has no autonomous mode.
    const autonomy = yield* Effect.serviceOption(Autonomy.Service)
    const sessions = yield* Effect.serviceOption(Session.Service)
    const defaultTimeoutMs = flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000

    const cygpath = Effect.fn("ShellTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return FSUtil.normalizePath(file)
    })

    const resolvePath = Effect.fn("ShellTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && FSUtil.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        return FSUtil.normalizePath(path.resolve(root, FSUtil.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

    const argPath = Effect.fn("ShellTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
      const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
      const file = text && prefix(text)
      if (!file || dynamic(file, ps)) return
      const next = ps ? provider(file) : file
      if (!next) return
      return yield* resolvePath(next, cwd, shell)
    })

    const collect = Effect.fn("ShellTool.collect")(function* (
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
      instance: InstanceContext,
      trust: Tool.Context["trust"],
    ) {
      const scan: Scan = {
        dirs: new Set<string>(),
        patterns: new Set<string>(),
        secretFiles: new Set<string>(),
      }
      const shellKind = ShellID.toKind(Shell.name(shell))
      // A changed directory, variable or function means no argument here can be taken at face value. Windows gets no
      // labels: nothing has been run there to back them up. Nor does a shell whose grammar is not the one parsed here.
      const posix = Boolean(trust) && !ps && shellKind !== "cmd" && process.platform !== "win32" && Shell.posix(shell)
      const redirects = ps ? { writes: [], reads: [], loose: [], unproven: false } : redirectsIn(root)
      const proven = !ps && understood(root)
      const uncertain =
        !posix || !proven || redirects.unproven || commands(root).some((node) => CWD.has(node.firstChild?.text ?? ""))
      const absolute = (file: string) => path.resolve(cwd, home(file))

      const judge = Effect.fn("ShellTool.judge")(function* (tokens: string[]) {
        const unknown = { kind: "unknown" } as const
        const verdict = Risk.classify(tokens.map(unquote))
        if (verdict.kind === "risky") return verdict
        if (uncertain) return unknown
        const listed = verdict.kind === "undoable" ? verdict.paths : []
        const removes = verdict.kind === "undoable" && verdict.removes
        // Anything that writes asks, and these only decide whether that prompt has to say Undo cannot help.
        const changed = [...listed, ...redirects.writes].map(absolute)
        const lost = { kind: "risky", risk: "irreversible" } as const
        for (const file of changed) {
          if (!containsPath(file, instance) || !Reach.inside(file, instance) || Reach.sensitive(file, instance))
            return removes ? lost : unknown
        }
        if (changed.length > 0 && trust?.canUndo) {
          const untrackedOnly = verdict.kind === "undoable" && verdict.untrackedOnly
          const landed = Reach.landsOn(changed, instance)
          if (yield* Effect.promise(() => Reach.outsideSnapshot(instance.worktree, landed, { untrackedOnly }))) return lost
        }
        return unknown
      })

      // Row 36b (SEC-01, SEC-03): what a secret file or a protected place shows is judged by its name and where it lands,
      // so a link `notes.txt` to `.env` and a glob `.en?` count, and Swarm's own credential files and the key folders in
      // the home folder are whole-secret for output (reads of them run without asking now, U12).
      const places = BypassLists.protectedOutputPlaces([Global.Path.home, os.homedir()], Global.Path.data)
      const kinds = new Map<string, "whole" | "lines">()
      const kindOf = (word: string) => {
        const file = absolute(word)
        for (const name of [file, ...globbed(file)]) {
          const kind = Secrets.outputKind(name, places)
          if (kind) kinds.set(name, kind)
          if (kind) return { file: name, kind }
        }
        return undefined
      }
      const named = new Set<string>()
      const read = new Set<string>()
      for (const word of redirects.reads) {
        const found = kindOf(word)
        if (found) named.add(found.file), read.add(found.file)
      }
      let reshaped = false
      let transformed = false
      let content = false
      let printed: string | undefined
      for (const node of commands(root)) {
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        const cmd = ps || shellKind === "cmd" ? tokens[0]?.toLowerCase() : tokens[0]
        if (!ps) {
          const plain = tokens.map(unquote)
          reshaped = reshaped || reshapes(plain)
          transformed = transformed || !verbatim(plain)
          content = content || !METADATA_VIEWERS.has(programOf(plain))
          const program = programOf(plain)
          if (program === "env" || program === "printenv") scan.masked = true
          if (program === "printenv")
            printed = printed ?? plain.slice(1).find((name) => !name.startsWith("-") && Secrets.secretPair(name, "x"))
          const loads = LOADERS.has(program)
          for (const word of plain.slice(1).flatMap((token) => token.split(WORD_BREAK))) {
            const found = word ? kindOf(word) : undefined
            if (!found) continue
            named.add(found.file)
            // `docker run --env-file .env` and `source .env` load the values; what they then print is scrubbed as before.
            if (!loads && !plain.some((arg) => arg === "--env-file" || arg.startsWith("--env-file="))) read.add(found.file)
          }
        }

        if (cmd && (FILES.has(cmd) || (shellKind === "cmd" && CMD_FILES.has(cmd)))) {
          for (const arg of pathArgs(command, ps, shellKind === "cmd")) {
            const resolved = yield* argPath(arg, cwd, ps, shell)
            yield* Effect.logInfo("resolved path", { arg, resolved })
            if (!resolved || containsPath(resolved, instance)) continue
            const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
            scan.dirs.add(dir)
          }
        }

        if (tokens.length && (!cmd || !CWD.has(cmd))) {
          const verdict = posix ? yield* judge(tokens) : undefined
          if (verdict?.kind === "risky") scan.risk = scan.risk === "irreversible" ? scan.risk : verdict.risk
          scan.patterns.add(source(node))
        }
      }

      // A redirect on a whole group belongs to no one command.
      redirects.loose.forEach((text) => scan.patterns.add(text))
      // Something here is not a plain command, such as `[[ -f x ]]`, `x=1` or `export PATH=evil`. The parser's list of
      // commands leaves it out, so the whole text is what a person answers for, and a rule for `ls *` does not cover it.
      if (posix && !proven) {
        const whole = root.text.trim()
        if (whole) scan.patterns.add(whole)
      }
      scan.secretFiles = new Set([...named].filter((file) => kinds.get(file) === "lines"))
      const whole = [...read].find((file) => kinds.get(file) === "whole")
      // A whole secret file or a protected place: only programs that print nothing of it (`ls`, `wc`, a checksum) show
      // their output, as the read tool shows none of it (SEC-01 item 3, SEC-03 item 1).
      if (whole && content) scan.withheld = WITHHELD_WHOLE(path.basename(whole))
      // A secret file read by anything but a verbatim viewer (SEC-01 item 2), or loaded and then reshaped (1.2.5).
      else if ((read.size > 0 && transformed) || (reshaped && named.size > 0))
        scan.withheld = WITHHELD_TRANSFORMED(path.basename([...read, ...named][0]!))
      else if (printed) scan.withheld = `[hidden:${printed}]`
      if (read.size > 0) scan.masked = true

      return scan
    })

    /** Where this session's root is and its autonomy service, when autonomous mode is on there; undefined otherwise. */
    const modeOn = Effect.fn("ShellTool.modeOn")(function* (ctx: Tool.Context) {
      if (Option.isNone(autonomy) || Option.isNone(sessions)) return
      const place = yield* Autonomy.placeOf(sessions.value, ctx.sessionID)
      const where = { root: place.root.id, directory: place.directory }
      if (!(yield* autonomy.value.isOn(where))) return
      return { place, where, autonomy: autonomy.value }
    })

    /**
     * U11 rule 6. Right before a command runs, every file it may run as a script is hashed again and compared with the
     * hash taken before the gate judged it. A file that changed, appeared or went away since means what would run is not
     * what was judged, so nothing runs. A file that is not there either time is no script, so `bun test` runs as usual.
     */
    const scriptChanged = Effect.fn("ShellTool.scriptChanged")(function* (
      before: Map<string, string | undefined>,
      cwd: string,
      instance: InstanceContext,
      ctx: Tool.Context,
    ) {
      const now = yield* Effect.promise(() => scriptHashes([...before.keys()], cwd, instance))
      if ([...before].every(([file, sha256]) => now.get(file) === sha256)) return
      const on = yield* modeOn(ctx)
      // The line is the record that it was stopped; the call is refused whether or not it is written.
      if (on)
        yield* on.autonomy
          .record(on.where.root, {
            type: "outcome",
            directory: on.where.directory,
            requestID: ctx.callID || ctx.messageID,
            outcome: "not_run",
            by: "system:script_changed",
          })
          .pipe(Effect.catch((error) => Effect.logError("could not record a changed script", { error: error.message })))
      yield* Effect.logWarning("a script changed after it was judged, so the command did not run", {
        callID: ctx.callID,
        files: [...before.keys()].filter((file) => now.get(file) !== before.get(file)).length,
      })
      return {
        title: "",
        metadata: {
          output: SCRIPT_CHANGED_TEXT,
          exit: 1 as number | null,
          truncated: false,
          outputPath: undefined as string | undefined,
        },
        output: SCRIPT_CHANGED_TEXT,
      }
    })

    /**
     * U11 rule 4. With autonomous mode on for this session's root, a deletion does not run: a plain one has its paths
     * moved to the archive and the agent reads the register text, anything else that deletes is refused. With the mode
     * off, or without the services, this returns nothing and the command runs as it always has. The permission was
     * already asked, so moving instead only ever does less than the command would have.
     */
    const archive = Effect.fn("ShellTool.archive")(function* (
      found: Deletion | "compound",
      command: string,
      cwd: string,
      ctx: Tool.Context,
    ) {
      const on = yield* modeOn(ctx)
      if (!on) return
      const place = on.place
      const where = on.where
      const done = (output: string, exit: number) => ({
        title: command,
        metadata: { output: preview(output), exit: exit as number | null, truncated: false, outputPath: undefined as string | undefined },
        output,
      })
      if (found === "compound") return done(DELETE_COMPOUND_TEXT, 1)
      const refused = yield* Effect.promise(() => refusedBy(found, cwd))
      if (refused) return done(refused, 1)
      const result = yield* Effect.promise(() =>
        Archive.move({
          directory: place.directory,
          cwd,
          paths: found.paths,
          requestID: ctx.callID ?? ctx.messageID,
          record: Autonomy.archiveRecorder(on.autonomy.record, where),
        }),
      )
      if (!result.ok) return done(result.message, 1)
      if (!result.recorded) yield* Effect.logError("could not record an archived deletion", { archive: result.id })
      const missing =
        result.missing.length > 0
          ? `${found.force ? "Not there, so nothing to move" : "No such file or directory"}: ${result.missing.join(", ")}`
          : ""
      const lines = [result.moved.length > 0 ? Archive.movedText(result.moved.length, result.id) : "", missing]
      return done(lines.filter(Boolean).join("\n"), result.missing.length > 0 && !found.force ? 1 : 0)
    })

    /**
     * C97 F2. With the mode on, what a plain `cp` or `mv` would replace is moved to the archive right before it runs, as a
     * deletion is (row 151), and looked up again now, so a file that appeared since the gate is kept too. Returns the text
     * for the agent, or a result that stops the command when the archive refused: then nothing is replaced.
     */
    const archiveReplaced = Effect.fn("ShellTool.archiveReplaced")(function* (
      item: Risk.CopyMove,
      command: string,
      cwd: string,
      ctx: Tool.Context,
      gate: CopyAtGate,
    ) {
      const on = yield* modeOn(ctx)
      if (!on) return
      const stopped = (text: string) => ({
        stopped: {
          title: command,
          metadata: { output: preview(text), exit: 1 as number | null, truncated: false, outputPath: undefined as string | undefined },
          output: text,
        },
      })
      const notRun = Effect.fn("ShellTool.copyNotRun")(function* (reason: string | undefined) {
        yield* on.autonomy
          .record(on.where.root, {
            type: "outcome",
            directory: on.where.directory,
            requestID: ctx.callID || ctx.messageID,
            outcome: "not_run",
            by: "system:checkpoint_failed",
          })
          .pipe(Effect.catch((error) => Effect.logError("could not record a copy that was not run", { error: error.message })))
        return stopped(checkpointFailedText(reason))
      })
      // 1.2.6 P-02 rule 4 (race): the targets the gate judged must still be the ones the program writes. A name that became a
      // folder since would send the copy somewhere nobody judged, so it does not run.
      const now = Risk.copyTargets(item, cwd)
      if (gate.targets && (!now || now.length !== gate.targets.length || now.some((file, index) => file !== gate.targets![index])))
        return yield* notRun(undefined)
      const paths = yield* Effect.promise(() => replacedBy(item, cwd))
      if (paths.length === 0) return
      const result = yield* Effect.promise(() =>
        Archive.move({
          directory: on.place.directory,
          cwd,
          paths,
          requestID: ctx.callID ?? ctx.messageID,
          record: Autonomy.archiveRecorder(on.autonomy.record, on.where),
        }),
      )
      if (!result.ok) {
        // A target the gate saw as missing appeared since and could not be archived: it is kept as a checkpoint copy
        // instead (C4), or the copy does not run (01b 3.2 rule 4). One the gate saw keeps the archive's answer.
        if (paths.every((file) => gate.archived.includes(file))) return stopped(result.message)
        const saved = yield* Effect.promise(() =>
          checkpointSeam
            .create({
              directory: on.place.directory,
              cwd,
              targets: paths,
              refs: [],
              sessionID: ctx.sessionID,
              requestID: ctx.callID || ctx.messageID,
              command,
              record: Autonomy.checkpointRecorder(on.autonomy.record, on.where),
            })
            .catch((): ActionCheckpoint.CreateResult => ({ ok: false, reason: "failed", message: "" })),
        )
        if (!saved.ok) return yield* notRun(saved.reason)
        if (!saved.recorded) yield* Effect.logError("could not record a checkpoint", { checkpoint: saved.id })
        return { text: ActionCheckpoint.savedText(saved.manifest.entries.length, saved.id, 0) }
      }
      if (!result.recorded) yield* Effect.logError("could not record an archived replacement", { archive: result.id })
      return { text: result.moved.length > 0 ? Archive.movedText(result.moved.length, result.id) : "" }
    })

    /**
     * 1.2.6 row 37b (P-01b, U6; 01b section 3.3 rule 3). With the mode on, an action nothing could undo runs only after a
     * checkpoint of what it changes exists: the gate allowed it, `ActionCheckpoint.create` saves the targets (and refs) and
     * writes the `checkpointed` audit line, and only then does the command run. A checkpoint that cannot be made stops the
     * command with `CHECKPOINT_FAILED_TEXT` and its reason: nothing runs, nothing changes.
     */
    const checkpoint = Effect.fn("ShellTool.checkpoint")(function* (
      plan: Extract<AutonomyTable.CheckpointPlan, { kind: "files" | "git" }>,
      command: string,
      cwd: string,
      ctx: Tool.Context,
    ) {
      const on = yield* modeOn(ctx)
      if (!on) return
      const requestID = ctx.callID || ctx.messageID
      const stop = (reason: string | undefined) =>
        Effect.gen(function* () {
          yield* on.autonomy
            .record(on.where.root, {
              type: "outcome",
              directory: on.where.directory,
              requestID,
              outcome: "not_run",
              by: "system:checkpoint_failed",
            })
            .pipe(Effect.catch((error) => Effect.logError("could not record a failed checkpoint", { error: error.message })))
          const text = checkpointFailedText(reason)
          return {
            stopped: {
              title: command,
              metadata: { output: preview(text), exit: 1 as number | null, truncated: false, outputPath: undefined as string | undefined },
              output: text,
            },
          }
        })
      const found =
        plan.kind === "git"
          ? yield* Effect.promise(() => gitCheckpoint(plan, cwd, on.place.directory))
          : { targets: [...plan.targets], refs: [] as string[] }
      if (!found) return yield* stop("git")
      const result = yield* Effect.promise(() =>
        checkpointSeam
          .create({
            directory: on.place.directory,
            cwd,
            targets: found.targets,
            refs: found.refs,
            sessionID: ctx.sessionID,
            requestID,
            command,
            record: Autonomy.checkpointRecorder(on.autonomy.record, on.where),
          })
          .catch((): ActionCheckpoint.CreateResult => ({ ok: false, reason: "failed", message: "" })),
      )
      if (!result.ok) return yield* stop(result.reason)
      if (!result.recorded) yield* Effect.logError("could not record a checkpoint", { checkpoint: result.id })
      const clean = plan.kind === "git" && plan.clean ? cleanSparing(plan.clean, cwd, on.place.directory) : undefined
      return {
        text: ActionCheckpoint.savedText(result.manifest.entries.length, result.id, result.manifest.refs?.length ?? 0),
        // The clean the plan read, run with the session's `.swarm` left out (`cleanSparing`).
        command: clean ? ["git", "clean", ...clean].map((word) => (/^[\w./@%+,:=-]+$/.test(word) ? word : `'${word}'`)).join(" ") : undefined,
      }
    })

    const shellEnv = Effect.fn("ShellTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      return withoutServerCredentials({ ...process.env, ...extra.env })
    })

    const run = Effect.fn("ShellTool.run")(function* (
      input: {
        shell: string
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        timeout: number
        withheld?: string
        masked?: boolean
      },
      ctx: Tool.Context,
    ) {
      const limits = shellLimits(yield* trunc.limits())
      const keep = limits.maxBytes * 2
      let head = ""
      let dropped = false
      let full = ""
      let last = ""
      const list: Chunk[] = []
      let used = 0
      let file = ""
      let sink: ReturnType<typeof createWriteStream> | undefined
      let cut = false
      let expired = false
      let aborted = false

      const closeSink = Effect.fnUntraced(function* () {
        const stream = sink
        if (!stream) return
        sink = undefined
        if (stream.destroyed || stream.closed) return
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              let settled = false
              const done = () => {
                if (settled) return
                settled = true
                stream.off("close", done)
                stream.off("error", done)
                stream.off("finish", done)
                resolve()
              }
              stream.once("close", done)
              stream.once("error", done)
              stream.once("finish", done)
              stream.end(done)
            }),
        ).pipe(Effect.catch(() => Effect.void))
      })

      const root = (yield* InstanceState.context).worktree
      // Row 36b (SEC-03, SEC-20): a protected read's output, wherever it is shown or saved, gets the assignment rules too.
      const mask = (text: string) => (input.masked ? Secrets.scrubAssigned(text) : text)
      yield* ctx.metadata({
        metadata: {
          output: "",
        },
      })

      const code: number | null = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(closeSink)
          const handle = yield* spawner.spawn(cmd(input.shell, input.command, input.cwd, input.env))
          // Windows commands are not in a group of their own here, so there is nothing to end later.
          if (process.platform !== "win32") {
            const pid = Number(handle.pid)
            yield* Effect.try({ try: () => ShellOrphans.record(ctx.sessionID, pid), catch: String }).pipe(
              Effect.catch((error) => Effect.logWarning("could not record running command", { error })),
            )
            yield* Effect.addFinalizer(() =>
              Effect.try({ try: () => ShellOrphans.clear(ctx.sessionID, pid), catch: String }).pipe(Effect.ignore),
            )
          }

          const reading = yield* Effect.forkScoped(
            Stream.runForEach(Stream.decodeText(handle.all), (chunk) => {
              if (input.withheld) return Effect.void
              const size = Buffer.byteLength(chunk, "utf-8")
              if (head.length < HEAD_BYTES) head += chunk
              list.push({ text: chunk, size })
              used += size
              while (used > keep && list.length > 1) {
                const item = list.shift()
                if (!item) break
                used -= item.size
                dropped = true
              }
              // How much arrives at once depends on how busy the machine is, so one huge chunk has to count the same as many.
              if (used > keep) {
                const text = list[0]!.text.slice(-keep)
                used = Buffer.byteLength(text, "utf-8")
                list[0] = { text, size: used }
                dropped = true
              }

              last = preview(last + chunk)

              if (file) {
                sink?.write(mask(chunk))
              } else {
                full += chunk
                if (Buffer.byteLength(full, "utf-8") > limits.maxBytes) {
                  return trunc.write(mask(full)).pipe(
                    Effect.andThen((next) =>
                      Effect.sync(() => {
                        file = next
                        sink = createWriteStream(next, { flags: "a" })
                        full = ""
                      }),
                    ),
                    Effect.andThen(
                      ctx.metadata({
                        metadata: {
                          output: mask(Secrets.scrub(last, root)),
                        },
                      }),
                    ),
                  )
                }
              }

              // Shown and stored while the command runs, before the final result gets its own pass.
              return ctx.metadata({
                metadata: {
                  output: mask(Secrets.scrub(last, root)),
                },
              })
            }),
          )

          const abort = Effect.callback<void>((resume) => {
            if (ctx.abort.aborted) return resume(Effect.void)
            const handler = () => resume(Effect.void)
            ctx.abort.addEventListener("abort", handler, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
          })

          const timeout = Effect.sleep(`${input.timeout + 100} millis`)

          const exit = yield* Effect.raceAll([
            handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
            abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
            timeout.pipe(Effect.map(() => ({ kind: "timeout" as const, code: null }))),
          ])

          // The exit can land before the last of its output does, and a silence would read as nothing printed. Bounded,
          // because something it left running in the background can hold the pipe open for as long as it likes.
          if (exit.kind === "exit") yield* Fiber.await(reading).pipe(Effect.timeoutOption("1 second"))

          if (exit.kind === "abort") {
            aborted = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }
          if (exit.kind === "timeout") {
            expired = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }

          return exit.kind === "exit" ? exit.code : null
        }),
      ).pipe(Effect.orDie)

      const meta: string[] = []
      if (expired) {
        meta.push(
          `shell tool terminated command after exceeding timeout ${input.timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`,
        )
      }
      if (aborted) meta.push("User aborted the command")
      const raw = list.map((item) => item.text).join("")
      const condensed = condense({ text: raw, command: input.command })
      const whole = tail(condensed.text, limits.maxLines, limits.maxBytes)
      // Saving a large output to a file along the way is not a cut: what matters is whether the agent sees all of it.
      cut = dropped || whole.cut
      // What was hidden stays one read away, so nothing the agent might need is gone.
      if (!file && (cut || condensed.hidden > 0)) file = yield* trunc.write(mask(raw))

      let output = whole.text || "(no output)"
      if (cut) {
        const shown = condense({ text: head, command: input.command }).text.slice(0, HEAD_BYTES)
        const opening = shown.slice(0, Math.max(shown.lastIndexOf("\n"), 0))
        const end = tail(condensed.text, limits.maxLines, limits.maxBytes - HEAD_BYTES).text
        output = `${opening ? opening + "\n\n" : ""}...output truncated...\n\nFull output saved to: ${file}\n\n${end}`
      }
      output = mask(output)
      if (input.withheld) output = input.withheld
      if (!cut && condensed.hidden > 0) output += `\n\n(${condensed.hidden} similar lines hidden. Full output saved to: ${file})`

      if (meta.length > 0) {
        output += "\n\n<shell_metadata>\n" + meta.join("\n") + "\n</shell_metadata>"
      }
      return {
        title: input.command,
        metadata: {
          output: mask(last) || preview(output),
          exit: code,
          truncated: cut,
          ...(file && (cut || condensed.hidden > 0) ? { outputPath: file } : {}),
        },
        output,
      }
    })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const shell = Shell.acceptable(cfg.shell)
        const name = Shell.name(shell)
        const limits = shellLimits(yield* trunc.limits())
        const prompt = ShellPrompt.render(name, process.platform, limits, defaultTimeoutMs)
        yield* Effect.logInfo("shell tool using shell", { shell })

        return {
          description: prompt.description,
          parameters: prompt.parameters,
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const instanceCtx = yield* InstanceState.context
              const cwd = params.workdir
                ? yield* resolvePath(params.workdir, instanceCtx.directory, shell)
                : instanceCtx.directory
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const timeout = params.timeout ?? defaultTimeoutMs
              const ps = Shell.ps(shell)
              const scanned = yield* Effect.scoped(
                Effect.gen(function* () {
                  const tree = yield* Effect.acquireRelease(parse(params.command, ps), (tree) =>
                    Effect.sync(() => tree.delete()),
                  )
                  const scan = yield* collect(tree.rootNode, cwd, ps, shell, instanceCtx, ctx.trust)
                  if (!containsPath(cwd, instanceCtx)) scan.dirs.add(cwd)
                  const posix = !ps && process.platform !== "win32" && Shell.posix(shell)
                  // Taken before the gate judges the files, and compared again right before the command runs.
                  const on = posix ? yield* modeOn(ctx) : undefined
                  const scripts = on
                    ? yield* Effect.promise(() => scriptHashes(scriptFiles(tree.rootNode), cwd, instanceCtx))
                    : undefined
                  const found = posix ? deletion(tree.rootNode) : undefined
                  const copy = on ? copyMove(tree.rootNode) : undefined
                  const archiveTargets = copy ? yield* Effect.promise(() => replacedBy(copy, cwd)) : undefined
                  // 1.2.6 P-02 rule 4: what the gate judges, looked at again right before the copy runs.
                  const copyGate: CopyAtGate | undefined = copy
                    ? { targets: Risk.copyTargets(copy, cwd), archived: archiveTargets ?? [] }
                    : undefined
                  const steps = on ? decompose(tree.rootNode, cwd) : undefined
                  // 1.2.6 row 37b: never both archived and checkpointed (01b section 3.3 rule 5). The folder's trust is the
                  // gate's to judge; the shell only says what it would save.
                  const plan =
                    on && typeof found !== "object" && !(archiveTargets && archiveTargets.length > 0)
                      ? AutonomyTable.checkpointPlan({
                          command: params.command,
                          steps,
                          cwd,
                          instance: instanceCtx,
                          canUndo: ctx.trust?.canUndo ?? false,
                          folder: "trusted",
                        })
                      : undefined
                  const saving = plan && (plan.kind === "files" || plan.kind === "git") ? plan : undefined
                  yield* ask(
                    ctx,
                    scan,
                    // `archive` below moves exactly when the mode is on and this is one plain deletion.
                    {
                      command: params.command,
                      cwd,
                      scripts,
                      archive: Boolean(on) && typeof found === "object",
                      archiveTargets,
                      checkpointTargets: saving?.targets,
                      steps,
                    },
                    posix ? Reach.alwaysFor(params.command, cwd, instanceCtx) : undefined,
                  )
                  return { ...scan, deletion: found, scripts, copy, copyGate, saving }
                }),
              )
              scanned.secretFiles.forEach(Secrets.learnFile)

              if (scanned.deletion) {
                const archived = yield* archive(scanned.deletion, params.command, cwd, ctx)
                if (archived) return archived
              }

              const env = yield* shellEnv(ctx, cwd)
              if (scanned.scripts && scanned.scripts.size > 0) {
                const changed = yield* scriptChanged(scanned.scripts, cwd, instanceCtx, ctx)
                if (changed) return { ...changed, title: params.command }
              }
              const kept =
                scanned.copy && scanned.copyGate
                  ? yield* archiveReplaced(scanned.copy, params.command, cwd, ctx, scanned.copyGate)
                  : undefined
              if (kept && "stopped" in kept) return kept.stopped
              // 1.2.6 row 37b: the checkpoint exists before anything of the command runs, or the command does not run.
              const saved = scanned.saving ? yield* checkpoint(scanned.saving, params.command, cwd, ctx) : undefined
              if (saved && "stopped" in saved) return saved.stopped
              const result = yield* run(
                {
                  shell,
                  command: saved?.command ?? params.command,
                  cwd,
                  env,
                  timeout,
                  withheld: scanned.withheld,
                  masked: scanned.masked,
                },
                ctx,
              )
              const told = [kept && "text" in kept ? kept.text : undefined, saved?.text].filter(Boolean).join("\n")
              return told ? { ...result, output: `${told}\n${result.output}` } : result
            }),
        }
      })
  }),
)
