// A command runs in its own process group, so it outlives a server that crashes or is killed. The run resumes, and the
// old command then races the next step: a half-done migration next to the step that assumes it finished. Each running
// command leaves a record, so the next tool call in that session can end what the dead server left behind.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"

type Started = { pid: number; started: string }
type Running = Started & { server: Started }

const FORCE_AFTER_MS = 3000
const POLL_MS = 50

const folder = (session: string) => path.join(Global.Path.state, "shell-running", path.basename(session))

/** When the process began. With a pid this identifies one process, since the number alone can be handed out again. */
function startedAt(pid: number) {
  const out = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" })
  return out.status === 0 ? out.stdout.trim() : ""
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
    // Its server is still up, whether this one or another process: that command is in use.
    if (running.server.started && startedAt(running.server.pid) === running.server.started) continue
    if (groupAlive(running.pid)) {
      // A live leader with another start time is a new process given the same number. A group whose leader has exited
      // keeps its number for as long as a member lives, so a group without a leader is still this command's.
      const leader = startedAt(running.pid)
      if (!leader || leader === running.started) {
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
