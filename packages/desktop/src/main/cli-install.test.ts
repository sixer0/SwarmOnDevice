import { afterAll, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { MessageBoxOptions } from "electron"
import { appServerFilePath, appStateHome, removeAppServerFile, writeAppServerFile } from "./app-server-file"
import { CLI_WRAPPER_MARKER, cliWrapperText, createCliInstaller, installCliWrapper, onPath } from "./cli-install"

const root = mkdtempSync(join(tmpdir(), "swarm-cli-test-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let counter = 0
function dir(name: string) {
  const path = join(root, `${name}-${counter++}`)
  mkdirSync(path, { recursive: true })
  return path
}

// A stand-in for Contents/Resources/swarm-cli: the real launcher next to a fake `swarm` that prints what it received.
function bundle() {
  const resources = dir("resources")
  const launcher = join(resources, "swarm-launcher")
  copyFileSync(join(import.meta.dir, "..", "..", "scripts", "swarm-launcher.sh"), launcher)
  chmodSync(launcher, 0o755)
  writeFileSync(
    join(resources, "swarm"),
    [
      "#!/bin/sh",
      'printf "args=%s\\n" "$*"',
      'printf "state=%s\\n" "${XDG_STATE_HOME:-}"',
      'printf "user=%s pass=%s\\n" "${SWARM_SERVER_USERNAME:-}" "${SWARM_SERVER_PASSWORD:-}"',
      'printf "flags=%s %s\\n" "${OPENCODE_EXPERIMENTAL_ICON_DISCOVERY:-}" "${OPENCODE_EXPERIMENTAL_FILEWATCHER:-}"',
      'printf "provider=%s\\n" "${SWARM_BUNDLED_PROVIDER:-}"',
      "",
    ].join("\n"),
  )
  chmodSync(join(resources, "swarm"), 0o755)
  writeFileSync(join(resources, "bundled-provider.json"), '{"provider":{"id":"fixture"}}')
  return { resources, launcher }
}

function run(file: string, args: string[], env: Record<string, string>, cwd: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(file, args, { cwd, env: { PATH: "/usr/bin:/bin", HOME: root, ...env } })
    let out = ""
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()))
    child.on("error", reject)
    child.on("exit", () => resolve(out))
  })
}

describe("installCliWrapper", () => {
  test("writes an executable wrapper that hands the app's state home to the bundled launcher", async () => {
    const { launcher } = bundle()
    const binDir = join(dir("home"), ".local", "bin")
    const path = await installCliWrapper({ launcher, stateHome: "/state/it's here", binDir })
    expect(path).toBe(join(binDir, "swarm"))
    expect(statSync(path).mode & 0o777).toBe(0o755)
    expect(readFileSync(path, "utf8")).toBe(cliWrapperText({ launcher, stateHome: "/state/it's here" }))
    expect(readFileSync(path, "utf8")).toContain(`SWARM_APP_STATE_HOME='/state/it'\\''s here'`)
  })

  test("replaces its own wrapper, never a file Swarm did not write", async () => {
    const { launcher } = bundle()
    const binDir = dir("bin")
    writeFileSync(join(binDir, "swarm"), `#!/bin/sh\n${CLI_WRAPPER_MARKER}\nexec old\n`)
    await installCliWrapper({ launcher, stateHome: "/s", binDir })
    expect(readFileSync(join(binDir, "swarm"), "utf8")).toContain(launcher)

    const foreign = dir("bin")
    writeFileSync(join(foreign, "swarm"), "#!/bin/sh\necho someone else\n")
    await expect(installCliWrapper({ launcher, stateHome: "/s", binDir: foreign })).rejects.toThrow("was not written by Swarm")
    expect(readFileSync(join(foreign, "swarm"), "utf8")).toBe("#!/bin/sh\necho someone else\n")
  })

  test("refuses when the app has no bundled command", async () => {
    await expect(
      installCliWrapper({ launcher: join(dir("none"), "swarm-launcher"), stateHome: "/s", binDir: dir("bin") }),
    ).rejects.toThrow("not bundled")
  })

  test("onPath matches the directory with or without a trailing slash", () => {
    expect(onPath("/u/.local/bin", "/usr/bin:/u/.local/bin/")).toBe(true)
    expect(onPath("/u/.local/bin", "/usr/bin")).toBe(false)
    expect(onPath("/u/.local/bin", undefined)).toBe(false)
  })
})

