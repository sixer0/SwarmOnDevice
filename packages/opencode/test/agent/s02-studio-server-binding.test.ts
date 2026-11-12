import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import * as Baseline from "@opencode-ai/core/swarm-permission-baseline"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent, ANSWER_DECISION_TOOL } from "../../src/agent/agent"
import * as SubagentPermissions from "../../src/agent/subagent-permissions"
import { DatumStudioMcp } from "../../src/mcp/datum-studio"
import { McpCatalog } from "../../src/mcp/catalog"
import { Permission } from "../../src/permission"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Agent.node, Plugin.node, Provider.node, Auth.node, Config.node, Skill.node, RuntimeFlags.node]),
    [[RuntimeFlags.node, RuntimeFlags.layer({})]],
  ),
)

// S-02 / SEC-13 (1.2.6 row 56): the shipped STUDIO_SUBAGENT_TOOLS allows (row 56b, AGENT_BASELINE planner and
// document-writer) bind to the BUILT-IN datum-studio server only. A user server under the same name, or one whose
// sanitised name can compose the same keys, gets no allow: the subagent asks. The main agent's asks are unchanged.

// Namespace imports so the BASE run (e363918a69, before 56b/56) fails on assertions, not on a missing export.
const studioToolsBound = (...args: Parameters<typeof SubagentPermissions.studioToolsBound>) =>
  SubagentPermissions.studioToolsBound(...args)
const withoutStudioAllows = (...args: Parameters<typeof SubagentPermissions.withoutStudioAllows>) =>
  SubagentPermissions.withoutStudioAllows(...args)

/** N-100 as row 56b shipped it (pinned here; the first test checks the core export equals it). */
const STUDIO_SUBAGENT_TOOLS = [
  "datum-studio_studio_figure_preview",
  "datum-studio_studio_figure_revise",
  "datum-studio_studio_document_get",
  "datum-studio_studio_document_status",
  "datum-studio_studio_document_structure",
  "datum-studio_studio_search",
  "datum-studio_studio_contracts_query",
  "datum-studio_studio_templates_list",
  "datum-studio_studio_template_get",
  "datum-studio_studio_registry",
  "datum-studio_studio_file_verify",
  "datum-studio_studio_mission_get",
  "datum-studio_studio_mission_list",
] as const

test("the pinned list equals core STUDIO_SUBAGENT_TOOLS", () => {
  expect([...(Reflect.get(Baseline, "STUDIO_SUBAGENT_TOOLS") ?? [])]).toEqual([...STUDIO_SUBAGENT_TOOLS])
})

const FIGURE_PREVIEW = "datum-studio_studio_figure_preview"
const SUBAGENTS = ["planner", "document-writer"] as const
const BUILTIN = DatumStudioMcp.entry("/Applications/Swarm.app/Contents/Resources/datum-studio/datum-studio-launcher")

afterEach(async () => {
  await disposeAllInstances()
})

