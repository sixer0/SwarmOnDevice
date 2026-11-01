import { Project } from "@/project/project"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTrust } from "@opencode-ai/core/project/trust"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ProjectNotFoundError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/project"
const UpdatePayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  icon: Schema.optional(Project.Info.fields.icon),
  commands: Schema.optional(Project.Info.fields.commands),
})

const TrustPayload = Schema.Struct({ decision: ProjectTrust.Decision })

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
