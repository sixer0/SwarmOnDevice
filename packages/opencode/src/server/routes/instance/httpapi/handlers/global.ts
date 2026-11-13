import { SessionSearch } from "@/session/search"
import { Config } from "@/config/config"
import { GlobalBus, type GlobalEvent as GlobalBusEvent } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { InstanceRef } from "@/effect/instance-ref"
import { Installation } from "@/installation"
import { Permission } from "@/permission"
import { InstanceStore } from "@/project/instance-store"
import { Question } from "@/question"
import { SessionStatus } from "@/session/status"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { setupObservation } from "@/server/shared/setup-observation"
import { applyLanesPatch, lanesStateObservation, observeEffective } from "@/server/shared/lanes-observation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect, Queue } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { RootHttpApi } from "../api"
import { GlobalUpgradeInput } from "../groups/global"
import { configPersonOnly } from "./config"

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

function eventResponse() {
  return Effect.gen(function* () {
    yield* Effect.logInfo("global event connected")
    const events = Stream.callback<GlobalBusEvent>((queue) => {
      const handler = (event: GlobalBusEvent) => Queue.offerUnsafe(queue, event)
      return Effect.acquireRelease(
        Effect.sync(() => GlobalBus.on("event", handler)),
        () => Effect.sync(() => GlobalBus.off("event", handler)),
      )
    })
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ({ payload: { id: EventV2.ID.create(), type: "server.heartbeat", properties: {} } })),
    )

    return HttpServerResponse.stream(
      Stream.make({ payload: { id: EventV2.ID.create(), type: "server.connected", properties: {} } }).pipe(
        Stream.concat(events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        Stream.map(eventData),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(Effect.logInfo("global event disconnected")),
      ),
      {
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      },
    )
  })
}

