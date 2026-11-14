// Part of the autonomy table (R-1, 1.2.8): The checkpoint plan for commands that change files.
// Moved unchanged from `autonomy-table.ts`, which re-exports the public names; import from there, not from here.
import path from "node:path"
import type { ProjectTrust } from "@opencode-ai/core/project/trust"
import type { InstanceContext } from "../../project/instance-context"
import { Reach } from "../../tool/reach"
import { Risk } from "../../tool/risk"
import { Secrets } from "../../tool/secrets"
import { refused, type Input, type Verdict } from "./types"
import { classifyShellWrite, programInProject, shellReading, shellWrites, type Step } from "./shell-steps"
import { onlyLooks, printsOnly } from "./read-class"
import { WORD_BREAK, canRunIn, gitAllowed } from "./routine"
import { commandWords } from "./outward"
import { existingFile, replacedWrites } from "./destroys"
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

/**
 * 1.2.7 row 47j (U9-9, C76): zsh's `print`, as a printer for the checkpoint only (it is no read of its own: `single` and
 * the read class do not take it). Words, `--`, and only the options that shape the text: `-r` raw, `-n` no newline, `-l`
 * one per line, `-N` NUL-separated, `-c` columns, `-a` across, `-o`/`-O`/`-i` sorted, `-D`/`-P` named directories
 * and prompt escapes, `-R` echo-like. Not `-C n` (takes a value), `-u n` (another descriptor), `-p` (the coprocess), `-s`/`-S` (history), `-z`
 * (the editing buffer), `-v name` (a variable), `-f` (a format reading `%` escapes is still text, but kept out with the
 * rest as nothing here needs it).
 */
const ZSH_PRINT_FLAG = /^-[rnlNcaoOiDPR]+$/
function zshPrints(words: readonly string[]) {
  if (words[0] !== "print") return false
  let options = true
  for (const word of words.slice(1)) {
    if (!options || !word.startsWith("-") || word === "-") {
      options = false
      continue
    }
    if (word === "--") options = false
    else if (!ZSH_PRINT_FLAG.test(word)) return false
  }
  return true
}

/** A step that only prints, or only looks at files inside the project that are readable and hold no secret. */
function checkpointLooks(step: Step, instance: InstanceContext) {
  if (printsOnly(step.argv) || zshPrints(step.argv)) return true
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
export function classifyCheckpoint(input: Input): Verdict | undefined {
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
