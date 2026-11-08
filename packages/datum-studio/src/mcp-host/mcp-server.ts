/**
 * One MCP server per MCP session (row 31, studio spec §3.2 "Each MCP session over HTTP gets its own
 * McpSession"). Built on the vendored `createStudioMcpServer` (resources, prompts, instructions kept
 * verbatim), with `tools/list` and `tools/call` replaced by the host table (tool-table.ts):
 * the 23 row 31 tools + registered extensions, `studio_draft_check` never listed or callable.
 *
 * Every Studio call of a vendored tool goes to the session's LocalStudioApi (`fetchImpl`); there is no
 * `globalThis.fetch` default left on this path (server.ts:79 is only reached when fetchImpl is absent).
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ErrorCode, ListResourcesRequestSchema, ListToolsRequestSchema, McpError, ReadResourceRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { HttpFetch } from "../../vendor/scripts/studio/_http-client"
import { TOOLSETS, type StudioMcpConfig, type Toolset } from "../../vendor/scripts/studio/mcp/config"
import { McpToolError, REAL_NODE_FS, redactSecret, type NodeFs } from "../../vendor/scripts/studio/mcp/safety"
import { createStudioMcpServer } from "../../vendor/scripts/studio/mcp/server"
import { executeTool, McpSession, newCallId, TOOLS, type ToolDef } from "../../vendor/scripts/studio/mcp/tools"
import { MISSION_GUIDE_NAME, MISSION_GUIDE_URI, missionGuideText } from "./mission/mission-guide.ts"
import { HOST_DROPPED_TOOLS, HOST_EXTRA_TOOLSETS, HOST_KEPT_TOOLS, type HostRememberedBasis, type HostToolExtension, type HostToolNext, type HostToolSession } from "./tool-table.ts"

export interface HostServerDeps {
  /** Session config (vendored loadConfig shape). `toolsets` = the host's active toolsets. */
  config: StudioMcpConfig
  fetchImpl: HttpFetch
  session: HostToolSession
  extensions: readonly HostToolExtension[]
  repoRoot: string
  log: (line: string) => void
  nfs?: NodeFs
  now?: () => number
}

export interface ListedTool {
  name: string
  title?: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
}

function hostToolsets(t: ToolDef): readonly Toolset[] {
  return [...t.toolsets, ...(HOST_EXTRA_TOOLSETS[t.name] ?? [])]
}

/** The vendored tools the host keeps, in HOST_KEPT_TOOLS order (missing name = startup error). */
export function keptToolDefs(): ToolDef[] {
  const dropped: readonly string[] = HOST_DROPPED_TOOLS
  return HOST_KEPT_TOOLS.map((n) => {
    const t = TOOLS.find((x) => x.name === n)
    if (!t || dropped.includes(n)) throw new Error(`vendored MCP tool ${n} is missing`)
    return t
  })
}

/** Tools active for a toolset selection (vendored kept + extensions). */
export function activeHostTools(
  toolsets: readonly Toolset[],
  extensions: readonly HostToolExtension[],
): { vendored: ToolDef[]; extensions: HostToolExtension[]; wrappers: Map<string, HostToolExtension> } {
  const on = (ts: readonly Toolset[]) => ts.some((t) => toolsets.includes(t))
  const vendored = keptToolDefs().filter((t) => on(hostToolsets(t)))
  // Row 119b: a wrapper follows its kept tool (active when the kept tool is), never adds a tool.
  const wrappers = new Map(extensions.filter((e) => e.wraps === true && vendored.some((t) => t.name === e.name)).map((e) => [e.name, e] as const))
  return { vendored, extensions: extensions.filter((e) => e.wraps !== true && on(e.toolsets)), wrappers }
}

