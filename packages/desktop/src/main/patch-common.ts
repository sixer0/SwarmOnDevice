import { execFile as nodeExecFile } from "node:child_process"
import { existsSync as nodeExistsSync, realpathSync as nodeRealpathSync } from "node:fs"
import { join } from "node:path"
import { PATCH_EXIT_NAMES, PATCH_S11_MAX_CHARS } from "./patch-codes"

// Shared by "Update from File…" (patch-update-flow.ts, row 56) and "Undo Last Update" (patch-undo.ts, row 59).
// Row 60 merged the copies both rows defined; the values and the parse rule are unchanged.

// Register 14.2 (R51-4a, R51-4b, R51-5). `_S` means seconds; execFile takes milliseconds, so callers pass x 1000 (C20).
export const PATCH_VERIFY_TIMEOUT_S = 600
export const PATCH_STATUS_TIMEOUT_S = 30
export const PATCH_OUTPUT_MAX_BYTES = 16384
// Register section 6: the applier's state folder, outside userData.
export const PATCH_STATE_ID = "id.co.gsp.swarm.patch"
// Register section 2.
export const PATCH_SEMVER = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/
// S11 error line printed by the applier on stderr (SP-UPD U4), shown cut to PATCH_S11_MAX_CHARS.
export const PATCH_S11_LINE = /^swarm-patch: E_[A-Z]+: [ -~]*$/
// Defined in patch-codes.ts (which imports nothing, so no import cycle); re-exported for the menu flows.
export { PATCH_EXIT_NAMES, PATCH_S11_MAX_CHARS }

const JOURNAL_PHASES = new Set([
  "none",
  "idle",
  "staged",
  "old_moved",
  "new_placed",
  "rollback_staged",
  "rollback_moved",
  "rollback_placed",
  "invalid",
])

export type PatchStatus = {
  release: string
  bundleVersion: string
  previousRelease: string
  dataMinRelease: string
  journalPhase: string
  rollbackBlocked: boolean
}

// Seam for row 57 (spec 5.1 H1-H4): spawn the detached wrapper with `applierArgv` as BN-61, wait for the child's
// `spawn` event, unref it and start the quit path. Resolves `{ ok: false, code }` when the spawn fails; then the app
// does not quit and the caller shows BN-51 + BN-52 `spawn: <code>`.
export type PatchHandoff = (applierArgv: readonly string[]) => Promise<{ ok: true } | { ok: false; code: string }>

// M8 single-run guard (D51-4). index.ts passes ONE guard to both flows, so while either runs a click on either is
// ignored. The guard is a required dependency of both flows (no module default), so every caller gets the same M8
// behaviour.
export type PatchFlowGuard = { tryEnter: () => boolean; leave: () => void }

export function createPatchFlowGuard(): PatchFlowGuard {
  let busy = false
  return {
    tryEnter: () => {
      if (busy) return false
      busy = true
      return true
    },
    leave: () => {
      busy = false
    },
  }
}

// C27 D-1: the one guard policy for both menu flows. A click while either flow runs is "busy" and does nothing. After
// a started handoff the guard stays held, because the launcher is quitting the app and a second wrapper must not
// start. Every other outcome (refusal, cancel, failed handoff, thrown error) releases it.
export function guardPatchFlow<T extends string>(
  guard: PatchFlowGuard,
  handedOff: T,
  body: () => Promise<T>,
): () => Promise<T | "busy"> {
  return async () => {
    if (!guard.tryEnter()) return "busy"
    let keep = false
    try {
      const outcome = await body()
      keep = outcome === handedOff
      return outcome
    } finally {
      if (!keep) guard.leave()
    }
  }
}

export function patchApplierPath(resourcesPath: string) {
  return join(resourcesPath, "swarm-patch", "swarm-patch")
}

export function patchStateDir(home: string) {
  return join(home, "Library", "Application Support", PATCH_STATE_ID)
}

