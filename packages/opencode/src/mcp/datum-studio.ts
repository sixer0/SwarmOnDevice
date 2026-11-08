// DATUM Studio as a built-in MCP server of the Swarm app (row 33, Studio spec §9.3 "Swarm's built-in entry").
//
// The entry is the same launcher Claude's wrapper runs:
//   mcp["datum-studio"] = { type: "local", command: ["<Res>/datum-studio/datum-studio-launcher"],
//                           environment: { STUDIO_AGENT_ID: "swarm" } }
// It holds no endpoint and no token. The launcher finds the host through `<state>/swarm/datum-studio.env` (it reads
// $XDG_STATE_HOME, which the sidecar already has), and the bridge reads the token from that 0600 file at each start.
//
// Where the launcher is follows the same rule as skill/datum-root.ts: the only source is what Electron gives the app's
// own utility process. The packaged app uses <Resources>/datum-studio; an unpackaged Electron (`electron-vite dev`,
// recognised by <Resources> having neither app.asar nor datum-studio) uses the row 36 stage
// <desktop>/.datum-studio-stage, with <desktop> taken from the sidecar's own entry script <desktop>/out/main/<name>.js.
// Neither the working directory nor the environment can name the launcher. Anywhere else (the terminal CLI, tests) there
// is no entry, and a launcher that fails the checks gives no entry either: never another copy.
//
// The entry is injected into the global layer (config.ts loadGlobal) below every config file, so it reaches every
// session without a file being written, the user's own `mcp["datum-studio"]` (for example `{ "enabled": false }`) wins,
// and the server is treated like the user's own config (mcp/index.ts sourceOf origin "global").
//
// Windows (row 174, L15, register R6.5, spec 114 §5.4): the launcher is `datum-studio-launcher.cmd`, which cmd.exe runs
// (the MCP stdio transport spawns through cross-spawn), so there is no exec bit to test; paths are judged with Windows
// separators. This file never splits PATH, so it has no PATH separator to change. Every other platform keeps the
// rules above.
import fs from "node:fs"
import path from "node:path"
import type { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"

/** Register §5: the one server id, key under `mcp`. Tools reach the model as `datum-studio_<tool>`. */
export const DATUM_STUDIO_MCP = "datum-studio"
/** Register §5 / spec §9.3: caller identity recorded on revisions made through Swarm. */
export const STUDIO_AGENT_ID = "swarm"

const RES_FOLDER = "datum-studio"
const DEV_STAGE_FOLDER = ".datum-studio-stage"
const LAUNCHER = "datum-studio-launcher"
const PACKAGED_MARKER = "app.asar"
// <desktop>/out/main/<entry>.js; the entry file name is whatever the bundler emitted.
const DEV_ENTRY = /[\\/]out[\\/]main[\\/][^\\/]+\.js$/

// Taken once, before anything else can change them (same reason as datum-root.ts).
const loaded = {
  type: Reflect.get(process, "type"),
  resourcesPath: Reflect.get(process, "resourcesPath"),
  entry: process.argv[1],
  platform: process.platform,
}

/** The per-platform rules. Anything but win32 gets exactly the macOS rules (the `path` module of this host). */
interface Host {
  path: typeof path
  launcher: string
  execBit: boolean
  /** Absolute on its own: on win32 a drive (`C:\`) or UNC root, never `\x` that takes the working directory's drive. */
  absolute(file: string): boolean
}

const WIN_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/

function host(platform: unknown): Host {
  if (platform === "win32")
    return {
      path: path.win32,
      launcher: `${LAUNCHER}.cmd`,
      execBit: false,
      absolute: (file) => WIN_ABSOLUTE.test(file),
    }
  return { path, launcher: LAUNCHER, execBit: true, absolute: (file) => path.isAbsolute(file) }
}

export type FailureCode = "missing" | "symlink" | "not_executable"

export type Status =
  | { kind: "available"; launcher: string }
  | { kind: "no-app" }
  | { kind: "failed"; code: FailureCode }

export interface Disk {
  lstat(file: string): { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; mode: number }
  realpath(file: string): string
}

const realDisk: Disk = {
  lstat: (file) => fs.lstatSync(file),
  realpath: (file) => fs.realpathSync.native(file),
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
function folder(disk: Disk, h: Host, base: string, name: string) {
  const entry = disk.lstat(h.path.join(base, name))
  if (entry.isSymbolicLink()) throw new Failure("symlink")
  if (!entry.isDirectory()) throw new Failure("missing")
  const root = disk.realpath(h.path.join(base, name))
  if (root !== h.path.join(disk.realpath(base), name)) throw new Failure("symlink")
  return root
}

function studioFolder(resourcesPath: string, entry: unknown, disk: Disk, h: Host) {
  // A packaged app, or any Resources that carries the Studio folder, is judged on its own copy only.
  if (exists(disk, h.path.join(resourcesPath, PACKAGED_MARKER)) || exists(disk, h.path.join(resourcesPath, RES_FOLDER)))
    return folder(disk, h, resourcesPath, RES_FOLDER)
  if (typeof entry !== "string" || !h.absolute(entry) || !DEV_ENTRY.test(entry)) throw new Failure("missing")
  const desktop = h.path.dirname(h.path.dirname(h.path.dirname(entry)))
  return folder(disk, h, desktop, DEV_STAGE_FOLDER)
}

function inspect(resourcesPath: string, entry: unknown, disk: Disk, h: Host): Status {
  const launcher = h.path.join(studioFolder(resourcesPath, entry, disk, h), h.launcher)
  const stat = disk.lstat(launcher)
  if (stat.isSymbolicLink()) throw new Failure("symlink")
  if (!stat.isFile()) throw new Failure("missing")
  // A `.cmd` has no exec bit: cmd.exe runs it by its extension.
  if (h.execBit && (stat.mode & 0o111) === 0) throw new Failure("not_executable")
  return { kind: "available", launcher }
}

/** Decides from its arguments alone. Outside the app's utility process it does not touch the disk at all. */
export function resolve(input: {
  type: unknown
  resourcesPath: unknown
  entry?: unknown
  disk?: Disk
  platform?: unknown
}): Status {
  if (input.type !== "utility" || typeof input.resourcesPath !== "string") return { kind: "no-app" }
  const h = host(input.platform ?? process.platform)
  // A relative value would be measured from the working directory, which must never name the launcher.
  if (!h.absolute(input.resourcesPath)) return { kind: "failed", code: "missing" }
  try {
    return inspect(input.resourcesPath, input.entry, input.disk ?? realDisk, h)
  } catch (error) {
    return { kind: "failed", code: error instanceof Failure ? error.code : "missing" }
  }
}

/** Spec §9.3 shape. No endpoint, port or token: the launcher reads them from the descriptor at each start. */
export function entry(launcher: string): ConfigMCPV1.Local {
  return { type: "local", command: [launcher], environment: { STUDIO_AGENT_ID } }
}

/** The built-in `mcp` block for a status: one entry when the launcher is available, none otherwise. */
export function builtin(status: Status): Record<string, ConfigMCPV1.Local> {
  return status.kind === "available" ? { [DATUM_STUDIO_MCP]: entry(status.launcher) } : {}
}

let memo: Status | undefined

/** This process's answer, checked once. */
export function current(): Status {
  return (memo ??= resolve(loaded))
}

export * as DatumStudioMcp from "./datum-studio"
