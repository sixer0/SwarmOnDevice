import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from "electron"
import { constants } from "node:fs"
import * as nodeFs from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { HANDOFF_RESULT_MAX_BYTES, PATCH_EXIT_NAMES, PATCH_S11_NAMED } from "./patch-codes"
import { PATCH_SEMVER, PATCH_STATE_ID } from "./patch-common"

// Result after relaunch (SP-UPD-R, row 58). The handoff wrapper (row 57) writes <userData>/swarm-patch-result
// (BN-64) and opens the app again; this module runs once at start, after the first window is shown (row 60 wires it).
// The file is UNTRUSTED input: anyone with the user's rights can write it. So:
// - it is opened O_NOFOLLOW | O_NONBLOCK (a symlink is never followed, a FIFO never blocks start), checked with fstat on
//   the fd (regular file, own uid, size), and at most HANDOFF_RESULT_MAX_BYTES + 1 bytes are read (UM-23, TB-15);
// - it is removed BEFORE any validation (R2, D51-5), so a broken file never shows twice; a path that cannot be removed
//   is logged and shows no dialog (TB-15), so it cannot make a dialog appear on every start;
// - for handoff_exit=31 no text from the file is shown, only the recover command this app computes from its own
//   location (D52-2, TB-14); for other codes the S11 line is shown only when its E_* name is the name of handoff_exit
//   (register section 7);
// - a success dialog is shown only when the release in the file equals the release `status` reports for this bundle
//   (R7, HB7).
// All shown text goes through the injected nativeT (BN-30..BN-54); the only untranslated text is the applier's S11
// line and the computed command, as in cli-install.ts.

// BN-64, BN-65 and the exit-name table live in patch-codes.ts (review row 31 M5); re-exported for index.ts and tests.
export { HANDOFF_RESULT_FILE_NAME, HANDOFF_RESULT_MAX_BYTES } from "./patch-codes"

const S11 = PATCH_S11_NAMED // R5
const S12 = /^(result|release|from_release|migration|new_key|outcome|recover_command)=(.*)$/ // R5
const S12_RESULT = /^(verified|applied|rolled_back|recovered)$/ // S12
// R4 with 14.5-7 (handoff_attempts 0..10).
const HEADER = [
  /^handoff_format=1$/,
  /^handoff_action=(apply|rollback)$/,
  /^handoff_outcome=(ran|main_alive|still_running)$/,
  /^handoff_attempts=(0|[1-9]|10)$/,
  /^handoff_exit=([0-9]{1,3})?$/,
] as const

const UPDATE_TITLE = "desktop.menu.updateFromFile" as const

export type PatchResultKey =
  | "desktop.menu.updateFromFile"
  | "desktop.menu.undoLastUpdate"
  | "desktop.patch.cancel"
  | "desktop.patch.result.updated.message"
  | "desktop.patch.result.undone.message"
  | "desktop.patch.result.failed.message"
  | "desktop.patch.result.failed.detail"
  | "desktop.patch.result.running.detail"
  | "desktop.patch.result.recover.detail"

export type PatchResultFile = {
  action: "apply" | "rollback"
  outcome: "ran" | "main_alive" | "still_running"
  attempts: number
  exit: number | undefined
  result: string | undefined
  release: string | undefined
  // Last S11 line and its E_* name. Never shown unless the name is the name of `exit` (D52-2).
  error: { name: string; line: string } | undefined
}

export type PatchResultDialog = {
  type: "info" | "warning" | "error"
  title: PatchResultKey
  message: { key: PatchResultKey; params?: Record<string, string> }
  detail?: { key: PatchResultKey; params?: Record<string, string> }
}

// fatal: invalid UTF-8 throws instead of becoming U+FFFD. ignoreBOM: a leading BOM stays in the text (and fails).
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
// Unicode Cc: C0, DEL and C1. The LF that ends a line is not part of it, so every LF-free line is checked whole.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

// R3 as ruled by C27 D-2 (register 14.9), per line: a line is accepted when its bytes are valid UTF-8, it holds no
// control character, and it fits HANDOFF_RESULT_MAX_BYTES. Otherwise it is undefined here. The applier prints
// HOME-derived and target paths in recover_command (applier AP2), so a non-ASCII path must not reject the file.
function resultLines(bytes: Uint8Array): (string | undefined)[] {
  const lines: (string | undefined)[] = []
  const accept = (line: Uint8Array) => {
    if (line.length > HANDOFF_RESULT_MAX_BYTES) return undefined
    let text: string
    try {
      text = UTF8.decode(line)
    } catch {
      return undefined
    }
    return CONTROL.test(text) ? undefined : text
  }
  let start = 0
  for (let i = 0; i < bytes.length; i++)
    if (bytes[i] === 0x0a) {
      lines.push(accept(bytes.subarray(start, i)))
      start = i + 1
    }
  // One trailing LF ends the last line; text after the last LF is a line of its own.
  if (start < bytes.length) lines.push(accept(bytes.subarray(start)))
  return lines
}

