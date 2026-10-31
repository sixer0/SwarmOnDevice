import { SavedCommands } from "@/command/saved"
import { SessionID } from "@/session/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ApiNotFoundError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/saved-command"

export const SavedCommandApi = HttpApi.make("savedCommand")
  .add(
    HttpApiGroup.make("savedCommand")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(SavedCommands.Item), "Commands saved as files, for this project and all"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "savedCommand.list",
            summary: "List saved commands",
            description: "List the commands kept as files in this project's folder and in the user's config.",
          }),
        ),
        HttpApiEndpoint.post("save", root, {
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({
            name: Schema.String,
            description: Schema.optional(Schema.String),
            template: Schema.String,
            global: Schema.optional(Schema.Boolean),
            replaces: Schema.optional(Schema.String),
            sessionID: Schema.optional(SessionID),
          }),
          success: described(SavedCommands.Result, "The saved command, or why it was refused"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "savedCommand.save",
            summary: "Save a command",
            description: "Save a command. An existing name is refused unless `replaces` names it.",
          }),
        ),
        HttpApiEndpoint.post("draft", `${root}/draft`, {
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({ sessionID: SessionID }),
          success: described(SavedCommands.Draft, "A command worked out from the run, for the user to review"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "savedCommand.draft",
            summary: "Draft a command from a session",
            description:
              "Write up a finished session as a reusable command, using the session's own model. Saves nothing.",
          }),
        ),
        HttpApiEndpoint.get("repeat", `${root}/repeat`, {
          query: Schema.Struct({ ...WorkspaceRoutingQuery.fields, sessionID: SessionID }),
          success: described(SavedCommands.Repeat, "How often this session's job has been asked for here"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "savedCommand.repeat",
            summary: "Check whether a session's job keeps coming back",
            description: "Compares the session's first prompt with recent ones in this project. Uses no model.",
          }),
        ),
        HttpApiEndpoint.post("decline", `${root}/decline`, {
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({ sessionID: SessionID }),
          success: described(Schema.Boolean, "Recorded"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "savedCommand.decline",
            summary: "Stop offering a job",
            description: "Do not offer to save this session's kind of job again.",
          }),
        ),
        HttpApiEndpoint.delete("remove", `${root}/:name`, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Whether a command was removed"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "savedCommand.remove",
            summary: "Remove a saved command",
            description: "Delete a saved command's file.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "savedCommand", description: "Saved command routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
