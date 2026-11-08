import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkSetupStage } from "./check-setup-stage"
import { buildTarget, prebuildChecks } from "./prebuild-target"
import { FILES } from "./stage-setup"

// Senior 3 / C82 (c): the prebuild gate against fixture folders. Nothing here compiles or touches resources/.

let root = ""
let stage = ""
let setup = ""
const LOCK = '{"version":"fixture"}\n'

function stageAll() {
  mkdirSync(stage, { recursive: true })
  for (const file of FILES) {
    writeFileSync(join(stage, file.name), file.name === "tools.lock.json" ? LOCK : "#!/bin/sh\n")
    chmodSync(join(stage, file.name), file.mode)
  }
  // The binary is newer than every setup source.
  const later = new Date(Date.now() + 60_000)
  utimesSync(join(stage, "swarm-setup"), later, later)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "setup-stage-check-"))
  stage = join(root, "resources", "swarm-setup")
  setup = join(root, "setup")
  mkdirSync(join(setup, "src", "steps"), { recursive: true })
  writeFileSync(join(setup, "tools.lock.json"), LOCK)
  writeFileSync(join(setup, "src", "index.ts"), "")
  writeFileSync(join(setup, "src", "steps", "node.ts"), "")
  stageAll()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("prebuild swarm-setup check", () => {
  test("the three files, right modes, same lock, binary newer than the setup sources: no problem", async () => {
    expect(FILES.map((file) => file.name)).toEqual(["swarm-setup", "tools.lock.json", "swarm-web-proxy"])
    expect(await checkSetupStage({ stage, setup })).toEqual([])
  })

  test("a missing folder fails and names the staging command", async () => {
    rmSync(stage, { recursive: true })
    expect(await checkSetupStage({ stage, setup })).toEqual([`${stage} is missing (run bun ./scripts/stage-setup.ts)`])
  })

  for (const file of FILES) {
    test(`a missing ${file.name} fails`, async () => {
      rmSync(join(stage, file.name))
      expect(await checkSetupStage({ stage, setup })).toEqual([`${file.name} is missing`])
    })
  }

  test("an empty file, a directory in place of a file and a wrong mode each fail", async () => {
    writeFileSync(join(stage, "swarm-web-proxy"), "")
    rmSync(join(stage, "tools.lock.json"))
    mkdirSync(join(stage, "tools.lock.json"))
    chmodSync(join(stage, "swarm-setup"), 0o644)
    expect(await checkSetupStage({ stage, setup })).toEqual([
      "swarm-setup mode 644, expected 755",
      "tools.lock.json is empty or not a regular file",
      "swarm-web-proxy is empty or not a regular file",
    ])
  })

  test("an extra file in the slot fails", async () => {
    writeFileSync(join(stage, ".DS_Store"), "x")
    expect(await checkSetupStage({ stage, setup })).toEqual(["unexpected files: .DS_Store"])
  })

  test("a staged lock that differs from packages/setup fails", async () => {
    writeFileSync(join(setup, "tools.lock.json"), LOCK.replace("fixture", "changed"))
    expect(await checkSetupStage({ stage, setup })).toEqual([
      "staged tools.lock.json differs from packages/setup/tools.lock.json",
    ])
  })

  test("a setup source edited after staging fails and names it", async () => {
    const later = new Date(Date.now() + 120_000)
    utimesSync(join(setup, "src", "steps", "node.ts"), later, later)
    expect(await checkSetupStage({ stage, setup })).toEqual(["packages/setup changed after staging: src/steps/node.ts"])
  })

  test("prebuild runs the check for a macOS build before the build", async () => {
    // Row 120 / row 185: the gate follows SWARM_BUILD_TARGET (unset = darwin-arm64), not the host.
    const prebuild = await Bun.file(new URL("./prebuild.ts", import.meta.url)).text()
    expect(prebuild).toContain("const checks = prebuildChecks(buildTarget())")
    expect(prebuild).toContain("if (checks.setup) await $`bun ./scripts/check-setup-stage.ts`")
    expect(prebuild.indexOf("check-setup-stage.ts")).toBeLessThan(prebuild.indexOf("bun script/build-node.ts"))
    expect(prebuildChecks(buildTarget({})).setup).toBe(true)
    expect(prebuildChecks(buildTarget({ SWARM_BUILD_TARGET: "darwin-arm64" })).setup).toBe(true)
  })
})
