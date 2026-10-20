import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

// Row-45 fix round (F-1/F-2 of verification/05_uninstall_check.md). Targets two contracts of
// `swarm uninstall`: (a) the printed binary-cleanup hints must cover EVERY file the installer
// wrote into ~/.swarm/bin, so following them leaves no residue (pre-fix the printed `rmdir`
// failed with exit 1 while ~/.swarm/bin/rg remained); (b) the directory removal set matches
// 01b section 8, which groups $TMPDIR/swarm with the four XDG dirs. rc-marker safety rows
// (decoy survival, OpenCode-only rc never selected, idempotent second pass) are re-proved here
// unchanged because the fix round must not regress them.

// Global.Path.tmp is computed from os.tmpdir() when core/src/global.ts is evaluated. Point
// TMPDIR into this file's sandbox BEFORE the first src/ import so the module never resolves
// the machine's real $TMPDIR/swarm (concurrent sessions may own that directory). The four
// XDG dirs are already sandboxed by test/preload.ts.
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "r45fix-uninstall-"))
const tmpRoot = path.join(sandbox, "tmp")
await fs.mkdir(tmpRoot, { recursive: true })
const savedEnv = { TMPDIR: process.env.TMPDIR }
process.env.TMPDIR = tmpRoot

const { Global } = await import("@opencode-ai/core/global")
const { binCleanupCommands, cleanShellConfig, collectRemovalTargets } = await import("../../../src/cli/cmd/uninstall")

afterAll(async () => {
  process.env.TMPDIR = savedEnv.TMPDIR
  await fs.rm(sandbox, { recursive: true, force: true })
})

const ALL_FLAGS = { keepConfig: false, keepData: false, dryRun: false, force: true }

// Simulates a user following the printed hints literally: an `rm "<file>"` line unlinks, an
// `rmdir "<dir>" 2>/dev/null` line removes the directory and MUST succeed here (the 2>/dev/null
// hides stderr, not the residue question this suite asks). Throws like the old F-1 state did.
async function followCommands(commands: string[]) {
  for (const command of commands) {
    const rm = /^rm "(.+)"$/.exec(command)
    if (rm) {
      await fs.unlink(rm[1])
      continue
    }
    const rmdir = /^rmdir "(.+)" 2>\/dev\/null$/.exec(command)
    if (rmdir) {
      await fs.rmdir(rmdir[1])
      continue
    }
    throw new Error(`unexpected hint shape: ${command}`)
  }
}

async function seedFile(file: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, "x")
}

describe("collectRemovalTargets — directory set vs 01b section 8", () => {
  test("lists the four XDG dirs plus $TMPDIR/swarm, all Swarm-named, no shell/binary for method unknown", async () => {
    const targets = await collectRemovalTargets(ALL_FLAGS, "unknown")
    expect(targets.directories.map((d) => d.path)).toEqual([
      Global.Path.data,
      Global.Path.cache,
      Global.Path.config,
      Global.Path.state,
      Global.Path.tmp,
    ])
    expect(targets.directories.map((d) => d.label)).toEqual(["Data", "Cache", "Config", "State", "Temp"])
    // F-2 close: the Temp entry IS the temp dir the spec row names.
    expect(Global.Path.tmp).toEqual(path.join(tmpRoot, "swarm"))
    // G7 static face of the set: every listed leaf is Swarm-owned. (A substring check on the
    // whole path would test the harness, not the product: test/preload.ts names its sandbox
    // "opencode-test-data-<pid>".)
    for (const dir of targets.directories) expect(path.basename(dir.path)).toEqual("swarm")
    expect(targets.shellConfig).toBeNull()
    expect(targets.binary).toBeNull()
  })

  test("fixture per removal target: every listed dir holds content and the documented rm call clears it", async () => {
    const targets = await collectRemovalTargets(ALL_FLAGS, "unknown")
    for (const dir of targets.directories) await seedFile(path.join(dir.path, "marker.txt"))
    for (const dir of targets.directories) {
      // Same call executeUninstall performs (uninstall.ts fs.rm recursive+force).
      await fs.rm(dir.path, { recursive: true, force: true })
      await expect(fs.access(dir.path)).rejects.toThrow()
    }
  })

  test("--keep-config/--keep-data guard only Config and Data; Temp is scratch and stays removable", async () => {
    const kept = await collectRemovalTargets({ ...ALL_FLAGS, keepConfig: true, keepData: true }, "unknown")
    const keeps = Object.fromEntries(kept.directories.map((d) => [d.label, d.keep]))
    expect(keeps).toEqual({ Data: true, Cache: false, Config: true, State: false, Temp: false })
  })
})

