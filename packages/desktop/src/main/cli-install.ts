import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from "electron"
import { constants } from "node:fs"
import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

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
  return writeMarkedWrapper({
    target: join(input.binDir, "swarm"),
    binDir: input.binDir,
    marker: CLI_WRAPPER_MARKER,
    text: cliWrapperText(input),
  })
}

// Shared by both wrappers (swarm, datum-studio) so the two flows cannot drift: a file without the wrapper's own marker is
// never replaced; the new text goes in with mode 0755 through temp-then-rename.
async function writeMarkedWrapper(input: { target: string; binDir: string; marker: string; text: string }) {
  const { target } = input
  const existing = await readFile(target, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw new CliInstallError(`${target} exists and cannot be read: ${error.message}`)
  })
  if (existing !== undefined && !existing.includes(input.marker))
    throw new CliInstallError(`${target} already exists and was not written by Swarm. Remove it, then try again.`)
  await mkdir(input.binDir, { recursive: true })
  const temp = `${target}.swarm-${process.pid}.tmp`
  await writeFile(temp, input.text, { mode: 0o755 })
  await chmod(temp, 0o755)
  await rename(temp, target)
  return target
}

// Install DATUM Studio for Claude (row 34; Studio spec §9.3, packaging spec §4; U13). `datum-studio` in ~/.local/bin is a
// two-line wrapper around the launcher inside this app bundle. The launcher starts a thin stdio bridge to the Studio
// endpoint the running app hosts on 127.0.0.1; the bridge reads the per-launch token from the app's 0600 descriptor, so
// no token, port or Claude config file is ever written here. Same consent and marker rules as `swarm`.
export const DATUM_STUDIO_COMMAND = "datum-studio"
export const DATUM_STUDIO_WRAPPER_MARKER =
  "# datum-studio command, written by Swarm.app (Install DATUM Studio for Claude)"

export function datumStudioLauncherPath(resourcesPath: string) {
  return join(resourcesPath, "datum-studio", "datum-studio-launcher")
}

/** `<Res>/swarm-cli/swarm`, the bundled Bun binary the bridge runs on with BUN_BE_BUN=1 (Studio spec §9.2). */
export function datumStudioRuntimePath(launcher: string) {
  return join(dirname(dirname(launcher)), "swarm-cli", "swarm")
}

export function datumStudioWrapperText(input: { launcher: string; stateHome: string }) {
  return [
    "#!/bin/sh",
    DATUM_STUDIO_WRAPPER_MARKER,
    `SWARM_APP_STATE_HOME=${shellQuote(input.stateHome)} STUDIO_AGENT_ID=claude exec ${shellQuote(input.launcher)} "$@"`,
    "",
  ].join("\n")
}

/** The documented registration line (register §6). Shown to the user as text; the app never runs it. */
export function claudeMcpAddLine(wrapper: string) {
  const arg = /^[A-Za-z0-9_./-]+$/.test(wrapper) ? wrapper : shellQuote(wrapper)
  return `claude mcp add ${DATUM_STUDIO_COMMAND} -- ${arg}`
}

