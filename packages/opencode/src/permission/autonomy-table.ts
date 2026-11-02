// What autonomous mode does with a request nobody is there to answer. This decides on what the request says and on bytes,
// and no model is involved: only class P ever reaches one, and a model's answer cannot raise a request into P. It is an
// allow list because a list of what to refuse let through every way of spelling `git push` that was tried.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import { devNull, homedir } from "node:os"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { needsPerson } from "@opencode-ai/core/permission/needs-person"
import type { ProjectTrust } from "@opencode-ai/core/project/trust"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { LibraryRoot } from "../skill/library-root"
import { GitGuard } from "../tool/git-guard"
import { Reach } from "../tool/reach"
import { Risk } from "../tool/risk"
import { Secrets } from "../tool/secrets"
import { findProgram } from "../util/find-program"

export type Class = "A" | "P" | "D" | "B" | "X"
export type CheckClass = Extract<Class, "P" | "D">

/**
 * A test or a build runs with all of the user's rights, and a decider only ever sees `bun test`. The user accepted that
 * for this mode. "D" holds every check for a person instead. This is a constant on purpose, and no setting reaches it.
 */
export const CHECK_CLASS: CheckClass = "P"

export type RoutineCategory = "check" | "file-op" | "git-local"
/** What `routine` finds a command to be. "read" only looks at the folder, and is class A. */
export type CommandKind = RoutineCategory | "read"
export type AllowedCategory = RoutineCategory | "edit-not-ordinary" | "outside_read" | "outside_copy"
export type HeldCategory =
  | "outside_folder"
  | "outside_write"
  | "outward"
  | "not_reversible"
  | "sensitive_file"
  | "secret_file"
  | "external_tool"
  | "no_undo"
  | "not_routine"
  | "queue_full"
  | "decider_unavailable"
  | "folder_not_trusted"
  | "plan_mode"
  | "app_state"
  | "asks_every_time"

/** What the edit tools learned from `Reach.editTrust`. Absent means nobody said, and that is held. */
export type EditClass = "ordinary" | "not_ordinary" | "no_undo" | "sensitive" | "secret"

export type Verdict = {
  class: Class
  /** The name of who settled it. "agent" is filled in with the model by whoever calls it. Absent when it is not recorded. */
  decidedBy?: "gate" | "agent" | "person"
  category?: AllowedCategory | HeldCategory
}

export type Input = {
  permission: string
  patterns: readonly string[]
  metadata: Readonly<Record<string, unknown>>
  instance: InstanceContext
  /** Where a command would really run. Its relative paths mean nothing without this. */
  cwd: string
  canUndo: boolean
  /** Undefined when it could not be read, which is treated as not trusted. */
  folder: ProjectTrust.Status["state"] | undefined
  harmless?: boolean
  editClass?: EditClass
  /** The root session's last person's message used the plan agent, for this request and all of its descendants. */
  plan?: boolean
  /** "user_catch_all" is `"*": "ask"` written by a person, who asked to be asked every time. */
  rule?: "deny" | "user_catch_all"
  /** Prompts answered together with this one. An `external_directory` for an edit says so here. */
  follows?: readonly { permission: string }[]
}

/** Not a prompt today. A folder's trust is a person's answer through its own endpoint, so nothing may answer it from here. */
export const TRUST_PERMISSION = "project_trust"

const held = (category: HeldCategory): Verdict => ({ class: "D", decidedBy: "gate", category })
const refused = (category: HeldCategory): Verdict => ({ class: "X", decidedBy: "gate", category })
const QUIET: Verdict = { class: "A" }

const CHECK_NAMES = new Set(["test", "build", "typecheck", "lint", "check"])
const QUIET_FLAGS = ["-q", "-x", "-v"]