describe("binCleanupCommands — F-1 catcher: hints cover the whole installed bin dir", () => {
  test("every file the installer writes into ~/.swarm/bin is named, and following the hints empties ~/.swarm", async () => {
    const home = path.join(sandbox, "f1-home")
    const bin = path.join(home, ".swarm", "bin")
    await seedFile(path.join(bin, "swarm"))
    await seedFile(path.join(bin, "rg"))

    const plan = await binCleanupCommands(path.join(bin, "swarm"))
    expect(plan).toContain(`rm "${path.join(bin, "swarm")}"`)
    expect(plan).toContain(`rm "${path.join(bin, "rg")}"`)
    expect(plan.slice(-2)).toEqual([`rmdir "${bin}" 2>/dev/null`, `rmdir "${path.join(home, ".swarm")}" 2>/dev/null`])

    // Pre-fix this threw ENOTEMPTY — the measured exit 1 of verification/05_uninstall_check.md F-1.
    await followCommands(plan)
    await expect(fs.access(path.join(home, ".swarm"))).rejects.toThrow()
  })

  test("cross-check against the installer source: names parsed from install's INSTALL_DIR writes are all covered", async () => {
    const installText = await fs.readFile(new URL("../../../../../install", import.meta.url), "utf8")
    const app = /^APP=(\w+)$/m.exec(installText)?.[1]
    if (!app) throw new Error("no APP= line found in the install script")
    expect(app).toBe("swarm") // install:3
    // Persistent destinations are `$INSTALL_DIR/$APP` (install:117) and `$INSTALL_DIR/rg`
    // (install:154); the `*_install_$$` mktemp stems (install:135,160) are transient temps.
    const written = [...installText.matchAll(/\$\{?INSTALL_DIR\}?\/([A-Za-z_$][A-Za-z0-9_$]*)/g)]
      .map((m) => m[1].replace("$APP", app))
      .filter((name) => !name.includes("_install_"))
      .sort()
    expect(written).toEqual(["rg", "swarm"]) // pins the parser against today's installer

    const home = path.join(sandbox, "xcheck-home")
    const bin = path.join(home, ".swarm", "bin")
    for (const name of written) await seedFile(path.join(bin, name))
    const plan = await binCleanupCommands(path.join(bin, "swarm"))
    for (const name of written) expect(plan).toContain(`rm "${path.join(bin, name)}"`)
    await followCommands(plan) // emptying succeeds for exactly the installer's file set
  })

  test("a non-.swarm bin dir (.local/bin curl install) keeps the plain single-rm hint", async () => {
    const bin = path.join(sandbox, "local-home", ".local", "bin")
    await seedFile(path.join(bin, "swarm"))
    await seedFile(path.join(bin, "someone-elses-tool"))
    const plan = await binCleanupCommands(path.join(bin, "swarm"))
    expect(plan).toEqual([`rm "${path.join(bin, "swarm")}"`]) // U04 gate: no rmdir, no neighbour naming
  })

  test("directories inside the gated bin dir are never advertised for rm (no recursive deletion)", async () => {
    const bin = path.join(sandbox, "subdir-home", ".swarm", "bin")
    await seedFile(path.join(bin, "swarm"))
    await seedFile(path.join(bin, "stuff", "kept.txt"))
    const plan = await binCleanupCommands(path.join(bin, "swarm"))
    expect(plan.some((c) => c.includes("stuff"))).toBe(false)
    await followCommands(plan.filter((c) => c.startsWith("rm ")))
    await expect(fs.rmdir(bin)).rejects.toThrow() // residue stays VISIBLE instead of being rm -rf'd
  })

  test("hints over an already-emptied install print no extra rm and stay a no-op", async () => {
    const bin = path.join(sandbox, "gone-home", ".swarm", "bin")
    await fs.mkdir(bin, { recursive: true })
    const plan = await binCleanupCommands(path.join(bin, "swarm"))
    expect(plan).toEqual([
      `rm "${path.join(bin, "swarm")}"`,
      `rmdir "${bin}" 2>/dev/null`,
      `rmdir "${path.join(sandbox, "gone-home", ".swarm")}" 2>/dev/null`,
    ])
    // Shell semantics: rm/rmdir failures print/suppress and the sequence still finishes 0.
    for (const command of plan) {
      const target = /"(.*?)"(?: 2>\/dev\/null)?$/.exec(command)?.[1]
      if (!target) throw new Error(`unexpected hint shape: ${command}`)
      await (command.startsWith("rm ") ? fs.unlink(target).catch(() => {}) : fs.rmdir(target).catch(() => {}))
    }
  })

  test("sibling naming is deterministic (sorted)", async () => {
    const bin = path.join(sandbox, "sort-home", ".swarm", "bin")
    for (const name of ["zz", "aa", "mm"]) await seedFile(path.join(bin, name))
    await seedFile(path.join(bin, "swarm"))
    const rms = (await binCleanupCommands(path.join(bin, "swarm")))
      .filter((c) => c.startsWith("rm ") && !c.includes('swarm"'))
      .map((c) => path.basename(c.slice(4, -1)))
    expect(rms).toEqual(["aa", "mm", "zz"])
  })
})

