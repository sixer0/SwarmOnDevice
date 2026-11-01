import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectTrust } from "@opencode-ai/core/project/trust"
import path from "path"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import type { InstanceContext } from "@/project/instance-context"
import { Effect, Layer, Context, Schema } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Config } from "@/config/config"
import { ConfigCommand } from "@/config/command"
import { MCP } from "../mcp"
import { Skill } from "../skill"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_REVIEW from "./template/review.txt"
import { LegacyEvent } from "@opencode-ai/schema/legacy-event"

type State = {
  commands: Record<string, Info>
  /** Names that came from a file when this instance started, so one deleted since can disappear. */
  fromFiles: Set<string>
}

export const Event = {
  Executed: LegacyEvent.CommandExecuted,
}

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Literals(["command", "mcp", "skill"])),
  // Some command templates are lazy promises from MCP prompt resolution.
  template: Schema.Unknown,
  subtask: Schema.optional(Schema.Boolean),
  hints: Schema.Array(Schema.String),
}).annotate({ identifier: "Command" })

export type Info = Omit<Schema.Schema.Type<typeof Info>, "template"> & { template: Promise<string> | string }

export function hints(template: string) {
  const result: string[] = []
  const numbered = template.match(/\$\d+/g)
  if (numbered) {
    for (const match of [...new Set(numbered)].sort()) result.push(match)
  }
  if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
  return result
}

/** Where a project's saved commands live. Folders without git have no worktree to anchor to. */
export function projectDir(ctx: Pick<InstanceContext, "directory" | "worktree">) {
  return path.join(ctx.worktree === "/" ? ctx.directory : ctx.worktree, ".swarm")
}

function projectDirs(ctx: Pick<InstanceContext, "directory" | "worktree">) {
  return Flag.OPENCODE_DISABLE_PROJECT_CONFIG ? [] : [projectDir(ctx)]
}

export const Default = {
  INIT: "init",
  REVIEW: "review",
} as const

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Command") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const skill = yield* Skill.Service

    // Saved command files are read when asked for, so one saved a moment ago works now, in every open project, without
    // restarting anything. A broken file must not take the working ones down with it.
    const files = Effect.fnUntraced(function* (ctx: InstanceContext) {
      const found: Record<string, Awaited<ReturnType<typeof ConfigCommand.load>>[string]> = {}
      // The project's folder may have been created after this instance worked out its config directories.
      const dirs = new Set([...(yield* config.textDirectories()), ...projectDirs(ctx)])
      const trusted = ProjectTrust.isTrusted(ctx.directory)
      for (const dir of dirs) {
        const keep = trusted || ProjectTrust.isUserLevel(dir) ? undefined : ProjectTrust.isTextCommand
        Object.assign(found, yield* Effect.promise(() => ConfigCommand.load(dir, keep).catch(() => ({}))))
      }
      // The library's name is not a command, whoever offers one. A repo must not be able to answer in the library's place.
      delete found[Skill.KNOWLEDGE_LIBRARY_SKILL_NAME]
      return found
    })

    const fromConfig = (name: string, command: { template: string; agent?: string; model?: string; description?: string; subtask?: boolean }): Info => ({
      name,
      agent: command.agent,
      model: command.model,
      description: command.description,
      source: "command",
      get template() {
        return command.template
      },
      subtask: command.subtask,
      hints: hints(command.template),
    })

    const init = Effect.fn("Command.state")(function* (ctx: InstanceContext) {
      const cfg = yield* config.get()
      const bridge = yield* EffectBridge.make()
      const commands: Record<string, Info> = {}

      commands[Default.INIT] = {
        name: Default.INIT,
        description: "guided AGENTS.md setup",
        source: "command",
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", ctx.worktree)
        },
        hints: hints(PROMPT_INITIALIZE),
      }
      commands[Default.REVIEW] = {
        name: Default.REVIEW,
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        source: "command",
        get template() {
          return PROMPT_REVIEW.replace("${path}", ctx.worktree)
        },
        subtask: true,
        hints: hints(PROMPT_REVIEW),
      }

      for (const [name, command] of Object.entries(cfg.command ?? {})) {
        if (name === Skill.KNOWLEDGE_LIBRARY_SKILL_NAME) continue
        commands[name] = fromConfig(name, command)
      }

      for (const [name, prompt] of Object.entries(yield* mcp.prompts())) {
        if (name === Skill.KNOWLEDGE_LIBRARY_SKILL_NAME) continue
        commands[name] = {
          name,
          source: "mcp",
          description: prompt.description,
          get template() {
            return bridge.promise(
              mcp
                .getPrompt(
                  prompt.client,
                  prompt.name,
                  prompt.arguments
                    ? Object.fromEntries(prompt.arguments.map((argument, i) => [argument.name, `$${i + 1}`]))
                    : {},
                )
                .pipe(
                  Effect.map(
                    (template) =>
                      template?.messages
                        .map((message) => (message.content.type === "text" ? message.content.text : ""))
                        .join("\n") || "",
                  ),
                ),
            )
          },
          hints: prompt.arguments?.map((_, i) => `$${i + 1}`) ?? [],
        }
      }

      for (const item of yield* skill.all()) {
        if (commands[item.name] || item.name === Skill.KNOWLEDGE_LIBRARY_SKILL_NAME) continue
        const dir = item.location === "<built-in>" ? undefined : path.dirname(item.location)
        commands[item.name] = {
          name: item.name,
          description: item.description,
          source: "skill",
          get template() {
            if (!dir) return item.content
            return [
              item.content,
              "",
              `Base directory for this skill: ${dir}`,
              "Relative paths in this skill (e.g., scripts/, references/) are relative to this base directory.",
            ].join("\n")
          },
          hints: [],
        }
      }

      return {
        commands,
        fromFiles: new Set(Object.keys(yield* files(ctx))),
      }
    })

    const current = Effect.fnUntraced(function* () {
      const s = yield* InstanceState.get(state)
      const onDisk = yield* files(yield* InstanceState.context)
      const result = { ...s.commands }
      for (const name of s.fromFiles) {
        if (!onDisk[name] && result[name]?.source === "command") delete result[name]
      }
      for (const [name, command] of Object.entries(onDisk)) {
        const known = result[name]
        // An MCP prompt or a skill of the same name was already resolved at start, and a file does not unseat it.
        if (!known || known.source === "command" || known.source === "skill") result[name] = fromConfig(name, command)
      }
      return result
    })

    const state = yield* InstanceState.make<State>((ctx) => init(ctx))

    const get = Effect.fn("Command.get")(function* (name: string) {
      return (yield* current())[name]
    })

    const list = Effect.fn("Command.list")(function* () {
      return Object.values(yield* current())
    })

    return Service.of({ get, list })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [Config.node, MCP.node, Skill.node] })

export * as Command from "."
