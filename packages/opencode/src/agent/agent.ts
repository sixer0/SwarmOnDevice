import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Config } from "@/config/config"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Provider } from "@/provider/provider"

import { generateObject, streamObject, type ModelMessage } from "ai"
import { Truncate } from "@/tool/truncate"
import { Auth } from "../auth"
import { ProviderTransform } from "@/provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import PROMPT_PLANNER from "./prompt/planner.txt"
import PROMPT_VERIFIER from "./prompt/verifier.txt"
import PROMPT_DATA_COLLECTOR from "./prompt/data-collector.txt"
import PROMPT_DOCUMENT_WRITER from "./prompt/document-writer.txt"
import { Permission } from "@/permission"
import { DATUM_STUDIO_MCP } from "@/mcp/datum-studio"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import { Plugin } from "@/plugin"
import { Skill } from "../skill"
import { Effect, Context, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { AbsolutePath, type DeepMutable } from "@opencode-ai/core/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Reference } from "@opencode-ai/core/reference"
import { Location } from "@opencode-ai/core/location"
import { PluginV2 } from "@opencode-ai/core/plugin"

/** Row 198 (D1): the Studio tool that records the person's answer to a mission decision, as it reaches the model. */
export const ANSWER_DECISION_TOOL = `${DATUM_STUDIO_MCP}_studio_mission_answer_decision`

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  native: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  topP: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  color: Schema.optional(Schema.String),
  permission: PermissionV1.Ruleset,
  model: Schema.optional(
    Schema.Struct({
      modelID: ModelV2.ID,
      providerID: ProviderV2.ID,
    }),
  ),
  variant: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Unknown),
  steps: Schema.optional(Schema.Finite),
}).annotate({ identifier: "Agent" })
export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>

const GeneratedAgent = Schema.Struct({
  identifier: Schema.String,
  whenToUse: Schema.String,
  systemPrompt: Schema.String,
})

export interface Interface {
  readonly get: (agent: string) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Info[]>
  readonly defaultInfo: () => Effect.Effect<Info>
  readonly defaultAgent: () => Effect.Effect<string>
  readonly generate: (input: {
    description: string
    model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
  }) => Effect.Effect<
    {
      identifier: string
      whenToUse: string
      systemPrompt: string
    },
    Provider.DefaultModelError
  >
}

type State = Omit<Interface, "generate">

