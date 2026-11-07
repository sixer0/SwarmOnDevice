import { existsSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, posix, resolve, sep } from "node:path"
import { StoreError } from "./errors.ts"

export const STORE_DB_FILE = "datum-studio.sqlite"
export const STORE_LOCK_FILE = "datum-studio.lock"

/**
 * The store root comes only from the caller (spec §8.1): absolute, normalised, not `/`, not $HOME,
 * not inside an app bundle (`*.app/Contents/...`, covers Res/). The store never reads env or cwd.
 */
export function assertStoreRoot(root: unknown): string {
  if (typeof root !== "string" || root.length === 0) throw new StoreError("STORE_ROOT_INVALID", "store root missing")
  if (root.includes("\u0000")) throw new StoreError("STORE_ROOT_INVALID", "store root contains NUL")
  if (!isAbsolute(root)) throw new StoreError("STORE_ROOT_INVALID", "store root must be absolute", { root })
  const norm = resolve(root)
  if (norm !== root.replace(/\/+$/, "") && norm !== root) throw new StoreError("STORE_ROOT_INVALID", "store root not normalised", { root })
  if (norm === "/" || norm === sep) throw new StoreError("STORE_ROOT_INVALID", "store root is /")
  if (norm === resolve(homedir())) throw new StoreError("STORE_ROOT_INVALID", "store root is the home folder")
  if (/\.app\/Contents(\/|$)/.test(norm)) throw new StoreError("STORE_ROOT_INVALID", "store root inside an app bundle", { root })
  return norm
}

/**
 * A store-relative path (POSIX, no `..`, no leading `/`, no backslash, no NUL), resolved under root.
 * `prefixes` limits the first segment (e.g. ["docs/", "tmp/preview/"]). Symlinked parents that leave
 * the root are refused.
 */
export function resolveStoreRel(root: string, rel: unknown, prefixes: readonly string[]): string {
  if (typeof rel !== "string" || rel.length === 0 || rel.length > 1024) throw new StoreError("PATH_OUTSIDE_ROOT", "relative path missing or too long")
  if (rel.includes("\u0000") || rel.includes("\\") || rel.startsWith("/")) throw new StoreError("PATH_OUTSIDE_ROOT", "relative path not allowed", { rel })
  const norm = posix.normalize(rel)
  if (norm !== rel || norm.split("/").some((seg) => seg === ".." || seg === "." || seg === "")) {
    throw new StoreError("PATH_OUTSIDE_ROOT", "relative path not normalised", { rel })
  }
  if (!prefixes.some((p) => norm.startsWith(p))) throw new StoreError("PATH_OUTSIDE_ROOT", "relative path outside allowed folders", { rel, prefixes })
  const abs = join(root, norm)
  // Walk up to the nearest existing parent and check its real path stays inside the root.
  let probe = dirname(abs)
  while (!existsSync(probe) && probe.length > root.length) probe = dirname(probe)
  const realRoot = realpathSync(root)
  const realProbe = realpathSync(probe)
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + sep)) {
    throw new StoreError("PATH_OUTSIDE_ROOT", "path escapes the store root through a link", { rel })
  }
  return abs
}

/** True when `p` (absolute) is the root or inside it. */
export function isInside(root: string, p: string): boolean {
  const a = resolve(root)
  const b = resolve(p)
  return b === a || b.startsWith(a + sep)
}