describe("createCliInstaller", () => {
  function installer(response: number | "throw", binDir: string, launcher: string) {
    const shown: MessageBoxOptions[] = []
    const install = createCliInstaller({
      window: () => null,
      showMessageBox: async (_win, options) => {
        shown.push(options)
        if (response === "throw" && shown.length === 1) throw new Error("no dialog")
        return { response: shown.length === 1 && response !== "throw" ? response : 0, checkboxChecked: false }
      },
      t: (key, params) => `${key}${params ? ` ${JSON.stringify(params)}` : ""}`,
      launcher,
      stateHome: "/state",
      binDir,
      pathEnv: () => "/usr/bin",
    })
    return { install, shown }
  }

  test("Cancel (the default) and a dialog that fails both write nothing", async () => {
    const { launcher } = bundle()
    for (const response of [1, "throw"] as const) {
      const binDir = join(dir("home"), "bin")
      const { install, shown } = installer(response, binDir, launcher)
      expect(await install()).toBeUndefined()
      expect(existsSync(join(binDir, "swarm"))).toBe(false)
      expect(shown[0]?.defaultId).toBe(1)
      expect(shown[0]?.cancelId).toBe(1)
    }
  })

  test("Install writes the wrapper and says how to put the directory on PATH", async () => {
    const { launcher } = bundle()
    const binDir = join(dir("home"), "bin")
    const { install, shown } = installer(0, binDir, launcher)
    expect(await install()).toBe(join(binDir, "swarm"))
    expect(shown.map((options) => options.message)).toEqual(["desktop.cli.confirm.message", "desktop.cli.done.message"])
    expect(shown[1]?.detail).toContain("desktop.cli.done.pathHint")
  })

  test("a failure is shown, not thrown", async () => {
    const { install, shown } = installer(0, dir("bin"), join(dir("none"), "swarm-launcher"))
    expect(await install()).toBeUndefined()
    expect(shown[1]?.message).toBe("desktop.cli.failed.message")
    expect(shown[1]?.detail).toContain("not bundled")
  })
})

describe("app server descriptor", () => {
  test("is written 0600 as KEY=value lines and removed on quit", async () => {
    const state = dir("state")
    const path = appServerFilePath(state)
    await writeAppServerFile(path, { url: "http://127.0.0.1:4096", username: "opencode", password: "p-1", pid: 42 })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, "utf8")).toBe("URL=http://127.0.0.1:4096\nUSERNAME=opencode\nPASSWORD=p-1\nPID=42\n")
    removeAppServerFile(path)
    expect(existsSync(path)).toBe(false)
    removeAppServerFile(path) // already gone is fine
  })

  test("refuses values the launcher could not parse", async () => {
    const path = appServerFilePath(dir("state"))
    await expect(
      writeAppServerFile(path, { url: "http://127.0.0.1:1", username: "a", password: "x\nURL=evil", pid: 1 }),
    ).rejects.toThrow("unparseable")
    expect(existsSync(path)).toBe(false)
  })

  test("the state home is the sidecar's: inherited XDG_STATE_HOME, else userData", () => {
    expect(appStateHome({ XDG_STATE_HOME: "/x" }, "/user")).toBe("/x")
    expect(appStateHome({}, "/user")).toBe("/user")
  })
})

describe("swarm-launcher", () => {
  test("gives the CLI the app's state home, flags and bundled provider", async () => {
    const { launcher } = bundle()
    const out = await run(launcher, ["models"], { SWARM_APP_STATE_HOME: "/app/state" }, root)
    expect(out).toContain("args=models\n")
    expect(out).toContain("state=/app/state\n")
    expect(out).toContain("flags=true true\n")
    expect(out).toContain('provider={"provider":{"id":"fixture"}}\n')
  })

  test("`run` attaches to the running app with the caller's directory; the password stays out of argv", async () => {
    const { launcher } = bundle()
    const state = dir("state")
    const app = join(dir("Fake.app"), "Contents", "MacOS")
    mkdirSync(app, { recursive: true })
    symlinkSync(process.execPath, join(app, "Swarm"))
    const fake = spawn(join(app, "Swarm"), ["-e", "setTimeout(() => {}, 20000)"])
    try {
      await new Promise((resolve) => setTimeout(resolve, 300))
      await writeAppServerFile(appServerFilePath(state), {
        url: "http://127.0.0.1:5555",
        username: "opencode",
        password: "secret-1",
        pid: fake.pid!,
      })
      const cwd = dir("project")
      const out = await run(launcher, ["run", "hello"], { SWARM_APP_STATE_HOME: state }, cwd)
      expect(out).toContain(`args=run --attach http://127.0.0.1:5555 --dir ${realpathSync(cwd)} hello\n`)
      expect(out).toContain("user=opencode pass=secret-1\n")
      expect(out).not.toMatch(/args=.*secret-1/)

      const explicit = await run(launcher, ["run", "--dir", "/elsewhere", "hi"], { SWARM_APP_STATE_HOME: state }, cwd)
      expect(explicit).toContain("args=run --attach http://127.0.0.1:5555 --dir /elsewhere hi\n")

      const own = await run(launcher, ["run", "--attach", "http://other:1", "hi"], { SWARM_APP_STATE_HOME: state }, cwd)
      expect(own).toContain("args=run --attach http://other:1 hi\n")
      expect(own).toContain("user= pass=\n")
    } finally {
      fake.kill()
    }
  })

  test("a descriptor whose PID is not a running Swarm is ignored", async () => {
    const { launcher } = bundle()
    const state = dir("state")
    await writeAppServerFile(appServerFilePath(state), {
      url: "http://127.0.0.1:5555",
      username: "opencode",
      password: "secret-1",
      pid: process.pid, // alive, but bun, not Contents/MacOS/Swarm
    })
    const out = await run(launcher, ["run", "hello"], { SWARM_APP_STATE_HOME: state }, root)
    expect(out).toContain("args=run hello\n")
    expect(out).toContain("user= pass=\n")
  })
})