// True when `path` is `root` or below it. Case-insensitive on purpose: the default macOS volume is case-insensitive,
// so this only ever refuses more. Used by both menu flows for the state-folder rule (D52-3) and by U2.
export function patchPathIsUnder(path: string, root: string) {
  const p = path.toLowerCase()
  const r = root.replace(/\/+$/, "").toLowerCase()
  return p === r || p.startsWith(r + "/")
}

// D52-3 / register 14.5-8: the patch menu items are enabled only when the applier is bundled AND this app is not the
// backup copy running from inside the state folder. Synchronous because createMenu (row 60) is synchronous. The menu,
// Update from File… and Undo Last Update all use this one check (C27 L1, N-6).
export function patchMenuEnabled(input: {
  resourcesPath: string
  home: string
  existsSync?: (path: string) => boolean
  realpathSync?: (path: string) => string
}) {
  const exists = input.existsSync ?? nodeExistsSync
  const real = input.realpathSync ?? nodeRealpathSync
  if (!exists(patchApplierPath(input.resourcesPath))) return false
  let resources: string
  try {
    resources = real(input.resourcesPath)
  } catch {
    return false
  }
  const state = patchStateDir(input.home)
  const states = [state]
  try {
    states.push(real(state))
  } catch {
    // The state folder may not exist yet; the literal path is still checked.
  }
  return !states.some((dir) => patchPathIsUnder(resources, dir) || patchPathIsUnder(input.resourcesPath, dir))
}

