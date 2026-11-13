// What autonomous mode does with a request nobody is there to answer. This decides on what the request says and on bytes,
// and no model is involved: only class P ever reaches one, and a model's answer cannot raise a request into P. It is an
// allow list because a list of what to refuse let through every way of spelling `git push` that was tried.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import { devNull, homedir, networkInterfaces } from "node:os"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { needsPerson } from "@opencode-ai/core/permission/needs-person"
import type { ProjectTrust } from "@opencode-ai/core/project/trust"
import { AUTONOMY_CONSENT, type PermissionV1 } from "@opencode-ai/core/v1/permission"
import { McpCatalog } from "../mcp/catalog"
import { OutwardKnown } from "./outward-known"
import { OutwardConsent } from "./outward-consent"
import { ScriptScreen } from "./script-screen"
import { BypassLists } from "./bypass-lists"
import { BypassScreen } from "./bypass-screen"
import { ScriptReader } from "./script-reader"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { LibraryRoot } from "../skill/library-root"
import { SelfAddress } from "../server/self-address"
import { GitGuard } from "../tool/git-guard"
import { Reach } from "../tool/reach"
import type { ShellPlace } from "../tool/shell"
import { Risk } from "../tool/risk"
import { DeletionWords, type Deletion } from "../tool/deletion"
import { Secrets } from "../tool/secrets"
import { findProgram } from "../util/find-program"
import type { CheckpointFailedReason, OwnApiReason } from "./autonomy-texts"

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
/**
 * The category names are the schema's (`PermissionV1`), so the gate, the table and the audit cannot name a category the
 * others lack. Only the routine kinds and "edit-not-ordinary" are the table's own.
 */
export type AllowedCategory = RoutineCategory | "edit-not-ordinary" | PermissionV1.AllowedCategory
export type HeldCategory = PermissionV1.DeferredCategory

/** What the edit tools learned from `Reach.editTrust`. Absent means nobody said, and that is held. */
export type EditClass = "ordinary" | "not_ordinary" | "no_undo" | "sensitive" | "secret"

export type Verdict = {
  class: Class
  /** The name of who settled it. "agent" is filled in with the model by whoever calls it. Absent when it is not recorded. */
  decidedBy?: "gate" | "agent" | "person"
  category?: AllowedCategory | HeldCategory
  /** U11 rule 3: it leaves the machine for a destination a person named and ticked, which `consentID` is the item of. */
  via?: "outward"
  /** The consent item a class A answer used: rule 3's destination with `via`, or rule 2's file with category "consented". */
  consentID?: string
  /**
   * That destination as the audit shows it (`OutwardKnown.label`), with account names hidden. 1.1.1 F26 (P42): on a call
   * the consent opened to send, where it goes (`host[:port]`, a remote name, a registry or deploy target), comma separated.
   */
  destination?: string
  /**
   * U11 rule 6: the screen behind a `script` or `script_flagged` answer, for the gate to put on record. The decider is only
   * ever given the closed summary of it (C70), and none of it is the script's text.
   */
  screen?: { bytes: number; lines: number; sha256: string; flags: readonly ScriptScreen.Flag[] }
  /** 1.1.1 (S1.12): the category the call had before the consented bypass let it run. Present only on an overlay A. */
  bypassed?: AllowedCategory | HeldCategory
  /**
   * 1.2.6 row 37b (P-01b): on an X `checkpoint_failed`, why no checkpoint could be made, from the closed list of
   * `checkpointFailedText` (autonomy-texts.ts). Never command text.
   */
  reason?: CheckpointFailedReason | OwnApiReason
}

/**
 * What the gate knows for U11 rule 3, from the root's consent: the destinations a person named and ticked, the snapshot
 * they were matched in before the mode could change anything, and for a push the recheck it ran just now on the remote
 * `pushTarget` names. The table only reads this, so nothing an agent says can add to it. Absent: nothing may leave.
 */
export type Outward = {
  allowed: readonly { id: string; destination: OutwardKnown.Destination }[]
  snapshot?: OutwardKnown.Snapshot
  recheck?: { repo: string; remote: string; result: OutwardKnown.Recheck }
  /** 1.1.1 F26 (P42): every destination named in the mission, ticked or not. Only the consented bypass reads it. */
  named?: readonly OutwardKnown.Destination[]
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
  outward?: Outward
  /** U11 rule 2, as the gate passes it (`Permission.Consented`). Read only here; absent means no list, so all is held. */
  consent?: Consent
  /**
   * 1.1.1 (S1.10): the person consented that the main agent decides during this run, and whose call this is. Absent: the
   * 1.1.0 table, to the byte.
   */
  bypass?: { readonly caller: "root" | "subagent" }
  /** The processes Swarm started (S1.28), for `kill` under the bypass. Absent: none is known to be Swarm's. */
  ownProcesses?: ReadonlySet<number>
  /**
   * 1.1.1 F26 (P42): the whole text of the call a step of `classifySteps` came from, so a request step still sees a `<`
   * or a pipe the step's own words no longer carry. Absent: the call's own command.
   */
  whole?: string
}

/**
 * What a person allowed of the root's consent list: each concrete path they were shown, with the id of the item covering
 * it. A pattern such as `.env*` is only how the list reads to them; a file it would match that is not here is not covered.
 */
export type Consent = {
  id: string
  files: ReadonlyMap<string, string>
}

/** Not a prompt today. A folder's trust is a person's answer through its own endpoint, so nothing may answer it from here. */
export const TRUST_PERMISSION = "project_trust"

const held = (category: HeldCategory): Verdict => ({ class: "D", decidedBy: "gate", category })
const refused = (category: HeldCategory): Verdict => ({ class: "X", decidedBy: "gate", category })
const QUIET: Verdict = { class: "A" }

const CHECK_NAMES = new Set(["test", "build", "typecheck", "lint", "check"])
// Row 276: a script named for one of those with a part after a colon, as projects split them (`check:registry`, `test:unit`).
const CHECK_SCRIPT = /^(test|check|lint|typecheck):[\w.-]+$/
const QUIET_FLAGS = ["-q", "-x", "-v"]

// Each row is the whole of what is accepted. `--preload`, `npm test -- x`, `pytest -p`, `go test -exec`, `make -f` and `VAR=`
// all name code an attacker chose, and they fall off the end of this list with nothing having to recognise them.
// `local`: the program `npx` must find in the project's own `node_modules/.bin`; without it npx downloads one and runs it.
const CHECKS: readonly {
  prefix: readonly string[]
  exact?: boolean
  names?: ReadonlySet<string>
  script?: RegExp
  flags?: readonly string[]
  paths?: boolean
  local?: string
}[] = [
  { prefix: ["bun", "test"], flags: ["--bail", "--only"], paths: true },
  { prefix: ["bun", "run"], names: CHECK_NAMES, script: CHECK_SCRIPT },
  { prefix: ["bun"], names: new Set(["typecheck", "lint"]) },
  // Row 276: `npm test <file>` hands the files to the project's test script; only names inside the folder, no flags.
  { prefix: ["npm", "test"], paths: true },
  { prefix: ["npm", "run"], names: CHECK_NAMES, script: CHECK_SCRIPT },
  { prefix: ["pnpm", "test"], exact: true },
  { prefix: ["pnpm", "run"], names: CHECK_NAMES, script: CHECK_SCRIPT },
  { prefix: ["yarn", "test"], exact: true },
  { prefix: ["yarn", "run"], names: CHECK_NAMES, script: CHECK_SCRIPT },
  { prefix: ["npx", "vitest", "run"], paths: true, local: "vitest" },
  { prefix: ["npx", "tsc", "--noEmit"], exact: true, local: "tsc" },
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
    if (row.local && !localBin(row.local, cwd, instance)) return false
    const rest = words.slice(row.prefix.length)
    if (row.exact) return rest.length === 0
    if (row.names) return rest.length === 1 && (row.names.has(rest[0]!) || row.script?.test(rest[0]!) === true)
    return rest.every((word) => (word.startsWith("-") ? row.flags?.includes(word) : row.paths && safePath(word, cwd, instance)))
  })
}

/** Whether `npx <name>` finds the project's own copy: `node_modules/.bin/<name>` from here up to the folder, as npx looks. */
function localBin(name: string, cwd: string, instance: InstanceContext) {
  const top = Reach.real(instance.directory) ?? instance.directory
  let folder = Reach.real(cwd) ?? cwd
  while (containsPath(folder, { ...instance, directory: top, worktree: top })) {
    const bin = path.join(folder, "node_modules", ".bin", name)
    if (fs.lstatSync(bin, { throwIfNoEntry: false }) && Reach.inside(bin, instance)) return true
    const parent = path.dirname(folder)
    if (parent === folder) return false
    folder = parent
  }
  return false
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
  const folder = Reach.real(cwd)
  return top !== undefined && folder !== undefined && noRepositoryBetween(folder, top)
}

/** Whether git, run in the real folder `folder`, lands in the repository at the real folder `top`. */
export function noRepositoryBetween(start: string, top: string) {
  let folder = start
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
//
// Row 274 adds the programs the inventory of 88,388 recorded agent commands found looking
// (`research/20_shell_command_inventory.md`), each with what would make it write: `sort -o`, `uniq` and `xxd` with a second
// name (their output file), `diff --output`, and `du`/`df` reading only. `maxPaths` caps the names a program takes as input.
const READS = new Map<string, { short?: string; long?: readonly string[]; exact?: readonly string[]; maxPaths?: number }>([
  ["ls", {}],
  ["cat", {}],
  ["head", {}],
  ["tail", { short: "fF", long: ["--follow", "--retry"] }],
  ["wc", { long: ["--files0-from"] }],
  ["stat", {}],
  // 1.2.7 row 47a (M1-01): `-z`/`-Z` decompress, which libmagic may hand to an outside program (gzip, xz, zstd …).
  ["file", { short: "CzZ", long: ["--compile", "--uncompress", "--uncompress-noreport"] }],
  ["pwd", {}],
  ["tree", { short: "oR", long: ["--output", "--fromfile"] }],
  // 1.2.7 row 47a (M1-01): `--hostname-bin=<program>` runs that program (ripgrep 13+), as `--pre` and `-z` do.
  ["rg", { short: "uLz.", long: ["--pre", "--pre-glob", "--hostname-bin", "--hidden", "--no-ignore", "--follow", "--search-zip", "--unrestricted"] }],
  ["grep", { short: "rRdD", long: ["--recursive", "--dereference-recursive", "--directories", "--devices"] }],
  ["egrep", { short: "rRdD", long: ["--recursive", "--dereference-recursive", "--directories", "--devices"] }],
  ["find", { exact: ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"] }],
  ["sort", { short: "oT", long: ["--output", "--temporary-directory", "--compress-program", "--files0-from"] }],
  ["uniq", { maxPaths: 1 }],
  ["cut", {}],
  ["tr", {}],
  // 1.2.7 row 47a (M1-01): `-l`/`--paginate` pipes the output through `pr`, a program diff starts.
  ["diff", { short: "l", long: ["--output", "--to-file", "--from-file", "--paginate"] }],
  ["cmp", {}],
  ["comm", {}],
  ["paste", {}],
  ["column", {}],
  ["nl", {}],
  ["rev", {}],
  ["fold", {}],
  ["fmt", {}],
  ["od", {}],
  ["xxd", { short: "r", long: ["--revert"], maxPaths: 1 }],
  ["hexdump", {}],
  ["strings", {}],
  ["du", {}],
  ["df", {}],
  ["basename", {}],
  ["dirname", {}],
  ["realpath", {}],
  ["readlink", {}],
  ["which", {}],
  ["shasum", {}],
  ["sha256sum", {}],
  ["sha1sum", {}],
  ["md5", {}],
  ["md5sum", {}],
  ["cksum", {}],
  // Not `jq`: `env` and `$ENV` print the environment, keys and tokens included, into what the agent reads.
  ["test", {}],
])
// Row 274: a short flag may carry its value (`cut -c1-80`, `sort -k1,1`, `head -n+5`) and a long one `=value`
// (`grep --include=*.ts`). A refused long name is matched with its value too, so `sort --output=f` is still a write.
// A space is a value only as `cut -d' '` writes it: one letter, then that one space.
const READ_FLAG = /^-[A-Za-z0-9@][A-Za-z0-9@,.:+-]*$|^-[A-Za-z] $|^--[a-z][a-z0-9-]*(=\S*)?$/

/** Whether no flag makes this program do more than look at what the command names. */
function onlyLooks(words: readonly string[]) {
  const rules = READS.get(words[0]!)
  if (!rules) return false
  return words.slice(1).every(
    (word) =>
      !word.startsWith("-") ||
      (READ_FLAG.test(word) &&
        !rules.exact?.includes(word) &&
        !rules.long?.some((name) => word === name || word.startsWith(name + "-") || word.startsWith(name + "=")) &&
        // 1.1.1 F10a (G3-1): these programs take a long option by any shortening of it, so a shortening is that option.
        !Risk.abbreviates(word, rules.long ?? []) &&
        (rules.exact !== undefined || word.startsWith("--") || ![...word.slice(1)].some((flag) => rules.short?.includes(flag)))),
  )
}

/** "read", "outside" when a path it names is beyond the folder, or undefined when it is not only a look. */
function readKind(words: readonly string[], cwd: string, instance: InstanceContext): "read" | "outside" | undefined {
  if (!onlyLooks(words)) return undefined
  const named = words.slice(1).filter((word) => !word.startsWith("-"))
  const cap = READS.get(words[0]!)?.maxPaths
  if (cap !== undefined && named.length > cap) return undefined
  for (const word of named) {
    // A pattern or a count is judged as a path too. It lands inside, or the command is held: never the other way round.
    const file = path.resolve(cwd, word)
    if (!Reach.inside(file, instance)) return "outside"
    if (!Reach.readable(file)) return undefined
  }
  return "read"
}

// `rtk <cmd>` runs `<cmd>` and shortens what it prints, so it is judged as `<cmd>`.
const unwrapped = (piece: string) => (piece.startsWith("rtk ") ? piece.slice(4) : piece)

/**
 * C97 F1: a look with quoted arguments (`cat "a b.md"`, `find d -name '*.ts'`), as the program will get them. Only a look:
 * each of its words is judged again as a flag or as a path, so a quote changes nothing about what is let through.
 */
function quotedLook(piece: string) {
  const words = Risk.quotedWords(piece)
  return words && (READS.has(words[0]!) || QUOTED_LOOKS.has(words[0]!)) ? words : undefined
}

// Row 274: the other programs `single` judges word by word, whose quoted words (`echo "== a =="`, `awk '{print $1}'`,
// `git log --format='%h %s'`) reach them as they are.
const QUOTED_LOOKS = new Set(["echo", "printf", "sleep", "date", "sed", "awk", "git"])

function single(piece: string, cwd: string, instance: InstanceContext): CommandKind | undefined {
  piece = unwrapped(piece)
  if (COMMIT.test(piece) || (BRANCH.test(piece) && !piece.includes(".."))) return gitAllowed(cwd, instance) ? "git-local" : undefined
  const words = Risk.plainWords(piece) ?? quotedLook(piece)
  if (!words) return undefined
  if (FILE_OPS.has(words[0]!)) return fileOp(words, cwd, instance) ? "file-op" : undefined
  if (words[0] === "git" && words[1] === "add") {
    const rest = words.slice(2)
    const named = rest.length === 1 && rest[0] === "-A" ? true : rest.length > 0 && rest.every((word) => safePath(word, cwd, instance))
    return named && gitAllowed(cwd, instance) ? "git-local" : undefined
  }
  if ((words[0] === "grep" || words[0] === "egrep") && words.some(recursiveFlag)) return grepTree(words, cwd, instance) ? "read" : undefined
  if (readKind(words, cwd, instance) === "read") return "read"
  if (words[0] === "sed") return sedPrints(words, cwd, instance) ? "read" : undefined
  if (words[0] === "awk") return awkReads(words, cwd, instance) ? "read" : undefined
  if (words[0] === "git") return gitReads(words, cwd, instance) ? "read" : undefined
  if (printsOnly(words)) return "read"
  const lockfiles = INSTALLS.get(piece)
  if (lockfiles) return lockfileUnchanged(lockfiles, cwd, instance) ? "check" : undefined
  return matchesCheck(words, cwd, instance) ? "check" : undefined
}

// Row 273: `sed -n` with one line or one range to print, `$` for the last. No other sed command reaches here: `w` writes,
// `e` runs a program, and `-i`, `-e`, `-f` are flags, which the file list below never takes.
const SED_PRINT = /^(?:\d+|\$)(?:,(?:\d+|\$))?p$/

/** `sed -n <range>p <file>...`, printing lines of files the read tool would show without asking. */
function sedPrints(words: readonly string[], cwd: string, instance: InstanceContext) {
  const files = words.slice(3)
  // Row 276: a `/regex/` address too (`sed -n '/^## 8\./,/^## 9\./p'`): it only picks the lines, and `p` prints them.
  const script = words[2] ?? ""
  const printsRange = SED_PRINT.test(script) || new RegExp(String.raw`^${SED_ADDR}(?:,${SED_ADDR})?p$`).test(script)
  if (words[1] !== "-n" || !printsRange || files.length === 0) return false
  return !files.some((word) => word.startsWith("-")) && readKind(["cat", ...files], cwd, instance) === "read"
}

// Row 276: `grep -r` reads every file under what it names, so it is a look only where that tree holds nothing the read
// tool would not show. Either every `--include` names a kind of source or text file, which no secret is, or a bounded walk
// of the tree, skipping what `--exclude-dir` skips, finds no secret, no link and no more than MAX_TREE entries.
const recursiveFlag = (word: string) => /^-[A-Za-z]*r[A-Za-z]*$/.test(word) || word === "--recursive"
const TEXT_KINDS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "md", "mdx", "sql", "py", "go", "rs", "css", "scss", "html", "vue", "svelte", "txt", "rb", "java", "kt", "swift", "c", "h", "cpp", "hpp"])
const MAX_TREE = 5000

function grepTree(words: readonly string[], cwd: string, instance: InstanceContext) {
  const includes: string[] = []
  const skipped: string[] = []
  const named: string[] = []
  const args = words.slice(1)
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    // Context and count flags take the next word as a number; `-e` takes it as the pattern.
    if (/^-[ABCm]$/.test(word) && /^\d+$/.test(args[index + 1] ?? "")) index++
    else if (word === "-e" && args[index + 1] !== undefined) named.unshift(args[++index]!)
    else if (word.startsWith("--include=")) includes.push(word.slice(10))
    else if (word.startsWith("--exclude-dir=")) skipped.push(word.slice(14))
    else if (word.startsWith("--exclude=")) continue
    else if (word === "--recursive") continue
    // Short flags only, none that follows links (`R`), reads patterns from a file (`f`), or changes how folders and
    // devices are read (`d`, `D`).
    else if (word.startsWith("-")) {
      if (!/^-[A-Za-z]+$/.test(word) || /[RfdD]/.test(word.slice(1))) return false
    } else named.push(word)
  }
  const [, ...targets] = named
  const roots = (targets.length > 0 ? targets : ["."]).map((word) => path.resolve(cwd, word))
  if (!roots.every((root) => Reach.inside(root, instance) && Reach.readable(root))) return false
  if (includes.length > 0 && includes.every((glob) => /^\*\.([a-z0-9]+)$/.test(glob) && TEXT_KINDS.has(glob.slice(2)))) return true
  // `.git`, hooks and the like are sensitive, as a plain `cat .git/config` is: a token can sit in a remote's address.
  const base = instance.worktree === "/" ? { ...instance, worktree: instance.directory } : instance
  let seen = 0
  const clean = (folder: string): boolean => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (++seen > MAX_TREE) return false
      if (entry.isDirectory() && skipped.includes(entry.name)) continue
      const file = path.join(folder, entry.name)
      if (entry.isSymbolicLink() || !Reach.readable(file) || Reach.sensitive(file, base)) return false
      if (entry.isDirectory() && !clean(file)) return false
    }
    return true
  }
  try {
    return roots.every((root) => (fs.statSync(root).isDirectory() ? clean(root) : true))
  } catch {
    return false
  }
}

// Row 274: programs whose arguments name no file. They print, wait or answer, and nothing more.
const PRINTS = new Set(["echo", "printf", "true", "false", ":"])

function printsOnly(words: readonly string[]) {
  const [name, ...args] = words
  if (PRINTS.has(name!)) return name === "echo" || name === "printf" || args.length === 0
  if (name === "sleep") return args.length > 0 && args.every((word) => /^\d+(\.\d+)?[smhd]?$/.test(word))
  // `date` prints; `-s` and a bare operand set the clock, `-f` reads a file of dates.
  if (name === "date") return args.every((word) => /^\+/.test(word) || /^-[ujR]+$/.test(word) || /^-I\w*$/.test(word) || /^-v[+-]?\d+[ymwdHMS]$/.test(word))
  return false
}

// Row 274: what awk can do besides read and print to the output. `system`, a pipe and `getline` from a command run a
// program; `print > f` and `printf > f` write; `close` and `fflush` act on those. A comparison such as `$3 > 5` outside a
// print is a comparison. Erring on a print that only compares holds it, which is the safe way to be wrong. `ENVIRON`
// reads the environment, keys and tokens included.
const AWK_ACTS = /\b(system|getline|close|fflush|ENVIRON)\b|\||\bprintf?\b[^;{}\n]*>/

/** `awk [-F x] [-v a=b] '<program>' [a=b] [file...]` whose program only reads and prints, over files the read tool shows. */
function awkReads(words: readonly string[], cwd: string, instance: InstanceContext) {
  const files: string[] = []
  let program: string | undefined
  for (let index = 1; index < words.length; index++) {
    const word = words[index]!
    if (program === undefined && word.startsWith("-")) {
      if (word === "-F" || word === "-v") index++
      else if (!/^-F.+$/.test(word) && !/^-v[A-Za-z_]\w*=/.test(word)) return false
      continue
    }
    if (program === undefined) program = word
    else if (!/^[A-Za-z_]\w*=/.test(word)) files.push(word)
  }
  if (program === undefined || AWK_ACTS.test(program)) return false
  return files.length === 0 || readKind(["cat", ...files], cwd, instance) === "read"
}

