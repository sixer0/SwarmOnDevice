// A person's answer on a held call, through the real route: the handler is what decides whether the agent hears about it.

import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { afterAll, afterEach, beforeEach, expect } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Socket from "effect/unstable/socket/Socket"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { Autonomy } from "../../src/permission/autonomy"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Question } from "../../src/question"
import { PermissionApi } from "../../src/server/routes/instance/httpapi/groups/permission"
import { permissionHandlers } from "../../src/server/routes/instance/httpapi/handlers/permission"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { instanceContextLayer } from "../../src/server/routes/instance/httpapi/middleware/instance-context"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { workspaceRoutingLayer } from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { Agent } from "../../src/agent/agent"
import { GlobalLifecycle } from "../../src/server/global-lifecycle"
import { ServerAuth } from "../../src/server/auth"
import { Tool } from "../../src/tool/tool"
import { ToolRegistry } from "../../src/tool/registry"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "../../src/session/session"
import { SessionID } from "../../src/session/schema"
import { TestInstance } from "../fixture/fixture"
import { workspaceLayerWithRuntimeFlags } from "../fixture/workspace"
import { testEffect } from "../lib/effect"

const folder = path.join(Global.Path.state, "autonomy")
const clean = () => rmSync(folder, { recursive: true, force: true })
const sent: { sessionID: string; text: string; lateAnswer: boolean }[] = []
// What happened, in order: a call the server ran again, and the message that woke the agent.
const order: string[] = []
// What the stand-in for the shell asks after its own prompt, for the case where the call goes on to a refused write.
let writesOutside = false
// What the stand-in for read asks second: its own `read` prompt, or a write beyond the folder that class X refuses.
let readThenWrites = false
beforeEach(() => {
  clean()
  sent.length = 0
  order.length = 0
  writesOutside = false
  readThenWrites = false
})
afterEach(clean)
afterAll(() => rmSync(away, { recursive: true, force: true }))

const it = testEffect(
  Layer.mergeAll(
    AppNodeBuilder.build(
      LayerNode.group([
        Permission.node,
        Session.node,
        Autonomy.node,
        EventV2Bridge.node,
        SessionProjector.node,
        CrossSpawnSpawner.node,
        InstanceStore.node,
        Question.node,
      ]),
      [
        [
          InstanceStore.bootstrapNode,
          Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
        ],
      ],
    ),
    NodeHttpServer.layerTest,
    NodeServices.layer,
    workspaceLayerWithRuntimeFlags({}),
  ),
)

const prompt = Layer.succeed(
  SessionPrompt.Service,
  SessionPrompt.Service.of({
    prompt: (input: SessionPrompt.PromptInput) =>
      Effect.sync(() => {
        const part = input.parts[0] as { text: string; metadata?: { lateAnswer?: boolean } }
        sent.push({ sessionID: input.sessionID, text: part.text, lateAnswer: part.metadata?.lateAnswer === true })
        order.push("sent")
        return {} as never
      }),
  } as unknown as SessionPrompt.Interface),
)

/**
 * A shell that asks as the real one does, through the context it is handed and with its call named, so the real gate
 * and the grant decide. Running a real `git push` is not what this file is about.
 */
const shell: Tool.Def = {
  id: "bash",
  description: "",
  parameters: Schema.Unknown,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const input = args as { command: string; workdir: string }
      yield* ctx.ask({
        permission: "bash",
        patterns: [input.command],
        metadata: { command: input.command, workdir: input.workdir },
        always: ["*"],
        call: { tool: "bash", args },
      })
      if (writesOutside)
        yield* ctx.ask({
          permission: "external_directory",
          patterns: ["/tmp/*"],
          metadata: { filepath: "/tmp/a.ts", parentDir: "/tmp" },
          always: [],
          follows: [{ permission: "edit", patterns: ["/tmp/a.ts"] }],
          call: { tool: "bash", args },
        })
      order.push("ran")
      return { title: input.command, metadata: { exit: 0 }, output: `pushed by ${input.command}` }
    }),
}
// A secret beyond the folder, as in alugra T3. Synthetic: nothing under a real home is read.
const away = realpathSync(mkdtempSync(path.join(os.tmpdir(), "autonomy-http-away-")))
mkdirSync(path.join(away, ".aws"), { recursive: true })
writeFileSync(path.join(away, ".aws/config"), "region = synthetic-1\n")
const secret = path.join(away, ".aws/config")

