import { Project } from "@/project/project"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTrust } from "@opencode-ai/core/project/trust"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ProjectNotFoundError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { DesktopNonceHeaders } from "./autonomy"
import { described } from "./metadata"

const root = "/project"
const UpdatePayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  icon: Schema.optional(Project.Info.fields.icon),
  commands: Schema.optional(Project.Info.fields.commands),
})

const TrustPayload = Schema.Struct({ decision: ProjectTrust.Decision })

// 1.2.8 row 44b (F-PROJ PROJ-i, 01d section 6, N8-130, N8-448): move one mission folder from the Default Project root
// into a group. Person-only twice: the autonomy table refuses an agent's call (row 28, PERSON_ONLY_ROUTES), and the
// handler needs the desktop app's per-launch nonce, whoever calls (a server holding none refuses every caller).
export const RehomePath = `${root}/rehome`

export const RehomePayload = Schema.Struct({
  missionId: Schema.String,
  from: Schema.String.annotate({ description: "The Default Project root (absolute)" }),
  to: Schema.String.annotate({ description: "The group folder, one level below the root (absolute)" }),
  sessions: Schema.Array(Schema.String),
  // Optional in the schema so a missing ref is answered with REHOME_APPROVAL_MISSING, not a decode error.
  approvalRef: Schema.optional(Schema.String).annotate({
    description: "The answered decision of the mission (D-<n>); required, else 409 REHOME_APPROVAL_MISSING",
  }),
  approvalMission: Schema.optional(Schema.String).annotate({
    description: "The mission holding approvalRef (the tidy mission of a tidy list); request ids are per mission",
  }),
  dryRun: Schema.optional(Schema.Boolean),
  compensates: Schema.optional(Schema.String).annotate({
    description: "The journal id of a completed move this call reverses (from and to swapped)",
  }),
  groupKind: Schema.optional(Schema.String).annotate({
    description: "product, institution or theme; required when the call creates the group",
  }),
}).annotate({ identifier: "ProjectRehomeInput" })

const RehomeMoved = Schema.Struct({
  journalId: Schema.String,
  moved: Schema.Struct({ folder: Schema.Boolean, notes: Schema.Number, sessions: Schema.Number }),
  replayed: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "ProjectRehomeMoved" })

const RehomePlanned = Schema.Struct({
  planned: Schema.Struct({
    folder: Schema.Boolean,
    notes: Schema.Number,
    sessions: Schema.Number,
    createsGroup: Schema.Boolean,
  }),
}).annotate({ identifier: "ProjectRehomePlanned" })

export const RehomeCodes = [
  "REHOME_SOURCE_MISSING",
  "REHOME_TARGET_EXISTS",
  "REHOME_OUTSIDE_ROOT",
  "REHOME_SYMLINK",
  "REHOME_APPROVAL_MISSING",
  "REHOME_BUSY",
  "REHOME_ROLLED_BACK",
  "REHOME_SESSION_ACTIVE",
  "REHOME_ROLLBACK_FAILED",
] as const

/** A refusal: nothing moved (REHOME_ROLLED_BACK: the move was undone). `data.code` is the register code (N8-135..141). */
export class ApiRehomeRefusedError extends Schema.ErrorClass<ApiRehomeRefusedError>("RehomeRefusedError")(
  {
    name: Schema.Literal("RehomeRefusedError"),
    data: Schema.Struct({
      code: Schema.Literals(RehomeCodes),
      message: Schema.String,
      detail: Schema.optional(Schema.String),
      step: Schema.optional(Schema.String),
      journal: Schema.optional(Schema.String),
    }),
  },
  { httpApiStatus: 409 },
) {}

/** No or wrong desktop nonce, or a server holding none. */
export class ApiRehomeForbiddenError extends Schema.ErrorClass<ApiRehomeForbiddenError>("RehomeForbiddenError")(
  {
    name: Schema.Literal("RehomeForbiddenError"),
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 403 },
) {}

export const ProjectApi = HttpApi.make("project")
  .add(
    HttpApiGroup.make("project")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Project.Info), "List of projects"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.list",
            summary: "List all projects",
            description: "Get a list of projects that have been opened with Swarm.",
          }),
        ),
        HttpApiEndpoint.get("current", `${root}/current`, {
          query: WorkspaceRoutingQuery,
          success: described(Project.Info, "Current project information"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.current",
            summary: "Get current project",
            description: "Retrieve the currently active project that Swarm is working with.",
          }),
        ),
        HttpApiEndpoint.get("trust", `${root}/trust`, {
          query: WorkspaceRoutingQuery,
          success: described(ProjectTrust.Status, "Whether this folder's own code and settings may load"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.trust",
            summary: "Get folder trust",
            description:
              "What this folder wants to run or change, and whether a person has decided. A folder with nothing to decide is `clean`.",
          }),
        ),
        HttpApiEndpoint.post("trustDecide", `${root}/trust`, {
          query: WorkspaceRoutingQuery,
          payload: TrustPayload,
          success: described(ProjectTrust.Status, "The folder's trust after the decision"),
          error: [HttpApiError.BadRequest],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.trustDecide",
            summary: "Decide folder trust",
            description:
              "Record a person's answer. `trust` is kept in the user's own state and reloads the folder, so what it asks for loads now; `later` lasts until the server restarts.",
          }),
        ),
        HttpApiEndpoint.post("initGit", `${root}/git/init`, {
          query: WorkspaceRoutingQuery,
          success: described(Project.Info, "Project information after git initialization"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.initGit",
            summary: "Initialize git repository",
            description: "Create a git repository for the current project and return the refreshed project info.",
          }),
        ),
        HttpApiEndpoint.patch("update", `${root}/:projectID`, {
          params: { projectID: ProjectV2.ID },
          query: WorkspaceRoutingQuery,
          payload: UpdatePayload,
          success: described(Project.Info, "Updated project information"),
          error: [HttpApiError.BadRequest, ProjectNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.update",
            summary: "Update project",
            description: "Update project properties such as name, icon, and commands.",
          }),
        ),
        HttpApiEndpoint.post("rehome", RehomePath, {
          query: WorkspaceRoutingQuery,
          headers: DesktopNonceHeaders,
          payload: RehomePayload,
          success: described(Schema.Union([RehomeMoved, RehomePlanned]), "The move, or with dryRun the plan"),
          error: [ApiRehomeForbiddenError, ApiRehomeRefusedError, HttpApiError.InternalServerError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.rehome",
            summary: "Move a mission into a group",
            description:
              "Move docs/<missionId> from the Default Project root into a one-level group folder, with the mission's memory notes and sessions, under a write-ahead journal that undoes every step on a failure. Any refusal leaves the disk unchanged. Person-only: needs the desktop app's per-launch x-swarm-desktop-nonce, else 403 (also on a server holding no nonce).",
          }),
        ),
        HttpApiEndpoint.get("directories", `${root}/:projectID/directories`, {
          params: { projectID: ProjectV2.ID },
          query: WorkspaceRoutingQuery,
          success: described(ProjectV2.Directories, "Project directories"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.directories",
            summary: "List project directories",
            description: "List known local absolute directories for a project.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "project",
          description: "Experimental HttpApi project routes.",
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
