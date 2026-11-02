import path from "path"
import { Effect } from "effect"
import { InstanceState } from "@/effect/instance-state"
import type * as Tool from "./tool"
import { containsPath } from "../project/instance-context"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Reach } from "./reach"
import { LibraryRoot } from "@/skill/library-root"

type Kind = "file" | "directory"

type Options = {
  bypass?: boolean
  kind?: Kind
  /** The caller only reads, and shows what it read as text. Nothing that writes or runs may set this. */
  readOnly?: boolean
  /** The caller also opens hidden files under the target (ripgrep runs with `--hidden`). Read by the autonomy table. */
  searchesHidden?: boolean
}

export const assertExternalDirectoryEffect = Effect.fn("Tool.assertExternalDirectory")(function* (
  ctx: Tool.Context,
  target?: string,
  options?: Options,
) {
  if (!target) return false

  if (options?.bypass) return false

  const ins = yield* InstanceState.context
  const full = process.platform === "win32" ? FSUtil.normalizePath(target) : target
  const named = containsPath(full, ins)
  if (named && Reach.inside(full, ins)) return false

  const root = bundledRoot()
  // A symlink in the project that leads out of it: what the person is being asked about is where it leads. The library
  // gets the same, because a name under it is what would otherwise pass.
  const landed = named || (root !== undefined && within(root, full)) ? (Reach.real(full) ?? full) : full
  const kind = options?.kind ?? "file"
  const dir = kind === "directory" ? landed : path.dirname(landed)
  const glob =
    process.platform === "win32"
      ? FSUtil.normalizePathPattern(path.join(dir, "*"))
      : path.join(dir, "*").replaceAll("\\", "/")

  yield* ctx.ask({
    permission: "external_directory",
    patterns: [glob],
    always: withholdsAlways(full, kind) ? [] : [glob],
    metadata: {
      filepath: landed,
      parentDir: dir,
      // Read by the autonomy table, which sorts a read out of the folder apart from a write.
      ...(options?.readOnly ? { readOnly: true } : {}),
      ...(options?.searchesHidden ? { hidden: true } : {}),
    },
    harmless:
      options?.readOnly && ctx.trust?.library && libraryRead(full, ctx.trust.library, Reach.real) ? true : undefined,
  })
  return true
})

/**
 * A read of the bundled library needs no prompt. The root is compared as text and never reaches a Wildcard, since a folder
 * above the app can be named anything. `real` is passed in so this can be checked without a disk.
 */
export function libraryRead(raw: string, root: string, real: (file: string) => string | undefined) {
  if (!path.isAbsolute(raw)) return false
  // On the text, whatever realpath says: the OS follows `link` in `link/..` first, and runtimes disagree on the answer.
  if (raw.split(/[\\/]/).includes("..")) return false
  if (!within(root, path.normalize(raw))) return false
  const target = real(raw)
  return target !== undefined && within(root, target)
}

/**
 * Whether this target, or the `dir/*` pattern asked about it, reaches the library. An approved pattern answers for every
 * later caller of this gate, including the ones that write, so such a pattern must never be kept. `*` crosses `/`, so a
 * parent of the root counts, and so does a pattern that could match the root through its own wildcard characters.
 */
export function touchesLibrary(target: string, kind: Kind, root: string, real: (file: string) => string | undefined) {
  return [target, path.normalize(target), real(target)]
    .filter((place) => place !== undefined)
    .some((place) => {
      const dir = kind === "directory" ? place : path.dirname(place)
      return within(root, place) || within(dir, root) || WILDCARD.test(dir)
    })
}

/** IZ-5 for a caller that has its own prompt. From the resolver, not the session: it holds while the feature is off too. */
export function withholdsAlways(target: string, kind: Kind) {
  const root = bundledRoot()
  return root !== undefined && touchesLibrary(target, kind, root, Reach.real)
}

// What Wildcard treats as special in a pattern. A backslash becomes `/` there, but is an ordinary separator on Windows.
const WILDCARD = process.platform === "win32" ? /[*?]/ : /[*?\\]/

const within = (parent: string, file: string) =>
  file === parent || file.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)

function bundledRoot() {
  const status = LibraryRoot.current()
  return status.kind === "available" ? status.root : undefined
}

export async function assertExternalDirectory(ctx: Tool.Context, target?: string, options?: Options) {
  return Effect.runPromise(assertExternalDirectoryEffect(ctx, target, options))
}
