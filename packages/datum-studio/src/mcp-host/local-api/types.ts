/**
 * LocalStudioApi types (row 31, studio spec §3.2). A route handler is the body of a Studio Next route
 * (`C/src/app/api/studio/**`, not vendored: spec §1.3), ported to a plain `Request -> Response` function.
 */
import type { StudioCaller } from "../../../vendor/src/lib/studio/contract/auth"

export type LocalMethod = "GET" | "POST" | "HEAD" | "PATCH"

export interface RouteContext {
  /** Decoded dynamic segments (`[id]`, `[pid]`, `[address]`). */
  params: Readonly<Record<string, string>>
  /** The MCP session's agent id (bridge header `X-Studio-Agent`); every write is made as this caller. */
  agentId: string
  /** The local caller of this session (spec §1.3: one fixed caller per MCP session). */
  caller: StudioCaller
}

export type RouteHandler = (req: Request, rc: RouteContext) => Promise<Response>

export interface RouteDef {
  /** Route id of `STUDIO_ROUTES` (R01-R23) or a local name for the two routes outside that table. */
  id: string
  /** Next route pattern, e.g. `/api/studio/documents/[id]`. */
  pattern: string
  methods: Partial<Record<LocalMethod, RouteHandler>>
}
