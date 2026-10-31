// A command runs in its own process group, so it outlives a server that crashes or is killed. The run resumes, and the
// old command then races the next step: a half-done migration next to the step that assumes it finished. Each running
// command leaves a record, so the next tool call in that session can end what the dead server left behind.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"

type Started = { pid: number; started?: string }
type Running = Started & { server: Started }

const FORCE_AFTER_MS = 3000
const POLL_MS = 50

const folder = (session: string) => path.join(Global.Path.state, "shell-running", path.basename(session))

/**
 * When the process began. With a pid this identifies one process, since the number alone can be handed out again.
 * `undefined` means `ps` could not say, which is not the same as `""`, no such process. It can be blocked or missing, and
 * BusyBox's has no `-p`.
 */
function startedAt(pid: number) {
  const out = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: process.env })
  if (out.error) return undefined
  if (out.status === 0) return out.stdout.trim() || undefined
  return out.status === 1 && !out.stderr.trim() ? "" : undefined
}

let self: Started | undefined
const thisServer = () => (self ??= { pid: process.pid, started: startedAt(process.pid) })

function groupAlive(pid: number) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    // EPERM still means it exists.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** No signal is sent. Only "no such process" counts as gone: anything else, including no permission, is still there. */
function processAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

/** Gone for certain, up for certain, or undefined when nothing here can tell. Only a certain answer may kill. */
function serverIsGone({ pid, started }: Started) {
  if (!processAlive(pid)) return true
  const now = startedAt(pid)
  if (now === undefined || !started) return undefined
  return now !== started
}

/** Whether ending this group would end the recorded command. Undefined when nothing here can tell. */
function stillThatCommand(running: Running) {
  // A group whose leader has exited keeps its number for as long as a member lives, so that is still this command.
  if (!processAlive(running.pid)) return true
  const leader = startedAt(running.pid)
  if (leader === undefined || !running.started) return undefined
  // A live leader with another start time is a new process given the same number.
  return leader === "" || leader === running.started
}

function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal)
  } catch {
    // Already gone, which is what this was for.
  }
}

export function record(session: string, pid: number, server: Started = thisServer()) {
  const entry: Running = { pid, started: startedAt(pid), server }
  fs.mkdirSync(folder(session), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(folder(session), `${pid}.json`), JSON.stringify(entry), { mode: 0o600 })
}

export function clear(session: string, pid: number) {
  fs.rmSync(path.join(folder(session), `${pid}.json`), { force: true })
}

function read(file: string): Running | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}

/** Ends this session's commands whose server is gone, and returns how many it ended. */
export async function end(session: string) {
  const dir = folder(session)
  if (!fs.existsSync(dir)) return 0
  let ended = 0
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name)
    const running = read(file)
    if (!running) {
      fs.rmSync(file, { force: true })
      continue
    }
    // Its server is still up, whether this one or another process: that command is in use. When `ps` cannot answer, the
    // record stays for a later call to decide, because a wrong guess here kills a running migration.
    if (serverIsGone(running.server) !== true) continue
    if (groupAlive(running.pid)) {
      const same = stillThatCommand(running)
      if (same === undefined) continue
      if (same) {
        signalGroup(running.pid, "SIGTERM")
        const deadline = Date.now() + FORCE_AFTER_MS
        while (groupAlive(running.pid) && Date.now() < deadline) await Bun.sleep(POLL_MS)
        if (groupAlive(running.pid)) signalGroup(running.pid, "SIGKILL")
        ended++
      }
    }
    fs.rmSync(file, { force: true })
  }
  return ended
}

export * as ShellOrphans from "./orphans"
