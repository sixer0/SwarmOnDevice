import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { Effect, Exit } from "effect"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { pollWithTimeout, testEffect } from "../lib/effect"

// Row 7 (1.3.3, MC-2 item 1; register `MCP.ToolsUnavailableError`). The reproduced MC-1 trigger: the datum-studio
// bridge closes, `onclose` drops the client and its tool list at once and starts a reconnect, and a tool list built in
// that window (hang trace: `provider tool set ... zeroToolServers=datum-studio`, same millisecond as the new bridge's
// start) went to the model without the Studio tools. `MCP.tools()` now waits for the reconnect in flight (bounded by
// the server's connect timeout), and when a server that had tools has none afterwards it ends with
// `MCP.ToolsUnavailableError` instead of returning a list without them.
// The fake bridge is test/fixture/mcp-row7-tools-stdio.ts: one process per generation, counted in a file.

const fixture = path.join(import.meta.dir, "../fixture/mcp-row7-tools-stdio.ts")
const itMcp = testEffect(LayerNode.compile(LayerNode.group([MCP.node, Config.node])))

const counters: string[] = []
function counter() {
  const file = path.join(os.tmpdir(), `row7-tools-${process.pid}-${counters.length}-${Date.now()}.count`)
  counters.push(file)
  return file
}
const generations = (file: string) => (fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0)

function server(file: string, environment: Record<string, string> = {}, timeout?: number) {
  return {
    type: "local" as const,
    command: [process.execPath, fixture],
    environment: { ROW7_COUNT_FILE: file, ...environment },
    ...(timeout === undefined ? {} : { timeout }),
  }
}

const DS = "datum-studio"

const statusOf = (name: string) =>
  Effect.gen(function* () {
    return (yield* (yield* MCP.Service).status())[name]
  })

/** The tool names a tool-list build returns, or the named error it ended with. */
const build = Effect.gen(function* () {
  const mcp = yield* MCP.Service
  const started = Date.now()
  const exit = yield* Effect.exit(mcp.tools())
  const ms = Date.now() - started
  if (Exit.isSuccess(exit)) return { names: Object.keys(exit.value).sort(), ms }
  const lost = MCP.toolsUnavailable(exit.cause)
  if (!lost) throw new Error(`tools() ended with something else: ${String(exit.cause)}`)
  return { lost, ms }
})

/** Ends the bridge the way a host restart does: `quit` answers, the process exits 3 just after. */
const quit = (name: string) =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const entry = (yield* mcp.tools())[`${name}_quit`]
    yield* Effect.promise(() =>
      entry.client.callTool({ name: "quit", arguments: {} }, CallToolResultSchema, { timeout: 10_000 }),
    )
    yield* pollWithTimeout(
      Effect.gen(function* () {
        return (yield* statusOf(name))?.status === "failed" ? true : undefined
      }),
      `${name} did not close`,
      "3 seconds",
    )
  })

const files = {
  wait: counter(),
  hang: counter(),
  bound: counter(),
  empty: counter(),
  never: counter(),
  disabled: counter(),
  other: counter(),
  disconnect: counter(),
}

describe("row 7 MC-2: the tool list waits for a reconnect in flight", () => {
  itMcp.instance(
    "a tool list built while datum-studio reconnects still carries the Studio tools",
    () =>
      Effect.gen(function* () {
        expect((yield* build).names).toEqual([`${DS}_ping`, `${DS}_quit`])
        yield* quit(DS)
        // The new bridge needs 400 ms before it answers: this build starts inside the reconnect window.
        expect(generations(files.wait)).toBeLessThanOrEqual(2)
        const during = yield* build
        expect(during.names).toEqual([`${DS}_ping`, `${DS}_quit`])
        expect(generations(files.wait)).toBe(2)
        expect(yield* statusOf(DS)).toEqual({ status: "connected" })
      }),
    { config: { mcp: { [DS]: server(files.wait, { ROW7_DELAY_GENS: "2", ROW7_DELAY_MS: "400" }) } } },
  )
})

