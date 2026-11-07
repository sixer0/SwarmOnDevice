/**
 * Row 119b: the mission extension of the Studio host (mission contract §8; decisions U19, U20, C57, C68, C71).
 *
 * `missionHostExtension(store)` returns the HostToolExtensions that start.ts passes to the host server:
 * - 11 new tools in the `missions` toolset (the 9 of §8.3 + studio_mission_request_decision / answer_decision);
 * - 4 wrappers that give the kept studio_report_template / check / submit / update their mission semantics
 *   (studio_report_refresh is unchanged). Wrappers keep their tool's slot: 23 + 11 = 34 tools.
 *
 * Integration (start.ts is row 67's while this row runs; I-2 adds it): see file_requests.md, line `row119b -> I-2`.
 */
import { appendJsonlDaily } from "../../../vendor/src/lib/studio/http/jsonl"
import { getStudioStore } from "../../store/index.ts"
import type { HostToolExtension } from "../tool-table.ts"
import { missionTools, type MissionExporter, type MissionHostStore } from "./mission-tools.ts"
import { reportWrappers } from "./report-tools.ts"
import { guardWriteWrappers } from "./guard-writes.ts"
import type { MissionLog } from "./tool-result.ts"
import { missionDocsExporter } from "./export/index.ts"
import { renderVerifyWrapper, type RenderVerifyStore } from "../verify/render-wrapper.ts"

export { MISSION_TOOL_NAMES } from "./schemas.ts"
export { missionDocsExporter } from "./export/index.ts"
export { GUARDED_CREATE_TOOLS, GUARDED_WRITE_TOOLS, isReportTemplate } from "./guard-writes.ts"
export type { MissionExporter, MissionHostStore } from "./mission-tools.ts"

export interface MissionExtensionOptions {
  /** Log sink (start.ts may pass its `write`); default: the host's daily JSONL, <store>/logs/mcp-host (same file as start.ts). */
  log?: MissionLog
  /** Row 120: the /docs renderer of studio_mission_export. Default: the row 120 renderer (export/); null = none (EXPORT_NOT_AVAILABLE). */
  exporter?: MissionExporter | null
}

/** The host extension list for the mission store of `store` (must be the installed store, as start.ts checks). */
export function missionHostExtension(store: object, opts: MissionExtensionOptions = {}): HostToolExtension[] {
  const installed = getStudioStore() as unknown as MissionHostStore
  if ((installed as unknown) !== store) throw new Error("missionHostExtension: the store passed is not the installed store (call openHostStore first)")
  const log: MissionLog =
    opts.log ??
    ((level, source, message, context) => {
      const entry: { timestamp: string } & Record<string, unknown> = { timestamp: new Date().toISOString(), level, source, message, ...(context ? { context } : {}) }
      void appendJsonlDaily("mcp-host", "datum-studio-host", entry).catch(() => undefined)
    })
  const exporter = opts.exporter === undefined ? missionDocsExporter : opts.exporter
  // Row 119c: + the studio_document_create / studio_write wrappers when the store's missionGuard is on (wrappers keep their slot).
  // Row 154: + the studio_render wrapper (output verification report + records, spec 01_specs_output_verification.md §6).
  // Row 119d: + the create-path wrappers of studio_chapter_import_markdown / studio_chapter_submit / studio_slot_fill (same flag).
  return [...missionTools(installed, { log, ...(exporter ? { exporter } : {}) }), ...reportWrappers(installed, { log }), ...guardWriteWrappers(installed, { log }), renderVerifyWrapper(installed as unknown as RenderVerifyStore, { log })]
}
