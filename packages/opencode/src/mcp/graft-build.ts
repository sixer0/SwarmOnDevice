// U20 (Office add-in task, ECO-1 F-2): graft 0.18 `mcp` lists no tools in a directory without a graph, and none of its
// tools can build one. The per-directory MCP connection keeps that empty list for the life of the instance, so a new
// project never gets graft. Before the graft MCP child is spawned, this module runs `graft build .` once for a project
// that has no graph (`graft/INDEX.md` or `graft/manifest.json`), so the connection that follows lists the tools.
//
// Scope is deliberately narrow:
//   - only the entry named `graft` whose command is exactly [<abs node>, <abs cli>, "mcp"] (the shape the setup
//     writer's launch guard sanctions); the build argv is derived from it as [node, cli, "build", "."];
//   - never `init` (writes machine-wide config) and never `--deep` (sends code to an LLM provider);
//   - the build child gets the same environment as the MCP child and is refused when telemetry is not off
//     (DO_NOT_TRACK=1) or a graft provider key is present;
//   - skipped for "/", the home folder and its ancestors (a graph of the whole home is neither wanted nor bounded),
//     and for a directory with no visible entry (nothing to index);
//   - graft's own edits of the project's .gitignore and .ignore are switched off (GRAFT_NO_GITIGNORE / GRAFT_NO_IGNORE,
//     graft 0.18 dist/context/node-file.js); only the graft/ folder is written (M12 S12-01);
//   - bounded by a timeout and by the instance's abort signal; a failed build is not retried for that folder for
//     GRAFT_BUILD_RETRY_MS (M12 CR-1), and any failure is logged by the caller.
//
// The caller runs the build in the background and reconnects graft when it succeeds (M12 CR-1): the first connect
// never waits on it, so no MCP server's tools are delayed by a build.

import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const GRAFT_MCP_NAME = "graft"
export const GRAFT_BUILD_TIMEOUT_MS = 90_000
/** @internal test seam */
export const GRAFT_BUILD_RETRY_MS = 60 * 60_000
const failedAt = new Map<string, number>()

/** Remember a failed build so the folder is not rebuilt at every instance start. */
export function recordGraftBuildFailure(cwd: string, now = Date.now()) {
  failedAt.set(path.resolve(cwd), now)
}

/** @internal test seam */
export function resetGraftBuildFailures() {
  failedAt.clear()
}

function real(p: string) {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return path.resolve(p)
  }
}
const GRAPH_MARKERS = ["INDEX.md", "manifest.json"] as const
const MUST_BE_UNSET = ["GRAFT_PROVIDER", "GRAFT_API_KEY"] as const

type GraftBuildPlan =
  | { readonly run: true; readonly argv: readonly [string, string, "build", "."] }
  | { readonly run: false; readonly reason: string }

interface GraftBuildPlanInput {
  readonly name: string
  readonly command: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  /** Test seam; default os.homedir(). */
  readonly home?: string
  /** Test seam; default Date.now(). */
  readonly now?: number
}

/** Decide whether a graph is built before this MCP entry connects. Reads the filesystem only (stat/readdir). */
export function planGraftBuild(input: GraftBuildPlanInput): GraftBuildPlan {
  if (input.name !== GRAFT_MCP_NAME) return { run: false, reason: "not the graft entry" }
  const [node, cli, sub, ...rest] = input.command
  if (rest.length > 0 || sub !== "mcp" || !node || !cli || !path.isAbsolute(node) || !path.isAbsolute(cli))
    return { run: false, reason: "graft command is not the sanctioned [node, cli, mcp] shape" }
  if (input.env.DO_NOT_TRACK !== "1") return { run: false, reason: "DO_NOT_TRACK is not 1" }
  if (MUST_BE_UNSET.some((k) => (input.env[k] ?? "") !== "")) return { run: false, reason: "graft provider key present" }

  // M12 F5: symlinks resolved and compared case-insensitively, so another spelling of home is still home.
  const cwd = real(input.cwd)
  const home = real(input.home ?? os.homedir())
  if (cwd === path.parse(cwd).root) return { run: false, reason: "filesystem root" }
  const [c, h] = [cwd.toLowerCase(), home.toLowerCase()]
  if (c === h || h.startsWith(c + path.sep)) return { run: false, reason: "home folder or an ancestor of it" }
  const failed = failedAt.get(path.resolve(input.cwd)) ?? failedAt.get(cwd)
  if (failed !== undefined && (input.now ?? Date.now()) - failed < GRAFT_BUILD_RETRY_MS)
    return { run: false, reason: "a recent build in this folder failed" }
  // ECO-1 F-9: a plain `graft build` writes graft/INDEX.md; graft/manifest.json comes only from `--deep`.
  if (GRAPH_MARKERS.some((m) => fs.existsSync(path.join(cwd, "graft", m)))) return { run: false, reason: "graph already present" }

  let entries: string[]
  try {
    if (!fs.statSync(cwd).isDirectory()) return { run: false, reason: "not a directory" }
    entries = fs.readdirSync(cwd)
  } catch {
    return { run: false, reason: "directory not readable" }
  }
  if (!entries.some((e) => !e.startsWith(".") && e !== "graft")) return { run: false, reason: "empty directory" }
  return { run: true, argv: [node, cli, "build", "."] }
}

type GraftBuildResult =
  | { readonly ok: true; readonly ms: number }
  | { readonly ok: false; readonly ms: number; readonly reason: string }

/**
 * Run the planned build in `cwd`. Output is discarded (it carries paths); only the exit status is reported. `signal`
 * (the instance closing) kills the child like the timeout does. Never rejects.
 */
export function runGraftBuild(
  argv: readonly string[],
  cwd: string,
  env: Record<string, string | undefined>,
  timeoutMs = GRAFT_BUILD_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<GraftBuildResult> {
  const started = Date.now()
  return new Promise((resolve) => {
    let settled = false
    const done = (r: GraftBuildResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    if (signal?.aborted) return done({ ok: false, ms: 0, reason: "aborted" })
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(argv[0]!, argv.slice(1), {
        cwd,
        env: { ...env, GRAFT_NO_GITIGNORE: "1", GRAFT_NO_IGNORE: "1" },
        stdio: "ignore",
      })
    } catch (e) {
      return done({ ok: false, ms: Date.now() - started, reason: e instanceof Error ? e.message : String(e) })
    }
    const stop = (reason: string) => {
      child.kill("SIGKILL")
      done({ ok: false, ms: Date.now() - started, reason })
    }
    timer = setTimeout(() => stop(`timed out after ${timeoutMs} ms`), timeoutMs)
    signal?.addEventListener("abort", () => stop("aborted"), { once: true })
    child.once("error", (e) => done({ ok: false, ms: Date.now() - started, reason: e.message }))
    child.once("exit", (code, killedBy) =>
      code === 0
        ? done({ ok: true, ms: Date.now() - started })
        : done({ ok: false, ms: Date.now() - started, reason: `exit ${code ?? killedBy}` }),
    )
  })
}
