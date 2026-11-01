import * as InstanceState from "@/effect/instance-state"
import { Autonomy } from "@/permission/autonomy"
import type { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import type { ApiNotFoundError } from "../errors"
import { ApiAutonomyWriteError } from "../groups/autonomy"
import * as SessionError from "./session-errors"

// A draft has no session yet, and no session is ever stored under this: only the folder can answer.
const NO_SESSION = "" as SessionID

export const autonomyHandlers = HttpApiBuilder.group(InstanceHttpApi, "autonomy", (handlers) =>
  Effect.gen(function* () {
    const autonomy = yield* Autonomy.Service
    const sessions = yield* Session.Service

    const rootOf = (sessionID: SessionID): Effect.Effect<Session.Info, ApiNotFoundError> =>
      SessionError.mapStorageNotFound(sessions.get(sessionID)).pipe(
        Effect.flatMap((session) => (session.parentID ? rootOf(session.parentID) : Effect.succeed(session))),
      )

    const modeAt = Effect.fn("AutonomyHttpApi.modeAt")(function* (where: Autonomy.Where) {
      return { on: yield* autonomy.isOn(where), externalChange: yield* autonomy.externalChange() }
    })

    const folderMode = Effect.fn("AutonomyHttpApi.folderMode")(function* () {
      return yield* modeAt({ root: NO_SESSION, directory: (yield* InstanceState.context).directory })
    })

    const saved = (change: Autonomy.ModeChange) =>
      autonomy
        .setMode(change)
        .pipe(
          Effect.mapError(
            (error) => new ApiAutonomyWriteError({ name: "AutonomyWriteError", data: { message: error.message } }),
          ),
        )

    const modeUpdate = Effect.fn("AutonomyHttpApi.modeUpdate")(function* (ctx: {
      payload: { on: boolean; sessionID?: SessionID }
    }) {
      const instance = yield* InstanceState.context
      if (!ctx.payload.sessionID) {
        yield* saved({ scope: "directory", directory: instance.directory, on: ctx.payload.on })
        return yield* folderMode()
      }
      const root = yield* rootOf(ctx.payload.sessionID)
      const where = { root: root.id, directory: root.directory ?? instance.directory }
      // Also when saving failed: stopping holds in memory all the same, and the record should say so.
      yield* saved({ scope: "session", root: root.id, on: ctx.payload.on }).pipe(
        Effect.ensuring(autonomy.markMode(where)),
      )
      return yield* modeAt(where)
    })

    const confirm = Effect.fn("AutonomyHttpApi.confirm")(function* () {
      yield* autonomy.confirm()
      return yield* folderMode()
    })

    const session = Effect.fn("AutonomyHttpApi.session")(function* (ctx: { params: { sessionID: SessionID } }) {
      const instance = yield* InstanceState.context
      const root = yield* rootOf(ctx.params.sessionID)
      const mode = yield* modeAt({ root: root.id, directory: root.directory ?? instance.directory })
      const read = yield* autonomy.readAudit(root.id)
      const open = (yield* autonomy.openDecisions()).filter((line) => line.rootID === root.id).length
      return { rootID: root.id, ...mode, open, ...read }
    })

    return handlers
      .handle("mode", folderMode)
      .handle("modeUpdate", modeUpdate)
      .handle("confirm", confirm)
      .handle("session", session)
  }),
)
