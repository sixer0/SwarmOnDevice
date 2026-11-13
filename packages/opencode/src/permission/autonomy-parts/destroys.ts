// Part of the autonomy table (R-1, 1.2.8): Destroying and replacing commands, output folders, consent redirects, stopping Swarm and `noWait`.
// Moved unchanged from `autonomy-table.ts`, which re-exports the public names; import from there, not from here.
import fs from "node:fs"
import { devNull, homedir } from "node:os"
import path from "node:path"
import { OutwardConsent } from "../outward-consent"
import { ScriptScreen } from "../script-screen"
import { BypassScreen } from "../bypass-screen"
import { containsPath } from "../../project/instance-context"
import { Reach } from "../../tool/reach"
import { Risk } from "../../tool/risk"
import { DeletionWords } from "../../tool/deletion"
import { refused, type Input, type Verdict } from "./types"
import { commandWords } from "./outward"
import { MAKES, scriptForm, shellReading } from "./shell-steps"
import { OUTWARD_HELD, consentOutward } from "./consent"
import { shellRunsScreenedScript } from "./subagent"
/**
 * 1.1.3: the wide reader (`DeletionWords.deletesOrReplacesWide`) sees a shell call remove, empty or replace a file, or
 * cannot tell (a launcher it cannot read).
 */
function destroys(input: Input) {
  if (input.permission !== "bash") return false
  const command = input.metadata.command
  if (typeof command !== "string") return false
  // 1.1.3 (T9 G1): the shell's own reading first, whose words carry no quote marks, so a `-c` text is seen as written.
  const read = (BypassScreen.readSteps(input) ?? []).map((step) => ({ argv: step.argv, cwds: step.cwds }))
  const pieces = commandWords(command)
  // 1.2.6 P-02: the rough reading splits a quoted name with a space and knows no `cd`. A `cp`/`mv` piece of it is left to the
  // shell's reading when that has as many `cp`/`mv` steps, each judged with its own folder; otherwise it is judged from the
  // call's folder, and only when nothing moves it.
  const copies = (list: readonly (readonly string[])[]) => list.filter((words) => words[0] === "cp" || words[0] === "mv").length
  const covered = copies(pieces) > 0 && copies(read.map((step) => step.argv)) >= copies(pieces)
  const moves = pieces.some((words) => ["cd", "pushd", "popd"].includes(words[0] ?? ""))
  const rough = pieces
    .filter((words) => !(covered && (words[0] === "cp" || words[0] === "mv")))
    .map((words) => ({ argv: words, cwds: moves ? [] : [input.cwd] }))
  // A step of a compound (`classifySteps`) is alone only when the whole text it came from is.
  const alone =
    copyAlone(read.length > 0 ? read.map((step) => step.argv) : pieces) &&
    (input.whole === undefined || input.whole === command || copyAlone(commandWords(input.whole)))
  return [...read, ...rough].some((step) => stepDestroys(step.argv, step.cwds, input, alone))
}

/**
 * 1.2.6 P-02: what the gate sees missing is still missing when the copy runs only when nothing else in the call can make it:
 * exactly one `cp`/`mv`, and beside it at most a plain `mkdir` (which makes folders, never a file). A `git checkout`, an
 * install, a second copy or a link before it could put a file where the gate saw none, so such a call keeps the 1.2.5 answer.
 */
function copyAlone(steps: readonly (readonly string[])[]) {
  const copies = steps.filter((argv) => argv[0] === "cp" || argv[0] === "mv")
  const rest = steps.filter((argv) => argv[0] !== "cp" && argv[0] !== "mv")
  return copies.length === 1 && rest.every((argv) => argv[0] === "mkdir" && argv.slice(1).every((word) => !word.startsWith("-") || MAKES.mkdir.test(word)))
}

/**
 * 1.2.6 P-02 (E-45): `DeletionWords.deletesOrReplacesWide` for one step, except a plain `cp`/`mv`, alone in its call
 * (`copyAlone`), that `copiesToNewName` shows replaces nothing.
 */
function stepDestroys(argv: readonly string[], cwds: readonly string[], input: Input, alone: boolean) {
  return !(alone && copiesToNewName(argv, cwds, input)) && DeletionWords.deletesOrReplacesWide(argv, commandWords)
}