export const globalHandlers = HttpApiBuilder.group(RootHttpApi, "global", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const installation = yield* Installation.Service
    const bridge = yield* EffectBridge.make()
    const instances = yield* InstanceStore.Service
    const permission = yield* Permission.Service
    const question = yield* Question.Service
    const status = yield* SessionStatus.Service
    const sessionSearch = yield* SessionSearch.Service

    const health = Effect.fn("GlobalHttpApi.health")(function* () {
      return { healthy: true as const, version: InstallationVersion }
    })

    const agents = Effect.fn("GlobalHttpApi.agents")(function* () {
      const loaded = yield* instances.loaded()
      return {
        instances: yield* Effect.forEach(
          loaded,
          (ctx) =>
            Effect.gen(function* () {
              return {
                directory: ctx.directory,
                status: Object.fromEntries(yield* status.list()),
                permission: yield* permission.list(),
                question: yield* question.list(),
              }
            }).pipe(Effect.provideService(InstanceRef, ctx)),
          { concurrency: "unbounded" },
        ),
      }
    })

    // Levels 1-2 of the Home status card. Two file reads with privileges the server already holds, and
    // nothing else: no directory or workspace parameter, no instance context, no spawn, and no internal
    // request to `/mcp` — a status read that started MCP children would be an action wearing a read's
    // clothes (masterplan/04_s6_status_spec.md §4 rule 3, research/s6_04_route_impact.md §3). The path
    // argument is Global.Path.config, the same constant the product's own global config load reads
    // (packages/opencode/src/config/config.ts:253), so the registration half describes the file the
    // product actually uses rather than one the writer merely happened to write.
    const setup = Effect.fn("GlobalHttpApi.setup")(function* () {
      return setupObservation(Global.Path.config)
    })

    // Row 247 — lane controls (06_s6b_lanes_spec.md §5.2). The read answers stored-plus-observed:
    // the file leg resolves through the setup writer's own resolver (imported, not mirrored) and
    // publishes only the tilde path; the observation leg reads /proc/1/environ inside already-running
    // label-scoped carriers — it execs, never spawns, and degrades to named reasons when the daemon
    // or a carrier is absent, because an absence must never be rendered as a value or as false.
    const lanesGet = Effect.fn("GlobalHttpApi.lanesGet")(function* () {
      const state = lanesStateObservation()
      const observed = yield* observeEffective()
      return { ...state, observed }
    })

    // Raw handling is what lets malformed JSON answer with the spec's own LANE_VALUE_MALFORMED
    // token instead of a framework decode rejection (session.create at handlers/session.ts:159-176
    // is the in-repo precedent for handleRaw + declared payload). Validation completes before any
    // write call exists (06 §4.2), so every refusal here provably touches no bytes and no mode.
    const lanesUpdate = Effect.fn("GlobalHttpApi.lanesUpdate")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const parsed = yield* Effect.try({
        try: () => JSON.parse(body) as unknown,
        catch: (err) => `request body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      }).pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catch((reason) => Effect.succeed({ ok: false as const, reason })),
      )
      if (!parsed.ok)
        return HttpServerResponse.jsonUnsafe(
          { error: { code: "LANE_VALUE_MALFORMED", reason: parsed.reason } },
          { status: 400 },
        )
      const result = applyLanesPatch(parsed.value)
      if (!result.ok) return HttpServerResponse.jsonUnsafe({ error: result.error }, { status: 400 })
      return HttpServerResponse.jsonUnsafe(result.state)
    })

    const event = Effect.fn("GlobalHttpApi.event")(function* () {
      return yield* eventResponse()
    })

    const configGet = Effect.fn("GlobalHttpApi.configGet")(function* () {
      return yield* config.getGlobal()
    })

    const configUpdate = Effect.fn("GlobalHttpApi.configUpdate")(function* (ctx) {
      // 1.2.8 row 40g (SR8-04, AC-SEC04): person-only while the server holds the desktop nonce.
      yield* configPersonOnly(ctx.headers)
      const result = yield* config.updateGlobal(ctx.payload)
      if (result.changed) bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
      return result.info
    })

    const dispose = Effect.fn("GlobalHttpApi.dispose")(function* () {
      // Row 229b: drop the cached global config so the next instance rereads swarm.json (e.g. an MCP
      // entry swarm-setup wrote). The reread goes through the same load/validate path as boot.
      yield* config.invalidate()
      yield* disposeAllInstancesAndEmitGlobalDisposed()
      return true
    })

    const upgrade = Effect.fn("GlobalHttpApi.upgrade")(function* (ctx: { payload: typeof GlobalUpgradeInput.Type }) {
      // WP-EGRESS-CORE (row 56): Swarm has no update server (decision 5). Refuse before any
      // method detection or download work; 403 states "policy, not failure". The response body
      // keeps the declared GlobalUpgradeResult shape so existing SDK clients parse it unchanged.
      if (Installation.UPGRADES_DISABLED) {
        return HttpServerResponse.jsonUnsafe(
          { success: false as const, error: Installation.UPGRADE_REFUSAL },
          { status: 403 },
        )
      }
      const method = yield* installation.method()
      if (method === "unknown") {
        return HttpServerResponse.jsonUnsafe(
          { success: false as const, error: "Unknown installation method" },
          { status: 400 },
        )
      }
      const target = ctx.payload.target
      const result = yield* installation.upgrade(method, target).pipe(
        Effect.as({ success: true as const, version: target }),
        Effect.catch((err) =>
          Effect.succeed({
            success: false as const,
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
      )
      if (!result.success) return HttpServerResponse.jsonUnsafe(result, { status: 500 })
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: target },
        },
      })
      return HttpServerResponse.jsonUnsafe(result)
    })

    return handlers
      .handle("health", health)
      .handle("setup", setup)
      .handle("agents", agents)
      .handle("search", (ctx) => sessionSearch.search(ctx.query))
      .handle("lanesGet", lanesGet)
      .handleRaw("lanesUpdate", lanesUpdate)
      .handleRaw("event", event)
      .handle("configGet", configGet)
      .handle("configUpdate", configUpdate)
      .handle("dispose", dispose)
      .handle("upgrade", upgrade)
  }),
)
