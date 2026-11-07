/**
 * Per-session file root (studio spec §9.4, row 31). The root is the caller's directory sent by the bridge
 * (`X-Studio-Caller-Cwd`, percent-encoded UTF-8). It becomes the session's only `STUDIO_MCP_FILE_ROOTS`
 * entry, so the vendored guards (safety.ts `resolveAllowedPath`, lexical + realpath, write targets checked
 * again) keep every read by path and every download inside it.
 *
 * Refused: not absolute, NUL, UNC, missing or not a directory, `/`, `$HOME`, inside `Res/`
 * (`process.resourcesPath`) or inside the app bundle (env.ts `assertWorkspaceRootAllowed`, the same rule
 * as the store root), inside the store, and a root that CONTAINS the store (a download could otherwise be
 * written into the store folder; stricter than §9.4, recorded as a row 31 decision).
 */
import { realpathSync, statSync } from "node:fs"
import path from "node:path"
import { assertWorkspaceRootAllowed, isPathInside, type WorkspaceRootFacts } from "../../vendor/src/lib/studio/contract/env"

export class FileRootError extends Error {
  readonly code = "FILE_ROOT_FORBIDDEN"
}

export interface FileRootFacts extends WorkspaceRootFacts {
  /** The store root (= STUDIO_WORKSPACE_ROOT). */
  storeRoot: string
}

function real(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

const same = (a: string, b: string) => path.relative(a, b) === ""

/** Decode the bridge header and return the absolute, real session root; throws FileRootError. */
export function resolveSessionRoot(header: string | null | undefined, facts: FileRootFacts): string {
  if (typeof header !== "string" || header === "") throw new FileRootError("X-Studio-Caller-Cwd is required (the caller's directory, percent-encoded)")
  let raw: string
  try {
    raw = decodeURIComponent(header)
  } catch {
    throw new FileRootError("X-Studio-Caller-Cwd is not valid percent-encoding")
  }
  if (raw.includes("\u0000") || !path.isAbsolute(raw) || /^[\\/]{2}/.test(raw)) throw new FileRootError("the caller directory must be a local absolute path")
  const lexical = path.resolve(raw)
  let st
  try {
    st = statSync(lexical)
  } catch {
    throw new FileRootError("the caller directory does not exist")
  }
  if (!st.isDirectory()) throw new FileRootError("the caller directory is not a directory")
  try {
    assertWorkspaceRootAllowed(lexical, facts)
  } catch (e) {
    const why = e instanceof Error ? e.message.replace(/^STUDIO_WORKSPACE_ROOT /, "") : "is not allowed"
    throw new FileRootError(`the caller directory ${why}`)
  }
  const realRoot = real(lexical)
  const store = path.resolve(facts.storeRoot)
  for (const s of [store, real(store)]) {
    for (const c of [lexical, realRoot]) {
      if (same(c, s) || isPathInside(c, s)) throw new FileRootError("the caller directory must not be inside the DATUM Studio store")
      if (isPathInside(s, c)) throw new FileRootError("the caller directory must not contain the DATUM Studio store")
    }
  }
  return realRoot
}
