// Where the bundled DATUM skill and its Python runtime are, and whether this process may use them. Same rule as
// library-root.ts: the only source is what Electron gives the app's own utility process, and a failed check means no
// DATUM, never another copy.
//
// Packaged app: <Resources>/datum-house-style and <Resources>/datum-runtime.
// Unpackaged Electron (a developer's `electron-vite dev`, recognised by <Resources> having no app.asar): the repo copy
// <desktop>/datum/datum-house-style and the staged runtime <desktop>/.datum-runtime-stage, where <desktop> is taken from
// the sidecar's own entry script <desktop>/out/main/<name>.js. Neither the working directory nor the environment can
// name a root.
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const SKILL_FOLDER = "datum-house-style"
const RUNTIME_FOLDER = "datum-runtime"
const DEV_SKILL_PARENT = "datum"
const DEV_RUNTIME_FOLDER = ".datum-runtime-stage"
const PACKAGED_MARKER = "app.asar"
const SKILL_FILE = "SKILL.md"
const MANIFEST = "runtime-manifest.json"
const PYTHON = path.join("bin", "datum-python")
// Windows ships a batch launcher instead (spec 114 section 5.2, register R6.3); NTFS has no exec bit, so a regular
// non-symlink file is enough there.
const PYTHON_WIN32 = path.join("bin", "datum-python.cmd")
// <desktop>/out/main/<entry>.js; the entry file name is whatever the bundler emitted.
const DEV_ENTRY = /[\\/]out[\\/]main[\\/][^\\/]+\.js$/

// Taken once, before any plugin runs (see library-root.ts for why the process type has to agree).
const loaded = {
  type: Reflect.get(process, "type"),
  resourcesPath: Reflect.get(process, "resourcesPath"),
  entry: process.argv[1],
}

export type FailureCode = "missing" | "symlink" | "manifest" | "python"

export type Status =
  | { kind: "available"; skillRoot: string; python: string }
  | { kind: "no-app" }
  | { kind: "failed"; code: FailureCode }

export interface Disk {
  lstat(file: string): { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; mode: number }
  realpath(file: string): string
  readFile(file: string): Buffer
}

const realDisk: Disk = {
  lstat: (file) => fs.lstatSync(file),
  realpath: (file) => fs.realpathSync.native(file),
  readFile: (file) => fs.readFileSync(file),
}

class Failure extends Error {
  constructor(readonly code: FailureCode) {
    super(code)
  }
}

function exists(disk: Disk, file: string) {
  try {
    disk.lstat(file)
    return true
  } catch {
    return false
  }
}

/** A real directory named `name` directly under `base`, reached without any symlink on the last step. */
function folder(disk: Disk, base: string, name: string) {
  const entry = disk.lstat(path.join(base, name))
  if (entry.isSymbolicLink()) throw new Failure("symlink")
  if (!entry.isDirectory()) throw new Failure("missing")
  const root = disk.realpath(path.join(base, name))
  if (root !== path.join(disk.realpath(base), name)) throw new Failure("symlink")
  return root
}

function regularFile(disk: Disk, file: string, code: FailureCode) {
  const entry = disk.lstat(file)
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Failure(code)
  return entry
}

type Layout = { skillBase: string; runtimeBase: string; runtimeName: string }

function layout(resourcesPath: string, entry: unknown, disk: Disk): Layout {
  // A packaged app, or any Resources that carries the skill, is judged on its own copy only.
  if (exists(disk, path.join(resourcesPath, PACKAGED_MARKER)) || exists(disk, path.join(resourcesPath, SKILL_FOLDER)))
    return { skillBase: resourcesPath, runtimeBase: resourcesPath, runtimeName: RUNTIME_FOLDER }
  if (typeof entry !== "string" || !path.isAbsolute(entry) || !DEV_ENTRY.test(entry)) throw new Failure("missing")
  const desktop = path.dirname(path.dirname(path.dirname(entry)))
  return { skillBase: path.join(desktop, DEV_SKILL_PARENT), runtimeBase: desktop, runtimeName: DEV_RUNTIME_FOLDER }
}

function skillSha(disk: Disk, manifest: string) {
  try {
    const sha = JSON.parse(disk.readFile(manifest).toString("utf8"))?.skillSha
    return typeof sha === "string" ? sha.toLowerCase() : undefined
  } catch {
    return undefined
  }
}

function inspect(resourcesPath: string, entry: unknown, disk: Disk, win32: boolean): Status {
  const where = layout(resourcesPath, entry, disk)
  const skillRoot = folder(disk, where.skillBase, SKILL_FOLDER)
  const runtimeRoot = folder(disk, where.runtimeBase, where.runtimeName)
  const skillFile = path.join(skillRoot, SKILL_FILE)
  regularFile(disk, skillFile, "missing")
  const digest = crypto.createHash("sha256").update(disk.readFile(skillFile)).digest("hex")
  if (skillSha(disk, path.join(runtimeRoot, MANIFEST)) !== digest) throw new Failure("manifest")
  if (win32) {
    const python = path.join(runtimeRoot, PYTHON_WIN32)
    regularFile(disk, python, "python")
    return { kind: "available", skillRoot, python }
  }
  const python = path.join(runtimeRoot, PYTHON)
  if ((regularFile(disk, python, "python").mode & 0o111) === 0) throw new Failure("python")
  return { kind: "available", skillRoot, python }
}

/** Decides from its arguments alone. Outside the app's utility process it does not touch the disk at all. */
export function resolve(input: {
  type: unknown
  resourcesPath: unknown
  entry?: unknown
  disk?: Disk
  platform?: NodeJS.Platform
}): Status {
  if (input.type !== "utility" || typeof input.resourcesPath !== "string") return { kind: "no-app" }
  // A relative value would be measured from the working directory, which must never name a root.
  if (!path.isAbsolute(input.resourcesPath)) return { kind: "failed", code: "missing" }
  const win32 = (input.platform ?? process.platform) === "win32"
  try {
    return inspect(input.resourcesPath, input.entry, input.disk ?? realDisk, win32)
  } catch (error) {
    return { kind: "failed", code: error instanceof Failure ? error.code : "missing" }
  }
}

let memo: Status | undefined

/** This process's answer, checked once. */
export function current(): Status {
  return (memo ??= resolve(loaded))
}

export * as DatumRoot from "./datum-root"
