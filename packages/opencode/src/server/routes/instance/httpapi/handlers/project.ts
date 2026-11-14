import { stat } from "node:fs/promises"
import * as InstanceState from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import { GlobalBus } from "@/bus/global"
import { Autonomy } from "@/permission/autonomy"
import { Project } from "@/project/project"
import { Rehome } from "@/project/rehome"
import { DesktopNonce } from "@/server/desktop-nonce"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTrust } from "@opencode-ai/core/project/trust"
import { Pty } from "@opencode-ai/core/pty"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { InstanceStore } from "@/project/instance-store"
import { Cause, Effect, Layer, Schema } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ProjectNotFoundError } from "../errors"
import { ApiRehomeForbiddenError, ApiRehomeRefusedError, type RehomePayload } from "../groups/project"
import { markInstanceForDisposal, markInstanceForReload } from "../lifecycle"

type DesktopNonceHeaders = { readonly [DesktopNonce.HEADER]?: string | undefined }

// ---------------------------------------------------------------------------------------------------------------
// 1.2.8 row 44b: the re-home primitive (row 44, `Rehome.make(ports)`) over the running server's services.

/**
 * G2-02 (row 43f): what a failed re-home logs. fs errors carry absolute paths (home folder, user name), so the line
 * keeps the error code and the message with every absolute path replaced by `<path>`.
 */
function logSafe(error: unknown) {
  const code = (error as { code?: unknown } | undefined)?.code
  const message = error instanceof Error ? error.message : String(error)
  return {
    ...(typeof code === "string" ? { code } : {}),
    error: message
      .replace(/'(?:[A-Za-z]:)?[\\/][^']*'/g, "'<path>'")
      .replace(/(?:[A-Za-z]:)?[\\/][^\s'"`,;)]*/g, (match, offset: number, text: string) =>
        offset > 0 && /[\w.~<-]/.test(text[offset - 1]!) ? match : "<path>",
      ),
  }
}

const REFUSAL_TEXT: Record<Rehome.Code, string> = {
  REHOME_SOURCE_MISSING: "The mission folder is no longer there.",
  REHOME_TARGET_EXISTS: "A folder with that name already exists in the group.",
  REHOME_OUTSIDE_ROOT: "Groups must be one folder inside the Default Project.",
  REHOME_SYMLINK: "The folder is a link. Swarm does not move links.",
  REHOME_APPROVAL_MISSING: "The move needs the person's answered decision for this mission.",
  REHOME_BUSY: "Another move is running. Try again when it ends.",
  REHOME_ROLLED_BACK: "The move failed and was undone. Nothing changed.",
  REHOME_SESSION_ACTIVE: "A session or terminal of this mission is still running.",
  REHOME_ROLLBACK_FAILED: "An earlier move of this mission could not be undone; resolve it before moving it again.",
  // Row 68f: said apart from REHOME_OUTSIDE_ROOT, whose "Groups must be ..." was shown for both on a first launch.
  REHOME_ROOT_UNKNOWN: "Swarm does not know where your Default Project folder is, so missions cannot be moved into groups.",
  REHOME_FOLDER_MISSING: "A folder this move needs is no longer on disk.",
}

const decodeSessionID = Schema.decodeUnknownOption(SessionID)

/**
 * The real ports (row 44 `Rehome.Ports`), built per call so `SWARM_DEFAULT_PROJECT_DIR` is read when the person acts.
 * Busy state and terminals are read only from instances already loaded: a folder no instance has open runs nothing.
 */
export const rehomePorts = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const status = yield* SessionStatus.Service
  const store = yield* InstanceStore.Service
  const projects = yield* ProjectV2.Service
  const mover = yield* MoveSession.Service
  const locations = yield* LocationServiceMap.Service
  const run = Effect.runPromiseWith(yield* Effect.context<never>())

  const loaded = () => run(store.loaded())

  return (): Rehome.Ports => ({
    root: process.env.SWARM_DEFAULT_PROJECT_DIR || undefined,
    async session(id) {
      const sessionID = decodeSessionID(id)
      if (sessionID._tag === "None") return undefined
      const info = await run(sessions.get(sessionID.value).pipe(Effect.option))
      if (info._tag === "None") return undefined
      const instance = (await loaded()).find((ctx) => ctx.directory === info.value.directory)
      const state = instance
        ? await run(status.get(sessionID.value).pipe(Effect.provideService(InstanceRef, instance)))
        : { type: "idle" as const }
      return { directory: info.value.directory, projectID: info.value.projectID, busy: state.type !== "idle" }
    },
    projectId: (directory) => run(projects.resolve(AbsolutePath.make(directory))).then((resolved) => resolved.id),
    async moveSession(id, directory) {
      const sessionID = decodeSessionID(id)
      if (sessionID._tag === "None") throw new Error(`not a session id: ${id}`)
      await run(
        mover
          .moveSession({ sessionID: sessionID.value, destination: { directory: AbsolutePath.make(directory) } })
          .pipe(Effect.mapError((error) => new Error(String((error as { _tag?: string })._tag ?? error)))),
      )
    },
    // OP20-8: the server knows a terminal's start folder only (`Pty.Info.cwd`), never where its shell moved later.
    // Row 68g: a loaded folder that is no longer on disk (deleted, renamed, or loaded before it existed) cannot hold
    // the mission folder and has no services to build; skipping it keeps one stale folder from failing every move.
    async terminals() {
      const cwds: string[] = []
      for (const ctx of await loaded()) {
        if (!(await stat(ctx.directory).then((info) => info.isDirectory(), () => false))) continue
        const list = await run(
          Pty.Service.use((service) => service.list()).pipe(
            Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))),
            Effect.orElseSucceed(() => [] as Pty.Info[]),
          ),
        )
        for (const info of list) if (info.status === "running") cwds.push(info.cwd)
      }
      return cwds
    },
    async publish(event) {
      GlobalBus.emit("event", {
        directory: "global",
        payload: { type: Rehome.Event.Rehomed.type, properties: event },
      })
    },
    // The vault mirror is derived and refreshed on the next memory write (01d section 6.3 step 9); no hook here yet.
  })
})

