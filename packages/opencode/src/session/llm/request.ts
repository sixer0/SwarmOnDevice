import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Auth } from "@/auth"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { Permission } from "@/permission"
import { McpCatalog } from "@/mcp/catalog"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "../message-v2"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { SystemPrompt } from "../system"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect, Record } from "effect"
import { jsonSchema, tool as aiTool, type ModelMessage, type Tool } from "ai"
import type { Plugin } from "@/plugin"
import { mergeDeep } from "remeda"

const USER_AGENT = `swarm/${InstallationVersion}`

type PrepareInput = {
  readonly user: SessionV1.User
  readonly sessionID: string
  readonly parentSessionID?: string
  readonly model: Provider.Model
  readonly agent: Agent.Info
  readonly permission?: PermissionV1.Ruleset
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly small?: boolean
  readonly tools: Record<string, Tool>
  /**
   * F0 (1.3.2): the configured MCP server names, used only to group the offered keys by server prefix. They are passed
   * in because the AI SDK `Tool` map has already lost where each entry came from (`session/tools.ts:609` still holds
   * `entry.source`, this map does not).
   */
  readonly mcpServers?: readonly string[]
  readonly provider: Provider.Info
  readonly auth: Auth.Info | undefined
  readonly plugin: Plugin.Interface
  readonly flags: RuntimeFlags.Info
  readonly isWorkflow: boolean
  readonly officeProfile?: boolean
}

export type Prepared = {
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly tools: Record<string, Tool>
  readonly params: {
    readonly temperature?: number
    readonly topP?: number
    readonly topK?: number
    readonly maxOutputTokens?: number
    readonly options: Record<string, any>
  }
  readonly messageTransformOptions: Record<string, any>
  readonly headers: Record<string, string>
}

const mergeOptions = (target: Record<string, any>, source: Record<string, any> | undefined): Record<string, any> =>
  mergeDeep(target, source ?? {}) as Record<string, any>

export const prepare = Effect.fn("LLMRequestPrep.prepare")(function* (input: PrepareInput) {
  const isOpenaiOauth = input.provider.id === "openai" && input.auth?.type === "oauth"
  const system = [
    [
      ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
      // GSP workflow and language rule: build and general only, on every model (specs S4.3, S5.1). Never for an Office
      // add-in session (SD-1, IA-1).
      ...(input.officeProfile ? [] : SystemPrompt.workflow(input.agent.name)),
      ...input.system,
      ...(input.user.system ? [input.user.system] : []),
    ]
      .filter((x) => x)
      .join("\n"),
  ]

  const header = system[0]
  yield* input.plugin.trigger(
    "experimental.chat.system.transform",
    { sessionID: input.sessionID, model: input.model },
    { system },
  )
  if (system.length > 2 && system[0] === header) {
    const rest = system.slice(1)
    system.length = 0
    system.push(header, rest.join("\n"))
  }

  const variant =
    !input.small && input.model.variants && input.user.model.variant
      ? input.model.variants[input.user.model.variant]
      : {}
  const base = input.small
    ? ProviderTransform.smallOptions(input.model)
    : ProviderTransform.options({
        model: input.model,
        sessionID: input.sessionID,
        providerOptions: input.provider.options,
      })
  const options = mergeOptions(mergeOptions(mergeOptions(base, input.model.options), input.agent.options), variant)
  if (
    input.model.api.npm === "@ai-sdk/azure" &&
    (input.provider.options.useCompletionUrls || input.model.options.useCompletionUrls || options.useCompletionUrls)
  ) {
    delete options.reasoningSummary
    delete options.include
  }
  if (isOpenaiOauth) options.instructions = system.join("\n")

  const messages =
    isOpenaiOauth || input.isWorkflow
      ? input.messages
      : [
          ...system.map(
            (x): ModelMessage => ({
              role: "system",
              content: x,
            }),
          ),
          ...input.messages,
        ]

  const params = yield* input.plugin.trigger(
    "chat.params",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      temperature: input.model.capabilities.temperature
        ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
        : undefined,
      topP: input.agent.topP ?? ProviderTransform.topP(input.model),
      topK: ProviderTransform.topK(input.model),
      // No limit declared on a self-hosted server: asking for a fixed amount can itself exceed its window (vLLM counts
      // the request as prompt plus max_tokens), so a model with 32k refused even a short first message. It knows best.
      maxOutputTokens:
        input.model.limit.output === 0 && input.model.api.npm === "@ai-sdk/openai-compatible"
          ? undefined
          : ProviderTransform.maxOutputTokens(input.model, input.flags.outputTokenMax),
      options,
    },
  )

  const { headers } = yield* input.plugin.trigger(
    "chat.headers",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      headers: {},
    },
  )

  // A model that cannot use tools rejects any request that lists them, so it gets a plain chat instead of an error.
  const tools = input.model.capabilities.toolcall ? resolveTools(input) : {}
  // Codex parity: OpenAI Responses-family providers hardcode `strict: false`
  // on every function tool so MCP-sourced and dynamic schemas that don't
  // satisfy OpenAI's structured-outputs constraints still register.
  if (
    input.model.api.npm === "@ai-sdk/openai" ||
    input.model.api.npm === "@ai-sdk/azure" ||
    input.model.api.npm === "@ai-sdk/amazon-bedrock/mantle"
  ) {
    for (const key of Object.keys(tools)) tools[key] = { ...tools[key], strict: false }
  }
  if (
    input.model.providerID.includes("github-copilot") &&
    Object.keys(tools).length === 0 &&
    hasToolCalls(input.messages)
  ) {
    // Copilot needs a tools field when replaying prior tool calls, even if no tools are currently enabled.
    tools["_noop"] = aiTool({
      description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          reason: { type: "string", description: "Unused" },
        },
      }),
      execute: async () => ({ output: "", title: "", metadata: {} }),
    })
  }

  const opencodeProjectID = input.model.providerID.startsWith("opencode")
    ? (yield* InstanceState.context).project.id
    : undefined

  // F0 (1.3.2): write down what this turn was actually offered. Nothing recorded it before, so an empty or shrunken
  // tool set could not be told apart from a call that never happened (C59). One line per provider turn, because
  // session/llm.ts:106 is prepare's only call site. Read `toolSetFields` below before trusting a count: the grouping is
  // derived from config, and F-N4 names the four cases where that disagrees with what was offered.
  yield* Effect.logInfo("provider tool set", toolSetFields(input, tools))

  return {
    system,
    messages,
    tools: Object.fromEntries(Object.entries(tools).toSorted(([a], [b]) => a.localeCompare(b))),
    params,
    messageTransformOptions: options,
    headers: {
      "x-swarm-session-id": input.sessionID,
      ...(input.parentSessionID ? { "x-swarm-parent-session-id": input.parentSessionID } : {}),
      ...(input.model.providerID.startsWith("opencode")
        ? {
            ...(opencodeProjectID ? { "x-opencode-project": opencodeProjectID } : {}),
            "x-opencode-session": input.sessionID,
            "x-opencode-request": input.user.id,
            "x-opencode-client": input.flags.client,
            "User-Agent": USER_AGENT,
          }
        : {
            "x-session-affinity": input.sessionID,
            "X-Session-Id": input.sessionID,
            "User-Agent": USER_AGENT,
          }),
      ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
      ...input.model.headers,
      ...headers,
    },
  }
})

