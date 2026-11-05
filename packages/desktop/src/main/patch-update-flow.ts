import type {
  BrowserWindow,
  MessageBoxOptions,
  MessageBoxReturnValue,
  OpenDialogOptions,
  OpenDialogReturnValue,
} from "electron"
import { constants as fsConstants } from "node:fs"
import { access as nodeAccess, lstat as nodeLstat, readFile as nodeReadFile, realpath as nodeRealpath } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import {
  createExecFileRunner,
  guardPatchFlow,
  patchApplierPath,
  patchChildEnv,
  patchErrorToken,
  patchExitWord,
  patchMenuEnabled,
  patchPathIsUnder,
  patchStateDir,
  runPatchStatus,
  PATCH_EXIT_NAMES,
  PATCH_OUTPUT_MAX_BYTES,
  PATCH_SEMVER,
  PATCH_STATUS_TIMEOUT_S,
  PATCH_VERIFY_TIMEOUT_S,
  type PatchFlowGuard,
  type PatchHandoff,
  type PatchRunner,
} from "./patch-common"

// "Update from File…" (SP-UPD section 4, U1-U11; register 13 and 14). The app only ever runs the bundled applier's
// read-only subcommands `verify` and `status` as child processes. Installing is handed to the detached handoff wrapper
// (row 57) after the user confirms; this module never starts it with any other subcommand itself.
// Constants, PatchStatus, the S-1 parser and call, the guard and its policy, the child-process runner, the error token
// and the handoff type live in patch-common.ts (rows 60, 65a).

// Register section 1 (anchor file); the manifest.sig limit (section 5) bounds the anchor read.
const ANCHOR_MAX_BYTES = 4096

export function patchPaths(input: { resourcesPath: string; home: string }) {
  return {
    applier: patchApplierPath(input.resourcesPath),
    signers: join(input.resourcesPath, "swarm-patch", "allowed_signers"),
    // `<res>/../..` = `<X>.app`, the same bundle the applier derives with `${0:A:h:h:h:h}` (register 4, B2).
    targetUnresolved: resolve(input.resourcesPath, "..", ".."),
    state: patchStateDir(input.home),
  }
}

function stdoutLines(stdout: string) {
  const lines = stdout.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
}

export type PatchVerifyResult = {
  release: string
  fromRelease: string
  migration: "none" | "forward"
  newKey: boolean
}

// SP-UPD U5: exactly one line each of result, release, from_release, migration, new_key; other lines are ignored.
export function parseVerifyOutput(stdout: string): PatchVerifyResult | undefined {
  const keys = ["result", "release", "from_release", "migration", "new_key"] as const
  const seen = new Map<string, string[]>()
  for (const line of stdoutLines(stdout)) {
    const eq = line.indexOf("=")
    if (eq <= 0) continue
    const key = line.slice(0, eq)
    if (!(keys as readonly string[]).includes(key)) continue
    seen.set(key, [...(seen.get(key) ?? []), line.slice(eq + 1)])
  }
  const one = (key: string) => {
    const values = seen.get(key)
    return values && values.length === 1 ? values[0] : undefined
  }
  const result = one("result")
  const release = one("release")
  const fromRelease = one("from_release")
  const migration = one("migration")
  const newKey = one("new_key")
  if (result !== "verified") return undefined
  if (release === undefined || !PATCH_SEMVER.test(release)) return undefined
  if (fromRelease === undefined || !PATCH_SEMVER.test(fromRelease)) return undefined
  if (migration !== "none" && migration !== "forward") return undefined
  if (newKey !== "yes" && newKey !== "no") return undefined
  return { release, fromRelease, migration, newKey: newKey === "yes" }
}

// ---- file system seam -----------------------------------------------------------------------------------------------

export type PatchStats = { isFile(): boolean; isSymbolicLink(): boolean; size: number }

export type PatchFs = {
  lstat: (path: string) => Promise<PatchStats>
  realpath: (path: string) => Promise<string>
  readFile: (path: string) => Promise<string>
  // Rejects when `path` is not writable.
  accessWritable: (path: string) => Promise<void>
}

export const nodePatchFs: PatchFs = {
  lstat: (path) => nodeLstat(path),
  realpath: (path) => nodeRealpath(path),
  readFile: (path) => nodeReadFile(path, "utf8"),
  accessWritable: (path) => nodeAccess(path, fsConstants.W_OK),
}

