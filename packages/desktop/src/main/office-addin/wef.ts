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

import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { OFFICE_MANIFEST_FILE } from "@swarm/office-addin/constants"

// C31: the filename is defined once in office-addin/src/constants.ts; this name stays for existing callers.
export const WEF_MANIFEST_FILE = OFFICE_MANIFEST_FILE

export type WefFs = {
  mkdir: (dir: string) => Promise<unknown>
  readFile: (file: string) => Promise<Uint8Array>
  writeFile: (file: string, data: Uint8Array) => Promise<void>
  unlink: (file: string) => Promise<void>
  rmdir: (dir: string) => Promise<void>
  rm: (target: string) => Promise<void>
  readdir: (dir: string) => Promise<string[]>
  exists: (target: string) => Promise<boolean>
}

export const nodeWefFs: WefFs = {
  mkdir: (dir) => mkdir(dir),
  readFile: (file) => readFile(file),
  writeFile: (file, data) => writeFile(file, data),
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
}

export type WefFailure = { path: string; code: string; message: string }

export type WefResult = {
  ok: boolean
  // Roots (install/uninstall) or entries (cache clear) that completed.
  done: string[]
  // Paths that answered EPERM/EACCES: the Finder-guided fallback targets.
  refused: string[]
  // Any other failure (including HASH_MISMATCH); the root was rolled back.
  failed: WefFailure[]
  // Rollback steps that could not be undone; empty in every expected case.
  rollbackErrors: WefFailure[]
}

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

function result(done: string[], refused: string[], failed: WefFailure[], rollbackErrors: WefFailure[]): WefResult {
  return { ok: refused.length === 0 && failed.length === 0, done, refused, failed, rollbackErrors }
}

async function readIfPresent(fs: WefFs, file: string) {
  return fs.readFile(file).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return undefined
    throw error
  })
}

// Missing ancestors of `dir`, deepest first, so rollback can rmdir them in order.
async function missingDirs(fs: WefFs, dir: string) {
  const missing: string[] = []
  const walk = async (current: string): Promise<void> => {
    if (await fs.exists(current)) return
    missing.push(current)
    const parent = dirname(current)
    if (parent === current) return
    return walk(parent)
  }
  await walk(dir)
  return missing
}

type RootState = { created: string[]; target: string; previous: Uint8Array | undefined; wrote: boolean }

async function rollbackRoot(fs: WefFs, state: RootState, errors: WefFailure[]) {
  const undo = async (target: string, step: () => Promise<void>) =>
    step().catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return
      errors.push({ path: target, code: errorCode(error) || "ROLLBACK_FAILED", message: message(error) })
    })
  if (state.wrote && state.previous) {
    const previous = state.previous
    // Restore only when the file actually changed: a refused write left it untouched.
    await undo(state.target, async () => {
      const current = await readIfPresent(fs, state.target)
      if (current && sha256(current) === sha256(previous)) return
      await fs.writeFile(state.target, previous)
    })
  }
  if (state.wrote && !state.previous) await undo(state.target, () => fs.unlink(state.target))
  for (const dir of state.created) await undo(dir, () => fs.rmdir(dir))
}

async function installRoot(fs: WefFs, root: string, source: Uint8Array, hash: string, errors: WefFailure[]) {
  const state: RootState = { created: [], target: join(root, WEF_MANIFEST_FILE), previous: undefined, wrote: false }
  try {
    state.created = await missingDirs(fs, root)
    state.previous = state.created.length === 0 ? await readIfPresent(fs, state.target) : undefined
    for (const dir of [...state.created].reverse()) await fs.mkdir(dir)
    state.wrote = true
    await fs.writeFile(state.target, source)
    const written = await fs.readFile(state.target)
    if (sha256(written) !== hash) {
      await rollbackRoot(fs, state, errors)
      return { kind: "failed" as const, failure: { path: root, code: "HASH_MISMATCH", message: `SHA-256 of ${state.target} differs from the source` } }
    }
    return { kind: "done" as const }
  } catch (error) {
    // A mkdir that failed did not create its directory, but the ones before it did;
    // rmdir on a directory that never existed is ENOENT and is ignored by rollback.
    await rollbackRoot(fs, state, errors)
    if (isRefusal(error)) return { kind: "refused" as const }
    return { kind: "failed" as const, failure: { path: root, code: errorCode(error) || "ERROR", message: message(error) } }
  }
}

