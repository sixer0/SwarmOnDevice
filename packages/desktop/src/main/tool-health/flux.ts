// TH-05 / SEC-18 (1.2.6 row 94): the FLUX adapter of the tool-health regime (spec 01c 4.6, 5.3; decisions C5, U19, U21).
//
// FLUX is never a shipped component (C5): this module only knows the SHAPE of a `flux3` user entry for
// `~/.config/swarm/tool-health.json`, built from the values of the machine it is written on (work dir, `id -u`,
// server.py hash). Nothing here holds a machine path. The regime runs the entry like any other user component:
// - probe   GET http://127.0.0.1:7863/health, healthy = 200 and `weights_downloaded: true` (the model loads lazily, so
//           `model_loaded` is not used). The probe sets no Host header: FLUX answers 403 to any Host other than
//           127.0.0.1:7863 or localhost:7863, and fetch derives exactly that from the URL.
// - revive  `launchctl kickstart gui/<uid>/<label>` (job still loaded, process died), then, only when that exits
//           non-zero, `launchctl submit -l <label> ...` (label gone: logout, reboot, `launchctl remove`). FLUX stays a
//           launchd submitted job; no plist is written (U19). No approval is asked (U21).
// - degraded when absent: no entry = no component; a missing venv python (`installedWhen.path`) =
//           `skipped_not_installed` with no launchctl call (regime decision table row 3).
// - SEC-18  the entry records `watch: [{ path: <W>/server.py, sha256 }]`; at revive a changed or missing file logs one
//           `WATCHED_FILE_CHANGED` warning and the revive still runs (U21: warn, never block).

import { createHash } from "node:crypto"
import { closeSync, fstatSync, openSync, readSync, constants as fsConstants } from "node:fs"
import { join } from "node:path"
import type { ToolHealthComponent, ToolHealthWatch } from "./types"

export const FLUX_COMPONENT_ID = "flux3"
export const FLUX_LABEL = "FLUX 3 image service"
export const FLUX_LAUNCHD_LABEL = "local.flux3-image-klein"
export const FLUX_HOST = "127.0.0.1"
export const FLUX_PORT = 7863
export const FLUX_HEALTH_URL = `http://${FLUX_HOST}:${FLUX_PORT}/health`
/** uvicorn starts at once (lazy model load, 02d), so 30 s covers launchd plus the first /health. */
export const FLUX_REVIVE_TIMEOUT_MS = 30000
export const FLUX_PROBE_TIMEOUT_MS = 3000
export const LAUNCHCTL_PATH = "/bin/launchctl"
/** Largest watched file that is hashed; a bigger file counts as changed (server.py is a few KiB). */
export const WATCH_HASH_MAX_BYTES = 8 * 1024 * 1024

export type FluxEntryInput = {
  /** Absolute FLUX work dir (holds server.py, .venv, service.log). Written literally: argv is never expanded. */
  workDir: string
  /** `id -u` when the entry is written (launchd GUI domain). */
  uid: number
  /** sha256 of <workDir>/server.py at write time (SEC-18). Absent = no watch. */
  serverSha256?: string
}

function assertInput(input: FluxEntryInput) {
  if (!input.workDir.startsWith("/") || input.workDir.includes("\0")) throw new Error("workDir must be an absolute path")
  if (!Number.isInteger(input.uid) || input.uid < 0) throw new Error("uid must be a non-negative integer")
  if (input.serverSha256 !== undefined && !/^[0-9a-f]{64}$/.test(input.serverSha256))
    throw new Error("serverSha256 must be 64 lowercase hex")
}

export function fluxPaths(workDir: string) {
  return {
    python: join(workDir, ".venv", "bin", "python"),
    server: join(workDir, "server.py"),
    stdout: join(workDir, "service.log"),
    stderr: join(workDir, "service-error.log"),
  }
}

/** Step 1: the job is still loaded in gui/<uid>, only its process died. */
export function fluxKickstartArgv(uid: number): string[] {
  return [LAUNCHCTL_PATH, "kickstart", `gui/${uid}/${FLUX_LAUNCHD_LABEL}`]
}

