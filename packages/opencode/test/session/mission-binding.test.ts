import { beforeEach, describe, expect, test } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect, Layer } from "effect"
import type { Agent } from "@/agent/agent"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { DatumStudioMcp } from "@/mcp/datum-studio"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import type { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import type { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Skill } from "../../src/skill"
import { MissionBinding } from "../../src/session/mission-binding"
import { testEffect } from "../lib/effect"

// MC-1 item 2 / MC-6 (1.3.3 row 9): a session knows its mission from its own Studio mission tool calls.
//
// The results below are written in the shapes the host returns (packages/datum-studio/src/mcp-host/mission/
// mission-tools.ts, tool-result.ts `okResult`): `{content: [{type: "text", text}], structuredContent: {ok: true, tool,
// ...data}}`. Ids and titles are synthetic.

const A = "ses_a"
const B = "ses_b"
const M1 = "2026-11-17_alpha"
const M2 = "2026-11-17_beta"

const ok = (tool: string, data: Record<string, unknown>) => ({
  content: [{ type: "text", text: "x" }],
  structuredContent: { ok: true, tool, ...data },
})

const created = (id: string, extra: Record<string, unknown> = {}) =>
  ok("studio_mission_create", { id, status: "draft", rows: 2, waves: [], issues: [], dryRun: false, ...extra })

const statusSet = (id: string, from: string, to: string, extra: Record<string, unknown> = {}) =>
  ok("studio_mission_set_status", { id, from, to, dryRun: false, ...extra })

const rowsUpdated = (results: Array<{ id: string; ok: boolean; code?: string }>, extra: Record<string, unknown> = {}) =>
  ok("studio_mission_update_row", {
    changed: results.filter((r) => r.ok).map((r) => r.id),
    results,
    waves: [],
    ready: [],
    checkpoints: [],
    messages: [],
    dryRun: false,
    ...extra,
  })

const got = (mission: Record<string, unknown>) => ok("studio_mission_get", { mission, derived: {} })

const create = (sessionID: string, id: string) =>
  MissionBinding.observe({
    sessionID,
    tool: "studio_mission_create",
    args: { mission: { id, title: "t", type: "generic", rows: [] } },
    result: created(id),
  })

const update = (sessionID: string, mission: string, rows: Array<Record<string, unknown>>, results?: Array<{ id: string; ok: boolean; code?: string }>) =>
  MissionBinding.observe({
    sessionID,
    tool: "studio_mission_update_row",
    args: { mission, rows },
    result: rowsUpdated(results ?? rows.map((r) => ({ id: String(r.id), ok: true }))),
  })

beforeEach(() => MissionBinding.reset())

describe("MissionBinding: set", () => {
  test("no binding before any mission call", () => {
    expect(MissionBinding.get(A)).toBeUndefined()
    expect(MissionBinding.hasRunningRow(A)).toBe(false)
  })

  test("create binds the session to the created mission", () => {
    expect(create(A, M1)).toBe("set")
    const b = MissionBinding.get(A)
    expect(b?.missionID).toBe(M1)
    expect(b?.runningRows).toEqual([])
    expect(b?.locks).toEqual([])
    expect(b?.knowledge).toEqual([])
    expect(typeof b?.updatedAt).toBe("number")
  })

  test("update_row tracks running rows and held locks from the patches that applied", () => {
    create(A, M1)
    update(A, M1, [
      { id: "1", status: "running", acquire: ["lock:build"] },
      { id: "2", status: "running" },
    ])
    expect(MissionBinding.get(A)?.runningRows).toEqual(["1", "2"])
    expect(MissionBinding.get(A)?.locks).toEqual(["lock:build"])
    expect(MissionBinding.hasRunningRow(A)).toBe(true)

    update(A, M1, [{ id: "1", status: "done", note: "n", release: ["lock:build"] }])
    expect(MissionBinding.get(A)?.runningRows).toEqual(["2"])
    expect(MissionBinding.get(A)?.locks).toEqual([])
  })

  test("a refused patch changes nothing for its row", () => {
    create(A, M1)
    update(
      A,
      M1,
      [
        { id: "1", status: "running", acquire: ["lock:build"] },
        { id: "2", status: "running" },
      ],
      [
        { id: "1", ok: false, code: "DEP_NOT_DONE" },
        { id: "2", ok: true },
      ],
    )
    expect(MissionBinding.get(A)?.runningRows).toEqual(["2"])
    expect(MissionBinding.get(A)?.locks).toEqual([])
  })

  test("a checkpoint-only patch has no result entry and does not shift the others", () => {
    create(A, M1)
    update(
      A,
      M1,
      [
        { id: "1", checkpoint: { n: 1, m: 3 } },
        { id: "2", status: "running" },
      ],
      [{ id: "2", ok: true }],
    )
    expect(MissionBinding.get(A)?.runningRows).toEqual(["2"])
  })

  test("update_row alone binds an unbound session (after a restart)", () => {
    update(A, M1, [{ id: "3", status: "running" }])
    expect(MissionBinding.get(A)?.missionID).toBe(M1)
    expect(MissionBinding.get(A)?.runningRows).toEqual(["3"])
  })

  test("set_status running binds and keeps the rows of the same mission", () => {
    create(A, M1)
    update(A, M1, [{ id: "1", status: "running" }])
    MissionBinding.observe({
      sessionID: A,
      tool: "studio_mission_set_status",
      args: { mission: M1, to: "paused" },
      result: statusSet(M1, "running", "paused"),
    })
    expect(MissionBinding.get(A)?.runningRows).toEqual(["1"])
  })

  test("get replaces rows, locks and knowledge with the mission state it returns", () => {
    create(A, M1)
    update(A, M1, [{ id: "9", status: "running", acquire: ["lock:old"] }])
    const out = MissionBinding.observe({
      sessionID: A,
      tool: "studio_mission_get",
      args: { mission: M1 },
      result: got({
        id: M1,
        status: "running",
        rows: [
          { id: "1", status: "done" },
          {
            id: "2",
            status: "running",
            knowledge: { domains: [{ domain: "COMPUTER-VISION", firstFile: "cv/00_index.md", consulted: [] }] },
          },
          { id: "3", status: "pending", knowledge: { domains: [{ domain: "RADAR", firstFile: "radar/00.md" }] } },
        ],
        locks: [
          { resource: "lock:build", row: "2", holder: "h", acquiredAt: "2026-11-17T00:00:00Z" },
          { resource: "lock:gone", row: "1", holder: "h", acquiredAt: "2026-11-17T00:00:00Z", releasedAt: "2026-11-17T01:00:00Z" },
        ],
      }),
    })
    expect(out).toBe("set")
    const b = MissionBinding.get(A)
    expect(b?.runningRows).toEqual(["2"])
    expect(b?.locks).toEqual(["lock:build"])
    expect(b?.knowledge).toEqual([{ row: "2", domain: "COMPUTER-VISION", firstFile: "cv/00_index.md" }])
  })

  test("get without rows (include: decisions) keeps the rows already known", () => {
    create(A, M1)
    update(A, M1, [{ id: "1", status: "running", acquire: ["lock:build"] }])
    MissionBinding.observe({
      sessionID: A,
      tool: "studio_mission_get",
      args: { mission: M1, include: ["decisions"] },
      result: got({ id: M1, status: "running", decisions: [] }),
    })
    expect(MissionBinding.get(A)?.runningRows).toEqual(["1"])
    expect(MissionBinding.get(A)?.locks).toEqual(["lock:build"])
  })

  test("get binds an unbound session to an open mission, and never switches a bound one", () => {
    MissionBinding.observe({
      sessionID: A,
      tool: "studio_mission_get",
      args: { mission: M1 },
      result: got({ id: M1, status: "running", rows: [{ id: "1", status: "running" }] }),
    })
    expect(MissionBinding.get(A)?.missionID).toBe(M1)
    const out = MissionBinding.observe({
      sessionID: A,
      tool: "studio_mission_get",
      args: { mission: M2 },
      result: got({ id: M2, status: "running", rows: [{ id: "7", status: "running" }] }),
    })
    expect(out).toBe("none")
    expect(MissionBinding.get(A)?.missionID).toBe(M1)
    expect(MissionBinding.get(A)?.runningRows).toEqual(["1"])
  })

  test("a write to another mission moves the binding to it", () => {
    create(A, M1)
    update(A, M1, [{ id: "1", status: "running" }])
    update(A, M2, [{ id: "5", status: "running" }])
    expect(MissionBinding.get(A)?.missionID).toBe(M2)
    expect(MissionBinding.get(A)?.runningRows).toEqual(["5"])
  })
})

describe("MissionBinding: cleared", () => {
  for (const to of ["done", "cancelled"]) {
    test(`set_status ${to} clears the binding`, () => {
      create(A, M1)
      update(A, M1, [{ id: "1", status: "running" }])
      const out = MissionBinding.observe({
        sessionID: A,
        tool: "studio_mission_set_status",
        args: { mission: M1, to },
        result: statusSet(M1, "running", to),
      })
      expect(out).toBe("cleared")
      expect(MissionBinding.get(A)).toBeUndefined()
      expect(MissionBinding.hasRunningRow(A)).toBe(false)
    })
  }

  test("closing another mission leaves the binding", () => {
    create(A, M1)
    MissionBinding.observe({
      sessionID: A,
      tool: "studio_mission_set_status",
      args: { mission: M2, to: "done" },
      result: statusSet(M2, "running", "done"),
    })
    expect(MissionBinding.get(A)?.missionID).toBe(M1)
  })

  test("get that shows the bound mission closed clears it; a closed mission never binds", () => {
    create(A, M1)
    MissionBinding.observe({
      sessionID: A,
      tool: "studio_mission_get",
      args: { mission: M1 },
      result: got({ id: M1, status: "done", rows: [] }),
    })
    expect(MissionBinding.get(A)).toBeUndefined()
    MissionBinding.observe({
      sessionID: A,
      tool: "studio_mission_get",
      args: { mission: M1 },
      result: got({ id: M1, status: "cancelled", rows: [] }),
    })
    expect(MissionBinding.get(A)).toBeUndefined()
  })

  test("list that shows the bound mission closed clears it, and never binds", () => {
    MissionBinding.observe({
      sessionID: A,
      tool: "studio_mission_list",
      args: {},
      result: ok("studio_mission_list", { items: [{ id: M1, status: "running" }] }),
    })
    expect(MissionBinding.get(A)).toBeUndefined()
    create(A, M1)
    MissionBinding.observe({
      sessionID: A,
      tool: "studio_mission_list",
      args: {},
      result: ok("studio_mission_list", { items: [{ id: M2, status: "done" }, { id: M1, status: "cancelled" }] }),
    })
    expect(MissionBinding.get(A)).toBeUndefined()
  })

  test("clear(sessionID) forgets one session only", () => {
    create(A, M1)
    create(B, M2)
    MissionBinding.clear(A)
    expect(MissionBinding.get(A)).toBeUndefined()
    expect(MissionBinding.get(B)?.missionID).toBe(M2)
  })
})

describe("MissionBinding: other sessions", () => {
  test("a binding is absent in every other session", () => {
    create(A, M1)
    update(A, M1, [{ id: "1", status: "running" }])
    expect(MissionBinding.get(B)).toBeUndefined()
    expect(MissionBinding.hasRunningRow(B)).toBe(false)
  })

  test("two sessions hold separate bindings; closing one leaves the other", () => {
    create(A, M1)
    create(B, M2)
    update(B, M2, [{ id: "4", status: "running" }])
    MissionBinding.observe({
      sessionID: A,
      tool: "studio_mission_set_status",
      args: { mission: M1, to: "done" },
      result: statusSet(M1, "running", "done"),
    })
    expect(MissionBinding.get(A)).toBeUndefined()
    expect(MissionBinding.get(B)?.runningRows).toEqual(["4"])
  })

  test("what get returns is a copy: changing it does not change the binding", () => {
    create(A, M1)
    update(A, M1, [{ id: "1", status: "running" }])
    const b = MissionBinding.get(A)!
    b.runningRows.push("x")
    b.missionID = "other"
    expect(MissionBinding.get(A)?.runningRows).toEqual(["1"])
    expect(MissionBinding.get(A)?.missionID).toBe(M1)
  })
})

describe("MissionBinding: results that do not match change nothing", () => {
  const cases: Array<[string, { tool: string; args: unknown; result: unknown }]> = [
    ["dry run in the result", { tool: "studio_mission_create", args: { mission: { id: M1 } }, result: created(M1, { dryRun: true }) }],
    ["dry run in the arguments", { tool: "studio_mission_create", args: { mission: { id: M1 }, dryRun: true }, result: created(M1) }],
    ["a refusal", { tool: "studio_mission_create", args: {}, result: { isError: true, content: [], structuredContent: { ok: false, tool: "studio_mission_create", code: "SCHEMA_INVALID" } } }],
    ["no structuredContent", { tool: "studio_mission_create", args: { mission: { id: M1 } }, result: { content: [{ type: "text", text: `mission ${M1} created` }] } }],
    ["structuredContent of another tool", { tool: "studio_mission_create", args: {}, result: ok("studio_document_create", { id: "doc" }) }],
    ["id is not a string", { tool: "studio_mission_create", args: {}, result: created(M1, { id: 7 }) }],
    ["a mission tool that carries no state", { tool: "studio_mission_record_decision", args: { mission: M1 }, result: ok("studio_mission_record_decision", { id: "C1" }) }],
    ["a tool that is not a mission tool", { tool: "studio_write", args: { mission: M1 }, result: ok("studio_write", { id: M1 }) }],
    ["update_row without a mission argument", { tool: "studio_mission_update_row", args: { rows: [{ id: "1", status: "running" }] }, result: rowsUpdated([{ id: "1", ok: true }]) }],
    ["update_row without results", { tool: "studio_mission_update_row", args: { mission: M1, rows: [{ id: "1", status: "running" }] }, result: ok("studio_mission_update_row", { changed: ["1"] }) }],
    ["result is a string", { tool: "studio_mission_get", args: { mission: M1 }, result: "mission" }],
    ["result is null", { tool: "studio_mission_get", args: { mission: M1 }, result: null }],
    ["get with an unknown status", { tool: "studio_mission_get", args: { mission: M1 }, result: got({ id: M1, status: "archived", rows: [] }) }],
  ]
  for (const [name, input] of cases) {
    test(name, () => {
      expect(MissionBinding.observe({ sessionID: A, ...input })).toBe("none")
      expect(MissionBinding.get(A)).toBeUndefined()
    })
  }

  test("an empty session id is ignored", () => {
    expect(MissionBinding.observe({ sessionID: "", tool: "studio_mission_create", args: {}, result: created(M1) })).toBe("none")
    expect(MissionBinding.get("")).toBeUndefined()
  })

  test("a malformed result leaves an existing binding as it was", () => {
    create(A, M1)
    update(A, M1, [{ id: "1", status: "running" }])
    const before = MissionBinding.get(A)
    MissionBinding.observe({ sessionID: A, tool: "studio_mission_update_row", args: { mission: M1, rows: "x" }, result: rowsUpdated([]) })
    MissionBinding.observe({ sessionID: A, tool: "studio_mission_get", args: { mission: M1 }, result: got({ id: M1, status: "running", rows: "x", locks: 3 }) })
    expect(MissionBinding.get(A)?.runningRows).toEqual(before!.runningRows)
    expect(MissionBinding.get(A)?.locks).toEqual(before!.locks)
  })

  test("malformed rows inside a get are skipped, the good ones kept", () => {
    MissionBinding.observe({
      sessionID: A,
      tool: "studio_mission_get",
      args: { mission: M1 },
      result: got({ id: M1, status: "running", rows: [null, 4, { id: 5, status: "running" }, { id: "2", status: "running", knowledge: { domains: [{ domain: 1 }, "x"] } }] }),
    })
    expect(MissionBinding.get(A)?.runningRows).toEqual(["2"])
    expect(MissionBinding.get(A)?.knowledge).toEqual([])
  })
})

describe("MissionBinding: bounds", () => {
  test("the oldest session is dropped once more than MAX_SESSIONS are bound", () => {
    for (let i = 0; i <= MissionBinding.MAX_SESSIONS; i++) create(`ses_${i}`, M1)
    expect(MissionBinding.get("ses_0")).toBeUndefined()
    expect(MissionBinding.get("ses_1")?.missionID).toBe(M1)
    expect(MissionBinding.get(`ses_${MissionBinding.MAX_SESSIONS}`)?.missionID).toBe(M1)
  })
})

// --- The hook in session/tools.ts: the real SessionTools.resolve path with a stub Studio client ----------------------
// Harness as in rel128-sk-g-suggest.test.ts (N8-048): the MCP service lists the built-in server's tools (global origin)
// and a project server of the same name (a look-alike); `reply` is what the stub client returns for the next call.

let reply: Record<string, unknown> = { content: [{ type: "text", text: "ok" }] }
const client = { callTool: async () => reply } as unknown as MCP.McpTool["client"]
const def = (name: string) => ({ name, description: name, inputSchema: { type: "object" as const, properties: {} } })
const builtin: MCP.Source = { server: DatumStudioMcp.DATUM_STUDIO_MCP, transport: "remote", origin: "global" }
const lookalike: MCP.Source = { server: DatumStudioMcp.DATUM_STUDIO_MCP, transport: "remote", origin: "project" }

const withTools = testEffect(
  Layer.mergeAll(
    Layer.succeed(
      Plugin.Service,
      Plugin.Service.of({
        init: () => Effect.void,
        list: () => Effect.succeed([]),
        trigger: (_name, _input, output) => Effect.succeed(output),
      } satisfies Plugin.Interface),
    ),
    Layer.succeed(
      Permission.Service,
      Permission.Service.of({
        ask: () => Effect.void,
        reply: () => Effect.succeed(undefined),
        grant: () => Effect.void,
        list: () => Effect.succeed([]),
      } satisfies Permission.Interface),
    ),
    Layer.succeed(
      MCP.Service,
      MCP.Service.of({
        tools: () =>
          Effect.succeed({
            "datum-studio_studio_mission_create": { def: def("studio_mission_create"), client, source: builtin },
            "datum-studio_studio_mission_update_row": { def: def("studio_mission_update_row"), client, source: builtin },
            "datum-studio_studio_mission_set_status": { def: def("studio_mission_set_status"), client, source: builtin },
            "lookalike_studio_mission_create": { def: def("studio_mission_create"), client, source: lookalike },
          }),
        clients: () => Effect.succeed({}),
      } as Partial<MCP.Interface> as MCP.Interface),
    ),
    Layer.succeed(
      Truncate.Service,
      Truncate.Service.of({
        cleanup: () => Effect.void,
        write: () => Effect.succeed("output.txt"),
        output: (text: string) => Effect.succeed({ content: text, truncated: false }),
        limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50 * 1024 }),
      } satisfies Truncate.Interface),
    ),
    RuntimeFlags.layer(),
    Layer.succeed(
      ToolRegistry.Service,
      ToolRegistry.Service.of({
        ids: () => Effect.succeed([]),
        all: () => Effect.succeed([]),
        named: () => Effect.die("unused"),
        tools: () => Effect.succeed([]),
      }),
    ),
    Layer.succeed(
      Skill.Service,
      Skill.Service.of({
        get: () => Effect.succeed(undefined),
        require: () => Effect.die("unused"),
        all: () => Effect.succeed([]),
        dirs: () => Effect.succeed([]),
        available: () => Effect.succeed([]),
        folders: () => Effect.succeed([]),
      } as Skill.Interface),
    ),
  ),
)

