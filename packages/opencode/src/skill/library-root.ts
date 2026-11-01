// Where the bundled Knowledge Library is, and whether this process may use it. The only source is what Electron gives the
// app's own utility process. Nothing else can name a root, so nothing here may ever look anywhere else: a failed check
// means no library, never another copy.
import fs from "node:fs"
import path from "node:path"

const FOLDER = "knowledge-library"
const MANIFEST = "library.json"
const EDITION = "edisi-umum"

// Taken once, before any plugin runs. A plain Bun binary can be given a resourcesPath by a preload, so that alone is not
// the app; the process type has to agree.
const loaded = { type: Reflect.get(process, "type"), resourcesPath: Reflect.get(process, "resourcesPath") }

export type FailureCode = "missing" | "symlink" | "edition"

export type Status = { kind: "available"; root: string } | { kind: "no-app" } | { kind: "failed"; code: FailureCode }

export interface Disk {
  lstat(file: string): { isDirectory(): boolean; isSymbolicLink(): boolean }
  realpath(file: string): string
  readFile(file: string): string
}

const realDisk: Disk = {
  lstat: (file) => fs.lstatSync(file),
  realpath: (file) => fs.realpathSync.native(file),
  readFile: (file) => fs.readFileSync(file, "utf8"),
}

function failed(code: FailureCode): Status {
  return { kind: "failed", code }
}

function inspect(resourcesPath: string, disk: Disk): Status {
  const folder = path.join(resourcesPath, FOLDER)
  const entry = disk.lstat(folder)
  if (entry.isSymbolicLink()) return failed("symlink")
  if (!entry.isDirectory()) return failed("missing")
  const root = disk.realpath(folder)
  if (root !== path.join(disk.realpath(resourcesPath), FOLDER)) return failed("symlink")
  return isEdition(disk, path.join(root, MANIFEST)) ? { kind: "available", root } : failed("edition")
}

function isEdition(disk: Disk, manifest: string) {
  try {
    return JSON.parse(disk.readFile(manifest))?.edition?.id === EDITION
  } catch {
    return false
  }
}

/** Decides from its arguments alone. Outside the app's utility process it does not touch the disk at all. */
export function resolve(input: { type: unknown; resourcesPath: unknown; disk?: Disk }): Status {
  if (input.type !== "utility" || typeof input.resourcesPath !== "string") return { kind: "no-app" }
  // A relative value would be measured from the working directory, which must never name a root.
  if (!path.isAbsolute(input.resourcesPath)) return failed("missing")
  try {
    return inspect(input.resourcesPath, input.disk ?? realDisk)
  } catch {
    return failed("missing")
  }
}

let memo: Status | undefined

/** This process's answer, checked once. */
export function current(): Status {
  return (memo ??= resolve(loaded))
}

export * as LibraryRoot from "./library-root"