// Row 274: git commands that only show the repository. Each is judged in a repository the guard vetted, with nothing
// between it and the folder (`gitAllowed`), so no config there can make git run a program. `-c`, `-C`, `--git-dir`,
// `--work-tree` and `--exec-path` before the command change which repository or program that is; `--output` writes,
// `--ext-diff` and `--open-files-in-pager`/`-O` run a program, `--no-index` reads beyond the repository.
const GIT_READS = new Set([
  "status", "diff", "log", "show", "rev-parse", "ls-files", "ls-tree", "cat-file", "rev-list", "for-each-ref", "merge-base",
  "check-ignore", "grep", "blame", "describe", "shortlog", "diff-tree", "name-rev", "count-objects", "reflog",
])
// Commands that also make or change things, and the flags with which they only list. `stash` and `worktree` list only
// after the word `list`.
const GIT_LISTS: Readonly<Record<string, RegExp>> = {
  branch: /^(-a|-r|-v|-vv|--list|--show-current|--all|--remotes|--verbose|--no-color|--contains|--merged|--no-merged)$/,
  tag: /^(-l|--list|-n\d*|--sort=[\w:-]+|--contains|--points-at)$/,
  remote: /^(-v|--verbose)$/,
  stash: /^--oneline$/,
  worktree: /^--porcelain$/,
}
const GIT_ACTS = /^(--output(=.*)?|--ext-diff|--open-files-in-pager(=.*)?|-O.*|--no-index|--exec(=.*)?|--textconv)$/
// 1.1.1 F10a (G3-1): the same options by name, as git also takes them shortened (one list, in `bypass-lists.ts`).
const gitActs = (word: string) => GIT_ACTS.test(word) || Risk.abbreviates(word, BypassLists.GIT_ACT_NAMES, BypassLists.GIT_ACT_EXACT)
// 1.2.7 row 47a (M1-12): options with which a look starts a program the user's own (unvetted, OP-6) git config names:
// `cat-file --filters` runs the smudge and textconv drivers, `--show-signature` and the signature placeholders of a format
// (`%G?`, `%GS`, `%(signature)`) run `gpg.program`. git takes `cat-file`'s long options shortened too.
const GIT_RUNS_NAMES: readonly string[] = ["--filters", "--show-signature"]
const GIT_SIGNATURE_FORMAT = /%G|%\(signature/
const gitRuns = (word: string) => Risk.abbreviates(word, GIT_RUNS_NAMES) || GIT_SIGNATURE_FORMAT.test(word)
// The one word after these flags is a revision, not a name to make.
const GIT_REV_FLAG = /^--(contains|merged|no-merged|points-at)$/

function gitReads(words: readonly string[], cwd: string, instance: InstanceContext) {
  // Row 276: `git -C <folder> <look>` is the same look run in that folder, which must be one a command may run in.
  const moved = words[1] === "-C" && words[2] !== undefined
  const here = moved ? path.resolve(cwd, words[2]!) : cwd
  const [sub, ...args] = words.slice(moved ? 3 : 1)
  if (moved && !canRunIn(here, instance)) return false
  return sub !== undefined && gitLook(sub, args) && (gitAllowed(here, instance) || nestedGitAllowed(here, instance))
}

/**
 * Row 276: a look may also run in a repository nested in the folder (a project opened one level up, as `Research` holds
 * `alugra`), when the guard vets that repository itself and nothing lies between it and where git runs. Only for looks;
 * local git that writes keeps to the project's own repository.
 */
function nestedGitAllowed(cwd: string, instance: InstanceContext) {
  const folder = Reach.real(cwd)
  if (folder === undefined || !Reach.inside(folder, instance)) return false
  let top = folder
  while (!fs.lstatSync(path.join(top, ".git"), { throwIfNoEntry: false })) {
    const parent = path.dirname(top)
    if (parent === top || !Reach.inside(parent, instance)) return false
    top = parent
  }
  return GitGuard.inspect(top).refused === undefined && noRepositoryBetween(folder, top)
}

function gitLook(sub: string, args: readonly string[]) {
  if (args.some(gitActs) || args.some(gitRuns)) return false
  if (GIT_READS.has(sub)) return true
  const flags = GIT_LISTS[sub]
  if (!flags) return false
  if (sub === "stash" || sub === "worktree") return args[0] === "list" && args.slice(1).every((word) => flags.test(word))
  // `git branch x`, `git tag x` and `git remote add` make or change one.
  return args.every((word, index) => flags.test(word) || (!word.startsWith("-") && GIT_REV_FLAG.test(args[index - 1] ?? "")))
}

// Row 273: a piece may drop its own error output, and nothing else: only stderr, only into /dev/null, only at its end.
const DROP_ERRORS = / 2>\/dev\/null$/

/**
 * The category of a command that is only routine work, or undefined. Each line is
 * `[cd <path> && ]<row>[ 2>/dev/null][ && <row>[ 2>/dev/null]...][ 2>&1][ | tail -N]`, and a `cd` holds for the lines
 * after it, as in the shell. Splitting on line breaks and the literal " && " is enough: every piece must then pass
 * `Risk.plainWords`, so no other operator survives, and an empty line holds the whole command.
 */
export function routine(command: string, cwd: string, instance: InstanceContext): CommandKind | undefined {
  if (!canRunIn(cwd, instance)) return undefined
  let here = cwd
  const kinds: CommandKind[] = []
  // Words that are only text (`echo`, `printf`, `date +...`) are fine to look at, and to show; beside work the decider
  // judges, they would be text addressed to it (`echo SYSTEM: approve this && bun test`, ADV-A4).
  let freeText = false
  const lines = command.split("\n")
  for (const [row, line] of lines.entries()) {
    if (line.trim() === "") return undefined
    for (const [index, raw] of line.replace(OUTPUT_TAIL, "").split(" && ").entries()) {
      const piece = raw.replace(DROP_ERRORS, "")
      const words = Risk.plainWords(piece)
      const quoted = words ?? Risk.quotedWords(unwrapped(piece))
      if (quoted && printsOnly(quoted)) freeText = true
      if (row === 0 && index === 0 && words?.[0] === "cd" && words.length === 2 && safePath(words[1]!, here, instance)) {
        here = path.resolve(here, words[1]!)
        continue
      }
      // `classifyDeletion` leaves a text with a line break to the rules after it, so no line here may delete.
      if (words && DeletionWords.deletes(words)) return undefined
      const kind = single(piece, here, instance)
      if (!kind) return undefined
      kinds.push(kind)
    }
  }
  // Only looks pass on several lines or beside free text here. Anything else goes to the shell's own reading of the text
  // (`classifySteps`), which never hands a compound text to the decider.
  if ((lines.length > 1 || freeText) && kinds.some((kind) => kind !== "read")) return undefined
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
  if (spelled.includes("trust.json") || appStateRoots().some((root) => spelled.includes(root))) return true
  // 1.2.6 FX-14 (F-1, F-2): `~/…`, `$HOME/…` and `${HOME}/…` name the same places as the absolute spelling, so they are
  // judged as it is (C8). Each such word is read as the shell would, under each home a place may be spelled in.
  return homeSpelled(command).some((file) => inAppStateSpelled(file, instance))
}

// Breaks a command into words the way a path ends: blanks, redirects, pipes, separators, `=` of an option or assignment.
const PATH_BREAK = /[\s<>|;&()`=,]+/
const HOME_WORD = /^(?:~|\$HOME\b|\$\{HOME\})(?=\/|$)/

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

// Hosts that are this computer, whatever the listener's own name. `0` and `0.0.0.0` connect to it on macOS and Linux.
const LOOPBACK_NAME = /^(?:localhost|ip6-localhost|ip6-loopback|[\w.-]+\.localhost|127(?:\.\d{1,3}){3}|0|0\.0\.0\.0|::|::1|::ffff:127(?:\.\d{1,3}){3}|0:0:0:0:0:0:0:1)$/i
const WILDCARD = new Set(["0.0.0.0", "::", ""])

/**
 * 1.2.7 F-4 (SR7-08): one spelling per host, so every spelling of loopback reads as one. An IPv4 address in any form
 * `inet_aton` takes (1 to 4 parts, each decimal, hex `0x…` or octal `0…`: `127.1`, `2130706433`, `0x7f000001`,
 * `0177.0.0.1`, `0`) becomes its dotted quad; an IPv6 address its short form, an IPv4-mapped one (`::ffff:127.0.0.1`)
 * that IPv4 address; a name loses its trailing dot (`localhost.`). Lower case, brackets dropped.
 */
function normaliseHost(host: string): string {
  const name = host.replace(/^\[|\]$/g, "").toLowerCase()
  const v4 = ipv4(name)
  if (v4 !== undefined) return v4
  if (name.includes(":")) return ipv6(name) ?? name
  return name.replace(/\.$/, "")
}

function ipv4(name: string): string | undefined {
  if (!/^[0-9a-fx]+(?:\.[0-9a-fx]+){0,3}$/.test(name)) return undefined
  const values = name.split(".").map((part) =>
    /^0x[0-9a-f]*$/.test(part)
      ? parseInt(part.slice(2) || "0", 16)
      : /^0[0-7]*$/.test(part)
        ? parseInt(part, 8)
        : /^[1-9]\d*$/.test(part)
          ? parseInt(part, 10)
          : NaN,
  )
  if (values.some((value) => !Number.isFinite(value))) return undefined
  const last = values.pop()!
  if (values.some((value) => value > 255) || last >= 256 ** (4 - values.length)) return undefined
  const whole = values.reduce((sum, value, index) => sum + value * 256 ** (3 - index), last)
  return [Math.floor(whole / 2 ** 24) % 256, Math.floor(whole / 2 ** 16) % 256, Math.floor(whole / 2 ** 8) % 256, whole % 256].join(".")
}

function ipv6(name: string): string | undefined {
  let text = name.replace(/%.*$/, "")
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (tail) {
    const quad = ipv4(tail[1]!)
    if (quad === undefined) return undefined
    const [a, b, c, d] = quad.split(".").map(Number) as [number, number, number, number]
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = text.split("::")
  if (halves.length > 2) return undefined
  const head = halves[0] ? halves[0].split(":") : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : []
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0
  if (fill < 0) return undefined
  const groups = [...head, ...Array<string>(fill).fill("0"), ...rest]
  if (groups.length !== 8 || !groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return undefined
  const words = groups.map((group) => parseInt(group, 16))
  // IPv4-mapped (`::ffff:a.b.c.d`) and IPv4-compatible (`::a.b.c.d`) addresses reach that IPv4 address.
  if (words.slice(0, 5).every((word) => word === 0) && (words[5] === 0xffff || (words[5] === 0 && words[6] !== 0)))
    return [words[6]! >> 8, words[6]! & 255, words[7]! >> 8, words[7]! & 255].join(".")
  if (words.every((word) => word === 0)) return "::"
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return "::1"
  return words.map((word) => word.toString(16)).join(":")
}

const isIpAddress = (normal: string) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(normal) || normal.includes(":")

/** Whether a host names this computer as Swarm's own listener at `listener` can be reached there. */
function ownHost(host: string, listener: SelfAddress.Address) {
  const name = normaliseHost(host)
  const bound = normaliseHost(listener.hostname)
  if (name === "" || LOOPBACK_NAME.test(name) || name === bound) return true
  if (!WILDCARD.has(bound)) return false
  // Bound on every interface: this computer's own addresses reach it too.
  return Object.values(networkInterfaces()).some((list) => list?.some((item) => normaliseHost(item.address) === name))
}

/**
 * D1 (1.2.6 FX-14): whether a text names `listener` literally: `host:port` (a URL or not), `[v6]:port`,
 * `/dev/tcp/host/port`, httpie's bare `:port`, and `host port` (`nc 127.0.0.1 port`) for a host that is not a bare number.
 */
function namesListener(raw: string, listener: SelfAddress.Address) {
  const text = raw.replace(/['"\\]/g, "")
  const at = String.raw`0*${listener.port}(?!\d)`
  const named = new RegExp(String.raw`(\[[0-9A-Fa-f:.]*\]|[\w.-]+):${at}|/dev/(?:tcp|udp)/([^/\s]+)/${at}`, "g")
  for (const match of text.matchAll(named)) if (ownHost(match[1] ?? match[2]!, listener)) return true
  // httpie and xh read a bare `:port` as localhost; `nc 127.0.0.1 port` names the host and the port apart.
  if (new RegExp(String.raw`(?:^|\s):${at}`).test(text)) return true
  for (const match of text.matchAll(new RegExp(String.raw`(?:^|\s)(\[[0-9A-Fa-f:.]*\]|[\w.:-]*[A-Za-z.:][\w.:-]*)\s+${at}`, "g")))
    if (ownHost(match[1]!, listener)) return true
  return false
}

/** 1.2.7 F-4: an X `own_api`; a reason (N7-136) when the address could not be worked out (N7-135), none when it was. */
type OwnApiHit = { readonly reason?: OwnApiReason }

/** F-4: the network clients whose address a call may hide (`BypassLists.OUTWARD` less the remote shells, mail and sync). */
const NETWORK_CLIENTS: ReadonlySet<string> = new Set(["curl", "wget", "nc", "ncat", "netcat", "socat", "http", "https", "xh", "telnet"])
/** Words that run the command after them; `xargs` builds it at run time, a shell's `-c` and `eval` run a text. */
const CLIENT_WRAPPERS: ReadonlySet<string> = new Set([
  "rtk", "env", "exec", "command", "builtin", "nohup", "time", "nice", "timeout", "stdbuf", "sudo", "doas", "eval", "xargs",
  "sh", "bash", "zsh", "dash",
])
/** curl's short options that take a value; `K` is a config file, `x` a proxy. */
const CURL_VALUE_SHORT = new Set("AbcCdDeEFHKmoPQrtTuUwxXyYz".split(""))
/** curl's long options whose value is an address. */
const CURL_ADDRESS_LONG = new Set(["--url", "--proxy", "--preproxy", "--doh-url", "--connect-to", "--resolve", "--socks4", "--socks4a", "--socks5", "--socks5-hostname"])
const CURL_VALUE_LONG = new Set([
  "--config", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "--json", "--header", "--proxy-header",
  "--user", "--user-agent", "--output", "--output-dir", "--request", "--cookie", "--cookie-jar", "--referer", "--form",
  "--form-string", "--write-out", "--max-time", "--connect-timeout", "--retry", "--retry-delay", "--retry-max-time", "--range",
  "--upload-file", "--cacert", "--capath", "--cert", "--key", "--cert-type", "--key-type", "--proxy-user", "--oauth2-bearer",
  "--limit-rate", "--max-filesize", "--dump-header", "--trace", "--trace-ascii", "--stderr", "--interface", "--dns-servers",
  "--unix-socket", "--abstract-unix-socket", "--aws-sigv4", "--variable", "--url-query", "--time-cond", "--continue-at",
  "--speed-limit", "--speed-time", "--local-port", "--keepalive-time", "--max-redirs", "--expect100-timeout", "--pass",
  "--ciphers", "--crlfile", "--pinnedpubkey", "--quote", "--telnet-option", "--create-file-mode", "--happy-eyeballs-timeout-ms",
  ...CURL_ADDRESS_LONG,
])
/** wget's short options that take a value; `i` is a URL list read at run time, `e` a `.wgetrc` command. */
const WGET_VALUE_SHORT = new Set("OoaiBtTwePUQlARDXI".split(""))
const WGET_VALUE_LONG = new Set([
  "--output-document", "--output-file", "--append-output", "--input-file", "--base", "--tries", "--timeout", "--wait",
  "--execute", "--directory-prefix", "--user-agent", "--quota", "--level", "--accept", "--reject", "--domains", "--header",
  "--user", "--password", "--http-user", "--http-password", "--post-data", "--post-file", "--body-data", "--body-file",
  "--method", "--config", "--load-cookies", "--save-cookies", "--referer", "--ca-certificate", "--certificate", "--private-key",
  "--limit-rate", "--bind-address", "--read-timeout", "--connect-timeout", "--dns-timeout", "--waitretry",
])
/** httpie's and xh's options that take a value; `--proxy` is `scheme:url`. */
const HTTPIE_VALUE = new Set(["-a", "--auth", "-A", "--auth-type", "--session", "--session-read-only", "-o", "--output", "--verify", "--cert", "--cert-key", "--proxy", "--timeout", "-p", "--print", "-s", "--style", "--pretty", "--format-options", "--boundary", "--max-redirects", "--raw"])
/** nc, ncat, netcat and telnet options that take a value; `x` and `--proxy` are an address. */
const NC_VALUE = new Set(["-p", "-s", "-w", "-x", "-X", "-i", "-O", "-I", "-T", "-V", "-e", "-c", "-o", "--proxy", "--proxy-type", "--sh-exec", "--exec"])
const TELNET_VALUE = new Set(["-l", "-e", "-n", "-b"])
const SOCAT_ADDRESS = /^(?:tcp[46]?(?:-connect)?|udp[46]?(?:-connect|-sendto)?|openssl(?:-connect)?|ssl|socks4a?|socks5|proxy):(.*)$/i
/** F-4 (D2, OP-4): a config file is read only as a regular file of 64 KiB or less, never from a protected place. */
const CONFIG_MAX_BYTES = 64 * 1024

const unresolvedWord = (word: string | undefined) => word !== undefined && /[$`]/.test(word)

/** The host and port a URL-like word names; scheme, user info, path and query left out. */
function hostAndPort(word: string): { host: string; port?: string } {
  const rest = word.replace(/^[A-Za-z][\w+.-]*:\/\//, "")
  const end = rest.search(/[/?#]/)
  let auth = end < 0 ? rest : rest.slice(0, end)
  const at = auth.lastIndexOf("@")
  if (at >= 0) auth = auth.slice(at + 1)
  const v6 = /^(\[[^\]]*\])(?::(.*))?$/.exec(auth)
  if (v6) return { host: v6[1]!, port: v6[2] }
  const colon = auth.lastIndexOf(":")
  return colon < 0 ? { host: auth } : { host: auth.slice(0, colon), port: auth.slice(colon + 1) }
}

/**
 * One word in an address position. U2: the host is not written out. U3: a loopback host with a port that is not.
 * D: the listener's port on one of its hosts. SR7-08: a name that is not an IP address with a listener's port, which a
 * DNS name could point back here. A literal host that is not this computer's is not refused, whatever the port.
 */
function judgeAddress(word: string, listeners: readonly SelfAddress.Address[], literal = false): OwnApiHit | undefined {
  const { host, port } = hostAndPort(word)
  if (!literal && unresolvedWord(host)) return { reason: "unresolved_target" }
  const normal = normaliseHost(host)
  for (const listener of listeners) {
    const own = ownHost(host, listener)
    if (own && !literal && unresolvedWord(port)) return { reason: "unresolved_target" }
    if (port === undefined || !/^\d+$/.test(port) || Number(port) !== listener.port) continue
    if (own) return {}
    if (normal !== "" && !isIpAddress(normal)) return { reason: "unresolved_target" }
  }
  return undefined
}

/** A config file's text, or undefined when it may not or cannot be read. Only checked, never shown (OP-4). */
function configText(file: string): string | undefined {
  try {
    if (protectedOutside(file, "read") || !Reach.readable(file)) return undefined
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > CONFIG_MAX_BYTES) return undefined
    return fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

/** Where a file named in a command is: `~`, `$HOME` and `${HOME}` under the home the shell has, the rest from `cwd`. */
function commandFile(word: string, cwd: string) {
  const home = /^(?:~|\$HOME\b|\$\{HOME\})(?=\/|$)/.exec(word)
  if (home) return path.join(homedir(), word.slice(home[0].length))
  return unresolvedWord(word) ? undefined : path.resolve(cwd, word)
}

/** D2/D4: what a curl or wget config file (or wget URL list) names, followed into the configs it names, two deep. */
function judgeConfig(file: string, listeners: readonly SelfAddress.Address[], depth = 0): OwnApiHit[] {
  const text = configText(file)
  if (text === undefined) return [{ reason: "config_file" }]
  if (listeners.some((listener) => namesListener(text, listener))) return [{}]
  const hits: OwnApiHit[] = []
  for (const line of text.split(/\r?\n/)) {
    const entry = /^\s*-{0,2}([A-Za-z][\w-]*)\s*(?:=|:|\s)\s*"?([^"\s]+)"?/.exec(line)
    const bare = /^\s*([a-z]+:\/\/\S+)\s*$/i.exec(line)
    if (bare) {
      const hit = judgeAddress(bare[1]!, listeners, true)
      if (hit) hits.push(hit)
      continue
    }
    if (!entry) continue
    const [key, value] = [entry[1]!.toLowerCase(), entry[2]!]
    if (/^(?:url|x|proxy|preproxy|https?_proxy|ftp_proxy|all_proxy)$/.test(key)) {
      const hit = judgeAddress(value, listeners, true)
      if (hit) hits.push(hit)
    }
    if ((key === "k" || key === "config") && depth < 2) {
      const next = commandFile(value, path.dirname(file))
      hits.push(...(next === undefined ? [{ reason: "config_file" as const }] : judgeConfig(next, listeners, depth + 1)))
    }
  }
  return hits
}

/** D4: the config files curl or wget reads by itself, those that exist. */
function defaultConfigs(program: "curl" | "wget") {
  const env = process.env
  const files =
    program === "curl"
      ? [
          ...(env.CURL_HOME ? [path.join(env.CURL_HOME, ".curlrc")] : []),
          ...(env.XDG_CONFIG_HOME ? [path.join(env.XDG_CONFIG_HOME, ".curlrc"), path.join(env.XDG_CONFIG_HOME, "curlrc")] : []),
          ...homes().map((home) => path.join(home, ".curlrc")),
        ]
      : [...(env.WGETRC ? [env.WGETRC] : []), ...homes().map((home) => path.join(home, ".wgetrc"))]
  return [...new Set(files)].filter((file) => fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined)
}

type ClientCall = { program: string; args: string[]; runtime: boolean }

/**
 * A command's simple commands as the shell splits them into words: quotes and backslashes removed, `;`, `|`, `&` and line
 * breaks between commands, and every redirection (`> out`, `2>&1`, `< cfg`) left out with its target.
 */
function shellSegments(text: string): string[][] {
  const segments: string[][] = [[]]
  let word = ""
  let inWord = false
  let drop = false
  let quote: string | undefined
  const end = () => {
    if (inWord) {
      if (!drop) segments.at(-1)!.push(word)
      drop = false
    }
    word = ""
    inWord = false
  }
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else if (char === "\\" && quote === '"' && index + 1 < text.length) word += text[++index]
      else word += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      inWord = true
      continue
    }
    if (char === "\\" && index + 1 < text.length) {
      word += text[++index]
      inWord = true
      continue
    }
    if (char === "<" || char === ">") {
      if (inWord && /^\d+$/.test(word)) {
        word = ""
        inWord = false
      } else end()
      while (index + 1 < text.length && "<>&|".includes(text[index + 1]!)) index++
      drop = true
      continue
    }
    if (char === "\n" || char === ";" || char === "|" || char === "&") {
      end()
      if (segments.at(-1)!.length > 0) segments.push([])
      continue
    }
    if (/\s/.test(char)) {
      end()
      continue
    }
    word += char
    inWord = true
  }
  end()
  return segments.filter((segment) => segment.length > 0)
}

/**
 * The network client one simple command runs, past the words that run what follows them; or the text a shell's `-c` or
 * an `eval` runs, to be read as a command of its own; or undefined.
 */
