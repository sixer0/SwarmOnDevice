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
//   - bounded by a timeout; any failure is logged by the caller and the connect proceeds exactly as before.

import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const GRAFT_MCP_NAME = "graft"
export const GRAFT_BUILD_TIMEOUT_MS = 90_000
const GRAPH_MARKERS = ["INDEX.md", "manifest.json"] as const
const MUST_BE_UNSET = ["GRAFT_PROVIDER", "GRAFT_API_KEY"] as const

export type GraftBuildPlan =
  | { readonly run: true; readonly argv: readonly [string, string, "build", "."] }
  | { readonly run: false; readonly reason: string }

export interface GraftBuildPlanInput {
  readonly name: string
  readonly command: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  /** Test seam; default os.homedir(). */
  readonly home?: string
}

/** Decide whether a graph is built before this MCP entry connects. Reads the filesystem only (stat/readdir). */
export function planGraftBuild(input: GraftBuildPlanInput): GraftBuildPlan {
  if (input.name !== GRAFT_MCP_NAME) return { run: false, reason: "not the graft entry" }
  const [node, cli, sub, ...rest] = input.command
  if (rest.length > 0 || sub !== "mcp" || !node || !cli || !path.isAbsolute(node) || !path.isAbsolute(cli))
    return { run: false, reason: "graft command is not the sanctioned [node, cli, mcp] shape" }
  if (input.env.DO_NOT_TRACK !== "1") return { run: false, reason: "DO_NOT_TRACK is not 1" }
  if (MUST_BE_UNSET.some((k) => (input.env[k] ?? "") !== "")) return { run: false, reason: "graft provider key present" }

  const cwd = path.resolve(input.cwd)
  const home = path.resolve(input.home ?? os.homedir())
  if (cwd === path.parse(cwd).root) return { run: false, reason: "filesystem root" }
  if (cwd === home || home.startsWith(cwd + path.sep)) return { run: false, reason: "home folder or an ancestor of it" }
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

export type GraftBuildResult =
  | { readonly ok: true; readonly ms: number }
  | { readonly ok: false; readonly ms: number; readonly reason: string }

/** Run the planned build in `cwd`. Output is discarded (it carries paths); only the exit status is reported. */
export function runGraftBuild(
  argv: readonly string[],
  cwd: string,
  env: Record<string, string | undefined>,
  timeoutMs = GRAFT_BUILD_TIMEOUT_MS,
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
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: "ignore" })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      done({ ok: false, ms: Date.now() - started, reason: `timed out after ${timeoutMs} ms` })
    }, timeoutMs)
    child.once("error", (e) => done({ ok: false, ms: Date.now() - started, reason: e.message }))
    child.once("exit", (code, signal) =>
      code === 0
        ? done({ ok: true, ms: Date.now() - started })
        : done({ ok: false, ms: Date.now() - started, reason: `exit ${code ?? signal}` }),
    )
  })
}
