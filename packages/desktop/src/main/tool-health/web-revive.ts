// TH-03 (1.2.6 row 92b): the web revive adapter. `runtime`, `searxng` and `firecrawl` are revived ONLY through
// `swarm-setup start <id>` on the shared setup runner (setup-runner.ts `start`), which runs one swarm-setup at a
// time. No argv is built here: the runner owns the one start-only argv (`startArgs`). Never install, apply, up.
//
// Mapping (01c 4.7, section 9):
// - no runner / no `start` method, or the runner refuses `no_start_verb` (older binary) -> SETUP_NO_START_VERB
// - runner busy (a person's install is running) or refuses `busy`                     -> SETUP_BUSY, no retry
// - RESULT REFUSED_CONCURRENCY (swarm-setup's own lock is held, C13)                   -> SETUP_BUSY
// - RESULT START_NOT_INSTALLED | RUNTIME_PROFILE_MISSING | START_CONTAINERS_MISSING    -> that reason (with no
//   RESULT line, the same token found in stdout/stderr)
// - exit 0                                                                             -> ok
// - anything else (other refusal, START_UNKNOWN_COMPONENT, FAILED, spawn failure)      -> REVIVE_EXIT
import type { ReviveOutcome, ToolHealthLog } from "./regime"
import { scrubDetail, scrubOutput } from "./state"

/** The only ids a `compose-start` revive may pass to `swarm-setup start` (N-153); same list as the runner's. */
export const WEB_REVIVE_IDS = ["runtime", "searxng", "firecrawl"] as const
export type WebReviveId = (typeof WEB_REVIVE_IDS)[number]

/** RESULT tokens of `swarm-setup start` that map one-to-one onto a tool-health reason (N-154, N-156, N-157). */
export const START_REFUSAL_CODES = ["START_NOT_INSTALLED", "RUNTIME_PROFILE_MISSING", "START_CONTAINERS_MISSING"] as const
/** swarm-setup's own lock refusal (P-15); `start` takes the setup lock per C13. */
export const START_BUSY_RESULT = "REFUSED_CONCURRENCY"

/** What tool-health needs from the shared setup runner. `SetupRunner` (setup-runner.ts) satisfies it. */
export type WebReviveRunner = {
  busy?: () => boolean
  start?: (id: WebReviveId) => Promise<
    | { kind: "ran"; exitCode: number | null; stdout: string; stderr: string; result?: string }
    | { kind: "refused"; reason: string; message?: string }
  >
}

export function isWebReviveId(id: string): id is WebReviveId {
  return (WEB_REVIVE_IDS as readonly string[]).includes(id)
}

/** The RESULT token: the runner's parsed `result`, else the last `RESULT <TOKEN>` line of stdout. */
function resultToken(run: { stdout: string; result?: string }) {
  if (run.result) return run.result
  const lines = [...run.stdout.matchAll(/^RESULT ([A-Z_]+)$/gm)]
  return lines.at(-1)?.[1]
}

export async function reviveWebComponent(
  id: string,
  runner: WebReviveRunner | undefined,
  opts: { log: ToolHealthLog; secrets: () => readonly string[] },
): Promise<ReviveOutcome> {
  if (!isWebReviveId(id)) return { ok: false, reason: "REVIVE_EXIT", detail: `${id} has no setup start` }
  if (!runner?.start) return { ok: false, reason: "SETUP_NO_START_VERB", detail: "swarm-setup start is not available" }
  if (runner.busy?.()) return { ok: false, reason: "SETUP_BUSY", detail: "swarm-setup is running" }
  const result = await runner.start(id)
  if (result.kind === "refused") {
    if (result.reason === "busy") return { ok: false, reason: "SETUP_BUSY", detail: "swarm-setup is running" }
    if (result.reason === "no_start_verb")
      return { ok: false, reason: "SETUP_NO_START_VERB", detail: "the bundled swarm-setup has no start command" }
    return { ok: false, reason: "REVIVE_EXIT", detail: `swarm-setup start ${id} refused (${result.reason})` }
  }
  if (result.exitCode === 0) return { ok: true, detail: `swarm-setup start ${id} ok` }
  const secrets = opts.secrets()
  opts.log("warn", `swarm-setup start ${id} output`, {
    exitCode: result.exitCode,
    stdout: scrubOutput(result.stdout, secrets),
    stderr: scrubOutput(result.stderr, secrets),
  })
  // The RESULT line is authoritative; without one (a crash mid-run), a refusal token anywhere in the output still
  // names the cause (the row 91 contract).
  const text = `${result.stdout}\n${result.stderr}`
  const token = resultToken(result) ?? START_REFUSAL_CODES.find((c) => new RegExp(`\\b${c}\\b`).test(text))
  if (token === START_BUSY_RESULT) return { ok: false, reason: "SETUP_BUSY", detail: `swarm-setup start ${id}: ${token}` }
  const code = START_REFUSAL_CODES.find((c) => c === token)
  if (code) return { ok: false, reason: code, detail: `swarm-setup start ${id}: ${code}` }
  const first = scrubDetail(result.stderr || result.stdout, secrets) || "no output"
  return { ok: false, reason: "REVIVE_EXIT", detail: `exit ${result.exitCode}: ${first}` }
}