/** The first of the two prompts the real read tool asks for a file beyond the folder (`read.ts`, `external-directory.ts`). */
const outsidePrompt = (args: unknown) => ({
  permission: "external_directory",
  patterns: [path.join(away, ".aws/*")],
  metadata: { filepath: secret, parentDir: path.join(away, ".aws"), readOnly: true },
  always: [],
  call: { tool: "read", args },
})
/** Its second prompt, which the entry the person approved never showed. The real tool names it relative to the worktree. */
const readPrompt = (args: unknown) => ({
  permission: "read",
  patterns: [secret],
  metadata: {},
  always: [],
  call: { tool: "read", args },
})

/** A read that asks twice for one call, in the real tool's order, through the context it is handed (C97 F3). */
const reader: Tool.Def = {
  id: "read",
  description: "",
  parameters: Schema.Unknown,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      yield* ctx.ask(outsidePrompt(args))
      if (readThenWrites)
        yield* ctx.ask({
          permission: "external_directory",
          patterns: ["/tmp/*"],
          metadata: { filepath: "/tmp/a.ts", parentDir: "/tmp" },
          always: [],
          follows: [{ permission: "edit", patterns: ["/tmp/a.ts"] }],
          call: { tool: "read", args },
        })
      if (!readThenWrites) yield* ctx.ask(readPrompt(args))
      order.push("read")
      return { title: secret, metadata: {}, output: `read ${JSON.stringify(args)}` }
    }),
}
const tools = Layer.succeed(
  ToolRegistry.Service,
  ToolRegistry.Service.of({ all: () => Effect.succeed([shell, reader]) } as unknown as ToolRegistry.Interface),
)
const agents = Layer.succeed(
  Agent.Service,
  Agent.Service.of({
    get: (name: string) => Effect.succeed({ name, mode: "primary", permission: [], options: {} }),
    defaultAgent: () => Effect.succeed("build"),
  } as unknown as Agent.Interface),
)

// The route the app serves, with one group mounted: the rest of the API has nothing to say about this.
const route = (extra: Layer.Layer<never>[]) =>
  HttpApiBuilder.layer(PermissionApi).pipe(
    Layer.provide(permissionHandlers as never),
    Layer.provide([
      authorizationLayer.pipe(Layer.provide(ServerAuth.Config.layer)),
      workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
      instanceContextLayer,
      schemaErrorLayer,
      prompt,
      ...extra,
    ]),
    HttpRouter.serve,
    Layer.build,
  ) as unknown as Effect.Effect<unknown>
const serve = route([])
/** As the app serves it, where the server can run a held call again (U11 E1). */
const serveWithTools = route([tools as never, agents as never])

/** One call held in a mode-on root, by its child. `bound` names the call as a tool does, so an answer is held to it. */
const hold = (bound = false) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const autonomy = yield* Autonomy.Service
    const permission = yield* Permission.Service
    const test = yield* TestInstance
    const root = yield* sessions.create({})
    const child = yield* sessions.create({ parentID: root.id })
    yield* autonomy.setMode({ scope: "session", root: root.id, on: true })
    const command = "git push origin main"
    const exit = yield* permission
      .ask({
        sessionID: child.id,
        permission: "bash",
        patterns: [command],
        metadata: { command, workdir: test.directory },
        always: ["*"],
        ruleset: [],
        canUndo: true,
        ...(bound && { call: { tool: "bash", args: { command, workdir: test.directory } } }),
      })
      .pipe(Effect.exit)
    if (!Exit.isFailure(exit)) throw new Error("expected the call to be held")
    expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.DeferredError)
    const [held] = yield* permission.list()
    return { root, held: held!, directory: test.directory }
  })

