// Mission control shell rules (row 133; masterplan/01_specs_mission_control_ui.md §6 items 1-4, 35-37, §11; C59).
// Pure, so the unit build tests them; mission-control.tsx renders them.
import type { MissionOption, MissionStatus, MissionVM } from "./mission-model"

/** V6:96 `@container (max-width:760px)`: above it the side cards sit in a sidebar, at or below it in a bottom sheet. */
export const SIDEBAR_MIN_WIDTH = 761

export type MissionLayout = "sidebar" | "sheet"

export function missionLayoutOf(width: number): MissionLayout {
  return width >= SIDEBAR_MIN_WIDTH ? "sidebar" : "sheet"
}

/** §11 blocking finding (C127): the Agents view is offered for a run with subagents OR a session with a mission. */
export function offersAgentsView(agents: number, missions: number) {
  return agents > 1 || missions > 0
}

/**
 * Row 136 L1 (C145): drop a remembered Agents filter only when the view has nothing to offer, and only once the
 * missions are known (the first list answered, or mission control is absent). While the first list is still loading the
 * filter is kept, so a one-agent session with missions does not end on All.
 */
export function agentsFilterFallsBack(agents: number, missions: { known: boolean; count: number }) {
  return missions.known && !offersAgentsView(agents, missions.count)
}

const TYPE_KEY: Record<string, string> = {
  research: "session.mission.type.research",
  debug: "session.mission.type.debug",
  "feature-release": "session.mission.type.featureRelease",
  document: "session.mission.type.document",
}

const STATUS_KEY: Partial<Record<MissionStatus, string>> = {
  draft: "session.mission.status.draft",
  approved: "session.mission.status.approved",
  paused: "session.mission.status.paused",
  done: "session.mission.status.done",
}

type T = (key: string) => string

/** §6 item 1: "Research", "Debug · Paused". A type outside the four is shown as stored (it passed the store's check). */
export function missionEyebrow(mission: Pick<MissionVM, "type" | "status">, t: T) {
  const type = TYPE_KEY[mission.type] ? t(TYPE_KEY[mission.type]) : mission.type
  if (mission.status === "running") return type
  const key = STATUS_KEY[mission.status]
  return `${type} · ${key ? t(key) : mission.status}`
}

/** §6 item 3: the selector is offered only when there is something to choose. */
export function showSelector(options: MissionOption[]) {
  return options.length >= 2
}

/** §6 item 35: the dock under the stage in sheet mode. */
export function dockItems(mission: Pick<MissionVM, "openDecisions" | "deliverables" | "finalCount">) {
  return {
    decisions: mission.openDecisions,
    files: mission.deliverables.length > 0 ? { final: mission.finalCount, total: mission.deliverables.length } : null,
  }
}
