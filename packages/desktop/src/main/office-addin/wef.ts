// Office add-in sideload folders ("wef") for Word and Excel on macOS (REG rev 5 §6.3, U11, C26a).
//
// Every operation takes its roots as arguments (TR-6) so tests run entirely under $TMPDIR.
// No Electron imports: the Finder-guided fallback lives in the controller (M7-03), which
// receives the refusing paths from these functions.
//
// Install contract, per wef root: the root either ends with a verified copy of the manifest
// (SHA-256 re-read equals the source) or is left exactly as it was before the call: folders
// this call created are removed and a manifest that was already there is restored byte for
// byte. A verified root is never undone because another root refused, since the Finder
// fallback only guides the user into the roots that refused.

import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { OFFICE_MANIFEST_FILE } from "@swarm/office-addin/constants"

// C31: the filename is defined once in office-addin/src/constants.ts; this name stays for existing callers.
export const WEF_MANIFEST_FILE = OFFICE_MANIFEST_FILE

/** What `lstat` saw, without following a symlink (M7-02a, F-M7-3). */
export type WefKind = "file" | "dir" | "symlink" | "other" | "missing"

export type WefFs = {
  mkdir: (dir: string) => Promise<unknown>
  readFile: (file: string) => Promise<Uint8Array>
  /** Never writes through a symlink in the last component (O_NOFOLLOW). */
  writeFile: (file: string, data: Uint8Array) => Promise<void>
  unlink: (file: string) => Promise<void>
  rmdir: (dir: string) => Promise<void>
  rm: (target: string) => Promise<void>
  readdir: (dir: string) => Promise<string[]>
  exists: (target: string) => Promise<boolean>
  lstat: (target: string) => Promise<WefKind>
  rename: (from: string, to: string) => Promise<void>
}

const NO_FOLLOW_WRITE = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW

export const nodeWefFs: WefFs = {
  mkdir: (dir) => mkdir(dir),
  readFile: (file) => readFile(file),
  writeFile: (file, data) => writeFile(file, data, { flag: NO_FOLLOW_WRITE }),
  unlink: (file) => unlink(file),
  rmdir: (dir) => rmdir(dir),
  rm: (target) => rm(target, { recursive: true, force: true }),
  readdir: (dir) => readdir(dir),
  exists: (target) =>
    stat(target).then(
      () => true,
      (error: unknown) => {
        if (errorCode(error) === "ENOENT") return false
        throw error
      },
    ),
  lstat: (target) =>
    lstat(target).then(
      (info): WefKind => {
        if (info.isSymbolicLink()) return "symlink"
        if (info.isDirectory()) return "dir"
        if (info.isFile()) return "file"
        return "other"
      },
      (error: unknown): WefKind => {
        const code = errorCode(error)
        if (code === "ENOENT" || code === "ENOTDIR") return "missing"
        throw error
      },
    ),
  rename: (from, to) => rename(from, to),
}

export type WefFailure = { path: string; code: string; message: string }

export type WefResult = {
  ok: boolean
  // Roots (install/uninstall) or entries (cache clear) that completed.
  done: string[]
  // Paths that answered EPERM/EACCES. Kept as the root (or entry) for the message text.
  refused: string[]
  // Any other failure (HASH_MISMATCH, UNSAFE_PATH, I/O); the root was rolled back.
  failed: WefFailure[]
  // Rollback steps that could not be undone; empty in every expected case.
  rollbackErrors: WefFailure[]
  // M7-02a (F-M7-6): hosts whose container `Data/Documents` folder does not exist (app never
  // installed or run). Skipped, nothing written; not a refusal and not a failure.
  notInstalled: string[]
  // M7-02a (F-M7-2): for each `refused[i]`, the nearest path at or above it that lstat reports as a
  // real directory (never a symlink, file or app bundle followed through a link). Finder targets.
  reveal: string[]
}

/** UNSAFE_PATH: a wef folder, its Documents parent or the manifest is a symlink or the wrong type. */
export const UNSAFE_PATH = "UNSAFE_PATH"

export function errorCode(error: unknown) {
  if (typeof error !== "object" || error === null) return ""
  if (!("code" in error)) return ""
  if (typeof error.code !== "string") return ""
  return error.code
}

export function isRefusal(error: unknown) {
  const code = errorCode(error)
  return code === "EPERM" || code === "EACCES"
}

function message(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

export function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}

// F-M7-2: the nearest real directory (lstat, not a symlink) at or above `target`.
export async function nearestRealDirectory(target: string, fs: WefFs = nodeWefFs): Promise<string> {
  const kind = await fs.lstat(target).catch((): WefKind => "missing")
  if (kind === "dir") return target
  const parent = dirname(target)
  if (parent === target) return target
  return nearestRealDirectory(parent, fs)
}

type Parts = Omit<WefResult, "ok" | "reveal">

function emptyParts(): Parts {
  return { done: [], refused: [], failed: [], rollbackErrors: [], notInstalled: [] }
}

