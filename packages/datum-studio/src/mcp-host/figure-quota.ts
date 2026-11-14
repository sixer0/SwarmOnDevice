/**
 * Swarm 1.2.8 row 34c (H-T18, AC-HT18, ruling D-H4 host-only; register N8-211): an agent session (non-admin) reads the
 * per-document figure quota. The two wrappers below give the kept vendored tools `studio_document_get` and
 * `studio_figure_preview` one more text line, `kuota gambar: <n>/<max>`, where
 * - n   = the chart, diagram and image blocks of the document revision (the set lint D22 counts, checks-d.ts), and
 * - max = the resolved template parameter `figure.quota.maxPerDocument` (P7-37) of that revision's template version.
 * With no quota (null, the default of every built-in template) no line is printed, so the text is unchanged.
 *
 * Read only: the revision and template are loaded as the figure preview route loads them (figure-preview-load.ts).
 * Not touched (lint closure and template lock): V/registry/lint.ts, V/engine/lint/structure/checks-d.ts,
 * V/params/figure.ts, V/registry/slots.ts. The tools keep their names, descriptions and schemas (wrappers keep their
 * slot, tool-table.ts row 119b). A failed quota read never fails the tool: the line is left out and a warn is logged.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { TOOLS } from "../../vendor/scripts/studio/mcp/tools"
import { walkDoc } from "../../vendor/src/lib/studio/engine/lint/structure/walk"
import type { AnyNormSnapshot, ParamMap } from "../../vendor/src/lib/studio/contract"
import type { MissionLog } from "./mission/tool-result.ts"
import type { HostToolExtension, HostToolNext, HostToolSession } from "./tool-table.ts"

/** The resolved quota parameter (P7-37) read by lint D22; read here, never written. */
export const FIGURE_QUOTA_PARAM = "figure.quota.maxPerDocument"
/** The block types the quota counts (= D22, register N-113). */
const QUOTA_TYPES: ReadonlySet<string> = new Set(["chart", "diagram", "image"])
/** The two kept tools that print the quota line (N8-211). */
export const FIGURE_QUOTA_TOOLS = ["studio_document_get", "studio_figure_preview"] as const

export interface FigureQuota {
  /** Figures (chart, diagram, image) in the revision. */
  count: number
  /** The resolved quota. */
  max: number
}

/** The quota of one revision: null when the template sets no quota (null or not a finite number). */
export function figureQuotaOf(snapshot: Pick<AnyNormSnapshot, "doc" | "blocks">, params: ParamMap | undefined): FigureQuota | null {
  const raw = params?.[FIGURE_QUOTA_PARAM]
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null
  const count = walkDoc(snapshot as never).items.filter((i) => QUOTA_TYPES.has(i.block.type)).length
  return { count, max: Math.max(0, Math.floor(raw)) }
}

/** N8-211: the tool text line (numbers only, outside every untrusted block). */
export function figureQuotaLine(q: FigureQuota): string {
  return `kuota gambar: ${q.count}/${q.max}`
}

/** Reads the quota of a document revision (current when `revisionNo` is undefined) from the installed store. */
export type FigureQuotaReader = (documentId: string, revisionNo: number | undefined) => Promise<FigureQuota | null>

/** Production reader: the revision and its pinned template, loaded as the figure preview route does (read only). */
export const readFigureQuota: FigureQuotaReader = async (documentId, revisionNo) => {
  const { loadFigureContext } = await import("./local-api/routes/figure-preview-load.ts")
  const ctx = await loadFigureContext(documentId, revisionNo)
  return figureQuotaOf(ctx.snapshot, ctx.template.params)
}

export interface FigureQuotaOptions {
  log: MissionLog
  /** Test seam: the quota reader (default `readFigureQuota`). */
  read?: FigureQuotaReader
}

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v)

/** The document id the vendored tool will use: `documentId`, or one of the aliases studio_document_get accepts. */
function documentIdOf(args: Record<string, unknown>): string | null {
  for (const k of ["documentId", "id", "docId", "document_id", "document"]) {
    const v = args[k]
    if (typeof v === "string" && v.trim() !== "") return v.trim()
  }
  return null
}

/** `rev` as the vendored tools accept it (a positive integer, or its digits); otherwise the current revision. */
function revisionOf(args: Record<string, unknown>): number | undefined {
  const r = args.rev
  const n = typeof r === "number" ? r : typeof r === "string" && /^\d{1,6}$/.test(r) ? Number(r) : NaN
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/** One wrapper per tool of FIGURE_QUOTA_TOOLS: the vendored call, then the quota line when the document has a quota. */
export function figureQuotaWrappers(opts: FigureQuotaOptions): HostToolExtension[] {
  const read = opts.read ?? readFigureQuota
  return FIGURE_QUOTA_TOOLS.map((name) => {
    const def = TOOLS.find((t) => t.name === name)
    if (!def) throw new Error(`vendored MCP tool ${name} is missing`)
    // The listed entry stays byte-identical to the unwrapped one: the title is listed once (top level), not in annotations.
    const { title, ...hints } = def.annotations
    return {
      name,
      title: typeof title === "string" ? title : name,
      description: def.description,
      inputSchema: def.inputSchema as Record<string, unknown>,
      annotations: hints as unknown as Record<string, unknown>,
      toolsets: def.toolsets,
      wraps: true,
      async call(args: Record<string, unknown>, session: HostToolSession, next?: HostToolNext): Promise<CallToolResult> {
        if (!next) throw new Error(`${name}: wrapper called without the vendored tool`)
        const out = await next(args)
        if (out.isError === true) return out
        const documentId = documentIdOf(isRec(args) ? args : {})
        const first = Array.isArray(out.content) ? out.content[0] : undefined
        if (!documentId || !first || first.type !== "text") return out
        let quota: FigureQuota | null
        try {
          quota = await read(documentId, revisionOf(args))
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e))
          opts.log("warn", "datum-studio-host.figure-quota", "figure quota not read; line left out", {
            tool: name,
            documentId,
            agentId: session.agentId,
            sessionId: session.sessionId,
            message: err.message,
            stack_trace: err.stack,
          })
          return out
        }
        if (quota === null) return out
        return { ...out, content: [{ ...first, text: `${first.text}\n${figureQuotaLine(quota)}` }, ...out.content.slice(1)] }
      },
    }
  })
}
