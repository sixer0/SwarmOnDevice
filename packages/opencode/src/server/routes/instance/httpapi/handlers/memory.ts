import { Memory } from "@/memory/memory"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const memoryHandlers = HttpApiBuilder.group(InstanceHttpApi, "memory", (handlers) =>
  Effect.gen(function* () {
    const memory = yield* Memory.Service

    return handlers
      .handle("get", () => memory.get())
      .handle("add", (ctx) => memory.add({ text: ctx.payload.text, source: "user" }))
      .handle("settings", (ctx) => memory.setEnabled(ctx.payload.enabled))
      .handle("update", (ctx) => memory.update(ctx.params.id, ctx.payload))
      .handle("remove", (ctx) => memory.remove(ctx.params.id))
  }),
)