// SP-UPD U8 with UM-25 / TB-24: the anchor must hold exactly one non-empty, non-comment line; type and key are taken
// with the same expression the applier uses in `sp_fingerprints`, then fingerprinted by ssh-keygen from stdin.
const ANCHOR_KEY =
  /(^| )((ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,2})( |$)/
const FINGERPRINT = /(SHA256:[A-Za-z0-9+/]{43})/

export async function anchorFingerprint(input: { fs: PatchFs; run: PatchRunner; signers: string; home: string }) {
  // Not readable, not a regular file, too large, or not exactly one key line: the applier's own name for a missing or
  // empty anchor (register section 7, code 11).
  const anchorError = { ok: false as const, error: "swarm-patch: " + PATCH_EXIT_NAMES[11] }
  const text = await input.fs
    .lstat(input.signers)
    .then((stats) => (stats.isFile() && stats.size <= ANCHOR_MAX_BYTES ? input.fs.readFile(input.signers) : undefined))
    .catch(() => undefined)
  if (text === undefined) return anchorError
  const lines = text.split("\n").filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"))
  if (lines.length !== 1) return anchorError
  const key = ANCHOR_KEY.exec(lines[0]!)?.[2]
  if (!key) return anchorError
  const result = await input.run("/usr/bin/ssh-keygen", ["-lf", "-"], {
    env: patchChildEnv(input.home),
    timeoutMs: PATCH_STATUS_TIMEOUT_S * 1000,
    maxBuffer: PATCH_OUTPUT_MAX_BYTES,
    input: key + "\n",
  })
  const fingerprint = result.failure === undefined && result.code === 0 ? FINGERPRINT.exec(result.stdout)?.[1] : undefined
  if (fingerprint) return { ok: true as const, fingerprint }
  return { ok: false as const, error: "ssh-keygen: exit " + patchExitWord(result) }
}

// ---- U2 -------------------------------------------------------------------------------------------------------------

// SP-UPD U2, extended by UM-24 / TB-18. Returns the bundle target on success. Any refusal is `swarm-patch: E_USAGE`
// and no child process is started.
export async function checkPatchPath(input: {
  fs: PatchFs
  path: string
  resourcesPath: string
  home: string
}): Promise<{ ok: true; target: string } | { ok: false; reason: string }> {
  const p = input.path
  if (!isAbsolute(p)) return { ok: false, reason: "relative" }
  if (/[\x00-\x1f\x7f]/.test(p)) return { ok: false, reason: "control_byte" }
  if (!p.endsWith(".swarmpatch")) return { ok: false, reason: "extension" }
  const stats = await input.fs.lstat(p).catch(() => undefined)
  if (!stats || stats.isSymbolicLink() || !stats.isFile()) return { ok: false, reason: "not_regular_file" }
  const realP = await input.fs.realpath(p).catch(() => undefined)
  if (!realP) return { ok: false, reason: "realpath" }

  const paths = patchPaths(input)
  const target = await input.fs.realpath(paths.targetUnresolved).catch(() => undefined)
  if (!target) return { ok: false, reason: "target_unresolved" }
  // The handoff wrapper accepts only an absolute `.app` target (SP-UPD W2); refuse here so the app does not quit for a
  // failure that is already certain.
  if (!target.endsWith(".app")) return { ok: false, reason: "target_not_app" }
  if (patchPathIsUnder(target, "/Volumes") || target.includes("/AppTranslocation/")) return { ok: false, reason: "target_readonly" }
  const parentWritable = await input.fs
    .accessWritable(dirname(target))
    .then(() => true)
    .catch(() => false)
  if (!parentWritable) return { ok: false, reason: "target_parent_not_writable" }

  const roots = [target, paths.targetUnresolved, paths.state]
  const realState = await input.fs.realpath(paths.state).catch(() => undefined)
  if (realState) roots.push(realState)
  // D51-7: the wrapper argv must not carry a path below the pattern roots (SP-UPD 5.4).
  if (roots.some((root) => patchPathIsUnder(p, root) || patchPathIsUnder(realP, root))) return { ok: false, reason: "inside_target_or_state" }
  return { ok: true, target }
}

// ---- the flow -------------------------------------------------------------------------------------------------------