describe("rc-marker safety is unchanged by the fix round (row 121 §4–§6)", () => {
  const rcFixture = [
    "# existing user stuff",
    "export LANG=en_US.UTF-8",
    "",
    "# opencode",
    "export PATH=$HOME/.opencode/bin:$PATH",
    "",
    "# swarm",
    "alias ll='ls -l'",
    "",
    "# swarm",
    "export PATH=$HOME/.swarm/bin:$PATH",
    "",
    "# tail comment",
    "",
  ].join("\n")
  const cleanedFixture = [
    "# existing user stuff",
    "export LANG=en_US.UTF-8",
    "",
    "# opencode",
    "export PATH=$HOME/.opencode/bin:$PATH",
    "",
    "# swarm",
    "alias ll='ls -l'",
    "",
    // The installer's leading blank line (before the real `# swarm`) and the blank that
    // followed the PATH line both survive — interior blanks are kept by design
    // (implementation/s45_uninstall.md §4 note 2); only end-of-file blanks are trimmed.
    "",
    "# tail comment",
    "",
  ].join("\n")

  // getShellConfigFile resolves the user via os.homedir(), and Bun's os.homedir() ignores a
  // runtime HOME change (measured: bun -e 'process.env.HOME="/tmp/fakehome";os.homedir()'
  // still prints the real home). Selection is therefore exercised in a child bun process with
  // HOME set at spawn — the same drive shape rows 119/121 used against the compiled binary.
  const uninstallModule = new URL("../../../src/cli/cmd/uninstall.ts", import.meta.url).pathname
  async function selectShellConfigWithHome(home: string): Promise<string | null> {
    const script = path.join(sandbox, `select-${path.basename(home)}.mjs`)
    await fs.writeFile(
      script,
      `const { getShellConfigFile } = await import(${JSON.stringify(uninstallModule)})\n` +
        `console.log(JSON.stringify(await getShellConfigFile()))\n`,
    )
    const proc = await Bun.spawn([process.execPath, script], {
      env: {
        ...process.env,
        HOME: home,
        SHELL: "/bin/zsh",
        TMPDIR: path.join(home, "tmp"),
        XDG_CONFIG_HOME: path.join(home, ".config"),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const out = await new Response(proc.stdout).text()
    const err = await new Response(proc.stderr).text()
    expect({ code: await proc.exited, err }).toEqual({ code: 0, err: "" })
    return JSON.parse(out.trim().split("\n").pop() ?? "null") as string | null
  }

  test("decoy # swarm heading an unrelated alias survives; only the real block is removed, byte-exact", async () => {
    const home = path.join(sandbox, "rc-home")
    const rc = path.join(home, ".zshrc")
    await fs.mkdir(home, { recursive: true })
    await fs.writeFile(rc, rcFixture)

    expect(await selectShellConfigWithHome(home)).toEqual(rc)

    await cleanShellConfig(rc)
    expect(await fs.readFile(rc, "utf8")).toEqual(cleanedFixture)

    // Second pass with the decoy still present: the look-ahead protects it, so the bytes
    // cannot change again — the "second uninstall is a no-op" property at file level.
    await cleanShellConfig(rc)
    expect(await fs.readFile(rc, "utf8")).toEqual(cleanedFixture)
  })

  test("an OpenCode-only rc is never selected and stays byte-identical", async () => {
    const home = path.join(sandbox, "rc-opencode-only-home")
    const rc = path.join(home, ".zshrc")
    await fs.mkdir(home, { recursive: true })
    const content = "# opencode\nexport PATH=$HOME/.opencode/bin:$PATH\n"
    await fs.writeFile(rc, content)

    expect(await selectShellConfigWithHome(home)).toBeNull()
    expect(await fs.readFile(rc, "utf8")).toEqual(content)
  })
})