function resolveTools(input: Pick<PrepareInput, "tools" | "agent" | "permission" | "user">) {
  const disabled = Permission.disabled(
    Object.keys(input.tools),
    Permission.merge(input.agent.permission, input.permission ?? []),
  )
  return Record.filter(input.tools, (_, k) => input.user.tools?.[k] !== false && !disabled.has(k))
}

/** F0: the hard ceiling of one provider tool set line, enforced here because the appender writes what it is handed. */
const TOOL_SET_MAX_BYTES = 2_048
/** F0: how many keys the anomaly case names before it reports the rest as `keysOmitted`. */
const TOOL_SET_MAX_KEYS = 32
/** F0: what `timestamp`, `level`, `run`, `message` and the separators around the fields cost. */
const TOOL_SET_ENVELOPE = 160
/** F0/NB-2 (row 24): room held back for the omission markers themselves, so adding one cannot breach the ceiling. */
const TOOL_SET_MARKER_SLACK = 96

/**
 * F0 (1.3.2): the fields of the one provider tool set line per turn.
 *
 * Flat dotted keys, because the appender dot-joins nested plain objects but not arrays, and quotes any value holding
 * whitespace (`packages/core/src/observability/logging.ts:23-46`). Grouping uses the sanitised server name, because
 * that is what composes the key (`McpCatalog.toolName` at `mcp/catalog.ts:292`); a raw config name with a dot or a
 * space would never match. The full key list appears only when an enabled server contributed nothing, which is the
 * one case where counting is not enough to read the line.
 *
 * NB-2 (row 24): the 2,048 B ceiling is per line, so it is checked over the assembled fields and not only over `keys`.
 * Over the ceiling, the per-server counts coarsen to one total and the zero list is cut, each reported rather than
 * dropped. F-I2: the markers are given their own slack so reporting a cut cannot itself breach the ceiling.
 *
 * F-N4 (row 18): grouping is derived from config, while the line claims what was offered, and the two disagree in four
 * cases a reader should know about. (1) A builtin or plugin tool whose name happens to start like a server prefix is
 * counted under that server — `apply_patch` (`tool/apply_patch.ts:30`) and `plan_exit` (`tool/plan.ts:20`) are the two
 * shipped names with an underscore in them, so a server configured as `apply` absorbs the builtin, and its own empty
 * contribution disappears from `zeroToolServers`. (2) Config drifts from a live instance: `State` is built once per
 * directory (`mcp/index.ts:794` builds `State` per directory), so a removed-but-still-connected server's tools land in `nonMcpCount` and a
 * newly-added-not-yet-connected server cries `zeroToolServers` every turn. (3) `sanitize` collisions merge counts: `a.b`
 * and `a_b` both group under `a_b`. (4) A SEC-13 refusal or a missing-`type` ignore keeps its name in
 * `zeroToolServers` forever — not a lie, since those routes log their own lines, but read it together with them.
 * Reading `zeroToolServers` as "configured and enabled and offered nothing" is correct; reading it as "connected and
 * offered nothing" is not. The precise fix is threading per-key source from `session/tools.ts:609`, not importing
 * `MCP.Service` here.
 */
