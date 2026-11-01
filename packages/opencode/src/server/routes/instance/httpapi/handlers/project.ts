import * as InstanceState from "@/effect/instance-state"
import { Autonomy } from "@/permission/autonomy"
import { Project } from "@/project/project"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTrust } from "@opencode-ai/core/project/trust"
import { InstanceStore } from "@/project/instance-store"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ProjectNotFoundError } from "../errors"
import { markInstanceForDisposal, markInstanceForReload } from "../lifecycle"

export const projectHandlers = HttpApiBuilder.group(InstanceHttpApi, "project", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Project.Service
    const project = yield* ProjectV2.Service
    const autonomy = yield* Autonomy.Service

    const list = Effect.fn("ProjectHttpApi.list")(function* () {
      return yield* svc.list()
    })

    const current = Effect.fn("ProjectHttpApi.current")(function* () {
      return (yield* InstanceState.context).project
    })

    const trust = Effect.fn("ProjectHttpApi.trust")(function* () {
      return ProjectTrust.status((yield* InstanceState.context).directory)
    })

    const trustDecide = Effect.fn("ProjectHttpApi.trustDecide")(function* (input: {
      payload: { decision: ProjectTrust.Decision }
    }) {
      const ctx = yield* InstanceState.context
      if (input.payload.decision === "later") {
        ProjectTrust.notNow(ctx.directory)
        return ProjectTrust.status(ctx.directory)
      }
      const root = yield* autonomy.grantTrust(ctx.directory).pipe(
        Effect.tapDefect((error) =>
          Effect.logError("failed to save folder trust", { directory: ctx.directory, error: String(error) }),
        ),
      )
      // Everything open under this checkout loaded without its project config, so all of it starts again.
      const store = yield* InstanceStore.Service
      const others = (yield* store.loaded()).filter(
        (item) => item.directory !== ctx.directory && ProjectTrust.rootOf(item.directory) === root,
      )
      yield* Effect.forEach(others, (item) => store.dispose(item), { discard: true })
      yield* markInstanceForDisposal(ctx)
      return ProjectTrust.status(ctx.directory)
    })

    const initGit = Effect.fn("ProjectHttpApi.initGit")(function* () {
      const ctx = yield* InstanceState.context
      const next = yield* svc.initGit({ directory: ctx.directory, project: ctx.project })
      if (next.id === ctx.project.id && next.vcs === ctx.project.vcs && next.worktree === ctx.project.worktree)
        return next
      yield* markInstanceForReload(ctx, {
        directory: ctx.directory,
        worktree: ctx.directory,
        project: next,
      })
      return next
    })

    const update = Effect.fn("ProjectHttpApi.update")(function* (ctx: {
      params: { projectID: ProjectV2.ID }
      payload: Project.UpdatePayload
    }) {
      return yield* svc.update({ ...ctx.payload, projectID: ctx.params.projectID }).pipe(
        Effect.catchTag("Project.NotFoundError", (error) =>
          Effect.fail(
            new ProjectNotFoundError({
              projectID: error.projectID,
              message: `Project not found: ${error.projectID}`,
            }),
          ),
        ),
      )
    })

    const directories = Effect.fn("ProjectHttpApi.directories")((ctx: { params: { projectID: ProjectV2.ID } }) =>
      project.directories({ projectID: ctx.params.projectID }),
    )

    return handlers
      .handle("list", list)
      .handle("current", current)
      .handle("trust", trust)
      .handle("trustDecide", trustDecide)
      .handle("initGit", initGit)
      .handle("update", update)
      .handle("directories", directories)
  }),
)
