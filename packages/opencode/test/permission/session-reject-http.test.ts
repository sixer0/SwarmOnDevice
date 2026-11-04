// A rejection through the older session route (row 122c, from C87): `/permission` hands a held entry's rejection to
// `late.rejected`, the session route does not. These pin what that difference does: nothing waits on either route,
// because a live call is failed by `Permission.reply` itself and a held entry's agent has already carried on. The only
// thing `late.rejected` delivers is a reason, and the session route has no field to carry one.

import { NodeServices } from "@effect/platform-node"
import { afterEach, beforeEach, expect } from "bun:test"
import { rmSync } from "node:fs"
import path from "node:path"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { loopbackServer } from "./loopback-server"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Socket from "effect/unstable/socket/Socket"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { Autonomy } from "../../src/permission/autonomy"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Question } from "../../src/question"
import { PermissionApi } from "../../src/server/routes/instance/httpapi/groups/permission"
import { SessionApi } from "../../src/server/routes/instance/httpapi/groups/session"
import { permissionHandlers } from "../../src/server/routes/instance/httpapi/handlers/permission"
import { sessionHandlers } from "../../src/server/routes/instance/httpapi/handlers/session"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { instanceContextLayer } from "../../src/server/routes/instance/httpapi/middleware/instance-context"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { workspaceRoutingLayer } from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { ServerAuth } from "../../src/server/auth"
import { SessionShare } from "../../src/share/session"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { Session } from "../../src/session/session"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { Todo } from "../../src/session/todo"
import { TestInstance } from "../fixture/fixture"
import { workspaceLayerWithRuntimeFlags } from "../fixture/workspace"
import { testEffect } from "../lib/effect"

const folder = path.join(Global.Path.state, "autonomy")
const clean = () => rmSync(folder, { recursive: true, force: true })
const sent: { sessionID: string; text: string }[] = []
beforeEach(() => {
  clean()
  sent.length = 0
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
    loopbackServer,
    NodeServices.layer,
    workspaceLayerWithRuntimeFlags({}),
  ),
)

const prompt = Layer.succeed(
  SessionPrompt.Service,
  SessionPrompt.Service.of({
    prompt: (input: SessionPrompt.PromptInput) =>
      Effect.sync(() => {
        const part = input.parts[0]
        sent.push({ sessionID: input.sessionID, text: part?.type === "text" ? part.text : "" })
        return {} as never
      }),
  } as unknown as SessionPrompt.Interface),
)
// The session group asks for these when it is built; the answer route uses none of them.
const unused = [
  SessionShare.Service,
  SessionRevert.Service,
  SessionCompaction.Service,
  SessionRunState.Service,
  SessionStatus.Service,
  Todo.Service,
  SessionSummary.Service,
  Agent.Service,
].map((tag) => Layer.succeed(tag as never, {} as never))

const middleware = [
  authorizationLayer.pipe(Layer.provide(ServerAuth.Config.layer)),
  workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
  instanceContextLayer,
  schemaErrorLayer,
  prompt,
]
const servePermission = HttpApiBuilder.layer(PermissionApi).pipe(
  Layer.provide(permissionHandlers as never),
  Layer.provide(middleware as never),
  HttpRouter.serve,
  Layer.build,
) as unknown as Effect.Effect<unknown>
const serveSession = HttpApiBuilder.layer(SessionApi).pipe(
  Layer.provide(sessionHandlers as never),
  Layer.provide([...middleware, ...unused] as never),
  HttpRouter.serve,
  Layer.build,
) as unknown as Effect.Effect<unknown>

const command = "git push origin main"

/** A call the agent is still waiting on: no mode, no rule, so it asks and blocks. */
const askLive = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const permission = yield* Permission.Service
  const test = yield* TestInstance
  const root = yield* sessions.create({})
  const fiber = yield* permission
    .ask({
      sessionID: root.id,
      permission: "bash",
      patterns: [command],
      metadata: { command, workdir: test.directory },
      always: ["*"],
      ruleset: [],
      canUndo: true,
    })
    .pipe(Effect.exit, Effect.forkChild)
  let entries = yield* permission.list()
  while (entries.length === 0) {
    yield* Effect.sleep("10 millis")
    entries = yield* permission.list()
  }
  expect(entries[0]!.movedOnAt).toBeUndefined()
  return { root, entry: entries[0]!, directory: test.directory, fiber }
})

