import { Autonomy } from "@/permission/autonomy"
import { DesktopNonce } from "@/server/desktop-nonce"
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
  consent: "/session/:sessionID/autonomy/consent",
  archive: "/session/:sessionID/autonomy/archive",
  archiveEmpty: "/session/:sessionID/autonomy/archive/empty",
  // 1.2.6 row 38a (N-079): the person puts a checkpoint back.
  checkpointRevert: "/session/:sessionID/autonomy/checkpoint/:checkpointID/revert",
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

/** The list answered is not the one on show any more: the mode went off, the server restarted, or it was made again. */
export class ApiAutonomyConsentError extends Schema.ErrorClass<ApiAutonomyConsentError>("AutonomyConsentError")(
  {
    name: Schema.Literal("AutonomyConsentError"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 409 },
) {}

/** A server anyone on the machine can call has no way to tell a person from an agent, so it takes no consent. */
export class ApiAutonomyNoPasswordError extends Schema.ErrorClass<ApiAutonomyNoPasswordError>(
  "AutonomyNoPasswordError",
)(
  {
    name: Schema.Literal("AutonomyNoPasswordError"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 403 },
) {}

const ExternalChange = Schema.Array(Schema.Literals(["mode.json", "trust.json"]))

export const ModeState = Schema.Struct({
  on: Schema.Boolean,
  externalChange: ExternalChange,
  bypass: Schema.Boolean.annotate({
    description: "True only while a consented activation is live for this scope; a restart turns it off",
  }),
}).annotate({ identifier: "AutonomyMode" })

// No session means the folder: what a draft shows, and what a new session in it starts from.
export const ModePayload = Schema.Struct({
  on: Schema.Boolean,
  sessionID: Schema.optional(SessionID),
  bypassConsent: Schema.optional(Schema.Literal(Autonomy.BYPASS_CONSENT)).annotate({
    description: "The consent the person gave in the app: the main agent decides during this run. Only with on: true",
  }),
  reportLanguage: Schema.optional(Schema.Literals(["en", "id"])).annotate({
    description: "Language of the end-of-run report; en when left out",
  }),
})

export const SessionState = Schema.Struct({
  rootID: SessionID,
  on: Schema.Boolean,
  externalChange: ExternalChange,
  bypass: Schema.Boolean.annotate({
    description: "True only while a consented activation is live for the session's root; a restart turns it off",
  }),
  open: Schema.Int,
  lines: Schema.Array(Autonomy.AuditLine.annotate({ identifier: "AutonomyAuditLine" })),
  intact: Schema.Boolean,
  problems: Schema.Array(Schema.String),
  notFromHere: Schema.Int,
}).annotate({ identifier: "AutonomySession" })

export const ConsentItem = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["secret", "sensitive", "outside", "destination"]),
  pattern: Schema.String,
  files: Schema.Array(Schema.String),
  named: Schema.Boolean,
  checked: Schema.Boolean,
  given: Schema.Boolean,
}).annotate({ identifier: "AutonomyConsentItem" })

export const ConsentList = Schema.Struct({
  id: Schema.String,
  hash: Schema.String,
  at: Schema.Number,
  items: Schema.Array(ConsentItem),
  stopped: Schema.optional(Schema.Literals(["files", "time"])),
  dropped: Schema.Int,
}).annotate({ identifier: "AutonomyConsentList" })

export const ConsentState = Schema.Struct({
  rootID: SessionID,
  consent: Schema.NullOr(ConsentList),
}).annotate({ identifier: "AutonomyConsent" })

export const ConsentPayload = Schema.Struct({
  hash: Schema.String,
  ids: Schema.Array(Schema.String),
})

export const ArchiveEntry = Schema.Struct({
  id: Schema.String,
  bytes: Schema.Int,
  count: Schema.Int,
  paths: Schema.Array(Schema.String),
}).annotate({ identifier: "AutonomyArchiveEntry" })

