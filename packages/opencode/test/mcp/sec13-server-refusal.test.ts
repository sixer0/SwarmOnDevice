import path from "node:path"
import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { testEffect } from "../lib/effect"

// SEC-13 (1.2.6 row 56a): a user MCP server whose sanitised name could compose the built-in DATUM Studio tool keys
// (`datum-studio_<tool>`, which carry the subagent Studio allows of row 56) is refused, at load and at runtime `add`.
// Load: names other than the `datum-studio` key itself that sanitise to `datum-studio` or start with `datum-studio_`
// (case-insensitive, as tool keys match case-insensitively on win32). The `datum-studio` key at load is the built-in
// or the user's own replacement (row 33 rule; row 56 then drops the subagent allows). Runtime `add`: every reserved
// name, `datum-studio` included, unless the entry is the built-in one; row 56's binding is decided at agent setup and
// cannot see a later `add`. The in-app built-in path is covered by test/mcp/datum-studio.test.ts (host running).

const stdio = path.join(import.meta.dir, "../fixture/mcp-lifecycle-stdio.ts")
const local = () => ({ type: "local" as const, command: [process.execPath, stdio] })

const itMcp = testEffect(LayerNode.compile(LayerNode.group([MCP.node, Config.node])))

const REFUSED = /reserved for Swarm's built-in DATUM Studio server/

const toolKeys = Effect.gen(function* () {
  const mcp = yield* MCP.Service
  return Object.keys(yield* mcp.tools())
})

describe("SEC-13 load: colliding server names are refused", () => {
  itMcp.instance(
    "datum-studio_studio, datum-studio.studio and Datum-Studio_x are not loaded; other servers are",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const status = yield* mcp.status()
        for (const name of ["datum-studio_studio", "datum-studio.studio", "Datum-Studio_x"]) {
          expect(status[name]?.status).toBe("failed")
          expect(status[name]?.status === "failed" ? status[name].error : "").toMatch(REFUSED)
        }
        expect(status.plain).toEqual({ status: "connected" })
        const keys = yield* toolKeys
        expect(keys).toContain("plain_current_directory")
        expect(keys.filter((key) => key.toLowerCase().startsWith("datum-studio"))).toEqual([])
      }),
    {
      config: {
        mcp: {
          "datum-studio_studio": local(),
          "datum-studio.studio": local(),
          "Datum-Studio_x": local(),
          plain: local(),
        },
      },
    },
  )

  itMcp.instance(
    "the datum-studio key itself still loads at load time (own entry wins, row 33)",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        expect((yield* mcp.status())["datum-studio"]).toEqual({ status: "connected" })
        expect(yield* toolKeys).toContain("datum-studio_current_directory")
      }),
    { config: { mcp: { "datum-studio": local() } } },
  )

  itMcp.instance(
    "a refused name cannot be brought up through connect",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.connect("datum-studio_studio")
        const status = (yield* mcp.status())["datum-studio_studio"]
        expect(status?.status).toBe("failed")
        expect(yield* toolKeys).not.toContain("datum-studio_studio_current_directory")
      }),
    { config: { mcp: { "datum-studio_studio": local() } } },
  )
})

describe("SEC-13 add: reserved names are refused at runtime", () => {
  for (const name of ["datum-studio_studio", "datum-studio.x", "DATUM-STUDIO_y", "datum-studio"])
    itMcp.instance(`add("${name}") is refused with a clear message and adds no tool`, () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const result = yield* mcp.add(name, local())
        const status = (result.status as Record<string, MCP.Status>)[name]
        expect(status?.status).toBe("failed")
        expect(status?.status === "failed" ? status.error : "").toMatch(REFUSED)
        expect(status?.status === "failed" ? status.error : "").toContain(`"${name}"`)
        expect((yield* toolKeys).filter((key) => key.toLowerCase().startsWith("datum-studio"))).toEqual([])
      }),
    )

  itMcp.instance("add of an ordinary name still connects", () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      const result = yield* mcp.add("studio-helper", local())
      expect((result.status as Record<string, MCP.Status>)["studio-helper"]).toEqual({ status: "connected" })
      expect(yield* toolKeys).toContain("studio-helper_current_directory")
    }),
  )

  itMcp.instance(
    "add under datum-studio does not replace or close a loaded datum-studio server",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const result = yield* mcp.add("datum-studio", { type: "local", command: [process.execPath, stdio, "--other"] })
        expect((result.status as Record<string, MCP.Status>)["datum-studio"]?.status).toBe("failed")
        expect((yield* mcp.status())["datum-studio"]).toEqual({ status: "connected" })
        expect(yield* toolKeys).toContain("datum-studio_current_directory")
      }),
    { config: { mcp: { "datum-studio": local() } } },
  )
})

describe("SEC-13 serverRefusal (pure)", () => {
  const BUILTIN = { type: "local", command: ["/Res/datum-studio/datum-studio-launcher"], environment: { STUDIO_AGENT_ID: "swarm" } }
  const refusal = (...args: Parameters<typeof McpCatalog.serverRefusal>) => McpCatalog.serverRefusal(...args)

  test("ordinary names are never refused", () => {
    for (const name of ["swarm-web", "studio", "datum", "datum-studios", "my-datum-studio_x"])
      for (const at of ["load", "add"] as const) expect(refusal(name, { type: "local", command: ["x"] }, BUILTIN, at)).toBeUndefined()
  })

  test("the built-in entry is not refused at load or add (enabled/timeout ignored)", () => {
    expect(refusal("datum-studio", BUILTIN, BUILTIN, "load")).toBeUndefined()
    expect(refusal("datum-studio", BUILTIN, BUILTIN, "add")).toBeUndefined()
    expect(refusal("datum-studio", { ...BUILTIN, enabled: true, timeout: 60000 }, BUILTIN, "add")).toBeUndefined()
  })

  test("add under datum-studio with any other entry, or with no built-in, is refused", () => {
    expect(refusal("datum-studio", { type: "local", command: ["/opt/evil"] }, BUILTIN, "add")).toMatch(REFUSED)
    expect(refusal("datum-studio", { ...BUILTIN, environment: { STUDIO_AGENT_ID: "swarm", X: "1" } }, BUILTIN, "add")).toMatch(REFUSED)
    expect(refusal("datum-studio", BUILTIN, undefined, "add")).toMatch(REFUSED)
  })

  test("colliding names are refused at load and add, even with the built-in entry", () => {
    for (const name of ["datum-studio_studio", "datum-studio.studio", "datum-studio studio", "Datum-Studio_x", "DATUM-STUDIO"])
      for (const at of ["load", "add"] as const) expect(refusal(name, BUILTIN, BUILTIN, at)).toMatch(REFUSED)
  })
})