// Install: for each wef root create it if missing, write the manifest, re-read and compare
// SHA-256 with `manifestPath`. EPERM/EACCES roots are rolled back and returned in `refused`.
export async function installManifest(input: { manifestPath: string; roots: string[]; fs?: WefFs }): Promise<WefResult> {
  const fs = input.fs ?? nodeWefFs
  const source = await fs.readFile(input.manifestPath)
  const hash = sha256(source)
  const done: string[] = []
  const refused: string[] = []
  const failed: WefFailure[] = []
  const rollbackErrors: WefFailure[] = []
  for (const root of input.roots) {
    const outcome = await installRoot(fs, root, source, hash, rollbackErrors)
    if (outcome.kind === "done") done.push(root)
    if (outcome.kind === "refused") refused.push(root)
    if (outcome.kind === "failed") failed.push(outcome.failure)
  }
  return result(done, refused, failed, rollbackErrors)
}

// Uninstall: delete only `swarm-office-addin.xml` in each root. A missing file or root is not
// an error. unlink is atomic, so a refusing root keeps its file intact (nothing partial to undo);
// roots that did delete are not restored, because the Finder fallback targets only `refused`.
export async function uninstallManifest(input: { roots: string[]; fs?: WefFs }): Promise<WefResult> {
  const fs = input.fs ?? nodeWefFs
  const done: string[] = []
  const refused: string[] = []
  const failed: WefFailure[] = []
  for (const root of input.roots) {
    const target = join(root, WEF_MANIFEST_FILE)
    const outcome = await fs.unlink(target).then(
      () => "done" as const,
      (error: unknown) => {
        const code = errorCode(error)
        if (code === "ENOENT" || code === "ENOTDIR") return "done" as const
        if (isRefusal(error)) return "refused" as const
        failed.push({ path: root, code: code || "ERROR", message: message(error) })
        return "failed" as const
      },
    )
    if (outcome === "done") done.push(root)
    if (outcome === "refused") refused.push(root)
  }
  return result(done, refused, failed, [])
}

// Cache clear: delete the contents of `root` (the OsfWebHost/Data folder), never `root` itself
// and nothing outside it. Confirmation is the caller's job. A missing root is not an error.
export async function clearCache(input: { root: string; fs?: WefFs }): Promise<WefResult> {
  const fs = input.fs ?? nodeWefFs
  const done: string[] = []
  const refused: string[] = []
  const failed: WefFailure[] = []
  const entries = await fs.readdir(input.root).catch((error: unknown) => {
    const code = errorCode(error)
    if (code === "ENOENT") return []
    if (isRefusal(error)) {
      refused.push(input.root)
      return []
    }
    failed.push({ path: input.root, code: code || "ERROR", message: message(error) })
    return []
  })
  for (const name of entries) {
    const target = join(input.root, name)
    // Guard against a name that would escape the root (readdir never returns one, an injected fs might).
    if (dirname(resolve(target)) !== resolve(input.root)) {
      failed.push({ path: target, code: "OUTSIDE_ROOT", message: `${name} is not a direct child of ${input.root}` })
      continue
    }
    const outcome = await fs.rm(target).then(
      () => "done" as const,
      (error: unknown) => {
        if (isRefusal(error)) return "refused" as const
        failed.push({ path: target, code: errorCode(error) || "ERROR", message: message(error) })
        return "failed" as const
      },
    )
    if (outcome === "done") done.push(target)
    if (outcome === "refused") refused.push(target)
  }
  return result(done, refused, failed, [])
}

// C26(a): at launch, when the add-in is enabled, re-sync if the installed manifest is missing or
// differs from the bundled one. An unreadable installed copy (EPERM/EACCES) returns false: the
// launch path must not trigger a Finder-guided flow it cannot verify; Enable remains the way to repair.
export async function needsResync(bundledManifestBytes: Uint8Array, installedPath: string, fs: WefFs = nodeWefFs) {
  const installed = await readIfPresent(fs, installedPath).catch((error: unknown) => {
    if (isRefusal(error)) return null
    throw error
  })
  if (installed === null) return false
  if (installed === undefined) return true
  return sha256(installed) !== sha256(bundledManifestBytes)
}
