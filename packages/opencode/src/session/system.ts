import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"

import { InstanceState } from "@/effect/instance-state"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_ASTRA from "./prompt/gpt-astra.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"
import PROMPT_META from "./prompt/meta.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import PROMPT_GSP_WORKFLOW from "./prompt/gsp-workflow.txt"
import PROMPT_AUTO_WORKFLOW from "./prompt/auto-workflow.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Reference } from "@opencode-ai/core/reference"
import { MCP } from "@/mcp"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { InstalledTools } from "./installed-tools"

/** One fixed line per component (U14 register, identification/04_structured_u14.md section 3). Only these strings
 *  reach the prompt: the state file decides which lines appear, never what they say. */
const INSTALLED_TOOL_LINES: Record<InstalledTools.ComponentId, { text: string; mcp?: string }> = {
  runtime: { text: "runtime: container runtime for the tool stacks. Do not manage it yourself." },
  node: { text: "node: private Node.js used by the tools only." },
  graft: {
    text: "graft: use the graft MCP tools to find code, callers and blast radius before grep or reading files by hand.",
    mcp: InstalledTools.GRAFT_MCP,
  },
  rtk: { text: "rtk: prefix commands with long output with `rtk` (for example `rtk bun test`, `rtk git log`)." },
  searxng: {
    text: "web search: use the swarm-web `search` tool (local SearXNG) as the default web search.",
    mcp: InstalledTools.SWARM_WEB_MCP,
  },
  firecrawl: {
    text: "crawl: use swarm-web `fetch` with mode=crawl (local Firecrawl); mode=page for a single page.",
    mcp: InstalledTools.SWARM_WEB_MCP,
  },
  obsidian: {
    text: "notes: use swarm-web `vault_inbox` to drop a note in the Obsidian inbox. It is not the memory store.",
    mcp: InstalledTools.SWARM_WEB_MCP,
  },
}

/** The `<installed_tools>` block, or undefined when no line applies. Lines follow COMPONENT_IDS order. A line that
 *  tells the agent to use an MCP server (graft, and the three swarm-web lines) needs that server `connected`, since a
 *  healthy component is useless to the agent without its tools (C76; senior review 239 finding 10a for graft).
 *  `connected` holds the MCP keys whose status is `connected`. The lead line is part of the U14 register (C86). */
export function installedTools(healthy: readonly InstalledTools.ComponentId[], connected: readonly string[]) {
  const lines = InstalledTools.COMPONENT_IDS.filter((id) => healthy.includes(id))
    .map((id) => INSTALLED_TOOL_LINES[id])
    .filter((line) => line.mcp === undefined || connected.includes(line.mcp))
    .map((line) => `  ${line.text}`)
  if (lines.length === 0) return
  return [
    "Swarm tools installed and healthy on this machine:",
    "<installed_tools>",
    ...lines,
    "</installed_tools>",
  ].join("\n")
}

export function provider(model: Provider.Model) {
  if (model.api.id.includes("muse")) {
    const name = model.api.id.includes("muse-glimmer") ? "Muse Glimmer" : "Muse Spark"
    return [PROMPT_META.replaceAll("{{MODEL_NAME}}", name)]
  }
  if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
    return [PROMPT_BEAST]
  if (model.api.id.includes("gpt")) {
    if (model.api.id.includes("gpt-6")) return [PROMPT_ASTRA]
    if (model.api.id.includes("codex")) {
      return [PROMPT_CODEX]
    }
    return [PROMPT_GPT]
  }
  if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
  if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
  if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
  if (
    model.api.id.toLowerCase().includes("kimi") ||
    ["kimi-for-coding", "moonshotai", "moonshotai-cn"].includes(model.providerID)
  )
    return [PROMPT_KIMI]
  return [PROMPT_DEFAULT]
}

/** Agents that get the GSP workflow and language rule (specs S0.1, S4.2). The gate is the agent name, not the model,
 *  so every model gets the block; `plan` and the hidden agents (`explore`, `compaction`, `title`, `summary`) do not.
 *  `coder` keeps the exact prompt stack `general` has, since it takes over most of general's work (spec 161 D3). */
export const GSP_WORKFLOW_AGENTS: ReadonlySet<string> = new Set(["build", "coder", "general"])

/** The `<gsp_workflow>` block for `agentName`, or nothing (specs S4.2-S4.5, S5.1). */
export function workflow(agentName: string): string[] {
  return GSP_WORKFLOW_AGENTS.has(agentName) ? [PROMPT_GSP_WORKFLOW] : []
}

/** The only agent whose prompt carries the routing and auto workflow blocks: the main thread (spec 161 §7, D11.1). */
const ROUTING_AGENT = "build"

/** One fixed line per shipped subagent, in this order (spec 161 §7, D7). The registry decides which lines appear,
 *  never what they say, so no user or project agent text reaches the system prompt. */
const ROUTING_LINES: readonly { name: string; text: string; mcp?: string }[] = [
  { name: "planner", text: "- planner: intent, blueprint, analysis or spec; no code changes." },
  { name: "coder", text: "- coder: implement, fix or refactor code and make its checks pass." },
  { name: "verifier", text: "- verifier: check finished work against its criteria, review, run tests; never edits." },
  { name: "data-collector", text: "- data-collector: read and digest the person's own files and documents." },
  { name: "document-writer", text: "- document-writer: DOCX, PDF, XLSX or PPTX deliverables in the house style." },
  { name: "explore", text: "- explore: find files and code in this codebase." },
  // researcher only has the swarm-web tools, so it is useless without that server (spec 161 F3, D7).
  { name: "researcher", text: "- researcher: search and read the public web.", mcp: InstalledTools.SWARM_WEB_MCP },
]