/** Step 2 (fallback): the label is gone; submit it again with the program and arguments of the original job (02d). */
export function fluxSubmitArgv(workDir: string): string[] {
  const p = fluxPaths(workDir)
  return [
    LAUNCHCTL_PATH,
    "submit",
    "-l",
    FLUX_LAUNCHD_LABEL,
    "-o",
    p.stdout,
    "-e",
    p.stderr,
    "--",
    p.python,
    "-m",
    "uvicorn",
    "--app-dir",
    workDir,
    "server:app",
    "--host",
    FLUX_HOST,
    "--port",
    String(FLUX_PORT),
  ]
}

/** The `flux3` entry of 01c 4.6 (+ SEC-18 `watch`), as it is written under `components` in the user file. */
export function fluxToolHealthEntry(input: FluxEntryInput): Omit<ToolHealthComponent, "id"> {
  assertInput(input)
  const p = fluxPaths(input.workDir)
  const entry: Omit<ToolHealthComponent, "id"> = {
    label: FLUX_LABEL,
    probe: {
      kind: "http",
      url: FLUX_HEALTH_URL,
      expectStatus: 200,
      expectJson: { weights_downloaded: true },
      timeoutMs: FLUX_PROBE_TIMEOUT_MS,
    },
    revive: { argv: fluxKickstartArgv(input.uid), fallbackArgv: fluxSubmitArgv(input.workDir) },
    startup: "probe",
    consent: "auto",
    installedWhen: { path: p.python },
    reviveTimeoutMs: FLUX_REVIVE_TIMEOUT_MS,
  }
  if (input.serverSha256) entry.watch = [{ path: p.server, sha256: input.serverSha256 }]
  return entry
}

/**
 * The user file with the `flux3` entry set. Other entries of `existing` are kept as they are; a non-object
 * `existing` is refused rather than overwritten (the caller backs the file up first and decides).
 */
export function withFluxEntry(existing: unknown, input: FluxEntryInput): { components: Record<string, unknown> } {
  const base = existing === undefined ? { components: {} } : existing
  if (typeof base !== "object" || base === null || Array.isArray(base)) throw new Error("existing tool-health.json is not an object")
  const components = (base as { components?: unknown }).components ?? {}
  if (typeof components !== "object" || components === null || Array.isArray(components))
    throw new Error("existing tool-health.json components is not an object")
  return { ...(base as object), components: { ...(components as Record<string, unknown>), [FLUX_COMPONENT_ID]: fluxToolHealthEntry(input) } }
}

/** sha256 of a regular file (no symlink follow, size-capped); undefined when it cannot be read. */
export function hashWatchedFile(path: string): string | undefined {
  let fd: number | undefined
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > WATCH_HASH_MAX_BYTES) return undefined
    const hash = createHash("sha256")
    const buf = Buffer.allocUnsafe(64 * 1024)
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null)
      if (n <= 0) break
      hash.update(buf.subarray(0, n))
    }
    return hash.digest("hex")
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export type WatchedFileChange = { path: string; expected: string; actual: string | "missing" }

/** SEC-18: the watched files whose hash differs from the recorded one (missing or unreadable counts as changed). */
export function changedWatchedFiles(
  watch: readonly ToolHealthWatch[] | undefined,
  hash: (path: string) => string | undefined = hashWatchedFile,
): WatchedFileChange[] {
  const changes: WatchedFileChange[] = []
  for (const w of watch ?? []) {
    const actual = hash(w.path)
    if (actual !== w.sha256) changes.push({ path: w.path, expected: w.sha256, actual: actual ?? "missing" })
  }
  return changes
}

/** The one warning line written for a revive with changed watched files (01c section 9 style). */
export function watchedFileChangedMessage(label: string, changes: readonly WatchedFileChange[]): string {
  const names = changes.map((c) => c.path).join(", ")
  return `${label}: WATCHED_FILE_CHANGED - ${names} changed since the entry was written; the revive runs anyway. Check the file, then update watch.sha256 in tool-health.json.`
}
