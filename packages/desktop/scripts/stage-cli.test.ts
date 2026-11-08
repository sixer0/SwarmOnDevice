import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { CLI_FILES, CLI_TARGETS, isBuildClone, verifyBunRuntime } from "./stage-cli"

// Row 121 (S115-04, spec 113 S2, spec 114 C3-C5). Nothing here compiles: every run of the script below is refused
// before build.ts starts, and the assertions prove it did not start.

const DESKTOP = resolve(import.meta.dir, "..")
const OPENCODE_DIST = resolve(DESKTOP, "..", "opencode", "dist")
const SCRIPT = join(import.meta.dir, "stage-cli.ts")
const RUNTIME_BYTES = "fixture bun runtime\n"
const RUNTIME_SHA = createHash("sha256").update(RUNTIME_BYTES).digest("hex")
const WRONG_SHA = "0".repeat(64)

let root = ""
let cache = ""

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "stage-cli-r121-"))
  cache = join(root, "bun-cache")
  mkdirSync(cache)
  for (const runtime of ["bun-linux-x64", "bun-windows-x64"])
    writeFileSync(join(cache, `${runtime}-v${Bun.version}`), RUNTIME_BYTES)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("CLI_TARGETS", () => {
  test("darwin-arm64 is the slot staged before row 121", () => {
    expect(CLI_TARGETS["darwin-arm64"]).toEqual({
      files: CLI_FILES,
      launcherSource: "swarm-launcher.sh",
      dist: "swarm-darwin-arm64",
      kind: "Mach-O 64-bit executable arm64",
    })
    expect(CLI_FILES.map((file) => [file.name, file.mode])).toEqual([
      ["swarm", 0o755],
      ["swarm-launcher", 0o755],
      ["bundled-provider.json", 0o644],
    ])
  })

  test("linux-x64 and win32-x64 follow register R2.6, R2.7 and R5.5", () => {
    expect(CLI_TARGETS["linux-x64"].files.map((file) => file.name)).toEqual([
      "swarm",
      "swarm-launcher",
      "bundled-provider.json",
    ])
    expect(CLI_TARGETS["linux-x64"].dist).toBe("swarm-linux-x64")
    expect(CLI_TARGETS["linux-x64"].runtime).toBe("bun-linux-x64")
    expect(CLI_TARGETS["win32-x64"].files.map((file) => file.name)).toEqual([
      "swarm.exe",
      "swarm-launcher.cmd",
      "bundled-provider.json",
    ])
    expect(CLI_TARGETS["win32-x64"].dist).toBe("swarm-windows-x64")
    expect(CLI_TARGETS["win32-x64"].runtime).toBe("bun-windows-x64")
    expect(CLI_TARGETS["win32-x64"].kind).toBe("PE32+ executable (console) x86-64")
    expect(CLI_TARGETS["linux-x64"].kind).toBe("ELF 64-bit LSB executable, x86-64")
  })

  test("only a clone_* checkout may run the cross install", () => {
    expect(isBuildClone("/r/tools/build/clone_linux_abc123")).toBe(true)
    expect(isBuildClone("/r/tools/build/clone_win_abc123")).toBe(true)
    expect(isBuildClone("/Users/x/Swarm_OnDevice/swarm")).toBe(false)
  })
})

