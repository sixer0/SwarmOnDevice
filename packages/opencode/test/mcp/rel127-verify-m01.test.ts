// Swarm 1.2.7 row 45c, AC-M01 (M-01, C3/D-1): CHAR-VERIFY regression for the shipped MCP request timeout.
// The audit saw mcp_timeout 600000 in a user's own swarm.jsonc; the row 9 probe showed 1.2.6 ships the value
// itself. This pins it with no user config that could mask it: a child process runs with HOME and every XDG_*
// directory pointed at a fresh, empty mkdtemp tree, so the real ~/.config/swarm is never read.
// Companion test: test/mcp/timeout-baseline.test.ts (the value reaches connected servers' tools).
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { BASELINE_CONFIG } from "@opencode-ai/core/swarm-defaults"

const root = mkdtempSync(path.join(os.tmpdir(), "r127m01-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const userFiles = (configHome: string) =>
  ["config.json", "swarm.json", "swarm.jsonc"]
    .map((name) => path.join(configHome, "swarm", name))
    .filter((file) => existsSync(file))

describe("rel127 VERIFY M-01 shipped experimental.mcp_timeout with no user config", () => {
  test("the baseline layer carries 600000 (milliseconds)", () => {
    const value = (BASELINE_CONFIG as { experimental?: { mcp_timeout?: number } }).experimental?.mcp_timeout
    expect(value).toBe(600000)
  })

  test("with an empty mkdtemp HOME and XDG tree, a fresh process reads 600000 and finds no user config", () => {
    const home = path.join(root, "h")
    const xdg = { XDG_CONFIG_HOME: "c", XDG_DATA_HOME: "d", XDG_CACHE_HOME: "k", XDG_STATE_HOME: "s" }
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: root }
    for (const [key, dir] of Object.entries(xdg)) env[key] = path.join(root, dir)
    for (const dir of [home, ...Object.values(env).filter((value) => value.startsWith(root))]) mkdirSync(dir, { recursive: true })

    const script = [
      'import { existsSync } from "node:fs"',
      'import path from "node:path"',
      'import { BASELINE_CONFIG } from "@opencode-ai/core/swarm-defaults"',
      'const names = ["config.json", "swarm.json", "swarm.jsonc"]',
      "const found = [process.env.XDG_CONFIG_HOME, path.join(process.env.HOME, \".config\")]",
      '  .flatMap((dir) => names.map((name) => path.join(dir, "swarm", name))).filter((file) => existsSync(file))',
      "console.log(JSON.stringify({ home: process.env.HOME, found, value: BASELINE_CONFIG.experimental?.mcp_timeout }))",
    ].join("\n")
    // Run from the package directory so the workspace import resolves; nothing is written into the repo.
    const run = Bun.spawnSync({ cmd: [process.execPath, "-e", script], cwd: path.join(import.meta.dir, "..", ".."), env })
    const out = run.stdout.toString().trim().split("\n").at(-1) ?? ""
    expect(run.exitCode).toBe(0)
    const result = JSON.parse(out) as { home: string; found: string[]; value: number }
    expect(result.home).toBe(home)
    expect(result.found).toEqual([])
    expect(result.value).toBe(600000)
    expect(userFiles(env["XDG_CONFIG_HOME"] ?? root)).toEqual([])
  })
})
