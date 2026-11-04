import { execFile } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"

// 1.1.1 (S1.28, D-F1-4): which processes a session's own shell tool started, so that under the consented bypass a `kill`
// of one of them can run and a `kill` of anything else waits for a person. The roots are the running-command records the
// shell tool writes (`tool/shell/orphans.ts`, `shell-running/<session>/<pid>.json`) whose server is this process; the rest
// is read from `/bin/ps`, by its absolute path and without a shell. Whatever goes wrong reads as "none": an empty set keeps
// every `kill` for the person, which is the 1.1.0 answer.

const TIMEOUT_MS = 2_000
const MAX_BUFFER = 8 * 1024 * 1024

/** `pid ppid` per line, as `ps -A -o pid=,ppid=` prints it. A line that is not two whole numbers is left out. */
export function parse(output: string): ReadonlyMap<number, number> {
  const parents = new Map<number, number>()
  for (const line of output.split("\n")) {
    const words = line.trim().split(/\s+/)
    if (words.length !== 2 || !/^\d+$/.test(words[0]!) || !/^\d+$/.test(words[1]!)) continue
    parents.set(Number(words[0]), Number(words[1]))
  }
  return parents
}

/** Every process below `root` in the tree `parents` describes, `root` itself left out. */
export function below(parents: ReadonlyMap<number, number>, root: number): ReadonlySet<number> {
  const children = new Map<number, number[]>()
  for (const [pid, ppid] of parents) {
    if (pid === ppid) continue
    const list = children.get(ppid)
    if (list) list.push(pid)
    else children.set(ppid, [pid])
  }
  const found = new Set<number>()
  const next = [root]
  while (next.length > 0) {
    for (const child of children.get(next.pop()!) ?? []) {
      if (child === root || found.has(child)) continue
      found.add(child)
      next.push(child)
    }
  }
  return found
}

/** How `ps` is run, as a seam so a test can hand in its own output or its own failure. */
export type Run = () => Promise<string>

const runPs: Run = () =>
  new Promise((resolve, reject) =>
    execFile(
      "/bin/ps",
      ["-A", "-o", "pid=,ppid="],
      { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
    ),
  )

/** The processes below `rootPid` (this server by default). Any failure is an empty set. */
export async function descendants(rootPid: number = process.pid, run: Run = runPs): Promise<ReadonlySet<number>> {
  try {
    return below(parse(await run()), rootPid)
  } catch {
    return new Set()
  }
}

/** The pids of a session's running-command records, as a seam so a test can hand in its own. */
export type Roots = (session: string) => readonly number[]

/** Where the shell tool keeps a session's running-command records. The same folder `tool/shell/orphans.ts` writes. */
const recordsOf = (session: string) => path.join(Global.Path.state, "shell-running", path.basename(session))

/**
 * The commands this server's shell tool started for `session` and has not cleared: a record whose server is another
 * process (an earlier, dead server) names nothing this server started. A record that cannot be read is left out.
 */
export const roots: Roots = (session) => {
  const dir = recordsOf(session)
  const names = (() => {
    try {
      return fs.readdirSync(dir)
    } catch {
      return []
    }
  })()
  const found: number[] = []
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    try {
      const entry: unknown = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))
      if (typeof entry !== "object" || entry === null) continue
      const { pid, server } = entry as { pid?: unknown; server?: { pid?: unknown } }
      if (!Number.isSafeInteger(pid) || (pid as number) <= 1) continue
      if (typeof server !== "object" || server === null || server.pid !== process.pid) continue
      found.push(pid as number)
    } catch {
      continue
    }
  }
  return found
}

/**
 * The processes `session`'s shell tool started (each record still in the process table) and everything below them. No
 * record, or any failure, is an empty set.
 */
export async function ofSession(session: string, run: Run = runPs, read: Roots = roots): Promise<ReadonlySet<number>> {
  try {
    const started = read(session)
    if (started.length === 0) return new Set()
    const parents = parse(await run())
    const found = new Set<number>()
    for (const root of started) {
      // A recorded pid that is no longer running names nothing: the number may be handed to another process later.
      if (!parents.has(root) || root === process.pid) continue
      found.add(root)
      for (const pid of below(parents, root)) found.add(pid)
    }
    found.delete(process.pid)
    return found
  } catch {
    return new Set()
  }
}

export * as ProcessTree from "./process-tree"
