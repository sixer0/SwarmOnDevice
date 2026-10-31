import { Memory } from "@/memory/memory"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/memory"

export const MemoryApi = HttpApi.make("memory")
  .add(
    HttpApiGroup.make("memory")
      .add(
        HttpApiEndpoint.get("get", root, {
          query: WorkspaceRoutingQuery,
          success: described(Memory.Info, "What this project's sessions start out knowing"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.get",
            summary: "Get project memory",
            description: "List the notes every new session on this project starts with.",
          }),
        ),
        HttpApiEndpoint.post("add", root, {
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({ text: Schema.String }),
          success: described(Memory.Result, "The stored note, or why it was refused"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.add",
            summary: "Add a note",
            description: "Add a note written by the user. Text that looks like a credential is refused.",
          }),
        ),
        HttpApiEndpoint.patch("settings", root, {
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({ enabled: Schema.Boolean }),
          success: described(Memory.Info, "The updated memory"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.settings",
            summary: "Turn project memory on or off",
            description: "When off, sessions receive no notes and nothing new is learned. Notes are kept.",
          }),
        ),
        HttpApiEndpoint.patch("update", `${root}/:id`, {
          params: { id: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({
            text: Schema.optional(Schema.String),
            deviceOnly: Schema.optional(Schema.Boolean),
          }),
          success: described(Memory.Result, "The updated note, or why the change was refused"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.update",
            summary: "Change a note",
            description: "Rewrite a note, or set whether it may leave this device.",
          }),
        ),
        HttpApiEndpoint.delete("remove", `${root}/:id`, {
          params: { id: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Whether a note was removed"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.remove",
            summary: "Remove a note",
            description: "Remove a note from the project memory.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "memory", description: "Project memory routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "swarm HttpApi",
      version: "0.0.1",
      description: "Effect HttpApi surface for instance routes.",
    }),
  )