// Each row is the whole of what is accepted. `--preload`, `npm test -- x`, `pytest -p`, `go test -exec`, `make -f` and `VAR=`
// all name code an attacker chose, and they fall off the end of this list with nothing having to recognise them.
const CHECKS: readonly {
  prefix: readonly string[]
  exact?: boolean
  names?: ReadonlySet<string>
  flags?: readonly string[]
  paths?: boolean
}[] = [
  { prefix: ["bun", "test"], flags: ["--bail", "--only"], paths: true },
  { prefix: ["bun", "run"], names: CHECK_NAMES },
  { prefix: ["bun"], names: new Set(["typecheck", "lint"]) },
  { prefix: ["npm", "test"], exact: true },
  { prefix: ["npm", "run"], names: CHECK_NAMES },
  { prefix: ["pnpm", "test"], exact: true },
  { prefix: ["pnpm", "run"], names: CHECK_NAMES },
  { prefix: ["yarn", "test"], exact: true },
  { prefix: ["yarn", "run"], names: CHECK_NAMES },
  { prefix: ["tsc", "--noEmit"], exact: true },
  { prefix: ["cargo"], names: new Set(["test", "build", "check", "clippy"]) },
  { prefix: ["go", "test"], paths: true },
  { prefix: ["go", "build"], paths: true },
  { prefix: ["go", "vet"], paths: true },
  { prefix: ["pytest"], flags: QUIET_FLAGS, paths: true },
  { prefix: ["python", "-m", "pytest"], flags: QUIET_FLAGS, paths: true },
  { prefix: ["python3", "-m", "pytest"], flags: QUIET_FLAGS, paths: true },
  { prefix: ["make"], names: CHECK_NAMES },
  { prefix: ["ruff", "check"], paths: true },
  { prefix: ["mvn", "test"], exact: true },
]

// A frozen install fetches what the repository already committed to. Anything else about the lockfile is a person's call.
const INSTALLS = new Map<string, readonly string[]>([
  ["bun install --frozen-lockfile", ["bun.lock", "bun.lockb"]],
  ["npm ci --ignore-scripts", ["package-lock.json", "npm-shrinkwrap.json"]],
  ["pnpm install --frozen-lockfile --ignore-scripts", ["pnpm-lock.yaml"]],
])