export type PatchUpdateKey =
  | "desktop.menu.updateFromFile"
  | "desktop.patch.picker.title"
  | "desktop.patch.picker.filter"
  | "desktop.patch.cancel"
  | "desktop.patch.invalid.message"
  | "desktop.patch.invalid.detail"
  | "desktop.patch.newKey.message"
  | "desktop.patch.newKey.detail"
  | "desktop.patch.confirm.message"
  | "desktop.patch.confirm.detail"
  | "desktop.patch.confirm.migration"
  | "desktop.patch.confirm.update"
  | "desktop.patch.result.failed.message"
  | "desktop.patch.result.failed.detail"

export type PatchLog = (level: "info" | "warn" | "error", event: string, extra?: Record<string, unknown>) => void

export type PatchUpdateOutcome =
  | "busy"
  | "disabled"
  | "cancelled"
  | "rejected"
  | "new_key"
  | "declined"
  | "handoff"
  | "handoff_failed"
  | "failed"

export type PatchUpdateFlowDeps = {
  window: () => BrowserWindow | null
  showOpenDialog: (win: BrowserWindow | null, options: OpenDialogOptions) => Promise<OpenDialogReturnValue>
  showMessageBox: (win: BrowserWindow | null, options: MessageBoxOptions) => Promise<MessageBoxReturnValue>
  t: (key: PatchUpdateKey, params?: Record<string, string | number>) => string
  resourcesPath: string
  home: string
  // Spawns the wrapper and starts the quit path itself (row 57 launcher); the flow has no exit step of its own (H4).
  handoff: PatchHandoff
  // Persistent log (row 60 wires logging.ts `write`). Never receives the chosen path or the user's home.
  log: PatchLog
  run?: PatchRunner
  fs?: PatchFs
  // M8: required, so both flows share the one guard index.ts creates (C27 L3).
  guard: PatchFlowGuard
  enabled?: () => boolean
}

