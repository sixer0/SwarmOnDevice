import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BUNDLED_PROVIDER } from "../src/main/bundled-provider"
import { checkCliStage } from "./check-cli-stage"
import type { BuildTarget } from "./prebuild-target"
import { CLI_TARGETS } from "./stage-cli"

// Row 121: the swarm-cli prebuild gate per build target, on fixture folders. Nothing here compiles or touches resources/.

// Smallest headers `file` names like the real cross builds (row 107): an ELF64 x86-64 executable and a PE32+ console exe.
function elf() {
  const b = Buffer.alloc(64)
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(b, 0)
  b.writeUInt16LE(2, 16) // ET_EXEC
  b.writeUInt16LE(0x3e, 18) // x86-64
  b.writeUInt32LE(1, 20)
  b.writeUInt16LE(64, 52)
  b.writeUInt16LE(56, 54)
  b.writeUInt16LE(64, 58)
  return b
}
function pe() {
  const b = Buffer.alloc(0x200)
  b.write("MZ", 0, "latin1")
  b.writeUInt16LE(0x40, 0x18)
  b.writeUInt32LE(0x40, 0x3c)
  b.write("PE\0\0", 0x40, "latin1")
  b.writeUInt16LE(0x8664, 0x44)
  b.writeUInt16LE(0xf0, 0x54)
  b.writeUInt16LE(0x22, 0x56)
  b.writeUInt16LE(0x20b, 0x58) // PE32+
  b.writeUInt16LE(3, 0x58 + 68) // console subsystem
  return b
}
const BINARY: Record<BuildTarget, () => Buffer> = {
  "darwin-arm64": () => Buffer.from("#!/bin/sh\n"), // the darwin gate never ran `file`; it still does not
  "linux-x64": elf,
  "win32-x64": pe,
}

let root = ""
let stage = ""
let sources = ""

function launcherOf(target: BuildTarget) {
  return join(import.meta.dir, CLI_TARGETS[target].launcherSource)
}

function stageAll(target: BuildTarget, binary = BINARY[target]()) {
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  const [bin, launcher, provider] = CLI_TARGETS[target].files
  writeFileSync(join(stage, bin!.name), binary)
  writeFileSync(join(stage, launcher!.name), readFileSync(launcherOf(target)))
  writeFileSync(join(stage, provider!.name), JSON.stringify(BUNDLED_PROVIDER))
  for (const file of CLI_TARGETS[target].files) chmodSync(join(stage, file.name), file.mode)
  const later = new Date(Date.now() + 60_000)
  utimesSync(join(stage, bin!.name), later, later)
}

const check = (target?: BuildTarget, launcher = launcherOf(target ?? "darwin-arm64")) =>
  checkCliStage({ stage, sources: [sources], launcher, ...(target ? { target } : {}) })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cli-stage-check-r121-"))
  stage = join(root, "resources", "swarm-cli")
  sources = join(root, "opencode-src")
  mkdirSync(sources, { recursive: true })
  writeFileSync(join(sources, "index.ts"), "")
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("checkCliStage per target", () => {
  test("darwin (no target given) accepts a complete slot exactly as before", async () => {
    stageAll("darwin-arm64")
    expect(await check()).toEqual([])
    expect(await check("darwin-arm64")).toEqual([])
  })

  test("darwin messages are unchanged", async () => {
    stageAll("darwin-arm64")
    writeFileSync(join(stage, "swarm-launcher"), "#!/bin/sh\nchanged\n")
    expect(await check()).toEqual(["staged swarm-launcher differs from scripts/swarm-launcher.sh"])
    rmSync(join(stage, "swarm"))
    expect(await check()).toEqual(["swarm is missing"])
  })

  for (const target of ["linux-x64", "win32-x64"] as const) {
    test(`${target} accepts a complete slot with the right binary kind`, async () => {
      stageAll(target)
      expect(await check(target)).toEqual([])
    })

    test(`${target} refuses a binary of another kind`, async () => {
      stageAll(target, Buffer.from("#!/bin/sh\n"))
      const problems = await check(target)
      expect(problems).toHaveLength(1)
      expect(problems[0]).toStartWith(`${CLI_TARGETS[target].files[0]!.name} is "`)
      expect(problems[0]).toEndWith(`expected ${CLI_TARGETS[target].kind}`)
    })
  }

  test("linux-x64 refuses the Windows binary and vice versa", async () => {
    stageAll("linux-x64", pe())
    expect((await check("linux-x64"))[0]).toContain("PE32+")
    stageAll("win32-x64", elf())
    expect((await check("win32-x64"))[0]).toContain("ELF 64-bit")
  })

  test("a darwin slot does not pass as win32-x64", async () => {
    stageAll("darwin-arm64")
    const problems = await check("win32-x64")
    expect(problems).toEqual([
      "unexpected files: swarm, swarm-launcher",
      "swarm.exe is missing",
      "swarm-launcher.cmd is missing",
    ])
  })

  test("win32-x64 compares the staged launcher with scripts/swarm-launcher.cmd", async () => {
    stageAll("win32-x64")
    writeFileSync(join(stage, "swarm-launcher.cmd"), "@echo off\n")
    expect(await check("win32-x64")).toEqual(["staged swarm-launcher.cmd differs from scripts/swarm-launcher.cmd"])
  })

  test("win32-x64 reports CLI sources newer than the binary", async () => {
    stageAll("win32-x64")
    const later = new Date(Date.now() + 120_000)
    utimesSync(join(sources, "index.ts"), later, later)
    const problems = await check("win32-x64")
    expect(problems).toHaveLength(1)
    expect(problems[0]).toStartWith("CLI sources changed after staging:")
  })
})

describe("scripts/swarm-launcher.cmd (spec 114 section 5.3)", () => {
  const text = readFileSync(join(import.meta.dir, "swarm-launcher.cmd"), "utf8")

  test("CRLF on every line and only full-path or built-in commands", () => {
    const lines = text.split("\r\n")
    expect(lines.at(-1)).toBe("")
    expect(text.replaceAll("\r\n", "")).not.toContain("\n")
    expect(lines.slice(0, 3)).toEqual(["@echo off", lines[1]!, "setlocal DisableDelayedExpansion"])
    expect(lines).toContain('"%dir%swarm.exe" %*')
    // WP-SEC-1 on the source: no bare findstr/tasklist/ping/where/timeout outside comments.
    const bare = lines.filter(
      (line) =>
        !/^\s*rem /i.test(line) &&
        /(^|[^\\A-Za-z0-9_])(findstr|tasklist|ping|where|timeout)([^A-Za-z0-9_]|$)/i.test(line),
    )
    expect(bare).toEqual([])
  })

  test("the staged provider fits the one line set /p reads", () => {
    const json = JSON.stringify(BUNDLED_PROVIDER)
    expect(json).not.toContain("\n")
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(1000)
  })
})