async function finish(fs: WefFs, parts: Parts): Promise<WefResult> {
  const reveal = await Promise.all(parts.refused.map((target) => nearestRealDirectory(target, fs)))
  return { ok: parts.refused.length === 0 && parts.failed.length === 0, ...parts, reveal }
}

function unsafe(target: string, kind: WefKind, expected: string): WefFailure {
  return { path: target, code: UNSAFE_PATH, message: `${target} is ${kind}, expected ${expected}` }
}

type RootState = {
  created: string | undefined
  temp: string | undefined
  target: string
  previous: Uint8Array | undefined
  renamed: boolean
}

async function rollbackRoot(fs: WefFs, state: RootState, errors: WefFailure[]) {
  const undo = async (target: string, step: () => Promise<void>) =>
    step().catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return
      errors.push({ path: target, code: errorCode(error) || "ROLLBACK_FAILED", message: message(error) })
    })
  const temp = state.temp
  if (temp) await undo(temp, () => fs.unlink(temp))
  const previous = state.previous
  if (state.renamed && previous) {
    // Restore only when the file actually changed, and only into a regular file (never through a link).
    await undo(state.target, async () => {
      if ((await fs.lstat(state.target)) !== "file") return fs.writeFile(state.target, previous)
      if (sha256(await fs.readFile(state.target)) === sha256(previous)) return
      await fs.writeFile(state.target, previous)
    })
  }
  if (state.renamed && !previous) await undo(state.target, () => fs.unlink(state.target))
  const created = state.created
  if (created) await undo(created, () => fs.rmdir(created))
}

type RootOutcome = { kind: "done" } | { kind: "refused" } | { kind: "notInstalled" } | { kind: "failed"; failure: WefFailure }

// One wef root: `<container>/Data/Documents/wef`. Only `wef/` itself may be created (F-M7-6), and
// nothing is read or written through a symlink (F-M7-3): the folder, its Documents parent, the old
// manifest and the temp file are all lstat-checked, and the manifest lands by rename of a temp file
// written with O_NOFOLLOW in the same folder.
async function installRoot(fs: WefFs, root: string, source: Uint8Array, hash: string, errors: WefFailure[]): Promise<RootOutcome> {
  const state: RootState = { created: undefined, temp: undefined, target: join(root, WEF_MANIFEST_FILE), previous: undefined, renamed: false }
  const fail = async (failure: WefFailure): Promise<RootOutcome> => {
    await rollbackRoot(fs, state, errors)
    return { kind: "failed", failure }
  }
  try {
    const documents = dirname(root)
    const documentsKind = await fs.lstat(documents)
    if (documentsKind === "missing") return { kind: "notInstalled" }
    if (documentsKind !== "dir") return { kind: "failed", failure: unsafe(documents, documentsKind, "a directory") }
    const rootKind = await fs.lstat(root)
    if (rootKind !== "dir" && rootKind !== "missing") return { kind: "failed", failure: unsafe(root, rootKind, "a directory") }
    const targetKind = rootKind === "dir" ? await fs.lstat(state.target) : "missing"
    if (targetKind !== "file" && targetKind !== "missing") return { kind: "failed", failure: unsafe(state.target, targetKind, "a file") }
    state.previous = targetKind === "file" ? await fs.readFile(state.target) : undefined
    if (rootKind === "missing") {
      state.created = root
      await fs.mkdir(root)
    }
    state.temp = join(root, `.${WEF_MANIFEST_FILE}.${randomUUID()}.tmp`)
    await fs.writeFile(state.temp, source)
    const tempKind = await fs.lstat(state.temp)
    if (tempKind !== "file") return fail(unsafe(state.temp, tempKind, "a file"))
    await fs.rename(state.temp, state.target)
    state.temp = undefined
    state.renamed = true
    const writtenKind = await fs.lstat(state.target)
    if (writtenKind !== "file") return fail(unsafe(state.target, writtenKind, "a file"))
    if (sha256(await fs.readFile(state.target)) !== hash) {
      return fail({ path: root, code: "HASH_MISMATCH", message: `SHA-256 of ${state.target} differs from the source` })
    }
    return { kind: "done" }
  } catch (error) {
    // A refused mkdir created nothing: rmdir answers ENOENT, which rollback ignores.
    await rollbackRoot(fs, state, errors)
    if (isRefusal(error)) return { kind: "refused" }
    return { kind: "failed", failure: { path: root, code: errorCode(error) || "ERROR", message: message(error) } }
  }
}

// Install: per wef root (see installRoot), write the manifest and compare SHA-256 with `manifestPath`.
// EPERM/EACCES roots are rolled back and returned in `refused` (with `reveal`); hosts without a container
// go to `notInstalled`.
export async function installManifest(input: { manifestPath: string; roots: string[]; fs?: WefFs }): Promise<WefResult> {
  const fs = input.fs ?? nodeWefFs
  const source = await fs.readFile(input.manifestPath)
  const hash = sha256(source)
  const parts = emptyParts()
  for (const root of input.roots) {
    const outcome = await installRoot(fs, root, source, hash, parts.rollbackErrors)
    if (outcome.kind === "done") parts.done.push(root)
    if (outcome.kind === "refused") parts.refused.push(root)
    if (outcome.kind === "notInstalled") parts.notInstalled.push(root)
    if (outcome.kind === "failed") parts.failed.push(outcome.failure)
  }
  return finish(fs, parts)
}