const agent: Agent.Info = { name: "build", mode: "primary", permission: Permission.fromConfig({ "*": "allow" }), options: {} }

const resolveFor = (session: SessionID) =>
  SessionTools.resolve({
    agent,
    model: { providerID: ProviderV2.ID.make("test"), api: { id: "test-model" } } as Provider.Model,
    session: { id: session, directory: "/syn/row9", permission: [] } as unknown as Session.Info,
    processor: {
      message: {
        id: MessageID.ascending(),
        sessionID: session,
        role: "assistant",
        parentID: MessageID.ascending(),
        agent: "build",
        mode: "build",
        path: { cwd: "/syn", root: "/syn" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: 1 },
      },
      updateToolCall: () => Effect.succeed(undefined),
      completeToolCall: () => Effect.void,
    } as unknown as Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">,
    bypassAgentCheck: false,
    messages: [],
    promptOps: {} as never,
  })

const call = (tools: Record<string, { execute?: (...a: any[]) => any }>, key: string, args: Record<string, unknown>, next: Record<string, unknown>) =>
  Effect.promise(async () => {
    reply = next
    return tools[key]!.execute!(args, { toolCallId: `call-${Math.random()}`, abortSignal: new AbortController().signal, messages: [] })
  })

describe("MissionBinding: the hook in session/tools.ts", () => {
  const S1 = SessionID.make("ses_row9one")
  const S2 = SessionID.make("ses_row9two")

  withTools.instance("mission calls of the built-in server bind the calling session, a close clears it, another session sees nothing", () =>
    Effect.gen(function* () {
      const tools = yield* resolveFor(S1)
      yield* resolveFor(S2)

      yield* call(tools, "datum-studio_studio_mission_create", { mission: { id: M1, type: "generic" } }, created(M1))
      expect(MissionBinding.get(S1)?.missionID).toBe(M1)
      expect(MissionBinding.hasRunningRow(S1)).toBe(false)

      yield* call(
        tools,
        "datum-studio_studio_mission_update_row",
        { mission: M1, rows: [{ id: "1", status: "running", acquire: ["lock:build"] }] },
        rowsUpdated([{ id: "1", ok: true }]),
      )
      expect(MissionBinding.get(S1)?.runningRows).toEqual(["1"])
      expect(MissionBinding.get(S1)?.locks).toEqual(["lock:build"])
      expect(MissionBinding.hasRunningRow(S1)).toBe(true)
      expect(MissionBinding.get(S2)).toBeUndefined()
      expect(MissionBinding.hasRunningRow(S2)).toBe(false)

      yield* call(tools, "datum-studio_studio_mission_set_status", { mission: M1, to: "done" }, statusSet(M1, "running", "done"))
      expect(MissionBinding.get(S1)).toBeUndefined()
    }),
  )

  withTools.instance("a refused call and a look-alike project server bind nothing", () =>
    Effect.gen(function* () {
      const tools = yield* resolveFor(S1)
      const refused = yield* call(tools, "datum-studio_studio_mission_create", { mission: { id: M1 } }, {
        content: [{ type: "text", text: "ditolak SCHEMA_INVALID: x" }],
        structuredContent: { ok: false, tool: "studio_mission_create", code: "SCHEMA_INVALID" },
        isError: true,
      }).pipe(Effect.exit)
      expect(refused._tag).toBe("Failure")
      expect(MissionBinding.get(S1)).toBeUndefined()

      yield* call(tools, "lookalike_studio_mission_create", { mission: { id: M1 } }, created(M1))
      expect(MissionBinding.get(S1)).toBeUndefined()
    }),
  )
})