export async function installDatumStudioWrapper(input: { launcher: string; stateHome: string; binDir: string }) {
  for (const file of [input.launcher, datumStudioRuntimePath(input.launcher)])
    await access(file, constants.X_OK).catch(() => {
      throw new CliInstallError(`DATUM Studio is not bundled with this app (${file})`)
    })
  return writeMarkedWrapper({
    target: join(input.binDir, DATUM_STUDIO_COMMAND),
    binDir: input.binDir,
    marker: DATUM_STUDIO_WRAPPER_MARKER,
    text: datumStudioWrapperText(input),
  })
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

// Dialog keys of the DATUM Studio flow (row 34). The strings live in packages/app i18n (file_requests: row 34 -> i18n
// owner); `done.detail` and `done.pathHint` also get `claude`, the `claude mcp add` line shown as text, never run.
type DatumStudioDialogKey =
  | "desktop.menu.installDatumStudio"
  | "desktop.datumStudio.confirm.message"
  | "desktop.datumStudio.confirm.detail"
  | "desktop.datumStudio.done.message"
  | "desktop.datumStudio.done.detail"
  | "desktop.datumStudio.done.pathHint"
  | "desktop.datumStudio.failed.message"
  | "desktop.setupTools.confirm.install"
  | "desktop.setupTools.confirm.cancel"

type InstallerInput<K extends string> = {
  window: () => BrowserWindow | null
  showMessageBox: (win: BrowserWindow | null, options: MessageBoxOptions) => Promise<MessageBoxReturnValue>
  t: (key: K, params?: Record<string, string | number>) => string
  launcher: string
  stateHome: string
  binDir: string
  pathEnv: () => string | undefined
}

// Cancel is the default and the Escape answer; only a press of Install (button 0) writes anything. A dialog that fails
// to show counts as Cancel. Returns the installed path, or undefined when nothing was written.
export function createCliInstaller(input: InstallerInput<CliDialogKey>) {
  return createWrapperInstaller({
    ...input,
    command: "swarm",
    install: installCliWrapper,
    keys: {
      title: "desktop.menu.installCli",
      confirmMessage: "desktop.cli.confirm.message",
      confirmDetail: "desktop.cli.confirm.detail",
      doneMessage: "desktop.cli.done.message",
      doneDetail: "desktop.cli.done.detail",
      donePathHint: "desktop.cli.done.pathHint",
      failedMessage: "desktop.cli.failed.message",
      install: "desktop.setupTools.confirm.install",
      cancel: "desktop.setupTools.confirm.cancel",
    },
  })
}

// Same flow for `datum-studio` (packaging spec §4): the done dialog adds the `claude mcp add` line as text. No ~/.claude
// file is written and nothing is run.
export function createDatumStudioInstaller(input: InstallerInput<DatumStudioDialogKey>) {
  return createWrapperInstaller({
    ...input,
    command: DATUM_STUDIO_COMMAND,
    install: installDatumStudioWrapper,
    doneParams: (installed) => ({ claude: claudeMcpAddLine(installed) }),
    keys: {
      title: "desktop.menu.installDatumStudio",
      confirmMessage: "desktop.datumStudio.confirm.message",
      confirmDetail: "desktop.datumStudio.confirm.detail",
      doneMessage: "desktop.datumStudio.done.message",
      doneDetail: "desktop.datumStudio.done.detail",
      donePathHint: "desktop.datumStudio.done.pathHint",
      failedMessage: "desktop.datumStudio.failed.message",
      install: "desktop.setupTools.confirm.install",
      cancel: "desktop.setupTools.confirm.cancel",
    },
  })
}

function createWrapperInstaller<K extends string>(
  input: InstallerInput<K> & {
    command: string
    install: (input: { launcher: string; stateHome: string; binDir: string }) => Promise<string>
    doneParams?: (installed: string) => Record<string, string>
    keys: Record<
      | "title"
      | "confirmMessage"
      | "confirmDetail"
      | "doneMessage"
      | "doneDetail"
      | "donePathHint"
      | "failedMessage"
      | "install"
      | "cancel",
      K
    >
  },
) {
  const { keys } = input
  return async () => {
    const target = join(input.binDir, input.command)
    const answer = await input
      .showMessageBox(input.window(), {
        type: "question",
        title: input.t(keys.title),
        message: input.t(keys.confirmMessage),
        detail: input.t(keys.confirmDetail, { path: target }),
        buttons: [input.t(keys.install), input.t(keys.cancel)],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      })
      .catch(() => undefined)
    if (answer?.response !== 0) return undefined

    const installed = await input.install(input).catch((error: unknown) => error)
    if (typeof installed !== "string") {
      await input
        .showMessageBox(input.window(), {
          type: "error",
          title: input.t(keys.title),
          message: input.t(keys.failedMessage),
          detail: installed instanceof Error ? installed.message : String(installed),
        })
        .catch(() => undefined)
      return undefined
    }
    const extra = input.doneParams?.(installed) ?? {}
    const detail = onPath(input.binDir, input.pathEnv())
      ? input.t(keys.doneDetail, { path: installed, ...extra })
      : input.t(keys.donePathHint, { path: installed, dir: input.binDir, ...extra })
    await input
      .showMessageBox(input.window(), {
        type: "info",
        title: input.t(keys.title),
        message: input.t(keys.doneMessage),
        detail,
      })
      .catch(() => undefined)
    return installed
  }
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