function toolSetFields(input: PrepareInput, tools: Record<string, Tool>) {
  const servers = [...new Set((input.mcpServers ?? []).map(McpCatalog.sanitize))]
    .filter((name) => name.length > 0)
    .sort((a, b) => b.length - a.length)
  const offered = Object.keys(tools)
  const counts = new Map<string, number>()
  let nonMcpCount = 0
  for (const key of offered) {
    const server = servers.find((name) => key.startsWith(`${name}_`))
    if (!server) {
      nonMcpCount++
      continue
    }
    counts.set(server, (counts.get(server) ?? 0) + 1)
  }
  const zeroServers = servers.filter((name) => !counts.has(name))
  const identity: Record<string, string | number> = {
    "session.id": input.sessionID,
    "model.id": input.model.id,
    toolCount: offered.length,
    nonMcpCount,
  }
  const fields: Record<string, string | number> = {
    ...identity,
    ...Object.fromEntries([...counts].map(([name, count]) => [`mcp.${name}`, count])),
    zeroToolServers: zeroServers.join(","),
  }

  // Over the ceiling the counts coarsen and the zero list is cut; both say so on the line.
  if (renderedFields(fields) > TOOL_SET_MAX_BYTES - TOOL_SET_ENVELOPE - TOOL_SET_MARKER_SLACK) {
    const kept = fitList(zeroServers, TOOL_SET_MAX_BYTES - TOOL_SET_ENVELOPE - TOOL_SET_MARKER_SLACK - renderedFields(identity) - "zeroToolServers=".length - "mcpCountsCoarsened=999".length)
    const coarse: Record<string, string | number> = {
      ...identity,
      mcpTotal: [...counts.values()].reduce((sum, count) => sum + count, 0),
      mcpCountsCoarsened: counts.size,
      zeroToolServers: kept.joined,
    }
    if (kept.omitted > 0) coarse.zeroToolServersOmitted = kept.omitted
    if (zeroServers.length === 0) return coarse
    return listOfferedKeys(coarse, offered, TOOL_SET_MAX_BYTES - TOOL_SET_ENVELOPE - TOOL_SET_MARKER_SLACK - renderedFields(coarse) - "keys=".length - KEY_OMISSION_SLACK)
  }

  if (!fields.zeroToolServers) return fields
  return listOfferedKeys(fields, offered, TOOL_SET_MAX_BYTES - TOOL_SET_ENVELOPE - TOOL_SET_MARKER_SLACK - renderedFields(fields) - "keys=".length - KEY_OMISSION_SLACK)
}

/** What it costs to add `keysOmitted=<n>` when the key list is cut. */
const KEY_OMISSION_SLACK = " keysOmitted=99999".length

/** Names the offered keys that fit the remaining budget, at most TOOL_SET_MAX_KEYS of them, and reports the cut. */
function listOfferedKeys(
  fields: Record<string, string | number>,
  offered: readonly string[],
  available: number,
) {
  const kept = fitList(offered, available, TOOL_SET_MAX_KEYS)
  // An empty `keys=` would read as "nothing was offered", so the cut is carried by `keysOmitted` alone.
  if (kept.joined.length > 0) fields.keys = kept.joined
  if (kept.omitted > 0) fields.keysOmitted = kept.omitted
  return fields
}

/** Joins as many leading entries as fit `available` bytes, comma-separated, and counts what fell out. */
function fitList(entries: readonly string[], available: number, limit = entries.length) {
  const named: string[] = []
  let used = 0
  for (const entry of entries) {
    if (named.length >= limit) break
    const cost = entry.length + (named.length > 0 ? 1 : 0)
    if (used + cost > available) break
    used += cost
    named.push(entry)
  }
  return { joined: named.join(","), omitted: entries.length - named.length }
}

function renderedFields(fields: Record<string, string | number>) {
  return Object.entries(fields).reduce((total, [key, value]) => total + key.length + String(value).length + 2, 0)
}

export function hasToolCalls(messages: ModelMessage[]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type === "tool-call" || part.type === "tool-result") return true
    }
  }
  return false
}

export * as LLMRequestPrep from "./request"
