// Part of the autonomy table (R-1, 1.2.8): Reads and copies outside the project, app-state folders, path spelling, and `classifyOutside`.
// Moved unchanged from `autonomy-table.ts`, which re-exports the public names; import from there, not from here.
import fs from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { BypassLists } from "../bypass-lists"
import { PathSpelling } from "../path-spelling"
import { ScriptReader } from "../script-reader"
import type { InstanceContext } from "../../project/instance-context"
import { LibraryRoot } from "../../skill/library-root"
import { Reach } from "../../tool/reach"
import { Risk } from "../../tool/risk"
import { Secrets } from "../../tool/secrets"
import { READS, READ_SHELL_ROLES, onlyLooks, readClass, readKind, unwrapped } from "./read-class"
import { OUTPUT_TAIL, WORD_BREAK } from "./routine"
import { held, refused, type Input, type Verdict } from "./types"
import { FOLDER_MOVES, OUTSIDE_EDIT, PROTECTED_READ, classifyConsented, editTargets, protectedLook, shellReading } from "./shell-steps"
import { shellSegments } from "./own-api"
import { classifySend } from "./outward"
/** The words of one plain command, with `~` read the way the shell reads it. */
export function homeWords(command: string) {
  const home = homedir()
  return Risk.plainWords(unwrapped(command).replace(/(^| )~(?=\/| |$)/g, (_match, space: string) => space + home))
}

/** Whether a plain read names a path beyond the folder. */
export function readsOutside(command: string, cwd: string, instance: InstanceContext) {
  const words = homeWords(command.replace(OUTPUT_TAIL, ""))
  return words !== undefined && readKind(words, cwd, instance) === "outside"
}

// The looks that may name a place beyond the folder (U11 rule 1). Each reads only what the command names: `find`, `tree` and
// `rg` walk into folders, and `rg` searches a hidden file once an ignore file there lists it, so they stay inside.
const OUTSIDE_READS = new Set(["ls", "cat", "head", "tail", "wc", "stat", "file", "pwd", "grep"])

/**
 * What one command that reaches beyond the folder does there, when it only reads: "outside_read" for a look, and
 * "outside_copy" for `cp <file> <new path in the folder>`, which is how an outside file gets changed without touching it.
 * Everything it names must be what the read tool would show without asking, so a secret never gets here.
 */
export function outsideKind(command: string, cwd: string, instance: InstanceContext): "outside_read" | "outside_copy" | undefined {
  const words = homeWords(command.replace(OUTPUT_TAIL, ""))
  if (!words || !path.isAbsolute(cwd) || !Reach.readable(cwd)) return undefined
  if (nearLibrary([cwd, ...words.slice(1).map((word) => path.resolve(cwd, word))])) return undefined
  if (words[0] === "cp") return copiesIn(words, cwd, instance) ? "outside_copy" : undefined
  if (!OUTSIDE_READS.has(words[0]!) || !onlyLooks(words)) return undefined
  return words
    .slice(1)
    .filter((word) => !word.startsWith("-"))
    .every((word) => Reach.readable(path.resolve(cwd, word)))
    ? "outside_read"
    : undefined
}

/**
 * The bundled library copy, or a folder above it. Its text reaches the agent through the read tool, marked as library text,
 * and the shell or a write has no business there (XF-03), so rule 1 does not open it: it stays as it was before U11.
 */
export function nearLibrary(files: readonly string[]) {
  const status = LibraryRoot.current()
  if (status.kind !== "available") return false
  return files.some((file) => [file, Reach.real(file)].some((place) => place !== undefined && (within(status.root, place) || within(place, status.root))))
}

/** One readable regular file from beyond the folder, to a name in it that nothing has yet. The original is only read. */
function copiesIn(words: readonly string[], cwd: string, instance: InstanceContext) {
  const args = words.slice(1)
  const names = args.filter((word) => !word.startsWith("-"))
  if (names.length !== 2 || args.some((word) => word.startsWith("-") && word !== "-p")) return false
  if (names[1]!.split("/").includes("..")) return false
  const source = path.resolve(cwd, names[0]!)
  const target = path.resolve(cwd, names[1]!)
  const from = Reach.real(source)
  if (from === undefined || Reach.inside(source, instance) || !Reach.readable(source)) return false
  if (fs.statSync(from, { throwIfNoEntry: false })?.isFile() !== true) return false
  // A new name only: a copy over a file, or into a folder under the same name, would be a write the person never saw.
  if (fs.lstatSync(target, { throwIfNoEntry: false })) return false
  if (!Reach.inside(target, instance) || Reach.sensitive(target, instance) || Reach.secret(target)) return false
  const into = Reach.real(path.dirname(target))
  if (into === undefined || fs.statSync(into, { throwIfNoEntry: false })?.isDirectory() !== true) return false
  // Without Git the worktree is `/`, and every name would be judged from the top of the disk.
  const base = instance.worktree === "/" ? instance.directory : instance.worktree
  return Risk.ordinaryEdit(path.relative(base, target)) && Risk.ordinaryEdit(path.relative(Reach.real(base) ?? base, path.join(into, path.basename(target))))
}

