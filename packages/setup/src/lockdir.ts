// Lock directory (PC-PATH-04, 01c §6.2). A second concurrent run is refused.
//
// Mechanism: `mkdir` of ~/.swarm/setup/lock is atomic, so exactly one racing
// process can create it. The winner records its pid inside the directory. On a
// later run, if the directory already exists we read that pid and probe it with
// `process.kill(pid, 0)`:
//   - alive (or EPERM = exists under another uid) -> refuse concurrency (exit 1);
//   - gone (ESRCH) -> the holder was killed (e.g. kill -9); clear the stale lock
//     and retry the mkdir once.
// The lock is released on completion or on a handled failure by removing the dir.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { MODES } from "./constants.ts"
import { ensureDir, lockDir } from "./paths.ts"

const PID_FILE_NAME = "pid"

function pidFilePath(): string {
  return join(lockDir(), PID_FILE_NAME)
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0) // signal 0 = liveness probe, delivers nothing
    return true
  } catch (err) {
    const code = (err as { code?: string }).code
    // EPERM means the process exists but belongs to another uid -> still alive.
    return code === "EPERM"
  }
}

export type LockResult = { ok: true } | { ok: false; reason: "concurrency"; holderPid: number }

/** Attempt to acquire the setup lock. Idempotent-safe against a prior crash. */
export function acquireLock(): LockResult {
  ensureDir(lockDir(), MODES.DIR_0700) // ensure parent ~/.swarm/setup exists
  try {
    mkdirSync(lockDir(), { mode: MODES.DIR_0700 }) // atomic create; throws EEXIST if held
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === "EEXIST") {
      const holder = readHolderPid()
      if (holder !== null && pidAlive(holder)) {
        return { ok: false, reason: "concurrency", holderPid: holder }
      }
      // Stale lock left by a killed run: clear it and retry the atomic mkdir once.
      rmSync(lockDir(), { recursive: true, force: true })
      try {
        mkdirSync(lockDir(), { mode: MODES.DIR_0700 })
      } catch {
        return { ok: false, reason: "concurrency", holderPid: -1 }
      }
    } else {
      throw err
    }
  }
  // Record our pid so a concurrent/stale reader can decide. Written 0600 inside the
  // 0700 dir. This is advisory metadata, not committed state: a torn pid file only
  // affects staleness detection, which fails safe (a bad parse is treated as stale).
  try {
    writeFileSync(pidFilePath(), String(process.pid) + "\n", { encoding: "utf8", mode: MODES.FILE_0600 })
  } catch {
    /* best-effort; a missing pid file makes the next run treat the lock as stale */
  }
  return { ok: true }
}

export function releaseLock(): void {
  rmSync(lockDir(), { recursive: true, force: true })
}

function readHolderPid(): number | null {
  try {
    const raw = readFileSync(pidFilePath(), "utf8").trim()
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}