describe("studioToolsBound", () => {
  test("the built-in entry in effect, nothing colliding: bound", () => {
    expect(studioToolsBound({ "datum-studio": BUILTIN, "swarm-web": { type: "local", command: ["x"] } }, BUILTIN)).toBe(
      true,
    )
    // enabled/timeout do not change which program answers
    expect(studioToolsBound({ "datum-studio": { ...BUILTIN, timeout: 60000, enabled: true } }, BUILTIN)).toBe(true)
  })

  test("a user entry named datum-studio (other command, env, url) is not the built-in", () => {
    expect(studioToolsBound({ "datum-studio": { type: "local", command: ["/opt/evil"] } }, BUILTIN)).toBe(false)
    expect(
      studioToolsBound(
        { "datum-studio": { ...BUILTIN, environment: { STUDIO_AGENT_ID: "swarm", EXTRA: "1" } } },
        BUILTIN,
      ),
    ).toBe(false)
    expect(studioToolsBound({ "datum-studio": { type: "remote", url: "https://evil.example/mcp" } }, BUILTIN)).toBe(
      false,
    )
    expect(studioToolsBound({ "datum-studio": { ...BUILTIN, enabled: false } }, BUILTIN)).toBe(false)
  })

  test("no built-in (terminal CLI, tests): never bound, even for an entry of the same shape", () => {
    expect(studioToolsBound({ "datum-studio": BUILTIN }, undefined)).toBe(false)
    expect(studioToolsBound({}, undefined)).toBe(false)
    expect(studioToolsBound({}, BUILTIN)).toBe(false)
  })

  test("a colliding sanitised name next to the built-in unbinds", () => {
    for (const name of ["datum-studio_studio", "datum-studio.studio", "datum-studio studio_figure", "datum-studio_"])
      expect(studioToolsBound({ "datum-studio": BUILTIN, [name]: { type: "local", command: ["x"] } }, BUILTIN)).toBe(
        false,
      )
    // a disabled look-alike cannot load, and names that cannot compose the keys do not count
    expect(
      studioToolsBound(
        {
          "datum-studio": BUILTIN,
          "datum-studio_studio": { type: "local", command: ["x"], enabled: false },
          datum_studio: { type: "local", command: ["x"] },
          "datum-studios": { type: "local", command: ["x"] },
        },
        BUILTIN,
      ),
    ).toBe(true)
  })

  test("withoutStudioAllows drops only the allow rules of the 13 keys", () => {
    const ruleset: PermissionV1.Ruleset = [
      { permission: "*", pattern: "*", action: "ask" },
      { permission: FIGURE_PREVIEW, pattern: "*", action: "allow" },
      { permission: "datum-studio_studio_render", pattern: "*", action: "allow" },
      { permission: "datum-studio_studio_search", pattern: "*", action: "deny" },
    ]
    expect(withoutStudioAllows(ruleset)).toEqual([ruleset[0], ruleset[2], ruleset[3]])
  })
})

const evalIn = (agent: Agent.Info | undefined, key: string) => {
  if (!agent) throw new Error("agent missing")
  return Permission.evaluate(key, "*", agent.permission).action
}

it.instance(
  "SEC-13: a user server named datum-studio gets ask for planner and document-writer (no built-in here)",
  () =>
    Effect.gen(function* () {
      for (const name of SUBAGENTS) {
        const agent = yield* Agent.Service.use((svc) => svc.get(name))
        for (const tool of STUDIO_SUBAGENT_TOOLS) expect(evalIn(agent, tool)).toBe("ask")
        expect(evalIn(agent, ANSWER_DECISION_TOOL)).toBe("deny")
      }
      const build = yield* Agent.Service.use((svc) => svc.get("build"))
      expect(evalIn(build, FIGURE_PREVIEW)).toBe("ask")
    }),
  { config: { mcp: { "datum-studio": { type: "local", command: ["/opt/user/datum-studio"] } } } },
)

// ---- In a process that looks like the app's utility process, so DatumStudioMcp.current() yields the built-in ----

function resources(base: string) {
  const res = path.join(base, "Swarm.app", "Contents", "Resources")
  fs.mkdirSync(path.join(res, "datum-studio"), { recursive: true })
  fs.writeFileSync(path.join(res, "app.asar"), "")
  const launcher = path.join(res, "datum-studio", "datum-studio-launcher")
  fs.writeFileSync(launcher, "#!/bin/sh\nexit 3\n")
  fs.chmodSync(launcher, 0o755)
  return res
}

type Decisions = Record<string, Record<string, string>>

const PROBE_KEYS = [...STUDIO_SUBAGENT_TOOLS, ANSWER_DECISION_TOOL, "datum-studio_studio_render"]

