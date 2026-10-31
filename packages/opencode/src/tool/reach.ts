// Where a path really lands, and whether Undo can bring it back. A name inside the project proves nothing on its own: a
// symlink can carry it anywhere, and the step's snapshot leaves ignored files, large files and nested repositories out.
import fs from "node:fs"
import { stat } from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Effect } from "effect"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { Risk } from "./risk"
import { Secrets } from "./secrets"

const git = promisify(execFile)
// Matches the size above which a step's snapshot leaves an untracked file out.
const SNAPSHOT_FILE_LIMIT = 2 * 1024 * 1024
const MAX_LINKS = 40

/**
 * The path a write here would really touch, including through a dangling link, which a write would create on the far
 * side of. undefined means it could not be worked out, such as a link loop.
 */
export function real(file: string, depth = 0): string | undefined {
  if (depth > MAX_LINKS) return undefined
  const whole = attempt(() => fs.realpathSync.native(file))
  if (whole) return whole
  const parent = path.dirname(file)
  if (parent === file) return file
  const link = attempt(() => fs.readlinkSync(file))
  if (link) return real(path.resolve(parent, link), depth + 1)
  const base = real(parent, depth + 1)
  return base && path.join(base, path.basename(file))
}

function attempt(read: () => string) {
  try {
    return read()
  } catch {
    return undefined
  }
}

function realRoots(instance: InstanceContext) {
  return {
    ...instance,
    directory: real(instance.directory) ?? instance.directory,
    worktree: instance.worktree === "/" ? "/" : (real(instance.worktree) ?? instance.worktree),
  }
}

/** Inside the project once every symlink on the way has been followed. */
export function inside(file: string, instance: InstanceContext) {
  const target = real(file)
  return target !== undefined && containsPath(target, realRoots(instance))
}

/** A symlink named `notes` that points at `.git/config` changes the same thing, so both names are checked. */
export function sensitive(file: string, instance: InstanceContext) {
  const target = real(file)
  if (target === undefined) return true
  return (
    Risk.sensitive(path.relative(instance.worktree, file)) ||
    Risk.sensitive(path.relative(realRoots(instance).worktree, target))
  )
}

export function secret(file: string) {
  const target = real(file)
  return target === undefined || Secrets.secretFile(file) || Secrets.secretFile(target)
}

/** Whether the step's snapshot would leave anything under these paths behind, so Undo could not bring it back. */
export async function outsideSnapshot(worktree: string, paths: string[], options?: { untrackedOnly?: boolean }) {
  const list = async (...args: string[]) =>
    (await git("git", ["-C", worktree, "ls-files", "-z", "--others", "--exclude-standard", ...args, "--", ...paths], { maxBuffer: 64 * 1024 * 1024 })).stdout
      .split("\0")
      .filter(Boolean)
  try {
    if (!options?.untrackedOnly) {
      if ((await list("--ignored", "--directory")).some((file) => !Risk.rebuilt(file))) return true
      // ls-files only lists what exists. A new file in an ignored place is just as far out of Undo's reach.
      const ignored = await git("git", ["-C", worktree, "check-ignore", "--", ...paths]).then(
        (out) => out.stdout.split("\n").filter(Boolean),
        (error: { code?: number }) => {
          if (error.code === 1) return [] as string[]
          throw error
        },
      )
      if (ignored.some((file) => !Risk.rebuilt(path.relative(worktree, path.resolve(worktree, file))))) return true
    }
    const untracked = await list()
    // Listed with a trailing slash, an untracked directory is a repository of its own. Its history is not in the snapshot.
    if (untracked.some((file) => file.endsWith("/"))) return true
    const sizes = await Promise.all(
      untracked.map((file) => stat(path.join(worktree, file)).then((info) => info.size, () => 0)),
    )
    return sizes.some((size) => size > SNAPSHOT_FILE_LIMIT)
  } catch {
    return true
  }
}

