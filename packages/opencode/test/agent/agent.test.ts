import { afterEach, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Layer } from "effect"
import path from "path"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Global } from "@opencode-ai/core/global"
import { Permission } from "../../src/permission"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { Truncate } from "../../src/tool/truncate"

const agentLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([Agent.node, Plugin.node, Provider.node, Auth.node, Config.node, Skill.node, RuntimeFlags.node]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
  )

const it = testEffect(agentLayer())

// Helper to evaluate permission for a tool with wildcard pattern
function evalPerm(agent: Agent.Info | undefined, permission: string): PermissionV1.Action | undefined {
  if (!agent) return undefined
  return Permission.evaluate(permission, "*", agent.permission).action
}

function load<A>(fn: (svc: Agent.Interface) => Effect.Effect<A>) {
  return Agent.Service.use(fn)
}

const expectDefaultAgentError = Effect.fn("AgentTest.expectDefaultAgentError")(function* (message: string) {
  const exit = yield* load((svc) => svc.defaultAgent()).pipe(Effect.exit)
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(message)
})

afterEach(async () => {
  await disposeAllInstances()
})

it.instance("returns default native agents when no config", () =>
  Effect.gen(function* () {
    const agents = yield* load((svc) => svc.list())
    const names = agents.map((a) => a.name)
    expect(names).toContain("build")
    expect(names).toContain("plan")
    expect(names).toContain("general")
    expect(names).toContain("explore")
    expect(names).toContain("compaction")
    expect(names).toContain("title")
    expect(names).toContain("summary")
  }),
)

it.instance("build agent has correct default properties", () =>
  Effect.gen(function* () {
    const build = yield* load((svc) => svc.get("build"))
    expect(build).toBeDefined()
    expect(build?.mode).toBe("primary")
    expect(build?.native).toBe(true)
    // Shipped-posture note (row 96 baseline): Permission.merge is plain concatenation
    // (src/permission/index.ts:200-202) and evaluate() takes findLast (:28-38), so the baseline's
    // ("*","*") rule — which arrives in the config layer, after defaults and after per-agent rules —
    // answers every query nothing more specific in the config block covers. These cases therefore
    // record the baseline outcome, not the upstream built-in.
    expect(evalPerm(build, "edit")).toBe("ask")
    expect(evalPerm(build, "bash")).toBe("ask")
  }),
)

it.instance("plan agent edits fall to the shipped ask wildcard", () =>
  Effect.gen(function* () {
    const plan = yield* load((svc) => svc.get("plan"))
    expect(plan).toBeDefined()
    // Shipped-posture note (row 96 baseline): Permission.merge is plain concatenation
    // (src/permission/index.ts:200-202) and evaluate() takes findLast (:28-38), so the baseline's
    // ("*","*") rule — which arrives in the config layer, after defaults and after per-agent rules —
    // answers every query nothing more specific in the config block covers. These cases therefore
    // record the baseline outcome, not the upstream built-in.
    expect(evalPerm(plan, "edit")).toBe("ask")
    // The plans-path allow was an agent-level rule, so it is shadowed the same way.
    expect(Permission.evaluate("edit", ".swarm/plans/foo.md", plan!.permission).action).toBe("ask")
  }),
)

it.instance("plan agent subagent rules fall to the shipped ask wildcard", () =>
  Effect.gen(function* () {
    const plan = yield* load((svc) => svc.get("plan"))
    expect(plan).toBeDefined()
    // Shipped-posture note (row 96 baseline): Permission.merge is plain concatenation
    // (src/permission/index.ts:200-202) and evaluate() takes findLast (:28-38), so the baseline's
    // ("*","*") rule — which arrives in the config layer, after defaults and after per-agent rules —
    // answers every query nothing more specific in the config block covers. These cases therefore
    // record the baseline outcome, not the upstream built-in.
    expect(Permission.evaluate("task", "general", plan!.permission).action).toBe("ask")
    expect(Permission.evaluate("task", "explore", plan!.permission).action).toBe("ask")
    expect(Permission.evaluate("task", "custom", plan!.permission).action).toBe("ask")
  }),
)

it.instance(
  "user permission can allow the general subagent from plan mode",
  () =>
    Effect.gen(function* () {
      const plan = yield* load((svc) => svc.get("plan"))
      expect(plan).toBeDefined()
      expect(Permission.evaluate("task", "general", plan!.permission).action).toBe("allow")
    }),
  {
    config: {
      permission: {
        task: {
          general: "allow",
        },
      },
    },
  },
)