/**
 * 1.2.6 P-02 (01b section 3.2): a plain `cp`/`mv` (`Risk.copyMove`, literal words) whose every target, worked out by the
 * program's rules from each folder it may run in, is an ordinary place in the project that `Risk.replacing` finds missing
 * (or `-n`). A copy's sources are readable and no secret; a move's are ordinary places in the project, since a move takes
 * them away (01b 3.2 rule 3). Targets that cannot be worked out, a word the shell would still expand, a move to the null
 * device or a folder nobody knows: false, so the caller keeps the 1.2.5 answer.
 */
function copiesToNewName(argv: readonly string[], cwds: readonly string[], input: Input) {
  if ((argv[0] !== "cp" && argv[0] !== "mv") || cwds.length === 0 || DeletionWords.deletes(argv)) return false
  const words = argv.map(literalWord)
  if (words.some((word) => word === undefined)) return false
  const item = Risk.copyMove(words as string[])
  if (!item) return false
  const instance = input.instance
  // Without Git the worktree is `/`, and every name would be judged from the top of the disk.
  const base = instance.worktree === "/" ? { ...instance, worktree: instance.directory } : instance
  const roots = [input.cwd, instance.directory, instance.worktree].map((root) => Reach.real(root))
  const place = (file: string) =>
    Reach.inside(file, instance) && !Reach.sensitive(file, base) && !Reach.secret(file) && !roots.includes(Reach.real(file))
  return cwds.every((cwd) => {
    if (!path.isAbsolute(cwd)) return false
    const sources = item.sources.map((word) => path.resolve(cwd, word))
    const from = (file: string) => (item.name === "mv" ? place(file) : Reach.readable(file) && !Reach.secret(file))
    if (!sources.every(from)) return false
    const targets = Risk.copyTargets(item, cwd)
    if (!targets || !targets.every(place)) return false
    return Risk.replacing(item, cwd)?.length === 0
  })
}

/** A word as the program gets it, when no quote, variable, glob or escape is left for the shell to work out; else undefined. */
function literalWord(word: string) {
  if (/^'[^']*'$/.test(word)) return word.slice(1, -1)
  if (/^"[^"$`\\]*"$/.test(word)) return word.slice(1, -1)
  if (/['"$`\\*?[\]{}]/.test(word) || word.startsWith("~")) return undefined
  return word
}

/**
 * 1.1.3 (T9 G1): a word of a text nobody can read word by word that names a deletion or an action nothing can undo. Read
 * roughly, on purpose: it only ever answers with the archive way instead of running.
 */
