import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { beforeEach, describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { MCP } from "../../src/mcp/index"
import {
  GRAFT_BUILD_RETRY_MS,
  planGraftBuild,
  recordGraftBuildFailure,
  resetGraftBuildFailures,
  runGraftBuild,
} from "../../src/mcp/graft-build"
import { testEffect } from "../lib/effect"

const fakeCli = path.join(import.meta.dir, "../fixture/mcp-fake-graft.ts")
const node = process.execPath
const env = { DO_NOT_TRACK: "1" }

function project(files: Record<string, string> = { "a.ts": "export const a = 1\n" }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graft-build-")))
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body)
  return dir
}

beforeEach(() => resetGraftBuildFailures())

const base = (cwd: string) => ({ name: "graft", command: [node, fakeCli, "mcp"], cwd, env, home: "/nonexistent-home" })

describe("U20 planGraftBuild", () => {
  test("plans [node, cli, build, .] for a project without a graph", () => {
    expect(planGraftBuild(base(project()))).toEqual({ run: true, argv: [node, fakeCli, "build", "."] })
  })

  test("skips every other entry and any non-sanctioned command shape", () => {
    const dir = project()
    expect(planGraftBuild({ ...base(dir), name: "swarm-web" }).run).toBe(false)
    expect(planGraftBuild({ ...base(dir), command: [node, fakeCli, "init"] }).run).toBe(false)
    expect(planGraftBuild({ ...base(dir), command: [node, fakeCli, "mcp", "--deep"] }).run).toBe(false)
    expect(planGraftBuild({ ...base(dir), command: ["node", fakeCli, "mcp"] }).run).toBe(false)
  })

  test("refuses without telemetry off or with a provider key", () => {
    const dir = project()
    expect(planGraftBuild({ ...base(dir), env: {} }).run).toBe(false)
    expect(planGraftBuild({ ...base(dir), env: { DO_NOT_TRACK: "1", GRAFT_API_KEY: "x" } }).run).toBe(false)
    expect(planGraftBuild({ ...base(dir), env: { DO_NOT_TRACK: "1", GRAFT_PROVIDER: "x" } }).run).toBe(false)
  })

  test("skips root, home, an ancestor of home, an empty folder and an existing graph", () => {
    const dir = project()
    expect(planGraftBuild({ ...base("/"), home: "/nonexistent-home" }).run).toBe(false)
    expect(planGraftBuild({ ...base(dir), home: dir }).run).toBe(false)
    expect(planGraftBuild({ ...base(path.dirname(dir)), home: path.join(dir, "user") }).run).toBe(false)
    expect(planGraftBuild(base(project({ ".hidden": "" }))).run).toBe(false)
    fs.mkdirSync(path.join(dir, "graft"))
    fs.writeFileSync(path.join(dir, "graft", "manifest.json"), "{}")
    expect(planGraftBuild(base(dir))).toEqual({ run: false, reason: "graph already present" })
  })

  test("F-9: a plain build's graft/INDEX.md counts as a graph (no rebuild on every start)", () => {
    const dir = project()
    fs.mkdirSync(path.join(dir, "graft"))
    fs.writeFileSync(path.join(dir, "graft", "INDEX.md"), "# index\n")
    expect(planGraftBuild(base(dir))).toEqual({ run: false, reason: "graph already present" })
  })
})

describe("M12 planGraftBuild guards", () => {
  test("each refusal names its own reason", () => {
    const dir = project()
    const file = path.join(dir, "a.ts")
    expect(planGraftBuild({ ...base(dir), command: [node, "rel/cli.js", "mcp"] })).toMatchObject({ reason: expect.stringContaining("shape") })
    expect(planGraftBuild({ ...base(dir), command: [node, fakeCli] })).toMatchObject({ reason: expect.stringContaining("shape") })
    expect(planGraftBuild({ ...base(dir), env: { DO_NOT_TRACK: "true" } })).toMatchObject({ reason: "DO_NOT_TRACK is not 1" })
    expect(planGraftBuild({ ...base(file) })).toMatchObject({ reason: "not a directory" })
    expect(planGraftBuild({ ...base(path.join(dir, "missing")) })).toMatchObject({ reason: "directory not readable" })
  })

  test("home reached through a symlink or another letter case is still home", () => {
    const home = project()
    const link = path.join(os.tmpdir(), `graft-home-link-${process.pid}-${Date.now()}`)
    fs.symlinkSync(home, link)
    try {
      expect(planGraftBuild({ ...base(link), home })).toMatchObject({ reason: "home folder or an ancestor of it" })
      expect(planGraftBuild({ ...base(home.toUpperCase()), home })).toMatchObject({ run: false })
    } finally {
      fs.unlinkSync(link)
    }
  })

  test("a failed build is not retried in that folder within GRAFT_BUILD_RETRY_MS", () => {
    const dir = project()
    recordGraftBuildFailure(dir, 1_000)
    expect(planGraftBuild({ ...base(dir), now: 1_000 + GRAFT_BUILD_RETRY_MS - 1 })).toMatchObject({
      reason: "a recent build in this folder failed",
    })
    expect(planGraftBuild({ ...base(dir), now: 1_000 + GRAFT_BUILD_RETRY_MS })).toMatchObject({ run: true })
  })
})

