// 1.2.6 row 31b, CFG-02 T2c (01d_spec_config.md §7): the shipped experimental.mcp_timeout
// (600000 ms) is the per-request fallback for every connected server that sets no timeout of
// its own; a server entry with its own timeout (the installer shape, 30000) keeps it.
import path from "node:path"
import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { MCP } from "../../src/mcp/index"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(MCP.node))
const stdioFixture = path.join(import.meta.dir, "../fixture/mcp-lifecycle-stdio.ts")

it.instance("a connected server without its own timeout gets the shipped 600000 on its tools", () =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    yield* mcp.add("no-timeout", { type: "local", command: [process.execPath, stdioFixture] })

    const tools = Object.values(yield* mcp.tools())
    expect(tools.length).toBeGreaterThan(0)
    for (const tool of tools) expect(tool.timeout).toBe(600000)
  }),
)

it.instance("a server entry with timeout 30000 (installer shape) keeps 30000", () =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    yield* mcp.add("own-timeout", { type: "local", command: [process.execPath, stdioFixture], timeout: 30000 })

    const tools = Object.values(yield* mcp.tools())
    expect(tools.length).toBeGreaterThan(0)
    for (const tool of tools) expect(tool.timeout).toBe(30000)
  }),
)
