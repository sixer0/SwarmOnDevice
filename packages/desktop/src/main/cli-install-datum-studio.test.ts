// Row 34: Install DATUM Studio for Claude (Studio spec §9.3, packaging spec §4 point 6). Fixture binDir only; the real
// ~/.local/bin and ~/.claude are never touched (the installer gets every path as an argument).
import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { MessageBoxOptions } from "electron"
import {
  claudeMcpAddLine,
  createDatumStudioInstaller,
  DATUM_STUDIO_WRAPPER_MARKER,
  datumStudioLauncherPath,
  datumStudioRuntimePath,
  datumStudioWrapperText,
  installDatumStudioWrapper,
} from "./cli-install"

const root = mkdtempSync(join(tmpdir(), "datum-studio-install-test-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let counter = 0
function dir(name: string) {
  const path = join(root, `${name}-${counter++}`)
  mkdirSync(path, { recursive: true })
  return path
}

// A stand-in for Contents/Resources with datum-studio/datum-studio-launcher and swarm-cli/swarm.
function resources(opts: { runtime?: boolean; launcher?: boolean } = {}) {
  const res = dir("Resources")
  mkdirSync(join(res, "datum-studio"), { recursive: true })
  mkdirSync(join(res, "swarm-cli"), { recursive: true })
  const launcher = datumStudioLauncherPath(res)
  if (opts.launcher !== false) {
    writeFileSync(launcher, "#!/bin/sh\nexit 0\n")
    chmodSync(launcher, 0o755)
  }
  if (opts.runtime !== false) {
    writeFileSync(join(res, "swarm-cli", "swarm"), "#!/bin/sh\nexit 0\n")
    chmodSync(join(res, "swarm-cli", "swarm"), 0o755)
  }
  return { res, launcher }
}

describe("installDatumStudioWrapper", () => {
  test("paths follow the names register: <Res>/datum-studio/datum-studio-launcher and <Res>/swarm-cli/swarm", () => {
    expect(datumStudioLauncherPath("/A/Swarm.app/Contents/Resources")).toBe(
      "/A/Swarm.app/Contents/Resources/datum-studio/datum-studio-launcher",
    )
    expect(datumStudioRuntimePath("/A/Swarm.app/Contents/Resources/datum-studio/datum-studio-launcher")).toBe(
      "/A/Swarm.app/Contents/Resources/swarm-cli/swarm",
    )
  })

  test("the wrapper text is Studio spec §9.3 byte for byte", () => {
    const text = datumStudioWrapperText({
      launcher: "/Applications/Swarm.app/Contents/Resources/datum-studio/datum-studio-launcher",
      stateHome: "/Users/u/Library/Application Support/id.co.gsp.swarm.desktop",
    })
    expect(text).toBe(
      "#!/bin/sh\n" +
        "# datum-studio command, written by Swarm.app (Install DATUM Studio for Claude)\n" +
        "SWARM_APP_STATE_HOME='/Users/u/Library/Application Support/id.co.gsp.swarm.desktop' STUDIO_AGENT_ID=claude exec '/Applications/Swarm.app/Contents/Resources/datum-studio/datum-studio-launcher' \"$@\"\n",
    )
    expect(DATUM_STUDIO_WRAPPER_MARKER).toBe("# datum-studio command, written by Swarm.app (Install DATUM Studio for Claude)")
    // A quote in a path cannot break out of the shell word.
    expect(datumStudioWrapperText({ launcher: "/x", stateHome: "/a'b" })).toContain(`SWARM_APP_STATE_HOME='/a'\\''b'`)
  })

  test("writes only <binDir>/datum-studio, mode 0755, and nothing else", async () => {
    const { launcher } = resources()
    const home = dir("home")
    const binDir = join(home, ".local", "bin")
    const target = await installDatumStudioWrapper({ launcher, stateHome: "/state", binDir })
    expect(target).toBe(join(binDir, "datum-studio"))
    expect(statSync(target).mode & 0o777).toBe(0o755)
    expect(readFileSync(target, "utf8")).toBe(datumStudioWrapperText({ launcher, stateHome: "/state" }))
    expect(readdirSync(binDir)).toEqual(["datum-studio"])
    expect(readdirSync(home)).toEqual([".local"])
    expect(existsSync(join(home, ".claude"))).toBe(false)
  })

  test("replaces its own wrapper, never a file Swarm did not write (nor the swarm wrapper)", async () => {
    const { launcher } = resources()
    const binDir = dir("bin")
    await installDatumStudioWrapper({ launcher, stateHome: "/old", binDir })
    await installDatumStudioWrapper({ launcher, stateHome: "/new", binDir })
    expect(readFileSync(join(binDir, "datum-studio"), "utf8")).toContain("SWARM_APP_STATE_HOME='/new'")

    const foreign = dir("bin")
    writeFileSync(join(foreign, "datum-studio"), "#!/bin/sh\necho mine\n")
    await expect(installDatumStudioWrapper({ launcher, stateHome: "/s", binDir: foreign })).rejects.toThrow(
      "already exists and was not written by Swarm",
    )
    expect(readFileSync(join(foreign, "datum-studio"), "utf8")).toBe("#!/bin/sh\necho mine\n")

    // The swarm wrapper's marker does not count as datum-studio's.
    const swarmOwned = dir("bin")
    writeFileSync(join(swarmOwned, "datum-studio"), "#!/bin/sh\n# swarm command, written by Swarm.app (Install Command Line Tool)\n")
    await expect(installDatumStudioWrapper({ launcher, stateHome: "/s", binDir: swarmOwned })).rejects.toThrow(
      "was not written by Swarm",
    )
  })

  test("refuses when the launcher or the bundled swarm-cli/swarm runtime is missing", async () => {
    const noRuntime = resources({ runtime: false })
    const binDir = dir("bin")
    await expect(installDatumStudioWrapper({ launcher: noRuntime.launcher, stateHome: "/s", binDir })).rejects.toThrow(
      "DATUM Studio is not bundled with this app",
    )
    const noLauncher = resources({ launcher: false })
    await expect(installDatumStudioWrapper({ launcher: noLauncher.launcher, stateHome: "/s", binDir })).rejects.toThrow(
      "DATUM Studio is not bundled with this app",
    )
    expect(readdirSync(binDir)).toEqual([])
  })

  test("the claude mcp add line is the register's, quoted only when needed", () => {
    expect(claudeMcpAddLine("/Users/u/.local/bin/datum-studio")).toBe(
      "claude mcp add datum-studio -- /Users/u/.local/bin/datum-studio",
    )
    expect(claudeMcpAddLine("/Users/a b/.local/bin/datum-studio")).toBe(
      "claude mcp add datum-studio -- '/Users/a b/.local/bin/datum-studio'",
    )
  })
})

describe("createDatumStudioInstaller", () => {
  function installer(response: number | "throw", binDir: string, launcher: string, pathEnv?: string) {
    const shown: MessageBoxOptions[] = []
    const run = createDatumStudioInstaller({
      window: () => null,
      showMessageBox: async (_win, options) => {
        shown.push(options)
        if (options.type === "question" && response === "throw") throw new Error("no window")
        return { response: options.type === "question" ? (response as number) : 0, checkboxChecked: false }
      },
      t: (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key),
      launcher,
      stateHome: "/state",
      binDir,
      pathEnv: () => pathEnv,
    })
    return { run, shown }
  }

  test("Cancel (the default) and a dialog that fails both write nothing", async () => {
    const { launcher } = resources()
    const binDir = join(dir("home"), ".local", "bin")
    for (const answer of [1, "throw"] as const) {
      const { run, shown } = installer(answer, binDir, launcher)
      expect(await run()).toBeUndefined()
      expect(shown[0]?.defaultId).toBe(1)
      expect(shown[0]?.cancelId).toBe(1)
      expect(shown[0]?.title).toBe("desktop.menu.installDatumStudio")
    }
    expect(existsSync(binDir)).toBe(false)
  })

  test("Install writes the wrapper and shows the claude mcp add line as text (with the PATH hint)", async () => {
    const { launcher } = resources()
    const binDir = join(dir("home"), ".local", "bin")
    const { run, shown } = installer(0, binDir, launcher, "/usr/bin:/bin")
    const target = await run()
    expect(target).toBe(join(binDir, "datum-studio"))
    const done = shown.at(-1)!
    expect(done.type).toBe("info")
    expect(done.detail).toContain("desktop.datumStudio.done.pathHint")
    expect(done.detail).toContain(`claude mcp add datum-studio -- ${binDir}/datum-studio`)

    const onPath = installer(0, binDir, launcher, `/usr/bin:${binDir}/`)
    await onPath.run()
    expect(onPath.shown.at(-1)!.detail).toContain("desktop.datumStudio.done.detail")
  })

  test("a failure is shown, not thrown", async () => {
    const { launcher } = resources({ runtime: false })
    const binDir = dir("bin")
    const { run, shown } = installer(0, binDir, launcher)
    expect(await run()).toBeUndefined()
    expect(shown.at(-1)!.type).toBe("error")
    expect(shown.at(-1)!.message).toBe("desktop.datumStudio.failed.message")
    expect(shown.at(-1)!.detail).toContain("DATUM Studio is not bundled with this app")
  })
})