describe("U20 runGraftBuild", () => {
  test("S12-01: the build child gets GRAFT_NO_GITIGNORE and GRAFT_NO_IGNORE", async () => {
    const dir = project()
    const probe = "require('fs').writeFileSync('env.json', JSON.stringify({g: process.env.GRAFT_NO_GITIGNORE, i: process.env.GRAFT_NO_IGNORE}))"
    expect((await runGraftBuild([node, "-e", probe], dir, { ...process.env })).ok).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(dir, "env.json"), "utf8"))).toEqual({ g: "1", i: "1" })
  })

  test("an abort signal kills the build, and a missing program is a failure, not a throw", async () => {
    const dir = project()
    const ctl = new AbortController()
    const pending = runGraftBuild([node, "-e", "setTimeout(() => {}, 10000)"], dir, { ...process.env }, 10_000, ctl.signal)
    setTimeout(() => ctl.abort(), 100)
    expect(await pending).toMatchObject({ ok: false, reason: "aborted" })
    expect((await runGraftBuild(["/nonexistent/graft-bin", "build", "."], dir, {})).ok).toBe(false)
  })

  test("ok on exit 0, and the graph exists afterwards", async () => {
    const dir = project()
    const r = await runGraftBuild([node, fakeCli, "build", "."], dir, { ...process.env, ...env })
    expect(r.ok).toBe(true)
    expect(fs.existsSync(path.join(dir, "graft", "INDEX.md"))).toBe(true)
  })

  test("reports a failing exit and a timeout without throwing", async () => {
    const dir = project()
    const failed = await runGraftBuild([node, fakeCli, "build", "."], dir, { ...process.env, FAKE_GRAFT_BUILD: "fail" })
    expect(failed).toMatchObject({ ok: false, reason: "exit 2" })
    const slow = await runGraftBuild([node, "-e", "setTimeout(() => {}, 10000)"], dir, { ...process.env }, 200)
    expect(slow.ok).toBe(false)
    expect(slow.ok === false && slow.reason).toContain("timed out")
  })
})

const it = testEffect(LayerNode.compile(MCP.node))

it.instance(
  "U20: a graft entry in a project with no graph gets its tools after the background build",
  () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp.add("graft", { type: "local", command: [node, fakeCli, "mcp"], environment: env })
      // M12 CR-1: the first connect does not wait for the build; graft reconnects with its tools once it is done.
      let names: string[] = []
      for (let i = 0; i < 100 && !names.includes("graft_graft_repo_map"); i++) {
        yield* Effect.sleep("50 millis")
        names = Object.keys(yield* mcp.tools())
      }
      expect(names).toContain("graft_graft_repo_map")
    }),
  { init: (dir) => Effect.sync(() => fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1\n")) },
)

it.instance(
  "U20: a failed build still connects, with no tools (the behaviour before U20)",
  () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp.add("graft", {
        type: "local",
        command: [node, fakeCli, "mcp"],
        environment: { ...env, FAKE_GRAFT_BUILD: "fail" },
      })
      yield* Effect.sleep("1500 millis")
      expect(Object.keys(yield* mcp.tools()).filter((k) => k.startsWith("graft_"))).toEqual([])
      const status = (yield* mcp.status())["graft"]
      expect(status?.status).toBe("connected")
    }),
  { init: (dir) => Effect.sync(() => fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1\n")) },
)
