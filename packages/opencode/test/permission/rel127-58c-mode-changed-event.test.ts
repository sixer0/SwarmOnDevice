// 1.2.7 row 58c (U-10, live finding F-5): `swarm autonomy off` from the CLI changed the mode on the server, but an open
// window kept its "Autonomous" marker until the session was reopened, because the server sent nothing. Every change
// through PUT /autonomy/mode now sends `autonomy.mode.changed` to the folder the changed scope belongs to: the session's
// own folder for a session, whichever folder the request came from.

import { NodeServices } from "@effect/platform-node"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Socket from "effect/unstable/socket/Socket"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { AutonomyEvent } from "@opencode-ai/schema/autonomy-event"
import { Workspace } from "../../src/control-plane/workspace"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { EventManifest } from "../../src/event-manifest"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { Autonomy } from "../../src/permission/autonomy"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { ServerAuth } from "../../src/server/auth"
import { AutonomyApi } from "../../src/server/routes/instance/httpapi/groups/autonomy"
import { autonomyHandlers } from "../../src/server/routes/instance/httpapi/handlers/autonomy"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { instanceContextLayer } from "../../src/server/routes/instance/httpapi/middleware/instance-context"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { workspaceRoutingLayer } from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { Session } from "../../src/session/session"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { loopbackServer } from "./loopback-server"

const MODE_CHANGED = "autonomy.mode.changed"

const folder = path.join(Global.Path.state, "autonomy")
const trustFile = path.join(Global.Path.state, "trust.json")
const clean = () => {
  rmSync(folder, { recursive: true, force: true })
  rmSync(trustFile, { force: true })
}
beforeEach(clean)
afterEach(clean)

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const decider = Layer.succeed(
  Permission.Decider,
  Permission.Decider.of({ decide: () => Effect.succeed({ decision: "allow" as const, decidedBy: "agent:test/stub" }) }),
)

const gated = testEffect(
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
        Workspace.node,
        EventV2.node,
      ]),
      [
        [InstanceStore.bootstrapNode, noopBootstrap],
        [Permission.deciderNode, decider],
        [RuntimeFlags.node, RuntimeFlags.layer({})],
      ],
    ),
    loopbackServer,
    NodeServices.layer,
  ),
)

const serveGroup = HttpApiBuilder.layer(AutonomyApi).pipe(
  Layer.provide(autonomyHandlers as never),
  Layer.provide([
    authorizationLayer.pipe(Layer.provide(ServerAuth.Config.layer)),
    workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
    instanceContextLayer,
    schemaErrorLayer,
  ]),
  HttpRouter.serve,
  Layer.build,
) as unknown as Effect.Effect<unknown>

const putMode = (directory: string, body: { on: boolean; sessionID?: string }) =>
  Effect.gen(function* () {
    const request = yield* HttpClientRequest.bodyJson(
      HttpClientRequest.put("/autonomy/mode").pipe(HttpClientRequest.setHeader("x-opencode-directory", directory)),
      body,
    )
    const response = yield* HttpClient.execute(request)
    expect(response.status).toBe(200)
    return (yield* response.json) as { on: boolean }
  })

type Seen = { data: unknown; directory: string | undefined }

/** Every mode notice as it leaves the server, with the folder it is routed to. */
const notices = Effect.gen(function* () {
  const events = yield* EventV2Bridge.Service
  const seen: Seen[] = []
  const stop = yield* events.listen((event) =>
    Effect.sync(() => {
      if (event.type !== MODE_CHANGED) return
      seen.push({ data: event.data, directory: event.location?.directory })
    }),
  )
  yield* Effect.addFinalizer(() => stop)
  return seen
})

const settle = Effect.promise(() => Bun.sleep(30))

gated.instance("58c: a folder turned on and off sends one notice each, to that folder", () =>
  Effect.gen(function* () {
    yield* serveGroup
    const test = yield* TestInstance
    const seen = yield* notices

    yield* putMode(test.directory, { on: true })
    yield* settle
    expect(seen).toEqual([{ data: { scope: "directory" }, directory: test.directory }])

    yield* putMode(test.directory, { on: false })
    yield* settle
    expect(seen.length).toBe(2)
    expect(seen[1]).toEqual({ data: { scope: "directory" }, directory: test.directory })
  }),
)

gated.instance("58c: a session switched off from another folder is told in the session's own folder", () =>
  Effect.gen(function* () {
    yield* serveGroup
    const test = yield* TestInstance
    const sessions = yield* Session.Service
    const root = yield* sessions.create({})
    const child = yield* sessions.create({ parentID: root.id })
    const seen = yield* notices

    yield* putMode(test.directory, { on: true, sessionID: root.id })
    yield* settle
    expect(seen).toEqual([{ data: { scope: "session", sessionID: root.id }, directory: test.directory }])

    // As the CLI does: the request names the session but comes from some other folder. A subagent names its root.
    const elsewhere = yield* tmpdirScoped({ git: true })
    expect((yield* putMode(elsewhere, { on: false, sessionID: child.id })).on).toBe(false)
    yield* settle
    expect(seen.length).toBe(2)
    expect(seen[1]).toEqual({ data: { scope: "session", sessionID: root.id }, directory: test.directory })
  }),
)

test("58c: autonomy.mode.changed is in the contract clients are generated from, with no text in it", () => {
  expect(AutonomyEvent.ModeChanged.type).toBe(MODE_CHANGED)
  expect(EventManifest.Latest.get(MODE_CHANGED)?.type).toBe(MODE_CHANGED)
  const types = readFileSync(new URL("../../../sdk/js/src/v2/gen/types.gen.ts", import.meta.url), "utf8")
  const start = types.indexOf("export type EventAutonomyModeChanged")
  expect(start).toBeGreaterThan(-1)
  const generated = types.slice(start)
  const body = generated.slice(0, generated.indexOf("\n}\n"))
  expect(body).toContain(`type: "${MODE_CHANGED}"`)
  expect(body).toContain('scope: "session" | "directory"')
})