it.instance("explore agent edit, write and todowrite fall to the shipped ask wildcard", () =>
  Effect.gen(function* () {
    const explore = yield* load((svc) => svc.get("explore"))
    expect(explore).toBeDefined()
    expect(explore?.mode).toBe("subagent")
    // Shipped-posture note (row 96 baseline): Permission.merge is plain concatenation
    // (src/permission/index.ts:200-202) and evaluate() takes findLast (:28-38), so the baseline's
    // ("*","*") rule — which arrives in the config layer, after defaults and after per-agent rules —
    // answers every query nothing more specific in the config block covers. These cases therefore
    // record the baseline outcome, not the upstream built-in.
    expect(evalPerm(explore, "edit")).toBe("ask")
    expect(evalPerm(explore, "write")).toBe("ask")
    expect(evalPerm(explore, "todowrite")).toBe("ask")
  }),
)

it.instance("explore agent asks for foreign external directories and keeps whitelisted ones", () =>
  Effect.gen(function* () {
    const explore = yield* load((svc) => svc.get("explore"))
    expect(explore).toBeDefined()
    expect(Permission.evaluate("external_directory", "/some/other/path", explore!.permission).action).toBe("ask")
    // Shipped-posture note (row 96 baseline): the baseline's ("*","*") rule arrives in the
    // config layer, which Permission.merge concatenates after defaults and per-agent rules
    // (src/permission/index.ts:200-202), and evaluate() takes findLast (:28-38) — so anything the
    // config block does not name resolves to the baseline action.
    expect(Permission.evaluate("external_directory", Truncate.GLOB, explore!.permission).action).toBe("allow")
    expect(
      Permission.evaluate("external_directory", path.join(Global.Path.tmp, "agent-work"), explore!.permission).action,
    ).toBe("ask")
  }),
)

it.instance(
  "reference config does not create subagents",
  () =>
    Effect.gen(function* () {
      const agents = yield* load((svc) => svc.list())
      const names = agents.map((agent) => agent.name)
      expect(names).not.toContain("effect")
      expect(names).not.toContain("effectFull")
      expect(names).not.toContain("localdocs")
      expect(names).not.toContain("localdocsFull")
    }),
  {
    config: {
      references: {
        effect: "github.com/effect/effect-smol",
        effectFull: {
          repository: "Effect-TS/effect",
          branch: "main",
        },
        localdocs: "../docs",
        localdocsFull: {
          path: "../local-docs",
        },
      },
    },
  },
)

it.instance("general agent todowrite falls to the shipped ask wildcard", () =>
  Effect.gen(function* () {
    const general = yield* load((svc) => svc.get("general"))
    expect(general).toBeDefined()
    expect(general?.mode).toBe("subagent")
    expect(general?.hidden).toBeUndefined()
    // Shipped-posture note (row 96 baseline): the baseline's ("*","*") rule arrives in the
    // config layer, which Permission.merge concatenates after defaults and per-agent rules
    // (src/permission/index.ts:200-202), and evaluate() takes findLast (:28-38) — so anything the
    // config block does not name resolves to the baseline action.
    expect(evalPerm(general, "todowrite")).toBe("ask")
  }),
)

it.instance("compaction agent permissions fall to the shipped ask wildcard", () =>
  Effect.gen(function* () {
    const compaction = yield* load((svc) => svc.get("compaction"))
    expect(compaction).toBeDefined()
    expect(compaction?.hidden).toBe(true)
    // Shipped-posture note (row 96 baseline): the baseline's ("*","*") rule arrives in the
    // config layer, which Permission.merge concatenates after defaults and per-agent rules
    // (src/permission/index.ts:200-202), and evaluate() takes findLast (:28-38) — so anything the
    // config block does not name resolves to the baseline action.
    // The agent is still hidden; only its permission answers moved with the baseline.
    expect(evalPerm(compaction, "bash")).toBe("ask")
    expect(evalPerm(compaction, "edit")).toBe("ask")
    expect(evalPerm(compaction, "read")).toBe("ask")
  }),
)