const ROUTING_HEAD = [
  "<agent_routing>",
  "Delegate a step with the task tool when it needs its own context. Choose the agent by the kind of work; use general only when no agent below fits.",
]

/** The `<agent_routing>` block for `agentName`, or nothing (spec 161 §7, SA-08). A line appears only when its agent is
 *  registered, not primary, not hidden, `canTask` lets the caller start it (the test describeTask uses) and, for
 *  researcher, its MCP server is connected. Fewer than 2 lines give nothing. */
export function routing(
  agentName: string,
  agents: readonly { name: string; mode: string; hidden?: boolean }[],
  canTask: (name: string) => boolean,
  connectedMcp: readonly string[],
): string[] {
  if (agentName !== ROUTING_AGENT) return []
  const lines = ROUTING_LINES.filter((line) => {
    const item = agents.find((agent) => agent.name === line.name)
    if (!item || item.mode === "primary" || item.hidden) return false
    if (line.mcp !== undefined && !connectedMcp.includes(line.mcp)) return false
    return canTask(line.name)
  }).map((line) => line.text)
  if (lines.length < 2) return []
  return [[...ROUTING_HEAD, ...lines, "</agent_routing>"].join("\n")]
}

/** The workflow skill the auto rule loads: Swarm's own built-in (spec 191 §4, L49; was the user's master-controller). */
export const AUTO_WORKFLOW_SKILL = "swarm-workflow"

/** The `<auto_workflow>` block for `agentName`, or nothing (spec 161 D11, SA-21 to SA-23; spec 191 §4). Only for build,
 *  only while the agent may start subagents, and only when `skills` (the agent's available list) holds the built-in
 *  `swarm-workflow`. The name is reserved, so a disk copy (user or project) is never listed under it and can never
 *  choose the workflow that is followed unasked (R9); a skill denied to the agent is not in its list. */
export function autoWorkflow(
  agentName: string,
  skills: readonly { name: string; location: string }[],
  canTask = true,
): string[] {
  if (agentName !== ROUTING_AGENT || !canTask) return []
  const found = skills.find((item) => item.name === AUTO_WORKFLOW_SKILL)
  if (!found || found.location !== "<built-in>") return []
  return [PROMPT_AUTO_WORKFLOW]
}

export { PROMPT_GSP_WORKFLOW, PROMPT_AUTO_WORKFLOW }

export interface Interface {
  readonly environment: (model: Provider.Model) => Effect.Effect<string[]>
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
  readonly mcp: (agent: Agent.Info, permission?: PermissionV1.Ruleset) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const mcp = yield* MCP.Service
    const locations = yield* LocationServiceMap.Service

    return Service.of({
      environment: Effect.fn("SystemPrompt.environment")(function* (model: Provider.Model) {
        const ctx = yield* InstanceState.context
        const references = yield* Effect.gen(function* () {
          return (yield* (yield* Reference.Service).list()).filter((reference) => reference.description !== undefined)
        }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))))
        // Read fresh on every call: the prompt loop calls this once per person message, so a tool installed or
        // removed mid-session shows from the next message on, and subagent sessions run the same loop.
        const healthy = yield* InstalledTools.healthy()
        const tools =
          healthy.length === 0
            ? undefined
            : installedTools(
                healthy,
                Object.entries(yield* mcp.status())
                  .filter(([, entry]) => entry.status === "connected")
                  .map(([key]) => key),
              )
        return [
          [
            `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
            `Here is some useful information about the environment you are running in:`,
            `<env>`,
            `  Working directory: ${ctx.directory}`,
            `  Workspace root folder: ${ctx.worktree}`,
            `  Is directory a git repo: ${ctx.project.vcs === "git" ? "yes" : "no"}`,
            `  Platform: ${process.platform}`,
            `  Today's date: ${new Date().toDateString()}`,
            `</env>`,
          ].join("\n"),
          references.length === 0
            ? undefined
            : [
                "Project references provide additional directories that can be accessed when relevant.",
                "<available_references>",
                ...references
                  .toSorted((a, b) => a.name.localeCompare(b.name))
                  .flatMap((reference) => [
                    "  <reference>",
                    `    <name>${reference.name}</name>`,
                    `    <path>${reference.path}</path>`,
                    ...(reference.description === undefined
                      ? []
                      : [`    <description>${reference.description}</description>`]),
                    "  </reference>",
                  ]),
                "</available_references>",
              ].join("\n"),
          tools,
        ].filter((part): part is string => part !== undefined)
      }),

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const list = yield* skill.available(agent)

        return [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          // the agents seem to ingest the information about skills a bit better if we present a more verbose
          // version of them here and a less verbose version in tool description, rather than vice versa.
          Skill.fmt(list, { verbose: true }),
        ].join("\n")
      }),

      mcp: Effect.fn("SystemPrompt.mcp")(function* (agent: Agent.Info, permission?: PermissionV1.Ruleset) {
        const ruleset = Permission.merge(agent.permission, permission ?? [])
        const instructions = (yield* mcp.instructions()).filter(
          (item) => item.tools.length === 0 || Permission.disabled(item.tools, ruleset).size < item.tools.length,
        )
        if (instructions.length === 0) return

        return [
          "<mcp_instructions>",
          ...instructions.flatMap((item) => [
            `  <server name="${item.name}">`,
            ...item.instructions.split("\n").map((line) => `    ${line}`),
            "  </server>",
          ]),
          "</mcp_instructions>",
        ].join("\n")
      }),
    })
  }),
)

const locationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: locationServiceMapLayer,
  deps: [],
})

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Skill.node, MCP.node, locationServiceMapNode],
})

export * as SystemPrompt from "./system"