export class Service extends Context.Service<Service, Interface>()("@opencode/Agent") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const auth = yield* Auth.Service
    const plugin = yield* Plugin.Service
    const skill = yield* Skill.Service
    const provider = yield* Provider.Service
    const locations = yield* LocationServiceMap.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Agent.state")(function* (ctx) {
        const cfg = yield* config.get()
        const skillDirs = yield* skill.dirs()
        const referenceDirs = Object.keys(cfg.references ?? cfg.reference ?? {}).length
          ? yield* Effect.gen(function* () {
              yield* (yield* PluginV2.Service).wait(PluginV2.ID.make("core/config-reference"))
              return (yield* (yield* Reference.Service).list()).map((reference) => reference.path)
            }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))))
          : []
        const whitelistedDirs = [
          Truncate.GLOB,
          path.join(Global.Path.tmp, "*"),
          ...skillDirs.map((dir) => path.join(dir, "*")),
          ...referenceDirs.map((dir) => path.join(dir, "*")),
        ]
        const readonlyExternalDirectory = {
          "*": "ask",
          ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
        } satisfies Record<string, "allow" | "ask" | "deny">

        const defaults = Permission.fromConfig({
          "*": "allow",
          doom_loop: "ask",
          external_directory: {
            "*": "ask",
            ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
          },
          question: "deny",
          plan_enter: "deny",
          plan_exit: "deny",
          // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
          read: {
            "*": "allow",
            "*.env": "ask",
            "*.env.*": "ask",
            "*.env.example": "allow",
          },
        }, { shipped: true })

        const user = Permission.fromConfig(cfg.permission ?? {})

        // Spec 161 D4 (1.2.2): the specialists' rules are merged AFTER `user`, because the shipped baseline in `user`
        // starts with "*": "ask" and evaluate() takes the last match (F1). They hold targeted denies only, never a
        // catch-all, so the baseline's bash gates (sudo deny, curl/python ask, ...) stay in force (F2). A person can
        // still loosen one specialist through `agent.<name>.permission`, which merges after this (see the loop below).
        const specialist = (extra: Record<string, unknown> = {}) =>
          Permission.fromConfig(
            {
              todowrite: "deny",
              task: "deny",
              "swarm-web_*": "deny",
              webfetch: "deny",
              websearch: "deny",
              // A child cannot run the controller workflow (it cannot delegate), so it may not load it (spec 161 C5,
              // spec 191 §3.1: Swarm's own swarm-workflow and a claude_compat master-controller alike).
              skill: { "master-controller": "deny", "swarm-workflow": "deny" },
              ...extra,
            } as Parameters<typeof Permission.fromConfig>[0],
            { shipped: true },
          )
        const markdownOnly = { edit: { "*": "deny", "*.md": "ask" }, bash: "deny" }
        // Row 198 (decision L61, checklist D1, S194-02 / S186-03): answering a mission decision is the person's answer.
        // Mission Control answers it through the desktop bridge (window.api.missions -> mission-client.ts, straight to the
        // Studio host), never through an agent's tools, so no agent may call the Studio tool. Merged into every agent
        // last, after `user` and after `agent.<name>.permission` (see the loop below), so neither a person's config nor
        // a standing "always" reopens it (S163-01: an agent's own deny is final). A deny on "*" also hides the tool.
        const personOnly = Permission.fromConfig({ [ANSWER_DECISION_TOOL]: "deny" }, { shipped: true })

        const agents: Record<string, Info> = {
          build: {
            name: "build",
            description: "The default agent. Executes tools based on configured permissions.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_enter: "allow",
              }, { shipped: true }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          plan: {
            name: "plan",
            description: "Plan mode. Disallows all edit tools.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_exit: "allow",
                task: {
                  general: "deny",
                },
                external_directory: {
                  [path.join(Global.Path.data, "plans", "*")]: "allow",
                },
                edit: {
                  "*": "deny",
                  [path.join(".swarm", "plans", "*.md")]: "allow",
                  [path.relative(ctx.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
                },
              }, { shipped: true }),
              user,
              // Spec 161 D10: plan is read-only, so it may never hand work to an editing subagent. Placed after `user`
              // so it binds over the baseline (F1). The `general` deny above keeps its old place, so the tested user
              // escape hatch (`permission.task.general: allow`) still works.
              Permission.fromConfig({ task: { coder: "deny", "document-writer": "deny" } }, { shipped: true }),
            ),
            mode: "primary",
            native: true,
          },
          general: {
            name: "general",
            description: `Fallback agent for multi-step work that no other agent in this list fits. Prefer the agent whose description matches the work. Use general to run several unrelated units of work in parallel.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "deny",
              }, { shipped: true }),
              user,
            ),
            options: {},
            mode: "subagent",
            native: true,
          },
          explore: {
            name: "explore",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                grep: "allow",
                glob: "allow",
                list: "allow",
                bash: "allow",
                webfetch: "allow",
                websearch: "allow",
                read: "allow",
                external_directory: readonlyExternalDirectory,
              }, { shipped: true }),
              user,
            ),
            description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
            prompt: PROMPT_EXPLORE,
            options: {},
            mode: "subagent",
            native: true,
          },
          // Spec 161 (1.2.2): specialist subagents. Descriptions per spec section 5, with the row 163 wording
          // (decision L21): "no web tools", and the verifier "does not use edit tools" (its shell still asks).
          coder: {
            name: "coder",
            description: `Implements code and config changes: a specified build row, a bug fix, a refactor, or tests to write and make pass. Edits files, runs the project's checks, and reports the files changed and the check results. No web tools. Use when the work changes code. Also the role called coder-execution, database-specialist, git-specialist or docker-specialist in workflow texts.`,
            // No prompt (D3): it keeps the provider prompt and the gsp_workflow block that `general` runs on today.
            permission: Permission.merge(defaults, user, specialist()),
            options: {},
            mode: "subagent",
            native: true,
          },
          planner: {
            name: "planner",
            description: `Plans and analyses without changing code: states the intent, writes a blueprint or spec, or analyses collected findings and recommends. Reads the project and may write Markdown documents only. No shell and no web tools. Use for intent, blueprint, analysis and spec steps. Also the role called request-translator, task-architect, data-analyst, pm-analyst or pm-planner in workflow texts.`,
            prompt: PROMPT_PLANNER,
            permission: Permission.merge(defaults, user, specialist(markdownOnly)),
            options: {},
            mode: "subagent",
            native: true,
          },
          verifier: {
            name: "verifier",
            description: `Checks finished work against its criteria and reports pass or fail with evidence: runs tests and checks, reviews a diff, a test report or the security of a change. Does not use edit tools; its shell commands still ask. No web tools. Use after implementation and before a gate or a report. Reads images (vision): it can check a rendered page, a figure or a screenshot by eye. Can act as a blind judge: it compares two sides given without project context and without knowing which side is the candidate. Also the role called verifier, senior-code-reviewer, security-review or pm-verifier, and test-expert when tests are run rather than written.`,
            prompt: PROMPT_VERIFIER,
            permission: Permission.merge(defaults, user, specialist({ edit: "deny" })),
            options: {},
            mode: "subagent",
            native: true,
          },
          "data-collector": {
            name: "data-collector",
            description: `Reads and digests material the person already has: project files, notes, PDF, DOCX and XLSX documents, earlier reports. Returns facts with their source paths and may write a Markdown collection file. No shell and no web tools. Use for read-and-summarise jobs, inventories and extractions. Also the role called data-collector or document-reader. For code search use explore; for the public web use researcher.`,
            prompt: PROMPT_DATA_COLLECTOR,
            permission: Permission.merge(defaults, user, specialist(markdownOnly)),
            options: {},
            mode: "subagent",
            native: true,
          },
          "document-writer": {
            name: "document-writer",
            description: `Produces finished documents for a reader in the GSP house style: DOCX, PDF, HTML, XLSX and PPTX, through the datum-house-style skill and the datum-studio tools, and runs the house-style checks before it reports. No web tools. Use when the deliverable is a document rather than code. Also the role called document-writer, pm-writer, document-converter or document-translator.`,
            prompt: PROMPT_DOCUMENT_WRITER,
            permission: Permission.merge(defaults, user, specialist()),
            options: {},
            mode: "subagent",
            native: true,
          },
          compaction: {
            name: "compaction",
            mode: "primary",
            native: true,
            hidden: true,
            prompt: PROMPT_COMPACTION,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }, { shipped: true }),
              user,
            ),
            options: {},
          },
          title: {
            name: "title",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            temperature: 0.5,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }, { shipped: true }),
              user,
            ),
            prompt: PROMPT_TITLE,
          },
          summary: {
            name: "summary",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }, { shipped: true }),
              user,
            ),
            prompt: PROMPT_SUMMARY,
          },
        }

        for (const [key, value] of Object.entries(cfg.agent ?? {})) {
          if (value.disable) {
            delete agents[key]
            continue
          }
          let item = agents[key]
          if (!item)
            item = agents[key] = {
              name: key,
              mode: "all",
              permission: Permission.merge(defaults, user),
              options: {},
              native: false,
            }
          if (value.model) item.model = Provider.parseModel(value.model)
          item.variant = value.variant ?? item.variant
          item.prompt = value.prompt ?? item.prompt
          item.description = value.description ?? item.description
          item.temperature = value.temperature ?? item.temperature
          item.topP = value.top_p ?? item.topP
          item.mode = value.mode ?? item.mode
          item.color = value.color ?? item.color
          item.hidden = value.hidden ?? item.hidden
          item.name = value.name ?? item.name
          item.steps = value.steps ?? item.steps
          item.options = mergeDeep(item.options, value.options ?? {})
          item.permission = Permission.merge(item.permission, Permission.fromConfig(value.permission ?? {}))
        }

        for (const name in agents) agents[name].permission = Permission.merge(agents[name].permission, personOnly)

        // Ensure Truncate.GLOB is allowed unless explicitly configured
        for (const name in agents) {
          const agent = agents[name]
          const explicit = agent.permission.some((r) => {
            if (r.permission !== "external_directory") return false
            if (r.action !== "deny") return false
            return r.pattern === Truncate.GLOB
          })
          if (explicit) continue

          agents[name].permission = Permission.merge(
            agents[name].permission,
            Permission.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }, { shipped: true }),
          )
        }

        const get = Effect.fnUntraced(function* (agent: string) {
          return agents[agent]
        })

        const list = Effect.fnUntraced(function* () {
          const cfg = yield* config.get()
          return pipe(
            agents,
            values(),
            sortBy(
              [(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "build"), "desc"],
              [(x) => x.name, "asc"],
            ),
          )
        })

        const defaultInfo = Effect.fnUntraced(function* () {
          const c = yield* config.get()
          if (c.default_agent) {
            const agent = agents[c.default_agent]
            if (!agent) throw new Error(`default agent "${c.default_agent}" not found`)
            if (agent.mode === "subagent") throw new Error(`default agent "${c.default_agent}" is a subagent`)
            if (agent.hidden === true) throw new Error(`default agent "${c.default_agent}" is hidden`)
            return agent
          }
          const visible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
          if (!visible) throw new Error("no primary visible agent found")
          return visible
        })

        const defaultAgent = Effect.fnUntraced(function* () {
          return (yield* defaultInfo()).name
        })

        return {
          get,
          list,
          defaultInfo,
          defaultAgent,
        } satisfies State
      }),
    )

    return Service.of({
      get: Effect.fn("Agent.get")(function* (agent: string) {
        return yield* InstanceState.useEffect(state, (s) => s.get(agent))
      }),
      list: Effect.fn("Agent.list")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.list())
      }),
      defaultInfo: Effect.fn("Agent.defaultInfo")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultInfo())
      }),
      defaultAgent: Effect.fn("Agent.defaultAgent")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultAgent())
      }),
      generate: Effect.fn("Agent.generate")(function* (input: {
        description: string
        model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      }) {
        const cfg = yield* config.get()
        const model = input.model ?? (yield* provider.defaultModel())
        const resolved = yield* provider.getModel(model.providerID, model.modelID)
        const language = yield* provider.getLanguage(resolved)
        const tracer = cfg.experimental?.openTelemetry
          ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
          : undefined

        const system = [PROMPT_GENERATE]
        yield* plugin.trigger("experimental.chat.system.transform", { model: resolved }, { system })
        const existing = yield* InstanceState.useEffect(state, (s) => s.list())

        // TODO: clean this up so provider specific logic doesnt bleed over
        const authInfo = yield* auth.get(model.providerID).pipe(Effect.orDie)
        const isOpenaiOauth = model.providerID === "openai" && authInfo?.type === "oauth"

        const params = {
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            tracer,
            metadata: {
              userId: cfg.username ?? "unknown",
            },
          },
          temperature: 0.3,
          messages: [
            ...(isOpenaiOauth
              ? []
              : system.map(
                  (item): ModelMessage => ({
                    role: "system",
                    content: item,
                  }),
                )),
            {
              role: "user",
              content: `Create an agent configuration based on this request: "${input.description}".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
            },
          ],
          model: language,
          schema: Object.assign(
            Schema.toStandardSchemaV1(GeneratedAgent),
            Schema.toStandardJSONSchemaV1(GeneratedAgent),
          ),
        } satisfies Parameters<typeof generateObject>[0]

        if (isOpenaiOauth) {
          return yield* Effect.promise(async () => {
            const result = streamObject({
              ...params,
              providerOptions: ProviderTransform.providerOptions(resolved, {
                instructions: system.join("\n"),
                store: false,
              }),
              onError: () => {},
            })
            for await (const part of result.fullStream) {
              if (part.type === "error") throw part.error
            }
            return result.object
          })
        }

        return yield* Effect.promise(() => generateObject(params).then((r) => r.object))
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
  deps: [Config.node, Auth.node, Plugin.node, Skill.node, Provider.node, locationServiceMapNode],
})

export * as Agent from "./agent"