describe("verifyBunRuntime (S115-04)", () => {
  const env = (pin: string | undefined, ...dir: [string | undefined] | []) => ({
    SWARM_BUN_RUNTIME_SHA256: pin,
    BUN_INSTALL_CACHE_DIR: dir.length === 0 ? cache : dir[0],
  })

  test("accepts the pinned runtime", async () => {
    expect(await verifyBunRuntime({ runtime: "bun-linux-x64", version: Bun.version, env: env(RUNTIME_SHA) })).toBe(
      join(cache, `bun-linux-x64-v${Bun.version}`),
    )
  })

  test("refuses a wrong sha256", async () => {
    await expect(
      verifyBunRuntime({ runtime: "bun-windows-x64", version: Bun.version, env: env(WRONG_SHA) }),
    ).rejects.toThrow(`sha256 ${RUNTIME_SHA} is not the pinned ${WRONG_SHA}`)
  })

  test("refuses an empty, missing or malformed pin", async () => {
    for (const pin of [undefined, "", "abc", RUNTIME_SHA.toUpperCase(), `${RUNTIME_SHA}\n`])
      await expect(verifyBunRuntime({ runtime: "bun-linux-x64", version: Bun.version, env: env(pin) })).rejects.toThrow(
        "SWARM_BUN_RUNTIME_SHA256 is not set to a sha256",
      )
  })

  test("refuses an unset or relative cache, a missing runtime and a symlinked runtime", async () => {
    for (const dir of [undefined, "", "bun-cache"])
      await expect(
        verifyBunRuntime({ runtime: "bun-linux-x64", version: Bun.version, env: env(RUNTIME_SHA, dir) }),
      ).rejects.toThrow("BUN_INSTALL_CACHE_DIR is not set to an absolute path")
    await expect(
      verifyBunRuntime({ runtime: "bun-linux-x64", version: "0.0.0", env: env(RUNTIME_SHA) }),
    ).rejects.toThrow("is missing or not a regular file")
    const linked = join(root, "linked")
    mkdirSync(linked)
    symlinkSync(join(cache, `bun-linux-x64-v${Bun.version}`), join(linked, `bun-linux-x64-v${Bun.version}`))
    await expect(
      verifyBunRuntime({ runtime: "bun-linux-x64", version: Bun.version, env: env(RUNTIME_SHA, linked) }),
    ).rejects.toThrow("is missing or not a regular file")
  })
})

describe("stage-cli.ts refuses a cross stage before compile", () => {
  function run(extra: Record<string, string>) {
    const home = join(root, "home")
    mkdirSync(home, { recursive: true })
    const result = Bun.spawnSync([process.execPath, SCRIPT], {
      cwd: DESKTOP,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local", "share"),
        XDG_CACHE_HOME: join(home, ".cache"),
        XDG_STATE_HOME: join(home, ".local", "state"),
        MODELS_DEV_API_JSON: join(root, "models.json"),
        BUN_INSTALL_CACHE_DIR: cache,
        ...extra,
      },
    })
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
  }
  // build.ts begins with `rm -rf dist`; an unchanged dist mtime (or a still-absent dist) shows it never ran.
  const distMtime = () => statSync(OPENCODE_DIST, { throwIfNoEntry: false })?.mtimeMs

  for (const target of ["linux-x64", "win32-x64"] as const) {
    test(`${target}: wrong bun runtime sha256`, () => {
      const before = distMtime()
      const result = run({ SWARM_BUILD_TARGET: target, SWARM_BUN_RUNTIME_SHA256: WRONG_SHA })
      console.log(`row121: ${target} wrong pin exit=${result.code} ${result.err.trim()}`)
      expect(result.code).toBe(1)
      expect(result.err).toContain(
        `CLI_STAGE_FAIL bun runtime ${join(cache, `${CLI_TARGETS[target].runtime}-v${Bun.version}`)}`,
      )
      expect(result.err).toContain(`is not the pinned ${WRONG_SHA}`)
      expect(result.out).not.toContain("building")
      expect(distMtime()).toBe(before)
    })

    test(`${target}: no pin at all`, () => {
      const result = run({ SWARM_BUILD_TARGET: target })
      expect(result.code).toBe(1)
      expect(result.err).toContain("CLI_STAGE_FAIL SWARM_BUN_RUNTIME_SHA256 is not set to a sha256")
    })

    test(`${target}: the right pin still stops outside a build clone`, () => {
      const before = distMtime()
      const result = run({ SWARM_BUILD_TARGET: target, SWARM_BUN_RUNTIME_SHA256: RUNTIME_SHA })
      expect(result.code).toBe(1)
      expect(result.err).toContain(`CLI_STAGE_FAIL ${target} stages only in a build clone (clone_*)`)
      expect(distMtime()).toBe(before)
    })
  }

  test("an unknown target is refused", () => {
    const result = run({ SWARM_BUILD_TARGET: "linux-arm64" })
    expect(result.code).toBe(1)
    expect(result.err).toContain("CLI_STAGE_FAIL SWARM_BUILD_TARGET must be one of darwin-arm64, linux-x64, win32-x64")
  })
})