it.instance(
  "custom agent from config creates new agent",
  () =>
    Effect.gen(function* () {
      const custom = yield* load((svc) => svc.get("my_custom_agent"))
      expect(custom).toBeDefined()
      expect(String(custom?.model?.providerID)).toBe("openai")
      expect(String(custom?.model?.modelID)).toBe("gpt-4")
      expect(custom?.description).toBe("My custom agent")
      expect(custom?.temperature).toBe(0.5)
      expect(custom?.topP).toBe(0.9)
      expect(custom?.native).toBe(false)
      expect(custom?.mode).toBe("all")
    }),
  {
    config: {
      agent: {
        my_custom_agent: {
          model: "openai/gpt-4",
          description: "My custom agent",
          temperature: 0.5,
          top_p: 0.9,
        },
      },
    },
  },
)

it.instance(
  "custom agent config overrides native agent properties",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build).toBeDefined()
      expect(String(build?.model?.providerID)).toBe("anthropic")
      expect(String(build?.model?.modelID)).toBe("claude-3")
      expect(build?.description).toBe("Custom build agent")
      expect(build?.temperature).toBe(0.7)
      expect(build?.color).toBe("#FF0000")
      expect(build?.native).toBe(true)
    }),
  {
    config: {
      agent: {
        build: {
          model: "anthropic/claude-3",
          description: "Custom build agent",
          temperature: 0.7,
          color: "#FF0000",
        },
      },
    },
  },
)

it.instance(
  "agent disable removes agent from list",
  () =>
    Effect.gen(function* () {
      const explore = yield* load((svc) => svc.get("explore"))
      expect(explore).toBeUndefined()
      const agents = yield* load((svc) => svc.list())
      const names = agents.map((a) => a.name)
      expect(names).not.toContain("explore")
    }),
  {
    config: {
      agent: {
        explore: { disable: true },
      },
    },
  },
)

it.instance(
  "agent permission config merges with defaults",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build).toBeDefined()
      // Unchanged from upstream and still true: a per-agent rule in config outranks the shipped
      // baseline wildcard, because agent.ts appends the agent's own config block after the merged
      // config layer. Only built-in defaults are shadowed by the baseline (see the "falls to the
      // shipped ask wildcard" cases above), which is row 96's documented posture.
      expect(Permission.evaluate("bash", "rm -rf *", build!.permission).action).toBe("deny")
      // This config names only `bash`, so `edit` has nothing from the user layer and lands on the
      // baseline wildcard — the built-in build-agent edit allow no longer answers on its own.
      expect(evalPerm(build, "edit")).toBe("ask")
    }),
  {
    config: {
      agent: {
        build: {
          permission: {
            bash: {
              "rm -rf *": "deny",
            },
          },
        },
      },
    },
  },
)

it.instance(
  "global permission config applies to all agents",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build).toBeDefined()
      expect(evalPerm(build, "bash")).toBe("deny")
    }),
  {
    config: {
      permission: {
        bash: "deny",
      },
    },
  },
)

it.instance(
  "agent steps/maxSteps config sets steps property",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      const plan = yield* load((svc) => svc.get("plan"))
      expect(build?.steps).toBe(50)
      expect(plan?.steps).toBe(100)
    }),
  {
    config: {
      agent: {
        build: { steps: 50 },
        plan: { maxSteps: 100 },
      },
    },
  },
)

it.instance(
  "agent mode can be overridden",
  () =>
    Effect.gen(function* () {
      const explore = yield* load((svc) => svc.get("explore"))
      expect(explore?.mode).toBe("primary")
    }),
  {
    config: {
      agent: {
        explore: { mode: "primary" },
      },
    },
  },
)

it.instance(
  "agent name can be overridden",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build?.name).toBe("Builder")
    }),
  {
    config: {
      agent: {
        build: { name: "Builder" },
      },
    },
  },
)

it.instance(
  "agent prompt can be set from config",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build?.prompt).toBe("Custom system prompt")
    }),
  {
    config: {
      agent: {
        build: { prompt: "Custom system prompt" },
      },
    },
  },
)

it.instance(
  "unknown agent properties are placed into options",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build?.options.random_property).toBe("hello")
      expect(build?.options.another_random).toBe(123)
    }),
  {
    config: {
      agent: {
        build: {
          random_property: "hello",
          another_random: 123,
        },
      },
    },
  },
)

it.instance(
  "agent options merge correctly",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build?.options.custom_option).toBe(true)
      expect(build?.options.another_option).toBe("value")
    }),
  {
    config: {
      agent: {
        build: {
          options: {
            custom_option: true,
            another_option: "value",
          },
        },
      },
    },
  },
)

