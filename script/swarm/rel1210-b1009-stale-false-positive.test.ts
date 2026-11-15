import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// N10-199 (1.2.10 row 71, AC-B1009, B10-09). Before 1.2.10 a baseline entry of the export guard was STALE as soon as
// any other tracked production file held an identifier with the entry's name, so a same-named local in an unrelated
// file (C104 F4: `const Busy = 1` in util/log-path.ts) marked `effect/runner.ts Busy` stale and failed the build gate.
// Since row 71 stale is computed from import-based readers (N10-115): an entry is stale only when it is no longer an
// unmarked export of its file, or when it gained a production reader that binds it by import. The stale output also
// names `--prune-stale` (N10-116). Run from this folder: `bun test ./rel1210-b1009-stale-false-positive.test.ts`.

const repo = path.resolve(import.meta.dir, "../..")
const guard = () => import("./check-exports")
const HINT = "--prune-stale removes these stale entries (the baseline only shrinks)."

describe("AC-B1009 no false stale baseline entry from an unrelated local", () => {
  test("(1) a local `Busy` in util/log-path.ts does not make `effect/runner.ts Busy` stale", async () => {
    const g = await guard()
    const host = "packages/opencode/src/util/log-path.ts"
    const entry = "packages/opencode/src/effect/runner.ts Busy"
    const baseline = g.loadBaseline(repo)
    expect(baseline.map((b) => `${b.file} ${b.name}`)).toContain(entry)
    const dir = mkdtempSync(path.join(os.tmpdir(), "b1009-"))
    try {
      const copy = path.join(dir, "log-path.ts")
      writeFileSync(
        copy,
        `${readFileSync(path.join(repo, host), "utf8")}\nfunction probeLocal() { const Busy = 1; return Busy }\n`,
      )
      const r = g.checkExports({ repo, baseline, replace: { [host]: copy } })
      expect(r.stale.map((s) => `${s.file} ${s.name}`)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)

  test("(2) the CLI prints the stale entry followed by the `--prune-stale` hint and exits 1", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "b1009-repo-"))
    try {
      const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { cwd: dir, encoding: "utf8" })
      expect(run("git", ["init", "-q"]).status).toBe(0)
      mkdirSync(path.join(dir, "script/swarm"), { recursive: true })
      mkdirSync(path.join(dir, "src"), { recursive: true })
      copyFileSync(path.join(repo, "script/swarm/check-exports.ts"), path.join(dir, "script/swarm/check-exports.ts"))
      symlinkSync(path.join(repo, "node_modules"), path.join(dir, "node_modules"))
      writeFileSync(path.join(dir, "src/held.ts"), "export const fixtureHeld = 1\n")
      writeFileSync(path.join(dir, "src/user.ts"), 'import { fixtureHeld } from "./held"\nconsole.log(fixtureHeld)\n')
      writeFileSync(
        path.join(dir, "script/swarm/check-exports.baseline.json"),
        `${JSON.stringify({ note: "fixture", entries: [{ file: "src/held.ts", name: "fixtureHeld" }] }, null, 2)}\n`,
      )
      expect(run("git", ["add", "src/held.ts", "src/user.ts"]).status).toBe(0)
      const out = run(process.execPath, ["script/swarm/check-exports.ts"])
      const lines = out.stdout.split("\n")
      const at = lines.indexOf("stale src/held.ts fixtureHeld")
      expect(at).toBeGreaterThanOrEqual(0)
      expect(lines[at + 1]).toBe(HINT)
      expect(out.status).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
