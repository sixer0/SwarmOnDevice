// 1.2.6 FX-1 (gate M1 S3): the shell's checkpoint planning and the checkpoint module share one git runner, which has a
// timeout and keeps the server's credentials out of git's env. Red at HEAD before the fix: no `runGit` exists, and the
// shell's own runner had neither.
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as Checkpoint from "../../src/tool/checkpoint"

type Run = (cwd: string, args: readonly string[], options?: { maxBuffer?: number }) => Promise<string | undefined>
const runGit = (Checkpoint as unknown as { runGit?: Run }).runGit

describe("FX-1 S3: one git runner for checkpoints", () => {
  test("runGit exists and returns git's stdout untrimmed", async () => {
    expect(typeof runGit).toBe("function")
    const out = await runGit!(os.tmpdir(), ["--version"])
    expect(out).toMatch(/^git version .+\n$/)
  })

  test("git run by it does not see the server's credentials", async () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "fx1-rungit-"))
    const saved = process.env.SWARM_SERVER_PASSWORD
    process.env.SWARM_SERVER_PASSWORD = "fx1-secret"
    try {
      // A shell alias prints what git's own env holds.
      const out = await runGit!(dir, ["-c", "alias.fx1env=!printf %s \"${SWARM_SERVER_PASSWORD:-none}\"", "fx1env"])
      expect(out).toBe("none")
    } finally {
      if (saved === undefined) delete process.env.SWARM_SERVER_PASSWORD
      else process.env.SWARM_SERVER_PASSWORD = saved
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a failing git is undefined, not a throw", async () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "fx1-rungit-"))
    try {
      expect(await runGit!(dir, ["rev-parse", "--verify", "--quiet", "no-such-ref"])).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
