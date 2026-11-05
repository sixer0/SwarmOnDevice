import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from "electron"
import { existsSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { nativeT } from "./native-translations"
import {
  createExecFileRunner,
  guardPatchFlow,
  patchApplierPath,
  patchMenuEnabled,
  runPatchStatus,
  type PatchFlowGuard,
  type PatchHandoff,
  type PatchRunner,
} from "./patch-common"

// Undo Last Update (SP-UPD-D, spec 04 section 7; register 13-14). The main process only ever runs the bundled
// applier's read-only `status` here. `rollback` itself runs in the detached handoff wrapper (row 57) after this
// process has exited; this module hands it the applier argv and nothing else.
// The S-1 call, the child-process runner (stdin closed), the error token, the state-folder check, the guard and its
// policy and the handoff type live in patch-common.ts (rows 60, 65a), shared with Update from File….

type UndoDialogKey =
  | "desktop.menu.undoLastUpdate"
  | "desktop.patch.cancel"
  | "desktop.patch.undo.confirm.message"
  | "desktop.patch.undo.confirm.detail"
  | "desktop.patch.undo.confirm.undo"
  | "desktop.patch.undo.none.message"
  | "desktop.patch.undo.blocked.message"
  | "desktop.patch.undo.blocked.detail"
  | "desktop.patch.result.failed.message"
  | "desktop.patch.result.failed.detail"

export type UndoLastUpdateDeps = {
  window: () => BrowserWindow | null
  showMessageBox: (win: BrowserWindow | null, options: MessageBoxOptions) => Promise<MessageBoxReturnValue>
  handoff: PatchHandoff
  resourcesPath: () => string
  t?: (key: UndoDialogKey, params?: Record<string, string | number>) => string
  run?: PatchRunner
  homedir?: () => string
  realpath?: (path: string) => string
  exists?: (path: string) => boolean
  // M8: required, so both flows share the one guard index.ts creates (C27 L3).
  guard: PatchFlowGuard
  // Persistent log (electron-log file transport via index.ts `logger`). Codes and release numbers only, no paths of
  // user files and no applier output beyond the S11 line already shown to the user.
  log?: { info: (message: string, meta?: Record<string, unknown>) => void; error: (message: string, meta?: Record<string, unknown>) => void }
}

export type UndoOutcome =
  | "busy"
  | "disabled"
  | "status_failed"
  | "interrupted"
  | "blocked"
  | "none"
  | "cancelled"
  | "handoff_failed"
  | "handed_off"

export function createUndoLastUpdate(deps: UndoLastUpdateDeps) {
  const t = deps.t ?? nativeT
  const runner = deps.run ?? createExecFileRunner()
  const home = deps.homedir ?? homedir
  const realpath = deps.realpath ?? realpathSync
  const exists = deps.exists ?? existsSync
  const log = deps.log ?? { info: () => {}, error: () => {} }

  const show = (options: Omit<MessageBoxOptions, "title">) =>
    deps
      .showMessageBox(deps.window(), { title: t("desktop.menu.undoLastUpdate"), ...options })
      .catch(() => undefined)

  const notice = (type: "error" | "warning" | "info", message: string, detail?: string) =>
    show({ type, message, ...(detail === undefined ? {} : { detail }), buttons: [t("desktop.patch.cancel")] })

  const run = async (): Promise<UndoOutcome> => {
    const resourcesPath = deps.resourcesPath()
    const userHome = home()
    // D52-3: the menu item's own check (case-insensitive, literal and resolved paths). Disabled means no dialog and
    // no child process.
    if (!patchMenuEnabled({ resourcesPath, home: userHome, realpathSync: realpath, existsSync: exists })) return "disabled"
    const applier = patchApplierPath(resourcesPath)

    // S-1
    const checked = await runPatchStatus({ run: runner, applier, home: userHome })

    // D1
    if (!checked.ok) {
      log.error("patch undo: status failed", { source: "patch-undo.status", error: checked.error })
      await notice(
        "error",
        t("desktop.patch.undo.blocked.message"),
        t("desktop.patch.result.failed.detail", { error: checked.error }),
      )
      return "status_failed"
    }
    const status = checked.status
    // D2: an interrupted operation needs `recover`, which the menu never runs.
    if (status.journalPhase !== "none" && status.journalPhase !== "idle") {
      log.error("patch undo: journal not idle", { source: "patch-undo.status", journalPhase: status.journalPhase })
      await notice("warning", t("desktop.patch.undo.blocked.message"))
      return "interrupted"
    }
    // D3
    if (status.rollbackBlocked) {
      await notice(
        "info",
        t("desktop.patch.undo.blocked.message"),
        t("desktop.patch.undo.blocked.detail", { release: status.previousRelease }),
      )
      return "blocked"
    }
    // D4
    if (status.previousRelease === "") {
      await notice("info", t("desktop.patch.undo.none.message"))
      return "none"
    }
    // D5: Cancel is the default and the Escape answer; a dialog that fails to show counts as Cancel.
    const answer = await show({
      type: "question",
      message: t("desktop.patch.undo.confirm.message", { release: status.previousRelease }),
      detail: t("desktop.patch.undo.confirm.detail", { installed: status.release, release: status.previousRelease }),
      buttons: [t("desktop.patch.undo.confirm.undo"), t("desktop.patch.cancel")],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    if (answer?.response !== 0) return "cancelled"

    // D6: BN-61 rollback argv, with no flags.
    const handed = await deps
      .handoff(["/bin/zsh", "-f", applier, "rollback"])
      .catch((error: unknown) => ({ ok: false as const, code: handoffErrorCode(error) }))
    if (!handed.ok) {
      log.error("patch undo: handoff spawn failed", { source: "patch-undo.handoff", code: handed.code })
      await notice(
        "error",
        t("desktop.patch.result.failed.message"),
        t("desktop.patch.result.failed.detail", { error: `spawn: ${handed.code}` }),
      )
      return "handoff_failed"
    }
    log.info("patch undo: rollback handed off", {
      source: "patch-undo.handoff",
      installed: status.release,
      target: status.previousRelease,
    })
    return "handed_off"
  }

  // C27 D-1: guard policy from patch-common.ts; kept after "handed_off", released on every other outcome.
  return guardPatchFlow<UndoOutcome>(deps.guard, "handed_off", run)
}

function handoffErrorCode(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : "unknown"
}