const MAX_WALKED = 20_000
// Directories whose contents can hold a credential under any name. `.git/config` carries remote URLs with their tokens.
const HOLDS_SECRETS = /(^|\/)(\.git|\.envs|\.ssh|\.aws|\.gnupg)(\/|$)/i

/** Whether what is in this file may reach the model through a command with nobody asked. */
export function readable(file: string) {
  const target = real(file)
  return target !== undefined && !secret(file) && !HOLDS_SECRETS.test(file) && !HOLDS_SECRETS.test(target)
}

/**
 * Whether a recursive read here could only print ordinary files. A pattern is a question, so a count or a match is one
 * bit of a secret and enough of them are all of it. No scrubber sees that, so a walk that reaches a secret file asks. A
 * link can lead anywhere, and past the budget nothing is known, and neither is proven.
 */
export function walkable(directory: string) {
  const target = real(directory)
  if (target === undefined) return false
  const pending = [target]
  let seen = 0
  while (pending.length > 0) {
    const current = pending.pop()!
    if (HOLDS_SECRETS.test(path.basename(current)) || Secrets.secretFile(current)) return false
    const info = fs.lstatSync(current, { throwIfNoEntry: false })
    if (!info) return false
    if (info.isSymbolicLink()) return false
    if (!info.isDirectory()) continue
    const entries = attemptList(current)
    if (!entries) return false
    seen += entries.length
    if (seen > MAX_WALKED) return false
    pending.push(...entries.map((entry) => path.join(current, entry)))
  }
  return true
}

function attemptList(directory: string) {
  try {
    return fs.readdirSync(directory)
  } catch {
    return undefined
  }
}

// Each of these makes a bare `ls` something other than the `ls` it looks like, before any of its arguments are read.
const REPLACES_A_PROGRAM = /^(LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_.+|BASH_FUNC_.+|GREP_OPTIONS)$/
const SOURCED_BY_THE_SHELL = ["BASH_ENV", "ENV", "ZDOTDIR"]

/**
 * Whether the environment leaves a bare command name meaning the system's program, in a project that may be hostile. A
 * relative or empty entry in PATH, or one inside the project, lets the repository supply its own `ls`.
 */
export function plainEnvironment(env: NodeJS.ProcessEnv, instance: InstanceContext) {
  if (Object.keys(env).some((key) => REPLACES_A_PROGRAM.test(key))) return false
  const roots = realRoots(instance)
  const outside = (entry: string) => {
    const target = path.isAbsolute(entry) ? real(entry) : undefined
    return target !== undefined && !containsPath(target, roots)
  }
  if (!(env.PATH ?? "").split(path.delimiter).every(outside)) return false
  return SOURCED_BY_THE_SHELL.every((key) => env[key] === undefined || outside(env[key]!))
}

/** The names a change reaches, as this worktree spells them: through a link it lands somewhere else in the project. */
export function landsOn(files: string[], instance: InstanceContext) {
  const root = realRoots(instance).worktree
  return [
    ...new Set(
      files.flatMap((file) => {
        const target = real(file)
        return target && containsPath(target, realRoots(instance))
          ? [file, path.join(instance.worktree, path.relative(root, target))]
          : [file]
      }),
    ),
  ]
}

/** What to tell the permission layer about an edit to these files. */
export const editTrust = Effect.fn("Reach.editTrust")(function* (
  ctx: { trust?: { canUndo: boolean } },
  instance: InstanceContext,
  files: string[],
) {
  if (!ctx.trust?.canUndo) return { harmless: false }
  if (files.some((file) => !inside(file, instance))) return { harmless: false, risk: "irreversible" as const }
  if (files.some((file) => sensitive(file, instance) || secret(file))) return { harmless: false }
  if (yield* Effect.promise(() => outsideSnapshot(instance.worktree, landsOn(files, instance))))
    return { harmless: false, risk: "irreversible" as const }
  return { harmless: true }
})

export * as Reach from "./reach"