const answer = (requestID: string, directory: string, body: { reply: PermissionV1.Reply; message?: string }) =>
  Effect.gen(function* () {
    const request = yield* HttpClientRequest.post(`/permission/${requestID}/reply`).pipe(
      HttpClientRequest.setHeader("x-opencode-directory", directory),
      HttpClientRequest.bodyJson(body),
    )
    const response = yield* HttpClient.execute(request)
    expect(response.status).toBe(200)
  })

const delivered = (count: number) =>
  Effect.gen(function* () {
    while (sent.length < count) yield* Effect.sleep("10 millis")
  }).pipe(Effect.timeout("2 seconds"))

it.instance("AU-23 over HTTP: a no with a message reaches the root as a late answer", () =>
  Effect.gen(function* () {
    yield* serve
    const { root, held, directory } = yield* hold()
    yield* answer(held.id, directory, { reply: "reject", message: "push to the fork instead" })
    yield* delivered(1)
    expect(sent[0]).toMatchObject({ sessionID: root.id, lateAnswer: true })
    expect(sent[0]!.text).toContain("push to the fork instead")
    expect(yield* (yield* Permission.Service).list()).toEqual([])
  }),
)

it.instance("AU-23 over HTTP: a plain no wakes nothing", () =>
  Effect.gen(function* () {
    yield* serve
    const { held, directory } = yield* hold()
    yield* answer(held.id, directory, { reply: "reject" })
    yield* Effect.sleep("100 millis")
    expect(sent).toEqual([])
    expect(yield* (yield* Permission.Service).list()).toEqual([])
  }),
)

it.instance("AU-23 over HTTP: allow still wakes the root", () =>
  Effect.gen(function* () {
    yield* serve
    const { root, held, directory } = yield* hold()
    yield* answer(held.id, directory, { reply: "once" })
    yield* delivered(1)
    expect(sent[0]).toMatchObject({ sessionID: root.id, lateAnswer: true })
    expect(sent[0]!.text).toContain("git push origin main")
  }),
)