export function createHostMcpServer(deps: HostServerDeps): Server {
  const { config } = deps
  const secret = config.secret
  // Vendored executeTool re-checks vendored toolsets (L-2); the host gate below is the authority, so the
  // executor gets every toolset (otherwise studio_registry, vendored in `reports` only, would fail under a
  // `documents`-only selection although spec §5.1 moved it to `documents`).
  const execConfig: StudioMcpConfig = { ...config, toolsets: [...TOOLSETS] }
  const server = createStudioMcpServer({ config, fetchImpl: deps.fetchImpl, repoRoot: deps.repoRoot, log: deps.log, ...(deps.nfs ? { nfs: deps.nfs } : {}), ...(deps.now ? { now: deps.now } : {}) })
  const active = activeHostTools(config.toolsets, deps.extensions)
  const toolDeps = { config: execConfig, fetchImpl: deps.fetchImpl, nfs: deps.nfs ?? REAL_NODE_FS, session: new McpSession(), ...(deps.now ? { now: deps.now } : {}) }
  const emit = (rec: Record<string, unknown>) =>
    deps.log(redactSecret(JSON.stringify({ ts: new Date().toISOString(), source: "datum-studio-host.mcp", sessionId: deps.session.sessionId, agentId: deps.session.agentId, ...rec }), secret))

  // Row 169: the MissionDoc guide resource, listed and readable while studio_mission_create is active. The vendored
  // resources/list and resources/read handlers stay as they are (vendor files unchanged): they are taken from the
  // SDK's handler map and called for every other uri.
  if (active.extensions.some((e) => e.name === "studio_mission_create")) {
    type Handler = (req: unknown, extra: unknown) => Promise<Record<string, unknown>>
    const handlers = (server as unknown as { _requestHandlers?: Map<string, Handler> })._requestHandlers
    const vendoredList = handlers?.get("resources/list")
    const vendoredRead = handlers?.get("resources/read")
    if (!vendoredList || !vendoredRead) throw new Error("vendored MCP resource handlers are missing")
    const guide = { uri: MISSION_GUIDE_URI, name: MISSION_GUIDE_NAME, title: "MissionDoc shape for studio_mission_create", description: "Required fields, kind/size/tier enums, deps N:B / N:C, mission types and a minimal valid example.", mimeType: "text/markdown" }
    server.setRequestHandler(ListResourcesRequestSchema, async (req, extra) => {
      const base = await vendoredList(req, extra)
      return { ...base, resources: [...((base.resources as unknown[]) ?? []), guide] }
    })
    server.setRequestHandler(ReadResourceRequestSchema, async (req, extra) => {
      if (req.params.uri === MISSION_GUIDE_URI) return { contents: [{ uri: MISSION_GUIDE_URI, mimeType: "text/markdown", text: missionGuideText() }] }
      return (await vendoredRead(req, extra)) as { contents: Array<{ uri: string; text: string }> }
    })
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...active.vendored.map((t) => {
        const { title, ...hints } = t.annotations
        const w = active.wrappers.get(t.name)
        if (w) return { name: t.name, title: w.title, description: w.description, inputSchema: w.inputSchema, annotations: { ...hints, ...(w.annotations ?? {}) } }
        return { name: t.name, title, description: t.description, inputSchema: t.inputSchema, annotations: hints }
      }),
      ...active.extensions.map((e) => ({ name: e.name, title: e.title, description: e.description, inputSchema: e.inputSchema, ...(e.annotations ? { annotations: e.annotations } : {}) })),
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const name = req.params.name
    const args = (req.params.arguments ?? {}) as Record<string, unknown>
    const ext = active.extensions.find((e) => e.name === name)
    if (ext) {
      const t0 = Date.now()
      try {
        const out = await ext.call(args, deps.session)
        emit({ level: out.isError ? "error" : "info", event: "tool_call", tool: name, ok: out.isError !== true, durationMs: Date.now() - t0 })
        return out
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e))
        emit({ level: "error", event: "tool_call", tool: name, ok: false, code: "INTERNAL_ERROR", stack_trace: err.stack })
        throw new McpError(ErrorCode.InternalError, "galat internal")
      }
    }
    if (!active.vendored.some((t) => t.name === name)) throw new McpError(ErrorCode.InvalidParams, `alat tidak dikenal: ${name}`)
    const wrapper = active.wrappers.get(name)
    if (wrapper) {
      // Row 119b: the wrapper decides; `next` is the unwrapped vendored call below (same logging, same envelope).
      const t0 = Date.now()
      let out: CallToolResult
      try {
        const next: HostToolNext = Object.assign((a: Record<string, unknown>) => runVendored(name, a), {
          basis: {
            get: (documentId: string) => toolDeps.session.get(documentId),
            restore: (documentId: string, saved: HostRememberedBasis | null) => {
              if (saved) toolDeps.session.remember(documentId, saved.revisionNo, saved.from, Date.parse(saved.at))
              else toolDeps.session.forget(documentId)
            },
          },
        })
        out = await wrapper.call(args, deps.session, next)
      } catch (e) {
        if (e instanceof McpError) throw e
        const err = e instanceof Error ? e : new Error(String(e))
        emit({ level: "error", event: "tool_call", tool: name, wrapped: true, ok: false, code: "INTERNAL_ERROR", stack_trace: err.stack })
        throw new McpError(ErrorCode.InternalError, "galat internal")
      }
      emit({ level: out.isError ? "error" : "info", event: "tool_call", tool: name, wrapped: true, ok: out.isError !== true, durationMs: Date.now() - t0 })
      return out
    }
    return runVendored(name, args)
  })

  async function runVendored(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const callId = newCallId()
    const t0 = Date.now()
    const fsLog = { writes: [] as string[] }
    let env
    try {
      env = await executeTool(name, args, toolDeps, callId, fsLog)
    } catch (e) {
      const msg = e instanceof McpToolError ? e.message : "galat internal"
      emit({ level: "error", event: "tool_call", tool: name, mcpCallId: callId, ok: false, code: "INTERNAL_ERROR", ...(e instanceof Error ? { stack_trace: e.stack } : {}) })
      throw new McpError(ErrorCode.InternalError, redactSecret(msg, secret))
    }
    emit({
      level: env.ok ? "info" : "error",
      event: "tool_call",
      tool: name,
      mcpCallId: callId,
      ok: env.ok,
      durationMs: Date.now() - t0,
      ...(env.error ? { code: env.error.code, correlationId: env.error.correlationId, httpStatus: env.error.httpStatus } : {}),
      ...(env.internalDetail !== undefined ? { internalDetail: env.internalDetail } : {}),
      ...(fsLog.writes.length > 0 ? { fileWrites: fsLog.writes } : {}),
    })
    const structured = JSON.parse(redactSecret(JSON.stringify(env.data), secret)) as Record<string, unknown>
    return { content: [{ type: "text", text: redactSecret(env.text, secret) }], structuredContent: structured, ...(env.ok || env.genuineFailure !== true ? {} : { isError: true }) }
  }

  return server
}
