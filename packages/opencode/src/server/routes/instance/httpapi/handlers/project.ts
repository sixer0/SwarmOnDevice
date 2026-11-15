import { stat } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import * as InstanceState from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import { GlobalBus } from "@/bus/global"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { DatumStudioMcp } from "@/mcp/datum-studio"
import { Autonomy } from "@/permission/autonomy"
import { Project } from "@/project/project"
import { Rehome } from "@/project/rehome"
import { DesktopNonce } from "@/server/desktop-nonce"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTrust } from "@opencode-ai/core/project/trust"
import { Pty } from "@opencode-ai/core/pty"
import { AbsolutePath } from "@opencode-ai/core/schema"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceStore } from "@/project/instance-store"
import { withoutPaths } from "@/util/log-path"
import { Cause, Effect, Layer, RcMap, Schema } from "effect"
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
 * keeps the error code and the message with every absolute path replaced by `<path>` (1.2.9 rows 45/67b: the shared
 * `withoutPaths`; the home folder is shown as `~` only in what the path rules leave, a path glued to the previous
 * character).
 */
function logSafe(error: unknown) {
  const code = (error as { code?: unknown } | undefined)?.code
  const message = error instanceof Error ? error.message : String(error)
  return {
    ...(typeof code === "string" ? { code } : {}),
    error: withoutPaths(message),
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

const locationRef = (directory: string) => Location.Ref.make({ directory: AbsolutePath.make(directory) })

/**
 * What `runningTerminalCwds` reads, one loaded folder (`dir`, the instance directory) at a time.
 * Exported for tests (production logic: `rehomePorts.terminals` uses it). 1.2.9 row 53 (N9-069).
 */
/** @internal test seam */
export interface TerminalScan {
  /** Directories of the instances the server has loaded. */
  loaded(): Promise<readonly string[]>
  /** Whether the folder is on disk now. */
  exists(dir: string): Promise<boolean>
  /** Whether the folder's location services are already built (`RcMap.has`); never builds them. */
  built(dir: string): Promise<boolean>
  /** The folder's terminals; `undefined` when they could not be listed. */
  list(dir: string): Promise<readonly Pick<Pty.Info, "status" | "cwd">[] | undefined>
}

/**
 * Start folders of the running terminals of every loaded folder (C05, 01c section 3.5):
 * - on disk: today's listing; a listing that fails counts as none (1.2.8 behaviour, kept on purpose, OP-15-4);
 * - missing with built services: its terminals are listed from those services; any failure or defect fails closed
 *   with REHOME_SESSION_ACTIVE "terminal check unavailable" (N9-009, path-free), never an HTTP 500;
 * - missing without built services: no services means no terminal, so nothing is listed. Services are never built
 *   for a missing folder (that build was the 1.2.8 row 68g 500).
 *
 * Exported for tests (production logic: `rehomePorts.terminals` uses it). 1.2.9 row 53 (N9-069).
 */
/** @internal test seam */
export async function runningTerminalCwds(scan: TerminalScan): Promise<string[]> {
  const cwds: string[] = []
  for (const dir of await scan.loaded()) {
    let list: readonly Pick<Pty.Info, "status" | "cwd">[] | undefined
    if (await scan.exists(dir)) list = (await scan.list(dir)) ?? []
    else {
      if (!(await scan.built(dir))) continue
      list = await scan.list(dir).catch(() => undefined)
      // Rehome maps this error to the refusal (rehome.ts, terminal check).
      if (!list)
        throw Object.assign(new Error("REHOME_SESSION_ACTIVE: terminal check unavailable"), {
          code: "REHOME_SESSION_ACTIVE" as const,
          detail: "terminal check unavailable",
        })
    }
    for (const info of list) if (info.status === "running") cwds.push(info.cwd)
  }
  return cwds
}

/**
 * The real ports (row 44 `Rehome.Ports`), built per call so `SWARM_DEFAULT_PROJECT_DIR` is read when the person acts.
 * Busy state and terminals are read only from instances already loaded: a folder no instance has open runs nothing.
 */
const rehomePorts = Effect.gen(function* () {
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
    // 1.2.9 row 53 (C05): a loaded folder that is no longer on disk is no longer skipped; see runningTerminalCwds.
    terminals: () =>
      runningTerminalCwds({
        loaded: async () => (await loaded()).map((ctx) => ctx.directory),
        exists: (dir) => stat(dir).then((info) => info.isDirectory(), () => false),
        // Only looks at the map: never runs the lookup, so it never builds services.
        built: (dir) => run(RcMap.has(locations.rcMap, locationRef(dir))),
        // A failure (e.g. services that cannot be built) is `undefined`; a defect rejects.
        list: (dir) =>
          run(
            Pty.Service.use((service) => service.list()).pipe(
              Effect.provide(locations.get(locationRef(dir))),
              Effect.orElseSucceed(() => undefined),
            ),
          ),
      }),
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

// ---------------------------------------------------------------------------------------------------------------
// 1.2.9 row 54 (C06, 01c section 3.6): the person's answer, read from the built-in DATUM Studio before a real move.

/** N9-056: a copy of the desktop's MISSION_CALL_TIMEOUT_MS (a copy, not an import: dependency direction). */
const REHOME_DECISION_TIMEOUT_MS = 5000

const UNCHECKED: Rehome.DecisionRead = { unchecked: true }
const OPEN: Rehome.DecisionRead = { status: "open" }

let decisionForTests: Rehome.Ports["decision"]

/**
 * Route tests that make a real move (C06 INTENT) answer the decision read with a fake bound port; `undefined` restores
 * the Studio read. Reachable from code only: no route, header or environment variable sets it.
 *
 * @internal test seam
 */
export function setRehomeDecisionForTests(port: Rehome.Ports["decision"]) {
  decisionForTests = port
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Maps a `studio_mission_get {include: ["requests"]}` result to the request `ref` (S9-15: strict types). A host refusal
 * (e.g. an unknown mission) means no answered request; a result of any other shape, or two requests with this id, is
 * unchecked. An answered request whose answer or options are malformed counts as not answered.
 */
function decisionFromResult(result: unknown, ref: string): Rehome.DecisionRead {
  if (!isRecord(result) || !isRecord(result.structuredContent)) return UNCHECKED
  const content = result.structuredContent
  if (result.isError === true) return content.ok === false && typeof content.code === "string" ? OPEN : UNCHECKED
  if (content.ok !== true || !Array.isArray(content.requests)) return UNCHECKED
  if (!content.requests.every((item) => isRecord(item) && typeof item.id === "string")) return UNCHECKED
  const found = (content.requests as Record<string, unknown>[]).filter((item) => item.id === ref)
  if (found.length > 1) return UNCHECKED
  const request = found[0]
  if (!request || request.status !== "answered") return OPEN
  const answer = request.answer
  if (!isRecord(answer)) return OPEN
  if (typeof answer.option !== "string" || typeof answer.by !== "string" || typeof answer.attested !== "boolean")
    return OPEN
  if (request.topic !== undefined && typeof request.topic !== "string") return OPEN
  if (request.options !== undefined && !Array.isArray(request.options)) return OPEN
  const chosen = ((request.options as unknown[] | undefined) ?? []).filter(
    (item) => isRecord(item) && item.id === answer.option,
  ) as Record<string, unknown>[]
  if (chosen.length > 1) return OPEN
  const group = chosen[0]?.group
  if (group !== undefined && typeof group !== "string") return OPEN
  return {
    status: "answered",
    topic: request.topic,
    option: answer.option,
    by: answer.by,
    attested: answer.attested,
    group,
    proposal: request.proposal,
  }
}

/**
 * The decision port of one request, in the instance the route runs in (the desktop names `from`). Trusted only from the
 * built-in server: the entry in effect is the one this instance's MCP state was built from (its loaded config, never a
 * fresh file read) and must equal the built-in entry, so a project config that redefines `datum-studio` is unchecked.
 * Then the server must be connected and answer within REHOME_DECISION_TIMEOUT_MS. Every other outcome is unchecked.
 * A server-internal read: it does not pass agent permissions or the tool registry and no agent sees it.
 */
const studioDecision = Effect.gen(function* () {
  const mcp = yield* MCP.Service
  const config = yield* Config.Service
  const run = Effect.runPromiseWith(yield* Effect.context<never>())

  return (instance: InstanceContext) =>
    async (mission: string, ref: string): Promise<Rehome.DecisionRead> => {
      const signal = AbortSignal.timeout(REHOME_DECISION_TIMEOUT_MS)
      const read = Effect.gen(function* () {
        const builtin = DatumStudioMcp.builtin(DatumStudioMcp.current())[DatumStudioMcp.DATUM_STUDIO_MCP]
        const effective = (yield* config.get()).mcp?.[DatumStudioMcp.DATUM_STUDIO_MCP]
        if (!builtin || !isRecord(effective)) return UNCHECKED
        if (!isDeepStrictEqual(McpCatalog.serverIdentity(effective), McpCatalog.serverIdentity(builtin))) return UNCHECKED
        if ((yield* mcp.status())[DatumStudioMcp.DATUM_STUDIO_MCP]?.status !== "connected") return UNCHECKED
        const client = (yield* mcp.clients())[DatumStudioMcp.DATUM_STUDIO_MCP]
        if (!client) return UNCHECKED
        const result = yield* Effect.promise(() =>
          client.callTool({ name: "studio_mission_get", arguments: { mission, include: ["requests"] } }, undefined, {
            signal,
            timeout: REHOME_DECISION_TIMEOUT_MS,
          }),
        )
        return decisionFromResult(result, ref)
      }).pipe(Effect.provideService(InstanceRef, instance))
      // Waiting for the instance's MCP state counts toward the limit too; the race never leaves the move waiting longer.
      const timedOut = new Promise<Rehome.DecisionRead>((resolve) => {
        if (signal.aborted) resolve(UNCHECKED)
        signal.addEventListener("abort", () => resolve(UNCHECKED), { once: true })
      })
      return Promise.race([run(read).catch(() => UNCHECKED), timedOut])
    }
})

export const projectHandlers = HttpApiBuilder.group(InstanceHttpApi, "project", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Project.Service
    const project = yield* ProjectV2.Service
    const autonomy = yield* Autonomy.Service
    const portsFor = yield* rehomePorts
    const decisionIn = yield* studioDecision

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
      // 1.2.9 row 54 (C06): the production route always provides the port; the module asks it before a real move only.
      const decision = decisionForTests ?? decisionIn(yield* InstanceState.context)
      const result = yield* Effect.tryPromise(() =>
        Rehome.make({ ...portsFor(), decision }).run({
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
  // 1.2.9 row 53 (C05): the terminal check reads the location services the terminal routes use (pty.ts), where the
  // app's terminals live; the server's other location map never holds them, so a running terminal was never seen.
).pipe(Layer.provide(locationServiceMapLayer))