describe("row 7 MC-2: lost tools end the build with the named error", () => {
  itMcp.instance(
    "a bridge that never comes back: the wait ends and the error names the server (no deadlock)",
    () =>
      Effect.gen(function* () {
        expect((yield* build).names).toEqual([`${DS}_ping`, `${DS}_quit`])
        yield* quit(DS)
        const first = yield* build
        expect(first.lost).toBeInstanceOf(MCP.ToolsUnavailableError)
        expect(first.lost?.server).toBe(DS)
        expect(first.lost?.message).toBe(`MCP server ${DS} has no tools after reconnect`)
        expect(first.ms).toBeLessThan(4_000)
        // No reconnect is pending any more: the next build fails at once, it does not wait again.
        const second = yield* build
        expect(second.lost?.server).toBe(DS)
        expect(second.ms).toBeLessThan(500)
      }),
    { config: { mcp: { [DS]: server(files.hang, { ROW7_HANG_GENS: "2,3,4" }, 1_000) } } },
  )

  itMcp.instance(
    "the wait is bounded by itself: it ends before a reconnect that takes longer than the bound",
    () =>
      Effect.gen(function* () {
        expect((yield* build).names).toEqual([`${DS}_ping`, `${DS}_quit`])
        yield* quit(DS)
        // Generation 2 answers initialize after 1500 ms and never answers tools/list (another 2000 ms), so the
        // reconnect itself runs about 3500 ms; the wait is the 2000 ms connect timeout.
        const result = yield* build
        expect(result.lost?.server).toBe(DS)
        expect(result.ms).toBeGreaterThanOrEqual(1_000)
        expect(result.ms).toBeLessThan(3_000)
      }),
    {
      config: {
        mcp: {
          [DS]: server(
            files.bound,
            { ROW7_DELAY_GENS: "2", ROW7_DELAY_MS: "1500", ROW7_LIST_HANG_GENS: "2" },
            2_000,
          ),
        },
      },
    },
  )

  itMcp.instance(
    "a bridge that comes back connected with an empty tool list is lost tools too",
    () =>
      Effect.gen(function* () {
        expect((yield* build).names).toEqual([`${DS}_ping`, `${DS}_quit`])
        yield* quit(DS)
        const result = yield* build
        expect(result.lost?.server).toBe(DS)
        expect(yield* statusOf(DS)).toEqual({ status: "connected" })
      }),
    { config: { mcp: { [DS]: server(files.empty, { ROW7_EMPTY_GENS: "2" }) } } },
  )

  itMcp.instance(
    "a server without reconnect that had tools and closed is named until the person disconnects it",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        expect((yield* build).names).toEqual(["other_ping", "other_quit"])
        yield* quit("other")
        const result = yield* build
        expect(result.lost?.server).toBe("other")
        expect(result.ms).toBeLessThan(500)
        expect(generations(files.other)).toBe(1)
        yield* mcp.disconnect("other")
        expect((yield* build).names).toEqual([])
      }),
    { config: { mcp: { other: server(files.other) } } },
  )
})

describe("row 7 MC-2: what does not raise the error", () => {
  itMcp.instance(
    "a server that never had tools may close without failing the build",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        expect((yield* build).names).toEqual([])
        const client = (yield* mcp.clients())[DS]
        yield* Effect.promise(() => client.close().catch(() => undefined))
        yield* pollWithTimeout(
          Effect.gen(function* () {
            return generations(files.never) === 2 ? true : undefined
          }),
          "datum-studio was not started again",
          "3 seconds",
        )
        expect((yield* build).names).toEqual([])
      }),
    { config: { mcp: { [DS]: server(files.never, { ROW7_NO_TOOLS: "1" }) } } },
  )

  itMcp.instance(
    "a server disabled by config is not expected to have tools",
    () =>
      Effect.gen(function* () {
        expect((yield* build).names).toEqual([])
        expect(yield* statusOf("off")).toEqual({ status: "disabled" })
        expect(generations(files.disabled)).toBe(0)
      }),
    { config: { mcp: { off: { ...server(files.disabled), enabled: false } } } },
  )

  itMcp.instance(
    "a server the person disconnected is not expected to have tools",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        expect((yield* build).names).toEqual([`${DS}_ping`, `${DS}_quit`])
        yield* mcp.disconnect(DS)
        expect((yield* build).names).toEqual([])
      }),
    { config: { mcp: { [DS]: server(files.disconnect) } } },
  )
})

process.on("exit", () => {
  for (const file of counters) fs.rmSync(file, { force: true })
})
