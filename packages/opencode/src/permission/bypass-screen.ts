// Swarm 1.1.1 (spec S1.20-S1.27): what the consented bypass must never open, read off a shell command's words. Pure: no
// Effect, no I/O beyond the fixed-pattern script screen of a heredoc's text. The overlay in `autonomy-table.ts` asks this
// before it lets the main agent decide a call, so an X trigger is refused by code and a D trigger stays for a person,
// whatever any agent says. What this cannot read word by word it does not open (S1.26). 1.1.1 F7 (P15): what it opens is
// an allowlist (`allowlisted`); the only I/O beyond the script screen is the allowlist's look at the step's folder (its
// manifest's script names, its own `node_modules/.bin`, its Python environment, whether a word names a path).
import fs from "node:fs"
import path from "node:path"
import type { AutonomyTable } from "./autonomy-table"
import { commandWords, consentPush, shellReading } from "./autonomy-table"
import { OutwardConsent } from "./outward-consent"
import {
  ADMIN,
  DISK_WIPE,
  FIND_EXEC,
  GIT_OUTWARD,
  HARD_SCRIPT_FLAGS,
  HOST,
  MIGRATE_WIPE,
  OUTWARD,
  RUNS_TEXT,
  SHELLS,
  SQL_TOOLS,
  SQL_WIPE,
  SYSTEM_SERVICE,
  BypassLists,
} from "./bypass-lists"
import { ScriptScreen } from "./script-screen"
import { ScriptReader } from "./script-reader"
import { DeletionWords } from "../tool/deletion"
import { containsPath } from "../project/instance-context"
import { Reach } from "../tool/reach"
import { Risk } from "../tool/risk"
import type { ShellPlace } from "../tool/shell"

export type XTrigger = "irreversible" | "admin_rights" | "delete_compound"
export type DTrigger =
  | "outward"
  | "system_service"
  | "process_not_own"
  | "unreadable_command"
  | "script_flagged"
  | "outside_write_held"
export type Screen = { x?: XTrigger; d?: DTrigger }

type Step = { argv: readonly string[]; cwds: readonly string[]; code?: string }

const dynamic = (word: string) => /[$`]/.test(word)
const base = (word: string) => path.posix.basename(word)
const shortHas = (word: string, letters: string) =>
  /^-[^-]/.test(word) && [...word.slice(1)].some((letter) => letters.includes(letter))

/**
 * 1.1.1 F40 (P56 usability item 7): leading `NAME=value` words before a program, read through when every name is one of
 * `BypassLists.SAFE_ASSIGNMENT` with a plain value: the program after them is judged as if it were typed alone. Any other
 * leading assignment (`PATH`, `NODE_OPTIONS`, `LD_*`, `GIT_*`, ...) leaves the words as they are, so the allowlist does not
 * accept the step and the call keeps its verdict. Only the consented screen reads steps this way; the 1.1.0 table judges
 * the shell's words as written.
 */
export function readThrough(argv: readonly string[]): readonly string[] {
  let at = 0
  while (at < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[at]!)) at++
  if (at === 0 || at === argv.length) return argv
  return argv.slice(0, at).every((word) => BypassLists.SAFE_ASSIGNMENT.test(word)) ? argv.slice(at) : argv
}
/**
 * `shellReading`, with each step's leading assignments read through (`readThrough`). 1.1.1 F41 (G17-2): a text that sets
 * any name outside `BypassLists.HARMLESS_EXPORTS`, or such a name to a path (G17-3), for its later steps is read but not
 * complete, so the consent never opens it and it keeps 1.1.0: its later steps may run with another home, search path or
 * config pointer than the server's, which every consented check assumes.
 */
function consentReading(value: unknown, instance?: AutonomyTable.Input["instance"]) {
  const reading = shellReading(value, instance)
  if (!reading) return reading
  const steps = reading.steps.map((step) => ({ ...step, argv: readThrough(step.argv) as string[] }))
  return { ...reading, steps, complete: reading.complete && reading.assigned.every(BypassLists.harmlessAssignment) }
}

/**
 * The commands of the input as argv lists: the shell's own reading (`metadata.steps`) when its shape is valid, else the
 * command as one program with literal words (`Risk.quotedWords`; the program may be a path, as a step of `classifySteps`
 * writes it), else undefined: nothing here can be read word by word.
 */
export function readSteps(
  input: Pick<AutonomyTable.Input, "metadata" | "cwd"> & Partial<Pick<AutonomyTable.Input, "bypass">>,
): Step[] | undefined {
  // 1.1.1 F22 (n54): only the steps are wanted here, but the reading is taken whole on purpose. A redirect through a link
  // loop makes it undefined, and then the call is read as one literal text or not at all (`screen` answers
  // `unreadable_command`, D-F20-3). Inside a classify's scope the landings it works out are memo hits for the other passes.
  const reading = consentReading(input.metadata.steps)
  if (reading && reading.steps.length > 0) return reading.steps
  const command = input.metadata.command
  if (typeof command !== "string") return undefined
  const words = literalWords(command.trim()) ?? assignedWords(command.trim())
  if (words && words.length > 0) return [{ argv: readThrough(words) as string[], cwds: [input.cwd] }]
  // 1.1.1 F30 (P46, G12-8): under consent only, a request whose header or body takes a `$NAME`, or whose URL is unquoted.
  return input.bypass ? requestSteps(command.trim(), input.cwd) : undefined
}

/**
 * 1.1.1 F30 (P46, G12-8, V12-2): under consent, the steps of a call the shell's reader leaves unread only because a request
 * tool's word holds a plain `$NAME` or `${NAME}` inside double quotes (a token from the environment), or an unquoted `?`,
 * `[`, `]` or `*` in a URL that can match no file. Read here by a small reader of its own: words of plain characters,
 * single quotes, and double quotes whose only expansions are plain names; steps split at `&&`, `||`, `|` and `;`. Anything
 * else (a substitution, a redirect, a `~`, a brace, a backslash outside double quotes, a newline, an assignment, a `cd`)
 * gives undefined, so the call stays unread. Only a request tool's words may hold an expansion or a pattern character,
 * and which of its words may hold one is the request reader's to say (`OutwardConsent.request`): never the program, the
 * URL or an option that names a file. A pattern word must have a folder part whose first name is not in the folder, so the
 * shell finds nothing to match and passes the word on as written (or, set to fail on no match, runs nothing).
 */
function requestSteps(command: string, cwd: string): Step[] | undefined {
  if (!command || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(command.replace(/\t/g, " "))) return undefined
  const steps: { words: string[]; marked: boolean[] }[] = [{ words: [], marked: [] }]
  let word: string | undefined
  let marked = false
  let pattern = false
  const end = () => {
    if (word === undefined) return
    const step = steps.at(-1)!
    // A pattern word whose first folder name is there (or has no folder part) could match a file.
    if (pattern) {
      const slash = word.indexOf("/")
      const first = slash < 0 ? undefined : word.slice(0, slash)
      const matchable = first === undefined || first === "" || /[?*[\]]/.test(first) || fs.existsSync(path.join(cwd, first))
      if (matchable) word = "\0"
    }
    step.words.push(word)
    step.marked.push(marked || pattern)
    word = undefined
    marked = false
    pattern = false
  }
  const split = () => {
    end()
    if (steps.at(-1)!.words.length === 0) return false
    steps.push({ words: [], marked: [] })
    return true
  }
  for (let index = 0; index < command.length; ) {
    const char = command[index]!
    if (char === " ") {
      end()
      index++
      continue
    }
    if (char === "'") {
      const close = command.indexOf("'", index + 1)
      if (close < 0) return undefined
      word = (word ?? "") + command.slice(index + 1, close)
      index = close + 1
      continue
    }
    if (char === '"') {
      let text = ""
      index++
      for (; index < command.length && command[index] !== '"'; ) {
        const inner = command[index]!
        if (inner === "\\") {
          const next = command[index + 1]
          if (next === undefined) return undefined
          // Inside double quotes a backslash quotes only these; before anything else it is itself.
          if (next === '"' || next === "\\") text += next
          else if (next === "$" || next === "`") return undefined
          else text += `\\${next}`
          index += 2
          continue
        }
        if (inner === "`" || inner === "!") return undefined
        if (inner === "$") {
          const name = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/.exec(command.slice(index))
          if (!name) return undefined
          text += name[0]
          marked = true
          index += name[0].length
          continue
        }
        text += inner
        index++
      }
      if (index >= command.length) return undefined
      index++
      word = (word ?? "") + text
      continue
    }
    if ((char === "&" && command[index + 1] === "&") || (char === "|" && command[index + 1] === "|")) {
      if (!split()) return undefined
      index += 2
      continue
    }
    if (char === "|" || char === ";") {
      if (!split()) return undefined
      index++
      continue
    }
    if (/[\w./@%+:,=-]/.test(char)) {
      word = (word ?? "") + char
      index++
      continue
    }
    if (char === "?" || char === "[" || char === "]" || char === "*") {
      word = (word ?? "") + char
      pattern = true
      index++
      continue
    }
    return undefined
  }
  end()
  if (steps.at(-1)!.words.length === 0) return undefined
  let any = false
  for (const step of steps) {
    const program = step.words[0]!
    if (!/^[A-Za-z0-9][\w.+-]*$/.test(program) || step.marked[0]) return undefined
    if (CHANGES_PLACE.has(program)) return undefined
    const marks = step.marked.some(Boolean)
    if (marks && !OutwardConsent.REQUEST_TOOLS.has(program)) return undefined
    if (step.words.includes("\0")) return undefined
    any ||= marks
  }
  // Only what the shell's reader leaves unread for these reasons is read here.
  return any ? steps.map((step) => ({ argv: step.words, cwds: [cwd] })) : undefined
}
/** Programs that change where, or with what, the later steps of a call run. */
const CHANGES_PLACE = new Set(["cd", "pushd", "popd", "export", "source", ".", "eval", "exec", "set", "unset", "alias", "declare", "typeset", "local", "readonly", "builtin", "command"])

/**
 * 1.1.1 F40 (P56 usability item 7): a one-program text the shell's reader leaves unread only because it starts with
 * `NAME=value` words (`CI=1 npm test`): each of them one of `BypassLists.SAFE_ASSIGNMENT` with a plain value, and the rest
 * literal words. Anything else: undefined.
 */
function assignedWords(command: string) {
  const prefix: string[] = []
  let rest = command
  for (let found = /^([A-Za-z_][A-Za-z0-9_]*=\S*) +/.exec(rest); found; found = /^([A-Za-z_][A-Za-z0-9_]*=\S*) +/.exec(rest)) {
    if (!BypassLists.SAFE_ASSIGNMENT.test(found[1]!)) return undefined
    prefix.push(found[1]!)
    rest = rest.slice(found[0].length)
  }
  if (prefix.length === 0) return undefined
  const words = literalWords(rest)
  return words && words.length > 0 ? [...prefix, ...words] : undefined
}

function literalWords(command: string) {
  const direct = Risk.quotedWords(command)
  if (direct) return direct
  // `Risk.quotedWords` takes only a bare name for the program. A path to one (`/usr/bin/git`) is as plain a word.
  const first = command.split(" ", 1)[0]!
  if (!/^[\w./@%+:,-]+$/.test(first) || first === command) return /^[\w./@%+:,-]+$/.test(command) ? [command] : undefined
  const rest = Risk.quotedWords(`p${command.slice(first.length)}`)
  return rest ? [first, ...rest.slice(1)] : undefined
}

type Unwrapped =
  | { kind: "admin" }
  | { kind: "unreadable" }
  | { kind: "code"; code: string }
  | { kind: "program"; name: string; spelled: string; args: string[]; viaXargs: boolean; assignments: string[] }
  | { kind: "none" }

/**
 * The program a step runs once `VAR=value` words and every launcher are out of the way: the wide reader of
 * `DeletionWords.launched` (1.1.1 F1b, P10 H1), so `caffeinate`, `stdbuf`, `rtk`, `npx` or `watch` hide nothing. A step
 * under `sudo` or `doas` is admin rights; a launcher that runs a shell text gives that text.
 */
export function unwrap(argv: readonly string[]): Unwrapped {
  const found = DeletionWords.launched(argv)
  if (found.launchers.some((name) => ADMIN.has(name))) return { kind: "admin" }
  if (found.kind === "program")
    return { kind: "program", name: found.name, spelled: found.spelled, args: found.args, viaXargs: found.fed, assignments: found.assignments }
  return found.kind === "code" ? { kind: "code", code: found.code } : { kind: found.kind }
}

/**
 * 1.1.1 F12a (P5, n21): a step of the call, as the shell reads it, runs `kill` (past every launcher). Only then does the
 * gate look up this session's own processes; a word "kill" in a message or a file name is no kill.
 */
export function namesKill(input: Pick<AutonomyTable.Input, "metadata" | "cwd">): boolean {
  const steps = readSteps(input)
  return (
    steps?.some((step) => {
      const program = unwrap(step.argv)
      return program.kind === "program" && program.name === "kill"
    }) ?? false
  )
}

/** S1.27: every target of `kill` is a pid Swarm started (`own`), and none is this server. */
export function killIsOwn(args: readonly string[], own: ReadonlySet<number> | undefined): boolean | "harmless" {
  const targets: string[] = []
  let ended = false
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    if (ended) {
      targets.push(word)
      continue
    }
    if (word === "--") {
      ended = true
      continue
    }
    if (word === "-l" || word === "-L" || word === "--list" || word === "--table") return "harmless"
    if (word === "-s" || word === "-n" || word === "--signal") {
      index++
      continue
    }
    if (/^-[A-Za-z0-9]+$/.test(word) && targets.length === 0) continue
    targets.push(word)
  }
  if (targets.length === 0 || !own) return false
  return targets.every((word) => {
    if (!/^[1-9]\d*$/.test(word)) return false
    const pid = Number(word)
    return pid !== process.pid && own.has(pid)
  })
}