/** A call the agent carried on without: held by autonomous mode, so its entry has moved on. */
const holdOne = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const autonomy = yield* Autonomy.Service
  const permission = yield* Permission.Service
  const test = yield* TestInstance
  const root = yield* sessions.create({})
  yield* autonomy.setMode({ scope: "session", root: root.id, on: true })
  const exit = yield* permission
    .ask({
      sessionID: root.id,
      permission: "bash",
      patterns: [command],
      metadata: { command, workdir: test.directory },
      always: ["*"],
      ruleset: [],
      canUndo: true,
      call: { tool: "bash", args: { command, workdir: test.directory, description: "push" } },
    })
    .pipe(Effect.exit)
  expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.DeferredError)
  const entries = yield* permission.list()
  expect(entries).toHaveLength(1)
  expect(entries[0]!.movedOnAt).toBeNumber()
  return { root, entry: entries[0]!, directory: test.directory }
})

const post = (url: string, directory: string, body: unknown) =>
  Effect.gen(function* () {
    const request = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeader("x-opencode-directory", directory),
      HttpClientRequest.bodyJson(body),
    )
    return (yield* HttpClient.execute(request)).status
  })

type Route = "permission" | "session"
const rejectVia = (route: Route, sessionID: string, id: string, directory: string, message?: string) =>
  route === "permission"
    ? post(`/permission/${id}/reply`, directory, { reply: "reject", ...(message && { message }) })
    : post(`/session/${sessionID}/permissions/${id}`, directory, { response: "reject", ...(message && { message }) })
const serve = (route: Route) => (route === "permission" ? servePermission : serveSession)

const pending = Effect.gen(function* () {
  return (yield* (yield* Permission.Service).list()).map((item) => item.id)
})
/** Long enough for a forked late answer to have been sent, were one coming. */
const settle = Effect.sleep("200 millis")

for (const route of ["permission", "session"] as const) {
  it.instance(`122c ${route} route: rejecting a call the agent waits on ends its wait`, () =>
    Effect.gen(function* () {
      yield* serve(route)
      const { root, entry, directory, fiber } = yield* askLive
      expect(yield* rejectVia(route, root.id, entry.id, directory)).toBe(200)
      const exit = yield* Fiber.join(fiber).pipe(Effect.timeout("2 seconds"))
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.RejectedError)
      expect(yield* pending).toEqual([])
      yield* settle
      expect(sent).toEqual([])
    }),
  )

  it.instance(`122c ${route} route: a plain no on a held entry clears it and wakes nothing`, () =>
    Effect.gen(function* () {
      yield* serve(route)
      const { root, entry, directory } = yield* holdOne
      expect(yield* rejectVia(route, root.id, entry.id, directory)).toBe(200)
      expect(yield* pending).toEqual([])
      yield* settle
      expect(sent).toEqual([])
    }),
  )
}

it.instance("122c permission route: a no with a reason on a held entry reaches the agent", () =>
  Effect.gen(function* () {
    yield* servePermission
    const { root, entry, directory } = yield* holdOne
    expect(yield* rejectVia("permission", root.id, entry.id, directory, "use the staging remote")).toBe(200)
    expect(yield* pending).toEqual([])
    const deadline = Date.now() + 2000
    while (sent.length === 0 && Date.now() < deadline) yield* Effect.sleep("10 millis")
    expect(sent).toHaveLength(1)
    expect(sent[0]!.sessionID).toBe(root.id)
    expect(sent[0]!.text).toContain("I've declined")
    expect(sent[0]!.text).toContain("use the staging remote")
  }),
)

it.instance("122c session route: it has no field for a reason, so one sent anyway is dropped", () =>
  Effect.gen(function* () {
    yield* serveSession
    const { root, entry, directory } = yield* holdOne
    expect(yield* rejectVia("session", root.id, entry.id, directory, "use the staging remote")).toBe(200)
    expect(yield* pending).toEqual([])
    yield* settle
    expect(sent).toEqual([])
  }),
)
