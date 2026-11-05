import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import { realpathSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { HANDOFF_RESULT_FILE_NAME } from "./patch-codes"
import { patchApplierPath, patchChildEnv } from "./patch-common"

// Update handoff HO (register 13.4, 14.3, 14.5, 14.8; spec 04 section 5). The app cannot run the applier itself: the
// applier excludes its own ancestors from its running-process check, so a child of Swarm's main process would pass that
// check while Swarm is still alive (B-F2). Instead the app spawns this detached zsh wrapper and quits. The wrapper waits
// until the main PID is gone, runs `apply` or `rollback` (retrying on exit 20 = E_RUNNING), writes the result file the
// next start reads (row 58), and opens the app at the target again.
//
// Every value reaches the wrapper as argv (BN-60). HANDOFF_SCRIPT is a fixed text: no interpolation, no eval, no source.
// The relaunch tool, the main PID and every path are injectable so tests never run /usr/bin/open (HO-00).

export const HANDOFF_MAIN_EXIT_WAIT_S = 60 // BN-62 (provisional until row 62 measures it, 14.5-12)
export const HANDOFF_POLL_S = 0.5 // BN-62
export const HANDOFF_MAX_ATTEMPTS = 10 // BN-63
export const HANDOFF_RETRY_DELAY_S = 2 // BN-63
// BN-65 lives in patch-codes.ts (review row 31 M5); re-exported for the row 62 e2e test.
export { HANDOFF_RESULT_MAX_BYTES } from "./patch-codes"
export const HANDOFF_OUTPUT_MAX_BYTES = 12000 // R51-6, the literal 12000 in HANDOFF_SCRIPT below

// Wrapper text (spec 04 W1-W8, reference 5.3). Steps:
//  W1 fixed environment (BN-68: PATH, LC_ALL=C, umask 077, signals ignored; zsh/system for sysopen, C21 #6).
//  W2 argv validation; exit 2 without applier, result file or relaunch. Includes HOME absolute (the busy check reads
//     it under no_unset) and D52-7 as ruled by C21 #7: realpath of the applier equals realpath of
//     <target>/Contents/Resources/swarm-patch/swarm-patch. The applier argv must be exactly one BN-61 shape
//     (row 32 N-3): `rollback` with nothing after it, or `apply [--accept-forward-migration] <abs>.swarmpatch`.
//  W3 wait while `kill -0 <main_pid>` succeeds, at most wait_s / poll_s polls, then main_alive (applier never runs).
//  W4 attempts 1..max: busy() is the 13.5 check (BN-70..BN-73 under the target and the backup), fail closed when
//     pgrep exits >= 2; otherwise run the applier, stop unless it exited 20.
//  W5 the applier runs as a grandchild (command-substitution subshell), so the main PID is never its ancestor.
//  W6 result file: remove <result>.new, create it exclusively without following a link (D52-6, 14.5-9), write the five
//     handoff_* lines and at most 12000 bytes of applier output, then mv over <result>. A planted link or directory at
//     <result> is removed or left alone, never written through. The move uses `mv -h` (row 32 N-1), so a link
//     planted at <result> after the check is replaced, never followed into a directory. Any failure skips to W7
//     without a result file.
//  W7 relaunch exactly once: "<relaunch_tool>" "<target>", or "<relaunch_tool>" -e "<result>" when the target is no
//     longer a directory (D52-1, C21 #5). The backup under <state>/previous is never opened.
//  W8 exit 0.
// No line may start with a number (HO-20): pgrep -lf prints this text as argv, and such a line would read as a PID.
export const HANDOFF_SCRIPT =
  [
    "emulate zsh; setopt no_unset pipe_fail; unsetopt multibyte",
    "export PATH=/usr/bin:/bin:/usr/sbin:/sbin LC_ALL=C; umask 077; trap '' INT TERM HUP",
    "zmodload zsh/system || exit 2",
    "(( $# >= 12 && $# <= 14 )) || exit 2",
    "pid=$1 target=$2 result=$3 relaunch=$4 wait_s=$5 max=$6 delay=$7 poll=$8",
    "num='^[0-9]+(\\.[0-9]+)?$' nl=$'\\n'",
    "[[ $pid =~ '^[1-9][0-9]{0,6}$' && $target == /*.app && $target != *$nl* ]] || exit 2",
    "[[ $result == /* && $result != *$nl* && $relaunch == /* && $relaunch != *$nl* ]] || exit 2",
    "[[ ${HOME:-} == /* && $HOME != *$nl* ]] || exit 2",
    "[[ $wait_s =~ $num && $delay =~ $num && $poll =~ $num && $max =~ '^[1-9][0-9]?$' ]] || exit 2",
    "(( wait_s > 0 && delay > 0 && poll > 0 )) || exit 2",
    "shift 8",
    "[[ $1 == /bin/zsh && $2 == -f && $3 == /* ]] || exit 2",
    "if [[ $4 == rollback ]]; then (( $# == 4 )) || exit 2",
    "elif [[ $4 == apply ]]; then",
    "  if (( $# == 6 )); then [[ $5 == --accept-forward-migration ]] || exit 2; else (( $# == 5 )) || exit 2; fi",
    "  [[ $argv[-1] == /*.swarmpatch && $argv[-1] != *$nl* ]] || exit 2",
    "else exit 2; fi",
    "applier=$3 want=$target/Contents/Resources/swarm-patch/swarm-patch",
    "[[ -f $applier && -f $want && $applier:A == $want:A ]] || exit 2",
    "action=$4 outcome='' attempts=0 rc='' out='' n=0",
    "busy() {",
    "  local list r p line pid2='' cmd=''; local -a pre",
    '  for r in "$target" "$HOME/Library/Application Support/id.co.gsp.swarm.patch/previous/Swarm.app"; do',
    '    pre+=( "$r/Contents/Resources/swarm-cli/" "/bin/sh $r/Contents/Resources/swarm-cli/swarm-launcher" "$r/Contents/Resources/swarm-setup/" "$r/Contents/Resources/rg" )',
    "  done",
    "  list=$(/usr/bin/pgrep -lf '.' 2>/dev/null); (( $? < 2 )) || return 0",
    '  for line in "${(@f)list}"; do',
    "    if [[ $line =~ '^([1-9][0-9]{0,6})( |$)(.*)$' ]]; then pid2=$match[1] cmd=$match[3]; else cmd=$line; fi",
    "    [[ -n $pid2 && $pid2 != $$ ]] || continue",
    '    for p in $pre; do [[ " $cmd" == *" $p"* ]] && return 0; done',
    "  done",
    "  return 1",
    "}",
    "while kill -0 $pid 2>/dev/null; do",
    "  if (( n >= wait_s / poll )); then outcome=main_alive; break; fi",
    "  /bin/sleep $poll; (( n++ ))",
    "done",
    "if [[ -z $outcome ]]; then",
    "  while (( attempts < max )); do",
    "    (( attempts++ ))",
    "    if busy; then outcome=still_running rc='' out=''",
    '    else out=$("$@" 2>&1); rc=$?; outcome=ran; (( rc == 20 )) || break; fi',
    "    (( attempts < max )) && /bin/sleep $delay",
    "  done",
    "fi",
    "new=$result.new",
    '/bin/rm -f -- "$new" 2>/dev/null',
    'if sysopen -w -m 600 -o excl,creat,nofollow -u fd "$new" 2>/dev/null; then',
    "  { print -r -- handoff_format=1; print -r -- handoff_action=$action; print -r -- handoff_outcome=$outcome",
    "    print -r -- handoff_attempts=$attempts; print -r -- handoff_exit=$rc",
    '    [[ -z $out ]] || print -r -- "${out[1,12000]}"; } >&$fd 2>/dev/null; wrote=$?',
    "  exec {fd}>&-",
    "  if (( wrote == 0 )); then",
    '    /bin/rm -f -- "$result" 2>/dev/null',
    '    if [[ ! -e $result && ! -L $result ]]; then /bin/mv -f -h -- "$new" "$result" 2>/dev/null; fi',
    "  fi",
    '  [[ -e $new || -L $new ]] && /bin/rm -f -- "$new" 2>/dev/null',
    "fi",
    'if [[ -d $target ]]; then "$relaunch" "$target"; else "$relaunch" -e "$result"; fi',
    "exit 0",
  ].join("\n") + "\n"

const ZSH = "/bin/zsh"
const WRAPPER_ARGV0 = "swarm-update-handoff" // BN-60 `$0`
const RELAUNCH_TOOL = "/usr/bin/open" // BN-67

export type HandoffRequest =
  | { action: "apply"; packagePath: string; acceptForwardMigration: boolean }
  | { action: "rollback" }

export type HandoffPaths = {
  resourcesPath: string // process.resourcesPath
  userData: string // app.getPath("userData")
  home: string // os.homedir()
}

export type HandoffTiming = { waitS: number; maxAttempts: number; retryDelayS: number; pollS: number }

type SpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

export type HandoffDeps = {
  spawn?: SpawnLike
  mainPid?: number // default process.pid
  relaunchTool?: string // default /usr/bin/open; tests pass a stub (HO-00)
  realpath?: (path: string) => string
  timing?: Partial<HandoffTiming>
  logger?: { log: (message: string, meta?: unknown) => void; error: (message: string, meta?: unknown) => void }
}

export type HandoffSpawn = { command: string; args: string[]; options: SpawnOptions }

// Errors carry a Node-style `code` so the caller can show `spawn: <code>` (spec 04 U11) for both kinds.
export class HandoffError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
}

