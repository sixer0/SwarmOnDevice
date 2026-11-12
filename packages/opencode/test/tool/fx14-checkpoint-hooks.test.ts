// 1.2.6 row FX-14 (F-5, decision C24): checkpoint git calls run with the project's hooks disabled
// (`-c core.hooksPath=/dev/null`). A `reference-transaction` hook planted in the project, in `.git/hooks` or in a
// `core.hooksPath` the project configures, does not run when a checkpoint keeps its refs or when a person reverts.
import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { ActionCheckpoint } from "../../src/tool/checkpoint"
import { tmpdir } from "../fixture/fixture"

const NOW = new Date(2026, 10, 13, 9, 5, 7)
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
const exists = (file: string) =>
  fs.stat(file).then(
    () => true,
    () => false,
  )

async function plant(hooks: string, marker: string) {
  await fs.mkdir(hooks, { recursive: true })
  const hook = path.join(hooks, "reference-transaction")
  await fs.writeFile(hook, `#!/bin/sh\necho ran >> '${marker}'\n`)
  await fs.chmod(hook, 0o755)
}

describe.skipIf(process.platform === "win32")("F-5: checkpoint git runs no project hook", () => {
  for (const where of ["hooks folder", "core.hooksPath"] as const) {
    test(`a reference-transaction hook in the project's ${where} does not run at create or revert`, async () => {
      await using dir = await tmpdir({ git: true })
      await using outside = await tmpdir()
      const marker = path.join(outside.path, "hook-ran")
      await fs.writeFile(path.join(dir.path, "a.txt"), "one\n")
      git(dir.path, "add", "a.txt")
      git(dir.path, "commit", "-qm", "one")
      const old = git(dir.path, "rev-parse", "HEAD")
      if (where === "hooks folder") await plant(path.join(dir.path, ".git", "hooks"), marker)
      else {
        await plant(path.join(dir.path, "planted-hooks"), marker)
        git(dir.path, "config", "core.hooksPath", "planted-hooks")
      }
      // Control: the planted hook is live for a plain git call.
      git(dir.path, "update-ref", "refs/fx14/probe", old)
      expect(await exists(marker)).toBe(true)
      await fs.rm(marker)

      const made = await ActionCheckpoint.create({ directory: dir.path, targets: ["a.txt"], refs: ["HEAD"], now: NOW })
      if (!made.ok) throw new Error(made.message)
      expect(await exists(marker)).toBe(false)

      await fs.writeFile(path.join(dir.path, "a.txt"), "two\n")
      execFileSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "-qam", "two"], { cwd: dir.path })
      expect(git(dir.path, "rev-parse", "HEAD")).not.toBe(old)

      const back = await ActionCheckpoint.revert({ directory: dir.path, id: made.id, manifestSha256: made.manifestSha256 })
      if (!back.ok) throw new Error(back.message)
      expect(git(dir.path, "rev-parse", "HEAD")).toBe(old)
      expect(await exists(marker)).toBe(false)
    })
  }
})
