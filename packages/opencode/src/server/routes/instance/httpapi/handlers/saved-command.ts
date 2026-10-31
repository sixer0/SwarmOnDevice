import { SavedCommands } from "@/command/saved"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import * as SessionError from "./session-errors"

export const savedCommandHandlers = HttpApiBuilder.group(InstanceHttpApi, "savedCommand", (handlers) =>
  Effect.gen(function* () {
    const saved = yield* SavedCommands.Service

    return handlers
      .handle("list", () => saved.list())
      .handle("save", (ctx) => saved.save(ctx.payload))
      .handle("draft", (ctx) => SessionError.mapStorageNotFound(saved.draft(ctx.payload.sessionID)))
      .handle("repeat", (ctx) => saved.repeat(ctx.query.sessionID))
      .handle("decline", (ctx) => saved.decline(ctx.payload.sessionID).pipe(Effect.as(true)))
      .handle("remove", (ctx) => saved.remove(ctx.params.name))
  }),
)
