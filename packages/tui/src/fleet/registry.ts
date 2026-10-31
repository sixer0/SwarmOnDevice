import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { hostname } from "node:os"
import path from "node:path"
import type { FleetEntry, FleetRow } from "./model"

// Every plain `swarm` runs a private in-process server, so a request blocked in one tmux pane exists only in that
// process's memory. These files are how the processes on one machine see each other. They carry state and "show this
// session" requests, never approvals: a dropped file must not be able to answer a permission prompt, because any
// command an agent runs as this user could write one.

/** A live process rewrites its file every 10s. Older than this and it is hung or suspended, so it says nothing true. */
const STALE_AFTER = 45_000

export function fleetDirectory(state: string) {
  return path.join(state, "fleet")
}

export function tmuxContext(env: Record<string, string | undefined> = process.env) {
  // $TMUX is "<socket>,<server pid>,<session>"; $TMUX_PANE is the stable "%12" id.
  const socket = env.TMUX?.split(",")[0]
  if (!socket || !env.TMUX_PANE) return undefined
  return { socket, pane: env.TMUX_PANE }
}

export function publish(dir: string, entry: FleetEntry) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, `${entry.pid}.json`)
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(entry), { mode: 0o600 })
  renameSync(temporary, file)
}

export function unpublish(dir: string, pid: number) {
  rmSync(path.join(dir, `${pid}.json`), { force: true })
  rmSync(path.join(dir, `${pid}.goto`), { force: true })
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it exists and belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function parseEntry(text: string): FleetEntry | undefined {
  try {
    const entry = JSON.parse(text) as FleetEntry
    return entry.version === 1 && typeof entry.pid === "number" && Array.isArray(entry.agents) ? entry : undefined
  } catch {
    return undefined
  }
}

/** Other live Swarm processes on this machine. Files left by dead ones are removed as they are found. */
export function readPeers(dir: string, input: { self?: number; now: number; host?: string }): FleetEntry[] {
  const host = input.host ?? hostname()
  const files = (() => {
    try {
      return readdirSync(dir).filter((name) => /^\d+\.json$/.test(name))
    } catch {
      return []
    }
  })()
  return files
    .flatMap((name) => {
      const pid = Number(name.slice(0, -5))
      if (pid === input.self) return []
      const file = path.join(dir, name)
      const text = (() => {
        try {
          return readFileSync(file, "utf8")
        } catch {
          return undefined
        }
      })()
      const entry = text ? parseEntry(text) : undefined
      // A home directory shared over NFS holds files from other hosts: their pids mean nothing here, so leave them be.
      if (entry && entry.host !== host) return []
      if (!entry || !alive(pid)) {
        rmSync(file, { force: true })
        return []
      }
      return input.now - entry.updated > STALE_AFTER ? [] : [entry]
    })
    .toSorted((a, b) => a.pid - b.pid)
}

/** Asks another Swarm process to bring a session to the front. Navigation only. */
export function requestGoto(dir: string, pid: number, sessionID: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(path.join(dir, `${pid}.goto`), sessionID, { mode: 0o600 })
}

export function takeGoto(dir: string, pid: number) {
  const file = path.join(dir, `${pid}.goto`)
  try {
    const sessionID = readFileSync(file, "utf8").trim()
    rmSync(file, { force: true })
    return sessionID || undefined
  } catch {
    return undefined
  }
}

/** Switches this tmux client to the pane holding the row's agent, and asks that Swarm to show the session. */
export function jumpToRow(dir: string, row: FleetRow): { ok: true } | { ok: false; message: string } {
  if (row.where.kind !== "peer") return { ok: false, message: "That agent is in this window." }
  if (!row.where.pane) {
    return {
      ok: false,
      message: row.where.otherTmux
        ? `That agent is in a tmux session this terminal is not part of (pid ${row.where.pid}). Switch to it there.`
        : `That agent is in a terminal outside tmux (pid ${row.where.pid}). Switch to it there.`,
    }
  }
  const result = spawnSync("tmux", ["switch-client", "-t", row.where.pane], { encoding: "utf8", timeout: 3000, env: process.env })
  if (result.error) return { ok: false, message: `Could not run tmux: ${result.error.message}` }
  if (result.status !== 0) return { ok: false, message: result.stderr.trim() || `tmux exited with ${result.status}` }
  requestGoto(dir, row.where.pid, row.sessionID)
  return { ok: true }
}
