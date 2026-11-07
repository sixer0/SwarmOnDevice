import { execFileSync } from "node:child_process"
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs"
import { join } from "node:path"
import { StoreError } from "./errors.ts"
import { STORE_LOCK_FILE } from "./paths.ts"

/**
 * Single-writer lock file `<root>/datum-studio.lock` (spec §6.2, U13).
 * Created with O_CREAT|O_EXCL ("wx", 0600) before the database opens; a second holder gets EEXIST.
 * A lock is stale only when its PID is not a live Swarm/Electron host process; a stale lock is
 * renamed to `datum-studio.lock.stale-<ms>` (never deleted), then taken again with O_EXCL.
 */
export interface LockInfo {
  pid: number
  startedAt: number
  release: string
}

export interface StoreLock {
  readonly path: string
  readonly info: LockInfo
  /** Removes the lock file only if it is still ours. */
  release(): void
}

/**
 * Default liveness check. The holder is live when it is this process, or when `ps -p <pid> -o comm=`
 * ends in `/Contents/MacOS/<Swarm|Electron>` or their `... Helper` (the host is a utility process,
 * whose binary is the Helper; row 7 §9.3 named only the main binary).
 */
export function defaultIsLiveHost(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return false
  }
  let comm = ""
  try {
    comm = execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", timeout: 5000 }).trim()
  } catch {
    return false
  }
  return /\/Contents\/MacOS\/(Swarm|Electron)( Helper( \([A-Za-z]+\))?)?$/.test(comm)
}

function readLock(path: string): LockInfo | null {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as Partial<LockInfo>
    if (typeof v.pid === "number" && typeof v.startedAt === "number") return { pid: v.pid, startedAt: v.startedAt, release: String(v.release ?? "") }
  } catch {
    // unreadable or half-written lock: treated as stale below
  }
  return null
}

function tryCreate(path: string, info: LockInfo): boolean {
  let fd: number
  try {
    fd = openSync(path, "wx", 0o600)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false
    throw e
  }
  try {
    writeSync(fd, JSON.stringify(info))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return true
}

export function acquireStoreLock(
  root: string,
  opts: { release: string; now: () => number; isLiveHost?: (pid: number) => boolean },
): StoreLock {
  const path = join(root, STORE_LOCK_FILE)
  const info: LockInfo = { pid: process.pid, startedAt: opts.now(), release: opts.release }
  const live = opts.isLiveHost ?? defaultIsLiveHost
  for (let attempt = 0; attempt < 2; attempt++) {
    if (tryCreate(path, info)) {
      return {
        path,
        info,
        release() {
          const cur = readLock(path)
          if (cur && cur.pid === info.pid && cur.startedAt === info.startedAt) unlinkSync(path)
        },
      }
    }
    const held = readLock(path)
    if (held && live(held.pid)) {
      throw new StoreError("STORE_LOCKED", `store in use by PID ${held.pid}`, { pid: held.pid, startedAt: held.startedAt })
    }
    renameSync(path, `${path}.stale-${opts.now()}`)
  }
  throw new StoreError("STORE_LOCKED", "store lock was re-taken by another process during stale recovery")
}
