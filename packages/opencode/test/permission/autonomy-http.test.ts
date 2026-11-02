// A person's answer on a held call, through the real route: the handler is what decides whether the agent hears about it.

import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { afterEach, beforeEach, expect } from "bun:test"
import { readFileSync, rmSync } from "node:fs"
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
beforeEach(() => {
  clean()
  sent.length = 0
  order.length = 0
  writesOutside = false
})
afterEach(clean)

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
const tools = Layer.succeed(
  ToolRegistry.Service,
  ToolRegistry.Service.of({ all: () => Effect.succeed([shell]) } as unknown as ToolRegistry.Interface),
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
