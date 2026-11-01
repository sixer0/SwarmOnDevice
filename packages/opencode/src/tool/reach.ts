// Where a path really lands, and whether Undo can bring it back. A name inside the project proves nothing on its own: a
// symlink can carry it anywhere, and the step's snapshot leaves ignored files, large files and nested repositories out.
import fs from "node:fs"
import { stat } from "node:fs/promises"
import path from "node:path"
import { devNull } from "node:os"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { Risk } from "./risk"
import { Secrets } from "./secrets"

const git = promisify(execFile)
// Asking whether Undo can help must not itself run what the repository says to.
const QUIET = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${devNull}`]
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
    (await git("git", [...QUIET, "-C", worktree, "ls-files", "-z", "--others", "--exclude-standard", ...args, "--", ...paths], { maxBuffer: 64 * 1024 * 1024 })).stdout
      .split("\0")
      .filter(Boolean)
  try {
    if (!options?.untrackedOnly) {
      if ((await list("--ignored", "--directory")).some((file) => !Risk.rebuilt(file))) return true
      // ls-files only lists what exists. A new file in an ignored place is just as far out of Undo's reach.
      const ignored = await git("git", [...QUIET, "-C", worktree, "check-ignore", "--", ...paths]).then(
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

// Directories whose contents can hold a credential under any name. `.git/config` carries remote URLs with their tokens.
const HOLDS_SECRETS = /(^|\/)(\.git|\.envs|\.ssh|\.aws|\.gnupg|\.kube|\.docker)(\/|$)/i

/** Whether what is in this file may reach the model through a read tool with nobody asked. */
export function readable(file: string) {
  const target = real(file)
  return target !== undefined && !secret(file) && !HOLDS_SECRETS.test(file) && !HOLDS_SECRETS.test(target)
}

/** The same judgement for a name in a repository, which may not be on disk any more. */
export const readableName = (name: string) => !Secrets.secretFile(name) && !HOLDS_SECRETS.test(name)

/**
 * The rule an "Allow always" may leave behind for this command, or undefined when there is none to offer and none that
 * could answer it: only one plain command, naming nothing outside the project and no secret, whatever comes after it.
 */
export function alwaysFor(command: string, cwd: string, instance: InstanceContext) {
  const words = Risk.plainWords(command)
  if (!words || !inside(cwd, instance)) return undefined
  const named = words.slice(1).flatMap((word) => word.replace(/^-[A-Za-z]/, "").split(/[=,:@]/)).filter(Boolean)
  const stays = named.every((word) => {
    if (word.startsWith("-")) return true
    const file = path.resolve(cwd, word)
    return !word.startsWith("/") && !word.includes("..") && inside(file, instance) && readable(file)
  })
  return stays ? Risk.scope(command) : undefined
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

/** Ordinary by both of its names, and not somewhere a global config loads from, even when that is the open project. */
function ordinary(file: string, instance: InstanceContext) {
  const target = real(file)
  const loaded = [Global.Path.config, process.env.OPENCODE_CONFIG_DIR, process.env.SWARM_CONFIG_DIR].filter((dir) => dir !== undefined)
  if (target === undefined || loaded.some((dir) => !path.relative(real(dir) ?? dir, target).startsWith(".."))) return false
  return (
    Risk.ordinaryEdit(path.relative(instance.worktree, file)) &&
    Risk.ordinaryEdit(path.relative(realRoots(instance).worktree, target))
  )
}

/** What to tell the permission layer about an edit to these files. */
export const editTrust = Effect.fn("Reach.editTrust")(function* (
  ctx: { trust?: { canUndo: boolean } },
  instance: InstanceContext,
  files: string[],
) {
  if (!ctx.trust?.canUndo) return { harmless: false, editClass: "no_undo" as const }
  if (files.some((file) => !inside(file, instance)))
    return { harmless: false, risk: "irreversible" as const, editClass: "no_undo" as const }
  if (files.some((file) => secret(file))) return { harmless: false, editClass: "secret" as const }
  if (files.some((file) => sensitive(file, instance))) return { harmless: false, editClass: "sensitive" as const }
  if (yield* Effect.promise(() => outsideSnapshot(instance.worktree, landsOn(files, instance))))
    return { harmless: false, risk: "irreversible" as const, editClass: "no_undo" as const }
  const harmless = files.every((file) => ordinary(file, instance))
  return { harmless, editClass: harmless ? ("ordinary" as const) : ("not_ordinary" as const) }
})

export * as Reach from "./reach"