it.instance(
  "multiple custom agents can be defined",
  () =>
    Effect.gen(function* () {
      const agentA = yield* load((svc) => svc.get("agent_a"))
      const agentB = yield* load((svc) => svc.get("agent_b"))
      expect(agentA?.description).toBe("Agent A")
      expect(agentA?.mode).toBe("subagent")
      expect(agentB?.description).toBe("Agent B")
      expect(agentB?.mode).toBe("primary")
    }),
  {
    config: {
      agent: {
        agent_a: {
          description: "Agent A",
          mode: "subagent",
        },
        agent_b: {
          description: "Agent B",
          mode: "primary",
        },
      },
    },
  },
)

it.instance(
  "Agent.list keeps the default agent first and sorts the rest by name",
  () =>
    Effect.gen(function* () {
      const names = (yield* load((svc) => svc.list())).map((a) => a.name)
      expect(names[0]).toBe("plan")
      expect(names.slice(1)).toEqual(names.slice(1).toSorted((a, b) => a.localeCompare(b)))
    }),
  {
    config: {
      default_agent: "plan",
      agent: {
        zebra: {
          description: "Zebra",
          mode: "subagent",
        },
        alpha: {
          description: "Alpha",
          mode: "subagent",
        },
      },
    },
  },
)

it.instance("Agent.get returns undefined for non-existent agent", () =>
  Effect.gen(function* () {
    const nonExistent = yield* load((svc) => svc.get("does_not_exist"))
    expect(nonExistent).toBeUndefined()
  }),
)

it.instance("default permission includes doom_loop and external_directory as ask", () =>
  Effect.gen(function* () {
    const build = yield* load((svc) => svc.get("build"))
    expect(evalPerm(build, "doom_loop")).toBe("ask")
    expect(evalPerm(build, "external_directory")).toBe("ask")
  }),
)

it.instance("webfetch is denied by the shipped baseline", () =>
  Effect.gen(function* () {
    const build = yield* load((svc) => svc.get("build"))
    // Unlike the wildcard cases, the baseline names webfetch explicitly, so this one is deny
    // rather than ask (packages/core/src/swarm-permission-baseline.ts webfetch/websearch).
    expect(evalPerm(build, "webfetch")).toBe("deny")
  }),
)

it.instance(
  "legacy tools config converts to permissions",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(evalPerm(build, "bash")).toBe("deny")
      expect(evalPerm(build, "read")).toBe("deny")
    }),
  {
    config: {
      agent: {
        build: {
          tools: {
            bash: false,
            read: false,
          },
        },
      },
    },
  },
)

it.instance(
  "legacy tools config maps write/edit/patch to edit permission",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(evalPerm(build, "edit")).toBe("deny")
    }),
  {
    config: {
      agent: {
        build: {
          tools: {
            write: false,
          },
        },
      },
    },
  },
)

it.instance(
  "Truncate.GLOB is allowed even when user denies external_directory globally",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(Permission.evaluate("external_directory", Truncate.GLOB, build!.permission).action).toBe("allow")
      expect(Permission.evaluate("external_directory", Truncate.DIR, build!.permission).action).toBe("deny")
      expect(Permission.evaluate("external_directory", "/some/other/path", build!.permission).action).toBe("deny")
    }),
  {
    config: {
      permission: {
        external_directory: "deny",
      },
    },
  },
)

it.instance("global tmp directory children fall to the shipped ask wildcard", () =>
  Effect.gen(function* () {
    const build = yield* load((svc) => svc.get("build"))
    expect(
      Permission.evaluate("external_directory", path.join(Global.Path.tmp, "scratch"), build!.permission).action,
    ).toBe("ask")
    expect(Permission.evaluate("external_directory", "/some/other/path", build!.permission).action).toBe("ask")
  }),
)

it.instance(
  "Truncate.GLOB is allowed even when user denies external_directory per-agent",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(Permission.evaluate("external_directory", Truncate.GLOB, build!.permission).action).toBe("allow")
      expect(Permission.evaluate("external_directory", Truncate.DIR, build!.permission).action).toBe("deny")
      expect(Permission.evaluate("external_directory", "/some/other/path", build!.permission).action).toBe("deny")
    }),
  {
    config: {
      agent: {
        build: {
          permission: {
            external_directory: "deny",
          },
        },
      },
    },
  },
)

