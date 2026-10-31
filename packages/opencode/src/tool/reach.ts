// Where a path really lands, and whether Undo can bring it back. A name inside the project proves nothing on its own: a
// symlink can carry it anywhere, and the step's snapshot leaves ignored files, large files and nested repositories out.
import fs from "node:fs"
import { readdir, stat } from "node:fs/promises"
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

/** A command that fires these hooks is running repository code, so it only counts as a plain file change without any. */
export async function hasGitHooks(directory: string, names?: readonly string[]) {
  try {
    const run = (...args: string[]) => git("git", ["-C", directory, ...args]).then((out) => out.stdout.trim())
    const custom = await run("config", "--get", "core.hooksPath").catch(() => "")
    const dir = custom
      ? path.resolve(directory, custom)
      : await run("rev-parse", "--path-format=absolute", "--git-path", "hooks")
    const hooks = (await readdir(dir).catch(() => [] as string[])).filter((file) => !file.endsWith(".sample"))
    return names ? hooks.some((file) => names.includes(file)) : hooks.length > 0
  } catch {
    return true
  }
}

const PROGRAM_SETTING =
  /^(core\.(sshcommand|pager|askpass|gitproxy|editor)|diff\.external|diff\..+\.(command|textconv)|filter\..+\.(clean|smudge|process)|merge\..+\.driver|gpg(\..+)?\.program|credential(\..+)?\.helper|sequence\.editor|pager\..+|interactive\.difffilter|uploadpack\.packobjectshook|include\.path|includeif\..+\.path)$/i

/**
 * Whether this repository's own config makes even `git status` run a program. It is the repository's file, which may
 * have arrived in a tarball, unlike the user's global config, so it is not taken as the user's choice.
 */
export async function hasGitPrograms(directory: string) {
  const local = await git("git", ["-C", directory, "config", "--local", "--get-regexp", "."]).then(
    (out) => out.stdout,
    // Exit 1 is no match. Outside a repository, git has nothing to run either.
    () => "",
  )
  return local.split("\n").some((line) => {
    const space = line.indexOf(" ")
    const key = space < 0 ? line : line.slice(0, space)
    if (key.toLowerCase() === "core.fsmonitor") return !/^(true|false|0|1)$/i.test(line.slice(space + 1).trim())
    return PROGRAM_SETTING.test(key)
  })
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
  if (yield* Effect.promise(() => outsideSnapshot(instance.worktree, files)))
    return { harmless: false, risk: "irreversible" as const }
  return { harmless: true }
})

export * as Reach from "./reach"
