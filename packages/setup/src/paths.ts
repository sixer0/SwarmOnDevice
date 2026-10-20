// Path resolution for the setup-owned state root (register class 3, PC-PATH-*).
// All `~` is expanded from $HOME when set, else os.homedir(), so a test can point
// HOME at a throwaway directory and prove clean-state / kill-9 behaviour without
// touching the real user home. Nothing outside ~/.swarm is ever written here
// (P-16 whitelist); this module only knows about setup's own dirs.

import { existsSync, mkdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { PATHS, MODES, PROGRAM_NAME, LOCK_FILE_NAME } from "./constants.ts"

export function homeDir(): string {
  const h = process.env.HOME
  return h && h.length > 0 ? h : homedir()
}

export function expandTilde(p: string): string {
  if (p === "~") return homeDir()
  if (p.startsWith("~/")) return join(homeDir(), p.slice(2))
  return p
}

export const setupRoot = (): string => expandTilde(PATHS.SETUP_ROOT) // ~/.swarm/setup
export const stateFile = (): string => expandTilde(PATHS.STATE) // state.json
export const consentLog = (): string => expandTilde(PATHS.CONSENT_LOG) // consent.log
export const lockDir = (): string => expandTilde(PATHS.LOCK_DIR) // lock/
export const setupLog = (): string => expandTilde(PATHS.SETUP_LOG) // setup.log
export const tmpDir = (): string => expandTilde(PATHS.TMP) // ~/.swarm/tmp
export const toolsDir = (): string => expandTilde(PATHS.TOOLS) // ~/.swarm/tools

export function toolDir(componentId: string): string {
  return join(toolsDir(), componentId) // PC-PATH-08
}

export function secretsDir(componentId: string): string {
  return join(toolDir(componentId), "secrets") // PC-PATH-09
}

/** Create a directory with an explicit mode, idempotently. The mode is applied on
 *  creation; if it already exists we do not chmod it (P-4 forbids chmod outside
 *  ~/.swarm, and these are inside it, but re-chmod of an existing dir is not needed). */
export function ensureDir(absPath: string, mode: number): void {
  if (!existsSync(absPath)) {
    mkdirSync(absPath, { recursive: true, mode })
  }
}

/** Ensure the parent directory of a file path exists as a 0700 setup dir. */
export function ensureParent(absPath: string): void {
  ensureDir(dirname(absPath), MODES.DIR_0700)
}

export function isDirectory(absPath: string): boolean {
  try {
    return statSync(absPath).isDirectory()
  } catch {
    return false
  }
}

/**
 * Resolve the directory that holds the shipped tools.lock.json (PC-PATH-11: read
 * relative to the program's own directory).
 *
 * Two postures:
 *  - Compiled single Mach-O binary (row 106): the lock sits beside the executable,
 *    so use dirname(process.execPath).
 *  - Source run (`bun run src/index.ts`, used by this row's proofs): execPath is the
 *    bun interpreter, so fall back to import.meta.dir (the module's own directory).
 *
 * Row 106 owns finalising the compiled-binary resolution; this helper is written so
 * both postures find a lock placed next to the entry point.
 */
export function resolveProgramDir(): string {
  const execDir = dirname(process.execPath)
  if (existsSync(join(execDir, LOCK_FILE_NAME))) {
    return execDir
  }
  // Source/dev posture: the module directory contains tools.lock.json.
  return import.meta.dir
}

export function resolveLockFile(): string {
  return join(resolveProgramDir(), LOCK_FILE_NAME)
}

/** Absolute path of the steps directory that self-registers components (§9). */
export function stepsRoot(): string {
  return join(import.meta.dir, "steps")
}

export const PROGRAM = PROGRAM_NAME