const DESTRUCTIVE_TOKEN =
  /(^|[\s;&|(){}'"`=])(rm|rmdir|unlink|shred|truncate|rimraf|srm|wipe|dd|mkfs(\.\w+)?|dropdb|crontab|delete|destroy|drop|flushall|flushdb|reset|clean|unpublish|uninstall|terminate|-{1,2}delete)(?=$|[\s;&|(){}'"`])/i

/**
 * 1.1.3 (T9 G2): a step of a project script deletes: a deletion program or form the wide reader sees, but not one that only
 * replaces (`cp`, `mv`, `install`, `ditto`, a plain `rsync`) or a shell running a script file, which build scripts do all
 * the time. `rsync --delete`, a `dd` and a move to the null device still count.
 */
function scriptDeletes(argv: readonly string[]) {
  if (!DeletionWords.deletesOrReplacesWide(argv, commandWords)) return false
  const found = DeletionWords.launched(argv)
  if (found.kind !== "program") return found.kind !== "none"
  const { name, args } = found
  if (DeletionWords.SHELLS.has(name)) return DeletionWords.shellText(name, args) !== undefined
  if (name === "ln") return false
  if (name === "rsync") return args.some((word) => word.startsWith("--delete"))
  if (name === "mv") return args.some((word) => word === "/dev/null" || word === devNull)
  if (DeletionWords.REPLACERS.has(name) && name !== "dd") return false
  return true
}

/**
 * 1.1.3 (T10): the folders a build writes and a clean step empties again. A deletion in a project script that targets only
 * these, inside the project, runs; any other deletion in a script still gets the archive way (T9 G2).
 */
export const OUTPUT_FOLDERS: ReadonlySet<string> = new Set([
  "dist", "build", "out", ".next", ".nuxt", ".turbo", ".svelte-kit", "coverage", "target", ".cache", "tmp",
])
/** The plain deletion programs whose operands are all paths; anything else in a script is judged by `scriptDeletes`. */
const OUTPUT_DELETERS: ReadonlySet<string> = new Set(["rm", "rmdir", "unlink", "rimraf", "del", "del-cli"])
const GLOB = /[*?[\]]/

/**
 * 1.1.3 (T10): one operand of a script's deletion names a generated-output folder, or something in one, of the folder the
 * script runs in, inside the project. Refused as the write checks refuse (`safePath`): a `~`, an option, a `..` anywhere,
 * a brace, an expansion, a glob in the folder's own name, or a link on the way (the folder or any named part under it),
 * and the whole path must still be inside the project once links are followed.
 */
function outputPath(word: string, cwd: string, input: Input) {
  if (word === "" || word.startsWith("~") || word.startsWith("-") || word.includes("..") || /[{}$`\\\0]/.test(word)) return false
  if (!Reach.inside(cwd, input.instance)) return false
  const file = path.resolve(cwd, word)
  const parts = path.relative(cwd, file).split(path.sep)
  if (parts[0] === "" || parts[0] === ".." || path.isAbsolute(parts[0]!) || !OUTPUT_FOLDERS.has(parts[0]!)) return false
  let at = cwd
  for (const part of parts) {
    if (GLOB.test(part)) break
    at = path.join(at, part)
    if (fs.lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink()) return false
  }
  const literal = parts.findIndex((part) => GLOB.test(part))
  const checked = literal === -1 ? file : path.join(cwd, ...parts.slice(0, literal))
  return Reach.inside(checked, input.instance) && containsPath(checked, input.instance)
}

/** 1.1.3 (T10): a script step that deletes, with every operand a generated-output path (`outputPath`) in every folder. */
function deletesOutputOnly(step: { argv: readonly string[]; cwds: readonly string[] }, input: Input) {
  const found = DeletionWords.launched(step.argv)
  if (found.kind !== "program" || found.fed || !OUTPUT_DELETERS.has(found.name)) return false
  // Admin rights (or a feed of names nobody sees) are never a plain clean step.
  if (found.launchers.some((name) => /^(sudo|doas|su|pkexec|run0)\b/.test(name))) return false
  const operands: string[] = []
  let ended = false
  for (const word of found.args) {
    if (!ended && word === "--") ended = true
    else if (!ended && word.startsWith("-")) continue
    else operands.push(word)
  }
  if (operands.length === 0 || step.cwds.length === 0) return false
  return step.cwds.every((cwd) => operands.every((word) => outputPath(word, cwd, input)))
}

/**
 * 1.1.3 (T9 G4): a git step that throws away work nothing has committed: a checkout of paths (`--`, `.`, a path that is
 * there, `-f`), a `restore` of the working tree, a `switch` that discards (`--discard-changes`, `-f`), a forced
 * `worktree remove`, or a forced `checkout-index`. It counts only when no Undo snapshot covers it: Undo is off (a folder
 * without Git, snapshots off), or it acts outside the project (its folder, a `-C` folder, or the worktree it removes).
 */
function discardsWork(step: { argv: readonly string[]; cwds: readonly string[] }, input: Input) {
  const found = BypassScreen.unwrap(step.argv)
  if (found.kind !== "program" || found.name !== "git") return false
  const args = found.args
  const moves: string[] = []
  let at = 0
  while (at < args.length) {
    const word = args[at]!
    if (word === "-C") {
      moves.push(args[at + 1] ?? ".")
      at += 2
    } else if (word === "-c" || word === "--git-dir" || word === "--work-tree" || word === "--namespace") at += 2
    else if (word.startsWith("-")) at++
    else break
  }
  const sub = args[at]
  const rest = args.slice(at + 1)
  const has = (...names: string[]) => rest.some((word) => names.includes(word))
  const forced = has("--force") || rest.some((word) => /^-[A-Za-z]*f[A-Za-z]*$/.test(word))
  const places = step.cwds.map((cwd) => moves.reduce((dir, move) => path.resolve(dir, move), cwd))
  const positional = rest.filter((word) => !word.startsWith("-"))
  let targets = places
  const discards = (() => {
    if (sub === "checkout")
      return (
        has("--", ".") ||
        forced ||
        positional.some((word) => places.some((place) => fs.existsSync(path.resolve(place, word))))
      )
    if (sub === "restore") return !(has("--staged", "-S") && !has("--worktree", "-W"))
    if (sub === "switch") return has("--discard-changes") || forced
    if (sub === "checkout-index") return forced
    if (sub === "worktree" && positional[0] === "remove" && forced) {
      const named = positional.slice(1)
      if (named.length > 0) targets = places.flatMap((place) => named.map((word) => path.resolve(place, word)))
      return true
    }
    return false
  })()
  if (!discards) return false
  return !input.canUndo || targets.some((target) => !Reach.inside(target, input.instance))
}

/** 1.1.3 (T9 G5): a path of the person's own configuration outside the project: under the home folder, not in the project. */
function userConfigPath(word: string, cwd: string, input: Input) {
  const home = homedir()
  const file = word === "~" || word.startsWith("~/") ? path.join(home, word.slice(1)) : path.resolve(cwd, word)
  if (path.relative(home, file).startsWith("..") || path.isAbsolute(path.relative(home, file))) return false
  // Through links, as the project's own folders are spelled (`Reach.realRoots`); a file not there yet counts by its folder.
  const parent = Reach.real(path.dirname(file)) ?? path.dirname(file)
  return !containsPath(path.join(parent, path.basename(file)), Reach.realRoots(input.instance)) && !containsPath(file, input.instance)
}

/** 1.1.3 (T9, row 11 re-run): the script screen's flags of a call that is inline code or a script file (`scriptForm`). */
function consentScriptFlags(input: Input, command: string): readonly string[] {
  const form = scriptForm(command.trim())
  if (!form) return []
  const directory = input.instance.directory
  const screen =
    form.code === undefined
      ? ScriptScreen.file({ directory, file: form.file, cwd: input.cwd })
      : ScriptScreen.inline(form.code, { roots: [...new Set([directory, Reach.real(directory) ?? directory])], cwd: input.cwd })
  return screen.ok ? screen.flags : []
}

/**
 * 1.1.3 (T9 G1-G5): under consent, what a shell call does past its own top-level words, and what it removes that nothing
 * archives. "irreversible": an X trigger inside a shell text or a project script, or a cloud or remote resource deleted
 * (`BypassScreen.cloudDeletes`); "admin_rights": admin rights inside a text; "not_reversible": a deletion or replacement
 * inside a shell text (`-c`, `eval`), a deletion in a project script run by name, git that discards uncommitted work no
 * snapshot covers, the person's configuration outside the project deleted, or a text nobody can read that names a
 * deletion or an irreversible action. undefined: none of these.
 */
function consentRedirect(input: Input): "irreversible" | "admin_rights" | "delete_compound" | "not_reversible" | undefined {
  if (input.permission !== "bash") return undefined
  if (typeof input.metadata.command !== "string") return undefined
  // Inline code or a script file the 1.1.0 table held before screening it (no Undo, a folder not trusted, a program of the
  // project): its sudo and delete flags get the answer a screened one gets (rule 3), so it never runs unscreened.
  const flags = consentScriptFlags(input, input.metadata.command)
  if (flags.includes("sudo")) return "admin_rights"
  if (flags.includes("delete")) return "delete_compound"
  const deep = BypassScreen.deepSteps(input)
  // 1.2.6 P-02: a copy inside a shell text runs as a new name only when it is alone there (`copyAlone`).
  const textAlone = copyAlone(deep.steps.filter((step) => step.from === "text").map((step) => step.argv))
  let archive = false
  for (const step of deep.steps) {
    const program = BypassScreen.unwrap(step.argv)
    if (program.kind === "program" && BypassScreen.cloudDeletes(program.name, program.args)) return "irreversible"
    if (step.from !== "call") {
      const x = BypassScreen.stepX(step, input)
      if (x === "irreversible" || x === "admin_rights") return x
      if (x === "delete_compound") archive = true
      if (step.from === "text" && stepDestroys(step.argv, step.cwds, input, textAlone)) archive = true
      if (step.from === "script" && scriptDeletes(step.argv) && !deletesOutputOnly(step, input)) archive = true
    }
    if (discardsWork(step, input)) archive = true
    if (BypassScreen.deletesUserConfig(step.argv)) archive = true
    if (program.kind === "program" && (DeletionWords.DELETERS.has(program.name) || DeletionWords.deletes(step.argv))) {
      const named = program.args.filter((word) => !word.startsWith("-"))
      if (named.some((word) => step.cwds.some((cwd) => userConfigPath(word, cwd, input)))) archive = true
    }
  }
  if (deep.unreadable.some((text) => DESTRUCTIVE_TOKEN.test(text))) archive = true
  return archive ? "not_reversible" : undefined
}

/** 1.1.3 (T7 F3): an existing regular file, through links. Anything that cannot be read counts as not existing. */
export function existingFile(file: string) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * 1.1.3 (T7 F3, T9 G6): the file words of the text's redirects that replace (`>`, `N>`, `>|`, `&>`, and zsh's `>!`,
 * `&>!`, `>&|`, `>&!`), read outside quotes
 * and comments. An append (`>>`, `&>>`) replaces nothing, a stream move (`2>&1`, `>&-`) names no file, and `<>` opens
 * without emptying. A `>` inside quotes (`"a -> b"`, `awk '$1 > 5'`) is no redirect.
 */
export function replacingTargets(command: string): string[] {
  const found: string[] = []
  let quote: string | undefined
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (quote) {
      if (char === "\\" && quote === '"') index++
      else if (char === quote) quote = undefined
      continue
    }
    if (char === "\\") {
      index++
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === "#" && (index === 0 || /\s/.test(command[index - 1]!))) {
      const end = command.indexOf("\n", index)
      if (end < 0) break
      index = end
      continue
    }
    if (char !== ">") continue
    let at = index + 1
    if (command[at] === ">") {
      index = at
      continue
    }
    if (command[index - 1] === "<") continue
    if (command[at] === "&") {
      const moved = /^(\d+|-)(?=$|[\s;&|()<>])/.exec(command.slice(at + 1))
      if (moved) {
        index = at + moved[0].length
        continue
      }
      at++
    }
    // 1.2.7 row 47i (C72, M1-04): zsh's noclobber overrides `>|`, `>!`, `N>!`, `&>!`, `>&|`, `>&!` (and `>!f`) replace
    // like `>`; the `|`/`!` touching the operator is no part of the file word. bash knows `>|` only, and the shell leaves
    // its `!` spellings unread, so nothing it reads changes.
    if (command[at] === "|" || command[at] === "!") at++
    while (command[at] === " " || command[at] === "\t") at++
    let word = ""
    let inner: string | undefined
    for (; at < command.length; at++) {
      const next = command[at]!
      if (inner) {
        if (next === inner) inner = undefined
        else word += next
        continue
      }
      if (next === "'" || next === '"') {
        inner = next
        continue
      }
      if (/[\s;&|()<>]/.test(next)) break
      word += next
    }
    if (word) found.push(word)
    index = at - 1
  }
  return found
}

/** 1.1.3 (T9 G6): the files of the reading's `writes` that a replacing redirect (`replacingTargets`) names. */
export function replacedWrites(command: string, writes: readonly string[], cwds: readonly string[]) {
  const words = replacingTargets(command).map((word) => (word === "~" || word.startsWith("~/") ? path.join(homedir(), word.slice(1)) : word))
  if (words.length === 0) return []
  return writes.filter((file) =>
    words.some(
      (word) =>
        cwds.some((cwd) => path.resolve(cwd, word) === file) ||
        // A target through `..` may land elsewhere once links are followed (`physicalWrites`); its name is the same.
        (word.includes("..") && path.basename(word) === path.basename(file)),
    ),
  )
}

/** 1.1.3 (T7 F3): the files a `tee` without `-a` of these steps writes, as each folder it may run in reads them. */
function teeTargets(steps: readonly { argv: readonly string[]; cwds: readonly string[] }[]) {
  const files: string[] = []
  for (const step of steps) {
    const found = BypassScreen.unwrap(step.argv)
    if (found.kind !== "program" || found.name !== "tee") continue
    const flags = found.args.filter((word) => word.startsWith("-") && word !== "-")
    if (flags.some((word) => word === "--append" || (/^-[A-Za-z]+$/.test(word) && word.includes("a")))) continue
    const named = found.args.filter((word) => !word.startsWith("-"))
    for (const cwd of step.cwds) files.push(...named.map((word) => path.resolve(cwd, word)))
  }
  return files
}

/**
 * 1.1.3 (T7 F3, narrowed by T8): a shell call replaces a file that exists and that no Undo snapshot covers: a `>` (or
 * `>|`, `&>`) redirect or a `tee` without `-a` onto such a file, without Undo (a folder without Git, snapshots off) or
 * outside the project, where no snapshot reaches. A file that does not exist yet is created, not replaced; an append
 * (`>>`, `tee -a`) replaces nothing. T8: the write, edit and patch tools are not judged here and keep running everywhere,
 * a folder without Git included; nor is `sed -i`.
 */
function overwritesWithoutUndo(input: Input) {
  if (input.permission !== "bash") return false
  const command = input.metadata.command
  if (typeof command !== "string") return false
  const reading = shellReading(input.metadata.steps, input.instance)
  const steps = reading?.steps ?? BypassScreen.readSteps(input) ?? commandWords(command).map((argv) => ({ argv, cwds: [input.cwd] }))
  const cwds = [...new Set([input.cwd, ...steps.flatMap((step) => step.cwds)])]
  const targets = [...(reading ? replacedWrites(command, reading.writes, cwds) : []), ...teeTargets(steps)]
  return targets.some((file) => (!input.canUndo || !Reach.inside(file, input.instance)) && existingFile(file))
}

/**
 * 1.1.3 (T7 F4): a word naming Swarm's own app or server as a process name (the desktop app `Swarm`, `Swarm.app`, its
 * `Swarm Helper` processes, the `opencode` / `swarm` server), alone or as the last part of a path, with arguments after a
 * space. A folder called `swarm` inside a path (a project's own `swarm/node_modules/.bin/vite`) is not such a name.
 */
const SWARM_PROCESS = /(^|\/)(swarm|opencode)(\.app|\s|$)/i
const SIGNALLERS = new Set(["kill", "pkill", "killall"])

/** 1.1.3 (T7 F4): the targets of a `kill`, a negative number (a process group) or `-1` (every process) included. */
function killTargets(args: readonly string[]) {
  const targets: string[] = []
  let ended = false
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    if (ended) targets.push(word)
    else if (word === "--") ended = true
    else if (word === "-s" || word === "-n" || word === "--signal") index++
    else if (index === 0 && /^-[A-Za-z0-9]+$/.test(word)) continue
    else if (/^-\d+$/.test(word) || !word.startsWith("-")) targets.push(word)
  }
  return targets
}

/** 1.1.3 (T7 F4): a pid word that names this server, the app that started it, or a group or set holding them. */
function swarmPid(word: string) {
  if (word === "0" || word === "-1" || /^\$\{?PPID\}?$/.test(word)) return true
  if (!/^-?[1-9]\d*$/.test(word)) return false
  const pid = Math.abs(Number(word))
  return pid === process.pid || (process.ppid > 1 && pid === process.ppid)
}

/**
 * 1.1.3 (T7 F4): a shell call that would stop Swarm's own app or server, and with it this run: a `kill` of this server's
 * pid, of the app that started it (`$PPID` included), of a group or every process; a `pkill` or `killall` naming Swarm or
 * the server; or a signal sent to what `pgrep`, `pidof` or `lsof` finds under those names. Read roughly, on purpose: it
 * only ever refuses more.
 */
function stopsSwarm(input: Input) {
  if (input.permission !== "bash") return false
  const command = input.metadata.command
  if (typeof command !== "string") return false
  const steps = [
    ...(BypassScreen.readSteps(input) ?? []).map((step) => step.argv),
    ...commandWords(command),
  ]
  let signals = false
  let finds = false
  for (const argv of steps) {
    const found = BypassScreen.unwrap(argv)
    if (found.kind !== "program") continue
    const name = path.basename(found.name)
    if (name === "kill" && killTargets(found.args).some(swarmPid)) return true
    if ((name === "pkill" || name === "killall") && found.args.some((word) => !word.startsWith("-") && SWARM_PROCESS.test(word)))
      return true
    if (SIGNALLERS.has(name) || (name === "xargs" && found.args.some((word) => SIGNALLERS.has(path.basename(word))))) signals = true
    if (["pgrep", "pidof", "lsof"].includes(name) && found.args.some((word) => SWARM_PROCESS.test(word))) finds = true
  }
  return signals && finds
}

/**
 * 1.1.3 (T7 F2): the verdicts `noWait` opened from a D or P (or the X `outside_write`): the calls that waited before 1.1.3.
 * A compound records the category of such a step (`classifySteps`), not of a step the 1.1.1 overlay already opened.
 */
export const OPENED_BY_NO_WAIT = new WeakSet<Verdict>()

/**
 * 1.1.3 (T7 F1): where a call that carries an outward category sends. What the consent lets out (`consentOutward`) when it
 * names it; otherwise the place read from the call's own words, a project script's steps included: a fetch's host, the
 * hosts a request tool connects to (`requestHosts`), and the remote a push names. Labels are `host[:port]` or a remote
 * name, so no account name, path or query is kept. undefined: nothing names a place (the report then reads the call).
 */
export function destinationsOf(input: Input): string[] | undefined {
  const opened = consentOutward(input)
  if (opened) return opened
  if (input.permission === "webfetch") {
    const url = typeof input.metadata.url === "string" ? OutwardConsent.urlOf(input.metadata.url) : undefined
    return url ? [OutwardConsent.label(url)] : undefined
  }
  if (input.permission !== "bash") return undefined
  const found: string[] = []
  for (const step of BypassScreen.readSteps(input) ?? []) {
    const scripts = step.cwds.flatMap((cwd) => BypassScreen.scriptSteps(step.argv, cwd, input.instance))
    for (const each of [step, ...scripts]) {
      const argv = DeletionWords.program(each.argv)
      const name = path.basename(argv[0] ?? "")
      if (name === "git") {
        const remote = OutwardConsent.pushWords(argv)
        if (remote) found.push(remote)
      } else if (OutwardConsent.REQUEST_TOOLS.has(name)) found.push(...requestHosts(name, argv.slice(1)))
    }
  }
  return found.length > 0 ? [...new Set(found)] : undefined
}

/**
 * 1.1.3 (T7 F1): the hosts a request tool's step connects to. Every word that reads as a URL is a candidate; the tool's
 * own reader (`OutwardConsent.request`) is then asked with those candidates named, so it picks the words it really takes
 * as URLs (not an output file or a header). When it holds the step for another reason (an upload, a word it cannot read),
 * the words with a scheme stand, or else the candidates that are no `name=value` or `user@file` item.
 */
function requestHosts(name: string, args: readonly string[]): string[] {
  const candidates = args.flatMap((word) => {
    // httpie and xh read a bare `:port` as localhost.
    const url = OutwardConsent.urlOf(/^:\d+(\/|$)/.test(word) ? `localhost${word}` : word)
    return url && (word.includes("://") || /[.:]/.test(url.host) || url.hostname === "localhost") ? [{ word, url }] : []
  })
  const known: OutwardConsent.Known = {
    allowed: [],
    named: candidates.map((item) => ({ kind: "host" as const, host: item.url.hostname })),
  }
  // The whole text's `<` is about holding the call, not about where it goes, so it is not passed here.
  const read = OutwardConsent.request(name, args, known, "")
  if (read && !("held" in read)) return read.destinations
  const schemed = candidates.filter((item) => item.word.includes("://"))
  const chosen = schemed.length > 0 ? schemed : candidates.filter((item) => !/[@=]/.test(item.word))
  return chosen.map((item) => OutwardConsent.label(item.url))
}

/**
 * 1.1.3 (T1, T3, T5, T7): under consent nothing waits for a person. Every consented verdict ends as a run or as an answer
 * the agent gets at once; a destructive call is redirected to the archive method. First match wins:
 * 1. B, or X other than `outside_write`: unchanged.
 * 1a. (T7 F4) A call that stops Swarm's own app or server (`stopsSwarm`): refused at once as X `process_not_own`, whose
 *     consented text ends with `CONSENT_CONTINUE_SUFFIX`; stopping Swarm would stop this run.
 * 1b. (T7 F3, T8) A shell call that replaces an existing file no Undo snapshot covers (`overwritesWithoutUndo`): refused at once as
 *     X `not_reversible` (`ARCHIVE_FIRST_TEXT`), whatever its class was, so it never runs silently and never waits.
 * 1c. A: unchanged, except that a send the overlay opened with no destination gets the one `destinationsOf` reads (T7 F1).
 * 2. X `outside_write`: runs, recorded as `outside_write_held` (the gate believes it: not a never-opened X).
 * 3. A script flagged `sudo` is refused as `admin_rights`; one flagged `delete` as `delete_compound`.
 * 4. `not_reversible`, or a shell call that deletes or replaces (`destroys`): refused as `not_reversible`.
 * 5. Any other D or P: the main agent's decision, run, with where it sends to (`destinationsOf`) when it carries an outward
 *    category, a host nobody named included (T7 F1).
 */
export function noWait(input: Input, verdict: Verdict): Verdict {
  if (verdict.class === "B" || (verdict.class === "X" && verdict.category !== "outside_write")) return verdict
  // 1.2.6 row 37b (U6): a call the shell checkpoints first replaces nothing for good, so rule 1b does not apply to it.
  if (verdict.class === "A" && verdict.category === "checkpointed") return verdict
  // The refusals below keep the category the call would have waited on (`bypassed`), so its line says what it was. For a
  // call that ran in 1.1.2 (class A), the reason it is refused now.
  const category = verdict.category
  const waited = verdict.class === "X" ? "outside_write_held" : (category ?? "not_routine")
  if (stopsSwarm(input))
    return { ...refused("process_not_own"), bypassed: verdict.class === "A" ? "process_not_own" : waited }
  if (overwritesWithoutUndo(input))
    return { ...refused("not_reversible"), bypassed: verdict.class === "A" ? "no_undo" : waited }
  // 1.1.3 (T9 G1-G5): what a call runs inside a shell text or a project script, a cloud deletion, discarded git work and
  // the person's configuration: redirected at once. A call that ran in 1.1.0 (class A the overlay did not open) is not
  // judged here, so an archived `rm` keeps running.
  if (verdict.class !== "A" || verdict.bypassed !== undefined) {
    const redirect = consentRedirect(input)
    if (redirect) return { ...refused(redirect), bypassed: verdict.class === "A" ? verdict.bypassed : waited }
  }
  if (verdict.class === "A") {
    // T7 F1: a send the overlay opened (rule 10) with no place it found names the host from the call's words as well.
    if (verdict.destination || verdict.bypassed === undefined || !OUTWARD_HELD.has(verdict.bypassed)) return verdict
    const destinations = destinationsOf(input)
    return destinations ? { ...verdict, destination: destinations.join(", ") } : verdict
  }
  if (verdict.class === "X") return openedByNoWait({ class: "A", decidedBy: "agent", category: "by_main_agent", bypassed: "outside_write_held" })
  const bypassed = waited
  if (category === "script_flagged") {
    const flags = verdict.screen?.flags ?? []
    if (flags.includes("sudo")) return { ...refused("admin_rights"), bypassed }
    if (flags.includes("delete")) return { ...refused("delete_compound"), bypassed }
  }
  if (category === "not_reversible" || (destroys(input) && !shellRunsScreenedScript(input, category)))
    return { ...refused("not_reversible"), bypassed }
  const destinations = category !== undefined && OUTWARD_HELD.has(category) ? destinationsOf(input) : undefined
  return openedByNoWait({
    class: "A",
    decidedBy: "agent",
    category: "by_main_agent",
    bypassed,
    ...(destinations && { destination: destinations.join(", ") }),
  })
}

/** 1.1.3 (T7 F2): marks a verdict `noWait` opened (`OPENED_BY_NO_WAIT`). */
export function openedByNoWait(verdict: Verdict) {
  OPENED_BY_NO_WAIT.add(verdict)
  return verdict
}