function gitScreen(args: readonly string[]): Screen {
  const [sub, ...rest] = Risk.gitCommand([...args])
  if (sub === undefined) return {}
  if (dynamic(sub)) return { d: "unreadable_command" }
  const shortOf = (letters: string) => rest.some((word) => shortHas(word, letters))
  const longOf = (...names: string[]) => rest.some((word) => Risk.long(word, ...names))
  if (sub === "reset" && longOf("hard")) return { x: "irreversible" }
  if (sub === "clean" && (shortOf("f") || longOf("force"))) return { x: "irreversible" }
  if (sub === "push") {
    const force =
      longOf("force", "force-with-lease", "force-if-includes", "mirror", "delete", "prune") ||
      shortOf("fd") ||
      rest.some((word) => /^[+:]/.test(word))
    if (force) return { x: "irreversible" }
    return rest.some(dynamic) ? { d: "unreadable_command" } : { d: "outward" }
  }
  if (sub === "branch") {
    const del = shortOf("d") || longOf("delete")
    const force = shortOf("f") || longOf("force")
    if (rest.some((word) => shortHas(word, "D")) || (del && force)) return { x: "irreversible" }
  }
  if (sub === "rebase" || sub === "filter-branch" || sub === "filter-repo") return { x: "irreversible" }
  if (rewritesHistory(sub, rest)) return { x: "irreversible" }
  // `update-ref -d` drops a ref and its reflog with it (decision R2-D2).
  if (sub === "update-ref" && rest.some((word) => word === "-d" || Risk.long(word, "delete"))) return { x: "irreversible" }
  if (sub === "reflog" && (rest[0] === "expire" || rest[0] === "delete")) return { x: "irreversible" }
  if (sub === "gc" && longOf("prune")) return { x: "irreversible" }
  if (sub === "stash" && (rest[0] === "drop" || rest[0] === "clear")) return { x: "irreversible" }
  if (rest.some(dynamic)) return { d: "unreadable_command" }
  if (GIT_OUTWARD.has(sub)) return { d: "outward" }
  if (sub === "remote" && rest.find((word) => !word.startsWith("-")) === "update") return { d: "outward" }
  // 1.1.1 F10a (G3-5): showing a remote asks it for its branches unless told not to (`-n`), and pruning one asks it what
  // is gone, as a fetch does; `set-head --auto` asks it for its HEAD.
  if (sub === "remote") {
    const action = rest.find((word) => !word.startsWith("-"))
    const offline = rest.includes("-n")
    if (action === "show" && !offline) return { d: "outward" }
    if (action === "prune" && !offline && !rest.some((word) => word === "--dry-run")) return { d: "outward" }
    if (action === "set-head" && rest.some((word) => word === "-a" || Risk.long(word, "auto"))) return { d: "outward" }
  }
  return {}
}

/**
 * 1.1.1 F9 (decisions P15 G2-2, P16, A1): a git form that rewrites a commit or moves, deletes or force-moves a ref. Under
 * consent it is refused as irreversible; without consent the screen is never asked, so 1.1.0 is unchanged. `rest` is what
 * follows the subcommand. Long options are matched as git abbreviates them (`--am` is `--amend`).
 */
function rewritesHistory(sub: string, rest: readonly string[]) {
  const shortOf = (letters: string) => rest.some((word) => shortHas(word, letters))
  const longOf = (...names: string[]) => rest.some((word) => Risk.long(word, ...names))
  const before = rest.indexOf("--") < 0 ? rest : rest.slice(0, rest.indexOf("--"))
  const positional = before.filter((word) => !word.startsWith("-"))
  if (sub === "commit") return longOf("amend")
  // As `tool/risk.ts` reads it: only a reset naming no commit, or HEAD itself, leaves the branch where it is. A bare name
  // may be a path (`git reset a.ts`), and that one is refused too rather than guessed at.
  if (sub === "reset") return !(positional.length === 0 || (positional.length === 1 && positional[0] === "HEAD"))
  if (sub === "update-ref") return true
  // `git symbolic-ref HEAD` reads; a second name, or -d, points HEAD (or another symbolic ref) somewhere else.
  if (sub === "symbolic-ref") return positional.length >= 2 || shortOf("d") || longOf("delete")
  if (sub === "replace") return rest.some((word) => !["-l", "--list"].includes(word) && !word.startsWith("--format"))
  // Any deletion of a branch (its reflog goes with it), a forced create or move, a forced rename or copy.
  if (sub === "branch") return shortOf("dDfMC") || longOf("delete", "force")
  if (sub === "tag") return shortOf("df") || longOf("delete", "force")
  // `checkout -B` and `switch -C` reset a branch that already exists to another commit.
  if (sub === "checkout" || sub === "switch") return shortOf(sub === "checkout" ? "B" : "C") || longOf("force-create")
  // A pull that rebases rewrites the local commits it replays.
  if (sub === "pull")
    return shortOf("r") || rest.some((word) => Risk.long(word, "rebase") && !/=(false|no)$/i.test(word))
  return false
}

/** A word naming an address with a scheme (`https://`, `ssh://`, `s3://`), other than a local `file://`. */
function addressesOut(word: string) {
  let at = word.indexOf("://")
  while (at >= 0) {
    const scheme = /([A-Za-z][A-Za-z0-9+.-]*)$/.exec(word.slice(0, at))?.[1]
    if (scheme?.toLowerCase() !== "file") return true
    at = word.indexOf("://", at + 3)
  }
  return false
}

/** What a step's P42 reading needs from the call (1.1.1 F26). Absent `bypass`: none is made, as without consent. */
type SendContext = Partial<Pick<AutonomyTable.Input, "bypass" | "outward" | "whole" | "metadata">> &
  Pick<AutonomyTable.Input, "instance">

/**
 * 1.1.1 F26 (P42): how the consent reads one step that sends, in folder `cwd`: a request, a publish, image push, deploy,
 * pull request or release, or a `git push`. undefined: the step sends nothing P42 knows (its other rules judge it).
 */
function sendStep(argv: readonly string[], cwd: string, input: SendContext): OutwardConsent.Reading | undefined {
  // 1.1.1 F29 (P44, D-F26-5 reversed): a hosted deploy through `npx`, `bunx`, `bun x` or `pnpm dlx` is read as the bare form.
  const launched = launchedSend(argv, cwd, input.instance)
  const context = { instance: input.instance }
  if (launched) return OutwardConsent.sendForm(launched[0]!, launched.slice(1), cwd, context)
  const found = unwrap(argv)
  if (found.kind !== "program" || found.viaXargs) return undefined
  // Otherwise only the step's own program: one handed on by any other launcher (`rtk curl`, `npx -p x vercel`) is never
  // read as a send here.
  if (argv.find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) !== found.spelled) return undefined
  const whole = input.whole ?? (typeof input.metadata?.command === "string" ? input.metadata.command : "")
  return (
    OutwardConsent.request(found.name, found.args, input.outward, whole) ??
    zshNetSend(found.name, found.args, input.outward, whole) ??
    OutwardConsent.sendForm(found.name, found.args, cwd, context) ??
    (found.name === "git" ? consentPush(["git", ...found.args], cwd, input) : undefined)
  )
}

/**
 * 1.2.7 row 47j (U9-5, C76): zsh's network builtins under consent, judged as curl's request is for the same destination
 * (`OutwardConsent.hostOpens`: a local host, or one the person named), with no rule beyond curl's. `ztcp [-v] [-d fd] host
 * [port]` and `zftp open|params host [port] …` name their host; a `<` in the call holds, as it holds curl (an upload). A
 * close (`ztcp -c`), a list (`ztcp`, `ztcp -L`) or another `zftp` sub-command sends nothing of its own (each call is a new
 * shell, so no session is open before it). A listen or accept (`ztcp -l`, `-a`), `zsocket` (a unix socket, as curl's
 * `--unix-socket` is not read either) and anything not written out stay unread: undefined, so `outward` judges them.
 */