// Uninstall: delete only `swarm-office-addin.xml` in each root. A missing file or root is not
// an error. unlink is atomic, so a refusing root keeps its file intact (nothing partial to undo);
// roots that did delete are not restored, because the Finder fallback targets only `refused`.
// A symlinked wef folder is UNSAFE_PATH: the delete would land in the link target.
export async function uninstallManifest(input: { roots: string[]; fs?: WefFs }): Promise<WefResult> {
  const fs = input.fs ?? nodeWefFs
  const parts = emptyParts()
  for (const root of input.roots) {
    const outcome = await (async () => {
      const rootKind = await fs.lstat(root)
      if (rootKind === "missing") return "done" as const
      if (rootKind !== "dir") {
        parts.failed.push(unsafe(root, rootKind, "a directory"))
        return "failed" as const
      }
      await fs.unlink(join(root, WEF_MANIFEST_FILE))
      return "done" as const
    })().catch((error: unknown) => {
      const code = errorCode(error)
      if (code === "ENOENT" || code === "ENOTDIR") return "done" as const
      if (isRefusal(error)) return "refused" as const
      parts.failed.push({ path: root, code: code || "ERROR", message: message(error) })
      return "failed" as const
    })
    if (outcome === "done") parts.done.push(root)
    if (outcome === "refused") parts.refused.push(root)
  }
  return finish(fs, parts)
}

// Cache clear: delete the contents of `root` (the OsfWebHost/Data folder), never `root` itself
// and nothing outside it. Confirmation is the caller's job. A missing root is not an error.
// A symlinked root is UNSAFE_PATH: its children would be the link target's.
export async function clearCache(input: { root: string; fs?: WefFs }): Promise<WefResult> {
  const fs = input.fs ?? nodeWefFs
  const parts = emptyParts()
  const rootKind = await fs.lstat(input.root).catch((error: unknown): WefKind | "refused" => {
    if (isRefusal(error)) return "refused"
    throw error
  })
  if (rootKind === "refused") {
    parts.refused.push(input.root)
    return finish(fs, parts)
  }
  if (rootKind === "missing") return finish(fs, parts)
  if (rootKind !== "dir") {
    parts.failed.push(unsafe(input.root, rootKind, "a directory"))
    return finish(fs, parts)
  }
  const entries = await fs.readdir(input.root).catch((error: unknown) => {
    const code = errorCode(error)
    if (code === "ENOENT") return []
    if (isRefusal(error)) {
      parts.refused.push(input.root)
      return []
    }
    parts.failed.push({ path: input.root, code: code || "ERROR", message: message(error) })
    return []
  })
  for (const name of entries) {
    const target = join(input.root, name)
    // Guard against a name that would escape the root (readdir never returns one, an injected fs might).
    if (dirname(resolve(target)) !== resolve(input.root)) {
      parts.failed.push({ path: target, code: "OUTSIDE_ROOT", message: `${name} is not a direct child of ${input.root}` })
      continue
    }
    // rm with recursive does not follow a symlinked child: it removes the link only.
    const outcome = await fs.rm(target).then(
      () => "done" as const,
      (error: unknown) => {
        if (isRefusal(error)) return "refused" as const
        parts.failed.push({ path: target, code: errorCode(error) || "ERROR", message: message(error) })
        return "failed" as const
      },
    )
    if (outcome === "done") parts.done.push(target)
    if (outcome === "refused") parts.refused.push(target)
  }
  return finish(fs, parts)
}

// C26(a): at launch, when the add-in is enabled, re-sync if the installed manifest is missing or
// differs from the bundled one. M7-02a:
// - no container `Data/Documents` (app not installed, F-M7-6) -> false: nothing to sync, nothing created;
// - a symlinked or wrong-type Documents, wef folder or manifest (F-M7-3) -> true, without reading through
//   the link, so the install that follows reports it as failed UNSAFE_PATH and writes nothing;
// - an unreadable installed copy (EPERM/EACCES) -> false: the launch path must not start a Finder-guided
//   flow it cannot verify; Enable remains the way to repair.
export async function needsResync(bundledManifestBytes: Uint8Array, installedPath: string, fs: WefFs = nodeWefFs) {
  const check = async () => {
    const root = dirname(installedPath)
    const documentsKind = await fs.lstat(dirname(root))
    if (documentsKind === "missing") return false
    if (documentsKind !== "dir") return true
    const rootKind = await fs.lstat(root)
    if (rootKind === "missing") return true
    if (rootKind !== "dir") return true
    const kind = await fs.lstat(installedPath)
    if (kind === "missing") return true
    if (kind !== "file") return true
    return sha256(await fs.readFile(installedPath)) !== sha256(bundledManifestBytes)
  }
  return check().catch((error: unknown) => {
    if (isRefusal(error)) return false
    if (errorCode(error) === "ENOENT") return true
    throw error
  })
}
