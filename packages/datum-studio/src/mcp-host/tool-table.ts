/**
 * The host's tool list (row 31): studio spec §5 as amended by U19 / mission contract §8.1.
 *
 * - 18 tools KEPT by spec §5.2 (documents, query, write);
 * - the 5 `studio_report_*` tools, KEPT again by U19 (decisions.md:65; mission contract §8.1 `reports`);
 * - `studio_draft_check` stays dropped;
 * - `studio_registry`, `studio_render`, `studio_file_verify` also join `documents` (spec §5.1).
 * = 23 tools in 1.2.0 row 31.
 *
 * Seams (not implemented here):
 * - `templates` toolset: the 5 template tools of spec §5.3 -> row 68 registers them as HostToolExtension;
 * - `missions` toolset: the 9 `studio_mission_*` tools of mission contract §8.3 -> rows 119-121.
 * With both, the list is 23 + 5 + 9 = 37 (mission contract §8.1 "The total is 37 tools").
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { TOOLSETS, type Toolset } from "../../vendor/scripts/studio/mcp/config"

/** Exact names kept in row 31, in list order. */
export const HOST_KEPT_TOOLS = [
  "studio_registry",
  "studio_templates_list",
  "studio_template_get",
  "studio_document_create",
  "studio_chapter_import_markdown",
  "studio_chapter_submit",
  "studio_slot_fill",
  "studio_document_structure",
  "studio_document_status",
  "studio_document_get",
  "studio_render",
  "studio_file_verify",
  "studio_search",
  "studio_contracts_query",
  "studio_figure_preview",
  "studio_figure_revise",
  "studio_write",
  "studio_edit",
  "studio_report_template",
  "studio_report_check",
  "studio_report_submit",
  "studio_report_update",
  "studio_report_refresh",
] as const

/** Vendored tools that the host never lists or runs (spec §5.2 DROP; U19 keeps it dropped). */
export const HOST_DROPPED_TOOLS = ["studio_draft_check"] as const

/** Extra toolset membership on top of the vendored `toolsets` field (spec §5.1). */
export const HOST_EXTRA_TOOLSETS: Readonly<Record<string, readonly Toolset[]>> = {
  studio_registry: ["documents"],
  studio_render: ["documents"],
  studio_file_verify: ["documents"],
}

/** Session facts an extension tool gets (rows 68, 119-121). */
export interface HostToolSession {
  /** MCP session id (transport). */
  sessionId: string
  /** The session's agent (`X-Studio-Agent`), e.g. `claude` or `swarm`. */
  agentId: string
  /** The session's file root (spec §9.4); the only folder a tool may write under. */
  fileRoot: string
}

/**
 * Registration seam for tools that are not vendored Studio tools: the template tools (row 68) and the mission
 * tools (rows 119-121). The host lists them with the kept tools when their toolset is active and routes
 * `tools/call` to `call`. Input validation is the extension's job (it gets the raw arguments).
 */
export interface HostToolExtension {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
  toolsets: readonly Toolset[]
  /**
   * Row 119b: `true` = this entry does not add a tool; it wraps the KEPT vendored tool of the same name (the
   * five `studio_report_*` tools get their mission semantics this way, mission contract §8.2). The tool keeps its
   * slot in the list (the count does not change) and is listed with this entry's title, description and
   * inputSchema; `call` receives `next`, which runs the vendored tool with the arguments it is given.
   */
  wraps?: boolean
  call(args: Record<string, unknown>, session: HostToolSession, next?: HostToolNext): Promise<CallToolResult>
}

/**
 * Row 119b: the vendored tool behind a wrapping extension (runs it exactly as an unwrapped call would).
 * `basis` reads / restores the MCP session's remembered basis of a document (vendored McpSession), so a wrapper
 * that rolls back a job after the vendored call can put the session memory back to what the store still holds.
 */
export type HostToolNext = ((args: Record<string, unknown>) => Promise<CallToolResult>) & {
  basis: { get(documentId: string): HostRememberedBasis | null; restore(documentId: string, saved: HostRememberedBasis | null): void }
}

/** = vendored RememberedBasis (tool-kit.ts). */
export interface HostRememberedBasis {
  documentId: string
  revisionNo: number
  line: string
  from: string
  at: string
}

const NAME_RE = /^studio_[a-z0-9_]{1,60}$/

/** Refuse a bad or duplicate extension at start-up (never at call time). */
export function assertExtensions(exts: readonly HostToolExtension[]): void {
  const seen = new Set<string>([...HOST_KEPT_TOOLS, ...HOST_DROPPED_TOOLS])
  const wrapped = new Set<string>()
  for (const e of exts) {
    if (!NAME_RE.test(e.name)) throw new Error(`host tool extension name ${JSON.stringify(e.name)} must match ${NAME_RE.source}`)
    if (e.wraps === true) {
      // row 119b: a wrapper names a kept tool, once
      if (!(HOST_KEPT_TOOLS as readonly string[]).includes(e.name)) throw new Error(`host tool wrapper ${e.name} names no kept tool`)
      if (wrapped.has(e.name)) throw new Error(`host tool ${e.name} is wrapped twice`)
      wrapped.add(e.name)
      continue
    }
    if (seen.has(e.name)) throw new Error(`host tool extension ${e.name} duplicates a tool name`)
    if (e.toolsets.length === 0 || e.toolsets.some((t) => !(TOOLSETS as readonly string[]).includes(t))) throw new Error(`host tool extension ${e.name} has an unknown toolset`)
    seen.add(e.name)
  }
}
