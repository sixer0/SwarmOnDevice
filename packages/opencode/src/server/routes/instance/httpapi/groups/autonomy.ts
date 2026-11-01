import { Autonomy } from "@/permission/autonomy"
import { SessionID } from "@/session/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ApiNotFoundError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/autonomy"

export const AutonomyPaths = {
  mode: `${root}/mode`,
  confirm: `${root}/confirm`,
  session: "/session/:sessionID/autonomy",
} as const

export class ApiAutonomyWriteError extends Schema.ErrorClass<ApiAutonomyWriteError>("AutonomyWriteError")(
  {
    name: Schema.Literal("AutonomyWriteError"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 500 },
) {}

const ExternalChange = Schema.Array(Schema.Literals(["mode.json", "trust.json"]))

export const ModeState = Schema.Struct({
  on: Schema.Boolean,
  externalChange: ExternalChange,
}).annotate({ identifier: "AutonomyMode" })

// No session means the folder: what a draft shows, and what a new session in it starts from.
export const ModePayload = Schema.Struct({
  on: Schema.Boolean,
  sessionID: Schema.optional(SessionID),
})

export const SessionState = Schema.Struct({
  rootID: SessionID,
  on: Schema.Boolean,
  externalChange: ExternalChange,
  open: Schema.Int,
  lines: Schema.Array(Autonomy.AuditLine.annotate({ identifier: "AutonomyAuditLine" })),
  intact: Schema.Boolean,
  problems: Schema.Array(Schema.String),
  notFromHere: Schema.Int,
}).annotate({ identifier: "AutonomySession" })

export const AutonomyApi = HttpApi.make("autonomy")
  .add(
    HttpApiGroup.make("autonomy")
      .add(
        HttpApiEndpoint.get("mode", AutonomyPaths.mode, {
          query: WorkspaceRoutingQuery,
          success: described(ModeState, "Autonomous mode for this folder"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "autonomy.mode",
            summary: "Get folder autonomous mode",
            description: "Whether new sessions in this folder start in autonomous mode.",
          }),
        ),
        HttpApiEndpoint.put("modeUpdate", AutonomyPaths.mode, {
          query: WorkspaceRoutingQuery,
          payload: ModePayload,
          success: described(ModeState, "Autonomous mode after the change"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, ApiAutonomyWriteError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "autonomy.modeUpdate",
            summary: "Set autonomous mode",
            description:
              "Turn autonomous mode on or off for a session's root, or for this folder when no session is given. The folder's instance keeps running.",
          }),
        ),
        HttpApiEndpoint.post("confirm", AutonomyPaths.confirm, {
          query: WorkspaceRoutingQuery,
          success: described(ModeState, "Autonomous mode for this folder after the confirmation"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "autonomy.confirm",
            summary: "Confirm a change to the state files",
            description:
              "A person says a change to the mode or trust file was theirs: what the files say now takes effect, and approvals resume.",
          }),
        ),
        HttpApiEndpoint.get("session", AutonomyPaths.session, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(SessionState, "Autonomous mode and decisions of the session's root"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "autonomy.session",
            summary: "Get a session's autonomous decisions",
            description:
              "The mode and audit record of the session's root. Patterns and reasons can come from an attacker: show them as plain text.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "autonomy",
          description: "Experimental HttpApi autonomous mode routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "swarm experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