// R3-R5. Returns undefined when the bytes are not a valid result file. The five handoff_* lines must be accepted
// (R3) and match R4; a later line R3 does not accept is dropped like an unknown line (R5), so it is never shown.
export function parsePatchResult(bytes: Uint8Array): PatchResultFile | undefined {
  const lines = resultLines(bytes)
  if (lines.length < HEADER.length) return undefined
  const head = HEADER.map((rule, i) => {
    const line = lines[i]
    return line === undefined ? null : rule.exec(line)
  })
  if (head.some((match) => !match)) return undefined
  const [, action, outcome, attempts, exitMatch] = head as RegExpExecArray[]
  const exitText = exitMatch![1]
  const ran = outcome![1] === "ran"
  // handoff_exit is set exactly when the applier ran (R4); main_alive is the only outcome with 0 attempts (14.5-7).
  if (ran !== (exitText !== undefined)) return undefined
  if ((attempts![1] === "0") !== (outcome![1] === "main_alive")) return undefined

  const seen = new Map<string, string | null>()
  let error: PatchResultFile["error"]
  for (const line of lines.slice(HEADER.length)) {
    if (line === undefined) continue // not accepted by R3: dropped, never shown
    const s11 = S11.exec(line)
    if (s11) {
      error = { name: s11[1]!, line }
      continue
    }
    const s12 = S12.exec(line)
    if (!s12) continue // any other line is ignored and never shown (R5)
    const key = s12[1]!
    // A key given twice is ambiguous, so it counts as absent.
    seen.set(key, seen.has(key) ? null : s12[2]!)
  }
  const value = (key: string, rule: RegExp) => {
    const v = seen.get(key)
    return typeof v === "string" && rule.test(v) ? v : undefined
  }
  return {
    action: action![1] as PatchResultFile["action"],
    outcome: outcome![1] as PatchResultFile["outcome"],
    attempts: Number(attempts![1]),
    exit: exitText === undefined ? undefined : Number(exitText),
    result: value("result", S12_RESULT),
    release: value("release", PATCH_SEMVER),
    error,
  }
}