const auditLines = (root: string) =>
  readFileSync(path.join(folder, `${root}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)

it.instance(
  "E1 over HTTP: approving a held call runs it once, before any model turn, and its output reaches the root",
  () =>
    Effect.gen(function* () {
      yield* serveWithTools
      const { root, held, directory } = yield* hold(true)
      yield* answer(held.id, directory, { reply: "once" })
      yield* delivered(1)
      // The call ran on the server first; the message only tells the agent what came of it.
      expect(order).toEqual(["ran", "sent"])
      expect(sent[0]).toMatchObject({ sessionID: root.id, lateAnswer: true })
      expect(sent[0]!.text).toContain("pushed by git push origin main")
      expect(sent[0]!.text).toContain("do not run it again")
      expect(yield* (yield* Permission.Service).list()).toEqual([])
      const lines = auditLines(root.id)
      // It went through the gate again, let through by the person's grant, and its result is on record.
      expect(lines.filter((line) => line.type === "decision" && line.via === "grant")).toMatchObject([
        { permission: "bash", decidedBy: "person", decision: "allow" },
      ])
      expect(lines.filter((line) => line.type === "outcome")).toMatchObject([
        { requestID: held.id, outcome: "approved_later", by: "person" },
        { requestID: held.id, outcome: "ran", exit: 0, by: "person" },
      ])
      // Once: the grant is used up, so the agent doing it again is asked again.
      const exit = yield* (yield* Permission.Service)
        .ask({
          sessionID: root.id,
          permission: "bash",
          patterns: ["git push origin main"],
          metadata: { command: "git push origin main", workdir: directory },
          always: ["*"],
          ruleset: [],
          canUndo: true,
          call: { tool: "bash", args: { command: "git push origin main", workdir: directory } },
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.DeferredError)
    }),
)

it.instance("E1 over HTTP: what the call goes on to do is still judged, and class X stays refused", () =>
  Effect.gen(function* () {
    yield* serveWithTools
    const { root, held, directory } = yield* hold(true)
    writesOutside = true
    yield* answer(held.id, directory, { reply: "once" })
    yield* delivered(1)
    expect(order).toEqual(["sent"])
    expect(sent[0]!.text).toContain("did not go through")
    expect(sent[0]!.text).toContain("Autonomous mode only reads outside the project folder")
    const lines = auditLines(root.id)
    expect(lines.filter((line) => line.type === "decision" && line.class === "X")).toMatchObject([
      { permission: "external_directory", category: "outside_write", decision: "reject" },
    ])
    expect(lines.filter((line) => line.type === "outcome").at(-1)).toMatchObject({
      requestID: held.id,
      outcome: "failed",
      by: "person",
    })
  }),
)

it.instance("E1 over HTTP: an entry back from a restart has no call, so approving it only wakes the agent", () =>
  Effect.gen(function* () {
    yield* serveWithTools
    const { root, held, directory } = yield* hold(true)
    yield* GlobalLifecycle.disposeAllInstancesAndEmitGlobalDisposed()
    const [restored] = yield* (yield* Permission.Service).list()
    expect(restored).toMatchObject({ id: held.id, deferred: true })
    yield* answer(held.id, directory, { reply: "once" })
    yield* delivered(1)
    expect(order).toEqual(["sent"])
    expect(sent[0]!.text).toContain("Do it now if it's still needed")
    expect(auditLines(root.id).filter((line) => line.outcome === "ran" || line.outcome === "failed")).toEqual([])
  }),
)

it.instance("E1 over HTTP: without a tool to run it, an approval wakes the agent as before", () =>
  Effect.gen(function* () {
    yield* serve
    const { held, directory } = yield* hold(true)
    yield* answer(held.id, directory, { reply: "once" })
    yield* delivered(1)
    expect(order).toEqual(["sent"])
    expect(sent[0]!.text).toContain("Do it now if it's still needed")
  }),
)

/** One prompt as the agent's own tool would ask it, with nothing allowed by rule: what the gate made of it. */
const tryAsk = (sessionID: SessionID, prompt: Omit<PermissionV1.AskInput, "sessionID" | "ruleset">) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const exit = yield* permission.ask({ sessionID, ruleset: [], canUndo: true, ...prompt }).pipe(Effect.exit)
    if (Exit.isSuccess(exit)) return "passed"
    return Cause.squash(exit.cause) instanceof PermissionV1.DeferredError ? "held" : "refused"
  })

/** Reads by a mode-on root and its child, held as one entry (E3), as alugra T3 had them. */
const holdReads = (reads: { child?: boolean; args: Record<string, unknown> }[]) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const autonomy = yield* Autonomy.Service
    const permission = yield* Permission.Service
    const test = yield* TestInstance
    const root = yield* sessions.create({})
    const child = yield* sessions.create({ parentID: root.id })
    yield* autonomy.setMode({ scope: "session", root: root.id, on: true })
    for (const read of reads)
      expect(yield* tryAsk(read.child ? child.id : root.id, outsidePrompt(read.args))).toBe("held")
    const entries = yield* permission.list()
    expect(entries).toHaveLength(1)
    return { root, child, entry: entries[0]!, directory: test.directory }
  })

const answerVersion = (requestID: string, directory: string, version: number) =>
  Effect.gen(function* () {
    const request = yield* HttpClientRequest.post(`/permission/${requestID}/reply`).pipe(
      HttpClientRequest.setHeader("x-opencode-directory", directory),
      HttpClientRequest.bodyJson({ reply: "once", version }),
    )
    expect((yield* HttpClient.execute(request)).status).toBe(200)
  })

const READS = [
  { args: { filePath: secret } },
  { args: { filePath: secret, offset: 2 } },
  { child: true, args: { filePath: secret, limit: 1 } },
]

it.instance("C97 F3 over HTTP: one approval of a merged read runs each of its calls once, both prompts included", () =>
  Effect.gen(function* () {
    yield* serveWithTools
    const permission = yield* Permission.Service
    const { root, child, entry, directory } = yield* holdReads(READS)
    expect(entry.metadata.version).toBe(3)
    yield* answerVersion(entry.id, directory, 3)
    yield* delivered(1)
    // All three ran on the one approval, before the agent heard; nothing came up again for a second or third approval.
    expect(order).toEqual(["read", "read", "read", "sent"])
    expect(sent[0]!.text.split("Swarm ran it once for you").length - 1).toBe(3)
    expect(yield* permission.list()).toEqual([])
    const lines = auditLines(root.id)
    // Each prompt of each call went through the gate on the person's grant: the one the entry showed, and the second.
    const granted = lines.filter((line) => line.type === "decision" && line.via === "grant")
    expect(granted.map((line) => [line.permission, line.decidedBy, line.decision])).toEqual(
      READS.flatMap(() => [
        ["external_directory", "person", "allow"],
        ["read", "person", "allow"],
      ]),
    )
    expect(lines.filter((line) => line.type === "outcome" && line.outcome === "ran")).toHaveLength(3)
    // Once per call: neither prompt of an approved call passes again on that approval, from the root or the child.
    for (const read of READS) {
      expect(yield* tryAsk(read.child ? child.id : root.id, readPrompt(read.args))).toBe("held")
      expect(yield* tryAsk(read.child ? child.id : root.id, outsidePrompt(read.args))).toBe("held")
    }
  }),
)

it.instance("C97 F3 over HTTP: a call that was not on the approved list gets nothing from the approval", () =>
  Effect.gen(function* () {
    yield* serveWithTools
    const permission = yield* Permission.Service
    const { root, entry, directory } = yield* holdReads(READS.slice(0, 2))
    // A third read joins after the person looked at version 2: an approval of version 2 does not run anything.
    expect(yield* tryAsk(root.id, outsidePrompt(READS[2]!.args))).toBe("held")
    yield* answerVersion(entry.id, directory, 2)
    expect(order).toEqual([])
    const [shown] = yield* permission.list()
    expect(shown!.metadata.version).toBe(3)
    // Approved at the version shown now, it runs the three on it.
    yield* answerVersion(shown!.id, directory, 3)
    yield* delivered(1)
    expect(order).toEqual(["read", "read", "read", "sent"])
    // One more read, after the click, with other arguments: neither of its prompts is covered, so it is held.
    const extra = { filePath: secret, offset: 3, limit: 2 }
    expect(yield* tryAsk(root.id, readPrompt(extra))).toBe("held")
    expect(yield* tryAsk(root.id, outsidePrompt(extra))).toBe("held")
    expect(auditLines(root.id).filter((line) => line.type === "outcome" && line.outcome === "ran")).toHaveLength(3)
  }),
)

it.instance("C97 F3 over HTTP: a second prompt of class X inside the rerun stays refused", () =>
  Effect.gen(function* () {
    yield* serveWithTools
    const permission = yield* Permission.Service
    const { root, entry, directory } = yield* holdReads(READS.slice(0, 2))
    readThenWrites = true
    yield* answerVersion(entry.id, directory, 2)
    yield* delivered(1)
    expect(order).toEqual(["sent"])
    expect(sent[0]!.text).toContain("did not go through")
    expect(sent[0]!.text).toContain("Autonomous mode only reads outside the project folder")
    const lines = auditLines(root.id)
    // The grant given for the call's own second prompt did not turn class X into a pass: each call was refused.
    expect(lines.filter((line) => line.type === "decision" && line.class === "X")).toMatchObject([
      { permission: "external_directory", category: "outside_write", decision: "reject" },
      { permission: "external_directory", category: "outside_write", decision: "reject" },
    ])
    expect(lines.filter((line) => line.type === "outcome" && line.outcome === "failed")).toHaveLength(2)
    expect(lines.filter((line) => line.type === "outcome" && line.outcome === "ran")).toEqual([])
    expect(yield* permission.list()).toEqual([])
  }),
)