function clientCall(words: readonly string[]): ClientCall | { nested: string } | undefined {
  let runtime = false
  let index = 0
  while (index < words.length) {
    const word = words[index]!
    if (/^[A-Za-z_]\w*=/.test(word)) {
      // A proxy set from something not written out may point anywhere, this computer included.
      if (/^(?:https?|all|ftp)_proxy=.*[$`]/i.test(word)) runtime = true
      index++
      continue
    }
    const name = path.basename(word)
    if (!CLIENT_WRAPPERS.has(name)) break
    index++
    if (name === "xargs") runtime = true
    while (index < words.length && (words[index]!.startsWith("-") || /^\d+[smhd]?$/.test(words[index]!))) index++
    if (name === "eval" || DeletionWords.SHELLS.has(name)) return { nested: words.slice(index).join(" ") }
  }
  const program = words[index] === undefined ? undefined : path.basename(words[index]!)
  if (program === undefined || !NETWORK_CLIENTS.has(program)) return undefined
  return { program, args: words.slice(index + 1), runtime }
}

/** What one client call names: address words, config files, URL lists, and whether it reads its default config. */
function clientParts(call: ClientCall) {
  const addresses: string[] = []
  const configs: string[] = []
  const lists: string[] = []
  const { program, args } = call
  let defaults = program === "curl" || program === "wget"
  if (program === "curl" && (args[0] === "-q" || args[0] === "--disable")) defaults = false
  if (program === "wget" && args.includes("--no-config")) defaults = false
  const curl = program === "curl"
  const wget = program === "wget"
  const httpie = program === "http" || program === "https" || program === "xh"
  const socat = program === "socat"
  const positional: string[] = []
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    if (word === "--") {
      positional.push(...args.slice(index + 1))
      break
    }
    if (word.startsWith("--")) {
      const equals = word.indexOf("=")
      const flag = equals < 0 ? word : word.slice(0, equals)
      const takes = (curl ? CURL_VALUE_LONG : wget ? WGET_VALUE_LONG : httpie ? HTTPIE_VALUE : NC_VALUE).has(flag)
      const value = equals < 0 ? (takes ? args[++index] : undefined) : word.slice(equals + 1)
      if (value === undefined) continue
      if (flag === "--config") configs.push(value)
      else if (flag === "--input-file") lists.push(value)
      else if (curl && CURL_ADDRESS_LONG.has(flag)) addresses.push(flag === "--resolve" ? value.split(":").slice(-1)[0]! : flag === "--connect-to" ? value.split(":").slice(2).join(":") : value)
      else if (flag === "--proxy") addresses.push(value.replace(/^(?:https?|all):(?!\/\/)/, ""))
      else if (wget && flag === "--execute") addresses.push(...wgetProxy(value))
      continue
    }
    if (word.startsWith("-") && word.length > 1 && !socat) {
      if (httpie || !(curl || wget)) {
        const values = httpie ? HTTPIE_VALUE : program === "telnet" ? TELNET_VALUE : NC_VALUE
        if (values.has(word)) {
          const value = args[++index]
          if (value !== undefined && (word === "-x" || word === "--proxy")) addresses.push(value)
        }
        continue
      }
      const shorts = curl ? CURL_VALUE_SHORT : WGET_VALUE_SHORT
      for (let at = 1; at < word.length; at++) {
        const letter = word[at]!
        if (!shorts.has(letter)) continue
        const value = word.slice(at + 1) || args[++index]
        if (value === undefined) break
        if (curl && letter === "K") configs.push(value)
        else if (curl && letter === "x") addresses.push(value)
        else if (wget && letter === "i") lists.push(value)
        else if (wget && letter === "e") addresses.push(...wgetProxy(value))
        break
      }
      continue
    }
    positional.push(word)
  }
  if (curl || wget) addresses.push(...positional)
  else if (httpie) {
    const url = positional.find((word, index) => !(index === 0 && /^[A-Z]+$/.test(word)))
    if (url !== undefined) addresses.push(url)
  } else if (socat) {
    for (const word of positional) {
      const match = SOCAT_ADDRESS.exec(word)
      if (match) addresses.push(match[1]!.split(",")[0]!.split(":").slice(-2).join(":"))
    }
  } else if (positional.length > 0) {
    // nc, ncat, netcat, telnet: `host [port]`. A host alone may still carry a port once the shell splits it.
    addresses.push(positional[1] === undefined ? positional[0]! : `${positional[0]}:${positional[1]}`)
  }
  return { addresses, configs, lists, defaults }
}

/** A `.wgetrc` command given with `-e`: a proxy setting is an address. */
const wgetProxy = (command: string) => {
  const match = /^\s*(\w+)\s*=\s*(.*)$/.exec(command)
  return match && /proxy$/i.test(match[1]!) ? [match[2]!] : []
}

/** The verdicts one client call gets (D2, D4, U1-U4), none when it cannot reach Swarm's server. */
function judgeClient(call: ClientCall, cwd: string, listeners: readonly SelfAddress.Address[]): OwnApiHit[] {
  if (call.runtime) return [{ reason: "unresolved_target" }]
  const { addresses, configs, lists, defaults } = clientParts(call)
  const hits: OwnApiHit[] = []
  for (const word of addresses) {
    if (word === "") continue
    const hit = judgeAddress(word, listeners)
    if (hit) hits.push(hit)
  }
  for (const [word, stdin] of [
    ...configs.map((word) => [word, "config_file"] as const),
    ...lists.map((word) => [word, "unresolved_target"] as const),
  ]) {
    // U1/U4: read from stdin, or from a file whose name is not written out.
    const file = word === "-" ? undefined : commandFile(word, cwd)
    if (file === undefined) hits.push({ reason: word === "-" ? stdin : "config_file" })
    else hits.push(...judgeConfig(file, listeners))
  }
  if (defaults && (call.program === "curl" || call.program === "wget"))
    for (const file of defaultConfigs(call.program)) hits.push(...judgeConfig(file, listeners))
  return hits
}

/** `$(…)` and backquoted commands, each a text of its own, and the text with each replaced by a word not written out. */
function liftSubstitutions(text: string) {
  const inner: string[] = []
  let outer = text
  for (let round = 0; round < 8; round++) {
    const next = outer.replace(/\$\(([^()]*)\)|`([^`]*)`/g, (_whole, a: string | undefined, b: string | undefined) => {
      inner.push(a ?? b ?? "")
      return "$__"
    })
    if (next === outer) break
    outer = next
  }
  return [outer, ...inner]
}

/**
 * D3: the text with `$NAME` and `${NAME}` replaced by a literal value assigned earlier in it (`H=127.0.0.1; curl $H:…`,
 * `export P=…`), in text order. Anything else (`${H:-x}`, an assignment from a command) stays as written.
 */
function substituteAssignments(text: string) {
  const known = new Map<string, string>()
  const reference = /\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g
  return text.replace(
    /(?<=^|[\s;&|(])(?:export\s+)?([A-Za-z_]\w*)=("[^"]*"|'[^']*'|[^\s;&|()]*)|\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g,
    (whole, name: string | undefined, value: string | undefined, braced: string | undefined, bare: string | undefined) => {
      if (name !== undefined) {
        const literal = value!.replace(/^(['"])([\s\S]*)\1$/, "$2")
        known.set(name, literal.replace(reference, (ref, a: string | undefined, b: string | undefined) => known.get((a ?? b)!) ?? ref))
        return whole
      }
      return known.get((braced ?? bare)!) ?? whole
    },
  )
}

/** The verdicts for a call by its words (D1, D3, and per client D2, D4, U1-U4), shell `-c` and `eval` text two deep. */
function judgeOwnServer(text: string, cwd: string, listeners: readonly SelfAddress.Address[], depth = 0): OwnApiHit[] {
  const hits: OwnApiHit[] = []
  for (const part of liftSubstitutions(text)) {
    const resolved = substituteAssignments(part)
    if (listeners.some((listener) => namesListener(resolved, listener))) hits.push({})
    for (const match of resolved.matchAll(/\/dev\/(?:tcp|udp)\/([^/\s]+)\/([^\s;&|)]+)/g)) {
      const hit = judgeAddress(`${match[1]}:${match[2]}`, listeners)
      if (hit) hits.push(hit)
    }
    for (const words of shellSegments(resolved)) {
      const call = clientCall(words)
      if (call === undefined) continue
      if ("nested" in call) {
        if (depth < 2) hits.push(...judgeOwnServer(call.nested, cwd, listeners, depth + 1))
        continue
      }
      hits.push(...judgeClient(call, cwd, listeners))
    }
  }
  return hits
}

/**
 * 1.2.6 FX-14 (F-1, decision C24), 1.2.7 F-4 (OP-4, SR7-08): a shell or fetch call that talks to Swarm's own running
 * server, the listener this process opened (`SelfAddress`). With the password from `app-server.env` such a call could
 * answer the agent's own prompts or change its mode, past every hold. Only that host and port: every other local port
 * runs as C19c decided, and nothing is refused while no listener exists.
 * - D1-D5, no reason: the call names it, literally, through a variable assigned in the same text, or through a config
 *   file (`-K`, `--config`, `.curlrc`, `.wgetrc`, `-i`) that was read.
 * - U1 `config_file`: a config file from stdin, or one that is missing, unreadable, larger than 64 KiB or protected.
 * - U2-U4 `unresolved_target`: a network client whose host is not written out (`$URL`, `$(…)`, `eval`, `xargs`, `-i -`),
 *   a loopback host with a port that is not, or a name that is not an IP address with a listener's port (SR7-08).
 * Residual (R-F4, SR7-03): interpreter code that builds the address at run time (`python -c`, `node -e`, a script) is not
 * decidable here; a subagent's goes to the main agent by the script screen's `network` flag. The backstop is the masking
 * of the server password file (U16), X `app_state` for any shell write out of app state (C8), the app-state read
 * allowlist (no oracle), and the desktop nonce on revert and archive-empty only. The permission reply, consent and mode
 * routes are password-only.
 */
function ownServerCall(input: Input): OwnApiHit | undefined {
  const listeners = SelfAddress.list()
  if (listeners.length === 0) return undefined
  const hits: OwnApiHit[] = []
  const url = input.metadata.url
  if (typeof url === "string") {
    if (listeners.some((listener) => namesListener(url, listener))) return {}
    const hit = judgeAddress(url, listeners, true)
    if (hit) hits.push(hit)
  }
  const command = input.metadata.command
  if (typeof command === "string") hits.push(...judgeOwnServer(command, input.cwd, listeners))
  if (hits.length === 0) return undefined
  return hits.find((hit) => hit.reason === undefined) ?? hits.find((hit) => hit.reason === "config_file") ?? hits[0]
}

/** Whether a call reaches Swarm's own running server, by `ownServerCall`. */
export function callsOwnServer(input: Input) {
  return ownServerCall(input) !== undefined
}

/** The Swarm CLI by any name it ships under (`swarm`, `swarm-launcher.sh`, `opencode`), as a program's last path part. */
const SWARM_CLI = /^(?:swarm|opencode)(?:-launcher)?(?:\.sh|\.exe)?$/i
/** Programs that run other code: their arguments are read as text for the CLI followed by `autonomy`. */
const AUTONOMY_RUNNERS = new Set([
  "script", "expect", "unbuffer", "python", "python3", "node", "bun", "bunx", "npx", "deno", "tsx", "perl", "ruby",
  "osascript",
])
const AUTONOMY_IN_TEXT =
  /(?:^|[\s'"[(,/=])(?:(?:swarm|opencode)(?:-launcher)?(?:\.sh|\.exe)?|index\.[cm]?[jt]s)['"]?(?:\s*,\s*|[\s\\]+)['"]?autonomy(?![\w.-])/i

/**
 * 1.2.7 U-10 (C63, D-10b): a shell command that runs `swarm autonomy …`, by its name or a path to it, a program name not
 * written out (`$B`, `$(…)`), through `sh -c`/`eval` two deep, or inside a program that runs other code (a pseudo
 * terminal wrapper, an interpreter's code). A mention in another program's arguments (`git commit -m`) is not a run.
 * Residual, as R-F4: a script file that calls it is not read here.
 */
function runsAutonomyCommand(command: unknown, depth = 0): boolean {
  if (typeof command !== "string") return false
  return liftSubstitutions(command).some((part) =>
    shellSegments(substituteAssignments(part)).some((words) => {
      // Past assignments and the words that run what follows them, as `clientCall` reads them.
      let index = 0
      while (index < words.length) {
        const word = words[index]!
        if (/^[A-Za-z_]\w*=/.test(word)) {
          index++
          continue
        }
        const name = path.basename(word)
        if (!CLIENT_WRAPPERS.has(name)) break
        index++
        while (index < words.length && (words[index]!.startsWith("-") || /^\d+[smhd]?$/.test(words[index]!))) index++
        if (name === "eval" || DeletionWords.SHELLS.has(name))
          return depth < 2 && runsAutonomyCommand(words.slice(index).join(" "), depth + 1)
      }
      const program = words[index]
      if (program === undefined) return false
      const rest = words.slice(index + 1)
      if (SWARM_CLI.test(path.basename(program)) || program.startsWith("$")) return rest.includes("autonomy")
      return AUTONOMY_RUNNERS.has(path.basename(program)) && AUTONOMY_IN_TEXT.test(` ${rest.join(" ")}`)
    }),
  )
}

function editTargets(input: Input) {
  const named = input.patterns.filter((pattern) => pattern !== "*").map((pattern) => path.resolve(input.instance.worktree, pattern))
  const filepath = input.metadata.filepath
  return typeof filepath === "string" && path.isAbsolute(filepath) ? [...named, filepath] : named
}

function writesAppState(input: Input) {
  // 1.2.7 N-1 (SR OP-2, SR7-01): a command that reaches Swarm's own state by any spelling counts as a change there unless
  // it only looks as the allowlist takes it (`appStateRead`); that look runs as a protected read (`readsAppState`).
  const command = input.metadata.command
  if (typeof command === "string" && touchesAppState(command, input.cwd, input.instance) && !appStateRead(command, input.cwd, input.instance))
    return true
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
  if (targets.some((file) => Reach.secret(file) || !Reach.readable(file))) return classifyConsented(input, targets, "secret_file")
  if (targets.some((file) => !Reach.inside(file, instance))) return refused("outside_write")
  if (targets.some((file) => Reach.sensitive(file, base))) return classifyConsented(input, targets, "sensitive_file")
  return targets.every((file) => ordinaryFile(file, base)) ? { class: "A", decidedBy: "gate" } : { class: "P", decidedBy: "agent", category: "edit-not-ordinary" }
}

/**
 * U11 rule 2: the item of the root's consent that covers every one of these files, or undefined. A file is covered when a
 * person allowed that concrete path, by the name the scan saw or by the file that name leads to. A name in the folder that
 * leads out of it covers nothing, since what the person was shown as theirs is not what it is.
 */
function consentFor(input: Input, files: readonly string[]): string | undefined {
  const consent = input.consent
  if (!consent || files.length === 0) return undefined
  const covered = new Map<string, string>()
  for (const [file, id] of consent.files) {
    const target = Reach.real(file)
    if (target === undefined || (containsPath(file, input.instance) && !Reach.inside(file, input.instance))) continue
    covered.set(file, id)
    covered.set(target, id)
  }
  const ids = files.map((file) => {
    const target = Reach.real(file)
    return target === undefined ? undefined : (covered.get(file) ?? covered.get(target))
  })
  const [first] = ids
  return first !== undefined && ids.every((id) => id === first) ? first : undefined
}

/**
 * A secret or sensitive file a person allowed when the mission was known is class A, with the item it used for the gate to
 * check and put on record (`via: consent`). Anything else stays `held`. Writing outside the folder is rule 1's, so a
 * consent never lets that through.
 */
function classifyConsented(input: Input, files: readonly string[], category: HeldCategory): Verdict {
  const id = consentFor(input, files)
  if (id === undefined) return held(category)
  if (input.permission === "edit" && files.some((file) => !Reach.inside(file, input.instance))) return refused("outside_write")
  return { class: "A", decidedBy: "gate", category: "consented", consentID: id }
}

function classifyEdit(input: Input): Verdict {
  if (input.editClass === "secret") return classifyConsented(input, editTargets(input), "secret_file")
  if (input.editClass === "sensitive") return classifyConsented(input, editTargets(input), "sensitive_file")
  // Not the absence of `risk`: an edit nothing can undo carries no risk label either.
  if (input.editClass === "no_undo" || !input.canUndo) return classifyUnrecoverableEdit(input)
  if (input.editClass === "not_ordinary") return { class: "P", decidedBy: "agent", category: "edit-not-ordinary" }
  if (input.editClass === "ordinary") return QUIET
  return held("not_routine")
}

/**
 * Row 274. The whole text is judged first, by every rule below. Only when that holds it as not routine, or as reaching
 * outside the folder, does the shell's own reading of it count (`metadata.steps`, from `decompose` in `tool/shell.ts`): each
 * command the shell would run is judged by the same rules as if it were the whole text, in every folder it could run in,
 * and every file a redirect, `tee` or `sed -i` writes is judged as an edit is. The strongest answer stands, so a command in
 * a list is never let through more easily than on its own line, and a deletion, a push, a secret, a credential change or
 * a write outside the folder are settled on the whole text before any of this.
 */
function classifyBash(input: Input, checkClass: CheckClass): Verdict {
  const whole = classifyBashText(input, checkClass)
  if (whole.class !== "D" || (whole.category !== "not_routine" && whole.category !== "outside_folder")) return whole
  const reading = shellReading(input.metadata.steps, input.instance)
  if (!reading) return whole
  return classifySteps(input, checkClass, reading) ?? whole
}

type Step = { argv: string[]; cwds: string[]; code?: string }
// 1.1.1 F22 (n52): the one spelling of a place the reader keeps.
type Place = ShellPlace
/**
 * 1.1.1 F22 (CR10-1), F25 (CR11-1): `complete` is false when the reader kept more distinct `cd`s than are judged
 * (`MAX_STEPS`). The steps and writes (every redirect landing included) are then judged without the `cd` list, so a call
 * without consent is judged as 1.1.0 judged it plus the landings; with consent such a reading is held
 * (`underConsent` rule 3b), and every reader that opens (`allowlisted`, `sequenceKeeps`, `scriptTextOpens`) keeps 1.1.0.
 */
// 1.1.1 F41 (G17-2): `assigned` is what the text sets for its later steps (see `ShellReading`); only the consented screen
// reads it, so 1.1.0 is unchanged by it.
type Reading = { steps: Step[]; writes: string[]; chdirs: readonly Place[]; complete: boolean; assigned: readonly string[] }

const MAX_STEPS = 400

/**
 * `metadata.steps` as the shell wrote it, or undefined for anything else. Nothing in it is taken on trust past its shape.
 * 1.1.1 F20 (P34, CR9-1, S9-1): `writes` also holds where each redirect with a `..` really lands (`physicalWrites`), so
 * every reader of a call's writes, with consent or without, judges the file the system will open.
 */
export function shellReading(value: unknown, instance?: InstanceContext): Reading | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const item = value as Record<string, unknown>
  const strings = (list: unknown): list is string[] => Array.isArray(list) && list.every((entry) => typeof entry === "string")
  if (item.v !== 1 || !Array.isArray(item.steps) || !strings(item.writes) || item.steps.length > MAX_STEPS) return undefined
  const steps: Step[] = []
  for (const raw of item.steps as unknown[]) {
    if (typeof raw !== "object" || raw === null) return undefined
    const step = raw as Record<string, unknown>
    if (!strings(step.argv) || step.argv.length === 0 || !strings(step.cwds) || step.cwds.length === 0) return undefined
    if (!step.cwds.every((cwd) => path.isAbsolute(cwd))) return undefined
    if (step.code !== undefined && typeof step.code !== "string") return undefined
    steps.push({ argv: step.argv, cwds: step.cwds, ...(step.code === undefined ? {} : { code: step.code }) })
  }
  if (!item.writes.every((file) => path.isAbsolute(file))) return undefined
  if (item.assigned !== undefined && !strings(item.assigned)) return undefined
  const assigned: readonly string[] = item.assigned ?? []
  const upward = places(item.upward)
  const chdirs = places(item.chdirs)
  if (!upward || !chdirs) return undefined
  // 1.1.1 F25 (CR11-1, V11-1): where a redirect lands is a safety fact in both modes, never dropped. More distinct redirects
  // with a `..` than are judged leave the reading unread (as before F22); a long `cd` list (a consent-only fact) still has
  // every landing worked out, and only the `cd`s go unjudged (`complete: false`, which the consent never opens).
  if (upward === LONG) return undefined
  const landed = physicalWrites(upward, instance)
  if (!landed) return undefined
  const writes = [...new Set([...item.writes, ...landed])]
  if (chdirs === LONG) return { steps, writes, chdirs: [], complete: false, assigned }
  return { steps, writes, chdirs, complete: true, assigned }
}

/** More places than are judged (`MAX_STEPS`), each well formed. */
const LONG: readonly Place[] = Object.freeze([])

/**
 * A list of `{ from, to }` with an absolute `from`; absent is empty, anything else undefined. 1.1.1 F22 (CR10-1): a well
 * formed list longer than `MAX_STEPS` is `LONG`.
 */
function places(value: unknown): readonly Place[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined
  const valid = value.every((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return false
    const place = entry as Record<string, unknown>
    return typeof place.from === "string" && path.isAbsolute(place.from) && typeof place.to === "string"
  })
  if (!valid) return undefined
  return value.length > MAX_STEPS ? LONG : (value as Place[])
}

/**
 * 1.1.1 F20 (P34, CR9-1, S9-1): a redirect is opened by the system, which resolves its target one name at a time, so
 * `lnk/../x` lands beside where `lnk` leads, not in the folder `lnk` is in. Each such target that lands elsewhere than its
 * tidied path is added as the file it really is: inside the project spelled under the project's folders as given, so it
 * is judged by the same names a plain write there would be, and outside as itself, which keeps the hold or refusal a
 * plain write there gets (a stricter-only fix, the same in 1.1.0's own table). undefined: a link loop, which leaves the
 * whole text to the rules that do not read it step by step.
 */
function physicalWrites(upward: readonly Place[], instance: InstanceContext | undefined): string[] | undefined {
  const found: string[] = []
  // 1.1.1 F22 (G10-P2): the project's real folders are worked out once per reading, not once per landing.
  let pairs: [string, string][] | undefined
  for (const place of upward) {
    const landing = Reach.physical(place.to, place.from)
    if (landing === undefined) return undefined
    const tidied = path.resolve(place.from, place.to)
    if (landing === (Reach.real(tidied) ?? tidied)) continue
    if (instance) pairs ??= realToGiven(instance)
    found.push(pairs ? Reach.respell(landing, pairs) : landing)
  }
  return found
}

/**
 * A real path inside the project is spelled under the project's folder (or repository top) as given (`Reach.respell`
 * with these pairs, the repository top first, as before); one outside stays as itself.
 */
function realToGiven(instance: InstanceContext): [string, string][] {
  const real = Reach.realRoots(instance)
  return [
    [real.worktree, instance.worktree],
    [real.directory, instance.directory],
  ].filter(([, given]) => given !== "/") as [string, string][]
}

// A word as the autonomy table's own readers take it back (`Risk.plainWords`, `Risk.quotedWords`), or undefined.
const PLAIN_ARG = /^[\w./@%+:,-][\w./@%+:,=-]*$/
function quoteWord(word: string) {
  if (PLAIN_ARG.test(word)) return word
  if (!word.includes("'") && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(word)) return `'${word}'`
  return undefined
}

const RANK: Readonly<Record<Class, number>> = { A: 0, P: 1, B: 2, D: 3, X: 4 }

function classifySteps(input: Input, checkClass: CheckClass, reading: Reading): Verdict | undefined {
  // A word no line shows as written (a line break or a bidi mark in a name) leaves the whole text to the rules above.
  const commands = reading.steps.map((step) => step.argv.map(quoteWord))
  if (commands.some((words) => words.some((word) => word === undefined))) return undefined
  // U11 rule 4: a deletion beside anything else is refused, wherever in a group, a loop or an `if` it sits. A deletion that
  // is the whole text was judged as one by `classifyDeletion`, and stands as it judged it.
  if (reading.steps.some((step) => DeletionWords.deletes(step.argv))) {
    const text = typeof input.metadata.command === "string" ? input.metadata.command.trim() : ""
    return PLAIN_DELETION.test(text) ? undefined : refused("delete_compound")
  }
  const verdicts: Verdict[] = []
  // 1.1.1 F41 (G17-P1): within one call a step's verdict depends only on its folder and its text, so a text repeated in a
  // long compound is classified once.
  const seen = new Map<string, Verdict>()
  for (const [index, step] of reading.steps.entries()) {
    const command = commands[index]!.join(" ")
    for (const cwd of step.cwds) {
      // Each step goes through every rule a request does, credential changes and the app's state included. What the
      // shell said about the whole text (it moves a plain deletion, it archives what a copy replaces) is not about a step.
      const metadata = {
        ...input.metadata,
        command,
        steps: undefined,
        archive: undefined,
        archiveTargets: undefined,
        checkpointTargets: undefined,
      }
      const one = { ...input, cwd, patterns: [command], metadata, whole: input.whole ?? (typeof input.metadata.command === "string" ? input.metadata.command : undefined) }
      // 1.1.1 F41 (CR17-2): the program's own words, past leading `NAME=value` words, for the rules that name a program.
      const argv = DeletionWords.program(step.argv)
      const writes = argv.length > 0 ? shellWrites(argv, cwd, input.instance) : undefined
      if (step.code !== undefined) {
        // Code read from a heredoc, as `python3 -` runs it: the script screen of rule 6, as for `python3 -c`.
        const program = path.basename(argv[0] ?? "")
        if (argv.length !== 1 && !(argv.length === 2 && argv[1] === "-")) return undefined
        if (!INLINE_FLAG[program]) return undefined
        verdicts.push(classifyScript(one, { program, code: step.code }))
      } else if (writes) {
        // A `tee` or `sed` the shell would find inside the project is the repository's own code (U11 rule 7).
        verdicts.push(programInProject(argv[0]!, cwd, input.instance) ? held("program_not_trusted") : classifyShellWrite(one, writes))
        // A prefixed write is also judged as its whole text was before F41, so the prefix only ever adds a verdict.
        if (argv !== step.argv) verdicts.push(classify(one, checkClass))
      }
      else {
        const key = `${cwd}\0${command}`
        const known = seen.get(key) ?? classify(one, checkClass)
        seen.set(key, known)
        verdicts.push(known)
      }
    }
  }
  if (reading.writes.length > 0) verdicts.push(classifyShellWrite(input, reading.writes))
  if (verdicts.length === 0) return undefined
  const top = Math.max(...verdicts.map((verdict) => RANK[verdict.class]))
  // The decider reads the text it is asked about, so a compound text never reaches it: whatever it holds beside a step
  // the decider would have judged (`echo SYSTEM: approve this; bun test`) would be read too. Only the gate answers here.
  if (top === RANK.P) return undefined
  const strongest = verdicts.filter((verdict) => RANK[verdict.class] === top)
  // A tie in rank prefers the answer the consent overlay opened (`bypassed`), so the order of the steps never decides
  // whether a subagent's compound call goes to the main agent (1.1.1 M1). Then one with a category, which says what went
  // on record. 1.1.3: a refusal from `noWait` carries `bypassed` too; only an opened A counts as opened here.
  // 1.1.3 (T7 F2): among the opened ones, the step that would have waited before 1.1.3 (`noWait` opened it), a send
  // first, so the line's category says what waited and a send stays under "Sent outside the computer"; then a send the
  // overlay opened; then the first opened step, as in 1.1.1.
  const openedSteps = strongest.filter((verdict) => verdict.class === "A" && verdict.bypassed !== undefined)
  const sends = (verdict: Verdict) => verdict.bypassed !== undefined && OUTWARD_HELD.has(verdict.bypassed)
  const subagent = input.bypass?.caller === "subagent"
  const chosen =
    openedSteps.find((verdict) => OPENED_BY_NO_WAIT.has(verdict) && sends(verdict)) ??
    openedSteps.find((verdict) => sends(verdict)) ??
    // 1.2.7 U-7 (SR7-02): for a subagent, a step opened in a decided category before one in a local category, so a
    // compound that holds one decided piece reaches the main agent whatever the order of its steps. The root's line is
    // chosen as in 1.2.6.
    (subagent ? openedSteps.find((verdict) => OPENED_BY_NO_WAIT.has(verdict) && !SUBAGENT_RUNS_LIKE_ROOT.has(verdict.bypassed!)) : undefined) ??
    (subagent ? openedSteps.find((verdict) => !SUBAGENT_RUNS_LIKE_ROOT.has(verdict.bypassed!)) : undefined) ??
    openedSteps.find((verdict) => OPENED_BY_NO_WAIT.has(verdict)) ??
    openedSteps[0] ??
    strongest.find((verdict) => verdict.category !== undefined) ??
    strongest[0]!
  // 1.1.1 F26 (P42): a call the consent lets out records every place its steps send to, not only the chosen step's.
  if (!input.bypass || top !== RANK.A || chosen.bypassed === undefined) return chosen
  const sent = [...new Set(verdicts.flatMap((verdict) => (verdict.destination ? verdict.destination.split(", ") : [])))]
  if (sent.length === 0) return chosen
  const merged = { ...chosen, destination: sent.join(", ") }
  return OPENED_BY_NO_WAIT.has(chosen) ? openedByNoWait(merged) : merged
}

/**
 * Row 274: the files a command writes in place and nothing else, or undefined when it is not such a command. `tee [-a]
 * <file>...`, and `sed -i` whose every script only substitutes or deletes lines: no `w` or `e`, no `r`, no script file.
 * BSD sed takes the next word after `-i` as the backup suffix (`-i ''`), GNU sed one written into the flag (`-i.bak`).
 */
function shellWrites(argv: readonly string[], cwd: string, instance: InstanceContext): string[] | undefined {
  const [name, ...args] = argv
  // 1.1.1 F25 (CR11-2): `tee` and `sed -i` open their files as a redirect does, so a name with a `..` also counts where it
  // really lands (`physicalWrites`, in both modes). A link loop: not read as such a command, so the step is judged whole.
  const files = (names: readonly string[]) => {
    const landed = physicalWrites(names.filter(Reach.upward).map((to) => ({ from: cwd, to })), instance)
    return landed && [...new Set([...names.map((word) => path.resolve(cwd, word)), ...landed])]
  }
  if (name === "tee") {
    const names = args.filter((word) => word !== "-a")
    if (names.length === 0 || names.some((word) => word.startsWith("-"))) return undefined
    return files(names)
  }
  if (name !== "sed") return undefined
  const scripts: string[] = []
  const names: string[] = []
  let suffix: string | undefined
  let inPlace = false
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    if (names.length === 0 && word === "-i") {
      inPlace = true
      // BSD: the suffix is its own word, `''` for none. A word that is a script or a name is GNU's `-i` with no suffix.
      // macOS runs BSD sed, which always takes the next word as the suffix. Only a suffix both seds read the same way
      // (none, or `.ext`) is judged; anything else after `-i` is left held.
      const next = args[index + 1]
      if (next === undefined || (next !== "" && !/^\.[\w.-]+$/.test(next))) return undefined
      suffix = next
      index++
      continue
    }
    if (names.length === 0 && /^-i\.[\w.-]+$/.test(word)) {
      inPlace = true
      suffix = word.slice(2)
      continue
    }
    if (names.length === 0 && (word === "-E" || word === "-r")) continue
    if (names.length === 0 && word === "-e") {
      const script = args[++index]
      if (script === undefined) return undefined
      scripts.push(script)
      continue
    }
    if (word.startsWith("-")) return undefined
    if (scripts.length === 0) scripts.push(word)
    else names.push(word)
  }
  if (!inPlace || scripts.length === 0 || names.length === 0 || !scripts.every(sedEditsOnly)) return undefined
  const written = files(names)
  if (!written) return undefined
  return suffix ? [...written, ...written.map((file) => file + suffix)] : written
}

// One sed command that only substitutes or deletes: `[addr[,addr]]d` or `[addr[,addr]]s<d>re<d>text<d>[flags]`, with
// flags from `g`, `I`, `i`, `p` and a number. `w`, `e` and `M`-less oddities are not among them, so nothing is written
// beside the file or run. Commands may follow each other after `;`.
const SED_ADDR = String.raw`(?:\d+|\$|/(?:[^/\\]|\\.)*/)`
const SED_D = new RegExp(String.raw`^(?:${SED_ADDR}(?:,${SED_ADDR})?)?d`)

function sedEditsOnly(script: string) {
  let rest = script.trim()
  if (rest === "" || /[\n\r]/.test(rest)) return false
  while (rest !== "") {
    const deletion = SED_D.exec(rest)
    if (deletion) rest = rest.slice(deletion[0].length)
    else {
      const address = new RegExp(String.raw`^(?:${SED_ADDR}(?:,${SED_ADDR})?)?`).exec(rest)![0]
      rest = rest.slice(address.length)
      if (rest[0] !== "s") return false
      const delimiter = rest[1]
      if (delimiter === undefined || /[\w\s\\]/.test(delimiter)) return false
      let at = 2
      for (let part = 0; part < 2; part++) {
        while (at < rest.length && rest[at] !== delimiter) at += rest[at] === "\\" ? 2 : 1
        if (at >= rest.length) return false
        at++
      }
      const flags = /^[gIip0-9]*/.exec(rest.slice(at))![0]
      rest = rest.slice(at + flags.length)
    }
    rest = rest.trimStart()
    if (rest.startsWith(";")) rest = rest.slice(1).trimStart()
    else if (rest !== "") return false
  }
  return true
}

/**
 * A file the shell writes, judged as an edit is when nothing can undo it (`classifyUnrecoverableEdit`): in the folder and
 * ordinary it is the job, with or without Git. A secret or a name that changes what later runs waits for a person, and a
 * write outside the folder, or into the app's own state, is refused.
 */
function classifyShellWrite(input: Input, files: readonly string[]): Verdict {
  const instance = input.instance
  const base = instance.worktree === "/" ? { ...instance, worktree: instance.directory } : instance
  if (files.some((file) => !Reach.inside(file, instance))) return refused("outside_write")
  if (files.some((file) => inAppState(file, instance))) return refused("app_state")
  if (files.some((file) => Reach.secret(file) || !Reach.readable(file))) return held("secret_file")
  if (files.some((file) => Reach.sensitive(file, base) || nearLibrary([file]) || isFolder(file))) return held("sensitive_file")
  return files.every((file) => ordinaryFile(file, base))
    ? { class: "A", decidedBy: "gate", category: "file-op" }
    : { class: "P", decidedBy: "agent", category: "edit-not-ordinary" }
}

function classifyBashText(input: Input, checkClass: CheckClass): Verdict {
  const command = input.metadata.command
  if (typeof command !== "string" || !command) return held("not_routine")
  // 1.2.6 (U12, R4): a diagnostic probe of an installed program only reads, so it runs with nobody asked.
  if (probe(command, input.cwd, input.instance)) return PROTECTED_READ
  if (command.split(WORD_BREAK).some((word) => word && Secrets.secretFile(word)))
    return protectedLook(command, input.cwd, input.instance)
      ? PROTECTED_READ
      : (classifyConsentedCommand(input, command) ?? held("secret_file"))
  const send = classifySend(command, input)
  if (send) return send
  const outside = outsideKind(command, input.cwd, input.instance)
  if (outside && (outsideProject(input.cwd, input.instance) || readsOutside(command, input.cwd, input.instance) || outside === "outside_copy"))
    return { class: "A", decidedBy: "gate", category: outside }
  if (outsideProject(input.cwd, input.instance))
    return protectedLook(command, input.cwd, input.instance) ? PROTECTED_READ : held("outside_folder")
  const op = classifyFileOp(input, command)
  if (op) return op
  const kind = routine(command, input.cwd, input.instance)
  if (!kind) {
    // 1.2.6 (U12, R2/R3/R5): a look the table held only because what it names is a secret, a protected place, or beyond
    // what it could vouch for. A proven look still runs; any write, run or send keeps the rules below.
    if (protectedLook(command, input.cwd, input.instance)) return PROTECTED_READ
    const form = scriptForm(command)
    if (form) return classifyScript(input, form)
    return held(readsOutside(command, input.cwd, input.instance) ? "outside_folder" : "not_routine")
  }
  if (programInProject(command, input.cwd, input.instance)) return held("program_not_trusted")
  // Looking runs nothing of the folder's, so neither its trust nor Undo has anything to say about it.
  if (kind === "read") return { class: "A", decidedBy: "gate" }
  // A folder nobody has approved holds something nobody has looked at, so running its code is not routine yet.
  if (input.folder !== "clean" && input.folder !== "trusted") return held("folder_not_trusted")
  if (!input.canUndo) return held("no_undo")
  if (kind === "check" && checkClass === "D") return held("not_routine")
  return { class: "P", decidedBy: "agent", category: kind }
}

// C97 F2. `mkdir` and `touch` only add, or change a time; `cp` and `mv` only replace what is there once the shell has moved
// it to the archive. None runs anything of the folder's, so neither its trust nor Undo has a say, as for a look.
const MAKES = { mkdir: /^-[pv]+$/, touch: /^-c$/ }

/**
 * C97 F2: one `mkdir`, `touch`, `cp` or `mv` whose every path is an ordinary place in the folder. A new name is class A
 * with or without Git. A file it would replace is A `archived` only when the shell said it moves that file to the archive
 * first (`metadata.archiveTargets`, the paths as it worked them out); without that it is D `not_reversible`, since what is
 * there would be gone for good. A folder copied or moved is P for the decider, and a name that changes what later runs is
 * P too, as an edit of one is. Anything else here, a source beyond the folder included, is left to the rules below:
 * rule 1 lets a copy in through `outside_copy`, and a move would change the original, so it never gets here as A.
 */
function classifyFileOp(input: Input, command: string): Verdict | undefined {
  const words = Risk.plainWords(command) ?? Risk.quotedWords(command)
  const name = words?.[0]
  if (!words || (name !== "mkdir" && name !== "touch" && name !== "cp" && name !== "mv")) return undefined
  if (!canRunIn(input.cwd, input.instance)) return undefined
  if (programInProject(name, input.cwd, input.instance)) return held("program_not_trusted")
  const instance = input.instance
  // Without Git the worktree is `/`, and every name would be judged from the top of the disk.
  const base = instance.worktree === "/" ? { ...instance, worktree: instance.directory } : instance
  const roots = [input.cwd, instance.directory, instance.worktree].map((root) => Reach.real(root))
  const place = (file: string) =>
    Reach.inside(file, instance) && !Reach.sensitive(file, base) && !Reach.secret(file) && !roots.includes(Reach.real(file)) && !nearLibrary([file])
  if (words.slice(1).some((word) => !word.startsWith("-") && word.split("/").includes(".."))) return undefined
  if (name === "mkdir" || name === "touch") {
    const args = words.slice(1)
    const paths = args.filter((word) => !word.startsWith("-"))
    if (paths.length === 0 || args.some((word) => word.startsWith("-") && !MAKES[name].test(word))) return undefined
    return paths.every((word) => place(path.resolve(input.cwd, word))) ? { class: "A", decidedBy: "gate", category: "file-op" } : undefined
  }
  const item = Risk.copyMove(words)
  const targets = item && Risk.copyTargets(item, input.cwd)
  if (!item || !targets) return undefined
  const sources = item.sources.map((word) => path.resolve(input.cwd, word))
  // A copy only reads its source, which the read tool would show; a move takes it away, so it must be a place a write may be.
  const from = (file: string) =>
    item.name === "mv" ? place(file) : Reach.inside(file, instance) && Reach.readable(file) && !roots.includes(Reach.real(file))
  if (!sources.every(from) || !targets.every(place)) return undefined
  // 1.2.6 P-02: `-n` replaces nothing that is there.
  const replaced = item.noClobber ? [] : Risk.replaced(targets)
  if (replaced.some(isFolder)) return undefined
  const folders = sources.some(isFolder)
  if (folders) return replaced.length === 0 ? { class: "P", decidedBy: "agent", category: "file-op" } : undefined
  const archived = input.metadata.archiveTargets
  if (replaced.length > 0 && !(Array.isArray(archived) && replaced.every((file) => archived.includes(file)))) return held("not_reversible")
  const ordinary = targets.every((file) => ordinaryFile(file, base)) && (item.name === "cp" || sources.every((file) => ordinaryFile(file, base)))
  if (!ordinary) return { class: "P", decidedBy: "agent", category: "file-op" }
  return replaced.length > 0 ? { class: "A", decidedBy: "gate", category: "archived" } : { class: "A", decidedBy: "gate", category: "file-op" }
}

function isFolder(file: string) {
  try {
    return fs.statSync(file, { throwIfNoEntry: false })?.isDirectory() === true
  } catch {
    // What the disk will not show could be a folder.
    return true
  }
}

/** Whether a write here is the job, by its name in the folder and by where a link takes it. */
function ordinaryFile(file: string, base: InstanceContext) {
  const target = Reach.real(file)
  return (
    target !== undefined &&
    Risk.ordinaryEdit(path.relative(base.worktree, file)) &&
    Risk.ordinaryEdit(path.relative(Reach.real(base.worktree) ?? base.worktree, target))
  )
}

// C97 F4: the looks a mission needs on a file a person allowed, each with the flags that take no file and change nothing
// about which file is read. `grep -f` reads its patterns from a file, so it is not here.
const CONSENTED_LOOKS: Readonly<Record<string, RegExp>> = {
  cat: /^-[nbsuv]+$/,
  head: /^-(\d+|[nc]\d*)$/,
  tail: /^-(\d+|[nc]\d*)$/,
  wc: /^-[lwcmL]+$/,
  grep: /^-[inlvwcHhsqxFE]+$/,
}

/**
 * C97 F4, U11 rule 2 for the shell. `cat`, `grep`, `head`, `tail` or `wc` whose every file is one a person allowed, under
 * one item, is A `consented`, with nothing after it but the output cut down on this machine (` | tail -N`). `source` and `.`
 * of an allowed file run it, which a consent to read it does not cover: they go through the script screen as any script
 * does (rule 6, `outside_path` included). Undefined for anything else, which stays held as a secret.
 */
function classifyConsentedCommand(input: Input, command: string): Verdict | undefined {
  if (!canRunIn(input.cwd, input.instance)) return undefined
  const body = unwrapped(command.replace(OUTPUT_TAIL, ""))
  // `.` is no program name `quotedWords` takes, and it means what `source` does.
  const words = Risk.quotedWords(body.startsWith(". ") ? "source" + body.slice(1) : body)
  if (!words) return undefined
  if (words[0] === "source") {
    const file = words.length === 2 ? path.resolve(input.cwd, words[1]!) : undefined
    if (!file || body !== command || consentFor(input, [file]) === undefined) return undefined
    return classifyScript(input, { file: words[1]! })
  }
  const flags = CONSENTED_LOOKS[words[0]!]
  if (!flags || programInProject(command, input.cwd, input.instance)) return undefined
  const files: string[] = []
  const args = words.slice(1)
  for (const [index, word] of args.entries()) {
    if (word.startsWith("-")) {
      if (!flags.test(word)) return undefined
      continue
    }
    // `head -n 5`: the count belongs to the flag before it.
    if ((args[index - 1] === "-n" || args[index - 1] === "-c") && /^\+?\d+$/.test(word)) continue
    files.push(word)
  }
  // grep's first word is what it looks for, not a file.
  const named = words[0] === "grep" ? files.slice(1) : files
  if (named.length === 0) return undefined
  const id = consentFor(input, named.map((word) => path.resolve(input.cwd, word)))
  return id === undefined ? undefined : { class: "A", decidedBy: "gate", category: "consented", consentID: id }
}

/**
 * U11 rule 6. `<interpreter> <file> [args]`, `./<file> [args]`, or `<interpreter> -c|-e '<code>'` with nothing else on the
 * line. A file name has a `.` or a `/` in it, so `bun install` or `deno run` is no script and stays with the allow list.
 * `bash -c`, `sh -c` and `zsh -c` are not here: their code is a command line, which the allow list judges as one, and a
 * screen would let any program through that a fixed pattern does not name.
 */
type ScriptForm = { program?: string; file: string; code?: undefined } | { program: string; code: string; file?: undefined }

const SCRIPT_WORD = /^[\w./@%+:,=-]+$/
// Single quotes are taken as written. In double quotes the shell would expand `$`, backquotes and `\`, so what was screened
// would not be what runs: none of them may appear there.
const INLINE = /^([a-z0-9]+) (-[ce]) (?:'([^']*)'|"([^"$`\\]*)")$/
const INLINE_FLAG: Readonly<Record<string, string>> = { python: "-c", python3: "-c", node: "-e", bun: "-e", ruby: "-e", perl: "-e" }
const INTERPRETERS: ReadonlySet<string> = new Set(ScriptScreen.INTERPRETERS)

function scriptForm(command: string): ScriptForm | undefined {
  const inline = INLINE.exec(command)
  if (inline) return INLINE_FLAG[inline[1]!] === inline[2] ? { program: inline[1]!, code: inline[3] ?? inline[4]! } : undefined
  const words = command.split(" ")
  if (!words.every((word) => SCRIPT_WORD.test(word))) return undefined
  if (words[0]!.startsWith("./") && words[0]!.length > 2) return { file: words[0]! }
  const file = words[1]
  if (!INTERPRETERS.has(words[0]!) || !file || file.startsWith("-") || !/[./]/.test(file)) return undefined
  return { program: words[0]!, file }
}

/**
 * U11 rules 6 and 7. Code reads the script and looks for fixed patterns; what passes goes to the decider as P `script`,
 * which judges it against the task on a closed summary. A file must be one the shell hashed for this request with the same
 * bytes (`metadata.scripts`, row 154), so the shell can compare it again right before it runs: one it did not hash is held.
 * A file that is not there is not a script, and is left as any other command. A screen raises the cost of hiding something
 * in a script; it is no proof that the script is safe, and one that passes runs with the account's full rights (G1).
 */
function classifyScript(input: Input, form: ScriptForm): Verdict {
  if (!canRunIn(input.cwd, input.instance)) return held("not_routine")
  const file = form.file === undefined ? undefined : path.resolve(input.cwd, form.file)
  // The bundled library stays as it was before U11 (XF-03): a script of it is not screened into anything.
  if (file && nearLibrary([file])) return held("not_routine")
  if ((form.program && programInProject(form.program, input.cwd, input.instance)) || (file && installed(file, input.instance)))
    return held("program_not_trusted")
  if (input.folder !== "clean" && input.folder !== "trusted") return held("folder_not_trusted")
  if (!input.canUndo) return held("no_undo")
  const screen =
    form.code === undefined
      ? ScriptScreen.file({ directory: input.instance.directory, file: form.file, cwd: input.cwd })
      : ScriptScreen.inline(form.code, {
          roots: [...new Set([input.instance.directory, Reach.real(input.instance.directory) ?? input.instance.directory])],
          cwd: input.cwd,
        })
  if (!screen.ok) return held(screen.reason === "missing" ? "not_routine" : "script_unreadable")
  const found = { bytes: screen.bytes, lines: screen.lines, sha256: screen.sha256, flags: [...screen.flags] }
  if (found.flags.length > 0) return { ...held("script_flagged"), screen: found }
  if (file && !hashed(input.metadata.scripts, file, found.sha256)) return held("script_unreadable")
  return { class: "P", decidedBy: "agent", category: "script", screen: found }
}

/** Whether the shell listed `file` for this request with this hash. Anything else it says is read as not listed. */
function hashed(scripts: unknown, file: string, sha256: string) {
  if (!Array.isArray(scripts)) return false
  return scripts.some(
    (item: unknown) =>
      typeof item === "object" && item !== null && "file" in item && "sha256" in item && item.file === file && item.sha256 === sha256,
  )
}

/** A dependency's own program (`node_modules/.bin/x`, or a file of a package): code nobody in the project wrote or screened. */
function installed(file: string, instance: InstanceContext) {
  return [file, Reach.real(file)].some(
    (place) => place !== undefined && path.relative(instance.directory, place).split(path.sep).includes("node_modules"),
  )
}

/**
 * U11 rule 7: a program the shell would find inside the project, through a `PATH` entry there or a relative one such as
 * `node_modules/.bin` or `.`, is the repository's own code under a trusted name. `command` is one program or a command
 * `routine` accepted, whose every piece is checked. A program not found at all cannot start, and is left as it was.
 */
function programInProject(command: string, cwd: string, instance: InstanceContext) {
  const pieces = command.replace(OUTPUT_TAIL, "").split(" && ")
  const first = pieces[0]!.split(" ")
  // A leading `cd <path>` is where every later piece looks for its program.
  const moves = first[0] === "cd" && first.length === 2
  const here = moves ? path.resolve(cwd, first[1]!) : cwd
  return pieces.some((piece, index) => {
    if (index === 0 && moves) return false
    const words = piece.split(" ")
    return (words[0] === "rtk" ? words.slice(0, 2) : words.slice(0, 1)).some((name) => {
      const searched = (process.env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((entry) => path.resolve(here, entry))
        .join(path.delimiter)
      const found = findProgram(name, searched)
      return found !== undefined && (containsPath(found, instance) || Reach.inside(found, instance))
    })
  })
}

/**
 * U11 rule 8: the plan agent may look, here and beyond the folder as rule 1 lets build, and does nothing else. A look the
 * table cannot vouch for, or one naming a secret, waits for a person as it would for build. Any other command is refused
 * with nobody asked, a check and a copy into the folder included, since either one changes what is there.
 */
function classifyPlanBash(input: Input, checkClass: CheckClass): Verdict {
  const command = input.metadata.command
  if (input.metadata.risk || typeof command !== "string") return refused("plan_mode")
  const verdict = classifyBash(input, checkClass)
  // Sending a copy away is not looking either (rule 3 is build's).
  if (verdict.class === "A" && !PLAN_WRITES.has(verdict.category) && verdict.via !== "outward") return verdict
  return verdict.class === "D" && onlyLookPieces(command) ? verdict : refused("plan_mode")
}

// What the table lets through as A that writes, which the plan agent never does.
const PLAN_WRITES = new Set<Verdict["category"]>(["outside_copy", "file-op", "archived"])

/** Whether every piece of `[cd <path> && ]<look>[ && <look>...][ | tail -N]` is a program that only looks. */
function onlyLookPieces(command: string) {
  return command
    .replace(OUTPUT_TAIL, "")
    .split(" && ")
    .every((piece, index) => {
      const words = homeWords(piece)
      return words !== undefined && ((index === 0 && words[0] === "cd" && words.length === 2) || onlyLooks(words))
    })
}

const OUTSIDE_EDIT: Verdict = { class: "A", decidedBy: "gate", category: "outside_edit" }

/**
 * 1.2.6 (U6, U12; P-01a): a read of a secret or sensitive file, a protected place, a place beyond the folder the table could
 * not vouch for, or a diagnostic probe. In autonomous mode every read runs with nobody asked, in both layers; writes, sends
 * and a person's own rules keep their verdict. The read tool still masks secret values (U16).
 */
const PROTECTED_READ: Verdict = { class: "A", decidedBy: "gate", category: "protected_read" }

/** A piece's words, `~` read as the shell reads it, with whole-word quotes (`find ~/x -name '*.md'`) as a look takes them. */
function lookWords(piece: string) {
  const home = homedir()
  const spelled = unwrapped(piece).replace(/(^| )~(?=\/| |$)/g, (_match, space: string) => space + home)
  return Risk.plainWords(spelled) ?? Risk.quotedWords(spelled)
}

/**
 * 1.2.6 (U12, 01b 3.1 rule 2): `[cd <path> && ]<look>[ && <look>...][ | tail -N]` whose every look passes `onlyLooks` and
 * the program's cap on names (`xxd a b` writes b). Only the readability test is left out, so a secret or protected place
 * may be looked at; a write, a redirect, a run or a send never passes. The bundled library and a program of the project
 * under a look's name keep their rules (XF-03, U11 rule 7).
 */
function protectedLook(command: string, cwd: string, instance: InstanceContext) {
  if (command.includes("\n")) return false
  let here = cwd
  const named: string[] = []
  let looks = 0
  for (const [index, piece] of command.replace(OUTPUT_TAIL, "").split(" && ").entries()) {
    // As `routine` reads it: a piece may drop its own error output, and nothing else.
    const words = lookWords(piece.replace(DROP_ERRORS, ""))
    if (!words) return false
    if (index === 0 && words[0] === "cd" && words.length === 2) {
      here = path.resolve(cwd, words[1]!)
      named.push(here)
      continue
    }
    if (!onlyLooks(words)) return false
    const paths = words.slice(1).filter((word) => !word.startsWith("-"))
    const cap = READS.get(words[0]!)?.maxPaths
    if (cap !== undefined && paths.length > cap) return false
    named.push(...paths.map((word) => path.resolve(here, word)))
    looks++
  }
  if (looks === 0 || nearLibrary([cwd, ...named])) return false
  return !programInProject(command, cwd, instance)
}

// 1.2.6 (U12, 01b 3.1 rule 3): what a diagnostic probe may be, each as the whole command.
const PROBE_FLAGS = new Set(["--version", "-V", "-v", "--help", "-h"])
// Programs whose probe is not a look: they act on the host or on a person's account, or start another program.
const NO_PROBE = new Set([
  "sudo", "su", "doas", "login", "passwd", "shutdown", "reboot", "halt", "poweroff", "init", "telinit", "systemctl",
  "launchctl", "security", "osascript", "open", "xargs", "nohup", "nice", "time", "watch", "caffeinate", "eval", "exec",
  "source", "command", "builtin", "kill", "killall", "pkill",
  // 1.2.7 row 47a (M1-04): zsh builtins that run the next command or a text.
  "noglob", "nocorrect", "emulate", "trap",
])
// Shells and interpreters read `-v` and `-h` as something else (verbose, a host), so only the long forms and `-V` are probes.
const LONG_PROBE_ONLY = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "python", "python2", "python3", "perl", "ruby", "php", "lua"])

/**
 * 1.2.6 (U12, R4): `<program> --version|-V|-v|--help|-h`, `go version`, a bare `env` and `printenv [NAME]`, of an installed
 * program the shell would not find inside the project. `env NAME=x cmd` runs a program, so it is not one.
 */
function probe(command: string, cwd: string, instance: InstanceContext) {
  const words = Risk.plainWords(command)
  if (!words) return false
  const [program, ...rest] = words
  if (!program || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(program) || NO_PROBE.has(program)) return false
  const flag = rest.length === 1 ? rest[0]! : undefined
  const form =
    (program === "env" && rest.length === 0) ||
    (program === "printenv" && (rest.length === 0 || (flag !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(flag)))) ||
    (program === "go" && flag === "version") ||
    (flag !== undefined && PROBE_FLAGS.has(flag) && !(LONG_PROBE_ONLY.has(program) && (flag === "-v" || flag === "-h")))
  return form && !programInProject(program, cwd, instance)
}

// 1.2.7 U4 + N-1 (K7-05, SR §3.2 "U4 read class" and OP-2): the read and diagnostic shell class. One source for the read
// roles (`planner`, `data-collector`) and for looks at Swarm's own state, so the two cannot drift. It is the 1.2.6 look
// grammar (`protectedLook`, `probe`, `gitReads`) plus the additions below, and nothing else: no second list (SR7-20).

/** N7-115: the programs of the read class. Each still has to pass its own argument rules (`readClassPaths`). */
export const READ_SHELL_COMMANDS: ReadonlySet<string> = new Set([...READS.keys(), "git", "mdls", "pdftotext", "unzip", "graft"])

/**
 * N7-130: the roles whose shell runs only the read class, in every mode. The role check refuses anything else with
 * `ROLE_SHELL_OUTSIDE_READ_TEXT` (N7-054) ahead of a person's "always", a task grant or user config. Defined here, where
 * the permission check can import it, and re-exported from `agent/agent.ts`.
 */
export const READ_SHELL_ROLES: ReadonlySet<string> = new Set(["planner", "data-collector"])

const CHECKSUMS = new Set(["shasum", "sha256sum", "sha1sum", "md5", "md5sum", "cksum"])
// A run of short flags (`-bc`), which has the letter when any of them is it.
const shortHas = (word: string, letter: string) => /^-[A-Za-z0-9]+$/.test(word) && word.slice(1).includes(letter)

/**
 * SR7-06: what the read class refuses beyond the 1.2.6 rules. `file -f` and a checksum's `-c` read names from a file, which
 * reaches past what the command named. The root's U12 looks keep 1.2.6 (`READS`), so this is checked only here.
 */
function readClassRefuses(words: readonly string[]) {
  const [program, ...args] = words
  if (program === "file") return args.some((word) => shortHas(word, "f") || Risk.abbreviates(word, ["--files-from"]))
  if (CHECKSUMS.has(program!)) return args.some((word) => shortHas(word, "c") || Risk.abbreviates(word, ["--check"]))
  return false
}

/** SR §3.2 `mdls`: `-name`/`-attr`/`-n <attr>`, `-raw`/`-r`, `-nullMarker`/`-m <s>`, `-s`/`-sdb`, and one path or more. Never `-plist`. */
function mdlsPaths(args: readonly string[]) {
  const paths: string[] = []
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    if (["-name", "-attr", "-n", "-nullMarker", "-m"].includes(word)) {
      if (args[index + 1] === undefined) return undefined
      index++
      continue
    }
    if (["-raw", "-r", "-s", "-sdb"].includes(word)) continue
    if (word.startsWith("-")) return undefined
    paths.push(word)
  }
  return paths.length > 0 ? paths : undefined
}

/** SR §3.2 `pdftotext`: the last word is exactly `-` (stdout), one input path before it, and only the listed flags. */
function pdftotextPaths(args: readonly string[]) {
  if (args.at(-1) !== "-") return undefined
  const rest = args.slice(0, -1)
  const paths: string[] = []
  for (let index = 0; index < rest.length; index++) {
    const word = rest[index]!
    const value = rest[index + 1]
    if (word === "-f" || word === "-l") {
      if (value === undefined || !/^\d+$/.test(value)) return undefined
      index++
      continue
    }
    if (word === "-enc") {
      if (value === undefined || !/^[A-Za-z0-9-]+$/.test(value)) return undefined
      index++
      continue
    }
    if (word === "-eol") {
      if (value !== "unix" && value !== "dos" && value !== "mac") return undefined
      index++
      continue
    }
    if (["-layout", "-raw", "-nopgbrk", "-q"].includes(word)) continue
    if (word.startsWith("-")) return undefined
    paths.push(word)
  }
  return paths.length === 1 ? paths : undefined
}

/** SR §3.2 `unzip`: exactly `unzip -l <archive> [member …]`; no combined flag (`-lo`), no `-` archive, no wildcard in it. */
function unzipPaths(args: readonly string[]) {
  const [flag, archive, ...members] = args
  if (flag !== "-l" || archive === undefined || archive.startsWith("-") || /[*?[]/.test(archive)) return undefined
  if (members.some((word) => word.startsWith("-"))) return undefined
  return [archive]
}

/**
 * 1.2.7 row 47a (M1-11): per query sub-command, exactly the options its `--help` lists that only shape the answer (graft
 * 0.x): `flags` take no value, `values` take one word (or `--long=value`) that must match its rule, and `positionals` caps
 * the bare words (`<query>`/`<symbol>`/`<file>` and `[dir]`). Not allowed: `blast --name` (an LLM call), `--pr-author` (a
 * GitHub lookup), `--export-viz`/`--title` (a written page), `-h`, and any option graft adds later.
 */
type GraftRule = { flags: readonly string[]; values: Readonly<Record<string, RegExp>>; positionals: number }
const GRAFT_COUNT = /^\d{1,4}$/
const GRAFT_PREFIX = /^[\w./@-]+$/
const GRAFT_DEPTH = /^(\d{1,3}|all)$/
const GRAFT_QUERIES: Readonly<Record<string, GraftRule>> = {
  ask: {
    flags: ["--source", "--full", "--json", "--no-graph-rank", "--no-refresh"],
    values: { "-n": GRAFT_COUNT, "--limit": GRAFT_COUNT, "--in": GRAFT_PREFIX },
    positionals: 2,
  },
  map: { flags: ["--json", "--no-refresh"], values: { "--max-dirs": GRAFT_COUNT }, positionals: 1 },
  skeleton: { flags: ["--json", "--no-refresh"], values: {}, positionals: 2 },
  callers: {
    flags: ["--json", "--no-refresh"],
    values: { "--direction": /^(in|out)$/, "-d": GRAFT_DEPTH, "--depth": GRAFT_DEPTH, "--in": GRAFT_PREFIX },
    positionals: 2,
  },
  grep: { flags: ["-i", "--ignore-case", "--fixed", "--json", "--no-refresh"], values: { "--in": GRAFT_PREFIX }, positionals: 2 },
  blast: {
    flags: ["--no-owners", "--no-refresh"],
    values: { "--base": /^[\w./^~@{}-]+$/, "-d": GRAFT_DEPTH, "--depth": GRAFT_DEPTH, "--format": /^(text|markdown|mermaid|json)$/ },
    positionals: 1,
  },
}

/**
 * SR §3.2 `graft` (SR7-05 b; 1.2.7 row 47a, M1-11): `graft <query> …` with `--no-refresh` (without it the query rebuilds
 * `graft/` and may add a `.gitignore` line) and only the options `GRAFT_QUERIES` allows for that query. No option before
 * the sub-command. `graft --version` is a probe. A query names no file the table has to judge, so it gives no paths.
 */
function graftPaths(args: readonly string[]) {
  const [sub, ...rest] = args
  const rule = sub !== undefined && Object.hasOwn(GRAFT_QUERIES, sub) ? GRAFT_QUERIES[sub] : undefined
  if (!rule || !rest.includes("--no-refresh")) return undefined
  let positionals = 0
  for (let index = 0; index < rest.length; index++) {
    const word = rest[index]!
    if (!word.startsWith("-")) {
      positionals++
      continue
    }
    if (rule.flags.includes(word)) continue
    const [name, inline] = word.startsWith("--") && word.includes("=") ? [word.slice(0, word.indexOf("=")), word.slice(word.indexOf("=") + 1)] : [word, undefined]
    const value = Object.hasOwn(rule.values, name) ? rule.values[name] : undefined
    if (!value) return undefined
    const given = inline ?? rest[++index]
    if (given === undefined || !value.test(given)) return undefined
  }
  return positionals <= rule.positionals ? ([] as string[]) : undefined
}

/** SR7-05 d: `git reflog` only bare or as `show`, `list` or `exists`; `expire` and `delete` change the repository. */
function gitReflogLooks(words: readonly string[]) {
  const moved = words[1] === "-C" && words[2] !== undefined
  const [sub, ...args] = words.slice(moved ? 3 : 1)
  return sub !== "reflog" || args.length === 0 || ["show", "list", "exists"].includes(args[0]!)
}

/** The words one read-class piece names as places, or undefined when the piece is not in the read class. */
function readClassPaths(words: readonly string[], here: string, instance: InstanceContext): string[] | undefined {
  const [program, ...args] = words
  if (program === undefined) return undefined
  if (READS.has(program)) {
    if (!onlyLooks(words) || readClassRefuses(words)) return undefined
    const paths = args.filter((word) => !word.startsWith("-"))
    const cap = READS.get(program)?.maxPaths
    return cap !== undefined && paths.length > cap ? undefined : paths
  }
  if (program === "git") return gitReads(words, here, instance) && gitReflogLooks(words) ? [] : undefined
  if (program === "mdls") return mdlsPaths(args)
  if (program === "pdftotext") return pdftotextPaths(args)
  if (program === "unzip") return unzipPaths(args)
  if (program === "graft") return graftPaths(args)
  return undefined
}

type ReadPiece = { words: string[]; here: string; paths: string[] }
// No control, format or line-separator character anywhere (`\r`, NUL, a line break, a bidi mark): the line a person reads
// is the line that runs (SR7-20).
const UNSEEN_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

/**
 * The pieces of a read-class command line, or undefined. The shape is SR §3.2's: `[cd <path> && ]<look>[ && <look>]…`, each
 * piece may end with ` 2>/dev/null`, the line may end with ` 2>&1` and ` | tail -N` or ` | head -N`; each piece's words
 * pass `Risk.plainWords` or whole-word quotes, so no other operator, substitution, assignment or redirect survives. A
 * probe (`<installed program> --version`) is the whole command and names nothing.
 */
function readClass(command: string, cwd: string, instance: InstanceContext): ReadPiece[] | undefined {
  if (!command || UNSEEN_TEXT.test(command)) return undefined
  if (probe(command, cwd, instance)) return []
  let here = cwd
  const pieces: ReadPiece[] = []
  const named: string[] = []
  for (const [index, raw] of command.replace(OUTPUT_TAIL, "").split(" && ").entries()) {
    const words = lookWords(raw.replace(DROP_ERRORS, ""))
    if (!words || words.length === 0) return undefined
    if (index === 0 && words[0] === "cd" && words.length === 2 && !words[1]!.startsWith("-")) {
      here = path.resolve(cwd, words[1]!)
      named.push(here)
      continue
    }
    const paths = readClassPaths(words, here, instance)
    if (!paths) return undefined
    named.push(...paths.map((word) => path.resolve(here, word)))
    pieces.push({ words, here, paths })
  }
  if (pieces.length === 0 || nearLibrary([cwd, ...named])) return undefined
  return programInProject(command, cwd, instance) ? undefined : pieces
}

/**
 * N7-116 (K7-05): whether a shell command line is in the read and diagnostic class (SR §3.2), judged on its text as the
 * shell will run it. Used by the read roles' check and by the app-state allowlist (N-1).
 */
export function isReadOnlyShell(command: string, cwd: string, instance: InstanceContext): boolean {
  return readClass(command, cwd, instance) !== undefined
}

/**
 * U4: whether a read role's call is refused, before any rule, grant or "always" is looked at. Only a shell call (or the
 * shell's folder prompt, which carries its command) by a `READ_SHELL_ROLES` agent is judged; it is refused when its
 * command is not in the read class. The caller answers with `ROLE_SHELL_OUTSIDE_READ_TEXT`.
 */
export function readRoleRefuses(
  input: { agent?: string; permission: string; metadata: Readonly<Record<string, unknown>> },
  instance: InstanceContext,
): boolean {
  if (input.agent === undefined || !READ_SHELL_ROLES.has(input.agent)) return false
  const command = input.metadata.command
  if (input.permission !== "bash" && !(input.permission === "external_directory" && command !== undefined)) return false
  if (typeof command !== "string") return true
  const workdir = input.metadata.workdir
  const cwd = typeof workdir === "string" && path.isAbsolute(workdir) ? workdir : instance.directory
  return !isReadOnlyShell(command, cwd, instance)
}

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
const MAX_DIRS = 16

/**
 * SR7-01: the places a command's words name, as the shell would resolve them: relative to its folder and to every `cd` in
 * it, with `~`, `$HOME`, `${HOME}` (under every home Swarm knows) and set environment variables expanded. Over-reads on
 * purpose: a word that is not a path resolves to a name nobody has.
 */
function spelledPlaces(command: string, cwd: string) {
  const words = command.replace(/['"\\]/g, "").split(SPELLED_BREAK).filter(Boolean)
  const expand = (word: string): string[] => {
    const home = HOME_WORD.exec(word)
    if (home) return homes().map((place) => path.join(place, word.slice(home[0].length)))
    return [word.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (whole, name: string) => process.env[name] ?? whole)]
  }
  let dirs = [cwd]
  const places: { file: string; glob: boolean }[] = []
  for (const [index, word] of words.entries()) {
    const resolved = expand(word).flatMap((spelling) => dirs.map((dir) => path.resolve(dir, spelling)))
    places.push(...resolved.map((file) => ({ file, glob: /[*?[]/.test(word) })))
    if (words[index - 1] === "cd") dirs = [...new Set([...dirs, ...resolved])].slice(0, MAX_DIRS)
  }
  const programs = new Set(words.map((word) => path.basename(word)))
  return { places, dirs, search: [...CONTENT_SEARCH].some((name) => programs.has(name)), rg: programs.has("rg") }
}

/** SR7-01: whether a command reaches into Swarm's own state by any spelling, or searches the contents of a folder above it. */
function touchesAppState(command: string, cwd: string, instance: InstanceContext) {
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

/**
 * SR OP-2 (N-1): whether a command that reaches Swarm's own state only looks there in a way the allowlist takes: it is in
 * the read class, every operand inside an app-state root (after `cd`, relative, `~` and real path) is a literal name read by
 * `APP_STATE_LOOKS` (`head`/`tail` without `-c`), and no content search runs on a folder that holds app state.
 */
function appStateRead(command: string, cwd: string, instance: InstanceContext) {
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
function readsAppState(input: Input) {
  const command = input.metadata.command
  if (typeof command !== "string" || (input.permission !== "bash" && input.permission !== "external_directory")) return false
  return touchesAppState(command, input.cwd, input.instance) && appStateRead(command, input.cwd, input.instance)
}

/** The home folders a protected place may be spelled under: the one Swarm reads (pinned in tests) and the system's. */
function homes() {
  return [...new Set([Global.Path.home, homedir()])]
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
function classifyOutsideEdit(input: Input): Verdict | undefined {
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
function classifyOutside(input: Input): Verdict {
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

// U11 rule 3. Something leaves the machine without a person only for a destination the person named in the mission and
// ticked, matched by code against what the gate passes in. No model judges "part of the mission": the agent writes the
// command and repository text can shape where it points. Every other way out waits for a person as `outward_not_in_mission`.
// 1.1.0's push flags; narrower than P42's (`OutwardConsent.pushWords`) on purpose, so 1.1.0 is unchanged (n63).
const PUSH_FLAGS = new Set(["-u", "--set-upstream", "-q", "--quiet", "-v", "--verbose"])
const REF = OutwardConsent.REF
const RCLONE_FLAGS = new Set(["-P", "--progress", "-v", "--verbose", "--ignore-existing", "-n", "--dry-run"])
// `-e`, `--rsh`, `--rsync-path`, `-o` and `-S` run a program; `--delete` and `--remove-source-files` remove. None is here.
const SCP_FLAGS = new Set(["-p", "-q", "-C"])
const RSYNC_FLAGS = /^-[avzhPtpqc]+$|^--(progress|partial|verbose|archive|compress|times|checksum)$/
const SSH_TARGET = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):(.*)$/

/**
 * The repository and remote of a plain `git push <remote> [<ref>...]`, as the snapshot taken before the mode knew them, or
 * undefined. The gate runs `OutwardKnown.recheck` on what this returns. A raw URL, a remote added since, a push with no
 * remote named, or a `.git` made between the folder and that repository gives nothing.
 */
export function pushTarget(input: Pick<Input, "metadata" | "cwd">, snapshot: OutwardKnown.Snapshot) {
  const command = input.metadata.command
  const words = typeof command === "string" ? Risk.plainWords(unwrapped(command)) : undefined
  if (!words || words[0] !== "git" || words[1] !== "push") return
  const [remote, ...refs] = words.slice(2).filter((word) => !PUSH_FLAGS.has(word))
  if (!remote || !REF.test(remote) || refs.some((ref) => ref.split(":").length > 2 || !ref.split(":").every((part) => REF.test(part) && !part.includes(".."))))
    return
  const here = Reach.real(input.cwd)
  if (here === undefined) return
  const repo = snapshot.repos.filter((item) => within(item.dir, here)).toSorted((a, b) => b.dir.length - a.dir.length)[0]
  if (!repo || !noRepositoryBetween(here, repo.dir) || !repo.remotes.some((item) => item.name === remote)) return
  return { repo: repo.dir, remote }
}

function classifyPush(input: Input): Verdict {
  const outward = input.outward
  const target = outward?.snapshot && canRunIn(input.cwd, input.instance) ? pushTarget(input, outward.snapshot) : undefined
  // The repository's own hooks and config run with the push, so it has to be one the guard can vouch for.
  if (!outward || !target || GitGuard.inspect(target.repo).refused !== undefined) return held("outward_not_in_mission")
  const check = outward.recheck
  if (!check || check.repo !== target.repo || check.remote !== target.remote || !check.result.ok) return held("outward_not_in_mission")
  return sentTo(input, (destination) => destination.kind === "git" && destination.repo === target.repo && destination.remote === target.remote)
}

/**
 * A copy off the machine through the shell: `rclone copy`, `scp` or `rsync` of files in the folder, or `cp` of one to a new
 * name on a mounted drive (G2). Undefined when the command is none of these, so the other rules judge it. A `cp` that does
 * not land on a ticked drive is left to rule 1, which refuses writing out there.
 */
function classifySend(command: string, input: Input): Verdict | undefined {
  const words = homeWords(command.replace(OUTPUT_TAIL, ""))
  if (!words) return undefined
  if (words[0] === "cp") return driveCopy(words, input)
  if (words[0] !== "rclone" && words[0] !== "scp" && words[0] !== "rsync") return undefined
  if (!canRunIn(input.cwd, input.instance)) return held("outward_not_in_mission")
  const match = words[0] === "rclone" ? rcloneTo(words, input) : sshTo(words, input)
  return match ? sentTo(input, match) : held("outward_not_in_mission")
}

/** `rclone copy|copyto <file> <remote>:<path>`. `sync` makes the far side match, which removes there, so it waits. */
function rcloneTo(words: readonly string[], input: Input) {
  if (words[1] !== "copy" && words[1] !== "copyto") return
  const args = words.slice(2)
  const names = args.filter((word) => !word.startsWith("-"))
  if (names.length !== 2 || args.some((word) => word.startsWith("-") && !RCLONE_FLAGS.has(word))) return
  const name = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):/.exec(names[1]!)?.[1]
  if (!name || !localFiles([names[0]!], input)) return
  return (destination: OutwardKnown.Destination) => destination.kind === "rclone" && destination.name === name
}

/** `scp|rsync <file>... <user>@<host>:<path>`, to the login the person wrote with ssh, scp or rsync. */
function sshTo(words: readonly string[], input: Input) {
  const args = words.slice(1)
  const allowed = (word: string) => (words[0] === "scp" ? SCP_FLAGS.has(word) : RSYNC_FLAGS.test(word))
  const names = args.filter((word) => !word.startsWith("-"))
  if (names.length < 2 || args.some((word) => word.startsWith("-") && !allowed(word))) return
  const target = SSH_TARGET.exec(names.at(-1)!)
  if (!target || !localFiles(names.slice(0, -1), input)) return
  const user = target[1]!
  const host = target[2]!.toLowerCase()
  return (destination: OutwardKnown.Destination) => destination.kind === "ssh" && destination.user === user && destination.host === host
}

/** Regular files in the folder that are neither secret nor sensitive. A folder is not walked here, so it waits. */
function localFiles(names: readonly string[], input: Input) {
  return names.every((name) => {
    if (name.includes(":")) return false
    const file = path.resolve(input.cwd, name)
    const target = Reach.real(file)
    return (
      target !== undefined &&
      Reach.inside(file, input.instance) &&
      Reach.readable(file) &&
      !Reach.secret(file) &&
      !Reach.sensitive(file, input.instance) &&
      fs.statSync(target, { throwIfNoEntry: false })?.isFile() === true
    )
  })
}

/** `cp [-p] <file in the folder> <new name on a ticked drive>`: a new file only, nothing over one that is there (G2). */
function driveCopy(words: readonly string[], input: Input): Verdict | undefined {
  const args = words.slice(1)
  const names = args.filter((word) => !word.startsWith("-"))
  if (names.length !== 2 || args.some((word) => word.startsWith("-") && word !== "-p") || names[1]!.split("/").includes("..")) return
  const target = path.resolve(input.cwd, names[1]!)
  const into = Reach.real(path.dirname(target))
  const given = input.outward?.allowed.find(
    ({ destination }) => destination.kind === "drive" && into !== undefined && within(Reach.real(destination.path) ?? destination.path, into),
  )
  if (!given || into === undefined || Reach.inside(target, input.instance) || nearLibrary([target])) return
  if (fs.lstatSync(target, { throwIfNoEntry: false }) || fs.statSync(into, { throwIfNoEntry: false })?.isDirectory() !== true) return
  if (!canRunIn(input.cwd, input.instance) || !localFiles([names[0]!], input)) return
  return sent(given)
}

/** `webfetch` of a URL on a host the person wrote. A search goes to a provider nobody named, so it waits. */
function classifyFetch(input: Input): Verdict {
  const url = input.metadata.url
  if (input.permission !== "webfetch" || typeof url !== "string" || !input.patterns.every((pattern) => pattern === url))
    return held("outward_not_in_mission")
  const host = URL.canParse(url) ? new URL(url) : undefined
  if (!host || (host.protocol !== "https:" && host.protocol !== "http:")) return held("outward_not_in_mission")
  return sentTo(input, (destination) => destination.kind === "host" && destination.host === host.hostname.toLowerCase())
}

function sentTo(input: Input, match: (destination: OutwardKnown.Destination) => boolean): Verdict {
  const given = input.outward?.allowed.find((item) => match(item.destination))
  return given ? sent(given) : held("outward_not_in_mission")
}

const sent = (given: Outward["allowed"][number]): Verdict => ({
  class: "A",
  decidedBy: "gate",
  via: "outward",
  consentID: given.id,
  destination: OutwardKnown.label(given.destination),
})

/**
 * U11 rules 5 and 7, for a tool of an MCP server. Its request says which server, how it is reached, and whose config set it
 * up (`session/tools.ts`); anything else said there is read as the stricter case. A local server from the user's own config,
 * or from the project's in a folder a person approved, runs on record. A project's server in a folder nobody approved is code
 * nobody has looked at. A remote one takes what it is sent off the machine, so it is a way out like any other (G4, rule 3).
 */
/** The shipped MCP servers that only read (C100): the plan agent may call their tools. */
const READ_ONLY_SERVERS = new Set(["swarm-web", "graft"])

/** A tool of a read-only server, by its name as well, so a request cannot borrow such a server's source. */
function readOnlyServer(input: Input, mcp: Readonly<Record<string, unknown>>) {
  return (
    typeof mcp.server === "string" &&
    READ_ONLY_SERVERS.has(mcp.server) &&
    input.permission.startsWith(McpCatalog.toolName(mcp.server, ""))
  )
}

function classifyMcp(input: Input, mcp: Readonly<Record<string, unknown>>): Verdict {
  // A tool is named after its server, so a request cannot borrow another server's source.
  if (typeof mcp.server !== "string" || !input.permission.startsWith(McpCatalog.toolName(mcp.server, ""))) return held("external_tool")
  if (mcp.origin !== "global" && input.folder !== "clean" && input.folder !== "trusted") return held("folder_not_trusted")
  // Rule 3 lets a way out through only to a destination it can match, and the source names the server, not its host.
  if (mcp.transport !== "local") return held("outward_not_in_mission")
  return { class: "A", decidedBy: "gate", category: "mcp_tool" }
}

// U11 rule 3: while the mode is on, nothing may change where a push goes or who it goes as, so the snapshot a person
// consented over stays true. Read on every piece of the command and with quotes dropped, since a refusal that a spelling
// slips past would leave it held for a person at best. Looking (`git remote -v`, `git remote get-url`) is not a change.
const REMOTE_CHANGES = new Set(["add", "set-url", "rename", "remove", "rm", "set-head", "set-branches"])
// `include.*` pulls a remote in from another file; `http.*.extraHeader`, `core.sshCommand` and `core.askPass` pick the
// credential a push goes with.
const CREDENTIAL_KEY = /^(remote|url|credential|include|includeif)\.|^http\..*extraheader$|^core\.(sshcommand|askpass)$/i
// Environment that gives git or `gh` another config, credential or account for the command it is set on.
const CREDENTIAL_ENV = /^(GIT_CONFIG|GIT_ASKPASS|GIT_SSH|SSH_ASKPASS|GH_|GITHUB_TOKEN)/
const COMMAND_WRAPPERS = new Set(["rtk", "command", "builtin", "exec", "env", "nohup", "time", "nice", "sudo", "doas", "xargs"])
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"])
const PUSH_VALUE_OPTIONS = new Set(["-o", "--push-option", "--receive-pack", "--exec"])
const RAW_URL = /:\/\/|^[^/:\s]+@[^:\s]+:|^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+:/
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

function changesCredentials(input: Input) {
  const command = input.metadata.command
  if (typeof command !== "string") return false
  return command
    .split(/&&|\|\||\$\(|[;&|\n()`{}]/)
    .map((piece) => piece.replace(/["'\\]/g, "").trim().split(/\s+/).filter(Boolean))
    .some((words) => pieceChangesCredentials(words, input.outward?.snapshot))
}

function pieceChangesCredentials(words: readonly string[], snapshot: OutwardKnown.Snapshot | undefined) {
  const start = words.findIndex((word, index) => {
    if (ASSIGNMENT.test(word)) return false
    if (COMMAND_WRAPPERS.has(word)) return false
    // A wrapper's own flags, such as `env -i` or `nice -n 5`.
    return !(index > 0 && COMMAND_WRAPPERS.has(words[index - 1]!) && word.startsWith("-"))
  })
  const head = start < 0 ? words : words.slice(0, start)
  if (head.some((word) => ASSIGNMENT.test(word) && CREDENTIAL_ENV.test(word))) return true
  if (start < 0) return false
  const name = words[start]!.split("/").at(-1)!
  const args = words.slice(start + 1)
  if (name === "export") return args.some((word) => CREDENTIAL_ENV.test(word))
  if (name === "gh") return args[0] === "auth"
  if (name !== "git") return false
  const configs: string[] = []
  let index = 0
  while (args[index]?.startsWith("-")) {
    const option = args[index]!
    if (option === "-c" || option === "--config-env") configs.push(args[index + 1] ?? "")
    if (option.startsWith("-c") && option.length > 2) configs.push(option.slice(2))
    if (option.startsWith("--config-env=")) configs.push(option.slice("--config-env=".length))
    index += GIT_VALUE_OPTIONS.has(option) ? 2 : 1
  }
  if (configs.some((value) => CREDENTIAL_KEY.test(value.split("=")[0]!))) return true
  const [sub, ...rest] = args.slice(index)
  if (sub === "remote") return REMOTE_CHANGES.has(rest[0] ?? "")
  if (sub === "credential" || sub?.startsWith("credential-")) return true
  if (sub === "config")
    return rest.some((word) => word === "-e" || Risk.abbreviates(word, ["--edit"]) || (!word.startsWith("-") && CREDENTIAL_KEY.test(word.split("=")[0]!)))
  if (sub === "push") return pushesToRawUrl(rest, snapshot)
  return false
}

/** `git push <url>` or `--repo=<url>` with a URL that is none of the push URLs the snapshot holds. */
function pushesToRawUrl(args: readonly string[], snapshot: OutwardKnown.Snapshot | undefined) {
  // 1.1.1 F10a (G3-1): git takes `--repo` by any shortening of it too.
  const isRepo = (word: string) => Risk.abbreviates(word, ["--repo"])
  const repo = args.flatMap((word, index) =>
    isRepo(word) ? (word.includes("=") ? [word.slice(word.indexOf("=") + 1)] : [args[index + 1] ?? ""]) : [],
  )
  const positional = args.find((word, index) => !word.startsWith("-") && !PUSH_VALUE_OPTIONS.has(args[index - 1] ?? "") && !isRepo(args[index - 1] ?? ""))
  return [...repo, ...(positional ? [positional] : [])].some(
    (target) =>
      RAW_URL.test(target) && !(snapshot !== undefined && snapshot.repos.some((item) => OutwardKnown.pushTarget(snapshot, item.dir, target))),
  )
}

// U11 rule 4. The program, the flags and the paths are read as the shell reads them (`tool/deletion.ts`): a plain deletion
// the table lets through must be one the shell moves, never one it runs.
// One command of words nothing rewrites: bare words the shell takes as written, single quotes, and double quotes without
// `$`, backquotes, `\` or `!`, with spaces between, so the text the shell parses is one command and nothing else.
const PLAIN_DELETE_WORD = /[\w./@%+:,-][\w./@%+:,=-]*|'[^']*'|"[^"$`\\!]*"/
const PLAIN_DELETION = new RegExp(`^(?:${PLAIN_DELETE_WORD.source})(?: +(?:${PLAIN_DELETE_WORD.source}))*$`)
const unquoteWord = (word: string) => (/^(['"]).*\1$/s.test(word) && word.length >= 2 ? word.slice(1, -1) : word)

/**
 * The commands of a text, as words, roughly as a shell would find them: split at `;`, `&`, `|`, newlines, brackets and
 * command substitution outside single quotes. It only has to find a deletion wherever one could run; what it lets through
 * as plain is decided by `PLAIN_DELETION` alone.
 */
export function commandWords(command: string) {
  const pieces: string[] = []
  let current = ""
  let quote: "'" | '"' | undefined
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (quote === "'") {
      current += char
      if (char === "'") quote = undefined
      continue
    }
    const opens = char === "`" || (char === "$" && command[index + 1] === "(")
    if (quote === '"') {
      if (char === "\\") {
        current += char + (command[++index] ?? "")
        continue
      }
      if (char === '"') quote = undefined
      if (opens || char === ")") {
        pieces.push(current)
        current = ""
        if (char === "$") index++
        continue
      }
      current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      current += char
      continue
    }
    if (char === "\\") {
      current += char + (command[++index] ?? "")
      continue
    }
    if (opens || /[;&|\n\r()]/.test(char) || ((char === "{" || char === "}") && /(^|\s)$/.test(current))) {
      pieces.push(current)
      current = ""
      if (char === "$") index++
      continue
    }
    current += char
  }
  pieces.push(current)
  return pieces.map((piece) => piece.trim().split(/\s+/).filter(Boolean).map(unquoteWord)).filter((words) => words.length > 0)
}

/** The paths of a plain deletion whose flags the shell knows, or undefined, which the shell refuses as `compound`. */
function deletionPaths(name: Deletion["name"], words: readonly string[]) {
  return DeletionWords.deletionFlags(name, words)?.paths
}

/**
 * U11 rule 4. In autonomous mode the shell runs no deletion: `rm`, `rmdir`, `unlink` or `git rm` alone, with literal paths
 * and flags it knows, has its paths moved to the archive, and any other text that deletes is refused with the register's
 * text. So a plain one of safe paths in the folder is class A `archived`, since code only moves and a person empties, and
 * any other deletion is X `delete_compound`. A plain one naming a path that is not safe here (beyond the folder, a secret,
 * the folder itself, the archive under `.swarm`) is left to the rules below, which hold it. `find -delete` and a script that
 * deletes name no deletion program, so they stay held as before. A plain one is `archived` only when the shell said it moves
 * it (`metadata.archive`, row 113): PowerShell, cmd or Windows would run it, so without that it is D `not_reversible`.
 */
function classifyDeletion(input: Input): Verdict | undefined {
  const command = input.metadata.command
  if (typeof command !== "string") return undefined
  if (!commandWords(command).some((words) => DeletionWords.deletes(words))) return undefined
  // A name with a line break, a control or a bidi mark in it is no plain line for anyone to read: the rules below hold it.
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(command.trim())) return undefined
  const text = command.trim()
  if (!PLAIN_DELETION.test(text)) return refused("delete_compound")
  // The program's own name as written: the shell takes no quoted name for one it moves.
  const raw = text.match(new RegExp(PLAIN_DELETE_WORD.source, "g")) ?? []
  const name: Deletion["name"] | undefined =
    raw[0] === "git" && raw[1] === "rm"
      ? "git rm"
      : raw[0] === "rm" || raw[0] === "rmdir" || raw[0] === "unlink"
        ? raw[0]
        : undefined
  const paths = name && deletionPaths(name, raw.slice(name === "git rm" ? 2 : 1).map(unquoteWord))
  if (!paths) return refused("delete_compound")
  if (!canRunIn(input.cwd, input.instance)) return undefined
  const roots = [input.cwd, input.instance.directory, input.instance.worktree].map((root) => Reach.real(root))
  const safe = paths.every(
    (word) => safePath(word, input.cwd, input.instance) && !roots.includes(Reach.real(path.resolve(input.cwd, word))),
  )
  if (!safe) return undefined
  // Only the shell knows it will move instead of run (a POSIX shell it parsed, with the mode on). Without its word the
  // command would delete for good, which this mode never lets happen unseen: a person decides.
  return input.metadata.archive === true ? { class: "A", decidedBy: "gate", category: "archived" } : held("not_reversible")
}

// 1.2.6 row 37b (P-01b, U6, D5; spec 01b section 3.3). An action nothing could undo runs once a checkpoint of what it
// changes exists. The permission service cannot call a tool, so the shell makes the checkpoint after the gate allowed the
// call and before it runs (as it moves a deletion to the archive), and says so beforehand in `metadata.checkpointTargets`
// (N-143). Both read the call with `checkpointPlan`, so what the shell saves is what the table judged.

/** What a checkpoint of a shell call holds, or that it cannot hold what the call changes. */
export type CheckpointPlan =
  /** I-F: known files inside the project, with no Undo snapshot over them. */
  | { readonly kind: "files"; readonly targets: readonly string[] }
  /**
   * I-G: git that moves or drops refs, or discards work. `refs` are the ref names it can move or drop; `branch` adds the
   * branch HEAD names, `all` every local branch and tag; `changed` the tracked files with changes (a hard reset); `clean`
   * the words a `git clean -n` lists the removed files with. All but `refs` are worked out by the shell right before it runs.
   */
  | {
      readonly kind: "git"
      readonly targets: readonly string[]
      readonly refs: readonly string[]
      readonly branch?: boolean
      readonly all?: boolean
      readonly changed?: boolean
      readonly clean?: readonly string[]
      /** SEC-19: a history rewrite, after which the agent line says old commits stay under the keep-alive refs. */
      readonly rewrite?: boolean
    }
  /** I-N: data outside the file system and Git, or a device. No checkpoint can hold it. */
  | { readonly kind: "not_files" }
  /**
   * 1.2.6 row 37c (C17): `git reflog expire` and `git gc --prune…` drop commits only the reflog reaches. A checkpoint keeps
   * ref names, not reflog entries, so these cannot be checkpointed and are refused instead of run.
   */
  | { readonly kind: "not_kept"; readonly reason: "git" }

export type CheckpointInput = {
  readonly command: string
  /** `metadata.steps`, the shell's own reading of the text. */
  readonly steps?: unknown
  readonly cwd: string
  readonly instance: InstanceContext
  readonly canUndo: boolean
  readonly folder?: ProjectTrust.Status["state"]
}

const CHECKPOINTED: Verdict = { class: "A", decidedBy: "gate", category: "checkpointed" }

// What each I-N program acts on is a database, a service's data or a device. Host control (`shutdown`, `reboot`, `halt`),
// system services and the file programs keep their own rules (01b sections 3.4, 3.5).
const NOT_FILE_PROGRAMS: ReadonlySet<string> = new Set([
  "dropdb",
  "dropuser",
  "dd",
  "mkfs",
  "diskutil",
  "wipefs",
  "redis-cli",
  "docker",
  "psql",
  "mysql",
  "sqlite3",
  "mongosh",
  "mongo",
  "cockroach",
])

function notFiles(argv: readonly string[]) {
  const name = argv[0] ?? ""
  if (name === "wipefs") return true
  if (!NOT_FILE_PROGRAMS.has(name) && !name.startsWith("mkfs.")) return false
  const label = Risk.classify([...argv])
  return label.kind === "risky" && label.risk === "irreversible"
}

const PLAIN_PATH = /^[\w.@%+,:-][\w./@%+,:=-]*$/
const REF_WORD = /^[\w.@{}~^/-]+$/
const BRANCH_NAME = /^[\w][\w./-]*$/

/** A word that names a file the plain way: no glob, no `~`, no `..`, no option. */
const plainPath = (word: string) => PLAIN_PATH.test(word) && !word.split("/").includes("..")

/** A step that only prints, or only looks at files inside the project that are readable and hold no secret. */
function checkpointLooks(step: Step, instance: InstanceContext) {
  if (printsOnly(step.argv)) return true
  if (!onlyLooks(step.argv)) return false
  return step.argv
    .slice(1)
    .filter((word) => !word.startsWith("-"))
    .every((word) =>
      step.cwds.every((cwd) => {
        const file = path.resolve(cwd, word)
        return plainPath(word) && Reach.inside(file, instance) && Reach.readable(file) && !Reach.secret(file)
      }),
    )
}

/** `truncate -s N files` and `shred [-u] [-z] [-n N] files`: the files, or undefined for any other form. */
function sizeOrShredFiles(argv: readonly string[]) {
  const [name, ...args] = argv
  const files: string[] = []
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    if (name === "truncate" && (word === "-s" || word === "--size")) {
      if (!/^[+\-<>/%]?\d+[KMGkmg]?$/.test(args[++index] ?? "")) return undefined
      continue
    }
    if (name === "truncate" && word === "-c") continue
    if (name === "shred" && /^-[uzvf]+$/.test(word)) continue
    if (name === "shred" && word === "-n") {
      if (!/^\d+$/.test(args[++index] ?? "")) return undefined
      continue
    }
    if (word.startsWith("-") || !plainPath(word)) return undefined
    files.push(word)
  }
  return files.length > 0 ? files : undefined
}

/** `git checkout [--] <paths>` and `git restore [-W] <paths>`: the paths they put back from the index, or undefined. */
function discardedPaths(args: readonly string[]) {
  const [sub, ...rest] = args
  const separator = rest.indexOf("--")
  if (sub === "checkout") {
    const named = separator < 0 ? rest : rest.slice(separator + 1)
    if (separator < 0 && rest.some((word) => word.startsWith("-"))) return undefined
    if (separator > 0) return undefined
    return named.length > 0 && named.every(plainPath) ? named : undefined
  }
  if (sub === "restore") {
    const flags = (separator < 0 ? rest : rest.slice(0, separator)).filter((word) => word.startsWith("-"))
    const named = separator < 0 ? rest.filter((word) => !word.startsWith("-")) : rest.slice(separator + 1)
    if (!flags.every((word) => word === "-W" || word === "--worktree")) return undefined
    return named.length > 0 && named.every(plainPath) ? named : undefined
  }
  return undefined
}

/** I-G: what a checkpoint of this git command has to keep, or undefined when it is not one this reads (01b section 3.3). */
function gitPlan(args: readonly string[]): Omit<Extract<CheckpointPlan, { kind: "git" }>, "kind" | "targets"> | undefined {
  const [sub, ...rest] = args
  if (sub === undefined || sub.startsWith("-")) return undefined
  const flags = rest.filter((word) => word.startsWith("-"))
  const positional = rest.filter((word) => !word.startsWith("-"))
  const only = (...allowed: string[]) => flags.every((word) => allowed.includes(word))
  if (sub === "reset") {
    if (rest.includes("--") || positional.length > 1 || !positional.every((word) => REF_WORD.test(word))) return undefined
    if (!only("--hard", "--soft", "--mixed", "--keep", "--merge", "-q", "--quiet")) return undefined
    const hard = flags.includes("--hard")
    const moves = positional.length === 1 && positional[0] !== "HEAD"
    return hard || moves ? { refs: ["HEAD"], branch: true, changed: hard } : undefined
  }
  if (sub === "clean") {
    if (!flags.every((word) => /^-[fdxXq]+$/.test(word) || word === "--force" || word === "--quiet")) return undefined
    if (!flags.some((word) => word === "--force" || /^-[A-Za-z]*f/.test(word))) return undefined
    if (!positional.every(plainPath)) return undefined
    return { refs: [], clean: rest }
  }
  if (sub === "branch") {
    const forced = flags.some((word) => /^-[A-Za-z]*D/.test(word)) || (flags.some((word) => /^-[A-Za-z]*d/.test(word) || word === "--delete") && flags.some((word) => /^-[A-Za-z]*f/.test(word) || word === "--force"))
    if (!forced || !flags.every((word) => /^-[dDf]+$/.test(word) || word === "--delete" || word === "--force")) return undefined
    if (positional.length === 0 || !positional.every((word) => BRANCH_NAME.test(word) && !word.split("/").includes(".."))) return undefined
    return { refs: positional.map((name) => `refs/heads/${name}`) }
  }
  if (sub === "stash") {
    // Only the newest entry has a ref name of its own (`refs/stash`); a drop of an older one, or `clear`, is not read here.
    const words = rest.filter((word) => word !== "-q" && word !== "--quiet")
    return words[0] === "drop" && (words.length === 1 || (words.length === 2 && words[1] === "stash@{0}"))
      ? { refs: ["refs/stash"] }
      : undefined
  }
  if (sub === "commit") {
    if (!flags.includes("--amend")) return undefined
    for (let index = 0; index < rest.length; index++) {
      const word = rest[index]!
      if (word === "-m" || word === "--message") index++
      else if (!["--amend", "--no-edit", "-a", "--all", "-q", "--quiet"].includes(word)) return undefined
    }
    return { refs: ["HEAD"], branch: true, rewrite: true }
  }
  if (sub === "rebase") {
    if (!only("-q", "--quiet") || positional.length !== 1 || !REF_WORD.test(positional[0]!)) return undefined
    return { refs: ["HEAD"], branch: true, rewrite: true }
  }
  if (sub === "update-ref") {
    const name = flags.length === 1 && flags[0] === "-d" ? positional[0] : flags.length === 0 ? positional[0] : undefined
    if (name === undefined || positional.length > 2 || !name.startsWith("refs/") || name.startsWith("refs/swarm-checkpoint/")) return undefined
    if (!positional.every((word) => REF_WORD.test(word))) return undefined
    return { refs: [name] }
  }
  if (sub === "filter-branch") {
    // Only forms that run no code of their own: every `--*-filter` but the subdirectory one runs a shell text.
    for (let index = 0; index < rest.length; index++) {
      const word = rest[index]!
      if (word === "--subdirectory-filter") {
        if (!plainPath(rest[++index] ?? "")) return undefined
      } else if (!["-f", "--force", "--prune-empty", "--", "--all"].includes(word) && !(BRANCH_NAME.test(word) || word === "HEAD")) return undefined
    }
    return { refs: ["HEAD"], branch: true, all: true, rewrite: true }
  }
  return undefined
}

/** Row 37c (C17): `git reflog expire …` or `git gc … --prune…`, in the forms row 37b read as I-G, which no checkpoint keeps. */
function dropsReflogCommits(args: readonly string[]) {
  const [sub, ...rest] = args
  if (sub === "reflog")
    return rest[0] === "expire" && rest.slice(1).every((word) => /^--(all|expire(-unreachable)?=[\w.-]+|stale-fix|rewrite|updateref)$/.test(word))
  if (sub === "gc")
    return (
      rest.some((word) => Risk.long(word, "prune")) &&
      rest.every((word) => /^--prune(=[\w.-]+)?$/.test(word) || ["--aggressive", "-q", "--quiet"].includes(word))
    )
  return false
}

/**
 * 1.2.6 row 37b: how a checkpoint covers this shell call, or undefined when it is none of I-F, I-G or I-N as this reads
 * them, which leaves the call to every rule it had in 1.2.5 (INV-1). Read conservatively: one word it does not know, a
 * variable, a secret's name, a program of the project or a reading the shell could not finish, and it is not one.
 */
export function checkpointPlan(input: CheckpointInput): CheckpointPlan | undefined {
  const command = input.command.trim()
  const instance = input.instance
  if (!command || /[$`*?[\]{}~]/.test(command.replace(/stash@\{0\}/g, "").replace(/HEAD~\d*|HEAD\^+/g, ""))) return undefined
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(command)) return undefined
  if (command.split(WORD_BREAK).some((word) => word && Secrets.secretFile(word))) return undefined
  const reading = shellReading(input.steps, instance)
  if (input.steps !== undefined && (!reading || !reading.complete)) return undefined
  if (!reading && /[<>]/.test(command)) return undefined
  const steps: Step[] = reading?.steps ?? commandWords(command).map((argv) => ({ argv: [...argv], cwds: [input.cwd] }))
  if (steps.length === 0 || steps.some((step) => step.code !== undefined)) return undefined
  if (!steps.every((step) => step.cwds.every((cwd) => canRunIn(cwd, instance)))) return undefined
  if (steps.some((step) => step.cwds.some((cwd) => programInProject(step.argv[0]!, cwd, instance)))) return undefined

  if (steps.some((step) => notFiles(step.argv)))
    return steps.every((step) => notFiles(step.argv) || checkpointLooks(step, instance)) ? { kind: "not_files" } : undefined

  // Git runs what the repository's own settings and hooks say, so only in a repository the guard vetted and a folder a
  // person trusts (or that holds nothing to trust).
  const gitOk = (step: Step) =>
    instance.worktree !== "/" &&
    (input.folder === "clean" || input.folder === "trusted") &&
    step.cwds.every((cwd) => gitAllowed(cwd, instance))

  const git = steps.filter((step) => step.argv[0] === "git" && !discardedPaths(step.argv.slice(1)))
  if (git.length > 0) {
    if (steps.length !== 1 || !gitOk(steps[0]!)) return undefined
    if (dropsReflogCommits(steps[0]!.argv.slice(1))) return { kind: "not_kept", reason: "git" }
    const plan = gitPlan(steps[0]!.argv.slice(1))
    return plan && { kind: "git", targets: [], ...plan }
  }

  // I-F: files only, where no Undo snapshot reaches. With Undo on the snapshot already brings them back (W1).
  if (input.canUndo) return undefined
  const targets = new Set<string>()
  const changed = new Set<string>()
  const add = (files: readonly string[], changes: boolean) => {
    for (const file of files) {
      targets.add(file)
      if (changes) changed.add(file)
    }
  }
  for (const step of steps) {
    const [name, ...args] = step.argv
    if (checkpointLooks(step, instance)) continue
    for (const cwd of step.cwds) {
      if (name === "sed" || name === "tee") {
        const files = shellWrites(step.argv, cwd, instance)
        if (!files) return undefined
        add(files, name === "sed" || !args.some((word) => word === "-a" || word === "--append"))
      } else if (name === "truncate" || name === "shred") {
        const files = sizeOrShredFiles(step.argv)
        if (!files) return undefined
        add(files.map((word) => path.resolve(cwd, word)), true)
      } else if (name === "git") {
        const files = discardedPaths(args)
        if (!files || !gitOk(step)) return undefined
        add(files.map((word) => path.resolve(cwd, word)), true)
      } else return undefined
    }
  }
  if (reading) {
    const cwds = [...new Set([input.cwd, ...steps.flatMap((step) => step.cwds)])]
    add(reading.writes, false)
    add(replacedWrites(command, reading.writes, cwds), true)
  }
  if (targets.size === 0 || ![...changed].some(existingFile)) return undefined
  return { kind: "files", targets: [...targets] }
}

/**
 * 1.2.6 row 37b (01b section 3.3): an I-F or I-G call the shell will checkpoint first (`metadata.checkpointTargets` lists
 * every target this reading finds) is A `checkpointed`; an I-N call is X `checkpoint_failed` (reason `not_files`), and
 * so is a reflog expiry or a pruning gc (reason `git`, row 37c). Any other reason a call is held or refused still
 * stands: an I-F write must be one an ordinary shell write may be (inside the project, no secret, no sensitive file, not
 * the app's state), or its 1.2.5 verdict stays.
 */
function classifyCheckpoint(input: Input): Verdict | undefined {
  const command = input.metadata.command
  if (input.permission !== "bash" || typeof command !== "string") return undefined
  const plan = checkpointPlan({
    command,
    steps: input.metadata.steps,
    cwd: input.cwd,
    instance: input.instance,
    canUndo: input.canUndo,
    folder: input.folder,
  })
  if (!plan) return undefined
  if (plan.kind === "not_files") return { ...refused("checkpoint_failed"), reason: "not_files" }
  if (plan.kind === "not_kept") return { ...refused("checkpoint_failed"), reason: plan.reason }
  const given = input.metadata.checkpointTargets
  if (!Array.isArray(given) || !given.every((file) => typeof file === "string")) return undefined
  if (!plan.targets.every((file) => given.includes(file))) return undefined
  if (plan.kind === "files" && classifyShellWrite(input, plan.targets).class !== "A") return undefined
  return CHECKPOINTED
}

/**
 * The class of one request, per the table this mode was specified with. Stricter rules are asked first, so a request can
 * only get here with less room than a later rule would give it. `checkClass` exists for the test of both values.
 */
export function classifyBase(input: Input, checkClass: CheckClass = CHECK_CLASS): Verdict {
  // A spend limit and a repeating call stop a run so that a person looks. Nothing here or later may answer them.
  if (needsPerson(input.permission)) return { class: "B", decidedBy: "person" }
  if (input.rule === "deny") return { class: "X" }
  if (input.permission === TRUST_PERMISSION) return { class: "X", decidedBy: "person", category: "folder_not_trusted" }
  // U11 rule 2 (C100): only the server makes a consent entry, from its own scan. An agent that asks for one is refused.
  if (input.permission === AUTONOMY_CONSENT) return { class: "X", decidedBy: "gate" }
  if ((input.permission === "bash" || input.permission === "external_directory") && changesCredentials(input))
    return refused("credential_change")

  const planEdit = input.plan === true && input.permission === "edit"
  const planFile = planEdit && isPlanFile(input)
  if (planEdit && !planFile) return refused("plan_mode")
  if (!planFile && writesAppState(input)) return refused("app_state")
  // 1.2.7 U-10 (C63): only the person turns the mode on (1.1.1 rule); an agent's `swarm autonomy` never runs.
  if (input.permission === "bash" && runsAutonomyCommand(input.metadata.command))
    return { ...refused("own_api"), reason: "person_only" }
  // 1.2.7 F-4 (N7-051): Swarm's own API has its own category, split from `app_state`; a reason names an unresolved form.
  const ownApi = ownServerCall(input)
  if (ownApi) return ownApi.reason ? { ...refused("own_api"), reason: ownApi.reason } : refused("own_api")

  if (input.rule === "user_catch_all") return held("asks_every_time")
  if (planFile) return { class: "A", decidedBy: "gate" }
  // 1.2.7 N-1 (N7-091): a look at Swarm's own state the OP-2 allowlist takes runs as a protected read; `cat`/`head`/`tail`
  // output stays masked (U16, SR7-07).
  if (readsAppState(input)) return PROTECTED_READ
  if (input.plan === true && input.permission === "bash") return classifyPlanBash(input, checkClass)
  // Before the labels: a deletion the shell moves to the archive takes nothing away, whatever Undo could have restored.
  if (input.permission === "bash") {
    const removal = classifyDeletion(input)
    if (removal) return removal
    // 1.2.6 row 37b (U6): before the labels too. A checkpoint made first takes away the reason "nothing could undo it";
    // what a checkpoint cannot hold (I-N) is refused with that reason. Anything else keeps the rules below.
    const saved = classifyCheckpoint(input)
    if (saved) return saved
  }

  // A label only ever raises a class. Nothing below may read its absence as safe. A push is the one way out the shell labels
  // that rule 3 can let through; a force push is labelled "irreversible" and is held as that.
  // Row 202: a file tool's write outside the project, which `classifyOutside` let through for its folder prompt.
  const outsideEdit = classifyOutsideEdit(input)
  if (outsideEdit) return outsideEdit
  if (input.metadata.risk === "remote" && input.permission === "bash") return classifyPush(input)
  if (input.metadata.risk) return held(riskCategory(input.metadata.risk))
  if (input.harmless) return QUIET
  if (input.permission === "task") return QUIET
  if (input.permission === "question") return { class: "A", decidedBy: "gate" }
  if (input.permission === "external_directory") {
    const verdict = classifyOutside(input)
    // A copy into the folder is a write there, which the plan agent does not do (rule 8), and neither is a copy away.
    return input.plan === true &&
      (verdict.category === "outside_copy" || verdict.category === "outside_edit" || verdict.via === "outward")
      ? refused("plan_mode")
      : verdict
  }
  if (input.permission === "webfetch" || input.permission === "websearch") return classifyFetch(input)
  // 1.2.6 (U12, R2/R3): the read tool asks only for a file it would not show unasked. It reads; the values stay masked (U16).
  if (input.permission === "read") {
    const targets = editTargets(input)
    return targets.length === 0 ||
      targets.some((file) => Reach.secret(file) || !Reach.readable(file) || protectedOutside(file, "read"))
      ? PROTECTED_READ
      : { class: "A", decidedBy: "gate" }
  }
  if (input.permission === "edit") return classifyEdit(input)
  if (input.permission === "bash") return classifyBash(input, checkClass)
  const mcp = input.metadata.mcp
  if (typeof mcp === "object" && mcp !== null) {
    const source = mcp as Readonly<Record<string, unknown>>
    // Rule 8 (C100): the table cannot tell what an MCP tool does, so the plan agent uses only the servers known to read.
    return input.plan === true && !readOnlyServer(input, source) ? refused("plan_mode") : classifyMcp(input, source)
  }
  // A tool that says nothing about itself has nothing to judge. No name is excepted, `graft_*` included.
  const opaque = input.patterns.every((pattern) => pattern === "*") && Object.keys(input.metadata).length === 0
  return held(opaque ? "external_tool" : "not_routine")
}

/**
 * The class of one request. Without the person's consent to the bypass this is `classifyBase`, unchanged since 1.1.0. With
 * it, the overlay of S1.13 (as decision P8 reads it) is laid over that answer. The plan agent keeps rule 8: no bypass for a
 * plan lineage. Steps of a compound text reach this again from `classifySteps` with the same `bypass`, so each is overlaid.
 */
export function classify(input: Input, checkClass: CheckClass = CHECK_CLASS): Verdict {
  if (!input.bypass) return classifyBase(input, checkClass)
  // 1.1.3 (T3): under consent no verdict waits, the plan lineage's included; rule 8 still refuses what it refused.
  if (input.plan === true) return noWait(input, classifyBase(input, checkClass))
  // 1.2.7 U-7 (C21 b): `sh|bash|zsh -c '<literal>'` is judged as the command line it runs, for root and subagent alike.
  const inner = shellTextCall(input)
  if (inner) return classify(inner, checkClass)
  // 1.1.1 F12b (Perf P2): one classify asks git about a file once, however many steps or scripts write it. 1.1.1 F14
  // (G5-P1): the one scope covers the whole consented classify, the steps' own overlays (reached from `classifySteps`,
  // whose nested scopes share this one), the call-level check and the kept path's `classifyBase` included.
  return Reach.snapshotScope(() => {
    const base = classifyBase(input, checkClass)
    const verdict = underConsent(input, base)
    // 1.1.1 F12a (S4-1): a step that changes the tree beside one that runs a project script does not open the call; it
    // keeps its 1.1.0 verdict. Refusals and held answers stand as they are (1.1.3: also one carrying `bypassed`).
    if (verdict.class === "A" && verdict.bypassed !== undefined && BypassScreen.sequenceKeeps(input)) {
      const kept = noWait(input, classifyBase({ ...input, bypass: undefined }, checkClass))
      // 1.1.3 (T7 F2): the kept call runs too, so its line names the step that would have waited (`classifySteps` chose
      // it, a send first) rather than the whole text's `not_routine`: a send stays under "Sent outside the computer".
      const waited = OPENED_BY_NO_WAIT.has(verdict) || OUTWARD_HELD.has(verdict.bypassed)
      if (kept.class !== "A" || kept.bypassed === undefined || !waited) return kept
      const { destination: _, ...rest } = kept
      return openedByNoWait({ ...rest, bypassed: verdict.bypassed, ...(verdict.destination && { destination: verdict.destination }) })
    }
    return noWait(input, verdict)
  })
}

/**
 * 1.2.7 U-7 (C7, C21, OP-1, N7-129): the opened categories a subagent's call runs in like the root's under the person's
 * consent (the gate in `index.ts`, which re-exports this one list): no decider call, the root's line with the child's
 * `sessionID`. A positive list, pinned by an equality test (SR7-02); every other opened category still goes to the main
 * agent, where "cannot tell" refuses. `classifySteps` names a decided step before a local one on a compound's line.
 * Row 29c (C41): `check` too, a recognised test or build command (`CHECKS`), which the root's consent already runs.
 */
export const SUBAGENT_RUNS_LIKE_ROOT: ReadonlySet<string> = new Set(["not_routine", "script", "outside_folder", "check"])

/** Row 29d (C46): the package tools whose `add` / `install <name>` fetches a named package from a registry. */
const REGISTRY_ADDERS: ReadonlySet<string> = new Set(["npm", "bun", "pnpm", "yarn"])
const ADD_WORDS: ReadonlySet<string> = new Set(["add", "install", "i", "in", "isntall"])
/** A word that names a local package, not one from a registry: a path or a local protocol. */
const LOCAL_PACKAGE = /^(\.{1,2}(\/|$)|\/|~|file:|link:|workspace:|portal:)/

/** Row 29d (C46): `npm|bun|pnpm|yarn add|install <pkg>`; a lockfile install (`bun install`, `npm ci`) names none. */
function addsRegistryPackage(name: string, args: readonly string[]) {
  if (!REGISTRY_ADDERS.has(name)) return false
  const words = args.filter((word) => !word.startsWith("-"))
  return ADD_WORDS.has(words[0] ?? "") && words.slice(1).some((word) => !LOCAL_PACKAGE.test(word))
}

/**
 * Row 47e (M1-07, C61): the other package tools' named adds, by tool: the sub-command words, the options whose value is
 * no package (skipped), and what a word names that is local. A requirements or lockfile install (`pip install -r`,
 * `uv sync`, `cargo build`, `bundle install`, `composer install`) names none and keeps parity.
 */
type AddRule = { readonly subs: readonly string[]; readonly values: ReadonlySet<string>; readonly local?: (word: string) => boolean }
const PIP_VALUES: ReadonlySet<string> = new Set([
  "-r", "--requirement", "-c", "--constraint", "-i", "--index-url", "--extra-index-url", "-f", "--find-links", "-t", "--target",
  "--prefix", "--root", "--src", "--platform", "--python-version", "--implementation", "--abi", "--progress-bar", "--log",
  "--cache-dir", "--trusted-host", "--proxy", "--retries", "--timeout", "--exists-action", "--upgrade-strategy",
  "--global-option", "--config-settings", "-C", "--report", "-p", "--python",
])
/** A path a pip-family tool installs from (`dist/x.whl`, `./pkg`), not a name from an index; a URL is not local. */
const PIP_LOCAL = (word: string) => LOCAL_PACKAGE.test(word) || (word.includes("/") && !word.includes(":") && !word.includes("@"))
const CARGO_VALUES: ReadonlySet<string> = new Set([
  "--version", "--vers", "--branch", "--tag", "--rev", "--root", "--index", "--registry", "-j", "--jobs", "--target",
  "--features", "-F", "--profile", "--bin", "--example", "--rename", "--package", "-p", "--manifest-path", "--target-dir",
  "--config", "-Z", "--color",
])
const NO_VALUES: ReadonlySet<string> = new Set()
const OTHER_ADDERS: Readonly<Record<string, readonly AddRule[]>> = {
  pip: [{ subs: ["install"], values: PIP_VALUES, local: PIP_LOCAL }],
  pip3: [{ subs: ["install"], values: PIP_VALUES, local: PIP_LOCAL }],
  uv: [
    { subs: ["add"], values: new Set(["--group", "--optional", "--extra", "--tag", "--branch", "--rev", "--index", "--default-index", "-p", "--python", "--package", "--script", "--directory", "--project", "--bounds"]) },
    { subs: ["pip", "install"], values: PIP_VALUES, local: PIP_LOCAL },
  ],
  poetry: [{ subs: ["add"], values: new Set(["-G", "--group", "-E", "--extras", "--source", "--python", "--platform", "--markers", "-C", "--directory", "-P", "--project"]) }],
  pdm: [{ subs: ["add"], values: new Set(["-G", "--group", "-p", "--project"]) }],
  pipenv: [{ subs: ["install"], values: new Set(["-r", "--requirements", "--python", "-i", "--index"]), local: PIP_LOCAL }],
  cargo: [
    { subs: ["add"], values: CARGO_VALUES },
    { subs: ["install"], values: CARGO_VALUES },
  ],
  go: [
    { subs: ["get"], values: new Set(["-C", "-modfile", "-tags", "-ldflags", "-gcflags"]) },
    { subs: ["install"], values: new Set(["-C", "-modfile", "-tags", "-ldflags", "-gcflags", "-o", "-p"]) },
  ],
  gem: [{ subs: ["install"], values: new Set(["-v", "--version", "-i", "--install-dir", "-n", "--bindir", "-s", "--source", "--platform", "-P", "--trust-policy", "-g", "--file"]), local: (word) => LOCAL_PACKAGE.test(word) || word.endsWith(".gem") }],
  composer: [{ subs: ["require"], values: new Set(["-d", "--working-dir"]) }],
  bundle: [{ subs: ["add"], values: new Set(["-v", "--version", "-g", "--group", "-s", "--source", "--require", "--path", "--git", "--github", "--branch", "--ref", "--glob"]) }],
}
const PYTHONS = /^python(\d+(\.\d+)?)?$/

/** Row 47e (M1-07): `name args` adds a named package from a registry (pip/uv/poetry/cargo/go/gem/composer and kin). */
function addsOtherRegistryPackage(name: string, args: readonly string[]): boolean {
  // `python3 -m pip install x` is pip's own add.
  if (PYTHONS.test(name) && args[0] === "-m" && (args[1] === "pip" || args[1] === "pip3"))
    return addsOtherRegistryPackage("pip", args.slice(2))
  const rules = Object.hasOwn(OTHER_ADDERS, name) ? OTHER_ADDERS[name]! : []
  return rules.some((rule) => {
    const words: string[] = []
    for (let index = 0; index < args.length; index++) {
      const word = args[index]!
      if (word === "--") continue
      if (word.startsWith("-")) {
        // An editable (`-e <spec>`) is a package spec; a value option's word is not.
        if ((word === "-e" || word === "--editable") && index + 1 < args.length) words.push(args[++index]!)
        else if (!word.includes("=") && rule.values.has(word)) index++
        else if (/^--(git|editable)=/.test(word)) words.push(word.slice(word.indexOf("=") + 1))
        continue
      }
      words.push(word)
    }
    if (!rule.subs.every((sub, at) => words[at] === sub)) return false
    const local = rule.local ?? ((word: string) => LOCAL_PACKAGE.test(word))
    return words.slice(rule.subs.length).some((word) => !local(word))
  })
}

/** Row 47e (M1-06): gh's options that take a value before the sub-command (`gh -R owner/repo pr create`). */
const GH_VALUES: ReadonlySet<string> = new Set(["-R", "--repo", "--hostname", "-X", "--method", "-H", "--header", "-f", "--field", "-F", "--raw-field", "--input", "-q", "--jq", "-t", "--template", "--cache"])
/** Row 47e (M1-06): the gh sub-commands that write to GitHub (a pull request, a release, a repository, an issue, a gist). */
const GH_WRITE = /^(pr (create|merge|comment|review|edit|close|reopen|ready|lock|unlock)|release (create|upload|edit|delete|delete-asset)|repo (create|fork|sync|edit|delete|rename|archive|unarchive|deploy-key add|set-default)|issue (create|comment|edit|close|reopen|delete|lock|unlock|transfer|pin|unpin|develop)|gist (create|edit|delete|clone)|label (create|edit|delete|clone)|secret (set|delete|remove)|variable (set|delete)|workflow (run|enable|disable)|run (rerun|cancel|delete)|cache delete|ruleset|project|codespace|ssh-key (add|delete)|gpg-key (add|delete)|org|attestation)\b/
/** Row 47e (M1-06): a gh call that writes: a write sub-command, or `gh api` with a method other than GET or with fields. */
function ghWrites(args: readonly string[]): boolean {
  const words: string[] = []
  let method: string | undefined
  let fields = false
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    const [flag, inline] = word.startsWith("--") && word.includes("=") ? [word.slice(0, word.indexOf("=")), word.slice(word.indexOf("=") + 1)] : [word, undefined]
    if (/^-X./.test(word)) method = word.slice(2)
    else if (flag === "-X" || flag === "--method") method = inline ?? args[++index]
    else if (["-f", "-F", "--field", "--raw-field", "--input"].includes(flag) || /^-[fF]./.test(word)) {
      fields = true
      if (inline === undefined && !/^-[fF]./.test(word)) index++
    } else if (word.startsWith("-")) {
      if (inline === undefined && GH_VALUES.has(flag)) index++
    } else words.push(word)
  }
  if (words[0] === "api") return fields || (method !== undefined && method.toUpperCase() !== "GET")
  return GH_WRITE.test(words.join(" "))
}

/** Row 47e (M1-05): how deep a script file or recipe that runs another one is read; past it, the call goes to the decider. */
const MAX_BODY_DEPTH = 3
/** Row 47e (M1-05): the largest script file or Makefile read. Larger is not read in full: the decider. */
const MAX_BODY_BYTES = 64 * 1024
/** A script file's first line that names a shell this reader reads (`#!/bin/sh`, `#!/usr/bin/env bash`). */
const SHELL_SHEBANG = /^#!\s*\S*\/(env\s+(-\S+\s+)*)?(sh|bash|zsh|dash|ksh)(\s|$)/
/** The words that run a file's text in the shell itself. */
const SOURCES: ReadonlySet<string> = new Set(["source", "."])
/** `make`'s options that change nothing about which recipe runs. Any other option is not read: the decider. */
const MAKE_PLAIN = /^(-s|--silent|--quiet|-k|--keep-going|-w|--print-directory|--no-print-directory|-j\d*|--jobs(=\d+)?|-B|--always-make|-r|--no-builtin-rules|-R|--no-builtin-variables)$/
/** Makefile lines this reader does not follow (includes, conditionals, a changed shell or recipe prefix): the decider. */
const MAKE_UNREAD = /^\s*(-?include|sinclude|define|endef|ifeq|ifneq|ifdef|ifndef|else|endif|override|vpath|load)\b|^\s*(SHELL|\.SHELLFLAGS|MAKEFLAGS|MFLAGS|MAKEFILES|\.RECIPEPREFIX|\.ONESHELL|\.DEFAULT|\.SUFFIXES)\b/

/** What a step runs from a file: the texts and the folder they run in, `unreadable`, or undefined for no such step. */
type Body = { readonly texts: readonly string[]; readonly cwd: string } | "unreadable"

/**
 * Row 47e (M1-05): the text of a local script file a step runs (`./deploy.sh`, `scripts/x.sh`, `bash x.sh`, `. ./env.sh`),
 * read as a shell text. `unreadable` when it cannot be read in full: missing, not a regular file, too large, a first line
 * naming another interpreter, or a binary inside the project. A program outside the project that is no script (a system
 * binary named by its path) is no body.
 */
function scriptFileBody(word: string, cwd: string, instance: InstanceContext): Body | undefined {
  const file = path.resolve(cwd, word)
  const inside = Reach.inside(file, instance)
  let text: string
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > MAX_BODY_BYTES) return inside ? "unreadable" : undefined
    text = fs.readFileSync(file, "utf8")
  } catch {
    return "unreadable"
  }
  const first = text.split("\n", 1)[0] ?? ""
  if (first.startsWith("#!")) return SHELL_SHEBANG.test(first) ? { texts: [text], cwd } : "unreadable"
  if (text.includes("\0")) return inside ? "unreadable" : undefined
  return { texts: [text], cwd }
}

/**
 * Row 47e (M1-05): the recipe lines `make <args>` runs in `cwd`, each a shell text, with the recipes of the targets it
 * depends on. `unreadable` for anything this small reader does not follow: an option it does not know, a variable on the
 * line, no Makefile, a target with no rule of its own, a `$` in a reached rule or recipe, a double-colon rule, includes and
 * conditionals.
 */
function makeBody(args: readonly string[], cwd: string, instance: InstanceContext): Body {
  let dir = cwd
  let named: string | undefined
  const goals: string[] = []
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    if (word === "-C" || word === "--directory") dir = path.resolve(dir, args[++index] ?? "")
    else if (word.startsWith("--directory=")) dir = path.resolve(dir, word.slice(12))
    else if (/^-C./.test(word)) dir = path.resolve(dir, word.slice(2))
    else if (word === "-f" || word === "--file" || word === "--makefile") named = args[++index]
    else if (/^--(file|makefile)=/.test(word)) named = word.slice(word.indexOf("=") + 1)
    else if (word === "-j" && /^\d+$/.test(args[index + 1] ?? "")) index++
    else if (MAKE_PLAIN.test(word)) continue
    else if (word.startsWith("-") || word.includes("=") || word.includes("$")) return "unreadable"
    else goals.push(word)
  }
  if (named?.includes("$") || dir.includes("$")) return "unreadable"
  const file = named !== undefined ? path.resolve(dir, named) : ["GNUmakefile", "makefile", "Makefile"].map((name) => path.join(dir, name)).find((each) => fs.existsSync(each))
  if (file === undefined || !Reach.inside(file, instance)) return "unreadable"
  let text: string
  try {
    if (fs.statSync(file).size > MAX_BODY_BYTES) return "unreadable"
    text = fs.readFileSync(file, "utf8")
  } catch {
    return "unreadable"
  }
  const rules = new Map<string, { prereqs: string[]; recipe: string[]; bad: boolean }>()
  let first: string | undefined
  let current: { prereqs: string[]; recipe: string[]; bad: boolean }[] = []
  let patterns = false
  const lines = text.split("\n")
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index]!.replace(/\r$/, "")
    if (line.startsWith("\t")) {
      if (current.length === 0) return "unreadable"
      // A recipe line, with its `\` continuations: one shell text.
      while (line.endsWith("\\") && index + 1 < lines.length) line = line.slice(0, -1) + lines[++index]!.replace(/^\t/, "")
      for (const rule of current) rule.recipe.push(line.slice(1))
      continue
    }
    while (line.endsWith("\\") && index + 1 < lines.length) line = line.slice(0, -1) + " " + lines[++index]!
    const bare = line.replace(/(^|\s)#.*$/, "").trimEnd()
    if (bare.trim() === "") continue
    if (MAKE_UNREAD.test(bare)) return "unreadable"
    if (/^\s*(export\s+|unexport\s+)?[\w.-]+\s*(\?|:|::|\+|!)?=/.test(bare)) {
      current = []
      continue
    }
    const rule = /^([^:=#\t][^:=#]*?)\s*(::?)(?!=)\s*([^;]*?)\s*(?:;\s*(.*))?$/.exec(bare)
    if (!rule) return "unreadable"
    const targets = rule[1]!.trim().split(/\s+/)
    const prereqs = (rule[3] ?? "").split(/\s+/).filter((word) => word !== "" && word !== "|")
    const bad = rule[2] === "::" || prereqs.some((word) => word.includes("=")) || [...targets, ...prereqs].some((word) => word.includes("$"))
    if (targets.some((target) => target.includes("%"))) patterns = true
    current = targets.map((target) => {
      const known = rules.get(target) ?? { prereqs: [], recipe: [], bad: false }
      // A second recipe for a target replaces the first (GNU make warns): not read.
      if (known.recipe.length > 0 && (rule[4] !== undefined || lines[index + 1]?.startsWith("\t"))) known.bad = true
      known.prereqs.push(...prereqs)
      known.bad ||= bad
      rules.set(target, known)
      return known
    })
    if (rule[4] !== undefined) for (const each of current) each.recipe.push(rule[4])
    first ??= targets.find((target) => !target.startsWith(".") && !target.includes("%"))
  }
  const wanted = goals.length > 0 ? goals : first !== undefined ? [first] : []
  if (wanted.length === 0) return "unreadable"
  const texts: string[] = []
  const seen = new Set<string>()
  const walk = (target: string, depth: number, goal: boolean): boolean => {
    if (seen.has(target)) return true
    seen.add(target)
    const rule = rules.get(target)
    // A goal needs a rule of its own; a prerequisite with none is a file, unless pattern rules may build it.
    if (!rule) return !goal && !patterns
    if (rule.bad || depth > 20) return false
    for (const prereq of rule.prereqs) if (!walk(prereq, depth + 1, false)) return false
    for (const line of rule.recipe) {
      const command = line.replace(/^[\s@+-]+/, "")
      if (command.includes("$")) return false
      if (command.trim() !== "") texts.push(command)
    }
    return true
  }
  for (const goal of wanted) if (!walk(goal, 0, true)) return "unreadable"
  return { texts, cwd: dir }
}

/**
 * Row 47e (M1-05): what a step runs from a file one level down: a local script file (by its path, through `sh|bash|zsh
 * <file>`, or `source`/`.`), or a Makefile recipe (`make`, `gmake`). Undefined for any other step.
 */
function stepBody(argv: readonly string[], cwd: string, instance: InstanceContext): Body | undefined {
  const found = BypassScreen.unwrap(argv)
  if (found.kind !== "program") return undefined
  if (found.name === "make" || found.name === "gmake") return makeBody(found.args, cwd, instance)
  if (SOURCES.has(found.name)) return found.args[0] === undefined ? undefined : scriptFileBody(found.args[0], cwd, instance)
  if (DeletionWords.SHELLS.has(found.name) && BypassScreen.runText(argv) === undefined) {
    // The first word past the shell's options is the file it runs; `-o <name>` takes a value. None: it reads stdin.
    for (let index = 0; index < found.args.length; index++) {
      const word = found.args[index]!
      if (word === "-o" || word === "+o" || word === "-O" || word === "+O") index++
      else if (word === "-s" || word === "--") return undefined
      else if (!/^[-+]/.test(word)) return scriptFileBody(word, cwd, instance)
    }
    return undefined
  }
  if (found.spelled.includes("/")) return scriptFileBody(found.spelled, cwd, instance)
  return undefined
}

/**
 * Row 47e (alias residual of 47a, C70): a step list that defines an alias (`alias x=...`) or a function (`function f`)
 * and names it in a later step. The alias's value is text no step shows, so what `x` runs cannot be told.
 */
function definesAndUses(steps: readonly { argv: readonly string[] }[]): boolean {
  const defined = new Set<string>()
  for (const step of steps) {
    const [program, ...args] = step.argv
    if (program === undefined) continue
    if (step.argv.some((word) => defined.has(word))) return true
    if (program === "alias")
      for (const word of args) if (!word.startsWith("-") && word.includes("=")) defined.add(word.slice(0, word.indexOf("=")))
    if (program === "function" && args[0] !== undefined) defined.add(args[0].replace(/\(\)$/, ""))
  }
  return false
}

/**
 * Row 29d (C46, OP-1): a SUBAGENT's shell call that leaves the parity path although its category is in
 * `SUBAGENT_RUNS_LIKE_ROOT`: one of its steps (texts and project scripts unwrapped, `BypassScreen.deepSteps`) is a form the
 * 1.1.1 rules recognise as leaving the machine (`BypassLists.OUTWARD_FORMS`: a hosted deploy, a publish, an image push), or
 * adds a named registry package. It goes to the main agent, where "cannot tell" refuses. The root is never asked here,
 * and nothing is reclassified: the line's category stays the table's.
 * Row 47e (C61): also a gh write (M1-06), another tool's named add (M1-07), an alias defined and used later in the call
 * (47a residual), and one level further down (M1-05): a local script file a step runs, or a Makefile recipe, read through
 * the same step reader; a file or recipe that cannot be read in full goes to the main agent too. The gate also asks this
 * of a call a P-01a task grant lifted to the root (M1-18): a grant never skips it.
 */
export function subagentSendsAnyway(input: Input): boolean {
  if (input.bypass?.caller !== "subagent") return false
  return sendsAnyway(input, 0)
}

function sendsAnyway(input: Input, depth: number): boolean {
  const deep = BypassScreen.deepSteps(input)
  // A body read one level down must be read in full; the call itself keeps the table's reading.
  if (depth > 0 && (deep.unreadable.length > 0 || deep.steps.length === 0)) return true
  if (definesAndUses(deep.steps)) return true
  return deep.steps.some((step) => {
    const found = BypassScreen.unwrap(step.argv)
    if (found.kind !== "program") return false
    const form = Object.hasOwn(BypassLists.OUTWARD_FORMS, found.name) ? BypassLists.OUTWARD_FORMS[found.name] : undefined
    if (form !== undefined && form(found.args)) return true
    if (addsRegistryPackage(found.name, found.args) || addsOtherRegistryPackage(found.name, found.args)) return true
    if (found.name === "gh" && ghWrites(found.args)) return true
    if (step.code !== undefined) return false
    return step.cwds.some((cwd) => {
      const body = stepBody(step.argv, cwd, input.instance)
      if (body === undefined) return false
      if (body === "unreadable" || depth >= MAX_BODY_DEPTH) return true
      return body.texts.some((text) => bodySends(input, text, body.cwd, depth + 1))
    })
  })
}

/** Row 47e (M1-05): a script file's or recipe line's text, read by the shell's own reader in full, sends anyway. */
function bodySends(input: Input, text: string, cwd: string, depth: number): boolean {
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text.replace(/[\n\t\r]/g, ""))) return true
  const steps = ScriptReader.read(text, cwd)
  const reading = shellReading(steps, input.instance)
  // Not read (an expansion, a function, a reader not ready) or not in full: what runs cannot be told.
  if (!steps || !reading?.complete) return true
  if (reading.steps.length === 0) return false
  return sendsAnyway({ ...input, cwd, patterns: [text], metadata: { command: text, steps } }, depth)
}

/** 1.2.7 U-7 (C21 b, c): the shells whose `-c` text is read as a command line, and whose script file is screened as one. */
const SHELL_TEXT_PROGRAMS: ReadonlySet<string> = new Set(["sh", "bash", "zsh"])

/** 1.2.7 row 47a (M1-04): the modes of zsh's `emulate`, whose `-c <text>` evaluates the text as `sh -c` does. */
const EMULATE_MODES: ReadonlySet<string> = new Set(["zsh", "sh", "ksh", "csh"])

/**
 * The text of a step that is exactly `sh|bash|zsh -c <text>`, or (row 47a, M1-04) zsh's `emulate [-lLR] <mode> -c <text>`;
 * undefined for any other shape, which then keeps the 1.2.6 path.
 */
function shellTextOf(argv: readonly string[]) {
  if (argv.length === 3 && SHELL_TEXT_PROGRAMS.has(argv[0]!) && argv[1] === "-c") return argv[2]
  if (argv[0] !== "emulate") return undefined
  let index = 1
  while (/^-[lLR]+$/.test(argv[index] ?? "")) index++
  return EMULATE_MODES.has(argv[index] ?? "") && argv[index + 1] === "-c" && argv.length === index + 3 ? argv[index + 2] : undefined
}

/**
 * 1.2.7 U-7 (C21 b): a call that is exactly `sh|bash|zsh -c '<one literal>'` (row 47a, M1-04: or zsh
 * `emulate <mode> -c '<literal>'`, `shellTextOf`) (one command, nothing before or after it, no
 * redirect, no `cd`, no `NAME=value`), as the text the shell will run: the literal read by the shell's own reader
 * (`ScriptReader`, the same tree-sitter `decompose` the shell tool gives `metadata.steps` with). undefined keeps the call
 * as it was (decided `unreadable_command`): the reader is not ready; the literal has an expansion, a substitution, a
 * variable, a glob or anything else the reader does not read in full; a control or format character, or a backslash before
 * a line break, that the reader and the shell might take differently (SR7-20); or it runs a shell text, an `eval` or a
 * launcher's code itself (one level only); or it deletes or replaces a file (`DeletionWords.deletesOrReplacesWide`), which
 * is refused on the 1.2.6 path with its 1.2.6 line. What the shell said about the outer text (archive, checkpoint) is not about the
 * inner one, so it is dropped: an inner deletion or overwrite is judged with nothing saved first.
 */
function shellTextCall(input: Input): Input | undefined {
  if (input.permission !== "bash") return undefined
  const command = input.metadata.command
  if (typeof command !== "string") return undefined
  const outer = ScriptReader.read(command, input.cwd)
  if (!outer || outer.steps.length !== 1 || outer.writes.length > 0 || outer.upward || outer.chdirs || outer.assigned)
    return undefined
  const step = outer.steps[0]!
  if (step.code !== undefined || step.cwds.length !== 1 || step.cwds[0] !== input.cwd) return undefined
  const text = shellTextOf(step.argv)
  if (text === undefined || text.trim() === "") return undefined
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text.replace(/[\n\t]/g, "")) || text.includes("\\\n")) return undefined
  const steps = ScriptReader.read(text, input.cwd)
  const reading = shellReading(steps, input.instance)
  if (!steps || !reading?.complete || reading.steps.length === 0) return undefined
  if (reading.steps.some((each) => BypassScreen.runText(each.argv) !== undefined)) return undefined
  // A deletion or a replacement in the text keeps the 1.2.6 path (refused, archive first), its line included (CHAR-05).
  if (reading.steps.some((each) => DeletionWords.deletesOrReplacesWide(each.argv, commandWords))) return undefined
  return {
    ...input,
    patterns: [text],
    metadata: { ...input.metadata, command: text, steps, archive: undefined, archiveTargets: undefined, checkpointTargets: undefined },
    whole: input.whole ?? command,
  }
}

/**
 * 1.2.7 U-7 (C21 c): `sh|bash|zsh <file> [args]` the table judged P `script` (`scriptForm`: screened, hashed by the shell)
 * runs that file as `./<file>` does, so the wide reader's "a shell with a script file cannot be read" is no deletion: the
 * script screen's `delete` flag is what refuses a script that deletes (`noWait` rule 3).
 */
function shellRunsScreenedScript(input: Input, category: string | undefined) {
  if (category !== "script" || input.permission !== "bash" || typeof input.metadata.command !== "string") return false
  const form = scriptForm(input.metadata.command)
  return form?.file !== undefined && form.program !== undefined && SHELL_TEXT_PROGRAMS.has(form.program)
}

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
function existingFile(file: string) {
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
function replacedWrites(command: string, writes: readonly string[], cwds: readonly string[]) {
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
const OPENED_BY_NO_WAIT = new WeakSet<Verdict>()

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
function openedByNoWait(verdict: Verdict) {
  OPENED_BY_NO_WAIT.add(verdict)
  return verdict
}

/**
 * Categories the overlay never opens. The first four are the person's in 1.1.0 already (P5 A2a, A2c, rule 6); the rest are
 * what the overlay itself holds, so overlaying a step's answer a second time keeps it (S1.15). `sensitive_file` (1.1.1
 * D-F1-2): an edit, write or patch of a file that changes later runs or what is allowed, and a shell write (`tee`, `sed -i`,
 * a redirect) to one, stays the person's. The one list: the gate (`index.ts`) reads it to refuse a forged verdict.
 */
export const KEPT_D: ReadonlySet<string> = new Set([
  "outward",
  "outward_not_in_mission",
  "outside_folder",
  "script_unreadable",
  "outside_write_held",
  "system_service",
  "process_not_own",
  "unreadable_command",
  "sensitive_file",
])
/** The script-screen flags that keep a `script_flagged` call for a person under consent. The one list (D-F1-3), which
 * lives in `bypass-lists.ts` so the screen reads the same one; re-exported here for the gate (`index.ts`). */
export const HARD_SCRIPT_FLAGS = BypassLists.HARD_SCRIPT_FLAGS

/**
 * The permissions Swarm's own tools ask with (`src/tool/*`, the session's plan and spend prompts). A name missing here only
 * keeps a call at its 1.1.0 verdict, which P8 allows, so the list errs short rather than long.
 */
const BUILT_IN_PERMISSIONS: ReadonlySet<string> = new Set([
  "bash",
  "edit",
  "read",
  "glob",
  "grep",
  "lsp",
  "git",
  "webfetch",
  "websearch",
  "task",
  "question",
  "todowrite",
  "skill",
  "external_directory",
  "plan_enter",
  "plan_exit",
])

/** 1.1.1 F9: an MCP tool (it carries its source), a tool that says nothing about itself, or a name no Swarm tool asks with. */
function externalTool(input: Input, base: Verdict) {
  const mcp = input.metadata.mcp
  if (typeof mcp === "object" && mcp !== null) return true
  if (base.category === "external_tool" || base.category === "mcp_tool") return true
  return !BUILT_IN_PERMISSIONS.has(input.permission)
}

/**
 * An edit, write or patch with any target `Reach.sensitive` sees (a hook, a manifest, a config), judged as the edit is.
 * 1.1.1 F12b (S4-2): or a tool's configuration (`Reach.consentSensitive`): a compiler or test run the consent opens writes
 * where that file says.
 */
function editsSensitive(input: Input) {
  if (input.permission !== "edit") return false
  const instance = input.instance
  // Without Git the worktree is `/`, and every name would be judged from the top of the disk.
  const base = instance.worktree === "/" ? { ...instance, worktree: instance.directory } : instance
  return editTargets(input).some((file) => Reach.consentSensitive(file, base))
}

/**
 * S1.13 under decision P8: the bypass loosens and never tightens. A call that is A without consent stays A; the only
 * answers stricter than the 1.1.0 one are the irreversible list and admin rights, which are refused (X), and (1.1.1 F25,
 * decision P40) a shell call whose reading is incomplete, which is held. Everything a
 * person kept in 1.1.0 stays theirs, and what this cannot read it does not open. First match wins.
 */
export function underConsent(input: Input, base: Verdict): Verdict {
  // 1. A spend limit or a repeating call stops the run for a person, whatever was consented.
  if (base.class === "B") return base
  // 1b. 1.1.1 F9 (P15 G2-5, P16): a plugin or MCP tool, or any tool that is not Swarm's own, keeps its 1.1.0 verdict. The
  // table cannot see what such a tool does, so the consent never opens it.
  if (externalTool(input, base)) return base
  // 1c. 1.2.6 row 37b (U6): the shell checkpoints this call before it runs (A `checkpointed`), or no checkpoint can hold
  // what it changes (X `checkpoint_failed`). The screen's "nothing can undo it" is what the checkpoint answers.
  if (base.category === "checkpointed" || base.category === "checkpoint_failed") return base
  // 2. Nothing can undo it, or it asks for admin rights: refused by code before any agent sees it.
  const found = BypassScreen.screen(input)
  if (found.x === "irreversible" || found.x === "admin_rights") return refused(found.x)
  // 2b. 1.1.1 F30 (G12-7, P42): a push to a place that is no remote of the repository is refused, as P42 and the consent
  // dialog say. Decision D-F30-1: stricter than 1.1.0 (which held a push to a folder), by the person's own choice in P42.
  if (consentRefusedPush(input)) return refused("credential_change")
  // 3. A write outside the project waits for a person instead of being refused (P5 A2c); any other X stays X.
  if (base.class === "X") return base.category === "outside_write" ? held("outside_write_held") : base
  // 3b. 1.1.1 F25 (CR11-1, V11-1): a shell call whose reading the screen could not finish (more distinct `cd`s than are
  // judged) waits for a person, as it did when such a reading was unread: the consent never takes 1.1.0's A for it.
  if (base.class === "A" && input.permission === "bash" && shellReading(input.metadata.steps, input.instance)?.complete === false)
    return held("unreadable_command")
  // 4. P8: what ran without consent (a look, a ticked destination, a webfetch) runs as it did.
  if (base.class === "A") return base
  // 5. A deletion the shell cannot archive is never opened. 1.1.3 (T3): it does not wait either; the agent is told at once
  // to delete with a command of its own, which the shell moves to the archive.
  if (found.x === "delete_compound") return refused("delete_compound")
  // 6. What leaves the machine, a system service, a process Swarm did not start, text nobody can read: kept for a person.
  if (found.d) return base.class === "D" ? held(found.d) : base
  // 6a. 1.1.1 F26 (P42): a call that sends only where the person allowed (a local or named host, a remote the repository
  // had, a publish or deploy) is not kept for that reason; every check below still applies to it.
  const sends = OUTWARD_HELD.has(base.category ?? "") ? consentOutward(input) : undefined
  if (base.category !== undefined && KEPT_D.has(base.category) && sends === undefined) return base
  // 6b. An edit of a sensitive file keeps its 1.1.0 verdict, whatever category it carries (a P edit-not-ordinary included).
  if (editsSensitive(input)) return base
  // 7. What nothing could undo (a deletion or overwrite the shell could not archive, a label of `irreversible`) stays for
  // the person. Rule 9 would keep every such shell call too; this keeps it for any other tool as well.
  if (base.category === "not_reversible") return base
  // 7b. 1.1.1 F10a (G3-4): an edit nothing can undo keeps its 1.1.0 verdict. Rule 4 has already let through the one that
  // was A in 1.1.0 (an ordinary file inside the folder); any other (a file that is not ordinary) is not opened.
  if (input.permission === "edit" && (input.editClass === "no_undo" || !input.canUndo)) return base
  // 8. 1.1.1 F1b (P10, P11), kept as an extra check: a shell, inline code or an unscreened script, an alias, an unknown
  // program before a risky one, SQL from a file or stdin, anything the wide reader sees deleting or replacing, or a command
  // substitution with anything unknown in it: the 1.1.0 verdict stands.
  if (BypassScreen.unclear(input, base) !== undefined) return base
  // 9. 1.1.1 F7 (P15): a shell call is opened only when every step is a development command the allowlist recognises, in a
  // form it recognises, and the shell's own reading carries no label. Anything else keeps its 1.1.0 verdict. A flagged or
  // unflagged script never matches it, so neither does any form rule 7 of F1b used to judge.
  // 1.1.1 F12b (Perf P2, S4-2): the undo-snapshot question of every file the call writes is asked once, in one batch, after
  // the allowlist; a file outside the snapshot, or a tool's configuration, keeps the 1.1.0 verdict.
  if (input.permission === "bash" || input.permission === "external_directory") {
    // 1.1.1 F14 (G5-P2): a call the allowlist does not open keeps 1.1.0 whatever git says, so git is not asked.
    const allowed = Reach.deferSnapshot(
      () => BypassScreen.allowlisted(input, base),
      (value) => value === true,
    )
    if (!allowed.value || allowed.outside) return base
  }
  // 10. Anything else held or judged: the main agent decides it.
  if ((base.class !== "D" && base.class !== "P") || base.category === undefined) return base
  const destinations = sends ?? consentOutward(input)
  return {
    class: "A",
    decidedBy: "agent",
    category: "by_main_agent",
    bypassed: base.category,
    ...(destinations && { destination: destinations.join(", ") }),
  }
}

/** 1.1.1 F26 (P42): the held categories a send carries in 1.1.0, which the consent may open (`consentOutward`). */
export const OUTWARD_HELD: ReadonlySet<string> = new Set(["outward", "outward_not_in_mission"])

/**
 * 1.1.1 F26 (P42): where a call the consent may let out sends, step by step in order, or undefined when it sends nowhere
 * P42 opens or any send in it is held. The gate asks it again on a verdict that opened an outward category (S1.36).
 */
export function consentOutward(input: Input): string[] | undefined {
  if (input.permission === "webfetch") {
    const found = OutwardConsent.fetch(input.metadata.url, input.patterns, input.outward)
    return "held" in found ? undefined : found.destinations
  }
  if (input.permission !== "bash") return undefined
  return BypassScreen.outwardOpened(input)
}

/**
 * 1.1.1 F26 (P42): the repository and remote of every `git push` step of a call, when they are one: a push without force
 * (`OutwardConsent.pushWords`) in a folder of a repository the consent snapshot knew, with no other repository between, to
 * a remote it named, or with none named to its only remote. The gate runs `OutwardKnown.recheck` on this.
 */
export function consentPushTarget(
  input: Pick<Input, "metadata" | "cwd">,
  snapshot: OutwardKnown.Snapshot,
  // 1.1.1 F29 (P44): with the project, the pushes inside the project scripts the call runs by name count as its own.
  instance?: Input["instance"],
) {
  const own = BypassScreen.readSteps(input) ?? []
  // 1.1.1 F30 (G12-P3): only a script whose manifest says `push` is expanded.
  const steps = instance
    ? own.flatMap((step) => [
        step,
        ...step.cwds.flatMap((cwd) =>
          BypassScreen.scriptMayPush(step.argv, cwd, instance) ? BypassScreen.scriptSteps(step.argv, cwd, instance) : [],
        ),
      ])
    : own
  let target: { repo: string; remote: string } | undefined
  for (const step of steps) {
    if (step.argv[0] !== "git" || step.argv[1] !== "push") continue
    for (const cwd of step.cwds) {
      const found = pushAt(step.argv, cwd, snapshot)
      if (!found || (target && (target.repo !== found.repo || target.remote !== found.remote))) return undefined
      target = found
    }
  }
  return target
}

function pushAt(argv: readonly string[], cwd: string, snapshot: OutwardKnown.Snapshot) {
  const named = OutwardConsent.pushWords(argv)
  if (named === undefined) return undefined
  const here = Reach.real(cwd)
  if (here === undefined) return undefined
  const repo = snapshot.repos.filter((item) => within(item.dir, here)).toSorted((a, b) => b.dir.length - a.dir.length)[0]
  if (!repo || !noRepositoryBetween(here, repo.dir)) return undefined
  const remote = named === "" ? (repo.remotes.length === 1 ? repo.remotes[0]!.name : undefined) : named
  if (!remote || !repo.remotes.some((item) => item.name === remote)) return undefined
  return { repo: repo.dir, remote }
}

/**
 * 1.1.1 F30 (G12-7, P42): under consent, a `git push` of the call, or of a project script it runs by name, whose repository
 * word is a place (a URL, `host:path`, a path to a folder) or a name the consent snapshot's repository for that folder
 * has no remote of. Without a snapshot only a place counts.
 */
export function consentRefusedPush(input: Input): boolean {
  if (input.permission !== "bash" || typeof input.metadata.command !== "string") return false
  const own = BypassScreen.readSteps(input) ?? []
  const steps = own.flatMap((step) => [step, ...step.cwds.flatMap((cwd) => BypassScreen.scriptSteps(step.argv, cwd, input.instance))])
  const snapshot = input.outward?.snapshot
  return steps.some((step) => {
    const words = OutwardConsent.pushRepositories(step.argv)
    if (!words) return false
    return words.some((word) => {
      if (OutwardConsent.pushPlace(word)) return true
      if (!snapshot) return false
      return step.cwds.some((cwd) => {
        const here = Reach.real(cwd)
        if (here === undefined) return false
        const repo = snapshot.repos.filter((item) => within(item.dir, here)).toSorted((a, b) => b.dir.length - a.dir.length)[0]
        return repo !== undefined && noRepositoryBetween(here, repo.dir) && !repo.remotes.some((remote) => remote.name === word)
      })
    })
  })
}

/**
 * 1.1.1 F26 (P42): one `git push` step the consent lets out: to a remote the snapshot knew (`pushAt`), whose recheck just
 * now found the same push URLs (a missing `gh` login is no reason to hold it: git uses its own credentials), in a
 * repository the guard vouches for, run in a folder a command may run in. undefined: not a push.
 */
export function consentPush(argv: readonly string[], cwd: string, input: Pick<Input, "outward" | "instance">): OutwardConsent.Reading | undefined {
  if (argv[0] !== "git" || argv[1] !== "push") return undefined
  const snapshot = input.outward?.snapshot
  const target = snapshot && canRunIn(cwd, input.instance) ? pushAt(argv, cwd, snapshot) : undefined
  if (!target || GitGuard.inspect(target.repo).refused !== undefined) return { held: "form" }
  const check = input.outward?.recheck
  if (!check || check.repo !== target.repo || check.remote !== target.remote) return { held: "form" }
  if (!check.result.ok && check.result.reason !== "no_credential") return { held: "form" }
  return { destinations: [target.remote], outputs: [] }
}

export * as AutonomyTable from "./autonomy-table"