export const ArchiveState = Schema.Struct({
  rootID: SessionID,
  entries: Schema.Array(ArchiveEntry),
  bytes: Schema.Int,
  // `.swarm` or the archive is there but is a link or not a folder: nothing in it is shown or deleted.
  unsafe: Schema.Boolean,
}).annotate({ identifier: "AutonomyArchive" })

export const ArchiveEmptyPayload = Schema.Struct({
  ids: Schema.Array(Schema.String),
})

// 1.2.6 row 38a (SEC-06, N-147): the per-launch nonce only the desktop app holds. The password alone is readable by an
// agent's shell, so the routes that delete or restore the person's files also need this.
export const DesktopNonceHeaders = Schema.Struct({
  [DesktopNonce.HEADER]: Schema.optional(Schema.String).annotate({
    description: "The per-launch nonce the desktop app holds in memory; required with the server password",
  }),
})

export const CheckpointRevertState = Schema.Struct({
  id: Schema.String,
  restored: Schema.Array(Schema.String),
  preRevert: Schema.String.annotate({
    description: "The checkpoint of the files as they were just before this revert, so the revert can be undone",
  }),
  verified: Schema.Literal(true),
}).annotate({ identifier: "AutonomyCheckpointRevert" })

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
        HttpApiEndpoint.get("consent", AutonomyPaths.consent, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(ConsentState, "What the session's root was asked once its mission was known"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "autonomy.consent",
            summary: "Get a session's consent list",
            description:
              "The secret and sensitive files and the destinations autonomous mode asks about once, and which a person allowed. Null while there is no mission yet or the mode is off. Paths and labels can come from an attacker: show them as plain text.",
          }),
        ),
        HttpApiEndpoint.post("consentAllow", AutonomyPaths.consent, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: ConsentPayload,
          success: described(ConsentState, "The consent list after the answer"),
          error: [
            HttpApiError.BadRequest,
            ApiNotFoundError,
            ApiAutonomyConsentError,
            ApiAutonomyNoPasswordError,
            ApiAutonomyWriteError,
          ],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "autonomy.consentAllow",
            summary: "Allow items of a consent list",
            description:
              "A person allows the items they ticked on the list named by its hash. Only a server with a password takes this, and an agent's shell is never given it. Each item is recorded before it counts.",
          }),
        ),
        HttpApiEndpoint.get("archive", AutonomyPaths.archive, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(ArchiveState, "What autonomous mode moved to the archive instead of deleting"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "autonomy.archive",
            summary: "Get a session's archive",
            description:
              "The entries under .swarm/archive in the folder of the session's root, with their size and the first paths in each. Paths can come from an attacker: show them as plain text.",
          }),
        ),
        HttpApiEndpoint.post("archiveEmpty", AutonomyPaths.archiveEmpty, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          headers: DesktopNonceHeaders,
          payload: ArchiveEmptyPayload,
          success: described(ArchiveState, "The archive after emptying"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, ApiAutonomyNoPasswordError, ApiAutonomyWriteError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "autonomy.archiveEmpty",
            summary: "Empty a session's archive",
            description:
              "A person deletes for good the archive entries they were shown, named by id. Only a server with a password and the desktop app's per-launch nonce takes this; an agent's shell is given neither. Nothing outside the archive is deleted, and the emptying is recorded before anything goes.",
          }),
        ),
        HttpApiEndpoint.post("checkpointRevert", AutonomyPaths.checkpointRevert, {
          params: { sessionID: SessionID, checkpointID: Schema.String },
          query: WorkspaceRoutingQuery,
          headers: DesktopNonceHeaders,
          success: described(CheckpointRevertState, "The checkpoint put back, and the checkpoint saved just before"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, ApiAutonomyNoPasswordError, ApiAutonomyWriteError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "autonomy.checkpointRevert",
            summary: "Revert a checkpoint",
            description:
              "A person puts back the files and Git refs a checkpoint saved before an action ran. The current bytes are saved as a new checkpoint first, so the revert can be undone. Only a server with a password and the desktop app's per-launch nonce takes this; an agent's shell is given neither. The manifest must match the one recorded when the checkpoint was made, and every restored file is checked by sha256.",
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