it.instance(
  "explicit Truncate.GLOB deny is respected",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(Permission.evaluate("external_directory", Truncate.GLOB, build!.permission).action).toBe("deny")
      expect(Permission.evaluate("external_directory", Truncate.DIR, build!.permission).action).toBe("deny")
    }),
  {
    config: {
      permission: {
        external_directory: {
          "*": "deny",
          [Truncate.GLOB]: "deny",
        },
      },
    },
  },
)

it.instance(
  "skill directories fall to the shipped ask wildcard for external_directory",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const skillDir = path.join(test.directory, ".swarm", "skill", "perm-skill")
      yield* Effect.promise(() =>
        Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: perm-skill
description: Permission skill.
---

# Permission Skill
`,
        ),
      )

      const home = process.env.OPENCODE_TEST_HOME
      process.env.OPENCODE_TEST_HOME = test.directory
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          process.env.OPENCODE_TEST_HOME = home
        }),
      )

      const build = yield* load((svc) => svc.get("build"))
      const target = path.join(skillDir, "reference", "notes.md")
      // Shipped-posture note (row 96 baseline): the baseline's ("*","*") rule arrives in the
      // config layer, which Permission.merge concatenates after defaults and per-agent rules
      // (src/permission/index.ts:200-202), and evaluate() takes findLast (:28-38) — so anything the
      // config block does not name resolves to the baseline action.
      expect(Permission.evaluate("external_directory", target, build!.permission).action).toBe("ask")
    }),
  { git: true },
)

it.instance(
  "project reference directories fall to the shipped ask wildcard",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const build = yield* load((svc) => svc.get("build"))
      const target = path.resolve(test.directory, "../docs/reference/notes.md")
      // Shipped-posture note (row 96 baseline): the baseline's ("*","*") rule arrives in the
      // config layer, which Permission.merge concatenates after defaults and per-agent rules
      // (src/permission/index.ts:200-202), and evaluate() takes findLast (:28-38) — so anything the
      // config block does not name resolves to the baseline action.
      expect(Permission.evaluate("external_directory", target, build!.permission).action).toBe("ask")
    }),
  {
    git: true,
    config: {
      references: {
        docs: "../docs",
      },
    },
  },
)

it.instance("defaultAgent returns build when no default_agent config", () =>
  Effect.gen(function* () {
    const agent = yield* load((svc) => svc.defaultAgent())
    expect(agent).toBe("build")
  }),
)

it.instance("defaultInfo returns resolved build agent when no default_agent config", () =>
  Effect.gen(function* () {
    const agent = yield* load((svc) => svc.defaultInfo())
    expect(agent.name).toBe("build")
    expect(agent.mode).toBe("primary")
  }),
)

it.instance(
  "defaultAgent respects default_agent config set to plan",
  () =>
    Effect.gen(function* () {
      const agent = yield* load((svc) => svc.defaultAgent())
      expect(agent).toBe("plan")
    }),
  {
    config: {
      default_agent: "plan",
    },
  },
)

it.instance(
  "defaultAgent respects default_agent config set to custom agent with mode all",
  () =>
    Effect.gen(function* () {
      const agent = yield* load((svc) => svc.defaultAgent())
      expect(agent).toBe("my_custom")
    }),
  {
    config: {
      default_agent: "my_custom",
      agent: {
        my_custom: {
          description: "My custom agent",
        },
      },
    },
  },
)

it.instance(
  "defaultAgent throws when default_agent points to subagent",
  () => expectDefaultAgentError('default agent "explore" is a subagent'),
  {
    config: {
      default_agent: "explore",
    },
  },
)

it.instance(
  "defaultAgent throws when default_agent points to hidden agent",
  () => expectDefaultAgentError('default agent "compaction" is hidden'),
  {
    config: {
      default_agent: "compaction",
    },
  },
)

it.instance(
  "defaultAgent throws when default_agent points to non-existent agent",
  () => expectDefaultAgentError('default agent "does_not_exist" not found'),
  {
    config: {
      default_agent: "does_not_exist",
    },
  },
)

it.instance(
  "defaultAgent returns plan when build is disabled and default_agent not set",
  () =>
    Effect.gen(function* () {
      const agent = yield* load((svc) => svc.defaultAgent())
      // build is disabled, so it should return plan (next primary agent)
      expect(agent).toBe("plan")
    }),
  {
    config: {
      agent: {
        build: { disable: true },
      },
    },
  },
)

it.instance(
  "defaultAgent throws when all primary agents are disabled",
  () => expectDefaultAgentError("no primary visible agent found"),
  {
    config: {
      agent: {
        build: { disable: true },
        plan: { disable: true },
      },
    },
  },
)

// ---------------------------------------------------------------------------------------------------------------------
// Row 164 (1.2.2, spec 161 SA-01 to SA-07): the five specialist subagents.

const SPECIALISTS = ["coder", "planner", "verifier", "data-collector", "document-writer"] as const
const PROMPT_DIR = path.join(import.meta.dir, "../../src/agent/prompt")
const LANGUAGE_PREFIX = "Language: reply in the language the person writes in."
const at = (agent: Agent.Info | undefined, permission: string, pattern: string) =>
  Permission.evaluate(permission, pattern, agent!.permission).action

it.instance("specialist subagents are native subagents", () =>
  Effect.gen(function* () {
    const names = (yield* load((svc) => svc.list())).map((a) => a.name)
    for (const name of [...SPECIALISTS, "build", "plan", "general", "explore", "researcher"]) expect(names).toContain(name)
    for (const name of SPECIALISTS) {
      const agent = yield* load((svc) => svc.get(name))
      expect(agent?.mode).toBe("subagent")
      expect(agent?.native).toBe(true)
      expect(agent?.hidden).toBeUndefined()
    }
  }),
)

it.instance("specialist descriptions", () =>
  Effect.gen(function* () {
    const expected: Record<string, string> = {
      coder: `Implements code and config changes: a specified build row, a bug fix, a refactor, or tests to write and make pass. Edits files, runs the project's checks, and reports the files changed and the check results. No web tools. Use when the work changes code. Also the role called coder-execution, database-specialist, git-specialist or docker-specialist in workflow texts.`,
      planner: `Plans and analyses without changing code: states the intent, writes a blueprint or spec, or analyses collected findings and recommends. Reads the project and may write Markdown documents only. No shell and no web tools. Use for intent, blueprint, analysis and spec steps. Also the role called request-translator, task-architect, data-analyst, pm-analyst or pm-planner in workflow texts.`,
      verifier: `Checks finished work against its criteria and reports pass or fail with evidence: runs tests and checks, reviews a diff, a test report or the security of a change. Does not use edit tools; its shell commands still ask. No web tools. Use after implementation and before a gate or a report. Reads images (vision): it can check a rendered page, a figure or a screenshot by eye. Can act as a blind judge: it compares two sides given without project context and without knowing which side is the candidate. Also the role called verifier, senior-code-reviewer, security-review or pm-verifier, and test-expert when tests are run rather than written.`,
      "data-collector": `Reads and digests material the person already has: project files, notes, PDF, DOCX and XLSX documents, earlier reports. Returns facts with their source paths and may write a Markdown collection file. No shell and no web tools. Use for read-and-summarise jobs, inventories and extractions. Also the role called data-collector or document-reader. For code search use explore; for the public web use researcher.`,
      "document-writer": `Produces finished documents for a reader in the GSP house style: DOCX, PDF, HTML, XLSX and PPTX, through the datum-house-style skill and the datum-studio tools, and runs the house-style checks before it reports. No web tools. Use when the deliverable is a document rather than code. Also the role called document-writer, pm-writer, document-converter or document-translator.`,
    }
    for (const name of SPECIALISTS) {
      const description = (yield* load((svc) => svc.get(name)))?.description
      expect(description).toBe(expected[name])
      expect(description).toContain("Use ")
      expect(description?.toLowerCase()).toContain("no web tools") // decision L21 (S163-05)
    }
    expect((yield* load((svc) => svc.get("verifier")))?.description).toContain("Does not use edit tools") // L21 (S163-06)
    const general = (yield* load((svc) => svc.get("general")))?.description
    expect(general).toBe(
      "Fallback agent for multi-step work that no other agent in this list fits. Prefer the agent whose description matches the work. Use general to run several unrelated units of work in parallel.",
    )
    expect(general?.startsWith("Fallback")).toBe(true)
  }),
)

