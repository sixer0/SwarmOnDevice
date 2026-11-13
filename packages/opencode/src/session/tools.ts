import { Agent } from "@/agent/agent"
import type { Config } from "@/config/config"
import { KNOWLEDGE_LIBRARY_SKILL_NAME, Skill } from "@/skill"
import { LibraryRoot } from "@/skill/library-root"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { DatumStudioMcp } from "@/mcp/datum-studio"
import { Permission } from "@/permission"
import { Autonomy } from "@/permission/autonomy"
import { Tool } from "@/tool/tool"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"

import { Plugin } from "@/plugin"
import type { TaskPromptOps } from "@/tool/task"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions, asSchema } from "ai"
import { Cause, Effect, Option } from "effect"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import { SessionProcessor } from "./processor"
import { PartID, type SessionID } from "./schema"
import { EffectBridge } from "@/effect/bridge"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { isRecord } from "@/util/record"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { Secrets } from "@/tool/secrets"
import { missionTypeSuggestion } from "./system"
import { Memory } from "@/memory/memory"
import { VaultMirror } from "@/memory/vault-mirror"

const MCP_RESOURCE_TOOLS = {
  list: "list_mcp_resources",
  listTemplates: "list_mcp_resource_templates",
  read: "read_mcp_resource",
} as const
const MAX_MCP_RESOURCE_BLOB_BYTES = 10 * 1024 * 1024
/** The swarm-web vault inbox tool (setup mcpproxy wiring); the close nudge is added only when the session has it. */
const VAULT_INBOX_TOOL = "swarm-web_vault_inbox"
const SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

/**
 * The library root this agent's tools may treat as the library, if any. The key is global on purpose: `getGlobal`, never
 * `get`, or a project could turn the library on. A config that cannot be read is left to fail, because it must not read as on.
 */
export const library = Effect.fn("SessionTools.library")(function* (input: {
  agent: Agent.Info
  config: Pick<Config.Interface, "getGlobal">
}) {
  const root = LibraryRoot.current()
  if (root.kind !== "available") return undefined
  const on = (yield* input.config.getGlobal()).knowledge_library !== false
  return on && Permission.evaluate("skill", KNOWLEDGE_LIBRARY_SKILL_NAME, input.agent.permission).action !== "deny"
    ? root.root
    : undefined
})

/**
 * For this one request only, and nothing is written. An allow rule settles a request before the gate, and under the plan
 * agent's limits an edit is the gate's to judge, whoever wrote the rule. A deny keeps its place and still refuses first.
 */
const allowsToAsks = (ruleset: PermissionV1.Ruleset) =>
  ruleset.map((rule) =>
    rule.action === "allow" && Wildcard.match("edit", rule.permission)
      ? { permission: "edit", pattern: rule.pattern, action: "ask" as const }
      : rule,
  )

/**
 * Ends `effect` (interrupting it) when the session's abort signal fires, failing with the signal's reason. An already
 * aborted signal ends it at once. Without a signal the effect runs as it is.
 */
const untilAborted = <A, E, R>(effect: Effect.Effect<A, E, R>, signal: AbortSignal | undefined) =>
  signal === undefined
    ? effect
    : Effect.raceFirst(
        effect,
        Effect.callback<never, unknown>((resume) => {
          const stop = () => resume(Effect.fail(signal.reason ?? new Error("aborted")))
          if (signal.aborted) return stop()
          signal.addEventListener("abort", stop, { once: true })
          return Effect.sync(() => signal.removeEventListener("abort", stop))
        }).pipe(Effect.orDie),
      )

