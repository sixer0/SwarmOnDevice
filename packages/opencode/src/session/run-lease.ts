import { Global } from "@opencode-ai/core/global"
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import path from "node:path"

// A run lives in one process's memory, so nothing in the database can tell "still running somewhere" from "the
// process died". Several Swarm processes share one database, and a run must never be picked up while its owner is
// alive. A lease is that missing fact: one file per active run, naming the process that owns it. A run that ends in any
// normal way (finished, failed, stopped by the user) removes its file; only a process that died leaves one behind.

export const MAX_RESUMES = 3
export const MAX_AGE = 24 * 60 * 60 * 1000

export type Lease = {
  version: 1
  sessionID: string
  directory: string
  parentID?: string
  pid: number
  resumes: number
  /** The process exited on purpose (quit, SIGTERM, ctrl-c). Quitting means stop: tidy up, do not carry on. */
  stopped?: boolean
}

export type Interrupted = {
  lease: Lease
  /** continue: run it again. stopped: its owner quit. exhausted: too many resumes or too old to act on unasked. */
  action: "continue" | "stopped" | "exhausted"
}

/** Exit codes that mean somebody asked this process to stop. Anything else is a crash and keeps its leases. */
const DELIBERATE_EXITS = new Set([0, 130, 143])

const held = new Map<string, Lease>()
let enabled = false
let pending: Interrupted[] = []

const directory = () => path.join(Global.Path.state, "runs")
const file = (sessionID: string) => path.join(directory(), `${sessionID}.json`)

/**
 * A long-lived host calls this once before its server starts: leases are written from here on, and the runs a dead
 * process left behind are queued for the server to continue (see SessionResume.layer). A one-shot `swarm run` does not
 * call it, so killing one stays final. `only` limits it to one project, for a host that is tied to one.
 */
export function host(input: { only?: string } = {}) {
  if (process.env.SWARM_DISABLE_RUN_RESUME) return
  enable()
  pending = [...pending, ...claimInterrupted(input)]
}

/** The claimed runs, once. Each server builds its own copy of the session services, so exactly one must run them. */
export function takePending() {
  const taken = pending
  pending = []
  return taken
}

export function enable() {
  if (enabled) return
  enabled = true
  process.on("exit", (code) => {
    if (DELIBERATE_EXITS.has(code)) markStopped()
  })
  // An unhandled signal kills the process before "exit" fires, which would read as a crash on the next start. SIGHUP is
  // left alone on purpose: a dropped ssh session or closed terminal is not a decision to stop the agent.
  ;(
    [
      ["SIGTERM", 143],
      ["SIGINT", 130],
    ] as const
  ).forEach(([signal, code]) => {
    if (process.listenerCount(signal) === 0) process.on(signal, () => process.exit(code))
  })
}

export function begin(input: { sessionID: string; directory: string; parentID?: string }) {
  if (!enabled) return
  // A resumed run was claimed just before it began. Keeping its count is what stops a crash loop spending forever.
  const previous = read(file(input.sessionID))
  write({
    version: 1,
    sessionID: input.sessionID,
    directory: input.directory,
    parentID: input.parentID,
    pid: process.pid,
    resumes: previous?.pid === process.pid ? previous.resumes : 0,
  })
}

/** Marks progress, so the age limit counts from when the run was last doing something and not from when it began. */
export function touch(sessionID: string) {
  if (!held.has(sessionID)) return
  const now = new Date()
  try {
    utimesSync(file(sessionID), now, now)
  } catch {
    // The file going missing only costs this run its crash protection.
  }
}

export function end(sessionID: string) {
  if (!enabled) return
  held.delete(sessionID)
  rmSync(file(sessionID), { force: true })
}

/**
 * Runs whose owner is gone, atomically taken over by this process. Two Swarms starting together cannot both get one:
 * the rename succeeds for exactly one of them. `only` limits it to one directory, for a host tied to a project.
 */
export function claimInterrupted(input: { only?: string; now?: number } = {}): Interrupted[] {
  const now = input.now ?? Date.now()
  const names = list()
  // A claim file with a dead owner means a process died in the instant between claiming and rewriting. Drop it.
  names
    .filter((name) => name.includes(".claim."))
    .filter((name) => !alive(Number(name.split(".claim.")[1])))
    .forEach((name) => rmSync(path.join(directory(), name), { force: true }))
  return names
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => {
      const lease = read(path.join(directory(), name))
      if (!lease || alive(lease.pid)) return []
      if (input.only && lease.directory !== input.only) return []
      const item = claim(lease, now)
      return item ? [item] : []
    })
}

function claim(lease: Lease, now: number): Interrupted | undefined {
  const target = file(lease.sessionID)
  const claimed = `${target}.claim.${process.pid}`
  const age = now - mtime(target)
  try {
    renameSync(target, claimed)
  } catch {
    return undefined
  }
  // The read before the rename can be out of date: another process may have claimed and rewritten this file since.
  const current = read(claimed)
  if (!current || alive(current.pid)) {
    if (current) renameSync(claimed, target)
    return undefined
  }
  const action = current.stopped
    ? ("stopped" as const)
    : current.resumes >= MAX_RESUMES || age > MAX_AGE
      ? ("exhausted" as const)
      : ("continue" as const)
  rmSync(claimed, { force: true })
  if (action !== "continue") return { lease: current, action }
  const next = { ...current, pid: process.pid, resumes: current.resumes + 1, stopped: undefined }
  if (enabled) write(next)
  return { lease: next, action }
}

function markStopped() {
  // Runs synchronously inside the "exit" event: nothing asynchronous would get a chance to finish here.
  held.forEach((lease) => write({ ...lease, stopped: true }))
}

function write(lease: Lease) {
  mkdirSync(directory(), { recursive: true, mode: 0o700 })
  const target = file(lease.sessionID)
  const temporary = `${target}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(lease), { mode: 0o600 })
  renameSync(temporary, target)
  held.set(lease.sessionID, lease)
}

function read(target: string) {
  try {
    const lease = JSON.parse(readFileSync(target, "utf8")) as Lease
    return lease.version === 1 && typeof lease.pid === "number" ? lease : undefined
  } catch {
    return undefined
  }
}

function list() {
  try {
    return readdirSync(directory())
  } catch {
    return []
  }
}

function mtime(target: string) {
  try {
    return statSync(target).mtimeMs
  } catch {
    return 0
  }
}

function alive(pid: number) {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it exists and belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export * as RunLease from "./run-lease"
