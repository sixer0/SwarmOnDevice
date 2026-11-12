import { expect } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"

const callID = "call-test"
const sessionID = SessionID.make("ses_test")
const messageID = MessageID.ascending()

const agent: Agent.Info = {
  name: "build",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
}

const model = {
  providerID: ProviderV2.ID.make("test"),
  api: { id: "test-model" },
} as Provider.Model

// SEC-21 remainder (1.2.6 row 40, routed from row 53b): the permission ask before an MCP call ends when the session's
// abort signal fires. Before, the ask kept waiting (for good on a request that needs a person) after the stop.
const calls: string[] = []
const client = {
  callTool: async () => {
    calls.push("callTool")
    return { content: [{ type: "text", text: "ran" }] }
  },
}

function fakeMcp() {
  return MCP.Service.of({
    tools: () =>
      Effect.succeed({
        demo_probe: {
          def: { name: "probe", description: "a stub", inputSchema: { type: "object", properties: {} } },
          client,
          source: { origin: "project" },
        },
      }),
    clients: () => Effect.succeed({}),
  } as unknown as Partial<MCP.Interface> as MCP.Interface)
}

const fakePlugin = Plugin.Service.of({
  init: () => Effect.void,
  list: () => Effect.succeed([]),
  trigger: (_name, _input, output) => Effect.succeed(output),
} satisfies Plugin.Interface)

// Nobody answers: the ask waits until it is interrupted.
const fakePermission = Permission.Service.of({
  ask: () => Effect.never,
  reply: () => Effect.succeed(undefined),
  grant: () => Effect.void,
  list: () => Effect.succeed([]),
} satisfies Permission.Interface)

const fakeTruncate = Truncate.Service.of({
  cleanup: () => Effect.void,
  write: () => Effect.succeed("output.txt"),
  output: (text: string) => Effect.succeed({ content: text, truncated: false }),
  limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50 * 1024 }),
} satisfies Truncate.Interface)

const layer = Layer.mergeAll(
  Layer.succeed(Plugin.Service, fakePlugin),
  Layer.succeed(Permission.Service, fakePermission),
  Layer.succeed(MCP.Service, fakeMcp()),
  Layer.succeed(Truncate.Service, fakeTruncate),
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
)

const it = testEffect(layer)

const processor = {
  message: {
    id: messageID,
    sessionID,
    role: "assistant",
    parentID: MessageID.ascending(),
    agent: "build",
    mode: "build",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make("test"),
    time: { created: 1 },
  } satisfies SessionV1.Assistant,
  updateToolCall: (_toolCallID, update) =>
    Effect.sync(() =>
      update({
        id: "prt_probe",
        sessionID,
        messageID,
        type: "tool",
        tool: "demo_probe",
        callID,
        state: { status: "running", input: {}, time: { start: 1 } },
      } as SessionV1.ToolPart),
    ),
  completeToolCall: () => Effect.void,
} satisfies Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">


it.effect("SEC-21: a session abort ends the permission ask before an MCP call, and the call does not run", () =>
  Effect.gen(function* () {

    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })
    const execute = tools.demo_probe?.execute
    if (!execute) throw new Error("demo_probe tool is missing execute")

    const controller = new AbortController()
    const started = Date.now()
    const outcome = execute({}, { toolCallId: callID, abortSignal: controller.signal, messages: [] }).then(
      () => "resolved",
      () => "rejected",
    )
    setTimeout(() => controller.abort(), 50)
    const ended = yield* Effect.promise(() =>
      Promise.race([outcome, new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 1000))]),
    )
    expect(ended).toBe("rejected")
    expect(Date.now() - started).toBeLessThan(1000)
    expect(calls).toEqual([])
  }),
)

it.effect("SEC-21: an already aborted session does not ask and does not call", () =>
  Effect.gen(function* () {
    const controller = new AbortController()
    controller.abort()
    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })
    const ended = yield* Effect.promise(() =>
      Promise.race([
        tools.demo_probe!.execute!({}, { toolCallId: callID, abortSignal: controller.signal, messages: [] }).then(
          () => "resolved",
          () => "rejected",
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 1000)),
      ]),
    )
    expect(ended).toBe("rejected")
    expect(calls).toEqual([])
  }),
)
