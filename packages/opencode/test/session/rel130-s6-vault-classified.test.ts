// Swarm 1.3.0 row 134, AC-S6b with fold F7 (S13-06), N13-343: opencode refuses a swarm-web vault inbox write whose name,
// slug or content holds a classification word, after the `tool.execute.before` hook and before the permission ask, on a
// clone of the final args. A refused call asks nothing and never reaches the MCP client; a clean note goes through once.
// Red at BASE a3e3c4c93a: there is no check, so every write reaches the client.
// The four words appear here only as rule subjects (synthetic corpus, syn129). No vault, no HOME and no network is used.
import { beforeEach, describe, expect } from "bun:test"
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

const callID = "call-s6b"
const sessionID = SessionID.make("ses_s6b")
const messageID = MessageID.ascending()
const STAGED_PROXY = "~/.swarm/setup/bin/swarm-web-proxy"

const agent: Agent.Info = {
  name: "build",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
}

const model = { providerID: ProviderV2.ID.make("test"), api: { id: "test-model" } } as Provider.Model

// The fake MCP client records every call and the arguments it was sent.
let calls: { name: string; arguments: Record<string, unknown> }[] = []
let asks: unknown[] = []
// A test plugin's `tool.execute.before` hook, set per test.
let beforeHook: ((output: { args: Record<string, unknown> }) => void) | undefined
// Runs inside the ask, after the check: a plugin that kept a reference to the args it saw.
let duringAsk: (() => void) | undefined

const client = {
  callTool: async (request: { name: string; arguments: Record<string, unknown> }) => {
    calls.push({ name: request.name, arguments: structuredClone(request.arguments) })
    return { content: [{ type: "text", text: "Wrote note" }] }
  },
}

const vaultDef = {
  name: "vault_inbox",
  description: "vault inbox (stub)",
  inputSchema: {
    type: "object",
    properties: { action: { type: "string" }, name: { type: "string" }, content: { type: "string" } },
  },
}

const fakeMcp = MCP.Service.of({
  tools: () =>
    Effect.succeed({
      "swarm-web_vault_inbox": {
        def: vaultDef,
        client,
        source: { server: "swarm-web", transport: "local", origin: "global" },
      },
      // F7: the same proxy (staged-proxy command) under a renamed server entry `web`.
      web_vault_inbox: {
        def: { ...vaultDef, description: `vault inbox via ${STAGED_PROXY} (stub)` },
        client,
        source: { server: "web", transport: "local", origin: "global" },
      },
      demo_probe: {
        def: { name: "probe", description: "a stub", inputSchema: { type: "object", properties: {} } },
        client,
        source: { server: "demo", transport: "local", origin: "project" },
      },
    }),
  clients: () => Effect.succeed({}),
} as unknown as Partial<MCP.Interface> as MCP.Interface)

const fakePlugin = Plugin.Service.of({
  init: () => Effect.void,
  list: () => Effect.succeed([]),
  trigger: (name, _input, output) =>
    Effect.sync(() => {
      if (name === "tool.execute.before" && beforeHook) beforeHook(output as { args: Record<string, unknown> })
      return output
    }),
} satisfies Plugin.Interface)

const fakePermission = Permission.Service.of({
  ask: (request) =>
    Effect.sync(() => {
      asks.push(request)
      duringAsk?.()
    }),
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

const it = testEffect(
  Layer.mergeAll(
    Layer.succeed(Plugin.Service, fakePlugin),
    Layer.succeed(Permission.Service, fakePermission),
    Layer.succeed(MCP.Service, fakeMcp),
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
  ),
)

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
        id: "prt_s6b",
        sessionID,
        messageID,
        type: "tool",
        tool: "swarm-web_vault_inbox",
        callID,
        state: { status: "running", input: {}, time: { start: 1 } },
      } as SessionV1.ToolPart),
    ),
  completeToolCall: () => Effect.void,
} satisfies Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">

type Outcome = { output: string }

/** Resolves the session tools and runs one call of `key` with `args`; returns the text the model would read. */
const call = (key: string, args: Record<string, unknown>) =>
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
    const execute = tools[key]?.execute
    if (!execute) throw new Error(`${key} is missing execute`)
    const result = (yield* Effect.promise(() =>
      execute(args, { toolCallId: callID, abortSignal: new AbortController().signal, messages: [] }),
    )) as { output: string }
    return { output: result.output } satisfies Outcome
  })

const CLASSIFIED_PREFIX = "BLOCKED_BY_POLICY: classified_content: the note holds the classification word "
const SHAPE =
  "BLOCKED_BY_POLICY: name must be a safe basename inside the inbox (no traversal, absolute paths, NUL, newlines, or symlink escapes)."
const CLEAN = { action: "write", name: "mission-m-syn129", content: "mission m-syn129, 2026-11-14, status done" }

/** A refused call: the proxy's text, no ask and no client call. */
function expectRefused(outcome: Outcome, text: string) {
  expect(outcome.output).toStartWith(text)
  expect({ calls: calls.length, asks: asks.length }).toEqual({ calls: 0, asks: 0 })
}

beforeEach(() => {
  calls = []
  asks = []
  beforeHook = undefined
  duringAsk = undefined
})

