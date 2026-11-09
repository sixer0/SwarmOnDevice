/**
 * Row 119b: result envelopes of the mission tools and of the mission refusals of the wrapped report tools.
 *
 * Mission contract §6.2: "Every refusal is a tool error with `code`, `message` and a `details` object." The shape
 * follows the vendored envelope (`{ok, tool, code, error: {code, message, details}}`, vendored tools.ts
 * executeTool) so a client reads a mission refusal the same way as a Studio one; mission refusals carry
 * `isError: true`. Unexpected failures are logged (persistent host log, with stack) and surface as INTERNAL_ERROR
 * without internals.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { isStoreError } from "../../store/index.ts"
import { neutralizeDeep, tok, untrustedFields } from "../../../vendor/scripts/studio/mcp/tool-kit"
import { outputGateFindings } from "../verify/client-findings.ts"
import { MISSION_GUIDE_URI } from "./mission-guide.ts"
import { MISSION_SKILL, nextCall } from "./next-call.ts"

export type MissionLog = (level: "info" | "warn" | "error", source: string, message: string, context?: Record<string, unknown>) => void

/** A refusal raised by the tool layer itself (argument checks done before the store is called). */
export class MissionToolError extends Error {
  readonly code: string
  readonly details: Record<string, unknown>
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = "MissionToolError"
    this.code = code
    this.details = details
  }
}

const CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/

/** `CODE: message` -> message (StoreError puts the code in front of its message). */
function bareMessage(code: string, message: string): string {
  return message.startsWith(`${code}: `) ? message.slice(code.length + 2) : message
}

export function okResult(tool: string, text: string, data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: { ok: true, tool, ...data } }
}

/** Row 169: at most this many schema issues go back to the agent (the rest is counted in `issuesTotal`). */
export const MAX_REFUSAL_ISSUES = 10

function compactDetails(tool: string, code: string, details: Record<string, unknown>): Record<string, unknown> {
  if (code !== "SCHEMA_INVALID") return details
  const out = { ...details }
  if (Array.isArray(details.issues) && details.issues.length > MAX_REFUSAL_ISSUES) {
    out.issues = details.issues.slice(0, MAX_REFUSAL_ISSUES)
    out.issuesTotal = details.issues.length
  }
  if (tool === "studio_mission_create") out.guide = MISSION_GUIDE_URI
  return out
}

/** Row 210 (I-1): every string of the OUTPUT_UNVERIFIED `rincian` summary (ids, codes) is a safe token or "?". */
function safeBrief(v: unknown): unknown {
  if (typeof v === "string") return tok(v, "?")
  if (Array.isArray(v)) return v.map(safeBrief)
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, safeBrief(x)]))
  return v
}

export function refusal(tool: string, code: string, message: string, rawDetails: Record<string, unknown> = {}): CallToolResult {
  let details = compactDetails(tool, code, rawDetails)
  // Row 206 (1.2.3): OUTPUT_UNVERIFIED names, per unverified output, the checks that failed or could not be measured
  // ({check, verdict, page, address, measured, expected, rule, message}) in the text, fenced as untrusted document text.
  let block = ""
  let brief: unknown = details
  let untrusted: Record<string, unknown> = {}
  if (code === "OUTPUT_UNVERIFIED") {
    const g = outputGateFindings(details)
    block = g.block
    brief = safeBrief({ ...g.details, deliverables: (Array.isArray(g.details.deliverables) ? g.details.deliverables : []).map((d: Record<string, unknown>) => ({ ...d, outputs: (Array.isArray(d.outputs) ? d.outputs : []).map(({ checks: _c, ...o }: Record<string, unknown>) => o) })) })
    // Row 210 (security review 209 M-2, MCP-D4): the check entries quote document text (address, label, engine
    // messages); structuredContent carries them neutralised and marked untrusted, as render-wrapper and doc-tools do.
    details = neutralizeDeep(g.details) as Record<string, unknown>
    untrusted = untrustedFields(["error.details.deliverables.outputs.checks"])
  }
  // Row 188 (L47): every refusal ends with the next correct call and the skill that holds the sequence.
  const next = nextCall(code)
  const error = { code, message, details, next, skill: MISSION_SKILL }
  return {
    content: [{ type: "text", text: `ditolak ${code}: ${message}\nrincian: ${JSON.stringify(brief).slice(0, 4000)}${block ? `\nperiksa (per keluaran belum terverifikasi):\n${block}` : ""}\nnext: ${next}` }],
    structuredContent: { ok: false, tool, code, error, next, ...untrusted },
    isError: true,
  }
}

/** Store and tool refusals -> refusal; anything else is logged with its stack and returned as INTERNAL_ERROR. */
export function errorResult(tool: string, e: unknown, log: MissionLog, context: Record<string, unknown> = {}): CallToolResult {
  if (e instanceof MissionToolError) return refusal(tool, e.code, e.message, e.details)
  if (isStoreError(e) && CODE_RE.test(e.code)) return refusal(tool, e.code, bareMessage(e.code, e.message), e.details ?? {})
  const err = e instanceof Error ? e : new Error(String(e))
  log("error", `datum-studio-host.mission.${tool}`, err.message, { ...context, stack_trace: err.stack })
  return refusal(tool, "INTERNAL_ERROR", "galat internal; rincian ada di log host", {})
}

/** The refusal code of a result (null for a success). */
export function refusalCode(r: CallToolResult): string | null {
  const s = r.structuredContent as Record<string, unknown> | undefined
  return s && s.ok === false && typeof s.code === "string" ? s.code : null
}
