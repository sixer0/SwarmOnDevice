import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { Effect, Option, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type { MessageV2 } from "../session/message-v2"
import type { Permission } from "../permission"
import type { SessionID, MessageID } from "../session/schema"
import * as Truncate from "./truncate"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { Autonomy } from "@/permission/autonomy"
import { Session } from "@/session/session"
import { Reach } from "./reach"
import { Secrets } from "./secrets"
import { ShellOrphans } from "./shell/orphans"
import { Agent } from "@/agent/agent"

interface Metadata {
  [key: string]: any
}

// TODO: remove this hack
export type DynamicDescription = (agent: Agent.Info) => Effect.Effect<string>

/**
 * Raised when the LLM calls a tool with arguments that fail the parameter
 * schema. This is the canonical "rewrite the input" tool error: the typed
 * error class makes it matchable upstream, and its `message` getter produces
 * the model-facing prose that the AI SDK feeds back as the tool result.
 */
export class InvalidArgumentsError extends Schema.TaggedErrorClass<InvalidArgumentsError>()(
  "ToolInvalidArgumentsError",
  {
    tool: Schema.String,
    detail: Schema.String,
  },
) {
  override get message() {
    return `The ${this.tool} tool was called with invalid arguments: ${this.detail}.\nPlease rewrite the input so it satisfies the expected schema.`
  }
}

export type Context<M extends Metadata = Metadata> = {
  sessionID: SessionID
  messageID: MessageID
  agent: string
  abort: AbortSignal
  callID?: string
  extra?: { [key: string]: unknown }
  messages: SessionV1.WithParts[]
  metadata(input: { title?: string; metadata?: M }): Effect.Effect<void>
  ask(
    input: Omit<PermissionV1.Request, "id" | "sessionID" | "tool"> & {
      harmless?: boolean
      noAlways?: boolean
      editClass?: PermissionV1.EditClass
      follows?: PermissionV1.Follows
      call?: PermissionV1.ToolCall
      /** Under the plan agent's limits in autonomous mode: no rule or earlier answer settles this before the gate. */
      planLimited?: boolean
    },
  ): Effect.Effect<void>
  /** Set for a real agent run. Without it a tool asks about everything, as a call from outside a session should. */
  trust?: {
    /** Each step snapshots this project, so Undo can restore what changes in it. */
    canUndo: boolean
    /** The bundled library's root, when it is on for this agent. A tool that finds this empty treats the folder like any other. */
    library?: string
  }
}

export interface ExecuteResult<M extends Metadata = Metadata> {
  title: string
  metadata: M
  output: string
  attachments?: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[]
}

export interface Def<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> {
  id: string
  description: string
  parameters: Parameters
  jsonSchema?: JSONSchema7
  execute(args: Schema.Schema.Type<Parameters>, ctx: Context): Effect.Effect<ExecuteResult<M>>
  formatValidationError?(error: unknown): string
}
export type DefWithoutID<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> = Omit<Def<Parameters, M>, "id">

export interface Info<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> {
  id: string
  init: () => Effect.Effect<DefWithoutID<Parameters, M>>
}

type Init<Parameters extends Schema.Decoder<unknown>, M extends Metadata> =
  | DefWithoutID<Parameters, M>
  | (() => Effect.Effect<DefWithoutID<Parameters, M>>)

export type InferParameters<T> =
  T extends Info<infer P, any>
    ? Schema.Schema.Type<P>
    : T extends Effect.Effect<Info<infer P, any>, any, any>
      ? Schema.Schema.Type<P>
      : never
export type InferMetadata<T> =
  T extends Info<any, infer M> ? M : T extends Effect.Effect<Info<any, infer M>, any, any> ? M : never

export type InferDef<T> =
  T extends Info<infer P, infer M>
    ? Def<P, M>
    : T extends Effect.Effect<Info<infer P, infer M>, any, any>
      ? Def<P, M>
      : never

function wrap<Parameters extends Schema.Decoder<unknown>, Result extends Metadata>(
  id: string,
  init: Init<Parameters, Result>,
  truncate: Truncate.Interface,
  agents: Agent.Interface,
  planLimited?: (ctx: Context) => Effect.Effect<boolean>,
) {
  return () =>
    Effect.gen(function* () {
      const toolInfo = typeof init === "function" ? { ...(yield* init()) } : { ...init }
      // Compile the parser closure once per tool init; `decodeUnknownEffect`
      // allocates a new closure per call, so hoisting avoids re-closing it for
      // every LLM tool invocation.
      const decode = Schema.decodeUnknownEffect(toolInfo.parameters)
      const execute = toolInfo.execute
      toolInfo.execute = (args, ctx) => {
        const attrs = {
          "tool.name": id,
          "session.id": ctx.sessionID,
          "message.id": ctx.messageID,
          ...(ctx.callID ? { "tool.call_id": ctx.callID } : {}),
        }
        return Effect.gen(function* () {
          const decoded = yield* decode(args).pipe(
            Effect.mapError(
              (error) =>
                new InvalidArgumentsError({
                  tool: id,
                  detail: toolInfo.formatValidationError ? toolInfo.formatValidationError(error) : String(error),
                }),
            ),
          )
          // Before anything else this run does, not only before the next command: a file edit races the old command too.
          const orphans = yield* Effect.tryPromise({ try: () => ShellOrphans.end(ctx.sessionID), catch: String }).pipe(
            Effect.catch((error) => Effect.logWarning("could not end interrupted commands", { error }).pipe(Effect.as(0))),
          )
          if (orphans > 0) yield* Effect.logInfo("ended interrupted commands", { count: orphans, sessionID: ctx.sessionID })
          // Every prompt of this call names the call, so an answer to it can be held to exactly this.
          const ask: Context["ask"] = (request) => ctx.ask({ call: { tool: id, args: decoded }, ...request })
          const raw = yield* execute(
            decoded as Schema.Schema.Type<Parameters>,
            planLimited
              ? {
                  ...ctx,
                  // An edit nobody would be asked about never reaches the gate, so this has to be settled here.
                  ask: (request) =>
                    request.permission !== "edit" && request.permission !== "external_directory"
                      ? ask(request)
                      : planLimited(ctx).pipe(
                          Effect.flatMap((limited) => {
                            if (!limited) return ask(request)
                            if (request.permission === "edit")
                              return ask({ ...request, harmless: false, noAlways: true, planLimited: true })
                            // The edit that follows is asked about on its own, and its plan is class A.
                            return dataPlan(request.metadata.filepath) ? Effect.void : ask(request)
                          }),
                        ),
                }
              : { ...ctx, ask },
          )
          const instance = yield* InstanceRef
          const result = instance ? Secrets.scrubResult(raw, instance.worktree) : raw
          if (result.metadata.truncated !== undefined) {
            return result
          }
          const agent = yield* agents.get(ctx.agent)
          const truncated = yield* truncate.output(result.output, {}, agent)
          return {
            ...result,
            output: truncated.content,
            metadata: {
              ...result.metadata,
              truncated: truncated.truncated,
              ...(truncated.truncated && { outputPath: truncated.outputPath }),
            },
          }
        }).pipe(Effect.orDie, Effect.withSpan("Tool.execute", { attributes: attrs }))
      }
      return toolInfo
    })
}

/**
 * Whether autonomous mode holds this session to the plan agent's limits. The same reading as the gate's, which has the
 * final say on what an edit is. With the mode off this reads no message and changes nothing.
 */
const planLimits = (sessions: Session.Interface, autonomy: Autonomy.Interface) =>
  Effect.fnUntraced(function* (ctx: Context) {
    const rootOf = (sessionID: SessionID): Effect.Effect<{ id: SessionID; directory?: string }> =>
      sessions.get(sessionID).pipe(
        Effect.flatMap((session) => (session.parentID ? rootOf(session.parentID) : Effect.succeed(session))),
        Effect.catchCause(() => Effect.succeed({ id: sessionID })),
      )
    const root = yield* rootOf(ctx.sessionID)
    const directory = root.directory ?? (yield* InstanceState.directory)
    if (!(yield* autonomy.isOn({ root: root.id, directory }))) return false
    if (ctx.agent === "plan") return true
    return yield* sessions
      .findMessage(root.id, (message) => message.info.role === "user")
      .pipe(
        Effect.map(Option.getOrUndefined),
        Effect.map((message) => message?.info.role === "user" && message.info.agent === "plan"),
        // A lineage nobody can place is held to the limits, as the gate holds it.
        Effect.catchCause(() => Effect.succeed(true)),
      )
  })

/** A plan in the app's own data folder, once links are followed. That folder is outside every project, so it asks first. */
const dataPlan = (file: unknown) => {
  const target = typeof file === "string" ? Reach.real(file) : undefined
  const folder = path.join(Global.Path.data, "plans")
  return target !== undefined && target.endsWith(".md") && path.dirname(target) === (Reach.real(folder) ?? folder)
}

export function define<
  Parameters extends Schema.Decoder<unknown>,
  Result extends Metadata,
  R,
  ID extends string = string,
>(
  id: ID,
  init: Effect.Effect<Init<Parameters, Result>, never, R>,
): Effect.Effect<Info<Parameters, Result>, never, R | Truncate.Service | Agent.Service> & { id: ID } {
  return Object.assign(
    Effect.gen(function* () {
      const resolved = yield* init
      const truncate = yield* Truncate.Service
      const agents = yield* Agent.Service
      // Optional so that a tool built on its own, as its unit tests do, needs neither. The registry provides both.
      const sessions = yield* Effect.serviceOption(Session.Service)
      const autonomy = yield* Effect.serviceOption(Autonomy.Service)
      const limits =
        Option.isSome(sessions) && Option.isSome(autonomy) ? planLimits(sessions.value, autonomy.value) : undefined
      return { id, init: wrap(id, resolved, truncate, agents, limits) }
    }),
    { id },
  )
}

export function init<P extends Schema.Decoder<unknown>, M extends Metadata>(
  info: Info<P, M>,
): Effect.Effect<Def<P, M>> {
  return Effect.gen(function* () {
    const init = yield* info.init()
    return {
      ...init,
      id: info.id,
    }
  })
}

export * as Tool from "./tool"