export function handoffTarget(resourcesPath: string, realpath: (path: string) => string = realpathSync) {
  return realpath(join(resourcesPath, "..", ".."))
}

export function handoffResultFile(userData: string) {
  return join(userData, HANDOFF_RESULT_FILE_NAME)
}

// BN-61: the applier argv exactly as spec 5.1. The menu never sends the new-key acceptance option (HB6).
export function handoffApplierArgv(applier: string, request: HandoffRequest) {
  if (request.action === "rollback") return [ZSH, "-f", applier, "rollback"]
  return [
    ZSH,
    "-f",
    applier,
    "apply",
    ...(request.acceptForwardMigration ? ["--accept-forward-migration"] : []),
    request.packagePath,
  ]
}

function invalid(what: string): never {
  throw new HandoffError("handoff: invalid " + what, "EINVAL")
}

function plainAbsolute(path: string) {
  return isAbsolute(path) && !/[\0\n]/.test(path)
}

// Mirrors the wrapper's W2 checks so a bad value fails here, before the app quits, instead of in the wrapper.
export function handoffSpawnArgs(request: HandoffRequest, paths: HandoffPaths, deps: HandoffDeps = {}): HandoffSpawn {
  const realpath = deps.realpath ?? realpathSync
  const mainPid = deps.mainPid ?? process.pid
  const relaunchTool = deps.relaunchTool ?? RELAUNCH_TOOL
  const timing: HandoffTiming = {
    waitS: HANDOFF_MAIN_EXIT_WAIT_S,
    maxAttempts: HANDOFF_MAX_ATTEMPTS,
    retryDelayS: HANDOFF_RETRY_DELAY_S,
    pollS: HANDOFF_POLL_S,
    ...deps.timing,
  }
  const target = handoffTarget(paths.resourcesPath, realpath)
  const resultFile = handoffResultFile(paths.userData)
  const applier = patchApplierPath(paths.resourcesPath) // the same path the flows build (M5 (d))
  if (!Number.isInteger(mainPid) || mainPid < 1 || mainPid > 9_999_999) invalid("main pid")
  if (!plainAbsolute(target) || !target.endsWith(".app")) invalid("target")
  if (!plainAbsolute(resultFile)) invalid("result file")
  if (!plainAbsolute(relaunchTool)) invalid("relaunch tool")
  if (!plainAbsolute(paths.home)) invalid("home")
  if (!plainAbsolute(applier)) invalid("applier")
  if (request.action === "apply" && (!plainAbsolute(request.packagePath) || !request.packagePath.endsWith(".swarmpatch")))
    invalid("package path")
  for (const value of [timing.waitS, timing.retryDelayS, timing.pollS])
    if (!Number.isFinite(value) || value <= 0 || !/^[0-9]+(\.[0-9]+)?$/.test(String(value))) invalid("timing")
  if (!Number.isInteger(timing.maxAttempts) || timing.maxAttempts < 1 || timing.maxAttempts > 99) invalid("attempts")
  return {
    command: ZSH,
    args: [
      "-f",
      "-c",
      HANDOFF_SCRIPT,
      WRAPPER_ARGV0,
      String(mainPid),
      target,
      resultFile,
      relaunchTool,
      String(timing.waitS),
      String(timing.maxAttempts),
      String(timing.retryDelayS),
      String(timing.pollS),
      ...handoffApplierArgv(applier, request),
    ],
    options: {
      detached: true,
      stdio: "ignore",
      env: patchChildEnv(paths.home), // register section 4 / S23
    },
  }
}