// Register section 4 / S23: child processes get exactly these three variables, never process.env.
export function patchChildEnv(home: string): Record<string, string> {
  return { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" }
}

// SP-UPD S-1: exit 0 and exactly 5 or 6 lines in this order (one trailing LF allowed); anything else is undefined.
export function parsePatchStatus(stdout: string): PatchStatus | undefined {
  const lines = stdout.endsWith("\n") ? stdout.slice(0, -1).split("\n") : stdout.split("\n")
  if (lines.length !== 5 && lines.length !== 6) return undefined
  const field = (index: number, key: string) => {
    const line = lines[index]
    return line?.startsWith(`${key}=`) ? line.slice(key.length + 1) : undefined
  }
  const optionalSemver = (value: string | undefined): value is string =>
    value !== undefined && (value === "" || PATCH_SEMVER.test(value))
  const release = field(0, "release")
  const bundleVersion = field(1, "bundle_version")
  const previousRelease = field(2, "previous_release")
  const dataMinRelease = field(3, "data_min_release")
  const journalPhase = field(4, "journal_phase")
  if (release === undefined || !PATCH_SEMVER.test(release)) return undefined
  if (bundleVersion === undefined || !/^[ -~]*$/.test(bundleVersion)) return undefined
  if (!optionalSemver(previousRelease) || !optionalSemver(dataMinRelease)) return undefined
  if (journalPhase === undefined || !JOURNAL_PHASES.has(journalPhase)) return undefined
  if (lines.length === 6 && lines[5] !== "rollback_blocked=forward_migration") return undefined
  return { release, bundleVersion, previousRelease, dataMinRelease, journalPhase, rollbackBlocked: lines.length === 6 }
}

// ---- child processes (one wrapper for every applier and ssh-keygen call, C27 M3) -------------------------------------

export type PatchRunOptions = {
  env: Record<string, string>
  timeoutMs: number
  maxBuffer: number
  input?: string
}

export type PatchRunResult = {
  // Exit code when the child exited by itself; null when it was killed or never started.
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
  // Set when the result is not a normal exit: timeout, output over maxBuffer, or the child could not be started.
  failure?: "timeout" | "overflow" | "start"
  // With failure "start": the errno name (for example ENOENT) when it is a plain code token.
  startCode?: string
}

export type PatchRunner = (file: string, args: readonly string[], options: PatchRunOptions) => Promise<PatchRunResult>

type ExecFileLike = typeof nodeExecFile

// Default runner over child_process.execFile. Never rejects; stdin is always closed (with `input` when given), so a
// child never waits on it.
export function createExecFileRunner(execFileImpl: ExecFileLike = nodeExecFile): PatchRunner {
  return (file, args, options) =>
    new Promise((done) => {
      try {
        const child = execFileImpl(
          file,
          [...args],
          {
            env: options.env,
            timeout: options.timeoutMs,
            maxBuffer: options.maxBuffer,
            encoding: "utf8",
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            const out = String(stdout ?? "")
            const err = String(stderr ?? "")
            if (!error) return done({ code: 0, signal: null, stdout: out, stderr: err })
            const e = error as NodeJS.ErrnoException & { code?: unknown; killed?: boolean; signal?: string | null }
            if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
              return done({ code: null, signal: e.signal ?? null, stdout: out, stderr: err, failure: "overflow" })
            if (typeof e.code === "number") return done({ code: e.code, signal: null, stdout: out, stderr: err })
            if (e.killed) return done({ code: null, signal: e.signal ?? null, stdout: out, stderr: err, failure: "timeout" })
            if (typeof e.code === "string")
              return done({
                code: null,
                signal: null,
                stdout: out,
                stderr: err,
                failure: "start",
                ...(/^[A-Z0-9_]{1,40}$/.test(e.code) ? { startCode: e.code } : {}),
              })
            // Killed by a signal the runner did not send: no failure word, the signal name is the exit token.
            done({ code: null, signal: e.signal ?? null, stdout: out, stderr: err })
          },
        )
        child.stdin?.on("error", () => {})
        child.stdin?.end(options.input ?? "")
      } catch {
        done({ code: null, signal: null, stdout: "", stderr: "", failure: "start" })
      }
    })
}

// The `<n>` of `exit <n>`: the exit code, or a fixed word when the child did not exit by itself.
export function patchExitWord(result: PatchRunResult) {
  if (result.failure === "timeout") return "timeout"
  if (result.failure === "overflow") return "overflow"
  if (result.failure === "start") return result.startCode ?? "start"
  if (result.code !== null) return String(result.code)
  return result.signal && /^SIG[A-Z0-9]{1,10}$/.test(result.signal) ? result.signal : "unknown"
}

// C27 D-3: the one `{{error}}` token for a failed applier call, for both flows. Code tokens only, never translated.
// Both subcommands: the last S11 line on stderr (cut to PATCH_S11_MAX_CHARS) when there is one.
// `status` (U7, D1): otherwise `swarm-patch: exit <n>`.
// `verify` (U4, UM-06): otherwise `swarm-patch: <E_NAME>` for a known non-zero exit code, else `swarm-patch: exit <n>`.
// Timeout and output overflow are `exit timeout` and `exit overflow` in both, so they can be told apart.
export function patchErrorToken(result: PatchRunResult, subcommand: "verify" | "status") {
  const s11 = result.stderr
    .split("\n")
    .filter((line) => PATCH_S11_LINE.test(line))
    .at(-1)
  if (s11 !== undefined) return s11.slice(0, PATCH_S11_MAX_CHARS)
  const name = result.failure === undefined && result.code !== null && result.code !== 0 ? PATCH_EXIT_NAMES[result.code] : undefined
  if (subcommand === "verify" && name) return "swarm-patch: " + name
  return "swarm-patch: exit " + patchExitWord(result)
}

// S-1 call, shared by Update (U7), Undo (D1) and the result reader. Read-only subcommand.
export async function runPatchStatus(input: { run: PatchRunner; applier: string; home: string }) {
  const result = await input.run("/bin/zsh", ["-f", input.applier, "status"], {
    env: patchChildEnv(input.home),
    timeoutMs: PATCH_STATUS_TIMEOUT_S * 1000,
    maxBuffer: PATCH_OUTPUT_MAX_BYTES,
  })
  const status = result.failure === undefined && result.code === 0 ? parsePatchStatus(result.stdout) : undefined
  return status
    ? { ok: true as const, status }
    : { ok: false as const, error: patchErrorToken(result, "status") }
}
