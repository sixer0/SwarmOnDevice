/**
 * Route table of the LocalStudioApi (row 31). Every route a kept MCP tool calls is listed (grep of
 * `http(ctx, ...)` / `client.call(...)` in vendor/scripts/studio/{mcp/*.ts,studio-report.ts}; the list is in
 * implementation/NN_row31_studio_mcp.md). Ported route bodies live in ./routes/*.ts (one per clone route).
 *
 * Routes whose service closure is NOT in the vendored file set (row 27) answer 501 `ROUTE_NOT_AVAILABLE`
 * with the reason, instead of a wrong answer:
 * - (R14 GET/PATCH and R16 GET/PATCH were here until row 31b vendored services/revisions; now ported.)
 * - (R17 POST and POST .../figures/preview were here until row 31c vendored services/render; now ported.)
 * None is left; `notAvailable` stays for any later route without its service closure.
 */
import { STUDIO_ROUTES } from "../../../vendor/src/lib/studio/contract/env"
import type { RouteDef, RouteHandler } from "./types.ts"
import * as r01 from "./routes/r01-templates.ts"
import * as r02 from "./routes/r02-template.ts"
import * as r03 from "./routes/r03-registry.ts"
import * as r04 from "./routes/r04-documents.ts"
import * as r05 from "./routes/r05-document.ts"
import * as r08 from "./routes/r08-validate.ts"
import * as r10 from "./routes/r10-files.ts"
import { handleSubmit } from "./routes/r12-r13-submit.ts"
import * as r15 from "./routes/r15-completeness.ts"
import * as r19 from "./routes/r19-skeleton.ts"
import * as r20 from "./routes/r20-content.ts"
import * as r21 from "./routes/r21-contracts.ts"
import * as r22 from "./routes/r22-search.ts"
import * as mdImport from "./routes/import-markdown.ts"
// Row 31b: R14 / R16 over the vendored services/revisions (Prisma cut).
import * as r14 from "./routes/r14-structure.ts"
import * as r16 from "./routes/r16-paragraph.ts"
// Row 31c: R17 and figure preview over the vendored services/render (Prisma cut).
import * as r17 from "./routes/r17-render.ts"
import * as figurePreview from "./routes/figure-preview.ts"

/** Route importer Markdown and figure preview: outside the R01-R23 table (doc-tools.ts:65, figure-tools.ts:58). */
export const IMPORT_MARKDOWN_ROUTE = "/api/studio/import/markdown"
export const FIGURE_PREVIEW_ROUTE = "/api/studio/documents/[id]/figures/preview"

type NextHandler = (req: Request, rc: { params: Promise<Record<string, string>> }) => Promise<Response> | Response

/** Next route signature -> RouteHandler (`params` is a Promise in Next 15+). */
const next =
  (h: NextHandler): RouteHandler =>
  (req, rc) =>
    Promise.resolve(h(req, { params: Promise.resolve({ ...rc.params }) }))

const plain =
  (h: (req: Request) => Promise<Response>): RouteHandler =>
  (req) =>
    h(req)

function notAvailable(routeId: string, reason: string): RouteHandler {
  return async () =>
    Response.json(
      { error: "This Studio route is not available in DATUM Studio for Swarm 1.2.0", code: "ROUTE_NOT_AVAILABLE", details: { route: routeId, reason } },
      { status: 501, headers: { "cache-control": "no-store" } },
    )
}

export const LOCAL_ROUTES: readonly RouteDef[] = [
  { id: "R01", pattern: STUDIO_ROUTES.R01, methods: { GET: plain(r01.GET) } },
  { id: "R19", pattern: STUDIO_ROUTES.R19, methods: { GET: next(r19.GET as NextHandler) } },
  { id: "R02", pattern: STUDIO_ROUTES.R02, methods: { GET: next(r02.GET as NextHandler) } },
  { id: "R03", pattern: STUDIO_ROUTES.R03, methods: { GET: plain(r03.GET) } },
  { id: "R04", pattern: STUDIO_ROUTES.R04, methods: { GET: plain(r04.GET), POST: plain(r04.POST) } },
  { id: "R05", pattern: STUDIO_ROUTES.R05, methods: { GET: next(r05.GET as NextHandler) } },
  { id: "R08", pattern: STUDIO_ROUTES.R08, methods: { POST: plain(r08.POST) } },
  { id: "R10", pattern: STUDIO_ROUTES.R10, methods: { GET: next(r10.GET as NextHandler), HEAD: next(r10.HEAD as NextHandler) } },
  { id: "R12", pattern: STUDIO_ROUTES.R12, methods: { POST: (req) => handleSubmit(req, "chapter") } },
  { id: "R13", pattern: STUDIO_ROUTES.R13, methods: { POST: (req) => handleSubmit(req, "slot") } },
  { id: "R14", pattern: STUDIO_ROUTES.R14, methods: { GET: next(r14.GET as NextHandler), PATCH: next(r14.PATCH as NextHandler) } },
  { id: "R15", pattern: STUDIO_ROUTES.R15, methods: { GET: next(r15.GET as NextHandler) } },
  { id: "R16", pattern: STUDIO_ROUTES.R16, methods: { GET: next(r16.GET as NextHandler), PATCH: next(r16.PATCH as NextHandler) } },
  { id: "R17", pattern: STUDIO_ROUTES.R17, methods: { POST: next(r17.POST as NextHandler) } },
  { id: "R20", pattern: STUDIO_ROUTES.R20, methods: { GET: next(r20.GET as NextHandler) } },
  { id: "R21", pattern: STUDIO_ROUTES.R21, methods: { GET: plain(r21.GET) } },
  { id: "R22", pattern: STUDIO_ROUTES.R22, methods: { GET: plain(r22.GET) } },
  { id: "import-markdown", pattern: IMPORT_MARKDOWN_ROUTE, methods: { POST: plain(mdImport.POST) } },
  { id: "figure-preview", pattern: FIGURE_PREVIEW_ROUTE, methods: { POST: next(figurePreview.POST as NextHandler) } },
]
