// SEC-21 (SR-21, 1.2.6 row 53b): a session abort cancels the in-flight MCP tool call.
// A stubbed server holds `tools/call` open (a hung server without its own timeout); aborting the
// caller's signal must end the call within 1 s, and the server must see the cancellation.
import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { McpCatalog } from "@/mcp/catalog"

const HUNG_MS = 30_000

async function hungServer() {
  const state = { started: false, cancelled: false }
  const server = new Server({ name: "hung", version: "1.0.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "slow", inputSchema: { type: "object" } }],
  }))
  server.setRequestHandler(CallToolRequestSchema, (_req, extra) => {
    state.started = true
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ content: [{ type: "text", text: "late" }] }), HUNG_MS)
      extra.signal.addEventListener("abort", () => {
        state.cancelled = true
        clearTimeout(timer)
      })
    })
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "swarm-test", version: "1.0.0" })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { client, server, state }
}

const def = { name: "slow", inputSchema: { type: "object", properties: {} } } as any

async function waitFor(check: () => boolean, ms: number) {
  const until = Date.now() + ms
  while (!check() && Date.now() < until) await new Promise((r) => setTimeout(r, 5))
  return check()
}

describe("SEC-21 session abort cancels the in-flight MCP call", () => {
  test("convertTool: aborting the session signal ends a hung call within 1 s", async () => {
    const { client, server, state } = await hungServer()
    try {
      // The configured timeout mirrors experimental.mcp_timeout (600000): only the abort can end the call.
      const tool = McpCatalog.convertTool(def, client, 600_000)
      const ctrl = new AbortController()
      const call = Promise.resolve(tool.execute!({}, { toolCallId: "c1", messages: [], abortSignal: ctrl.signal }))
      const settled = call.then(
        () => "resolved" as const,
        () => "rejected" as const,
      )
      expect(await waitFor(() => state.started, 1000)).toBe(true)
      const t0 = Date.now()
      ctrl.abort(new Error("session aborted"))
      const outcome = await Promise.race([settled, new Promise<"hung">((r) => setTimeout(() => r("hung"), 1000))])
      expect(outcome).toBe("rejected")
      expect(Date.now() - t0).toBeLessThan(1000)
      expect(await waitFor(() => state.cancelled, 1000)).toBe(true)
    } finally {
      await client.close().catch(() => {})
      await server.close().catch(() => {})
    }
  })

  test("convertTool: a session aborted before the call never reaches the server", async () => {
    const { client, server, state } = await hungServer()
    try {
      const tool = McpCatalog.convertTool(def, client, 600_000)
      const ctrl = new AbortController()
      ctrl.abort(new Error("session aborted"))
      const t0 = Date.now()
      await expect(
        Promise.resolve(tool.execute!({}, { toolCallId: "c2", messages: [], abortSignal: ctrl.signal })),
      ).rejects.toBeDefined()
      expect(Date.now() - t0).toBeLessThan(1000)
      expect(state.started).toBe(false)
    } finally {
      await client.close().catch(() => {})
      await server.close().catch(() => {})
    }
  })

  test("convertTool: an abort while the call _meta is still being resolved ends the call within 1 s", async () => {
    const { client, server, state } = await hungServer()
    try {
      // A meta resolver that hangs (e.g. the autonomy lookup for the built-in studio server) must not outlive the abort.
      const meta = () => new Promise<Record<string, unknown> | undefined>(() => {})
      const tool = McpCatalog.convertTool(def, client, 600_000, meta)
      const ctrl = new AbortController()
      const settled = Promise.resolve(
        tool.execute!({}, { toolCallId: "c3", messages: [], abortSignal: ctrl.signal }),
      ).then(
        () => "resolved" as const,
        () => "rejected" as const,
      )
      await new Promise((r) => setTimeout(r, 20))
      const t0 = Date.now()
      ctrl.abort(new Error("session aborted"))
      const outcome = await Promise.race([settled, new Promise<"hung">((r) => setTimeout(() => r("hung"), 1000))])
      expect(outcome).toBe("rejected")
      expect(Date.now() - t0).toBeLessThan(1000)
      expect(state.started).toBe(false)
    } finally {
      await client.close().catch(() => {})
      await server.close().catch(() => {})
    }
  })
})