// 1.2.6 row 104a (S-01, GUIDE): the verifier description says it reads images and can act as a blind judge.
it.instance("verifier description states image input and blind-judge use (S-01)", () =>
  Effect.gen(function* () {
    const description = (yield* load((svc) => svc.get("verifier")))?.description ?? ""
    expect(description).toContain("Reads images (vision)")
    expect(description).toContain("blind judge")
    expect(description).toContain("without project context")
    expect(description).toContain("without knowing which side is the candidate")
  }),
)

it.instance("specialist prompts", () =>
  Effect.gen(function* () {
    expect((yield* load((svc) => svc.get("coder")))?.prompt).toBeUndefined()
    for (const name of ["planner", "verifier", "data-collector", "document-writer"]) {
      const file = yield* Effect.promise(() => Bun.file(path.join(PROMPT_DIR, `${name}.txt`)).text())
      expect((yield* load((svc) => svc.get(name)))?.prompt).toBe(file)
      expect(Buffer.byteLength(file)).toBeLessThanOrEqual(1600)
      // Row 182 (L36): at most 2 mission lines; each reports against its row and never marks unverified work done.
      const mission = file.split("\n").filter((line) => line.includes("mission"))
      expect(mission.length).toBeGreaterThanOrEqual(1)
      expect(mission.length).toBeLessThanOrEqual(2)
      expect(mission.join(" ")).toContain("When a mission is open, report")
      expect(mission.join(" ")).toContain("against your row with studio_mission_update_row")
      expect(mission.join(" ")).toContain("never mark a row done on an unverified output")
      if (name === "document-writer") {
        expect(mission.join(" ")).toContain("Produce through Studio")
        expect(mission.join(" ")).toContain("studio_file_verify")
      }
      const last = file.trimEnd().split("\n").at(-1)!
      expect(last.startsWith(LANGUAGE_PREFIX)).toBe(true)
      // SA-15: no private text in a shipped prompt.
      expect(file).not.toMatch(/alugra|iris|gsp-budi|\/Users\/|ses_[0-9a-f]|100\.102\./i)
    }
    // The paragraph is gsp-workflow.txt's, verbatim.
    const workflow = yield* Effect.promise(() =>
      Bun.file(path.join(import.meta.dir, "../../src/session/prompt/gsp-workflow.txt")).text(),
    )
    const paragraph = workflow.split("\n").find((line) => line.startsWith(LANGUAGE_PREFIX))!
    for (const name of ["planner", "verifier", "data-collector", "document-writer"]) {
      const file = yield* Effect.promise(() => Bun.file(path.join(PROMPT_DIR, `${name}.txt`)).text())
      expect(file.trimEnd().endsWith(paragraph)).toBe(true)
    }
  }),
)