/** Server start (01d section 6.3): a journal still `running` never completed and is rolled back with every re-check. */
export const rehomeRecovery = Layer.effectDiscard(
  Effect.gen(function* () {
    const ports = yield* rehomePorts
    yield* Effect.tryPromise(() => Rehome.make(ports()).recover()).pipe(
      Effect.tap((done) =>
        done.length ? Effect.logWarning("re-home: interrupted moves rolled back at start", { journals: done }) : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Effect.logError("re-home: start-time recovery failed", logSafe(Cause.squash(cause))),
      ),
      Effect.forkScoped,
    )
  }),
)

export const projectHandlers = HttpApiBuilder.group(InstanceHttpApi, "project", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Project.Service
    const project = yield* ProjectV2.Service
    const autonomy = yield* Autonomy.Service
    const portsFor = yield* rehomePorts

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

    // 01d section 6.1 gate 1: whoever calls, a move is taken only with the nonce the desktop app holds for this launch
    // (the server password is readable by an agent's shell, the nonce is not). Checked before anything is read.
    const rehome = Effect.fn("ProjectHttpApi.rehome")(function* (ctx: {
      headers: DesktopNonceHeaders
      payload: typeof RehomePayload.Type
    }) {
      if (!DesktopNonce.matches(ctx.headers[DesktopNonce.HEADER]))
        return yield* new ApiRehomeForbiddenError({
          name: "RehomeForbiddenError",
          data: { message: "Missions can be moved only from the Swarm desktop app." },
        })
      const body = ctx.payload
      const result = yield* Effect.tryPromise(() =>
        Rehome.make(portsFor()).run({
          missionId: body.missionId,
          from: body.from,
          to: body.to,
          sessions: body.sessions,
          approvalRef: body.approvalRef ?? "",
          ...(body.approvalMission === undefined ? {} : { approvalMission: body.approvalMission }),
          ...(body.dryRun === undefined ? {} : { dryRun: body.dryRun }),
          ...(body.compensates === undefined ? {} : { compensates: body.compensates }),
          // The module refuses a kind it does not know (REHOME_APPROVAL_MISSING, detail groupKind).
          ...(body.groupKind === undefined ? {} : { groupKind: body.groupKind as Rehome.GroupKind }),
        }),
      ).pipe(
        Effect.tapError((error) =>
          Effect.logError("re-home failed", { missionId: body.missionId, ...logSafe(error.cause ?? error) }),
        ),
        Effect.mapError(() => new HttpApiError.InternalServerError({})),
      )
      if ("refused" in result)
        return yield* new ApiRehomeRefusedError({
          name: "RehomeRefusedError",
          data: {
            code: result.refused,
            message: REFUSAL_TEXT[result.refused],
            ...(result.detail === undefined ? {} : { detail: result.detail }),
            ...(result.step === undefined ? {} : { step: result.step }),
            ...(result.journal === undefined ? {} : { journal: result.journal }),
          },
        })
      return result
    })

    return handlers
      .handle("list", list)
      .handle("current", current)
      .handle("trust", trust)
      .handle("trustDecide", trustDecide)
      .handle("initGit", initGit)
      .handle("update", update)
      .handle("directories", directories)
      .handle("rehome", rehome)
  }),
)
