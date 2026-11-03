import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from "electron"
import { constants } from "node:fs"
import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"

// Install Command Line Tool (C120/C121). `swarm` in the user's ~/.local/bin is a two-line wrapper around the launcher
// inside this app bundle, so the command always runs this app's own engine at this app's version, with the state
// directory this app's server uses. It is written only after the user confirms, and a file Swarm did not write is never
// replaced.
export const CLI_WRAPPER_MARKER = "# swarm command, written by Swarm.app (Install Command Line Tool)"

export function cliLauncherPath(resourcesPath: string) {
  return join(resourcesPath, "swarm-cli", "swarm-launcher")
}

export function cliWrapperText(input: { launcher: string; stateHome: string }) {
  return [
    "#!/bin/sh",
    CLI_WRAPPER_MARKER,
    `SWARM_APP_STATE_HOME=${shellQuote(input.stateHome)} exec ${shellQuote(input.launcher)} "$@"`,
    "",
  ].join("\n")
}

export class CliInstallError extends Error {}

export async function installCliWrapper(input: { launcher: string; stateHome: string; binDir: string }) {
  await access(input.launcher, constants.X_OK).catch(() => {
    throw new CliInstallError(`the swarm command is not bundled with this app (${input.launcher})`)
  })
  const target = join(input.binDir, "swarm")
  const existing = await readFile(target, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw new CliInstallError(`${target} exists and cannot be read: ${error.message}`)
  })
  if (existing !== undefined && !existing.includes(CLI_WRAPPER_MARKER))
    throw new CliInstallError(`${target} already exists and was not written by Swarm. Remove it, then try again.`)
  await mkdir(input.binDir, { recursive: true })
  const temp = `${target}.swarm-${process.pid}.tmp`
  await writeFile(temp, cliWrapperText(input), { mode: 0o755 })
  await chmod(temp, 0o755)
  await rename(temp, target)
  return target
}

export function onPath(dir: string, pathEnv: string | undefined) {
  return (pathEnv ?? "").split(":").some((entry) => entry.replace(/\/+$/, "") === dir.replace(/\/+$/, ""))
}

type CliDialogKey =
  | "desktop.menu.installCli"
  | "desktop.cli.confirm.message"
  | "desktop.cli.confirm.detail"
  | "desktop.cli.done.message"
  | "desktop.cli.done.detail"
  | "desktop.cli.done.pathHint"
  | "desktop.cli.failed.message"
  | "desktop.setupTools.confirm.install"
  | "desktop.setupTools.confirm.cancel"

// Cancel is the default and the Escape answer; only a press of Install (button 0) writes anything. A dialog that fails
// to show counts as Cancel. Returns the installed path, or undefined when nothing was written.
export function createCliInstaller(input: {
  window: () => BrowserWindow | null
  showMessageBox: (win: BrowserWindow | null, options: MessageBoxOptions) => Promise<MessageBoxReturnValue>
  t: (key: CliDialogKey, params?: Record<string, string | number>) => string
  launcher: string
  stateHome: string
  binDir: string
  pathEnv: () => string | undefined
}) {
  return async () => {
    const target = join(input.binDir, "swarm")
    const answer = await input
      .showMessageBox(input.window(), {
        type: "question",
        title: input.t("desktop.menu.installCli"),
        message: input.t("desktop.cli.confirm.message"),
        detail: input.t("desktop.cli.confirm.detail", { path: target }),
        buttons: [input.t("desktop.setupTools.confirm.install"), input.t("desktop.setupTools.confirm.cancel")],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      })
      .catch(() => undefined)
    if (answer?.response !== 0) return undefined

    const installed = await installCliWrapper(input).catch((error: unknown) => error)
    if (typeof installed !== "string") {
      await input
        .showMessageBox(input.window(), {
          type: "error",
          title: input.t("desktop.menu.installCli"),
          message: input.t("desktop.cli.failed.message"),
          detail: installed instanceof Error ? installed.message : String(installed),
        })
        .catch(() => undefined)
      return undefined
    }
    const detail = onPath(input.binDir, input.pathEnv())
      ? input.t("desktop.cli.done.detail", { path: installed })
      : input.t("desktop.cli.done.pathHint", { path: installed, dir: input.binDir })
    await input
      .showMessageBox(input.window(), {
        type: "info",
        title: input.t("desktop.menu.installCli"),
        message: input.t("desktop.cli.done.message"),
        detail,
      })
      .catch(() => undefined)
    return installed
  }
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
