/**
 * Shared route helpers, ported from C/src/app/api/studio/validate/_shared/route-kit.ts (sha256 recorded in
 * implementation/NN_row31_studio_mcp.md). Change: Prisma P2002 on `docNumber` becomes the store's unique
 * violation on `doc_number` (store-bridge/db.ts `isUniqueViolation`); `requireSession` is gone because the
 * LocalStudioApi router authenticates every request before a handler runs.
 */
import { isUniqueViolation } from "../../store-bridge/index.ts"
import { failure, isRecord, reject, type ReadJsonOptions, type ReqCtx } from "../../../vendor/src/lib/studio/http"

/** R04/R08: invalid UTF-8 = 400 JSON_MALFORMED (S55 behaviour). */
export const S55_BODY_OPTIONS: ReadJsonOptions = { fatalUtf8: true }

/** Map any error to the §6.1 response and log it durably (unknown errors: 500 + correlationId, no stack). */
export function failFrom(err: unknown, ctx: ReqCtx, context?: Record<string, unknown>): Response {
  if (isUniqueViolation(err, "doc_number")) return reject(ctx, "DOC_NUMBER_EXISTS", "Document number already exists", undefined, context)
  return failure(err, ctx, { context, exposeCorrelationId: true })
}

/** Body `agentId` (string) or undefined. In the host it is informational: the caller is the session's. */
export function bodyAgentId(body: unknown): string | undefined {
  return isRecord(body) && typeof body.agentId === "string" ? body.agentId : undefined
}

export { documentSummary as toDocumentSummary, revisionSummary as toRevisionSummary } from "../../../vendor/src/lib/studio/services/revisions/rows"