describe("N13-343 (AC-S6b) a classified vault inbox write is refused before the ask and the call", () => {
  it.instance("the word in the content is refused with the proxy's text, 0 calls and 0 asks", () =>
    Effect.gen(function* () {
      const outcome = yield* call("swarm-web_vault_inbox", { ...CLEAN, content: "status of the RAHASIA plan" })
      expectRefused(outcome, `${CLASSIFIED_PREFIX}RAHASIA; nothing was written.`)
    }),
  )

  it.instance("the word in the name is refused", () =>
    Effect.gen(function* () {
      expectRefused(
        yield* call("swarm-web_vault_inbox", { ...CLEAN, name: "confidential plan" }),
        `${CLASSIFIED_PREFIX}CONFIDENTIAL;`,
      )
    }),
  )

  it.instance("the word as a first-line marker is refused", () =>
    Effect.gen(function* () {
      expectRefused(
        yield* call("swarm-web_vault_inbox", { ...CLEAN, content: "TERBATAS\nmission m-syn129, status done" }),
        `${CLASSIFIED_PREFIX}TERBATAS;`,
      )
    }),
  )

  it.instance("F7: a slug-only hit (`TERBATAS_note`, whose slug is `terbatas-note`) is refused", () =>
    Effect.gen(function* () {
      expect(SessionTools.slugify("TERBATAS_note")).toBe("terbatas-note")
      expectRefused(
        yield* call("swarm-web_vault_inbox", { ...CLEAN, name: "TERBATAS_note" }),
        `${CLASSIFIED_PREFIX}TERBATAS;`,
      )
    }),
  )

  it.instance("F7: a plugin that rewrites the content in tool.execute.before is checked on what it wrote", () =>
    Effect.gen(function* () {
      beforeHook = (output) => {
        output.args.content = "now RESTRICTED"
      }
      expectRefused(yield* call("swarm-web_vault_inbox", { ...CLEAN }), `${CLASSIFIED_PREFIX}RESTRICTED;`)
    }),
  )

  it.instance("F7: a plugin that replaces the args object is checked on the new object", () =>
    Effect.gen(function* () {
      beforeHook = (output) => {
        output.args = { ...CLEAN, name: "rahasia" }
      }
      expectRefused(yield* call("swarm-web_vault_inbox", { ...CLEAN }), `${CLASSIFIED_PREFIX}RAHASIA;`)
    }),
  )

  it.instance("F7: `action: \"WRITE\"` and an absent action are checked as writes", () =>
    Effect.gen(function* () {
      expectRefused(
        yield* call("swarm-web_vault_inbox", { ...CLEAN, action: "WRITE", content: "RAHASIA" }),
        CLASSIFIED_PREFIX,
      )
      expectRefused(yield* call("swarm-web_vault_inbox", { name: CLEAN.name, content: "RAHASIA" }), CLASSIFIED_PREFIX)
      // The same calls without the word go through: the check does not refuse an unusual action on its own.
      const clean = yield* call("swarm-web_vault_inbox", { ...CLEAN, action: "WRITE" })
      expect(clean.output).toBe("Wrote note")
      expect(calls).toHaveLength(1)
    }),
  )

  it.instance("F7: a renamed server (`web`) running the staged proxy is checked", () =>
    Effect.gen(function* () {
      expectRefused(yield* call("web_vault_inbox", { ...CLEAN, content: "Confidential" }), `${CLASSIFIED_PREFIX}CONFIDENTIAL;`)
    }),
  )

  it.instance("F7: a name or content that is not a string is refused with the proxy's shape text", () =>
    Effect.gen(function* () {
      expectRefused(yield* call("swarm-web_vault_inbox", { ...CLEAN, content: ["RAHASIA"] }), SHAPE)
      expectRefused(yield* call("swarm-web_vault_inbox", { ...CLEAN, name: 7 }), SHAPE)
      expectRefused(yield* call("swarm-web_vault_inbox", { action: "write", name: CLEAN.name }), SHAPE)
    }),
  )

  it.instance("a clean note goes through: 1 ask, 1 client call, with the args it was checked on", () =>
    Effect.gen(function* () {
      const outcome = yield* call("swarm-web_vault_inbox", { ...CLEAN })
      expect(outcome.output).toBe("Wrote note")
      expect({ calls: calls.length, asks: asks.length }).toEqual({ calls: 1, asks: 1 })
      expect(calls[0]).toEqual({ name: "vault_inbox", arguments: CLEAN })
    }),
  )

  it.instance("F7: the call sends the checked clone, so a plugin that kept the args object cannot change it later", () =>
    Effect.gen(function* () {
      let kept: Record<string, unknown> | undefined
      beforeHook = (output) => {
        kept = output.args
      }
      duringAsk = () => {
        if (kept) kept.content = "RAHASIA"
      }
      const outcome = yield* call("swarm-web_vault_inbox", { ...CLEAN })
      expect(outcome.output).toBe("Wrote note")
      expect(calls).toHaveLength(1)
      expect(calls[0]!.arguments.content).toBe(CLEAN.content)
    }),
  )

  it.instance("list and read are not checked, and another server's tool is untouched", () =>
    Effect.gen(function* () {
      yield* call("swarm-web_vault_inbox", { action: "list" })
      yield* call("swarm-web_vault_inbox", { action: "read", name: "RAHASIA.md" })
      yield* call("demo_probe", { note: "RAHASIA" })
      expect({ calls: calls.length, asks: asks.length }).toEqual({ calls: 3, asks: 3 })
    }),
  )
})