export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
  /** true skips the task permission ask for every agent (command subtasks); a list skips it for those agents only. */
  bypassAgentCheck: boolean | readonly string[]
  messages: SessionV1.WithParts[]
  promptOps: TaskPromptOps
  /** Whether each step snapshots this project, so Undo can restore what changes in it. */
  canUndo?: boolean
  /** The library root for this agent, from `library`. Without it the folder is like any other. */
  library?: string
}) {
  const tools: Record<string, AITool> = {}
  const run = yield* EffectBridge.make()
  const plugin = yield* Plugin.Service
  const permission = yield* Permission.Service
  const registry = yield* ToolRegistry.Service
  const mcp = yield* MCP.Service
  const truncate = yield* Truncate.Service
  const flags = yield* RuntimeFlags.Service
  const trust = { canUndo: input.canUndo ?? false, library: input.library }
  // Row 197 (S194-01): optional, as in tool.ts, so a resolve without them (unit tests) reads the mode as off.
  const autonomy = Option.getOrUndefined(yield* Effect.serviceOption(Autonomy.Service))
  const sessions = Option.getOrUndefined(yield* Effect.serviceOption(Session.Service))
  // SK-g (N8-048): optional too; without it no mission-type line is added.
  const skills = Option.getOrUndefined(yield* Effect.serviceOption(Skill.Service))
  // MEM-e (01e §4.2): optional too; without it the done close carries no memory check and the host warns.
  const memory = Option.getOrUndefined(yield* Effect.serviceOption(Memory.Service))

  const context = (args: Record<string, unknown>, options: ToolExecutionOptions): Tool.Context => ({
    sessionID: input.session.id,
    abort: options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck, promptOps: input.promptOps },
    agent: input.agent.name,
    messages: input.messages,
    trust,
    metadata: (val) =>
      input.processor.updateToolCall(options.toolCallId, (match) => {
        if (!["running", "pending"].includes(match.state.status)) return match
        return {
          ...match,
          state: {
            title: val.title,
            metadata: val.metadata,
            status: "running",
            input: args,
            time: match.state.status === "running" ? match.state.time : { start: Date.now() },
          },
        }
      }),
    ask: ({ planLimited, ...request }) => {
      const ruleset = Permission.merge(input.agent.permission, input.session.permission ?? [])
      // Requests live in memory, so a crash loses them. This is what tells a restart that the call never ran.
      const waiting = (value: boolean) =>
        input.processor.updateToolCall(options.toolCallId, (match) => {
          if (match.state.status !== "running" && match.state.status !== "pending") return match
          const { waitingOnPermission: _, ...metadata } = ("metadata" in match.state && match.state.metadata) || {}
          return {
            ...match,
            state: {
              title: "title" in match.state ? match.state.title : undefined,
              metadata: value ? { ...metadata, waitingOnPermission: true } : metadata,
              status: "running" as const,
              input: args,
              time: match.state.status === "running" ? match.state.time : { start: Date.now() },
            },
          }
        })
      return waiting(true).pipe(
        Effect.andThen(
          permission.ask({
            ...request,
            sessionID: input.session.id,
            tool: { messageID: input.processor.message.id, callID: options.toolCallId },
            agent: input.agent.name,
            canUndo: trust.canUndo,
            ruleset: planLimited ? allowsToAsks(ruleset) : ruleset,
          }),
        ),
        Effect.ensuring(waiting(false).pipe(Effect.ignore)),
        Effect.orDie,
      )
    },
  })

  for (const item of yield* registry.tools({
    modelID: ModelV2.ID.make(input.model.api.id),
    providerID: input.model.providerID,
    agent: input.agent,
    permission: input.session.permission,
  })) {
    const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))
    tools[item.id] = tool({
      description: item.description,
      inputSchema: jsonSchema(schema),
      execute(args, options) {
        return run.promise(
          Effect.gen(function* () {
            const ctx = context(args, options)
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
              { args },
            )
            const result = yield* item.execute(args, ctx)
            const output = {
              ...result,
              attachments: result.attachments?.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
              })),
            }
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
              output,
            )
            if (options.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(options.toolCallId, output)
            }
            return output
          }),
        )
      },
    })
  }

  const hasMcpResourceServer = Object.values(yield* mcp.clients()).some(
    (client) => !!client.getServerCapabilities()?.resources,
  )
  if (hasMcpResourceServer) {
    tools[MCP_RESOURCE_TOOLS.list] = tool({
      description:
        "Lists resources provided by connected MCP servers. Resources provide context such as files, database schemas, or application-specific information.",
      inputSchema: jsonSchema(
        ProviderTransform.schema(input.model, {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: "Optional MCP server name. When omitted, lists resources from every connected server.",
            },
          },
          additionalProperties: false,
        }),
      ),
      execute(args, opts) {
        return run.promise(
          Effect.gen(function* () {
            const parsed = parseListMcpResourcesArgs(args)
            const ctx = context(toRecord(args), opts)
            const clients = yield* mcp.clients()
            const resourceServers = Object.entries(clients)
              .filter((entry) => !!entry[1].getServerCapabilities()?.resources)
              .map((entry) => entry[0])
              .sort((a, b) => a.localeCompare(b))
            if (parsed.server && !resourceServers.includes(parsed.server)) {
              throw new Error(
                resourceServers.length === 0
                  ? `MCP server "${parsed.server}" does not support resources`
                  : `MCP server "${parsed.server}" does not support resources. Available resource servers: ${resourceServers.join(", ")}`,
              )
            }
            const permissionPatterns = parsed.server
              ? [`mcp:${parsed.server}:*`]
              : resourceServers.map((server) => `mcp:${server}:*`)
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: MCP_RESOURCE_TOOLS.list, sessionID: ctx.sessionID, callID: opts.toolCallId },
              { args },
            )
            yield* ctx.ask({
              permission: "read",
              metadata: parsed.server ? { server: parsed.server } : {},
              patterns: permissionPatterns,
              always: permissionPatterns,
            })

            const resources = Object.values(yield* mcp.resources(parsed.server))
            const filtered = resources
              .filter((resource) => !parsed.server || resource.client === parsed.server)
              .toSorted((a, b) =>
                (a.client + "\u0000" + a.name + "\u0000" + a.uri).localeCompare(
                  b.client + "\u0000" + b.name + "\u0000" + b.uri,
                ),
              )
            const content = JSON.stringify({ resources: filtered.map(formatMcpResource) }, null, 2)
            const truncated = yield* truncate.output(content, {}, input.agent)
            const output = {
              title: parsed.server ? `MCP resources: ${parsed.server}` : "MCP resources",
              metadata: {
                count: filtered.length,
                servers: resourceServers,
                ...(parsed.server ? { server: parsed.server } : {}),
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              },
              output: truncated.content,
            }
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: MCP_RESOURCE_TOOLS.list, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
              output,
            )
            if (opts.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(opts.toolCallId, output)
            }
            return output
          }),
        )
      },
    })

    tools[MCP_RESOURCE_TOOLS.listTemplates] = tool({
      description:
        "Lists resource templates provided by connected MCP servers. Resource templates are parameterized resources that can be read after filling in their URI template.",
      inputSchema: jsonSchema(
        ProviderTransform.schema(input.model, {
          type: "object",
          properties: {
            server: {
              type: "string",
              description:
                "Optional MCP server name. When omitted, lists resource templates from every connected server.",
            },
          },
          additionalProperties: false,
        }),
      ),
      execute(args, opts) {
        return run.promise(
          Effect.gen(function* () {
            const parsed = parseListMcpResourcesArgs(args)
            const ctx = context(toRecord(args), opts)
            const clients = yield* mcp.clients()
            const resourceServers = Object.entries(clients)
              .filter((entry) => !!entry[1].getServerCapabilities()?.resources)
              .map((entry) => entry[0])
              .sort((a, b) => a.localeCompare(b))
            if (parsed.server && !resourceServers.includes(parsed.server)) {
              throw new Error(
                resourceServers.length === 0
                  ? `MCP server "${parsed.server}" does not support resources`
                  : `MCP server "${parsed.server}" does not support resources. Available resource servers: ${resourceServers.join(", ")}`,
              )
            }
            const permissionPatterns = parsed.server
              ? [`mcp:${parsed.server}:*`]
              : resourceServers.map((server) => `mcp:${server}:*`)
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: MCP_RESOURCE_TOOLS.listTemplates, sessionID: ctx.sessionID, callID: opts.toolCallId },
              { args },
            )
            yield* ctx.ask({
              permission: "read",
              metadata: parsed.server ? { server: parsed.server } : {},
              patterns: permissionPatterns,
              always: permissionPatterns,
            })

            const templates = Object.values(yield* mcp.resourceTemplates(parsed.server))
            const filtered = templates
              .filter((template) => !parsed.server || template.client === parsed.server)
              .toSorted((a, b) =>
                (a.client + "\u0000" + a.name + "\u0000" + a.uriTemplate).localeCompare(
                  b.client + "\u0000" + b.name + "\u0000" + b.uriTemplate,
                ),
              )
            const content = JSON.stringify({ resourceTemplates: filtered.map(formatMcpResourceTemplate) }, null, 2)
            const truncated = yield* truncate.output(content, {}, input.agent)
            const output = {
              title: parsed.server ? `MCP resource templates: ${parsed.server}` : "MCP resource templates",
              metadata: {
                count: filtered.length,
                servers: resourceServers,
                ...(parsed.server ? { server: parsed.server } : {}),
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              },
              output: truncated.content,
            }
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: MCP_RESOURCE_TOOLS.listTemplates, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
              output,
            )
            if (opts.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(opts.toolCallId, output)
            }
            return output
          }),
        )
      },
    })

    tools[MCP_RESOURCE_TOOLS.read] = tool({
      description:
        "Read a specific resource from an MCP server using the server name and resource URI. The URI is an MCP identifier and does not need to be a file URL.",
      inputSchema: jsonSchema(
        ProviderTransform.schema(input.model, {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: "MCP server name exactly as returned by list_mcp_resources.",
            },
            uri: {
              type: "string",
              description: "Resource URI to read. Use the exact URI string returned by list_mcp_resources.",
            },
          },
          required: ["server", "uri"],
          additionalProperties: false,
        }),
      ),
      execute(args, opts) {
        return run.promise(
          Effect.gen(function* () {
            const parsed = parseReadMcpResourceArgs(args)
            const ctx = context(toRecord(args), opts)
            const clients = yield* mcp.clients()
            const client = clients[parsed.server]
            if (!client) {
              throw new Error(`MCP server "${parsed.server}" is not connected`)
            }
            if (!client.getServerCapabilities()?.resources) {
              throw new Error(`MCP server "${parsed.server}" does not support resources`)
            }
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: MCP_RESOURCE_TOOLS.read, sessionID: ctx.sessionID, callID: opts.toolCallId },
              { args },
            )
            yield* ctx.ask({
              permission: "read",
              metadata: { server: parsed.server, uri: parsed.uri },
              patterns: [`mcp:${parsed.server}:${parsed.uri}`],
              always: [`mcp:${parsed.server}:*`],
            })

            const content = yield* mcp.readResource(parsed.server, parsed.uri)
            if (!content) throw new Error(`Failed to read MCP resource: ${parsed.server}/${parsed.uri}`)

            const formatted = formatMcpResourceContent(parsed.server, parsed.uri, content)
            const truncated = yield* truncate.output(formatted.text, {}, input.agent)
            const output = {
              title: `MCP resource: ${parsed.uri}`,
              metadata: {
                server: parsed.server,
                uri: parsed.uri,
                contents: formatted.contents,
                attachments: formatted.attachments.length,
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              },
              output: truncated.content,
              attachments: formatted.attachments.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
              })),
            }
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: MCP_RESOURCE_TOOLS.read, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
              output,
            )
            if (opts.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(opts.toolCallId, output)
            }
            return output
          }),
        )
      },
    })
  }

  if (flags.experimentalCodeMode) return tools

  // Row 197 (S194-01): Swarm's autonomous mode for this session, by its root as the gate reads it (tool.ts planLimits).
  // Anything that cannot be read counts as off.
  const autonomousOn: Effect.Effect<boolean> = Effect.gen(function* () {
    if (!autonomy || !sessions) return false
    const rootOf = (id: SessionID, depth: number): Effect.Effect<{ id: SessionID; directory?: string }> =>
      depth > 50
        ? Effect.succeed({ id })
        : sessions.get(id).pipe(
            Effect.flatMap((session) => (session.parentID ? rootOf(session.parentID, depth + 1) : Effect.succeed(session))),
            Effect.catchCause(() => Effect.succeed({ id })),
          )
    const root = input.session.parentID ? yield* rootOf(input.session.parentID, 0) : input.session
    const directory = root.directory ?? (yield* InstanceState.directory)
    return yield* autonomy.isOn({ root: root.id, directory })
  }).pipe(Effect.catchCause(() => Effect.succeed(false)))

  // MEM-e (01e §4.2, N8-012): on `studio_mission_set_status {to: "done"}` only, whether this project's memory holds the
  // mission's index entry (archived counts). The key is left out, so the host warns MEMORY_INDEX_UNCHECKED instead of
  // refusing, when memory is off (SWARM_DISABLE_MEMORY or the store disabled), when this agent may not `remember`, or
  // when the lookup fails: a close is never refused for a step the agent cannot take. The model cannot set `_meta`.
  const memoryIndexMeta = (name: string, args: Record<string, unknown>): Effect.Effect<Record<string, unknown>> => {
    if (name !== "studio_mission_set_status" || args.to !== "done" || typeof args.mission !== "string")
      return Effect.succeed({})
    const missionId = args.mission
    return Effect.gen(function* () {
      if (!memory || process.env.SWARM_DISABLE_MEMORY) return {}
      const ruleset = Permission.merge(input.agent.permission, input.session.permission ?? [])
      if (Permission.evaluate("remember", "*", ruleset).action === "deny") return {}
      const store = yield* memory.get()
      if (!store.enabled) return {}
      const present = store.items.some((item) => item.kind === "index" && item.missionId === missionId)
      return { [McpCatalog.MEMORY_INDEX_META]: { missionId, present } }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("mission index lookup failed", {
          source: "SessionTools.memoryIndexMeta",
          sessionID: input.session.id,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as({})),
      ),
    )
  }

  // N8-437: whether the closed mission has an index entry in this project's memory, so the close nudge can name its
  // vault notes. Memory off, a disabled store or a failed lookup give the nudge without links (logged).
  const missionIndexed = (missionId: string): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      if (!memory || process.env.SWARM_DISABLE_MEMORY) return false
      const store = yield* memory.get()
      return store.enabled && store.items.some((item) => item.kind === "index" && item.missionId === missionId)
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("mission index lookup failed", {
          source: "SessionTools.missionIndexed",
          sessionID: input.session.id,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(false)),
      ),
    )

  for (const [key, entry] of Object.entries(yield* mcp.tools())) {
    // L51: the built-in datum-studio server (global origin only, never a project's look-alike entry) gets the calling
    // session in _meta, so a mission it writes links to this session without the agent inventing an id.
    // Row 197 (S194-01): and, read at each call, whether Swarm's autonomous mode setting is on for this session's root
    // (the person turns it on). Only then may the agent self-approve a mission; the model cannot set `_meta`.
    const studio: McpCatalog.CallMeta | undefined =
      entry.source?.server === DatumStudioMcp.DATUM_STUDIO_MCP && entry.source.origin === "global"
        ? async (args) => ({
            ...McpCatalog.callerSessionMeta(input.session.id),
            ...((await run.promise(autonomousOn)) ? { [McpCatalog.AUTONOMOUS_META]: true } : {}),
            ...(await run.promise(memoryIndexMeta(entry.def.name, args))),
          })
        : undefined
    const item = McpCatalog.convertTool(entry.def, entry.client, entry.timeout, studio)
    const execute = item.execute
    if (!execute) continue

    const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
    const transformed = ProviderTransform.schema(input.model, { ...schema, properties: schema.properties ?? {} })
    item.inputSchema = jsonSchema(transformed)
    item.execute = (args, opts) =>
      run.promise(
        Effect.gen(function* () {
          const ctx = context(args, opts)
          yield* plugin.trigger(
            "tool.execute.before",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId },
            { args },
          )
          const result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.gen(function* () {
            // Rule 5 reads server, transport and origin from here; a tool without a known source counts as project.
            const mcp: MCP.Source | { origin: "project" } = entry.source ?? { origin: "project" }
            // SEC-21 remainder (1.2.6 row 40): a stopped session ends the wait for an answer too, and the call never runs.
            yield* untilAborted(
              ctx.ask({
                permission: key,
                metadata: { mcp },
                patterns: ["*"],
                always: ["*"],
                call: { tool: key, args },
              }),
              opts.abortSignal,
            )
            return yield* Effect.promise(() => execute(args, opts))
          }).pipe(
            Effect.withSpan("Tool.execute", {
              attributes: {
                "tool.name": key,
                "tool.call_id": opts.toolCallId,
                "session.id": ctx.sessionID,
                "message.id": input.processor.message.id,
              },
            }),
          )
          yield* plugin.trigger(
            "tool.execute.after",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
            result,
          )

          const textParts: string[] = []
          const attachments: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[] = []
          for (const contentItem of result.content) {
            if (contentItem.type === "text") textParts.push(contentItem.text)
            else if (contentItem.type === "image") {
              attachments.push({
                type: "file",
                mime: contentItem.mimeType,
                url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
              })
            } else if (contentItem.type === "resource") {
              const { resource } = contentItem
              if (resource.text) textParts.push(resource.text)
              if (resource.blob) {
                const mime = resource.mimeType ?? "application/octet-stream"
                const size = base64Size(resource.blob)
                if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
                  textParts.push(
                    `[Binary MCP resource omitted: ${resource.uri} (${mime}, ${formatBytes(size)}) is not a supported attachment type]`,
                  )
                  continue
                }
                if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
                  textParts.push(
                    `[Binary MCP resource omitted: ${resource.uri} (${mime}, ${formatBytes(size)}) exceeds ${formatBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
                  )
                  continue
                }
                attachments.push({
                  type: "file",
                  mime,
                  url: `data:${mime};base64,${resource.blob}`,
                  filename: resource.uri,
                })
              }
            }
          }

          // OBS-d T3 and the OBS-g close nudge (01c §5, §8.3, N8-437): a successful close (done or cancelled) refreshes
          // the vault mirror now and, when this session can write to the vault inbox, names the notes to link. A recorded
          // decision refreshes it too (debounced). Neither waits for the run, and neither can fail or change the close.
          if (studio && memory && !result.isError) {
            const call = toRecord(args)
            if (entry.def.name === "studio_mission_set_status" && (call.to === "done" || call.to === "cancelled")) {
              yield* memory.mirror({ immediate: true })
              if (VAULT_INBOX_TOOL in tools && typeof call.mission === "string")
                textParts.push(VaultMirror.closeNudge(call.mission, yield* missionIndexed(call.mission)))
            }
            if (entry.def.name === "studio_mission_record_decision") yield* memory.mirror()
          }

          // SK-g (N8-048): a created mission's type suggests skills; a line in the result, never a load, and never in
          // the cached system prompt.
          if (
            studio &&
            skills &&
            entry.def.name === "studio_mission_create" &&
            !result.isError &&
            !Permission.disabled(["skill"], input.agent.permission).has("skill")
          ) {
            const line = missionTypeSuggestion(yield* skills.available(input.agent), toRecord(args).type)
            if (line) textParts.push(line)
          }

          const truncated = yield* truncate.output(
            Secrets.scrub(textParts.join("\n\n"), (yield* InstanceState.context).worktree),
            {},
            input.agent,
          )
          const metadata = {
            ...result.metadata,
            truncated: truncated.truncated,
            ...(truncated.truncated && { outputPath: truncated.outputPath }),
          }

          const output = {
            title: "",
            metadata,
            output: truncated.content,
            attachments: attachments.map((attachment) => ({
              ...attachment,
              id: PartID.ascending(),
              sessionID: ctx.sessionID,
              messageID: input.processor.message.id,
            })),
            content: result.content,
          }
          if (opts.abortSignal?.aborted) {
            yield* input.processor.completeToolCall(opts.toolCallId, output)
          }
          return output
        }),
      )
    tools[key] = item
  }

  return tools
})

function toRecord(value: unknown) {
  if (isRecord(value)) return value
  return {}
}

function parseListMcpResourcesArgs(value: unknown) {
  const args = toRecord(value)
  return { server: optionalString(args, "server") }
}

function parseReadMcpResourceArgs(value: unknown) {
  const args = toRecord(value)
  return { server: requiredString(args, "server"), uri: requiredString(args, "uri") }
}

function optionalString(args: Record<string, unknown>, key: string) {
  const value = args[key]
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string") throw new Error(`${key} must be a string`)
  return value
}

function requiredString(args: Record<string, unknown>, key: string) {
  const value = optionalString(args, key)
  if (value) return value
  throw new Error(`${key} is required`)
}

function formatMcpResource(resource: MCP.Resource) {
  const result = Object.fromEntries(Object.entries(resource).filter((entry) => entry[0] !== "client"))
  return { ...result, server: resource.client }
}

function formatMcpResourceTemplate(template: Record<string, unknown> & { client: string }) {
  const result = Object.fromEntries(Object.entries(template).filter((entry) => entry[0] !== "client"))
  return { ...result, server: template.client }
}

function formatMcpResourceContent(server: string, uri: string, content: { contents: unknown }) {
  const items = (Array.isArray(content.contents) ? content.contents : [content.contents]).filter(isRecord)
  const text: string[] = []
  const attachments: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[] = []

  for (const item of items) {
    const itemUri = typeof item.uri === "string" ? item.uri : uri
    const mime = typeof item.mimeType === "string" ? item.mimeType : "application/octet-stream"
    if (typeof item.text === "string") {
      text.push(`Resource: ${itemUri}\nMIME: ${mime}\n${item.text}`)
      continue
    }
    if (typeof item.blob === "string") {
      const size = base64Size(item.blob)
      if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
        text.push(
          `[Binary MCP resource omitted: ${itemUri} (${mime}, ${formatBytes(size)}) is not a supported attachment type]`,
        )
        continue
      }
      if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
        text.push(
          `[Binary MCP resource omitted: ${itemUri} (${mime}, ${formatBytes(size)}) exceeds ${formatBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
        )
        continue
      }
      text.push(`[Binary MCP resource attached: ${itemUri} (${mime})]`)
      attachments.push({
        type: "file",
        mime,
        url: `data:${mime};base64,${item.blob}`,
        filename: itemUri,
      })
      continue
    }
    text.push(`[MCP resource content without text or blob: ${itemUri}]`)
  }

  return {
    contents: items.length,
    attachments,
    text: text.join("\n\n") || `MCP resource ${uri} from ${server} returned no contents.`,
  }
}

function base64Size(value: string) {
  const trimmed = value.replace(/\s/g, "")
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${Math.ceil(value / (1024 * 1024))} MB`
}

export * as SessionTools from "./tools"
