/**
 * Row 119b: the mission facts of a work report before it is sent (mission, docKey, TaskRef, Status, Owner, basis),
 * read with Studio's own parsers (md-report `stripToolKeys` / `mdReportToBlocks`, draft `extractDraft`), so the
 * wrapper sees what the vendored tool will send. Read-only: no store or network access.
 */
import { readFileSync } from "node:fs"
import { MAX_INPUT_BYTES } from "../../../vendor/scripts/studio/mcp/config"
import { REAL_NODE_FS, resolveAllowedPath } from "../../../vendor/scripts/studio/mcp/safety"
import { detectFormat } from "../../../vendor/scripts/studio/studio-report"
import { extractDraft } from "../../../vendor/src/lib/studio/services/draft"
import { mdReportToBlocks, parseMdBasis, stripToolKeys } from "../../../vendor/src/lib/studio/services/draft/md-report"

export interface ReportFacts {
  format: "md" | "json"
  /** argument, else header line / block target */
  mission: string | null
  docKey: string | null
  taskRef: string | null
  status: string | null
  owner: string | null
  /** `basis: <id>@rev<n>` (update mode) */
  basisDocumentId: string | null
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const s = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null)

/** The report text from `markdown` or `path` (inside the session root, same rule as the vendored loadSource). */
export function readReportSource(args: Record<string, unknown>, fileRoot: string): string | null {
  if (typeof args.markdown === "string") return args.markdown
  if (typeof args.path !== "string") return null
  try {
    const p = resolveAllowedPath(args.path, [fileRoot], "read-report", REAL_NODE_FS, MAX_INPUT_BYTES)
    return readFileSync(p, "utf8")
  } catch {
    return null // the vendored tool reports the path error itself
  }
}

function recordOf(blocks: readonly unknown[]): Record<string, unknown> | null {
  for (const b of blocks) if (isRec(b) && b.slot === "record" && isRec(b.payload)) return b.payload
  return null
}

function targetOf(blocks: readonly unknown[]): { mission: string | null; docKey: string | null; documentId: string | null } {
  for (const b of blocks) {
    if (!isRec(b)) continue
    const holder = b.$schema === "studio.doc/v2" ? b : isRec(b.target) ? b.target : null
    if (!holder) continue
    return { mission: isRec(holder.mission) ? s(holder.mission.folder) : null, docKey: s(holder.docKey), documentId: s(holder.documentId) }
  }
  return { mission: null, docKey: null, documentId: null }
}

export function reportFacts(markdown: string, args: { mission?: string | null; docKey?: string | null }): ReportFacts {
  const argMission = s(args.mission)
  const argDocKey = s(args.docKey)
  let format: "md" | "json" = "md"
  try {
    format = detectFormat(markdown)
  } catch {
    format = "md"
  }
  if (format === "json") {
    const blocks = extractDraft(markdown).blocks.map((b) => b.value)
    const t = targetOf(blocks)
    const rec = recordOf(blocks)
    return { format, mission: argMission ?? t.mission, docKey: argDocKey ?? t.docKey, taskRef: s(rec?.taskRef), status: s(rec?.status), owner: s(rec?.owner), basisDocumentId: t.documentId }
  }
  const tool = stripToolKeys(markdown).tool
  const mission = argMission ?? s(tool.mission)
  const docKey = argDocKey ?? s(tool.docKey)
  const basis = parseMdBasisSafe(tool.basis)
  let rec: Record<string, unknown> | null = null
  try {
    // mission/docKey placeholders only let the converter run; the record payload does not depend on them
    rec = recordOf(mdReportToBlocks(markdown, { mode: "create", mission: mission ?? "0000-00-00_x", docKey: docKey ?? "x", agentId: null }).blocks)
  } catch {
    rec = null // conversion errors are the vendored tool's to report
  }
  return { format, mission, docKey, taskRef: s(rec?.taskRef), status: s(rec?.status), owner: s(rec?.owner), basisDocumentId: basis }
}

function parseMdBasisSafe(raw: string | null): string | null {
  try {
    const b = parseMdBasis(raw)
    return b && b.kind === "revision" ? b.documentId : null
  } catch {
    return null
  }
}