const ZTCP_VALUE = new Set(["-d"])
function zshNetSend(name: string, args: readonly string[], known: Parameters<typeof OutwardConsent.hostOpens>[1], whole: string): OutwardConsent.Reading | undefined {
  if (name !== "ztcp" && name !== "zftp") return undefined
  if (args.some((word) => /[$`\\{}*?[\]]/.test(word))) return undefined
  const opened = (host: string | undefined, port: string | undefined): OutwardConsent.Reading => {
    if (host === undefined || host === "" || (port !== undefined && !/^\d{1,5}$/.test(port))) return { held: "unread" }
    if (whole.includes("<")) return { held: "upload" }
    if (!OutwardConsent.hostOpens(host, known)) return { held: "host" }
    return { destinations: [port === undefined ? host : `${host}:${port}`], outputs: [] }
  }
  if (name === "zftp") {
    const [sub, host, port] = args
    if (sub === "open" || sub === "params") return opened(host, port !== undefined && /^\d+$/.test(port) ? port : undefined)
    return sub === undefined || sub.startsWith("-") ? undefined : { destinations: [], outputs: [] }
  }
  const positional: string[] = []
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    if (ZTCP_VALUE.has(word)) {
      index++
      continue
    }
    if (word === "-v" || word === "-t") continue
    if (word === "-c" || word === "-L") return { destinations: [], outputs: [] }
    if (word.startsWith("-")) return undefined
    positional.push(word)
  }
  if (positional.length === 0) return { destinations: [], outputs: [] }
  if (positional.length > 2) return { held: "unread" }
  return opened(positional[0], positional[1])
}

/**
 * 1.1.1 F29 (P44, D-F26-5 reversed): the launchers that find or fetch a package's program and run it, and the packages
 * whose program is a hosted deploy P42 opens. A package name the launcher would fetch is one whose program is the deploy
 * tool (`netlify-cli`, `firebase-tools`); the program's own name (`netlify`, `firebase`) names another package on the
 * registry, so it counts only when the project has that program in its `node_modules/.bin`. A version or tag after the
 * name (`vercel@latest`), any launcher option but `-y`/`--yes`/`-q`/`--quiet` of `npx`, or any other launcher: not read.
 */
const LAUNCHED_DEPLOYS: Readonly<Record<string, string>> = { vercel: "vercel", "netlify-cli": "netlify", "firebase-tools": "firebase" }
const LAUNCHED_LOCAL_ONLY = new Set(["netlify", "firebase"])
const NPX_QUIET = new Set(["-y", "--yes", "-q", "--quiet"])

/** The deploy step a launcher runs, as `[program, ...args]`, or undefined when the step is no such launch. */
function launchedSend(argv: readonly string[], cwd: string, instance: AutonomyTable.Input["instance"]): string[] | undefined {
  const at = argv.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
  if (at < 0) return undefined
  const [launcher, ...rest] = argv.slice(at)
  let words: readonly string[]
  if (launcher === "npx") {
    const first = rest.findIndex((word) => !NPX_QUIET.has(word))
    words = first < 0 ? [] : rest.slice(first)
  } else if (launcher === "bunx") words = rest
  else if (launcher === "bun" && rest[0] === "x") words = rest.slice(1)
  else if (launcher === "pnpm" && rest[0] === "dlx") words = rest.slice(1)
  else return undefined
  const spelled = words[0]
  if (spelled === undefined) return undefined
  const program = Object.hasOwn(LAUNCHED_DEPLOYS, spelled)
    ? LAUNCHED_DEPLOYS[spelled]
    : LAUNCHED_LOCAL_ONLY.has(spelled) &&
        upward(cwd, instance).some((dir) => fs.existsSync(path.join(dir, "node_modules", ".bin", spelled)))
      ? spelled
      : undefined
  return program === undefined ? undefined : [program, ...words.slice(1)]
}

const opens = (reading: OutwardConsent.Reading | undefined): reading is OutwardConsent.Opened =>
  reading !== undefined && !("held" in reading)

/** 1.1.1 F26 (P42): under consent, the step sends only where P42 lets it, in every folder it may run in. */
function stepSends(step: Step, input: SendContext) {
  return input.bypass !== undefined && step.code === undefined && step.cwds.every((cwd) => opens(sendStep(step.argv, cwd, input)))
}

/**
 * 1.1.1 F26 (P42): every destination of a call the consent lets out, in step order, or undefined when no step sends where
 * P42 opens or a step sends where it does not. The rest of the call is judged by the overlay's other rules.
 */
export function outwardOpened(input: AutonomyTable.Input): string[] | undefined {
  if (input.permission !== "bash" || !input.bypass || typeof input.metadata.command !== "string") return undefined
  // 1.1.1 F30 (G12-P2): once per classify; the allowlist's walk may already have found them.
  return Reach.classifyMemo(outwardKey(input), () => walkOutward(input))
}

function walkOutward(input: AutonomyTable.Input): string[] | undefined {
  counters.outwardWalks++
  const steps = readSteps(input)
  if (!steps) return undefined
  const found: string[] = []
  // 1.1.1 F29 (P44, D-F26-5 reversed): a step that runs a project script by name sends where the sends inside it do, as
  // the allowlist reads them (only marks, no write is asked about: rule 9 still judges the call in full).
  let env: Env | undefined
  for (const step of steps) {
    for (const cwd of step.cwds) {
      const reading = step.code === undefined ? sendStep(step.argv, cwd, input) : undefined
      if (reading === undefined) {
        if (step.code !== undefined || scriptNamed(step.argv) === undefined) continue
        env ??= newEnv(input, true)
        env.collect = []
        if (allowedStep(step.argv, cwd, env, 0)) found.push(...env.collect)
        continue
      }
      if ("held" in reading) return undefined
      found.push(...reading.destinations)
    }
  }
  return found.length > 0 ? [...new Set(found)] : undefined
}

/** 1.1.1 F26 (P42): the shell's `remote` label is explained by steps P42 lets out, each of them. */
function remoteSent(input: AutonomyTable.Input, steps: readonly Step[] | undefined) {
  if (!input.bypass || input.metadata.risk !== "remote" || !steps) return false
  const remote = steps.filter((step) => {
    const label = Risk.classify([...step.argv])
    return label.kind === "risky" && label.risk === "remote"
  })
  return remote.length > 0 && remote.every((step) => stepSends(step, input))
}

/** One step's triggers. `own` is the gate's set of processes Swarm started. */
function stepScreen(step: Step, input: Pick<AutonomyTable.Input, "instance" | "ownProcesses"> & Partial<SendContext>, depth = 0): Screen {
  if (step.code !== undefined) {
    const hard = step.cwds.some((cwd) =>
      ScriptScreen.flags(step.code!, { roots: [input.instance.directory, input.instance.worktree], cwd }).some((flag) =>
        HARD_SCRIPT_FLAGS.has(flag),
      ),
    )
    if (hard) return { d: "script_flagged" }
  }
  const found = unwrap(step.argv)
  if (found.kind === "admin") return { x: "admin_rights" }
  if (found.kind === "unreadable") return { d: "unreadable_command" }
  if (found.kind === "code") {
    // A launcher that runs a shell text (`watch`, `hyperfine`, `npx -c`): never readable word by word, and what it would
    // run is still looked at for X, as a text nobody can read is.
    const inner = depth > 4 ? undefined : textX(found.code, step, input, depth + 1)
    return inner ? { x: inner } : { d: "unreadable_command" }
  }
  if (found.kind === "none") return {}
  const { name, spelled, args } = found
  const outwardWord = step.argv.some(addressesOut)
  if (dynamic(spelled)) return { d: "unreadable_command" }
  if (ADMIN.has(name)) return { x: "admin_rights" }
  if (name === "osascript" && args.some((word) => /with administrator privileges/i.test(word))) return { x: "admin_rights" }

  const x = ((): XTrigger | undefined => {
    if (found.viaXargs && (DeletionWords.deletes([spelled, ...args]) || name === "shred")) return "delete_compound"
    if (HOST.has(name) || name.startsWith("mkfs.")) return "irreversible"
    // History filtering tools run as their own program (1.1.1 F9, G2-2).
    if (name === "bfg" || name === "git-filter-repo") return "irreversible"
    if (SQL_TOOLS.has(name) && args.some((word) => SQL_WIPE.test(word))) return "irreversible"
    if (name === "redis-cli" && args.some((word) => /^flush(all|db)$/i.test(word))) return "irreversible"
    if (name === "diskutil" && DISK_WIPE.test(args.find((word) => !word.startsWith("-")) ?? "")) return "irreversible"
    if (name === "docker") {
      const text = args.filter((word) => !word.startsWith("-")).join(" ")
      if (/^(volume (rm|prune)|system prune)\b/.test(text)) return "irreversible"
      // `compose down -v` removes the named volumes with the containers (decision R2-D2, as `tool/risk.ts` labels it).
      if (/^compose\b.*\bdown\b/.test(text) && args.some((word) => word === "-v" || word === "--volumes")) return "irreversible"
    }
    if (MIGRATE_WIPE.test(args.join(" "))) return "irreversible"
    if (name === "find") {
      if (args.includes("-delete")) return "delete_compound"
      for (const [index, word] of args.entries()) {
        if (!FIND_EXEC.has(word)) continue
        const end = args.findIndex((next, at) => at > index && (next === ";" || next === "+"))
        const command = args.slice(index + 1, end < 0 ? undefined : end)
        if (DeletionWords.deletes(command) || base(command[0] ?? "") === "shred") return "delete_compound"
      }
    }
    if (name === "rsync" && args.some((word) => word.startsWith("--delete"))) {
      const target = args.filter((word) => !word.startsWith("-")).at(-1) ?? ""
      if (!/^[^/]*:/.test(target) && !target.includes("://")) return "delete_compound"
    }
    if (name === "git") return gitScreen(args).x
    return undefined
  })()
  if (x) return { x }

  // 1.1.1 F26 (P42): a send the consent lets out is no `outward` trigger; every other trigger still applies to it.
  const sends = stepSends(step, input)
  if (name === "git") {
    const git = gitScreen(args)
    if (git.d && !(sends && git.d === "outward")) return git
  }
  if (!sends && (OUTWARD.has(name) || outwardWord || outwardForm(name, args))) return { d: "outward" }
  if (outsideWrite(name, args, step, input.instance)) return { d: "outside_write_held" }
  if (SYSTEM_SERVICE.has(name)) return { d: "system_service" }
  if (name === "pkill" || name === "killall") return { d: "process_not_own" }
  if (name === "kill") {
    if (args.some(dynamic)) return { d: "unreadable_command" }
    const own = killIsOwn(args, input.ownProcesses)
    return own === false ? { d: "process_not_own" } : {}
  }
  // 1.1.3 (T9 G1): what a shell's `-c` text or an `eval` runs is unwrapped and judged for X, as a launcher's text is. It
  // stays D `unreadable_command` otherwise; the table's `consentRedirect` judges its deletions.
  const ran = runText(step.argv)
  if (ran !== undefined && (RUNS_TEXT.has(name) || SHELLS.has(name))) {
    const inner = depth > 4 ? undefined : (textX(ran, step, input, depth + 1) ?? textStepsX(ran, step, input, depth + 1))
    if (inner) return { x: inner }
  }
  if (RUNS_TEXT.has(name)) return { d: "unreadable_command" }
  if (SHELLS.has(name) && args.some((word) => word === "-c" || shortHas(word, "c"))) return { d: "unreadable_command" }
  // 1.1.3 (T3, matrix row 37): a SQL tool or diskutil whose arguments nobody can read may wipe; under consent it is answered
  // at once with the archive or snapshot way (X `irreversible`) instead of waiting.
  if ((SQL_TOOLS.has(name) || name === "diskutil") && args.some(dynamic)) return { x: "irreversible" }
  return {}
}

const lookup = <T>(record: Readonly<Record<string, T>>, name: string) => (Object.hasOwn(record, name) ? record[name] : undefined)

/** M1 (P11): a package publish, an image push, a hosted deploy, a release, a pull request or an upload. */
function outwardForm(name: string, args: readonly string[]) {
  if (lookup(BypassLists.OUTWARD_FORMS, name)?.(args)) return true
  return BypassLists.RISK_REMOTE.some(([tool, sub]) => tool === name && sub.test(args[0] ?? ""))
}

/** M3 (P10): a link, a global install, a global config or a system preference: a write outside the folder. */
function outsideWrite(name: string, args: readonly string[], step: Step, instance: AutonomyTable.Input["instance"]) {
  if (lookup(BypassLists.OUTSIDE_WRITE_FORMS, name)?.(args)) return true
  if (name !== "ln") return false
  // `ln` makes its last word; one that lands outside the folder (or in the home folder) writes there.
  const target = args.filter((word) => !word.startsWith("-")).at(-1)
  if (target === undefined) return false
  if (target.startsWith("~")) return true
  // 1.1.1 F22 (P37): and where it lands once each link before a `..` is followed (`Reach.physical`).
  return step.cwds.some(
    (cwd) => !containsPath(path.resolve(cwd, target), instance) || (Reach.upward(target) && !landsInside(target, cwd, instance)),
  )
}

/** 1.1.1 F22 (P37): `word`, taken from `cwd`, lands inside the project once links are followed; a loop does not. */
function landsInside(word: string, cwd: string, instance: AutonomyTable.Input["instance"]) {
  const landing = Reach.physical(word, cwd)
  return landing !== undefined && Reach.inside(landing, instance)
}

/** X triggers on a text a launcher would run, split as the table splits a text. */
function textX(text: string, step: Step, input: Pick<AutonomyTable.Input, "instance" | "ownProcesses">, depth: number) {
  for (const argv of commandWords(text)) {
    const found = stepScreen({ argv, cwds: step.cwds }, input, depth)
    if (found.x) return found.x
  }
  return undefined
}

/** 1.1.3 (T9 G1): X triggers on a text a shell runs, read as the shell reads it (`textSteps`). */
function textStepsX(text: string, step: Step, input: Pick<AutonomyTable.Input, "instance" | "ownProcesses">, depth: number) {
  for (const inner of textSteps(text, step.cwds).steps) {
    const found = stepScreen(inner, input, depth)
    if (found.x) return found.x
  }
  return undefined
}

/** 1.1.3 (T9 G1): the X trigger of one step, if any, as the consented screen reads it (`stepScreen`). */
export function stepX(step: Step, input: Pick<AutonomyTable.Input, "instance" | "ownProcesses">): XTrigger | undefined {
  return stepScreen(step, input).x
}

/**
 * 1.1.3 (T9 G1): the text a step hands to a shell to run: a shell's `-c` text, the words of an `eval`, or a launcher's
 * code (`watch`, `npx -c`). undefined: the step runs a program, a script file or stdin.
 */
export function runText(argv: readonly string[]): string | undefined {
  const found = unwrap(argv)
  if (found.kind === "code") return found.code
  if (found.kind !== "program") return undefined
  if (found.name === "eval") return found.args.join(" ")
  if (SHELLS.has(found.name)) return DeletionWords.shellText(found.name, found.args)
  return undefined
}

/** A word with one pair of outer quotes and nothing the shell expands inside them, as the shell passes it on. */
function unquoteWord(word: string) {
  if (/^'[^']*'$/.test(word)) return word.slice(1, -1)
  if (/^"[^"`$\\]*"$/.test(word)) return word.slice(1, -1)
  return word
}

/**
 * 1.1.3 (T9 G1): the steps of a text a shell runs, read as the shell's reader reads it (`ScriptReader`), else split as the
 * table splits a text with each word's outer quotes taken off. `readable: false` when the reader could not read it and a
 * word of the rough split holds an expansion, a quote or a substitution: what would run cannot be told word by word.
 */
export function textSteps(text: string, cwds: readonly string[]): { steps: Step[]; readable: boolean } {
  const cwd = cwds[0]
  const reading = cwd === undefined ? undefined : consentReading(ScriptReader.read(text, cwd))
  if (reading && reading.complete && reading.steps.length > 0)
    return { steps: reading.steps.map((step) => ({ argv: step.argv, cwds: step.cwds, code: step.code })), readable: true }
  const steps = commandWords(text).map((words) => ({ argv: words.map(unquoteWord), cwds }))
  const readable = steps.length > 0 && !steps.some((step) => step.argv.some((word) => /[$`'"\\]/.test(word)))
  return { steps, readable }
}

/** 1.1.3 (T9 G1, G2): one step a call runs, and where it comes from: the call itself, a shell text, or a project script. */
export type DeepStep = Step & { from: "call" | "text" | "script" }

/**
 * 1.1.3 (T9 G1, G2): every step a shell call runs, with its shell texts (`-c`, `eval`, a launcher's code) and the project
 * scripts it runs by name unwrapped, five levels deep and at most `MAX_SCRIPT_STEPS` steps. `unreadable` holds each text
 * that could not be read word by word, and the whole command when nothing of it can (`readSteps` undefined). A step
 * inside a script keeps `from: "script"` through any text it runs, so a script body is judged as a script.
 */
export function deepSteps(input: AutonomyTable.Input): { steps: DeepStep[]; unreadable: string[] } {
  const unreadable: string[] = []
  const top = readSteps(input)
  if (!top) {
    if (typeof input.metadata.command === "string") unreadable.push(input.metadata.command)
    return { steps: [], unreadable }
  }
  const steps: DeepStep[] = []
  const queue: { step: DeepStep; depth: number }[] = top.map((step) => ({ step: { ...step, from: "call" }, depth: 0 }))
  while (queue.length > 0 && steps.length < MAX_SCRIPT_STEPS) {
    const { step, depth } = queue.shift()!
    steps.push(step)
    if (depth > 4) continue
    const text = runText(step.argv) ?? (shellRunsCode(step) ? step.code : undefined)
    if (text !== undefined) {
      const inner = textSteps(text, step.cwds)
      if (!inner.readable) unreadable.push(text)
      const from = step.from === "script" ? "script" : "text"
      queue.push(...inner.steps.map((each) => ({ step: { ...each, from } as DeepStep, depth: depth + 1 })))
    }
    // `scriptSteps` already follows the scripts a script runs by name, so a script's own steps are not expanded again.
    if (step.from !== "script" && step.code === undefined)
      for (const cwd of step.cwds)
        queue.push(
          ...scriptSteps(step.argv, cwd, input.instance).map((each) => ({ step: { ...each, from: "script" } as DeepStep, depth: depth + 1 })),
        )
  }
  return { steps, unreadable }
}

/** A shell fed its text on stdin (a heredoc the reader kept as `code`). */
function shellRunsCode(step: Step) {
  if (step.code === undefined) return false
  const found = unwrap(step.argv)
  return found.kind === "program" && SHELLS.has(found.name)
}

/**
 * 1.1.3 (T9 G3): the cloud and remote command lines that delete what they manage, by tool. Read on the words that are not
 * options (`positional`), roughly: it only ever answers with the archive or snapshot way instead of running. A network
 * call of the same tool that deletes nothing keeps running.
 */
const CLOUD_DELETES: Readonly<Record<string, (words: readonly string[], args: readonly string[]) => boolean>> = {
  // aws s3 rm / rb, aws s3 sync --delete, any `delete-*`, `remove-*`, `terminate-*`, `deregister-*` operation.
  aws: (words, args) =>
    words.some((word) => /^(delete|remove|terminate|deregister|purge)(-|$)/.test(word)) ||
    (words[0] === "s3" && ["rm", "rb"].includes(words[1] ?? "")) ||
    (words[0] === "s3" && words[1] === "sync" && args.some((word) => word.startsWith("--delete"))),
  gcloud: (words) => words.some((word) => word === "delete" || word === "rm" || word === "purge"),
  gsutil: (words, args) => ["rm", "rb"].includes(words[0] ?? "") || (words[0] === "rsync" && args.includes("-d")),
  az: (words) => words.some((word) => /^(delete|purge|delete-batch|remove)$/.test(word)),
  kubectl: (words) => words[0] === "delete",
  oc: (words) => words[0] === "delete",
  helm: (words) => ["uninstall", "delete", "del", "un"].includes(words[0] ?? ""),
  eksctl: (words) => words[0] === "delete",
  terraform: (words, args) =>
    words[0] === "destroy" ||
    (words[0] === "apply" && args.includes("-destroy")) ||
    (words[0] === "state" && words[1] === "rm") ||
    (words[0] === "workspace" && words[1] === "delete"),
  tofu: (words, args) => CLOUD_DELETES.terraform!(words, args),
  terragrunt: (words, args) => CLOUD_DELETES.terraform!(words, args) || words.some((word) => word === "destroy"),
  pulumi: (words) => words[0] === "destroy" || (words[0] === "stack" && words[1] === "rm"),
  cdk: (words) => words[0] === "destroy",
  serverless: (words) => words[0] === "remove",
  sls: (words) => words[0] === "remove",
  doctl: (words) => words.some((word) => word === "delete" || word === "rm"),
  fly: (words) => words.some((word) => ["destroy", "delete", "rm", "remove"].includes(word)),
  flyctl: (words) => words.some((word) => ["destroy", "delete", "rm", "remove"].includes(word)),
  vercel: (words) => ["remove", "rm"].includes(words[0] ?? "") || words.slice(1).some((word) => word === "rm" || word === "remove"),
  heroku: (words) => words.some((word) => /(^|:)(destroy|delete|remove|reset)$/.test(word)),
  netlify: (words) => words.some((word) => /(^|:)delete$/.test(word)),
  firebase: (words) => words.some((word) => /:(delete|remove)$/.test(word)),
  wrangler: (words) => words.some((word) => word === "delete"),
  supabase: (words) => words.some((word) => word === "delete"),
  railway: (words) => words[0] === "delete" || words[0] === "down",
  gh: (words) => words[1] === "delete",
  glab: (words) => words[1] === "delete",
  npm: (words) => words[0] === "unpublish",
  rclone: (words) => ["delete", "deletefile", "purge", "rmdir", "rmdirs"].includes(words[0] ?? ""),
  s3cmd: (words) => ["del", "rm", "rb"].includes(words[0] ?? ""),
  mc: (words) => ["rm", "rb"].includes(words[0] ?? ""),
  // A container removed by force (its writable layer is gone), as row 11 (S3) lists it.
  docker: (words, args) =>
    (words[0] === "rm" || (words[0] === "container" && words[1] === "rm")) &&
    args.some((word) => word === "--force" || /^-[A-Za-z]*f[A-Za-z]*$/.test(word)),
}

/** 1.1.3 (T9 G3): the tools `CLOUD_DELETES` reads; the report and the spec name them. */
export const CLOUD_DELETE_TOOLS: readonly string[] = Object.keys(CLOUD_DELETES)

/** 1.1.3 (T9 G3): `name args` deletes a cloud or remote resource (`CLOUD_DELETES`). */
export function cloudDeletes(name: string, args: readonly string[]): boolean {
  const rule = lookup(CLOUD_DELETES, name)
  return rule !== undefined && rule(args.filter((word) => !word.startsWith("-")), args)
}

/**
 * 1.1.3 (T9 G5): a step that deletes the person's own configuration outside the project, which nothing archives: the whole
 * crontab (`crontab -r`), a keychain or an item of one (`security delete-*`), an app's settings (`defaults delete`,
 * `PlistBuddy -c Delete`, `plutil -remove`), a directory record (`dscl . -delete`), a privacy grant (`tccutil reset`), or
 * the Trash emptied through `osascript`.
 */
export function deletesUserConfig(argv: readonly string[]): boolean {
  const found = unwrap(argv)
  if (found.kind !== "program") return false
  const { name, args } = found
  const words = args.filter((word) => !word.startsWith("-"))
  if (name === "crontab") return args.some((word) => /^-[A-Za-z]*r[A-Za-z]*$/.test(word))
  if (name === "security") return /^delete-/.test(words[0] ?? "")
  if (name === "defaults") return words.find((word) => word !== "-currentHost") === "delete"
  if (name === "PlistBuddy") return args.some((word) => /^\s*delete\b/i.test(word))
  if (name === "plutil") return args.includes("-remove")
  if (name === "dscl") return args.includes("-delete")
  if (name === "tccutil") return words[0] === "reset"
  // Emptying the Trash removes for good what the person (or Swarm's archive way) put there.
  if (name === "osascript") return args.some((word) => /\bempty\s+(the\s+)?trash\b/i.test(word))
  return false
}

/**
 * S1.20: the triggers of a call. Only `bash` and `external_directory` with a command are screened; any other permission
 * has none. An X trigger in any step outranks every D trigger; the first of each kind in step order is the one named.
 */
export function screen(input: AutonomyTable.Input): Screen {
  if (input.permission !== "bash" && input.permission !== "external_directory") return {}
  if (typeof input.metadata.command !== "string") return {}
  const steps = readSteps(input)
  const result: Screen = input.metadata.risk === "remote" && !remoteSent(input, steps) ? { d: "outward" } : {}
  if (!steps) {
    // Nothing to read word by word: held. The X triggers are still looked for on a rough split of the text, so an
    // irreversible command inside text nobody can read is refused rather than left for a person to allow.
    const x = roughX(input.metadata.command, input)
    return x ? { x } : { d: result.d ?? "unreadable_command" }
  }
  for (const step of steps) {
    const found = stepScreen(step, input)
    if (found.x) return { x: found.x }
    // 1.1.1 F29 (P44): under consent a step that runs a project script by name runs what the script says, so the
    // irreversible list and admin rights inside it are refused as they are on the call itself (P8 allows exactly these).
    if (input.bypass && step.code === undefined) {
      const inner = step.cwds.flatMap((cwd) => scriptSteps(step.argv, cwd, input.instance))
      for (const item of inner) {
        const x = stepScreen(item, { instance: input.instance, ownProcesses: input.ownProcesses }).x
        if (x === "irreversible" || x === "admin_rights") return { x }
      }
    }
    if (found.d && !result.d) result.d = found.d
  }
  return result
}

/** npm-family commands of their own, which a bare name never runs as a script. */
const MANAGER_COMMANDS = new Set([
  "install", "i", "ci", "add", "a", "remove", "rm", "uninstall", "un", "update", "up", "upgrade", "publish", "pack", "link",
  "ln", "unlink", "dlx", "exec", "x", "create", "c", "init", "why", "info", "list", "ls", "outdated", "audit", "config",
  "import", "store", "run", "run-script", "set", "version", "workspace", "workspaces", "npm", "dedupe", "patch", "rebuild",
  "prune", "fetch", "pm", "repl", "test", "t", "build", "help", "bin", "cache", "global", "node", "env", "plugin",
])

/**
 * 1.1.1 F29 (P44): the project script a step of the npm family runs by name, with the words the manager appends: `run`
 * or `run-script <name>`, `test`/`t` (not bun's own runner), `start`, `stop`, `restart`, and for yarn, pnpm and bun a
 * bare name that is none of their own commands. Read roughly: it only widens what is looked at for a refusal or a recheck.
 */
function scriptNamed(argv: readonly string[]): { manager: string; name: string; extra: readonly string[] } | undefined {
  const at = argv.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
  if (at < 0) return undefined
  const manager = argv[at]!
  if (!OutwardConsent.NODE_PUBLISHERS.has(manager)) return undefined
  const args = argv.slice(at + 1)
  const first = args.findIndex((word) => !word.startsWith("-"))
  if (first < 0) return undefined
  const sub = args[first]!
  const after = (index: number) => {
    const rest = args.slice(index + 1)
    return rest[0] === "--" ? rest.slice(1) : rest
  }
  if (sub === "run" || sub === "run-script") {
    const at = args.findIndex((word, index) => index > first && !word.startsWith("-"))
    return at < 0 ? undefined : { manager, name: args[at]!, extra: after(at) }
  }
  if ((sub === "test" || sub === "t") && manager !== "bun") return { manager, name: "test", extra: after(first) }
  if (["start", "stop", "restart"].includes(sub) && manager !== "bun") return { manager, name: sub, extra: after(first) }
  if (manager !== "npm" && !MANAGER_COMMANDS.has(sub)) return { manager, name: sub, extra: after(first) }
  return undefined
}

/**
 * 1.1.1 F29 (P44): every step of the project scripts `argv` runs by name in `cwd` (its `pre` and `post` hooks, and the
 * scripts those run by name, three deep), each with the folders it runs in. Read as the allowlist reads a script, or
 * roughly as `commandWords` splits it when the reader does not understand it in full. Each script is expanded once, at
 * most `MAX_SCRIPT_STEPS` steps are gathered, and the answer is kept for the classify. None: no such script.
 */
export function scriptSteps(argv: readonly string[], cwd: string, instance: AutonomyTable.Input["instance"]): Step[] {
  if (scriptNamed(argv) === undefined) return []
  return Reach.classifyMemo(["scriptSteps", instance.directory, instance.worktree, cwd, ...argv].join("\0"), () => {
    const walk = { env: newEnv({ instance, canUndo: false, ownProcesses: undefined }, true), seen: new Set<string>(), found: [] as Step[] }
    expandScripts(argv, cwd, walk, 0)
    return walk.found
  })
}

/**
 * 1.1.1 F30 (G12-P3): whether a project script `argv` runs by name in `cwd` may push: the manifest that names it says
 * `push` somewhere. A manifest that cannot be read may. Only narrows which scripts the gate expands to find a push to
 * recheck; a push it does not find is not rechecked, and an unrechecked push stays held.
 */
export function scriptMayPush(argv: readonly string[], cwd: string, instance: AutonomyTable.Input["instance"]): boolean {
  if (scriptNamed(argv) === undefined) return false
  const here = Reach.real(cwd)
  if (here === undefined) return true
  const env = newEnv({ instance, canUndo: false, ownProcesses: undefined }, true)
  const manifest = nearestManifest(here, env)
  if (manifest === undefined) return false
  try {
    return /push/.test(fs.readFileSync(manifest, "utf8"))
  } catch {
    return true
  }
}

function expandScripts(argv: readonly string[], cwd: string, walk: { env: Env; seen: Set<string>; found: Step[] }, depth: number) {
  const named = depth > 3 ? undefined : scriptNamed(argv)
  if (!named) return
  const env = walk.env
  const here = Reach.real(cwd)
  const manifest = here === undefined ? undefined : nearestManifest(here, env)
  if (!manifest || !Reach.inside(manifest, env.instance)) return
  const appended = named.extra.map((word) => (/^[\w./@%+:,=-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`))
  const key = [manifest, named.name, ...appended].join("\0")
  const scripts = manifestScripts(manifest, env)
  if (!scripts || walk.seen.has(key)) return
  walk.seen.add(key)
  const main = lookup(scripts, named.name)
  const texts = [
    lookup(scripts, `pre${named.name}`),
    typeof main === "string" ? [main, ...appended].join(" ") : undefined,
    lookup(scripts, `post${named.name}`),
  ]
  const folder = path.dirname(manifest)
  for (const text of texts) {
    if (typeof text !== "string" || text.length > MAX_SCRIPT) continue
    const reading = consentReading(ScriptReader.read(text, folder), env.lexical)
    const steps: Step[] =
      reading && reading.complete
        ? reading.steps.map((step) => ({ argv: step.argv, cwds: step.cwds, code: step.code }))
        : commandWords(text).map((words) => ({ argv: words, cwds: [folder] }))
    for (const step of steps) {
      if (walk.found.length >= MAX_SCRIPT_STEPS) return
      walk.found.push(step)
      for (const at of step.cwds) expandScripts(step.argv, at, walk, depth + 1)
    }
  }
}

/** X triggers only, on the commands of a text as the table's `commandWords` splits it (roughly, as a shell would). */
function roughX(command: string, input: Pick<AutonomyTable.Input, "instance" | "ownProcesses" | "cwd">): XTrigger | undefined {
  for (const argv of commandWords(command)) {
    const found = stepScreen({ argv, cwds: [input.cwd] }, input)
    if (found.x === "irreversible" || found.x === "admin_rights") return found.x
    // `commandWords` leaves a quoted statement as several words, so the SQL wipe is also read on the words joined.
    const program = unwrap(argv)
    if (program.kind === "program" && SQL_TOOLS.has(program.name) && SQL_WIPE.test(program.args.join(" "))) return "irreversible"
  }
  return undefined
}

/**
 * 1.1.1 F7 (decision P15): the overlay opens a held shell call only when this says yes. Every step is a recognised
 * development command in a recognised form (`BypassLists.ALLOWLIST`), and the shell's own reading of the call carries no
 * label: no `risk` (irreversible, or remote), no folder outside (an `external_directory` prompt), no plain deletion it
 * offered to archive (that one is A `archived` in 1.1.0 already and never reaches here), no redirect writing outside the
 * folder, no step running in or naming a place outside it, and no program the shell would find inside the project.
 * 1.1.1 F10a: every file a redirect or a tool's own output option writes is one the consent may leave to the agent
 * (`writeOpens`). Anything else keeps its 1.1.0 verdict.
 */
export function allowlisted(input: AutonomyTable.Input, verdict: AutonomyTable.Verdict): boolean {
  if (input.permission !== "bash") return false
  const metadata = input.metadata
  if (typeof metadata.command !== "string" || metadata.archive !== undefined) return false
  // 1.1.1 F26 (P42): a `remote` label only when every step it comes from is a send the consent lets out.
  if (metadata.risk !== undefined && !remoteSent(input, readSteps(input))) return false
  if (verdict.category === "program_not_trusted") return false
  // 1.1.1 F12a (P1, m28): one `Env` per classify, so its memory of manifests and scripts lives exactly one call.
  const env = newEnv(input)
  const reading = consentReading(metadata.steps, input.instance)
  // 1.1.1 F10a (B3, M4.2): a redirect into the repository's own storage, a secret, a file that changes later runs or what
  // is allowed, or one nothing can bring back keeps its 1.1.0 verdict, for the root and a subagent alike. 1.1.1 F20 (P34,
  // S9-1): the reading's writes include where a redirect with a `..` really lands.
  // 1.1.1 F22 (CR10-1): a reading with more distinct places than are judged keeps 1.1.0.
  if (reading && !reading.complete) return false
  if (reading && !reading.writes.every((file) => writeOpens(file, env))) return false
  if (reading && !reading.chdirs.every((place) => logicalCd(place, cdRoots(env), reading.steps))) return false
  const steps = readSteps(input)
  // 1.1.1 F30 (G12-P2): under consent the walk also gathers where the sends it opened go, step by step, keeping what
  // `outwardOpened` counts (a send of the step itself, and the sends inside a project script it runs by name). The answer
  // is kept for the classify, so rule 10 does not walk the scripts again.
  const collect: string[] | undefined = input.bypass ? [] : undefined
  const counts = (step: Step, cwd: string) => scriptNamed(step.argv) !== undefined || sendStep(step.argv, cwd, input) !== undefined
  const ok =
    steps !== undefined &&
    steps.length > 0 &&
    sequenceOpens(
      steps,
      env,
      (step) =>
        step.code === undefined &&
        step.cwds.every((cwd) => {
          const mark = collect?.length ?? 0
          env.collect = collect
          const passed = allowedStep(step.argv, cwd, env, 0)
          if (collect && passed && !counts(step, cwd)) collect.length = mark
          return passed
        }),
      redirectPart(steps.length, reading?.writes.length ?? 0),
    )
  env.collect = undefined
  if (ok && collect) Reach.classifyMemo(outwardKey(input), () => (collect.length > 0 ? [...new Set(collect)] : undefined))
  return ok
}

/** 1.1.1 F30 (G12-P2): the key of a call's destinations in the classify's memo. */
const outwardKey = (input: AutonomyTable.Input) =>
  ["outwardOpened", input.cwd, String(input.metadata.command), input.bypass?.caller ?? ""].join("\0")

/**
 * 1.1.1 F20 (P34, S9-2): a `cd` the shell takes as the reading does, logically. Its folder exists as written (bash falls back
 * to the physical path when the logical one fails), and no name the `cd` passes is a link (a shell set to resolve links,
 * by an option or a profile, would land somewhere else). The project's folders, and the folders above them, are how the
 * project was opened, not part of the `cd`. 1.1.1 F22 (CR10-2): `roots` are those folders as given and by their real
 * paths (`cdRoots`), since a script's `cd` is taken from the real folder of its manifest and a call's from the folder as
 * given.
 */
function logicalCd(place: ShellPlace, roots: readonly string[], steps: readonly Step[]) {
  if (fs.statSync(path.resolve(place.from, place.to), { throwIfNoEntry: false })?.isDirectory() !== true)
    return madeBefore(place, roots, steps) && passesNoLink(place, roots)
  return passesNoLink(place, roots)
}

/** 1.1.1 F22 (CR10-2, G10-P2): the project's folders as given and by their real paths, each once; `/` is none. */
function cdRoots(env: Env) {
  return [...new Set([env.lexical.directory, env.lexical.worktree, env.instance.directory, env.instance.worktree])].filter(
    (root) => root !== "/",
  )
}

/**
 * 1.1.1 F21: a folder that does not exist yet is still taken logically when an earlier step of the same call makes exactly
 * it: `mkdir [-p] <dir>` run only in the `cd`'s own folder, the folder inside the project, neither written path with a
 * `..` (so the logical and the physical path are one), and between that step and the first step that runs in the folder
 * only programs that read or print (nothing that changes the tree or makes a link). The reading does not place a `cd`
 * among the steps; every step after it can run in its folder, so the first step that can is where the `cd` has happened
 * by. A `cd` before the `mkdir` that no step runs after fails and leaves the folder as it was, which changes nothing.
 * The link check on the names the `cd` passes (`passesNoLink`) still applies.
 *
 * 1.1.1 F22 (n56): the invariant this rests on and does not check itself. `mkdir -p` succeeds over a link that already
 * has the folder's name, and the `cd` then follows it, so a link made BEFORE the `mkdir` would carry the `cd` out. That
 * cannot open today only because no step the overlay opens makes a link, except an install or a tree change, and those
 * meet `interferes` beside the `mkdir`'s own write wherever they sit: `ln`, `cp`, `rsync`, `tar` and the managers' `link`
 * forms are not allowlisted (`OUTSIDE_WRITE_FORMS` holds every `link` form; the wide deletion reader holds every `cp`).
 * Allowlisting any program that can make a link needs this rule widened to every step before the `mkdir` as well. The
 * F22 tests pin it: with `ln` allowlisted they fail. (Widening it now would hold `mkdir -p a && … && mkdir -p b && cd b`,
 * which P35 opens.)
 * (n53) Only the exact `mkdir <dir>` and `mkdir -p <dir>` forms are read, so the folder named is never in doubt.
 */
function madeBefore(place: ShellPlace, roots: readonly string[], steps: readonly Step[]) {
  const target = path.resolve(place.from, place.to)
  if (Reach.upward(place.to) || !roots.some((root) => target !== root && Reach.within(target, root))) return false
  const made = steps.findIndex((step) => {
    if (step.code !== undefined || step.argv[0] !== "mkdir" || step.cwds.length !== 1 || step.cwds[0] !== place.from) return false
    const words = step.argv.slice(1)
    const dir = words.length === 2 && words[0] === "-p" ? words[1]! : words.length === 1 ? words[0]! : undefined
    return dir !== undefined && !dir.startsWith("-") && !Reach.upward(dir) && path.resolve(place.from, dir) === target
  })
  if (made < 0 || steps.slice(0, made).some((step) => step.cwds.includes(target))) return false
  const arrives = steps.findIndex((step, index) => index > made && step.cwds.includes(target))
  // n53: `READS_ONLY` holds no `git`, so `changesTree` adds nothing today; it stays so that a reader added to that list
  // later cannot let a tree change through here.
  return steps
    .slice(made + 1, arrives < 0 ? undefined : arrives)
    .every((step) => readsOnly(step) && !changesTree(step.argv))
}

/**
 * 1.1.1 F20 (S9-2): no name the `cd` passes is a link, the project's folders (`roots`) and those above them aside. 1.1.1
 * F22 (G10-P3): whether a name is a link is asked through `Reach.isLink`, once per path per classify.
 */
function passesNoLink(place: ShellPlace, roots: readonly string[]) {
  const passed = place.to
    .split("/")
    .filter((name) => name !== "" && name !== ".")
    .reduce<string[]>((found, name) => {
      const at = found.at(-1) ?? (place.to.startsWith("/") ? "/" : place.from)
      found.push(name === ".." ? path.dirname(at) : path.join(at, name))
      return found
    }, [])
  return passed.every((at) => roots.some((root) => Reach.within(root, at)) || !Reach.isLink(at))
}

/**
 * What one step did, as far as the order of steps matters (1.1.1 F12a, S4-1): it runs a project script, it can change the
 * tree or HEAD, and (1.1.1 F19, P32 principle 2) it writes a file or names an output or config file of its own.
 */
// 1.1.1 F20 (P34): `installs`, it fills a dependency folder, which can make links; `configures`, it names a config file of
// its own (D-F19-4), which a tree change can swap but an install does not touch.
// 1.1.1 F39 (G15-1, P54): `publishes` marks a package publish or hosted deploy the consent opened (`PUBLISH_PROGRAMS`).
type Trace = { runs: boolean; changes: boolean; writes: boolean; configures: boolean; installs: boolean; publishes: boolean }
const blank = (changes = false): Trace => ({ runs: false, changes, writes: false, configures: false, installs: false, publishes: false })
type Env = {
  // 1.1.1 F19 (P32 principle 1): the project's folders by their real paths, so every walk and containment check of the
  // consented screen is made on the folders the managers and tools themselves see. `lexical` is the instance as given.
  instance: AutonomyTable.Input["instance"]
  lexical: AutonomyTable.Input["instance"]
  canUndo: boolean
  own: ReadonlySet<number> | undefined
  // 1.1.1 F12a (P1, m28): what this classify already read: the nearest manifest of a folder, a manifest's scripts, and
  // each script's answer (keyed with the chain that reached it, so a cycle is still a cycle).
  nearest: Map<string, string | undefined>
  manifests: Map<string, Manifest | undefined>
  scripts: Map<string, Trace & { ok: boolean }>
  // Script steps this classify may still examine; at 0 every further one answers false, which keeps 1.1.0.
  budget: { left: number }
  // The step being judged: whether it runs project scripts (a script by name, an install's lifecycle scripts) and
  // whether it, or what it runs, can change the working tree or HEAD.
  trace: Trace | undefined
  // 1.1.1 F14 (G5-P1): only the marks are wanted (`sequenceKeeps`), never an answer that opens: no write is asked about.
  traceOnly: boolean
  // 1.1.1 F15, F17 (P30): from a folder above the repository's top, whether some folder up to `/` holds a manifest or a
  // pnpm workspace file.
  above: Map<string, boolean>
  // 1.1.1 F17 (P30): a folder's install root as npm finds it (`installRoot`), and whether a manifest marks it (n38).
  roots: Map<string, InstallRoot | undefined>
  // 1.1.1 F19 (G8-P1): whether a folder is a workspace marker (`inWorkspace`), asked once per folder per classify.
  workspace: Map<string, boolean>
  // 1.1.1 F26 (P42): what a step that sends is read with; absent without consent, so no send is accepted.
  send: SendContext | undefined
  // 1.1.1 F29 (P44): where the sends the walk opened go, when the caller asks (`outwardOpened`).
  collect?: string[]
}
type InstallRoot = { dir: string; manifest: boolean }
/** What a manifest says that the screen reads: its scripts, and whether it declares workspaces (1.1.1 F14, G5-2). */
type Manifest = { scripts: Record<string, unknown> | undefined; workspaces: boolean }
/** 1.1.1 F12a (P1, m28): at most this many script steps are examined in one classify. */
export const MAX_SCRIPT_STEPS = 200
/** Test seam (1.1.1 F12a, m33): how many manifests were read and parsed since the counter was last set to 0. */
export const counters = { manifestReads: 0, workspaceAsks: 0, workspaceFolders: 0, outwardWalks: 0 }

function newEnv(
  input: Pick<AutonomyTable.Input, "instance" | "canUndo" | "ownProcesses"> & Partial<SendContext>,
  traceOnly = false,
): Env {
  const lexical = input.instance
  return {
    send: input.bypass
      ? {
          bypass: input.bypass,
          outward: input.outward,
          whole: input.whole ?? (typeof input.metadata?.command === "string" ? input.metadata.command : ""),
          metadata: input.metadata,
          instance: lexical,
        }
      : undefined,
    traceOnly,
    lexical,
    instance: Reach.realRoots(lexical),
    canUndo: input.canUndo === true,
    own: input.ownProcesses,
    nearest: new Map(),
    manifests: new Map(),
    scripts: new Map(),
    budget: { left: MAX_SCRIPT_STEPS },
    trace: undefined,
    above: new Map(),
    roots: new Map(),
    workspace: new Map(),
  }
}

/**
 * 1.1.1 F19 (P32 principle 1): a path as the screen judges it. Under one of the project's folders as given, it is spelled
 * under that folder's real path (the names below it are kept, so a link inside the project is still judged by both of its
 * names); anything else as it is.
 */
function reroot(file: string, env: Env) {
  // 1.1.1 F22 (n51): the one mapper between the two spellings of the project's folders (`Reach.respell`).
  return Reach.respell(file, [
    [env.lexical.directory, env.instance.directory],
    [env.lexical.worktree, env.instance.worktree],
  ])
}

/**
 * 1.1.1 F12a (S4-1): every item passes `check`, judged in order, and no two parts interfere (`interferes`, the one rule;
 * `parts` are parts of the text that are no item: its redirects, or the install whose hooks the items are). The order of
 * a pipeline or a background step is not known from the reading, so a part counts before or after another alike. What
 * the items did is passed up to the step that holds them.
 */
function sequenceOpens<T extends { argv?: readonly string[]; text?: unknown }>(
  items: readonly T[],
  env: Env,
  check: (item: T) => boolean,
  parts: readonly Trace[] = [],
) {
  const outer = env.trace
  const marks: Trace[] = [...parts]
  for (const item of items) {
    const mark = blank(item.argv !== undefined && changesTree(item.argv))
    env.trace = mark
    const ok = (() => {
      try {
        return check(item)
      } finally {
        env.trace = outer
      }
    })()
    if (!ok) return false
    marks.push(mark)
  }
  if (interferes(marks)) return false
  if (outer) merge(outer, marks)
  return true
}

const merge = (into: Trace, marks: readonly Trace[]) => {
  into.runs ||= marks.some((mark) => mark.runs)
  into.changes ||= marks.some((mark) => mark.changes)
  into.writes ||= marks.some((mark) => mark.writes)
  into.configures ||= marks.some((mark) => mark.configures)
  into.installs ||= marks.some((mark) => mark.installs)
  into.publishes ||= marks.some((mark) => mark.publishes)
}

/**
 * 1.1.1 F20 (P34, CR9-2, S9-3, S9-4): the one interference rule, over the marks of the parts of one text (the steps of a
 * call, the texts of a script and its hooks, the steps of one script text, an install's hooks), each mark holding what its
 * own scripts and hooks did. A part that changes the tree or installs (an install makes links: a dependency on a folder
 * becomes one) beside another part that writes: what the first brought in can carry the write elsewhere. A tree change
 * beside a part that runs a project script (an install included) or names a config file: the script or config is read
 * here as it is now and used as the change leaves it (S4-1, D-F19-4). P24: an install beside tests, builds, scripts or
 * another install that write nothing still opens. Two parts that only change the tree, or only read, do not interfere.
 * 1.1.1 F39 (G15-1, P54): a publish or deploy beside a part that writes: the tool reads its configuration, its manifest
 * and what it uploads when it runs, so a file written in the same call is read as it is then, not as it was judged. A
 * publish's own hooks and output options are its own part; an edit in an earlier call is judged as that call.
 * 1.1.1 F40 (G16-1, P56): a publish or deploy beside a part that changes the tree (a merge, a switch, a branch checkout,
 * a stash pop): what the change brings in (a tool's config, a manifest) is what the tool reads. Also one part that both
 * changes the tree and publishes (a publish whose own hook switches branches). An install stays exempt (P24): it fills
 * the dependency folder, not the files a publish reads.
 */
const interferes = (marks: readonly Trace[]) =>
  marks.some((mark) => mark.changes && mark.publishes) ||
  marks.some(
    (mark, at) =>
      (mark.changes || mark.installs || mark.publishes) &&
      marks.some(
        (other, index) =>
          index !== at &&
          (other.writes || (mark.changes && (other.runs || other.configures || other.publishes))),
      ),
  )

/**
 * 1.1.1 F20 (CR9-2): the reading does not say which part of a text a redirect belongs to, so beside two or more parts the
 * text's redirects are one more part, one that writes.
 */
const redirectPart = (parts: number, writes: number): Trace[] => (parts > 1 && writes > 0 ? [{ ...blank(), writes: true }] : [])

/**
 * 1.1.1 F12a (S4-1): the table overlays each step of a compound call on its own (`classifySteps`), so no single step
 * sees the others. This answers for the whole call, by the one rule (`interferes`) over the steps' marks and the call's
 * redirects: when two parts interfere, the call keeps its 1.1.0 verdict. 1.1.1 F19 (P32 principle 2, G8-3): a step the
 * allowlist does not accept is A in 1.1.0 here (or the call would not have been opened); unless its program only reads
 * or prints, it counts as one that writes (a copy, a `tee`, a `sed -i`, code read from a heredoc).
 */
export function sequenceKeeps(input: AutonomyTable.Input): boolean {
  if (input.permission !== "bash") return false
  const reading = consentReading(input.metadata.steps, input.instance)
  if (!reading) return false
  // 1.1.1 F22 (CR10-1): a reading with more distinct places than are judged keeps 1.1.0.
  if (!reading.complete) return true
  // 1.1.1 F25 (n58): no `cd` to check and a single step: nothing can interfere, so no `Env` is built.
  if (reading.chdirs.length === 0 && reading.steps.length < 2) return false
  // 1.1.1 F14 (G5-P1): the walk is only for its marks, so no write target is asked about (no git, no snapshot). This can
  // only keep a call, never open one, so answering every write "fine" here cannot loosen a verdict.
  const env = newEnv(input, true)
  // 1.1.1 F20 (S9-2): a step the table opened on its own still runs in the folder a `cd` before it reached.
  if (!reading.chdirs.every((place) => logicalCd(place, cdRoots(env), reading.steps))) return true
  if (reading.steps.length < 2) return false
  const marks = reading.steps.map((step) => {
    const mark = blank(changesTree(step.argv))
    env.trace = mark
    try {
      const accepted =
        step.code === undefined && step.cwds.map((cwd) => allowedStep(step.argv, cwd, env, 0)).every((ok) => ok)
      if (!accepted && !readsOnly(step)) mark.writes = true
    } finally {
      env.trace = undefined
    }
    return mark
  })
  return interferes([...marks, ...redirectPart(marks.length, reading.writes.length)])
}

/**
 * 1.1.1 F19 (P32 principle 2): programs that only read files or print text in the forms that reach this check, which are
 * the forms 1.1.0 already lets through as A (n44: `tree -o`, `file -C` and `date -s` write, and 1.1.0 holds them).
 */
const READS_ONLY = new Set([
  "echo", "printf", "pwd", "true", "false", "date", "which", "stat", "file", "tree", "basename", "dirname", "ls", "cat", "head",
  "tail", "wc", "grep", "jq",
])
function readsOnly(step: Step) {
  if (step.code !== undefined) return false
  const program = unwrap(step.argv)
  return program.kind === "program" && !program.viaXargs && READS_ONLY.has(program.name)
}

const TREE_GIT = new Set(["checkout", "switch", "merge", "pull", "reset", "rebase", "apply", "am", "restore", "cherry-pick", "revert", "stash", "worktree", "read-tree", "checkout-index", "bisect"])
/**
 * 1.1.1 F12a (S4-1): a step that can change tracked files, the working tree or HEAD before a later step reads them: a
 * branch switch, a stash (other than listing or showing one), a merge, a checkout, a pull, a reset, a rebase, applying
 * patches.
 */
export function changesTree(argv: readonly string[]): boolean {
  // 1.1.1 F20 (G9-P2): a step's argv is the same list in every pass of one classify (the overlay's and the call-level
  // check's), so its answer is worked out once.
  const known = treeMemo.get(argv)
  if (known !== undefined) return known
  const found = treeChange(argv)
  treeMemo.set(argv, found)
  return found
}
const treeMemo = new WeakMap<readonly string[], boolean>()

function treeChange(argv: readonly string[]): boolean {
  const program = unwrap(argv)
  if (program.kind !== "program") return false
  const { name, args } = program
  if (name === "git") {
    const [sub, ...rest] = Risk.gitCommand([...args])
    if (sub === undefined || !TREE_GIT.has(sub)) return false
    if (sub === "stash") return !["list", "show"].includes(rest.find((word) => !word.startsWith("-")) ?? "push")
    // 1.1.1 F14 (V5-3): a new branch made at HEAD (no start point, no path) changes no file.
    if ((sub === "checkout" || sub === "switch") && createsAtHead(sub, rest)) return false
    return true
  }
  // An install fills the dependency folder, not the manifest's scripts, so it is no tree change (1.1.1 P24): the packages'
  // own code is the residual the consent text names. 1.1.1 F20: it is marked as an install (`Trace.installs`) instead.
  return false
}

/** `checkout -b <name>` or `switch -c <name>` (quiet or not), and nothing else: the branch starts at HEAD. */
function createsAtHead(sub: "checkout" | "switch", rest: readonly string[]) {
  const words = rest.filter((word) => word !== "-q" && word !== "--quiet")
  const flags = sub === "checkout" ? ["-b"] : ["-c", "--create"]
  return words.length === 2 && flags.includes(words[0]!) && /^[A-Za-z0-9][\w./-]*$/.test(words[1]!) && !words[1]!.includes("..")
}

/**
 * 1.1.1 F10a (B3, M4.2, G3-3, G3-4): a file a step writes that the consent may leave to the agent. It lands inside the
 * project once links are followed; it is no secret, nothing the read tool would hide (the repository's own storage
 * included), and nothing `Reach.consentSensitive` names (a hook, a manifest, a config, a tool's config). With Undo it is one the step's snapshot
 * covers; without Undo it must be an ordinary file, as an edit nothing can undo must be.
 */
function writeOpens(given: string, env: Env) {
  // 1.1.1 F19 (P32 principle 2): the step being judged writes.
  if (env.trace) env.trace.writes = true
  if (env.traceOnly) return true
  const instance = env.instance
  // 1.1.1 F19 (P32 principle 1): judged under the project's real folders.
  const file = reroot(given, env)
  // Without Git the worktree is `/`, and every name would be judged from the top of the disk.
  const base = instance.worktree === "/" ? { ...instance, worktree: instance.directory } : instance
  if (!containsPath(file, instance) || !Reach.inside(file, instance)) return false
  // 1.1.1 F12a (with F12b, S4-2): a tool's or compiler's config counts as sensitive here too, with or without Undo.
  if (Reach.secret(file) || !Reach.readable(file) || Reach.consentSensitive(file, base)) return false
  if (!env.canUndo) return Reach.ordinaryFile(file, base)
  return !Reach.outsideSnapshotSync(instance.worktree, Reach.landsOn([file], instance))
}

/**
 * 1.1.1 F22 (P37, S9-1): a place a step's own option or a formatter's in-place word names, taken from the step's folder,
 * judged as a redirect is since F20: by its tidied path, and also where the system opens it once each link before a `..`
 * is followed (`Reach.physical`). Both must open; a link loop does not.
 */
function targetOpens(word: string, cwd: string, env: Env) {
  if (word.startsWith("~") || !writeOpens(path.resolve(cwd, word), env)) return false
  if (!Reach.upward(word)) return true
  const landing = Reach.physical(word, cwd)
  return landing !== undefined && writeOpens(landing, env)
}

function allowedStep(argv: readonly string[], given: string, env: Env, depth: number, chain: ReadonlySet<string> = new Set()): boolean {
  const instance = env.instance
  // 1.1.1 F19 (P32 principle 1, G8-1): the step runs in its folder's real path, as a process's working folder always is.
  // Every manifest, install root, script, workspace and inside-the-project question below starts from there, so a link
  // inside the project to a folder under another manifest is judged by that manifest. undefined (a link loop): no.
  const cwd = Reach.real(given)
  if (depth > 3 || cwd === undefined || !containsPath(cwd, instance)) return false
  const at = argv.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
  // 1.1.1 F30 (P46): under consent a request tool's header or body value may take a `$NAME`; the request reader says which
  // of its words may (`OutwardConsent.request`). Anything else with an expansion is not read.
  const expanded = argv.some(dynamic)
  if (expanded && !(env.send && at >= 0 && OutwardConsent.REQUEST_TOOLS.has(argv[at]!))) return false
  if (at < 0 || !argv.slice(0, at).every((word) => BypassLists.SAFE_ASSIGNMENT.test(word))) return false
  const spelled = argv[at]!
  const name = base(spelled)
  // A bare name the shell finds on PATH, or the full path of a system folder; anything else is some other program.
  if (spelled.includes("/") && !BypassLists.SYSTEM_BIN.includes(path.posix.dirname(spelled))) return false
  // 1.1.1 F26 (P42): a step that sends where the consent lets it. What it writes is judged as a redirect is; a publish of
  // the npm family runs its lifecycle scripts, which pass what a script run by name must. 1.1.1 F29 (P44, D-F26-5
  // reversed): also a step of a project script (every other check of the script still applies to it), and a hosted deploy
  // handed on by `npx`, `bunx`, `bun x` or `pnpm dlx` (`launchedSend`), read as the bare form.
  if (env.send && (OutwardConsent.SEND_PROGRAMS.has(name) || name === "npx" || name === "bunx")) {
    const sent = sendStep(argv.slice(at), given, env.send)
    if (sent !== undefined) {
      if ("held" in sent) return false
      const launched = launchedSend(argv.slice(at), given, env.send.instance)
      const [program, ...words] = launched ?? argv.slice(at)
      // 1.1.1 F30 (G12-5): every place a publish, deploy, push or release names (a folder, a config file) lands inside the
      // project once links are followed, as a redirect's target must.
      if (!OutwardConsent.REQUEST_TOOLS.has(program!) && !words.every((word) => sendWordInside(word, cwd, env, program!))) return false
      if (!sent.outputs.every((word) => targetOpens(word, cwd, env))) return false
      // 1.1.1 F39 (G15-1): a publish or deploy is a part `interferes` judges beside every part that writes.
      // 1.1.1 F41 (V17-5): a pull request or a release that `gh` creates counts as one too, so a tree change or a write
      // beside it keeps the call at 1.1.0.
      const ghCreates = program === "gh" && (words.includes("pr") || words.includes("release")) && words.includes("create")
      if (env.trace && (OutwardConsent.PUBLISH_PROGRAMS.has(program!) || ghCreates)) env.trace.publishes = true
      const ok = !launched && OutwardConsent.NODE_PUBLISHERS.has(name) ? publishOpens(cwd, env, depth, chain) : true
      if (ok) env.collect?.push(...sent.destinations)
      return ok
    }
  }
  if (expanded) return false
  if (!/^[A-Za-z0-9][\w.+-]*$/.test(name) || !Object.hasOwn(BypassLists.ALLOWLIST, name)) return false
  const args = argv.slice(at + 1)
  if (!args.every((word) => staysInside(word, cwd, env, name))) return false
  if (!BypassLists.ALLOWLIST[name]!(args, allowContext(cwd, env, depth, chain))) return false
  // 1.1.1 F14 (G4-2 variant): a config or project file chosen on the line, or config given inline, says where the tool
  // writes in a way the checks below do not read. 1.1.1 F15 (S6-1, S6-2): the default file it may name must be one that
  // exists as a regular file and lands inside the project once links are followed. 1.1.1 F19 (P32 principle 2): a step
  // that names one counts beside a tree change (D-F19-4); 1.1.1 F20: it is marked as configuring, not as writing.
  const config = (file: string) => {
    if (env.trace) env.trace.configures = true
    // 1.1.1 F22 (P37): the file the tool opens, once each link before a `..` is followed, as well as the one named.
    const named = path.resolve(cwd, file)
    // 1.1.1 F25 (n57): without a `..` the landing is the named file, asked about once.
    if (!Reach.upward(file)) return configFileInside(named, instance)
    const landing = Reach.physical(file, cwd)
    return landing !== undefined && configFileInside(named, instance) && configFileInside(landing, instance)
  }
  if (BypassLists.selectsConfig(name, args, config)) return false
  // 1.1.1 F10a (G3-3): what the tool's own options say it writes is judged as a redirect is.
  const outputs = BypassLists.outputTargets(name, args)
  if (outputs === undefined || !outputs.every((word) => targetOpens(word, cwd, env))) return false
  // 1.1.1 F10b (P19 item 3): what a formatter or linter rewrites in place, the same way. A pattern is judged by the folder
  // before its first wildcard.
  const rewrites = BypassLists.inPlaceTargets(name, args)
  const fixedPart = (word: string) =>
    /[*?[{]/.test(word) ? word.slice(0, word.search(/[*?[{]/)).replace(/[^/]*$/, "") || "." : word
  if (
    rewrites === undefined ||
    !rewrites.every((word) => (word === BypassLists.PROJECT ? writeOpens(instance.directory, env) : targetOpens(fixedPart(word), cwd, env)))
  )
    return false
  // 1.1.1 F25 (P40): a formatter other than prettier that walks a folder (a folder named, a pattern's folder, the whole
  // project) may follow a link below it out of the project or into its storage; with any link there, 1.1.0 stands.
  // Only the marks are wanted in a trace-only walk, and the targets have marked this step as writing already.
  if (env.traceOnly || !WALKS_LINKS.has(name)) return true
  return rewrites.every((word) => {
    const folder =
      word === BypassLists.PROJECT
        ? instance.worktree === "/" ? instance.directory : instance.worktree
        : Reach.physical(fixedPart(word), cwd)
    // `Reach.linkBelow` walks each folder once per classify (its answers live in the classify's scope).
    return folder !== undefined && !Reach.linkBelow(folder, Reach.LINK_SCAN_CAP, name)
  })
}

/**
 * 1.1.1 F25 (P40): in-place formatters whose own walk of a folder is not known to leave links alone. Prettier is not
 * among them: its glob walk does not follow links and it skips a linked pattern (read in prettier 3.6.2).
 */
const WALKS_LINKS = new Set(["eslint", "biome", "black", "ruff", "cargo", "go"])

/**
 * 1.1.1 F10b (P19 item 1): a manifest script runs only what the allowlist accepts. The nearest `package.json` at or above
 * the step's folder (inside the project, at most `MAX_MANIFEST` bytes) names it; its `pre` and `post` hooks run with it,
 * in its folder, as every manager runs them. Each text is read by the shell's own reader (`ScriptReader`), with what the
 * call adds after the name appended to the main one, and passes only when the reader understands it in full and every step
 * passes what a step of the call itself must: no step the screen holds or refuses, nothing `unclear`, no risk label,
 * nothing it writes that `writeOpens` would not open, and the allowlist with its own checks. A script that runs another
 * (`npm run b`) is followed the same way, three scripts deep; a script met again on the way is a cycle and answers false.
 */
const MAX_MANIFEST = 1024 * 1024
const MAX_SCRIPT = 16 * 1024
/** 1.1.1 F12a (V4-1, m32): the project's own lifecycle scripts an install runs, in the order the managers run them. */
const INSTALL_HOOKS = ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare"]

/** The nearest manifest at or above `cwd` inside the project, read once per classify. */
function nearestManifest(cwd: string, env: Env) {
  if (env.nearest.has(cwd)) return env.nearest.get(cwd)
  const found = upward(cwd, env.instance).map((dir) => path.join(dir, "package.json")).find((file) => fs.existsSync(file))
  env.nearest.set(cwd, found)
  return found
}

/** A memoised answer for `key`: replayed onto the step being judged, or worked out once by `work`. */
function remembered(key: string, env: Env, work: () => boolean) {
  const known = env.scripts.get(key)
  if (known) {
    if (env.trace) merge(env.trace, [known])
    return known.ok
  }
  const outer = env.trace
  const mark = blank()
  env.trace = mark
  const ok = (() => {
    try {
      return work()
    } finally {
      env.trace = outer
    }
  })()
  env.scripts.set(key, { ok, ...mark })
  if (outer) merge(outer, [mark])
  return ok
}

function scriptOpens(name: string, extra: readonly string[], cwd: string, env: Env, depth: number, chain: ReadonlySet<string>) {
  const manifest = nearestManifest(cwd, env)
  if (!manifest || !Reach.inside(manifest, env.instance)) return false
  const key = `${manifest}\0${name}`
  if (env.trace) env.trace.runs = true
  return remembered([key, ...extra, depth, ...chain].join("\0"), env, () => {
    const scripts = manifestScripts(manifest, env)
    if (!scripts || chain.has(key) || typeof lookup(scripts, name) !== "string") return false
    // A word the manager appends, quoted for the shell; one that cannot be quoted plainly is not read.
    const appended = extra.map((word) => (/^[\w./@%+:,=-]+$/.test(word) ? word : word.includes("'") ? undefined : `'${word}'`))
    if (appended.some((word) => word === undefined)) return false
    const texts = [lookup(scripts, `pre${name}`), [lookup(scripts, name), ...appended].join(" "), lookup(scripts, `post${name}`)]
    const folder = path.dirname(manifest)
    const next = new Set([...chain, key])
    // 1.1.1 F12a (S4-1): a hook that changes the tree beside a text that runs a script is judged as two steps would be.
    return sequenceOpens(
      texts.flatMap((text, index) => (text === undefined && index !== 1 ? [] : [{ text: text as unknown }])),
      env,
      ({ text }) => typeof text === "string" && scriptTextOpens(text, folder, env, depth + 1, next),
    )
  })
}

/**
 * 1.1.1 F12a (V4-1, m32): an install opens only when each lifecycle script of the manifest it installs for passes what a
 * script run by name must. One that cannot be read, or a hook that is no text: false.
 *
 * 1.1.1 F17 (P30): which manifest that is follows one rule, the way npm finds its install root (`@npmcli/config`
 * `loadLocalPrefix`): the first folder upward from the call's folder, up to `/`, that holds a `package.json` or a
 * `node_modules`. The install opens only when that folder is inside the project and holds a manifest of its own, it is no
 * workspace root or member (`inWorkspace`), and no folder above the repository's top holds a `package.json` or a pnpm
 * workspace file (npm and pnpm keep looking there for a workspace root that lists the project). With no such folder
 * anywhere, npm installs in the call's folder itself; that keeps 1.1.0 as well. pnpm, yarn and bun are held to the same
 * rule. An install runs scripts (S4-1); it fills the dependency folder, not the manifest's scripts, so it does not count
 * as a change of the tree (1.1.1 P24). 1.1.1 F19 (P32 principle 1): `cwd` is a real path, so every walk is the one npm
 * makes from its real working folder.
 */
function installOpens(cwd: string, env: Env, depth: number, chain: ReadonlySet<string>) {
  if (env.trace) {
    env.trace.runs = true
    env.trace.installs = true
  }
  const root = installRoot(cwd, env)
  if (root === undefined || !root.manifest || !containsPath(root.dir, env.instance)) return false
  const manifest = path.join(root.dir, "package.json")
  if (!Reach.inside(manifest, env.instance)) return false
  if (manifestAbove(path.dirname(repositoryTop(env.instance)), env)) return false
  // 1.1.1 F14 (G5-2): in a workspace an install also runs its members' lifecycle scripts, which are not read here.
  if (inWorkspace(cwd, env)) return false
  const key = `${manifest}\0\0install`
  return remembered([key, depth, ...chain].join("\0"), env, () => {
    const parsed = manifestScripts(manifest, env)
    if (parsed === undefined || chain.has(key)) return false
    const hooks = INSTALL_HOOKS.filter((hook) => Object.hasOwn(parsed, hook))
    const folder = path.dirname(manifest)
    const next = new Set([...chain, key])
    // 1.1.1 F20 (P34, S9-4): the install itself is a part beside its own hooks, since `install` and `postinstall` run
    // after the dependency folder (and any link in it) is made.
    return sequenceOpens(
      hooks.map((hook) => ({ text: parsed[hook] })),
      env,
      ({ text }) => typeof text === "string" && scriptTextOpens(text, folder, env, depth + 1, next),
      [{ ...blank(), installs: true }],
    )
  })
}

/**
 * 1.1.1 F26 (P42): a publish of the npm family opens only when each publish lifecycle script of the nearest manifest
 * (`OutwardConsent.PUBLISH_HOOKS`) passes what a script run by name must, as an install's hooks do. A manifest that cannot
 * be read, in a workspace, or outside the project: false.
 */
function publishOpens(cwd: string, env: Env, depth: number, chain: ReadonlySet<string>) {
  return hooksOpen(cwd, env, depth, chain, OutwardConsent.PUBLISH_HOOKS, "publish")
}

/** 1.1.1 F40 (P56 usability item 8): the lifecycle scripts `npm version` runs. */
const VERSION_HOOKS = ["preversion", "version", "postversion"]
/**
 * 1.1.1 F40: what `publishOpens` was, for any one npm command's lifecycle scripts: the nearest manifest is inside the
 * project and no workspace's, and each of `hooks` it has passes what a script run by name must.
 */
function hooksOpen(cwd: string, env: Env, depth: number, chain: ReadonlySet<string>, names: readonly string[], label: string) {
  if (env.trace) env.trace.runs = true
  const manifest = nearestManifest(cwd, env)
  if (!manifest || !Reach.inside(manifest, env.instance) || inWorkspace(cwd, env)) return false
  const key = `${manifest}\0\0${label}`
  return remembered([key, depth, ...chain].join("\0"), env, () => {
    const parsed = manifestScripts(manifest, env)
    if (parsed === undefined || chain.has(key)) return false
    const hooks = names.filter((hook) => Object.hasOwn(parsed, hook))
    const folder = path.dirname(manifest)
    const next = new Set([...chain, key])
    return sequenceOpens(
      hooks.map((hook) => ({ text: parsed[hook] })),
      env,
      ({ text }) => typeof text === "string" && scriptTextOpens(text, folder, env, depth + 1, next),
    )
  })
}

/**
 * 1.1.1 F17 (P30): npm's install root for `cwd`: the first folder at or above it, up to `/`, holding a `package.json` or a
 * `node_modules` (either kind of entry; one that is no file or folder only keeps more calls at 1.1.0). undefined: none.
 */
function installRoot(cwd: string, env: Env): InstallRoot | undefined {
  if (env.roots.has(cwd)) return env.roots.get(cwd)
  const parent = path.dirname(cwd)
  // n38: whether the manifest marks the root is kept with it, so the install does not ask again.
  const manifest = fs.existsSync(path.join(cwd, "package.json"))
  const found =
    manifest || fs.existsSync(path.join(cwd, "node_modules"))
      ? { dir: cwd, manifest }
      : parent === cwd
        ? undefined
        : installRoot(parent, env)
  env.roots.set(cwd, found)
  return found
}

/** pnpm finds its workspace root by either of these files alone (1.1.1 F17, D-F17-4). */
const PNPM_WORKSPACE = ["pnpm-workspace.yaml", "pnpm-workspace.yml"]

/** The repository's top, or the project folder when there is no repository. */
const repositoryTop = (instance: AutonomyTable.Input["instance"]) => (instance.worktree === "/" ? instance.directory : instance.worktree)

/**
 * 1.1.1 F15, F17 (P30): a `package.json` in `dir` or any folder above it, up to `/`, or a pnpm workspace file (pnpm looks
 * for its workspace root by that file alone); asked once per folder per classify.
 */
function manifestAbove(dir: string, env: Env): boolean {
  const known = env.above.get(dir)
  if (known !== undefined) return known
  const parent = path.dirname(dir)
  const found =
    ["package.json", ...PNPM_WORKSPACE].some((name) => fs.existsSync(path.join(dir, name))) ||
    (parent !== dir && manifestAbove(parent, env))
  env.above.set(dir, found)
  return found
}

/**
 * 1.1.1 F14 (G5-2): some manifest at or above `cwd` inside the project declares workspaces, or a folder there holds a
 * pnpm workspace file. A manifest that cannot be read counts as one.
 */
function inWorkspace(cwd: string, env: Env) {
  // Up to the repository's top as well: a member folder opened as the project still installs for its workspace root.
  const top = repositoryTop(env.instance)
  const dirs: string[] = []
  for (let at = cwd; containsPath(at, { ...env.instance, directory: top }); at = path.dirname(at)) {
    dirs.push(at)
    if (at === top || path.dirname(at) === at) break
  }
  counters.workspaceAsks++
  return dirs.some((dir) => {
    // 1.1.1 F19 (G8-P1): each folder's answer is kept for the rest of the classify.
    const known = env.workspace.get(dir)
    if (known !== undefined) return known
    counters.workspaceFolders++
    const file = path.join(dir, "package.json")
    const marks =
      PNPM_WORKSPACE.some((name) => fs.existsSync(path.join(dir, name))) ||
      (fs.existsSync(file) && (readManifest(file, env)?.workspaces ?? true))
    env.workspace.set(dir, marks)
    return marks
  })
}

function scriptTextOpens(text: string, folder: string, env: Env, depth: number, chain: ReadonlySet<string>) {
  if (depth > 3 || text.length > MAX_SCRIPT) return false
  // 1.1.1 F20 (P34): read as a call's own text is, with the physical landing of each redirect with a `..`.
  const reading = consentReading(ScriptReader.read(text, folder), env.lexical)
  // 1.1.1 F22 (CR10-1): a reading with more distinct places than are judged keeps 1.1.0.
  if (!reading || !reading.complete || reading.steps.length === 0) return false
  // 1.1.1 F12a (P1, m28): every script step counts against this classify's budget.
  env.budget.left -= reading.steps.length
  if (env.budget.left < 0) return false
  if (!reading.writes.every((file) => writeOpens(file, env))) return false
  if (!reading.chdirs.every((place) => logicalCd(place, cdRoots(env), reading.steps))) return false
  // 1.1.1 F29 (P44): under consent a step of the script that sends is read as one of the call would be, with the call's
  // text and the script's together (a `<` or a pipe in either holds a request).
  const outer = env.send?.whole
  if (env.send) env.send.whole = `${outer ?? ""}\n${text}`
  const input = { ...env.send, instance: env.instance, ownProcesses: env.own }
  try {
    return sequenceOpens(
      reading.steps,
      env,
      (step) => {
        if (step.code !== undefined) return false
        if (Object.keys(stepScreen(step, input)).length > 0) return false
        if (stepUnclear(step.argv, false, 0) !== undefined || DeletionWords.deletesOrReplacesWide(step.argv, commandWords)) return false
        const risk = Risk.classify([...step.argv])
        if (risk.kind === "risky" && !(risk.risk === "remote" && stepSends(step, input))) return false
        return step.cwds.every((cwd) => allowedStep(step.argv, cwd, env, depth, chain))
      },
      redirectPart(reading.steps.length, reading.writes.length),
    )
  } finally {
    if (env.send) env.send.whole = outer
  }
}

/** The folders from `cwd` up to the project's top, nearest first. */
function upward(cwd: string, instance: AutonomyTable.Input["instance"]) {
  const found: string[] = []
  for (let at = cwd; containsPath(at, instance); at = path.dirname(at)) {
    found.push(at)
    if (at === instance.directory || at === instance.worktree || path.dirname(at) === at) break
  }
  return found
}

/**
 * 1.1.1 F15 (S6-1, S6-2): a config file named on the line is an existing regular file (links followed) that lands inside
 * the project by its name and once every link on the way is followed.
 */
function configFileInside(file: string, instance: AutonomyTable.Input["instance"]) {
  return fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true && containsPath(file, instance) && Reach.inside(file, instance)
}

/** 1.1.1 F15 (n29): short letters whose joined value is a pattern, not a place (`grep -e/x/`). */
const PATTERN_LETTERS: Readonly<Record<string, string>> = { grep: "e", rg: "e" }

/**
 * 1.1.1 F30 (G12-5): a word of a publish, deploy, push or release passes what any word must (`staysInside`), and when it, its
 * `=value` or a short option's joined value names something that is there (a folder, a file, a link, a dangling one
 * included), or has a folder part, that lands inside the project once every link on the way is followed. A word without
 * a folder part that names nothing there is no place (an image name, a branch, a title).
 */
function sendWordInside(word: string, cwd: string, env: Env, program: string) {
  if (!staysInside(word, cwd, env, program)) return false
  const joined = /^-[A-Za-z]./.test(word) && !word.includes("=") ? word.slice(2) : undefined
  return [word, word.includes("=") ? word.slice(word.indexOf("=") + 1) : undefined, joined].every((part) => {
    if (part === undefined || part === "" || part === "/dev/null") return true
    // A word with a folder part is followed through the links on its way even when its last name is not there yet.
    const named = path.resolve(cwd, part)
    if (!part.includes("/") && !fs.existsSync(named) && !Reach.isLink(named)) return true
    const landing = Reach.physical(part, cwd)
    return landing !== undefined && containsPath(landing, env.instance) && Reach.inside(landing, env.instance)
  })
}

/** A word that names a place (`/x`, `~/x`, `../x`, or an option's `=value` of one) names one inside the folder. */
function staysInside(word: string, cwd: string, env: Env, program: string) {
  // 1.1.1 F14 (G4-2): a place quoted inside a value given as data (JSON-like, `{...}` or `[...]`) is not read here, so
  // such a word does not pass; a short option's joined value (`-o/x`) is read as the value it is.
  // 1.1.1 F15 (S6-3): such a value with any backslash does not pass either, since a JSON escape can spell the place.
  // 1.1.1 F17 (S7-1): nor one with a step back anywhere in it (`./..`, a root token then `..`), wherever the string starts.
  if (/[{[]/.test(word) && (word.includes("\\") || word.includes("..") || /["']\s*(\/|~)/.test(word))) return false
  // 1.1.1 F19 (G7-1 variant), F20 (CR9-3): jest's root-dir token stands for a folder jest picks, which no check here
  // resolves, so a jest word with one does not pass. Only jest expands it: to every other program `<Name>` is plain text
  // (a commit message, a test-name filter), which passes as any other word does.
  if (program === "jest" && /<rootDir>/i.test(word)) return false
  const pattern = Object.hasOwn(PATTERN_LETTERS, program) && PATTERN_LETTERS[program]!.includes(word[1] ?? "")
  const joined = /^-[A-Za-z]./.test(word) && !word.includes("=") && !pattern ? word.slice(2) : undefined
  return [word, word.includes("=") ? word.slice(word.indexOf("=") + 1) : undefined, joined].every((part) => {
    if (part === undefined || part === "/dev/null") return true
    if (part.startsWith("~")) return false
    if (!part.startsWith("/") && !Reach.upward(part)) return true
    // 1.1.1 F19 (P32 principle 1): inside by its name, and once links are followed (a step back after a link inside the
    // project goes up from where the link leads, as the system resolves it, so the word is not normalised first).
    const target = path.resolve(cwd, part)
    const landing = Reach.physical(part, cwd)
    return (
      (containsPath(target, env.instance) || containsPath(target, env.lexical)) &&
      landing !== undefined &&
      containsPath(landing, env.instance)
    )
  })
}

/** 1.1.1 F22 (P37): something exists where `word`, taken from `cwd`, lands once links are followed. */
function existsLanding(word: string, cwd: string) {
  const landing = Reach.physical(word, cwd)
  return landing !== undefined && fs.existsSync(landing)
}

function allowContext(cwd: string, env: Env, depth: number, chain: ReadonlySet<string>): BypassLists.AllowContext {
  const instance = env.instance
  return {
    runs: (name, extra) => scriptOpens(name, extra, cwd, env, depth, chain),
    installs: () => installOpens(cwd, env, depth, chain),
    versions: () => hooksOpen(cwd, env, depth, chain, VERSION_HOOKS, "version"),
    localBin: (name) => upward(cwd, instance).some((dir) => fs.existsSync(path.join(dir, "node_modules", ".bin", name))),
    venv: () =>
      [instance.directory, instance.worktree].some((root) =>
        [".venv", "venv"].some((folder) => fs.existsSync(path.join(root, folder, "pyvenv.cfg"))),
      ),
    // 1.1.1 F22 (P37): a word that names something by its tidied path or where the system resolves it counts as a path,
    // which only ever reads the step as the stricter form. 1.1.1 F25 (CR11-4): defensive; while `staysInside` judges every
    // word with a `..` where it lands, this cannot change a verdict.
    exists: (word) => fs.existsSync(path.resolve(cwd, word)) || (Reach.upward(word) && existsLanding(word, cwd)),
    step: (argv) => allowedStep(argv, cwd, env, depth + 1, chain),
    // 1.1.1 F22 (P37): inside by its tidied path and where it lands once links are followed. 1.1.1 F25 (CR11-4): defensive,
    // as `exists` is.
    inside: (word) =>
      !word.startsWith("~") &&
      fs.existsSync(path.resolve(cwd, word)) &&
      Reach.inside(path.resolve(cwd, word), instance) &&
      (!Reach.upward(word) || landsInside(word, cwd, instance)),
    ownKill: (args) => !args.some(dynamic) && killIsOwn(args, env.own) === true,
  }
}

/**
 * The `scripts` of a manifest, or undefined when it cannot be read: too large (1.1.1 F10b), not JSON, not an ordinary file
 * once links are followed, or outside the project.
 */
function manifestScripts(file: string, env: Env): Record<string, unknown> | undefined {
  return readManifest(file, env)?.scripts
}

/** A manifest, read and parsed once per classify; undefined when it cannot be read. */
function readManifest(file: string, env: Env): Manifest | undefined {
  if (!env.manifests.has(file)) {
    // 1.1.1 F29 (P44): one read per classify, whichever walk of it asks first.
    env.manifests.set(
      file,
      Reach.classifyMemo(`manifest\0${file}`, () => {
        counters.manifestReads++
        return parseManifest(file)
      }),
    )
  }
  return env.manifests.get(file)
}

function parseManifest(file: string): Manifest | undefined {
  const parsed: unknown = (() => {
    try {
      const info = fs.statSync(file)
      if (!info.isFile() || info.size > MAX_MANIFEST) return undefined
      return JSON.parse(fs.readFileSync(file, "utf8"))
    } catch {
      return undefined
    }
  })()
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
  const fields = parsed as Record<string, unknown>
  const scripts = fields.scripts
  const workspaces = fields.workspaces !== undefined
  if (scripts === undefined) return { scripts: NO_SCRIPTS, workspaces }
  return {
    scripts: typeof scripts === "object" && scripts !== null && !Array.isArray(scripts) ? (scripts as Record<string, unknown>) : undefined,
    workspaces,
  }
}
/** A manifest read in full that has no `scripts` field. */
const NO_SCRIPTS: Record<string, unknown> = Object.freeze({})

/** Why the overlay may not open a call: a part of it is not understood. */
export type Unclear =
  | "unreadable"
  | "shell"
  | "launcher_text"
  | "inline_code"
  | "unscreened_script"
  | "alias"
  | "sql_input"
  | "unknown_then_risky"
  | "deletes"
  | "substitution"

/**
 * 1.1.1 F1b (P10, P11): the overlay opens a held call only when it understands every step. This names the first part it
 * does not, and the overlay then keeps the call's 1.1.0 verdict: a step whose program (past every launcher) is a shell; an
 * interpreter or launcher given inline code, stdin or a script that was not screened (`verdict.screen` is the screen of the
 * one script a single-step call ran); git configured inline or a subcommand that is no git command (an alias); a program
 * it does not know followed by one the risk tables call risky; an SQL tool reading a file or stdin; any step the wide
 * deletion reader says removes or replaces a file (the shell archives only what `classifyDeletion` answered A, which never
 * reaches here); and a command substitution with any piece in it that is not a known program screened clean.
 */
export function unclear(input: AutonomyTable.Input, verdict: AutonomyTable.Verdict): Unclear | undefined {
  if (input.permission !== "bash" && input.permission !== "external_directory") return undefined
  const command = input.metadata.command
  if (typeof command !== "string") return undefined
  const steps = readSteps(input)
  if (!steps) return "unreadable"
  const screened = verdict.screen !== undefined && steps.length === 1
  for (const step of steps) {
    if (step.code !== undefined && !screened) return "unscreened_script"
    const found = stepUnclear(step.argv, screened, 0)
    if (found) return found
    if (DeletionWords.deletesOrReplacesWide(step.argv, commandWords)) return "deletes"
  }
  for (const body of substitutions(command)) {
    for (const argv of commandWords(body)) {
      const program = DeletionWords.launched(argv)
      const known = program.kind === "program" && BypassLists.KNOWN_PROGRAMS.has(program.name)
      const clean = Object.keys(stepScreen({ argv, cwds: [input.cwd] }, input)).length === 0
      if (!known || !clean || stepUnclear(argv, false, 0) || DeletionWords.deletesOrReplacesWide(argv, commandWords)) return "substitution"
    }
  }
  return undefined
}

/**
 * 1.1.1 F14 (G5-P3): past this many words in one step the step is not read further; the call keeps its 1.1.0 verdict.
 * The cap bounds every program, not only an unknown one: a known program's checks are linear in its words (each named
 * file is judged), so it also bounds a formatter or `git add` given thousands of paths (n28). Do not narrow it.
 */
export const MAX_STEP_WORDS = 256

function stepUnclear(argv: readonly string[], screened: boolean, depth: number): Unclear | undefined {
  if (depth > 4 || argv.length > MAX_STEP_WORDS) return "unreadable"
  const found = DeletionWords.launched(argv)
  if (found.kind === "unreadable") return "unreadable"
  if (found.kind === "code") return "launcher_text"
  if (found.kind === "none") return undefined
  if (found.assignments.some((word) => BypassLists.LOADS_CODE.test(word) || BypassLists.NODE_OPTIONS_CODE.test(word))) return "alias"
  const { name, args } = found
  if (SHELLS.has(name) || RUNS_TEXT.has(name)) return "shell"
  if (!screened) {
    const code = interpreterCode(name, found.spelled, args)
    if (code) return code
  }
  if (name === "git" && gitAlias(args)) return "alias"
  if (SQL_TOOLS.has(name) && !sqlInline(name, args)) return "sql_input"
  if (name === "find") {
    for (const [index, word] of args.entries()) {
      if (!FIND_EXEC.has(word)) continue
      const end = args.findIndex((next, at) => at > index && (next === ";" || next === "+"))
      const inner = stepUnclear(args.slice(index + 1, end < 0 ? undefined : end), false, depth + 1)
      if (inner) return inner
    }
  }
  if (!BypassLists.KNOWN_PROGRAMS.has(name) && args.some((word, index) => !word.startsWith("-") && riskyProgram(args.slice(index))))
    return "unknown_then_risky"
  return undefined
}

/** H3: what an interpreter runs that no screen read: inline code, stdin, a REPL, a script file. */
function interpreterCode(name: string, spelled: string, args: readonly string[]): Unclear | undefined {
  if (BypassLists.SCRIPT_FILE.test(name) || BypassLists.SCRIPT_FILE.test(spelled)) return "unscreened_script"
  const inline = lookup(BypassLists.INLINE_CODE, name) ?? (/^python\d+(\.\d+)*$/.test(name) ? ["-c"] : undefined)
  if (!inline) return undefined
  // An awk program is its first word or a file (`-f`): code either way.
  if (/^[gmn]?awk$/.test(name)) return "inline_code"
  if (args.length === 0) return "inline_code"
  const python = name.startsWith("python") || name.startsWith("pypy")
  let index = 0
  for (; index < args.length; index++) {
    const word = args[index]!
    const option = word.split("=")[0]!
    if (word === "-") return "inline_code"
    if (word === "--") {
      index++
      break
    }
    if (!word.startsWith("-")) break
    if (inline.includes(option)) return "inline_code"
    // A short flag with its value joined (`-e'code'`, `-MFoo`).
    if (!word.startsWith("--") && inline.some((flag) => flag.length === 2 && word.startsWith(flag))) return "inline_code"
    // `python3 -m pytest` runs a module by name, as an installed program would.
    if (python && word === "-m") return undefined
    if (python && (word === "-W" || word === "-X")) index++
  }
  const first = args[index]
  if (first === undefined) return args.every((word) => BypassLists.PRINTS_ONLY.test(word)) ? undefined : "inline_code"
  const subs = lookup(BypassLists.INTERPRETER_SUBS, name)
  if (subs?.has(first)) {
    if (first === "eval" || first === "repl") return "inline_code"
    if (first !== "run" && first !== "serve") return undefined
    const next = args.slice(index + 1).find((word) => !word.startsWith("-"))
    return next !== undefined && /[./]/.test(next) ? "unscreened_script" : undefined
  }
  // `bun build-docs` runs the package script of that name; a word with a `.` or `/` is a file.
  if (subs && !/[./]/.test(first)) return undefined
  return "unscreened_script"
}

/** H3: git configured inline, or a first word that is no git command and so an alias. */
function gitAlias(args: readonly string[]) {
  let index = 0
  while (index < args.length && args[index]!.startsWith("-")) {
    if (BypassLists.GIT_INLINE_CONFIG.test(args[index]!)) return true
    index += ["-C", "--git-dir", "--work-tree", "--namespace"].includes(args[index]!) ? 2 : 1
  }
  const sub = args[index]
  return sub !== undefined && !BypassLists.GIT_SUBCOMMANDS.has(sub)
}

/** M2: an SQL tool whose statement is on the line, where the screen read it. A file or stdin is not. */
function sqlInline(name: string, args: readonly string[]) {
  if (args.some((word) => BypassLists.SQL_FILE.test(word.trim()))) return false
  if (name === "sqlite3") return args.filter((word) => !word.startsWith("-")).length >= 2
  const inline = lookup(BypassLists.SQL_INLINE, name) ?? []
  return args.some(
    (word) => inline.includes(word.split("=")[0]!) || inline.some((flag) => flag.length === 2 && word.startsWith(flag) && word.length > 2),
  )
}

/** A program the risk tables, the deletion reader or this screen's lists call risky, at the head of `words`. */
function riskyProgram(words: readonly string[]) {
  const name = base(words[0] ?? "")
  return (
    Risk.classify([...words]).kind === "risky" ||
    DeletionWords.DELETERS.has(name) ||
    DeletionWords.REPLACERS.has(name) ||
    OUTWARD.has(name) ||
    SHELLS.has(name) ||
    ADMIN.has(name) ||
    RUNS_TEXT.has(name) ||
    SYSTEM_SERVICE.has(name) ||
    HOST.has(name) ||
    SQL_TOOLS.has(name) ||
    ["kill", "pkill", "killall"].includes(name) ||
    lookup(BypassLists.INLINE_CODE, name) !== undefined ||
    outwardForm(name, words.slice(1)) ||
    lookup(BypassLists.OUTSIDE_WRITE_FORMS, name)?.(words.slice(1)) === true
  )
}

/** The texts of every command substitution (`$( )` and backquotes) outside single quotes, inside double quotes included. */
function substitutions(command: string) {
  const bodies: string[] = []
  let quote: "'" | '"' | undefined
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (quote === "'") {
      if (char === "'") quote = undefined
      continue
    }
    if (char === "\\") {
      index++
      continue
    }
    if (char === '"') {
      quote = quote ? undefined : '"'
      continue
    }
    if (char === "'" && !quote) {
      quote = "'"
      continue
    }
    if (char === "`") {
      const end = command.indexOf("`", index + 1)
      bodies.push(command.slice(index + 1, end < 0 ? undefined : end))
      if (end < 0) break
      index = end
      continue
    }
    if (char !== "$" || command[index + 1] !== "(") continue
    let depth = 0
    let at = index + 1
    for (; at < command.length; at++) {
      if (command[at] === "(") depth++
      if (command[at] === ")" && --depth === 0) break
    }
    bodies.push(command.slice(index + 2, at))
    index = at
  }
  return bodies
}

export * as BypassScreen from "./bypass-screen"