// F-LOG (C35): the result block as one log-safe line. At most HANDOFF_RESULT_MAX_BYTES bytes are decoded (invalid
// UTF-8 becomes U+FFFD, never an exception); a backslash and every Unicode Cc character, LF included, are escaped
// (\\, \n, \uXXXX), so the block cannot add lines or terminal sequences to the log.
export function escapeResultBlock(bytes: Uint8Array) {
  const text = new TextDecoder("utf-8").decode(bytes.subarray(0, HANDOFF_RESULT_MAX_BYTES))
  return text.replace(/[\\\u0000-\u001f\u007f-\u009f]/g, (c) =>
    c === "\\" ? "\\\\" : c === "\n" ? "\\n" : `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )
}

// zsh ${(qq)x}: single quotes, an embedded ' written as '\'' (the applier quotes recover_command this way, :873).
export function zshSingleQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

// D52-2 / R6: the recover command, computed from this app's own location only. `target` = realpath(<res>/../..),
// `state` = <realpath HOME>/Library/Application Support/id.co.gsp.swarm.patch (applier B2, 5.3).
// apply: the backup applier with --target (R6, AP2, C4), the same string the applier prints at AP2.
// rollback: the target's own applier (TB-14 (a); first form of the applier's rollback message, :978).
// Returns undefined when it cannot be computed; the dialog then has no detail.
export function computeRecoverCommand(input: { action: "apply" | "rollback"; target: string; state: string }) {
  const { target, state } = input
  if (!/^\/.*\.app$/.test(target) || /[^ -~]/.test(target)) return undefined
  if (!state.startsWith("/") || /[^ -~]/.test(state)) return undefined
  if (target === state || target.startsWith(`${state}/`)) return undefined // running from the backup or staging
  if (input.action === "rollback")
    return `/bin/zsh -f ${zshSingleQuote(join(target, "Contents/Resources/swarm-patch/swarm-patch"))} recover`
  const backup = join(state, "previous/Swarm.app/Contents/Resources/swarm-patch/swarm-patch")
  return `/bin/zsh -f ${zshSingleQuote(backup)} recover --target ${zshSingleQuote(target)}`
}

// Mapping table of SP-UPD 6 with D52-2; the first row that matches wins. `installedRelease` is the release from
// `status` (R7), undefined when status failed; it is only asked for when a success dialog is possible.
export function patchResultDialog(
  file: PatchResultFile | undefined,
  input: { installedRelease?: string; recoverCommand?: string },
): PatchResultDialog {
  const failed = { key: "desktop.patch.result.failed.message" } as const
  if (!file) return { type: "error", title: UPDATE_TITLE, message: failed }
  const title = file.action === "rollback" ? "desktop.menu.undoLastUpdate" : "desktop.menu.updateFromFile"
  const running = { key: "desktop.patch.result.running.detail" } as const
  if (file.outcome !== "ran" || file.exit === 20) return { type: "warning", title, message: failed, detail: running }
  if (file.exit === 0 && file.release && file.release === input.installedRelease) {
    if (file.action === "apply" && file.result === "applied")
      return {
        type: "info",
        title,
        message: { key: "desktop.patch.result.updated.message", params: { release: file.release } },
      }
    if (file.action === "rollback" && file.result === "rolled_back")
      return {
        type: "info",
        title,
        message: { key: "desktop.patch.result.undone.message", params: { release: file.release } },
      }
  }
  if (file.exit === 31) {
    // Never text from the file here (D52-2): only the command computed by this app.
    if (!input.recoverCommand) return { type: "error", title, message: failed }
    return {
      type: "error",
      title,
      message: failed,
      detail: { key: "desktop.patch.result.recover.detail", params: { command: input.recoverCommand } },
    }
  }
  if (file.exit !== undefined && file.exit !== 0 && file.error && file.error.name === PATCH_EXIT_NAMES[file.exit])
    return {
      type: "error",
      title,
      message: failed,
      detail: { key: "desktop.patch.result.failed.detail", params: { error: file.error.line } },
    }
  return { type: "error", title, message: failed }
}

export type PatchResultFs = Pick<typeof nodeFs, "open" | "unlink" | "rmdir" | "realpath">

export type PatchResultOutcome =
  | { shown: false; reason: "absent" | "not-removed" }
  | { shown: true; dialog: PatchResultDialog; reason: string }

// Read and remove the result file. "absent": nothing to show. "not-removed": the path could not be removed, so no
// dialog (TB-15). Otherwise `bytes` is the content, or undefined when the file is not usable (R2: BN-51, no detail).
async function takeResultFile(
  path: string,
  fs: PatchResultFs,
  uid: number,
  log: PatchResultLog,
): Promise<{ state: "absent" | "not-removed" } | { state: "taken"; bytes: Uint8Array | undefined; reason: string }> {
  const remove = async () => {
    const unlinked = await fs.unlink(path).then(
      () => true,
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    )
    if (unlinked) return true
    // A directory cannot be unlinked; an empty one can still go. A non-empty one stays and shows no dialog.
    return fs.rmdir(path).then(
      () => true,
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    )
  }
  const handle = await fs
    .open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch((error: NodeJS.ErrnoException) => error)
  if (handle instanceof Error) {
    if (handle.code === "ENOENT") return { state: "absent" }
    // ELOOP (a symlink, never followed), EACCES and the rest: the path is removed as it is, then BN-51.
    if (!(await remove())) {
      log("result file cannot be opened or removed", { code: handle.code }, "warn")
      return { state: "not-removed" }
    }
    return { state: "taken", bytes: undefined, reason: `open:${handle.code ?? "unknown"}` }
  }
  try {
    // R2: removed before any validation of what was opened.
    if (!(await remove())) {
      log("result file cannot be removed", undefined, "warn")
      return { state: "not-removed" }
    }
    const stat = await handle.stat()
    if (!stat.isFile()) return { state: "taken", bytes: undefined, reason: "not-regular" }
    if (stat.uid !== uid) return { state: "taken", bytes: undefined, reason: "other-owner" }
    if (stat.size > HANDOFF_RESULT_MAX_BYTES) return { state: "taken", bytes: undefined, reason: "too-large" }
    // Read from the fd, at most MAX + 1 bytes, so a file that grows after fstat is still caught.
    const buffer = Buffer.alloc(HANDOFF_RESULT_MAX_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > HANDOFF_RESULT_MAX_BYTES) return { state: "taken", bytes: undefined, reason: "too-large" }
    return { state: "taken", bytes: buffer.subarray(0, length), reason: "read" }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

export type PatchResultLog = (
  message: string,
  extra?: Record<string, unknown>,
  level?: "info" | "warn" | "error",
) => void

export function createPatchResultReader(input: {
  // <userData>/swarm-patch-result (BN-64): row 60 passes join(app.getPath("userData"), HANDOFF_RESULT_FILE_NAME).
  resultFile: string
  // process.resourcesPath of the running bundle.
  resourcesPath: string
  window: () => BrowserWindow | null
  showMessageBox: (win: BrowserWindow | null, options: MessageBoxOptions) => Promise<MessageBoxReturnValue>
  t: (key: PatchResultKey, params?: Record<string, string | number>) => string
  // S-1 `status` of this bundle's own applier: resolves to its `release`, or undefined when status failed (R7).
  // Row 60 wires the S-1 implementation of rows 56/59; only called when a success dialog is possible.
  installedRelease: () => Promise<string | undefined>
  // Persistent log (row 60: logging.ts `write("swarm-patch", ...)`). Given file content only as the escaped block of a
  // file that passed R4 (F-LOG, C35).
  log: PatchResultLog
  fs?: PatchResultFs
  homeDir?: () => string
  getuid?: () => number
}) {
  const fs = input.fs ?? nodeFs
  const homeDir = input.homeDir ?? homedir
  const getuid = input.getuid ?? (() => process.getuid?.() ?? -1)

  const recoverCommand = async (action: "apply" | "rollback") => {
    const home = homeDir()
    if (!home.startsWith("/")) return undefined
    const [target, realHome] = await Promise.all([
      fs.realpath(join(input.resourcesPath, "..", "..")).catch(() => undefined),
      fs.realpath(home).catch(() => undefined),
    ])
    if (!target || !realHome) return undefined
    return computeRecoverCommand({ action, target, state: join(realHome, "Library/Application Support", PATCH_STATE_ID) })
  }

  return async (): Promise<PatchResultOutcome> => {
    const taken = await takeResultFile(input.resultFile, fs, getuid(), input.log).catch((error: unknown) => {
      input.log(
        "result file read failed",
        { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined },
        "error",
      )
      return { state: "taken" as const, bytes: undefined, reason: "read-error" }
    })
    if (taken.state !== "taken") return { shown: false, reason: taken.state }

    const file = taken.bytes ? parsePatchResult(taken.bytes) : undefined
    // F-LOG (C35): a valid block is logged whole (escaped, bounded) so a failure keeps the applier's own S11 line in
    // swarm-patch.log. R2 still holds: the path was removed before validation (takeResultFile); these are the bytes
    // read from the fd of the removed file, so nothing is lost by the removal. A block that fails R4 is not logged.
    if (file && taken.bytes)
      input.log("update result file", { bytes: taken.bytes.length, block: escapeResultBlock(taken.bytes) }, "info")
    const successPossible =
      file?.outcome === "ran" &&
      file.exit === 0 &&
      file.release !== undefined &&
      ((file.action === "apply" && file.result === "applied") ||
        (file.action === "rollback" && file.result === "rolled_back"))
    const installedRelease = successPossible ? await input.installedRelease().catch(() => undefined) : undefined
    const command = file?.outcome === "ran" && file.exit === 31 ? await recoverCommand(file.action) : undefined
    const dialog = patchResultDialog(file, { installedRelease, recoverCommand: command })

    const reason = !taken.bytes ? taken.reason : !file ? "invalid" : `${file.outcome}:${file.exit ?? ""}`
    input.log(
      "update result",
      {
        reason,
        action: file?.action,
        outcome: file?.outcome,
        attempts: file?.attempts,
        exit: file?.exit,
        dialog: dialog.message.key,
        releaseMatches: successPossible ? installedRelease === file?.release : undefined,
      },
      dialog.type === "info" ? "info" : "warn",
    )

    const t = (part: { key: PatchResultKey; params?: Record<string, string> }) => input.t(part.key, part.params)
    await input
      .showMessageBox(input.window(), {
        type: dialog.type,
        title: input.t(dialog.title),
        message: t(dialog.message),
        ...(dialog.detail ? { detail: t(dialog.detail) } : {}),
        buttons: [input.t("desktop.patch.cancel")],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      .catch((error: unknown) =>
        input.log(
          "result dialog failed to show",
          { message: error instanceof Error ? error.message : String(error) },
          "error",
        ),
      )
    return { shown: true, dialog, reason }
  }
}