// H2-H3: spawn the wrapper detached, wait for its `spawn` event, then unref it. Resolves once the wrapper runs; the
// caller then quits through the relaunch path without app.relaunch() (H4). Rejects with a `code` (spawn error or
// EINVAL) and the app must not quit. Failures are written to the injected logger (electron-log file transport).
export function startHandoff(request: HandoffRequest, paths: HandoffPaths, deps: HandoffDeps = {}) {
  return new Promise<void>((resolve, reject) => {
    const fail = (error: unknown) => {
      const code =
        error instanceof HandoffError
          ? error.code
          : typeof (error as NodeJS.ErrnoException)?.code === "string"
            ? (error as NodeJS.ErrnoException).code!
            : "EUNKNOWN"
      deps.logger?.error("swarm-patch handoff failed", {
        action: request.action,
        code,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      })
      reject(error instanceof HandoffError ? error : new HandoffError("spawn: " + code, code))
    }
    let child: ChildProcess
    try {
      const { command, args, options } = handoffSpawnArgs(request, paths, deps)
      child = (deps.spawn ?? nodeSpawn)(command, args, options)
    } catch (error) {
      fail(error)
      return
    }
    let settled = false
    child.once("spawn", () => {
      if (settled) return
      settled = true
      child.unref()
      deps.logger?.log("swarm-patch handoff started", { action: request.action, pid: child.pid })
      resolve()
    })
    child.once("error", (error) => {
      if (settled) return
      settled = true
      fail(error)
    })
  })
}