/** Agent permissions as evaluated by the real Agent service in an app-like process, for the given global config. */
function decisionsInApp(base: string, globalConfig?: unknown): { mcp: unknown; decisions: Decisions } {
  const res = resources(base)
  const xdg = path.join(base, "xdg")
  for (const name of ["home", "config", "data", "state", "cache"])
    fs.mkdirSync(path.join(xdg, name), { recursive: true })
  const project = path.join(base, "project")
  fs.mkdirSync(project)
  if (globalConfig !== undefined) {
    fs.mkdirSync(path.join(xdg, "config", "swarm"), { recursive: true })
    fs.writeFileSync(path.join(xdg, "config", "swarm", "swarm.json"), JSON.stringify(globalConfig))
  }
  const src = (rel: string) => JSON.stringify(path.join(import.meta.dir, "../../src", rel))
  const script = `
    Object.defineProperty(process, "type", { value: "utility", configurable: true, writable: true })
    Object.defineProperty(process, "resourcesPath", { value: ${JSON.stringify(res)}, configurable: true, writable: true })
    const { Effect, Layer } = await import("effect")
    const { LayerNode } = await import("@opencode-ai/core/effect/layer-node")
    const { Agent } = await import(${src("agent/agent.ts")})
    const { Auth } = await import(${src("auth/index.ts")})
    const { Config } = await import(${src("config/config.ts")})
    const { RuntimeFlags } = await import(${src("effect/runtime-flags.ts")})
    const { Permission } = await import(${src("permission/index.ts")})
    const { Plugin } = await import(${src("plugin/index.ts")})
    const { Provider } = await import(${src("provider/provider.ts")})
    const { Skill } = await import(${src("skill/index.ts")})
    const { provideInstance, testInstanceStoreLayer } = await import(${JSON.stringify(path.join(import.meta.dir, "../fixture/fixture.ts"))})
    const keys = ${JSON.stringify(PROBE_KEYS)}
    const program = Effect.gen(function* () {
      const mcp = (yield* (yield* Config.Service).get()).mcp
      const decisions = {}
      for (const name of ["planner", "document-writer", "build", "data-collector"]) {
        const agent = yield* Agent.Service.use((svc) => svc.get(name))
        if (!agent) continue
        decisions[name] = Object.fromEntries(keys.map((k) => [k, Permission.evaluate(k, "*", agent.permission).action]))
      }
      return { mcp, decisions }
    }).pipe(
      provideInstance(${JSON.stringify(project)}),
      Effect.provide(
        Layer.mergeAll(
          LayerNode.compile(
            LayerNode.group([Agent.node, Plugin.node, Provider.node, Auth.node, Config.node, Skill.node, RuntimeFlags.node]),
            [[RuntimeFlags.node, RuntimeFlags.layer({})]],
          ),
          testInstanceStoreLayer,
        ),
      ),
    )
    console.log("RESULT" + JSON.stringify(await Effect.runPromise(program)))
    process.exit(0)
  `
  const result = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: path.join(import.meta.dir, "../.."),
    env: {
      ...process.env,
      OPENCODE_TEST_HOME: path.join(xdg, "home"),
      XDG_CONFIG_HOME: path.join(xdg, "config"),
      XDG_DATA_HOME: path.join(xdg, "data"),
      XDG_STATE_HOME: path.join(xdg, "state"),
      XDG_CACHE_HOME: path.join(xdg, "cache"),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const line = result.stdout
    .toString()
    .split("\n")
    .find((item) => item.startsWith("RESULT"))
  if (!line) throw new Error(result.stderr.toString())
  return JSON.parse(line.slice("RESULT".length))
}

describe("in the app (built-in datum-studio present)", () => {
  test("S-02: planner and document-writer call the 13 Studio tools without an ask; answer_decision deny; main agent unchanged", async () => {
    await using tmp = await tmpdir()
    const { mcp, decisions } = decisionsInApp(tmp.path)
    expect((mcp as Record<string, { command?: string[] }>)["datum-studio"]?.command?.[0]).toEndWith(
      "datum-studio/datum-studio-launcher",
    )
    for (const name of SUBAGENTS) {
      for (const tool of STUDIO_SUBAGENT_TOOLS)
        expect([name, tool, decisions[name][tool]]).toEqual([name, tool, "allow"])
      expect(decisions[name][FIGURE_PREVIEW]).toBe("allow")
      expect(decisions[name][ANSWER_DECISION_TOOL]).toBe("deny")
      expect(decisions[name]["datum-studio_studio_render"]).toBe("ask")
    }
    // main agent: the baseline ask for every Studio key, answer_decision deny (as before row 56)
    for (const tool of STUDIO_SUBAGENT_TOOLS) expect(decisions.build[tool]).toBe("ask")
    expect(decisions.build[ANSWER_DECISION_TOOL]).toBe("deny")
    // a specialist without the list keeps the ask
    if (decisions["data-collector"]) expect(decisions["data-collector"][FIGURE_PREVIEW]).toBe("ask")
  }, 60_000)

  test("SEC-13: the user's own global datum-studio entry (other command) replaces the built-in and gets ask", async () => {
    await using tmp = await tmpdir()
    const { mcp, decisions } = decisionsInApp(tmp.path, {
      mcp: { "datum-studio": { type: "local", command: ["/opt/user/datum-studio"] } },
    })
    expect((mcp as Record<string, { command?: string[] }>)["datum-studio"]?.command).toEqual(["/opt/user/datum-studio"])
    for (const name of SUBAGENTS) {
      for (const tool of STUDIO_SUBAGENT_TOOLS) expect([name, tool, decisions[name][tool]]).toEqual([name, tool, "ask"])
      expect(decisions[name][ANSWER_DECISION_TOOL]).toBe("deny")
    }
    for (const tool of STUDIO_SUBAGENT_TOOLS) expect(decisions.build[tool]).toBe("ask")
  }, 60_000)

  test("SEC-13: a colliding user server (sanitised datum-studio_studio) next to the built-in gets no allow", async () => {
    await using tmp = await tmpdir()
    const { decisions } = decisionsInApp(tmp.path, {
      mcp: { "datum-studio.studio": { type: "local", command: ["/opt/user/look-alike"] } },
    })
    for (const name of SUBAGENTS) expect(decisions[name][FIGURE_PREVIEW]).toBe("ask")
  }, 60_000)
})

// Gate M2 S4 (1.2.6 row FX-3): one SEC-13 reserved-name rule. The subagent binding (studioToolsBound) and the load/add
// refusal (McpCatalog.serverRefusal) use the same case-insensitive sanitised compare, so a case variant of the
// reserved name is treated the same in both: refused at load AND no Studio allow for subagents.
describe("SEC-13 one reserved-name rule (case variants)", () => {
  const variants = ["Datum-Studio_x", "DATUM-STUDIO", "Datum-Studio", "datum-studio_x", "DATUM-Studio.studio"]
  for (const name of variants) {
    test(`"${name}" is reserved in catalog and unbinds the subagent allows`, () => {
      const extra = { type: "local", command: ["/opt/user/look-alike"] }
      expect(McpCatalog.reservedServerName(name)).toBe(true)
      expect(McpCatalog.serverRefusal(name, extra, BUILTIN, "load")).toBeString()
      expect(studioToolsBound({ "datum-studio": BUILTIN, [name]: extra }, BUILTIN)).toBe(false)
    })
  }
  test("names that only look alike are not reserved in either place", () => {
    const extra = { type: "local", command: ["x"] }
    for (const name of ["datum-studios", "my-datum-studio", "datum_studio"]) {
      expect([name, McpCatalog.reservedServerName(name)]).toEqual([name, false])
      expect([name, studioToolsBound({ "datum-studio": BUILTIN, [name]: extra }, BUILTIN)]).toEqual([name, true])
    }
  })
})