it.instance("specialist permissions bind over the baseline", () =>
  Effect.gen(function* () {
    const get = (name: string) => load((svc) => svc.get(name))
    const verifier = yield* get("verifier")
    expect(at(verifier, "edit", "src/a.ts")).toBe("deny")
    const hidden = Permission.disabled(["edit", "write", "apply_patch", "bash", "read"], verifier!.permission)
    expect([...hidden].sort()).toEqual(["apply_patch", "edit", "write"])
    for (const name of ["planner", "data-collector"]) {
      const agent = yield* get(name)
      expect(at(agent, "edit", "src/a.ts")).toBe("deny")
      expect(at(agent, "edit", "docs/x.md")).toBe("ask")
      expect(at(agent, "bash", "ls")).toBe("deny")
      expect(Permission.disabled(["bash"], agent!.permission).has("bash")).toBe(true)
      // Markdown lane: the edit tools stay visible, because their last rule is not a "*" deny.
      expect(Permission.disabled(["edit", "write"], agent!.permission).size).toBe(0)
    }
    for (const name of SPECIALISTS) {
      const agent = yield* get(name)
      expect(at(agent, "task", "general")).toBe("deny")
      expect(at(agent, "todowrite", "*")).toBe("deny")
      expect(at(agent, "swarm-web_fetch", "*")).toBe("deny")
      expect(at(agent, "webfetch", "*")).toBe("deny")
      expect(at(agent, "websearch", "*")).toBe("deny")
      // Spec 161 C5: a child cannot run the controller workflow, so it may not load it; other skills stay allowed.
      expect(at(agent, "skill", "master-controller")).toBe("deny")
      // SW-11 (row 192, spec 191 §3.1): nor Swarm's own workflow.
      expect(at(agent, "skill", "swarm-workflow")).toBe("deny")
      expect(at(agent, "skill", "mission-control")).toBe("allow")
      expect(at(agent, "skill", "datum-house-style")).toBe("allow")
    }
    for (const name of ["coder", "document-writer"]) expect(at(yield* get(name), "edit", "src/a.ts")).toBe("ask")
    expect(at(yield* get("document-writer"), "datum-studio_studio_render", "*")).toBe("ask")
  }),
)