export function startApplyHandoff(
  input: { packagePath: string; acceptForwardMigration: boolean },
  paths: HandoffPaths,
  deps: HandoffDeps = {},
) {
  return startHandoff({ action: "apply", ...input }, paths, deps)
}

export function startRollbackHandoff(paths: HandoffPaths, deps: HandoffDeps = {}) {
  return startHandoff({ action: "rollback" }, paths, deps)
}

export type HandoffLaunchResult = { ok: true } | { ok: false; code: string }
export type HandoffLauncher = (applierArgv: string[]) => Promise<HandoffLaunchResult>

// Seam for rows 56 and 59 (controller message, row 57): H1-H4 behind one call that takes the BN-61 applier argv.
// Shows no dialog; on { ok: false } the caller shows BN-51 with BN-52 `spawn: <code>` and the app keeps running.
// On { ok: true } `quit` (H4: setAppQuitting(); stopSidecars().finally(() => app.quit()), never app.relaunch()) has
// already been called. The argv must be exactly [/bin/zsh, -f, <res>/swarm-patch/swarm-patch, apply,
// [--accept-forward-migration], <file>.swarmpatch] or [..., rollback]; anything else is { ok: false, code: "EINVAL" }.
export function createHandoffLauncher(
  paths: HandoffPaths,
  deps: HandoffDeps & { quit: () => void },
): HandoffLauncher {
  return async (applierArgv) => {
    const request = handoffRequestFromArgv(applierArgv, patchApplierPath(paths.resourcesPath))
    if (!request) {
      deps.logger?.error("swarm-patch handoff refused applier argv", { argc: applierArgv.length })
      return { ok: false, code: "EINVAL" }
    }
    try {
      await startHandoff(request, paths, deps)
    } catch (error) {
      return { ok: false, code: error instanceof HandoffError ? error.code : "EUNKNOWN" }
    }
    deps.quit()
    return { ok: true }
  }
}

export function handoffRequestFromArgv(argv: readonly string[], applier: string): HandoffRequest | undefined {
  if (argv[0] !== ZSH || argv[1] !== "-f" || argv[2] !== applier) return undefined
  if (argv.length === 4 && argv[3] === "rollback") return { action: "rollback" }
  if (argv[3] !== "apply") return undefined
  if (argv.length === 5) return { action: "apply", packagePath: argv[4]!, acceptForwardMigration: false }
  if (argv.length === 6 && argv[4] === "--accept-forward-migration")
    return { action: "apply", packagePath: argv[5]!, acceptForwardMigration: true }
  return undefined
}