export function createPatchUpdateFlow(deps: PatchUpdateFlowDeps) {
  const run = deps.run ?? createExecFileRunner()
  const fs = deps.fs ?? nodePatchFs
  const enabled = deps.enabled ?? (() => patchMenuEnabled({ resourcesPath: deps.resourcesPath, home: deps.home }))
  const paths = patchPaths(deps)
  const title = () => deps.t("desktop.menu.updateFromFile")

  // A dialog that fails to show counts as Cancel (cli-install.ts pattern).
  const ask = (options: MessageBoxOptions) =>
    deps
      .showMessageBox(deps.window(), options)
      .then((answer) => answer.response)
      .catch((error: unknown) => {
        deps.log("warn", "patch update: dialog failed", { error: errorName(error) })
        return undefined
      })

  // U-E.
  const invalid = (error: string) =>
    ask({
      type: "error",
      title: title(),
      message: deps.t("desktop.patch.invalid.message"),
      detail: deps.t("desktop.patch.invalid.detail", { error }),
      buttons: [deps.t("desktop.patch.cancel")],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })

  const failed = (error: string) =>
    ask({
      type: "error",
      title: title(),
      message: deps.t("desktop.patch.result.failed.message"),
      detail: deps.t("desktop.patch.result.failed.detail", { error }),
      buttons: [deps.t("desktop.patch.cancel")],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })

  const confirm = (options: Pick<MessageBoxOptions, "type" | "message" | "detail">) =>
    ask({
      ...options,
      title: title(),
      buttons: [deps.t("desktop.patch.confirm.update"), deps.t("desktop.patch.cancel")],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })

  async function flow(): Promise<PatchUpdateOutcome> {
    // U1.
    const picked = await deps
      .showOpenDialog(deps.window(), {
        title: deps.t("desktop.patch.picker.title"),
        message: deps.t("desktop.patch.picker.title"),
        properties: ["openFile"],
        filters: [{ name: deps.t("desktop.patch.picker.filter"), extensions: ["swarmpatch"] }],
      })
      .catch((error: unknown) => {
        deps.log("warn", "patch update: file picker failed", { error: errorName(error) })
        return undefined
      })
    const file = picked && !picked.canceled ? picked.filePaths[0] : undefined
    if (typeof file !== "string" || file === "") return "cancelled"

    // U2.
    const checked = await checkPatchPath({ fs, path: file, resourcesPath: deps.resourcesPath, home: deps.home })
    if (!checked.ok) {
      deps.log("warn", "patch update: file refused", { reason: checked.reason })
      await invalid("swarm-patch: " + PATCH_EXIT_NAMES[2])
      return "rejected"
    }

    // U3-U5. Read-only subcommand.
    const verified = await run("/bin/zsh", ["-f", paths.applier, "verify", file], {
      env: patchChildEnv(deps.home),
      timeoutMs: PATCH_VERIFY_TIMEOUT_S * 1000,
      maxBuffer: PATCH_OUTPUT_MAX_BYTES,
    })
    if (verified.failure !== undefined || verified.code !== 0) {
      const error = patchErrorToken(verified, "verify")
      deps.log("warn", "patch update: verify refused", { error, failure: verified.failure, code: verified.code })
      await invalid(error)
      return "rejected"
    }
    const patch = parseVerifyOutput(verified.stdout)
    if (!patch) {
      deps.log("error", "patch update: verify output not understood", { stdoutBytes: verified.stdout.length })
      await invalid("swarm-patch: exit 0")
      return "rejected"
    }

    // U6 (HB6): a new signing key is never accepted from the menu.
    if (patch.newKey) {
      deps.log("warn", "patch update: new signing key refused in menu", { release: patch.release })
      await ask({
        type: "warning",
        title: title(),
        message: deps.t("desktop.patch.newKey.message"),
        detail: deps.t("desktop.patch.newKey.detail"),
        buttons: [deps.t("desktop.patch.cancel")],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      return "new_key"
    }

    // U7 (HB7). Read-only subcommand.
    const status = await runPatchStatus({ run, applier: paths.applier, home: deps.home })
    if (!status.ok || status.status.release !== patch.fromRelease) {
      const error = status.ok ? "swarm-patch: exit 0" : status.error
      deps.log("warn", "patch update: status check failed", { error, fromRelease: patch.fromRelease })
      await invalid(error)
      return "rejected"
    }

    // U8 (B-F4, TA-1).
    const anchor = await anchorFingerprint({ fs, run, signers: paths.signers, home: deps.home })
    if (!anchor.ok) {
      deps.log("warn", "patch update: fingerprint failed", { error: anchor.error })
      await invalid(anchor.error)
      return "rejected"
    }

    // U9.
    const first = await confirm({
      type: "question",
      message: deps.t("desktop.patch.confirm.message", { release: patch.release }),
      detail: deps.t("desktop.patch.confirm.detail", {
        installed: status.status.release,
        release: patch.release,
        fingerprint: anchor.fingerprint,
      }),
    })
    if (first !== 0) return "declined"

    // U10 (D51-1): forward migration needs a second, separate warning.
    if (patch.migration === "forward") {
      const second = await confirm({ type: "warning", message: deps.t("desktop.patch.confirm.migration") })
      if (second !== 0) return "declined"
    }

    // U11. BN-61 argv for the wrapper; the menu never adds a key-acceptance option (HB6).
    const applierArgv =
      patch.migration === "forward"
        ? ["/bin/zsh", "-f", paths.applier, "apply", "--accept-forward-migration", file]
        : ["/bin/zsh", "-f", paths.applier, "apply", file]
    const started = await deps.handoff(applierArgv).catch((error: unknown) => ({
      ok: false as const,
      code: errorName(error),
    }))
    if (!started.ok) {
      deps.log("error", "patch update: handoff spawn failed", { code: started.code })
      await failed("spawn: " + started.code)
      return "handoff_failed"
    }
    deps.log("info", "patch update: handoff started", {
      installed: status.status.release,
      release: patch.release,
      migration: patch.migration,
    })
    return "handoff"
  }

  // C27 D-1: guard policy from patch-common.ts; kept after "handoff", released on every other outcome.
  return guardPatchFlow<PatchUpdateOutcome>(deps.guard, "handoff", async () => {
    try {
      if (!enabled()) return "disabled"
      return await flow()
    } catch (error) {
      deps.log("error", "patch update: unexpected failure", {
        error: errorName(error),
        stack: error instanceof Error ? error.stack : undefined,
      })
      await failed("update: " + errorName(error))
      return "failed"
    }
  })
}

function errorName(error: unknown) {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code
  if (error instanceof Error) return error.name
  return "unknown"
}