it.instance("baseline bash gates survive", () =>
  Effect.gen(function* () {
    for (const name of ["coder", "verifier", "document-writer"]) {
      const agent = yield* load((svc) => svc.get(name))
      expect(at(agent, "bash", "sudo ls")).toBe("deny")
      expect(at(agent, "bash", "curl x")).toBe("ask")
      expect(at(agent, "bash", "python3 x")).toBe("ask")
      expect(at(agent, "bash", "ls")).not.toBe("allow")
    }
  }),
)

it.instance(
  "user file overrides a built-in subagent",
  () =>
    Effect.gen(function* () {
      const verifier = yield* load((svc) => svc.get("verifier"))
      expect(verifier?.prompt).toBe("X")
      expect(verifier?.native).toBe(true)
      expect(verifier?.mode).toBe("subagent")
      expect(at(verifier, "edit", "src/a.ts")).toBe("allow")
      expect(yield* load((svc) => svc.get("coder"))).toBeUndefined()
      expect((yield* load((svc) => svc.list())).map((a) => a.name)).not.toContain("coder")
    }),
  {
    config: {
      agent: {
        verifier: { prompt: "X", permission: { edit: "allow" } },
        coder: { disable: true },
      },
    },
  },
)

it.instance(
  "a global permission does not loosen a specialist",
  () =>
    Effect.gen(function* () {
      expect(at(yield* load((svc) => svc.get("verifier")), "edit", "src/a.ts")).toBe("deny")
      expect(at(yield* load((svc) => svc.get("planner")), "edit", "src/a.ts")).toBe("deny")
      expect(at(yield* load((svc) => svc.get("build")), "edit", "src/a.ts")).toBe("allow")
    }),
  { config: { permission: { edit: "allow" } } },
)

it.instance("plan cannot hand edits to a subagent", () =>
  Effect.gen(function* () {
    const plan = yield* load((svc) => svc.get("plan"))
    expect(at(plan, "task", "coder")).toBe("deny")
    expect(at(plan, "task", "document-writer")).toBe("deny")
    expect(at(plan, "task", "explore")).toBe("ask")
    expect(at(plan, "task", "planner")).toBe("ask")
    // build is unchanged: it may still hand work to the editing specialists (with the usual ask).
    const build = yield* load((svc) => svc.get("build"))
    expect(at(build, "task", "coder")).toBe("ask")
  }),
)

it.instance(
  "plan's coder deny binds over a global task allow",
  () =>
    Effect.gen(function* () {
      const plan = yield* load((svc) => svc.get("plan"))
      expect(at(plan, "task", "coder")).toBe("deny")
      expect(at(plan, "task", "document-writer")).toBe("deny")
      expect(at(plan, "task", "general")).toBe("allow")
    }),
  { config: { permission: { task: { "*": "allow" } } } },
)

// Row 198 (decision L61, checklist D1): answering a mission decision is the person's answer. No agent may call the Studio
// tool; Mission Control answers through the desktop bridge (desktop mission-client.ts), not through agent tools.
const ANSWER = "datum-studio_studio_mission_answer_decision"

it.instance(
  "row 198: every agent is denied studio_mission_answer_decision, over a person's allow and agent config",
  () =>
    Effect.gen(function* () {
      expect(Agent.ANSWER_DECISION_TOOL).toBe(ANSWER)
      const agents = yield* load((svc) => svc.list())
      expect(agents.map((a) => a.name)).toContain("my_custom_agent")
      for (const agent of agents) {
        expect(at(agent, ANSWER, "*")).toBe("deny")
        // A deny on "*" also takes the tool out of the model's tool list.
        expect(Permission.disabled([ANSWER], agent.permission).has(ANSWER)).toBe(true)
      }
      // The other mission tools stay where the person's config puts them (allowed here) for the working agents.
      for (const name of ["build", "general", "coder"]) {
        const agent = yield* load((svc) => svc.get(name))
        expect(at(agent, "datum-studio_studio_mission_get", "*")).toBe("allow")
        expect(Permission.disabled(["datum-studio_studio_mission_get"], agent!.permission).size).toBe(0)
      }
    }),
  {
    config: {
      permission: { "*": "allow", "datum-studio_*": "allow", [ANSWER]: "allow" },
      agent: {
        build: { permission: { [ANSWER]: "allow" } },
        general: { permission: { "*": "allow" } },
        my_custom_agent: { description: "custom", permission: { [ANSWER]: "allow" } },
      },
    },
  },
)
