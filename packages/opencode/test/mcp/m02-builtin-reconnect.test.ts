import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { Effect } from "effect"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { pollWithTimeout, testEffect } from "../lib/effect"

// M-02 (1.2.6 row 54c, register N-052 BUILTIN_MCP_RECONNECT_ATTEMPTS): when the built-in `datum-studio` server's stdio
// bridge ends (a host restart / descriptor change makes it exit 3), opencode starts it again once and retries the call
// that was pending once. Any other server keeps the old behaviour (failed "Connection closed", no new process), and a
// bridge that ends again before it has answered a call is not started a third time (no reconnect loop).
// The fake transport is test/fixture/mcp-reconnect-stdio.ts: one process per generation, counted in a file.

const fixture = path.join(import.meta.dir, "../fixture/mcp-reconnect-stdio.ts")
const itMcp = testEffect(LayerNode.compile(LayerNode.group([MCP.node, Config.node])))

const counters: string[] = []
function counter() {
  const file = path.join(os.tmpdir(), `m02-reconnect-${process.pid}-${counters.length}-${Date.now()}.count`)
  counters.push(file)
  return file
}
const generations = (file: string) => (fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0)

function server(file: string, dieGens: string) {
  return {
    type: "local" as const,
    command: [process.execPath, fixture],
    environment: { MCP_RECONNECT_COUNT_FILE: file, MCP_RECONNECT_DIE_GENS: dieGens },
  }
}

/** Calls `<name>_<tool>` the way the session does (McpCatalog.convertTool), returning the text or the error message. */
const call = (name: string, tool: string) =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const entry = (yield* mcp.tools())[`${name}_${tool}`]
    if (!entry) return { error: `no tool ${name}_${tool}` }
    return yield* Effect.promise((): Promise<{ text?: string; error?: string }> =>
      entry.client
        .callTool({ name: tool, arguments: {} }, CallToolResultSchema, { timeout: 10_000 })
        .then((result) => ({
          text: result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join(""),
        }))
        .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) })),
    )
  })

const statusOf = (name: string) =>
  Effect.gen(function* () {
    return (yield* (yield* MCP.Service).status())[name]
  })

const DS = "datum-studio"
const files = {
  retry: counter(),
  idle: counter(),
  loop: counter(),
  reset: counter(),
  other: counter(),
}

describe("M-02 opencode: the built-in datum-studio reconnects once", () => {
  itMcp.instance(
    "a call pending when the bridge exits is retried once on a new bridge",
    () =>
      Effect.gen(function* () {
        const result = yield* call(DS, "ping")
        expect(result).toEqual({ text: "gen 2" })
        expect(generations(files.retry)).toBe(2)
        expect(yield* statusOf(DS)).toEqual({ status: "connected" })
        // The tool set the session reads again holds the new bridge.
        expect(yield* call(DS, "ping")).toEqual({ text: "gen 2" })
      }),
    { config: { mcp: { [DS]: server(files.retry, "1") } } },
  )

  itMcp.instance(
    "a bridge that ends with no call pending is started again and its tools come back",
    () =>
      Effect.gen(function* () {
        expect(yield* call(DS, "quit")).toEqual({ text: "bye 1" })
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const status = yield* statusOf(DS)
            return generations(files.idle) === 2 && status?.status === "connected" ? true : undefined
          }),
          "datum-studio did not reconnect",
          "3 seconds",
        )
        expect(yield* call(DS, "ping")).toEqual({ text: "gen 2" })
      }),
    { config: { mcp: { [DS]: server(files.idle, "") } } },
  )

  itMcp.instance(
    "no reconnect loop: a new bridge that ends before answering is not started a third time",
    () =>
      Effect.gen(function* () {
        const result = yield* call(DS, "ping")
        expect(result.error).toMatch(/Connection closed|Not connected/)
        yield* Effect.sleep("600 millis")
        expect(generations(files.loop)).toBe(2)
        expect(yield* statusOf(DS)).toEqual({ status: "failed", error: "Connection closed" })
      }),
    { config: { mcp: { [DS]: server(files.loop, "1,2,3,4") } } },
  )

  itMcp.instance(
    "after a reconnected bridge has answered, a later host restart gets its own reconnect",
    () =>
      Effect.gen(function* () {
        expect(yield* call(DS, "ping")).toEqual({ text: "gen 2" })
        expect(yield* call(DS, "quit")).toEqual({ text: "bye 2" })
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const status = yield* statusOf(DS)
            return generations(files.reset) === 3 && status?.status === "connected" ? true : undefined
          }),
          "datum-studio did not reconnect after the second restart",
          "3 seconds",
        )
        expect(yield* call(DS, "ping")).toEqual({ text: "gen 3" })
      }),
    { config: { mcp: { [DS]: server(files.reset, "1") } } },
  )
})

describe("M-02 opencode: other servers are unchanged", () => {
  itMcp.instance(
    "a non-built-in server is not reconnected and its pending call fails",
    () =>
      Effect.gen(function* () {
        const result = yield* call("other", "ping")
        expect(result.error).toMatch(/Connection closed/)
        yield* Effect.sleep("600 millis")
        expect(generations(files.other)).toBe(1)
        expect(yield* statusOf("other")).toEqual({ status: "failed", error: "Connection closed" })
      }),
    { config: { mcp: { other: server(files.other, "1") } } },
  )
})

process.on("exit", () => {
  for (const file of counters) fs.rmSync(file, { force: true })
})