const COMMIT = /^git commit -m "[A-Za-z0-9 _.,:;()/#@%+=-]*"$/
const BRANCH = /^git (switch -c|checkout -b) [A-Za-z0-9][A-Za-z0-9._/-]*$/
const FILE_OPS = new Set(["mkdir", "touch", "rm", "mv", "cp"])
const FILE_FLAGS = new Set(["-p", "-r", "-f", "-rf", "-fr"])
// What a check's output may be cut down with. Nothing else after a pipe, and nothing after this.
const OUTPUT_TAIL = /( 2>&1)?( \| (?:tail|head) -(?:n ?)?\d+)?$/
const WORD_BREAK = /[\s'"`|;&<>()=,:@$]+/

/** Relative, stays in the project once links are followed, and names nothing that outlives the session or holds a secret. */
function safePath(word: string, cwd: string, instance: InstanceContext) {
  if (word.startsWith("/") || word.startsWith("~") || word.startsWith("-") || word.split("/").includes("..")) return false
  const file = path.resolve(cwd, word)
  return Reach.inside(file, instance) && !Reach.sensitive(file, instance) && !Reach.secret(file)
}

function fileOp(words: readonly string[], cwd: string, instance: InstanceContext) {
  const args = words.slice(1)
  const paths = args.filter((word) => !word.startsWith("-"))
  if (paths.length === 0 || args.some((word) => word.startsWith("-") && !FILE_FLAGS.has(word))) return false
  // `rm -rf .` takes `.git` with it, and then Undo has nothing to restore from.
  const roots = [cwd, instance.directory, instance.worktree].map((root) => Reach.real(root))
  return paths.every((word) => safePath(word, cwd, instance) && !roots.includes(Reach.real(path.resolve(cwd, word))))
}

function matchesCheck(words: readonly string[], cwd: string, instance: InstanceContext) {
  return CHECKS.some((row) => {
    if (row.prefix.some((word, index) => words[index] !== word)) return false
    const rest = words.slice(row.prefix.length)
    if (row.exact) return rest.length === 0
    if (row.names) return rest.length === 1 && row.names.has(rest[0]!)
    return rest.every((word) => (word.startsWith("-") ? row.flags?.includes(word) : row.paths && safePath(word, cwd, instance)))
  })
}

const outsideProject = (cwd: string, instance: InstanceContext) => !path.isAbsolute(cwd) || !Reach.inside(cwd, instance)

/**
 * The folder decides which Makefile `make` reads, which scripts `npm` runs and which repository `git` lands in and takes
 * hooks from, even for a command that names no path. So a `workdir` has to meet what `cd` has to meet, by where it really
 * is: the shell only compares its spelling with the project's.
 */
function canRunIn(cwd: string, instance: InstanceContext) {
  if (outsideProject(cwd, instance) || Reach.sensitive(cwd, instance) || Reach.secret(cwd)) return false
  // Nothing can run in a folder that is not there. Holding it also leaves no time for a link to appear under that name.
  try {
    return fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory() === true
  } catch {
    return false
  }
}

/** The guard vets the project's own `.git`. A `.git` on the way up from here belongs to a repository it never looked at. */
function gitAllowed(cwd: string, instance: InstanceContext) {
  if (GitGuard.inspect(instance.worktree).refused !== undefined) return false
  const top = Reach.real(instance.worktree)
  let folder = Reach.real(cwd)
  if (top === undefined || folder === undefined) return false
  while (folder !== top) {
    if (fs.lstatSync(path.join(folder, ".git"), { throwIfNoEntry: false })) return false
    const parent: string = path.dirname(folder)
    if (parent === folder) return false
    folder = parent
  }
  return true
}

/**
 * Whether each lockfile present here is byte for byte what HEAD holds. Comparing two hashes runs nothing the repository
 * chose, where `git diff` or `git status` could run its clean filter. Whatever cannot be established counts as changed.
 */
export function lockfileUnchanged(names: readonly string[], cwd: string, instance: InstanceContext) {
  const guarded = GitGuard.inspect(instance.worktree)
  if (guarded.gitDir === undefined) return false
  const worktree = Reach.real(instance.worktree)
  if (worktree === undefined) return false
  const present = names.map((name) => path.join(cwd, name)).filter((file) => fs.lstatSync(file, { throwIfNoEntry: false }))
  if (present.length === 0) return false
  // Not `hardenedEnv` from the git tool: importing that module would lead back to `Permission`, which calls this.
  const env = {
    PATH: (process.env.PATH ?? "")
      .split(path.delimiter)
      .filter((entry) => path.isAbsolute(entry) && !containsPath(Reach.real(entry) ?? entry, instance))
      .join(path.delimiter),
    HOME: devNull,
    XDG_CONFIG_HOME: devNull,
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_OPTIONAL_LOCKS: "0",
  }
  const binary = findProgram("git", env.PATH)
  if (!binary) return false
  const git = (...args: string[]) =>
    execFileSync(
      binary,
      [
        `--git-dir=${guarded.gitDir}`,
        `--work-tree=${instance.worktree}`,
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-c",
        `core.hooksPath=${devNull}`,
        ...args,
      ],
      { cwd: instance.worktree, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 },
    ).trim()
  try {
    return present.every((file) => {
      const target = Reach.real(file)
      if (target === undefined || !Reach.inside(file, instance) || target !== path.join(Reach.real(cwd) ?? cwd, path.basename(file)))
        return false
      const name = path.relative(worktree, target).split(path.sep).join("/")
      return git("rev-parse", "--verify", "--quiet", `HEAD:${name}`) === git("hash-object", "--no-filters", "--", name)
    })
  } catch {
    return false
  }
}

// Programs that only look. Each lists what would make it do more: run a program (`find -exec`, `rg --pre`, `rg -z`), write
// (`find -delete`, `find -fprint`, `tree -o`, `tree -R`, `file -C`), wait for good (`tail -f`), read names from a file
// (`wc --files0-from`), or reach past what the shell named (`grep -r`, `rg --hidden`, `rg -u`, `rg -L`). Every other word
// must be a path inside the folder that the read tool would show without asking.
const READS = new Map<string, { short?: string; long?: readonly string[]; exact?: readonly string[] }>([
  ["ls", {}],
  ["cat", {}],
  ["head", {}],
  ["tail", { short: "fF", long: ["--follow", "--retry"] }],
  ["wc", { long: ["--files0-from"] }],
  ["stat", {}],
  ["file", { short: "C", long: ["--compile"] }],
  ["pwd", {}],
  ["tree", { short: "oR", long: ["--output", "--fromfile"] }],
  ["rg", { short: "uLz.", long: ["--pre", "--pre-glob", "--hidden", "--no-ignore", "--follow", "--search-zip", "--unrestricted"] }],
  ["grep", { short: "rRdD", long: ["--recursive", "--dereference-recursive", "--directories", "--devices"] }],
  ["find", { exact: ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"] }],
])
const READ_FLAG = /^-[A-Za-z0-9@]+$|^--[a-z][a-z0-9-]*$/

/** Whether no flag makes this program do more than look at what the command names. */
function onlyLooks(words: readonly string[]) {
  const rules = READS.get(words[0]!)
  if (!rules) return false
  return words.slice(1).every(
    (word) =>
      !word.startsWith("-") ||
      (READ_FLAG.test(word) &&
        !rules.exact?.includes(word) &&
        !rules.long?.some((name) => word === name || word.startsWith(name + "-")) &&
        (rules.exact !== undefined || word.startsWith("--") || ![...word.slice(1)].some((flag) => rules.short?.includes(flag)))),
  )
}

/** "read", "outside" when a path it names is beyond the folder, or undefined when it is not only a look. */
function readKind(words: readonly string[], cwd: string, instance: InstanceContext): "read" | "outside" | undefined {
  if (!onlyLooks(words)) return undefined
  for (const word of words.slice(1).filter((word) => !word.startsWith("-"))) {
    // A pattern or a count is judged as a path too. It lands inside, or the command is held: never the other way round.
    const file = path.resolve(cwd, word)
    if (!Reach.inside(file, instance)) return "outside"
    if (!Reach.readable(file)) return undefined
  }
  return "read"
}

// `rtk <cmd>` runs `<cmd>` and shortens what it prints, so it is judged as `<cmd>`.
const unwrapped = (piece: string) => (piece.startsWith("rtk ") ? piece.slice(4) : piece)

function single(piece: string, cwd: string, instance: InstanceContext): CommandKind | undefined {
  piece = unwrapped(piece)
  if (COMMIT.test(piece) || (BRANCH.test(piece) && !piece.includes(".."))) return gitAllowed(cwd, instance) ? "git-local" : undefined
  const words = Risk.plainWords(piece)
  if (!words) return undefined
  if (FILE_OPS.has(words[0]!)) return fileOp(words, cwd, instance) ? "file-op" : undefined
  if (words[0] === "git" && words[1] === "add") {
    const rest = words.slice(2)
    const named = rest.length === 1 && rest[0] === "-A" ? true : rest.length > 0 && rest.every((word) => safePath(word, cwd, instance))
    return named && gitAllowed(cwd, instance) ? "git-local" : undefined
  }
  if (readKind(words, cwd, instance) === "read") return "read"
  const lockfiles = INSTALLS.get(piece)
  if (lockfiles) return lockfileUnchanged(lockfiles, cwd, instance) ? "check" : undefined
  return matchesCheck(words, cwd, instance) ? "check" : undefined
}

/**
 * The category of a command that is only routine work, or undefined. `[cd <path> && ]<row>[ && <row>...][ 2>&1][ | tail -N]`.
 * Splitting on the literal " && " is enough: every piece must then pass `Risk.plainWords`, so no other operator survives.
 */
export function routine(command: string, cwd: string, instance: InstanceContext): CommandKind | undefined {
  if (!canRunIn(cwd, instance)) return undefined
  let here = cwd
  const kinds: CommandKind[] = []
  for (const [index, piece] of command.replace(OUTPUT_TAIL, "").split(" && ").entries()) {
    const words = Risk.plainWords(piece)
    if (index === 0 && words?.[0] === "cd" && words.length === 2 && safePath(words[1]!, here, instance)) {
      here = path.resolve(here, words[1]!)
      continue
    }
    const kind = single(piece, here, instance)
    if (!kind) return undefined
    kinds.push(kind)
  }
  // A look beside real work is that work: the strongest piece decides.
  return (
    kinds.find((kind) => kind === "check") ??
    kinds.find((kind) => kind === "git-local") ??
    kinds.find((kind) => kind === "file-op") ??
    kinds[0]
  )
}

/** The words of one plain command, with `~` read the way the shell reads it. */
function homeWords(command: string) {
  const home = homedir()
  return Risk.plainWords(unwrapped(command).replace(/(^| )~(?=\/| |$)/g, (_match, space: string) => space + home))
}

/** Whether a plain read names a path beyond the folder. */
function readsOutside(command: string, cwd: string, instance: InstanceContext) {
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
function nearLibrary(files: readonly string[]) {
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

const within = (root: string, file: string) => {
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

function inAppState(file: string, instance: InstanceContext) {
  const target = Reach.real(file)
  // Where a write would land could not be worked out. Assume the worst of it.
  if (target === undefined) return true
  if (ownCheckout(target, instance)) return false
  return appStateRoots().some((root) => within(root, file) || within(root, target))
}

function mentionsAppState(command: string, instance: InstanceContext) {
  const spelled = ownCheckout(instance.worktree, instance) ? command.replaceAll(instance.worktree, "") : command
  return spelled.includes("trust.json") || appStateRoots().some((root) => spelled.includes(root))
}

function editTargets(input: Input) {
  const named = input.patterns.filter((pattern) => pattern !== "*").map((pattern) => path.resolve(input.instance.worktree, pattern))
  const filepath = input.metadata.filepath
  return typeof filepath === "string" && path.isAbsolute(filepath) ? [...named, filepath] : named
}

function writesAppState(input: Input) {
  if (typeof input.metadata.command === "string" && mentionsAppState(input.metadata.command, input.instance)) return true
  if (input.permission === "edit") return editTargets(input).some((file) => inAppState(file, input.instance))
  // A read of the same place only asks to look, which is the ordinary outside-the-project case.
  if (input.permission !== "external_directory" || !input.follows?.some((prompt) => prompt.permission === "edit")) return false
  const filepath = input.metadata.filepath
  return typeof filepath === "string" && inAppState(filepath, input.instance)
}

function isPlanFile(input: Input) {
  const worktree = input.instance.worktree
  const folders = [path.join(worktree, ".swarm", "plans"), path.join(Global.Path.data, "plans")].map((dir) => Reach.real(dir) ?? dir)
  const targets = editTargets(input)
  return (
    targets.length > 0 &&
    targets.every((file) => {
      const target = Reach.real(file)
      return target !== undefined && target.endsWith(".md") && folders.includes(path.dirname(target))
    })
  )
}

const riskCategory = (risk: unknown): HeldCategory => (risk === "remote" ? "outward" : "not_reversible")

/**
 * An edit nothing can undo, judged again here, because the edit tools stop at the missing Undo and say nothing else about
 * the file. Inside the folder and ordinary, it is the job the user asked for, with or without Git: it runs, on record. What
 * changes later runs or what is allowed, a secret, and anything a link takes out of the folder stay held.
 */
function classifyUnrecoverableEdit(input: Input): Verdict {
  const instance = input.instance
  // Without Git the worktree is `/`, and every name would be judged from the top of the disk.
  const base = instance.worktree === "/" ? { ...instance, worktree: instance.directory } : instance
  const targets = editTargets(input)
  if (targets.length === 0) return held("no_undo")
  if (targets.some((file) => Reach.secret(file) || !Reach.readable(file))) return held("secret_file")
  if (targets.some((file) => !Reach.inside(file, instance))) return refused("outside_write")
  if (targets.some((file) => Reach.sensitive(file, base))) return held("sensitive_file")
  const ordinary = targets.every((file) => {
    const target = Reach.real(file)
    return (
      target !== undefined &&
      Risk.ordinaryEdit(path.relative(base.worktree, file)) &&
      Risk.ordinaryEdit(path.relative(Reach.real(base.worktree) ?? base.worktree, target))
    )
  })
  return ordinary ? { class: "A", decidedBy: "gate" } : { class: "P", decidedBy: "agent", category: "edit-not-ordinary" }
}

function classifyEdit(input: Input): Verdict {
  if (input.editClass === "secret") return held("secret_file")
  if (input.editClass === "sensitive") return held("sensitive_file")
  // Not the absence of `risk`: an edit nothing can undo carries no risk label either.
  if (input.editClass === "no_undo" || !input.canUndo) return classifyUnrecoverableEdit(input)
  if (input.editClass === "not_ordinary") return { class: "P", decidedBy: "agent", category: "edit-not-ordinary" }
  if (input.editClass === "ordinary") return QUIET
  return held("not_routine")
}

function classifyBash(input: Input, checkClass: CheckClass): Verdict {
  const command = input.metadata.command
  if (typeof command !== "string" || !command) return held("not_routine")
  if (command.split(WORD_BREAK).some((word) => word && Secrets.secretFile(word))) return held("secret_file")
  const outside = outsideKind(command, input.cwd, input.instance)
  if (outside && (outsideProject(input.cwd, input.instance) || readsOutside(command, input.cwd, input.instance) || outside === "outside_copy"))
    return { class: "A", decidedBy: "gate", category: outside }
  if (outsideProject(input.cwd, input.instance)) return held("outside_folder")
  const kind = routine(command, input.cwd, input.instance)
  if (!kind) return held(readsOutside(command, input.cwd, input.instance) ? "outside_folder" : "not_routine")
  // Looking runs nothing of the folder's, so neither its trust nor Undo has anything to say about it.
  if (kind === "read") return { class: "A", decidedBy: "gate" }
  // A folder nobody has approved holds something nobody has looked at, so running its code is not routine yet.
  if (input.folder !== "clean" && input.folder !== "trusted") return held("folder_not_trusted")
  if (!input.canUndo) return held("no_undo")
  if (kind === "check" && checkClass === "D") return held("not_routine")
  return { class: "P", decidedBy: "agent", category: kind }
}

/**
 * U11 rule 1, for the prompt a tool raises before it reaches beyond the folder. A read is class A when what it names is
 * readable, a copy into the folder too, and a write is refused with nobody asked. A secret stays a person's call.
 */
function classifyOutside(input: Input): Verdict {
  const command = input.metadata.command
  if (typeof command === "string") {
    if (command.split(WORD_BREAK).some((word) => word && Secrets.secretFile(word))) return held("secret_file")
    const outside = outsideKind(command, input.cwd, input.instance)
    if (outside) return { class: "A", decidedBy: "gate", category: outside }
    const words = homeWords(command.replace(OUTPUT_TAIL, ""))
    if (words && nearLibrary([input.cwd, ...words.slice(1).map((word) => path.resolve(input.cwd, word))])) return held("outside_folder")
    // What does not parse, and a look this table cannot vouch for such as a walk, wait for a person. Any other plain command
    // that reaches out may change what is there, so it is refused with nobody asked.
    if (!words || READS.has(words[0]!)) return held("outside_folder")
    if (words.slice(1).some((word) => !word.startsWith("-") && !Reach.readable(path.resolve(input.cwd, word)))) return held("secret_file")
    return refused("outside_write")
  }
  const filepath = input.metadata.filepath
  if (typeof filepath !== "string" || !path.isAbsolute(filepath) || nearLibrary([filepath])) return held("outside_folder")
  const writes = input.follows?.some((prompt) => prompt.permission === "edit") === true
  if (!Reach.readable(filepath) || (writes && Reach.secret(filepath))) return held("secret_file")
  if (writes) return refused("outside_write")
  if (input.metadata.readOnly !== true) return held("outside_folder")
  // A search that opens every file under a folder, hidden ones too, would show a `.zshrc` or a token file no name marks.
  if (input.metadata.hidden === true) return held("outside_folder")
  return { class: "A", decidedBy: "gate", category: "outside_read" }
}

/**
 * The class of one request, per the table this mode was specified with. Stricter rules are asked first, so a request can
 * only get here with less room than a later rule would give it. `checkClass` exists for the test of both values.
 */
export function classify(input: Input, checkClass: CheckClass = CHECK_CLASS): Verdict {
  // A spend limit and a repeating call stop a run so that a person looks. Nothing here or later may answer them.
  if (needsPerson(input.permission)) return { class: "B", decidedBy: "person" }
  if (input.rule === "deny") return { class: "X" }
  if (input.permission === TRUST_PERMISSION) return { class: "X", decidedBy: "person", category: "folder_not_trusted" }

  const planEdit = input.plan === true && input.permission === "edit"
  const planFile = planEdit && isPlanFile(input)
  if (planEdit && !planFile) return refused("plan_mode")
  if (!planFile && writesAppState(input)) return refused("app_state")

  if (input.rule === "user_catch_all") return held("asks_every_time")
  if (planFile) return { class: "A", decidedBy: "gate" }
  if (input.plan === true && input.permission === "bash") return held("plan_mode")

  // A label only ever raises a class. Nothing below may read its absence as safe.
  if (input.metadata.risk) return held(riskCategory(input.metadata.risk))
  if (input.harmless) return QUIET
  if (input.permission === "task") return QUIET
  if (input.permission === "question") return { class: "A", decidedBy: "gate" }
  if (input.permission === "external_directory") return classifyOutside(input)
  if (input.permission === "read") return held("secret_file")
  if (input.permission === "edit") return classifyEdit(input)
  if (input.permission === "bash") return classifyBash(input, checkClass)
  // MCP tools ask with `*` and empty metadata, so there is nothing about the call to judge. No name is excepted, `graft_*` included.
  const opaque = input.patterns.every((pattern) => pattern === "*") && Object.keys(input.metadata).length === 0
  return held(opaque ? "external_tool" : "not_routine")
}

export * as AutonomyTable from "./autonomy-table"
