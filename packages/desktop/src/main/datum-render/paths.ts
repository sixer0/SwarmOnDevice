// DATUM render bridge: path allow-list (row 24).
//
// Runtime spec §3.2: src and dst must be absolute and the bridge has no more file reach than the
// sidecar that asks. On top of that this module refuses relative or non-normalised paths, NUL,
// symlinked outputs, outputs into credential/config folders, and keeps a renderer URL gate
// (data:, about:blank and an exact set of allowed file paths; no network scheme ever).

import { lstatSync, realpathSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, isAbsolute, join, normalize, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { BridgeError, MAX_INPUT_BYTES } from "./protocol"

export type PathPolicy = {
  /** Real paths under which inputs and outputs may live. */
  roots: string[]
  /** Real paths under which nothing is read or written, even inside a root. */
  deny: string[]
  maxInputBytes: number
  /**
   * Row 151c (C161 I1): narrow exceptions to `deny`, built by the host from its own store root (never from a
   * request). A path inside a deny folder is allowed only when one grant of the right mode matches it exactly.
   */
  grants?: PathGrant[]
}

/**
 * One exception to the deny list. `root` is the folder (resolved to its real path at every check, so a store that
 * is created after the bridge starts still matches); the path must lie strictly inside it, end with `ext`
 * (lower case compare) and, when `depth` is set, sit exactly `depth` path segments below `root`.
 */
export type PathGrant = { root: string; mode: "read" | "write"; ext: string; depth?: number }

/**
 * Row 151c (C161 I1): the Studio store lives under `~/.local/share/swarm/datum-studio` (layout.ts studioStoreRoot),
 * which HOME_DENY protects. Output verification needs exactly two things there:
 *   read  `<store>/docs/**.html`            the stored HTML render the pagePng op images;
 *   write `<store>/verify/<outputId>/<f>.png` the page images (verify-outputs.ts dstDir), one folder level only.
 * Everything else in the store (the sqlite file, assets, tmp, logs, templates) and in the rest of the protected
 * folder stays refused.
 */
export function studioStoreGrants(storeRoot: string): PathGrant[] {
  return [
    { root: join(storeRoot, "docs"), mode: "read", ext: ".html" },
    { root: join(storeRoot, "verify"), mode: "write", ext: ".png", depth: 2 },
  ]
}

const HOME_DENY = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".swarm",
  ".swarm-patch-key",
  ".opencode",
  ".claude",
  ".config/swarm",
  ".local/share/swarm",
  ".local/bin",
  ".colima",
  "Library/Keychains",
  "Library/Application Support/Swarm",
]

function real(p: string) {
  try {
    return realpathSync(p)
  } catch {
    return normalize(p)
  }
}

export function defaultPolicy(home = homedir(), extraDeny: string[] = [], grants: PathGrant[] = []): PathPolicy {
  const roots = [home, tmpdir(), "/private/tmp", "/tmp", "/Volumes"].map(real)
  const deny = [...HOME_DENY.map((d) => join(home, d)), "/Applications", ...extraDeny].map(real)
  return { roots: [...new Set(roots)], deny: [...new Set(deny)], maxInputBytes: MAX_INPUT_BYTES, grants: grants.map((g) => ({ ...g })) }
}

export function isInside(child: string, parent: string) {
  if (child === parent) return true
  const p = parent.endsWith(sep) ? parent : parent + sep
  return child.startsWith(p)
}

function refuse(message: string): never {
  throw new BridgeError("PATH_REFUSED", message)
}

function checkShape(p: string, label: string) {
  if (typeof p !== "string" || p.length === 0 || p.length > 4096) refuse(`${label} must be a path of 1..4096 chars`)
  if (p.includes("\0")) refuse(`${label} contains NUL`)
  if (!isAbsolute(p)) refuse(`${label} must be an absolute path`)
  if (normalize(p) !== p || p.split(sep).includes("..")) refuse(`${label} must be a normalised path`)
}

/** Row 151c: true when a grant of `mode` covers `realPath` (strictly inside the grant's real root, ext, depth). */
export function granted(realPath: string, policy: PathPolicy, mode: PathGrant["mode"]): boolean {
  for (const g of policy.grants ?? []) {
    if (g.mode !== mode) continue
    const root = real(g.root)
    if (realPath === root || !isInside(realPath, root)) continue
    if (!realPath.toLowerCase().endsWith(g.ext.toLowerCase())) continue
    const rel = realPath.slice(root.length + (root.endsWith(sep) ? 0 : 1)).split(sep)
    if (rel.some((s) => s === "" || s === "." || s === "..")) continue
    if (g.depth !== undefined && rel.length !== g.depth) continue
    return true
  }
  return false
}

function checkReach(realPath: string, policy: PathPolicy, label: string) {
  if (!policy.roots.some((r) => isInside(realPath, r))) refuse(`${label} is outside the allowed roots`)
  if (policy.deny.some((d) => isInside(realPath, d)) && !granted(realPath, policy, label === "src" ? "read" : "write")) {
    refuse(`${label} is inside a protected folder`)
  }
}

/** Returns the real path of a readable regular input file within reach. */
export function checkInputPath(p: string, policy: PathPolicy): string {
  checkShape(p, "src")
  let r: string
  try {
    r = realpathSync(p)
  } catch {
    refuse("src does not exist")
  }
  checkReach(r, policy, "src")
  const st = statSync(r)
  if (!st.isFile()) refuse("src is not a regular file")
  if (st.size > policy.maxInputBytes) throw new BridgeError("INPUT_TOO_LARGE", "src is larger than the input cap")
  return r
}

/** Returns the output path to write (real parent + base name). The file itself may not exist yet. */
export function checkOutputPath(p: string, policy: PathPolicy): string {
  checkShape(p, "dst")
  const parent = dirname(p)
  let realParent: string
  try {
    realParent = realpathSync(parent)
  } catch {
    refuse("dst folder does not exist")
  }
  if (!statSync(realParent).isDirectory()) refuse("dst folder is not a folder")
  const target = join(realParent, p.slice(parent.length + 1))
  checkReach(target, policy, "dst")
  let st
  try {
    st = lstatSync(target)
  } catch {
    return target
  }
  if (st.isSymbolicLink()) refuse("dst is a symbolic link")
  if (!st.isFile()) refuse("dst exists and is not a regular file")
  return target
}

/**
 * Gate for every request the render window makes (session.webRequest.onBeforeRequest).
 * Allowed: data:, about:blank, and file: URLs whose path is exactly in `allowedFiles`.
 * Everything else (http, https, ws, ftp, blob from elsewhere, other file paths) is cancelled.
 */
export function isAllowedRendererUrl(url: string, allowedFiles: ReadonlySet<string>): boolean {
  if (url.startsWith("data:")) return true
  if (url === "about:blank") return true
  if (url.startsWith("devtools:")) return false
  if (!url.startsWith("file:")) return false
  let path: string
  try {
    const u = new URL(url)
    if (u.host !== "" || u.search !== "" ) return false
    path = fileURLToPath(u)
  } catch {
    return false
  }
  return allowedFiles.has(path)
}
