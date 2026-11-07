/**
 * Replacements for the three Next/HQ imports of the ported route bodies (studio spec §1.3: the routes are
 * not vendored because they import next/server and require-session).
 *
 * - `NextRequest` -> the standard `Request` (the bodies read only `req.url`, `req.headers`, `req.method`
 *   and the body, all of which `Request` has).
 * - `requireSession` -> always passes: the LocalStudioApi router has already checked `x-internal-secret`
 *   with `secretEquals` before any handler runs (router.ts), and nothing else can call a handler.
 * - `getStudioCaller` -> the session's fixed local caller (spec §1.3 "one fixed local caller per MCP
 *   session"; contract/auth.ts `localStudioCaller`). The agent comes from the router-set `x-studio-agent`
 *   header (= the MCP session's agent). A body `agentId` is IGNORED for identity, so one client cannot
 *   write as another (the MCP layer also locks it: STUDIO_MCP_LOCK_AGENT_ID=1, config.ts L-1).
 */
import { localStudioCaller, STUDIO_AGENT_HEADER, type StudioCaller } from "../../../vendor/src/lib/studio/contract/auth"
import { StudioEngineError } from "../../../vendor/src/lib/studio/contract/errors"

export type NextRequest = Request

export async function requireSession(_req: Request): Promise<Response | null> {
  return null
}

export async function getStudioCaller(req: Request, _bodyAgentId?: string | null): Promise<StudioCaller> {
  const agent = req.headers.get(STUDIO_AGENT_HEADER)
  if (!agent) throw new StudioEngineError("UNAUTHORIZED", "Unauthorized")
  return localStudioCaller(agent)
}
