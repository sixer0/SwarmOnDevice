/**
 * Row 120: the MissionExporter of studio_mission_export (row 119b seam D3, mission contract §9, §5.5).
 *
 * One store job per export: it writes the `export` status snapshot (§5.5: a snapshot at every export) and reads
 * the mission, its derived phases and its whole event trail inside the same job, so the four files describe one
 * consistent state. The tool layer (mission-tools.ts) owns where the files go: only under
 * <session root>/docs/<mission>/, FILE_EXISTS unless overwrite (a .bak copy first).
 */
import { StoreError } from "../../../store/index.ts"
import type { MissionEventRecord } from "../../../store/mission/types.ts"
import type { MissionExporter } from "../mission-tools.ts"
import { readDeliverables } from "../deliverables.ts"
import { EXPORT_PATHS, renderBlueprint, renderDecisions, renderDelegation, renderStatus, type ExportFileKey } from "./render.ts"

const EVENT_PAGE = 5000

/** The row 120 renderer. Files are returned in §9 order, filtered by `files`. */
export const missionDocsExporter: MissionExporter = async ({ mission, files, store }) => {
  const M = store.missions
  return store.transaction(async (tx) => {
    const got = M.get(mission, tx)
    if (!got) throw new StoreError("MISSION_NOT_FOUND", "unknown mission", { mission })
    const snapshotId = M.snapshot(tx, mission, "export")
    const snap = M.listSnapshots(mission, tx).find((s) => s.id === snapshotId)
    if (!snap) throw new Error(`export snapshot ${snapshotId} not readable in its own job`)
    const events: MissionEventRecord[] = []
    if (files.includes("delegation")) {
      for (;;) {
        const page = M.listEvents(mission, { afterSeq: events.at(-1)?.seq ?? 0, take: EVENT_PAGE }, tx)
        events.push(...page)
        if (page.length < EVENT_PAGE) break
      }
    }
    const render: Record<ExportFileKey, () => string> = {
      blueprint: () => renderBlueprint(got.mission),
      // Row 86 (MC-08): status_tasks.md lists the deliverables (owned and linked) read in the same job.
      status: () => renderStatus(got.mission, got.derived, snap, readDeliverables(tx, mission, new Set(got.mission.rows.map((r) => r.id)))),
      decisions: () => renderDecisions(got.mission),
      delegation: () => renderDelegation(got.mission, events),
    }
    return (Object.keys(EXPORT_PATHS) as ExportFileKey[]).filter((k) => files.includes(k)).map((k) => ({ path: EXPORT_PATHS[k], markdown: render[k]() }))
  })
}
