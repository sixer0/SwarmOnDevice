/**
 * R21/R22 service layer over the store (studio spec §5.2: R21 -> `queryContracts`, R22 -> `searchParagraphs`).
 * Replaces the clone's `services/query` barrel (not vendored; its db.ts is Prisma + Postgres tsvector). The
 * query-string parsers are the clone's own (`query-filters.ts`, ported verbatim apart from one import line);
 * the store answers with the same `ContractSummaryV2` / `SearchHitV2` shapes (store/types.ts:393-466).
 *
 * `logQueryRead` keeps the clone's FIX-SEC rule (D-402 L-1): every 200 writes one structured read log line,
 * with `q` reduced to its length and no snippet text, through the persistent API log.
 */
import type { StudioCaller } from "@/lib/studio/contract/auth"
import { StudioEngineError } from "@/lib/studio/contract/errors"
import { apiLog } from "@/lib/studio/http"
import { getStudioStore, isStoreError } from "../../../store/index.ts"
import type { QueryContractsResult, SearchBlocksResult } from "../../../store/types.ts"
import type { ContractQueryFilter, SearchQueryFilter } from "./query-filters"

export { parseContractQuery, parseSearchQuery } from "./query-filters"

/** Store validation errors are caller errors (400), as in the clone's service. */
function mapStoreError(e: unknown): never {
  if (isStoreError(e, "SCHEMA_INVALID")) throw new StudioEngineError("SCHEMA_INVALID", (e as Error).message)
  throw e
}

export async function queryContracts(f: ContractQueryFilter, _o?: { correlationId?: string }): Promise<QueryContractsResult> {
  try {
    return await getStudioStore().queryContracts(f)
  } catch (e) {
    mapStoreError(e)
  }
}

export async function searchBlocks(f: SearchQueryFilter, _o?: { correlationId?: string }): Promise<SearchBlocksResult> {
  try {
    return await getStudioStore().searchParagraphs(f)
  } catch (e) {
    mapStoreError(e)
  }
}

export function logQueryRead(i: {
  correlationId: string
  route: string
  caller: StudioCaller
  filter: ContractQueryFilter | SearchQueryFilter
  resultCount: number
  hasNextCursor: boolean
}): void {
  const { q, ...rest } = i.filter as SearchQueryFilter
  const filter: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(rest)) filter[k] = typeof v === "string" ? v.slice(0, 80) : v
  apiLog({
    correlationId: i.correlationId,
    route: i.route,
    method: "GET",
    source: "studio.api.query",
    level: "info",
    message: "studio query read",
    code: "QUERY_READ",
    context: { requester: i.caller.requester, filter, ...(typeof q === "string" ? { qLength: q.length } : {}), resultCount: i.resultCount, hasNextCursor: i.hasNextCursor },
  })
}