export const within = (root: string, file: string) => {
  const relative = path.relative(root, file)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function appStateRoots() {
  // The desktop app puts state at `XDG_STATE_HOME ?? userData`, so that spelling is compared as well as the one inside it.
  const roots = [
    Global.Path.state,
    Global.Path.config,
    Global.Path.data,
    process.env.XDG_STATE_HOME,
    process.env.OPENCODE_CONFIG_DIR,
    process.env.SWARM_CONFIG_DIR,
  ].filter((root): root is string => !!root)
  return [...new Set(roots.flatMap((root) => [root, Reach.real(root) ?? root]))]
}

// Sessions run in checkouts the app keeps under its data folder. Those are projects, and what the rest of that folder is not.
function ownCheckout(file: string, instance: InstanceContext) {
  const homes = [path.join(Global.Path.data, "worktree"), Global.Path.repos].flatMap((root) => [root, Reach.real(root) ?? root])
  return homes.some((root) => within(root, file)) && Reach.inside(file, instance)
}

export function inAppState(file: string, instance: InstanceContext) {
  const target = Reach.real(file)
  // Where a write would land could not be worked out. Assume the worst of it.
  if (target === undefined) return true
  if (ownCheckout(target, instance)) return false
  return appStateRoots().some((root) => within(root, file) || within(root, target))
}

function mentionsAppState(command: string, instance: InstanceContext) {
  const spelled = ownCheckout(instance.worktree, instance) ? command.replaceAll(instance.worktree, "") : command
  if (spelled.includes("trust.json") || appStateRoots().some((root) => spelled.includes(root))) return true
  // 1.2.6 FX-14 (F-1, F-2): `~/…`, `$HOME/…` and `${HOME}/…` name the same places as the absolute spelling, so they are
  // judged as it is (C8). Each such word is read as the shell would, under each home a place may be spelled in.
  return homeSpelled(command).some((file) => inAppStateSpelled(file, instance))
}

// Breaks a command into words the way a path ends: blanks, redirects, pipes, separators, `=` of an option or assignment.
const PATH_BREAK = /[\s<>|;&()`=,]+/
const HOME_WORD = PathSpelling.HOME_SPELLING

/** The places a command names with a home spelling (`~`, `$HOME`, `${HOME}`), resolved under every home Swarm knows. */
function homeSpelled(command: string) {
  const words = command.replace(/['"]/g, "").split(PATH_BREAK)
  return words.flatMap((word) => {
    const match = HOME_WORD.exec(word)
    if (!match) return []
    const rest = word.slice(match[0].length)
    return homes().map((home) => path.resolve(home, `.${rest}`))
  })
}

/** `inAppState` for a place spelled by hand: one that cannot be resolved is judged by its spelling. */
function inAppStateSpelled(file: string, instance: InstanceContext) {
  const target = Reach.real(file) ?? file
  if (ownCheckout(target, instance)) return false
  return appStateRoots().some((root) => within(root, file) || within(root, target))
}

export const CHECKSUMS = new Set(["shasum", "sha256sum", "sha1sum", "md5", "md5sum", "cksum"])

// SR OP-2: inside an app-state root only these look, and only at literal names. `cat`/`head`/`tail` output is masked
// (U16); every other program there is X `app_state`, so no count, offset or byte dump of a password file comes back.
const APP_STATE_LOOKS = new Set(["ls", "stat", "du", "wc", "file", "tree", "find", ...CHECKSUMS, "mdls", "cat", "head", "tail"])
// SR OP-2: on a folder that holds app state (home, `~/.local`, `~/.config`), content search is refused.
const CONTENT_SEARCH = new Set(["rg", "grep", "egrep"])
const NOT_LITERAL = /[*?[{$]/
const BYTES_FLAG = (word: string) => /^-[A-Za-z0-9]*c/.test(word) || Risk.abbreviates(word, ["--bytes"])

/** Where a place lies against Swarm's own state: inside a root, above one (a folder that holds it), or neither. */
function stateRelation(file: string, instance: InstanceContext): "inside" | "above" | undefined {
  const target = Reach.real(file) ?? file
  if (ownCheckout(target, instance)) return undefined
  const roots = appStateRoots()
  if (roots.some((root) => within(root, file) || within(root, target))) return "inside"
  if (roots.some((root) => within(file, root) || within(target, root))) return "above"
  return undefined
}

/** One glob segment as a pattern; like the shell, `*` and `?` do not match a leading dot. */
function segmentMatches(pattern: string, name: string) {
  if (name.startsWith(".") && !pattern.startsWith(".")) return false
  const source = pattern.replace(/[.+^${}()|\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")
  try {
    return new RegExp(`^${source}$`).test(name)
  } catch {
    return true
  }
}

/** Whether a glob could match a place inside an app-state root (1.2.6 residual R-1: a glob names no root by its spelling). */
function globReachesState(file: string) {
  const parts = file.split(path.sep)
  return appStateRoots().some((root) => {
    const rootParts = root.split(path.sep)
    return parts.length >= rootParts.length && rootParts.every((part, index) => segmentMatches(parts[index]!, part))
  })
}

const SPELLED_BREAK = /[\s<>|;&()`=,]+/

/** 1.2.7 47f (C68): the word resolver this reader uses, the same object the shell's output masking uses. */
export const spelling = PathSpelling

/**
 * SR7-01: the places a command's words name, as the shell would resolve them: relative to its folder and to every `cd` in
 * it, with `~`, `$HOME`, `${HOME}` (under every home Swarm knows) and set environment variables expanded. Over-reads on
 * purpose: a word that is not a path resolves to a name nobody has.
 */
function spelledPlaces(command: string, cwd: string) {
  const words = command.replace(/['"\\]/g, "").split(SPELLED_BREAK).filter(Boolean)
  const expand = (word: string): string[] => spelling.expand(word, homes()).names
  let dirs = [cwd]
  const places: { file: string; glob: boolean }[] = []
  for (const [index, word] of words.entries()) {
    const resolved = expand(word).flatMap((spelling) => dirs.map((dir) => path.resolve(dir, spelling)))
    places.push(...resolved.map((file) => ({ file, glob: /[*?[]/.test(word) })))
    // 1.2.8 R-2: after any folder change (`FOLDER_MOVES`), over-read as after `cd`.
    if (FOLDER_MOVES.has(words[index - 1] ?? "")) dirs = spelling.widen(dirs, resolved).folders
  }
  const programs = new Set(words.map((word) => path.basename(word)))
  return { places, dirs, search: [...CONTENT_SEARCH].some((name) => programs.has(name)), rg: programs.has("rg") }
}

/** SR7-01: whether a command reaches into Swarm's own state by any spelling, or searches the contents of a folder above it. */
export function touchesAppState(command: string, cwd: string, instance: InstanceContext) {
  if (mentionsAppState(command, instance)) return true
  const spelled = spelledPlaces(command, cwd)
  // `rg` with no path searches where it runs, so its folder counts as a place it names.
  const places = [...spelled.places, ...(spelled.rg ? spelled.dirs.map((file) => ({ file, glob: false })) : [])]
  return places.some(({ file, glob }) => {
    if (glob) return globReachesState(file)
    const relation = stateRelation(file, instance)
    return relation === "inside" || (relation === "above" && spelled.search)
  })
}

/** 1.2.7 row 47j (U9-6): the programs a consented search over state folders may be made of (no writer, no other reader). */
const STATE_SEARCH_STEPS: ReadonlySet<string> = new Set([...CONTENT_SEARCH, "head", "tail", "wc"])

/** An existing folder; anything that cannot be read is none (fails closed, unlike `isFolder`). */
const existingFolder = (file: string) => {
  try {
    return fs.statSync(file).isDirectory()
  } catch {
    return false
  }
}

/**
 * 1.2.7 row 47j (U9-6, C76): the app-state folders a content search (`rg`, `grep`, `egrep`) reaches through the folders it names, when
 * that is the only way the command reaches app state: a content search runs, and every place the command names in or
 * above an app-state root (after `cd`, `~`, `$HOME`, real path: `spelledPlaces`, which over-reads on purpose) is an
 * existing folder, never a file or a glob. A pattern word or a write resolved inside a root names a file there and fails
 * it. Returned: each app-state root below a named folder, or the named folder itself when it lies inside a root. Empty: no
 * such search. The shell masks what such a search prints (`tool/shell.ts` learns the values of the files in these).
 */
export function searchedStateFolders(command: string, cwd: string, instance: InstanceContext): string[] {
  const spelled = spelledPlaces(command, cwd)
  if (!spelled.search) return []
  const places = [...spelled.places, ...(spelled.rg ? spelled.dirs.map((file) => ({ file, glob: false })) : [])]
  const folders: string[] = []
  for (const { file, glob } of places) {
    if (glob) {
      if (globReachesState(file)) return []
      continue
    }
    const relation = stateRelation(file, instance)
    if (relation === undefined) continue
    if (!existingFolder(file)) return []
    // What the search can reach of app state: the folder itself inside a root, or each root below the folder.
    const target = Reach.real(file) ?? file
    if (relation === "inside") folders.push(file)
    else folders.push(...appStateRoots().filter((root) => within(file, root) || within(target, root)))
  }
  return [...new Set(folders)]
}

/**
 * 1.2.7 row 47j (U9-6, C76; supersedes SR7-01's refusal of a content search on a folder that holds app state under
 * consent, as the person ruled): under the consent, for the main agent and its subagents but never a read role (U4 keeps
 * its limit), a call that is only a content search over folders holding Swarm's state is no change there: it is judged
 * as any other look of the consented caller, and its output is masked. The call must be read in full by the shell's own
 * reader, every step one of `STATE_SEARCH_STEPS`, nothing written into app state. Searches of a state FILE, oracles on a
 * named file, globs and every write stay X `app_state`.
 */
export function consentedStateSearch(input: Input, command: string) {
  if (!input.bypass || input.permission !== "bash") return false
  if (input.agent !== undefined && READ_SHELL_ROLES.has(input.agent)) return false
  const reading = shellReading(input.metadata.steps, input.instance) ?? shellReading(ScriptReader.read(command, input.cwd), input.instance)
  // A step of a compound (`classifySteps`) comes without the shell's reading: its text is rebuilt from the step's words,
  // so one command with plain or whole-word-quoted words (no operator, redirect or expansion) is read as itself.
  const literal = reading ? undefined : Risk.quotedWords(command)
  const steps = reading ? reading.steps : literal ? [{ argv: literal }] : []
  if ((reading && !reading.complete) || steps.length === 0) return false
  if (reading?.writes.some((file) => inAppState(file, input.instance))) return false
  const only = steps.every((step) => !("code" in step && step.code !== undefined) && STATE_SEARCH_STEPS.has(path.basename(step.argv[0]!)))
  return only && searchedStateFolders(command, input.cwd, input.instance).length > 0
}

/**
 * SR OP-2 (N-1): whether a command that reaches Swarm's own state only looks there in a way the allowlist takes: it is in
 * the read class, every operand inside an app-state root (after `cd`, relative, `~` and real path) is a literal name read by
 * `APP_STATE_LOOKS` (`head`/`tail` without `-c`), and no content search runs on a folder that holds app state.
 */
export function appStateRead(command: string, cwd: string, instance: InstanceContext) {
  const pieces = readClass(command, cwd, instance)
  if (!pieces) return false
  return pieces.every(({ words, here, paths }) => {
    const program = words[0]!
    // A look with no name looks where it runs; `rg` also searches there when given only a pattern.
    const operands = paths.length > 0 ? (program === "rg" ? [...paths, "."] : paths) : ["."]
    return operands.every((word) => {
      const relation = stateRelation(path.resolve(here, word), instance)
      if (relation === "above") return !CONTENT_SEARCH.has(program)
      if (relation !== "inside") return true
      if (!APP_STATE_LOOKS.has(program) || NOT_LITERAL.test(word)) return false
      return !((program === "head" || program === "tail") && words.slice(1).some(BYTES_FLAG))
    })
  })
}

/** N-1: a shell call (or its folder prompt) that reaches Swarm's own state and only looks there as OP-2 allows. */
/** 1.2.7 row 47k (U9-7): programs that only write the places they name; none prints what a place holds. */
const STATE_WRITERS: ReadonlySet<string> = new Set(["printf", "echo", "print", "touch", "mkdir", "rmdir", "rm", "cp", "mv", "ln", "install", "truncate", "tee", "true", ":"])
/** Of those, the ones whose words are text, not places. */
const TEXT_WRITERS: ReadonlySet<string> = new Set(["printf", "echo", "print", "true", ":"])

/**
 * 1.2.7 row 47k (U9-7, C76, user ruling U9 item 7): an autonomous shell call outside the consent that reaches Swarm's
 * state only through a glob, a link or a variable (no spelling `mentionsAppState` knows) and only writes there: every
 * simple command is a `cd` or one of `STATE_WRITERS`, no input redirect or command substitution, and no operand a copy
 * or move reads from (all but the last of `cp`, `ln`, `install`, `mv`) lies in or may glob into app state. Such a call is
 * held for the person as in 1.2.6 (R-1); everything else that `writesAppState` finds stays X `app_state` (SR7-01).
 */
export function indirectStateWrite(input: Input) {
  const command = input.metadata.command
  if (input.bypass || input.permission !== "bash" || typeof command !== "string") return false
  if (mentionsAppState(command, input.instance) || /[<`]|\$\(/.test(command)) return false
  let dirs = [input.cwd]
  const places = (word: string) => spelling.expand(word, homes()).names.flatMap((name) => dirs.map((dir) => path.resolve(dir, name)))
  return shellSegments(command).every((words) => {
    const program = path.basename(words[0]!)
    if (program === "cd") {
      if (words[1] !== undefined) dirs = spelling.widen(dirs, places(words[1])).folders
      return true
    }
    if (!STATE_WRITERS.has(program)) return false
    if (TEXT_WRITERS.has(program)) return true
    const operands = words.slice(1).filter((word) => !word.startsWith("-"))
    const read = ["cp", "ln", "install", "mv"].includes(program) ? operands.slice(0, -1) : []
    return !read.some((word) =>
      places(word).some((file) => (/[*?[]/.test(word) ? globReachesState(file) : stateRelation(file, input.instance) === "inside")),
    )
  })
}

export function readsAppState(input: Input) {
  const command = input.metadata.command
  if (typeof command !== "string" || (input.permission !== "bash" && input.permission !== "external_directory")) return false
  return touchesAppState(command, input.cwd, input.instance) && appStateRead(command, input.cwd, input.instance)
}

/** The home folders a protected place may be spelled under (47f: the shared resolver's list). */
export function homes() {
  return PathSpelling.homes()
}

/** The protected roots for a read or a write, each also by its real path (`/etc` is `/private/etc` on macOS). */
function protectedRoots(mode: "read" | "write") {
  const secrets = [
    ...homes().flatMap((home) => BypassLists.PROTECTED_HOME.map((place) => path.join(home, place))),
    ...BypassLists.PROTECTED_APP_FILES.map((file) => path.join(Global.Path.data, file)),
  ]
  const system = mode === "write" ? [...BypassLists.PROTECTED_SYSTEM, ...appBundle()] : []
  return [...new Set([...secrets, ...system].flatMap((root) => [root, Reach.real(root) ?? root]))]
}

/**
 * The installed app this server runs from: the `.app` bundle around it on macOS, or the folder above `resources` of a
 * packaged Linux or Windows install. Nothing for a server started from a checkout (`bun`).
 */
function appBundle(): string[] {
  const exec = process.execPath
  const mac = exec.match(/^(.*?\.app)(\/|$)/)
  if (mac) return [mac[1]!]
  const packaged = exec.split(path.sep).indexOf("resources")
  return packaged > 0 ? [exec.split(path.sep).slice(0, packaged).join(path.sep) || path.sep] : []
}

/**
 * Row 202: whether a file tool's target outside the project is a place autonomous mode never opens: a secret place or
 * Swarm's credential files for any use, and the system's folders or the app itself for a write. Judged by the path as
 * given and by where it really lands, so a link out of `~/Documents` into `~/.ssh` is the place it leads to.
 */
export function protectedOutside(file: string, mode: "read" | "write") {
  const places = [path.normalize(file), Reach.real(file)].filter((place) => place !== undefined)
  // A place that cannot be worked out (a link loop) is the worst case.
  if (places.length < 2) return true
  const roots = protectedRoots(mode)
  return places.some((place) => roots.some((root) => within(root, place)))
}

/**
 * Row 202: the edit of files that all lie outside the project, with the mode on. Class A (`outside_edit`) when none is a
 * protected place, a secret, a file that changes later runs, or the bundled library; a protected place is refused. Any
 * other case is left to the rules after this (undefined), so nothing inside the project is judged differently.
 */
export function classifyOutsideEdit(input: Input): Verdict | undefined {
  if (input.permission !== "edit") return undefined
  // Only the write and edit tools' own prompt, which names the file by its absolute path beside the pattern. A prompt
  // that names its files only by patterns (a whole patch) keeps the rules after this.
  if (typeof input.metadata.filepath !== "string" || !path.isAbsolute(input.metadata.filepath)) return undefined
  const targets = editTargets(input)
  if (targets.length === 0 || targets.some((file) => Reach.inside(file, input.instance))) return undefined
  if (targets.some((file) => protectedOutside(file, "write"))) return refused("protected_path")
  if (nearLibrary(targets)) return undefined
  if (input.editClass === "secret" || input.editClass === "sensitive") return undefined
  if (targets.some((file) => Reach.secret(file) || !Reach.readable(file) || Reach.sensitive(file, input.instance))) return undefined
  return OUTSIDE_EDIT
}

/**
 * U11 rule 1, for the prompt a tool raises before it reaches beyond the folder. A read is class A when what it names is
 * readable, a copy into the folder too, and a write is refused with nobody asked. A secret stays a person's call.
 */
export function classifyOutside(input: Input): Verdict {
  const command = input.metadata.command
  if (typeof command === "string") {
    if (command.split(WORD_BREAK).some((word) => word && Secrets.secretFile(word)))
      return protectedLook(command, input.cwd, input.instance) ? PROTECTED_READ : held("secret_file")
    // The prompt for a drive the person named and ticked (G2): what the bash prompt beside it gets, so both agree.
    const send = classifySend(command, input)
    if (send?.class === "A") return send
    const outside = outsideKind(command, input.cwd, input.instance)
    if (outside) return { class: "A", decidedBy: "gate", category: outside }
    const words = homeWords(command.replace(OUTPUT_TAIL, ""))
    if (words && nearLibrary([input.cwd, ...words.slice(1).map((word) => path.resolve(input.cwd, word))])) return held("outside_folder")
    // 1.2.6 (U12): a proven look runs wherever it looks, a secret or protected place included.
    if (protectedLook(command, input.cwd, input.instance)) return PROTECTED_READ
    // What does not parse, and a look this table cannot vouch for such as a walk, wait for a person. Any other plain command
    // that reaches out may change what is there, so it is refused with nobody asked.
    if (!words || READS.has(words[0]!)) return held("outside_folder")
    if (words.slice(1).some((word) => !word.startsWith("-") && !Reach.readable(path.resolve(input.cwd, word)))) return held("secret_file")
    return refused("outside_write")
  }
  const filepath = input.metadata.filepath
  if (typeof filepath !== "string" || !path.isAbsolute(filepath) || nearLibrary([filepath])) return held("outside_folder")
  const writes = input.follows?.some((prompt) => prompt.permission === "edit") === true
  // 1.2.6 (U12, R3/R5): a file tool that only reads (`readOnly`) may read a secret or protected place, and search hidden
  // files, with nobody asked. What it shows the agent stays masked (U16). A prompt that does not prove a read keeps the rules below.
  if (
    !writes &&
    input.metadata.readOnly === true &&
    (protectedOutside(filepath, "read") || !Reach.readable(filepath) || input.metadata.hidden === true)
  )
    return PROTECTED_READ
  // Row 202: a secret or system place is never written, with the person's consent to the bypass or without it.
  if (protectedOutside(filepath, writes ? "write" : "read")) return refused("protected_path")
  const looks = input.metadata.readOnly === true && input.metadata.hidden !== true
  if (!Reach.readable(filepath) && looks) return classifyConsented(input, [filepath], "secret_file")
  if (!Reach.readable(filepath) || (writes && Reach.secret(filepath))) return held("secret_file")
  // Row 202 (2026-11-09): the person turned the mode on and with it agreed that a file tool may write outside the project.
  // The edit that follows is judged on its own (`classifyOutsideEdit`). A file that changes later runs (a shell's rc file,
  // a manifest, a tool's config) is refused as before, so the folder prompt and its edit agree.
  if (writes) return Reach.sensitive(filepath, input.instance) ? refused("outside_write") : OUTSIDE_EDIT
  if (input.metadata.readOnly !== true) return held("outside_folder")
  // A search that opens every file under a folder, hidden ones too, would show a `.zshrc` or a token file no name marks.
  if (input.metadata.hidden === true) return held("outside_folder")
  return { class: "A", decidedBy: "gate", category: "outside_read" }
}
