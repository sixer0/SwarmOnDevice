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
// Row 147 (block "inbox"): namespace imports only, so the file loads at BASE and the block fails there by its assertions.
import { afterAll, afterEach, beforeAll, spyOn, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import * as osModule from "node:os"
import path from "node:path"
import { Cause, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as TableModule from "../../src/permission/autonomy-table"
import * as Texts from "../../src/permission/autonomy-texts"
import * as ReachModule from "../../src/tool/reach"
import type { InstanceContext } from "../../src/project/instance-context"
import { readSteps } from "../../src/tool/shell"
import { WriteTool } from "../../src/tool/write"
import { EditTool } from "../../src/tool/edit"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { LSP } from "@/lsp/lsp"
import { Format } from "../../src/format"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

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

// ---------------------------------------------------------------------------------------------------------------------
// Swarm 1.3.0 row 147, block "inbox": AC-S6-INBOX (C95 S13-07, folded F8, N13-408 text, N13-409 class `vault_inbox`).
// An agent's own write into `<vault>/inbox/**` (Write, Edit, apply_patch, a shell redirect, tee, cp, mv, rm, sed -i, an
// interpreter's inline code) is refused in every mode with VAULT_INBOX_TOOL_ONLY_TEXT, so a note reaches the inbox only
// through swarm-web_vault_inbox, which checks the classification words. The edit tools refuse before any prompt (mode
// off, a person's "always" present); the autonomy table refuses an edit or a shell write as X `vault_inbox` with the mode
// on and under the consent, a consent item covering the file included. Reads of the inbox and writes elsewhere in the
// vault (`other/`, a sibling `inbox-old/`) are judged as before. Red at BASE a3e3c4c93a: nothing refuses an inbox write.
// HOME and the vault are mkdtemp folders with `os.homedir` stubbed; files are synthetic; no real ~/.swarm is touched.
// ---------------------------------------------------------------------------------------------------------------------

// N13-408, written out so the test does not take it from the code under test.
const N13_408 = "Write inbox notes with swarm-web_vault_inbox, which checks classification words."

describe("inbox: agent writes into <vault>/inbox/ are refused with VAULT_INBOX_TOOL_ONLY_TEXT", () => {
  const { AutonomyTable } = TableModule
  const Reach = ReachModule.Reach as typeof ReachModule.Reach & Record<string, any>
  let fixture: Awaited<ReturnType<typeof tmpdir>>
  let dir: string
  let instance: InstanceContext
  let home: string
  let vault: string
  let inbox: string
  let note: string
  let spies: { mockRestore(): void }[] = []
  const saved = { vault: process.env.SWARM_VAULT_DIR, disable: process.env.SWARM_DISABLE_MEMORY }

  function seedVault(root: string) {
    for (const sub of ["inbox", "other", "inbox-old", "swarm-memory/x"]) mkdirSync(path.join(root, sub), { recursive: true })
    writeFileSync(path.join(root, "inbox/x.md"), "synthetic inbox note\n")
    writeFileSync(path.join(root, "other/own.md"), "synthetic own note\n")
  }

  beforeAll(async () => {
    fixture = await tmpdir({ git: true })
    dir = fixture.path
    instance = { directory: dir, worktree: dir, project: { vcs: "git" } } as InstanceContext
    execFileSync("git", ["config", "--unset", "core.fsmonitor"], { cwd: dir })
    execFileSync("git", ["config", "--unset", "commit.gpgsign"], { cwd: dir })
    writeFileSync(path.join(dir, "a.md"), "synthetic\n")
    home = mkdtempSync(path.join(os.tmpdir(), "s147h-"))
    vault = mkdtempSync(path.join(os.tmpdir(), "s147v-"))
    seedVault(vault)
    inbox = path.join(vault, "inbox")
    note = path.join(inbox, "x.md")
    process.env.SWARM_VAULT_DIR = vault
    delete process.env.SWARM_DISABLE_MEMORY
    spies = [spyOn(os, "homedir").mockReturnValue(home), spyOn(osModule, "homedir").mockReturnValue(home)]
  })
  afterAll(async () => {
    for (const spy of spies) spy.mockRestore()
    if (saved.vault === undefined) delete process.env.SWARM_VAULT_DIR
    else process.env.SWARM_VAULT_DIR = saved.vault
    if (saved.disable !== undefined) process.env.SWARM_DISABLE_MEMORY = saved.disable
    rmSync(home, { recursive: true, force: true })
    rmSync(vault, { recursive: true, force: true })
    await fixture[Symbol.asyncDispose]()
  })

  type Mode = "on" | "consent"
  const MODES = ["on", "consent"] as const
  const ROLES = [undefined, "build", "coder", "verifier", "planner"] as const

  function editInput(file: string, mode: Mode, agent?: string, editClass?: string): TableModule.AutonomyTable.Input {
    return {
      permission: "edit",
      patterns: [path.relative(dir, file)],
      metadata: { filepath: file },
      instance,
      cwd: dir,
      canUndo: true,
      folder: "clean",
      editClass: (editClass ?? "no_undo") as TableModule.AutonomyTable.Input["editClass"],
      ...(agent !== undefined && { agent }),
      ...(mode === "consent" && {
        bypass: { caller: agent === undefined || agent === "build" ? "root" : "subagent" },
        consent: { id: "c1", files: new Map([[file, "item-1"]]) },
      }),
    } as TableModule.AutonomyTable.Input
  }

  async function shellInput(command: string, mode: Mode, consented: string[] = []): Promise<TableModule.AutonomyTable.Input> {
    return {
      permission: "bash",
      patterns: [command],
      metadata: { command, workdir: dir, steps: await readSteps(command, dir) },
      instance,
      cwd: dir,
      canUndo: true,
      folder: "clean",
      ...(mode === "consent" && {
        bypass: { caller: "root" as const },
        consent: { id: "c1", files: new Map(consented.map((file) => [file, "item-1"])) },
      }),
    } as TableModule.AutonomyTable.Input
  }

  const verdictOf = (input: TableModule.AutonomyTable.Input) =>
    input.bypass ? AutonomyTable.classify(input) : AutonomyTable.classifyBase(input)
  const trust = (files: string[], canUndo = true) =>
    Effect.runPromiseExit(Reach.editTrust({ trust: { canUndo } }, instance, files) as Effect.Effect<unknown>)
  const failure = (exit: Exit.Exit<unknown, unknown>) => {
    if (!Exit.isFailure(exit)) return "succeeded"
    const error = Cause.squash(exit.cause)
    return error instanceof Error ? error.message : String(error)
  }

  test("N13-408 text, the vault_inbox literal and its X refusal text, with and without consent", async () => {
    expect((Texts as Record<string, unknown>).VAULT_INBOX_TOOL_ONLY_TEXT).toBe(N13_408)
    const { PermissionV1 } = await import("@opencode-ai/core/v1/permission")
    expect(PermissionV1.DeferredCategory.literals as readonly string[]).toContain("vault_inbox")
    expect(PermissionV1.EditClass.literals as readonly string[]).toContain("vault_inbox")
    for (const error of [Permission.refusedByMode("vault_inbox"), Permission.refusedUnderConsent("vault_inbox")]) {
      expect((error as Error).message).toContain(N13_408)
      expect((error as Error).message.startsWith("This call did not run.")).toBe(true)
    }
  })

  test("Reach.editTrust: an inbox file, a new file, the inbox folder itself, real-path spelling, with and without Undo", async () => {
    for (const canUndo of [true, false]) expect(failure(await trust([note], canUndo))).toContain(N13_408)
    for (const file of [path.join(inbox, "new.md"), path.join(inbox, "sub/y.md"), inbox, path.join(realpathSync(vault), "inbox/x.md")])
      expect([file, failure(await trust([file]))]).toEqual([file, expect.stringContaining(N13_408)])
  })

  test("Reach.editTrust: a project symlink into the inbox is judged where it lands", async () => {
    const link = path.join(dir, "ilink")
    if (!existsSync(link)) symlinkSync(inbox, link)
    expect(failure(await trust([path.join(link, "x.md")]))).toContain(N13_408)
    rmSync(link)
  })

  test("Reach.editTrust: <vault>/other/, a sibling inbox-old/ and a project file are not refused as inbox", async () => {
    for (const file of ["other/own.md", "inbox-old/x.md"]) expect(failure(await trust([path.join(vault, file)]))).not.toContain(N13_408)
    expect(Exit.isSuccess(await trust([path.join(dir, "a.md")]))).toBe(true)
  })

  for (const mode of MODES)
    for (const agent of ROLES)
      test(`table, mode ${mode}, ${agent ?? "no agent"}: an edit of <vault>/inbox/x.md is X vault_inbox`, () => {
        const verdict = verdictOf(editInput(note, mode, agent))
        expect([verdict.class, verdict.category]).toEqual(["X", "vault_inbox"])
      })

  test("table: editClass vault_inbox from the edit tools, and an outside-folder ask an edit follows, are X vault_inbox", () => {
    for (const mode of MODES) {
      const byClass = verdictOf(editInput(note, mode, undefined, "vault_inbox"))
      expect([byClass.class, byClass.category]).toEqual(["X", "vault_inbox"])
      const input = { ...editInput(note, mode), permission: "external_directory", follows: [{ permission: "edit" }] }
      const outside = verdictOf(input as TableModule.AutonomyTable.Input)
      expect([outside.class, outside.category]).toEqual(["X", "vault_inbox"])
    }
  })

  const writes = () => [
    `printf 'synthetic\\n' > ${inbox}/x.md`,
    `echo synthetic >> ${inbox}/y.md`,
    `echo synthetic | tee ${inbox}/x.md`,
    `cp a.md ${inbox}/`,
    `cp a.md ${inbox}/z.md`,
    `mv a.md ${inbox}/z.md`,
    `rm ${inbox}/x.md`,
    `sed -i '' 's/a/b/' ${inbox}/x.md`,
    `cat > ${inbox}/h.md <<'EOF'\nsynthetic\nEOF`,
    `cd ${inbox} && cp ${dir}/a.md b.md`,
    `cd ${vault} && echo synthetic > inbox/c.md`,
    `python3 -c "open('${inbox}/p.md','w').write('x')"`,
    `node -e "require('fs').writeFileSync('${inbox}/n.md','x')"`,
  ]
  for (const mode of MODES)
    for (const index of writes().keys())
      test(`table, mode ${mode}: shell write #${index} into the inbox is X vault_inbox`, async () => {
        const command = writes()[index]!
        const verdict = verdictOf(await shellInput(command, mode, [note, path.join(inbox, "z.md")]))
        expect([command, verdict.class, verdict.category]).toEqual([command, "X", "vault_inbox"])
      })

  for (const mode of MODES)
    test(`table, mode ${mode}: the default root ~/.swarm/vault/inbox (no SWARM_VAULT_DIR) is X vault_inbox`, async () => {
      seedVault(path.join(home, ".swarm/vault"))
      delete process.env.SWARM_VAULT_DIR
      try {
        const shell = verdictOf(await shellInput("printf 'x' > ~/.swarm/vault/inbox/d.md", mode))
        expect([shell.class, shell.category]).toEqual(["X", "vault_inbox"])
        const edit = verdictOf(editInput(path.join(home, ".swarm/vault/inbox/d.md"), mode))
        expect([edit.class, edit.category]).toEqual(["X", "vault_inbox"])
      } finally {
        process.env.SWARM_VAULT_DIR = vault
      }
    })

  const reads = () => [`cat ${inbox}/x.md`, `ls ${inbox}`, `grep -r synthetic ${inbox}`, `cp ${inbox}/x.md copy.md`]
  for (const index of reads().keys())
    test(`table, mode consent: read #${index} of the inbox runs (not refused)`, async () => {
      const command = reads()[index]!
      const verdict = verdictOf(await shellInput(command, "consent"))
      expect([command, verdict.class === "X", verdict.category === "vault_inbox"]).toEqual([command, false, false])
    })

  test("table: a write into <vault>/other/ or <vault>/inbox-old/ is not vault_inbox (judged as before)", async () => {
    for (const mode of MODES)
      for (const file of [path.join(vault, "other/n.md"), path.join(vault, "inbox-old/n.md")]) {
        expect(verdictOf(await shellInput(`echo synthetic > ${file}`, mode, [file])).category).not.toBe("vault_inbox")
        expect(verdictOf(editInput(file, mode)).category).not.toBe("vault_inbox")
      }
  })

  describe("edit tools, mode off with an \"always\" for edits and outside folders", () => {
    afterEach(async () => {
      await disposeAllInstances()
    })
    const itTools = testEffect(
      LayerNode.compile(
        LayerNode.group([LSP.node, FSUtil.node, EventV2Bridge.node, Format.node, CrossSpawnSpawner.node, Truncate.node, Agent.node]),
      ),
    )
    const context = (asked: string[]) => ({
      sessionID: SessionID.make("ses_test-s147"),
      messageID: MessageID.make("msg_test"),
      callID: "",
      agent: "build",
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => Effect.void,
      trust: { canUndo: true },
      ask: (input: { permission: string }) => Effect.sync(() => void asked.push(input.permission)),
    })

    itTools.instance("Write, Edit and apply_patch into the inbox: refused with N13-408, nothing asked, nothing written", () =>
      Effect.gen(function* () {
        const asked: string[] = []
        const ctx = context(asked) as never
        const write = yield* (yield* WriteTool).init()
        const edit = yield* (yield* EditTool).init()
        const patch = yield* (yield* ApplyPatchTool).init()
        const results = [
          yield* write.execute({ filePath: note, content: "RAHASIA\n" }, ctx).pipe(Effect.exit),
          yield* write.execute({ filePath: path.join(inbox, "extra.md"), content: "new\n" }, ctx).pipe(Effect.exit),
          yield* edit.execute({ filePath: note, oldString: "synthetic", newString: "new" }, ctx).pipe(Effect.exit),
          yield* patch
            .execute({ patchText: `*** Begin Patch\n*** Add File: ${path.join(inbox, "added.md")}\n+new\n*** End Patch` }, ctx)
            .pipe(Effect.exit),
        ]
        for (const exit of results) expect(failure(exit)).toContain(N13_408)
        expect(asked).toEqual([])
        expect(readFileSync(note, "utf8")).toBe("synthetic inbox note\n")
        expect(existsSync(path.join(inbox, "extra.md"))).toBe(false)
        expect(existsSync(path.join(inbox, "added.md"))).toBe(false)
      }),
    )

    itTools.instance("a Write into <vault>/other/ still gets its outside-folder prompt (unchanged)", () =>
      Effect.gen(function* () {
        const asked: string[] = []
        const write = yield* (yield* WriteTool).init()
        const exit = yield* write
          .execute({ filePath: path.join(vault, "other/n.md"), content: "new\n" }, context(asked) as never)
          .pipe(Effect.exit)
        expect(failure(exit)).not.toContain(N13_408)
        expect(asked[0]).toBe("external_directory")
      }),
    )
  })
})
